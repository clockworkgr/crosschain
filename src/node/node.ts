/**
 * A node: consensus engine, mempool, networking, block sync, storage, and
 * one application, wired together. Validators and full nodes run the same
 * code; a full node simply has no validator key.
 */
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Application } from '../app/types.ts';
import { CoreApp } from '../app/core/app.ts';
import { loadAppGenesis } from '../app/core/genesis.ts';
import { Consensus, DEFAULT_LIMITS, type ConsensusTimeouts } from '../consensus/consensus.ts';
import { EvidencePool, evidenceId, verifyDuplicateVoteEvidence } from '../consensus/evidence.ts';
import { decodeEvidence, encodeEvidence } from '../types/evidence.ts';
import { decode } from '../codec/reader.ts';
import { sha256, toHex } from '../crypto/hash.ts';
import { txHash, type Header } from '../types/block.ts';
import { encode } from '../codec/writer.ts';
import { Requester } from '../p2p/request.ts';
import { stateSync } from '../sync/statesync.ts';
import { CORE_TYPES } from '../app/core/types.ts';
import { getGlobal } from '../app/core/state.ts';
import { FileSignStateStore, MemorySignStateStore, PrivValidator } from '../consensus/privval.ts';
import type { ValidationLimits } from '../consensus/validate.ts';
import { keyPairFromSeed, schemeTag, type KeyPair } from '../crypto/keys.ts';
import { InlineVerifier, type Verifier } from '../crypto/verifier.ts';
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
import type { Genesis } from '../types/genesis.ts';
import { makeLogger, type Logger, type LogLevel } from '../util/log.ts';
import { BlockExecutor } from './executor.ts';
import { GcScheduler, MemoryGuard, type GcSchedulerOptions, type MemoryGuardOptions, type MemoryLevel, type MemoryStats } from './memory.ts';

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
  /** Retention: blocks kept behind the latest (all when unset), provable heights, snapshots kept. */
  retain?: { blocks?: number; versions?: number; snapshots?: number };
  /** Export a state snapshot every this many blocks; 0 disables. */
  snapshotInterval?: number;
  verifier?: Verifier;
  timeouts?: Partial<ConsensusTimeouts>;
  limits?: Partial<ValidationLimits>;
  network?: Partial<Pick<NetworkConfig, 'desiredOutbound' | 'maxInbound' | 'connectIntervalMs' | 'pingIntervalMs' | 'idleTimeoutMs'>>;
  lagGraceMs?: number;
  log?: Logger;
  logLevel?: LogLevel;
  /** Heap thresholds and sampling for the memory guard (see memory.ts); tests inject their own `stats`. */
  memory?: Partial<Omit<MemoryGuardOptions, 'log' | 'onLevel' | 'onSample'>>;
  /** Collection scheduling after commits; `gc: null` turns it off. */
  gc?: Partial<Omit<GcSchedulerOptions, 'log'>>;
}

/**
 * Claim a data directory for this process. A stale claim from a process that no longer runs is taken over;
 * a live one refuses, since two nodes on one directory would double sign.
 */
/** Directories this process holds, so two nodes in one process are refused as surely as two processes are. */
const heldDirs = new Set<string>();

function lockDataDir(dir: string): () => void {
  const path = join(dir, 'LOCK');
  if (heldDirs.has(dir)) throw new Error(`data directory ${dir} is in use by this process`);
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    let alive = false;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    if (alive) throw new Error(`data directory ${dir} is in use by process ${pid}`);
  }
  writeFileSync(path, String(process.pid));
  heldDirs.add(dir);
  return () => {
    heldDirs.delete(dir);
    try {
      unlinkSync(path);
    } catch {
      // Already gone: nothing to release.
    }
  };
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
    this.verifier = cfg.verifier ?? new InlineVerifier();
    // One scheme per chain, genesis's, for the node identity and the validator key alike.
    const scheme = schemeTag(cfg.genesis.signatureScheme ?? 'ml-dsa-44');
    this.nodeKey = keyPairFromSeed(cfg.nodeKeySeed, scheme);
    if (cfg.dataDir) mkdirSync(cfg.dataDir, { recursive: true });
    // Two nodes on one directory would share a signing guard that neither sees the other write.
    this.releaseLock = cfg.dataDir ? lockDataDir(cfg.dataDir) : null;
    this.env = cfg.env ?? (cfg.dataDir ? new LmdbEnv(join(cfg.dataDir, 'lmdb')) : new MemoryEnv());
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
  }

  static async create(cfg: NodeConfig): Promise<Node> {
    const node = new Node(cfg);
    await node.init();
    return node;
  }

  private networkStarted = false;

  private async init(): Promise<void> {
    const limits = { ...DEFAULT_LIMITS, ...(this.cfg.genesis.consensus?.maxEvidenceAgeMs !== undefined ? { maxEvidenceAgeMs: this.cfg.genesis.consensus.maxEvidenceAgeMs } : {}), ...this.cfg.limits };

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
      });
    }
    this.mempool = new Mempool(this.app);
    this.executor = await BlockExecutor.open(
      {
        app: this.app,
        store: this.store,
        mempool: this.mempool,
        evidencePool: this.evidencePool,
        log: this.log,
        retainBlocks: this.cfg.retain?.blocks,
        protectedHeight: () => (this.app instanceof CoreApp ? (this.app.snapshotHeights().at(-1) ?? 0n) : 0n),
        evidenceAgeMs: () => limits.maxEvidenceAgeMs,
      },
      this.cfg.genesis,
    );
    // The evidence age follows the unbonding period the application holds now, not the one genesis had.
    if (this.app instanceof CoreApp && this.cfg.limits?.maxEvidenceAgeMs === undefined) limits.maxEvidenceAgeMs = this.app.stakingParameters().unbondingPeriodMs;

    this.gcScheduler = new GcScheduler({ log: this.log, ...this.cfg.gc });
    this.memoryGuard = new MemoryGuard({
      log: this.log,
      ...this.cfg.memory,
      onLevel: (level, stats) => this.onMemoryLevel(level, stats),
      onSample: (level, stats) => {
        if (!(this.app instanceof CoreApp)) return;
        const est = this.app.db.rebuildEstimate();
        if (est.indexTrees === 0 && est.trees === 0) return;
        // While something is dropped, the heap of the last few samples: garbage between collections included, since
        // that is what the levels are taken from.
        this.recentHeap.push(stats.heapUsed);
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
      if (m.block && m.height === this.consensus.height) void this.consensus.handleFetchedBlock(m.block);
    });

    // Consensus messages are pushed straight through; no inventory round trip.
    this.network.on('proposal', (peer, m) => void this.consensus.handleProposal(m.proposal, peer.id));
    this.network.on('vote', (peer, m) => void this.consensus.handleVote(m.vote, peer.id));
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
    // What a peer announces and we lack is fetched at most once while a fetch is outstanding, in batches the serving side accepts.
    const outstanding = new Map<string, number>();
    const wanted = (hashes: Uint8Array[], have: (h: Uint8Array) => boolean) => {
      const now = Date.now();
      for (const [k, t] of outstanding) if (now - t > 10_000) outstanding.delete(k);
      const out: Uint8Array[] = [];
      for (const h of hashes) {
        const k = toHex(h);
        if (have(h) || outstanding.has(k)) continue;
        outstanding.set(k, now);
        out.push(h);
      }
      return out;
    };
    this.network.on('inv', (peer, m) => {
      // Under memory pressure the mempool admits nothing, so there is no point fetching what peers announce.
      const want = m.kind === InvKind.Tx ? (this.mempool.paused ? [] : wanted(m.hashes, (h) => this.mempool.seen(h))) : m.kind === InvKind.Evidence ? wanted(m.hashes, (h) => this.evidencePool.hasHash(h)) : [];
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
      outstanding.delete(toHex(m.kind === InvKind.Tx ? txHash(m.data) : sha256(m.data)));
      if (m.kind === InvKind.Tx) void this.mempool.addTx(m.data, peer.id);
      else if (m.kind === InvKind.Evidence) void this.acceptEvidence(peer.id, m.data);
    });
    this.network.on('itemNotFound', (_peer, m) => outstanding.delete(toHex(m.hash)));

    // Every commit is announced so lagging peers know to sync, and the evidence age tracks the unbonding period.
    this.executor.onCommitted((block) => {
      this.network.broadcast({ type: 'status', height: block.header.height });
      // The idle moment after a commit is where collections are least in the way.
      setImmediate(() => this.gcScheduler.afterCommit());
      if (this.app instanceof CoreApp && this.cfg.limits?.maxEvidenceAgeMs === undefined) limits.maxEvidenceAgeMs = this.app.stakingParameters().unbondingPeriodMs;
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
    const set = this.executor.validatorSetAtHeight(ev.voteA.height);
    if (!set) return;
    const err = await verifyDuplicateVoteEvidence(this.chainId, ev, set, this.verifier);
    if (err) {
      this.network.score(peerId, 20, `invalid evidence: ${err}`);
      return;
    }
    if (this.evidencePool.add(ev)) this.log('warn', 'evidence received from peer', { h: ev.voteA.height, validator: ev.voteA.validatorIndex });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.networkStarted) await this.network.start();
    this.networkStarted = true;
    this.blockSync.start();
    this.consensus.start();
    this.memoryGuard.start();
    this.gcScheduler.start();
    this.log('info', 'node started', {
      height: this.executor.state.lastHeight,
      validator: this.privValidator ? this.privValidator.address : null,
      nodeId: this.network.id.slice(0, 8),
    });
  }

  async stop(): Promise<void> {
    this.releaseLock?.();
    this.releaseLock = null;
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
    // A block being applied finishes its writes before the store goes away.
    await this.executor?.idle();
    if (this.ownsEnv) await this.env.close();
  }

  get height(): bigint {
    return this.executor.state.lastHeight;
  }

  /** Called on every change of the memory guard's level; the CLI stops the node on `critical`. */
  onMemory(fn: (level: MemoryLevel, stats: MemoryStats) => void): void {
    this.memoryListeners.push(fn);
  }

  get memoryLevel(): MemoryLevel {
    return this.memoryGuard.level;
  }

  /** True while load is shed: the mempool admits nothing, costly RPC methods and new streams are refused. */
  get isShedding(): boolean {
    return this.shedding;
  }

  /** The database's hot cache of decoded objects: unbounded while memory is fine, capped as it fills (STATE-PAGING.md section 7). */
  static readonly HOT_OBJECTS = { ok: Infinity, warn: 100_000, pressure: 10_000, critical: 10_000 } as const;

  private onMemoryLevel(level: MemoryLevel, stats: MemoryStats): void {
    if (level === 'warn' || level === 'pressure') void this.gcScheduler.major();
    if (this.app instanceof CoreApp) {
      const db = this.app.db;
      db.setHotLimit(Node.HOT_OBJECTS[level]);
      // The second and third dials: from `pressure` on the index trees are dropped, every index read going to LMDB
      // through the overlay of the block in progress, and then the Merkle trees, every root and proof reading its
      // paths from LMDB (STATE-PAGING.md section 7); back at `ok` both are rebuilt from LMDB. `warn` leaves them.
      if (level === 'pressure' || level === 'critical') {
        db.dropIndexTrees();
        db.dropTrees();
        this.deferredRebuild = null;
        this.recentHeap = [];
      }
    }
    this.shed(level === 'pressure' || level === 'critical');
    for (const fn of this.memoryListeners) fn(level, stats);
  }

  /** What the last deferred rebuild was waiting for, so the log says it once rather than at every sample. */
  private deferredRebuild: string | null = null;
  /** Heap used at each guard sample since the last drop, the latest REBUILD_WINDOW of them. */
  private recentHeap: number[] = [];
  /** How many samples after a drop the heap is watched before anything is rebuilt: ten seconds at the default interval. */
  static readonly REBUILD_WINDOW = 10;

  /**
   * At `ok`, rebuild what was dropped, but only what fits: dropping can take the heap from above the pressure line to
   * below the ok line in one go, and rebuilding all of it then would take it straight back, and the node would drop
   * and rebuild at every sample. One sample is not enough to judge by either: right after a major collection the heap
   * reads a few hundred MiB lower than it will a second later. So nothing is rebuilt until REBUILD_WINDOW samples
   * have been seen since the drop, and then a tier is rebuilt when its estimated heap
   * (ObjectDatabase.rebuildEstimate) fits under the warn line beside the highest of those samples, the index trees
   * first; otherwise it stays dropped, which the node runs fine on, and the guard asks again at every sample while
   * the level is `ok`.
   */
  private rebuildWhatFits(stats: MemoryStats): void {
    if (!(this.app instanceof CoreApp)) return;
    const db = this.app.db;
    const est = db.rebuildEstimate();
    if (est.indexTrees === 0 && est.trees === 0) return;
    if (this.recentHeap.length < Node.REBUILD_WINDOW) return;
    const peak = Math.max(...this.recentHeap);
    let room = this.memoryGuard.o.warnAt * stats.heapLimit - peak;
    if (est.indexTrees > 0 && est.indexTrees <= room) {
      db.rebuildIndexTrees();
      room -= est.indexTrees;
      // The samples from before it do not count for the next tier: the heap is larger by that much now.
      this.recentHeap = this.recentHeap.map((h) => h + est.indexTrees);
      this.log('info', 'memory: index trees rebuilt', { estimate: `${Math.round(est.indexTrees / 1048576)} MiB` });
    }
    if (est.trees > 0 && est.trees <= room) {
      db.rebuildTrees();
      this.log('info', 'memory: Merkle trees rebuilt', { estimate: `${Math.round(est.trees / 1048576)} MiB` });
    }
    const left = db.rebuildEstimate();
    const waiting = left.indexTrees + left.trees > 0 ? `${Math.round((left.indexTrees + left.trees) / 1048576)} MiB` : null;
    if (waiting && waiting !== this.deferredRebuild) this.log('info', 'memory: staying paged until the heap has room to rebuild', { needs: waiting, room: `${Math.round(Math.max(0, room) / 1048576)} MiB` });
    this.deferredRebuild = waiting;
  }

  private shed(on: boolean): void {
    if (on === this.shedding) return;
    this.shedding = on;
    if (on) {
      this.mempool.pause('node under memory pressure');
      if (this.app instanceof CoreApp) this.app.dropSignatureCache();
    } else this.mempool.resume();
    this.log(on ? 'warn' : 'info', on ? 'shedding load: mempool paused, costly requests refused' : 'load shedding over', { mempool: this.mempool.size });
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
   * the next block exists, its result proof against that header. Null if unknown.
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
