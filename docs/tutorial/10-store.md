# 10. The store

This chapter covers `src/store/`: the small key-value interface that everything persistent is written through, its two implementations (a B+ tree in memory and LMDB on disk), the block store that keeps committed blocks, commits, chain state and validator sets on top of it, and the atomic file write used for the few things that are files rather than records. It sits below [the node](08-node.md), which opens one environment per data directory and hands a named store to the block executor and another to the application; below [the object database](09-database.md), whose change lists and history records are what the application writes here; and below [the application](11-application.md), which defines the key layout of its own store. The codec of [chapter 1](01-codec.md) supplies every value's bytes and `src/db/keys.ts` supplies the key encoding; the block and state encodings come from [chapter 3](03-types.md). The double-sign guard of [consensus](04-consensus.md) and the keystore of [the wallet](14-wallet-cli.md) use the file writer.

## Concepts

### A key-value store

A key-value store maps byte strings to byte strings. There is no schema: a "table" is a prefix byte, a "row" is a key with that prefix, and relationships are encoded into keys. That is enough for a blockchain node because every record it keeps is addressed by something small and fixed (a height, a hash, an object id), and because the state machine, not the store, decides what is consistent. While every tier of the state is in memory, nothing is read back to make a decision during block execution, and the store is a durable copy plus the records needed to restart. Execution does read the store for a tier that is not in memory. A node leaves its secondary index trees in the store by default ([chapter 8](08-node.md)), so a uniqueness check or a lookup by key during a block is a store read behind an overlay of the writes since the last commit, and the same holds for Merkle tree nodes once the trees are dropped and for object bytes the arena has released ([chapter 9](09-database.md)). Such a read returns what the last commit wrote, so the outcome is the one a resident state gives.

The one property the store adds to a plain map is order. Keys are compared bytewise, and the interface exposes `range(start, end)` over `start <= key < end` in ascending order. Combined with the encoding rules of `src/db/keys.ts` (big-endian integers, zero-terminated strings, prefix bytes first), a prefix scan is a range: everything under prefix p lies in `[p, prefixEnd(p))`, where `prefixEnd` is the smallest key greater than every key starting with p. "Every history record" or "every object" is one such scan.

Worked example: the application store's layout, from the top of `src/app/core/app.ts`, is `'m'` meta (height and app hash), `'o' || id` one object, `'c' || type` one counter, `'h' || version` one history record, `'l' || place` one account history entry at its place in the log, `'p' || account` that account's count and the place of its newest entry, `'L'` the log's length and how much of it the stored `'p'` entries cover, `'s'` and `'k'` for snapshot manifests and chunks, and the three prefixes the object database's own files define for the tiers the memory guard can drop (STATE-PAGING.md sections 4 and 5): `'i' || type || position || key` one secondary index entry, `'t' || tree || level || chunk` one chunk of a dense Merkle tree, `'n' || type || position || path` one node of a sparse Merkle tree. Reopening the database is a range over `'o'`, one `get` per counter, a range over `'i'` for the indices and over `'t'` and `'n'` for the trees, and a range over `'h'`; chapter 11 has the full table. The restart test in `test/app.test.ts` reads the history keys back with `store.range(new Uint8Array([0x68]), prefixEnd(new Uint8Array([0x68])))` and expects versions 4 to 7 after the window has slid.

### Atomic writes

The interface has one write path: `write(fn)`, which hands a writer with `put` and `del` to a callback and commits everything the callback did together, or nothing. Commit in [the application](11-application.md) is one `write`: every changed object, the index entries the block added and removed, the Merkle tree chunks and nodes it changed, the moved counters, the history record, the deletion of the record that left the window, and the height with its app hash. Either all of it is on disk when the block is reported committed, or none of it is and the node replays the block on restart through the `info()` handshake described in DESIGN.md section 6. The block store likewise saves a block, its hash index entry, its transaction index entries and its results in one `write`, and offers `batch(fn)` so that several saves share one. DESIGN.md section 4 fixes the persistence order on commit: finalize in memory, then the block with its commit, results, the next validator set and the new chain state, then the application's commit with the objects that changed. A node that created its own application runs the last two inside one transaction of the environment, so a block costs one flush to the device; an application that keeps its state elsewhere commits in a transaction of its own after the chain store's. Either way the executor keeps the chain store's step to one transaction by saving the block with its results, the next validator set by hash and by height, and the new chain state inside a single batch. Review finding 39 in REVIEW-2026-10-28.md is what that fixes: those four saves used to be four transactions, so a crash between them could leave a block and its transaction index entries on disk without the state that goes with them.

The interface is synchronous on purpose. The header of `src/store/kv.ts` puts it this way: the state machine is synchronous, a block is applied in one go with no `await` between its first write and its last. A store that returned promises would let other work interleave with a half-applied block, and would make the ordering of writes and reads inside `commit` a matter of scheduling rather than of code.

### LMDB and memory mapping

The on-disk implementation is LMDB (the Lightning Memory-Mapped Database from Symas, written for OpenLDAP), through the `lmdb` package (lmdb-js). LMDB is a B+ tree stored in a file that the process maps into its address space. Four consequences matter here, all named in the header of `src/store/lmdb.ts`:

- Reads are synchronous and cheap. A `get` walks tree pages that are ordinary memory; no system call, no read buffer, and the only copy is the value itself being copied out of the map so the caller holds stable bytes. There is no cache to warm other than the operating system's page cache.
- Keys are compared bytewise, the same order the in-memory store and `src/db/keys.ts` assume.
- A transaction commits and syncs before `transactionSync` returns. LMDB writes modified pages copy-on-write and flips a meta page at commit, so a crash in the middle of a transaction leaves the previous state intact; with the sync, a transaction that returned is on disk. Readers never block a writer and a writer never blocks readers: each reader sees the tree as of the last commit when it started.
- A transaction can span every database of the environment. The named stores are sub-databases of one root, and a write transaction opened on the root encloses whatever the stores write inside it, so state sync can install a snapshot into the application store and the chain store in one (chapter 7): either the join is complete on disk or none of it is.

A fifth consequence is operational: a second process could open the same environment read-only, which `LmdbEnv` supports with `{ readOnly: true }` and `test/store.test.ts` exercises. The header puts it in the past tense, "the CLI did once; it now reads through the RPC": RPC-SYNC-PROOFS.md section 1 lists the removal of read-only store access from the CLI, and today `src/cli.ts` opens no environment at all: `start` passes `dataDir` to `Node.create`, and the node claims the directory and then opens LMDB, read-write, in the line quoted below. The in-memory implementation exists so that tests and the in-process localnet run without a disk, and so that the two can be checked against each other: `test/store.test.ts` runs the same exercise on both.

An environment is one directory and can hold several named stores. The node opens one environment and takes `chain` for the block store and `app` for the application, so a data directory is one LMDB directory:

```ts
      this.env = env = cfg.env ?? (cfg.dataDir ? new LmdbEnv(join(cfg.dataDir, 'lmdb')) : new MemoryEnv());
      this.ownsEnv = !cfg.env;
      this.store = new KvBlockStore(this.env.store('chain'));
```

README.md puts numbers on the disk side: a 500-transfer block commits in 9.9 ms to LMDB against 3.4 ms to memory; a 1 GB genesis occupies 958 MiB of LMDB (1,464 MiB with one snapshot); eight blocks of 2,400 scattered transfers grow it by 31 MiB.

### What the block store keeps

Blocks and their commits by height, so the chain can be replayed and served; a hash-to-height index, so a block can be found by hash; chain state (the current height, hashes and validator sets around it); validator sets by hash and by the height they sign; the lowest height held; a transaction index by hash with the outcome; the execution results of each block; and, on a node that joined by state sync, headers kept without their block for the heights below its lowest block, as far back as evidence may reach, with the lowest such height.

Validator sets are stored by hash rather than only by height because they rarely change and each one can be large: 1,313 bytes of tagged public key per validator on an ML-DSA-44 chain, which the header of `src/store/blockstore.ts` rounds to 1.3 KB (34 bytes on a secp256k1 chain, where the sets are small but the reasoning is the same). A header names its set by hash, so the set that signed any past height is two lookups away, which is what evidence verification needs. A set by hash is removed once pruning has left no header that names it and the chain state does not hold it either ([chapter 5](05-mempool-executor.md)). Sets are also stored by the height they sign, with proposer priorities, because a node that joins by state sync must continue consensus with the exact priorities the chain had (RPC-SYNC-PROOFS.md, sections 1 and 4.2); the hash excludes priorities, so the by-hash copy cannot supply them. The same record answers the executor's `validatorSetAtHeight` for a past height ([chapter 5](05-mempool-executor.md)), which asks by height first and by hash only when that record is gone: the copy by hash is written again whenever a later height has the same set, so its proposer is a later height's. The executor's `hasProposerAt(h)` says whether the record of the height answers, and where only the copy by hash does the RPC's `validators` method gives `proposer: null` ([chapter 12](12-rpc.md)).

The transaction index and the per-block results are derived data outside the state root (RPC-SYNC-PROOFS.md section 2.3): replay or backfill rebuilds them. The lowest height is what retention moves: after each commit the executor deletes blocks below `lastHeight - blocks`, never below the newest snapshot nor into the evidence window (a block whose time is within the evidence age of the latest block stays), and records where the contiguous range now starts.

The header records answer a question a state-synced node could not otherwise answer. A block after the join may carry evidence of a double sign at any height within the evidence age, and applying it takes the validator set that header names and the time of that height, which every other node reads from its own blocks. State sync therefore fetches the headers below its snapshot height, each bound to the one above it by its hash, and stores them alone (chapter 7); the executor reads them where it would read a block's header, and prunes them as the evidence window moves on. Backfill replaces each one with its block. The records are contiguous from the lowest header height up to the lowest block.

### Atomic file replacement

Two things are files rather than records: the double-sign guard's record of what the validator last signed, and the wallet's keystore. Both must never be half-written. The standard recipe is to write the new content to a temporary file, `fsync` it, rename it over the old name (a rename is atomic on POSIX file systems), and then `fsync` the directory so the rename itself reaches the disk. Without the last step a power loss can bring the old file back after the new one was already acted on; for the signing guard that would mean a validator forgetting a signature it broadcast, and signing a conflicting one after restart. That was review finding 16 in REVIEW-2026-10-28.md, and finding 26 (the keystore truncating and rewriting its only file, so an interrupted `add` could destroy every stored key) was fixed by routing the keystore through the same function.

## The code, file by file

### src/store/kv.ts

Purpose: the interface, the in-memory implementation, and the prefix helper.

Exports:

- `interface KvWriter { put(key, value); del(key) }`: what a `write` callback receives.
- `interface KvStore { get(key); range(start, end); write(fn) }`: one named store. `range` yields `[key, value]` pairs with `start <= key < end`, ascending.
- `interface KvEnv { store(name); transaction(fn); close() }`: a set of named stores sharing one environment. `transaction(fn)` runs writes to several stores of the environment as one transaction: on disk they all land or none does, whatever happens in between; in memory "there is no crash to recover from, but a throw out of `fn` still undoes what the stores took inside it". `close` is the only asynchronous method, because closing LMDB is.
- `prefixEnd(prefix)`: the exclusive upper bound of a prefix scan.
- `class MemoryKv implements KvStore` and `class MemoryEnv implements KvEnv`.

`prefixEnd` increments the last byte that is not `0xff` and drops every byte after it:

```ts
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
```

For the prefix `68` (the history records of the application store) the end is `69`; for `62 ff` it is the single byte `63`. The trailing `ff` is dropped rather than zeroed because of how a shorter key sorts: `63` is less than `63 00`, so a range ending at `63 00` would include the one-byte key `63`, which does not start with `62 ff`. Any byte left after the incremented one has the same effect, which is what the comment in the loop says, so the end is cut at the carry. A prefix of nothing but `0xff` bytes has no key above it and is refused rather than silently scanning to the end. The copy at the top means the caller's prefix is never modified.

`MemoryKv` is a `BPlusTree<Uint8Array>` from `src/db/bptree.ts`, the same tree the secondary indices use. `get` is the tree's `get` with the value copied; `range` is `entriesFrom` cut off at `end`, with every key and value copied on the way out:

```ts
  get(key: Uint8Array): Uint8Array | undefined {
    return this.tree.get(key)?.slice(); // a copy, as LMDB gives one: the store's bytes are not the caller's to change
  }

  *range(start: Uint8Array, end: Uint8Array): IterableIterator<[Uint8Array, Uint8Array]> {
    for (const e of this.tree.entriesFrom(start)) {
      if (compareBytes(e[0], end) >= 0) return;
      yield [e[0].slice(), e[1].slice()];
    }
  }
```

The copies are what make the memory store a faithful stand-in for LMDB. The tree holds its keys and values by reference, so handing them out would let a caller change the store's own bytes in place, and a key mutated after it was returned would corrupt the tree's order. LMDB copies every value out of its map (see below), so a caller can never do that on disk; without the copies here, code that mutated what it read would pass every test on the memory store and fail on a real node. Reading is the common operation and the copies cost a little, but the two backends behaving the same is worth more than the allocation.

`write` buffers:

```ts
  write(fn: (w: KvWriter) => void): void {
    // Buffer the writes so a throw inside fn leaves the store untouched; applied in the order made, as LMDB does,
    // so a key put and then deleted in one write ends deleted.
    const ops: [Uint8Array, Uint8Array | null][] = [];
    fn({ put: (k, v) => void ops.push([k.slice(), v.slice()]), del: (k) => void ops.push([k.slice(), null]) });
    for (const [k, v] of ops) {
      // Inside an environment's transaction, what each key held before is kept so the transaction can be undone.
      this.undo?.push([k, this.tree.get(k) ?? null]);
      if (v) this.tree.set(k, v);
      else this.tree.delete(k);
    }
  }
```

Keys and values are copied on the way in as well as on the way out, so a caller that reuses a buffer after `put` cannot corrupt the store, and the B+ tree, which stores keys by reference, is safe. The atomicity test in `test/store.test.ts` relies on the buffering: a callback that puts `d` and then throws leaves `d` absent, because nothing is applied until the callback returns. The puts and deletes go into one list and are applied in the order the callback made them, which is the order LMDB applies them in: a `put(k)` followed by `del(k)` in one `write` leaves `k` absent on both backends, and a `del(k)` followed by `put(k)` leaves it present. The application's commit relies on the second for an index key that changed hands within the block, its change list putting the removal first.

`size` is the entry count, which `test/app.test.ts` uses as a cheap "something was persisted" check. `MemoryEnv.store(name)` creates a store on first use and returns the same one afterwards, and `close` does nothing. `transaction(fn)` keeps the promise the disk environment makes, all the stores' writes inside `fn` or none of them if it throws:

```ts
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
```

```ts
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
```

The first block is `MemoryKv`'s, the second `MemoryEnv`'s. While a transaction is open each store has an undo list, and the line in `write` above, `this.undo?.push([k, this.tree.get(k) ?? null])`, notes what each key held just before it is changed, `null` for a key that was absent. `rollbackTo(mark)` walks the list from its newest entry down to entry `mark`, puts each value back or deletes the key, and cuts the list to `mark`, so a key written several times ends with what it held before the first of the writes undone. `mark()` is the length of the list at that moment, "a place a transaction inside this one can go back to". `end(true)` is `rollbackTo(0)`, everything since `begin`, and then drops the list; `end(false)` only drops it. The environment begins every store it has when the outermost transaction starts and ends them all in a `finally`, with `failed` still true if `fn` threw. Two cases are covered beside the plain one. A store first asked for inside the transaction is begun as it is created (`if (this.depth > 0) s.begin()` in `store`), so its writes are undone with the rest. A transaction inside a transaction is part of the one already open: its writes go onto the same undo lists, and a throw out of the outer one undoes them too, as LMDB's child transactions are aborted with their parent. If the inner one itself throws, "its own writes are undone there and then": before it calls `fn` it takes a mark in every store the environment has, and its `catch` rolls each store back to its mark and throws the error on. A store first asked for inside the inner transaction has no mark and is rolled back to 0, which is everything it holds, since it was begun when it was created. An outer transaction that catches the error and goes on therefore keeps only what it wrote itself, before the inner one and after it, which is what an LMDB child transaction that aborts leaves its parent. A `MemoryKv` used on its own, outside any environment, has no undo list and its `write` is as before; its `mark()` is 0 and its `rollbackTo` returns at once. This is what makes a failed application commit leave nothing of the block on the memory backend as it does on LMDB ([chapter 5](05-mempool-executor.md)).

The in-memory store is what most engine and application tests run on (the recovery and restart cases use LMDB in a temporary directory), and what `Node` uses when no data directory is configured.

### src/store/lmdb.ts

Purpose: the same interface on LMDB.

Exports:

- `class LmdbEnv implements KvEnv` with `constructor(path, { readOnly? })`, `store(name)`, `transaction(fn)` and `close()`.
- `class StoreClosedError extends Error`, with the message `the store is closed`: what every call on a closed environment, or on a store of one, throws.

```ts
/** What a store of a closed environment answers every call with. */
export class StoreClosedError extends Error {
  constructor() {
    super('the store is closed');
    this.name = 'StoreClosedError';
  }
}
```

The store class is private to the file:

```ts
class LmdbStore implements KvStore {
  private readonly db: Database<Buffer, Buffer>;
  /** Throws once the environment is closed: work that outlived a stop fails here, in JavaScript, and not in the native library on memory that is gone. */
  private readonly open: () => void;

  constructor(db: Database<Buffer, Buffer>, open: () => void) {
    this.db = db;
    this.open = open;
  }
```

`open` is a function the environment hands each of its stores, its own `assertOpen` (below). It returns while the environment is open and throws `StoreClosedError` once its close has been called. Each of the three methods calls it first. `get` is then one call into lmdb-js; `range` and `write` call it again as they go:

```ts
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
```

The check is there for work that outlives a stop. A node that stops closes its environment ([chapter 8](08-node.md)), and a request to a peer, a signature verification or an RPC method that was waiting at that moment may resume afterwards and go on to read or write. lmdb-js keeps the environment in native memory that the close frees, so such a call would reach the native library after the environment is gone. With the check it fails "here, in JavaScript, and not in the native library on memory that is gone", as an ordinary error the caller's own handling catches.

`range` is a generator, so nothing in it runs until the first `next()`. It takes the lmdb-js iterator and steps it by hand, not with `for ... of`, so that `open` can be called "before every step, not only the first": a caller may keep an iteration across a wait, and the environment may be closed during it. An iteration begun before a close and stepped after it throws `StoreClosedError` at that step, and no cursor of the closed environment is moved. The `finally` is for an iteration left early, by a `break` or a `return()`: it gives the cursor back through the iterator's `return`, unless `open` throws first. Then the environment "went first and took it along", and nothing of the cursor is left to release.

`write` checks once before it opens the transaction and again in every `put` and `del`, through `use`. The writer handed to the callback is "good for the callback and no longer": `live` is set to false in a `finally`, whether `transactionSync` returned or threw, and a `put` or `del` on a writer that was kept and used afterwards throws `a store writer was used after its write() returned`. Without the flag such a call "would write outside a transaction".

`buf` wraps a `Uint8Array` as a Node `Buffer` over the same memory without copying, for lmdb-js's binary encodings:

```ts
function buf(b: Uint8Array): Buffer {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
}
```

Results are copied into fresh `Uint8Array`s (`new Uint8Array(v)`), which is the "copy only the value out" of the header: the bytes lmdb-js returns may reference the map, and a copy is what makes them safe to keep. `range` copies keys too, since `getRange` may reuse its key buffer between iterations. `write` runs the callback inside `transactionSync`; a throw inside the callback aborts the transaction, which is how LMDB satisfies the same atomicity test the memory store passes. lmdb-js's `put` and `remove` return promises in the asynchronous API, but inside a synchronous transaction they apply immediately; the `void` discards the return value so the arrow functions type as `void`.

`LmdbEnv` creates the directory (unless read-only), opens the root database with binary keys and values, and `store(name)` opens a named sub-database with the same encodings:

```ts
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
    return new LmdbStore(db, this.assertOpen);
  }
```

Binary key encoding is what makes LMDB's order the bytewise order the keys were designed for; with a key encoding that transforms keys before comparison, the ranges would not line up with `prefixEnd`. `store` calls `assertOpen` before it opens the database, so a closed environment gives out no new store, and passes the same function to the `LmdbStore` it returns. `close` closes the root once and returns that one close to every caller, and `assertOpen` reads the field `close` sets:

```ts
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
```

The first call keeps the promise of the root's close in `closing`, and a later call is handed the same promise, so a second caller waits for the close instead of returning at once while the store is still open. `Node` calls it for an environment it created itself (`ownsEnv`) and for one it was handed for a data directory it holds the claim on ([chapter 8](08-node.md)).

`assertOpen` throws `StoreClosedError` when `closing` is set, which is "from the moment close() is called, not from when it is done": the close of the root is asynchronous, and a call that arrived between its start and its end would begin work on an environment that is going away. It is an arrow function in a field and not a method, so it can be handed to a store as it is and still read the environment's `closing`. Every entry into lmdb-js from this file therefore passes it first: `get`, `range` and `write` of every store the environment gave out, and the environment's own `store` and `transaction`. `close` itself does not, so closing a closed environment stays harmless. `test/review5-node.test.ts`, `does not go on starting once it is being stopped, and answers a closed store with an error`, stops a node on a data directory and then calls `loadBlock(1n)` and `setLowestHeight(1n)` on its block store: the read throws a `StoreClosedError` and the write throws with the message `the store is closed`. `refuses every step of an iteration and every use of a writer once the disk environment is closed`, in the same file, opens an `LmdbEnv` in a temporary directory and writes keys 1 to 3 to its `chain` store, keeping the writer its callback was given. A `put` of key 9 on the kept writer throws `after its write() returned`, and key 9 is absent. An iteration over the store is then stepped once, which yields key 1, and the environment is closed: the next step of that iteration throws `StoreClosedError`, and so do a `get`, a new iteration, a `write` and the environment's `transaction`.

`transaction` is a write transaction on the root database:

```ts
  transaction(fn: () => void): void {
    // A store's write() inside the callback runs as a child of this transaction, whatever database it is on; a throw
    // out of the callback aborts the lot, and nothing reaches the disk until the callback returns.
    this.assertOpen();
    this.root.transactionSync(fn);
  }
```

lmdb-js nests transactions: a `transactionSync` opened on a sub-database while one is open on the root becomes a child of it, so every `write` the callback makes, on whichever named store, joins the environment-wide transaction, and a throw out of `fn` aborts them together (this was probed before it was relied on: nothing lands). There are two callers. State sync's install writes the application store, the validator sets, block H, the lowest heights and the chain state inside `env.transaction`, so a crash leaves either a complete join or nothing, and a restart simply joins again (chapter 7). And the executor of a node that created its own application saves each block and has the application commit inside one ([chapter 5](05-mempool-executor.md)): when the commit succeeds, the block and the state it produced land together, a crash leaves both or neither, and LMDB flushes to the device once for the block where two transactions flushed twice. A commit whose store write fails aborts the transaction. `CoreApp.commit` is not an `async` function and does its write before it returns, so the failure is thrown inside the callback and takes the block, the validator set and the chain state with it: the store is where it was before the block, and `applyBlock` rejects with the chain state unchanged. The executor calls `commitSync()` in place of `commit()` on an application that has one, for the same effect. The application's memory is by then one block ahead of its store, so the node needs a restart, which finds the chain and the application at the same height. Only what a commit does after its write, the snapshot export in `CoreApp`, fails as a rejected promise once the transaction has ended: the block and the state are stored by then. The flush, not the writing, is most of what a commit costs: at 192,000 accounts the application's commit of a 500-transfer block measured 17 to 26 ms of LMDB's own work (15 to 19 ms since the account history became a log) and 40 to 120 ms with the flush (`F_FULLFSYNC` on macOS). The `MemoryEnv` version has no crash to recover from and keeps the other half of the promise: a throw out of the callback undoes the writes made inside it, in every store, and a throw out of a transaction inside another undoes that one's writes alone (`src/store/kv.ts` above).

Two behaviours of lmdb-js to know. `openDB` builds a new database object on every call, so two calls to `store('app')` give two wrappers over the same named database; nothing in `LmdbEnv` caches them, and the node calls `store` once per name in the normal path. And in a read-only environment, `openDB` of a name that does not exist returns `undefined` rather than throwing, so a wrapper built over it would fail on first use with a type error; `store` checks for that and throws `the store has no database named X, and a read-only environment cannot create it` where the database is asked for. The test opens a name that exists and one that does not.

### src/store/blockstore.ts

Purpose: the chain's persistent records on a `KvStore`.

Exports:

- `interface TxLocation { height; index; ok: boolean | null; error }`: where a transaction landed. `ok` is null for a block stored without executing it here (a backfilled block).
- `interface BlockStore`: `loadBlock`, `saveBlock`, `heightOf`, `txLocation` and `txLocations`, `loadResults`, `loadState`, `saveState`, `loadValidatorSet`, `saveValidatorSet`, `deleteValidatorSet`, `loadValidatorsAt`, `saveValidatorsAt`, `lowestHeight`, `setLowestHeight`, the header records `loadHeader`, `saveHeader`, `deleteHeader`, `lowestHeaderHeight` and `setLowestHeaderHeight`, `deleteBlock`, and `batch(fn)`, which runs several saves as one store transaction "so a crash leaves all or none of them".
- `class KvBlockStore implements BlockStore` over any `KvStore`.
- `class MemoryBlockStore extends KvBlockStore`: the same on a fresh `MemoryKv`.

The key layout is a set of one-byte prefixes, each followed by the natural address:

```ts
const STATE_KEY = key((k) => k.u8(0x73));
const LOWEST_KEY = key((k) => k.u8(0x6c));
const blockKey = (h: bigint) => key((k) => k.u8(0x62).u64(h));
const hashKey = (hash: Uint8Array) => key((k) => k.u8(0x68).fixed(hash));
const valsetKey = (hash: Uint8Array) => key((k) => k.u8(0x76).fixed(hash));
const valsetAtKey = (height: bigint) => key((k) => k.u8(0x56).u64(height));
/**
 * How many blocks share a segment of the transaction index. An index keyed by the hash alone puts every
 * transaction of a block on a page of its own once the index is large, and a block's write grows with the chain
 * (docs/benchmarks.md section 4.13). Keyed by segment first, a block's entries go among those of the few blocks
 * around it, on pages already being written; the price is a lookup, which asks every segment the store holds.
 */
export const TX_SEGMENT_BLOCKS = 32n;
/**
 * One entry per block a transaction is in, under its block's segment. A store written before the segments has its
 * entries under 't', by hash and height or, older still, by hash alone; they are moved once, when the store is
 * next opened (migrateTxIndex), and 'T' records that.
 */
const TX_LAYOUT_KEY = Uint8Array.of(0x54);
const TX_LAYOUT = 3;
const TX_PREFIX = Uint8Array.of(0x78);
const OLD_TX_PREFIX = Uint8Array.of(0x74);
const txKey = (hash: Uint8Array, height: bigint) => key((k) => k.u8(0x78).u64(height / TX_SEGMENT_BLOCKS).fixed(hash).u64(height));
const txPrefix = (segment: bigint, hash: Uint8Array) => key((k) => k.u8(0x78).u64(segment).fixed(hash));
const TX_KEY_SIZE = 1 + 8 + HASH_SIZE + 8;
const MAX_SEGMENT = 0xffff_ffff_ffff_ffffn;
const oldTxPrefix = (hash: Uint8Array) => key((k) => k.u8(0x74).fixed(hash));
const encodeTx = (height: bigint, index: number, r: TxResult | null | undefined) => encode((wr) => wr.u64(height).u32(index).u8(r ? (r.ok ? 1 : 0) : 2).string(r?.error ?? ''));
const decodeTx = (v: Uint8Array): TxLocation =>
  decode(v, (r) => {
    const height = r.u64();
    const index = r.u32();
    const ok = r.u8();
    return { height, index, ok: ok === 2 ? null : ok === 1, error: r.string() };
  });
const resultsKey = (h: bigint) => key((k) => k.u8(0x72).u64(h));
const headerKey = (h: bigint) => key((k) => k.u8(0x48).u64(h));
const LOWEST_HEADER_KEY = key((k) => k.u8(0x4c));
```

In ASCII: `'s'` state, `'l'` lowest height, `'b'` block by height, `'h'` height by block hash, `'v'` validator set by hash, `'V'` validator set by the height it signs, `'x'` transaction location by segment, hash and height, `'T'` the layout of that index (`'t'` held it before it was kept in segments), `'r'` results by height, `'H'` a header kept without its block, `'L'` the lowest height with such a header. Because heights are big-endian u64, the blocks sort by height and a range over `'b'` walks the chain in order. The prefixes are the same letters the application store uses for different things (`'h'` is a block hash here and a history version there); that is fine because the two live in different named stores.

Every save goes through a private `write` that either joins a batch in progress or opens its own transaction:

```ts
  /** The writer of a batch in progress; every save joins it instead of opening its own transaction. */
  private open: KvWriter | null = null;
  /** Whether entries of an older layout may still lie under 't': their move did not finish when the store was opened (the store cannot be written, or a write of the move failed). */
  private oldTxIndex = false;

  constructor(kv: KvStore) {
    this.kv = kv;
    this.migrateTxIndex();
  }
```

`batch` holds the writer of the one transaction while `fn` runs:

```ts
  batch(fn: () => void): void {
    if (this.open) {
      fn();
      return;
    }
    this.kv.write((w) => {
      this.open = w;
      try {
        fn();
      } finally {
        this.open = null;
      }
    });
  }
```

and `write` hands a save that writer, or a transaction of its own:

```ts
  private write(fn: (w: KvWriter) => void): void {
    if (this.open) fn(this.open);
    else this.kv.write(fn);
  }
```

The invariant: while a batch is open, every save of this store joins its transaction, and a nested `batch` call joins the outer one instead of opening a second (the inner call just runs `fn`; only the outermost call holds the writer and clears it in `finally`, so a throw anywhere inside aborts the one transaction and leaves `open` null for the next caller). Outside a batch each save is its own transaction, as before. Reads (`loadBlock`, `loadState` and the rest) go to the store directly, not through the open writer; on the memory store, whose `write` buffers, a read inside a batch does not see the batch's own writes, and no caller relies on it either way (`deleteBlock` inside the pruning batch loads the block it is about to delete, which no earlier step of that batch wrote). The executor's `doApply` in `src/node/executor.ts` is the batch user:

```ts
    // Block, commit, results, the next set and the new state land together or not at all.
    const save = () =>
      this.d.store.batch(() => {
        this.d.store.saveBlock(block, commit, res.txResults);
        this.d.store.saveValidatorSet(newState.nextValidators);
        this.d.store.saveValidatorsAt(h + 2n, newState.nextValidators);
        this.d.store.saveState(newState);
      });
```

`save` is called once per block, either on its own or inside `KvEnv.transaction` together with the application's commit ([chapter 5](05-mempool-executor.md)); in the second case the batch's `kv.write` is a child of the environment's transaction and commits with it. A commit update for an already applied block is a single save and opens its own transaction. The retention pass runs after the block's save, in batches of its own, one for blocks and one for headers: the executor's `pruneBlocks` works out the new floor and then, inside one `batch`, calls `deleteBlock` for every height below it and `setLowestHeight`, and `pruneHeaders` does the same with `deleteHeader` and `setLowestHeaderHeight`. So the blocks go with the marker that says they are gone, or none of it does, and a crash never leaves `lowestHeight()` naming a height whose block has been deleted.

A block and its commit are stored as one value, the block's encoding followed by the commit's, and read back by decoding both in sequence:

```ts
  loadBlock(height: bigint): { block: Block; commit: Commit } | null {
    const b = this.kv.get(blockKey(height));
    return b ? decode(b, (r) => ({ block: decodeBlock(r), commit: decodeCommit(r) })) : null;
  }
```

`saveBlock(block, commit, results?)` writes, through `write`, the block, its hash index entry, and, depending on the third argument, the transaction index: with an array of results the transactions are indexed with their outcomes; with `null` they are indexed as not executed here (backfill); with the argument left out the index is not touched, which is how the executor stores a fuller commit for a block it already applied (review finding 21: a precommit that arrives while the block is being executed used to be lost from the stored commit, so the next block could penalise its signer as absent).

```ts
      if (results !== undefined) {
        // A transaction repeated in one block is indexed once: at the first position it succeeded at, or at its
        // first position when it succeeded nowhere (or the block was stored without executing it).
        const seen = new Map<string, { hash: Uint8Array; index: number }>();
        block.txs.forEach((tx, i) => {
          const hash = txHash(tx);
          const k = toHex(hash);
          const first = seen.get(k);
          if (!first || (results && !results[first.index]?.ok && results[i]?.ok)) seen.set(k, { hash, index: i });
        });
        for (const { hash, index } of seen.values()) {
          w.put(txKey(hash, h), encodeTx(h, index, results?.[index]));
          if (this.oldTxIndex) this.delOldTx(w, hash, h);
        }
        if (results) w.put(resultsKey(h), encode((wr) => wr.array(results, (wr, r) => wr.bool(r.ok).string(r.error ?? ''))));
      }
```

The location value is the height, the position, a status byte (1 ok, 0 failed, 2 not executed) and the error string. A transaction can stand in one block more than once, and the block has one index entry for it. The `seen` map chooses the position: the first one the hash appears at, replaced by a later one only while the position held failed and the later one succeeded, so the entry names the first position the transaction succeeded at, and its first position when it succeeded nowhere or the block was stored without being executed (`results` is `null`). For a block `[T, T]` where the first T succeeds and the second fails as a duplicate, the entry is position 0 with `ok`; for one where the first fails, for want of a balance that a transaction between the two supplies, and the second succeeds, it is the second position, so the RPC reports the success and the result proof is made for the position that has it. `loadResults(height)` returns every position's result, from which a result proof for any position can be built.

The last line of the loop, `delOldTx`, runs only while `oldTxIndex` is set, which is while entries of an older layout may still lie under `'t'` (the move below was cut short). A block saved then may be one whose transactions still have their old entries, a block saved again with its results, say. `txLocations` reads both places while the flag is set, so without the removal the transaction would be reported twice in the one block, once from its segment and once from under `'t'`, and with whatever result the old entry had. With it the block's entry is the one in its segment only. `delOldTx` itself is shown with `deleteBlock`, which calls it too.

The key carries the height after the hash, so there is one entry for every block a transaction is in. A transaction that failed has no effect and can be included again, in a later block, where it may succeed or fail once more; with one entry per hash the last block written used to win.

Before the hash the key carries the block's segment, the height divided by `TX_SEGMENT_BLOCKS`, 32. The reason is what a write costs. A hash is uniformly spread, so in an index keyed by the hash first the entries of one block land anywhere, and once the index is large each is on a 16 KiB page of its own: a block then rewrites about as many pages of the index as it has transactions, and its write grows with the chain ([docs/benchmarks.md](../benchmarks.md) section 4.13). Keyed by the segment first, the entries of a block lie among those of the 32 blocks around it, on pages that are being written anyway. Worked example: block 1,000 is in segment 31 (1000 / 32, rounded down), with blocks 992 to 1,023; block 70,000 is in segment 2,187.

The price is the lookup, which no longer knows where to look: the hash does not say which block has it. `txLocations(hash)` asks every segment the store holds, and `txLocation(hash)` picks one of the answers:

```ts
  txLocations(hash: Uint8Array): TxLocation[] {
    const found: TxLocation[] = [];
    const end = prefixEnd(TX_PREFIX);
    // A read or two per segment held: from where the hash would be in a segment, the first key there is either an
    // entry of the hash, or it names the next segment that has anything, and the segments between are passed over.
    for (let segment = 0n; ; ) {
      const prefix = txPrefix(segment, hash);
      let next: bigint | null = null;
      for (const [k, v] of this.kv.range(prefix, end)) {
        if (k.length !== TX_KEY_SIZE) continue; // not an entry of the index: nothing writes one, and it says nothing of the segments
        if (startsWith(k, prefix)) {
          found.push(decodeTx(v));
          continue;
        }
        const at = decode(k.subarray(1, 9), (r) => r.u64());
        // Past the hash in the segment asked: the next one may have it. A later segment's first key says the same of
        // that segment when it sorts after the hash's entries there; otherwise that segment is asked.
        const there = txPrefix(at, hash);
        next = at === segment || (compareBytes(k, there) > 0 && !startsWith(k, there)) ? at + 1n : at;
        break;
      }
      if (next === null || next > MAX_SEGMENT) break;
      segment = next;
    }
    if (this.oldTxIndex) {
      const prefix = oldTxPrefix(hash);
      for (const [, v] of this.kv.range(prefix, prefixEnd(prefix))) found.push(decodeTx(v));
    }
    return found.sort((a, b) => (a.height < b.height ? -1 : a.height > b.height ? 1 : 0));
  }

  txLocation(hash: Uint8Array): TxLocation | null {
    const all = this.txLocations(hash);
    return all.find((l) => l.ok === true) ?? all[all.length - 1] ?? null;
  }
```

The loop reads from where the hash would be in a segment to the end of the index. A key whose length is not an entry's, `TX_KEY_SIZE`, is skipped before anything is read from it: nothing writes one, and it is neither an entry to decode nor a key whose bytes name a segment. Entries of the hash in that segment come first and are collected. The first key that is not one ends the read, and it says where to go next. If it is in the segment asked, the hash's entries there are finished and the next segment is asked. If it is in a later segment, the segments between hold nothing and are passed over, and the key itself tells whether that later segment can hold the hash: a key that sorts after the hash's entries there means it cannot, and the segment after it is asked; otherwise that segment is. A read that finds no key at all ends the loop. That is one or two reads per segment that has entries and none for a segment that has none, where the old layout made one range read: a lookup grows with the blocks a node keeps, and pruning bounds it. A probe over 4,000 blocks measured 0.27 ms. `MAX_SEGMENT` stops the loop at the last segment a u64 can name rather than let `at + 1n` overflow the key.

`txLocations` is every block still held that carries the transaction, oldest first; `txLocation` is the block it succeeded in if there is one, otherwise the newest. `decodeTx` turns the status byte back into `ok`, null for 2.

A store written before the segments has its entries under `'t'`, in one of two layouts: by hash and height, or, older still, by hash alone, one entry per hash. Both have the height in the value. The constructor calls the private `migrateTxIndex`, which moves them once:

```ts
  private migrateTxIndex(): void {
    if (this.kv.get(TX_LAYOUT_KEY)?.[0] === TX_LAYOUT) return;
    this.oldTxIndex = true;
    const end = prefixEnd(OLD_TX_PREFIX);
    try {
      for (;;) {
        // What a pass moved is gone from under 't', so each pass starts at the front of what is left.
        const old: [Uint8Array, Uint8Array][] = [];
        for (const e of this.kv.range(OLD_TX_PREFIX, end)) {
          old.push(e);
          if (old.length === 5000) break;
        }
        this.kv.write((w) => {
          for (const [k, v] of old) {
            w.put(txKey(k.subarray(1, 1 + HASH_SIZE), decodeTx(v).height), v);
            w.del(k);
          }
          if (old.length < 5000) w.put(TX_LAYOUT_KEY, Uint8Array.of(TX_LAYOUT));
        });
        if (old.length < 5000) break;
      }
      this.oldTxIndex = false;
    } catch {
      // not writable
    }
  }
```

The marker `'T'` holds the layout's number, 3 for the segments; a store that says 2 (hash and height) or says nothing is moved. Each entry is rewritten under the key of its own height, which is read from the value, so the two older layouts need not be told apart: the hash is the 32 bytes after the prefix in both. The move takes 5,000 entries a write, each write deleting what it moved, and the marker goes in with the last write, so a move that was cut short is taken up again at the next open and a store that has the marker is not scanned. A new, empty store writes the marker at once, which is one write at open. While old entries may remain, `oldTxIndex` is set: it is cleared only when the move has finished. A store that cannot be written is left as it is, and so is one whose move stopped at a failed write; with the flag set `txLocations` also reads the hash's prefix under `'t'`, which finds an entry of either older layout, so every entry is found whether it was moved or not.

The rest are one-key reads and writes: `heightOf(hash)`, `loadState` / `saveState` (the `ChainState` encoding from `src/types/state.ts`, whose last byte names the chain's signature scheme and is refused on read when it names none the code knows), `loadValidatorSet` / `saveValidatorSet` keyed by `set.hash()`, `loadValidatorsAt` / `saveValidatorsAt` keyed by height, `lowestHeight`, which defaults to 1 when nothing was stored, and the header records: `loadHeader` / `saveHeader` keyed by the header's own height (the `Header` encoding from `src/types/block.ts`), `deleteHeader`, and the marker of the lowest one, which unlike `lowestHeight` has no default, because a node that never state-synced has no such records:

```ts
  lowestHeaderHeight(): bigint | null {
    const v = this.kv.get(LOWEST_HEADER_KEY);
    return v ? decode(v, (r) => r.u64()) : null;
  }

  setLowestHeaderHeight(height: bigint | null): void {
    this.write((w) => (height === null ? w.del(LOWEST_HEADER_KEY) : w.put(LOWEST_HEADER_KEY, encode((wr) => wr.u64(height)))));
  }
```

Setting the marker to `null` deletes the key, which is what header pruning does once the last record is older than the evidence window and what backfill does once a block has replaced the record the marker pointed at. `deleteBlock(height)` is what retention and pruning use; it loads the block first so it can remove the hash index entry and every transaction entry in the same transaction, with the block's results and the validator set stored for its height:

```ts
  deleteBlock(height: bigint): void {
    const stored = this.loadBlock(height);
    if (!stored) return;
    this.write((w) => {
      w.del(blockKey(height));
      w.del(hashKey(blockHash(stored.block)));
      w.del(resultsKey(height));
      // The set by height serves a state-sync join at a snapshot height, which needs the block of that height too:
      // without the block the record answers nothing. Sets by hash are the executor's to remove, once no header
      // still held names them.
      w.del(valsetAtKey(height));
      for (const tx of stored.block.txs) {
        const hash = txHash(tx);
        w.del(txKey(hash, height));
        if (this.oldTxIndex) this.delOldTx(w, hash, height);
      }
    });
  }
```

While `oldTxIndex` is set, both it and `saveBlock` call the private `delOldTx` for each transaction of the block:

```ts
  /**
   * Remove what a move that was cut short left under 't' for a transaction in a block: the entry by hash and
   * height, and the one by hash alone if it names this block. The block's entry is then the one in its segment only.
   */
  private delOldTx(w: KvWriter, hash: Uint8Array, height: bigint): void {
    const alone = oldTxPrefix(hash);
    w.del(key((k) => k.u8(0x74).fixed(hash).u64(height)));
    const v = this.kv.get(alone);
    if (v && decodeTx(v).height === height) w.del(alone);
  }
```

Deleting a block removes that block's index entries only: a transaction that is also in another block still held keeps its entry there. While `oldTxIndex` is set, entries of the block's transactions may still lie under `'t'`, so `delOldTx` removes those too: the one by hash and height, and the one by hash alone if its value names this block, which takes a read of that key. An entry by hash alone that names another block is that block's and stays. The validator set stored by height (`'V'`) goes with the block of that height: it is what a peer joining at a snapshot of that height is served, and such a join needs the block too, so the record answers nothing once the block is gone. The sets of the heights still held stay, as do the two the executor has stored ahead of the latest block. Sets by hash (`'v'`), one per distinct set, are not deleted here: headers still held name them, which is what evidence at any retained height needs. They are the executor's to remove. After a pruning pass it looks for each set the removed heights carried among the headers still held and in the current state, and calls **`deleteValidatorSet(hash)`**, a single `del` of the `'v'` key, for one that nothing names (`pruneValidatorSets`, [chapter 5](05-mempool-executor.md)). The store does not check the condition itself; the interface says so: "the caller has found that no header still held and no state names it". A store pruned by an earlier build keeps the by-height records of the blocks that build deleted, below its lowest block, since `deleteBlock` returns at once for a height whose block is already gone.

### src/store/files.ts

Purpose: replace a file atomically and durably.

Exports:

- `writeAtomic(path, data)`.

```ts
export function writeAtomic(path: string, data: Uint8Array): void {
  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // The rename itself must reach the disk too, or a crash can bring the old file back.
  try {
    const dir = openSync(dirname(path), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (e) {
    // Some platforms refuse to fsync a directory handle at all; the file write above was still synced.
    // A failure of the sync itself is a different matter and must surface.
    const code = (e as NodeJS.ErrnoException).code;
    if (!code || !['EINVAL', 'EPERM', 'ENOTSUP', 'EISDIR', 'EBADF', 'EACCES'].includes(code)) throw e;
  }
}
```

The file is either the old content or the new content, never a mix: the data goes to `path.tmp`, is synced, and only then takes the name. The directory sync is the fix for review finding 16. It is wrapped in a `try`, but the catch is selective. The error codes that mean "this platform or file system does not let a directory handle be opened or synced" (`EINVAL`, `EPERM`, `ENOTSUP`, `EISDIR`, `EBADF`, `EACCES`) are swallowed, because in that case the data file itself is still durable and only the rename could in principle be lost. Any other error means the sync was attempted and failed, an I/O error on a file system that does support it, and that is rethrown: a signing guard whose record may not have reached the disk must not report success, and a caller that caught a blanket exception would never know. `src/consensus/privval.ts` writes the signing guard through it, `src/wallet/keystore.ts` the keystore, and the key-value test application (`src/app/kvstore.ts`) its JSON snapshot. The temporary name is fixed, so two processes writing the same path would race; every caller writes a single-process file, in a node's own directory or the wallet's. The function is synchronous like the store, for the same reason: the signing guard must be on disk before the signature it records leaves the process.

## How it is tested

`test/store.test.ts`:

- "memory store orders keys bytewise and makes writes atomic": `exerciseKv` puts keys out of order, reads one back, finds a missing key undefined, scans the prefix `b` with `prefixEnd` and gets the two `b/` keys in order, scans `[a, z)` and gets four, throws inside a `write` and finds the key it put absent, and deletes a key.
- "lmdb store does the same and survives reopening": the same exercise on an `LmdbEnv` in a temporary directory, then a reopen reads a value back, a second, read-only environment on the same directory sees the deletion, and asking that environment for a store named `missing` throws `/no database named missing/`.
- "block store finds blocks by height and by hash on both backends": five blocks saved on a `MemoryBlockStore` and on a `KvBlockStore` over LMDB; `loadBlock(3)` returns the block with its commit, `heightOf` finds block 4 and returns null for an unknown hash, `loadBlock(9)` and `loadState` return null.

`test/review.test.ts`, "keeps per-block results so a repeated transaction proves its real outcome at each position": a block `[T, T]` with results success then failure; `txLocation` points at position 0 with `ok: true`, `loadResults` returns both, and a result proof for position 1 verifies against the results root with `ok: false` (finding 18). Its neighbour "saves everything a height needs to the block store in one transaction" subclasses `MemoryKv` to count calls to `write`: a `batch` holding `saveValidatorSet`, `saveValidatorsAt` and `setLowestHeight` costs one (counted from after the store is opened, which writes the layout of its transaction index once), the values are readable afterwards, and a `setLowestHeight` outside the batch costs another (finding 39).

`test/review4.test.ts` has three cases on the transaction index. "keeps every block a transaction is in, answers with the one it succeeded in, and loses only the pruned one" saves one transaction in blocks 5 (failed), 8 (succeeded, at position 1) and 9 (failed): `txLocations` lists the three in height order, `txLocation` answers block 8, after `deleteBlock(8n)` the list is 5 and 9 and the answer block 9, and after the other two are deleted it is null. "finds a transaction in whichever segments hold it, with blocks far apart and segments missing between" saves fourteen blocks at heights from 1 to 90,000, which lie in seven segments, with one transaction in five of them: `txLocations` lists the five in height order, a transaction in a single block is found at either end and in the middle, hashes of all zero and all `0xff` bytes find nothing, one lookup makes at most 14 range reads, every key under `'x'` starts with its height divided by `TX_SEGMENT_BLOCKS`, three keys put under `'x'` that are not entries (41 bytes, sorting just before an entry of the transaction, 2 bytes and 9 bytes) change no answer, and deleting two of the five blocks leaves the other three. "moves an index of either older layout into the segments when the store is opened, and reads one it cannot move" writes 12,000 entries under `'t'`, half by hash alone and half by hash and height, over heights in ten segments, with the marker saying layout 2, and opens a `KvBlockStore` on them: nothing is left under `'t'`, the entries read back with their heights, positions and results, a transaction with entries at heights 5 and 700 that lands again at height 9 has all three and keeps the first two when block 9 is deleted, and a second store opened on the same data makes no range read. A store whose second write throws leaves 7,000 entries unmoved and no marker, finds every entry all the same, answers with one location for a block saved again while its old entry remained with none for one saved and then pruned and none for one pruned whose block was stored without touching the index, 6,997 old entries being left, and the next open finishes the move and writes the marker; and a store whose `write` always throws answers from entries of both older layouts.

`test/review5-node.test.ts` has seven cases on this chapter's code; two, on a closed LMDB environment, are described under `src/store/lmdb.ts` above, and the other five are these. "indexes a transaction repeated in one block where it succeeded": on a `MemoryBlockStore`, a block `[T, U, T]` with results failure, success, success is indexed at position 2 with `ok: true`; a block `[T, T]` with success then failure at position 0; one where both fail at the first of the two with its error; one saved with `null` results at position 0 with `ok: null`; and `txLocations` has one entry per block, which goes when the block is deleted. "applies the operations of one write to the memory store in the order they were made": a put followed by a delete of one key in a single `write` leaves the key absent, put, delete, put leaves the last value, and a callback that deletes and then throws leaves the store as it was. "prunes blocks and headers in one transaction each, the set by height going with its block": a one-validator node retaining two blocks runs on a `MemoryKv` that records the first byte of every key each `write` puts and deletes. Every write that deletes a block also puts the lowest-height marker, no write moves the marker alone, and each deletes as many `'V'` records as blocks; `loadValidatorsAt` is null below the lowest block and answers at it and two heights above the latest, and the genesis set is still found by hash, the chain's one validator never having changed. Two header records written below the lowest block with times older than the evidence age are then deleted, with their marker, in a single write after the next commit. The fourth, "removes a validator set by hash once no header held names it" ([chapter 5](05-mempool-executor.md)), exercises `deleteValidatorSet`: a set replaced by a `val:` transaction is gone from the store once every block that names it has been pruned, and each block still held finds both sets its header names. The fifth, "undoes the writes of a memory environment transaction that throws, in every store", puts a key in the `chain` store of a `MemoryEnv`, then in a transaction overwrites it, adds a second key, deletes the first, writes to an `app` store first asked for inside a nested transaction, and throws: the first key holds its old value, the second key and the `app` store's key are absent. A transaction that returns keeps its write, and a write made after it is not undone by a later transaction that throws. Last, an outer transaction puts the first key, runs an inner one that overwrites it, writes to a `late` store first asked for there and throws, catches the error and puts the second key: afterwards the first key holds the outer transaction's value, the second key its new one, and the `late` store has nothing.

`test/app.test.ts`, "restarts from the store with the same app hash and keeps producing the same hashes": the application on a `MemoryKv` is reopened from it, serves the same app hash and the same proofs, and after the window slides the history keys under prefix `0x68` are exactly versions 4 to 7, showing that commit deletes the record that left the window. `test/genesis.test.ts` reopens an application from a `MemoryKv` and checks the app hash matches an inline genesis.

The remaining block store methods (state, validator sets by hash and by height, lowest height, the header records, deletion) are covered indirectly by the engine, recovery, sync and network suites of [chapter 15](15-tests.md), which restart nodes and prune blocks on these stores; `test/sync.test.ts` reads the header records of a state-synced node back (`lowestHeaderHeight` is 1, header 7 equals a validator's, and both are gone once backfill reached genesis). `test/review.test.ts`, "persists a decided height to the chain store in one transaction", builds a `KvEnv` by hand whose `transaction` just runs its callback, which is all the executor's commit path asks of it. The LMDB path under load is measured rather than tested: the figures in README.md quoted above.

## Limitations and ideas

- Values carry no checksum of their own; the chain trusts LMDB's page-level integrity and checks the application state against the stored app hash on start.
- A block and its commit share one value, so storing a fuller commit rewrites the whole block.
- `LmdbEnv.store(name)` returns a new wrapper on every call and does not cache.
- `batch` is per `KvBlockStore` and therefore per named store. What makes a block and the application's commit one transaction is `KvEnv.transaction` around both, which the executor uses only when the node created the application on its own environment's `app` store. An application handed to the node commits in a separate transaction, or outside LMDB altogether, so a crash between the block store's batch and `app.commit` is still possible there and is still repaired by replay, as DESIGN.md section 4 describes.
- A transaction that encloses an asynchronous `commit()` holds only what the application wrote before its first `await`; nothing checks that an application in the environment's store keeps to that, and one that does not silently pays the second flush. A `commit()` that fails after an `await` rejects its promise and does not abort the transaction, so the block is stored without the application's writes and the node relies on the replay at restart. After a commit that did abort the transaction the application still holds the block in memory while the store does not, and the node has to be restarted.
- The by-height records of blocks deleted before those records went with their blocks stay in a store pruned by an earlier build, and so do the sets by hash that only those blocks named: the executor considers a set by hash only when a pass removes a height that carried it.
- There is no compaction or map-size management beyond lmdb-js's defaults.

Exercises:

1. Add a case to `exerciseKv` in `test/store.test.ts` that puts and then deletes one key in a single `write`, and one that deletes and then puts it, so that the order of operations is checked on LMDB as well as on the memory store.
2. `deleteBlock` loads the block to find the index entries of its transactions. Keep a block's transaction hashes under a key of their own by height so that it need not, and measure what that costs a commit.
3. Add a third backend (for example SQLite or a log-structured file) behind `KvStore` and run `test/store.test.ts` against it unchanged.
4. Measure `write` latency on LMDB with and without the sync (lmdb-js exposes options for it) and relate the difference to what crash recovery in [chapter 8](08-node.md) would have to replay. Then time a block's commit with the executor's `transaction` left out, so that the chain store and the application each flush, and compare it with the one flush per block the node pays now.
5. Write a tool that opens a node's `data/lmdb` read-only, as the test does, and prints the key layout of each store with counts per prefix byte.
6. Add a checksum (for example the first 8 bytes of SHA-256) in front of every value of the block store and verify it on read; measure the cost in the block sync benchmark.

## Where to next

[Chapter 11, the application](11-application.md): the object types, the transaction format, the evaluators, and how commit writes the database's change list to the `app` store opened here.
