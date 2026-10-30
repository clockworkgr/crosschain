/**
 * The secondary indices' disk form (STATE-PAGING.md section 4): every index
 * entry of every type is one key in the application store, written in the
 * same transaction as the objects of the version that changed it.
 *
 *   'i' type u16, index position u8, key bytes          -> id u64  (unique index)
 *   'i' type u16, index position u8, key bytes, id u64  -> empty   (non-unique index)
 *
 * The position is the index's place in its type's definition. A non-unique
 * key already ends with the id (index.ts appends it), so the entry is the
 * key the B+ tree holds with the four-byte header in front, and bytewise
 * order in the store is the order the tree keeps: a prefix scan is a range,
 * and a cursor from a start key is `scanFrom`.
 *
 * The database reads the entries through `IndexStore`, a read-only view the
 * application gives it over its store; what it writes it reports in the
 * change list of each root, and the application writes that with the rest.
 */
import { compareBytes } from '../crypto/hash.ts';
import { BPlusTree } from './bptree.ts';

/** What the database needs of the store that holds the index entries: point reads and ascending ranges. */
export interface IndexStore {
  get(key: Uint8Array): Uint8Array | undefined;
  /** Entries with start <= key < end, ascending. */
  range(start: Uint8Array, end: Uint8Array): IterableIterator<[Uint8Array, Uint8Array]>;
}

/** One index entry a root added (value) or removed (null). */
export interface IndexEntryChange {
  key: Uint8Array;
  value: Uint8Array | null;
}

export const INDEX_PREFIX = 0x69; // 'i'
/** Bytes in front of an index key: the prefix, the type, the position. */
export const INDEX_HEADER = 4;
/** A non-unique entry's value: the id is the last eight bytes of the key. */
export const EMPTY_VALUE = new Uint8Array(0);

/** The header every entry of one index starts with. */
export function indexHeader(type: number, position: number): Uint8Array {
  return Uint8Array.of(INDEX_PREFIX, type >> 8, type & 0xff, position);
}

/** The store key of an index entry: the header, then the index key. */
export function entryKey(header: Uint8Array, k: Uint8Array): Uint8Array {
  const out = new Uint8Array(header.length + k.length);
  out.set(header);
  out.set(k, header.length);
  return out;
}

/** The smallest key greater than every key with this prefix, or null when there is none (all 0xff). */
export function afterPrefix(prefix: Uint8Array): Uint8Array | null {
  for (let i = prefix.length - 1; i >= 0; i--) {
    if (prefix[i]! < 0xff) {
      const end = prefix.slice(0, i + 1);
      end[i]!++;
      return end;
    }
  }
  return null;
}

/**
 * Lay `over` on top of `base`, both ascending by key: an overlay entry replaces the base's entry at the same key,
 * a null one hides it, and everything else of both comes through in order. This is the cache-KV iterator of the
 * Cosmos SDK: one step of each cursor at a time, nothing materialised.
 */
export function* overlaid<V>(base: Iterator<[Uint8Array, V]>, over: Iterator<[Uint8Array, V | null]>): IterableIterator<[Uint8Array, V]> {
  let b = base.next();
  let o = over.next();
  try {
    while (!b.done || !o.done) {
      const c = b.done ? 1 : o.done ? -1 : compareBytes(b.value[0], o.value[0]);
      if (c < 0) {
        yield b.value as [Uint8Array, V];
        b = base.next();
        continue;
      }
      const [k, v] = o.value as [Uint8Array, V | null];
      if (v !== null) yield [k, v];
      if (c === 0) b = base.next();
      o = over.next();
    }
  } finally {
    // A caller that stops early (a page of results) closes the store's cursor too.
    if (!b.done) base.return?.();
    if (!o.done) over.return?.();
  }
}

/** Entries of an ordered map from `start` up to (not including) `end`. */
export function* until<V>(entries: Iterable<[Uint8Array, V]>, end: Uint8Array | null): IterableIterator<[Uint8Array, V]> {
  for (const e of entries) {
    if (end && compareBytes(e[0], end) >= 0) return;
    yield e;
  }
}

/**
 * An index store in memory, for a database that has no application store behind it (tests, benchmarks, a
 * snapshot being imported). It exists only while some type's trees are dropped: it is what they fall back on.
 */
export class MemoryIndexStore implements IndexStore {
  private readonly tree = new BPlusTree<Uint8Array>();

  get(key: Uint8Array): Uint8Array | undefined {
    return this.tree.get(key);
  }

  range(start: Uint8Array, end: Uint8Array): IterableIterator<[Uint8Array, Uint8Array]> {
    return until(this.tree.entriesFrom(start), end);
  }

  apply(changes: Iterable<IndexEntryChange>): void {
    for (const c of changes) {
      if (c.value) this.tree.set(c.key, c.value);
      else this.tree.delete(c.key);
    }
  }

  get size(): number {
    return this.tree.size;
  }
}
