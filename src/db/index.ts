/**
 * One type's objects and indices, Graphene's generic_index without Boost.
 *
 * The primary index maps instance i to the object with id (type, i), because
 * ids are dense (id.ts). It is two things (STATE-PAGING.md section 3): the
 * committed encoding of every object in the arena, addressed by a table of
 * references, and a hot cache of decoded objects over it, bounded by a budget
 * the database shares among its types. An object written since the last root
 * lives decoded in the cache, pinned, until root() encodes it once and writes
 * it to the arena; a removal is a tombstone there until then. A read answers
 * from the cache or decodes from the arena, about a microsecond for an
 * account. Eviction is CLOCK, the second-chance approximation of least
 * recently used: a hit sets the instance's touched bit, a fresh decode enters
 * with it clear (so a one-time read is the first to go, and a scan of the
 * state does not wash out what a block works on), and when the budget is
 * spent a hand sweeps the type's instances, clearing bits it finds set and
 * evicting the first clean entry it finds clear. A hit costs one byte store;
 * an eviction costs a few map lookups; nothing is ever sorted.
 *
 * Every secondary index is a key encoder (keys.ts) plus an ordered byte map
 * (bptree.ts). A unique index maps key to id. A non-unique index appends the
 * id to the key, which makes every entry distinct while keeping all entries
 * for one prefix adjacent, so a range query is a prefix scan.
 *
 * The B+ trees are accelerators over the index entries the store holds
 * (indexstore.ts, STATE-PAGING.md section 4) and can be dropped. While they
 * are, a type answers from the store as of the last root, with an overlay on
 * top: per key, what the writes since that root made of it, an id or null
 * for a key they released. Every write that would have set or deleted a tree
 * key sets the overlay instead, undo included, so the overlay is always the
 * difference between the last root and now, and a lookup is one overlay probe
 * and at most one store read. When the trees are dropped in the middle of a
 * block the overlay is built from what is dirty: every committed key of a
 * dirty object released, then every current key of one taken, in that order,
 * so a key passed from one object to another ends with its new owner. A root
 * empties the overlay, since the store (with the root's changes) then says
 * the same.
 *
 * An index marked `authenticated` (unique only) also keeps a sparse Merkle
 * tree (smt.ts) over its keys, whose root goes into the type's leaf in the
 * state root, so a key can be proven present or absent. Those trees are
 * tier three and stay resident whatever happens to the B+ trees.
 */
import { decode, type Reader } from '../codec/reader.ts';
import type { Writer } from '../codec/writer.ts';
import { bytesEqual } from '../crypto/hash.ts';
import { instanceOf, objectId, type ObjectId } from './id.ts';
import { KeyWriter } from './keys.ts';
import { encode } from '../codec/writer.ts';
import type { Arena } from './arena.ts';
import { BPlusTree } from './bptree.ts';
import { deepFreeze } from './freeze.ts';
import { afterPrefix, EMPTY_VALUE, entryKey, INDEX_HEADER, indexHeader, overlaid, until, type IndexEntryChange, type IndexStore } from './indexstore.ts';
import { SparseMerkleTree } from './smt.ts';

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbError';
  }
}

export interface IndexDef<T> {
  name: string;
  unique: boolean;
  /** Keep a Merkle root over the keys, so membership and absence can be proven. Unique indices only. */
  authenticated?: boolean;
  key(obj: T, k: KeyWriter): void;
}

export interface ObjectType<T extends { id: ObjectId }> {
  /** 1..65535. Fixed forever: it is in every id and every leaf hash. */
  id: number;
  name: string;
  /** Canonical encoding, hashed into the state root. The id is not written; its position implies it. */
  encode(w: Writer, obj: T): void;
  decode(r: Reader, id: ObjectId): T;
  indices: IndexDef<T>[];
}

/** The largest instance a JavaScript array can index; ids allow 48 bits, the primary index does not. */
export const MAX_INSTANCE = 2 ** 32 - 2;

/** How many decoded objects the hot caches of all types may hold together. */
export interface HotBudget {
  limit: number;
  size: number;
}

/** One secondary index: its definition, where its entries live in the store, and its tree or, while that is dropped, its overlay. */
interface Secondary<T> {
  def: IndexDef<T>;
  /** 'i', type, position: the first bytes of every store key of this index. */
  header: Uint8Array;
  tree: BPlusTree<ObjectId> | null;
  /** While the tree is dropped: per key, what the writes since the last root made of it (null: released). */
  overlay: BPlusTree<ObjectId | null> | null;
}

/**
 * The id a unique entry stores: eight bytes, big-endian, as the sparse trees also hash it. Written byte by byte:
 * a small typed array lives on the heap until something asks for its buffer, and a DataView would ask.
 */
export function idBytes(id: ObjectId): Uint8Array {
  const b = new Uint8Array(8);
  const hi = Number(id >> 32n);
  const lo = Number(id & 0xffffffffn);
  b[0] = hi >>> 24;
  b[1] = hi >>> 16;
  b[2] = hi >>> 8;
  b[3] = hi;
  b[4] = lo >>> 24;
  b[5] = lo >>> 16;
  b[6] = lo >>> 8;
  b[7] = lo;
  return b;
}

function u64At(b: Uint8Array, o: number): ObjectId {
  const hi = ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  const lo = ((b[o + 4]! << 24) | (b[o + 5]! << 16) | (b[o + 6]! << 8) | b[o + 7]!) >>> 0;
  return (BigInt(hi) << 32n) | BigInt(lo);
}

/** Index keys of an object written since the last root: as committed (null: it did not exist) and as it stands (null: removed). */
interface DirtyKeys {
  committed: Uint8Array[] | null;
  current: Uint8Array[] | null;
}

export class TypeIndex<T extends { id: ObjectId }> {
  readonly type: ObjectType<T>;
  nextInstance = 0;
  /** Sparse trees of the authenticated indices, by name. */
  readonly trees = new Map<string, SparseMerkleTree>();
  /** Names of the authenticated indices, in definition order. */
  readonly authenticated: string[] = [];
  private readonly arena: Arena;
  private readonly budget: HotBudget;
  /** The store's index entries as of the last root, which a dropped index falls back on. */
  private readonly base: IndexStore;
  /** Secondary indices in definition order (an index's position is its place here), and by name. */
  private readonly secondary: Secondary<T>[] = [];
  private readonly byName = new Map<string, Secondary<T>>();
  /** Arena reference of each committed instance (-1 when absent) and its encoding's length. */
  private refs = new Float64Array(0);
  private lens = new Uint32Array(0);
  /** Decoded objects by instance; null is a tombstone for a removal the arena has not seen. */
  private readonly hot = new Map<number, T | null>();
  /** CLOCK's second-chance bit per instance, and where its hand is. */
  private touched = new Uint8Array(0);
  private hand = 0;
  /** Instances written since the last root: never evicted. */
  private readonly pinned = new Set<number>();
  /** Set when an eviction pass found nothing clean left to drop; cleared at the next root, which unpins. */
  private saturated = false;
  /**
   * For every pinned instance, its keys at the last root and now. A write computes both anyway (to unindex the old
   * value and index the new one); kept, they make a root's index changes a comparison instead of a re-encoding.
   */
  private readonly dirtyKeys = new Map<number, DirtyKeys>();

  constructor(type: ObjectType<T>, retainVersions: number, arena: Arena, budget: HotBudget, base: IndexStore, resident = true) {
    this.type = type;
    this.arena = arena;
    this.budget = budget;
    this.base = base;
    if (type.indices.length > 256) throw new Error(`${type.name}: more than 256 indices`);
    type.indices.forEach((ix, position) => {
      if (this.byName.has(ix.name)) throw new Error(`${type.name}: duplicate index ${ix.name}`);
      const s: Secondary<T> = { def: ix, header: indexHeader(type.id, position), tree: resident ? new BPlusTree() : null, overlay: resident ? null : new BPlusTree() };
      this.secondary.push(s);
      this.byName.set(ix.name, s);
      if (ix.authenticated) {
        if (!ix.unique) throw new Error(`${type.name}.${ix.name}: only unique indices can be authenticated`);
        this.trees.set(ix.name, new SparseMerkleTree(retainVersions));
        this.authenticated.push(ix.name);
      }
    });
  }

  /** Replace an authenticated index's tree, after a rebuild with history. */
  replaceTree(name: string, tree: SparseMerkleTree): void {
    this.trees.set(name, tree);
  }

  private ensure(instance: number): void {
    if (instance < this.refs.length) return;
    const size = Math.max(instance + 1, this.refs.length * 2, 16);
    const refs = new Float64Array(size).fill(-1);
    refs.set(this.refs);
    this.refs = refs;
    const lens = new Uint32Array(size);
    lens.set(this.lens);
    this.lens = lens;
    const touched = new Uint8Array(size);
    touched.set(this.touched);
    this.touched = touched;
  }

  /** The arena reference of an instance's committed encoding, or -1. */
  refAt(instance: number): number {
    return instance < this.refs.length ? this.refs[instance]! : -1;
  }

  /** Compaction moved an entry. */
  relocate(instance: number, ref: number): void {
    this.refs[instance] = ref;
  }

  private cache(instance: number, value: T | null): void {
    this.ensure(instance);
    if (!this.hot.has(instance)) this.budget.size++;
    this.hot.set(instance, value);
    this.touched[instance] = 0;
    if (!this.saturated) this.evict();
  }

  private uncache(instance: number): void {
    if (this.hot.delete(instance)) this.budget.size--;
  }

  /**
   * Over budget: sweep this type's instances with the clock hand, giving a touched entry a second chance and
   * evicting the first clean one that has not been touched since the hand last passed. Pinned objects stay
   * whatever the budget. The sweep is bounded, and a type that cannot find victims (its cache all pinned, as
   * while a genesis is built) marks itself saturated and does no more work until the next root unpins.
   */
  evict(): void {
    let over = this.budget.size - this.budget.limit;
    if (over <= 0) return;
    const n = this.refs.length;
    if (n === 0 || this.hot.size === this.pinned.size) {
      this.saturated = true;
      return;
    }
    // The sweep is bounded per call; what it does not manage now, the next call continues from the hand.
    for (let scanned = 0, cap = Math.min(2 * n, 2 * over + 256); over > 0 && scanned < cap; scanned++) {
      const i = this.hand;
      this.hand = i + 1 >= n ? 0 : i + 1;
      if (!this.hot.has(i) || this.pinned.has(i)) continue;
      if (this.touched[i]) {
        this.touched[i] = 0;
        continue;
      }
      this.hot.delete(i);
      this.budget.size--;
      over--;
    }
    // Saturated means nothing clean is left to evict, not that this window found none.
    this.saturated = over > 0 && this.hot.size === this.pinned.size;
  }

  /** A root is over: the pins are off, so the budget can be enforced again, and an overlay has nothing left to say. */
  afterRoot(): void {
    this.saturated = false;
    this.evict();
    for (const s of this.secondary) s.overlay?.clear();
  }

  private decodeAt(instance: number): T {
    const bytes = this.arena.read(this.refs[instance]!);
    return deepFreeze(decode(bytes, (r) => this.type.decode(r, objectId(this.type.id, instance))));
  }

  get(instance: number): T | undefined {
    const v = this.hot.get(instance);
    if (v !== undefined) {
      // A cached object, or a tombstone (null), which reads as absent.
      this.touched[instance] = 1;
      return v ?? undefined;
    }
    if (this.refAt(instance) < 0) return undefined;
    const obj = this.decodeAt(instance);
    this.cache(instance, obj);
    return obj;
  }

  has(instance: number): boolean {
    if (this.hot.has(instance)) return this.hot.get(instance) !== null;
    return this.refAt(instance) >= 0;
  }

  /** The value written since the last root (null for a removal), or undefined when nothing is pending. */
  pending(instance: number): T | null | undefined {
    return this.pinned.has(instance) ? this.hot.get(instance) : undefined;
  }

  /** The committed encoding, a view into the arena; undefined when the arena holds none. */
  bytesOf(instance: number): Uint8Array | undefined {
    const ref = this.refAt(instance);
    return ref < 0 ? undefined : this.arena.read(ref);
  }

  /** The current encoding: a pending value's, or the committed bytes. Null for a removal, undefined when absent. */
  bytesFor(instance: number): Uint8Array | null | undefined {
    const pending = this.pending(instance);
    if (pending !== undefined) return pending ? encode((w) => this.type.encode(w, pending)) : null;
    return this.bytesOf(instance);
  }

  private secondaryIndex(name: string): Secondary<T> {
    const s = this.byName.get(name);
    if (!s) throw new Error(`${this.type.name}: no index ${name}`);
    return s;
  }

  /** An index's B+ tree; it must be resident. */
  index(name: string): BPlusTree<ObjectId> {
    const s = this.secondaryIndex(name);
    if (!s.tree) throw new Error(`${this.type.name}.${name}: the index tree is dropped`);
    return s.tree;
  }

  /** Whether the B+ trees are resident (the type's indices are dropped or kept together). */
  get resident(): boolean {
    return this.secondary.length === 0 || this.secondary[0]!.tree !== null;
  }

  /** The id a stored entry names: a unique entry's value, a non-unique key's last eight bytes. */
  private storedId(s: Secondary<T>, k: Uint8Array, v: Uint8Array): ObjectId {
    return s.def.unique ? u64At(v, 0) : u64At(k, k.length - 8);
  }

  private find(s: Secondary<T>, k: Uint8Array): ObjectId | undefined {
    if (s.tree) return s.tree.get(k);
    const o = s.overlay!.get(k);
    if (o !== undefined) return o ?? undefined;
    const v = this.base.get(entryKey(s.header, k));
    return v === undefined ? undefined : this.storedId(s, k, v);
  }

  /** The id under an exact key: a tree walk, or while dropped an overlay probe and a store read. */
  lookupId(name: string, k: Uint8Array): ObjectId | undefined {
    return this.find(this.secondaryIndex(name), k);
  }

  /**
   * Entries from `start` in key order, all of them to the end of the index, or with `prefix` given only those
   * that start with it. While dropped: a store cursor merged with the overlay.
   */
  entries(name: string, start: Uint8Array, prefix: Uint8Array | null): IterableIterator<[Uint8Array, ObjectId]> {
    return this.entriesOf(this.secondaryIndex(name), start, prefix);
  }

  /** Not a generator itself, so a resident scan costs what the tree's iterator costs and nothing on top. */
  private entriesOf(s: Secondary<T>, start: Uint8Array, prefix: Uint8Array | null): IterableIterator<[Uint8Array, ObjectId]> {
    if (s.tree) return prefix ? s.tree.scan(prefix) : s.tree.scanFrom(start);
    return this.fallbackEntries(s, start, prefix);
  }

  private *fallbackEntries(s: Secondary<T>, start: Uint8Array, prefix: Uint8Array | null): IterableIterator<[Uint8Array, ObjectId]> {
    const end = prefix ? afterPrefix(prefix) : null;
    const stored = this.base.range(entryKey(s.header, start), end ? entryKey(s.header, end) : afterPrefix(s.header)!);
    const self = this;
    function* fromStore(): IterableIterator<[Uint8Array, ObjectId]> {
      for (const [k, v] of stored) yield [k.subarray(INDEX_HEADER), self.storedId(s, k, v)];
    }
    yield* overlaid(fromStore(), until(s.overlay!.entriesFrom(start), end));
  }

  private keysOf(obj: T): Uint8Array[] {
    return this.type.indices.map((ix) => {
      const k = new KeyWriter();
      ix.key(obj, k);
      if (!ix.unique) k.id(obj.id);
      return k.finish();
    });
  }

  private checkUnique(obj: T, keys: Uint8Array[]): void {
    for (let i = 0; i < keys.length; i++) {
      const s = this.secondary[i]!;
      if (!s.def.unique) continue;
      const taken = this.find(s, keys[i]!);
      if (taken !== undefined && taken !== obj.id) throw new DbError(`${this.type.name}.${s.def.name}: key already exists`);
    }
  }

  private indexKeys(obj: T, keys: Uint8Array[]): void {
    for (let i = 0; i < keys.length; i++) {
      const s = this.secondary[i]!;
      const k = keys[i]!;
      if (s.tree) s.tree.set(k, obj.id);
      else s.overlay!.set(k, obj.id);
      this.trees.get(s.def.name)?.set(k, idBytes(obj.id));
    }
  }

  /** Write a value (create or modify). Fails, changing nothing, if a unique key is already taken by another object. */
  insert(obj: T): void {
    const keys = this.keysOf(obj);
    this.checkUnique(obj, keys);
    const instance = instanceOf(obj.id);
    if (instance > MAX_INSTANCE) throw new DbError(`${this.type.name}: instance ${instance} is beyond the index`);
    const old = this.get(instance);
    const oldKeys = old ? this.unindex(old) : null;
    this.wrote(instance, oldKeys, keys);
    this.pinned.add(instance);
    this.cache(instance, obj);
    this.indexKeys(obj, keys);
  }

  /** Remember an instance's keys as committed (on its first write since the root) and as they now stand. */
  private wrote(instance: number, before: Uint8Array[] | null, now: Uint8Array[] | null): void {
    if (this.secondary.length === 0) return;
    const d = this.dirtyKeys.get(instance);
    if (d && this.pinned.has(instance)) d.current = now;
    else this.dirtyKeys.set(instance, { committed: before, current: now });
  }

  /** Load a committed object straight into the arena (import), decoded only to build its index entries. */
  importCommitted(obj: T, bytes: Uint8Array): void {
    const keys = this.keysOf(obj);
    this.checkUnique(obj, keys);
    this.importBytes(instanceOf(obj.id), bytes);
    this.indexKeys(obj, keys);
  }

  /** Load a committed object whose index entries the store already holds (a restart): no decode at all. */
  importBytes(instance: number, bytes: Uint8Array): void {
    if (instance > MAX_INSTANCE) throw new DbError(`${this.type.name}: instance ${instance} is beyond the index`);
    if (this.has(instance)) throw new DbError(`${this.type.name}: instance ${instance} imported twice`);
    this.ensure(instance);
    this.refs[instance] = this.arena.alloc(this.type.id, instance, bytes);
    this.lens[instance] = bytes.length;
  }

  /**
   * After importBytes: fill the sparse trees, and the B+ trees when resident, from the store's entries. They come
   * in key order, which is the B+ tree's cheapest order to grow in.
   */
  loadIndexEntries(): void {
    for (const s of this.secondary) {
      const smt = this.trees.get(s.def.name);
      if (!s.tree && !smt) continue;
      for (const [k, v] of this.base.range(s.header, afterPrefix(s.header)!)) {
        const key = k.subarray(INDEX_HEADER);
        s.tree?.set(key, this.storedId(s, k, v));
        smt?.set(key, v);
      }
    }
  }

  private unindex(obj: T): Uint8Array[] {
    const keys = this.keysOf(obj);
    for (let i = 0; i < keys.length; i++) {
      const s = this.secondary[i]!;
      const k = keys[i]!;
      if (s.tree) s.tree.delete(k);
      else s.overlay!.set(k, null);
      this.trees.get(s.def.name)?.delete(k);
    }
    return keys;
  }

  erase(obj: T): void {
    const keys = this.unindex(obj);
    const instance = instanceOf(obj.id);
    this.wrote(instance, keys, null);
    this.pinned.add(instance);
    this.cache(instance, null);
  }

  /**
   * Drop the B+ trees and fall back on the store. `changed` is every object of this type written since the last
   * root, as its committed value and its current one (null for none): what the overlay must say from now on.
   */
  dropTrees(changed: [T | null, T | null][]): void {
    if (!this.resident) return;
    for (const s of this.secondary) {
      s.tree = null;
      s.overlay = new BPlusTree();
    }
    // Every key a write released first, then every key one took, so a key passed between two objects ends taken.
    for (const [before] of changed) if (before) this.keysOf(before).forEach((k, i) => this.secondary[i]!.overlay!.set(k, null));
    for (const [, now] of changed) if (now) this.keysOf(now).forEach((k, i) => this.secondary[i]!.overlay!.set(k, now.id));
  }

  /** Build the B+ trees again from what the fallback reads (the store with the overlay on top) and drop the overlays. */
  rebuildTrees(): void {
    if (this.resident) return;
    const built = this.secondary.map((s) => {
      const tree = new BPlusTree<ObjectId>();
      for (const [k, id] of this.entriesOf(s, new Uint8Array(0), null)) tree.set(k, id);
      return tree;
    });
    this.secondary.forEach((s, i) => {
      s.tree = built[i]!;
      s.overlay = null;
    });
  }

  /**
   * The index entries a root reports for one object that went from `before` to `after` (null: absent): a
   * released key is removed, a taken one added, and a key it kept is left alone. The keys the writes recorded
   * are used when there are any; `after` is then only asked for its id.
   */
  diffEntries(before: T | null, after: T | null, removed: IndexEntryChange[], added: IndexEntryChange[], instance?: number): void {
    if (this.secondary.length === 0) return;
    const d = instance === undefined ? undefined : this.dirtyKeys.get(instance);
    const old = d ? d.committed : before ? this.keysOf(before) : null;
    const now = d ? d.current : after ? this.keysOf(after) : null;
    for (let i = 0; i < this.secondary.length; i++) {
      const s = this.secondary[i]!;
      const o = old?.[i];
      const n = now?.[i];
      if (o && n && bytesEqual(o, n)) continue;
      if (o) removed.push({ key: entryKey(s.header, o), value: null });
      if (n) added.push({ key: entryKey(s.header, n), value: s.def.unique ? idBytes(after!.id) : EMPTY_VALUE });
    }
  }

  /** Every index entry as it stands, as store keys and values, index by index in key order. */
  *indexEntries(): IterableIterator<[Uint8Array, Uint8Array]> {
    for (const s of this.secondary) {
      for (const [k, id] of this.entriesOf(s, new Uint8Array(0), null)) yield [entryKey(s.header, k), s.def.unique ? idBytes(id) : EMPTY_VALUE];
    }
  }

  /**
   * Compare the resident trees with the store (no writes may be pending): every tree entry must be there with
   * its value, and the store may hold no more entries under the index's prefix than the tree does.
   */
  checkStore(store: IndexStore): string[] {
    const problems: string[] = [];
    for (const s of this.secondary) {
      if (!s.tree) continue;
      const where = `${this.type.name}.${s.def.name}`;
      for (const [k, id] of s.tree.scanFrom(new Uint8Array(0))) {
        const v = store.get(entryKey(s.header, k));
        if (v === undefined) problems.push(`${where}: a key of ${id} is not in the store`);
        else if (s.def.unique ? !bytesEqual(v, idBytes(id)) : v.length !== 0) problems.push(`${where}: the store has another value for a key of ${id}`);
      }
      let stored = 0;
      for (const _ of store.range(s.header, afterPrefix(s.header)!)) stored++;
      if (stored !== s.tree.size) problems.push(`${where}: the store holds ${stored} entries, the tree ${s.tree.size}`);
    }
    return problems;
  }

  /**
   * A root has encoded a pending value: write it to the arena (or free the old entry for a removal)
   * and unpin it. The decoded object stays cached, clean, until evicted.
   */
  flush(instance: number, bytes: Uint8Array | null): void {
    const old = this.refAt(instance);
    if (old >= 0) this.arena.free(old);
    this.ensure(instance);
    if (bytes) {
      this.refs[instance] = this.arena.alloc(this.type.id, instance, bytes);
      this.lens[instance] = bytes.length;
    } else {
      this.refs[instance] = -1;
      this.lens[instance] = 0;
      this.uncache(instance);
    }
    this.pinned.delete(instance);
    this.dirtyKeys.delete(instance);
  }

  /** A root found a pending value equal to the committed one: nothing to write, just unpin. */
  settle(instance: number): void {
    this.pinned.delete(instance);
    this.dirtyKeys.delete(instance);
    if (this.hot.get(instance) === null) this.uncache(instance);
  }

  /** Every present instance, ascending. */
  *instances(): IterableIterator<number> {
    for (let i = 0; i < this.nextInstance; i++) if (this.has(i)) yield i;
  }

  /** Undo of a session that created objects: forget everything from `before` on. */
  truncate(before: number): void {
    for (const instance of [...this.hot.keys()]) {
      if (instance < before) continue;
      this.uncache(instance);
      this.pinned.delete(instance);
      this.dirtyKeys.delete(instance);
    }
    for (let i = before; i < this.refs.length; i++) this.refs[i] = -1;
    this.nextInstance = before;
  }

  /** Index keys of an object, by index name. */
  keyFor(obj: T, index: string): Uint8Array {
    const i = this.secondary.indexOf(this.secondaryIndex(index));
    return this.keysOf(obj)[i]!;
  }

  clear(): void {
    for (let i = 0; i < this.refs.length; i++) if (this.refs[i]! >= 0) this.arena.free(this.refs[i]!);
    this.refs = new Float64Array(0);
    this.lens = new Uint32Array(0);
    this.touched = new Uint8Array(0);
    this.hand = 0;
    this.budget.size -= this.hot.size;
    this.hot.clear();
    this.pinned.clear();
    this.dirtyKeys.clear();
    this.nextInstance = 0;
    for (const s of this.secondary) {
      s.tree?.clear();
      s.overlay?.clear();
    }
  }

  get hotSize(): number {
    return this.hot.size;
  }
}
