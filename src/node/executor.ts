/**
 * The block executor is the only thing that advances chain state. It takes a
 * decided block, runs it through the application, persists everything, and
 * publishes the new state. Both consensus and block sync feed it, and it
 * serialises them: a block for a height that has already passed is refused
 * with StaleHeightError, which the callers treat as "someone else got there
 * first".
 *
 * Persistence order matters for crash recovery:
 *   1. app.finalizeBlock      (in memory, gives app hash and validator updates)
 *   2. save block, commit, new chain state   (fsync)
 *   3. app.commit             (app persists)
 * If the process dies between 2 and 3 the app is one block behind the chain
 * state on restart. `open` detects this through app.info() and replays the
 * missing blocks, checking that the app hash comes out the same.
 */
import { toHex } from '../crypto/hash.ts';
import type { Application, FinalizeBlockRequest, Misbehavior, TxResult } from '../app/types.ts';
import { StaleHeightError } from '../consensus/consensus.ts';
import type { EvidencePool } from '../consensus/evidence.ts';
import type { Mempool } from '../mempool.ts';
import type { BlockStore } from '../store/blockstore.ts';
import { blockHash, type Block, type Commit, type Header } from '../types/block.ts';
import { resultsRoot } from '../types/txproof.ts';
import type { Genesis } from '../types/genesis.ts';
import { genesisState, nextState, type ChainState } from '../types/state.ts';
import type { ValidatorSet, ValidatorUpdate } from '../types/validator.ts';
import type { Logger } from '../util/log.ts';
import { bytesEqual } from '../crypto/hash.ts';

export interface ExecutorDeps {
  app: Application;
  store: BlockStore;
  mempool: Mempool;
  evidencePool: EvidencePool;
  log: Logger;
  /** Keep only this many blocks behind the latest; undefined keeps all. */
  retainBlocks?: number;
  /** A height that pruning must not pass (the newest snapshot). */
  protectedHeight?: () => bigint;
  /** How far back evidence may reach; blocks within it stay so their validator sets and times can be checked. */
  evidenceAgeMs?: () => bigint;
}

export class BlockExecutor {
  state: ChainState;
  private readonly d: ExecutorDeps;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly committedListeners: ((block: Block, commit: Commit, results: TxResult[], updates: ValidatorUpdate[]) => void)[] = [];

  private constructor(deps: ExecutorDeps, state: ChainState) {
    this.d = deps;
    this.state = state;
  }

  /** Load state, or initialise from genesis, then bring the app up to date. */
  static async open(deps: ExecutorDeps, genesis: Genesis): Promise<BlockExecutor> {
    let state = deps.store.loadState();
    if (!state) {
      const init = await deps.app.initChain(genesis);
      state = genesisState(genesis, init.appHash, init.validators);
      deps.store.saveValidatorSet(state.validators);
      deps.store.saveValidatorSet(state.nextValidators);
      deps.store.saveValidatorsAt(1n, state.validators);
      deps.store.saveValidatorsAt(2n, state.nextValidators);
      deps.store.saveState(state);
      deps.log('info', 'initialised from genesis', { chainId: state.chainId, validators: state.validators.size });
    } else if (state.chainId !== genesis.chainId) {
      throw new Error(`data directory is for chain ${state.chainId}, genesis is for ${genesis.chainId}`);
    }
    const exec = new BlockExecutor(deps, state);
    await exec.replayToApp();
    return exec;
  }

  onCommitted(fn: (block: Block, commit: Commit, results: TxResult[], updates: ValidatorUpdate[]) => void): void {
    this.committedListeners.push(fn);
  }

  getLastCommit(): Commit | null {
    if (this.state.lastHeight === 0n) return null;
    return this.d.store.loadBlock(this.state.lastHeight)?.commit ?? null;
  }

  /** The header of a height: from the stored block, or kept alone below the lowest block a state-synced node holds. */
  headerAt(h: bigint): Header | null {
    return this.d.store.loadBlock(h)?.block.header ?? this.d.store.loadHeader(h);
  }

  /** The set that signs (or signed) height h. */
  validatorSetAtHeight(h: bigint): ValidatorSet | null {
    const s = this.state;
    if (h === s.lastHeight + 1n) return s.validators;
    if (h === s.lastHeight + 2n) return s.nextValidators;
    if (h === s.lastHeight) return s.lastValidators;
    const header = this.headerAt(h);
    if (!header) return null;
    return this.d.store.loadValidatorSet(header.validatorsHash);
  }

  applyBlock(block: Block, commit: Commit): Promise<void> {
    const run = this.chain.then(() => this.doApply(block, commit));
    this.chain = run.catch(() => {});
    return run;
  }

  /** Resolves once every block handed to applyBlock so far has finished, so a store can be closed safely. */
  idle(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  /** Replace the stored commit of the last applied block with one carrying more signatures. */
  updateCommit(height: bigint, commit: Commit): void {
    if (height !== this.state.lastHeight) return;
    const stored = this.d.store.loadBlock(height);
    if (!stored || !bytesEqual(stored.commit.blockHash, commit.blockHash)) return;
    const count = (c: Commit) => c.signatures.filter((s) => s !== null).length;
    if (count(commit) <= count(stored.commit)) return;
    this.d.store.saveBlock(stored.block, commit);
    this.d.log('debug', 'commit updated with late precommits', { h: height, signatures: count(commit) });
  }

  blockTimeAt(height: bigint): bigint | null {
    if (height === this.state.lastHeight) return this.state.lastBlockTime;
    return this.headerAt(height)?.time ?? null;
  }

  private buildRequest(block: Block): FinalizeBlockRequest {
    const h = block.header.height;
    const lastCommitSigners: Uint8Array[] = [];
    if (block.lastCommit) {
      const set = this.validatorSetAtHeight(h - 1n);
      if (set) {
        block.lastCommit.signatures.forEach((sig, i) => {
          if (sig !== null) lastCommitSigners.push(set.byIndex(i)!.address);
        });
      }
    }
    const misbehavior: Misbehavior[] = [];
    for (const ev of block.evidence) {
      // Every node must hand the application the same offender, so a set this node cannot find is a halt with a
      // reason, never a silent omission that would leave it computing a different state from everyone else.
      const set = this.validatorSetAtHeight(ev.voteA.height);
      if (!set) throw new Error(`block ${h} carries evidence for height ${ev.voteA.height}, whose validator set this node does not hold; its history does not reach that far`);
      const val = set.byIndex(ev.voteA.validatorIndex);
      if (!val) throw new Error(`block ${h} carries evidence naming validator ${ev.voteA.validatorIndex}, outside the set of height ${ev.voteA.height}`);
      misbehavior.push({ address: val.address, height: ev.voteA.height });
    }
    return { height: h, time: block.header.time, txs: block.txs, proposerAddress: block.header.proposerAddress, lastCommitSigners, misbehavior };
  }

  private async doApply(block: Block, commit: Commit): Promise<void> {
    const h = block.header.height;
    if (h !== this.state.lastHeight + 1n) throw new StaleHeightError(`block ${h} but state is at ${this.state.lastHeight}`);

    const res = await this.d.app.finalizeBlock(this.buildRequest(block));
    const failed = res.txResults.filter((r) => !r.ok).length;
    const newState = nextState(this.state, block, res.validatorUpdates, res.appHash, resultsRoot(res.txResults));

    // Block, commit, results, the next set and the new state land together or not at all.
    this.d.store.batch(() => {
      this.d.store.saveBlock(block, commit, res.txResults);
      this.d.store.saveValidatorSet(newState.nextValidators);
      this.d.store.saveValidatorsAt(h + 2n, newState.nextValidators);
      this.d.store.saveState(newState);
    });
    await this.d.app.commit();

    this.state = newState;
    this.prune();
    this.d.evidencePool.markCommitted(block.evidence);
    this.d.log('info', 'committed', {
      h,
      hash: blockHash(block),
      txs: block.txs.length,
      failed,
      evidence: block.evidence.length,
      appHash: res.appHash,
      valUpdates: res.validatorUpdates.length,
    });
    await this.d.mempool.update(block.txs);
    for (const fn of this.committedListeners) fn(block, commit, res.txResults, res.validatorUpdates);
  }

  private prune(): void {
    const age = this.d.evidenceAgeMs?.();
    // The time before which evidence can no longer name a height, as of the latest block.
    const oldest = age === undefined ? null : this.state.lastBlockTime - age;
    this.pruneBlocks(oldest);
    this.pruneHeaders(oldest);
  }

  /** Drop blocks older than the retention window, never past the newest snapshot nor into the evidence window. */
  private pruneBlocks(oldest: bigint | null): void {
    const keep = this.d.retainBlocks;
    if (keep === undefined) return;
    let floor = this.state.lastHeight - BigInt(keep);
    const protect = this.d.protectedHeight?.() ?? 0n;
    if (protect > 0n && protect < floor) floor = protect;
    const lowest = this.d.store.lowestHeight();
    if (floor <= lowest) return;
    if (oldest !== null) {
      // Walk down from the proposed floor until the block below it is older than evidence may be.
      while (floor > lowest && (this.d.store.loadBlock(floor - 1n)?.block.header.time ?? 0n) >= oldest) floor--;
      if (floor <= lowest) return;
    }
    for (let h = lowest; h < floor; h++) this.d.store.deleteBlock(h);
    this.d.store.setLowestHeight(floor);
    this.d.log('debug', 'pruned blocks', { below: floor });
  }

  /** Headers kept alone below the lowest block serve evidence checks; once older than evidence may be, they go too. */
  private pruneHeaders(oldest: bigint | null): void {
    if (oldest === null) return;
    const lowest = this.d.store.lowestHeaderHeight();
    if (lowest === null) return;
    const top = this.d.store.lowestHeight();
    let h = lowest;
    // A record that is missing (the block backfill replaced it) is passed over like one that has aged out.
    while (h < top && (this.d.store.loadHeader(h)?.time ?? oldest - 1n) < oldest) this.d.store.deleteHeader(h++);
    if (h === lowest) return;
    this.d.store.setLowestHeaderHeight(h < top ? h : null);
    this.d.log('debug', 'pruned headers', { below: h });
  }

  /** Crash recovery: the app may be behind the chain state. */
  private async replayToApp(): Promise<void> {
    const info = await this.d.app.info();
    if (info.lastHeight > this.state.lastHeight) {
      throw new Error(`app is at height ${info.lastHeight}, ahead of chain state ${this.state.lastHeight}; data is inconsistent`);
    }
    if (info.lastHeight === this.state.lastHeight) {
      if (!bytesEqual(info.lastAppHash, this.state.appHash)) throw new Error('app hash does not match chain state');
      return;
    }
    for (let h = info.lastHeight + 1n; h <= this.state.lastHeight; h++) {
      const stored = this.d.store.loadBlock(h);
      if (!stored) throw new Error(`missing block ${h} needed for replay`);
      const res = await this.d.app.finalizeBlock(this.buildRequest(stored.block));
      const expected = h === this.state.lastHeight ? this.state.appHash : this.d.store.loadBlock(h + 1n)!.block.header.appHash;
      if (!bytesEqual(res.appHash, expected)) {
        throw new Error(`replay of block ${h} produced app hash ${toHex(res.appHash)}, expected ${toHex(expected)}`);
      }
      await this.d.app.commit();
      this.d.log('info', 'replayed block to app', { h });
    }
  }
}
