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
 *
 * The trees are reported the same way (STATE-PAGING.md section 5): each
 * root lists the dense trees' chunks and the sparse trees' nodes it changed,
 * and the store keeps them beside the objects. dropTrees() lets every tree
 * go at once, dense and sparse together, since one dial is all the guard
 * needs: roots, proofs and key proofs then read the store, the dense chunks
 * through a shared LRU (treeChunks), and give the same answers. The
 * history of past versions stays in memory either way. rebuildTrees() reads
 * them back. A restart can take the trees from the store too (loadTrees)
 * instead of hashing every object and inserting every key again.
 */
import { decode, type Reader } from '../codec/reader.ts';
import { encode, type Writer } from '../codec/writer.ts';
import { bytesEqual, HASH_SIZE } from '../crypto/hash.ts';
import { instanceOf, objectId, typeOf, type ObjectId } from './id.ts';
import { Arena, type ArenaStats } from './arena.ts';
import { deepFreeze } from './freeze.ts';
import { DbError, TypeIndex, type HotBudget, type ObjectFetch, type ObjectType } from './index.ts';
import { MemoryIndexStore, overlaid, until, type IndexEntryChange, type IndexStore } from './indexstore.ts';
import { BPlusTree } from './bptree.ts';
import { ChunkCache, DenseMerkleTree, EMPTY, nodePosition, type PastTree, type StoreChange, type TreeRecords } from './merkle.ts';
import { objectLeaf, typeLeaf, type KeyProof, type ObjectProof } from './proof.ts';
import { nodeString, SparseMerkleTree, type NodeRecord, type PastNodes } from './smt.ts';

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
  /** Start with the Merkle trees (dense chunks and sparse nodes) dropped, read from the store; default resident. */
  trees?: boolean;
  /** How many dense tree chunks (32 KiB at most each) dropped trees keep cached between reads. */
  treeChunks?: number;
  /**
   * Where the application keeps every committed object, by id. With one, the arena can be held within `arenaBytes`
   * (STATE-PAGING.md section 3.4): slabs beyond it are released once the store has what they hold, and their objects
   * are read from the store. Without one the arena holds every object, whatever the limit says.
   */
  objectStore?: ObjectFetch;
  /** The most bytes the arena's slabs may take, with an object store behind it; unbounded by default. */
  arenaBytes?: number;
  /**
   * Where the application keeps each root's history record (Changes.history, as encodeHistory writes it), by
   * version. With one, a past version the window in memory no longer holds is answered from the records instead
   * (STATE-PAGING.md section 7.3): trimming the window, or opening a store without reading it back, then costs a
   * past-version read its speed and not its answer.
   */
  historyStore?: HistoryFetch;
}

/** The encoded history record of a version, or undefined if the store has none. */
export type HistoryFetch = (version: number) => Uint8Array | undefined;

/** Where `indexTrees` and `trees` default from; the test setup turns them off to run every suite on the fallbacks (INDEX_TREES=0, TREES=0). */
let defaultIndexTrees = true;
let defaultTrees = true;
export function setDefaultIndexTrees(resident: boolean): void {
  defaultIndexTrees = resident;
}
export function setDefaultTrees(resident: boolean): void {
  defaultTrees = resident;
}

/** What the database holds in memory besides the trees and indices, for the memory guard and status. */
export interface DatabaseMemory {
  arena: ArenaStats;
  /** The most the arena's slabs may take (Infinity: no limit), and how many committed objects have their bytes only in the store. */
  arenaLimit: number;
  storedObjects: number;
  /** The decoded objects: every one kept (resident), or a bounded cache over the arena (capped). */
  objects: 'resident' | 'capped';
  hotObjects: number;
  hotLimit: number;
  /** Bytes of past values kept for the retention window. */
  historyBytes: number;
  /** The window of past versions: all the database was made to retain (resident), or fewer while memory is short (trimmed). */
  history: 'resident' | 'trimmed';
  /** How many past versions are kept just now, and the oldest version that can be asked for. */
  historyWindow: number;
  lowestVersion: number;
  /** The secondary indices' B+ trees: all resident, all dropped (reads go to the store), or some of each. */
  indexTrees: 'resident' | 'dropped' | 'partial';
  /** The Merkle trees, dense and sparse: resident, or dropped with every node read from the store. */
  trees: 'resident' | 'dropped';
  /** Dense tree chunks cached for dropped trees, and how many may be. */
  treeChunks: number;
  treeChunkLimit: number;
  /** Reads the decoded-object cache answered and reads that decoded, and the same for the chunk cache: the hit rates. */
  hotHits: number;
  hotMisses: number;
  chunkHits: number;
  chunkMisses: number;
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
  /**
   * Before this version the sparse tree node under this store key was this encoding, or absent. Null when the
   * root kept no list (a database with no store and its trees resident) and in records written before there was one.
   */
  nodes: NodeRecord[] | null;
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
  /**
   * Dense tree chunks and sparse tree nodes written (value) or deleted (null), as store keys, in no particular
   * order (no key appears twice). The values may be views of live chunks: write them before the next root, then
   * call dropChanges(). Empty for a database with no store and its trees resident.
   */
  trees: StoreChange[];
}

export function encodeHistory(w: Writer, h: HistoryRecord): void {
  w.array(h.trees, (w, t) => {
    w.u16(t.tree).option(t.records.sizeBefore, (w, n) => w.u64(BigInt(n)));
    w.array(t.records.nodes, (w, [k, j, hash]) => w.u8(k).u64(BigInt(j)).fixed(hash));
  });
  w.array(h.objects, (w, [id, bytes]) => w.u64(id).option(bytes, (w, b) => w.bytes(b)));
  w.array(h.counters, (w, [type, n]) => w.u16(type).u64(BigInt(n)));
  w.option(h.nodes, (w, nodes) => w.array(nodes, (w, [key, before]) => w.bytes(key).option(before, (w, b) => w.bytes(b))));
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
    // A record written before the sparse nodes were kept ends here.
    nodes: r.remaining() === 0 ? null : r.option((r) => r.array((r) => [r.bytes(), r.option((r) => r.bytes())] as NodeRecord)),
  };
}

/** What a read of a past version needs from the store's records: the entries it will look at, and no others. */
interface Wanted {
  objects: Set<ObjectId>;
  counters: Set<number>;
  /** By tree (a type id, or TOP_TREE), node positions. */
  trees: Map<number, Set<number>>;
  /** Sparse tree nodes, by nodeString of their store keys. */
  nodes: Set<string>;
}

/** What the records say of them: for each one a version after the one asked about changed, what it was before the first such change. */
interface Past {
  objects: Map<ObjectId, Uint8Array | null>;
  counters: Map<number, number>;
  trees: Map<number, PastTree>;
  nodes: PastNodes;
}

/** Bytes of one tree node in a history record: level u8, index u64, hash. */
const NODE_RECORD = 9 + HASH_SIZE;

/**
 * Take from one encoded history record what `want` names and `past` does not have yet. Records are scanned in
 * ascending version order, so what is found first is what was true at the version asked about. The record is
 * walked where it lies, by the layout encodeHistory gives it, and only the entries wanted are copied out: a record
 * is some hundreds of kilobytes, a read wants a few dozen entries of it, and decoding it whole for each would cost
 * the memory the trimmed window was to save. Returns false if sparse nodes are wanted and the record has no list of them.
 */
function scanHistory(b: Uint8Array, want: Wanted, past: Past): boolean {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  const u32 = () => ((p += 4), view.getUint32(p - 4));
  const u64 = () => ((p += 8), view.getUint32(p - 8) * 2 ** 32 + view.getUint32(p - 4));
  const bytes = () => {
    const n = u32();
    return b.subarray(p, (p += n));
  };
  for (let trees = u32(); trees > 0; trees--) {
    const tree = view.getUint16(p);
    p += 2;
    const sizeBefore = b[p++] === 1 ? u64() : null;
    const count = u32();
    const wanted = want.trees.get(tree);
    if (wanted) {
      const found = past.trees.get(tree)!;
      if (found.size === null) found.size = sizeBefore;
      for (let i = 0, q = p; i < count; i++, q += NODE_RECORD) {
        const position = nodePosition(b[q]!, view.getUint32(q + 1) * 2 ** 32 + view.getUint32(q + 5));
        if (wanted.has(position) && !found.nodes.has(position)) found.nodes.set(position, b.slice(q + 9, q + NODE_RECORD));
      }
    }
    p += count * NODE_RECORD;
  }
  for (let objects = u32(); objects > 0; objects--) {
    const id = view.getBigUint64(p);
    p += 8;
    const before = b[p++] === 1 ? bytes() : null;
    if (want.objects.has(id) && !past.objects.has(id)) past.objects.set(id, before && before.slice());
  }
  for (let counters = u32(); counters > 0; counters--) {
    const type = view.getUint16(p);
    p += 2;
    const count = u64();
    if (want.counters.has(type) && !past.counters.has(type)) past.counters.set(type, count);
  }
  if (want.nodes.size === 0) return true;
  if (p === b.length || b[p++] !== 1) return false;
  for (let nodes = u32(); nodes > 0; nodes--) {
    const key = nodeString(bytes());
    const before = b[p++] === 1 ? bytes() : null;
    if (want.nodes.has(key) && !past.nodes.has(key)) past.nodes.set(key, before && before.slice());
  }
  return true;
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
/**
 * Chunks a dropped tree set keeps cached: at most 128 MiB of buffers, outside the heap the memory guard watches. A
 * root over a state scattered across more chunks than the cache holds reads the rest from the store at every block:
 * with 256 chunks a block of 500 transfers among 514,000 accounts, whose trees have 1,100 chunks, took 271 ms to
 * finalize against 60 to 69 with all of them cached and 45 to 73 resident. So trees of up to about two million
 * leaves in all are cached whole while dropped, and beyond that the cache is what bounds them.
 */
const DEFAULT_TREE_CHUNKS = 4096;
/**
 * Heap a resident index entry takes (its slot in a B+ tree and its key), and a sparse tree leaf with its share of
 * inner nodes: what dropping them gave back at 192,000 accounts (STATE-PAGING.md section 7), for estimates only.
 */
const INDEX_ENTRY_HEAP = 210;
const SPARSE_LEAF_HEAP = 1000;
/**
 * What rebuilding a sparse tree allocates besides what it keeps: per current leaf, the two nodes or so it reads from
 * the store and the keys it reads them by, about 1,000 bytes that the collector takes back afterwards; and per
 * record of a retained version, the node built for that version with its reads, about 500 bytes (a fifth of it
 * kept). Measured as the heap allocated by a rebuild before a collection, at 50,000 leaves and at 1,000 leaves with
 * thirty versions of churn behind them. The guard compares the estimate with the heap's headroom, and what a rebuild
 * of this size allocates and drops is promoted to the old generation before a collection takes it back, so the
 * estimate counts what is allocated, not only what stays.
 */
const SPARSE_LEAF_GARBAGE = 1000;
const SPARSE_HISTORY_NODE_HEAP = 500;
/**
 * Heap one past value takes besides its bytes (its entry, its slot in two maps), and one dense tree record (the
 * entry, the 32-byte hash it copies, its slots): rough figures, for the estimate of what the window holds.
 */
const VALUE_HISTORY_HEAP = 150;
const DENSE_HISTORY_HEAP = 250;
/** Unbounded: with memory to spare every decoded object stays, and the node runs as it did before the arena. The memory guard caps it. */
const DEFAULT_HOT = Infinity;

/**
 * About how many bytes of heap the two droppable tiers take resident, for a set of types and how many objects each
 * holds (a counter is a fair upper bound): the same figures rebuildEstimate() uses, for deciding before a store is
 * opened whether its tiers fit the heap.
 */
export function estimateTiers(types: ObjectType<any>[], countOf: (type: number) => number): { indexTrees: number; trees: number } {
  let entries = 0;
  let leaves = 0;
  for (const t of types) {
    const n = countOf(t.id);
    entries += n * t.indices.length;
    leaves += n * t.indices.filter((ix) => ix.authenticated).length;
  }
  return { indexTrees: entries * INDEX_ENTRY_HEAP, trees: leaves * (SPARSE_LEAF_HEAP + SPARSE_LEAF_GARBAGE) };
}

export class ObjectDatabase {
  private readonly types = new Map<number, TypeIndex<AnyObject>>();
  /** Type ids in ascending order; a type's position here is its leaf in the top tree. */
  private readonly order: number[];
  private readonly trees = new Map<number, DenseMerkleTree>();
  private readonly top: DenseMerkleTree;
  private readonly sessions: UndoSession[] = [];
  private readonly dirty = new Set<ObjectId>();
  /** How many past versions are recorded for the store, and how many of them are kept in memory just now (setHistoryWindow). */
  private readonly retain: number;
  private window: number;
  private version = -1;
  /** The oldest version this database can describe: where it was built, lowered as history is loaded, raised when the window is trimmed. */
  private floor = 0;
  /** The application's store of history records, or null, and the oldest version its records describe. */
  private readonly historyStore: HistoryFetch | null;
  private storedFloor = 0;
  /** The versions inside the full window that have a history record, ascending: each root after the first, and what the store was opened with. */
  private recorded: number[] = [];
  /** The sparse tree nodes of the records given back (loadHistory), by version, until restoreIndexVersions uses them; null once a record had none. */
  private loadedNodes: Map<number, NodeRecord[]> | null = new Map();
  /** How many past values `valueHistory` holds. */
  private historyValues = 0;
  /** For every object written since the last root(): its value at that root. */
  private readonly shadow = new Map<ObjectId, AnyObject | null>();
  private readonly counterShadow = new Map<number, number>();
  /** Before version v, the object was these bytes (null: did not exist). Bytes, not records: the window costs what it stores. */
  private readonly valueHistory = new Map<ObjectId, { v: number; bytes: Uint8Array | null }[]>();
  private historyBytes = 0;
  /** The committed encodings of every object, and the budget the types' hot caches share. */
  private readonly arena: Arena;
  private readonly hotBudget: HotBudget;
  /** The application's store of committed objects, or null: with one, the arena is kept within arenaLimit. */
  private readonly objectStore: ObjectFetch | null;
  private arenaLimit: number;
  /** The store holds every committed object: true from dropChanges() until the next root. */
  private objectsStored = false;
  /** Bytes an import has put into the arena, to stop at the limit. */
  private importedBytes = 0;
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
  /** Chunks dropped dense trees have read, shared by all of them. */
  private readonly chunkCache: ChunkCache;
  /** Without an application store: the trees' chunks and nodes in memory, kept only while the trees are dropped. */
  private ownTreeStore: MemoryIndexStore | null = null;
  /** What dropped trees read: the store as of the last root, with the roots not yet written on top. */
  private readonly treeBase: IndexStore;
  private treesResident: boolean;
  /** The store already holds the trees as of the version the first root computes (a restart): that root reports none. */
  private treesStored = false;
  /** The trees were read from the store (loadTrees), not computed from the objects. */
  private treesLoaded = false;

  constructor(types: ObjectType<any>[], opts: DatabaseOptions = {}) {
    this.retain = Math.max(0, opts.retainVersions ?? DEFAULT_RETAIN);
    this.window = this.retain;
    this.hotBudget = { limit: Math.max(0, opts.hotObjects ?? DEFAULT_HOT), size: 0, hits: 0, misses: 0 };
    this.arena = new Arena({
      refOf: (type, instance) => this.types.get(type)?.refAt(instance) ?? -1,
      relocate: (type, instance, ref) => this.types.get(type)!.relocate(instance, ref),
      released: (type, instance) => this.types.get(type)!.released(instance),
    });
    this.objectStore = opts.objectStore ?? null;
    this.historyStore = opts.historyStore ?? null;
    this.arenaLimit = Math.max(0, opts.arenaBytes ?? Infinity);
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
    this.chunkCache = new ChunkCache(opts.treeChunks ?? DEFAULT_TREE_CHUNKS);
    this.treeBase = {
      get: (k) => {
        const v = this.unwrittenEntries()?.get(k);
        return v !== undefined ? (v ?? undefined) : (this.store ?? this.ownTreeStore)?.get(k);
      },
      range: (start, end) => {
        const stored = (this.store ?? this.ownTreeStore)?.range(start, end) ?? [][Symbol.iterator]();
        const pending = this.unwrittenEntries();
        return pending ? overlaid(stored, until(pending.entriesFrom(start), end)) : stored;
      },
    };
    for (const t of types) {
      if (this.types.has(t.id)) throw new Error(`duplicate object type ${t.id}`);
      if (t.id === TOP_TREE) throw new Error(`type id ${TOP_TREE} names the tree over the types`);
      this.types.set(t.id, new TypeIndex(t, this.retain, this.arena, this.hotBudget, this.base, resident, this.objectStore));
      this.trees.set(t.id, new DenseMerkleTree(this.retain, t.id));
    }
    this.order = [...this.types.keys()].sort((a, b) => a - b);
    this.top = new DenseMerkleTree(this.retain, TOP_TREE);
    this.top.resize(this.order.length);
    this.treesResident = true;
    if (!(opts.trees ?? defaultTrees)) this.dropTrees();
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

  /**
   * The oldest version proofs can still be made for: the oldest in the window in memory, or, with a store of
   * history records, the oldest the records reach, which trimming the window does not change.
   */
  get lowestVersion(): number {
    if (!this.historyStore) return this.windowStart;
    return Math.min(this.windowStart, Math.max(this.storedFloor, this.version - this.retain));
  }

  /** The oldest version the window in memory describes. */
  private get windowStart(): number {
    return Math.max(this.floor, this.version - this.window);
  }

  // ---- the history window ----

  /**
   * Keep only the last `versions` past versions in memory from now on, never more than the database was made to
   * retain (STATE-PAGING.md section 7). Lowering it forgets the older ones at once, in the value history and in
   * every tree, and they stay forgotten: raising it again lets the window grow back one root at a time. Nothing a
   * block does reads a past version, so only proofs and queries at past heights notice. Every root still reports
   * its history record in full, so the store keeps the whole window and a restart has it back; and with a history
   * store, a version the window has forgotten is read from those records (past(), below), slower and no less right.
   */
  setHistoryWindow(versions: number): void {
    this.window = Math.max(0, Math.min(this.retain, versions));
    for (const tree of this.denseTrees()) tree.setWindow(this.window);
    for (const smt of this.sparseTrees()) smt.setWindow(this.window);
    if (this.version < 0) return;
    const min = this.version - this.window;
    if (min > this.floor) this.floor = min;
    this.pruneHistory(min);
  }

  get historyWindow(): number {
    return this.window;
  }

  /**
   * The store holds the history record of `version`, which this database was not given (loadHistory): a store
   * opened without reading its window back. The records are taken to be there for every version from it to the current one.
   */
  noteStoredHistory(version: number): void {
    if (version - 1 < this.storedFloor) this.storedFloor = Math.max(0, version - 1);
    let i = this.recorded.length;
    while (i > 0 && this.recorded[i - 1]! > version) i--;
    if (this.recorded[i - 1] !== version) this.recorded.splice(i, 0, version);
  }

  /**
   * What the store's records say of `want` as of a version older than the window in memory, or null for a version
   * the window holds. Each record says what its version overwrote, so the records of every version after the one
   * asked about are scanned, oldest first, and the first to name an entry has its value then; an entry none of them
   * names has not changed since and is read as it is now. The last root's record may not be in the store yet: it
   * is taken from the change list the application is still to write. A record the store should hold and does not
   * is a refusal: without it an entry it named would be read as it is now, a wrong answer with nothing to show for it.
   */
  private past(version: number, want: Partial<Wanted>): Past | null {
    if (!this.historyStore || version >= this.windowStart) return null;
    const wanted: Wanted = { objects: want.objects ?? new Set(), counters: want.counters ?? new Set(), trees: want.trees ?? new Map(), nodes: want.nodes ?? new Set() };
    const past: Past = { objects: new Map(), counters: new Map(), trees: new Map(), nodes: new Map() };
    // Every tree asked about is answered for, also one no record names: nothing has changed it since.
    for (const tree of wanted.trees.keys()) past.trees.set(tree, { size: null, nodes: new Map() });
    for (const v of this.recorded) {
      if (v <= version) continue;
      const unwritten = this.changes?.version === v ? this.changes.history : null;
      const record = unwritten ? encode((w) => encodeHistory(w, unwritten)) : this.historyStore(v);
      if (!record) throw new RangeError(`version ${version} is not available: the store has no history record of version ${v}`);
      if (!scanHistory(record, wanted, past)) throw new RangeError(`version ${version} is not available: the record of version ${v} was written without the sparse tree nodes`);
    }
    return past;
  }

  /** The entries of the dense trees a proof through a type's tree (to one instance of it, if given) and the top tree reads. */
  private wantedTrees(type: number, instance?: number): Map<number, Set<number>> {
    return new Map([
      [type, new Set(this.trees.get(type)!.pastPositions(instance))],
      [TOP_TREE, new Set(this.top.pastPositions(this.order.indexOf(type)))],
    ]);
  }

  /** The root nodes of a type's authenticated indices, and with an index and a key, the nodes down the key's path in it. */
  private wantedNodes(ti: TypeIndex<AnyObject>, index?: string, key?: Uint8Array): Set<string> {
    const out = new Set<string>();
    for (const name of ti.authenticated) for (const k of ti.trees.get(name)!.pastKeys(name === index ? key : undefined)) out.add(nodeString(k));
    return out;
  }

  /** The newest version whose history record a store need no longer keep: the one that left the full window, trimmed or not. */
  get lastStaleVersion(): number {
    return this.version - this.retain;
  }

  /**
   * About how many bytes of heap the window of past versions holds: the past values, the dense trees' records, and
   * for the sparse trees the records kept while they are dropped or, resident, the nodes their retained commits
   * replaced. What trimming the window gives back, and what letting it grow again will take.
   */
  historyEstimate(): number {
    let dense = 0;
    for (const tree of this.denseTrees()) dense += tree.historyEntries;
    let sparse = 0;
    for (const smt of this.sparseTrees()) sparse += smt.historyNodes;
    return this.historyBytes + this.historyValues * VALUE_HISTORY_HEAP + dense * DENSE_HISTORY_HEAP + sparse * SPARSE_HISTORY_NODE_HEAP;
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
    for (const tree of this.denseTrees()) tree.release();
    // And that it holds every committed object, so the arena may let go of what is over its limit.
    this.objectsStored = this.version >= 0;
    this.shrinkArena();
  }

  // ---- the object tier ----

  private shrinkArena(): void {
    if (this.objectStore && this.objectsStored && this.arenaLimit !== Infinity) this.arena.shrink(this.arenaLimit);
  }

  /**
   * Hold the arena within this many bytes from now on (Infinity: no limit). It takes effect at once if the store
   * holds every committed object, and otherwise when the application has written the last root (dropChanges). The
   * current slab always stays, so the arena never goes below it. Ignored without an object store.
   */
  setArenaLimit(bytes: number): void {
    this.arenaLimit = Math.max(0, bytes);
    this.shrinkArena();
  }

  /** The tree over the types, then every type's tree. */
  private denseTrees(): DenseMerkleTree[] {
    return [this.top, ...this.order.map((t) => this.trees.get(t)!)];
  }

  private sparseTrees(): SparseMerkleTree[] {
    return this.order.flatMap((t) => [...this.typeIndexById(t).trees.values()]);
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
   * trees, and the B+ trees where resident, from the store's entries instead of decoding every object. With `check`
   * (the default), the entries must then be exactly the ones the objects make: no entry missing, none extra and none
   * naming another object. Nothing in the app hash covers an unauthenticated index, so without this a damaged entry
   * would quietly send a lookup, and the writes that follow it, to the wrong object. It decodes every object of a
   * type with indices, once, keeping none.
   */
  loadIndexEntries(check = true): void {
    if (!this.store || this.importsIndexed !== true || this.version >= 0) throw new DbError('index entries are loaded from the store only after an indexed import');
    // The sparse trees come from the entries unless their nodes are already in place: loaded, or in the store a
    // dropped tree reads.
    const sparse = this.treesResident ? !this.treesLoaded : !this.treesStored;
    for (const ti of this.types.values()) ti.loadIndexEntries(sparse);
    if (check) for (const ti of this.types.values()) ti.checkEntries();
  }

  // ---- the tree tier ----

  /**
   * Drop every Merkle tree, the dense chunks and the sparse nodes together: from now on a root reads the paths it
   * changes from the store (dense chunks through the shared LRU) and writes the changed ones back through the change
   * list, and proofs walk the store. Sessions may be open: the trees hold nothing of them but the sparse trees'
   * writes, which become pending writes. Without an application store the trees go to a store in memory.
   */
  dropTrees(): void {
    if (!this.treesResident) return;
    if (!this.store) {
      // What a store written at every root would hold now: the trees as of the last root (nothing before the first).
      const own = new MemoryIndexStore();
      if (this.version >= 0) own.apply(Array.from(this.treeEntries(), ([key, value]) => ({ key, value })));
      this.ownTreeStore = own;
    }
    for (const tree of this.denseTrees()) tree.drop(this.treeBase, this.chunkCache);
    for (const smt of this.sparseTrees()) smt.drop(this.treeBase);
    this.treesResident = false;
  }

  /** Read every dropped tree back from the store and keep it resident again. */
  rebuildTrees(): void {
    if (this.treesResident) return;
    for (const tree of this.denseTrees()) tree.rebuild();
    for (const smt of this.sparseTrees()) smt.rebuild();
    this.chunkCache.clear();
    this.ownTreeStore = null;
    this.treesResident = true;
  }

  /** Whether the Merkle trees are resident. */
  get treesAreResident(): boolean {
    return this.treesResident;
  }

  /**
   * About how many bytes of heap rebuilding what is dropped would take, per tier (0 for a resident one): every
   * committed object has one entry in each of its type's indices and one leaf in each authenticated index's sparse
   * tree, and a sparse tree also builds a node for each record its retained versions hold, the subtrees they share
   * with a newer version built once; the reads and keys a rebuild throws away count too (SPARSE_LEAF_GARBAGE). The
   * memory guard rebuilds only what fits.
   */
  rebuildEstimate(): { indexTrees: number; trees: number } {
    let entries = 0;
    let leaves = 0;
    let dropped = false;
    for (const ti of this.types.values()) {
      if (!ti.resident) {
        dropped = true;
        entries += ti.committedCount * ti.type.indices.length;
      }
      leaves += ti.committedCount * ti.authenticated.length;
    }
    let history = 0;
    if (!this.treesResident) for (const smt of this.sparseTrees()) history += smt.historyNodes;
    const trees = leaves * (SPARSE_LEAF_HEAP + SPARSE_LEAF_GARBAGE) + history * SPARSE_HISTORY_NODE_HEAP;
    // A dropped tier never reads zero, however empty, so that zero means nothing is dropped.
    return { indexTrees: dropped ? Math.max(1, entries * INDEX_ENTRY_HEAP) : 0, trees: this.treesResident ? 0 : Math.max(1, trees) };
  }

  /** Every dense chunk and sparse node as of the last root, as store keys and values: what a store written from scratch holds. */
  *treeEntries(): IterableIterator<[Uint8Array, Uint8Array]> {
    for (const tree of this.denseTrees()) yield* tree.entries();
    for (const smt of this.sparseTrees()) yield* smt.entries();
  }

  /**
   * After importing objects whose trees the store holds as of the version about to be rooted (a restart): take the
   * trees from the store instead of computing them, so the first root hashes no object and inserts no key, and
   * reports nothing. With `checkLeaves`, what is taken is checked first, resident or dropped: every dense node above
   * a leaf must be the hash of its children and every sparse node must hash to what its parent says, so the root the
   * caller compares with the app hash commits to every leaf; every imported object must hash to its leaf; and each
   * type's tree must have no more non-empty leaves than objects, so no leaf has lost its object.
   */
  loadTrees(checkLeaves = false): void {
    if (!this.store || this.importsIndexed !== true || this.version >= 0) throw new DbError('trees are loaded from the store only after an indexed import');
    if (this.treesResident) {
      for (const tree of this.denseTrees()) tree.load(this.treeBase);
      for (const smt of this.sparseTrees()) smt.load(this.treeBase, checkLeaves);
    }
    if (checkLeaves) {
      for (const type of this.order) this.trees.get(type)!.resize(this.typeIndexById(type).nextInstance);
      this.top.verify();
      for (const type of this.order) {
        const ti = this.typeIndexById(type);
        const leaves = this.trees.get(type)!.verify();
        if (leaves !== ti.committedCount) throw new DbError(`${ti.type.name}: the stored tree has ${leaves} leaves for ${ti.committedCount} objects`);
      }
      if (!this.treesResident) for (const smt of this.sparseTrees()) smt.verifyStored();
      for (const id of this.dirty) {
        const ti = this.typeIndexById(typeOf(id));
        const bytes = ti.bytesOf(instanceOf(id));
        if (bytes && !bytesEqual(objectLeaf(id, bytes), this.trees.get(typeOf(id))!.node(0, instanceOf(id)))) throw new DbError(`object ${id} does not hash to its leaf in the stored tree`);
      }
    }
    this.dirty.clear();
    this.treesStored = true;
    this.treesLoaded = true;
  }

  /** The store holds the trees as of the version the first root computes, which computes them again anyway (a restart): report none. */
  assumeStoredTrees(): void {
    if (!this.store || this.version >= 0) throw new DbError('only a database about to take its first root over a store can assume its trees are stored');
    this.treesStored = true;
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
    return {
      arena: this.arena.stats,
      arenaLimit: this.objectStore ? this.arenaLimit : Infinity,
      storedObjects: [...this.types.values()].reduce((n, ti) => n + ti.storedCount, 0),
      objects: this.hotBudget.limit === Infinity ? 'resident' : 'capped',
      hotObjects: this.hotBudget.size,
      hotLimit: this.hotBudget.limit,
      historyBytes: this.historyBytes,
      history: this.window === this.retain ? 'resident' : 'trimmed',
      historyWindow: this.window,
      lowestVersion: this.version < 0 ? 0 : this.lowestVersion,
      indexTrees,
      trees: this.treesResident ? 'resident' : 'dropped',
      treeChunks: this.chunkCache.size,
      treeChunkLimit: this.chunkCache.limit,
      hotHits: this.hotBudget.hits,
      hotMisses: this.hotBudget.misses,
      chunkHits: this.chunkCache.hits,
      chunkMisses: this.chunkCache.misses,
    };
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
    const before = this.past(version, { objects: new Set([id]) })?.objects.get(id);
    if (before !== undefined) return before ? deepFreeze(decode(before, (r) => type.decode(r, id))) : null;
    const entries = this.valueHistory.get(id);
    if (entries) for (const e of entries) if (e.v > version) return e.bytes ? deepFreeze(decode(e.bytes, (r) => type.decode(r, id))) : null;
    return this.getCommitted(type, id);
  }

  /** The encoding of an object as of a past version inside the window, without decoding it: for snapshots and proofs. */
  bytesAt(id: ObjectId, version: number): Uint8Array | null {
    this.checkVersion(version);
    return this.bytesIn(this.past(version, { objects: new Set([id]) }), id, version);
  }

  /** As bytesAt, with what the store's records say if the version is older than the window. */
  private bytesIn(past: Past | null, id: ObjectId, version: number): Uint8Array | null {
    const before = past?.objects.get(id);
    if (before !== undefined) return before;
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
    return this.countIn(this.past(version, { counters: new Set([type]) }), type, version);
  }

  private countIn(past: Past | null, type: number, version: number): number {
    const before = past?.counters.get(type);
    if (before !== undefined) return before;
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
    if (this.version < 0) this.floor = this.storedFloor = version;
    this.objectsStored = false;
    const objects: ObjectChange[] = [];
    const touched = new Set<number>();
    if (this.version < 0) for (const t of this.order) touched.add(t);
    const keepHistory = this.retain > 0 && this.version >= 0;
    const historyIds: ObjectId[] = [];
    const record: HistoryRecord = { trees: [], objects: [], counters: [], nodes: [] };
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
          this.historyValues++;
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
    // The trees' changes go to the store whenever there is one, and always while the trees are dropped, the store
    // being where they live; not from the first root of a restart, whose trees the store already has.
    const reportTrees = (this.store !== null && !(first && this.treesStored)) || !this.treesResident;
    const treeChanges: StoreChange[] = [];
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
      tree.reporting = reportTrees;
      const typeRoot = tree.root(version);
      for (const c of tree.takeChunks()) treeChanges.push(c);
      const indexRoots = ti.authenticated.map((name) => {
        const smt = ti.trees.get(name)!;
        const r = smt.commit(version, reportTrees);
        for (const c of smt.takeNodes()) treeChanges.push(c);
        // What the commit overwrote goes into the history record; one tree without a list leaves the record without.
        const overwritten = smt.takeRecords();
        if (overwritten && record.nodes) for (const n of overwritten) record.nodes.push(n);
        else record.nodes = null;
        return r;
      });
      const previous = this.lastIndexRoots.get(type);
      if (!previous || indexRoots.some((r, i) => !bytesEqual(r, previous[i]!))) touched.add(type);
      this.lastIndexRoots.set(type, indexRoots);
      if (touched.has(type)) this.top.setLeaf(this.order.indexOf(type), typeLeaf(type, BigInt(ti.nextInstance), typeRoot, indexRoots));
      const recs = tree.lastRecords;
      if (keepHistory && (recs.nodes.length > 0 || recs.sizeBefore !== null)) record.trees.push({ tree: type, records: recs });
    }
    this.top.reporting = reportTrees;
    const root = this.top.root(version);
    for (const c of this.top.takeChunks()) treeChanges.push(c);
    if (keepHistory && this.top.lastRecords.nodes.length > 0) record.trees.push({ tree: TOP_TREE, records: this.top.lastRecords });
    // As with the index entries: dropped trees must read what this root wrote before the store has it.
    if (this.store) {
      if (treeChanges.length > 0) {
        this.unwritten.push(treeChanges);
        if (this.unwrittenMap) for (const c of treeChanges) this.unwrittenMap.set(c.key, c.value);
      }
    } else this.ownTreeStore?.apply(treeChanges);
    this.version = version;
    this.changes = { version, objects, counters, history: keepHistory ? record : null, indices, trees: treeChanges };
    if (keepHistory) {
      this.recorded.push(version);
      while (this.recorded.length > 0 && this.recorded[0]! <= version - this.retain) this.recorded.shift();
    }
    // What a trimmed window forgot stays forgotten when the window is widened again.
    if (version - this.window > this.floor) this.floor = version - this.window;
    if (this.retain > 0) this.pruneHistory(version - this.window);
    // Slabs the block left more than half dead are compacted now, while the node idles.
    this.arena.maintain();
    return root;
  }

  private pruneHistory(minVersion: number): void {
    for (const [v, ids] of this.valueHistoryByVersion) {
      if (v > minVersion) continue;
      for (const id of ids) {
        const entries = this.valueHistory.get(id);
        if (!entries) continue; // emptied by an earlier version's pass, when several are pruned at once
        while (entries.length > 0 && entries[0]!.v <= minVersion) {
          this.historyBytes -= entries.shift()!.bytes?.length ?? 0;
          this.historyValues--;
        }
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
    this.noteStoredHistory(version);
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
      this.historyValues++;
      this.historyBytes += bytes?.length ?? 0;
      ids.push(id);
    }
    if (ids.length > 0) this.valueHistoryByVersion.set(version, ids);
    for (const [type, count] of rec.counters) {
      let entries = this.counterHistory.get(type);
      if (!entries) this.counterHistory.set(type, (entries = []));
      entries.push({ v: version, count });
    }
    if (rec.nodes) this.loadedNodes?.set(version, rec.nodes);
    else this.loadedNodes = null;
  }

  /**
   * After the history has been loaded: give every authenticated index its past versions again, so key proofs at
   * past heights work. From the records' sparse tree nodes when every record given back had them, each older
   * version built from what the commit after it overwrote and sharing the rest (SparseMerkleTree.loadVersions),
   * which costs the nodes the window's blocks changed; otherwise, or if a record does not hold a node a version
   * needs, by replaying the keys from the object history (rebuildIndexVersions), which costs every key. Returns
   * which was used.
   */
  restoreIndexVersions(): 'records' | 'replay' | 'none' {
    if (this.version < 0 || this.sessions.length > 0) throw new DbError('restoring needs a root and no open session');
    const loaded = this.loadedNodes;
    this.loadedNodes = new Map();
    const lowest = this.lowestVersion;
    if (lowest === this.version) return 'none';
    if (loaded) {
      // Each tree's records, by the first bytes of their store keys (nodeHeader).
      const byTree = new Map<string, Map<number, NodeRecord[]>>();
      for (const [v, nodes] of loaded) {
        for (const n of nodes) {
          const header = nodeString(n[0].subarray(0, 4));
          let versions = byTree.get(header);
          if (!versions) byTree.set(header, (versions = new Map()));
          let list = versions.get(v);
          if (!list) versions.set(v, (list = []));
          list.push(n);
        }
      }
      try {
        for (const ti of this.types.values()) {
          for (const name of ti.authenticated) {
            const tree = ti.trees.get(name)!;
            tree.loadVersions(lowest, byTree.get(nodeString(tree.rootKey.subarray(0, 4))) ?? new Map());
          }
        }
        return 'records';
      } catch {
        // The records do not describe these trees; the replay below replaces every one of them, whatever this left.
      }
    }
    this.rebuildIndexVersions();
    return 'replay';
  }

  /** Inclusion or absence proof for an id as of a version inside the retention window. */
  proofAt(id: ObjectId, version: number): ObjectProof {
    this.checkVersion(version);
    const type = typeOf(id);
    const ti = this.typeIndexById(type);
    const tree = this.trees.get(type)!;
    const instance = instanceOf(id);
    const past = this.past(version, { objects: new Set([id]), counters: new Set([type]), trees: this.wantedTrees(type, instance), nodes: this.wantedNodes(ti) });
    const count = this.countIn(past, type, version);
    const idx = this.order.indexOf(type);
    return {
      height: BigInt(version),
      id,
      value: this.bytesIn(past, id, version)?.slice() ?? null,
      nextInstance: BigInt(count),
      typeRoot: tree.rootAt(version, past?.trees.get(type)),
      typeSiblings: instance < count ? tree.pathAt(instance, version, past?.trees.get(type)) : [],
      indexRoots: ti.authenticated.map((name) => ti.trees.get(name)!.rootAt(version, past?.nodes)),
      typeIndex: idx,
      typeCount: this.order.length,
      topSiblings: this.top.pathAt(idx, version, past?.trees.get(TOP_TREE)),
    };
  }

  /** The contents of a type's leaf as of a version, with its path to the app hash. */
  typeLeafProofAt(type: number, version: number): { nextInstance: bigint; typeRoot: Uint8Array; indexRoots: Uint8Array[]; typeIndex: number; typeCount: number; topSiblings: Uint8Array[] } {
    this.checkVersion(version);
    const ti = this.typeIndexById(type);
    const idx = this.order.indexOf(type);
    const past = this.past(version, { counters: new Set([type]), trees: this.wantedTrees(type), nodes: this.wantedNodes(ti) });
    return {
      nextInstance: BigInt(this.countIn(past, type, version)),
      typeRoot: this.trees.get(type)!.rootAt(version, past?.trees.get(type)),
      indexRoots: ti.authenticated.map((name) => ti.trees.get(name)!.rootAt(version, past?.nodes)),
      typeIndex: idx,
      typeCount: this.order.length,
      topSiblings: this.top.pathAt(idx, version, past?.trees.get(TOP_TREE)),
    };
  }

  /** Siblings that fold instances [from, to) of a type to its root as of a version. */
  rangeProofAt(type: number, from: number, to: number, version: number): Uint8Array[] {
    this.checkVersion(version);
    const tree = this.trees.get(type)!;
    const past = this.past(version, { trees: new Map([[type, new Set(from >= 0 && from < to ? tree.pastRangePositions(from, to) : [])]]) });
    return tree.rangeProofAt(from, to, version, past?.trees.get(type));
  }

  /** The app hash as of a version inside the window. */
  rootAt(version: number): Uint8Array {
    this.checkVersion(version);
    const past = this.past(version, { trees: new Map([[TOP_TREE, new Set(this.top.pastPositions())]]) });
    return this.top.rootAt(version, past?.trees.get(TOP_TREE));
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
    const past = this.past(version, { counters: new Set([type.id]), trees: this.wantedTrees(type.id), nodes: this.wantedNodes(ti, index, key) });
    return {
      height: BigInt(version),
      type: type.id,
      indexPosition: position,
      key,
      proof: ti.trees.get(index)!.proveAt(key, version, past?.nodes),
      nextInstance: BigInt(this.countIn(past, type.id, version)),
      typeRoot: this.trees.get(type.id)!.rootAt(version, past?.trees.get(type.id)),
      indexRoots: ti.authenticated.map((name) => ti.trees.get(name)!.rootAt(version, past?.nodes)),
      typeIndex: idx,
      typeCount: this.order.length,
      topSiblings: this.top.pathAt(idx, version, past?.trees.get(TOP_TREE)),
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
        const rebuilt = ti.freshTree(name);
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
    // An indexed import comes from the store, so what does not fit the arena's limit can stay there.
    if (indexed && this.objectStore && this.importedBytes + bytes.length > this.arenaLimit) ti.importStored(instanceOf(id));
    else if (indexed) {
      ti.importBytes(instanceOf(id), bytes);
      this.importedBytes += bytes.length;
    } else ti.importCommitted(decode(bytes, (r) => ti.type.decode(r, id)), bytes);
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
