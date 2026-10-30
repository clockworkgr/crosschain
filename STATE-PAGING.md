# State paging specification

Status: phases one to five implemented. Phase one, the arena (`src/db/arena.ts`,
`src/db/index.ts`, `src/db/database.ts`); phases two and three, the index entries on disk and
the droppable index trees (`src/db/indexstore.ts`, `src/db/index.ts`, `src/db/database.ts`,
`src/app/core/app.ts`); phase four, the dense tree chunks and sparse tree nodes on disk and
the droppable Merkle trees (`src/db/merkle.ts`, `src/db/smt.ts`, `src/db/database.ts`,
`src/app/core/app.ts`); phase five, the guard's dials (`src/node/node.ts`,
`src/node/memory.ts`) and the paging benchmark (`bench/paging.bench.ts`,
`bench/paging-node.ts`). Tests in `test/db.test.ts`, `test/arena.test.ts`,
`test/app.test.ts` and `test/memory.test.ts`; `INDEX_TREES=0` and `TREES=0` run any suite
on the fallbacks. Decisions were taken in conversation on 2026-10-30; where the
implementation settled or changed a detail, the section says so under "As built".
`DESIGN.md` section 6 describes the object database this changes, and `docs/benchmarks.md`
sections 4.9 and 7 hold the measurements it starts from. Not built: releasing cold arena
slabs at `warn`, paging the history window (7.1), and opening a store with its tiers
dropped when the heap is known to be too small for them (9).

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
| always on | the extra writes per commit are not a mode; a node that never pages pays them anyway, a few percent of warm throughput, so that the fallback exists the moment it is needed (measured: nothing for local writes, a fifth of the commit for a block spread over 192,000 accounts; 5.3) |
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
them at `ok` once they fit (7); `status.memory.database.indexTrees` reports `resident`, `dropped` or `partial`.
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
't' tree u16, level u8, chunk u48  -> up to 1024 hashes      (dense tree chunk)
'n' type u16, index position u8, path bytes -> node           (sparse tree node)
```

As built:

- **The prefix is 't', not 'c'.** The application store already keys the type counters as
  'c' type u16, so a chunk key of the tree of type T would have had T's counter key as a
  prefix; 't' is free. The tree is the type id, or 0 (`TOP_TREE`) for the tree over the
  types, which no type may use. The chunk index is big-endian, so one tree's chunks are one
  range (`src/db/merkle.ts`, `chunkKey`).
- **A chunk is stored without its trailing empty hashes**, so the last chunk of a level and
  the one-chunk upper levels cost what they hold (the root level of a tree is one 32-byte
  value), and a chunk that becomes all empty is deleted. Read back, it is padded again.
- **The size per tree is not written separately**: a tree's leaf count is always its type's
  counter at the last root, which the store already keeps ('c'), and the tree over the
  types has one leaf per registered type.
- **A sparse node's path bytes** are the first `depth` bits of the path from the root,
  packed and zero-padded, followed by the depth as one byte, so every node has one key
  (`src/db/smt.ts`, `nodeKey`; the index position is the index's place in its type, as in
  the 'i' prefix). An inner node is `0x00`, the left hash, the right hash; a leaf is `0x01`,
  the key hash, the value (the eight-byte id). An inner node carries both children's
  hashes, so a walk down one key's path reads one node per level and finds every sibling
  hash on the way; a proof never reads a sibling node.
- **Reported per root.** `Changes.trees` lists the chunks and nodes a root wrote (value) or
  deleted (null). A dense tree knows the chunks its root changed; a resident sparse tree
  finds its changed nodes by walking the previous and the new root together into the
  subtrees whose hashes differ, which costs the changed paths. The values of resident
  chunks are views of the live chunks, not copies: a chunk handed out is copied before it
  is next written if the application has not written the list yet (`dropChanges()` says it
  has). The first root writes every chunk and node (the genesis); a database with no store
  and its trees resident reports nothing, as for the indices. `CoreApp.persist` writes the
  list in the same `kv.write` as the rest; `writeImportedState` (state sync) writes every
  chunk and node from `treeEntries()`.

### 5.2 Fallback reads

With a tree's chunks dropped, computing a root reads each changed leaf's path from LMDB (a
chunk per level, about twenty per changed leaf, through a small LRU of chunks, so the upper
levels are shared and resident) and writes the changed chunks back at commit. A sparse tree
read walks nodes by path. Proofs at the current version read the same way; proofs at past
versions still need the history records, which stay in memory for the window as now.

As built:

- **One dial for the tier.** `dropTrees()` and `rebuildTrees()` act on every dense and every
  sparse tree together: the guard has one decision to make, and the sparse trees are where
  the heap goes (a node object and two small typed arrays per node), while the dense
  chunks live in array buffers. Both may be called with sessions open.
- **Dense trees.** Dropped, a tree releases every chunk and reads through a `ChunkCache`, an
  LRU by count that all the database's trees share (`treeChunks`, 256 by default: at most
  8 MiB, and the upper levels' chunks are short). A root works on private full-size copies
  of the chunks it changes, so nothing read from the store, cached or handed out in a change
  list is ever written; when the root is done the copies go to the cache, and the
  root's own value is read before they do, since a cache smaller than one root's working set
  may evict them at once (the root's change list, laid over the store until it is written,
  still has them). Between roots a dense tree holds nothing pending, so dropping it touches
  nothing but its own chunks. Past versions come from the history records exactly as before.
- **Sparse trees.** Dropped, a tree lets its nodes go; a write (set or delete of a key) is
  only remembered, per key hash, the last one winning, undo included, since undo goes
  through the same calls. A commit applies the remembered writes by walking each key's path
  from the root, reading nodes from the store and writing changed ones to a map of its own,
  with the shape rules of the tree in memory (a leaf at the first depth where its prefix is
  unique; a lone leaf moves up when its sibling goes), so the root is the same; the shape
  depends only on the final key set, so the order the writes are applied in does not
  matter. What the map holds at the end is the commit's change list. For past versions a
  dropped tree keeps records of what each commit overwrote (before version v the node at
  this path was x, or nothing), as the dense trees do; when a resident tree is dropped, the
  records are made from the versions it retained, by walking each pair of consecutive roots
  together, and the writes since the last commit (a drop in the middle of a block) become
  remembered writes by the same walk over the leaves. Rebuilding reads the current tree from
  the store and each retained version from the records, newest first, each sharing with
  the next newer one every subtree whose hash did not change, then applies the remembered
  writes.
- **What a dropped tree reads** is the store the application writes (`indexStore`), with the
  change lists of roots it has not written yet laid over it, as for the indices (4.2); a
  database with no store builds an in-memory one from its trees when they are dropped and
  lets it go when they are rebuilt.
- **Restart.** `loadTrees()` takes every resident tree from its chunks and nodes after an
  indexed import, so the first root hashes no object and inserts no key into a sparse tree;
  `openObjectDatabase` does that by default and checks the root against the stored app hash
  as before. That root equals the stored hash by construction unless the store is
  inconsistent, so by itself it would no longer prove that the objects hash to it; the default
  therefore also hashes every object and compares it with its leaf (`checkLeaves`, about an
  eighth of the restart), which keeps the property the old path had: a corrupt object store
  fails at startup, not when something reads the object. `checkLeaves: false` skips it, and
  `fromTrees: false` recomputes the trees from the objects (the old path, about twice as
  slow; 5.3). A store written before phase four
  has no 't' prefix: opening it recomputes the trees and writes them once, as phase two did
  for the index entries. A database can also start with its trees dropped (`trees: false`),
  and the test setup does that for every database with `TREES=0`.

### 5.3 Measured effect

Trees on disk, against the phase-three code (commit a3914e7) run on the same machine, Apple
M4 Pro, node 24; the genesis rows at 191,896 accounts under secp256k1 (56 MB), single runs:

| | before | after |
|---|---:|---:|
| genesis: build (apply, root, persist) | 6.94 s | 7.80 s |
| of which root / persist | 1,861 / 973 ms | 2,125 / 1,672 ms |
| LMDB on disk after genesis | 92.7 MiB | 213 MiB |
| heap after building | 607 MiB | 607 MiB |
| restart from LMDB | 8.41 s | 5.2 s (4.6 s without the leaf check) |
| of which indices, trees and root | 4,518 ms | 761 ms |
| heap after a restart | 572 MiB | 572 MiB |
| block of 500 transfers (accounts 0 to 500): commit to LMDB | 13.2 ms | 13.6 ms |
| scale suite, block of 2,400 transfers among random accounts: commit | 45.7 ms | 55.1 ms |
| scale suite, state sync: write the imported state / open it | 1.09 / 5.72 s | 1.84 / 1.59 s |
| `commit to LMDB (after a 500-transfer block)`, 1,001 accounts | 9.72 ms | 9.48 to 9.96 ms |
| `first root over 100,000 objects` (db suite, no store) | 358 ms | 347 to 356 ms |
| `modify 1,000 balances + root` (no store) | 19.3 to 20.5 ms | 19.8 to 20.4 ms |
| `modify 10,000 balances + root` (no store) | 159 to 162 ms | 161 to 167 ms |

The three ways to reopen the same store, measured in one run: the trees from their chunks
and nodes with every object hashed against its leaf (the default) 5.18 s, the same without
the leaf check 4.56 s, the trees computed from the objects 8.46 s. What is left of a restart is mostly the history (3.5 s at
height 1): rebuilding the sparse trees' past versions replays every account, which the
store does not hold in a form to load; that is not changed here.

The genesis writes about 600,000 sparse nodes (the name tree of 192,000 leaves and their
inner nodes) and 25 MiB of chunks: 120 MiB more of LMDB, 0.7 s more to write, a quarter of a
second more to list at the first root. A block's commit costs what its chunks cost: a chunk
holds 1,024 hashes, so a block whose leaves are spread over the whole state rewrites nearly
every chunk of the trees it touches, 6.1 MiB per root for a thousand random balances among
100,000, the same for ten thousand; at 192,000 accounts that is about 12 MiB, and the
commit of a scattered block grows by a fifth (9 ms). A block whose writes are local (the
genesis suite's transfers among consecutive accounts) costs nothing measurable, nor does
the 1,001-account application suite. Smaller chunks on disk would cut the scattered case
about in half at this size and are the obvious next step if the commit matters; the
format here is the one the specification set.

Dropped trees, from the db suite (100,000 balances and 21,000 accounts, the trees over
LMDB; means, and medians where a first cold iteration pulls the mean):

| | resident | dropped |
|---|---:|---:|
| `modify 1,000 balances + root` | 20.2 ms | 53.7 ms (median 23.8) |
| `modify 10,000 balances + root` | 170 ms | 207 ms (median 179) |
| object proof, current version, per 100 | 1.13 ms | 1.35 ms |
| object proof, past version, per 100 | 1.14 ms | 1.35 ms |
| name proof (sparse tree), per 100 | 428 µs | 1.87 ms |
| drop / rebuild every tree | | 0.3 / 180 ms |

A root over dropped trees costs about what a resident one does once the upper levels are
cached (215 of the 256 cached chunks after these runs); the first one after a drop reads
every chunk it touches from LMDB. Object proofs cost about the same, being dominated by
building the proof rather than reading twenty hashes (a fifth more, from the chunks read
through the cache); a name proof reads about twenty nodes
from LMDB and costs four times as much. (The resident and dropped columns of the first two
rows are the same database over LMDB; the resident one reports its changes, and costs what
the no-store rows above do.) Rebuilding reads 400 chunks and the name tree's 42,000
nodes, and every retained version of the name tree from the records.

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

Phase four as built: the chunks and nodes are `Changes.trees`, written by `CoreApp.persist`
after the index entries in the same `kv.write`, and laid over the store until
`dropChanges()` like the index entries. `commit to LMDB` at 1,001 accounts did not move
(9.7 to 9.5 ms, noise); at 192,000 accounts a block spread over the whole state costs about
12 MiB of chunks and 9 ms more, a fifth (5.3).

## 7. The guard's dials (phase five)

| level | heap used of limit | what the database does |
|---|---|---|
| ok | under 70% | caches unbounded (built); dropped index trees and Merkle trees rebuilt, each only if it fits (built) |
| warn | 70% | hot cache capped at 100,000 decoded objects (built); cold slabs may be released (not built); major collection started |
| pressure | 85% | hot cache capped at 10,000 (built); index trees dropped, then the Merkle trees (built); costly RPC methods still refused, since proofs at past heights read history |
| critical | 95% | clean stop, as now; reached only when one block's working set does not fit |

As built (`src/node/node.ts`, `onMemoryLevel`):

- **`pressure` and `critical`** drop the index trees and then the Merkle trees, after capping
  the cache; `critical` keeps them dropped while the node stops.
- **`ok` rebuilds what fits, not everything.** Dropping takes a large state from above the
  pressure line to well below the ok line in one go (at 192,000 accounts the heap gave back
  130 MiB for the index trees and 193 MiB for the Merkle trees; 7.1), and rebuilding all of
  it at `ok` takes the heap straight back over the pressure line. Measured with the literal
  rule, a node under load dropped, read `ok`, rebuilt and read `pressure` again within a
  second or two, over and over, a second of rebuilding each time. So the node rebuilds a
  dropped tier only when its estimated heap fits under the warn line, the index trees
  first. The estimate comes from the database (`rebuildEstimate()`): every committed object
  has one entry in each index of its type and one leaf in each authenticated index's sparse
  tree, at 210 and 1,000 bytes of heap, which is what dropping them gave back at 192,000
  accounts, within a few percent. What it is compared with is not one sample: right after
  a major collection the heap reads a few hundred MiB lower than it will a second later,
  and a rebuild judged on such a sample flapped just the same. The node waits until ten
  samples have been seen since the drop (ten seconds at the default interval) and compares
  with the highest of the last ten. What does not fit stays dropped, the node running on
  the fallbacks at `ok`, and the guard asks again at every sample (`onSample`) while the
  level is `ok`, logging once what it is waiting for. This changes the table's "rebuilt"
  at `ok` to "rebuilt when it fits".
- **The limit is the old generation's.** V8's `heap_size_limit` adds the young generation's
  reserve to `--max-old-space-size` (192 MiB on the machine measured), which long-lived
  objects never fill; a process aborts when the old generation is full. With the CLI's
  `--heap 744`, the guard's lines were taken from 936 MiB, `pressure` (85%) sat past the
  abort, and a node under load died without shedding anything. The guard now measures
  against `--max-old-space-size` when the process was started with it
  (`src/node/memory.ts`).
- **The mempool stays paused at `pressure`.** Admission through the fallbacks is correct:
  `test/app.test.ts` checks transactions against dropped index trees and dropped Merkle
  trees, and the pending session's writes go to the overlays like a block's. It is kept
  paused because admission is also what grows the heap under load: every pooled transaction
  pins the objects it touches decoded in the pending session (the cache cannot evict them),
  adds overlay entries, and keeps its bytes and its signature-cache entry; the paging
  benchmark's in-process node held about 330 MiB more live heap with a full mempool than
  idle. Shedding that
  at `pressure` is what lets the level come down; admitting again is what `ok` is for, and
  with the rebuild now conditional, `ok` is reached with the trees still dropped, so the node
  admits and commits through the fallbacks without flapping. Lifting the pause would want a
  mempool limit that follows the level, which is not built.
- **`status.memory.database`** reports each tier's mode, `objects` (`resident` or
  `capped`), `indexTrees` and `trees` (`resident`, `dropped`, or `partial` for index trees
  dropped by type), the decoded objects and the cache limit, the chunks cached and their
  limit, and the hit counts of both caches (`hotHits`, `hotMisses`, `chunkHits`,
  `chunkMisses`, from which a rate follows).

### 7.1 Measured effect: the paging benchmark

`CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 node --expose-gc bench/run.ts paging`, 191,896
accounts. First a node, in a child process started with `--max-old-space-size=744`, 1.25
times the heap of the resident state (595 MiB): a single validator over the store, its
mempool kept two blocks ahead with transfers among random accounts, for 40 seconds.

| seconds | what happened |
|---|---|
| 0 | store opened in 1.24 s (the trees from their chunks), 396 MiB of heap; 3,300 to 3,600 transfers per 2 s |
| 4 to 9 | `warn` (the cache capped) as the mempool's pending session and the history window fill the heap |
| 9.2 | `pressure` at 669 MiB: mempool paused, index trees and Merkle trees dropped; next sample 225 MiB, `ok` |
| 13.3 | after ten samples, the index trees rebuilt; the Merkle trees stay dropped, 183 MiB needed and 96 MiB of room |
| 21.5 | `pressure` again at 633 MiB, index trees dropped; from then on rebuilding never fits (313 MiB needed, no room) |
| 30 to 43 | `warn` and `pressure` alternate around 550 to 580 MiB after collections, all tiers dropped, mempool paused and resumed |

In all: 107 blocks and 59,128 transfers in 40 s (1,478 a second, against 1,700 to 1,800 in
the first eight seconds), 79 of the blocks and 44,036 of the transfers committed with the
Merkle trees dropped, and no abort. Two runs before the changes of section 7 show what
they are for: with the guard's lines taken from `heap_size_limit` the same node reached
`warn` and then died of an out-of-memory error at 19.5 s without ever shedding; with the
lines fixed and the trees rebuilt at the first `ok` sample, it changed level 30 times in
40 seconds, rebuilding each time, and committed 622 transfers a second. What still grows
under this load and drives the late alternation is not a tier the guard can drop: the
history window (100 versions of overwritten tree nodes and object bytes, each block of
scattered transfers adding tens of thousands of records) and the recent transaction ids.
Paging the history window is the next step if a node is to live at its limit under load;
it is not built.

Then the database alone, in the parent process after the node session (so with a full
history window): blocks of 500 random transfers, six per mode, checked through `checkTx`
first as admission does, then finalized and committed to LMDB; the modes added up as the
guard's levels add them:

| mode | blocks/s | transfers/s | finalize | commit | checkTx of 500 | heap after | array buffers |
|---|---:|---:|---:|---:|---:|---:|---:|
| resident | 7.2 | 3,579 | 50.3 ms | 89.4 ms | 55.8 ms | 1,125 MiB | 114 MiB |
| cache capped at 10,000 | 7.0 | 3,478 | 49.8 ms | 93.9 ms | 51.1 ms | 936 MiB | 113 MiB |
| and index trees dropped | 7.6 | 3,820 | 40.4 ms | 90.5 ms | 49.9 ms | 761 MiB | 102 MiB |
| and Merkle trees dropped | 5.7 | 2,869 | 45.9 ms | 128 ms | 57.9 ms | 543 MiB | 81 MiB |
| everything rebuilt (1.06 s) | 7.0 | 3,518 | 46.7 ms | 95.4 ms | 48.4 ms | 948 MiB | 116 MiB |

The same suite run on the state before any node session (no history yet) gave 10.6, 10.2,
11.5, 10.7 and 10.3 blocks a second and 493, 512, 382, 189 and 617 MiB of heap: the index
trees give back 130 to 175 MiB and the Merkle trees 190 to 220 MiB, the cache up to 190 MiB
when it holds 200,000 decoded objects (nothing when it held fewer than its cap), and with
everything dropped the node runs on 40 to 50% of its resident heap. Throughput holds within 10% until the Merkle trees
go, and falls by 5 to 20% with them (a rerun measured 6.7 against 7.0 blocks a second), all
of it in the commit: a root over dropped trees
reads its chunks from LMDB and writes private copies, where a resident one writes in
place. The index trees dropped cost nothing a block of transfers notices (the transfers
look up no index; a block's finalize even gets faster without the B+ tree updates).

## 8. Performance envelope

| read | resident | from the page cache | from an NVMe |
|---|---:|---:|---:|
| object by id | 40 ns (hot) or 1 µs (decode) | 2 µs | 100 µs |
| index lookup | 1 µs | 2 µs | 100 µs |
| root over 20,000 changed leaves | 300 ms | about 1 s | several seconds |

Measured (5.3, 4.4, 3.3): an object decoded from the arena about 1 µs; an index lookup
through LMDB 1.0 µs, as fast as a resident one at these sizes; a root over 10,000 changed
leaves out of 100,000 with the trees dropped, from the page cache, 179 ms (median) against
170 ms resident. The row for 20,000 changed leaves is about right resident; dropped it costs
little more while LMDB sits in the page cache. None of it was measured from an NVMe with a
cold page cache.

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
4. **Chunks on disk and droppable trees** (built): a test drops the trees and verifies that
   roots, object proofs, key proofs and range proofs equal a resident database's at every
   version in the window, through undone sessions, drops and rebuilds in the middle of
   blocks, a cache of three chunks and arena compaction; a restart takes the trees from
   the store (5.2). The whole suite also passes with `TREES=0`, every database's trees
   dropped from the start, and with `INDEX_TREES=0`.
5. **Guard integration and a paging benchmark** (built): the guard caps the cache, drops the
   index trees and then the Merkle trees at `pressure`, and rebuilds what fits at `ok` (7);
   `npm run bench -- paging` reports blocks and transfers per second and the memory at each
   mode, and a node whose guard reaches `pressure` on its real heap keeps committing (7.1).
   A real `--heap` below the state size is not what the benchmark runs: a node opening its
   store builds every tier resident before the guard samples, so a heap smaller than the
   resident state aborts at startup; the in-process node is given its real heap figures
   against a limit the benchmark chooses. Opening a store with the tiers dropped when the
   heap is known to be too small is not built.

## 10. Defaults

| parameter | default |
|---|---|
| hotObjects | unbounded; the guard caps it at 100,000 (`warn`) and 10,000 (`pressure`) |
| slab size | 256 KiB first, doubling to 16 MiB |
| compaction | a slab with dead bytes over half its used bytes, at most two per root |
| entry header | 10 bytes: type u16, instance u32, length u32 |
| treeChunks | 256 dense tree chunks cached while the trees are dropped (at most 8 MiB) |
| rebuild estimate | 210 bytes of heap per index entry, 1,000 per sparse tree leaf |

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

For the tree tier, `test/db.test.ts` gains: the chunks and nodes each root reports, applied
to a store, equal the trees (a chunk deleted when emptied, sparse nodes deleted when they
collapse, none for a value change); the acceptance comparison of 9 item 4; databases with
their trees dropped from the start, with and without a store, matching a resident one; a
dense tree dropped and rebuilt between roots, through a cache of two chunks, with the
roots, paths and range proofs of a resident one across growth and emptied chunks; a sparse
tree dropped between commits and in the middle of writes, with the roots and proofs of a
resident one at every version in the window, and the store holding exactly its nodes.
`test/app.test.ts` gains: the store's chunks and nodes equal the trees after every commit,
a restart from them (and with the leaves checked, and recomputing, and with the trees
dropped) with the proofs of the original, a tampered object caught by the leaf check and by
the recomputing path, a store without them filled in on opening, and blocks run with both
tiers dropped and rebuilt matching an application that never drops them.
`test/memory.test.ts`: the node also drops its Merkle trees at `pressure`, proves objects
against them as a validator does, keeps them dropped at `ok` while rebuilding is estimated
not to fit, and rebuilds them once it does. `TREES=0` runs any suite with every tree
dropped.
