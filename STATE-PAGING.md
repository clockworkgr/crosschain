# State paging specification

Status: phases one to three implemented: the arena (`src/db/arena.ts`, `src/db/index.ts`,
`src/db/database.ts`), the index entries on disk and the droppable index trees
(`src/db/indexstore.ts`, `src/db/index.ts`, `src/db/database.ts`, `src/app/core/app.ts`), with
tests in `test/db.test.ts`, `test/arena.test.ts`, `test/app.test.ts` and `test/memory.test.ts`;
together with the first two of phase five's dials (the guard caps the hot cache, and drops
the index trees at `pressure`). Phase four (tree chunks) and the rest of phase five are
designed here and not yet built. Decisions were taken in conversation on 2026-10-30. `DESIGN.md` section 6
describes the object database this changes, and `docs/benchmarks.md` sections 4.9 and 7
hold the measurements it starts from.

## 1. The property

A node with enough memory works as designed: the whole state resident, lookups in tens of
nanoseconds. A node nearing the heap limit keeps working indefinitely, slower, instead of
aborting. The way to have both is to make memory a cache at every tier and LMDB the truth:
with memory to spare nothing is ever evicted and the node is today's node; under pressure
each tier is evicted in turn and reads fall through to the store, whose memory map the
operating system pages in and out. What then bounds the node is the working set of one
block plus whatever cache it is granted, not the size of the state.

The measured starting point (docs/benchmarks.md 4.9): 3.2 KB of heap per account with its
balance whatever the signature scheme, because the keys live in array buffers and what the
heap holds is the database itself. Phase one measured how that divides: the decoded objects
are about a sixth of it (0.55 KB), and the secondary indices, the name tree and the Merkle
trees the rest (2.65 KB). The expectation when this was written, a third for the objects, was
wrong, and it moves the weight of the later phases onto tiers two and three.

## 2. Summary of decisions

| topic | decision |
|---|---|
| truth | LMDB holds every tier's complete state at every committed height; memory holds accelerators |
| tier one, objects | encoded bytes in packed slabs (an arena), decoded through a bounded hot cache; dirty objects pinned decoded until the next root |
| tier two, indices | one LMDB key per index entry written at every commit; the B+ trees stay as droppable accelerators with an overlay-merged cursor scan as the fallback |
| tier three, trees | the dense and sparse trees' changed chunks and nodes written at every commit; the live trees stay as droppable accelerators with chunk reads as the fallback |
| eviction order | decoded cache, then cold slabs, then index trees, then tree chunks |
| who turns the dials | the memory guard (`src/node/memory.ts`): `ok` evicts nothing, `warn` caps the caches, `pressure` drops the accelerators, `critical` stops cleanly |
| always on | the extra writes per commit are not a mode; a node that never pages pays them anyway, a few percent of warm throughput, so that the fallback exists the moment it is needed |
| determinism | unchanged: roots are computed from the same leaves and the same bytes, wherever they are read from |
| history | past values kept as encoded bytes, not decoded objects; the retention window costs bytes, not records |

## 3. Tier one: the arena (phase one)

### 3.1 What changes

The primary index of a type was an array of decoded, frozen objects by instance. It is now
two things: the committed encoding of every object in the arena, addressed by a per-type
table of references, and a hot cache of decoded objects over it.

- **Arena** (`src/db/arena.ts`): slabs of bytes, the first 256 KiB and each next one twice
  the last up to 16 MiB, filled by a bump allocator. An entry is a 10-byte header (type u16,
  instance u32, length u32) followed by the encoding. Freeing an entry only counts its bytes
  dead; a slab whose dead bytes exceed half its used bytes is compacted after a root: its live
  entries are copied into the current slab, their owners are told the new references, and the
  slab's buffer is released. At most two slabs are compacted per root, so the pause is
  bounded by 16 MiB of copying. An encoding larger than a slab is refused (no object is: the
  largest, the dynamic properties with a thousand validators, is under 2 MiB).
- **References**: per type, a `Float64Array` of slab-and-offset packed into one number
  (-1 for absent) and a `Uint32Array` of lengths, both growing by doubling with the instance
  counter.
- **Hot cache**: per type, a `Map` from instance to decoded object, evicted by CLOCK: a hit
  sets the instance's touched bit, a fresh decode enters with it clear (so a one-time read is
  the first to go and a scan of the state does not wash out a block's working set), and when
  the budget is spent a hand sweeps the type's instances, clearing bits it finds set and
  evicting the first clean entry it finds clear. A hit is one byte store, an eviction a few
  map lookups, and nothing is ever sorted; a type whose cache is all pinned (a genesis being
  built) marks itself saturated and does nothing until the next root. Dirty objects (written
  since the last root) are pinned and never evicted; tombstones (`null`) mark removals the
  arena has not seen yet. The budget `hotObjects` is shared by all types and unbounded by
  default, so a node with memory to spare keeps every decoded object and runs as it did;
  `setHotLimit(n)` changes it at run time, and the memory guard does: 100,000 at `warn`,
  10,000 at `pressure`, unbounded again at `ok` (section 7).
- **Writes**: `create`, `modify` and `remove` touch the hot cache and the secondary indices
  only, as before. Encoding happens once per object per root, as before: `root()` encodes
  each dirty object's value, hashes it, writes it to the arena, frees the old entry and
  unpins it. Undo puts old decoded values back into the hot cache, so a transaction that
  fails costs no arena traffic.
- **Reads**: `get` answers from the hot cache, else decodes from the arena (about a
  microsecond for an account), freezes the result and caches it. Secondary indices map keys
  to ids as before, so a lookup is a tree walk plus a `get`.
- **History**: before-values are kept as bytes; `getAt` decodes on demand, `bytesAt` hands
  the bytes out, and snapshots are built from `bytesAt` without a decode and re-encode.
  Loading history on restart stores the bytes the store kept, with no decode.
- **Import and export**: `importObject` writes the bytes into the arena directly, decoding
  once to build the indices and keeping nothing decoded; `exportObjects` yields the arena's
  bytes. The first root after an import hashes the arena's bytes without decoding.
- **Accounting**: `memory()` reports arena bytes used and dead, slab count, hot objects and
  their limit, and history bytes; `status` carries it under `memory.database`.

### 3.2 What stays

The public API of `ObjectDatabase` (get, lookup, scan, scanFrom, create, modify, remove,
sessions, getCommitted, getAt, countAt, root, proofs, history, import, export, snapshots) is
unchanged, as are the codec, the trees, the indices and every root. The tutorial's chapter
09 describes a database whose records are frozen immutable values; that remains true of
what `get` returns.

### 3.3 Measured effect

At 191,896 accounts with two keys each under secp256k1 (the genesis benchmark at 56 MB),
against the same run before the arena:

| | before | resident (cache unbounded) | capped at 100,000 objects |
|---|---:|---:|---:|
| heap after building | 597 MiB | 607 MiB | 583 MiB |
| heap after a restart | 601 MiB | 585 MiB | 489 MiB |
| array buffers (keys, and now the arena) | 41 MiB | 79 MiB | 79 MiB |
| build (apply, root, persist) | 5.7 s | 5.9 s | 5.9 s |
| block of 500 transfers among random accounts | 21.5 ms | 24.8 ms | 41 ms |
| restart from LMDB | 8.7 s | 8.5 s | 8.5 s |

And on the small-scale suites under ML-DSA-44: `finalizeBlock 500 transfers, warm` 27,400 to
25,000 a second, cold 6,290 to 6,040, admission 6,680 to 6,420, `get by id` 42 to 72 ns (a
map lookup instead of an array index).

So the resident mode costs about 6% more memory (the encoded copy beside the decoded one)
and 5 to 15% of speed, and the capped mode saves 17% of the heap with an empty cache at the
price of a block of random transfers taking twice as long: that is the degraded mode the
property calls for, and it is what the guard turns on. The arena is the object tier the later
phases need, with the overlay and the dial already in place, but by itself it does not move
memory much, because decoded objects were never the bulk of it. The history window does
shrink from records to bytes, and snapshots and proofs no longer decode and re-encode.
Acceptance held for speed (warm block within 10%, restart no slower) and not for memory
(the 2.5 KB per account target assumed the wrong budget).

## 4. Tier two: indices (phases two and three)

### 4.1 Disk form

Every secondary index entry is one LMDB key in the application store, written and deleted
in the same transaction as the objects of the version that changed it:

```
'i' type u16, index position u8, key bytes          -> id u64      (unique index)
'i' type u16, index position u8, key bytes, id u64  -> empty       (non-unique index)
```

The index position is the index's place in the type's definition, so the key layout is fixed
by the type registry. Bytewise order of LMDB keys is the order the B+ trees keep, so a prefix
scan is an LMDB range and a cursor from `start` is `scanFrom`. The four-byte header is the
only thing added to the key the tree holds (a non-unique key already ends with the id), and
the id is big-endian, the same eight bytes the sparse trees hash as the value.

As built (`src/db/indexstore.ts`):

- **Reported per root.** `Changes.indices` lists the entries a root added (key and value) and
  removed (key, null value), removals first, so a key passed from one object to another in
  one block ends with its new owner when the list is applied in order. For each object the
  root changed it compares the keys the object had at the last root with its keys now; both
  were computed by the writes anyway (to unindex the old value and index the new), so the
  index keeps them per dirty object and a root compares arrays instead of encoding keys again.
  A key the object kept writes nothing, so a transfer, which changes amounts and no key,
  costs no index write. The first root of a database writes every entry (the genesis), unless
  its objects were imported from a store that holds them (a restart). A database with no
  store behind it and its trees resident reports nothing, there being nothing to keep.
- **Written.** `CoreApp.persist` writes the list in its single `kv.write` with the objects,
  the counters, the history and the meta key. `writeImportedState` (state sync) writes every
  entry from `indexEntries()`, which walks the indices as they stand.
- **Reopening.** The store's entries are what a restart builds the indices from: objects are
  imported as bytes with no decode at all (`importObject(id, bytes, indexed)`), and
  `loadIndexEntries()` walks the 'i' prefix once, filling the B+ trees in key order (their
  cheapest order to grow in) and the sparse trees from the same entries. Measured at 192,000
  accounts this is as fast as decoding every object for its keys was, within a few percent
  (both are dominated by hashing the name tree; 4.4), and it is the read a node with dropped
  trees does anyway, so it is the one kept. A store written before phase two has no 'i'
  prefix; opening one decodes the objects for their keys as before and writes the entries once.
- **Checked.** `checkIndexStore()` (for tests) compares the resident trees with the store:
  every tree entry is there with its value, and the count of keys under each index's prefix
  equals the tree's size.

### 4.2 Fallback reads

While a type's index tree is dropped, `lookup` is one LMDB get and `scan` / `scanFrom` is an
LMDB cursor merged with the overlay: entries the open sessions added appear, entries they
removed are skipped, and a key both removed and re-added yields the new id. The merge walks
the cursor and the overlay's sorted keys together, as Cosmos SDK's cache-KV iterator does.
Uniqueness checks on `insert` consult the overlay, then the tree if present, then LMDB.

As built, what a dropped index reads is three layers, each laid over the one below by the
same merge (`overlaid` in `src/db/indexstore.ts`):

1. **The store** the application gives the database as `indexStore` (its app store; the
   database only reads it). A database without one (tests, benchmarks, a snapshot being
   imported) builds an in-memory store when it first drops a tree, holding the entries as of
   the last root, applies every later root's changes to it, and lets it go when every tree is
   resident again.
2. **The unwritten roots.** Between a root and the application's write of it (`commit()`
   comes after `finalizeBlock`) the store is a block behind; the root's own change list is
   laid over it until `dropChanges()` says it is written. Without this a query between the
   two would see an index older than the objects.
3. **The overlay**, per index: a B+ tree from key to an id, or to null for a key released.
   It is the difference between the last root and now, kept by the writes themselves: while
   the tree is dropped, every write that would have set or deleted a tree key (create,
   modify, remove, and the undo of each, which goes through the same calls) sets the
   overlay instead. A root empties it, since the store with the root's changes then says
   the same. When the trees are dropped in the middle of a block, the overlay starts from
   what is dirty: for each object written since the last root, its committed keys (from the
   value the root shadow holds) are set to null, then its current keys to its id, all the
   releases before all the takes, so a key that changed hands ends with its new owner, and a
   key an object kept ends as it was.

So a lookup is an overlay probe, a probe of the unwritten change list (empty almost always),
and one LMDB get; a scan is two or three cursors merged lazily, nothing materialised, and a
caller that stops after a page closes the LMDB cursor. The edge cases are tested directly
(`test/db.test.ts`): a key handed from one object to another in one block, an object created
and removed before a root, a session undone while the trees are dropped, a read between a
root and the store's write of it; and a randomised test plays writes, nested sessions
committed and undone, roots, drops and rebuilds at arbitrary moments on a database that drops
and one that never does, and requires the same lookups, scans and roots after every step.

### 4.3 Dropping and rebuilding

A tree is dropped whole (the guard's `pressure` level) and rebuilt whole from LMDB when
memory returns (`ok`), by walking the type's prefix; until then every read of that type
takes the fallback. The authenticated indices' sparse trees are tier three.

As built: `dropIndexTrees(type?)` and `rebuildIndexTrees(type?)` act on one type or on all;
a type's indices go together. Both may be called with sessions open, mid-block: the drop
builds the overlay from the dirty set (4.2), the rebuild walks the merged view (store,
unwritten roots, overlay) into fresh trees, so neither changes a lookup or a root. Dropping
with a store behind is cheap (it touches only what is dirty); rebuilding reads the whole
prefix. The node's guard drops every type's trees at `pressure` (and `critical`) and rebuilds
them at `ok`; `status.memory.database.indexTrees` reports `resident`, `dropped` or `partial`.
A database can also start dropped (`indexTrees: false`), and the test setup does that for
every database when `INDEX_TREES=0`, which is how the acceptance test of phase three runs the
application's suites on the fallback (9).

### 4.4 Measured effect

Index entries on disk, against the phase-one code run on the same machine, alternated with
the new code (single runs vary by about 5%, so most rows give the range of several):

| | before | after |
|---|---:|---:|
| `commit to LMDB (after a 500-transfer block)` | 8.65 to 9.21 ms, mean 8.95 | 8.86 to 10.0 ms, mean 9.63 |
| `commit to memory (after a 500-transfer block)` | 2.55 to 2.88 ms | 3.13 to 3.87 ms |
| `modify 1,000 balances + root` (db suite, no store) | 19.3 to 19.6 ms | 19.7 to 19.8 ms |
| `first root over 100,000 objects` (db suite, no store) | 323 to 326 ms | 347 to 354 ms |
| genesis at 191,896 accounts (secp256k1, 56 MB): build | 5.96 s | 6.67 to 6.73 s |
| of which root | 1,569 ms | 1,809 to 1,903 ms |
| of which persist | 406 ms | 946 to 959 ms |
| LMDB on disk after genesis | 34.6 MiB | 92.7 MiB |
| block of 500 transfers at that size: commit to LMDB | 10.6 ms | 11.8 to 12.2 ms |
| restart from LMDB | 8.92 s | 8.43 to 8.49 s |
| of which import / indices and root | 3,899 / 1,119 ms | 281 to 298 / 4,462 to 4,508 ms |
| heap after a restart | 585 MiB | 572 MiB (array buffers 79 to 90 MiB) |

A 500-transfer block writes about a thousand entries (each transfer leaves a recent
transaction id, two index entries; the balances change no key), so the commit costs about
0.7 ms more, 7%. The genesis writes 576,000 entries (a name, an owner-asset key
and an asset key per account): a third of a second to list them at the first root and half a
second to write them, and 58 MiB of LMDB, about 100 bytes an entry with LMDB's page overhead.
Peak RSS during the build rose with it (1.69 to 2.18 GiB), most likely the transient list
and the larger write transaction; the heap after building is unchanged at 607 MiB. Writing
the genesis entries straight from the trees instead of from a list would remove the first
part. The same restart run with the indices built from the objects instead (the old path,
kept for a store that predates the entries) took 8.49 s (import 3,726 ms, root 1,200 ms)
against 8.43 s from the entries; two direct reopens of the same store, 8.89 s against
8.84 s. The name tree's hashing dominates both. The rows of the db suite carry no store, so they show only the bookkeeping (the keys
kept per dirty object).

Droppable trees, from the db suite at 100,000 balances and 21,000 accounts (per 1,000
lookups and per 100 scanned entries, same runs):

| | resident | dropped, in-memory store | dropped, LMDB |
|---|---:|---:|---:|
| lookup by unique index (byOwnerAsset), 1,000 | 1.04 to 1.34 ms | 1.18 to 1.46 ms | 1.02 to 1.20 ms |
| scan 100 entries of a non-unique index (byAsset) | 9 to 13 µs | 24 to 28 µs | 50 to 57 µs |
| modify 1,000 balances + root | 19.7 to 20.8 ms | 22.1 to 23.0 ms | |
| rebuild every index tree | | 130 to 138 ms | 182 to 212 ms |

A lookup through LMDB costs about what a resident one does (the resident row varies more
between runs than the difference), because both are dominated by building the key and
fetching the object; a scan costs four to six times as much, the price of copying every key
and value out of LMDB and merging two cursors, still under a microsecond an entry. At genesis scale (`account by name`, 192,000 accounts) resident lookups
measured 1.41 ms per 1,000 before and 1.61 ms after in the genesis run, and 1.78 against 1.81
ms in a direct comparison of the two builds at that size (15 rounds each, medians), so about
2%; the genesis run's larger gap is mostly that run's noise.

## 5. Tier three: trees (phase four)

### 5.1 Disk form

The dense trees already have a persisted record form for the history
(`TreeRecords`: level, position, hash). The live trees' changed chunks are written at every
commit:

```
'c' tree u16, level u8, chunk u48  -> up to 1024 hashes      (dense tree chunk)
'n' type u16, index position u8, path bytes -> node           (sparse tree node)
```

### 5.2 Fallback reads

With a tree's chunks dropped, computing a root reads each changed leaf's path from LMDB (a
chunk per level, about twenty per changed leaf, through a small LRU of chunks, so the upper
levels are shared and resident) and writes the changed chunks back at commit. A sparse tree
read walks nodes by path. Proofs at the current version read the same way; proofs at past
versions still need the history records, which stay in memory for the window as now.

## 6. The commit transaction

At every root the application store receives, in one LMDB transaction: the changed objects
(as now), the counters (as now), the history record (as now), and from phase two the index
entries added and removed, and from phase four the changed chunks and nodes. The cost is
measured at each phase against `commit to LMDB (after a 500-transfer block)`, 8.8 ms when
phase one was done.

Phase two as built: the entries are `Changes.indices`, removals before additions, written
by `CoreApp.persist` after the objects in the same `kv.write`; `commit to LMDB` went from
about 9.0 ms to about 9.6 ms (4.4). The database lays the change list over the store until
the application calls `dropChanges()` after writing it, so the store being a block behind
between `finalizeBlock` and `commit` is invisible to dropped indices.

## 7. The guard's dials (phase five)

| level | heap used of limit | what the database does |
|---|---|---|
| ok | under 70% | caches unbounded (built); dropped index trees rebuilt (built), other dropped accelerators rebuilt |
| warn | 70% | hot cache capped at 100,000 decoded objects (built); cold slabs may be released; major collection started |
| pressure | 85% | hot cache capped at 10,000 (built); index trees dropped (built) and cold chunks dropped; costly RPC methods still refused, since proofs at past heights read history |
| critical | 95% | clean stop, as now; reached only when one block's working set does not fit |

The mempool is no longer paused at `pressure` once phase three is in: admission reads
through the fallback like everything else. (Not yet changed: the node still pauses the
mempool while it sheds load; the fallback itself is ready for admission, and
`test/app.test.ts` checks transactions against it.) `critical` keeps the trees dropped. `status` reports the mode of each tier
(resident, capped, dropped) and the hit rates.

## 8. Performance envelope

| read | resident | from the page cache | from an NVMe |
|---|---:|---:|---:|
| object by id | 40 ns (hot) or 1 µs (decode) | 2 µs | 100 µs |
| index lookup | 1 µs | 2 µs | 100 µs |
| root over 20,000 changed leaves | 300 ms | about 1 s | several seconds |

A full node keeps committing at any of these; a validator slower than the round timeouts
misses rounds and, past the downtime window, is jailed. The guard's log says which tier is
paging, so the operator knows whether to add memory or a faster disk.

## 9. Phases and acceptance

1. **Arena** (this change): memory per account as in 3.3; every existing test unchanged.
2. **Index entries on disk** (built): written at every commit, read by a restart (which builds
   the indices from them) and by the fallback; commit cost measured (4.4, 6).
3. **Droppable index trees** (built): fallback lookups and merged scans; a test drops every
   tree and runs the application suite against the fallback: `INDEX_TREES=0 npx vitest run
   test/app.test.ts test/staking.test.ts test/fees.test.ts test/db.test.ts` passes, as does
   the whole suite with `INDEX_TREES=0` (4.3).
4. **Chunks on disk and droppable trees**: a test drops the trees and verifies roots match.
5. **Guard integration and a paging benchmark**: a node started with `--heap` below its state
   size keeps committing blocks; the benchmark reports blocks per second at each level. Built
   so far: the hot cache dial (phase one) and the index tier's dial (drop at `pressure`,
   rebuild at `ok`, reported in `status`).

## 10. Defaults

| parameter | default |
|---|---|
| hotObjects | unbounded; the guard caps it at 100,000 (`warn`) and 10,000 (`pressure`) |
| slab size | 256 KiB first, doubling to 16 MiB |
| compaction | a slab with dead bytes over half its used bytes, at most two per root |
| entry header | 10 bytes: type u16, instance u32, length u32 |

## 11. Tests

`test/arena.test.ts`: allocation across slab growth, free accounting, compaction moving live
entries and releasing a slab, refusal of an oversized entry. `test/db.test.ts` gains: a hot
cache that evicts clean objects and never dirty ones, with reads correct after eviction;
tombstones hiding removed objects until the root; history as bytes with `getAt` and
`bytesAt` agreeing; export after churn equal to the live state; the same root from a
database whose cache holds nothing as from one whose cache is unbounded.
`test/memory.test.ts`: a core-application node whose heap is driven to the `pressure` level
has its cache capped at 10,000 and the excess evicted, and gets it back unbounded at `ok`;
the same node has its index trees dropped at `pressure`, keeps following the chain on the
fallback, reports it in `status`, and has them rebuilt at `ok`.

For the index tier, `test/db.test.ts` gains: the entries each root reports, applied to a
store, equal the trees, with removals first and nothing for a key kept; lookups, merged
scans and uniqueness against the overlay and the store, through a key changing hands, an
object created and removed before a root, an undone session and a read between a root and
its write; a randomised comparison of a database that drops and rebuilds at arbitrary
moments with one that never does (lookups, scans and roots after every step); and a drop and
rebuild in the middle of blocks leaving every root and lookup as they were.
`test/app.test.ts` gains: the store's entries equal the indices after every commit, a
restart from them, a store without them filled in on opening, blocks run with the trees
dropped and rebuilt matching an application that never drops them, and the entries of a
state imported from a snapshot. `INDEX_TREES=0` runs any suite with every tree dropped.
