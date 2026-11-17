/**
 * LMDB through lmdb-js: the on-disk key-value store. It is memory mapped, so
 * reads are synchronous and copy only the value out; keys are compared
 * bytewise; a transaction commits and syncs before transactionSync returns;
 * a transaction can span every database of the environment (state sync
 * installs a snapshot into the application and chain stores in one); and a
 * second process could open the same environment read-only (the CLI did
 * once; it now reads through the RPC).
 */
import { mkdirSync } from 'node:fs';
import { open, type Database, type RootDatabase } from 'lmdb';
import { StoreReadOnlyError, type KvEnv, type KvStore, type KvWriter } from './kv.ts';

function buf(b: Uint8Array): Buffer {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
}

/** What a store of a closed environment answers every call with. */
export class StoreClosedError extends Error {
  constructor() {
    super('the store is closed');
    this.name = 'StoreClosedError';
  }
}

class LmdbStore implements KvStore {
  private readonly db: Database<Buffer, Buffer>;
  /** Throws once the environment is closed: work that outlived a stop fails here, in JavaScript, and not in the native library on memory that is gone. */
  private readonly open: () => void;
  private readonly readOnly: boolean;

  constructor(db: Database<Buffer, Buffer>, open: () => void, readOnly: boolean) {
    this.db = db;
    this.open = open;
    this.readOnly = readOnly;
  }

  get(key: Uint8Array): Uint8Array | undefined {
    this.open();
    const v = this.db.get(buf(key));
    return v === undefined ? undefined : new Uint8Array(v);
  }

  *range(start: Uint8Array, end: Uint8Array): IterableIterator<[Uint8Array, Uint8Array]> {
    this.open();
    const it = this.db.getRange({ start: buf(start), end: buf(end) })[Symbol.iterator]();
    try {
      for (;;) {
        // Before every step, not only the first: a caller that keeps an iteration across a wait must not move a
        // cursor of an environment closed meanwhile.
        this.open();
        const step = it.next();
        if (step.done) return;
        yield [new Uint8Array(step.value.key), new Uint8Array(step.value.value)];
      }
    } finally {
      // Left early: the cursor is given back, unless the environment went first and took it along.
      try {
        this.open();
        it.return?.();
      } catch {
        // Closed: nothing of the cursor is left to release.
      }
    }
  }

  write(fn: (w: KvWriter) => void): void {
    this.open();
    if (this.readOnly) throw new StoreReadOnlyError();
    // The writer is good for the callback and no longer: kept and used later, it would write outside a transaction.
    let live = true;
    const use = (): void => {
      if (!live) throw new Error('a store writer was used after its write() returned');
      this.open();
    };
    try {
      this.db.transactionSync(() => {
        fn({
          put: (k, v) => {
            use();
            void this.db.put(buf(k), buf(v));
          },
          del: (k) => {
            use();
            void this.db.remove(buf(k));
          },
        });
      });
    } finally {
      live = false;
    }
  }
}

export class LmdbEnv implements KvEnv {
  private readonly root: RootDatabase<Buffer, Buffer>;
  private readonly readOnly: boolean;

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    this.readOnly = opts.readOnly ?? false;
    if (!this.readOnly) mkdirSync(path, { recursive: true });
    this.root = open<Buffer, Buffer>({ path, keyEncoding: 'binary', encoding: 'binary', readOnly: this.readOnly });
  }

  store(name: string): KvStore {
    // A read-only environment cannot create a database: asked for one that is not there, lmdb-js hands back
    // undefined, and the first read would fail far from here with nothing to say why.
    this.assertOpen();
    const db = this.root.openDB<Buffer, Buffer>({ name, keyEncoding: 'binary', encoding: 'binary' }) as Database<Buffer, Buffer> | undefined;
    if (!db) throw new Error(`the store has no database named ${name}${this.readOnly ? ', and a read-only environment cannot create it' : ''}`);
    return new LmdbStore(db, this.assertOpen, this.readOnly);
  }

  transaction(fn: () => void): void {
    // A store's write() inside the callback runs as a child of this transaction, whatever database it is on; a throw
    // out of the callback aborts the lot, and nothing reaches the disk until the callback returns.
    this.assertOpen();
    this.root.transactionSync(fn);
  }

  private closing: Promise<void> | null = null;

  /** From the moment close() is called, not from when it is done: nothing new is begun on an environment going away. */
  private readonly assertOpen = (): void => {
    if (this.closing) throw new StoreClosedError();
  };

  /**
   * Closing twice is closing once: a node closes the store of a directory it claimed, and its owner may close it
   * again. Every caller waits for the one close, so none goes on as if the store were shut while it still is not.
   */
  close(): Promise<void> {
    return (this.closing ??= this.root.close());
  }
}
