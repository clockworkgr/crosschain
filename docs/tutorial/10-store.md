# 10. The store

This chapter covers `src/store/`: the small key-value interface that everything persistent is written through, its two implementations (a B+ tree in memory and LMDB on disk), the block store that keeps committed blocks, commits, chain state and validator sets on top of it, and the atomic file write used for the few things that are files rather than records. It sits below [the node](08-node.md), which opens one environment per data directory and hands a named store to the block executor and another to the application; below [the object database](09-database.md), whose change lists and history records are what the application writes here; and below [the application](11-application.md), which defines the key layout of its own store. The codec of [chapter 1](01-codec.md) supplies every value's bytes and `src/db/keys.ts` supplies the key encoding; the block and state encodings come from [chapter 3](03-types.md). The double-sign guard of [consensus](04-consensus.md) and the keystore of [the wallet](14-wallet-cli.md) use the file writer.

## Concepts

### A key-value store

A key-value store maps byte strings to byte strings. There is no schema: a "table" is a prefix byte, a "row" is a key with that prefix, and relationships are encoded into keys. That is enough for a blockchain node because every record it keeps is addressed by something small and fixed (a height, a hash, an object id), and because the state machine, not the store, decides what is consistent. Nothing is ever read back to make a decision during block execution; the state is in memory, and the store is a durable copy plus the records needed to restart.

The one property the store adds to a plain map is order. Keys are compared bytewise, and the interface exposes `range(start, end)` over `start <= key < end` in ascending order. Combined with the encoding rules of `src/db/keys.ts` (big-endian integers, zero-terminated strings, prefix bytes first), a prefix scan is a range: everything under prefix p lies in `[p, prefixEnd(p))`, where `prefixEnd` is the smallest key greater than every key starting with p. "Every history record" or "every object" is one such scan.

Worked example: the application store's layout, from the top of `src/app/core/app.ts`, is `'m'` meta (height and app hash), `'o' || id` one object, `'c' || type` one counter, `'h' || version` one history record, `'a' || account || sequence` one history entry, `'q' || account` the next sequence, and `'s'` and `'k'` for snapshot manifests and chunks. Reopening the database is a range over `'o'`, one `get` per counter, and a range over `'h'`; the restart test in `test/app.test.ts` reads the history keys back with `store.range(new Uint8Array([0x68]), prefixEnd(new Uint8Array([0x68])))` and expects versions 4 to 7 after the window has slid.

### Atomic writes

The interface has one write path: `write(fn)`, which hands a writer with `put` and `del` to a callback and commits everything the callback did together, or nothing. Commit in [the application](11-application.md) is one `write`: every changed object, the moved counters, the history record, the deletion of the record that left the window, and the height with its app hash. Either all of it is on disk when the block is reported committed, or none of it is and the node replays the block on restart through the `info()` handshake described in DESIGN.md section 6. The block store likewise saves a block, its hash index entry, its transaction index entries and its results in one `write`, and offers `batch(fn)` so that several saves share one. DESIGN.md section 4 fixes the persistence order on commit: "app.finalizeBlock (in memory), then save block + commit + new chain state (one transaction), then app.commit (one transaction with the objects that changed)". The executor keeps the middle step to one transaction by saving the block with its results, the next validator set by hash and by height, and the new chain state inside a single batch. Review finding 39 in REVIEW-2026-10-28.md is what that fixes: those four saves used to be four transactions, so a crash between them could leave a block and its transaction index entries on disk without the state that goes with them.

The interface is synchronous on purpose. The header of `src/store/kv.ts` puts it this way: the state machine is synchronous, a block is applied in one go with no `await` between its first write and its last. A store that returned promises would let other work interleave with a half-applied block, and would make the ordering of writes and reads inside `commit` a matter of scheduling rather than of code.

### LMDB and memory mapping

The on-disk implementation is LMDB (the Lightning Memory-Mapped Database from Symas, written for OpenLDAP), through the `lmdb` package (lmdb-js). LMDB is a B+ tree stored in a file that the process maps into its address space. Four consequences matter here, all named in the header of `src/store/lmdb.ts`:

- Reads are synchronous and cheap. A `get` walks tree pages that are ordinary memory; no system call, no read buffer, and the only copy is the value itself being copied out of the map so the caller holds stable bytes. There is no cache to warm other than the operating system's page cache.
- Keys are compared bytewise, the same order the in-memory store and `src/db/keys.ts` assume.
- A transaction commits and syncs before `transactionSync` returns. LMDB writes modified pages copy-on-write and flips a meta page at commit, so a crash in the middle of a transaction leaves the previous state intact; with the sync, a transaction that returned is on disk. Readers never block a writer and a writer never blocks readers: each reader sees the tree as of the last commit when it started.
- A transaction can span every database of the environment. The named stores are sub-databases of one root, and a write transaction opened on the root encloses whatever the stores write inside it, so state sync can install a snapshot into the application store and the chain store in one (chapter 7): either the join is complete on disk or none of it is.

A fifth consequence is operational: a second process could open the same environment read-only, which `LmdbEnv` supports with `{ readOnly: true }` and `test/store.test.ts` exercises. The header puts it in the past tense, "the CLI did once; it now reads through the RPC": RPC-SYNC-PROOFS.md section 1 lists the removal of read-only store access from the CLI, and today `src/cli.ts` opens an environment only in `start`, read-write, for the node it runs. The in-memory implementation exists so that tests and the in-process localnet run without a disk, and so that the two can be checked against each other: `test/store.test.ts` runs the same exercise on both.

An environment is one directory and can hold several named stores. The node opens one environment and takes `chain` for the block store and `app` for the application, so a data directory is one LMDB directory:

```ts
    this.env = cfg.env ?? (cfg.dataDir ? new LmdbEnv(join(cfg.dataDir, 'lmdb')) : new MemoryEnv());
    this.ownsEnv = !cfg.env;
    this.store = new KvBlockStore(this.env.store('chain'));
```

README.md puts numbers on the disk side: a 500-transfer block commits in 8.8 ms to LMDB against 2.6 ms to memory; a 1 GB genesis occupies 614 MiB of LMDB (1.1 GiB with one snapshot); eight blocks of 2,400 scattered transfers grow it by 36 MiB.

### What the block store keeps

Blocks and their commits by height, so the chain can be replayed and served; a hash-to-height index, so a block can be found by hash; chain state (the current height, hashes and validator sets around it); validator sets by hash and by the height they sign; the lowest height held; a transaction index by hash with the outcome; the execution results of each block; and, on a node that joined by state sync, headers kept without their block for the heights below its lowest block, as far back as evidence may reach, with the lowest such height.

Validator sets are stored by hash rather than only by height because they rarely change and each one is large: 1312 bytes of ML-DSA public key per validator, which the header of `src/store/blockstore.ts` rounds to 1.3 KB. A header names its set by hash, so the set that signed any past height is two lookups away, which is what evidence verification needs. Sets are also stored by the height they sign, with proposer priorities, because a node that joins by state sync must continue consensus with the exact priorities the chain had (RPC-SYNC-PROOFS.md, sections 1 and 4.2); the hash excludes priorities, so the by-hash copy cannot supply them.

The transaction index and the per-block results are derived data outside the state root (RPC-SYNC-PROOFS.md section 2.3): replay or backfill rebuilds them. The lowest height is what retention moves: after each commit the executor deletes blocks below `lastHeight - blocks`, never below the newest snapshot, and records where the contiguous range now starts.

The header records answer a question a state-synced node could not otherwise answer. A block after the join may carry evidence of a double sign at any height within the evidence age, and applying it takes the validator set that header names and the time of that height, which every other node reads from its own blocks. State sync therefore fetches the headers below its snapshot height, each bound to the one above it by its hash, and stores them alone (chapter 7); the executor reads them where it would read a block's header, and prunes them as the evidence window moves on. Backfill replaces each one with its block. The records are contiguous from the lowest header height up to the lowest block.

### Atomic file replacement

Two things are files rather than records: the double-sign guard's record of what the validator last signed, and the wallet's keystore. Both must never be half-written. The standard recipe is to write the new content to a temporary file, `fsync` it, rename it over the old name (a rename is atomic on POSIX file systems), and then `fsync` the directory so the rename itself reaches the disk. Without the last step a power loss can bring the old file back after the new one was already acted on; for the signing guard that would mean a validator forgetting a signature it broadcast, and signing a conflicting one after restart. That was review finding 16 in REVIEW-2026-10-28.md, and finding 26 (the keystore truncating and rewriting its only file, so an interrupted `add` could destroy every stored key) was fixed by routing the keystore through the same function.

## The code, file by file

### src/store/kv.ts

Purpose: the interface, the in-memory implementation, and the prefix helper.

Exports:

- `interface KvWriter { put(key, value); del(key) }`: what a `write` callback receives.
- `interface KvStore { get(key); range(start, end); write(fn) }`: one named store. `range` yields `[key, value]` pairs with `start <= key < end`, ascending.
- `interface KvEnv { store(name); transaction(fn); close() }`: a set of named stores sharing one environment. `transaction(fn)` runs writes to several stores of the environment as one transaction: on disk they all land or none does, whatever happens in between; in memory each store's write lands on its own, since there is no crash to recover from. `close` is the only asynchronous method, because closing LMDB is.
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
    // Buffer the writes so a throw inside fn leaves the store untouched.
    const puts: [Uint8Array, Uint8Array][] = [];
    const dels: Uint8Array[] = [];
    fn({ put: (k, v) => void puts.push([k.slice(), v.slice()]), del: (k) => void dels.push(k.slice()) });
    for (const k of dels) this.tree.delete(k);
    for (const [k, v] of puts) this.tree.set(k, v);
  }
```

Keys and values are copied on the way in as well as on the way out, so a caller that reuses a buffer after `put` cannot corrupt the store, and the B+ tree, which stores keys by reference, is safe. The atomicity test in `test/store.test.ts` relies on the buffering: a callback that puts `d` and then throws leaves `d` absent, because nothing is applied until the callback returns. One difference from LMDB to notice: deletes are applied before puts, whatever order the callback issued them in, so a `put(k)` followed by `del(k)` in one `write` leaves `k` present here and absent in LMDB. No caller in `src/` does both to one key in one write; the application's commit deletes history for the version leaving the window, which is never the version being written, and the block store's deletions are separate writes.

`size` is the entry count, which `test/app.test.ts` uses as a cheap "something was persisted" check. `MemoryEnv.store(name)` creates a store on first use and returns the same one afterwards; `transaction(fn)` just calls `fn()`, so each store's `write` inside it lands on its own; `close` does nothing. The in-memory store is what every engine and application test runs on, and what `Node` uses when no data directory is configured.

### src/store/lmdb.ts

Purpose: the same interface on LMDB.

Exports:

- `class LmdbEnv implements KvEnv` with `constructor(path, { readOnly? })`, `store(name)`, `transaction(fn)` and `close()`.

The store class is private to the file:

```ts
class LmdbStore implements KvStore {
  private readonly db: Database<Buffer, Buffer>;

  constructor(db: Database<Buffer, Buffer>) {
    this.db = db;
  }
```

Its three methods are each one call into lmdb-js:

```ts
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
```

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
    return new LmdbStore(this.root.openDB<Buffer, Buffer>({ name, keyEncoding: 'binary', encoding: 'binary' }));
  }
```

Binary key encoding is what makes LMDB's order the bytewise order the keys were designed for; with a key encoding that transforms keys before comparison, the ranges would not line up with `prefixEnd`. `close` awaits the root's close; `Node` calls it only for an environment it created itself (`ownsEnv`).

`transaction` is a write transaction on the root database:

```ts
  transaction(fn: () => void): void {
    // A store's write() inside the callback runs as a child of this transaction, whatever database it is on; a throw
    // out of the callback aborts the lot, and nothing reaches the disk until the callback returns.
    this.root.transactionSync(fn);
  }
```

lmdb-js nests transactions: a `transactionSync` opened on a sub-database while one is open on the root becomes a child of it, so every `write` the callback makes, on whichever named store, joins the environment-wide transaction, and a throw out of `fn` aborts them together (this was probed before it was relied on: nothing lands). State sync is the one caller: its install writes the application store, the validator sets, block H, the lowest heights and the chain state inside `env.transaction`, so a crash leaves either a complete join or nothing, and a restart simply joins again (chapter 7). The `MemoryEnv` version just runs the callback, which is the right stand-in: in memory there is no crash to recover from, and the store the tests see is the same whether the writes were one transaction or several.

Two behaviours of lmdb-js to know. `openDB` builds a new database object on every call, so two calls to `store('app')` give two wrappers over the same named database; nothing in `LmdbEnv` caches them, and the node calls `store` once per name in the normal path. And in a read-only environment, `openDB` of a name that does not exist returns `undefined` rather than throwing, so a wrapper built over it fails on first use with a type error instead of a clear message; the test opens a name that exists.

### src/store/blockstore.ts

Purpose: the chain's persistent records on a `KvStore`.

Exports:

- `interface TxLocation { height; index; ok: boolean | null; error }`: where a transaction landed. `ok` is null for a block stored without executing it here (a backfilled block).
- `interface BlockStore`: `loadBlock`, `saveBlock`, `heightOf`, `txLocation`, `loadResults`, `loadState`, `saveState`, `loadValidatorSet`, `saveValidatorSet`, `loadValidatorsAt`, `saveValidatorsAt`, `lowestHeight`, `setLowestHeight`, the header records `loadHeader`, `saveHeader`, `deleteHeader`, `lowestHeaderHeight` and `setLowestHeaderHeight`, `deleteBlock`, and `batch(fn)`, which runs several saves as one store transaction "so a crash leaves all or none of them".
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
const txKey = (hash: Uint8Array) => key((k) => k.u8(0x74).fixed(hash));
const resultsKey = (h: bigint) => key((k) => k.u8(0x72).u64(h));
const headerKey = (h: bigint) => key((k) => k.u8(0x48).u64(h));
const LOWEST_HEADER_KEY = key((k) => k.u8(0x4c));
```

In ASCII: `'s'` state, `'l'` lowest height, `'b'` block by height, `'h'` height by block hash, `'v'` validator set by hash, `'V'` validator set by the height it signs, `'t'` transaction location by hash, `'r'` results by height, `'H'` a header kept without its block, `'L'` the lowest height with such a header. Because heights are big-endian u64, the blocks sort by height and a range over `'b'` walks the chain in order. The prefixes are the same letters the application store uses for different things (`'h'` is a block hash here and a history version there); that is fine because the two live in different named stores.

Every save goes through a private `write` that either joins a batch in progress or opens its own transaction:

```ts
  /** The writer of a batch in progress; every save joins it instead of opening its own transaction. */
  private open: KvWriter | null = null;

  constructor(kv: KvStore) {
    this.kv = kv;
  }

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

  private write(fn: (w: KvWriter) => void): void {
    if (this.open) fn(this.open);
    else this.kv.write(fn);
  }
```

The invariant: while a batch is open, every save of this store joins its transaction, and a nested `batch` call joins the outer one instead of opening a second (the inner call just runs `fn`; only the outermost call holds the writer and clears it in `finally`, so a throw anywhere inside aborts the one transaction and leaves `open` null for the next caller). Outside a batch each save is its own transaction, as before. Reads (`loadBlock`, `loadState` and the rest) go to the store directly, not through the open writer; on the memory store, whose `write` buffers, a read inside a batch does not see the batch's own writes, and no caller relies on it either way. The executor's `doApply` in `src/node/executor.ts` is the batch user:

```ts
    // Block, commit, results, the next set and the new state land together or not at all.
    this.d.store.batch(() => {
      this.d.store.saveBlock(block, commit, res.txResults);
      this.d.store.saveValidatorSet(newState.nextValidators);
      this.d.store.saveValidatorsAt(h + 2n, newState.nextValidators);
      this.d.store.saveState(newState);
    });
```

A commit update for an already applied block and the retention pass that moves the lowest height are single saves and open their own transactions.

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
        // A transaction repeated in one block can only have succeeded once, at its first position.
        const seen = new Set<string>();
        block.txs.forEach((tx, i) => {
          const hash = txHash(tx);
          const k = toHex(hash);
          if (seen.has(k)) return;
          seen.add(k);
          const r = results?.[i];
          w.put(txKey(hash), encode((wr) => wr.u64(h).u32(i).u8(r ? (r.ok ? 1 : 0) : 2).string(r?.error ?? '')));
        });
        if (results) w.put(resultsKey(h), encode((wr) => wr.array(results, (wr, r) => wr.bool(r.ok).string(r.error ?? ''))));
      }
```

The location value is the height, the position, a status byte (1 ok, 0 failed, 2 not executed) and the error string. The `seen` set and the per-block results array are review finding 18: with one location per hash, a block containing `[T, T]` used to overwrite T's successful first position with the failing second one, so the RPC reported a failure and the result proof did not verify. Now the first position owns the index entry and `loadResults(height)` returns every position's result, from which a result proof for any position can be built. `txLocation(hash)` decodes the status byte back:

```ts
    return decode(v, (r) => {
      const height = r.u64();
      const index = r.u32();
      const ok = r.u8();
      return { height, index, ok: ok === 2 ? null : ok === 1, error: r.string() };
    });
```

The rest are one-key reads and writes: `heightOf(hash)`, `loadState` / `saveState` (the `ChainState` encoding from `src/types/state.ts`), `loadValidatorSet` / `saveValidatorSet` keyed by `set.hash()`, `loadValidatorsAt` / `saveValidatorsAt` keyed by height, `lowestHeight`, which defaults to 1 when nothing was stored, and the header records: `loadHeader` / `saveHeader` keyed by the header's own height (the `Header` encoding from `src/types/block.ts`), `deleteHeader`, and the marker of the lowest one, which unlike `lowestHeight` has no default, because a node that never state-synced has no such records:

```ts
  lowestHeaderHeight(): bigint | null {
    const v = this.kv.get(LOWEST_HEADER_KEY);
    return v ? decode(v, (r) => r.u64()) : null;
  }

  setLowestHeaderHeight(height: bigint | null): void {
    this.write((w) => (height === null ? w.del(LOWEST_HEADER_KEY) : w.put(LOWEST_HEADER_KEY, encode((wr) => wr.u64(height)))));
  }
```

Setting the marker to `null` deletes the key, which is what header pruning does once the last record is older than the evidence window and what backfill does once a block has replaced the record the marker pointed at. `deleteBlock(height)` is what retention and pruning use; it loads the block first so it can remove the hash index entry and every transaction entry in the same transaction:

```ts
  deleteBlock(height: bigint): void {
    const stored = this.loadBlock(height);
    if (!stored) return;
    this.write((w) => {
      w.del(blockKey(height));
      w.del(hashKey(blockHash(stored.block)));
      w.del(resultsKey(height));
      for (const tx of stored.block.txs) w.del(txKey(txHash(tx)));
    });
  }
```

Something to notice: the transaction index has one entry per hash across all blocks. If a transaction that succeeded at height h is included again at a later height (it would fail there as a replay), the later `saveBlock` overwrites its entry with the failing location, and a later `deleteBlock` of that block removes the entry although the earlier inclusion is still stored. The `seen` guard covers repeats inside one block only; the mempool does not admit a committed transaction again, so this needs a proposer to include one deliberately. Validator sets are never deleted; they are small in number and needed for evidence at any retained height.

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

The file is either the old content or the new content, never a mix: the data goes to `path.tmp`, is synced, and only then takes the name. The directory sync is the fix for review finding 16. It is wrapped in a `try`, but the catch is selective. The error codes that mean "this platform or file system does not let a directory handle be opened or synced" (`EINVAL`, `EPERM`, `ENOTSUP`, `EISDIR`, `EBADF`, `EACCES`) are swallowed, because in that case the data file itself is still durable and only the rename could in principle be lost. Any other error means the sync was attempted and failed, an I/O error on a file system that does support it, and that is rethrown: a signing guard whose record may not have reached the disk must not report success, and a caller that caught a blanket exception would never know. `src/consensus/privval.ts` writes the signing guard through it, and `src/wallet/keystore.ts` the keystore. The temporary name is fixed, so two processes writing the same path would race; both callers are single-process files in a node's own directory. The function is synchronous like the store, for the same reason: the signing guard must be on disk before the signature it records leaves the process.

## How it is tested

`test/store.test.ts`:

- "memory store orders keys bytewise and makes writes atomic": `exerciseKv` puts keys out of order, reads one back, finds a missing key undefined, scans the prefix `b` with `prefixEnd` and gets the two `b/` keys in order, scans `[a, z)` and gets four, throws inside a `write` and finds the key it put absent, and deletes a key.
- "lmdb store does the same and survives reopening": the same exercise on an `LmdbEnv` in a temporary directory, then a reopen reads a value back, and a second, read-only environment on the same directory sees the deletion.
- "block store finds blocks by height and by hash on both backends": five blocks saved on a `MemoryBlockStore` and on a `KvBlockStore` over LMDB; `loadBlock(3)` returns the block with its commit, `heightOf` finds block 4 and returns null for an unknown hash, `loadBlock(9)` and `loadState` return null.

`test/review.test.ts`, "keeps per-block results so a repeated transaction proves its real outcome at each position": a block `[T, T]` with results success then failure; `txLocation` points at position 0 with `ok: true`, `loadResults` returns both, and a result proof for position 1 verifies against the results root with `ok: false` (finding 18). Its neighbour "saves everything a height needs to the block store in one transaction" subclasses `MemoryKv` to count calls to `write`: a `batch` holding `saveValidatorSet`, `saveValidatorsAt` and `setLowestHeight` costs one, the values are readable afterwards, and a `setLowestHeight` outside the batch costs another (finding 39).

`test/app.test.ts`, "restarts from the store with the same app hash and keeps producing the same hashes": the application on a `MemoryKv` is reopened from it, serves the same app hash and the same proofs, and after the window slides the history keys under prefix `0x68` are exactly versions 4 to 7, showing that commit deletes the record that left the window. `test/genesis.test.ts` reopens an application from a `MemoryKv` and checks the app hash matches an inline genesis.

The remaining block store methods (state, validator sets by hash and by height, lowest height, the header records, deletion) are covered indirectly by the engine, recovery, sync and network suites of [chapter 15](15-tests.md), which restart nodes and prune blocks on these stores; `test/sync.test.ts` reads the header records of a state-synced node back (`lowestHeaderHeight` is 1, header 7 equals a validator's, and both are gone once backfill reached genesis). `test/review.test.ts`, "persists a decided height to the chain store in one transaction", builds a `KvEnv` by hand whose `transaction` just runs its callback, which is all the executor's commit path asks of it. The LMDB path under load is measured rather than tested: the figures in README.md quoted above.

## Limitations and ideas

- `MemoryKv.write` applies deletes before puts; LMDB applies operations in order. The two agree for every current caller but not in general.
- The transaction index is one entry per hash across the chain; a transaction included twice in different blocks keeps only the later location, and deleting the later block removes it.
- Values carry no checksum of their own; the chain trusts LMDB's page-level integrity and checks the application state against the stored app hash on start.
- A block and its commit share one value, so storing a fuller commit rewrites the whole block.
- `LmdbEnv.store(name)` returns a new wrapper on every call and does not cache; a read-only open of a missing name yields a wrapper that fails on use (noted and left in REVIEW-2026-10-28.md).
- `batch` is per `KvBlockStore` and therefore per named store: the application's `commit` on the `app` store is a separate transaction, so a crash between the block store's batch and `app.commit` is still repaired by replay, as DESIGN.md section 4 describes. `KvEnv.transaction` could enclose both, as it does for the state-sync install, but the commit path does not use it.
- There is no compaction or map-size management beyond lmdb-js's defaults.

Exercises:

1. Make `MemoryKv.write` apply operations in the order the callback issued them, and add a test to `exerciseKv` that puts and then deletes one key in a single `write` on both backends.
2. Give the transaction index a per-block entry (`'t' || hash || height`) and make `txLocation` return the earliest successful one; then make `deleteBlock` remove only its own.
3. Add a third backend (for example SQLite or a log-structured file) behind `KvStore` and run `test/store.test.ts` against it unchanged.
4. Measure `write` latency on LMDB with and without the sync (lmdb-js exposes options for it) and relate the difference to what crash recovery in [chapter 8](08-node.md) would have to replay.
5. Write a tool that opens a node's `data/lmdb` read-only, as the test does, and prints the key layout of each store with counts per prefix byte; then make `LmdbEnv` report a missing name clearly.
6. Add a checksum (for example the first 8 bytes of SHA-256) in front of every value of the block store and verify it on read; measure the cost in the block sync benchmark.

## Where to next

[Chapter 11, the application](11-application.md): the object types, the transaction format, the evaluators, and how commit writes the database's change list to the `app` store opened here.
