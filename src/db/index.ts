/**
 * One type's objects and indices, Graphene's generic_index without Boost.
 *
 * The primary index is an array: instance i is objects[i], because ids are
 * dense (id.ts). Every secondary index is a key encoder (keys.ts) plus an
 * ordered byte map (bptree.ts). A unique index maps key to id. A
 * non-unique index appends the id to the key, which makes every entry
 * distinct while keeping all entries for one prefix adjacent, so a range
 * query is a prefix scan.
 *
 * Indices are derived from the objects and are rebuilt when a store is
 * loaded. An index marked `authenticated` (unique only) also keeps a sparse
 * Merkle tree (smt.ts) over its keys, whose root goes into the type's leaf
 * in the state root, so a key can be proven present or absent.
 */
import type { Reader } from '../codec/reader.ts';
import type { Writer } from '../codec/writer.ts';
import { instanceOf, type ObjectId } from './id.ts';
import { KeyWriter } from './keys.ts';
import { encode } from '../codec/writer.ts';
import { BPlusTree } from './bptree.ts';
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

export class TypeIndex<T extends { id: ObjectId }> {
  readonly type: ObjectType<T>;
  readonly objects: (T | undefined)[] = [];
  nextInstance = 0;
  readonly secondary = new Map<string, BPlusTree<ObjectId>>();
  /** Sparse trees of the authenticated indices, by name. */
  readonly trees = new Map<string, SparseMerkleTree>();
  /** Names of the authenticated indices, in definition order. */
  readonly authenticated: string[] = [];

  constructor(type: ObjectType<T>, retainVersions = 0) {
    this.type = type;
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

  get(instance: number): T | undefined {
    return this.objects[instance];
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

  /** Fails, changing nothing, if a unique key is already taken by another object. */
  insert(obj: T): void {
    const keys = this.keysOf(obj);
    for (const [ix, k] of keys) {
      if (!ix.unique) continue;
      const taken = this.secondary.get(ix.name)!.get(k);
      if (taken !== undefined && taken !== obj.id) throw new DbError(`${this.type.name}.${ix.name}: key already exists`);
    }
    const instance = instanceOf(obj.id);
    if (instance > MAX_INSTANCE) throw new DbError(`${this.type.name}: instance ${instance} is beyond the index`);
    const old = this.objects[instance];
    if (old) this.unindex(old);
    this.objects[instance] = obj;
    for (const [ix, k] of keys) {
      this.secondary.get(ix.name)!.set(k, obj.id);
      this.trees.get(ix.name)?.set(k, encode((w) => w.u64(obj.id)));
    }
  }

  private unindex(obj: T): void {
    for (const [ix, k] of this.keysOf(obj)) {
      this.secondary.get(ix.name)!.delete(k);
      this.trees.get(ix.name)?.delete(k);
    }
  }

  erase(obj: T): void {
    this.unindex(obj);
    this.objects[instanceOf(obj.id)] = undefined;
  }

  /** Index keys of an object, by index name. */
  keyFor(obj: T, index: string): Uint8Array {
    for (const [ix, k] of this.keysOf(obj)) if (ix.name === index) return k;
    throw new Error(`${this.type.name}: no index ${index}`);
  }

  clear(): void {
    this.objects.length = 0;
    this.nextInstance = 0;
    for (const m of this.secondary.values()) m.clear();
  }
}
