# State paging specification

Status: phase one implemented (`src/db/arena.ts`, `src/db/index.ts`, `src/db/database.ts`,
tests in `test/db.test.ts`, `test/arena.test.ts` and `test/memory.test.ts`), together with
the first of phase five's dials (the guard caps the hot cache); phases two to four designed
here and not yet built. Decisions were taken in conversation on 2026-10-30. `DESIGN.md` section 6
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
scan is an LMDB range and a cursor from `start` is `scanFrom`.

### 4.2 Fallback reads

While a type's index tree is dropped, `lookup` is one LMDB get and `scan` / `scanFrom` is an
LMDB cursor merged with the overlay: entries the open sessions added appear, entries they
removed are skipped, and a key both removed and re-added yields the new id. The merge walks
the cursor and the overlay's sorted keys together, as Cosmos SDK's cache-KV iterator does.
Uniqueness checks on `insert` consult the overlay, then the tree if present, then LMDB.

### 4.3 Dropping and rebuilding

A tree is dropped whole (the guard's `pressure` level) and rebuilt whole from LMDB when
memory returns (`ok`), by walking the type's prefix; until then every read of that type
takes the fallback. The authenticated indices' sparse trees are tier three.

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
measured at each phase against `commit to LMDB (after a 500-transfer block)`, 8.8 ms today.

## 7. The guard's dials (phase five)

| level | heap used of limit | what the database does |
|---|---|---|
| ok | under 70% | caches unbounded (built); dropped accelerators rebuilt |
| warn | 70% | hot cache capped at 100,000 decoded objects (built); cold slabs may be released; major collection started |
| pressure | 85% | hot cache capped at 10,000 (built); index trees and cold chunks dropped; costly RPC methods still refused, since proofs at past heights read history |
| critical | 95% | clean stop, as now; reached only when one block's working set does not fit |

The mempool is no longer paused at `pressure` once phase three is in: admission reads
through the fallback like everything else. `status` reports the mode of each tier
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
2. **Index entries on disk**: written at every commit, read by nothing yet; commit cost measured.
3. **Droppable index trees**: fallback lookups and merged scans; a test drops every tree and
   runs the application suite against the fallback.
4. **Chunks on disk and droppable trees**: a test drops the trees and verifies roots match.
5. **Guard integration and a paging benchmark**: a node started with `--heap` below its state
   size keeps committing blocks; the benchmark reports blocks per second at each level.

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
has its cache capped at 10,000 and the excess evicted, and gets it back unbounded at `ok`.
