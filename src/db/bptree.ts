/**
 * A B+ tree over byte keys: the ordered map behind every secondary index,
 * and the in-memory key-value store. Fan-out 32, keys in sorted arrays
 * inside each node, binary search at every level. For a million keys that
 * is four levels and a handful of array moves per insert, where a single
 * sorted array would move the whole tail.
 *
 * Leaves hold keys and values; inner nodes hold separators and children,
 * with child i covering keys in [separator i-1, separator i). Leaves carry
 * no sibling pointers: iteration keeps a stack of (inner node, child index)
 * instead, which makes removing a leaf a local operation.
 *
 * Deletion merges an underfull node with a neighbour when both fit in one
 * node, and drops a node that becomes empty. It does not borrow single
 * entries, so fill can degrade under adversarial patterns; correctness and
 * logarithmic depth do not.
 */
import { compareBytes } from '../crypto/hash.ts';
import { startsWith } from './keys.ts';

export const FANOUT = 32;
const MIN_FILL = FANOUT >> 1;

interface LeafNode<V> {
  leaf: true;
  keys: Uint8Array[];
  values: V[];
}

interface InnerNode<V> {
  leaf: false;
  /** keys.length === children.length - 1 */
  keys: Uint8Array[];
  children: BNode<V>[];
}

type BNode<V> = LeafNode<V> | InnerNode<V>;

/** First index with keys[i] >= k. */
function lowerBound(keys: Uint8Array[], k: Uint8Array): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(keys[mid]!, k) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the child that covers k: the number of separators <= k. */
function childIndex<V>(n: InnerNode<V>, k: Uint8Array): number {
  let lo = 0;
  let hi = n.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(n.keys[mid]!, k) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function emptyLeaf<V>(): LeafNode<V> {
  return { leaf: true, keys: [], values: [] };
}

export class BPlusTree<V> {
  private root: BNode<V> = emptyLeaf();
  private count = 0;

  get size(): number {
    return this.count;
  }

  private findLeaf(k: Uint8Array): LeafNode<V> {
    let n = this.root;
    while (!n.leaf) n = n.children[childIndex(n, k)]!;
    return n;
  }

  get(k: Uint8Array): V | undefined {
    const leaf = this.findLeaf(k);
    const i = lowerBound(leaf.keys, k);
    return i < leaf.keys.length && compareBytes(leaf.keys[i]!, k) === 0 ? leaf.values[i] : undefined;
  }

  has(k: Uint8Array): boolean {
    return this.get(k) !== undefined;
  }

  /** Insert, or replace the value of an existing key. */
  set(k: Uint8Array, v: V): void {
    const split = this.insert(this.root, k, v);
    if (split) this.root = { leaf: false, keys: [split.key], children: [this.root, split.node] };
  }

  /** Returns the new right sibling and the first key it covers if the node split. */
  private insert(n: BNode<V>, k: Uint8Array, v: V): { key: Uint8Array; node: BNode<V> } | null {
    if (n.leaf) {
      const i = lowerBound(n.keys, k);
      if (i < n.keys.length && compareBytes(n.keys[i]!, k) === 0) {
        n.values[i] = v;
        return null;
      }
      n.keys.splice(i, 0, k);
      n.values.splice(i, 0, v);
      this.count++;
      if (n.keys.length <= FANOUT) return null;
      // Appending in key order (the common case for ids and timestamps) keeps the left leaf full.
      const mid = i === n.keys.length - 1 ? n.keys.length - 2 : n.keys.length >> 1;
      const right: LeafNode<V> = { leaf: true, keys: n.keys.splice(mid), values: n.values.splice(mid) };
      return { key: right.keys[0]!, node: right };
    }
    const ci = childIndex(n, k);
    const split = this.insert(n.children[ci]!, k, v);
    if (!split) return null;
    n.keys.splice(ci, 0, split.key);
    n.children.splice(ci + 1, 0, split.node);
    if (n.children.length <= FANOUT) return null;
    const mid = n.children.length >> 1;
    const promoted = n.keys[mid - 1]!;
    const right: InnerNode<V> = { leaf: false, keys: n.keys.splice(mid), children: n.children.splice(mid) };
    n.keys.length = mid - 1;
    return { key: promoted, node: right };
  }

  delete(k: Uint8Array): boolean {
    const removed = this.remove(this.root, k);
    if (removed && !this.root.leaf && this.root.children.length === 1) this.root = this.root.children[0]!;
    return removed;
  }

  private remove(n: BNode<V>, k: Uint8Array): boolean {
    if (n.leaf) {
      const i = lowerBound(n.keys, k);
      if (i >= n.keys.length || compareBytes(n.keys[i]!, k) !== 0) return false;
      n.keys.splice(i, 1);
      n.values.splice(i, 1);
      this.count--;
      return true;
    }
    const ci = childIndex(n, k);
    if (!this.remove(n.children[ci]!, k)) return false;
    this.rebalance(n, ci);
    return true;
  }

  private static fill<V>(n: BNode<V>): number {
    return n.leaf ? n.keys.length : n.children.length;
  }

  /** After a removal below child ci: drop it if empty, else merge it with a neighbour when they fit. */
  private rebalance(n: InnerNode<V>, ci: number): void {
    const child = n.children[ci]!;
    const fill = BPlusTree.fill(child);
    if (fill >= MIN_FILL) return;
    if (fill === 0 && n.children.length > 1) {
      n.children.splice(ci, 1);
      n.keys.splice(ci > 0 ? ci - 1 : 0, 1);
      return;
    }
    if (ci + 1 < n.children.length && this.merge(n, ci)) return;
    if (ci > 0) this.merge(n, ci - 1);
  }

  /** Merge children li and li+1 into li if everything fits in one node. */
  private merge(n: InnerNode<V>, li: number): boolean {
    const l = n.children[li]!;
    const r = n.children[li + 1]!;
    if (l.leaf && r.leaf) {
      if (l.keys.length + r.keys.length > FANOUT) return false;
      l.keys.push(...r.keys);
      l.values.push(...r.values);
    } else if (!l.leaf && !r.leaf) {
      if (l.children.length + r.children.length > FANOUT) return false;
      l.keys.push(n.keys[li]!, ...r.keys);
      l.children.push(...r.children);
    } else return false;
    n.keys.splice(li, 1);
    n.children.splice(li + 1, 1);
    return true;
  }

  /** Every entry with key >= start, ascending. */
  *entriesFrom(start: Uint8Array): IterableIterator<[Uint8Array, V]> {
    const stack: [InnerNode<V>, number][] = [];
    let n = this.root;
    while (!n.leaf) {
      const ci = childIndex(n, start);
      stack.push([n, ci]);
      n = n.children[ci]!;
    }
    let leaf: LeafNode<V> | null = n;
    let i = lowerBound(leaf.keys, start);
    while (leaf) {
      for (; i < leaf.keys.length; i++) yield [leaf.keys[i]!, leaf.values[i]!];
      // Climb to the first ancestor with a next child, then descend to its leftmost leaf.
      leaf = null;
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        if (frame[1] + 1 < frame[0].children.length) {
          frame[1]++;
          let d: BNode<V> = frame[0].children[frame[1]]!;
          while (!d.leaf) {
            stack.push([d, 0]);
            d = d.children[0]!;
          }
          leaf = d;
          i = 0;
          break;
        }
        stack.pop();
      }
    }
  }

  /** Every entry whose key is at or after `start`, in key order: the way to resume a listing from a cursor. */
  *scanFrom(start: Uint8Array): IterableIterator<[Uint8Array, V]> {
    yield* this.entriesFrom(start);
  }

  /** Every entry whose key starts with the prefix, in key order. An empty prefix scans everything. */
  *scan(prefix: Uint8Array): IterableIterator<[Uint8Array, V]> {
    for (const e of this.entriesFrom(prefix)) {
      if (!startsWith(e[0], prefix)) return;
      yield e;
    }
  }

  clear(): void {
    this.root = emptyLeaf();
    this.count = 0;
  }
}
