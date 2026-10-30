/**
 * A compacted sparse Merkle tree over hashed keys: the commitment structure
 * for an authenticated index, alongside the B+ tree that does the lookups.
 *
 * Why not hash the B+ tree itself: its root would depend on node layout,
 * which depends on the order of inserts and deletes, and a node that
 * restarts rebuilds its indices from the objects in id order. A sparse tree
 * keyed by sha256(key) has one shape per key set (the Jellyfish shape:
 * every leaf sits at the first depth where its prefix is unique), so any
 * node, after any history, hashes identically. Keys are hashed so the tree
 * stays balanced and ICS23's SMT spec applies (PrehashKey SHA256).
 *
 * Hashing is the same as merkle.ts: leaf H(0x00 ...), inner H(0x01 l r),
 * empty H(0x02) with two empties hashing to empty. Nodes are immutable and
 * every write copies the path from the root, so keeping a past version is
 * keeping its root pointer; versions outside the window are dropped and the
 * garbage collector reclaims what nothing references.
 *
 * A proof is the sibling hashes down the key's path and what sits at its
 * end: the key's own leaf (membership), nothing (absence), or another leaf
 * sharing the prefix (absence, since that leaf owns the whole subtree).
 *
 * On disk (STATE-PAGING.md section 5) every node is one store key, by the
 * path from the root to it:
 *
 *   'n' type u16, index position u8, path bits (packed, zero-padded), depth u8
 *     -> 0x00 left hash, right hash     (inner node)
 *     -> 0x01 key hash, value           (leaf)
 *
 * An inner node carries its children's hashes, so a walk down one key's path
 * reads one node per level and finds every sibling hash it needs on the way.
 * A commit reports the nodes it changed (takeNodes): in memory, by walking
 * the previous and the new root together into the subtrees whose hashes
 * differ. A tree can be dropped: the nodes are let go and the tree works on
 * the store. Writes between commits are then only remembered, per key; a
 * commit applies them by walking each key's path, reading nodes from the
 * store and writing the changed ones back, with the same shape rules as the
 * nodes in memory, so the root is the same. A lookup or a proof walks nodes
 * from the root. Past versions inside the window are served from records of
 * what each commit overwrote (before version v, the node at this path was x),
 * as the dense trees keep theirs; rebuilding reads the current tree from the
 * store and each older version from the records, sharing every subtree that
 * did not change.
 */
import { bytesEqual, sha256 } from '../crypto/hash.ts';
import { EMPTY, innerHash, isEmpty, leafHash, type StoreChange, type TreeSource } from './merkle.ts';

export interface SmtLeaf {
  keyHash: Uint8Array;
  value: Uint8Array;
}

export interface SmtProof {
  /** Sibling hashes from depth 0 down to the depth where the walk ended. */
  siblings: Uint8Array[];
  /** The leaf at the end of the walk, or null if the walk reached an empty slot. */
  leaf: SmtLeaf | null;
}

type Node = { hash: Uint8Array; leaf: SmtLeaf; left?: undefined } | { hash: Uint8Array; left: Node | null; right: Node | null; leaf?: undefined };

const KEY_BITS = 256;

function bit(h: Uint8Array, i: number): number {
  return (h[i >> 3]! >> (7 - (i & 7))) & 1;
}

function setBit(path: Uint8Array, i: number, b: number): void {
  const mask = 1 << (7 - (i & 7));
  path[i >> 3] = b ? path[i >> 3]! | mask : path[i >> 3]! & ~mask;
}

/** First byte of a sparse tree node's store key. */
export const NODE_PREFIX = 0x6e; // 'n'

/** The first bytes of every node key of one authenticated index: 'n', the type, the index's position in the type. */
export function nodeHeader(type: number, position: number): Uint8Array {
  return Uint8Array.of(NODE_PREFIX, type >> 8, type & 0xff, position);
}

/** The store key of the node at `depth` on a path: the path's first `depth` bits, packed and zero-padded, then the depth. */
export function nodeKey(header: Uint8Array, path: Uint8Array, depth: number): Uint8Array {
  // A leaf one level below the deepest inner node possible (two keys sharing 255 bits) cannot be named.
  if (depth > 255) throw new RangeError('sparse tree node deeper than 255');
  const n = (depth + 7) >> 3;
  const out = new Uint8Array(header.length + n + 1);
  out.set(header);
  for (let i = 0; i < n; i++) out[header.length + i] = path[i]!;
  if (depth & 7) out[header.length + n - 1]! &= (0xff << (8 - (depth & 7))) & 0xff;
  out[out.length - 1] = depth;
  return out;
}

const INNER = 0;
const LEAF = 1;

function innerEncoding(left: Uint8Array, right: Uint8Array): Uint8Array {
  const e = new Uint8Array(65);
  e[0] = INNER;
  e.set(left, 1);
  e.set(right, 33);
  return e;
}

function leafEncoding(keyHash: Uint8Array, value: Uint8Array): Uint8Array {
  const e = new Uint8Array(33 + value.length);
  e[0] = LEAF;
  e.set(keyHash, 1);
  e.set(value, 33);
  return e;
}

function encodingOf(n: Node): Uint8Array {
  return n.leaf ? leafEncoding(n.leaf.keyHash, n.leaf.value) : innerEncoding(n.left?.hash ?? EMPTY, n.right?.hash ?? EMPTY);
}

function hashOfEncoding(e: Uint8Array): Uint8Array {
  return e[0] === LEAF ? leafHash(e.subarray(1, 33), e.subarray(33)) : innerHash(e.subarray(1, 33), e.subarray(33, 65));
}

/** The child hash on one side (0 left, 1 right) of an inner node's encoding. */
function childOf(e: Uint8Array, side: number): Uint8Array {
  return e.subarray(1 + 32 * side, 33 + 32 * side);
}

/** A map key for a store key. */
function str(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');
}

/**
 * Visit every position where two trees differ, top down: a node of `b` that is not in `a` (or replaces a different
 * one), and a node of `a` that `b` no longer has. Subtrees with equal hashes are equal and skipped, so the cost is
 * the changed paths.
 */
function walkChanged(a: Node | null, b: Node | null, header: Uint8Array, path: Uint8Array, depth: number, visit: (key: Uint8Array, a: Node | null, b: Node | null) => void): void {
  if (a === b || (a && b && bytesEqual(a.hash, b.hash))) return;
  visit(nodeKey(header, path, depth), a, b);
  const al = a && !a.leaf ? a.left : null;
  const ar = a && !a.leaf ? a.right : null;
  const bl = b && !b.leaf ? b.left : null;
  const br = b && !b.leaf ? b.right : null;
  if (al || bl) {
    setBit(path, depth, 0);
    walkChanged(al, bl, header, path, depth + 1, visit);
  }
  if (ar || br) {
    setBit(path, depth, 1);
    walkChanged(ar, br, header, path, depth + 1, visit);
  }
}

function eachLeaf(n: Node | null, f: (l: SmtLeaf) => void): void {
  if (!n) return;
  if (n.leaf) f(n.leaf);
  else {
    eachLeaf(n.left, f);
    eachLeaf(n.right, f);
  }
}

/** One key's write since the last commit while the tree is dropped: its value, or null for a removal. */
interface PendingWrite {
  keyHash: Uint8Array;
  value: Uint8Array | null;
}

/** A node a commit in progress wrote: its key, its encoding now (null: deleted) and at the last commit. */
interface NodeWrite {
  key: Uint8Array;
  enc: Uint8Array | null;
  before: Uint8Array | null;
}

/** A subtree after an update while dropped: its hash and its root's encoding (null: empty). */
interface Sub {
  hash: Uint8Array;
  enc: Uint8Array | null;
}

function leafNode(keyHash: Uint8Array, value: Uint8Array): Node {
  return { hash: leafHash(keyHash, value), leaf: { keyHash, value } };
}

function innerNode(left: Node | null, right: Node | null): Node {
  return { hash: innerHash(left?.hash ?? EMPTY, right?.hash ?? EMPTY), left, right };
}

function insert(node: Node | null, keyHash: Uint8Array, value: Uint8Array, depth: number): Node {
  if (!node) return leafNode(keyHash, value);
  if (node.leaf) {
    if (bytesEqual(node.leaf.keyHash, keyHash)) return bytesEqual(node.leaf.value, value) ? node : leafNode(keyHash, value);
    // Two leaves in one subtree: push both down to the first bit where they differ.
    let b = depth;
    while (b < KEY_BITS && bit(node.leaf.keyHash, b) === bit(keyHash, b)) b++;
    const fresh = leafNode(keyHash, value);
    let cur = bit(keyHash, b) ? innerNode(node, fresh) : innerNode(fresh, node);
    for (let d = b - 1; d >= depth; d--) cur = bit(keyHash, d) ? innerNode(null, cur) : innerNode(cur, null);
    return cur;
  }
  if (bit(keyHash, depth)) {
    const right = insert(node.right, keyHash, value, depth + 1);
    return right === node.right ? node : innerNode(node.left, right);
  }
  const left = insert(node.left, keyHash, value, depth + 1);
  return left === node.left ? node : innerNode(left, node.right);
}

function remove(node: Node | null, keyHash: Uint8Array, depth: number): Node | null {
  if (!node) return null;
  if (node.leaf) return bytesEqual(node.leaf.keyHash, keyHash) ? null : node;
  const goRight = bit(keyHash, depth) === 1;
  const left = goRight ? node.left : remove(node.left, keyHash, depth + 1);
  const right = goRight ? remove(node.right, keyHash, depth + 1) : node.right;
  if (left === node.left && right === node.right) return node;
  if (!left && !right) return null;
  // A lone leaf moves up: its prefix is unique one level earlier now.
  if (!left && right?.leaf) return right;
  if (!right && left?.leaf) return left;
  return innerNode(left, right);
}

export class SparseMerkleTree {
  private root: Node | null = null;
  private readonly versions = new Map<number, Node | null>();
  private readonly retain: number;
  private version = -1;
  /** Where this tree's nodes live in the store: 'n', type, index position. */
  private readonly header: Uint8Array;
  private nodeChanges: StoreChange[] = [];
  // ---- while dropped ----
  /** The store the nodes are read from; null while the tree is resident. */
  private source: TreeSource | null = null;
  /** Per key hash (as a string), what the writes since the last commit made of it. */
  private readonly pending = new Map<string, PendingWrite>();
  /** The root hash as of each retained version. */
  private readonly roots = new Map<number, Uint8Array>();
  /** The oldest version the records can describe. */
  private floor = 0;
  /** Per node key (as a string): before version v the node was enc (null: absent). Ascending by v. */
  private readonly history = new Map<string, { v: number; enc: Uint8Array | null }[]>();
  private readonly historyByVersion = new Map<number, string[]>();
  /** The nodes the commit in progress wrote, by key. */
  private work: Map<string, NodeWrite> | null = null;

  constructor(retainVersions = 0, header: Uint8Array = new Uint8Array(0)) {
    this.retain = Math.max(0, retainVersions);
    this.header = header;
  }

  get currentVersion(): number {
    return this.version;
  }

  get lowestVersion(): number {
    if (this.source) return this.retain > 0 ? Math.max(this.floor, this.version - this.retain) : this.version;
    return this.retain > 0 ? Math.max(0, this.version - this.retain) : this.version;
  }

  get resident(): boolean {
    return this.source === null;
  }

  /** The store a dropped tree reads, for a tree that replaces it. */
  get dropSource(): TreeSource | null {
    return this.source;
  }

  set(key: Uint8Array, value: Uint8Array): void {
    if (this.source) {
      const keyHash = sha256(key);
      this.pending.set(str(keyHash), { keyHash, value });
    } else this.root = insert(this.root, sha256(key), value, 0);
  }

  delete(key: Uint8Array): void {
    if (this.source) {
      const keyHash = sha256(key);
      this.pending.set(str(keyHash), { keyHash, value: null });
    } else this.root = remove(this.root, sha256(key), 0);
  }

  get(key: Uint8Array): Uint8Array | undefined {
    const keyHash = sha256(key);
    if (this.source) {
      const p = this.pending.get(str(keyHash));
      if (p) return p.value?.slice() ?? undefined;
      for (let d = 0; ; d++) {
        const e = this.source.get(nodeKey(this.header, keyHash, d));
        if (!e) return undefined;
        if (e[0] === LEAF) return bytesEqual(e.subarray(1, 33), keyHash) ? e.slice(33) : undefined;
        if (isEmpty(childOf(e, bit(keyHash, d)))) return undefined;
      }
    }
    let n = this.root;
    for (let d = 0; n && !n.leaf; d++) n = bit(keyHash, d) ? n.right : n.left;
    return n && bytesEqual(n.leaf!.keyHash, keyHash) ? n.leaf!.value.slice() : undefined;
  }

  rootHash(): Uint8Array {
    if (this.source) {
      if (this.pending.size > 0) throw new Error('a dropped sparse tree computes its root at a commit');
      return this.storedRootHash().slice();
    }
    return (this.root?.hash ?? EMPTY).slice();
  }

  /**
   * Remember the current contents as `version`. Versions must increase. With `report`, the nodes that changed
   * since the last commit are listed for the store (takeNodes); a dropped tree always lists them, since the store
   * is where they live.
   */
  commit(version: number, report = false): Uint8Array {
    if (version <= this.version) throw new Error(`version ${version} is not after ${this.version}`);
    if (this.source) return this.commitDropped(version);
    this.nodeChanges = [];
    if (report) {
      const before = this.version >= 0 ? (this.versions.get(this.version) ?? null) : null;
      walkChanged(before, this.root, this.header, new Uint8Array(32), 0, (key, _a, b) => this.nodeChanges.push({ key, value: b ? encodingOf(b) : null }));
    }
    this.version = version;
    this.versions.set(version, this.root);
    for (const v of this.versions.keys()) if (v < version - this.retain) this.versions.delete(v);
    return this.rootHash();
  }

  /** The nodes the last commit changed, as store keys and values (null: delete); handed over once, so the tree does not keep them alive. */
  takeNodes(): StoreChange[] {
    const out = this.nodeChanges;
    this.nodeChanges = [];
    return out;
  }

  private rootOf(version: number): Node | null {
    if (version > this.version || version < this.lowestVersion || !this.versions.has(version)) {
      throw new RangeError(`version ${version} is not available (have ${this.lowestVersion}..${this.version})`);
    }
    return this.versions.get(version)!;
  }

  private checkDropped(version: number): void {
    if (version > this.version || version < this.lowestVersion || !this.roots.has(version)) {
      throw new RangeError(`version ${version} is not available (have ${this.lowestVersion}..${this.version})`);
    }
  }

  rootAt(version: number): Uint8Array {
    if (this.source) {
      this.checkDropped(version);
      return this.roots.get(version)!.slice();
    }
    return (this.rootOf(version)?.hash ?? EMPTY).slice();
  }

  /** Membership or absence proof for a key as of a version. Every buffer in it is a copy; the tree's own stay untouched. */
  proveAt(key: Uint8Array, version: number): SmtProof {
    const keyHash = sha256(key);
    const siblings: Uint8Array[] = [];
    if (this.source) {
      this.checkDropped(version);
      for (let d = 0; ; d++) {
        const e = this.nodeAt(nodeKey(this.header, keyHash, d), version);
        if (!e) return { siblings, leaf: null };
        if (e[0] === LEAF) return { siblings, leaf: { keyHash: e.slice(1, 33), value: e.slice(33) } };
        const side = bit(keyHash, d);
        siblings.push(childOf(e, 1 - side).slice());
        if (isEmpty(childOf(e, side))) return { siblings, leaf: null };
      }
    }
    let n = this.rootOf(version);
    for (let d = 0; n && !n.leaf; d++) {
      if (bit(keyHash, d)) {
        siblings.push((n.left?.hash ?? EMPTY).slice());
        n = n.right;
      } else {
        siblings.push((n.right?.hash ?? EMPTY).slice());
        n = n.left;
      }
    }
    return { siblings, leaf: n ? { keyHash: n.leaf!.keyHash.slice(), value: n.leaf!.value.slice() } : null };
  }

  prove(key: Uint8Array): SmtProof {
    return this.proveAt(key, this.version);
  }

  /** Every node as of the last commit, as store keys and values: what a store written from scratch holds. */
  *entries(): IterableIterator<[Uint8Array, Uint8Array]> {
    if (this.source) {
      yield* this.source.range(this.header, headerEnd(this.header));
      return;
    }
    const out: [Uint8Array, Uint8Array][] = [];
    walkChanged(null, this.version >= 0 ? (this.versions.get(this.version) ?? null) : this.root, this.header, new Uint8Array(32), 0, (key, _a, b) => out.push([key, encodingOf(b!)]));
    yield* out;
  }

  // ---- dropping and rebuilding ----

  /**
   * Let the nodes go and work on `source`, which must hold this tree as of the last commit. Writes since then become
   * pending writes, and the retained versions become records of what each commit overwrote.
   */
  drop(source: TreeSource): void {
    if (this.source) return;
    const committed = this.version >= 0 ? (this.versions.get(this.version) ?? null) : null;
    // What the writes since the last commit changed: every leaf of a subtree that differs, released, then every
    // leaf of the subtree that replaced it, taken (a leaf in both is taken again, with its value, which is no change).
    const changed = (a: Node | null, b: Node | null): void => {
      if (a === b || (a && b && bytesEqual(a.hash, b.hash))) return;
      if (a && !a.leaf && b && !b.leaf) {
        changed(a.left, b.left);
        changed(a.right, b.right);
        return;
      }
      eachLeaf(a, (l) => this.pending.set(str(l.keyHash), { keyHash: l.keyHash, value: null }));
      eachLeaf(b, (l) => this.pending.set(str(l.keyHash), { keyHash: l.keyHash, value: l.value }));
    };
    changed(committed, this.root);
    const versions = [...this.versions.keys()].sort((a, b) => a - b);
    for (const v of versions) this.roots.set(v, (this.versions.get(v)?.hash ?? EMPTY).slice());
    this.floor = versions[0] ?? 0;
    for (let i = 1; i < versions.length; i++) {
      const v = versions[i]!;
      const keys: string[] = [];
      walkChanged(this.versions.get(versions[i - 1]!) ?? null, this.versions.get(v) ?? null, this.header, new Uint8Array(32), 0, (key, a) => {
        const s = str(key);
        let entries = this.history.get(s);
        if (!entries) this.history.set(s, (entries = []));
        entries.push({ v, enc: a ? encodingOf(a) : null });
        keys.push(s);
      });
      if (keys.length > 0) this.historyByVersion.set(v, keys);
    }
    this.root = null;
    this.versions.clear();
    this.source = source;
  }

  /** Read the tree back from the store, and every retained version from the records; the pending writes go on top. */
  rebuild(): void {
    const source = this.source;
    if (!source) return;
    const path = new Uint8Array(32);
    // Newest first, each built against the next newer one, so whatever did not change between them is shared.
    let newer: Node | null = null;
    const built = new Map<number, Node | null>();
    for (const v of [...this.roots.keys()].sort((a, b) => b - a)) {
      const h = this.roots.get(v)!;
      const n: Node | null = isEmpty(h) ? null : this.build((k) => this.nodeAt(k, v), path, 0, h, newer);
      built.set(v, n);
      newer = n;
    }
    let root: Node | null;
    if (this.version >= 0) root = built.get(this.version) ?? null;
    else {
      const h = this.storedRootHash();
      root = isEmpty(h) ? null : this.build((k) => source.get(k) ?? null, path, 0, h, null);
    }
    for (const p of this.pending.values()) root = p.value ? insert(root, p.keyHash, p.value, 0) : remove(root, p.keyHash, 0);
    this.source = null;
    this.pending.clear();
    this.roots.clear();
    this.history.clear();
    this.historyByVersion.clear();
    for (const [v, n] of built) this.versions.set(v, n);
    this.root = root;
  }

  /** A fresh tree takes its nodes from a store that holds them (a restart), instead of inserting every key. */
  load(source: TreeSource): void {
    if (this.version >= 0 || this.source || this.root) throw new Error('nodes are loaded only into a fresh resident tree');
    const e = source.get(nodeKey(this.header, EMPTY, 0));
    this.root = e ? this.build((k) => source.get(k) ?? null, new Uint8Array(32), 0, hashOfEncoding(e), null) : null;
  }

  /** Build the subtree at a path whose hash is known, reusing `same` (the node at that path in another version) where the hash matches. */
  private build(read: (key: Uint8Array) => Uint8Array | null, path: Uint8Array, depth: number, hash: Uint8Array, same: Node | null): Node {
    if (same && bytesEqual(same.hash, hash)) return same;
    const e = read(nodeKey(this.header, path, depth));
    if (!e) throw new Error('a sparse tree node is missing from the store');
    if (e[0] === LEAF) return { hash: hash.slice(), leaf: { keyHash: e.slice(1, 33), value: e.slice(33) } };
    const l = childOf(e, 0);
    const r = childOf(e, 1);
    let left: Node | null = null;
    let right: Node | null = null;
    if (!isEmpty(l)) {
      setBit(path, depth, 0);
      left = this.build(read, path, depth + 1, l.slice(), same && !same.leaf ? same.left : null);
    }
    if (!isEmpty(r)) {
      setBit(path, depth, 1);
      right = this.build(read, path, depth + 1, r.slice(), same && !same.leaf ? same.right : null);
    }
    return { hash: hash.slice(), left, right };
  }

  /** The root hash the store holds (the last commit's, or before any commit what was loaded into it). */
  private storedRootHash(): Uint8Array {
    if (this.version >= 0 && this.roots.has(this.version)) return this.roots.get(this.version)!;
    const e = this.source!.get(nodeKey(this.header, EMPTY, 0));
    return e ? hashOfEncoding(e) : EMPTY;
  }

  /** A node as of a retained version: from the records if a later commit overwrote it, else from the store. */
  private nodeAt(key: Uint8Array, version: number): Uint8Array | null {
    if (version < this.version) {
      const entries = this.history.get(str(key));
      if (entries) for (const e of entries) if (e.v > version) return e.enc;
    }
    return this.source!.get(key) ?? null;
  }

  private read(key: Uint8Array): Uint8Array | null {
    const w = this.work!.get(str(key));
    return w ? w.enc : (this.source!.get(key) ?? null);
  }

  private write(key: Uint8Array, enc: Uint8Array | null): void {
    const s = str(key);
    const w = this.work!.get(s);
    if (w) w.enc = enc;
    else this.work!.set(s, { key, enc, before: this.source!.get(key) ?? null });
  }

  private commitDropped(version: number): Uint8Array {
    this.work = new Map();
    const rootKey = nodeKey(this.header, EMPTY, 0);
    let hash = this.storedRootHash();
    // The shape depends only on the final key set, so the order the writes are applied in does not matter.
    for (const p of this.pending.values()) {
      const e = this.read(rootKey);
      hash = (p.value ? this.insertAt(0, p.keyHash, p.value, e, hash) : this.removeAt(0, p.keyHash, e, hash)).hash;
    }
    this.pending.clear();
    const keep = this.retain > 0 && this.version >= 0;
    const changes: StoreChange[] = [];
    const keys: string[] = [];
    for (const [s, w] of this.work) {
      if (bytesEqual(w.before, w.enc)) continue;
      changes.push({ key: w.key, value: w.enc });
      if (keep) {
        let entries = this.history.get(s);
        if (!entries) this.history.set(s, (entries = []));
        entries.push({ v: version, enc: w.before });
        keys.push(s);
      }
    }
    this.work = null;
    if (keys.length > 0) this.historyByVersion.set(version, keys);
    this.nodeChanges = changes;
    if (this.version < 0) this.floor = version;
    this.version = version;
    this.roots.set(version, hash.slice());
    const min = version - this.retain;
    for (const v of this.roots.keys()) if (v < min) this.roots.delete(v);
    for (const [v, list] of this.historyByVersion) {
      if (v > min) continue;
      for (const s of list) {
        const entries = this.history.get(s)!;
        while (entries.length > 0 && entries[0]!.v <= min) entries.shift();
        if (entries.length === 0) this.history.delete(s);
      }
      this.historyByVersion.delete(v);
    }
    return hash.slice();
  }

  /** Put a key into the subtree at `depth` on its path, whose root is `e` with hash `hash`, writing what changes. */
  private insertAt(depth: number, keyHash: Uint8Array, value: Uint8Array, e: Uint8Array | null, hash: Uint8Array): Sub {
    const key = nodeKey(this.header, keyHash, depth);
    if (!e) {
      const fresh = leafEncoding(keyHash, value);
      this.write(key, fresh);
      return { hash: leafHash(keyHash, value), enc: fresh };
    }
    if (e[0] === LEAF) {
      const other = e.subarray(1, 33);
      if (bytesEqual(other, keyHash)) {
        if (bytesEqual(e.subarray(33), value)) return { hash, enc: e };
        const fresh = leafEncoding(keyHash, value);
        this.write(key, fresh);
        return { hash: leafHash(keyHash, value), enc: fresh };
      }
      // Two leaves in one subtree: both move down to the first bit where they differ, inner nodes above them.
      let b = depth;
      while (b < KEY_BITS && bit(other, b) === bit(keyHash, b)) b++;
      const fresh = leafEncoding(keyHash, value);
      const freshHash = leafHash(keyHash, value);
      this.write(nodeKey(this.header, other, b + 1), e);
      this.write(nodeKey(this.header, keyHash, b + 1), fresh);
      let enc = bit(keyHash, b) ? innerEncoding(hash, freshHash) : innerEncoding(freshHash, hash);
      let h = hashOfEncoding(enc);
      this.write(nodeKey(this.header, keyHash, b), enc);
      for (let d = b - 1; d >= depth; d--) {
        enc = bit(keyHash, d) ? innerEncoding(EMPTY, h) : innerEncoding(h, EMPTY);
        h = hashOfEncoding(enc);
        this.write(nodeKey(this.header, keyHash, d), enc);
      }
      return { hash: h, enc };
    }
    const side = bit(keyHash, depth);
    const childHash = childOf(e, side);
    const child = isEmpty(childHash) ? null : this.read(nodeKey(this.header, keyHash, depth + 1));
    const sub = this.insertAt(depth + 1, keyHash, value, child, childHash);
    if (bytesEqual(sub.hash, childHash)) return { hash, enc: e };
    const enc = side ? innerEncoding(childOf(e, 0), sub.hash) : innerEncoding(sub.hash, childOf(e, 1));
    this.write(key, enc);
    return { hash: hashOfEncoding(enc), enc };
  }

  /** Take a key out of the subtree at `depth` on its path; a leaf left alone in a subtree moves up, as in memory. */
  private removeAt(depth: number, keyHash: Uint8Array, e: Uint8Array | null, hash: Uint8Array): Sub {
    if (!e) return { hash: EMPTY, enc: null };
    const key = nodeKey(this.header, keyHash, depth);
    if (e[0] === LEAF) {
      if (!bytesEqual(e.subarray(1, 33), keyHash)) return { hash, enc: e };
      this.write(key, null);
      return { hash: EMPTY, enc: null };
    }
    const side = bit(keyHash, depth);
    const childHash = childOf(e, side);
    if (isEmpty(childHash)) return { hash, enc: e };
    const childKey = nodeKey(this.header, keyHash, depth + 1);
    const sub = this.removeAt(depth + 1, keyHash, this.read(childKey), childHash);
    if (bytesEqual(sub.hash, childHash)) return { hash, enc: e };
    const otherHash = childOf(e, 1 - side);
    if (sub.enc === null) {
      if (isEmpty(otherHash)) {
        this.write(key, null);
        return { hash: EMPTY, enc: null };
      }
      // The other side, if a lone leaf, now has its prefix to itself one level up.
      const otherPath = keyHash.slice();
      setBit(otherPath, depth, 1 - side);
      const otherKey = nodeKey(this.header, otherPath, depth + 1);
      const other = this.read(otherKey);
      if (other && other[0] === LEAF) {
        this.write(otherKey, null);
        this.write(key, other);
        return { hash: otherHash.slice(), enc: other };
      }
    } else if (sub.enc[0] === LEAF && isEmpty(otherHash)) {
      this.write(childKey, null);
      this.write(key, sub.enc);
      return { hash: sub.hash, enc: sub.enc };
    }
    const enc = side ? innerEncoding(otherHash, sub.hash) : innerEncoding(sub.hash, otherHash);
    this.write(key, enc);
    return { hash: hashOfEncoding(enc), enc };
  }
}

/** The smallest key after every key that starts with `header`. */
function headerEnd(header: Uint8Array): Uint8Array {
  const end = header.slice();
  for (let i = end.length - 1; i >= 0; i--) {
    if (end[i]! < 0xff) {
      end[i]!++;
      return end.subarray(0, i + 1);
    }
  }
  throw new RangeError('a header of all 0xff bytes has no end');
}

/** Fold a proof back to a root for `key`, and say what it proves: the value, or absence (null). Undefined means the proof is malformed. */
export function smtProofRoot(key: Uint8Array, p: SmtProof): { root: Uint8Array; value: Uint8Array | null } | undefined {
  const keyHash = sha256(key);
  const depth = p.siblings.length;
  if (depth > KEY_BITS) return undefined;
  let cur: Uint8Array;
  let value: Uint8Array | null = null;
  if (p.leaf === null) cur = EMPTY;
  else if (bytesEqual(p.leaf.keyHash, keyHash)) {
    cur = leafHash(keyHash, p.leaf.value);
    value = p.leaf.value;
  } else {
    // Another key's leaf owns this subtree; it must share the path down to it.
    for (let d = 0; d < depth; d++) if (bit(p.leaf.keyHash, d) !== bit(keyHash, d)) return undefined;
    cur = leafHash(p.leaf.keyHash, p.leaf.value);
  }
  for (let d = depth - 1; d >= 0; d--) cur = bit(keyHash, d) ? innerHash(p.siblings[d]!, cur) : innerHash(cur, p.siblings[d]!);
  return { root: cur, value };
}
