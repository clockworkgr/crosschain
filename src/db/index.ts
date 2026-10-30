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
 * Indices are derived from the objects and are rebuilt when a store is
 * loaded. An index marked `authenticated` (unique only) also keeps a sparse
 * Merkle tree (smt.ts) over its keys, whose root goes into the type's leaf
 * in the state root, so a key can be proven present or absent.
 */
import { decode, type Reader } from '../codec/reader.ts';
import type { Writer } from '../codec/writer.ts';
import { instanceOf, objectId, type ObjectId } from './id.ts';
import { KeyWriter } from './keys.ts';
import { encode } from '../codec/writer.ts';
import type { Arena } from './arena.ts';
import { BPlusTree } from './bptree.ts';
import { deepFreeze } from './freeze.ts';
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

export class TypeIndex<T extends { id: ObjectId }> {
  readonly type: ObjectType<T>;
  nextInstance = 0;
  readonly secondary = new Map<string, BPlusTree<ObjectId>>();
  /** Sparse trees of the authenticated indices, by name. */
  readonly trees = new Map<string, SparseMerkleTree>();
  /** Names of the authenticated indices, in definition order. */
  readonly authenticated: string[] = [];
  private readonly arena: Arena;
  private readonly budget: HotBudget;
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

  constructor(type: ObjectType<T>, retainVersions: number, arena: Arena, budget: HotBudget) {
    this.type = type;
    this.arena = arena;
    this.budget = budget;
    for (const ix of type.indices) {
      if (this.secondary.has(ix.name)) throw new Error(`${type.name}: duplicate index ${ix.name}`);
      this.secondary.set(ix.name, new BPlusTree());
      if (ix.authenticated) {
        if (!ix.unique) throw new Error(`${type.name}.${ix.name}: only unique indices can be authenticated`);
        this.trees.set(ix.name, new SparseMerkleTree(retainVersions));
        this.authenticated.push(ix.name);
      }
    }
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

  /** A root is over: the pins are off, so the budget can be enforced again. */
  afterRoot(): void {
    this.saturated = false;
    this.evict();
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

  index(name: string): BPlusTree<ObjectId> {
    const m = this.secondary.get(name);
    if (!m) throw new Error(`${this.type.name}: no index ${name}`);
    return m;
  }

  private keysOf(obj: T): [IndexDef<T>, Uint8Array][] {
    return this.type.indices.map((ix) => {
      const k = new KeyWriter();
      ix.key(obj, k);
      if (!ix.unique) k.id(obj.id);
      return [ix, k.finish()];
    });
  }

  private checkUnique(obj: T, keys: [IndexDef<T>, Uint8Array][]): void {
    for (const [ix, k] of keys) {
      if (!ix.unique) continue;
      const taken = this.secondary.get(ix.name)!.get(k);
      if (taken !== undefined && taken !== obj.id) throw new DbError(`${this.type.name}.${ix.name}: key already exists`);
    }
  }

  private indexKeys(obj: T, keys: [IndexDef<T>, Uint8Array][]): void {
    for (const [ix, k] of keys) {
      this.secondary.get(ix.name)!.set(k, obj.id);
      this.trees.get(ix.name)?.set(k, encode((w) => w.u64(obj.id)));
    }
  }

  /** Write a value (create or modify). Fails, changing nothing, if a unique key is already taken by another object. */
  insert(obj: T): void {
    const keys = this.keysOf(obj);
    this.checkUnique(obj, keys);
    const instance = instanceOf(obj.id);
    if (instance > MAX_INSTANCE) throw new DbError(`${this.type.name}: instance ${instance} is beyond the index`);
    const old = this.get(instance);
    if (old) this.unindex(old);
    this.pinned.add(instance);
    this.cache(instance, obj);
    this.indexKeys(obj, keys);
  }

  /** Load a committed object straight into the arena (import), decoded only to build its index entries. */
  importCommitted(obj: T, bytes: Uint8Array): void {
    const keys = this.keysOf(obj);
    this.checkUnique(obj, keys);
    const instance = instanceOf(obj.id);
    if (instance > MAX_INSTANCE) throw new DbError(`${this.type.name}: instance ${instance} is beyond the index`);
    if (this.has(instance)) throw new DbError(`${this.type.name}: instance ${instance} imported twice`);
    this.ensure(instance);
    this.refs[instance] = this.arena.alloc(this.type.id, instance, bytes);
    this.lens[instance] = bytes.length;
    this.indexKeys(obj, keys);
  }

  private unindex(obj: T): void {
    for (const [ix, k] of this.keysOf(obj)) {
      this.secondary.get(ix.name)!.delete(k);
      this.trees.get(ix.name)?.delete(k);
    }
  }

  erase(obj: T): void {
    this.unindex(obj);
    const instance = instanceOf(obj.id);
    this.pinned.add(instance);
    this.cache(instance, null);
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
  }

  /** A root found a pending value equal to the committed one: nothing to write, just unpin. */
  settle(instance: number): void {
    this.pinned.delete(instance);
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
    }
    for (let i = before; i < this.refs.length; i++) this.refs[i] = -1;
    this.nextInstance = before;
  }

  /** Index keys of an object, by index name. */
  keyFor(obj: T, index: string): Uint8Array {
    for (const [ix, k] of this.keysOf(obj)) if (ix.name === index) return k;
    throw new Error(`${this.type.name}: no index ${index}`);
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
    this.nextInstance = 0;
    for (const m of this.secondary.values()) m.clear();
  }

  get hotSize(): number {
    return this.hot.size;
  }
}
