/**
 * A node: consensus engine, mempool, networking, block sync, storage, and
 * one application, wired together. Validators and full nodes run the same
 * code; a full node simply has no validator key.
 */
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Application } from '../app/types.ts';
import { CoreApp } from '../app/core/app.ts';
import { loadAppGenesis } from '../app/core/genesis.ts';
import { Consensus, DEFAULT_LIMITS, type ConsensusTimeouts } from '../consensus/consensus.ts';
import { EvidencePool, evidenceId, verifyEvidence } from '../consensus/evidence.ts';
import { decodeEvidence, encodeEvidence, evidenceHeight, evidenceValidator } from '../types/evidence.ts';
import { decode } from '../codec/reader.ts';
import { sha256, toHex } from '../crypto/hash.ts';
import { txHash, type Header } from '../types/block.ts';
import { encode } from '../codec/writer.ts';
import { Requester } from '../p2p/request.ts';
import { stateSync } from '../sync/statesync.ts';
import { CORE_TYPES } from '../app/core/types.ts';
import { getGlobal } from '../app/core/state.ts';
import { FileSignStateStore, MemorySignStateStore, PrivValidator } from '../consensus/privval.ts';
import { evidenceAgeOk, type ValidationLimits } from '../consensus/validate.ts';
import { keyPairFromSeed, schemeTag, type KeyPair } from '../crypto/keys.ts';
import { WorkerVerifier, type Verifier } from '../crypto/verifier.ts';
import { Mempool, type AddTxResult } from '../mempool.ts';
import { InvKind, MAX_HEADERS } from '../p2p/messages.ts';
import { Network, type NetworkConfig } from '../p2p/network.ts';
import { PeerDb } from '../p2p/peerdb.ts';
import type { Transport } from '../p2p/transport.ts';
import { KvBlockStore, type BlockStore } from '../store/blockstore.ts';
import { MemoryEnv, type KvEnv } from '../store/kv.ts';
import { LmdbEnv } from '../store/lmdb.ts';
import type { KeyProof, ObjectProof } from '../db/proof.ts';
import type { KeyQueryResult, StateQueryResult, TxQueryResult } from '../light/verify.ts';
import { resultProofFor, txProofFor } from '../types/txproof.ts';
import { BlockSync } from '../sync/blocksync.ts';
import { checkMaxBlockBytes, type Genesis } from '../types/genesis.ts';
import { makeLogger, type Logger, type LogLevel } from '../util/log.ts';
import { BlockExecutor } from './executor.ts';
import { GcScheduler, heapInUse, heapLimitFlag, MemoryGuard, memoryStats, type GcSchedulerOptions, type MemoryGuardOptions, type MemoryLevel, type MemoryStats } from './memory.ts';

export interface NodeConfig {
  name: string;
  genesis: Genesis;
  /** null keeps everything in memory. */
  dataDir: string | null;
  nodeKeySeed: Uint8Array;
  /** null makes this a full node that follows but does not vote. */
  validatorSeed: Uint8Array | null;
  transport: Transport;
  listenAddr: string | null;
  advertiseAddr?: string;
  seeds?: string[];
  /** The application. Default is the core application on the node's store. Must be left out for state sync. */
  app?: Application;
  /** Storage environment. Default is LMDB under dataDir, or memory without one. */
  env?: KvEnv;
  /** Join from a snapshot: a header the operator trusts, with backfill of older blocks afterwards. */
  stateSync?: { trustHeight: bigint; trustHash: Uint8Array; backfill?: boolean };
  /**
   * Retention: blocks kept behind the latest (all when unset), provable heights, snapshots kept; and how many of the
   * provable heights are kept in memory (all of them when unset), the store answering for the rest.
   */
  retain?: { blocks?: number; versions?: number; snapshots?: number; memoryVersions?: number };
  /** Export a state snapshot every this many blocks; 0 disables. */
  snapshotInterval?: number;
  /** The most bytes the application's arena of encoded objects may take, the rest read from the store; unbounded by default. */
  arenaBytes?: number;
  /**
   * Where the application's secondary indices are read from. 'store' (the default) never builds their B+ trees and
   * reads LMDB: the node commits about 8% more than it does while it has them and opens with a third less in its
   * heap, a lookup by key costs the same and a page of a scan about twice as much, tens of microseconds
   * (docs/benchmarks.md section 4.13). 'memory' keeps the trees in the heap while they fit, dropped under memory
   * pressure and rebuilt after it, for a node that mostly serves scans.
   */
  indexTrees?: 'memory' | 'store';
  /**
   * What checks signatures. Left out, the node makes a pool of worker threads of its own and closes it when it
   * stops: signatures are most of what a block costs, and checked inline they hold the event loop, consensus
   * timers and all. Several nodes in one process should share one pool and pass it here.
   */
  verifier?: Verifier;
  timeouts?: Partial<ConsensusTimeouts>;
  /** The clock drift this node votes within, and for tests the evidence age. The block size is the chain's and comes from the genesis. */
  limits?: Partial<Omit<ValidationLimits, 'maxBlockBytes'>>;
  network?: Partial<Pick<NetworkConfig, 'desiredOutbound' | 'maxInbound' | 'connectIntervalMs' | 'pingIntervalMs' | 'idleTimeoutMs'>>;
  lagGraceMs?: number;
  log?: Logger;
  logLevel?: LogLevel;
  /** Heap thresholds and sampling for the memory guard (see memory.ts); tests inject their own `stats`. */
  memory?: Partial<Omit<MemoryGuardOptions, 'log' | 'onLevel' | 'onSample'>>;
  /** Collection scheduling after commits; `gc: { gc: null }` turns it off. */
  gc?: Partial<Omit<GcSchedulerOptions, 'log'>>;
}

/** Fetches of announced items a node remembers: in all, for one peer, for how long, and how soon another peer may be asked. */
const MAX_OUTSTANDING = 20_000;
const MAX_OUTSTANDING_PER_PEER = 2_048;
const FETCH_LIFETIME_MS = 60_000;
const FETCH_RETRY_MS = 10_000;

/** Directories this process holds, by their real path, so two nodes in one process are refused as surely as two processes are. */
const heldDirs = new Set<string>();

/** Is the process whose id a claim file holds still running? A file that names no process, or this one, is not a live claim. */
function claimAlive(text: string): number | null {
  const pid = Number(text);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

/**
 * Claim a data directory for this process. The claim is a file linked into place only if none is there, so of two
 * nodes starting at once only one makes it. A live claim refuses, since two nodes on one directory would double sign. A stale one,
 * from a process that no longer runs, is taken over, and only by a process holding a second exclusive file,
 * `LOCK.takeover`: it reads the claim again, and removes it only if it is still stale. Without that, two processes
 * that both found the stale claim could each remove the other's new one and both start. A process killed in the
 * few file operations it holds `LOCK.takeover` for leaves it behind, and that file is never removed
 * automatically: the next start says so and stops.
 */
function lockDataDir(dir: string): () => void {
  // The directory exists by now; its real path is one name for it however it was spelled or linked to.
  const real = realpathSync(dir);
  const path = join(real, 'LOCK');
  const takeover = join(real, 'LOCK.takeover');
  if (heldDirs.has(real)) throw new Error(`data directory ${dir} is in use by this process`);
  // The claim appears with the process id already in it: it is written under another name and linked into place,
  // which fails if a claim is there. A claim created empty and filled afterwards could be read as stale in between.
  const mine = join(real, `LOCK.${process.pid}.${randomBytes(4).toString('hex')}`);
  for (let attempt = 0; ; attempt++) {
    // Every way round the loop counts, so starts that keep finding and clearing stale claims end too.
    if (attempt >= 50) throw new Error(`data directory ${dir}: could not claim it in 50 attempts; ${takeover} may have been left by a process that stopped while taking over a stale claim: check that no node runs on the directory, then remove it`);
    writeFileSync(mine, String(process.pid));
    try {
      linkSync(mine, path);
      unlinkSync(mine);
      break;
    } catch (e) {
      unlinkSync(mine);
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // Released between the two calls: the next attempt creates it.
      continue;
    }
    const pid = claimAlive(text);
    if (pid !== null) throw new Error(`data directory ${dir} is in use by process ${pid}`);
    try {
      writeFileSync(takeover, String(process.pid), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Another process is taking the stale claim over; it is done within a few file operations.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      continue;
    }
    try {
      // Only the holder of the takeover file removes a claim, and only one still stale now that it holds it.
      let still: string | null = null;
      try {
        still = readFileSync(path, 'utf8');
      } catch {
        // Gone: the link is tried again.
      }
      if (still !== null && claimAlive(still) === null) unlinkSync(path);
    } finally {
      unlinkSync(takeover);
    }
  }
  heldDirs.add(real);
  return () => {
    heldDirs.delete(real);
    try {
      // Only this process's own claim is removed, not one that replaced it.
      if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
    } catch {
      // Already gone: nothing to release.
    }
  };
}

/** A constructor's failure, with what releases the resources it had taken by then. */
class ConstructionFailure extends Error {
  override readonly cause: unknown;
  readonly cleanup: () => Promise<void>;
  constructor(cause: unknown, cleanup: () => Promise<void>) {
    super('node construction failed');
    this.cause = cause;
    this.cleanup = cleanup;
  }
}

export class Node {
  readonly name: string;
  private releaseLock: (() => void) | null = null;
  readonly chainId: string;
  app!: Application;
  readonly store: BlockStore;
  readonly env: KvEnv;
  private readonly ownsEnv: boolean;
  mempool!: Mempool;
  readonly evidencePool: EvidencePool;
  requester!: Requester;
  /** Set when the node joined from a snapshot. */
  joinedAt: bigint | null = null;
  memoryGuard!: MemoryGuard;
  gcScheduler!: GcScheduler;
  private shedding = false;
  private readonly memoryListeners: ((level: MemoryLevel, stats: MemoryStats) => void)[] = [];
  readonly privValidator: PrivValidator | null;
  readonly nodeKey: KeyPair;
  readonly verifier: Verifier;
  /** The pool this node made because it was given none; closed by stop(). */
  private readonly ownVerifier: WorkerVerifier | null;
  readonly log: Logger;
  executor!: BlockExecutor;
  consensus!: Consensus;
  network!: Network;
  blockSync!: BlockSync;
  private readonly cfg: NodeConfig;
  private started = false;

  private constructor(cfg: NodeConfig) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.chainId = cfg.genesis.chainId;
    this.log = cfg.log ?? makeLogger(cfg.name, cfg.logLevel ?? 'info');
    // One scheme per chain, genesis's, for the node identity and the validator key alike. Before anything is
    // opened: a genesis naming a scheme the code does not know throws here with nothing to give back.
    const scheme = schemeTag(cfg.genesis.signatureScheme ?? 'ml-dsa-44');
    this.nodeKey = keyPairFromSeed(cfg.nodeKeySeed, scheme);
    this.ownVerifier = cfg.verifier ? null : new WorkerVerifier();
    this.verifier = cfg.verifier ?? this.ownVerifier!;
    let env: KvEnv | null = null;
    try {
      if (cfg.dataDir) mkdirSync(cfg.dataDir, { recursive: true });
      // Two nodes on one directory would share a signing guard that neither sees the other write.
      this.releaseLock = cfg.dataDir ? lockDataDir(cfg.dataDir) : null;
      this.env = env = cfg.env ?? (cfg.dataDir ? new LmdbEnv(join(cfg.dataDir, 'lmdb')) : new MemoryEnv());
      this.ownsEnv = !cfg.env;
      this.store = new KvBlockStore(this.env.store('chain'));
      this.evidencePool = new EvidencePool();
      this.privValidator = cfg.validatorSeed
        ? new PrivValidator(
            keyPairFromSeed(cfg.validatorSeed, scheme),
            cfg.dataDir ? new FileSignStateStore(join(cfg.dataDir, 'priv_validator_state.bin')) : new MemorySignStateStore(),
            this.chainId,
          )
        : null;
    } catch (e) {
      // Nothing is handed back to stop, and a constructor cannot wait: the error goes out with what gives back
      // what was opened so far, for create() to wait on. The store is closed under the rule stop() follows (the
      // node's own, or any in a directory it claimed), and the claim on the directory goes last, once it is.
      const ownVerifier = this.ownVerifier;
      const releaseLock = this.releaseLock;
      throw new ConstructionFailure(e, async () => {
        try {
          // Each step on its own: one that throws, even before it returns a promise, does not stop the next.
          try {
            if (env && (!cfg.env || releaseLock)) await env.close();
          } catch {
            // The error the caller is given is the one that failed the construction.
          }
          try {
            await ownVerifier?.close();
          } catch {
            // As above.
          }
        } finally {
          releaseLock?.();
        }
      });
    }
  }

  static async create(cfg: NodeConfig): Promise<Node> {
    let node: Node;
    try {
      node = new Node(cfg);
    } catch (e) {
      if (!(e instanceof ConstructionFailure)) throw e;
      await e.cleanup();
      throw e.cause;
    }
    try {
      await node.init();
    } catch (e) {
      // A node that could not be set up gives back what it opened (the store, the verifier pool, the claim on its
      // directory), so the caller can try again in this process.
      await node.stop().catch(() => {});
      throw e;
    }
    return node;
  }

  private networkStarted = false;
  /** The limits blocks and evidence are held to; the evidence age in it follows the application's unbonding period. */
  private limits!: ValidationLimits;

  /** The evidence age in force now: the operator's figure, else the unbonding period the application holds. */
  private evidenceAge(): bigint {
    if (this.app instanceof CoreApp && this.cfg.limits?.maxEvidenceAgeMs === undefined) this.limits.maxEvidenceAgeMs = this.app.stakingParameters().unbondingPeriodMs;
    return this.limits.maxEvidenceAgeMs;
  }

  private async init(): Promise<void> {
    const chain = this.cfg.genesis.consensus;
    const limits = (this.limits = {
      ...DEFAULT_LIMITS,
      ...(chain?.maxEvidenceAgeMs !== undefined ? { maxEvidenceAgeMs: chain.maxEvidenceAgeMs } : {}),
      ...this.cfg.limits,
      // Last, so nothing a node is configured with changes what blocks it holds valid.
      maxBlockBytes: chain?.maxBlockBytes !== undefined ? checkMaxBlockBytes(chain.maxBlockBytes) : DEFAULT_LIMITS.maxBlockBytes,
    });

    this.network = new Network({
      chainId: this.chainId,
      nodeKey: this.nodeKey,
      transport: this.cfg.transport,
      listenAddr: this.cfg.listenAddr,
      advertiseAddr: this.cfg.advertiseAddr,
      peerDb: new PeerDb(this.cfg.dataDir ? join(this.cfg.dataDir, 'peers.json') : null, this.cfg.seeds ?? []),
      verifier: this.verifier,
      getHeight: () => this.executor?.state.lastHeight ?? 0n,
      log: this.log,
      ...this.cfg.network,
    });
    this.requester = new Requester(this.network);
    // Peers are served headers, sets and snapshots whether or not we are caught up ourselves.
    this.network.on('headerRequest', (peer, m) => {
      const stored = this.store.loadBlock(m.height);
      peer.send({ type: 'headerResponse', height: m.height, header: stored?.block.header ?? null, commit: stored?.commit ?? null });
    });
    this.network.on('headersRequest', (peer, m) => {
      // Downward from the height asked: block headers, or headers kept alone, as many consecutive ones as are held.
      const headers: Header[] = [];
      for (let h = m.height; h >= 1n && headers.length < Math.min(m.count, MAX_HEADERS); h--) {
        const header = this.store.loadBlock(h)?.block.header ?? this.store.loadHeader(h);
        if (!header) break;
        headers.push(header);
      }
      peer.send({ type: 'headersResponse', height: m.height, headers });
    });
    this.network.on('validatorSetRequest', (peer, m) => peer.send({ type: 'validatorSetResponse', hash: m.hash, set: this.store.loadValidatorSet(m.hash) }));
    this.network.on('validatorsRequest', (peer, m) => peer.send({ type: 'validatorsResponse', height: m.height, set: this.store.loadValidatorsAt(m.height) }));
    this.network.on('snapshotsRequest', (peer) => peer.send({ type: 'snapshotsResponse', heights: this.app instanceof CoreApp ? this.app.snapshotHeights() : [] }));
    this.network.on('manifestRequest', (peer, m) => peer.send({ type: 'manifestResponse', height: m.height, manifest: this.app instanceof CoreApp ? this.app.manifestBytes(m.height) : null }));
    this.network.on('chunkRequest', (peer, m) => peer.send({ type: 'chunkResponse', height: m.height, objectType: m.objectType, index: m.index, chunk: this.app instanceof CoreApp ? this.app.chunkBytes(m.height, m.objectType, m.index) : null }));

    if (this.cfg.stateSync && !this.store.loadState()) {
      if (this.cfg.app) throw new Error('state sync needs the node to construct the application itself');
      await this.network.start();
      this.networkStarted = true;
      const joined = await stateSync({
        chainId: this.chainId,
        network: this.network,
        requester: this.requester,
        verifier: this.verifier,
        chainStore: this.store,
        appKv: this.env.store('app'),
        types: CORE_TYPES,
        retainVersions: this.cfg.retain?.versions,
        log: this.log,
        trustHeight: this.cfg.stateSync.trustHeight,
        trustHash: this.cfg.stateSync.trustHash,
        scheme: this.nodeKey.scheme,
        // The same age the node will hold blocks to: the operator's figure, else the unbonding period the imported state holds.
        evidenceAgeMs: (db) => this.cfg.limits?.maxEvidenceAgeMs ?? getGlobal(db).staking.unbondingPeriodMs,
        transaction: (fn) => this.env.transaction(fn),
      });
      if (joined) this.joinedAt = joined.height;
    }

    if (this.cfg.app) this.app = this.cfg.app;
    else {
      const kv = this.env.store('app');
      // Parsed only when the store is empty: a large genesis is streamed from its file once, at first start.
      const appGenesis = CoreApp.hasState(kv) ? undefined : await loadAppGenesis(this.cfg.genesis);
      this.app = new CoreApp({
        genesis: this.cfg.genesis,
        appGenesis,
        verifier: this.verifier,
        kv,
        log: this.log,
        retainVersions: this.cfg.retain?.versions,
        snapshotInterval: this.cfg.snapshotInterval,
        snapshotsKept: this.cfg.retain?.snapshots,
        arenaBytes: this.cfg.arenaBytes,
        indexTrees: this.indexTrees === 'store' ? false : undefined,
        // Under a heap limit, a stored state whose trees would not fit in the room left below OPEN_FILL (half) of the limit is opened paged.
        heapRoom: heapLimitFlag() === null ? undefined : Math.max(0, Node.OPEN_FILL * memoryStats().heapLimit - heapInUse(memoryStats())),
      });
    }
    if (this.app instanceof CoreApp && this.indexTrees === 'store') this.app.db.dropIndexTrees();
    // A window in memory shorter than the provable one, when asked for: never longer than what the store was opened with.
    if (this.app instanceof CoreApp && this.historyInMemory < this.app.db.historyWindow) this.app.db.setHistoryWindow(this.historyInMemory);
    // Half the block at most, with the four bytes of its length: the block builder gives evidence no more than
    // the other half, so a transaction admitted here fits the next block it is first in line for.
    this.mempool = new Mempool(this.app, { maxTxBytes: Math.min(1024 * 1024, Math.floor(this.limits.maxBlockBytes / 2) - 4) });
    this.executor = await BlockExecutor.open(
      {
        app: this.app,
        store: this.store,
        mempool: this.mempool,
        evidencePool: this.evidencePool,
        log: this.log,
        retainBlocks: this.cfg.retain?.blocks,
        // The node's own application keeps its state in the node's environment: a block's writes and its are one transaction.
        transaction: this.cfg.app ? undefined : (fn) => this.env.transaction(fn),
        protectedHeight: () => (this.app instanceof CoreApp ? (this.app.snapshotHeights().at(-1) ?? 0n) : 0n),
        // Read from the application each time: the executor asks after a block is applied, and a block that changed
        // the unbonding period is pruned behind with the new one, not the one in force before it.
        evidenceAgeMs: () => this.evidenceAge(),
      },
      this.cfg.genesis,
    );
    // The evidence age follows the unbonding period the application holds now, not the one genesis had.
    this.evidenceAge();

    this.gcScheduler = new GcScheduler({ log: this.log, ...this.cfg.gc });
    this.memoryGuard = new MemoryGuard({
      log: this.log,
      ...this.cfg.memory,
      onLevel: (level, stats) => this.onMemoryLevel(level, stats),
      onSample: (level, stats) => {
        if (!(this.app instanceof CoreApp)) return;
        const est = this.rebuildEstimate(this.app.db);
        this.sinceRebuild++;
        if (est.indexTrees === 0 && est.trees === 0 && this.historyHeld === 0) return;
        // While something is dropped or trimmed, the heap of the last few samples, as the levels are taken from it: the
        // old generation's garbage between major collections included.
        this.sinceDrop = level === 'ok' ? this.sinceDrop + 1 : 0;
        this.recentHeap.push(heapInUse(stats));
        if (this.recentHeap.length > Node.REBUILD_WINDOW) this.recentHeap.shift();
        if (level === 'ok') this.rebuildWhatFits(stats);
      },
    });

    this.consensus = new Consensus({
      chainId: this.chainId,
      getState: () => this.executor.state,
      applyBlock: (b, c) => this.executor.applyBlock(b, c),
      updateCommit: (h, c) => this.executor.updateCommit(h, c),
      blockTimeAt: (h) => this.executor.blockTimeAt(h),
      requestBlock: (height) => this.network.broadcast({ type: 'blockRequest', height }),
      scorePeer: (id, points, reason) => this.network.score(id, points, reason),
      getLastCommit: () => this.executor.getLastCommit(),
      validatorSetAtHeight: (h) => this.executor.validatorSetAtHeight(h),
      reapTxs: (max) => this.mempool.reap(max),
      privValidator: this.privValidator,
      verifier: this.verifier,
      evidencePool: this.evidencePool,
      broadcastProposal: (p, except) => this.network.broadcast({ type: 'proposal', proposal: p }, except),
      broadcastVote: (v, except) => this.network.broadcast({ type: 'vote', vote: v }, except),
      timeouts: this.cfg.timeouts,
      limits,
      log: this.log,
    });

    this.blockSync = new BlockSync({
      chainId: this.chainId,
      getState: () => this.executor.state,
      applyBlock: (b, c) => this.executor.applyBlock(b, c),
      validatorSetAtHeight: (h) => this.executor.validatorSetAtHeight(h),
      blockTimeAt: (h) => this.executor.blockTimeAt(h),
      store: this.store,
      verifier: this.verifier,
      limits,
      network: this.network,
      requester: this.requester,
      isConsensusDeciding: () => this.consensus.isDeciding,
      onBlockApplied: () => this.consensus.restart(),
      log: this.log,
      lagGraceMs: this.cfg.lagGraceMs,
      backfill: this.cfg.stateSync?.backfill ?? true,
      retainBlocks: this.cfg.retain?.blocks,
      scorePeer: (id, points, reason) => this.network.score(id, points, reason),
    });
    // A block fetched for the height consensus is on: it stands in for the proposal.
    this.network.on('blockResponse', (_peer, m) => {
      if (m.block && m.height === this.consensus.height) this.detached(this.consensus.handleFetchedBlock(m.block), 'fetched block');
    });

    // Consensus messages are pushed straight through; no inventory round trip.
    this.network.on('proposal', (peer, m) => this.detached(this.consensus.handleProposal(m.proposal, peer.id), 'proposal'));
    this.network.on('vote', (peer, m) => this.detached(this.consensus.handleVote(m.vote, peer.id), 'vote'));
    // A peer that just connected missed everything flooded before; catch it up on the current height.
    this.network.onPeer((peer) => {
      const { proposals, votes } = this.consensus.messagesForPeer();
      for (const proposal of proposals) peer.send({ type: 'proposal', proposal });
      for (const vote of votes) peer.send({ type: 'vote', vote });
      // Evidence still waiting for a block is announced too; it was flooded before this peer existed.
      const pending = this.evidencePool.list(Infinity).map(evidenceId);
      for (let i = 0; i < pending.length; i += 256) peer.send({ type: 'inv', kind: InvKind.Evidence, hashes: pending.slice(i, i + 256) });
    });

    // Transactions and evidence use announce-and-fetch.
    this.mempool.on('tx', (hash, _tx, source) => this.network.broadcast({ type: 'inv', kind: InvKind.Tx, hashes: [hash] }, source));
    this.evidencePool.onAdded((ev) => this.network.broadcast({ type: 'inv', kind: InvKind.Evidence, hashes: [evidenceId(ev)] }));
    // What a peer announces and we lack is fetched at most once while a fetch is outstanding, in batches the serving
    // side accepts. Each fetch is remembered with its kind and the peers it was sent to: only their answers are taken.
    // After ten seconds without one the item may be asked of another peer, of four at most, and an entry lives a
    // minute from its first fetch whatever is asked after. The entries are bounded in all and for each peer, so
    // peers that announce and never answer cannot make the node remember without limit. An entry is for one kind
    // and hash, so an announcement of one kind cannot stand in the way of another's, and its times are read from a
    // clock that never goes back, which the order of expiry depends on.
    const outstanding = new Map<string, { first: number; at: number; peers: Set<string> }>();
    const asked = new Map<string, number>();
    const release = (peer: string) => {
      const n = (asked.get(peer) ?? 1) - 1;
      if (n > 0) asked.set(peer, n);
      else asked.delete(peer);
    };
    const drop = (k: string, o: { peers: Set<string> }) => {
      for (const p of o.peers) release(p);
      outstanding.delete(k);
    };
    const wanted = (peer: string, kind: number, hashes: Uint8Array[], have: (h: Uint8Array) => boolean) => {
      const now = performance.now();
      // Entries stay in the order they were made, so the expired ones are the first.
      for (const [k, o] of outstanding) {
        if (now - o.first <= FETCH_LIFETIME_MS) break;
        drop(k, o);
      }
      const out: Uint8Array[] = [];
      let mine = asked.get(peer) ?? 0;
      for (const h of hashes) {
        if (mine >= MAX_OUTSTANDING_PER_PEER) break;
        if (have(h)) continue;
        const k = `${kind}:${toHex(h)}`;
        const o = outstanding.get(k);
        if (o) {
          // A peer already asked is not asked again, and does not push back the moment another may be.
          if (o.peers.has(peer) || now - o.at <= FETCH_RETRY_MS || o.peers.size >= 4) continue;
          o.at = now;
          o.peers.add(peer);
        } else {
          // Full: nothing new is remembered, but a hash further on that has an entry may still be due another peer.
          if (outstanding.size >= MAX_OUTSTANDING) continue;
          outstanding.set(k, { first: now, at: now, peers: new Set([peer]) });
        }
        mine++;
        out.push(h);
      }
      if (mine > 0) asked.set(peer, mine);
      return out;
    };
    /** Whether this peer was asked for this item within the last minute. The item settles the fetch; a peer that lacks it only steps out of it. */
    const answered = (peer: string, kind: number, hash: Uint8Array, found: boolean) => {
      const k = `${kind}:${toHex(hash)}`;
      const o = outstanding.get(k);
      if (!o || !o.peers.has(peer)) return false;
      // An answer that comes after the entry's minute is not one to a fetch still open.
      if (performance.now() - o.first > FETCH_LIFETIME_MS) {
        drop(k, o);
        return false;
      }
      if (found) drop(k, o);
      else {
        o.peers.delete(peer);
        release(peer);
        if (o.peers.size === 0) outstanding.delete(k);
      }
      return true;
    };
    // A peer that left will not answer. Its fetches are forgotten, so what it announces when it is back is asked again.
    this.network.onPeerGone((peer) => {
      if (!asked.has(peer.id)) return;
      for (const [k, o] of outstanding) if (o.peers.delete(peer.id) && o.peers.size === 0) outstanding.delete(k);
      asked.delete(peer.id);
    });
    this.network.on('inv', (peer, m) => {
      // A mempool that would refuse them (full, or its limit lowered under memory pressure) fetches nothing peers announce.
      const want = m.kind === InvKind.Tx ? (!this.mempool.accepting ? [] : wanted(peer.id, m.kind, m.hashes, (h) => this.mempool.seen(h))) : m.kind === InvKind.Evidence ? wanted(peer.id, m.kind, m.hashes, (h) => this.evidencePool.hasHash(h)) : [];
      for (let i = 0; i < want.length; i += 256) peer.send({ type: 'fetch', kind: m.kind, hashes: want.slice(i, i + 256) });
    });
    this.network.on('fetch', (peer, m) => {
      const hashes = [...new Map(m.hashes.map((h) => [toHex(h), h])).values()].slice(0, 256);
      if (hashes.length < m.hashes.length) this.network.score(peer.id, 5, 'oversized or repetitive fetch');
      for (const h of hashes) {
        if (m.kind === InvKind.Tx) {
          const tx = this.mempool.get(h);
          peer.send(tx ? { type: 'item', kind: InvKind.Tx, data: tx } : { type: 'itemNotFound', kind: InvKind.Tx, hash: h });
        } else if (m.kind === InvKind.Evidence) {
          const ev = this.evidencePool.getByHash(h);
          peer.send(ev ? { type: 'item', kind: InvKind.Evidence, data: encode((w) => encodeEvidence(w, ev)) } : { type: 'itemNotFound', kind: InvKind.Evidence, hash: h });
        }
      }
    });
    this.network.on('item', (peer, m) => {
      // An item nobody asked this peer for is dropped unread: a peer cannot push transactions or evidence past the
      // announce-and-fetch round, which is what bounds how much of either it can make this node check.
      if (!answered(peer.id, m.kind, m.kind === InvKind.Tx ? txHash(m.data) : sha256(m.data), true)) return;
      if (m.kind === InvKind.Tx) this.detached(this.mempool.addTx(m.data, peer.id), 'transaction');
      else if (m.kind === InvKind.Evidence) this.detached(this.acceptEvidence(peer.id, m.data), 'evidence');
    });
    this.network.on('itemNotFound', (peer, m) => void answered(peer.id, m.kind, m.hash, false));

    // Every commit is announced so lagging peers know to sync, and the evidence age tracks the unbonding period.
    this.executor.onCommitted((block) => {
      this.network.broadcast({ type: 'status', height: block.header.height });
      // The idle moment after a commit is where collections are least in the way.
      if (!this.stopping) {
        this.afterCommit ??= setImmediate(() => {
          this.afterCommit = null;
          this.gcScheduler.afterCommit();
        });
      }
      this.evidenceAge();
    });
  }

  /** Gossiped evidence: verify against the set of its height before pooling it. */
  private async acceptEvidence(peerId: string, data: Uint8Array): Promise<void> {
    let ev;
    try {
      ev = decode(data, decodeEvidence);
    } catch {
      this.network.score(peerId, 20, 'malformed evidence');
      return;
    }
    if (this.evidencePool.has(ev)) return;
    // Evidence no later block could carry is not pooled: it would hold one of the pending places until the next
    // commit let it go. Measured at the last block's time, which is the earliest the next block's can be. The peer
    // is not marked for it: it may be ahead of this node, or hold history this node has pruned.
    const state = this.executor.state;
    if (evidenceAgeOk(evidenceHeight(ev), state.lastHeight + 1n, state.lastBlockTime, state, this.limits, (h) => this.executor.blockTimeAt(h))) return;
    const set = this.executor.validatorSetAtHeight(evidenceHeight(ev));
    if (!set) return;
    const err = await verifyEvidence(this.chainId, ev, set, this.verifier);
    if (err) {
      this.network.score(peerId, 20, `invalid evidence: ${err}`);
      return;
    }
    if (this.evidencePool.add(ev)) this.log('warn', 'evidence received from peer', { h: evidenceHeight(ev), kind: ev.kind, validator: evidenceValidator(ev) });
  }

  /**
   * Work begun for a message from a peer and not waited for. Whatever it ends with is taken here: one that was
   * waiting on a verification when the node stopped resumes to a closed store or a closed verifier pool, and that
   * is the end of it, not an error nobody handles. While the node runs a failure is worth a line in the log.
   */
  private detached(work: Promise<unknown>, what: string): void {
    work.catch((e) => {
      this.log(this.stopping ? 'debug' : 'warn', `handling a ${what} failed`, { err: e instanceof Error ? e.message : String(e) });
    });
  }

  private starting: Promise<void> | null = null;

  /** A start that a stop overtakes goes no further, and the stop waits for it before it closes anything. */
  start(): Promise<void> {
    return (this.starting ??= this.startUp());
  }

  private async startUp(): Promise<void> {
    if (this.started || this.stopping) return;
    this.started = true;
    if (!this.networkStarted) {
      // Marked before the wait, so a stop that comes during it stops the network this is starting.
      this.networkStarted = true;
      await this.network.start();
    }
    if (this.stopping) return;
    this.blockSync.start();
    this.consensus.start();
    // Opening a store leaves garbage several times what it keeps (every stored entry read and checked), and the
    // guard's first sample would take it for a full heap and stop a node that fits: collect it first.
    await this.gcScheduler.major();
    if (this.stopping) return;
    this.memoryGuard.start();
    // The guard's first sample may have found the heap critical and its listener begun a stop.
    if (this.stopping) return;
    this.gcScheduler.start();
    this.log('info', 'node started', {
      height: this.executor.state.lastHeight,
      validator: this.privValidator ? this.privValidator.address : null,
      nodeId: this.network.id.slice(0, 8),
    });
  }

  private stopping: Promise<void> | null = null;
  /** The collection queued for the moment after a commit, so that a stop can take it back. */
  private afterCommit: NodeJS.Immediate | null = null;

  /**
   * Stopping twice is stopping once: a second caller waits for the first, and the claim is released when that one
   * is done. `beforeClose` is waited for once the node has stopped what it runs and before its store is closed: whoever
   * still reads the store, an RPC server finishing its requests for one, is given until then. Only the first
   * caller's is used.
   */
  stop(beforeClose?: () => Promise<unknown>): Promise<void> {
    return (this.stopping ??= this.shutDown(beforeClose));
  }

  private async shutDown(beforeClose?: () => Promise<unknown>): Promise<void> {
    // Every step is tried whatever the ones before it did, and the first failure is the one the caller is given.
    let failed = false;
    let failure: unknown;
    const step = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        if (!failed) failure = e;
        failed = true;
      }
    };
    if (this.afterCommit) clearImmediate(this.afterCommit);
    this.afterCommit = null;
    try {
      // A start still on its way ends first: it sees the stop after each of its waits and goes no further.
      await step(() => this.starting);
      await step(async () => {
        if (this.started) {
          this.started = false;
          this.memoryGuard.stop();
          this.gcScheduler.stop();
          this.consensus.stop();
          this.blockSync.stop();
        }
        // The network may be up from a state-sync join even if start() was never called.
        if (this.networkStarted) {
          this.networkStarted = false;
          await this.network.stop();
        }
      });
      // A block being applied finishes its writes before the store goes away.
      await step(() => this.executor?.idle());
      await step(() => beforeClose?.());
      // The store the node opened, and also one it was handed for a directory it holds the claim on: the claim
      // says nobody else writes there, so it cannot be given up while that store is open.
      await step(() => (this.ownsEnv || this.releaseLock ? this.env.close() : undefined));
      await step(() => this.ownVerifier?.close());
    } finally {
      // Last: until the store is closed and the writes are done, another node on the directory would be writing
      // beside this one.
      this.releaseLock?.();
      this.releaseLock = null;
    }
    if (failed) throw failure;
  }

  get height(): bigint {
    return this.executor.state.lastHeight;
  }

  /**
   * Called on every change of the memory guard's level; the CLI stops the node on `critical`. A listener added once
   * the guard is sampling is told the level it is at, unless that is `ok`: a node already critical at its first
   * sample would otherwise never be reported, since a level that stays the same fires nothing.
   */
  onMemory(fn: (level: MemoryLevel, stats: MemoryStats) => void): void {
    this.memoryListeners.push(fn);
    if (this.started && this.memoryGuard.level !== 'ok') fn(this.memoryGuard.level, this.memoryGuard.stats);
  }

  get memoryLevel(): MemoryLevel {
    return this.memoryGuard.level;
  }

  /** True while load is shed: the mempool's limit is lowered, costly RPC methods and new streams are refused. */
  get isShedding(): boolean {
    return this.shedding;
  }

  /** The database's hot cache of decoded objects: unbounded while memory is fine, capped as it fills (STATE-PAGING.md section 7). */
  static readonly HOT_OBJECTS = { ok: Infinity, warn: 100_000, pressure: 10_000, critical: 10_000 } as const;

  /**
   * The share of its limit the mempool admits up to at each level. Every pooled transaction holds its bytes, its
   * writes in the pending state and its overlay entries, so the pool's size is a dial like the others; lowered in
   * steps, the node goes on admitting at the rate its blocks take transactions out instead of refusing everything
   * and then everything at once. At `critical` nothing is admitted: the node is about to stop.
   */
  static readonly MEMPOOL_SHARE = { ok: 1, warn: 0.5, pressure: 0.1, critical: 0 } as const;

  private onMemoryLevel(level: MemoryLevel, stats: MemoryStats): void {
    if (level === 'warn' || level === 'pressure') void this.gcScheduler.major();
    this.mempool.setLimit(this.mempool.maxTxs * Node.MEMPOOL_SHARE[level]);
    if (level === 'critical') this.mempool.pause('node out of memory');
    else this.mempool.resume();
    if (this.app instanceof CoreApp) {
      const db = this.app.db;
      db.setHotLimit(Node.HOT_OBJECTS[level]);
      // The second dial, from `warn` on: the index trees are dropped, every index read going to LMDB through the
      // overlay of the block in progress, and the window of past versions is cut to the last few, the store answering
      // for the rest. A loaded node commits more that way than with both in its heap (docs/benchmarks.md section
      // 4.13), so it does not wait for `pressure` to get there. The third, from `pressure` on: the Merkle trees are
      // dropped, every root and proof reading its paths from LMDB (STATE-PAGING.md section 7). Back at `ok` each is
      // rebuilt from LMDB when it fits.
      if (level !== 'ok') {
        db.dropIndexTrees();
        if (level !== 'warn') db.dropTrees();
        // What the window held, for letting it grow back.
        if (db.historyWindow > Node.HISTORY_WHEN_PAGED) {
          this.historyHeld = Math.max(1, this.historyHeld, db.historyEstimate());
          db.setHistoryWindow(Node.HISTORY_WHEN_PAGED);
        }
        this.deferredRebuild = null;
        this.recentHeap = [];
        // How long the node ran since it last had something rebuilt (or since it started) is how long the heap took
        // to fill: nothing is rebuilt until it has stayed at `ok` for as long again.
        this.rebuildAfter = Math.min(Node.REBUILD_WAIT_MAX, Math.max(Node.REBUILD_WINDOW, this.sinceRebuild));
        this.sinceDrop = 0;
      }
    }
    this.shed(level === 'pressure' || level === 'critical');
    for (const fn of this.memoryListeners) fn(level, stats);
  }

  /**
   * The share of the heap limit a stored state's trees may fill when it is opened: what a rebuild is allowed
   * (REBUILD_FILL). Opened up to the warn line, a state the size of the heap ran just under `warn` and reached it
   * every ten seconds (docs/benchmarks.md section 4.13).
   */
  static readonly OPEN_FILL = 0.5;
  /** How many past versions stay in memory from `warn` on: enough for a proof at the height a client just read. */
  static readonly HISTORY_WHEN_PAGED = 2;
  /** About the heap the window of past versions held when it was trimmed, 0 while it is whole: what letting it grow back will take. */
  private historyHeld = 0;
  /** What the last deferred rebuild was waiting for, so the log says it once rather than at every sample. */
  private deferredRebuild: string | null = null;
  /** Guard samples since something was last rebuilt (or the node started), and samples in a row at `ok` with something dropped. */
  private sinceRebuild = 0;
  private sinceDrop = 0;
  /** How many samples after the last drop the node waits before it rebuilds anything; set at each drop, REBUILD_WINDOW at least. */
  private rebuildAfter = 0;
  /** The longest that wait gets: ten minutes at the default interval. */
  static readonly REBUILD_WAIT_MAX = 600;
  /** The index trees are left in the store unless the config asks for them in memory. */
  private get indexTrees(): 'memory' | 'store' {
    return this.cfg.indexTrees ?? 'store';
  }
  /** How many past versions the operator wants in memory (`retain.memoryVersions`); all of the window when unset. */
  private get historyInMemory(): number {
    return this.cfg.retain?.memoryVersions ?? Infinity;
  }
  /** Heap used at each guard sample since the last drop, the latest REBUILD_WINDOW of them. */
  private recentHeap: number[] = [];
  /** How many samples after a drop the heap is watched before anything is rebuilt: ten seconds at the default interval. */
  static readonly REBUILD_WINDOW = 10;
  /**
   * The share of the heap limit a rebuild may fill. Well below the warn line: what is rebuilt up to that line leaves
   * the load no room, and a node whose index trees just fitted spent minutes between `warn` and `pressure`, the
   * collector working on a nearly full old generation, committing a fifth less than it did with them dropped.
   */
  static readonly REBUILD_FILL = 0.5;

  /** What rebuilding the dropped tiers would take; index trees kept in the store by choice are not waiting to be rebuilt. */
  private rebuildEstimate(db: CoreApp['db']): { indexTrees: number; trees: number } {
    const est = db.rebuildEstimate();
    return this.indexTrees === 'store' ? { ...est, indexTrees: 0 } : est;
  }

  /**
   * At `ok`, rebuild what was dropped, but only what fits: dropping can take the heap from above the pressure line to
   * below the ok line in one go, and rebuilding all of it then would take it straight back, and the node would drop
   * and rebuild at every sample. One sample is not enough to judge by either: right after a major collection the old
   * generation reads lower than it will once the load has refilled it. And a load that filled the heap once fills
   * it again: trees rebuilt ten seconds after a drop were dropped again a few minutes later, the node committing less
   * while it had them. So nothing is rebuilt until the heap has stayed at `ok` for as long as the node had run before
   * the drop (`rebuildAfter`: REBUILD_WINDOW samples at least, REBUILD_WAIT_MAX at most), and then a tier is rebuilt when its estimated heap
   * (ObjectDatabase.rebuildEstimate) fits within REBUILD_FILL of the limit beside the highest of those samples, the
   * index trees first; otherwise it stays dropped, which the node runs fine on, and the guard asks again at every
   * sample while the level is `ok`.
   */
  private rebuildWhatFits(stats: MemoryStats): void {
    if (!(this.app instanceof CoreApp)) return;
    const db = this.app.db;
    const est = this.rebuildEstimate(db);
    if (est.indexTrees === 0 && est.trees === 0 && this.historyHeld === 0) return;
    if (this.recentHeap.length < Node.REBUILD_WINDOW || this.sinceDrop < this.rebuildAfter) return;
    const peak = Math.max(...this.recentHeap);
    let room = Math.min(Node.REBUILD_FILL, this.memoryGuard.o.warnAt) * stats.heapLimit - peak;
    if (est.indexTrees > 0 && est.indexTrees <= room) {
      db.rebuildIndexTrees();
      this.sinceRebuild = 0;
      room -= est.indexTrees;
      // The samples from before it do not count for the next tier: the heap is larger by that much now.
      this.recentHeap = this.recentHeap.map((h) => h + est.indexTrees);
      this.log('info', 'memory: index trees rebuilt', { estimate: `${Math.round(est.indexTrees / 1048576)} MiB` });
    }
    if (est.trees > 0 && est.trees <= room) {
      db.rebuildTrees();
      this.sinceRebuild = 0;
      room -= est.trees;
      this.recentHeap = this.recentHeap.map((h) => h + est.trees);
      this.log('info', 'memory: Merkle trees rebuilt', { estimate: `${Math.round(est.trees / 1048576)} MiB` });
    }
    const left = this.rebuildEstimate(db);
    // Last, with both tiers back: the window of past versions is let grow again, a root at a time, if what it held fits.
    if (this.historyHeld > 0 && left.indexTrees + left.trees === 0 && this.historyHeld <= room) {
      db.setHistoryWindow(this.historyInMemory);
      this.sinceRebuild = 0;
      this.log('info', 'memory: history window restored', { estimate: `${Math.round(this.historyHeld / 1048576)} MiB`, provableFrom: db.lowestVersion });
      this.historyHeld = 0;
    }
    const needs = left.indexTrees + left.trees + this.historyHeld;
    const waiting = needs > 0 ? `${Math.round(needs / 1048576)} MiB` : null;
    // Said once per drop: what is needed grows with the state, and a line at every MiB of it filled the log.
    if (waiting && this.deferredRebuild === null) this.log('info', 'memory: staying paged until the heap has room to rebuild', { needs: waiting, room: `${Math.round(Math.max(0, room) / 1048576)} MiB` });
    this.deferredRebuild = waiting;
  }

  private shed(on: boolean): void {
    if (on === this.shedding) return;
    this.shedding = on;
    if (on && this.app instanceof CoreApp) this.app.dropSignatureCache();
    this.log(on ? 'warn' : 'info', on ? 'shedding load: mempool limit lowered, costly requests refused' : 'load shedding over', { mempool: this.mempool.size, limit: this.mempool.currentLimit });
  }

  get genesis(): Genesis {
    return this.cfg.genesis;
  }

  /** Submit a transaction locally, as an RPC endpoint would. */
  submitTx(tx: Uint8Array): Promise<AddTxResult> {
    return this.mempool.addTx(tx, null);
  }

  /**
   * A state proof as an RPC would serve it: the object at `height` (default
   * the latest height whose next header exists) with the header that commits
   * to it and that header's commit. Null if the app cannot prove, or the
   * chain has not yet committed the following block.
   */
  queryState(id: bigint, height?: bigint): StateQueryResult | null {
    const app = this.app as Partial<CoreApp>;
    if (typeof app.proofAt !== 'function' || app.lowestProvableHeight === undefined) return null;
    const h = height ?? this.executor.state.lastHeight - 1n;
    if (h < app.lowestProvableHeight) return null;
    const next = this.store.loadBlock(h + 1n);
    if (!next) return null;
    const proof: ObjectProof = app.proofAt(id, h);
    return { proof, header: next.block.header, commit: next.commit };
  }

  /**
   * A transaction with its inclusion proof against its block's header and, once
   * the next block exists and this node holds the block's results (a backfilled
   * block has none), its result proof against that header. Null if unknown.
   */
  queryTx(hash: Uint8Array): TxQueryResult | null {
    const loc = this.store.txLocation(hash);
    if (!loc) return null;
    const at = this.store.loadBlock(loc.height);
    if (!at) return null;
    const next = this.store.loadBlock(loc.height + 1n);
    const results = this.store.loadResults(loc.height);
    return {
      txProof: txProofFor(loc.height, at.block.txs, loc.index),
      header: at.block.header,
      commit: at.commit,
      resultProof: next && results ? resultProofFor(loc.height, results, loc.index) : null,
      nextHeader: next?.block.header ?? null,
      nextCommit: next?.commit ?? null,
    };
  }

  /** The same for an account name: which id it maps to, or that it is free. */
  queryAccountName(name: string, height?: bigint): KeyQueryResult | null {
    const app = this.app as Partial<CoreApp>;
    if (typeof app.proveAccountName !== 'function' || app.lowestProvableHeight === undefined) return null;
    const h = height ?? this.executor.state.lastHeight - 1n;
    if (h < app.lowestProvableHeight) return null;
    const next = this.store.loadBlock(h + 1n);
    if (!next) return null;
    const proof: KeyProof = app.proveAccountName(name, h);
    return { proof, header: next.block.header, commit: next.commit };
  }
}
