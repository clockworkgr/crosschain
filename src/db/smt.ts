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
 */
import { bytesEqual, sha256 } from '../crypto/hash.ts';
import { EMPTY, innerHash, leafHash } from './merkle.ts';

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

  constructor(retainVersions = 0) {
    this.retain = Math.max(0, retainVersions);
  }

  get currentVersion(): number {
    return this.version;
  }

  get lowestVersion(): number {
    return this.retain > 0 ? Math.max(0, this.version - this.retain) : this.version;
  }

  set(key: Uint8Array, value: Uint8Array): void {
    this.root = insert(this.root, sha256(key), value, 0);
  }

  delete(key: Uint8Array): void {
    this.root = remove(this.root, sha256(key), 0);
  }

  get(key: Uint8Array): Uint8Array | undefined {
    const keyHash = sha256(key);
    let n = this.root;
    for (let d = 0; n && !n.leaf; d++) n = bit(keyHash, d) ? n.right : n.left;
    return n && bytesEqual(n.leaf!.keyHash, keyHash) ? n.leaf!.value.slice() : undefined;
  }

  rootHash(): Uint8Array {
    return (this.root?.hash ?? EMPTY).slice();
  }

  /** Remember the current contents as `version`. Versions must increase. */
  commit(version: number): Uint8Array {
    if (version <= this.version) throw new Error(`version ${version} is not after ${this.version}`);
    this.version = version;
    this.versions.set(version, this.root);
    for (const v of this.versions.keys()) if (v < version - this.retain) this.versions.delete(v);
    return this.rootHash();
  }

  private rootOf(version: number): Node | null {
    if (version > this.version || version < this.lowestVersion || !this.versions.has(version)) {
      throw new RangeError(`version ${version} is not available (have ${this.lowestVersion}..${this.version})`);
    }
    return this.versions.get(version)!;
  }

  rootAt(version: number): Uint8Array {
    return (this.rootOf(version)?.hash ?? EMPTY).slice();
  }

  /** Membership or absence proof for a key as of a version. Every buffer in it is a copy; the tree's own stay untouched. */
  proveAt(key: Uint8Array, version: number): SmtProof {
    const keyHash = sha256(key);
    const siblings: Uint8Array[] = [];
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
