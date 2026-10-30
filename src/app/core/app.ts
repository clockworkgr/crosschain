/**
 * The core application: accounts, assets and balances on the object
 * database, behind the engine's Application interface.
 *
 * Signature verification is the only asynchronous step, because it goes to
 * the worker pool. Everything that touches the database is synchronous and
 * happens after any await, so the undo sessions nest cleanly even though
 * checkTx calls overlap each other and a finalizeBlock.
 *
 * Sessions during normal operation:
 *   pending  opened after every block; checkTx applies into it so that
 *            transactions queued behind each other are checked in sequence
 *   tx       one per transaction, inside pending for a check and at top
 *            level for a block; undone if the transaction fails
 * finalizeBlock first undoes pending, so the block runs on committed state,
 * and then the engine's post-commit recheck rebuilds pending.
 *
 * State lives in memory. The key-value store holds a copy of every object,
 * written incrementally: commit() writes the objects the block changed, the
 * counters that moved, and the height and app hash, in one transaction. On
 * startup everything is read back, the root recomputed and checked against
 * the stored app hash, and the engine replays any blocks the store is
 * behind on.
 *
 * The signature cache remembers which addresses signed a transaction id
 * validly. That fact never changes, so a transaction verified on arrival is
 * not verified again when its block is applied. Authority thresholds, which
 * do depend on state, are always rechecked.
 */
import { decode } from '../../codec/reader.ts';
import { encode } from '../../codec/writer.ts';
import { bytesEqual, HASH_SIZE, sha256, toHex } from '../../crypto/hash.ts';
import { schemeOf, schemeTag, signContext, type SchemeTag } from '../../crypto/keys.ts';
import type { Verifier, VerifyJob } from '../../crypto/verifier.ts';
import { decodeHistory, encodeHistory, ObjectDatabase, type Changes, type UndoSession } from '../../db/database.ts';
import { idToString, type ObjectId } from '../../db/id.ts';
import { DbError, type ObjectType } from '../../db/index.ts';
import { key } from '../../db/keys.ts';
import type { KeyProof, ObjectProof } from '../../db/proof.ts';
import { MemoryKv, prefixEnd, type KvStore } from '../../store/kv.ts';
import type { Genesis } from '../../types/genesis.ts';
import { silentLogger, type Logger } from '../../util/log.ts';
import type { Application, CheckTxResult, FinalizeBlockRequest, FinalizeBlockResult, InitChainResult, TxResult } from '../types.ts';
import { authoritySatisfied, collectKeys, type AuthorityLookup } from './authority.ts';
import { applyTransaction, getDynamic, getGlobal, pruneExpiredTxs, requiredAuthorities, TxError } from './evaluate.ts';
import { beginBlock, endBlock } from './staking.ts';
import { exportSnapshot, manifestToBytes } from './snapshot.ts';
import { historyEntryFromBytes, historyEntryToBytes, HistoryRecorder, type HistoryEntry } from './history.ts';
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
  /** Export a snapshot every this many blocks; 0 disables. */
  snapshotInterval?: number;
  snapshotsKept?: number;
  snapshotChunkObjects?: number;
  log?: Logger;
}

const SIG_CACHE_MAX = 20_000;

// Key layout of the app store: 'm' meta, 'o' id, 'c' type, 'h' version, 'a' account history, 'q' history sequence.
const META_KEY = key((k) => k.u8(0x6d));
const OBJECT_PREFIX = key((k) => k.u8(0x6f));
const HISTORY_PREFIX = key((k) => k.u8(0x68));
const objectKey = (id: ObjectId) => key((k) => k.u8(0x6f).u64(id));
const counterKey = (type: number) => key((k) => k.u8(0x63).u16(type));
const historyKey = (version: number) => key((k) => k.u8(0x68).u64(BigInt(version)));
const accountHistoryKey = (account: ObjectId, sequence: bigint) => key((k) => k.u8(0x61).u64(account).u64(sequence));
const sequenceKey = (account: ObjectId) => key((k) => k.u8(0x71).u64(account));
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
  timing: { objects: number; importMs: number; rootMs: number; historyMs: number };
}

/**
 * Load a database from a store written by CoreApp, with the history inside
 * the retention window, so past heights are provable again. Null if the
 * store is empty.
 */
export function openObjectDatabase(kv: KvStore, types: ObjectType<any>[], retainVersions?: number): OpenedDatabase | null {
  const m = kv.get(META_KEY);
  if (!m) return null;
  const meta = decode(m, (r) => ({ height: r.u64(), appHash: r.fixed(HASH_SIZE) }));
  const db = new ObjectDatabase(types, { retainVersions });
  const t0 = performance.now();
  let objects = 0;
  for (const [k, v] of kv.range(OBJECT_PREFIX, prefixEnd(OBJECT_PREFIX))) {
    db.importObject(decode(k, (r) => (r.u8(), r.u64())), v);
    objects++;
  }
  for (const t of types) {
    const c = kv.get(counterKey(t.id));
    if (c) db.setCounter(t.id, Number(decode(c, (r) => r.u64())));
  }
  const t1 = performance.now();
  const appHash = db.root(Number(meta.height));
  if (!bytesEqual(appHash, meta.appHash)) throw new Error('stored objects do not hash to the stored app hash');
  // That root produced a change list holding the encoded bytes of every object; the store already has them.
  db.dropChanges();
  const t2 = performance.now();
  const staleHistory: number[] = [];
  for (const [k, v] of kv.range(HISTORY_PREFIX, prefixEnd(HISTORY_PREFIX))) {
    const version = Number(decode(k, (r) => (r.u8(), r.u64())));
    if (version > db.currentVersion - (retainVersions ?? 100) && version <= db.currentVersion) db.loadHistory(version, decode(v, decodeHistory));
    else staleHistory.push(version);
  }
  db.rebuildIndexVersions();
  const timing = { objects, importMs: Math.round(t1 - t0), rootMs: Math.round(t2 - t1), historyMs: Math.round(performance.now() - t2) };
  return { db, height: meta.height, appHash, staleHistory, timing };
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
    this.snapshotInterval = Math.max(0, opts.snapshotInterval ?? 1000);
    this.snapshotsKept = Math.max(1, opts.snapshotsKept ?? 2);
    this.snapshotChunkObjects = Math.max(1, opts.snapshotChunkObjects ?? 2000);
    const stored = openObjectDatabase(this.kv, CORE_TYPES, opts.retainVersions);
    if (stored) {
      this.db = stored.db;
      this.height = stored.height;
      this.appHash = stored.appHash;
      this.staleHistory = stored.staleHistory;
      this.log('info', 'loaded application state', { height: this.height, appHash: this.appHash, provableFrom: this.db.lowestVersion, ...stored.timing });
    } else {
      if (opts.genesis.appStateFile && !opts.appGenesis) throw new Error('the application genesis is in a file; parse it with loadAppGenesis first');
      const t0 = performance.now();
      const g = opts.appGenesis ?? parseAppGenesis(opts.genesis.appState);
      const t1 = performance.now();
      this.db = new ObjectDatabase(CORE_TYPES, { retainVersions: opts.retainVersions });
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

  async checkTx(bytes: Uint8Array): Promise<CheckTxResult> {
    const d = this.decode(bytes);
    if ('error' in d) return { ok: false, error: d.error };
    while (this.applying) await this.applying;
    const sigError = await this.verifySignatures(d.tx, d.txId);
    if (sigError) return { ok: false, error: sigError };
    // A block may have started while the pool verified; its state must be the one checked against.
    while (this.applying) await this.applying;
    const r = this.applyChecked(d.tx, d.txId, this.lastTime, this.height + 1n, this.pending !== null, false);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  async finalizeBlock(req: FinalizeBlockRequest): Promise<FinalizeBlockResult> {
    let release: () => void = () => {};
    this.applying = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Everything the block does happens inside one session until the root is taken, so a failure
    // on the way (a verifier gone away) leaves the database exactly as the previous block left it.
    let blockSession: UndoSession | null = null;
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
        const sigError = await this.verifySignatures(d.tx, d.txId);
        if (sigError) {
          txResults.push({ ok: false, error: sigError });
          continue;
        }
        this.recorder.beginTx(txHash(req.txs[i]!), i);
        const r = this.applyChecked(d.tx, d.txId, req.time, req.height, true, true);
        this.recorder.endTx(r.ok);
        txResults.push(r);
      }
      const validatorUpdates = endBlock(this.db, this.log);
      this.db.modify(DynamicType, DYNAMIC_ID, (d) => ({ ...d, height: req.height, time: req.time }));
      blockSession.commit();
      blockSession = null;

      this.appHash = this.db.root(Number(req.height));
      this.height = req.height;
      this.lastTime = req.time;
      this.toPersist = { changes: this.db.lastChanges!, meta: { height: this.height, appHash: this.appHash }, history: this.recorder.entries };
      this.pending = this.db.startSession();
      return { appHash: this.appHash, txResults, validatorUpdates };
    } catch (e) {
      if (blockSession) {
        blockSession.undo();
        this.pending = this.db.startSession();
      }
      throw e;
    } finally {
      this.applying = null;
      release();
    }
  }

  async commit(): Promise<void> {
    if (this.toPersist) {
      this.persist(this.toPersist);
      this.lastHistory = this.toPersist.history;
      this.toPersist = null;
      if (this.snapshotInterval > 0 && this.height > 0n && this.height % BigInt(this.snapshotInterval) === 0n) this.takeSnapshot();
    }
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
      for (const [type, next] of db.counters()) w.put(counterKey(type), encode((wr) => wr.u64(BigInt(next))));
      w.put(META_KEY, encode((wr) => wr.u64(height).fixed(appHash)));
    });
  }

  async info(): Promise<{ lastHeight: bigint; lastAppHash: Uint8Array }> {
    return { lastHeight: this.height, lastAppHash: this.appHash };
  }

  private persist(p: { changes: Changes; meta: Meta; history: [ObjectId, HistoryEntry][] }): void {
    this.kv.write((w) => {
      const next = new Map<ObjectId, bigint>();
      for (const [account, entry] of p.history) {
        const seq = next.get(account) ?? this.nextSequence(account);
        w.put(accountHistoryKey(account, seq), historyEntryToBytes(entry));
        next.set(account, seq + 1n);
      }
      for (const [account, seq] of next) w.put(sequenceKey(account), encode((wr) => wr.u64(seq)));
      for (const c of p.changes.objects) {
        if (c.bytes) w.put(objectKey(c.id), c.bytes);
        else w.del(objectKey(c.id));
      }
      for (const [type, next] of p.changes.counters) w.put(counterKey(type), encode((wr) => wr.u64(BigInt(next))));
      if (p.changes.history) w.put(historyKey(p.changes.version), encode((wr) => encodeHistory(wr, p.changes.history!)));
      // History that no longer serves any provable height: the version that just left the window, and leftovers found at startup.
      if (this.db.lowestVersion > 0) w.del(historyKey(this.db.lowestVersion));
      for (const v of this.staleHistory) w.del(historyKey(v));
      this.staleHistory = [];
      w.put(META_KEY, encode((wr) => wr.u64(p.meta.height).fixed(p.meta.appHash)));
    });
    this.db.dropChanges();
  }

  private nextSequence(account: ObjectId): bigint {
    const v = this.kv.get(sequenceKey(account));
    return v ? decode(v, (r) => r.u64()) : 0n;
  }

  /** An account's history, oldest first from `from`, or newest first when reversed. */
  accountHistory(account: ObjectId, from = 0n, limit = 100, reverse = false): { entries: (HistoryEntry & { sequence: bigint })[]; total: bigint } {
    const total = this.nextSequence(account);
    const entries: (HistoryEntry & { sequence: bigint })[] = [];
    if (reverse) {
      for (let seq = total - 1n - from; seq >= 0n && entries.length < limit; seq--) {
        const v = this.kv.get(accountHistoryKey(account, seq));
        if (v) entries.push({ ...historyEntryFromBytes(v), sequence: seq });
      }
    } else {
      for (const [k, v] of this.kv.range(accountHistoryKey(account, from), accountHistoryKey(account, total))) {
        if (entries.length >= limit) break;
        entries.push({ ...historyEntryFromBytes(v), sequence: decode(k, (r) => (r.u8(), r.u64(), r.u64())) });
      }
    }
    return { entries, total };
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
  }

  private trimCache(): void {
    while (this.sigCache.size > SIG_CACHE_MAX) this.sigCache.delete(this.sigCache.keys().next().value!);
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
      this.trimCache();
    }
    // A set, never a replacement: two valid signatures by one key over one body can be in flight at once
    // (signing is randomised), and a later verification must not make an earlier one look unverified.
    let hashes = verified.get(address);
    if (!hashes) verified.set(address, (hashes = new Set()));
    hashes.add(sigHash);
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

  private async verifySignatures(tx: Transaction, txId: Uint8Array): Promise<string | null> {
    if (tx.signatures.length === 0) return 'transaction has no signatures';
    const candidates = this.signingKeys(tx);
    if (typeof candidates === 'string') return candidates;
    const txKey = toHex(txId);
    const jobs: VerifyJob[] = [];
    const jobKeys: [string, string][] = [];
    const seen = new Set<string>();
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
      if (this.isVerified(txKey, address, sigHash)) continue;
      jobs.push({ sig: s.signature, msg: body, publicKey, context: this.context });
      jobKeys.push([address, sigHash]);
    }
    if (jobs.length > 0) {
      const results = await this.verifier.verify(jobs);
      if (results.some((ok) => !ok)) return 'invalid signature';
      for (const [address, sigHash] of jobKeys) this.cacheVerified(txKey, address, sigHash);
    }
    return null;
  }

  /** Thresholds against current state, then the state changes, in a nested session. Synchronous on purpose. */
  private applyChecked(tx: Transaction, txId: Uint8Array, time: bigint, height: bigint, keep: boolean, final: boolean): TxResult {
    const txKey = toHex(txId);
    const signed = new Set<string>();
    for (const s of tx.signatures) {
      const a = toHex(s.address);
      if (this.isVerified(txKey, a, toHex(sha256(s.signature)))) signed.add(a);
    }
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
