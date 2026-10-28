/**
 * A Merkle tree over a dense array of leaves: leaf i is the object with
 * instance i. Because instances are allocated 0, 1, 2, ... the tree is a
 * complete binary tree whose shape depends only on the leaf count. No sparse
 * tree, no balancing, no key hashing. Node (k, j) covers leaves
 * [j * 2^k, (j + 1) * 2^k) regardless of size, so growth never moves a node;
 * the root climbs one level each time the count crosses a power of two.
 *
 * Hashing follows the ICS23 conventions used by the tm2 B+ tree so a
 * standard verifier could check these proofs:
 *   leaf   = H(0x00 || varint(len key) || key || varint(32) || H(value))
 *   inner  = H(0x01 || left || right)
 *   empty  = H(0x02), and two empty children hash to empty
 * The last rule means an empty subtree of any height has the same hash, which
 * is what lets a proof treat padding at every level as one EmptyChild value.
 *
 * Storage is one buffer per 1024 nodes, allocated when a node in it is first
 * set and released when its last node becomes empty, so memory follows the
 * live objects rather than the counter. A type whose objects come and go,
 * like recent transaction ids, costs only its live window.
 *
 * Versions: root(v) hashes the changed paths and, when a retention window is
 * configured, remembers each overwritten node hash as "before version v it
 * was x". A path at an older version is read through those records, and
 * records older than the window are dropped. Node positions never change,
 * so no copy-on-write is needed. The records made by one root() are handed
 * out through lastRecords so a store can persist them, and loadRecords puts
 * them back after a restart.
 */
import { bytesEqual, HASH_SIZE, sha256 } from '../crypto/hash.ts';

const LEAF_PREFIX = new Uint8Array([0]);
const INNER_PREFIX = new Uint8Array([1]);
/** Hash of an empty slot, and of an empty subtree of any height. */
export const EMPTY: Uint8Array = sha256(new Uint8Array([2]));
export const MAX_HEIGHT = 48;
const CHUNK_BITS = 10;
const CHUNK = 1 << CHUNK_BITS;

export function isEmpty(h: Uint8Array): boolean {
  return bytesEqual(h, EMPTY);
}

export function innerHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (isEmpty(left) && isEmpty(right)) return EMPTY;
  return sha256(INNER_PREFIX, left, right);
}

/** Protobuf varint, as ICS23's LengthOp VAR_PROTO expects. */
export function varint(n: number): Uint8Array {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return new Uint8Array(out);
}

/** ICS23 LeafOp: prefix 0x00, key unhashed, value prehashed with sha256, varint lengths. */
export function leafHash(key: Uint8Array, value: Uint8Array): Uint8Array {
  return sha256(LEAF_PREFIX, varint(key.length), key, varint(HASH_SIZE), sha256(value));
}

/** Height of the tree holding n leaves: 0 for one leaf, and the smallest h with 2^h >= n otherwise. */
export function heightFor(leaves: number): number {
  let h = 0;
  while (2 ** h < leaves) h++;
  return h;
}

/**
 * Fold a contiguous range of leaves [from, from + leaves.length) up to the
 * root of a tree with `count` leaves. Siblings come in the order rangeProofAt
 * produces them: at each level, the left neighbour if the range starts on an
 * odd index, then the right neighbour if it ends on an even one. Null if the
 * proof does not fit the range.
 */
export function rootFromRange(leaves: Uint8Array[], from: number, count: number, siblings: Uint8Array[]): Uint8Array | null {
  if (count === 0) return leaves.length === 0 && siblings.length === 0 ? EMPTY : null;
  if (leaves.length === 0 || from + leaves.length > count) return null;
  let nodes = leaves.slice();
  let a = from;
  let b = from + leaves.length;
  let i = 0;
  for (let k = 0; k < heightFor(count); k++) {
    if (a % 2 === 1) {
      if (i >= siblings.length) return null;
      nodes.unshift(siblings[i++]!);
      a -= 1;
    }
    if ((b - 1) % 2 === 0) {
      if (i >= siblings.length) return null;
      nodes.push(siblings[i++]!);
      b += 1;
    }
    const next: Uint8Array[] = [];
    for (let j = 0; j < nodes.length; j += 2) next.push(innerHash(nodes[j]!, nodes[j + 1]!));
    nodes = next;
    a /= 2;
    b /= 2;
  }
  return i === siblings.length && nodes.length === 1 ? nodes[0]! : null;
}

/** Fold a leaf up through its siblings to the root. The bits of `index` say which side the leaf is on. */
export function rootFromPath(leaf: Uint8Array, index: number, siblings: Uint8Array[]): Uint8Array {
  let cur = leaf;
  let j = index;
  for (const sib of siblings) {
    cur = j % 2 === 0 ? innerHash(cur, sib) : innerHash(sib, cur);
    j = Math.floor(j / 2);
  }
  return cur;
}

interface HistoryEntry {
  /** Before version v ... */
  v: number;
  /** ... the node's hash was h. */
  h: Uint8Array;
}

/** What one root() recorded: node (level, index) hashed to h before that version, and the leaf count before it. */
export interface TreeRecords {
  nodes: [number, number, Uint8Array][];
  sizeBefore: number | null;
}

export class DenseMerkleTree {
  /** levels[k] maps chunk index to a buffer of CHUNK node hashes. */
  private readonly levels: Map<number, Uint8Array>[] = [];
  /** Non-empty nodes per chunk, so a chunk can be released. */
  private readonly counts: Map<number, number>[] = [];
  private size = 0;
  private sizeAtLastRoot = 0;
  private dirty = new Set<number>();
  private readonly retain: number;
  private version = -1;
  /** The oldest version this tree can describe: where it was built, lowered as history is loaded. */
  private floor = 0;
  private readonly history: Map<number, HistoryEntry[]>[] = [];
  private readonly historyByVersion = new Map<number, [number, number][]>();
  /** Before version v the leaf count was size. */
  private readonly sizes: { v: number; size: number }[] = [];
  private pendingRecords: [number, number, Uint8Array][] = [];
  private records: TreeRecords = { nodes: [], sizeBefore: null };

  constructor(retainVersions = 0) {
    this.retain = Math.max(0, retainVersions);
  }

  get leafCount(): number {
    return this.size;
  }

  get height(): number {
    return heightFor(this.size);
  }

  get currentVersion(): number {
    return this.version;
  }

  /** The oldest version a path can still be produced for. */
  get lowestVersion(): number {
    return Math.max(this.floor, this.retain > 0 ? this.version - this.retain : this.version);
  }

  /** Number of chunks allocated across all levels, for tests and diagnostics. */
  get chunkCount(): number {
    let n = 0;
    for (const m of this.levels) if (m) n += m.size;
    return n;
  }

  /** Grow to n leaves. New leaves are empty until set. */
  resize(n: number): void {
    if (n < this.size) throw new Error('a dense Merkle tree never shrinks: ids are not reused');
    if (n === this.size) return;
    // Nodes above the old root cover leaf 0; its path recomputes them.
    if (this.size > 0 && heightFor(n) > heightFor(this.size)) this.dirty.add(0);
    this.size = n;
  }

  setLeaf(i: number, hash: Uint8Array): void {
    if (i >= this.size) throw new RangeError(`leaf ${i} beyond size ${this.size}`);
    if (hash.length !== HASH_SIZE) throw new RangeError('leaf hash must be 32 bytes');
    this.writeNode(0, i, hash);
    this.dirty.add(i);
  }

  private nodesAt(k: number, size = this.size): number {
    return Math.ceil(size / 2 ** k);
  }

  private rawNode(k: number, j: number): Uint8Array {
    const chunk = this.levels[k]?.get(Math.floor(j / CHUNK));
    if (!chunk) return EMPTY;
    const off = (j % CHUNK) * HASH_SIZE;
    return chunk.subarray(off, off + HASH_SIZE);
  }

  /** Node j at level k now; anything past the populated range is empty. */
  node(k: number, j: number): Uint8Array {
    if (j >= this.nodesAt(k)) return EMPTY;
    return this.rawNode(k, j);
  }

  /** Write a node, recording its old hash for the version history and keeping chunk occupancy. */
  private writeNode(k: number, j: number, h: Uint8Array): void {
    const old = this.rawNode(k, j);
    if (bytesEqual(old, h)) return;
    if (this.retain > 0 && this.version >= 0) this.record(k, j, old.slice());
    const c = Math.floor(j / CHUNK);
    const off = (j % CHUNK) * HASH_SIZE;
    if (!this.levels[k]) {
      this.levels[k] = new Map();
      this.counts[k] = new Map();
    }
    const level = this.levels[k]!;
    const counts = this.counts[k]!;
    let chunk = level.get(c);
    if (isEmpty(h)) {
      if (!chunk) return;
      chunk.set(EMPTY, off);
      const n = (counts.get(c) ?? 1) - 1;
      if (n <= 0) {
        level.delete(c);
        counts.delete(c);
      } else counts.set(c, n);
      return;
    }
    if (!chunk) {
      chunk = new Uint8Array(CHUNK * HASH_SIZE);
      for (let i = 0; i < CHUNK; i++) chunk.set(EMPTY, i * HASH_SIZE);
      level.set(c, chunk);
    }
    if (isEmpty(old)) counts.set(c, (counts.get(c) ?? 0) + 1);
    chunk.set(h, off);
  }

  /** Remember that before the version being computed, node (k, j) hashed to `old`. */
  private record(k: number, j: number, old: Uint8Array): void {
    if (this.addEntry(k, j, this.pendingVersion, old)) this.pendingRecords.push([k, j, old]);
  }

  /** Returns false if the node already has an entry for that version. Entries must arrive in ascending version order. */
  private addEntry(k: number, j: number, v: number, h: Uint8Array): boolean {
    let byIndex = this.history[k];
    if (!byIndex) byIndex = this.history[k] = new Map();
    let entries = byIndex.get(j);
    if (!entries) byIndex.set(j, (entries = []));
    const last = entries[entries.length - 1];
    if (last && last.v >= v) return false;
    entries.push({ v, h });
    let list = this.historyByVersion.get(v);
    if (!list) this.historyByVersion.set(v, (list = []));
    list.push([k, j]);
    return true;
  }

  /** The records the last root() made, for a store. */
  get lastRecords(): TreeRecords {
    return this.records;
  }

  /** Put back records a store kept, in ascending version order, after the current root is in place. */
  /**
   * Make `version` askable although no record of it was loaded: nothing changed
   * this tree between then and the oldest recorded version, so its entries, or
   * its live state, already describe it.
   */
  lowerFloor(version: number): void {
    if (version < this.floor) this.floor = Math.max(0, version);
  }

  loadRecords(version: number, rec: TreeRecords): void {
    if (version > this.version) throw new RangeError(`cannot load history for version ${version} beyond ${this.version}`);
    // A record for version v describes version v-1 as well.
    this.lowerFloor(version - 1);
    if (version <= this.lowestVersion) return;
    for (const [k, j, h] of rec.nodes) this.addEntry(k, j, version, h);
    if (rec.sizeBefore !== null) {
      const last = this.sizes[this.sizes.length - 1];
      if (last && last.v >= version) throw new RangeError('size history must be loaded in ascending version order');
      this.sizes.push({ v: version, size: rec.sizeBefore });
    }
  }

  /** Writes between two root() calls belong to the next version. */
  private get pendingVersion(): number {
    return this.nextVersion ?? this.version + 1;
  }
  private nextVersion: number | null = null;

  /** Recompute every changed path and return the root, as of `version`. Versions must increase. */
  root(version = this.version + 1): Uint8Array {
    if (version <= this.version) throw new Error(`version ${version} is not after ${this.version}`);
    if (this.version < 0) this.floor = version;
    this.nextVersion = version;
    let sizeBefore: number | null = null;
    if (this.version >= 0 && this.size !== this.sizeAtLastRoot) {
      sizeBefore = this.sizeAtLastRoot;
      this.sizes.push({ v: version, size: sizeBefore });
    }
    this.sizeAtLastRoot = this.size;
    const h = this.height;
    let dirty = this.dirty;
    for (let k = 1; k <= h; k++) {
      const parents = new Set<number>();
      for (const j of dirty) parents.add(Math.floor(j / 2));
      for (const p of parents) this.writeNode(k, p, innerHash(this.node(k - 1, 2 * p), this.node(k - 1, 2 * p + 1)));
      dirty = parents;
    }
    this.dirty = new Set();
    this.version = version;
    this.nextVersion = null;
    this.records = { nodes: this.pendingRecords, sizeBefore };
    this.pendingRecords = [];
    if (this.retain > 0) this.prune(version - this.retain);
    else this.sizes.length = 0; // nothing but the current version is askable, and its size is `size`
    return this.rootAt(version);
  }

  /** Leaf count as of a version. */
  sizeAt(version: number): number {
    for (const s of this.sizes) if (s.v > version) return s.size;
    return this.size;
  }

  private checkVersion(version: number): void {
    if (this.dirty.size > 0) throw new Error('tree has unhashed changes; call root() first');
    if (version > this.version || version < this.lowestVersion) throw new RangeError(`version ${version} is not available (have ${this.lowestVersion}..${this.version})`);
  }

  /** Node j at level k as of a version. */
  nodeAt(k: number, j: number, version: number): Uint8Array {
    if (j >= this.nodesAt(k, this.sizeAt(version))) return EMPTY;
    const entries = this.history[k]?.get(j);
    if (entries) for (const e of entries) if (e.v > version) return e.h;
    return this.rawNode(k, j);
  }

  rootAt(version: number): Uint8Array {
    this.checkVersion(version);
    const size = this.sizeAt(version);
    return size === 0 ? EMPTY : this.nodeAt(heightFor(size), 0, version).slice();
  }

  /** Sibling hashes from leaf i to the root as of a version: the inclusion proof. */
  pathAt(i: number, version: number): Uint8Array[] {
    this.checkVersion(version);
    const size = this.sizeAt(version);
    if (i >= size) throw new RangeError(`leaf ${i} beyond size ${size} at version ${version}`);
    const out: Uint8Array[] = [];
    let j = i;
    for (let k = 0; k < heightFor(size); k++) {
      out.push(this.nodeAt(k, j % 2 === 0 ? j + 1 : j - 1, version).slice());
      j = Math.floor(j / 2);
    }
    return out;
  }

  path(i: number): Uint8Array[] {
    return this.pathAt(i, this.version);
  }

  /** The siblings that fold leaves [from, to) to the root as of a version; see rootFromRange. */
  rangeProofAt(from: number, to: number, version: number): Uint8Array[] {
    this.checkVersion(version);
    const size = this.sizeAt(version);
    if (from < 0 || from >= to || to > size) throw new RangeError(`range [${from}, ${to}) outside size ${size}`);
    const out: Uint8Array[] = [];
    let a = from;
    let b = to;
    for (let k = 0; k < heightFor(size); k++) {
      if (a % 2 === 1) {
        out.push(this.nodeAt(k, a - 1, version).slice());
        a -= 1;
      }
      if ((b - 1) % 2 === 0) {
        out.push(this.nodeAt(k, b, version).slice());
        b += 1;
      }
      a /= 2;
      b /= 2;
    }
    return out;
  }

  /** Drop history that only serves versions at or below minVersion. */
  prune(minVersion: number): void {
    for (const [v, list] of this.historyByVersion) {
      if (v > minVersion) continue;
      for (const [k, j] of list) {
        const byIndex = this.history[k]!;
        const entries = byIndex.get(j)!;
        while (entries.length > 0 && entries[0]!.v <= minVersion) entries.shift();
        if (entries.length === 0) byIndex.delete(j);
      }
      this.historyByVersion.delete(v);
    }
    while (this.sizes.length > 0 && this.sizes[0]!.v <= minVersion) this.sizes.shift();
  }
}
