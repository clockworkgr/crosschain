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
import type { KvEnv, KvStore, KvWriter } from './kv.ts';

function buf(b: Uint8Array): Buffer {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
}

class LmdbStore implements KvStore {
  private readonly db: Database<Buffer, Buffer>;

  constructor(db: Database<Buffer, Buffer>) {
    this.db = db;
  }

  get(key: Uint8Array): Uint8Array | undefined {
    const v = this.db.get(buf(key));
    return v === undefined ? undefined : new Uint8Array(v);
  }

  *range(start: Uint8Array, end: Uint8Array): IterableIterator<[Uint8Array, Uint8Array]> {
    for (const { key, value } of this.db.getRange({ start: buf(start), end: buf(end) })) yield [new Uint8Array(key), new Uint8Array(value)];
  }

  write(fn: (w: KvWriter) => void): void {
    this.db.transactionSync(() => {
      fn({
        put: (k, v) => void this.db.put(buf(k), buf(v)),
        del: (k) => void this.db.remove(buf(k)),
      });
    });
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
    return new LmdbStore(this.root.openDB<Buffer, Buffer>({ name, keyEncoding: 'binary', encoding: 'binary' }));
  }

  transaction(fn: () => void): void {
    // A store's write() inside the callback runs as a child of this transaction, whatever database it is on; a throw
    // out of the callback aborts the lot, and nothing reaches the disk until the callback returns.
    this.root.transactionSync(fn);
  }

  async close(): Promise<void> {
    await this.root.close();
  }
}
