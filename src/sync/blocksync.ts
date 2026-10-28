/**
 * Block sync brings a lagging node up to date. Consensus gossip cannot do
 * that: nobody keeps votes for old heights. Instead the node asks peers that
 * reported higher heights for committed blocks, a window of heights at a
 * time spread over several peers, verifies each block's commit against the
 * validator set it already knows for that height, and runs it through the
 * executor in order.
 *
 * With instant finality there are no forks, so there is no fork-point
 * search: "give me heights H+1 to H+8" is the whole protocol.
 *
 * Being one block behind for a moment is normal (the others decided a few
 * hundred milliseconds ago), so a lag of one is tolerated for a short grace
 * period before sync kicks in. A lag of two or more triggers it at once.
 *
 * When nothing is missing ahead, a node that joined from a snapshot fills in
 * the blocks before it, one at a time and low priority, checking each
 * against the hash chain it already holds.
 */
import { validateBlockStructure, verifyBlockSignatures, verifyCommit, type ValidationLimits } from '../consensus/validate.ts';
import { StaleHeightError } from '../consensus/consensus.ts';
import { bytesEqual } from '../crypto/hash.ts';
import type { Verifier } from '../crypto/verifier.ts';
import type { Network, Peer } from '../p2p/network.ts';
import type { Requester } from '../p2p/request.ts';
import type { BlockStore } from '../store/blockstore.ts';
import { blockHash, encodeBlock, encodeCommit, type Block, type Commit } from '../types/block.ts';
import { encode } from '../codec/writer.ts';
import { bodyMatchesHeader } from './statesync.ts';
import type { ChainState } from '../types/state.ts';
import type { ValidatorSet } from '../types/validator.ts';
import type { Logger } from '../util/log.ts';

export interface BlockSyncDeps {
  chainId: string;
  getState(): ChainState;
  applyBlock(block: Block, commit: Commit): Promise<void>;
  validatorSetAtHeight(h: bigint): ValidatorSet | null;
  /** The time of a committed height, from its block or from a header kept alone; evidence age is checked against it. */
  blockTimeAt(h: bigint): bigint | null;
  store: BlockStore;
  verifier: Verifier;
  limits: ValidationLimits;
  network: Network;
  requester: Requester;
  isConsensusDeciding(): boolean;
  onBlockApplied(): void;
  log: Logger;
  scorePeer?(peerId: string, points: number, reason: string): void;
  requestTimeoutMs?: number;
  lagGraceMs?: number;
  /** Heights kept requested ahead of the applied height. */
  window?: number;
  /** Heights per request. */
  perRequest?: number;
  /** Peers asked at once. */
  maxPeers?: number;
  /** Fetch blocks before the lowest held one when idle. */
  backfill?: boolean;
  /** Blocks the node keeps behind its head; backfill stops there, or pruning would undo it. */
  retainBlocks?: number;
}

const MAX_SERVED = 64;
/** Bytes of blocks per response, leaving room under the transport's frame limit. */
const MAX_SERVED_BYTES = 16 * 1024 * 1024;

export class BlockSync {
  private readonly d: BlockSyncDeps;
  private readonly peerHeights = new Map<string, bigint>();
  private readonly buffer = new Map<bigint, { block: Block; commit: Commit; peerId: string }>();
  private readonly requested = new Set<bigint>();
  private readonly busyPeers = new Set<string>();
  private readonly noOldBlocks = new Set<string>();
  private applying = false;
  private backfilling = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private behindSince: number | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private running = false;
  /** Blocks applied through sync; for tests and status. */
  synced = 0n;
  /** Blocks stored by backfill. */
  backfilled = 0n;

  constructor(deps: BlockSyncDeps) {
    this.d = deps;
    deps.network.on('status', (peer, m) => this.onPeerStatus(peer.id, m.height));
    deps.network.on('blockRequest', (peer, m) => this.serveBlock(peer, m.height));
    deps.network.on('blocksRequest', (peer, m) => this.serveBlocks(peer, m.from, m.count));
    deps.network.onPeer((peer) => this.onPeerStatus(peer.id, peer.height));
    deps.network.onPeerGone((peer) => {
      this.peerHeights.delete(peer.id);
      this.busyPeers.delete(peer.id);
      this.check();
    });
  }

  start(): void {
    this.running = true;
    this.check();
  }

  stop(): void {
    this.running = false;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  get isSyncing(): boolean {
    return this.buffer.size > 0 || this.requested.size > 0;
  }

  bestPeerHeight(): bigint {
    let best = 0n;
    for (const h of this.peerHeights.values()) if (h > best) best = h;
    return best;
  }

  private onPeerStatus(peerId: string, height: bigint): void {
    this.peerHeights.set(peerId, height);
    this.check();
  }

  private later(ms: number): void {
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.check();
    }, ms);
  }

  private check(): void {
    if (!this.running) return;
    const ours = this.d.getState().lastHeight;
    const best = this.bestPeerHeight();
    if (best <= ours) {
      this.behindSince = null;
      void this.backfill();
      return;
    }
    if (best === ours + 1n && this.buffer.size === 0) {
      const grace = this.d.lagGraceMs ?? 3000;
      const now = Date.now();
      if (this.behindSince === null) this.behindSince = now;
      if (now - this.behindSince < grace) {
        this.later(grace - (now - this.behindSince));
        return;
      }
    }
    this.request();
    void this.drain();
  }

  /** Keep a window of heights requested, in runs of a few, across several peers. */
  private request(): void {
    const ours = this.d.getState().lastHeight;
    const best = this.bestPeerHeight();
    const window = BigInt(this.d.window ?? 32);
    const perRequest = this.d.perRequest ?? 8;
    const maxPeers = this.d.maxPeers ?? 4;
    const target = best < ours + window ? best : ours + window;
    const missing: bigint[] = [];
    for (let h = ours + 1n; h <= target; h++) if (!this.buffer.has(h) && !this.requested.has(h)) missing.push(h);
    while (missing.length > 0 && this.busyPeers.size < maxPeers) {
      const from = missing[0]!;
      let count = 1;
      while (count < perRequest && count < missing.length && missing[count] === from + BigInt(count)) count++;
      const to = from + BigInt(count - 1);
      let chosen: Peer | null = null;
      for (const [id, h] of this.peerHeights) {
        if (h < to || this.busyPeers.has(id)) continue;
        const p = this.d.network.peers.get(id);
        if (p && (!chosen || h > this.peerHeights.get(chosen.id)!)) chosen = p;
      }
      if (!chosen) break;
      missing.splice(0, count);
      void this.fetchRun(chosen, from, count);
    }
  }

  private async fetchRun(peer: Peer, from: bigint, count: number): Promise<void> {
    this.busyPeers.add(peer.id);
    for (let i = 0; i < count; i++) this.requested.add(from + BigInt(i));
    this.d.log('debug', 'requesting blocks', { from, count, peer: peer.id.slice(0, 8) });
    try {
      const m = await this.d.requester.request(peer, { type: 'blocksRequest', from, count }, 'blocksResponse', (m) => m.from === from, this.d.requestTimeoutMs ?? 5000);
      let got = 0;
      m.blocks.forEach((b, i) => {
        const h = from + BigInt(i);
        if (b.block.header.height !== h || !bytesEqual(b.commit.blockHash, blockHash(b.block))) return;
        this.buffer.set(h, { block: b.block, commit: b.commit, peerId: peer.id });
        got++;
      });
      if (got === 0) this.peerHeights.set(peer.id, from - 1n); // it does not have them after all
    } catch (e) {
      this.d.log('warn', 'block request failed', { from, count, peer: peer.id.slice(0, 8), err: (e as Error).message });
      this.peerHeights.delete(peer.id);
    } finally {
      for (let i = 0; i < count; i++) this.requested.delete(from + BigInt(i));
      this.busyPeers.delete(peer.id);
    }
    this.check();
  }

  /** Apply buffered blocks in order. */
  private async drain(): Promise<void> {
    if (this.applying || !this.running) return;
    this.applying = true;
    let progressed = false;
    try {
      for (;;) {
        const ours = this.d.getState().lastHeight;
        // Consensus may have decided heights we were still holding; they are not needed any more.
        for (const h of this.buffer.keys()) if (h <= ours) this.buffer.delete(h);
        const next = this.buffer.get(ours + 1n);
        if (!next) break;
        if (this.d.isConsensusDeciding()) {
          this.later(200);
          break;
        }
        this.buffer.delete(ours + 1n);
        progressed = true;
        let err: string | null;
        try {
          err = await this.verify(this.d.getState(), next.block, next.commit);
        } catch (e) {
          // Not the peer's fault: the verifier went away under us (shutdown). Stop quietly.
          this.d.log('debug', 'block verification aborted', { h: ours + 1n, err: (e as Error).message });
          this.stop();
          return;
        }
        if (err) {
          this.d.log('warn', 'bad block from peer', { h: ours + 1n, from: next.peerId.slice(0, 8), err });
          this.d.scorePeer?.(next.peerId, 50, 'bad block in sync');
          this.peerHeights.delete(next.peerId);
          continue;
        }
        try {
          await this.d.applyBlock(next.block, next.commit);
          this.synced++;
          this.d.onBlockApplied();
        } catch (e) {
          if (!(e instanceof StaleHeightError)) {
            this.d.log('error', 'failed to apply synced block', { h: ours + 1n, err: (e as Error).message });
            this.stop();
            return;
          }
        }
      }
    } finally {
      this.applying = false;
    }
    // Re-check only after a block left the buffer. check() calls drain() again, and
    // with nothing to apply that would recurse without ever reaching an await.
    if (this.running && progressed) this.check();
  }

  private serveBlock(peer: Peer, height: bigint): void {
    const stored = this.d.store.loadBlock(height);
    peer.send({ type: 'blockResponse', height, block: stored?.block ?? null, commit: stored?.commit ?? null });
  }

  private serveBlocks(peer: Peer, from: bigint, count: number): void {
    const blocks = [];
    let bytes = 0;
    for (let i = 0; i < Math.min(count, MAX_SERVED); i++) {
      const stored = this.d.store.loadBlock(from + BigInt(i));
      if (!stored) break;
      bytes += encode((w) => encodeBlock(w, stored.block)).length + encode((w) => encodeCommit(w, stored.commit)).length;
      if (bytes > MAX_SERVED_BYTES && blocks.length > 0) break; // the first block always goes, however large
      blocks.push(stored);
    }
    peer.send({ type: 'blocksResponse', from, blocks });
  }

  private async verify(state: ChainState, block: Block, commit: Commit): Promise<string | null> {
    // Clock drift is not checked on historical blocks.
    const structural = validateBlockStructure(state, block, this.d.limits, null, this.d.blockTimeAt);
    if (structural) return structural;
    const commitErr = await verifyCommit(this.d.chainId, state.validators, blockHash(block), commit, this.d.verifier);
    if (commitErr) return `commit: ${commitErr}`;
    return verifyBlockSignatures(this.d.chainId, state, block, this.d.verifier, this.d.validatorSetAtHeight);
  }

  /** Fetch the block before the lowest held one and check it against the hash chain. */
  private async backfill(): Promise<void> {
    if (!this.d.backfill || this.backfilling || !this.running) return;
    const lowest = this.d.store.lowestHeight();
    if (lowest <= this.backfillFloor()) return;
    let peer: Peer | null = null;
    for (const p of this.d.network.peers.values()) if (!this.noOldBlocks.has(p.id)) peer = p;
    if (!peer) {
      // Everyone connected has declined once; a peer that was itself still syncing may have the block later.
      if (this.noOldBlocks.size > 0 && !this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.noOldBlocks.clear();
          void this.backfill();
        }, 30_000);
        this.retryTimer.unref?.();
      }
      return;
    }
    this.backfilling = true;
    const height = lowest - 1n;
    try {
      const m = await this.d.requester.request(peer, { type: 'blockRequest', height }, 'blockResponse', (m) => m.height === height, this.d.requestTimeoutMs ?? 5000);
      if (!m.block || !m.commit) {
        this.noOldBlocks.add(peer.id);
        return;
      }
      const above = this.d.store.loadBlock(lowest)!;
      const hash = blockHash(m.block);
      if (m.block.header.height !== height || !bytesEqual(above.block.header.lastBlockHash, hash) || !bytesEqual(m.commit.blockHash, hash) || m.commit.height !== height || !bodyMatchesHeader(m.block)) {
        this.d.scorePeer?.(peer.id, 50, 'backfilled block off the hash chain');
        this.noOldBlocks.add(peer.id);
        return;
      }
      // The commit must carry the signatures the header's set actually gave.
      let set = this.d.store.loadValidatorSet(m.block.header.validatorsHash);
      if (!set) {
        const r = await this.d.requester.request(peer, { type: 'validatorSetRequest', hash: m.block.header.validatorsHash }, 'validatorSetResponse', (r) => bytesEqual(r.hash, m.block!.header.validatorsHash), this.d.requestTimeoutMs ?? 5000);
        if (!r.set || !bytesEqual(r.set.hash(), m.block.header.validatorsHash)) {
          this.noOldBlocks.add(peer.id);
          return;
        }
        set = r.set;
        this.d.store.saveValidatorSet(set);
      }
      const commitErr = await verifyCommit(this.d.chainId, set, hash, m.commit, this.d.verifier);
      if (commitErr) {
        this.d.scorePeer?.(peer.id, 50, `backfilled commit: ${commitErr}`);
        this.noOldBlocks.add(peer.id);
        return;
      }
      this.d.store.saveBlock(m.block, m.commit, null);
      this.d.store.setLowestHeight(height);
      // The header kept alone for this height (a state-sync join fetched it) is now redundant; when it was the
      // highest one left, none remain.
      this.d.store.deleteHeader(height);
      if ((this.d.store.lowestHeaderHeight() ?? -1n) >= height) this.d.store.setLowestHeaderHeight(null);
      this.backfilled++;
      if (height === 1n) this.d.log('info', 'backfill reached genesis');
    } catch (e) {
      this.d.log('debug', 'backfill request failed', { height, err: (e as Error).message });
    } finally {
      this.backfilling = false;
      // Whatever happened (a decline returns early above), the next step is scheduled from here.
      if (this.running && this.d.store.lowestHeight() > this.backfillFloor()) setImmediate(() => void this.backfill());
    }
  }

  /** The lowest height worth fetching back to: genesis, or the edge of the retention window. */
  private backfillFloor(): bigint {
    if (this.d.retainBlocks === undefined) return 1n;
    const floor = this.d.getState().lastHeight - BigInt(this.d.retainBlocks);
    return floor > 1n ? floor : 1n;
  }
}
