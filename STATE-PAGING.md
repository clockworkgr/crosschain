# State paging specification

Status: phases one to five implemented. Phase one, the arena (`src/db/arena.ts`,
`src/db/index.ts`, `src/db/database.ts`); phases two and three, the index entries on disk and
the droppable index trees (`src/db/indexstore.ts`, `src/db/index.ts`, `src/db/database.ts`,
`src/app/core/app.ts`); phase four, the dense tree chunks and sparse tree nodes on disk and
the droppable Merkle trees (`src/db/merkle.ts`, `src/db/smt.ts`, `src/db/database.ts`,
`src/app/core/app.ts`); phase five, the guard's dials (`src/node/node.ts`,
`src/node/memory.ts`) and the paging benchmark (`bench/paging.bench.ts`,
`bench/paging-node.ts`). Built after the phases: a mempool limit that follows the memory
level and a history window trimmed as the heap fills (7, 7.2), past versions read from the
store's history records when the window in memory no longer holds them (7.3), the arena as
a cache within a byte limit (3.4), and a store too large for the heap opened paged (9.1). Tests in `test/db.test.ts`, `test/arena.test.ts`,
`test/app.test.ts` and `test/memory.test.ts`; `INDEX_TREES=0` and `TREES=0` run any suite
on the fallbacks. Decisions were taken in conversation on 2026-10-30; where the
implementation settled or changed a detail, the section says so under "As built".
`DESIGN.md` section 6 describes the object database this changes, and `docs/benchmarks.md`
sections 4.9 and 7 hold the measurements it starts from. One thing was built differently
from the decision in section 2: cold arena slabs are not released at `warn` by the guard but
against a byte budget the operator sets, because the slabs are outside the heap the guard
watches (3.4).

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
| tier one, objects | encoded bytes in packed slabs (an arena), decoded through a bounded hot cache; dirty objects pinned decoded until the next root; given a byte limit, the arena is itself a cache over the objects in the store (3.4) |
| tier two, indices | one LMDB key per index entry written at every commit; the B+ trees stay as droppable accelerators with an overlay-merged cursor scan as the fallback |
| tier three, trees | the dense and sparse trees' changed chunks and nodes written at every commit; the live trees stay as droppable accelerators with chunk reads as the fallback |
| eviction order | by the guard, as the heap fills: decoded cache, then the index trees and the history window (whose older versions are then read from the store), then the Merkle trees. The arena's cold slabs were to come second; as built they are released against a byte budget of the operator's, not by the guard (3.4) |
| who turns the dials | the memory guard (`src/node/memory.ts`): `ok` evicts nothing, `warn` caps the cache, drops the index trees (where the node keeps them in memory, which is not the default; 7), trims the history window and halves the mempool's limit, `pressure` drops the Merkle trees, lowers the mempool's limit to a tenth and sheds load, `critical` stops cleanly |
| always on | the extra writes per commit are not a mode; a node that never pages pays them anyway, a few percent of warm throughput, so that the fallback exists the moment it is needed (measured: nothing for local writes, a fifth of the commit for a block spread over 192,000 accounts; 5.3) |
| determinism | unchanged: roots are computed from the same leaves and the same bytes, wherever they are read from |
| history | past values kept as encoded bytes, not decoded objects; the retention window costs bytes, not records; from `warn` on only the last two versions are kept in memory, the store keeping the whole window (7.2); a version the window in memory no longer holds is read from the store's history records, slower and at no cost in memory (7.3) |

## 3. Tier one: the arena (phase one)

### 3.1 What changes

The primary index of a type was an array of decoded, frozen objects by instance. It is now
two things: the committed encoding of every object in the arena, addressed by a per-type
table of references, and a hot cache of decoded objects over it.

- **Arena** (`src/db/arena.ts`): slabs of bytes, the first 256 KiB and each next one twice
  the last up to 16 MiB, filled by a bump allocator. An entry is a 10-byte header (type u16,
  instance u32, length u32) followed by the encoding. Freeing an entry only counts its bytes
  dead. After a root, a slab with nothing live left is released outright, with no copying,
  however many there are; a slab whose dead bytes exceed half its used bytes is compacted: its
  live entries are copied into the current slab, their owners are told the new references,
  and the slab's buffer is released. Compaction copies at most what the root's block wrote
  into the arena (and at least 16 MiB), so the pause stays in proportion to the block, and
  since a compacted slab gives back more than it copies, reclaiming keeps up with any rate of
  writes and a backlog drains. An encoding larger than a slab is refused (no object is: the
  largest, the dynamic properties with a thousand validators, is under 2 MiB).
- **References**: per type, a `Float64Array` of slab-and-offset packed into one number
  (-1 for absent, -2 for an object whose bytes are only in the store; 3.4) and a `Uint32Array` of lengths, both growing by doubling with the instance
  counter. A released slab's number goes to the next slab with its generation counted up, so
  the numbers stay as few as the slabs alive at once: 24 bits of offset, 16 of slot and 13 of
  generation fit the 53 bits a double holds exactly, and `packRef` refuses anything beyond. The
  generation refuses a stale reference into a reused slot.
- **Hot cache**: per type, a `Map` from instance to decoded object, evicted by CLOCK: a hit
  sets the instance's touched bit, a fresh decode enters with it clear (so a one-time read is
  the first to go and a scan of the state does not wash out a block's working set), and when
  the budget is spent a hand sweeps the type's cached entries in the map's order, sending
  one whose bit is set (or that is pinned) to the back with the bit cleared and evicting
  clean ones it finds clear until the budget is met, each entry passed at most twice; it walks
  what is cached, not the instances, so cached objects far apart among the instances cost no
  more. A hit is one byte store, an eviction a few map operations, and nothing is ever sorted; a type whose cache is all pinned (a genesis being
  built) marks itself saturated and does nothing until the next root. Dirty objects (written
  since the last root) are pinned and never evicted; tombstones (`null`) mark removals the
  arena has not seen yet. Undoing a session that created objects forgets only the instances
  it created, from its starting counter up, so a failed transaction costs what it did, not
  what is cached. The budget `hotObjects` is shared by all types and unbounded by
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
- **Accounting**: `memory()` reports arena bytes used and dead, slab count, the arena's
  limit and how many objects have their bytes only in the store (3.4), hot objects and
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

### 3.4 The arena as a cache

Section 2 put "cold slabs" second in the eviction order, released by the guard at `warn`.
That was never built, and what is built has a different trigger. The arena's slabs are
`ArrayBuffer`s, which V8 allocates outside its heap. The guard takes its levels from the
heap used against the heap limit (7), so it does not see the slabs, and releasing them
would not lower the figure it acts on. The arena is therefore bounded by a byte budget the
operator sets, not by the guard: `arenaBytes` in the database's options, `start --arena
<MiB>` on the command line (a whole number, at least 16). It is unbounded by default, and
then every committed encoding stays in the arena as in 3.1.

As built (`src/db/arena.ts`, `src/db/index.ts`, `src/db/database.ts`):

- **The store behind it.** The application's store already holds every committed object
  by id (the `'o'` keys `CoreApp.persist` writes). The application hands the database a
  function that reads one (`objectStore`, an `ObjectFetch`: id to bytes), and with it the
  limit. Without an object store the limit is ignored and the arena holds every object:
  there would be nowhere else to read the bytes from, and `memory().arenaLimit` reports
  no limit.
- **When slabs are released.** Between a root and the application's write of it, the
  objects the root wrote are in the arena and nowhere else. So the arena is shrunk only
  when the application has said the last root is written (`dropChanges()`).
  `setArenaLimit(bytes)` takes effect at once if the store holds the last root, and at
  the next `dropChanges()` otherwise.
- **Which slabs.** `Arena.shrink(limit)` releases whole slabs until the capacity of the
  slabs is within the limit. The current slab, the one being filled, is never released, so
  the arena does not go below it (16 MiB at most). The choice is CLOCK with one bit per
  slab: every read of an entry sets its slab's bit; a first pass releases, in slot order,
  the slabs whose bit is clear and clears the bit of the others; a second pass releases
  those too if the first was not enough. A slab nothing has read since the last pass goes
  first.
- **What a released slab leaves.** For each live entry of a slab about to be released the
  arena calls its owner (`ArenaOwner.released`), and the type's index sets the object's
  reference to `STORED` (-2) and counts it. Dead entries are not reported. The object is
  still committed: `has`, the counts, the indices and the trees are unchanged.
- **Reads.** A read of a `STORED` object that misses the hot cache fetches the bytes from
  the store, decodes them and caches the object as any other read does. The bytes are not
  put back in the arena by a read, so reading does not grow the arena. Proofs, history,
  exports and snapshots take the committed bytes the same way (`bytesOf`). An object the
  store does not hold is an error at the read (`its bytes are neither in the arena nor in
  the store`).
- **Writes.** A `STORED` object is modified and removed like any other, undo included.
  The root that writes it allocates its new encoding in the current slab, so it is in the
  arena again until its slab is released.
- **At open.** An indexed import (a restart from the store) puts objects into the arena
  until the bytes imported reach the limit and leaves the rest in the store
  (`importStored`): they get a `STORED` reference without their bytes being copied. The
  first `dropChanges()` then shrinks the arena as after any root.
- **Reported.** `memory()` gives `arenaLimit` (Infinity for none) and `storedObjects`, the
  number of committed objects whose bytes are only in the store; `status` carries both
  under `memory.database`.

Roots and proofs do not change: they are computed from the same bytes, read from the
store instead of from a slab. What it costs is the read: an object that is neither in the
hot cache nor in the arena is an LMDB get and a decode where it was a decode (section 8
has the envelope). Measured on the 192,000-account state for three minutes under a full
feed (docs/benchmarks.md 4.13): without a budget the arena grows from 48 to 64 MiB; held
to 32 MiB it leaves 124,000 to 215,000 objects in the store; held to 16 MiB it leaves
315,000 there at the start of the run and 652,000 at its end, and the process holds 48 MiB
fewer array buffers. Throughput does not notice either budget: 1,511 transfers a second
without one, 1,520 and 1,500 with.

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
  trees does anyway, so it is the one kept. The entries are then checked against the objects
  (`checkIndexEntries`, the default): every object is decoded once for its keys, without being
  cached, each key must be stored naming that object, and each index must hold no more entries
  than there are objects. The app hash covers only the authenticated indices, so without the
  check a damaged entry would send a lookup, and the writes after it, to the wrong object; at
  192,000 accounts it costs about 0.46 s of a restart (5.3). A store written before phase two
  has no 'i' prefix; opening one decodes the objects for their keys as before and writes the
  entries once.
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

A tree is dropped whole (from the guard's `warn` level on) and rebuilt whole from LMDB when
memory returns (`ok`), by walking the type's prefix; until then every read of that type
takes the fallback. The authenticated indices' sparse trees are tier three.

As built: `dropIndexTrees(type?)` and `rebuildIndexTrees(type?)` act on one type or on all;
a type's indices go together. Both may be called with sessions open, mid-block: the drop
builds the overlay from the dirty set (4.2), the rebuild walks the merged view (store,
unwritten roots, overlay) into fresh trees, so neither changes a lookup or a root. Dropping
with a store behind is cheap (it touches only what is dirty); rebuilding reads the whole
prefix. A node with `indexTrees: 'memory'` has its guard drop every type's trees from `warn` on and rebuild
them at `ok` once they fit (7); by default (`indexTrees: 'store'`) a node never builds them. `status.memory.database.indexTrees` reports `resident`, `dropped` or `partial`,
and `dropped` from the start on a node with the default.
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
versions still need the history records, which stay in memory for the window as now. (Since
then a version the window in memory does not hold is answered from the records in the
store; 7.3.)

As built:

- **One dial for the tier.** `dropTrees()` and `rebuildTrees()` act on every dense and every
  sparse tree together: the guard has one decision to make, and the sparse trees are where
  the heap goes (a node object and two small typed arrays per node), while the dense
  chunks live in array buffers. Both may be called with sessions open.
- **Dense trees.** Dropped, a tree releases every chunk and reads through a `ChunkCache`, an
  LRU by count that all the database's trees share (`treeChunks`, 4,096 by default: at most
  128 MiB of buffers, outside the heap the guard watches, and the upper levels' chunks are
  short). The default was 256, at most 8 MiB, which keeps the upper levels and was enough
  for the state it was measured on (5.3); a root over a state scattered across more chunks
  than the cache holds reads the rest from the store at every block. A block of 500
  transfers among 514,000 accounts, whose trees have about 1,100 chunks, took 271 ms to
  finalize with 256 chunks cached, against 60 to 69 ms with all of them cached and 45 to
  73 ms resident. With 4,096, trees of up to about two million leaves in all are cached
  whole while dropped, and beyond that the cache is what bounds them. The cache remembers
  the key it last moved to the end and does not move it again: a root reads a node and its
  sibling, mostly from one chunk. A root works on private full-size copies
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
  therefore checks what it took (`checkLeaves`), resident or dropped: every dense node above
  the leaves must be the hash of its children and lie inside the tree, every sparse node's
  encoding must hash to what its parent says, every object must hash to its leaf, and each
  type's tree must have as many non-empty leaves as there are objects, so no leaf has lost its
  object. With the root compared to the app hash that keeps the property the old path had: a
  corrupt store fails at startup, not when something reads it. `checkLeaves: false` skips it, and
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
store does not hold in a form to load; that is not changed here. (It was changed later:
the history records now carry the sparse tree nodes each commit overwrote, and a restart
takes the past versions from them; 7.3. The same three reopens then measure 2.84 s, 1.46 s
and 5.41 s, the node's restart 2.91 s with the history 2 ms of it, and the heap after a
restart 381 MiB.)

Checking the trees and the index entries in full (every dense and sparse node, every leaf
against an object, every index entry against the objects), measured the same way in one run
before and after: the default reopen went from 5.08 to 6.48 s (indices, trees and root 1,351
to 2,597 ms), the reopen without the leaf check, which still checks the index entries, from
4.46 to 5.05 s (732 to 1,195 ms), and the reopen that computes the trees from the objects
from 8.22 to 8.90 s. So the index entry check is about 0.46 s and the tree check about
0.78 s on top of the 0.62 s the leaf check already took.

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
cached (215 chunks cached after these runs, of the 256 the cache then held; it holds
4,096 now, 5.2); the first one after a drop reads
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

That transaction is no longer the application's alone. A node that created its own
application has the chain store and the application store in one LMDB environment, and its
executor saves the block (block, commit, results, validator sets, chain state) and calls
`commit()` inside one transaction of that environment (`ExecutorDeps.transaction`,
`src/node/executor.ts`), in the order they had as two. Each LMDB transaction ends with a flush
to the device (`F_FULLFSYNC` on macOS), and the flush measured as the larger and by far the
noisier part of a commit: the application's commit of a 500-transfer block at 192,000 accounts
was 17 to 26 ms of LMDB's own work and 40 to 120 ms with the flush (15 to 19 ms of LMDB's
own work since the account history became a log, 7.1). A block paid for two
flushes and now pays for one, and the block and the application state land together or not
at all. `persist` writes everything before `commit()` first awaits, which is what puts it
inside the transaction. An application handed to the node, whose store is not in the node's
environment, commits on its own after the chain store as before, and the replay at `open`
that brings an application behind the chain state back level is unchanged and still what
covers it.

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

| level | heap in use of limit (the old generation's, under a heap limit) | what the database does | what the mempool admits |
|---|---|---|---|
| ok | under 70% | caches unbounded; dropped index trees and Merkle trees rebuilt, each only if it fits; then the history window let grow back, if what it held fits | up to its limit (10,000 transactions) |
| warn | 70% | hot cache capped at 100,000 decoded objects; index trees dropped; the history window cut to the last two versions; major collection started | up to half its limit (5,000) |
| pressure | 85% | hot cache capped at 10,000; the Merkle trees dropped as well; costly RPC methods refused | up to a tenth of its limit (1,000) |
| critical | 95% | everything kept dropped and trimmed; clean stop, reached only when one block's working set does not fit | nothing: the pool is paused |

All of it is built. The table as decided had "cold slabs may be released" at `warn`; the
arena is bounded by a byte budget instead, which the guard does not turn (3.4). As first
built the index trees and the history window went at `pressure` with the Merkle trees;
they go at `warn` since the measurements of 7.1. What the table and the points below say
of the index trees is what a node does under `indexTrees: 'memory'`, the default when the
runs they cite were made. By default now (`indexTrees: 'store'`, below) the trees are never
built: `warn` still caps the cache and cuts the window, and only the Merkle trees and the
window are waited for and rebuilt.

As built (`src/node/node.ts`, `onMemoryLevel`):

- **`warn` pages what a block does not need.** From `warn` on the index trees are dropped,
  after the cache is capped, and the history window is cut (7.2). From `pressure` on the
  Merkle trees are dropped as well, before the window is cut if it is still whole;
  `critical` keeps them so while the node stops. Load shedding is still `pressure`'s. As
  first built all three went at `pressure`. A loaded node commits more with its index
  trees in the store than with them in its heap, about a tenth more (a block of transfers
  looks up no index; 7.1), and under that rule it reached that state only when the heap
  arrived at the pressure line, minutes into a full load. The history window goes with
  them for the memory it holds, not for the rate: a block reads no past version, and how
  much of the window is in memory does not change what the node commits (7.2).
- **`ok` rebuilds what fits, not everything.** Dropping takes a large state from above the
  pressure line to well below the ok line in one go (at 192,000 accounts the heap gave back
  130 MiB for the index trees and 193 MiB for the Merkle trees; 7.1), and rebuilding all of
  it at `ok` takes the heap straight back over the pressure line. Measured with the literal
  rule, a node under load dropped, read `ok`, rebuilt and read `pressure` again within a
  second or two, over and over, a second of rebuilding each time. So the node rebuilds a
  dropped tier only when its estimated heap fits within half the heap limit
  (`Node.REBUILD_FILL`, 0.5), the index trees first. The room was first taken to the warn
  line, 0.7, and that was measured once the guard read the old generation (below): a node
  rebuilt its index trees whenever they just fitted under the warn line and then spent
  minutes between `warn` and `pressure`, the collector working on a nearly full old
  generation, collections taking 7 to 12% of its time against 4 to 5% with the trees
  dropped, and it committed about a fifth less (1,050 to 1,280 transfers a second against
  1,330 to 1,560). What is rebuilt up to the warn line leaves the load no room. The room
  is `min(REBUILD_FILL, warnAt) * heapLimit` less the highest recent sample; opening a
  stored state is judged against the same half (`Node.OPEN_FILL`, 0.5; 9.1). The
  estimate comes from the database (`rebuildEstimate()`): every committed object
  has one entry in each index of its type and one leaf in each authenticated index's sparse
  tree, at 210 and 1,000 bytes of heap, which is what dropping them gave back at 192,000
  accounts, within a few percent. A sparse tree's rebuild also builds every retained
  version (a node for each record its past versions hold, the subtrees they share with a
  newer one built once) and throws away the nodes and keys it reads. The estimate counts
  both: a leaf counts 2,000 bytes and each record 500, what a rebuild allocated before a
  collection at 50,000 leaves and at 1,000 leaves with thirty versions of churn behind them
  (the second had read 1 MB, for 52 MB allocated). The figures date from when the guard
  measured the whole heap, which held all of that garbage until a collection. Under a heap
  limit it now measures the old generation (below), which holds only the part of it that
  was promoted before it died, so the estimate errs high, on the side of staying dropped.
  What it is compared with is not one sample. Measured on the whole heap, a sample right
  after a major collection read a few hundred MiB lower than one a second later, and a
  rebuild judged on such a sample flapped just the same. The young generation's garbage is
  no longer in the figure; the old generation's garbage between two major collections
  still is, so a sample right after one is still the lowest the node shows. The node compares
  with the highest of the last ten samples (`Node.REBUILD_WINDOW`), and as first built it
  waited only for those ten, ten seconds at the default interval. That was too soon: a load
  that filled the heap once fills it again. In a ten-minute run under a heap 2.5 times the
  state the index trees were rebuilt four seconds after each drop and dropped again a few
  minutes later, and the node committed less while it had them (docs/benchmarks.md
  section 4.13). With the wait that follows, the same run rebuilt them once, 30 seconds
  after a drop at 34 s, and after the second drop, at 211 s, waited to 360 s, found no
  room and stayed paged to the end (7.1). So at each level
  other than `ok` the node sets a wait (`rebuildAfter`): the number of guard samples since
  something was last rebuilt, or since it started (`sinceRebuild`), at least
  `REBUILD_WINDOW` and at most `Node.REBUILD_WAIT_MAX` (600, ten minutes at the default
  interval). Nothing is rebuilt until the level has been `ok` for that many samples in a
  row (`sinceDrop`). What does not fit stays dropped, the node running on
  the fallbacks at `ok`, and the guard asks again at every sample (`onSample`) while the
  level is `ok`, logging once per drop what it is waiting for. This changes the table's "rebuilt"
  at `ok` to "rebuilt when it fits". Each tier rebuilt is taken off the room and added to
  the remembered samples, so the next decision in the same pass counts it.
- **The history window is a dial too, turned with the index trees.** From `warn` on, after
  the index trees are dropped, the window of past versions kept in memory is cut to the last two, and at
  `ok` it is let grow back, last, when what it held fits (7.2), to `retain.memoryVersions`
  if the operator set it. No height stops being
  provable for it: a version the window in memory no longer holds is read from the history
  records in the store (7.3).
- **The index trees are left in the store unless the config asks for them.** `indexTrees: 'store'`
  (`NodeConfig.indexTrees`, and `indexTrees` in the CLI's `config.json`), the default,
  makes a node that never builds them; `'memory'`, the default until the measurements
  here, is the behaviour of the points above. With `'store'` the node passes `indexTrees: false` to the
  application it opens, drops them at start for an application it was handed, and reports
  them as needing nothing wherever it asks what waits to be rebuilt (`Node.rebuildEstimate`,
  which `onSample` and `rebuildWhatFits` read), so the Merkle trees and the history window
  are rebuilt and restored as if the index trees were resident. When a store is opened
  (9.1) their estimate is not taken off the room either. `'store'` is the one to keep
  unless the node mostly serves scans, which is what `'memory'` is for.
  Measured at 191,896 accounts under 1,488 MiB, 2.5 times the resident heap, for ten
  minutes (`bench/paging-node.ts` takes `BENCH_PAGING_INDEX_TREES=store` or `=memory` for it
  and follows the node's default when it is unset): the node with `'store'`
  opens with 258 MiB of heap in use against 398 MiB with `'memory'`, a third less, commits
  1,552 transfers a second against 1,485, which is within what two runs differ by (4.5%),
  and reaches `warn` once, at 40 s, from the history window and the cache, against twice,
  with nothing to rebuild but the window (docs/benchmarks.md section 4.13). What it gives
  up is index reads from memory. With 200 reads a second of each kind beside the load
  (`BENCH_PAGING_READS=200`, 2,380 MiB of heap so that the node with `'memory'` keeps its trees) a
  lookup by key takes 5 microseconds at the median either way, a page of twenty accounts in
  name order 33 microseconds from the store against 17 from memory (about 200 against 47 at
  the 99th percentile), and the three runs with `'store'` commit 8% more than the three
  with `'memory'`, 1,503 against 1,395 transfers a second. A store none of which was in the
  page cache when the node opened it gave the same reads from the first two seconds, the
  open taking 3,965 ms against 3,355 to 3,545 ms: the node reads its whole store when it
  opens (docs/benchmarks.md section 4.13); a store larger than the machine's memory was
  not measured. Proofs and the Merkle trees are unaffected.
- **The limit is the old generation's.** V8's `heap_size_limit` adds the young generation's
  reserve to `--max-old-space-size` (192 MiB on the machine measured), which long-lived
  objects never fill; a process aborts when the old generation is full. With the CLI's
  `--heap 744`, the guard's lines were taken from 936 MiB, `pressure` (85%) sat past the
  abort, and a node under load died without shedding anything. The guard now measures
  against `--max-old-space-size` when the process was started with it
  (`src/node/memory.ts`).
- **And so is the use it is compared with.** V8's `used_heap_size` counts the young
  generation too, which between two minor collections holds up to a semi-space of garbage
  (64 MiB as `start` runs the node, `--max-semi-space-size=64`) that never reaches the old
  generation. Counted against an old-generation limit, that garbage read as a full heap on
  a node with a small one: a benchmark node under a 153 MiB limit logged `critical` at
  "162/153 MiB", and the next sample, after a collection, read 42 MiB. Under
  `--max-old-space-size` a sample (`MemoryStats`) now also carries `heapOld`, the bytes in
  use in every V8 heap space except `new_space` and `new_large_object_space`
  (`v8.getHeapSpaceStatistics()`), and `heapInUse(stats)`, which is `heapOld` when the
  sample has it and `heapUsed` otherwise, is what the levels are taken from. The guard's
  log fields, the collection scheduler's growth test, the node's remembered samples
  (`recentHeap`), the room it gives the application at opening (9.1) and the status line's
  `heap=<used>/<limit>` use the same figure. `heapUsed` is unchanged and still reported;
  without a heap limit there is no `heapOld` and everything is taken from `heapUsed` as
  before. The effect is largest on a small state, where a semi-space of garbage is a large
  share of the limit. A 34,000-account node was run under heap limits of 0.8, 1.0, 1.25,
  1.5 and 2.0 times its resident heap (98 to 244 MiB). Measured on the whole heap it
  reached `critical` at every limit up to 1.5 times, and at 0.8 times it refused 43% of
  the transactions submitted to it. Measured on the old generation it never reached
  `critical` at any of the five, visited `pressure` one to three times in forty seconds,
  and after its first two seconds refused 236 of 48,200 transactions at 0.8 times and
  nothing at the other four, for 1,149 to 1,567 transfers a second. As the node now
  stands, with the index trees and the window going at `warn`, the same five runs refuse
  nothing after their first two seconds, visit `pressure` three times at 0.8 times, once
  at 1.0 and at 1.25 and not at all at 1.5 and 2.0, and commit, in transfers a second,
  1,499 at 0.8 times, 1,497 at 1.0, 1,530 at 1.25, 1,476 at 1.5 and 1,711 at 2.0
  (docs/benchmarks.md 4.13).
- **The mempool's limit follows the level.** Admission through the fallbacks is correct:
  `test/app.test.ts` checks transactions against dropped index trees and dropped Merkle
  trees, and the pending session's writes go to the overlays like a block's. But admission
  is also what grows the heap under load: every pooled transaction
  pins the objects it touches decoded in the pending session (the cache cannot evict them),
  adds overlay entries, and keeps its bytes and its signature-cache entry; the paging
  benchmark's in-process node held about 330 MiB more live heap with a full mempool than
  idle. The node first paused the mempool at `pressure` for that reason, which refused
  everything until `ok` and then admitted everything at once. The pool's size is now a
  dial like the others (`Node.MEMPOOL_SHARE`, `Mempool.setLimit`): the pool admits up to
  its whole limit at `ok`, half of it at `warn`, a tenth at `pressure` and nothing at
  `critical` (10,000, 5,000, 1,000 and 0 transactions at the default). Lowering the limit
  evicts nothing: what is pooled stays and is reaped, and admission begins again as soon
  as blocks have taken the pool below the limit, so under pressure the node goes on
  admitting at the rate its blocks take transactions out. A transaction refused at a
  lowered limit gets the status `full` with an error that says the limit is lowered; the
  `broadcastTx` method answers it with `RATE_LIMITED` (-32004, try again later) while the
  level is not `ok`, and with `CHECK_FAILED` as before when the pool is simply full. A
  pool that would refuse (paused, or at its limit) fetches no transaction its peers
  announce. The pool is paused only at `critical`, with the reason `node out of memory`,
  while the node stops. Shedding at `pressure` still drops the signature cache and refuses
  costly RPC methods and new event streams, with one exception: `broadcastTx`, a costly
  method, is served while the node sheds (`whileShedding` in `src/rpc/methods.ts`),
  because the lowered limit is what throttles it then. A broadcast over the RPC is admitted
  whenever the pool has room under the tenth of its limit, and answered with -32004
  otherwise.
- **`status.memory.database`** reports each tier's mode, `objects` (`resident` or
  `capped`), `indexTrees` and `trees` (`resident`, `dropped`, or `partial` for index trees
  dropped by type), `history` (`resident` or `trimmed`) with `historyWindow` (how many
  past versions are kept in memory just now) and `lowestVersion` (the oldest that can be
  asked for: the oldest the store's history records reach, which trimming the window does
  not change; 7.3), the arena's `arenaLimit` and `storedObjects` (3.4), the decoded objects and the
  cache limit, the chunks cached and their limit, and the hit counts of both caches
  (`hotHits`, `hotMisses`, `chunkHits`, `chunkMisses`, from which a rate follows).

### 7.1 Measured effect: the paging benchmark

`CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 node --expose-gc bench/run.ts paging`, 191,896
accounts. First a node, in a child process started with `--max-old-space-size=744`, 1.25
times the heap of the resident state (595 MiB): a single validator over the store, its
mempool kept two blocks ahead with transfers among random accounts, for 40 seconds, with
the index trees dropped and the history window cut at `warn` (7). The runs of this
section were made with `indexTrees: 'memory'`, the default at the time, except those
marked `store`.

| seconds | what happened |
|---|---|
| 0 | store opened in 3.5 s (the trees from their chunks, the index entries checked against the objects), 379 MiB of heap in use; 1,500 and then 1,800 transfers a second as the pending session and the history window fill the heap, 445 and then 502 MiB |
| about 5 | `warn` at 539 of 744 MiB: the index trees dropped, the history window cut to two versions, the cache capped, the mempool admitting up to half its limit; next sample 308 MiB, `ok` |
| 5 to 40 | `ok` throughout, 311 to 501 MiB, 1,520 to 2,010 transfers a second in each window of two seconds, the Merkle trees resident; the index trees stay dropped, 161 to 183 MiB needed for them and no room within half the limit (372 MiB) |

In all: 124 blocks and 69,492 transfers in 40.6 s (1,712 a second), no block committed
with the Merkle trees dropped, one visit to `warn`, none to `pressure`, and no abort. The
508 submissions refused were all in the first two seconds, before the first block. The
heap is the old generation's use, which is what the guard's levels are taken from (7).
While the index trees and the window went only at `pressure`, the same run sat at `warn`
from 6.8 s and reached `pressure` at 14.0 s (637 MiB), where both tree tiers were dropped
and the next sample read 45 MiB; the index trees were rebuilt at 17.6 s, the Merkle trees
stayed dropped, and it committed 112 blocks and 61,364 transfers (1,508 a second), 80 of
the blocks with the Merkle trees dropped. Two runs before the changes of section 7 show
what they are for: with the guard's lines taken from `heap_size_limit` the same node reached
`warn` and then died of an out-of-memory error at 19.5 s without ever shedding; with the
lines fixed and the trees rebuilt at the first `ok` sample, it changed level 30 times in
40 seconds, rebuilding each time, and committed 622 transfers a second. And before the
history window was trimmed and the mempool's limit followed the level (both
in section 7), the same run went to `pressure` twice and then alternated between `warn`
and `pressure` for its last ten seconds with the mempool paused and resumed, for 107
blocks and 59,128 transfers: the history window (100 versions of overwritten tree nodes
and object bytes, each block of scattered transfers adding tens of thousands of records)
was what kept the heap at its limit once the trees were gone, and trimming it is what
took the heap from 640 to 50 MiB in one sample. What still grows under this load and no
dial sheds is the recent transaction ids.

Then the database alone, in the parent process after the node session (so with a full
history window): blocks of 500 random transfers, six per mode, checked through `checkTx`
first as admission does, then finalized and committed to LMDB; the modes added up as the
guard's levels add them:

| mode | blocks/s | transfers/s | finalize | commit | checkTx of 500 | heap after | array buffers |
|---|---:|---:|---:|---:|---:|---:|---:|
| resident | 10.9 | 5,474 | 50.5 ms | 40.9 ms | 56.9 ms | 950 MiB | 116 MiB |
| cache capped at 10,000 | 10.8 | 5,415 | 49.0 ms | 43.3 ms | 51.0 ms | 946 MiB | 116 MiB |
| and index trees dropped | 12.1 | 6,064 | 41.1 ms | 41.3 ms | 55.2 ms | 771 MiB | 102 MiB |
| and Merkle trees dropped | 10.3 | 5,165 | 52.5 ms | 44.3 ms | 49.9 ms | 544 MiB | 86 MiB |
| everything rebuilt (1.12 s) | 10.7 | 5,349 | 49.9 ms | 43.5 ms | 49.1 ms | 955 MiB | 117 MiB |

With the account history keyed by account (below) the same five modes ran at 8.7, 8.8,
10.0, 8.3 and 8.7 blocks a second, their commits 62, 63, 58, 76 and 63 ms. The same suite
run then on the state before any node session (no history yet) gave 10.6, 10.2,
11.5, 10.7 and 10.3 blocks a second and 493, 512, 382, 189 and 617 MiB of heap: the index
trees give back 130 to 175 MiB and the Merkle trees 190 to 220 MiB, the cache up to 190 MiB
when it holds 200,000 decoded objects (nothing when it held fewer than its cap), and with
everything dropped the node runs on 40 to 50% of its resident heap. Throughput holds
within 10% of the resident figure in every mode but the one with only the index trees
dropped, which is faster (12.1 against 10.9 blocks a second). With the Merkle trees
dropped it is 10.3 against 10.9 blocks a second in the table above, where it was 7.7
against 9.4 while the dropped trees' cache held 256 chunks: the trees of this state have
about 420, so a root read the rest from LMDB at every block, and at 514,000 accounts,
whose trees have 1,100, a block of 500 transfers took 271 ms to finalize against 60 to 69
with every chunk cached and 45 to 73 resident. The cache now holds 4,096 chunks, 128 MiB
at most and outside the heap (5.2), so the dense trees of up to two million leaves are
read once after a drop and the cache bounds only larger ones. The index trees dropped
cost nothing a block of transfers notices (the transfers
look up no index; a block's finalize even gets faster without the B+ tree updates).

The node over longer runs and other heaps (docs/benchmarks.md 4.13 has the tables). Over
three states (34,000, 192,000 and 514,000 accounts) and five limits (0.8 to 2.0 times the
resident heap), forty seconds each, every run committed for the whole time and none
reached `critical`; the 192,000-account node commits 1,650 to 1,800 transfers a second at
every one of the five limits, the spread between runs, having reached `warn` once and run
on with its index trees in the store and two versions of history in memory. Held for ten
minutes at 1.0 and 2.5 times its resident heap it commits 1,619 and 1,485 transfers a
second (1,608 at 0.8 times), refuses nothing after its
first two seconds and never reaches `pressure`: each `warn`, five and two in the two
runs, is followed by `ok` within half a second. Within the run at the resident figure
every window of twenty seconds is between 1,530 and 1,780 transfers a second. The run at
2.5 times shows the wait before a rebuild (7). The node opened resident, dropped its
index trees at `warn` at 34 s, waited 30 seconds at `ok`, having run 34, and rebuilt
them at 64.6 s; at the second `warn`, at 210.6 s, it had run 146 seconds since the
rebuild, waited as long, to 360 s, found no room (565 MiB needed) and stayed paged to the
end. That is one rebuild where the rule of ten samples made two, and the rates beside it
give what resident index trees cost this load: 1,310 to 1,440 transfers a second while
they were resident, from 80 to 200 s, against 1,550 to 1,610 before and 1,420 to 1,600
after (1,517 on average), about a tenth. While the index
trees and the window went only at `pressure` the rates were lower: the forty-second rate was
1,520 to 1,560 at 0.8 to 1.25 times the resident heap and 1,250 to 1,350 at 1.5 and 2.0
times, where the index trees stayed resident; the
ten-minute rates were 1,322 and 1,355, with two visits to `pressure` each; and within such
a run the rate fell from 1,590 to 1,050 transfers a second while the index trees were
resident and the heap climbed towards the pressure line, and returned to 1,330 to 1,560,
level, once they were dropped. A loaded node is faster without its index trees in memory,
which is why they are dropped at `warn`, and now not built at all by default; the window is cut there for the heap it gives
back (7, 7.2). The
store's part in the decline was small. Tested directly, LMDB's own work for the
application's commit grew by half over 400 blocks (17.0 to 26.2 ms), most of it the
account history and not the entries keyed by a hash. Its entries were then keyed by
account, and a block of transfers names accounts all over the state, so they dirtied a
store page for every account the block named. The history is now one log in block order
(`HistoryLog`, `src/app/core/history.ts`): a block's entries are consecutive keys at the
end of the log, a few pages. An account's count and the place of its newest entry are
still keyed by account, so they are not written at every block either: they wait in
memory, and as first built were written together every 64 blocks, or sooner
when 50,000 of them waited, the log saying how far the stored ones cover it so that a
restart reads the rest back from the entries. With the log so built the same commit took 13.4 ms
at the first fifty blocks and 17.0 ms at blocks 351 to 400, at the median, where a commit
that writes no history at all takes 13.0 and 14.9 ms. The median left out the block that
wrote the waiting heads, one in fifty under this load, which took roughly 100 ms longer.
No block carries the whole batch now: the heads
wait in 64 slices of the account numbers (`HistoryLog.SLICES`), and every block that has
entries writes the waiting heads of one slice, the next in turn, which are neighbours in
the store; all the slices are written at once only if 50,000 heads wait
(`HistoryLog.HEADS_HELD`). The log records the place of the oldest change still waiting,
and a restart reads the entries from there on. Under this load a block writes about 760
to 1,000 heads so, and the commit takes 15.1 and 19.4 ms at the median. The work is the
same in total as with the heads written together (the means over the last 200 blocks are
19.2 to 24.0 ms against 17.5 to 19.3, within what runs differ by); what the slices remove
is the block of 100 ms more. The history costs about 2 ms a block at the start and 4.5 ms
at block 400, where the old layout cost 4 and 11.3 against the same run, about 60% less. The flush to the device is the larger and noisier
part of a commit (40 to 120 ms with it when the first of these was measured, 41 to 44 ms
in the table above), and a block now pays one, the block and the
application's state being one store transaction (6).

### 7.2 The history window

The window of past versions (100 by default) is what still grew with everything else
dropped: each block of scattered transfers adds tens of thousands of records of overwritten
tree nodes and object bytes (7.1). From `warn` on, after the index trees are dropped (and
the Merkle trees, when the level is `pressure` or `critical`), the node calls
`setHistoryWindow(2)` (`Node.HISTORY_WHEN_PAGED`), once, if the window is wider: the database
forgets, at once, every past object value, every dense tree record and every sparse tree
version or record older than the last two versions, and from then on keeps a window two
wide in memory as roots are taken. Two versions in memory are enough for a proof at the
height a client has just read to be made at full speed. Nothing a block does reads a past
version, so consensus, execution and admission are unaffected; what notices is a proof or a
query at an older height, which is no longer answered from memory but from the history
records in the store (7.3), slower and with the same answer. Without a store of history
records (a database built without the `historyStore` option, as in some tests) such a
height is refused as `not available`, as a height before the window always was.

What was forgotten stays forgotten in memory: when the window is widened again
(`setHistoryWindow` with `Infinity`, or with `retain.memoryVersions` when the operator set it, clamped to what the database was made to retain) it grows
back one root at a time. The store is not trimmed. Every root still reports its history
record in full, and the application deletes the record of the version that left the full
window (`lastStaleVersion`, the current version less the configured retention), not of the
one that left the window in memory, so the store keeps the whole configured window and a
restart with room reads all of it back (`loadHistory`, `restoreIndexVersions`).

The node widens the window again in `rebuildWhatFits`, last: only when both tiers are
resident again and its estimate of what the window held fits in the room that is left within
half the heap limit (the same room the tiers are rebuilt into, 7). It is worth widening although the store answers for the older heights,
because a read from memory is faster than one from the records. The estimate
(`historyEstimate()`, taken just before the cut) is the bytes of the past values plus 150 bytes of heap
per value, 250 per dense tree record and 500 per sparse tree record. It counts the sparse
trees' past versions whether those trees are resident or dropped: a dropped tree keeps
records, and a resident one counts the nodes its retained commits replaced (`replaced`
and `historyNodes` in `src/db/smt.ts`), which are what the versions before them still
hold. Until then the log's
`memory: staying paged until the heap has room to rebuild` counts it in `needs`; when it is
widened the log says `memory: history window restored` with the oldest provable version.

The window in memory can also be set short from the start. `retain.memoryVersions`
(`NodeConfig.retain`, and `retain` in the CLI's `config.json`) is how many of the
provable past versions (`retain.versions`, 100 by default) the node keeps in memory;
unset, it keeps all of them until memory fills. The node calls `setHistoryWindow` with it
when it has opened the application, and when the guard has trimmed the window and the
node widens it again, it widens it to this setting, not to the whole window. The store
keeps the whole window either way, and a proof or a query at an older height is answered
from the history records (7.3): of the order of 0.2 ms per version back, against under
0.1 ms from memory. The setting is for a node with a large heap: it never reaches `warn`,
so nothing trims its window, and it keeps a hundred versions of overwritten tree nodes
and object bytes in its heap. Measured at 514,008 accounts under 3,126 MiB, twice the
resident heap, for 120 seconds, two runs of each (`bench/paging-node.ts` takes
`BENCH_PAGING_MEMORY_VERSIONS` for it): the node commits 1,355 and 1,255 transfers a
second with the whole window and 1,369 and 1,241 with two versions, so throughput does
not depend on the window. What the setting buys is memory and pause length: a peak heap
of 1,630 MiB against 2,140, about 500 MiB less at this size, and a longest collection
pause of 190 to 200 ms against 290 to 300 ms. What it costs is a proof at a past height,
12 to 28 ms fifty and a hundred versions back instead of under 0.2 ms.

Trimming several versions in one call exposed a fault in the three pruning loops (the value
history, the dense trees, the dropped sparse trees), which assumed one version was pruned
at a time: a node or object changed in more than one of the pruned versions had its entries
emptied by the first version's pass and was then looked up again by the next. They now skip
an entry that is already gone.

### 7.3 Past versions from the store

Until this was built, a height older than the window in memory was refused as `not
available`: after a trim at `pressure` until the window had grown back, and after a store
was opened paged (9.1) until a hundred blocks had been applied. The store held the history
records of those heights all the while. The database now reads them.

- **The history store.** `ObjectDatabase` takes an option `historyStore`, a function from a
  version to the encoded history record the application wrote for it, or undefined
  (`HistoryFetch` in `src/db/database.ts`). `CoreApp` and `openObjectDatabase` pass
  `(version) => kv.get(historyKey(version))`. Without the option nothing changes: the
  window in memory is all the database can describe.
- **What can be asked for.** With a history store, `lowestVersion` is the oldest version
  the store's records reach: the larger of `storedFloor` and the current version less the
  configured retention, or the start of the window in memory if that is lower. Trimming the
  window no longer raises it. `storedFloor` is the version of the first root, lowered by
  `loadHistory` for each record it is given and by `noteStoredHistory(version)` for each
  record the store holds that the database was not given, which is how a store opened
  paged tells the database what its records cover (9.1).
- **A history record says what its version overwrote.** For each dense tree it changed, the
  leaf count before and the hash of each node before; for each object, its bytes before
  (or that there was none); for each type's counter, its value before; and, new with this,
  for each sparse tree node the commit changed, the node's store key and its encoding
  before, or that there was none (`HistoryRecord.nodes`, a list of `NodeRecord`). The
  sparse trees hand these over after each commit (`takeRecords()`), resident or dropped.
  `encodeHistory` writes the list last, as an option. `nodes` is null when a tree kept no
  list, which is the case for a database with no store and resident trees. A record
  written before the list existed simply ends after the counters, and `decodeHistory`
  reads it with `nodes: null`.
- **A past read** (`getAt`, `bytesAt`, `countAt`, `proofAt`, `typeLeafProofAt`,
  `rangeProofAt`, `rootAt`, `proveKeyAt`) of a version inside the window in memory is
  answered from memory as before. For an older version it first names what it will look
  at: the object, the type's counter, the positions of the dense tree nodes on the proof's
  paths (`pastPositions`, `pastRangePositions`: the root at every height the tree may have
  had, and the siblings of the leaf's path up to today's height), and the store keys of the
  sparse tree nodes (`pastKeys`: each authenticated index's root node, and for a key proof
  every node down the key's path). The private `past(version, want)` then scans the records
  of every version after the one asked about, oldest first. The first record to name an
  entry gives its value as of the version asked about; an entry no record names has not
  changed since and is read as it is now, from the tree or the store. The last root's
  record may not have been written by the application yet, so it is taken from the pending
  change list. The trees take the result as an extra parameter (`past`) on `sizeAt`,
  `nodeAt`, `rootAt`, `pathAt` and `rangeProofAt` of the dense tree and on `rootAt` and
  `proveAt` of the sparse tree, and answer from it where it has an entry.
- **A record is not decoded.** `scanHistory` walks the encoded record where it lies, by
  the layout `encodeHistory` gives it, and copies out only the entries wanted. A record of
  a block of scattered transfers is some hundreds of kilobytes and a proof wants a few
  dozen entries of it; decoding each whole would allocate what the trimmed window was to
  save. Nothing is cached between reads, so a trimmed window costs a past read time and
  not memory. A read from the records is slower than one from memory, the more so the
  further back the version is, since every later record is scanned: at 192,000 accounts
  under blocks of 400 to 550 transfers, an account proof takes 0.04 ms from memory, 9.2 ms
  fifty versions back and 19 ms a hundred back, about 0.2 ms per record
  (docs/benchmarks.md 4.13).
- **A missing record is a refusal.** The database keeps the list of the versions that
  have a record (`recorded`: every root after the first, and what `loadHistory` and
  `noteStoredHistory` name, less what has left the full window), and `past()` scans
  exactly those. If the store does not return the record of one of them, the read throws
  `RangeError: version N is not available: the store has no history record of version V`.
  Without the record an entry it named would be read as it is now, a wrong answer with
  nothing to show for it; as first built, a version the store had no record for was taken
  to be one at which no root was computed, and a damaged store was answered from what was
  left. The same holds at opening: `openObjectDatabase` reads the history keys in one pass
  and uses only the run of records that is unbroken up to the current height. With a
  record missing in between, the heights below the gap are not provable
  (`lowestProvableHeight` rises to the gap) and their records are deleted with the next
  commit.
- **A restart takes the sparse trees' past versions from the records.** A sparse tree's
  versions are root pointers into a structure in memory and do not survive a restart.
  They were rebuilt by replaying every key from the object history
  (`rebuildIndexVersions`), which costs every key of every authenticated index: 3.5 s of
  a 5.2 s restart at 192,000 accounts (5.3). With the node lists in the records that is no
  longer needed. `loadHistory` keeps each record's list, and
  `ObjectDatabase.restoreIndexVersions()` hands each tree the lists of its nodes by
  version (`SparseMerkleTree.loadVersions(lowest, records)`). A commit's records are what
  the version before it differs by, so each older version is built against the next newer
  one from that commit's records alone, newest first, sharing every subtree the commit
  left alone, and every node taken from a record must hash to what its parent says. A
  dropped tree builds nothing: it takes the root hashes and keeps the records as its own
  history. The cost is the nodes the window's blocks changed, not every key.
  `restoreIndexVersions()` returns `'records'` when it did this, `'none'` when there is no
  past version to restore, and `'replay'` when it fell back on `rebuildIndexVersions`,
  which it does when a record given to `loadHistory` was written before the lists were
  kept (its `nodes` is null) or a record does not hold a node a version needs.
  `openObjectDatabase` calls it where it called `rebuildIndexVersions`, and the startup
  line `loaded application state` reports the result as `indexVersions`. The restart
  measured again at 192,000 accounts: 2.91 s where it was 5.2 s, of which 0.31 s is
  reading the store, 2.59 s the indices, the trees and the root with every check, and
  2 ms the history, where replaying every account took 3.5 s. Without the leaf check it
  is 1.46 s, and with the trees computed from the objects 5.41 s. The heap after the
  restart is 381 MiB where it was 572.
- **Records without the sparse nodes.** A past read that needs sparse tree nodes (an
  object proof, a type leaf proof, a key proof: each carries the roots of the type's
  authenticated indices) and meets a record with no list of them throws `RangeError:
  version N is not available: the record of version M was written without the sparse tree
  nodes`. Reads that need only objects, counters and dense tree nodes (`getAt`, `bytesAt`,
  `countAt`, `rootAt`, `rangeProofAt`) work from such records. In a store written by an
  earlier build the old records age out of the window as blocks are applied, a hundred
  blocks at the default retention.
- **Unchanged.** The window is still trimmed by the guard and let grow back at `ok` when
  it fits (7.2), a restart with room still reads the window back into memory (the sparse
  trees' part of it now from the records, as above), and the store still keeps the full
  configured window.

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
   index trees (at `pressure` as first built, from `warn` on now) and then the Merkle trees
   at `pressure`, and rebuilds what fits at `ok` (7);
   `npm run bench -- paging` reports blocks and transfers per second and the memory at each
   mode, and a node whose guard reaches `pressure` on its real heap keeps committing (7.1).
   The node runs under a real `--max-old-space-size`. When this was measured a node
   opening its store built every tier resident before the guard sampled, so a heap smaller
   than what opening took (about two thirds of the resident heap: 400 of 595 MiB at
   192,000 accounts, 1,000 of 1,563 at 514,000) aborted at startup. Above that it opened
   and paged: a matrix of three states (34,000,
   192,000 and 514,000 accounts) against five limits (0.8, 1.0, 1.25, 1.5 and 2.0 times the
   resident heap) committed blocks for the whole run in every cell, with 15 to 25% of
   throughput lost while paged at the two larger sizes and the smallest state cycling through
   `pressure` and `critical` because the load's own growth is several times that state.
   A store is now opened with the tiers that do
   not fit left dropped (9.1), which moved the floor from two thirds of the resident heap
   to a quarter under the benchmark's load. The matrix as it now stands
   (docs/benchmarks.md 4.13 has the table) is from after that, after the guard came to
   read the old generation (7) and after the dropped trees' chunk cache grew to 4,096
   chunks (5.2): no cell reaches `critical`, the smallest state included, and throughput
   paged is within a tenth of resident, the 192,000-account node committing 1,650 to
   1,800 transfers a second at every limit from 0.8 times its resident heap to twice it.

### 9.1 Opening a store too large for the heap

The guard cannot help a node while it opens its store: it samples once a second, and a
tier that does not fit has taken the heap past the limit before the first sample. So the
decision is made before anything is built (`openObjectDatabase` in `src/app/core/app.ts`,
`estimateTiers` in `src/db/database.ts`).

- **The room.** Under a heap limit (`--max-old-space-size`, which the CLI's `start` always
  sets) the node gives the application `heapRoom`: half the limit (`Node.OPEN_FILL`,
  0.5, what a rebuild is allowed) less the heap in use at that moment (`heapInUse`, the old
  generation's; 7). It was 0.7, the guard's warn line, at first. At the warn line a node with its index trees in the store opened its Merkle trees into a heap as large as its resident state and then ran 75 MiB under `warn`, visiting it 61 times in ten minutes; at half it opens paged and visits `warn` five times,
  committing 1,523 transfers a second against 1,478 (docs/benchmarks.md section 4.13). Without a heap limit it
  gives none, and every tier is opened as before.
- **The estimate.** The store keeps a counter per object type, an upper bound on how many
  objects the type holds. `estimateTiers` multiplies them by the figures
  `rebuildEstimate()` uses (10): 210 bytes per index entry for the index trees, 2,000 per
  leaf of an authenticated index for the Merkle trees.
- **The decision.** If the index trees are estimated not to fit the room they are opened
  dropped; otherwise their estimate is taken off the room, unless the caller left them out
  (`indexTrees: false`), in which case they take none. Then the Merkle trees are opened
  dropped if they do not fit what is left. A tier the caller named (`indexTrees` or
  `trees` given as an option) is opened as asked, whatever the room.
- **The history window.** If either tier was left out, the history records are not read
  back either. Reading them puts every tree node and object the window's blocks
  overwrote into the heap, which under a scattered load is more than the trees
  themselves. The
  node then starts with an empty window in memory, which fills again one block at a time.
  The heights before the one it opened at stay provable all the same: for each record it
  does not read, `openObjectDatabase` calls `noteStoredHistory(version)`, so the database
  knows how far back the store's records reach and reads those versions from them (7.3).
  `lowestVersion` is what it would have been had the window been read back. The records
  stay in the store and age out of it as they would have, so the same store opened later
  with room has its window back in memory.
- **Reported.** `OpenedDatabase.paged` lists what was left out (`indexTrees`, `trees`,
  `history`), and the startup line `loaded application state` carries it as `paged` when
  it is not empty.
- **Afterwards.** The tiers left out are dropped tiers like any the guard dropped: the
  node runs on the fallbacks, and `rebuildWhatFits` rebuilds them at `ok` if room appears
  (7).

The objects themselves are still loaded into the arena, outside the heap, unless
`--arena` bounds it (3.4).

Measured on the 191,896-account state (595 MiB of heap resident, 400 MiB to open
resident), a single validator under a full feed of transfers, with `indexTrees: 'memory'`,
the default at the time (docs/benchmarks.md 4.13):

| heap limit | of the resident heap | opened with | heap after opening | run | transfers/s | levels reached |
|---|---:|---|---:|---:|---:|---|
| 298 MiB | 0.5 | index trees; Merkle trees and history left in the store | 155 MiB | 120 s | 1,594 | `warn` four times |
| 208 MiB | 0.35 | index trees; Merkle trees and history left in the store | 153 MiB | 60 s | 1,439 | `warn` three times |
| 149 MiB | 0.25 | nothing; index trees, Merkle trees and history left in the store | 34 MiB | 60 s | 1,193 | `warn` twice |

All three opened in 3.2 to 3.4 seconds and committed for the whole run, every
block with the Merkle trees dropped, and none reached `pressure`. Every height of the
window stayed provable from the
records in all three (7.3), a proof at the oldest taking 13 ms after the run at 298 MiB.
Opening with every tier left out took 34 MiB of heap (the old generation's use, as in the
whole table). A quarter of the resident heap is enough under this load: the node opens
with every tier in the store and commits 1,193 transfers a second, where the same run
reached `critical` once while the guard counted the young generation (7), and two thirds
was the floor before stores were opened paged. The two that open with their index trees
resident drop them at the first `warn`; while the index trees went only at `pressure`
each of the three runs went there once, for 1,357, 1,197 and 1,171 transfers a second.
Opening leaves garbage several times what
it keeps, which the guard's first sample took for a full heap at 208 MiB (211 of 208,
`critical`, with 75 MiB live); the node collects once before the guard starts
(`Node.start`).

## 10. Defaults

| parameter | default |
|---|---|
| hotObjects | unbounded; the guard caps it at 100,000 (`warn`) and 10,000 (`pressure`) |
| arenaBytes | unbounded; `start --arena <MiB>` sets it (at least 16); needs an object store, never releases the current slab |
| mempool limit | 10,000 transactions; the guard admits up to all of it at `ok`, half at `warn`, a tenth at `pressure`, none at `critical` |
| index trees | `indexTrees: 'store'` (the default): never built, read from LMDB, not counted as waiting to be rebuilt; `indexTrees: 'memory'`: resident when they fit at opening, dropped from `warn` on, rebuilt at `ok` after the wait below when they fit |
| history window in memory | the configured retention (100 versions), or `retain.memoryVersions` of it when set; 2 from `warn` on (`Node.HISTORY_WHEN_PAGED`), let grow back at `ok` once both tiers are resident and what it held fits |
| wait before a rebuild | the guard samples since something was last rebuilt or the node started, at least 10 (`Node.REBUILD_WINDOW`) and at most 600 (`Node.REBUILD_WAIT_MAX`), all of them at `ok` in a row; then a tier is rebuilt if it fits within 0.5 of the heap limit (`Node.REBUILD_FILL`) beside the highest of the last 10 samples |
| room for opening a store | 0.7 of the heap limit less the heap in use (the old generation's), when the process runs under a heap limit |
| slab size | 256 KiB first, doubling to 16 MiB |
| compaction | every slab with nothing live, without copying; then slabs with dead bytes over half their used bytes, copying at most what the root wrote (at least 16 MiB) |
| entry header | 10 bytes: type u16, instance u32, length u32 |
| treeChunks | 4,096 dense tree chunks cached while the trees are dropped (at most 128 MiB, outside the heap) |
| rebuild estimate | 210 bytes of heap per index entry; 2,000 per sparse tree leaf (1,000 kept, 1,000 thrown away) and 500 per node record of a retained version |
| history estimate | the bytes of the past values, plus 150 bytes of heap per past value, 250 per dense tree record and 500 per sparse tree record (a record kept while the sparse trees are dropped, a replaced node while they are resident) |

## 11. Tests

`test/arena.test.ts`: allocation across slab growth, free accounting, compaction moving live
entries and releasing a slab, refusal of an oversized entry. `test/db.test.ts` gains: a hot
cache that evicts clean objects and never dirty ones, with reads correct after eviction;
tombstones hiding removed objects until the root; history as bytes with `getAt` and
`bytesAt` agreeing; export after churn equal to the live state; the same root from a
database whose cache holds nothing as from one whose cache is unbounded.
`test/memory.test.ts`: a core-application node whose heap is driven to the `pressure` level
has its cache capped at 10,000 and the excess evicted, and gets it back unbounded at `ok`;
the same node, made with `indexTrees: 'memory'` as the test helper makes them, has its index trees dropped from `warn` on, keeps following the chain on the
fallback, reports it in `status`, and has them rebuilt at `ok`. A guard given samples that
carry `heapOld` takes its levels and its log fields from that figure whatever `heapUsed`
says, and the process's own sample has `heapOld` exactly when it runs under a heap limit.

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
`test/memory.test.ts`: the node keeps its Merkle trees at `warn` and drops them at `pressure`, proves objects
against them as a validator does, considers no rebuild until it has waited at `ok` as long
as it had run before the drop, keeps them dropped while rebuilding is estimated
not to fit, saying once that it stays paged, and rebuilds them once it does. `TREES=0` runs any suite with every tree
dropped.

For the mempool limit and the history window, `test/memory.test.ts`: at `warn` the node's
history window is trimmed to two versions and its mempool admits up to half its limit,
with nothing shed; at `pressure` the window stays trimmed and the mempool is not paused
but admits up to a tenth of its limit; with the limit reached a transaction submitted to the node is
refused as `full` and `broadcastTx` answers -32004, and with room under the limit a
broadcast reaches the application; back at `ok` the limit is whole again, and once both tiers
are rebuilt and there is room the window is restored; and a node started with
`retain.memoryVersions` 3 keeps three past versions in memory and proves a height six
back from the store, and with `indexTrees: 'store'` finds an account by name with its
index trees dropped from the start and still dropped 300 ms later. `test/db.test.ts` ("counts the nodes its past versions hold while
resident, and gives them up with the window"): a resident sparse tree counts the nodes
its retained commits replaced, fewer after its window is narrowed and none at a window
of 0, and none for commits that do not list their changes. `test/db.test.ts` ("a trimmed
history window", with the trees resident and with them dropped): a database trimmed to two
versions forgets the older ones at once (object proofs, past values and key proofs there
are `not available`, the database having no history store), gives the same roots and the same proofs as an untrimmed one for
the versions it keeps, still reports the same history record at every root, and counts
the version a store may forget from the full window; widened again, it does not take back
what it forgot and reaches its full width a root at a time; and dropping or rebuilding
the trees while trimmed keeps what the window holds. `test/app.test.ts`: an application
whose window in memory is trimmed keeps the whole window in its store, so a restart from
that store proves every height an untrimmed application does, its startup line saying
`indexVersions: 'records'`; while trimmed it
reports the same lowest provable height as the untrimmed one and gives the same object
proofs and name proofs at every height of the window, from the store's records; and with
one history record deleted from the store, an application opened on it proves the heights
from the gap on, refuses the ones below it as `not available`, and deletes their records
with its next commit.

For past versions from the store, `test/db.test.ts` ("past versions from the store", with
the trees resident and with them dropped): a database with a history store, its window
trimmed to two versions and then to none, reports the same `lowestVersion` as one that
never trims and gives the same object proofs, key proofs (present, absent, and a name that
passes from one object to another), range proofs, type leaf proofs, roots and past
values at every
version the store has a record of; it answers for a root whose record the application has
not written yet; when the window grows back the window in memory takes over from the
records a version at a time, through a drop or a rebuild of the trees, and both agree
throughout; a version before the oldest record is still `not available`; and with one
record deleted from the store, a version above it is still answered and a version below
it is refused, naming the record that is missing. A second case, also run both ways,
reopens the store as a restart does, once with every record whole and once with one
record's node list set to null: `restoreIndexVersions()` returns `records` and `replay`,
and either way the reopened database gives the proofs and past values of the first at
every version of the window and goes on from there like a database that never restarted.
A third case
writes the records as they were before the sparse tree nodes were kept: they decode with
`nodes: null`, the root and the proof of an object whose type has no authenticated index
are still read from them, and a key proof or a proof of an object whose type has one is
refused as `not available`.

For the arena as a cache, `test/arena.test.ts`: `shrink` releases whole slabs down to a
byte limit, unread ones before read ones, reports each live entry of a released slab to
the owner once and no dead one, never releases the current slab, and leaves the slots to
be used again. `test/db.test.ts` ("an arena within a byte limit"): a database with a
limit of zero over a store releases nothing until the store has the root, then keeps one
slab and reads the rest from the store, with the roots, proofs, lookups, scans, past
values, export and snapshot of a database with no limit; an object only in the store is
modified, removed and undone like any other and is back in the arena once written; an
object missing from the store is an error when it is read; and without an object store
the limit is ignored. `test/app.test.ts`: an application opened with `arenaBytes: 0`
leaves every object in the store, reads them from there, runs blocks with the app hashes,
results and proofs of a resident one, and has what the blocks wrote back in the arena.

For a store opened without room, `test/app.test.ts`: an application reopened with
`heapRoom: 0` has both tiers dropped and no history window in memory, proves the heights
before the one it opened at from the records left in the store (the same lowest provable
height, object proofs and name proofs as the resident application), runs blocks with the app hashes, results and proofs of a resident one, and
leaves those records in the store to age out; the same store opened
with room has its whole window back; and a tier asked for by name is opened resident
whatever the room.
