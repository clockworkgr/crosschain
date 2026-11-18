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
  /**
   * All writes made in the callback land together, or not at all. A read made inside the callback sees what the
   * callback has written so far.
   */
  write(fn: (w: KvWriter) => void): void;
  /** Whether the key is there, without its value being read; a store without it is asked with get. */
  has?(key: Uint8Array): boolean;
}

/** A set of named stores sharing one environment, so a node keeps one directory. */
export interface KvEnv {
  store(name: string): KvStore;
  /**
   * Run writes to several stores of this environment as one transaction: on
   * disk they all land or none does, whatever happens in between. In memory
   * there is no crash to recover from, but a throw out of `fn` still undoes
   * what the stores took inside it.
   */
  transaction(fn: () => void): void;
  close(): Promise<void>;
}

/** What write() throws on a store opened read-only: the one failure of a write that a reader of the store can go on from. */
export class StoreReadOnlyError extends Error {
  constructor() {
    super('the store is read-only');
    this.name = 'StoreReadOnlyError';
  }
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

  has(key: Uint8Array): boolean {
    return this.tree.has(key);
  }

  /** Counts the changes made to the tree, so that a range in progress knows to find its place again. */
  private version = 0;

  *range(start: Uint8Array, end: Uint8Array): IterableIterator<[Uint8Array, Uint8Array]> {
    // The caller may write between two steps, as it may on LMDB, and the tree's own iteration does not survive a
    // change to the tree. So after a step during which the tree changed, the place is found again from the last
    // key given, and what was put or deleted ahead of it is seen as it now is.
    for (let from = start; ; ) {
      const version = this.version;
      let last: Uint8Array | null = null;
      for (const e of this.tree.entriesFrom(from)) {
        if (compareBytes(e[0], end) >= 0) return;
        last = e[0]; // the tree's own key, which nothing changes
        yield [e[0].slice(), e[1].slice()];
        if (this.version !== version) break;
        last = null;
      }
      if (!last) return;
      from = new Uint8Array(last.length + 1); // the smallest key after the last one given
      from.set(last);
    }
  }

  /** The environment this store is one of, if any: a write to the store is then a transaction of the environment. */
  private readonly env: Pick<KvEnv, 'transaction'> | null;

  constructor(env: Pick<KvEnv, 'transaction'> | null = null) {
    this.env = env;
  }

  write(fn: (w: KvWriter) => void): void {
    // On LMDB a write to one store is a transaction of the whole environment: whatever is written to the other
    // stores while it runs, by a transaction begun inside it say, is undone with it. So it is here.
    if (this.env) this.env.transaction(() => this.apply(fn));
    else this.apply(fn);
  }

  private apply(fn: (w: KvWriter) => void): void {
    // Each write is applied as it is made, so that a read inside the callback sees it, as on LMDB, and what the key
    // held before is kept: a throw inside fn puts everything back. Inside an environment's transaction the same
    // record lets the transaction be undone.
    const outer = this.undo;
    const undo = outer ?? (this.undo = []);
    const mark = undo.length;
    const set = (k: Uint8Array, v: Uint8Array | null): void => {
      const key = k.slice();
      undo.push([key, this.tree.get(key) ?? null]);
      this.version++;
      if (v) this.tree.set(key, v.slice());
      else this.tree.delete(key);
    };
    try {
      fn({ put: (k, v) => set(k, v), del: (k) => set(k, null) });
    } catch (e) {
      this.rollbackTo(mark);
      throw e;
    } finally {
      if (!outer) this.undo = null;
    }
  }

  private undo: [Uint8Array, Uint8Array | null][] | null = null;

  /** Start keeping what writes replace. */
  begin(): void {
    this.undo = [];
  }

  /** How much has been kept so far: a place a transaction inside this one can go back to. */
  mark(): number {
    return this.undo?.length ?? 0;
  }

  /** Put back everything written since `mark`, newest first. */
  rollbackTo(mark: number): void {
    const undo = this.undo;
    if (!undo) return;
    for (let i = undo.length - 1; i >= mark; i--) {
      const [k, v] = undo[i]!;
      this.version++;
      if (v) this.tree.set(k, v);
      else this.tree.delete(k);
    }
    undo.length = mark;
  }

  /** Stop keeping it; with `rollback`, first put everything back. */
  end(rollback: boolean): void {
    if (rollback) this.rollbackTo(0);
    this.undo = null;
  }

  get size(): number {
    return this.tree.size;
  }
}

export class MemoryEnv implements KvEnv {
  private readonly stores = new Map<string, MemoryKv>();

  store(name: string): KvStore {
    let s = this.stores.get(name);
    if (!s) {
      this.stores.set(name, (s = new MemoryKv(this)));
      if (this.depth > 0) s.begin(); // first asked for inside a transaction: part of it
    }
    return s;
  }

  private depth = 0;

  /**
   * All the stores' writes inside `fn`, or none of them if it throws: the same promise the disk environment makes.
   * A transaction inside another is part of it, and if it throws, its own writes are undone there and then, so an
   * outer one that catches the error and goes on keeps only what it wrote itself.
   */
  transaction(fn: () => void): void {
    if (this.depth > 0) {
      const marks = new Map([...this.stores.values()].map((s) => [s, s.mark()]));
      this.depth++;
      try {
        fn();
      } catch (e) {
        // A store first asked for inside has no mark: all it holds of this transaction goes.
        for (const s of this.stores.values()) s.rollbackTo(marks.get(s) ?? 0);
        throw e;
      } finally {
        this.depth--;
      }
      return;
    }
    this.depth++;
    for (const s of this.stores.values()) s.begin();
    let failed = true;
    try {
      fn();
      failed = false;
    } finally {
      this.depth--;
      for (const s of this.stores.values()) s.end(failed);
    }
  }

  async close(): Promise<void> {}
}
