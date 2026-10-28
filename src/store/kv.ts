/**
 * The key-value store behind everything that is persisted: committed blocks,
 * chain state, validator sets, and the application's objects. One small
 * interface, two implementations. In memory it is a B+ tree, the same one
 * the secondary indices use; on disk it is LMDB (lmdb.ts).
 *
 * Keys are byte strings ordered bytewise (see db/keys.ts for the encoding
 * rules), so a prefix scan is a range. Every write happens inside write(),
 * which is atomic and, on disk, durable before it returns. The whole
 * interface is synchronous because the state machine is: a block is applied
 * in one go, with no await between its first write and its last.
 */
import { compareBytes } from '../crypto/hash.ts';
import { BPlusTree } from '../db/bptree.ts';

export interface KvWriter {
  put(key: Uint8Array, value: Uint8Array): void;
  del(key: Uint8Array): void;
}

export interface KvStore {
  get(key: Uint8Array): Uint8Array | undefined;
  /** Entries with start <= key < end, ascending. */
  range(start: Uint8Array, end: Uint8Array): IterableIterator<[Uint8Array, Uint8Array]>;
  /** All writes made in the callback land together, or not at all. */
  write(fn: (w: KvWriter) => void): void;
}

/** A set of named stores sharing one environment, so a node keeps one directory. */
export interface KvEnv {
  store(name: string): KvStore;
  /**
   * Run writes to several stores of this environment as one transaction: on
   * disk they all land or none does, whatever happens in between. In memory
   * each store's write lands on its own; there is no crash to recover from.
   */
  transaction(fn: () => void): void;
  close(): Promise<void>;
}

/** The smallest key greater than every key with this prefix. */
export function prefixEnd(prefix: Uint8Array): Uint8Array {
  const end = prefix.slice();
  for (let i = end.length - 1; i >= 0; i--) {
    if (end[i]! < 0xff) {
      end[i]!++;
      return end.subarray(0, i + 1); // bytes after the carry would admit shorter keys that are not prefixed
    }
  }
  throw new RangeError('prefix of all 0xff bytes has no end');
}

export class MemoryKv implements KvStore {
  private readonly tree = new BPlusTree<Uint8Array>();

  get(key: Uint8Array): Uint8Array | undefined {
    return this.tree.get(key)?.slice(); // a copy, as LMDB gives one: the store's bytes are not the caller's to change
  }

  *range(start: Uint8Array, end: Uint8Array): IterableIterator<[Uint8Array, Uint8Array]> {
    for (const e of this.tree.entriesFrom(start)) {
      if (compareBytes(e[0], end) >= 0) return;
      yield [e[0].slice(), e[1].slice()];
    }
  }

  write(fn: (w: KvWriter) => void): void {
    // Buffer the writes so a throw inside fn leaves the store untouched.
    const puts: [Uint8Array, Uint8Array][] = [];
    const dels: Uint8Array[] = [];
    fn({ put: (k, v) => void puts.push([k.slice(), v.slice()]), del: (k) => void dels.push(k.slice()) });
    for (const k of dels) this.tree.delete(k);
    for (const [k, v] of puts) this.tree.set(k, v);
  }

  get size(): number {
    return this.tree.size;
  }
}

export class MemoryEnv implements KvEnv {
  private readonly stores = new Map<string, MemoryKv>();

  store(name: string): KvStore {
    let s = this.stores.get(name);
    if (!s) this.stores.set(name, (s = new MemoryKv()));
    return s;
  }

  transaction(fn: () => void): void {
    fn();
  }

  async close(): Promise<void> {}
}
