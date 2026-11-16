/**
 * The core application: accounts, assets and balances on the object
 * database, behind the engine's Application interface.
 *
 * Signature verification is the only asynchronous step, because it goes to
 * the worker pool. checkTx writes to the database only after its last await.
 * finalizeBlock awaits the pool with its block session open: it opens the
 * session and runs beginBlock, then prewarms the block's signatures, then
 * resolves each transaction's signers just before applying it. checkTx calls
 * wait behind a block in progress (`applying`), so the undo sessions nest
 * cleanly even though checkTx calls overlap each other and a finalizeBlock.
 *
 * Sessions during normal operation:
 *   pending  opened after every block; checkTx applies into it so that
 *            transactions queued behind each other are checked in sequence
 *   block    opened by finalizeBlock around everything a block does and
 *            committed before the root is taken; undone if the block fails
 *   tx       one per transaction, inside pending for a check and inside
 *            block for a block; undone if the transaction fails
 * finalizeBlock first undoes pending, so the block runs on committed state,
 * and then the engine's post-commit recheck rebuilds pending.
 *
 * State lives in memory. The key-value store holds a copy of every object,
 * written incrementally: commit() writes the objects the block changed, the
 * index entries they added and removed, the Merkle tree chunks and nodes
 * they changed, the counters that moved, and the height and app hash, in one
 * transaction. On startup everything is read back (the indices from their
 * entries and the trees from their chunks and nodes, neither rebuilt from
 * the objects; by default every object is then hashed against its leaf and
 * every index entry checked against its object), the root checked against
 * the stored app hash, and the
 * engine replays any blocks the store is behind on. The index entries and
 * the trees are also what the database falls back on when the memory guard
 * drops its index trees and its Merkle trees.
 *
 * The signature cache remembers which addresses signed a transaction id
 * validly. That fact never changes, so a transaction verified on arrival is
 * not verified again when its block is applied. Authority thresholds, which
 * do depend on state, are always rechecked. The cache only saves work: the
 * signers a transaction is applied with are the ones its own verification
 * found, cached or not, so the cache being dropped or trimmed while that
 * verification awaits the pool cannot change a result.
 */
import { decode } from '../../codec/reader.ts';
import { encode } from '../../codec/writer.ts';
import { bytesEqual, HASH_SIZE, sha256, toHex } from '../../crypto/hash.ts';
import { schemeName, schemeOf, schemeTag, signContext, type SchemeTag } from '../../crypto/keys.ts';
import type { Verifier, VerifyJob } from '../../crypto/verifier.ts';
import { decodeHistory, encodeHistory, estimateTiers, ObjectDatabase, type Changes, type UndoSession } from '../../db/database.ts';
import { idToString, type ObjectId } from '../../db/id.ts';
import { DbError, type ObjectType } from '../../db/index.ts';
import { key } from '../../db/keys.ts';
import { INDEX_PREFIX } from '../../db/indexstore.ts';
import { CHUNK_PREFIX } from '../../db/merkle.ts';
import type { KeyProof, ObjectProof } from '../../db/proof.ts';
import { MemoryKv, prefixEnd, type KvStore } from '../../store/kv.ts';
import type { Genesis } from '../../types/genesis.ts';
import { silentLogger, type Logger } from '../../util/log.ts';
import type { Application, CheckTxOptions, CheckTxResult, FinalizeBlockRequest, FinalizeBlockResult, InitChainResult, TxResult } from '../types.ts';
import { authoritySatisfied, collectKeys, type AuthorityLookup } from './authority.ts';
import { applyTransaction, getDynamic, getGlobal, pruneExpiredTxs, requiredAuthorities, TxError } from './evaluate.ts';
import { beginBlock, endBlock } from './staking.ts';
import { exportSnapshot, manifestToBytes } from './snapshot.ts';
import { HistoryLog, HistoryRecorder, type HistoryEntry } from './history.ts';
import { applyGenesis, parseAppGenesis, type AppGenesis } from './genesis.ts';
import { decodeTransaction, txBodyBytes, txIdOf, type Transaction } from './tx.ts';
import { txHash } from '../../types/block.ts';
import { AccountType, AssetType, BalanceType, CORE_TYPES, DelegationType, DYNAMIC_ID, DynamicType, GLOBAL_ID, GlobalType, ValidatorType, type Account, type ChainParameters, type DynamicProperties, type FeeSchedule, type GlobalProperties, type StakingParameters } from './types.ts';

export interface CoreAppOptions {
  genesis: Genesis;
  /** The application genesis already parsed (loadAppGenesis); required when it lives in a file. Used only if the store is empty. */
  appGenesis?: AppGenesis;
  verifier: Verifier;
  /** Where objects are persisted. Default is in memory. */
  kv?: KvStore;
  /** How many past heights stay provable. */
  retainVersions?: number;
  /** Start with the index trees dropped, every index read going to the store (STATE-PAGING.md section 4); default resident. */
  indexTrees?: boolean;
  /** Start with the Merkle trees dropped, read from the store (STATE-PAGING.md section 5); default resident. */
  trees?: boolean;
  /** The most bytes the arena of encoded objects may take, the rest read from the store (STATE-PAGING.md section 3.4); unbounded by default. */
  arenaBytes?: number;
  /**
   * Bytes of heap the index trees, the Merkle trees and the history window may take when a store is opened. A tier
   * estimated to need more is left dropped, and the history window is then not read back either (it grows again a
   * block at a time): a state too large for the heap opens paged instead of running out while it loads. Unset, every
   * tier is opened as `indexTrees` and `trees` say.
   */
  heapRoom?: number;
  /** Export a snapshot every this many blocks; 0 disables. */
  snapshotInterval?: number;
  snapshotsKept?: number;
  snapshotChunkObjects?: number;
  log?: Logger;
}

/** Transaction bodies the signature cache holds at most. */
const SIG_CACHE_MAX = 20_000;
/** Signatures it holds at most across those bodies, so the bound is on memory and not only on bodies. */
const SIG_CACHE_SIGNATURES = 40_000;
/**
 * Signatures it keeps per signer and body. A key can make any number of valid signatures over one body (a fresh
 * nonce each), and each verifies once and is then refused in execution without paying a fee; without a cap one
 * body would hold them all.
 */
const SIG_CACHE_VARIANTS = 4;

// Key layout of the app store: 'm' meta, 'o' id, 'c' type, 'h' version, 'l' 'p' 'L' the account history's log (history.ts),
// 'i' index entry (db/indexstore.ts), 't' dense tree chunk (db/merkle.ts), 'n' sparse tree node (db/smt.ts).
const META_KEY = key((k) => k.u8(0x6d));
const OBJECT_PREFIX = key((k) => k.u8(0x6f));
const INDEX_PREFIX_KEY = Uint8Array.of(INDEX_PREFIX);
const CHUNK_PREFIX_KEY = Uint8Array.of(CHUNK_PREFIX);
const HISTORY_PREFIX = key((k) => k.u8(0x68));
const objectKey = (id: ObjectId) => key((k) => k.u8(0x6f).u64(id));
const counterKey = (type: number) => key((k) => k.u8(0x63).u16(type));
const historyKey = (version: number) => key((k) => k.u8(0x68).u64(BigInt(version)));
// 's' snapshot manifest by height, 'k' snapshot chunk by height, type and index.
const MANIFEST_PREFIX = key((k) => k.u8(0x73));
const manifestKey = (height: bigint) => key((k) => k.u8(0x73).u64(height));
const chunkKey = (height: bigint, type: number, index: number) => key((k) => k.u8(0x6b).u64(height).u16(type).u32(index));
const chunkPrefix = (height: bigint) => key((k) => k.u8(0x6b).u64(height));

interface Meta {
  height: bigint;
  appHash: Uint8Array;
}

export interface OpenedDatabase {
  db: ObjectDatabase;
  height: bigint;
  appHash: Uint8Array;
  /** History versions found in the store that are outside the window; the writer deletes them. */
  staleHistory: number[];
  /** How long the phases of opening took, for the startup log. */
  timing: { objects: number; importMs: number; rootMs: number; historyMs: number; indexVersions: 'records' | 'replay' | 'none' };
  /** What was left out because `heapRoom` had no room for it: 'indexTrees', 'trees', 'history'. Empty when everything was opened. */
  paged: string[];
}

/** How to open a store: the database's options, and how the trees come back. */
export interface OpenOptions {
  retainVersions?: number;
  indexTrees?: boolean;
  trees?: boolean;
  /** As CoreAppOptions.arenaBytes: objects beyond it are left in the store instead of being loaded. */
  arenaBytes?: number;
  /** As CoreAppOptions.heapRoom: a tier that does not fit is opened dropped, and the history window with it. */
  heapRoom?: number;
  /**
   * Take the Merkle trees from their chunks and nodes in the store (the default) instead of hashing every object and
   * inserting every index key again. Either way the root must equal the stored app hash; a store written before the
   * trees were has none, and computes them.
   */
  fromTrees?: boolean;
  /**
   * With the trees from the store, check them before use (the default): every stored node against its children,
   * every object against its leaf, and every non-empty leaf against an object. The root then still proves that the
   * objects are the ones the app hash commits to, as it did when the trees were computed from them. Off, a restart is
   * faster and a corrupt object or tree node goes unnoticed until something reads it.
   */
  checkLeaves?: boolean;
  /**
   * With the index entries from the store, check them against the objects (the default): each object decoded for its
   * keys, every key stored and naming it, and no entry over. The app hash does not cover an unauthenticated index, so
   * this is the only thing that catches a damaged entry before a lookup goes to the wrong object. Off, a restart
   * decodes no object at all.
   */
  checkIndexEntries?: boolean;
}

/**
 * Load a database from a store written by CoreApp, with the history inside
 * the retention window, so past heights are provable again. Null if the
 * store is empty.
 */
export function openObjectDatabase(kv: KvStore, types: ObjectType<any>[], opts: OpenOptions = {}): OpenedDatabase | null {
  const m = kv.get(META_KEY);
  if (!m) return null;
  const meta = decode(m, (r) => ({ height: r.u64(), appHash: r.fixed(HASH_SIZE) }));
  const { retainVersions } = opts;
  // With a figure for the heap's room, a tier estimated not to fit is opened dropped rather than built and then
  // dropped by the memory guard, which would be too late: the index trees first, then the Merkle trees with what is left.
  let { indexTrees, trees } = opts;
  const paged: string[] = [];
  if (opts.heapRoom !== undefined) {
    const counter = (type: number) => {
      const c = kv.get(counterKey(type));
      return c ? decode(c, (r) => r.u53()) : 0;
    };
    const est = estimateTiers(types, counter);
    let room = opts.heapRoom;
    if (indexTrees === undefined && est.indexTrees > room) (indexTrees = false), paged.push('indexTrees');
    else if (indexTrees !== false) room -= est.indexTrees;
    if (trees === undefined && est.trees > room) (trees = false), paged.push('trees');
  }
  const db = new ObjectDatabase(types, { retainVersions, indexStore: kv, indexTrees, trees, objectStore: (id) => kv.get(objectKey(id)), arenaBytes: opts.arenaBytes, historyStore: (version) => kv.get(historyKey(version)) });
  // A store written before the index entries were (STATE-PAGING.md phase two) has none: the objects are decoded for
  // their keys as they always were, and the entries written once below. An empty prefix in a store that has objects
  // means exactly that, because every write of objects carries their entries in the same transaction. The same holds
  // for the trees' chunks and nodes (phase four).
  const has = (prefix: Uint8Array) => {
    const probe = kv.range(prefix, prefixEnd(prefix));
    const found = !probe.next().done;
    probe.return?.(undefined); // close the cursor rather than leave it to the collector
    return found;
  };
  const indexed = has(INDEX_PREFIX_KEY);
  const treesStored = indexed && has(CHUNK_PREFIX_KEY);
  const t0 = performance.now();
  let objects = 0;
  for (const [k, v] of kv.range(OBJECT_PREFIX, prefixEnd(OBJECT_PREFIX))) {
    db.importObject(decode(k, (r) => (r.u8(), r.u64())), v, indexed);
    objects++;
  }
  for (const t of types) {
    const c = kv.get(counterKey(t.id));
    if (c) db.setCounter(t.id, decode(c, (r) => r.u53()));
  }
  const t1 = performance.now();
  // The trees come from their chunks and nodes: no tree is built by hashing every object and inserting every index
  // key into a sparse tree, which was most of a restart (STATE-PAGING.md 5.3). Recomputing them gives the same root,
  // only slower. With checkLeaves (the default) each object is still hashed once, against the leaf that was stored.
  if (treesStored) {
    if (opts.fromTrees ?? true) db.loadTrees(opts.checkLeaves ?? true);
    else db.assumeStoredTrees();
  }
  // The indices come from their entries rather than from inserting every key, and are checked against the objects.
  if (indexed && objects > 0) db.loadIndexEntries(opts.checkIndexEntries ?? true);
  const appHash = db.root(Number(meta.height));
  if (!bytesEqual(appHash, meta.appHash)) throw new Error('stored objects do not hash to the stored app hash');
  const missing = [...(indexed ? [] : db.lastChanges!.indices), ...(treesStored ? [] : db.lastChanges!.trees)];
  if (missing.length > 0) kv.write((w) => missing.forEach((c) => (c.value ? w.put(c.key, c.value) : w.del(c.key))));
  // That root's change list may hold the encoded bytes of every object; the store already has them.
  db.dropChanges();
  const t2 = performance.now();
  const staleHistory: number[] = [];
  // Reading the window back puts every tree node and object the last hundred blocks overwrote into the heap, which
  // under a scattered load is more than the trees themselves: a store opened with a tier left out for want of room
  // starts with an empty window instead, which fills again as blocks are applied. The records stay in the store until
  // they age out, and the database reads a past version from them there (ObjectDatabase.past), so the heights stay
  // provable.
  const withHistory = paged.length === 0;
  if (!withHistory) paged.push('history');
  const oldest = db.currentVersion - (retainVersions ?? 100);
  const found = new Map<number, Uint8Array | null>();
  for (const [k, v] of kv.range(HISTORY_PREFIX, prefixEnd(HISTORY_PREFIX))) {
    const version = decode(k, (r) => (r.u8(), r.u53()));
    if (version > oldest && version <= db.currentVersion) found.set(version, withHistory ? v : null);
    else staleHistory.push(version);
  }
  // The records serve the heights from the lowest one that has every record up to the current height: one missing
  // in between (a damaged store) would make every height below it read what the missing record overwrote as it is
  // now, so the heights below it are not provable and their records go.
  let from = db.currentVersion + 1;
  while (found.has(from - 1)) from--;
  for (const version of found.keys()) if (version < from) staleHistory.push(version);
  for (let version = from; version <= db.currentVersion; version++) {
    if (withHistory) db.loadHistory(version, decode(found.get(version)!, decodeHistory));
    else db.noteStoredHistory(version);
  }
  found.clear();
  const restored = withHistory ? db.restoreIndexVersions() : 'none';
  const timing = { objects, importMs: Math.round(t1 - t0), rootMs: Math.round(t2 - t1), historyMs: Math.round(performance.now() - t2), indexVersions: restored };
  return { db, height: meta.height, appHash, staleHistory, timing, paged };
}

type Decoded = { tx: Transaction; txId: Uint8Array } | { error: string };

export class CoreApp implements Application {
  readonly chainId: string;
  readonly db: ObjectDatabase;
  private readonly kv: KvStore;
  private readonly verifier: Verifier;
  private readonly context: Uint8Array;
  private readonly log: Logger;
  private height = 0n;
  private appHash: Uint8Array;
  private lastTime: bigint;
  private pending: UndoSession | null = null;
  /** tx id hex to address hex to the hashes of every signature by that signer over that body that verified. */
  private readonly sigCache = new Map<string, Map<string, Set<string>>>();
  /** Signature hashes held across sigCache, for its bound. */
  private sigCacheSignatures = 0;
  private readonly historyLog: HistoryLog;
  private toPersist: { changes: Changes; meta: Meta; history: [ObjectId, HistoryEntry][] } | null = null;
  private staleHistory: number[] = [];
  private readonly recorder = new HistoryRecorder();
  private readonly snapshotInterval: number;
  private readonly snapshotsKept: number;
  private readonly snapshotChunkObjects: number;
  /** History entries written by the last commit, for event streams. */
  lastHistory: [ObjectId, HistoryEntry][] = [];

  constructor(opts: CoreAppOptions) {
    this.chainId = opts.genesis.chainId;
    this.verifier = opts.verifier;
    this.context = signContext(this.chainId, 'tx');
    this.log = opts.log ?? silentLogger;
    this.kv = opts.kv ?? new MemoryKv();
    this.historyLog = new HistoryLog(this.kv);
    this.snapshotInterval = Math.max(0, opts.snapshotInterval ?? 1000);
    this.snapshotsKept = Math.max(1, opts.snapshotsKept ?? 2);
    this.snapshotChunkObjects = Math.max(1, opts.snapshotChunkObjects ?? 2000);
    const stored = openObjectDatabase(this.kv, CORE_TYPES, { retainVersions: opts.retainVersions, indexTrees: opts.indexTrees, trees: opts.trees, arenaBytes: opts.arenaBytes, heapRoom: opts.heapRoom });
    if (stored) {
      this.db = stored.db;
      // The state holds the scheme genesis fixed, and the node derives its keys from the genesis it was given: the two
      // must name the same one.
      const scheme = getGlobal(this.db).scheme;
      if (scheme !== schemeTag(opts.genesis.signatureScheme ?? 'ml-dsa-44')) throw new Error(`the application state is for a ${schemeName(scheme)} chain, genesis names ${opts.genesis.signatureScheme ?? 'ml-dsa-44'}`);
      this.height = stored.height;
      this.appHash = stored.appHash;
      this.staleHistory = stored.staleHistory;
      this.log('info', 'loaded application state', { height: this.height, appHash: this.appHash, provableFrom: this.db.lowestVersion, ...stored.timing, ...(stored.paged.length > 0 ? { paged: stored.paged.join(', ') } : {}) });
    } else {
      if (opts.genesis.appStateFile && !opts.appGenesis) throw new Error('the application genesis is in a file; parse it with loadAppGenesis first');
      const t0 = performance.now();
      const g = opts.appGenesis ?? parseAppGenesis(opts.genesis.appState);
      const t1 = performance.now();
      this.db = new ObjectDatabase(CORE_TYPES, { retainVersions: opts.retainVersions, indexStore: this.kv, indexTrees: opts.indexTrees, trees: opts.trees, objectStore: (id) => this.kv.get(objectKey(id)), arenaBytes: opts.arenaBytes, historyStore: (version) => this.kv.get(historyKey(version)) });
      applyGenesis(this.db, g, opts.genesis.genesisTime, schemeTag(opts.genesis.signatureScheme ?? 'ml-dsa-44'));
      const t2 = performance.now();
      this.appHash = this.db.root(0);
      const t3 = performance.now();
      this.persist({ changes: this.db.lastChanges!, meta: { height: 0n, appHash: this.appHash }, history: [] });
      this.log('info', 'applied genesis', { accounts: g.accounts.length, parseMs: Math.round(t1 - t0), applyMs: Math.round(t2 - t1), rootMs: Math.round(t3 - t2), persistMs: Math.round(performance.now() - t3) });
    }
    this.lastTime = getDynamic(this.db).time;
    this.pending = this.db.startSession();
  }

  /** Whether a store already holds application state, so genesis need not be parsed. */
  static hasState(kv: KvStore): boolean {
    return kv.get(META_KEY) !== undefined;
  }

  // ---- Application ----

  async initChain(_genesis: Genesis): Promise<InitChainResult> {
    if (this.height !== 0n) throw new Error('initChain on an application that already has blocks');
    const active = getDynamic(this.db).active;
    return { appHash: this.appHash, validators: active.map((a) => ({ publicKey: a.publicKey, power: a.power })) };
  }

  /** Serialises checkTx's state-touching part behind a block in progress. */
  private applying: Promise<void> | null = null;

  /**
   * Set when a block failed after its session was committed: its changes are in the database and cannot be undone,
   * while the height and the app hash did not advance. Applying anything more would build on a block applied
   * twice, so the application refuses every block and check from then on. Nothing of the block was written to the
   * store, so a restart has the state of the block before.
   */
  private failed: string | null = null;

  async checkTx(bytes: Uint8Array, opts: CheckTxOptions = {}): Promise<CheckTxResult> {
    if (this.failed) return { ok: false, error: this.failed };
    const d = this.decode(bytes);
    if ('error' in d) return { ok: false, error: d.error };
    while (this.applying) await this.applying;
    const signed = await this.verifySignatures(d.tx, d.txId);
    if (typeof signed === 'string') return { ok: false, error: signed };
    // A block may have started while the pool verified; its state must be the one checked against.
    while (this.applying) await this.applying;
    // Nor is a transaction the mempool would now refuse applied: its writes would stay in the pending state, and
    // the transactions checked after it would be checked against them.
    const refused = opts.admit?.() ?? null;
    if (refused !== null) return { ok: false, error: refused };
    if (this.failed) return { ok: false, error: this.failed };
    const r = this.applyChecked(d.tx, d.txId, signed, this.lastTime, this.height + 1n, this.pending !== null, false);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  async finalizeBlock(req: FinalizeBlockRequest): Promise<FinalizeBlockResult> {
    if (this.failed) throw new Error(this.failed);
    let release: () => void = () => {};
    this.applying = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Everything the block does happens inside one session until the root is taken, so a failure
    // on the way (a verifier gone away) leaves the database exactly as the previous block left it.
    let blockSession: UndoSession | null = null;
    let committed = false;
    try {
      this.closePending();
      blockSession = this.db.startSession();
      pruneExpiredTxs(this.db, req.time);
      this.recorder.reset(req.height);
      beginBlock(this.db, req, this.log, this.recorder);
      const decoded = req.txs.map((t) => this.decode(t));
      // One batch for every signature not already verified, so the pool works in parallel. The cache
      // entry this fills is "this signer signed this body", which no state change can invalidate; the
      // pass below still resolves each signer against the state its transaction applies to.
      await this.prewarmSignatures(decoded);
      const txResults: TxResult[] = [];
      for (let i = 0; i < req.txs.length; i++) {
        const d = decoded[i]!;
        if ('error' in d) {
          txResults.push({ ok: false, error: d.error });
          continue;
        }
        // Keys are resolved against the state as it stands after the transactions before this one, on every node alike.
        const signed = await this.verifySignatures(d.tx, d.txId);
        if (typeof signed === 'string') {
          txResults.push({ ok: false, error: signed });
          continue;
        }
        this.recorder.beginTx(txHash(req.txs[i]!), i);
        const r = this.applyChecked(d.tx, d.txId, signed, req.time, req.height, true, true);
        this.recorder.endTx(r.ok);
        txResults.push(r);
      }
      const validatorUpdates = endBlock(this.db, this.log);
      this.db.modify(DynamicType, DYNAMIC_ID, (d) => ({ ...d, height: req.height, time: req.time }));
      // The root needs every session closed, so from here to the end a failure can undo nothing.
      committed = true;
      blockSession.commit();
      blockSession = null;

      this.appHash = this.db.root(Number(req.height));
      this.height = req.height;
      this.lastTime = req.time;
      this.toPersist = { changes: this.db.lastChanges!, meta: { height: this.height, appHash: this.appHash }, history: this.recorder.entries };
      this.pending = this.db.startSession();
      return { appHash: this.appHash, txResults, validatorUpdates };
    } catch (e) {
      if (committed) this.failed = `the application failed while taking the root of block ${req.height} (${(e as Error).message}) and holds changes it cannot undo: restart the node, the store has the state of the block before`;
      else if (blockSession) {
        blockSession.undo();
        this.pending = this.db.startSession();
      }
      throw e;
    } finally {
      this.applying = null;
      release();
    }
  }

  /**
   * Write the block to the store. Everything here is synchronous, and the function is not an async one, so that a
   * write that fails throws where commit() is called: a caller that holds a store transaction open around the call
   * has it aborted with its own writes. The block stays to be written, and commit() can be called again. A snapshot
   * that fails rejects the promise instead: the block is written by then.
   */
  commit(): Promise<void> {
    const p = this.toPersist;
    if (!p) return Promise.resolve();
    this.persist(p);
    this.lastHistory = p.history;
    this.toPersist = null;
    try {
      if (this.snapshotInterval > 0 && this.height > 0n && this.height % BigInt(this.snapshotInterval) === 0n) this.takeSnapshot();
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve();
  }

  // ---- snapshots ----

  /** Export the committed state at the current height into the store, keeping the last few. */
  takeSnapshot(): void {
    const { manifest, chunks } = exportSnapshot(this.db, CORE_TYPES, Number(this.height), this.snapshotChunkObjects);
    const stale = this.snapshotHeights().filter((h) => h !== this.height).slice(0, -(this.snapshotsKept - 1) || undefined);
    this.kv.write((w) => {
      w.put(manifestKey(this.height), manifestToBytes(manifest));
      chunks.forEach((perType, t) => perType.forEach((bytes, i) => w.put(chunkKey(this.height, manifest.types[t]!.type, i), bytes)));
      for (const h of stale) {
        w.del(manifestKey(h));
        for (const [k] of this.kv.range(chunkPrefix(h), prefixEnd(chunkPrefix(h)))) w.del(k);
      }
    });
    this.log('info', 'snapshot written', { height: this.height, chunks: chunks.reduce((s, c) => s + c.length, 0) });
  }

  snapshotHeights(): bigint[] {
    const out: bigint[] = [];
    for (const [k] of this.kv.range(MANIFEST_PREFIX, prefixEnd(MANIFEST_PREFIX))) out.push(decode(k, (r) => (r.u8(), r.u64())));
    return out;
  }

  manifestBytes(height: bigint): Uint8Array | null {
    return this.kv.get(manifestKey(height)) ?? null;
  }

  chunkBytes(height: bigint, type: number, index: number): Uint8Array | null {
    return this.kv.get(chunkKey(height, type, index)) ?? null;
  }

  /** Write a database loaded from a snapshot into an empty store, as the application's commit would have. */
  static writeImportedState(kv: KvStore, db: ObjectDatabase, height: bigint, appHash: Uint8Array): void {
    if (kv.get(META_KEY)) throw new Error('the application store is not empty');
    kv.write((w) => {
      for (const [id, bytes] of db.exportObjects()) w.put(objectKey(id), bytes);
      for (const [k, v] of db.indexEntries()) w.put(k, v);
      for (const [k, v] of db.treeEntries()) w.put(k, v);
      for (const [type, next] of db.counters()) w.put(counterKey(type), encode((wr) => wr.u64(BigInt(next))));
      w.put(META_KEY, encode((wr) => wr.u64(height).fixed(appHash)));
    });
  }

  async info(): Promise<{ lastHeight: bigint; lastAppHash: Uint8Array }> {
    return { lastHeight: this.height, lastAppHash: this.appHash };
  }

  private persist(p: { changes: Changes; meta: Meta; history: [ObjectId, HistoryEntry][] }): void {
    try {
      this.write(p);
    } catch (e) {
      // The store took nothing of the write; the history log, which counted the block's entries as it appended
      // them, goes back to what the store has, so that the same block can be written again.
      this.historyLog.rollback();
      throw e;
    }
    this.staleHistory = [];
    this.db.dropChanges();
  }

  private write(p: { changes: Changes; meta: Meta; history: [ObjectId, HistoryEntry][] }): void {
    this.kv.write((w) => {
      this.historyLog.append(w, p.history);
      for (const c of p.changes.objects) {
        if (c.bytes) w.put(objectKey(c.id), c.bytes);
        else w.del(objectKey(c.id));
      }
      // Removals first in the list, so a key that changed hands within the block ends with its new owner.
      for (const c of p.changes.indices) {
        if (c.value) w.put(c.key, c.value);
        else w.del(c.key);
      }
      for (const c of p.changes.trees) {
        if (c.value) w.put(c.key, c.value);
        else w.del(c.key);
      }
      for (const [type, next] of p.changes.counters) w.put(counterKey(type), encode((wr) => wr.u64(BigInt(next))));
      if (p.changes.history) w.put(historyKey(p.changes.version), encode((wr) => encodeHistory(wr, p.changes.history!)));
      // History that no longer serves any provable height: the version that just left the window, and leftovers found at startup.
      // The store's window is the full one even while the memory guard has trimmed the one in memory, so a restart has it back.
      if (this.db.lastStaleVersion > 0) w.del(historyKey(this.db.lastStaleVersion));
      for (const v of this.staleHistory) w.del(historyKey(v));
      w.put(META_KEY, encode((wr) => wr.u64(p.meta.height).fixed(p.meta.appHash)));
    });
  }

  /** An account's history, oldest first from `from`, or newest first when reversed. */
  accountHistory(account: ObjectId, from = 0n, limit = 100, reverse = false): { entries: (HistoryEntry & { sequence: bigint })[]; total: bigint } {
    return this.historyLog.read(account, from, limit, reverse);
  }

  /** How many history entries an account had as of a height. */
  accountHistoryTotalAt(account: ObjectId, height: bigint): bigint {
    return height >= this.lastHeight ? this.historyLog.total(account) : this.historyLog.totalAt(account, height);
  }

  // ---- queries, all against committed state ----

  get lastHeight(): bigint {
    return this.height;
  }

  get lastAppHash(): Uint8Array {
    return this.appHash;
  }

  /** The oldest height a proof can still be made for. */
  get lowestProvableHeight(): bigint {
    return BigInt(this.db.lowestVersion);
  }

  get coreAsset(): ObjectId {
    return getGlobal(this.db).coreAsset;
  }

  stakingParameters(): StakingParameters {
    return getGlobal(this.db).staking;
  }

  /** The committed global properties. */
  global(): GlobalProperties {
    return this.db.getCommitted(GlobalType, GLOBAL_ID)!;
  }

  feeSchedule(): FeeSchedule {
    return this.global().fees;
  }

  /** What a proposal replaces: the fee schedule and the staking parameters. */
  chainParameters(): ChainParameters {
    const g = this.global();
    return { fees: g.fees, staking: g.staking };
  }

  dynamic(): DynamicProperties {
    return this.db.getCommitted(DynamicType, DYNAMIC_ID)!;
  }

  accountByName(name: string): Account | null {
    let k: Uint8Array;
    try {
      k = key((k) => k.str(name));
    } catch {
      return null;
    }
    const live = this.db.lookup(AccountType, 'byName', k);
    return live ? this.db.getCommitted(AccountType, live.id) : null;
  }

  account(id: ObjectId): Account | null {
    return this.db.getCommitted(AccountType, id);
  }

  balance(owner: ObjectId, asset: ObjectId = this.coreAsset): bigint {
    const live = this.db.lookup(BalanceType, 'byOwnerAsset', key((k) => k.id(owner).id(asset)));
    return (live ? this.db.getCommitted(BalanceType, live.id) : null)?.amount ?? 0n;
  }

  /** Inclusion or absence proof for any object id against the current app hash. */
  proof(id: ObjectId): ObjectProof {
    return this.db.proof(id);
  }

  /** The same for a past height inside the retention window. Verify it against header height+1. */
  proofAt(id: ObjectId, height: bigint): ObjectProof {
    return this.db.proofAt(id, Number(height));
  }

  /** Proof that a name maps to an account id, or that no account has it. The value proven is the 8-byte id. */
  proveAccountName(name: string, height: bigint = this.height): KeyProof {
    return this.db.proveKeyAt(AccountType, 'byName', key((k) => k.str(name)), Number(height));
  }

  proveAssetSymbol(symbol: string, height: bigint = this.height): KeyProof {
    return this.db.proveKeyAt(AssetType, 'bySymbol', key((k) => k.str(symbol)), Number(height));
  }

  /** Which validator stands behind a consensus address, or that none does. The value proven is the 8-byte validator id. */
  proveValidatorAddress(address: Uint8Array, height: bigint = this.height): KeyProof {
    return this.db.proveKeyAt(ValidatorType, 'byConsensusAddress', key((k) => k.fixed(address)), Number(height));
  }

  /** A delegation's existence, or absence; the value proven is the delegation's id. */
  proveDelegation(delegator: ObjectId, validator: ObjectId, height: bigint = this.height): KeyProof {
    return this.db.proveKeyAt(DelegationType, 'byDelegatorValidator', key((k) => k.id(delegator).id(validator)), Number(height));
  }

  // ---- internals ----

  private decode(bytes: Uint8Array): Decoded {
    try {
      const tx = decodeTransaction(bytes);
      return { tx, txId: txIdOf(tx) };
    } catch (e) {
      return { error: `malformed transaction: ${(e as Error).message}` };
    }
  }

  private readonly lookupAuthorities: AuthorityLookup = (id) => {
    const a = this.db.get(AccountType, id);
    return a ? { active: a.active, owner: a.owner } : null;
  };

  private closePending(): void {
    if (this.pending) {
      this.pending.undo();
      this.pending = null;
    }
  }

  /** Forget every verified signature (load shedding); each is verified again when next seen. */
  dropSignatureCache(): void {
    this.sigCache.clear();
    this.sigCacheSignatures = 0;
  }

  /** Oldest bodies first, until both bounds hold. */
  private trimCache(): void {
    while (this.sigCache.size > SIG_CACHE_MAX || this.sigCacheSignatures > SIG_CACHE_SIGNATURES) {
      const [txKey, verified] = this.sigCache.entries().next().value!;
      for (const hashes of verified.values()) this.sigCacheSignatures -= hashes.size;
      this.sigCache.delete(txKey);
    }
  }

  /** The public keys the required authorities hold right now, by address, or why they cannot be found. */
  private signingKeys(tx: Transaction): Map<string, Uint8Array> | string {
    const required = requiredAuthorities(tx.operations);
    const candidates = new Map<string, Uint8Array>();
    for (const id of [...required.active, ...required.owner]) {
      const a = this.db.get(AccountType, id);
      if (!a) return `account ${idToString(id)} does not exist`;
      collectKeys(a.active, this.lookupAuthorities, candidates);
      collectKeys(a.owner, this.lookupAuthorities, candidates);
    }
    return candidates;
  }

  private cacheVerified(txKey: string, address: string, sigHash: string): void {
    let verified = this.sigCache.get(txKey);
    if (!verified) {
      verified = new Map();
      this.sigCache.set(txKey, verified);
    }
    // A set, never a replacement: two valid signatures by one key over one body can be in flight at once (this
    // chain's signer is deterministic, but a hedged signer or any other can make a second valid one), and a later
    // one should not cost the earlier its cache entry. Past a few the oldest goes; a transaction in flight holds
    // its own verified signers, so that costs at most a second verification.
    let hashes = verified.get(address);
    if (!hashes) verified.set(address, (hashes = new Set()));
    if (hashes.has(sigHash)) return;
    if (hashes.size >= SIG_CACHE_VARIANTS) hashes.delete(hashes.values().next().value!);
    else this.sigCacheSignatures++;
    hashes.add(sigHash);
    this.trimCache();
  }

  private isVerified(txKey: string, address: string, sigHash: string): boolean {
    return this.sigCache.get(txKey)?.get(address)?.has(sigHash) ?? false;
  }

  /**
   * Verify every uncached signature of a block in one batch against the state before the block.
   * A signer whose key is not in a required authority yet (it may be added by an earlier transaction
   * of the same block) is skipped here and handled by the per-transaction pass.
   */
  private async prewarmSignatures(decoded: Decoded[]): Promise<void> {
    const jobs: VerifyJob[] = [];
    const owners: { txKey: string; address: string; sigHash: string }[] = [];
    for (const d of decoded) {
      if ('error' in d) continue;
      const candidates = this.signingKeys(d.tx);
      if (typeof candidates === 'string') continue;
      const txKey = toHex(d.txId);
      const body = txBodyBytes(d.tx);
      for (const s of d.tx.signatures) {
        const address = toHex(s.address);
        const publicKey = candidates.get(address);
        if (!publicKey || schemeOf(s.signature) !== this.chainScheme) continue;
        const sigHash = toHex(sha256(s.signature));
        if (this.isVerified(txKey, address, sigHash)) continue;
        jobs.push({ sig: s.signature, msg: body, publicKey, context: this.context });
        owners.push({ txKey, address, sigHash });
      }
    }
    if (jobs.length === 0) return;
    const results = await this.verifier.verify(jobs);
    results.forEach((ok, i) => {
      if (ok) this.cacheVerified(owners[i]!.txKey, owners[i]!.address, owners[i]!.sigHash);
    });
  }

  /** The scheme genesis fixed; part of the committed global properties, so two nodes with other genesis files never agree on a root. */
  private get chainScheme(): SchemeTag {
    return getGlobal(this.db).scheme;
  }

  /**
   * The addresses that validly signed the transaction, or why it is refused. The set is the caller's to apply the
   * transaction with: what the cache says when the transaction is applied does not matter, since load shedding can
   * clear it, and trimming shrink it, while this awaits the pool.
   */
  private async verifySignatures(tx: Transaction, txId: Uint8Array): Promise<Set<string> | string> {
    if (tx.signatures.length === 0) return 'transaction has no signatures';
    const candidates = this.signingKeys(tx);
    if (typeof candidates === 'string') return candidates;
    const txKey = toHex(txId);
    const jobs: VerifyJob[] = [];
    const jobKeys: [string, string][] = [];
    const seen = new Set<string>();
    const signed = new Set<string>();
    const body = txBodyBytes(tx);
    for (const s of tx.signatures) {
      const address = toHex(s.address);
      if (seen.has(address)) return 'duplicate signature';
      seen.add(address);
      const publicKey = candidates.get(address);
      if (!publicKey) return 'signature by a key that no required authority contains';
      if (schemeOf(s.signature) !== this.chainScheme) return 'signature of another scheme than the chain uses';
      // A cache hit is only for the exact signature bytes seen before.
      const sigHash = toHex(sha256(s.signature));
      if (this.isVerified(txKey, address, sigHash)) {
        signed.add(address);
        continue;
      }
      jobs.push({ sig: s.signature, msg: body, publicKey, context: this.context });
      jobKeys.push([address, sigHash]);
    }
    if (jobs.length > 0) {
      const results = await this.verifier.verify(jobs);
      if (results.some((ok) => !ok)) return 'invalid signature';
      for (const [address, sigHash] of jobKeys) {
        signed.add(address);
        this.cacheVerified(txKey, address, sigHash);
      }
    }
    return signed;
  }

  /**
   * Thresholds against current state, then the state changes, in a nested session. Synchronous on purpose.
   * `signed` is what verifySignatures returned for this transaction.
   */
  private applyChecked(tx: Transaction, txId: Uint8Array, signed: ReadonlySet<string>, time: bigint, height: bigint, keep: boolean, final: boolean): TxResult {
    if (signed.size !== tx.signatures.length) return { ok: false, error: 'unverified signature' };
    const required = requiredAuthorities(tx.operations);
    for (const id of required.owner) {
      const a = this.db.get(AccountType, id);
      if (!a || !authoritySatisfied(a.owner, signed, this.lookupAuthorities)) return { ok: false, error: `missing owner authority of ${a?.name ?? idToString(id)}` };
    }
    for (const id of required.active) {
      const a = this.db.get(AccountType, id);
      if (!a || (!authoritySatisfied(a.active, signed, this.lookupAuthorities) && !authoritySatisfied(a.owner, signed, this.lookupAuthorities))) {
        return { ok: false, error: `missing active authority of ${a?.name ?? idToString(id)}` };
      }
    }
    const session = this.db.startSession();
    try {
      applyTransaction({ db: this.db, time, height, final, log: this.log, history: final ? this.recorder : undefined }, tx, txId);
    } catch (e) {
      session.undo();
      if (e instanceof TxError || e instanceof DbError) return { ok: false, error: e.message };
      throw e;
    }
    if (keep) session.commit();
    else session.undo();
    return { ok: true };
  }
}
