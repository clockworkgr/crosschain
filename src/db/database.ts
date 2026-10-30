/**
 * The object database: every consensus-relevant object of every type, in
 * memory, with undo sessions, a Merkle root per version, and a retention
 * window of past versions for proofs. This is Graphene's object_database
 * plus the state root it never had.
 *
 * Writes go through create / modify / remove. Objects are immutable records:
 * modify replaces the object with a new one, so an undo log only has to keep
 * references to old values.
 *
 * Undo sessions nest. A transaction runs in a session that is undone if it
 * fails. The mempool's speculative state is a session that is undone before
 * every block and rebuilt by re-checking. There is no block-level undo
 * because blocks are final. The outermost open session also doubles as the
 * committed view: whatever it recorded as an old value is what was committed,
 * which is what queries and proofs must return while the mempool session is
 * open.
 *
 * root(version) is the only thing that touches the trees, and it must be
 * called with no session open. Until then changed objects are merely
 * remembered, so the trees always reflect the last committed state. Each
 * root() also reports the objects and counters that changed, which is what a
 * persistent store writes, and remembers the previous value of each changed
 * object so a proof can be produced for any version inside the window.
 *
 * The secondary indices' entries are also reported per root (indexstore.ts),
 * so the store holds them beside the objects, and a type's B+ trees can be
 * dropped and rebuilt (dropIndexTrees, rebuildIndexTrees): while they are
 * dropped its lookups and scans read the store, with the writes since the
 * last root laid on top (index.ts). The store the database reads is the one
 * the application writes, given as `indexStore`; between a root and the
 * application's write of it (dropChanges) the root's own changes are laid
 * over that store, so a read never sees an index older than the objects.
 */
import { decode, type Reader } from '../codec/reader.ts';
import { encode, type Writer } from '../codec/writer.ts';
import { bytesEqual, HASH_SIZE } from '../crypto/hash.ts';
import { instanceOf, objectId, typeOf, type ObjectId } from './id.ts';
import { Arena, type ArenaStats } from './arena.ts';
import { deepFreeze } from './freeze.ts';
import { DbError, TypeIndex, type HotBudget, type ObjectType } from './index.ts';
import { MemoryIndexStore, overlaid, until, type IndexEntryChange, type IndexStore } from './indexstore.ts';
import { BPlusTree } from './bptree.ts';
import { DenseMerkleTree, EMPTY, type TreeRecords } from './merkle.ts';
import { objectLeaf, typeLeaf, type KeyProof, type ObjectProof } from './proof.ts';
import { SparseMerkleTree } from './smt.ts';

export { deepFreeze } from './freeze.ts';
export type { IndexEntryChange, IndexStore } from './indexstore.ts';

type AnyObject = { id: ObjectId };

export interface DatabaseOptions {
  /** How many past versions stay provable. 0 keeps only the current one. */
  retainVersions?: number;
  /** How many decoded objects the hot caches may hold together (STATE-PAGING.md section 3); unbounded by default. */
  hotObjects?: number;
  /**
   * The store that holds the index entries the application writes from each root's change list. Without one, a
   * database that drops its trees keeps the entries in memory instead (tests, benchmarks, a snapshot import).
   */
  indexStore?: IndexStore;
  /** Start with the B+ trees of the secondary indices dropped, every index read going to the store; default resident. */
  indexTrees?: boolean;
}

/** Where `indexTrees` defaults from; the test setup turns it off to run every suite on the fallback (INDEX_TREES=0). */
let defaultIndexTrees = true;
export function setDefaultIndexTrees(resident: boolean): void {
  defaultIndexTrees = resident;
}

/** What the database holds in memory besides the trees and indices, for the memory guard and status. */
export interface DatabaseMemory {
  arena: ArenaStats;
  hotObjects: number;
  hotLimit: number;
  /** Bytes of past values kept for the retention window. */
  historyBytes: number;
  /** The secondary indices' B+ trees: all resident, all dropped (reads go to the store), or some of each. */
  indexTrees: 'resident' | 'dropped' | 'partial';
}

export interface ObjectChange {
  id: ObjectId;
  /** The new encoding, or null if the object was removed. */
  bytes: Uint8Array | null;
}

/** What was true before one version, so a store can give the history back after a restart. */
export interface HistoryRecord {
  /** Tree records by tree: a type id, or TOP_TREE for the tree over the types. */
  trees: { tree: number; records: TreeRecords }[];
  /** Before this version the object was these bytes, or did not exist. */
  objects: [ObjectId, Uint8Array | null][];
  /** Before this version the type's counter was this. */
  counters: [number, number][];
}

export const TOP_TREE = 0;

/** What one root() changed, for a persistent store to write. */
export interface Changes {
  version: number;
  objects: ObjectChange[];
  /** Types whose counter moved, with the new counter. */
  counters: Map<number, number>;
  /** Null when no history is kept. */
  history: HistoryRecord | null;
  /**
   * Index entries added (with their value) and removed (null), as store keys. Removals come first, so a key
   * passed from one object to another in one version ends with its new owner when they are applied in order.
   * Empty for a database that keeps no index store (none given and the trees resident).
   */
  indices: IndexEntryChange[];
}

export function encodeHistory(w: Writer, h: HistoryRecord): void {
  w.array(h.trees, (w, t) => {
    w.u16(t.tree).option(t.records.sizeBefore, (w, n) => w.u64(BigInt(n)));
    w.array(t.records.nodes, (w, [k, j, hash]) => w.u8(k).u64(BigInt(j)).fixed(hash));
  });
  w.array(h.objects, (w, [id, bytes]) => w.u64(id).option(bytes, (w, b) => w.bytes(b)));
  w.array(h.counters, (w, [type, n]) => w.u16(type).u64(BigInt(n)));
}

export function decodeHistory(r: Reader): HistoryRecord {
  return {
    trees: r.array((r) => ({
      tree: r.u16(),
      records: {
        sizeBefore: r.option((r) => Number(r.u64())),
        nodes: r.array((r) => [r.u8(), Number(r.u64()), r.fixed(HASH_SIZE)] as [number, number, Uint8Array]),
      },
    })),
    objects: r.array((r) => [r.u64(), r.option((r) => r.bytes())] as [ObjectId, Uint8Array | null]),
    counters: r.array((r) => [r.u16(), Number(r.u64())] as [number, number]),
  };
}

export class UndoSession {
  private readonly db: ObjectDatabase;
  readonly created = new Set<ObjectId>();
  /** id to the value it had when this session first touched it. */
  readonly modified = new Map<ObjectId, AnyObject>();
  readonly removed = new Map<ObjectId, AnyObject>();
  /** type to its counter when this session first created an object of it. */
  readonly counters = new Map<number, number>();
  private active = true;

  constructor(db: ObjectDatabase) {
    this.db = db;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Revert everything this session did. It must be the innermost open session. */
  undo(): void {
    this.db.undoSession(this);
    this.active = false;
  }

  /** Keep the changes: fold them into the enclosing session, or make them permanent if there is none. */
  commit(): void {
    this.db.commitSession(this);
    this.active = false;
  }
}

const SNAPSHOT_VERSION = 2;
const DEFAULT_RETAIN = 100;
/** Unbounded: with memory to spare every decoded object stays, and the node runs as it did before the arena. The memory guard caps it. */
const DEFAULT_HOT = Infinity;

export class ObjectDatabase {
  private readonly types = new Map<number, TypeIndex<AnyObject>>();
  /** Type ids in ascending order; a type's position here is its leaf in the top tree. */
  private readonly order: number[];
  private readonly trees = new Map<number, DenseMerkleTree>();
  private readonly top: DenseMerkleTree;
  private readonly sessions: UndoSession[] = [];
  private readonly dirty = new Set<ObjectId>();
  private readonly retain: number;
  private version = -1;
  /** The oldest version this database can describe: where it was built, lowered as history is loaded. */
  private floor = 0;
  /** For every object written since the last root(): its value at that root. */
  private readonly shadow = new Map<ObjectId, AnyObject | null>();
  private readonly counterShadow = new Map<number, number>();
  /** Before version v, the object was these bytes (null: did not exist). Bytes, not records: the window costs what it stores. */
  private readonly valueHistory = new Map<ObjectId, { v: number; bytes: Uint8Array | null }[]>();
  private historyBytes = 0;
  /** The committed encodings of every object, and the budget the types' hot caches share. */
  private readonly arena: Arena;
  private readonly hotBudget: HotBudget;
  private readonly valueHistoryByVersion = new Map<number, ObjectId[]>();
  private readonly counterHistory = new Map<number, { v: number; count: number }[]>();
  private readonly lastIndexRoots = new Map<number, Uint8Array[]>();
  private changes: Changes | null = null;
  /** The application's store of index entries, or null when there is none. */
  private readonly store: IndexStore | null;
  /** Without an application store: the index entries in memory, kept only while some type's trees are dropped. */
  private ownStore: MemoryIndexStore | null = null;
  /** Index changes of roots the application has not written to its store yet, oldest first, and the same as a map, built when read. */
  private unwritten: IndexEntryChange[][] = [];
  private unwrittenMap: BPlusTree<Uint8Array | null> | null = null;
  /** Whether the objects were imported with their index entries already in the store (a restart), so the first root reports none. */
  private importsIndexed: boolean | null = null;
  /** What a dropped index reads: the store as of the last root. */
  private readonly base: IndexStore;

  constructor(types: ObjectType<any>[], opts: DatabaseOptions = {}) {
    this.retain = Math.max(0, opts.retainVersions ?? DEFAULT_RETAIN);
    this.hotBudget = { limit: Math.max(0, opts.hotObjects ?? DEFAULT_HOT), size: 0 };
    this.arena = new Arena({
      refOf: (type, instance) => this.types.get(type)?.refAt(instance) ?? -1,
      relocate: (type, instance, ref) => this.types.get(type)!.relocate(instance, ref),
    });
    this.store = opts.indexStore ?? null;
    const resident = opts.indexTrees ?? defaultIndexTrees;
    if (!resident && !this.store) this.ownStore = new MemoryIndexStore();
    this.base = {
      get: (k) => {
        const v = this.unwrittenEntries()?.get(k);
        return v !== undefined ? (v ?? undefined) : this.backing()?.get(k);
      },
      range: (start, end) => {
        const stored = this.backing()?.range(start, end) ?? [][Symbol.iterator]();
        const pending = this.unwrittenEntries();
        return pending ? overlaid(stored, until(pending.entriesFrom(start), end)) : stored;
      },
    };
    for (const t of types) {
      if (this.types.has(t.id)) throw new Error(`duplicate object type ${t.id}`);
      this.types.set(t.id, new TypeIndex(t, this.retain, this.arena, this.hotBudget, this.base, resident));
      this.trees.set(t.id, new DenseMerkleTree(this.retain));
    }
    this.order = [...this.types.keys()].sort((a, b) => a - b);
    this.top = new DenseMerkleTree(this.retain);
    this.top.resize(this.order.length);
  }

  private typeIndex<T extends AnyObject>(type: ObjectType<T>): TypeIndex<T> {
    const ti = this.types.get(type.id);
    if (!ti) throw new Error(`unregistered object type ${type.name}`);
    return ti as unknown as TypeIndex<T>;
  }

  private typeIndexById(type: number): TypeIndex<AnyObject> {
    const ti = this.types.get(type);
    if (!ti) throw new Error(`unregistered object type ${type}`);
    return ti;
  }

  private get session(): UndoSession | null {
    return this.sessions.length > 0 ? this.sessions[this.sessions.length - 1]! : null;
  }

  get currentVersion(): number {
    return this.version;
  }

  /** The oldest version proofs can still be made for. */
  get lowestVersion(): number {
    return Math.max(this.floor, this.retain > 0 ? this.version - this.retain : this.version);
  }

  /** What the last root() changed. */
  get lastChanges(): Changes | null {
    return this.changes;
  }

  /**
   * Forget the last change list once a store has written it; it holds the encoded bytes of every changed object.
   * It is also the word that the store now holds the index entries, so dropped indices read them from there.
   */
  dropChanges(): void {
    this.changes = null;
    this.unwritten = [];
    this.unwrittenMap = null;
  }

  private backing(): IndexStore | null {
    return this.store ?? this.ownStore;
  }

  /** The index changes the store has not been given yet, as one map (null: removed), or null when there are none. */
  private unwrittenEntries(): BPlusTree<Uint8Array | null> | null {
    if (this.unwritten.length === 0) return null;
    if (!this.unwrittenMap) {
      this.unwrittenMap = new BPlusTree();
      for (const list of this.unwritten) for (const c of list) this.unwrittenMap.set(c.key, c.value);
    }
    return this.unwrittenMap;
  }

  // ---- the index tier ----

  /**
   * Drop the B+ trees of one type's secondary indices, or of every type's: lookups and scans then read the store,
   * with the writes since the last root laid over it. Sessions may be open; the overlay starts from what is dirty.
   */
  dropIndexTrees(type?: ObjectType<any>): void {
    if (!this.backing()) {
      // No application store: one in memory stands in, holding what a store written at every root would hold now,
      // the entries as of the last root (none before the first). That is the trees as they stand with the writes
      // since then taken back: a key a write took and released again before the drop must not linger in it.
      const own = new MemoryIndexStore();
      if (this.version >= 0) {
        for (const type of this.order) own.apply(Array.from(this.typeIndexById(type).indexEntries(), ([key, value]) => ({ key, value })));
        const removed: IndexEntryChange[] = [];
        const added: IndexEntryChange[] = [];
        for (const id of this.dirty) {
          const ti = this.typeIndexById(typeOf(id));
          const instance = instanceOf(id);
          ti.diffEntries(instance < ti.nextInstance ? (ti.get(instance) ?? null) : null, this.shadow.get(id) ?? null, removed, added);
        }
        own.apply(removed);
        own.apply(added);
      }
      this.ownStore = own;
    }
    for (const ti of type ? [this.typeIndex(type) as TypeIndex<AnyObject>] : this.types.values()) {
      if (!ti.resident) continue;
      const changed: [AnyObject | null, AnyObject | null][] = [];
      for (const id of this.dirty) {
        if (typeOf(id) !== ti.type.id) continue;
        const instance = instanceOf(id);
        changed.push([this.shadow.get(id) ?? null, instance < ti.nextInstance ? (ti.get(instance) ?? null) : null]);
      }
      ti.dropTrees(changed);
    }
  }

  /** Build the dropped B+ trees again from the store (and the overlay), for one type or for all. */
  rebuildIndexTrees(type?: ObjectType<any>): void {
    for (const ti of type ? [this.typeIndex(type) as TypeIndex<AnyObject>] : this.types.values()) ti.rebuildTrees();
    // The in-memory stand-in for a store is only there for dropped trees to fall back on.
    if (!this.store && [...this.types.values()].every((ti) => ti.resident)) this.ownStore = null;
  }

  /** Whether a type's index trees are resident. */
  indexTreesResident(type: ObjectType<any>): boolean {
    return this.typeIndex(type).resident;
  }

  /** Every index entry of every type as it stands, as store keys and values: what a store written from scratch holds. */
  *indexEntries(): IterableIterator<[Uint8Array, Uint8Array]> {
    for (const type of this.order) yield* this.typeIndexById(type).indexEntries();
  }

  /**
   * Check the store's index entries against the resident trees (for tests): every tree entry is in the store with
   * its value, and the store holds as many entries under each index's prefix as the tree. Empty when consistent.
   */
  checkIndexStore(): string[] {
    if (!this.backing()) throw new DbError('no index store to check');
    if (this.dirty.size > 0) throw new DbError('the index store can be checked only right after a root');
    return [...this.types.values()].flatMap((ti) => ti.checkStore(this.base));
  }

  /**
   * After importing objects whose index entries the store holds (importObject with `indexed`): fill the sparse
   * trees, and the B+ trees where resident, from the store's entries instead of decoding every object.
   */
  loadIndexEntries(): void {
    if (!this.store || this.importsIndexed !== true || this.version >= 0) throw new DbError('index entries are loaded from the store only after an indexed import');
    for (const ti of this.types.values()) ti.loadIndexEntries();
  }

  /** Change the hot caches' shared budget at run time (the memory guard's first dial); the excess is evicted at once. */
  setHotLimit(limit: number): void {
    this.hotBudget.limit = Math.max(0, limit);
    for (const ti of this.types.values()) ti.evict();
  }

  memory(): DatabaseMemory {
    const withIndices = [...this.types.values()].filter((ti) => ti.type.indices.length > 0);
    const resident = withIndices.filter((ti) => ti.resident).length;
    const indexTrees = resident === withIndices.length ? 'resident' : resident === 0 ? 'dropped' : 'partial';
    return { arena: this.arena.stats, hotObjects: this.hotBudget.size, hotLimit: this.hotBudget.limit, historyBytes: this.historyBytes, indexTrees };
  }

  // ---- reads ----

  get<T extends AnyObject>(type: ObjectType<T>, id: ObjectId): T | null {
    if (typeOf(id) !== type.id) return null;
    return this.typeIndex(type).get(instanceOf(id)) ?? null;
  }

  /** Exact match on a unique index. */
  lookup<T extends AnyObject>(type: ObjectType<T>, index: string, key: Uint8Array): T | null {
    const ti = this.typeIndex(type);
    const id = ti.lookupId(index, key);
    return id === undefined ? null : (ti.get(instanceOf(id)) ?? null);
  }

  /** Every object whose index key starts with the prefix, in key order. */
  *scan<T extends AnyObject>(type: ObjectType<T>, index: string, prefix: Uint8Array): IterableIterator<T> {
    const ti = this.typeIndex(type);
    for (const [, id] of ti.entries(index, prefix, prefix)) yield ti.get(instanceOf(id))!;
  }

  range<T extends AnyObject>(type: ObjectType<T>, index: string, prefix: Uint8Array): T[] {
    return [...this.scan(type, index, prefix)];
  }

  /** Every object whose index key is at or after `start`, in key order; a page of results resumes here. */
  *scanFrom<T extends AnyObject>(type: ObjectType<T>, index: string, start: Uint8Array): IterableIterator<[Uint8Array, T]> {
    const ti = this.typeIndex(type);
    for (const [k, id] of ti.entries(index, start, null)) yield [k, ti.get(instanceOf(id))!];
  }

  nextInstance(type: ObjectType<any>): number {
    return this.typeIndex(type).nextInstance;
  }

  // ---- writes ----

  create<T extends AnyObject>(type: ObjectType<T>, init: (id: ObjectId) => T): T {
    const ti = this.typeIndex(type);
    const id = objectId(type.id, ti.nextInstance);
    const obj = deepFreeze(init(id));
    if (obj.id !== id) throw new DbError('object must carry the id it was given');
    ti.insert(obj);
    if (!this.counterShadow.has(type.id)) this.counterShadow.set(type.id, ti.nextInstance);
    if (!this.shadow.has(id)) this.shadow.set(id, null);
    const s = this.session;
    if (s) {
      if (!s.counters.has(type.id)) s.counters.set(type.id, ti.nextInstance);
      s.created.add(id);
    }
    ti.nextInstance++;
    this.dirty.add(id);
    return obj;
  }

  modify<T extends AnyObject>(type: ObjectType<T>, id: ObjectId, fn: (old: T) => T): T {
    const ti = this.typeIndex(type);
    const old = this.get(type, id);
    if (!old) throw new DbError(`${type.name} ${instanceOf(id)} does not exist`);
    const next = deepFreeze(fn(old));
    if (next.id !== id) throw new DbError('modify may not change the id');
    ti.insert(next);
    if (!this.shadow.has(id)) this.shadow.set(id, old);
    const s = this.session;
    if (s && !s.created.has(id) && !s.modified.has(id)) s.modified.set(id, old);
    this.dirty.add(id);
    return next;
  }

  remove<T extends AnyObject>(type: ObjectType<T>, id: ObjectId): void {
    const ti = this.typeIndex(type);
    const old = this.get(type, id);
    if (!old) throw new DbError(`${type.name} ${instanceOf(id)} does not exist`);
    ti.erase(old);
    if (!this.shadow.has(id)) this.shadow.set(id, old);
    const s = this.session;
    if (s) {
      if (s.created.has(id)) s.created.delete(id);
      else if (s.modified.has(id)) {
        s.removed.set(id, s.modified.get(id)!);
        s.modified.delete(id);
      } else s.removed.set(id, old);
    }
    this.dirty.add(id);
  }

  // ---- sessions ----

  startSession(): UndoSession {
    const s = new UndoSession(this);
    this.sessions.push(s);
    return s;
  }

  get sessionDepth(): number {
    return this.sessions.length;
  }

  private popSession(s: UndoSession): void {
    if (!s.isActive) throw new DbError('session already closed');
    if (this.session !== s) throw new DbError('sessions must be closed innermost first');
    this.sessions.pop();
  }

  /** @internal */
  undoSession(s: UndoSession): void {
    this.popSession(s);
    // Erase first, then put old values back, so a restored unique key never collides
    // with a value that is itself about to go.
    for (const id of s.created) {
      const ti = this.typeIndexById(typeOf(id));
      const cur = ti.get(instanceOf(id));
      if (cur) ti.erase(cur);
      this.dirty.add(id);
    }
    for (const id of s.modified.keys()) {
      const ti = this.typeIndexById(typeOf(id));
      const cur = ti.get(instanceOf(id));
      if (cur) ti.erase(cur);
    }
    for (const [id, old] of s.modified) {
      this.typeIndexById(typeOf(id)).insert(old);
      this.dirty.add(id);
    }
    for (const [id, old] of s.removed) {
      this.typeIndexById(typeOf(id)).insert(old);
      this.dirty.add(id);
    }
    for (const [type, before] of s.counters) this.typeIndexById(type).truncate(before);
  }

  /** @internal */
  commitSession(s: UndoSession): void {
    this.popSession(s);
    const parent = this.session;
    if (!parent) return;
    for (const [type, before] of s.counters) if (!parent.counters.has(type)) parent.counters.set(type, before);
    for (const id of s.created) parent.created.add(id);
    for (const [id, old] of s.modified) {
      if (parent.created.has(id) || parent.modified.has(id)) continue;
      parent.modified.set(id, old);
    }
    for (const [id, old] of s.removed) {
      if (parent.created.has(id)) parent.created.delete(id);
      else if (parent.modified.has(id)) {
        parent.removed.set(id, parent.modified.get(id)!);
        parent.modified.delete(id);
      } else parent.removed.set(id, old);
    }
  }

  // ---- committed and historical views ----

  /** The object as of the last root(), looking through every open session. */
  getCommitted<T extends AnyObject>(type: ObjectType<T>, id: ObjectId): T | null {
    for (const s of this.sessions) {
      if (s.created.has(id)) return null;
      const m = s.modified.get(id);
      if (m) return m as T;
      const r = s.removed.get(id);
      if (r) return r as T;
    }
    return this.get(type, id);
  }

  committedNextInstance(type: number): number {
    for (const s of this.sessions) {
      const c = s.counters.get(type);
      if (c !== undefined) return c;
    }
    return this.typeIndexById(type).nextInstance;
  }

  private checkVersion(version: number): void {
    if (this.version < 0) throw new DbError('no root computed yet');
    if (version > this.version || version < this.lowestVersion) throw new RangeError(`version ${version} is not available (have ${this.lowestVersion}..${this.version})`);
  }

  /** The object as of a past version inside the retention window. */
  getAt<T extends AnyObject>(type: ObjectType<T>, id: ObjectId, version: number): T | null {
    this.checkVersion(version);
    const entries = this.valueHistory.get(id);
    if (entries) for (const e of entries) if (e.v > version) return e.bytes ? deepFreeze(decode(e.bytes, (r) => type.decode(r, id))) : null;
    return this.getCommitted(type, id);
  }

  /** The encoding of an object as of a past version inside the window, without decoding it: for snapshots and proofs. */
  bytesAt(id: ObjectId, version: number): Uint8Array | null {
    this.checkVersion(version);
    const entries = this.valueHistory.get(id);
    if (entries) for (const e of entries) if (e.v > version) return e.bytes;
    const ti = this.typeIndexById(typeOf(id));
    for (const s of this.sessions) {
      if (s.created.has(id)) return null;
      const old = s.modified.get(id) ?? s.removed.get(id);
      if (old) return encode((w) => ti.type.encode(w, old));
    }
    return ti.bytesFor(instanceOf(id)) ?? null;
  }

  countAt(type: number, version: number): number {
    this.checkVersion(version);
    const entries = this.counterHistory.get(type);
    if (entries) for (const e of entries) if (e.v > version) return e.count;
    return this.committedNextInstance(type);
  }

  // ---- Merkle root and proofs ----

  /**
   * Hash every changed object into its type tree and every type into the top
   * tree, and return the root as of `version`. Versions must increase; the
   * default is the next one.
   */
  root(version = this.version + 1): Uint8Array {
    if (this.sessions.length > 0) throw new DbError('root() needs every session closed');
    if (version <= this.version) throw new DbError(`version ${version} is not after ${this.version}`);
    if (this.version < 0) this.floor = version;
    const objects: ObjectChange[] = [];
    const touched = new Set<number>();
    if (this.version < 0) for (const t of this.order) touched.add(t);
    const keepHistory = this.retain > 0 && this.version >= 0;
    const historyIds: ObjectId[] = [];
    const record: HistoryRecord = { trees: [], objects: [], counters: [] };
    // The index entries this root changes. The first root of a database writes every entry, since the store holds
    // none of them yet, unless the objects came from a store that does (a restart); after that, each changed
    // object's committed keys against its new ones. A database with no store to keep (none given, trees resident)
    // reports none.
    const removed: IndexEntryChange[] = [];
    const added: IndexEntryChange[] = [];
    const first = this.version < 0;
    const reportIndices = this.backing() !== null;
    if (reportIndices && first && !this.importsIndexed) for (const type of this.order) for (const [key, value] of this.typeIndexById(type).indexEntries()) added.push({ key, value });
    for (const id of this.dirty) {
      const type = typeOf(id);
      const ti = this.typeIndexById(type);
      const tree = this.trees.get(type)!;
      tree.resize(ti.nextInstance);
      const instance = instanceOf(id);
      if (instance >= ti.nextInstance) continue; // created and undone: it never existed
      const pending = ti.pending(instance);
      let bytes: Uint8Array | null;
      if (pending === undefined) {
        // Imported straight into the arena (the first root after an import): hash the bytes as they are.
        bytes = ti.bytesOf(instance)?.slice() ?? null;
      } else {
        const before = this.shadow.get(id);
        if (before !== undefined && before === pending) {
          ti.settle(instance); // written and written back
          continue;
        }
        // Encoded once here, however many times it was modified since the last root.
        bytes = pending ? encode((w) => ti.type.encode(w, pending)) : null;
        if (reportIndices && !first) ti.diffEntries(before ?? null, pending, removed, added, instance);
        ti.flush(instance, bytes);
        if (keepHistory && before !== undefined) {
          const beforeBytes = before ? encode((w) => ti.type.encode(w, before)) : null;
          let entries = this.valueHistory.get(id);
          if (!entries) this.valueHistory.set(id, (entries = []));
          entries.push({ v: version, bytes: beforeBytes });
          this.historyBytes += beforeBytes?.length ?? 0;
          historyIds.push(id);
          record.objects.push([id, beforeBytes]);
        }
      }
      tree.setLeaf(instance, bytes ? objectLeaf(id, bytes) : EMPTY);
      objects.push({ id, bytes });
      touched.add(type);
    }
    this.dirty.clear();
    this.shadow.clear();
    const indices = removed.length === 0 ? added : removed.concat(added);
    // The store dropped indices read must say what this root says before the overlays are emptied.
    if (this.store) {
      if (indices.length > 0) {
        this.unwritten.push(indices);
        if (this.unwrittenMap) for (const c of indices) this.unwrittenMap.set(c.key, c.value);
      }
    } else this.ownStore?.apply(indices);
    // Pins are off; each type's hot cache comes back under the budget in one pass.
    for (const ti of this.types.values()) ti.afterRoot();
    if (historyIds.length > 0) this.valueHistoryByVersion.set(version, historyIds);

    const counters = new Map<number, number>();
    for (const [type, before] of this.counterShadow) {
      const now = this.typeIndexById(type).nextInstance;
      if (now === before) continue;
      counters.set(type, now);
      touched.add(type);
      if (keepHistory) {
        let entries = this.counterHistory.get(type);
        if (!entries) this.counterHistory.set(type, (entries = []));
        entries.push({ v: version, count: before });
        record.counters.push([type, before]);
      }
    }
    this.counterShadow.clear();

    // Every tree advances to the version, touched or not, so historical reads line up.
    for (const type of this.order) {
      const ti = this.typeIndexById(type);
      const tree = this.trees.get(type)!;
      tree.resize(ti.nextInstance);
      const typeRoot = tree.root(version);
      const indexRoots = ti.authenticated.map((name) => ti.trees.get(name)!.commit(version));
      const previous = this.lastIndexRoots.get(type);
      if (!previous || indexRoots.some((r, i) => !bytesEqual(r, previous[i]!))) touched.add(type);
      this.lastIndexRoots.set(type, indexRoots);
      if (touched.has(type)) this.top.setLeaf(this.order.indexOf(type), typeLeaf(type, BigInt(ti.nextInstance), typeRoot, indexRoots));
      const recs = tree.lastRecords;
      if (keepHistory && (recs.nodes.length > 0 || recs.sizeBefore !== null)) record.trees.push({ tree: type, records: recs });
    }
    const root = this.top.root(version);
    if (keepHistory && this.top.lastRecords.nodes.length > 0) record.trees.push({ tree: TOP_TREE, records: this.top.lastRecords });
    this.version = version;
    this.changes = { version, objects, counters, history: keepHistory ? record : null, indices };
    if (this.retain > 0) this.pruneHistory(version - this.retain);
    // Slabs the block left more than half dead are compacted now, while the node idles.
    this.arena.maintain();
    return root;
  }

  private pruneHistory(minVersion: number): void {
    for (const [v, ids] of this.valueHistoryByVersion) {
      if (v > minVersion) continue;
      for (const id of ids) {
        const entries = this.valueHistory.get(id)!;
        while (entries.length > 0 && entries[0]!.v <= minVersion) this.historyBytes -= entries.shift()!.bytes?.length ?? 0;
        if (entries.length === 0) this.valueHistory.delete(id);
      }
      this.valueHistoryByVersion.delete(v);
    }
    for (const [type, entries] of this.counterHistory) {
      while (entries.length > 0 && entries[0]!.v <= minVersion) entries.shift();
      if (entries.length === 0) this.counterHistory.delete(type);
    }
  }

  /** Give back the history a store kept for one version. Load ascending, after root() for the current version. */
  loadHistory(version: number, rec: HistoryRecord): void {
    if (this.version < 0 || version > this.version) throw new DbError(`cannot load history for version ${version}`);
    if (version - 1 < this.floor) this.floor = Math.max(0, version - 1);
    if (version <= this.lowestVersion) return;
    // Every tree can answer for version - 1: the ones this record names from their records, the rest
    // because nothing touched them, so their later state is also their state then.
    this.top.lowerFloor(version - 1);
    for (const tree of this.trees.values()) tree.lowerFloor(version - 1);
    for (const t of rec.trees) (t.tree === TOP_TREE ? this.top : this.trees.get(t.tree))?.loadRecords(version, t.records);
    const ids: ObjectId[] = [];
    for (const [id, bytes] of rec.objects) {
      // Kept as the bytes the store gave back; decoded only if a past version is asked for.
      let entries = this.valueHistory.get(id);
      if (!entries) this.valueHistory.set(id, (entries = []));
      entries.push({ v: version, bytes });
      this.historyBytes += bytes?.length ?? 0;
      ids.push(id);
    }
    if (ids.length > 0) this.valueHistoryByVersion.set(version, ids);
    for (const [type, count] of rec.counters) {
      let entries = this.counterHistory.get(type);
      if (!entries) this.counterHistory.set(type, (entries = []));
      entries.push({ v: version, count });
    }
  }

  /** Inclusion or absence proof for an id as of a version inside the retention window. */
  proofAt(id: ObjectId, version: number): ObjectProof {
    this.checkVersion(version);
    const type = typeOf(id);
    const ti = this.typeIndexById(type);
    const tree = this.trees.get(type)!;
    const instance = instanceOf(id);
    const count = this.countAt(type, version);
    const idx = this.order.indexOf(type);
    return {
      height: BigInt(version),
      id,
      value: this.bytesAt(id, version)?.slice() ?? null,
      nextInstance: BigInt(count),
      typeRoot: tree.rootAt(version),
      typeSiblings: instance < count ? tree.pathAt(instance, version) : [],
      indexRoots: ti.authenticated.map((name) => ti.trees.get(name)!.rootAt(version)),
      typeIndex: idx,
      typeCount: this.order.length,
      topSiblings: this.top.pathAt(idx, version),
    };
  }

  /** The contents of a type's leaf as of a version, with its path to the app hash. */
  typeLeafProofAt(type: number, version: number): { nextInstance: bigint; typeRoot: Uint8Array; indexRoots: Uint8Array[]; typeIndex: number; typeCount: number; topSiblings: Uint8Array[] } {
    this.checkVersion(version);
    const ti = this.typeIndexById(type);
    const idx = this.order.indexOf(type);
    return {
      nextInstance: BigInt(this.countAt(type, version)),
      typeRoot: this.trees.get(type)!.rootAt(version),
      indexRoots: ti.authenticated.map((name) => ti.trees.get(name)!.rootAt(version)),
      typeIndex: idx,
      typeCount: this.order.length,
      topSiblings: this.top.pathAt(idx, version),
    };
  }

  /** Siblings that fold instances [from, to) of a type to its root as of a version. */
  rangeProofAt(type: number, from: number, to: number, version: number): Uint8Array[] {
    return this.trees.get(type)!.rangeProofAt(from, to, version);
  }

  /** The app hash as of a version inside the window. */
  rootAt(version: number): Uint8Array {
    this.checkVersion(version);
    return this.top.rootAt(version);
  }

  /** Type ids in leaf order. */
  get typeOrder(): number[] {
    return [...this.order];
  }

  /** Membership or absence proof for a key of an authenticated index, as of a version. */
  proveKeyAt(type: ObjectType<any>, index: string, key: Uint8Array, version: number): KeyProof {
    this.checkVersion(version);
    const ti = this.typeIndex(type);
    const position = ti.authenticated.indexOf(index);
    if (position < 0) throw new DbError(`${type.name}.${index} is not an authenticated index`);
    const idx = this.order.indexOf(type.id);
    return {
      height: BigInt(version),
      type: type.id,
      indexPosition: position,
      key,
      proof: ti.trees.get(index)!.proveAt(key, version),
      nextInstance: BigInt(this.countAt(type.id, version)),
      typeRoot: this.trees.get(type.id)!.rootAt(version),
      indexRoots: ti.authenticated.map((name) => ti.trees.get(name)!.rootAt(version)),
      typeIndex: idx,
      typeCount: this.order.length,
      topSiblings: this.top.pathAt(idx, version),
    };
  }

  proveKey(type: ObjectType<any>, index: string, key: Uint8Array): KeyProof {
    return this.proveKeyAt(type, index, key, this.version);
  }

  /**
   * After the history has been loaded: rebuild every authenticated index at
   * the oldest version in the window from the object history, then replay
   * forward committing each version, so past-version key proofs work again.
   * The sparse tree's shape depends only on its keys, so the result matches
   * what the original run produced, which is checked against the live root.
   */
  rebuildIndexVersions(): void {
    if (this.version < 0 || this.sessions.length > 0) throw new DbError('rebuild needs a root and no open session');
    const lowest = this.lowestVersion;
    if (lowest === this.version) return;
    for (const type of this.order) {
      const ti = this.typeIndexById(type);
      if (ti.authenticated.length === 0) continue;
      const candidates = new Set<ObjectId>();
      for (const instance of ti.instances()) candidates.add(objectId(type, instance));
      for (const id of this.valueHistory.keys()) if (typeOf(id) === type) candidates.add(id);
      for (const name of ti.authenticated) {
        const rebuilt = new SparseMerkleTree(this.retain);
        const put = (obj: AnyObject | null) => obj && rebuilt.set(ti.keyFor(obj, name), encode((w) => w.u64(obj.id)));
        const drop = (obj: AnyObject | null) => obj && rebuilt.delete(ti.keyFor(obj, name));
        for (const id of candidates) put(this.getAt(ti.type, id, lowest));
        rebuilt.commit(lowest);
        for (let v = lowest + 1; v <= this.version; v++) {
          // Every key a version released is dropped before any it took, or a swap of keys between two objects would erase one.
          const changed = (this.valueHistoryByVersion.get(v) ?? []).filter((id) => typeOf(id) === type);
          for (const id of changed) {
            const e = this.valueHistory.get(id)!.find((e) => e.v === v)!;
            drop(e.bytes ? decode(e.bytes, (r) => ti.type.decode(r, id)) : null);
          }
          for (const id of changed) put(this.getAt(ti.type, id, v));
          rebuilt.commit(v);
        }
        if (!bytesEqual(rebuilt.rootHash(), ti.trees.get(name)!.rootHash())) throw new DbError(`${ti.type.name}.${name}: rebuilt index does not match the live one`);
        ti.replaceTree(name, rebuilt);
      }
    }
  }

  /** Proof against the latest root. */
  proof(id: ObjectId): ObjectProof {
    return this.proofAt(id, this.version);
  }

  // ---- bulk import and export ----

  /**
   * Load one object into an empty database, before the first root(). Counters are set separately. With `indexed`,
   * the index store already holds the object's index entries (a restart from the application's store): the object
   * is not decoded at all, and loadIndexEntries() builds the indices from the store once every object is in.
   */
  importObject(id: ObjectId, bytes: Uint8Array, indexed = false): void {
    if (this.version >= 0 || this.sessions.length > 0) throw new DbError('import only into a fresh database');
    if (this.importsIndexed !== null && this.importsIndexed !== indexed) throw new DbError('an import is indexed or not throughout');
    if (indexed && !this.store) throw new DbError('an indexed import needs the index store');
    this.importsIndexed = indexed;
    const ti = this.typeIndexById(typeOf(id));
    // Decoded once for its index keys and not kept: the arena holds the bytes, the first root hashes them as they are.
    if (indexed) ti.importBytes(instanceOf(id), bytes);
    else ti.importCommitted(decode(bytes, (r) => ti.type.decode(r, id)), bytes);
    if (instanceOf(id) >= ti.nextInstance) ti.nextInstance = instanceOf(id) + 1;
    this.dirty.add(id);
  }

  setCounter(type: number, next: number): void {
    if (this.version >= 0 || this.sessions.length > 0) throw new DbError('counters are set only in a fresh database');
    const ti = this.typeIndexById(type);
    if (next < ti.nextInstance) throw new DbError('counter below an imported object');
    ti.nextInstance = next;
  }

  /** Every object of every type, in id order, as encoded bytes. */
  *exportObjects(): IterableIterator<[ObjectId, Uint8Array]> {
    for (const type of this.order) {
      const ti = this.typeIndexById(type);
      for (const instance of ti.instances()) yield [objectId(type, instance), ti.bytesFor(instance)!];
    }
  }

  counters(): Map<number, number> {
    return new Map(this.order.map((t) => [t, this.typeIndexById(t).nextInstance]));
  }

  /** A self-contained snapshot: every object in id order plus the counters. Deterministic. */
  encodeSnapshot(height: bigint, appHash: Uint8Array): Uint8Array {
    if (this.sessions.length > 0) throw new DbError('snapshot needs every session closed');
    return encode((w) => {
      w.u32(SNAPSHOT_VERSION).u64(height).fixed(appHash);
      w.array(this.order, (w, type) => {
        const ti = this.typeIndexById(type);
        const present = [...ti.instances()];
        w.u16(type).u64(BigInt(ti.nextInstance));
        w.array(present, (w, instance) => {
          w.u64(objectId(type, instance));
          w.bytes(ti.bytesFor(instance)!);
        });
      });
    });
  }

  /** Replace all contents with a snapshot. Returns what the snapshot claims; the caller compares root() against it. */
  loadSnapshot(bytes: Uint8Array): { height: bigint; appHash: Uint8Array } {
    return decode(bytes, (r: Reader) => {
      const v = r.u32();
      if (v !== SNAPSHOT_VERSION) throw new DbError(`snapshot version ${v}`);
      const height = r.u64();
      const appHash = r.fixed(HASH_SIZE);
      r.array((r) => {
        const type = r.u16();
        const next = Number(r.u64());
        r.array((r) => {
          const id = r.u64();
          if (typeOf(id) !== type || instanceOf(id) >= next) throw new DbError('snapshot object out of range');
          this.importObject(id, r.bytes());
        });
        this.setCounter(type, next);
      }, this.order.length);
      return { height, appHash };
    });
  }
}
