# 9. The object database

This chapter covers `src/db/`: the in-memory object database that holds every piece of consensus state the application owns (as encoded bytes in an arena, with a bounded cache of decoded objects over them), the indices that make it queryable, the Merkle trees that turn it into one 32-byte app hash, the proofs that let an outsider check a single object or a single name against that hash, and the undo sessions and version history that let the same structure serve transactions, blocks and queries at past heights. It builds on the deterministic binary codec of [chapter 1](01-codec.md) (every object has exactly one encoding, which is what gets hashed) and the SHA-256 and byte helpers of [chapter 2](02-crypto.md). It is used by [the application](11-application.md), which defines the object types and drives sessions and roots; by [sync](07-sync.md), which exports and imports snapshots with range proofs; by [the RPC](12-rpc.md), which serves objects, keys and proofs; and by [the light client](13-light-client.md), which verifies those proofs with `src/db/proof.ts` and nothing else. `src/types/txproof.ts` from [chapter 3](03-types.md) reuses the dense tree for the block's data hash and results hash. The database writes nothing to disk itself: what it changed at each root, the objects, the index entries, the Merkle trees' chunks and nodes, is handed to [the store](10-store.md) as a change list, and the store gives it all back on restart. The one thing it reads from the store is what the memory guard has told it to let go of, through a read-only view the application lends it: since phases two to four of STATE-PAGING.md the secondary indices' B+ trees and the Merkle trees are caches over the store that can be dropped and rebuilt while the node runs, and this chapter describes them as such.

## Concepts

### Objects, types and dense ids

The model is the object database of Graphene, the framework behind BitShares. All consensus state is a set of typed objects held in memory. Each type (account, asset, balance, validator, ...) has a small integer id, and each object of a type has an instance number taken from a per-type counter that only ever goes up. The pair is the object's id, written `type.n`. DESIGN.md section 6 states the two reasons for this: a reference by id is eight bytes where a public key is 1,313 bytes with ML-DSA-44 (34 with secp256k1, the scheme tag included either way), so a transfer names its accounts cheaply and the keys stay in state; and dense instance numbers make the primary index an array and the Merkle tree a complete binary tree, with no key hashing and no balancing.

The two halves pack into one unsigned 64-bit integer: 16 bits of type, 48 bits of instance. Worked example: the id of instance 5 of type 3 is

```
objectId(3, 5) = (3n << 48n) | 5n
              = 3 * 2^48 + 5
              = 844424930131973
              = 0x0003_0000_0000_0005
idToString(...) = "3.5"
```

The test suite relies on the same arithmetic: `test/genesis.test.ts` expects the account id `"3.0"` to parse to `3n * 2n ** 48n`. Instances are below 2^48, so `instanceOf(id)` is an exact JavaScript number. Whether it can index an array directly is a separate question: a JavaScript array index stops at 2^32 - 2, so `src/db/index.ts` enforces `MAX_INSTANCE = 2 ** 32 - 2` in `insert` and in the imports (`importBytes`, which `importCommitted` goes through, and `importStored`) and refuses anything beyond it. The 48 bits of the id layout are headroom in the wire format; the primary index guarantees the smaller bound, and that guarantee is what lets the rest of the code treat an instance as a dense array index.

Objects are immutable records. A modification does not mutate; it replaces the object with a new one under the same id. That is what makes undo cheap (an undo log holds references to old values) and what makes "the object as of version v" a well-defined thing to remember. Counters are consensus state too: they are hashed into the type leaf, and a proof that instance 50 of the account type does not exist is a proof about the counter.

### Why everything is in memory, and what it costs

Graphene keeps all consensus state in RAM and this chain began from the same trade-off (DESIGN.md section 6: "all consensus state in memory", "state bounded by RAM"). The disk holds a copy of every object, every index entry, every tree chunk and node, and the history records; a database on its own holds every tier in memory as well, and with memory to spare nothing on its hot path reads the disk. A node is the exception from the start: it leaves the secondary indices' trees in the store unless its config says `indexTrees: 'memory'` ([chapter 8](08-node.md)), so those are read there whatever memory there is; under memory pressure the tiers the guard has dropped are read there too, which the section after the next describes. README.md's figures give the shape of the cost: 100,000 objects take 94 MiB; a 1 GB genesis of 193,393 accounts with two ML-DSA keys each sits at 383 MiB of heap plus 582 MiB of array buffers after a restart (590 and 1,054 MiB in the process that built it), roughly its size after a restart, since hex halves to binary while objects and trees add it back. What that buys is reads that do not depend on size: an account by id is 10,200,000 lookups per second at that scale, by name 592,000, and a proof with verification about 46,000 per second. What grows with size is anything that walks every object: genesis, restart, snapshot export and import. Those figures are with the arena of the next section, which changed how the objects are held more than how much memory they take.

### Objects as bytes: the arena and the hot cache

"In memory" does not have to mean "as JavaScript objects". A decoded account is a small tree of objects, strings, bigints and arrays, each with its own header in the V8 heap; the header comment of `src/db/arena.ts` puts an account under secp256k1 at 117 bytes encoded and about a kilobyte decoded. And the encoding is needed anyway: it is what a leaf hashes, what the store writes, what a proof carries and what a snapshot ships. So since phase one of STATE-PAGING.md, the specification that turns memory into a cache over LMDB one tier at a time, the database keeps every committed object as its canonical bytes and decodes on demand, with a bounded cache of decoded objects in front.

The bytes live in an arena: a few large `Uint8Array` slabs filled by a bump allocator, the first 256 KiB and each next one twice the last, up to 16 MiB. An entry is a 10-byte header followed by the encoding:

```
offset 0    type       u16   the object's type
offset 2    instance   u32   the object's instance
offset 6    length     u32   bytes of encoding that follow
offset 10   encoding
```

A reference to an entry is the slab number times 2^24 plus the offset of its header, packed into one JavaScript number: the entry at offset 1,000 of slab 3 is `3 * 2^24 + 1000 = 50,332,648`. Per type, a `Float64Array` indexed by instance holds each object's reference (-1 for none, -2 for an object whose bytes are only in the store, below) and a `Uint32Array` its length. Those two tables are the primary index now, and they are still plain arrays indexed by instance, because instances are dense.

Slabs are never written in place. A new encoding of an object is a new entry at the end of the current slab, and the old entry only has its bytes counted dead. After a root, a slab with nothing live left is released outright, and a slab whose dead bytes are more than half its used bytes is compacted: its entries are walked header by header, each one that is still current (the header names the owning type and instance, and the owner's table says whether this reference is still the object's) is copied into the current slab, the owner is told the new reference, and the slab's buffer is released. Compaction takes up slabs until it has copied what the root's block wrote into the arena (or 16 MiB, if that is more), so the pause stays in proportion to the block. The budget is tested between slabs and not inside one, so a pass can run past it by the live bytes of its last slab, which are less than half of that slab and so under 8 MiB. A released slab's number goes to the next slab with a generation counted up (the slab number in a reference is the generation times 2^16 plus the slot), so a stale reference fails instead of reading someone else's bytes.

Over the arena sits the hot cache: per type a `Map` from instance to decoded, frozen object, under one budget, `hotObjects`, that all types share. A read is a cache hit, or a decode from the arena (about a microsecond for an account) whose result is frozen and cached. When the budget is spent something must go, and choosing well matters: a block keeps touching the same accounts, while an RPC client listing every account touches each one once. The policy is CLOCK, the second-chance approximation of least recently used from operating systems' page replacement: each instance has a touched bit, a hit sets it, a fresh decode enters with it clear, and a hand sweeps the type's cached entries in the cache's own order, clearing the bits it finds set and sending those entries to the back (the second chance) and evicting the ones it finds clear. A hit costs one byte store, and nothing is ever sorted.

Worked example with a budget of two and the hand at instance 0. Read 0, then read 1: two misses, both decoded and cached with their bits clear, and the budget is full. Read 0 again: a hit, and its bit is set. Read 2: a miss, so 2 is cached with its bit clear and the cache is one over. The hand looks at 0, finds its bit set, clears it and moves on; it looks at 1, finds its bit clear, and evicts it. The cache holds 0 and 2, both bits clear, and the hand waits at 2. Instance 1, read once, went first; instance 0, read twice, stayed. A scan that reads every account once fills the cache with clear bits, and the hand takes those before anything a block keeps touching.

Writes never leave the cache before a root. An object created or modified since the last root is pinned there, decoded, and never evicted whatever the budget; a removal is a tombstone (`null`) there, which hides the object the arena still holds. `root()` encodes each pinned object once, however many times it was modified, hashes those bytes, writes them to the arena and unpins it. A transaction that fails is undone by putting old decoded values back into the cache, so it costs no arena traffic. Past values are kept the same way: what an object was before a version is kept as its bytes, not as a decoded record, and decoded only when that version is read.

The budget is unbounded by default, so a node with memory to spare decodes each object once, keeps it, and runs nearly as it did before the arena. The memory guard of [chapter 8](08-node.md) caps it as the heap fills: 100,000 objects at `warn`, 10,000 at `pressure`. Measured when the arena was introduced, at 191,896 accounts with two keys each under secp256k1 ([benchmarks.md](../benchmarks.md) section 4.10), against the same run before the arena, the resident mode cost about 6% more memory, the encoded copy beside the decoded one (607 MiB of heap after building against 597, and the array buffers, where the slabs live, at 79 MiB against 41), and 5 to 15% of speed (a block of 500 transfers among random accounts in 24.8 ms against 21.5; `get by id` on the small suite in 72 ns against 42, a map lookup instead of an array index). The capped mode saved 17% of the heap with an empty cache (489 MiB after a restart against 601) at the price of the same block taking twice as long, 41 ms; that is the degraded mode the guard turns on. The arena by itself did not move memory much, because decoded objects were never the bulk: they are about a sixth of the heap, 0.55 KB of the 3.2 KB an account costs, and the secondary indices, the name tree and the Merkle trees are the rest, which is what the later phases of STATE-PAGING.md put on disk.

The arena itself can be a cache too. The application's store holds every committed object by id, written at every commit, so the copy in the arena is one the database could read back. Given a byte limit (`arenaBytes`, the CLI's `start --arena <MiB>`; unbounded by default) and a function that reads an object's bytes from the store, the database releases whole slabs beyond the limit once the application has written the last root, those nothing has read since the last pass first and never the one being filled. Each live object in a released slab has its reference set to -2, "stored": it is still committed, still in every index and every tree, and a read that misses the hot cache fetches its bytes from the store instead of from a slab, decodes them and caches the object. A read does not put the bytes back in the arena, so reading the whole state does not grow it; the object is in the arena again when it is next written, because a root writes every new encoding there. At a restart, objects are loaded into the arena until their bytes reach the limit and the rest are left in the store. This limit is in bytes and set by the operator, not turned by the memory guard: the slabs are `ArrayBuffer`s, outside the heap the guard watches (STATE-PAGING.md section 3.4, which also records that the specification first had the guard release "cold slabs" at `warn`, and why that was not built).

### The indices and the trees as caches over the store

Phases two to four of STATE-PAGING.md do for the other five sixths what the arena did for the objects: LMDB holds every tier's complete state at every committed height, and what memory holds are accelerators. Three things follow, and the file sections below keep coming back to them.

**Every tier is written at every commit.** Besides the objects, a root reports the secondary index entries it added and removed and the Merkle tree chunks and nodes it changed, and the application writes them in the same transaction as the objects ([chapter 11](11-application.md)). The disk forms are three key prefixes in the application store, each defined by the database file that owns it:

```
'i' type u16, index position u8, key bytes           -> id u64                  (unique index)
'i' type u16, index position u8, key bytes, id u64   -> empty                   (non-unique index)
't' tree u16, level u8, chunk u48                    -> up to 1024 hashes, trailing empties cut off
'n' type u16, index position u8, path bits, depth u8 -> 0x00 left right, or 0x01 keyHash value
```

The index position is the index's place in its type's definition, so the layout is fixed by the type registry; a non-unique key already ends with the id (`TypeIndex.keysOf` appends it before the key reaches the tree), so an entry is the tree's key with a four-byte header in front, and bytewise order in the store is the order the tree keeps: a prefix scan is an LMDB range and a cursor from a start key is `scanFrom`. The tree of a chunk key is the type id, or 0 for the tree over the types (`TOP_TREE`), and the chunk index is big-endian, so one tree's chunks are one range; a chunk is stored without its trailing empty hashes, so the one-chunk upper levels cost what they hold (a tree's root level is one 32-byte value) and a chunk that becomes all empty is deleted. A sparse node's key is the first `depth` bits of its path, packed and zero-padded, then the depth as one byte, so every node has one key; an inner node carries both children's hashes, so a walk down one key's path reads one node per level and finds every sibling hash on the way, and a proof never reads a sibling node. Writing all of this is not a mode a node turns on under pressure: a node that never pages pays for it anyway, so that the fallback exists the moment it is needed, and it costs a few percent of a commit (the numbers at the end of this section).

**A dropped tier reads the store.** `dropIndexTrees()` lets a type's B+ trees go (one type or all), and `dropTrees()` lets every dense and sparse tree go at once, one dial for the tier, since the guard has one decision to make and the sparse trees are where the heap goes. While the B+ trees are dropped a lookup is one LMDB get and a scan is an LMDB cursor merged with an overlay: per index, what the writes since the last root made of each key, an id or null for a key released. The merge is the one the Cosmos SDK's cache-KV iterator does, one step of each cursor at a time with nothing materialised, and what a dropped index reads is three such layers laid over each other: the store as the application last wrote it; the change lists of roots the application has not written yet, since `commit()` comes a moment after `finalizeBlock` and the store is a block behind in between; and the overlay. A root empties the overlay, since the store with the root's changes then says the same. While the Merkle trees are dropped, a root reads each changed leaf's path from the store, a chunk per level, through an LRU of chunks that all the database's trees share (4,096 by default, at most 128 MiB of buffers outside the heap), works on private copies of the chunks it changes and reports those as the change list, so nothing read from the store or handed out is ever written in place; a sparse tree only remembers its writes per key and applies them at the commit by walking each key's path through the store with the shape rules of the tree in memory, so the root is the same whatever the order. Proofs at the current version read the same way; past versions still come from the history records, which stay in memory for the window. Rebuilding reads a type's prefix, or every tree's chunks and nodes, back into fresh structures. Both dials may be turned with sessions open, in the middle of a block: the drop builds the overlay from what is dirty (every committed key of a dirty object released, then every current key taken, so a key that changed hands ends with its new owner and a key an object kept ends as it was) and turns the sparse trees' uncommitted writes into pending ones, and the rebuild walks the merged view, so neither changes a lookup or a root. `test/db.test.ts` plays a database that drops and rebuilds at random moments against one that never does and requires the same lookups, scans, roots and proofs after every step.

**Determinism is untouched.** Roots are computed from the same leaves and the same bytes wherever they are read from, and a restart takes the trees from the store instead of hashing every object, about twice as fast, hashing every object against its leaf on the way by default so that a corrupt object store still fails at startup and not when something reads the object.

What it costs, from STATE-PAGING.md sections 4.4, 5.3 and 7.1, at 191,896 accounts under secp256k1 unless said otherwise. The index entries: `commit to LMDB` after a 500-transfer block went from a mean of 8.95 to 9.63 ms, 7%, for about a thousand entries a block (each transfer leaves a recent transaction id with two entries; the balances change no key); the genesis writes 576,000 entries and the store grows from 34.6 to 92.7 MiB. The trees: another 120 MiB of store, to 213 MiB, for about 600,000 sparse nodes and 25 MiB of chunks; a block whose writes are local costs nothing measurable, a block of 2,400 transfers scattered over the whole state about 12 MiB of chunks and a fifth more commit, 45.7 to 55.1 ms; the restart went from 8.41 to 5.2 s (4.6 without the leaf check), and is 2.85 s now that the sparse trees' past versions come from the history records. Dropped, on the db suite at 100,000 balances and 26,000 accounts (docs/benchmarks.md sections 4.11 and 4.12): a lookup through LMDB costs about what a resident one does (both are dominated by building the key and fetching the object), a scan five to nine times as much, by its median and its mean (53 and 92 microseconds per hundred entries against 10), still under a microsecond an entry; a root over 1,000 modified balances 54.2 ms against 26.9 as means, with medians of 29.4 against 20.3 once the upper levels are cached (215 chunks after these runs, of the 4,096 the cache holds), over 10,000 of them 231 ms against 221, medians 203 against 201; an object proof a third more, a name proof five times as much (1.78 ms per hundred against 0.36 ms, about twenty nodes read from LMDB); dropping the trees 0.6 ms, rebuilding them 368 ms (0.3 and 63 ms in the secp256k1 run), rebuilding every index tree 295 ms over LMDB. On the whole state, with everything dropped the database runs on 57% of the heap it holds resident with a full history window (40 to 50% in an earlier build's run on a state with no history yet) and commits blocks of random transfers at the rate it has resident or above it (docs/benchmarks.md section 4.13), now that the dropped trees' cache holds 4,096 chunks; with 256 it ran at 7.7 blocks a second against 9.4, a root reading from LMDB at every block the chunks the cache did not hold ([chapter 8](08-node.md) has the guard's side).

### Indices as ordered byte keys

A primary index is the table of arena references of the arena section above, indexed by instance. A secondary index ("accounts by name", "balances by owner and asset") is a key encoder plus one ordered map from byte strings to ids. The rule that makes every index the same shape, from `src/db/keys.ts`: a key is a byte string whose lexicographic order is the order you want to scan in. Integers are written big-endian so they sort numerically; strings end with a zero byte instead of carrying a length prefix, so `"ab"` sorts before `"abc"`, and a prefix scan on the bytes of `ab` without the terminator finds both, while the key `str("ab")` builds, terminator included, is a prefix of the entry for `"ab"` alone; a compound key is the parts written one after another.

Worked examples, using the codec's big-endian integers:

- `k.str('alice')` produces `61 6c 69 63 65 00` (six bytes: the UTF-8 text and a terminator).
- `k.id(owner).id(asset)` produces sixteen bytes: two big-endian u64 ids. The application's `byOwnerAsset` balance index uses exactly this (`test/app.test.ts` looks a balance up with `key((k) => k.id(aliceId).id(app.coreAsset))`).
- A non-unique index appends the object's own id to the key. The test type in `test/db.test.ts` has `byGroup` keyed by a u32 group; its stored keys are 4 bytes of group followed by 8 bytes of id, so every entry is distinct and all entries of one group are adjacent. "Everything in group 1" is then a prefix scan on the 4-byte prefix, and the results come out in id order within the group.

A unique index maps a key to one id and refuses a second object with the same key. A non-unique index is a prefix scan. Both are derived data: the store keeps their entries beside the objects and a restart reads them back from there (a store written before phase two of STATE-PAGING.md has none, and the indices are then rebuilt from the objects as they always were), and they are not hashed. The exception is an index marked authenticated, covered below.

### The B+ tree

The ordered map behind every secondary index (and behind the in-memory key-value store of [chapter 10](10-store.md)) is a B+ tree, in `src/db/bptree.ts`. A B+ tree is a search tree where every node holds a sorted array of keys and either values (in a leaf) or child pointers (in an inner node), with a bounded number of entries per node called the fan-out. Lookups binary-search one node per level; inserts splice into one sorted array and, if the node overflows, split it in two and push one separator key up. The depth is logarithmic in the number of keys with a large base, so it is small: the file's header puts a million keys at four levels with fan-out 32.

Why fan-out 32: DESIGN.md section 6 calls it "the tm2 shape, without its copy-on-write persistence", that is, the B+ tree store of tm2/gno. The point of a moderate fan-out in memory is that a node's key array is small enough that `splice` on it is a handful of moves, while a single sorted array over all keys would move its whole tail on every insert in the middle. Two further choices from the header comment: leaves carry no sibling pointers, so iteration keeps a stack of (inner node, child index) and removing a leaf stays local; and deletion merges an underfull node with a neighbour only when both fit in one node, and never borrows single entries, so fill can degrade under adversarial patterns but correctness and logarithmic depth do not.

Worked example of a split. A leaf holds 32 keys and receives a 33rd. If the new key landed in the middle, the leaf keeps the first 16 and a new right leaf takes the other 17; the right leaf's first key goes up as a separator. If the new key landed at the end, which is what happens when keys arrive in order (ids, timestamps), the leaf keeps 31 and only the last two move, so sequential inserts leave nearly full leaves behind instead of half-full ones. An inner node with 33 children splits into 16 and 17 children, and its 16th separator is promoted rather than copied.

### Authenticated data structures and Merkle trees

A hash function such as SHA-256 maps any input to 32 bytes such that nobody can find two inputs with the same output. A Merkle tree uses that to commit to a whole collection with one hash: each leaf is the hash of one item, each inner node is the hash of its two children, and the root is the commitment. The root changes if any item changes. That is what makes it an authenticated data structure: a party that trusts the root (here, a light client that verified a signed block header carrying the app hash) can be convinced of the contents of one item by someone who holds the whole tree, without trusting them.

An inclusion proof for leaf i is the list of sibling hashes along the path from that leaf to the root. The verifier recomputes the leaf hash from the claimed item, folds it upward with each sibling (the bits of i say whether the leaf's node is the left or right child at each level), and compares the result with the root it trusts. If a single byte of the item or the path were different, the recomputed root would differ. A proof is small: its length is the height of the tree, so README.md measures an object proof at 777 bytes on a small state and 3.4 KiB on the gigabyte state, where the difference is the object's own encoding (two ML-DSA keys), not the path.

An absence proof shows that a position holds nothing. In this database that takes one of two shapes, both from `src/db/proof.ts`: a slot whose instance number is at or past the type's counter was never created, and since the counter itself is hashed into the type's leaf no path is needed; a slot below the counter that was removed holds the empty hash, and its proof is an ordinary path ending in that empty hash.

Worked example of a leaf hash, following `leafHash` in `src/db/merkle.ts`:

```
leaf = SHA256( 0x00 || varint(len key) || key || varint(32) || SHA256(value) )
```

For an object, the key is the 8-byte id and the value is the object's canonical encoding. With an 8-byte key, `varint(8)` is the single byte `0x08` and `varint(32)` is `0x20`, so the preimage is 1 + 1 + 8 + 1 + 32 = 43 bytes: the prefix, the key length, the key, the length of the value hash, and the value hash. For a type leaf the key is the 2-byte type id (`varint(2)` is `0x02`) and the value is the counter, the type root and the index roots. The value is prehashed so a leaf preimage has a fixed, small size whatever the object is.

### Domain separation and the ICS23 conventions

The three kinds of node are hashed under different first bytes:

```
leaf   = H(0x00 || varint(len key) || key || varint(32) || H(value))
inner  = H(0x01 || left || right)
empty  = H(0x02), and two empty children hash to empty
```

The prefixes are domain separation. Without them an attacker could present a leaf's preimage as if it were an inner node (or the reverse) and build a path that folds to a genuine root while claiming a different item; with them, the byte that opens the preimage fixes what kind of node it is, and a 65-byte inner preimage (the prefix byte and two 32-byte hashes) cannot be read as a leaf preimage. The review in REVIEW-2026-10-28.md lists "domain-separated Merkle hashing" among the strongest parts of the code base.

The exact shapes are not invented here. They follow ICS23, the proof specification of the Cosmos inter-blockchain protocol, as used by the tm2 B+ tree: `LeafOp` with prefix `0x00`, the key unhashed (`PrehashKey NO_HASH`), the value prehashed with SHA-256 (`PrehashValue SHA256`), and protobuf varint lengths (`Length VAR_PROTO`); `InnerSpec` with child order `[0, 1]`, child size 32, prefix `0x01`, and `EmptyChild = SHA256(0x02)`. DESIGN.md section 6 spells this out so that a standard ICS23 verifier configured with this spec accepts both legs of a proof; the verifier in `src/db/proof.ts` is a direct implementation of the same rules. RPC-SYNC-PROOFS.md keeps proofs ICS23-shaped on purpose, for cross-chain connections later. The empty rule (two empties hash to empty) is what lets an empty subtree of any height be one value, so padding at every level is the single `EmptyChild` constant.

### The dense tree and the two-level state root

Because instances are allocated 0, 1, 2, ..., the tree over a type's objects is a complete binary tree whose shape depends only on the leaf count: leaf i is the object with instance i, the right side is padded with the empty hash, and node (k, j) at level k always covers leaves [j·2^k, (j+1)·2^k). Growth never moves a node; when the count crosses a power of two the root climbs one level.

Worked example with five objects. `heightFor(5)` is 3 because 2^3 = 8 is the first power of two at or above 5.

```
level 3:  root = H(0x01 || n(2,0) || n(2,1))
level 2:  n(2,0) = H(0x01 || n(1,0) || n(1,1))      n(2,1) = H(0x01 || n(1,2) || EMPTY)
level 1:  n(1,0) = H(L0,L1)   n(1,1) = H(L2,L3)   n(1,2) = H(L4,EMPTY)   n(1,3) = EMPTY
level 0:  L0  L1  L2  L3  L4  EMPTY  EMPTY  EMPTY
```

The inclusion path for leaf 2 is `[L3, n(1,0), n(2,1)]`: at level 0 index 2 is even so its sibling is on the right (L3); at level 1 the node's index is 1, odd, so the sibling is on the left (n(1,0)); at level 2 index 0 is even, sibling on the right (n(2,1)). `rootFromPath(L2, 2, path)` folds exactly that way. If instance 1 is later removed, L1 becomes `EMPTY`, n(1,0) becomes `H(0x01 || L0 || EMPTY)`, and the absence proof for instance 1 is the path from that empty leaf. When a sixth object arrives nothing above moves: L5 is set, n(1,2) and n(2,1) and the root are recomputed, and the other nodes are untouched. When the ninth arrives the height becomes 4 and the old root becomes n(3,0), the left child of a new root.

Above the types sits one more dense tree over the type leaves in type-id order. A type leaf commits to the counter, the type root and the authenticated index roots:

```
leaf(id, value)            --typeSiblings-->  typeRoot
leaf(type, nextInstance || typeRoot || indexRoots)  --topSiblings-->  appHash
```

The app hash is the root of the top tree. A proof about an object therefore has two legs, each an ICS23 existence proof under the one spec. A consequence `test/app.test.ts` demonstrates: a proof for alice's account made at height 2 fails at height 3 even though her account did not change, because the balance and dynamic types changed their leaves and with them the top tree's nodes on alice's path.

Storage is per level in chunks of 1,024 hashes, allocated when a node in the chunk is first set and released when its last node becomes empty, so memory follows the live objects rather than the counter: a type whose objects come and go, like recent transaction ids, costs only its live window (DESIGN.md section 6). Changed objects are remembered and their paths recomputed in one pass at the end of each block, shared ancestors once; README.md measures a root after 1,000 changed objects at 20 ms.

### The sparse Merkle tree for proofs by key

The dense tree proves things about ids. Users ask about names: "is there an account called alice", "what id does the symbol CORE have". An index can be marked `authenticated`, and such an index keeps a second structure beside its B+ tree: a sparse Merkle tree over `sha256(key)`, in `src/db/smt.ts`. Its root goes into the type leaf after the counter and the type root, so a proof by key is a sparse-tree path to one of those roots followed by the same type leg. For a non-unique index the key in the tree is the entry's key, the index key followed by the object's id, and the value is that id, as for a unique one: what is proven is that one object is under one key, or is not. That a list of objects under a key is complete cannot be proven this way.

Why not hash the B+ tree itself, which would avoid a second structure: the header of `src/db/smt.ts` answers that its root would depend on node layout, which depends on the order of inserts and deletes, and a node that restarts rebuilds its indices from the objects in id order. Two nodes with the same key set but different histories would disagree on the root. A sparse tree keyed by the hash of the key has one shape per key set, so any node, after any history, hashes identically. That property is also what lets a dropped tree apply its pending writes to the store in any order, and what lets past index versions be rebuilt from the object history after a restart: the store keeps the current tree's nodes since phase four of STATE-PAGING.md and a restart loads them and takes the versions inside the window from the history records, replaying them from the objects only when a record came without its sparse tree nodes. DESIGN.md section 6 draws the line the same way: the B+ trees are not part of the root, and the unique indices that need proofs are authenticated by sparse Merkle trees whose roots are in the type leg.

A sparse Merkle tree in its textbook form is a binary tree of depth 256 where the bits of the hashed key choose left or right at each level and almost every subtree is empty. The compacted form used here is the Jellyfish shape (from the Jellyfish Merkle tree of the Diem project): every leaf sits at the first depth where its key prefix is unique, inner nodes exist only where two keys share a prefix, and an empty child is the `EMPTY` hash. Keys are hashed so the tree stays balanced whatever names users pick, and so ICS23's SMT spec (`PrehashKey SHA256`) applies.

Worked example. Three keys whose hashes begin with the bits `00`, `01` and `1`, called k1, k2 and k3. After k1 the tree is one leaf. Inserting k2 finds a leaf with a different key at the root; the two agree on bit 0 and differ on bit 1, so both are pushed to depth 2 under an inner node at depth 1, which hangs as the left child of a new root whose right child is empty. Inserting k3 goes right at bit 0 into the empty slot and becomes a leaf at depth 1:

```
root = inner( inner( leaf k1, leaf k2 ), leaf k3 )
```

The membership proof for k2 is the siblings down its path, `[hash(leaf k3), hash(leaf k1)]`, and its own leaf. A query for an absent key whose hash begins with `1` walks right and ends on k3's leaf: the proof is `[hash(inner(k1, k2))]` with k3's leaf, and the verifier accepts it as absence because k3 shares the one bit of path that was walked and therefore owns that whole subtree. If k3 is then removed, the root's right child becomes empty and the same query ends on an empty slot: siblings `[hash(inner(k1, k2))]`, leaf null. Either way the fold reaches the root only if the claimed shape is the real one.

A proof is thus the sibling hashes down the key's path plus what sits at the end of the walk: the key's own leaf (membership), nothing (absence through an empty slot), or another key's leaf that shares the prefix (absence, because that leaf owns the whole subtree and the key would have been pushed below it if present). The value stored in a leaf is the 8-byte id of the object that owns the key.

### Undo sessions and the committed view

Writes go through `create`, `modify` and `remove`. An undo session, Graphene style, records what each write replaced so that everything since the session started can be reverted. Sessions nest, and nesting matters because blocks contain transactions: the application runs each transaction in its own session and undoes it if the transaction fails, inside a block that must either apply fully or be replayed; and the mempool's speculative state is one long-lived session that is undone before every block and rebuilt by re-checking the pending transactions. A block is final, so nothing undoes a block that applied; but the application does bracket each block in a session of its own while it is being applied, committed just before the root is taken, so that a failure half way through (a signature verifier that went away) leaves the database as the previous block left it and the block can be applied again from scratch.

Beside the sessions the database keeps a committed view: the state as of the last root, which is what queries and proofs must return while the mempool session is open. `getCommitted` answers from the record the database keeps of every object written since the last root, the value it had at that root (the root shadow, which `root()` also compares with to tell what changed), so it returns the committed value whether the write was made in an open session, in one closed since, or outside any. The dense trees are never touched by a write; only `root()` hashes them, and it must be called with every session closed, so they always reflect the last committed state. The sparse tree of an authenticated index is handled differently: while it is resident, each write inserts or removes its key at once (`indexKeys` and `unindex` in `src/db/index.ts`) and hashes the new nodes on that path, and while it is dropped the write is only noted and applied at the commit. Either way a proof reads the version that `root()` committed last, which a write does not move. Nothing speculative is ever written to disk: the pending session is undone before the block runs (DESIGN.md section 6, "Persistence and recovery").

### Versions, history and the retention window

`root(version)` is called once per block with the height as the version. A node must answer "prove object X as of height h" for some window of recent heights, because a light client verifies a proof against the header that committed to that state (header h+1, since the app hash is deferred by one block; see DESIGN.md section 6, "Deferred execution caveat"). Cosmos does this with IAVL, a versioned AVL tree where every version keeps its own nodes. Here, because node positions never change, the same thing reduces to an undo log: with a retention window (default 100 heights), every overwritten node hash is remembered as "before version v it was x", every overwritten object as "before v its encoding was b", and every moved counter likewise. A read at an older version goes through those records, and records that only serve versions older than the window are dropped after each root. RPC-SYNC-PROOFS.md section 4.7 suggests windows per role: 100 for a validator, 10,000 for a query node. The objects' history is kept as bytes, so the window costs what it stores, and a read at an older version decodes the one value it asks for.

What one version's history record holds, following `HistoryRecord` in `src/db/database.ts`. Suppose at version 5 the application created item 7.5 and modified item 7.2, in a database whose types are 3 and 7 (so type 7 is leaf 1 of the top tree), and the item tree had five leaves before:

```
trees:
  { tree: 7, records: { sizeBefore: 5,          // the item tree had 5 leaves before v5
      nodes: [ [0, 2, old L2], [0, 5, EMPTY],   // leaf 5 was empty before v5
               [1, 1, old n(1,1)], [1, 2, old n(1,2)],
               [2, 0, old n(2,0)], [2, 1, old n(2,1)],
               [3, 0, old root of the item tree] ] } }
  { tree: 0, records: { sizeBefore: null,       // TOP_TREE: the type leaf of type 7 and the node above it
      nodes: [ [0, 1, old type leaf], [1, 0, old app hash] ] } }
objects:
  [ [7.2, <encoding of item 7.2 before v5>], [7.5, null] ]   // null: it did not exist before v5
counters:
  [ [7, 5] ]                                                 // before v5 the item counter was 5
nodes:
  [ [<store key of byName's root node>, <its encoding before v5>],
    [<store key of a node on the new name's path>, null], ... ]   // null: no node there before v5
```

Every node on the two changed paths is listed, because every one of them was overwritten. The last section, `nodes`, does the same for the sparse trees of the type's authenticated indices: for each node a commit changed, its store key (which is its position, the tree and the path from the root) and its encoding before, or null where there was none. The store writes that record next to the block's changes and reads it back on restart, so the whole window is provable again after a restart. Each database and each tree also has a floor: the oldest version it can describe, set to the version of the first root (where it was built) and lowered as history is loaded. A fresh node, or a node that joined by state sync, is provable only from the height it started at. The window in memory can also be made narrower than the one the database records. From the memory guard's `warn` level on the node cuts it to two past versions with `setHistoryWindow` ([chapter 8](08-node.md)), so that the current version and the two before it stay: everything older is forgotten at once, in the value history and in every tree, and the floor rises to the oldest version kept. Nothing a block does reads a past version, so only proofs and queries at the forgotten heights notice. Each root still produces its full history record and the store keeps the whole configured window, so a restart has it back; in the running database what was forgotten stays forgotten, and when the window is widened again it grows back one version per root.

What happens to a read at a forgotten height depends on whether the database was given the store's records. Without them it is refused, as any height before the floor is. With a history store (the option `historyStore`, a function from a version to its encoded history record, which the application passes) the database reads the version from the records instead. The records are an undo log, so the rule is the one the window in memory follows: to know what an entry (an object, a counter, a tree node) was at version h, look through the records of versions h+1, h+2 and so on up to the current one; the first that names the entry holds its value before that version, which is its value at h; and if none names it, it has not changed since h and its current value is right. A proof needs a few dozen entries, so the database names them first and then scans the records for just those, without decoding a record whole and without keeping anything afterwards. Such a read is slower than one from the window in memory and costs no memory, which is the trade the trimmed window is for. The oldest version that can be asked for is then the oldest the store's records reach, and trimming the window does not move it. The section on `src/db/database.ts` walks through `past()` and `scanHistory`, which do this. README.md measures the memory side of the window from above: the heap in use grew by 209 MiB over 8 blocks of 2,400 scattered transfers each on the gigabyte state, which is the process's heap-used difference across the blocks and not an isolated measure of the version history.

Snapshots are the other export. `encodeSnapshot` writes every object's bytes in id order, straight from the arena, plus the counters, deterministically, so two nodes at the same height produce identical bytes; the state-sync snapshot in `src/app/core/snapshot.ts` goes further and ships chunks with range proofs, which `rangeProofAt` produces.

### Worked example: verifying an object proof

Take `verifyObjectProof(appHash, p)` from `src/db/proof.ts`, with p the proof for id 7.2 at a height where type 7 has 5 objects and the database has two types.

1. Split the id: type 7, instance 2. Read the counter from the proof: `count = 5`.
2. Instance 2 is below the counter, so the proof must carry a path. Check `typeSiblings.length === heightFor(5) === 3`.
3. Recompute the leaf: `value` is not null, so `leaf = leafHash(idKey(7.2), value)`. (For a removed object `value` is null and the leaf is `EMPTY`.)
4. Fold: `rootFromPath(leaf, 2, typeSiblings)` gives a candidate type root. Compare with `p.typeRoot`; stop if different.
5. The type leg: build the type leaf `leafHash(typeKey(7), typeValue(5n, typeRoot, indexRoots))`, check `typeIndex < typeCount` and `topSiblings.length === heightFor(typeCount)`, fold with `rootFromPath(typeLeaf, typeIndex, topSiblings)`, and compare with the app hash.

If the instance were 5 or more, step 2 instead requires `value === null` and an empty `typeSiblings`, and the type root is taken from the proof as given: the type leg then vouches for the counter, and the counter rules the instance out. `test/db.test.ts` checks that raising the counter in such a proof to 6 makes it fail, because the type leaf no longer matches.

### Worked example: verifying a key proof

`verifyKeyProof(appHash, p)` for the name "alice" in the account type's `byName` index:

1. `smtProofRoot(p.key, p.proof)`: hash the key, `keyHash = sha256("alice\0")`. If `p.proof.leaf` is null, start from `EMPTY`. If the leaf's `keyHash` equals ours, start from `leafHash(keyHash, leaf.value)` and remember `leaf.value` as the answer. Otherwise the leaf belongs to another key: check that its hash agrees with ours on the first `siblings.length` bits (else the proof is malformed), start from that leaf's hash, and the answer is "absent".
2. Fold upward from the deepest sibling to the root: at depth d, if bit d of our key hash is 1 we were the right child, so `innerHash(sibling, cur)`; else `innerHash(cur, sibling)`.
3. Compare the folded root with `p.indexRoots[p.indexPosition]`.
4. Run the same type leg as for an object proof, with the index roots array hashed into the type leaf.
5. Return the value (the 8-byte id), null for absence, or undefined if any step failed.

The three outcomes are deliberately distinct so a caller cannot confuse "proven absent" with "the proof is bad". `test/app.test.ts` shows that changing the key of a membership proof can at most yield null or undefined, never a value, and that swapping the leaf's value for another account's id is rejected as undefined.

## The code, file by file

### src/db/id.ts

Purpose: object identity and its packing into a u64.

Exports:

- `MAX_TYPE = 0xffff`, `INSTANCE_BITS = 48n`, `MAX_INSTANCE = 2 ** 48 - 1`: the layout constants.
- `type ObjectId = bigint`: an id is a `bigint`, which the codec writes as a u64 and a `Map` can use as a key.
- `objectId(type, instance)`: packs the pair, throwing `RangeError` if either half is not an integer in range.
- `typeOf(id)`, `instanceOf(id)`: the two halves back. `instanceOf` returns a plain number, exact because instances are below 2^48.
- `idToString(id)` / `idFromString(s)`: the `type.n` text form, used by the RPC and the genesis JSON. `idFromString` accepts only `^(\d+)\.(\d+)$` and goes through `objectId`, so the range checks apply.

```ts
export function objectId(type: number, instance: number): ObjectId {
  if (!Number.isInteger(type) || type < 0 || type > MAX_TYPE) throw new RangeError(`bad object type ${type}`);
  if (!Number.isInteger(instance) || instance < 0 || instance > MAX_INSTANCE) throw new RangeError(`bad instance ${instance}`);
  return (BigInt(type) << INSTANCE_BITS) | BigInt(instance);
}

export function typeOf(id: ObjectId): number {
  return Number(id >> INSTANCE_BITS);
}

/** Instances are below 2^48, so a plain number is exact. An index's arrays hold fewer: MAX_INSTANCE in index.ts (2^32 - 2). */
export function instanceOf(id: ObjectId): number {
  return Number(id & INSTANCE_MASK);
}
```

Notice that `objectId` accepts type 0, while `ObjectType.id` in `src/db/index.ts` is documented as `1..65535` and `TOP_TREE = 0` in `src/db/database.ts` uses 0 to label the top tree in history records and chunk keys. The check is not made here: the `ObjectDatabase` constructor refuses to register a type with id 0 (under `src/db/database.ts` below), and the core application's types start at 1.

### src/db/keys.ts

Purpose: the key encoding rules for secondary indices, as a small builder over the codec's `Writer`.

Exports:

- `class KeyWriter`: chainable `u8`, `u16`, `u32`, `u64`, `id` (a u64), `fixed` (raw bytes) and `str`, then `finish()` for the bytes. The writer starts with a 32-byte buffer, enough for most keys.
- `key(f)`: build a key in one expression.
- `startsWith(b, prefix)`: byte prefix test, used by the B+ tree's `scan`.

```ts
export function key(f: (k: KeyWriter) => void): Uint8Array {
  const k = new KeyWriter();
  f(k);
  return k.finish();
}
```

The one rule with a failure mode is `str`:

```ts
  str(s: string): this {
    const b = new TextEncoder().encode(s);
    for (const x of b) if (x === 0) throw new RangeError('index key strings cannot contain a zero byte');
    this.w.fixed(b).u8(0);
    return this;
  }
```

A zero byte inside a string would make `"a\0b"` and `"a"` followed by more key ambiguous, so it is rejected rather than escaped. The error is a `RangeError`, not a `DbError`, because the application validates names before they reach an index; a zero byte here is a programming error. The header comment names `bptree.ts` as the one ordered map every index lives in, whatever its shape.

### src/db/bptree.ts

Purpose: the ordered byte-keyed map behind every secondary index and the in-memory key-value store.

Exports:

- `FANOUT = 32`. The private `MIN_FILL` is half of it.
- `class BPlusTree<V>` with `size`, `get(k)`, `has(k)`, `set(k, v)`, `delete(k)`, `entriesFrom(start)`, `scanFrom(start)`, `scan(prefix)` and `clear()`.

Nodes are plain objects: a leaf has parallel `keys` and `values` arrays; an inner node has `keys` (separators) and `children`, with `keys.length === children.length - 1` and child i covering keys in `[separator i-1, separator i)`. Two binary searches do all the work, and the difference between them is the whole point of separators:

```ts
/** First index with keys[i] >= k. */
function lowerBound(keys: Uint8Array[], k: Uint8Array): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(keys[mid]!, k) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the child that covers k: the number of separators <= k. */
function childIndex<V>(n: InnerNode<V>, k: Uint8Array): number {
```

`lowerBound` finds where a key is or would be in a leaf; `childIndex` counts separators `<= k`, so a key equal to a separator goes right, matching the half-open interval each child covers. Both compare with `compareBytes` from `src/crypto/hash.ts`, a memcmp-style comparison where a shorter prefix sorts first, which is exactly the order `src/db/keys.ts` promises.

`set` inserts or replaces, and handles the split by recursion: `insert` returns the new right sibling and the first key it covers when a node overflows past `FANOUT`, and the parent splices them in; if the root itself splits, a new root is made with one separator.

```ts
      n.keys.splice(i, 0, k);
      n.values.splice(i, 0, v);
      this.count++;
      if (n.keys.length <= FANOUT) return null;
      // Appending in key order (the common case for ids and timestamps) keeps the left leaf full.
      const mid = i === n.keys.length - 1 ? n.keys.length - 2 : n.keys.length >> 1;
      const right: LeafNode<V> = { leaf: true, keys: n.keys.splice(mid), values: n.values.splice(mid) };
      return { key: right.keys[0]!, node: right };
```

When the new key landed at the end, `mid` is 31 of 33 and only the last two keys move to the new leaf. An inner split promotes the middle separator and trims the left node's key array to `mid - 1` keys for `mid` children:

```ts
    const mid = n.children.length >> 1;
    const promoted = n.keys[mid - 1]!;
    const right: InnerNode<V> = { leaf: false, keys: n.keys.splice(mid), children: n.children.splice(mid) };
    n.keys.length = mid - 1;
    return { key: promoted, node: right };
```

`delete` removes from the leaf and then `rebalance`s on the way up:

```ts
  private rebalance(n: InnerNode<V>, ci: number): void {
    const child = n.children[ci]!;
    const fill = BPlusTree.fill(child);
    if (fill >= MIN_FILL) return;
    if (fill === 0 && n.children.length > 1) {
      n.children.splice(ci, 1);
      n.keys.splice(ci > 0 ? ci - 1 : 0, 1);
      return;
    }
    if (ci + 1 < n.children.length && this.merge(n, ci)) return;
    if (ci > 0) this.merge(n, ci - 1);
  }
```

A child that became empty is dropped with the separator before it (or the first separator if it was child 0); an underfull child is merged with its right neighbour if both fit in one node, else with its left; `merge` refuses to combine a leaf with an inner node, which cannot happen in a balanced tree. If the root ends with one child, that child becomes the root. The test in `test/db.test.ts` drives all of this through 60,000 random operations against a reference `Map`, including deleting down to empty.

Iteration avoids leaf links. `entriesFrom` descends with a stack of `(inner node, child index)`, yields the leaf from `lowerBound(start)`, then climbs to the first ancestor with a next child and descends to its leftmost leaf:

```ts
      leaf = null;
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        if (frame[1] + 1 < frame[0].children.length) {
          frame[1]++;
          let d: BNode<V> = frame[0].children[frame[1]]!;
          while (!d.leaf) {
            stack.push([d, 0]);
            d = d.children[0]!;
          }
          leaf = d;
          i = 0;
          break;
        }
        stack.pop();
      }
```

`scan(prefix)` is `entriesFrom(prefix)` stopped at the first key that does not start with the prefix; an empty prefix scans everything. `scanFrom(start)` is `entriesFrom` under a name that says what it is for: every entry whose key is at or after `start`, with no prefix test, which is how a listing resumes from a cursor. A page of accounts ends with the last name it returned; the next request seeks to that name in one descent and skips it, instead of scanning the whole index from the beginning and counting past what was already served. Iteration is a generator over live nodes, so mutating the tree while iterating is not supported; callers that need to change things while scanning collect first (`range` in `src/db/database.ts` returns an array).

Failure modes: `has` is `get(k) !== undefined`, so a stored value of `undefined` would read as absent; values here are ids and byte arrays, never undefined. There is no key-length limit and keys are stored by reference, so a caller that mutates a key array after `set` corrupts the order; the key-value store copies keys for that reason.

### src/db/indexstore.ts

Purpose: the secondary indices' disk form and the merged cursor the fallback reads through (STATE-PAGING.md section 4). The database never writes the store; this file defines what it reads.

Exports:

- `interface IndexStore { get(key); range(start, end) }`: what the database needs of the store that holds the entries, point reads and ascending ranges over `start <= key < end`. The application's `KvStore` of [chapter 10](10-store.md) satisfies it as it stands, and `src/db/merkle.ts` names the same shape `TreeSource` for the trees.
- `interface IndexEntryChange { key; value | null }`: one entry a root added (with its value) or removed (null).
- `INDEX_PREFIX = 0x69` (`'i'`), `INDEX_HEADER = 4` and `EMPTY_VALUE`: the prefix byte, the bytes in front of an index key, and a non-unique entry's value, which is nothing, the id being the last eight bytes of its key.
- `indexHeader(type, position)`, `entryKey(header, k)` and `afterPrefix(prefix)`: the key helpers.
- `overlaid(base, over)` and `until(entries, end)`: the merge, and a bound on an ordered map's entries.
- `class MemoryIndexStore implements IndexStore`: an index store in memory, for a database with no application store behind it.

```ts
/** The header every entry of one index starts with. */
export function indexHeader(type: number, position: number): Uint8Array {
  return Uint8Array.of(INDEX_PREFIX, type >> 8, type & 0xff, position);
}

/** The store key of an index entry: the header, then the index key. */
export function entryKey(header: Uint8Array, k: Uint8Array): Uint8Array {
  const out = new Uint8Array(header.length + k.length);
  out.set(header);
  out.set(k, header.length);
  return out;
}
```

A type's index at position p has every entry under the four bytes `'i'`, type, p, and `afterPrefix` of those bytes is the end of its range (it is `prefixEnd` from chapter 10 under another name, returning null for a prefix of nothing but `0xff` bytes instead of throwing). The merge is the one piece of logic in the file:

```ts
/**
 * Lay `over` on top of `base`, both ascending by key: an overlay entry replaces the base's entry at the same key,
 * a null one hides it, and everything else of both comes through in order. This is the cache-KV iterator of the
 * Cosmos SDK: one step of each cursor at a time, nothing materialised.
 */
export function* overlaid<V>(base: Iterator<[Uint8Array, V]>, over: Iterator<[Uint8Array, V | null]>): IterableIterator<[Uint8Array, V]> {
  let b = base.next();
  let o = over.next();
  try {
    while (!b.done || !o.done) {
      const c = b.done ? 1 : o.done ? -1 : compareBytes(b.value[0], o.value[0]);
      if (c < 0) {
        yield b.value as [Uint8Array, V];
        b = base.next();
        continue;
      }
      const [k, v] = o.value as [Uint8Array, V | null];
      if (v !== null) yield [k, v];
      if (c === 0) b = base.next();
      o = over.next();
    }
  } finally {
    // A caller that stops early (a page of results) closes the store's cursor too.
    if (!b.done) base.return?.();
    if (!o.done) over.return?.();
  }
}
```

Both inputs are ascending by key. At each step the smaller key wins: a base entry below the overlay's next key comes through; an overlay entry at or below the base's key replaces the base's entry at the same key, or hides it when its value is null, and when the keys are equal both cursors advance. Nothing is collected, so a caller that reads a page and stops costs a page, and the `finally` clause closes whichever cursor is still open, which for an LMDB range is what releases its read transaction. The database stacks the function: the store under the unwritten roots' changes, and that under an index's overlay. `MemoryIndexStore` is a `BPlusTree<Uint8Array>` with `apply(changes)` on top: it exists only while some tree is dropped on a database that was given no store (tests, benchmarks, a snapshot being imported), holding the entries as of the last root, and goes when every tree is resident again.

### src/db/merkle.ts

Purpose: the dense Merkle tree with chunked storage and a version history, and the hashing conventions shared by every tree in the node. `src/types/txproof.ts` reuses `DenseMerkleTree`, `leafHash` and `rootFromPath` for the block's data hash and results hash, so the conventions here are the chain's conventions.

Exports:

- `EMPTY`: `sha256(0x02)`, the hash of an empty slot and of an empty subtree of any height. `isEmpty(h)` compares against it.
- `MAX_HEIGHT = 48`: the largest height a type tree could reach with 48-bit instances. It is exported but not referenced anywhere else in `src/` or `test/`.
- `innerHash(left, right)`: `EMPTY` if both children are empty, else `sha256(0x01 || left || right)`.
- `varint(n)`: the protobuf varint, as ICS23's `VAR_PROTO` length op expects.
- `leafHash(key, value)`: the ICS23 `LeafOp`.
- `heightFor(leaves)`: 0 for one leaf, else the smallest h with `2^h >= leaves`. `heightFor(0)` is also 0.
- `rootFromRange(leaves, from, count, siblings)`: folds a contiguous run of leaf hashes to the root of a tree with `count` leaves; null if the proof does not fit. The verifier side of range proofs for snapshot chunks.
- `rootFromPath(leaf, index, siblings)`: the inclusion-proof fold.
- `interface TreeRecords { nodes: [level, index, hash][]; sizeBefore: number | null }`: what one `root()` recorded.
- `interface PastTree { size: number | null; nodes: Map<position, hash> }` and `nodePosition(level, index)`: what the store's history records say of a tree at a version the window in memory no longer holds, and the number a node goes by in it.
- `CHUNK_PREFIX = 0x74` (`'t'`), `chunkKey(tree, level, chunk)` and `treePrefix(tree)`: a chunk's store key and the prefix every chunk key of one tree starts with (STATE-PAGING.md section 5).
- `interface TreeSource { get; range }` and `interface StoreChange { key; value | null }`: what a dropped tree reads (the same shape as `IndexStore`), and one key a root wrote or deleted, for the store.
- `class ChunkCache`: the chunks dropped trees have read, least recently used first, bounded by a count and shared by a database's trees, with `hits` and `misses` counted.
- `class DenseMerkleTree`, which besides the hashing and the versions below has `id` (which tree it is in the store), `reporting`, `takeChunks()`, `release()`, `resident`, `drop(source, cache)`, `rebuild()`, `load(source)`, `verify()`, `entries()`, and `pastPositions(leaf?)` and `pastRangePositions(from, to)` for reads from the store's records; and the getters `leafCount`, `height`, `currentVersion`, `lowestVersion`, `historyEntries` and `chunkCount` (the chunks allocated across all levels, for tests and diagnostics).

The two hashing functions, copied exactly:

```ts
export function innerHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (isEmpty(left) && isEmpty(right)) return EMPTY;
  return sha256(INNER_PREFIX, left, right);
}
```

```ts
/** ICS23 LeafOp: prefix 0x00, key unhashed, value prehashed with sha256, varint lengths. */
export function leafHash(key: Uint8Array, value: Uint8Array): Uint8Array {
  return sha256(LEAF_PREFIX, varint(key.length), key, varint(HASH_SIZE), sha256(value));
}
```

`rootFromPath` is four lines and is the heart of every verifier:

```ts
export function rootFromPath(leaf: Uint8Array, index: number, siblings: Uint8Array[]): Uint8Array {
  let cur = leaf;
  let j = index;
  for (const sib of siblings) {
    cur = j % 2 === 0 ? innerHash(cur, sib) : innerHash(sib, cur);
    j = Math.floor(j / 2);
  }
  return cur;
}
```

`rootFromRange` folds a run `[from, from + leaves.length)` level by level. At each level the run is widened to even boundaries with siblings from the proof: a left neighbour if it starts on an odd index, a right neighbour if it ends on an even one, in that order, which is the order `rangeProofAt` emits them; then adjacent pairs are hashed and the indices halve. It returns null if a sibling is missing, left over, or the run does not fit in `count`; with `count === 0` only an empty run with no siblings is accepted and its root is `EMPTY`. A snapshot chunk of 2,000 objects (the application's default) therefore costs at most two siblings per level, about the same as one inclusion proof.

**Storage.** `levels[k]` maps a chunk index to a buffer of 1,024 node hashes (32 KiB), and `counts[k]` keeps the number of non-empty nodes per chunk so that a chunk whose last node becomes empty is released. A node's chunk is `Math.floor(j / CHUNK)` and its offset in the chunk is `j % CHUNK`, written as arithmetic rather than as `j >> CHUNK_BITS` and `j & (CHUNK - 1)` on purpose: JavaScript's bitwise operators work on 32-bit signed integers, so a shift would turn a leaf index at or above 2^31 into a negative chunk number and silently address the wrong node, while division and remainder are exact for every integer an instance can be. `rawNode(k, j)` reads a node or returns `EMPTY` if its chunk is absent; `node(k, j)` additionally returns `EMPTY` for any index at or past `nodesAt(k) = ceil(size / 2^k)`, so stale data cannot leak past the populated range. `writeNode` is the only writer:

```ts
  private writeNode(k: number, j: number, h: Uint8Array): void {
    const old = this.rawNode(k, j);
    if (bytesEqual(old, h)) return;
    if (this.retain > 0 && this.version >= 0) this.record(k, j, old.slice());
```

It records the old hash for the history before overwriting and, in a resident tree, allocates a chunk pre-filled with `EMPTY` on first use, counts non-empty nodes in and out, and frees the chunk when the count drops to zero; what it does in a dropped tree is under "Chunks on disk" below. The `old.slice()` matters: `rawNode` returns a view into the chunk, and the view would change under the history entry when the chunk is overwritten. A chunk read from the store ends at its last non-empty slot, so `rawNode` treats an offset past a chunk's end as `EMPTY`.

**Growth.** `resize(n)` throws if n is smaller than the current size ("a dense Merkle tree never shrinks: ids are not reused"). When the height grows, it marks leaf 0 dirty, because the nodes above the old root all lie on leaf 0's path and will be computed by it. `setLeaf(i, hash)` writes the leaf and marks it dirty; it rejects an index past the size and a hash that is not 32 bytes.

**Hashing a version.** `root(version)` recomputes only the changed paths:

```ts
    const h = this.height;
    let dirty = this.dirty;
    for (let k = 1; k <= h; k++) {
      const parents = new Set<number>();
      for (const j of dirty) parents.add(Math.floor(j / 2));
      for (const p of parents) this.writeNode(k, p, innerHash(this.node(k - 1, 2 * p), this.node(k - 1, 2 * p + 1)));
      dirty = parents;
    }
```

Shared ancestors are hashed once per level because `parents` is a set. Before that loop, if the leaf count changed since the last root, the old size is pushed onto `sizes` as "before this version the count was n" and reported as `sizeBefore`. After it, the records made by this root are moved into `lastRecords`, and `prune(version - window)` drops history that only serves versions outside the window (`window` is `retain` unless the window was trimmed, below). With a zero retention window there is no node history to prune, but the size records would still accumulate one entry per growth, so `root()` clears `sizes` outright in that case: only the current version is askable, and its leaf count is the live `size`. The method returns `rootAt(version)`.

**Reading the past.** `nodeAt(k, j, version)` is the versioned read:

```ts
  /**
   * Leaf count as of a version. With `past`, the version is older than the window in memory and the store's
   * records answer for it, here and in nodeAt, rootAt and pathAt.
   */
  sizeAt(version: number, past?: PastTree): number {
    if (past) return past.size ?? this.size;
    for (const s of this.sizes) if (s.v > version) return s.size;
    return this.size;
  }

  private checkVersion(version: number, past?: PastTree): void {
    if (this.dirty.size > 0) throw new Error('tree has unhashed changes; call root() first');
    if (version > this.version || (!past && version < this.lowestVersion)) throw new RangeError(`version ${version} is not available (have ${this.lowestVersion}..${this.version})`);
  }

  /** Node j at level k as of a version. */
  nodeAt(k: number, j: number, version: number, past?: PastTree): Uint8Array {
    if (j >= this.nodesAt(k, this.sizeAt(version, past))) return EMPTY;
    if (past) return past.nodes.get(nodePosition(k, j)) ?? this.rawNode(k, j);
    const entries = this.history[k]?.get(j);
    if (entries) for (const e of entries) if (e.v > version) return e.h;
    return this.rawNode(k, j);
  }

  rootAt(version: number, past?: PastTree): Uint8Array {
    this.checkVersion(version, past);
    const size = this.sizeAt(version, past);
    return size === 0 ? EMPTY : this.nodeAt(heightFor(size), 0, version, past).slice();
  }

  /** Sibling hashes from leaf i to the root as of a version: the inclusion proof. */
  pathAt(i: number, version: number, past?: PastTree): Uint8Array[] {
    this.checkVersion(version, past);
    const size = this.sizeAt(version, past);
    if (i >= size) throw new RangeError(`leaf ${i} beyond size ${size} at version ${version}`);
    const out: Uint8Array[] = [];
    let j = i;
    for (let k = 0; k < heightFor(size); k++) {
      out.push(this.nodeAt(k, j % 2 === 0 ? j + 1 : j - 1, version, past).slice());
      j = Math.floor(j / 2);
    }
    return out;
  }
```

Leave `past` aside for a moment. Beyond the populated range of that version's size a node is `EMPTY`; otherwise the first history entry with `v > version` gives the hash before that later change, and with no such entry the current hash is right. `rootAt`, `pathAt(i, version)` and `rangeProofAt(from, to, version)` all read through `nodeAt`, and `path(i)` is `pathAt` at the current version. `checkVersion` throws if there are unhashed changes or the version is outside `[lowestVersion, currentVersion]`.

The optional `past` is how a version older than the window in memory is read. The tree has forgotten its own entries for that version, but the database may have found them again in the store's history records, and hands them over as a `PastTree`:

```ts
/**
 * What the store's history records say of one tree as of a version the window in memory no longer holds
 * (ObjectDatabase, "past versions from the store"): the leaf count then, if a later version changed it, and for
 * each node asked about that a later version overwrote, its hash then. A node not in it is what it is now.
 */
export interface PastTree {
  size: number | null;
  /** By nodePosition(level, index). */
  nodes: Map<number, Uint8Array>;
}

/** One number for a node's level and index, as the chunks have. */
export function nodePosition(k: number, j: number): number {
  return k * LEVEL_SPAN + j;
}
```

With a `PastTree` each read asks it first and falls back on the tree as it is now: `sizeAt` takes `past.size`, or the current size if no later version changed the leaf count; `nodeAt` takes the hash recorded under the node's position, or the node's current hash if no later version overwrote it; and `checkVersion` lets a version below `lowestVersion` through, the database having checked it against what the store's records reach. The same two rules as with the entries in memory, with the records as their source. `rangeProofAt` takes `past` the same way.

The database has to say beforehand which nodes it will want, so that it copies only those out of the records. It cannot know the tree's size at the past version before it has read the records, so it asks for every node the read could touch:

```ts
  /**
   * The nodes rootAt and, with a leaf, pathAt may read at any past version: the tree was never larger than it is,
   * so its root was the first node of some level up to today's, and the leaf's path the siblings up to there.
   */
  pastPositions(leaf?: number): number[] {
    const out: number[] = [];
    const h = heightFor(this.size);
    for (let k = 0; k <= h; k++) out.push(nodePosition(k, 0));
    if (leaf !== undefined) for (let k = 0, j = leaf; k < h; k++, j = Math.floor(j / 2)) out.push(nodePosition(k, j % 2 === 0 ? j + 1 : j - 1));
    return out;
  }
```

A dense tree never shrinks, so at any past version it was at most as high as today. Its root then was node 0 of the level its height was, one of the levels 0 to `h`, and the path of a leaf was the siblings on the way up to that level: at most `h + 1` candidates for the root and `h` siblings, about forty positions for a tree of a million leaves. `pastRangePositions(from, to)` gives the same for a range proof, from the private `rangeSiblings`, which `rangeProofAt` now also uses to list the nodes beside a range.

Back to the window in memory. Its oldest version is

```ts
  get lowestVersion(): number {
    return Math.max(this.floor, this.version - this.window);
  }
```

`window` is how many past versions the tree keeps in memory just now. It starts as `retain`, the number the tree was constructed with, and the two differ only while the database has trimmed the window under memory pressure:

```ts

  /**
   * Keep only the last `versions` past versions in memory from now on (never more than the tree was made to retain).
   * Lowering it forgets the older ones at once and they stay forgotten: raising it again lets the window grow back
   * one root at a time. The records each root hands to the store are not affected.
   */
  setWindow(versions: number): void {
    this.window = Math.max(0, Math.min(this.retain, versions));
    if (this.version < 0) return;
    const min = this.version - this.window;
    if (min > this.floor) this.floor = min;
    this.prune(min);
  }
```

Lowering the window raises the floor to the oldest version still kept and prunes everything older at once. Raising it only changes the number: the floor stays where it is, because what was forgotten cannot be asked for again, and `root()` keeps it there (`if (version - this.window > this.floor) this.floor = version - this.window`), so the window grows back by one version at each root until it is `retain` wide again. `retain` still decides whether a root records anything at all (`retain > 0`), and the records a root hands out for the store (`lastRecords`) are the same whatever the window, so the store's copy of the history is complete even while the one in memory is not. `historyEntries` counts the entries held, for the database's estimate of what the window costs.

**History bookkeeping.** `record` calls `addEntry` with the pending version and keeps a list of what this root recorded so a store can persist it. `addEntry` requires ascending versions per node and refuses a second entry for the same node and version, so the first overwrite in a version wins, which is the value before the version. `historyByVersion` lets `prune` find every node touched by a version without scanning:

```ts
  prune(minVersion: number): void {
    for (const [v, list] of this.historyByVersion) {
      if (v > minVersion) continue;
      for (const [k, j] of list) {
        const byIndex = this.history[k]!;
        // Several versions pruned at once: an earlier one's pass may already have emptied this node's entries.
        const entries = byIndex.get(j);
        if (!entries) continue;
        while (entries.length > 0 && entries[0]!.v <= minVersion) {
          entries.shift();
          this.historyCount--;
        }
        if (entries.length === 0) byIndex.delete(j);
      }
      this.historyByVersion.delete(v);
    }
    while (this.sizes.length > 0 && this.sizes[0]!.v <= minVersion) this.sizes.shift();
  }
```

An entry tagged v serves reads of versions below v, so entries tagged at or below the window's lowest version serve nothing inside it and go. A root prunes one version at a time, but `setWindow` may prune many, and a node overwritten in two of them is listed under both: the first version's pass shifts all of its entries out and deletes the node from the map, so the second finds nothing there. That is what the `if (!entries) continue` is for; without it trimming a window threw on the first node changed twice. The floor has a public setter, and `loadRecords(version, rec)` puts records back after a restart:

```ts
  /**
   * Make `version` askable although no record of it was loaded: nothing changed
   * this tree between then and the oldest recorded version, so its entries, or
   * its live state, already describe it.
   */
  lowerFloor(version: number): void {
    if (version < this.floor) this.floor = Math.max(0, version);
  }

  /** Put back records a store kept, in ascending version order, after the current root is in place. */
  loadRecords(version: number, rec: TreeRecords): void {
    if (version > this.version) throw new RangeError(`cannot load history for version ${version} beyond ${this.version}`);
    // A record for version v describes version v-1 as well.
    this.lowerFloor(version - 1);
    if (version <= this.lowestVersion) return;
    for (const [k, j, h] of rec.nodes) this.addEntry(k, j, version, h);
```

`loadRecords` lowers the floor to `version - 1`, skips the version if it is at or below `lowestVersion`, and otherwise replays the entries and the size record, requiring ascending order. `lowerFloor` exists for the trees a record does not name: a tree that recorded nothing in a version was not touched in it, so the hashes it holds now are also the hashes it held then, and reads at that version through `nodeAt` are correct without any entries. The database uses it for every tree on every loaded record (review finding 44 in REVIEW-2026-10-28.md; see `loadHistory` below).

Two things to notice. First, the version a leaf write is recorded under comes from `pendingVersion`:

```ts
  /** Writes between two root() calls belong to the next version. */
  private get pendingVersion(): number {
    return this.nextVersion ?? this.version + 1;
  }
```

Between roots `nextVersion` is null, so leaf writes are tagged `version + 1`, while inner-node writes made inside `root(v)` are tagged `v`. The two agree only when roots are called with consecutive versions, which every caller does (heights). Second, a fresh tree's floor is the version of its first root, set inside `root()`; nothing but `lowerFloor` and `loadRecords` lowers it afterwards, and only a trimmed window raises it (`setWindow`, and `root()` while the window is narrower than the retention), so once a version is askable it stays askable until the window passes it.

**Chunks on disk.** A tree knows which tree it is in the store (`id`: a type id, or `TOP_TREE` for the tree over the types), and its chunks have store keys:

```ts
/** First byte of a dense tree chunk's store key. */
export const CHUNK_PREFIX = 0x74; // 't'

/** The store key of a chunk: 't', the tree (a type id, or 0 for the tree over the types), the level, the chunk index. */
export function chunkKey(tree: number, level: number, chunk: number): Uint8Array {
  const hi = Math.floor(chunk / 2 ** 32);
  const lo = chunk >>> 0;
  return Uint8Array.of(CHUNK_PREFIX, tree >> 8, tree & 0xff, level, (hi >>> 8) & 0xff, hi & 0xff, lo >>> 24, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
}

/** Every chunk key of one tree starts with this. */
export function treePrefix(tree: number): Uint8Array {
  return Uint8Array.of(CHUNK_PREFIX, tree >> 8, tree & 0xff);
}
```

The chunk index is six bytes, big-endian, written in two halves for the reason given under "Storage" (a shift would misplace an index at or above 2^31), so one tree's chunks are one range and a level's chunks are consecutive within it. The prefix is `'t'` and not `'c'` because the application store already keys the type counters as `'c'` followed by the type id, and a chunk key of type T's tree would have had T's counter key as a prefix. When `reporting` is set, which the database sets on every root when there is a store to keep the tree, `root()` ends by listing the chunks it changed:

```ts
  /** After a root: list the chunks it changed for the store, and hand a dropped tree's copies to the cache. */
  private finishChunks(): void {
    const out: StoreChange[] = [];
    if (this.reporting) {
      for (const ck of this.changed) {
        const k = Math.floor(ck / LEVEL_SPAN);
        const c = ck % LEVEL_SPAN;
        const chunk = this.levels[k]?.get(c);
        const used = chunk ? usedLength(chunk) : 0;
        out.push({ key: chunkKey(this.id, k, c), value: used > 0 ? chunk!.subarray(0, used) : null });
        if (used > 0 && !this.source) this.handedOut.add(chunk!);
      }
    }
    this.chunkChanges = out;
    this.changed.clear();
    if (this.source) {
      this.levels.forEach((level, k) => {
        for (const [c, chunk] of level) this.cache!.set(this.slot * SLOT_SPAN + k * LEVEL_SPAN + c, chunk);
      });
      this.levels.length = 0;
      this.counts.length = 0;
    }
  }
```

`changed` collected the level and index of every chunk `writeNode` touched, as one number. A chunk's used length is its bytes up to the last non-empty slot, so a chunk that emptied is reported as a deletion (its value null), and the one-chunk upper levels cost what they hold rather than 32 KiB each; a chunk read back from the store is padded to full size again. The values of a resident tree's chunks are views of the live chunks, not copies, which is what keeps a root over a resident tree from copying anything; the price is `handedOut`:

```ts
  /**
   * The chunks the last root() changed, as store keys and values (null: delete), when reporting; handed over once,
   * so the tree does not keep the list alive. The values are views, valid until release().
   */
  takeChunks(): StoreChange[] {
    const out = this.chunkChanges;
    this.chunkChanges = [];
    return out;
  }

  /** The store has written the last change list: its chunks may be written in place again. */
  release(): void {
    this.handedOut.clear();
  }
```

Until the application has written the list and the database's `dropChanges()` has called `release()`, a chunk among `handedOut` that `writeNode` is about to write again is copied first (the `handedOut.has(chunk)` branch below), so the list keeps describing the root it was made for however many writes the next block makes before the commit. `entries()` yields every chunk as it stands, for a store written from scratch (state sync), reading the store itself while dropped.

**Dropped.** `drop(source, cache)` releases every chunk and from then on every read goes through `chunk()`:

```ts
  /** A chunk to read from: resident, or the root's own copy, or through the cache from the store. Never written. */
  private chunk(k: number, c: number): Uint8Array | undefined {
    const live = this.levels[k]?.get(c);
    if (live || !this.source) return live;
    const key = this.slot * SLOT_SPAN + k * LEVEL_SPAN + c;
    let buf = this.cache!.get(key);
    if (buf === undefined) {
      buf = this.source.get(chunkKey(this.id, k, c));
      if (buf === undefined) return undefined;
      this.cache!.set(key, buf);
    }
    return buf;
  }
```

A chunk is the live one (resident, or the root's own copy while a root is in progress), else the cache's, else the store's, which is then cached; the cache key packs the tree's slot in the cache, the level and the chunk index into one number, so one cache serves every tree of a database. `writeNode` in a dropped tree never writes what it read:

```ts
    const level = this.levels[k]!;
    this.changed.add(k * LEVEL_SPAN + c);
    let chunk = level.get(c);
    if (this.source) {
      // Dropped: the root writes a private full-size copy, so a chunk read from the store, cached, or handed out in
      // an earlier change list is never written. Emptied chunks stay until the report deletes them from the store.
      if (!chunk) {
        chunk = EMPTY_CHUNK.slice();
        const stored = this.chunk(k, c);
        if (stored) chunk.set(stored);
        level.set(c, chunk);
      }
      chunk.set(h, off);
      return;
    }
    if (chunk && this.handedOut.size > 0 && this.handedOut.has(chunk)) {
      chunk = chunk.slice();
      level.set(c, chunk);
    }
```

The root works on private full-size copies of the chunks it changes, each filled from the store's shorter copy, so a chunk read from the store, cached, or handed out in an earlier change list is never written in place. When the root is done, `finishChunks` lists the copies and hands them to the cache, and `root()` reads its own value (`rootAt`) before that happens, since a cache smaller than one root's working set may evict them at once; the change list, laid over the store until it is written, still has them. The cache is an LRU by count:

```ts
  /** The key last moved to the end: a root reads a node and its sibling, mostly from one chunk, and need not move it twice. */
  private newest = -1;

  get(key: number): Uint8Array | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.hits++;
      if (key !== this.newest) {
        this.map.delete(key);
        this.map.set(key, v);
        this.newest = key;
      }
    } else this.misses++;
    return v;
  }

  set(key: number, v: Uint8Array): void {
    this.map.delete(key);
    this.map.set(key, v);
    this.newest = key;
    this.trim();
  }

  trim(): void {
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value!);
    if (this.map.size === 0) this.newest = -1;
  }
```

A `Map` keeps insertion order, so a hit re-inserts the entry at the end and eviction takes from the front; `hits` and `misses` are what the database's `memory()` reports. `newest` is the key last moved to the end. A root reads a node and then its sibling, which mostly sit in one chunk, so the second read would delete and re-insert an entry that is already last; comparing the key with `newest` saves that, and `trim` forgets it when the cache is emptied. The limit comes from the database, `treeChunks`, whose default is a constant of `src/db/database.ts`:

```ts
/**
 * Chunks a dropped tree set keeps cached: at most 128 MiB of buffers, outside the heap the memory guard watches. A
 * root over a state scattered across more chunks than the cache holds reads the rest from the store at every block:
 * with 256 chunks a block of 500 transfers among 514,000 accounts, whose trees have 1,100 chunks, took 271 ms to
 * finalize against 60 to 69 with all of them cached and 45 to 73 resident. So trees of up to about two million
 * leaves in all are cached whole while dropped, and beyond that the cache is what bounds them.
 */
const DEFAULT_TREE_CHUNKS = 4096;
```

A chunk is 1,024 hashes, 32 KiB at most, so 4,096 of them are at most 128 MiB, and most are smaller, the upper levels' chunks being short. They are array buffers, outside the V8 heap, so the cache does not count against the limit the guard is defending. The default was 256 chunks at first, at most 8 MiB: enough for the upper levels, which every path crosses, and for all of a state of 100,000 objects, and too few for a large state under a scattered load, where each block's paths end in more leaf chunks than the cache held and the rest came from LMDB at every block, 271 ms to finalize where a cache holding every chunk takes 60 to 69. With every chunk cached a root over dropped trees costs what a resident one does for ten thousand changes and half as much again for a thousand (docs/benchmarks.md section 4.12: 215 chunks cached after the db suite's runs, a root over 10,000 modified balances at a median of 203 ms against 201 resident and over 1,000 at 29.4 ms against 20.3, and 54.2 as a mean there because the first root after a drop reads every chunk it touches from LMDB). Between roots a dense tree holds nothing pending, so dropping it touches nothing but its own chunks, and `drop` refuses a tree with unhashed changes; past versions come from the history records exactly as before, which is why `nodeAt` and `pathAt` need no dropped branch. `rebuild()` reads the tree's chunks back with one range, and `load(source)` does the same for a fresh tree at a restart, both padding each chunk back to full size and counting its non-empty nodes:

```ts
  /**
   * Release every chunk and read from `source` from now on, through `cache`. The source must hold the tree as of
   * the last root; between roots nothing is pending in a tree, so that is all there is.
   */
  drop(source: TreeSource, cache: ChunkCache): void {
    if (this.source) return;
    if (this.dirty.size > 0) throw new Error('a tree with unhashed changes cannot be dropped');
    this.levels.length = 0;
    this.counts.length = 0;
    this.handedOut.clear();
    this.source = source;
    this.cache = cache;
    if (this.slot < 0) this.slot = cache.slot();
  }

  /** Read every chunk back from the store the tree was dropped to, and keep them resident again. */
  rebuild(): void {
    const source = this.source;
    if (!source) return;
    this.source = null;
    this.cache = null;
    this.readChunks(source);
  }

  /** A fresh tree takes its chunks from a store that holds it (a restart), instead of hashing every leaf. */
  load(source: TreeSource): void {
    if (this.version >= 0 || this.source) throw new Error('chunks are loaded only into a fresh resident tree');
    this.readChunks(source);
  }
```

`test/db.test.ts` ("dense merkle tree: dropped") drives one tree through fourteen versions of growth across chunk boundaries and powers of two, rewrites, emptied slots and an emptied chunk, dropped twice to a cache of two chunks and rebuilt once, and requires the roots, paths, range proofs and stored chunks of a resident tree at every retained version.

### src/db/smt.ts

Purpose: the compacted sparse Merkle tree behind authenticated indices, with versions by root pointer.

Exports:

- `interface SmtLeaf { keyHash; value }` and `interface SmtProof { siblings; leaf }`.
- `NODE_PREFIX = 0x6e` (`'n'`), `nodeHeader(type, position)` and `nodeKey(header, path, depth)`: a node's store key (STATE-PAGING.md section 5).
- `class SparseMerkleTree` with `currentVersion`, `lowestVersion`, `setWindow(versions)`, `historyNodes`, `resident`, `dropSource`, `set(key, value)`, `delete(key)`, `get(key)`, `rootHash()`, `commit(version, report?)`, `takeNodes()`, `takeRecords()`, `rootKey`, `pastKeys(key?)`, `rootAt(version, past?)`, `proveAt(key, version, past?)`, `prove(key)`, `entries()`, `drop(source)`, `rebuild()`, `load(source, check)`, `loadVersions(lowest, records)` and `verifyStored()`.
- `type NodeRecord = [storeKey, encoding | null]`: what one commit recorded for the store about one node, its encoding before the commit or null if there was none. `type PastNodes = Map<string, encoding | null>`: what the store's history records say of a tree's nodes at a version the window in memory no longer holds, by `nodeString(storeKey)`, the map key for a store key.
- `smtProofRoot(key, proof)`: the verifier's fold, returning `{ root, value }` (value null for absence) or undefined for a malformed proof.

A node is either a leaf `{ hash, leaf: { keyHash, value } }` or an inner node `{ hash, left, right }` with nullable children; the hash is computed once at construction with the same `leafHash` and `innerHash` as `src/db/merkle.ts`, so a leaf of the sparse tree is `leafHash(sha256(key), value)`. `bit(h, i)` reads bit i of a hash, most significant bit first, so depth 0 uses the top bit of the first byte. Nodes are immutable: `insert` and `remove` return a new node when anything below changed and the same node otherwise, so each write copies only the path from the root and every past version is just a root pointer that the garbage collector keeps alive. The value is copied on the way in: `set` makes a `Uint8Array` of its own from the buffer it is given, before either branch, and that copy is what the leaf holds, or the pending write while the tree is dropped. A caller that changes its buffer afterwards changes nothing that `get` or a proof returns. The copy is a few bytes next to a hash of the key; the database's own writes pass `idBytes(obj.id)`.

The Jellyfish shape is produced by two rules. On insert into a subtree that holds one leaf with a different key, both leaves are pushed down to the first bit where they differ:

```ts
    // Two leaves in one subtree: push both down to the first bit where they differ.
    let b = depth;
    while (b < KEY_BITS && bit(node.leaf.keyHash, b) === bit(keyHash, b)) b++;
    const fresh = leafNode(keyHash, value);
    let cur = bit(keyHash, b) ? innerNode(node, fresh) : innerNode(fresh, node);
    for (let d = b - 1; d >= depth; d--) cur = bit(keyHash, d) ? innerNode(null, cur) : innerNode(cur, null);
    return cur;
```

On remove, a leaf left alone under an inner node moves up:

```ts
  if (!left && !right) return null;
  // A lone leaf moves up: its prefix is unique one level earlier now.
  if (!left && right?.leaf) return right;
  if (!right && left?.leaf) return left;
  return innerNode(left, right);
```

Together they guarantee one shape per key set. The test in `test/db.test.ts` checks it with 3,000 random sets and deletes against a tree built from the sorted final key set. Setting a key to the value it already has returns the same node, so the root pointer does not change and no path is copied.

`commit(version, report)` is the versioning:

```ts
  /**
   * Remember the current contents as `version`. Versions must increase. With `report`, the nodes that changed
   * since the last commit are listed for the store (takeNodes); a dropped tree always lists them, since the store
   * is where they live.
   */
  commit(version: number, report = false): Uint8Array {
    if (version <= this.version) throw new Error(`version ${version} is not after ${this.version}`);
    if (this.source) return this.commitDropped(version);
    this.nodeChanges = [];
    this.records = null;
    if (report) {
      const before = this.version >= 0 ? (this.versions.get(this.version) ?? null) : null;
      // The first commit overwrites nothing a past version could ask for.
      const records: NodeRecord[] | null = this.version >= 0 ? [] : null;
      walkChanged(before, this.root, this.header, new Uint8Array(32), 0, (key, a, b) => {
        this.nodeChanges.push({ key, value: b ? encodingOf(b) : null });
        records?.push([key, a ? encodingOf(a) : null]);
      });
      this.records = records;
      if (records) this.replaced.set(version, records.length);
    }
    this.version = version;
    this.versions.set(version, this.root);
    if (version - this.window > this.floor) this.floor = version - this.window;
    for (const v of this.versions.keys()) if (v < version - this.window) this.versions.delete(v);
    for (const v of this.replaced.keys()) if (v <= version - this.window) this.replaced.delete(v);
    return this.rootHash();
  }
```

It requires increasing versions, stores the current root pointer under the version, and drops every stored version below `version - window`, where `window` is the retention the tree was made with unless `setWindow` has lowered it (below). Review finding 29 (REVIEW-2026-10-28.md) is about the last line: it used to prune only when retention was positive, so `retainVersions: 0` kept every root pointer forever and with them every path those roots reached; it now prunes at any retention, and `test/review.test.ts` asserts that version 3 is gone after committing 0..4 with retention 0. With `report`, which the database passes whenever a store keeps the tree, the commit also lists the nodes that changed since the last commit for the store, by walking the previous root and the new one together (`walkChanged`, under "Nodes on disk" below) into the subtrees whose hashes differ, so the cost is the changed paths, and an object written without a change to its index entry reports nothing. The same walk sees, at each changed position, the node the previous root had there (`a`), and the commit keeps those too: `records` is the list of what this commit overwrote, each a `NodeRecord` of the node's store key and its encoding before, or null where the previous version had no node. `takeNodes()` hands the store what the commit wrote and `takeRecords()` what it overwrote, each once. The database puts the second list into the version's history record, which is what later lets it read this tree at a version the window in memory has forgotten (below). The first commit keeps no list, having overwritten nothing, and neither does a commit made without `report`. A dropped tree takes the other branch, `commitDropped`, also below. `rootOf(version)` throws a `RangeError` if the version is outside the window or was never committed. `proveAt` walks from that version's root following the key's bits, collecting the sibling at each inner node (`EMPTY` for a missing child), and stops at a leaf or at null:

```ts
  /** Membership or absence proof for a key as of a version. Every buffer in it is a copy; the tree's own stay untouched. */
  proveAt(key: Uint8Array, version: number, past?: PastNodes): SmtProof {
    const keyHash = sha256(key);
    const siblings: Uint8Array[] = [];
    if (this.source || past) {
      if (!past) this.checkDropped(version);
      const node = past ? this.pastPath(keyHash, past) : (d: number) => this.nodeAt(nodeKey(this.header, keyHash, d), version);
      for (let d = 0; ; d++) {
        const e = node(d);
        if (!e) return { siblings, leaf: null };
        if (e[0] === LEAF) return { siblings, leaf: { keyHash: e.slice(1, 33), value: e.slice(33) } };
        const side = bit(keyHash, d);
        siblings.push(childOf(e, 1 - side).slice());
        if (isEmpty(childOf(e, side))) return { siblings, leaf: null };
      }
    }
    let n = this.rootOf(version);
    for (let d = 0; n && !n.leaf; d++) {
      if (bit(keyHash, d)) {
        siblings.push((n.left?.hash ?? EMPTY).slice());
        n = n.right;
      } else {
        siblings.push((n.right?.hash ?? EMPTY).slice());
        n = n.left;
      }
    }
    return { siblings, leaf: n ? { keyHash: n.leaf!.keyHash.slice(), value: n.leaf!.value.slice() } : null };
  }
```

The dropped branch walks the same path through the store, one node per depth: an inner node's encoding carries both children's hashes, so the sibling is read off it without another lookup, and the walk ends at a leaf, at a missing node, or at an inner node whose child on the key's side is empty. `nodeAt` reads a past version through the before-image records a dropped tree keeps (below), and the current version straight from the store.

The same walk over encodings serves a version older than the window, for a tree that is dropped or resident. The database hands over `past`, a `PastNodes`: for each node it asked the store's history records about and a later commit changed, the node's encoding at the version asked about, or null if there was no node then. Where the records say nothing about a node, no commit has changed it since, and the node as it is now is right. `pastPath` puts the two together:

```ts
  /**
   * The nodes down a key's path as of a version older than the window: the returned function, called with depth 0,
   * 1, 2 and so on, gives each node as the store's records have it, or, where no later commit changed it, as it is now.
   */
  private pastPath(keyHash: Uint8Array, past: PastNodes): (depth: number) => Uint8Array | null {
    // While resident, the node at the depth last asked for in the tree as last committed.
    let n: Node | null = this.source ? null : (this.versions.get(this.version) ?? null);
    let at = 0;
    return (depth) => {
      for (; at < depth; at++) n = n && !n.leaf ? (bit(keyHash, at) ? n.right : n.left) : null;
      const key = nodeKey(this.header, keyHash, depth);
      const recorded = past.get(str(key));
      if (recorded !== undefined) return recorded;
      return this.source ? (this.source.get(key) ?? null) : n ? encodingOf(n) : null;
    };
  }
```

For each depth it asks `past` first. A hit, null included, is the answer. A miss means the node is unchanged, and the current node is read: from the store if the tree is dropped, and otherwise from the tree as last committed, which the function follows down the key's bits one level per call so that it always has the current node at the depth asked for. `rootAt` uses the same function for depth 0:

```ts
  /** The root as of a version; with `past`, one older than the window, answered from the store's records. */
  rootAt(version: number, past?: PastNodes): Uint8Array {
    if (past) {
      const e = this.pastPath(EMPTY, past)(0);
      return e ? hashOfEncoding(e) : EMPTY.slice();
    }
    if (this.source) {
      this.checkDropped(version);
      return this.roots.get(version)!.slice();
    }
    return (this.rootOf(version)?.hash ?? EMPTY).slice();
  }
```

The root's hash is not in the records as such; it is recomputed from the root node's encoding with `hashOfEncoding`, and a tree that was empty at that version has `EMPTY`.

The database must name the nodes it wants before it scans the records, and here it cannot know how deep the key's path went at the past version, so `pastKeys` names every position on it:

```ts
  /** The store key of the root node. */
  get rootKey(): Uint8Array {
    return nodeKey(this.header, EMPTY, 0);
  }

  /** The store keys rootAt and, with a key, proveAt may read at a past version: the root's, and every node's down the key's path. */
  pastKeys(key?: Uint8Array): Uint8Array[] {
    const out = [this.rootKey];
    if (key) {
      const keyHash = sha256(key);
      for (let d = 1; d < KEY_BITS; d++) out.push(nodeKey(this.header, keyHash, d));
    }
    return out;
  }
```

That is 256 store keys for a key proof and one for a root. Most of them name positions where no node ever was; they cost a lookup in a set while the records are scanned and nothing else.

Every buffer in the proof is a copy, and so are the roots `rootHash` and `rootAt` return and the value `get` returns, each a `slice()`. Nodes are shared between versions and the hash in each is what every proof and root is folded from, so a caller writing into a sibling, a leaf or a root it was handed (a proof patched in a test, say) would otherwise rewrite the tree's own memory for every version that reaches that node. The dense tree already copied; the sparse tree now does too.

`smtProofRoot` is the verifier, and its one non-obvious check is for the "other leaf" case:

```ts
  } else {
    // Another key's leaf owns this subtree; it must share the path down to it.
    for (let d = 0; d < depth; d++) if (bit(p.leaf.keyHash, d) !== bit(keyHash, d)) return undefined;
    cur = leafHash(p.leaf.keyHash, p.leaf.value);
  }
  for (let d = depth - 1; d >= 0; d--) cur = bit(keyHash, d) ? innerHash(p.siblings[d]!, cur) : innerHash(cur, p.siblings[d]!);
```

Without the prefix check a prover could present any leaf from anywhere in the tree as "the leaf owning this subtree". A proof deeper than 256 siblings is rejected before hashing anything. The leaf hash is recomputed from the leaf's key hash and value, never taken from the proof, so the value is bound.

**The window.** As in the dense tree, how many past versions are kept can be lowered below what the tree was made to retain, and raised again:

```ts
  /**
   * Keep only the last `versions` past versions from now on (never more than the tree was made to retain). Lowering
   * it forgets the older ones at once; raising it again lets the window grow back one commit at a time.
   */
  setWindow(versions: number): void {
    this.window = Math.max(0, Math.min(this.retain, versions));
    if (this.version < 0) return;
    const min = this.version - this.window;
    if (min > this.floor) this.floor = min;
    if (this.source) this.pruneDropped(min);
    else {
      for (const v of this.versions.keys()) if (v < min) this.versions.delete(v);
      for (const v of this.replaced.keys()) if (v <= min) this.replaced.delete(v);
    }
  }

```

A resident tree forgets versions by deleting their root pointers; the nodes only those roots reached are then garbage. A dropped tree forgets its root hashes before `min` and the records that only serve versions before it (`pruneDropped`, which the dropped commit also calls for the one version that leaves the window at each commit, and which skips a node whose entries an earlier version's pass already emptied, for the reason given under the dense tree's `prune`). The floor is raised to `min` and stays there when the window is widened, and `lowestVersion` is the largest of the floor, `version - window` and zero, so the window grows back one commit at a time. `historyNodes` is the count the database's estimates take: the records a dropped tree holds, and for a resident tree the sum of `replaced`, which holds, per retained commit, how many nodes that commit replaced. Those nodes are what the version before the commit holds that the newer versions do not share, so their sum is about what the window holds besides the current tree, and what trimming it gives back. `commit` notes the number when it lists its changes (a commit made without `report` lists nothing and is not counted), and `setWindow` and `commit` forget the note of a commit once the version before it has left the window. `drop` clears the notes, since the dropped tree keeps records in their place; `rebuild` takes them back from how many records the dropped tree held for each version; and `loadVersions` sets them from the store's records as it builds each past version of a resident tree.

**Nodes on disk.** Every node has one store key, its path from the root:

```ts
/** First byte of a sparse tree node's store key. */
export const NODE_PREFIX = 0x6e; // 'n'

/** The first bytes of every node key of one authenticated index: 'n', the type, the index's position in the type. */
export function nodeHeader(type: number, position: number): Uint8Array {
  return Uint8Array.of(NODE_PREFIX, type >> 8, type & 0xff, position);
}

/** The store key of the node at `depth` on a path: the path's first `depth` bits, packed and zero-padded, then the depth. */
export function nodeKey(header: Uint8Array, path: Uint8Array, depth: number): Uint8Array {
  // A leaf one level below the deepest inner node possible (two keys sharing 255 bits) cannot be named.
  if (depth > 255) throw new RangeError('sparse tree node deeper than 255');
  const n = (depth + 7) >> 3;
  const out = new Uint8Array(header.length + n + 1);
  out.set(header);
  for (let i = 0; i < n; i++) out[header.length + i] = path[i]!;
  if (depth & 7) out[header.length + n - 1]! &= (0xff << (8 - (depth & 7))) & 0xff;
  out[out.length - 1] = depth;
  return out;
}
```

The header is `'n'`, the type and the index's position in its type, the same position the `'i'` prefix uses, and `TypeIndex` hands each tree its header at construction. The root is the node at depth 0 with no path bits, so `nodeKey(header, EMPTY, 0)` names it, which is how a dropped tree finds its root hash in the store. The bits past `depth` are masked off, so every key that passes through an inner node names it by the same key. An inner node is encoded as `0x00`, the left hash, the right hash, 65 bytes; a leaf as `0x01`, the 32-byte key hash, the value (the 8-byte id). `hashOfEncoding` recomputes a node's hash from either encoding, which is how a dropped tree finds its stored root hash; a tree loaded from the store takes each child's hash from its parent's encoding rather than rehashing every node, and the root it then reports is checked against the stored app hash by whoever loaded it. A resident tree finds the nodes a commit changed by walking two versions together:

```ts
/**
 * Visit every position where two trees differ, top down: a node of `b` that is not in `a` (or replaces a different
 * one), and a node of `a` that `b` no longer has. Subtrees with equal hashes are equal and skipped, so the cost is
 * the changed paths.
 */
function walkChanged(a: Node | null, b: Node | null, header: Uint8Array, path: Uint8Array, depth: number, visit: (key: Uint8Array, a: Node | null, b: Node | null) => void): void {
  if (a === b || (a && b && bytesEqual(a.hash, b.hash))) return;
  visit(nodeKey(header, path, depth), a, b);
  const al = a && !a.leaf ? a.left : null;
  const ar = a && !a.leaf ? a.right : null;
  const bl = b && !b.leaf ? b.left : null;
  const br = b && !b.leaf ? b.right : null;
  if (al || bl) {
    setBit(path, depth, 0);
    walkChanged(al, bl, header, path, depth + 1, visit);
  }
  if (ar || br) {
    setBit(path, depth, 1);
    walkChanged(ar, br, header, path, depth + 1, visit);
  }
}
```

Subtrees with equal hashes are equal and skipped, so the visit is the changed paths: a node of the new root that was not there, or replaced a different one, gets its encoding, and a node of the old root that the new one no longer has gets null, a deletion. `entries()` is the same walk against nothing, every node of the committed tree, for a store written from scratch.

**Dropped.** `drop(source)` lets the nodes go. Writes are then only remembered:

```ts
  /** The tree keeps its own copy of the value (a few bytes, next to a hash of the key): the caller's buffer stays the caller's. */
  set(key: Uint8Array, value: Uint8Array): void {
    value = new Uint8Array(value);
    if (this.source) {
      const keyHash = sha256(key);
      this.pending.set(str(keyHash), { keyHash, value });
    } else this.root = insert(this.root, sha256(key), value, 0);
  }

  delete(key: Uint8Array): void {
    if (this.source) {
      const keyHash = sha256(key);
      this.pending.set(str(keyHash), { keyHash, value: null });
    } else this.root = remove(this.root, sha256(key), 0);
  }
```

`set` copies the value before it does anything else, resident or dropped, so a caller that goes on using its buffer cannot change a leaf or a remembered write behind the tree's back. Per key hash the last write wins, undo included, since undo goes through the same calls. `get` answers from the pending writes first and otherwise walks the store by path, and `rootHash()` refuses while writes are pending, because a dropped tree's root is computed at its commit, which applies the remembered writes against the store:

```ts
  private commitDropped(version: number): Uint8Array {
    this.work = new Map();
    const rootKey = nodeKey(this.header, EMPTY, 0);
    let hash = this.storedRootHash();
    // The shape depends only on the final key set, so the order the writes are applied in does not matter.
    for (const p of this.pending.values()) {
      const e = this.read(rootKey);
      hash = (p.value ? this.insertAt(0, p.keyHash, p.value, e, hash) : this.removeAt(0, p.keyHash, e, hash)).hash;
    }
    this.pending.clear();
```

`insertAt` and `removeAt` are `insert` and `remove` over encodings instead of nodes, with the same two shape rules (two leaves in one subtree are pushed down to the first bit where they differ, a leaf left alone moves up), reading nodes through `read`, which prefers what this commit has already written, and writing through `write`, which records a node's encoding before the commit (`before`) the first time the commit touches it. What `work` holds at the end, less the nodes whose encoding came back to what it was, is the commit's change list (`takeNodes`), their before-images are the list for the store's history record (`takeRecords`, as in the resident commit), and the same before-images become the tree's own records for past versions, per node key and ascending by version, exactly as the dense tree keeps "before version v this node was x"; `roots` keeps each retained version's root hash, and both are pruned to the window at every commit. `drop` itself makes those records from the versions the resident tree retained, by walking each pair of consecutive roots with `walkChanged`, and turns the writes since the last commit into pending ones by the same kind of walk over the leaves, so a tree may be dropped in the middle of a block:

```ts
  /**
   * Let the nodes go and work on `source`, which must hold this tree as of the last commit. Writes since then become
   * pending writes, and the retained versions become records of what each commit overwrote.
   */
  drop(source: TreeSource): void {
    if (this.source) return;
    const committed = this.version >= 0 ? (this.versions.get(this.version) ?? null) : null;
    // What the writes since the last commit changed: every leaf of a subtree that differs, released, then every
    // leaf of the subtree that replaced it, taken (a leaf in both is taken again, with its value, which is no change).
    const changed = (a: Node | null, b: Node | null): void => {
      if (a === b || (a && b && bytesEqual(a.hash, b.hash))) return;
      if (a && !a.leaf && b && !b.leaf) {
        changed(a.left, b.left);
        changed(a.right, b.right);
        return;
      }
      eachLeaf(a, (l) => this.pending.set(str(l.keyHash), { keyHash: l.keyHash, value: null }));
      eachLeaf(b, (l) => this.pending.set(str(l.keyHash), { keyHash: l.keyHash, value: l.value }));
    };
    changed(committed, this.root);
    const versions = [...this.versions.keys()].sort((a, b) => a - b);
    for (const v of versions) this.roots.set(v, (this.versions.get(v)?.hash ?? EMPTY).slice());
    this.floor = versions[0] ?? 0;
    for (let i = 1; i < versions.length; i++) {
      const v = versions[i]!;
      const keys: string[] = [];
      walkChanged(this.versions.get(versions[i - 1]!) ?? null, this.versions.get(v) ?? null, this.header, new Uint8Array(32), 0, (key, a) => {
        const s = str(key);
        let entries = this.history.get(s);
        if (!entries) this.history.set(s, (entries = []));
        entries.push({ v, enc: a ? encodingOf(a) : null });
        this.historyCount++;
        keys.push(s);
      });
      if (keys.length > 0) this.historyByVersion.set(v, keys);
    }
    this.root = null;
    this.versions.clear();
    this.replaced.clear();
    this.source = source;
  }
```

`rebuild()` reads the current tree back from the store and every retained version from the records, newest first, each built against the next newer one so that every subtree whose hash did not change is shared between them as it was when the versions were live, and applies the pending writes on top; `load(source)` builds a fresh tree from the store's root node at a restart. The `build` they share reads a node's encoding, recurses into the children whose hashes are not empty, and reuses the other version's node wherever the hash matches:

```ts
  /** Read the tree back from the store, and every retained version from the records; the pending writes go on top. */
  rebuild(): void {
    const source = this.source;
    if (!source) return;
    const path = new Uint8Array(32);
    // Newest first, each built against the next newer one, so whatever did not change between them is shared.
    let newer: Node | null = null;
    const built = new Map<number, Node | null>();
    for (const v of [...this.roots.keys()].sort((a, b) => b - a)) {
      const h = this.roots.get(v)!;
      const n: Node | null = isEmpty(h) ? null : this.build((k) => this.nodeAt(k, v), path, 0, h, newer);
      built.set(v, n);
      newer = n;
    }
    let root: Node | null;
    if (this.version >= 0) root = built.get(this.version) ?? null;
    else {
      const h = this.storedRootHash();
      root = isEmpty(h) ? null : this.build((k) => source.get(k) ?? null, path, 0, h, null);
    }
    for (const p of this.pending.values()) root = p.value ? insert(root, p.keyHash, p.value, 0) : remove(root, p.keyHash, 0);
    this.source = null;
    this.pending.clear();
    this.roots.clear();
    this.history.clear();
    for (const [v, keys] of this.historyByVersion) this.replaced.set(v, keys.length);
    this.historyByVersion.clear();
    this.historyCount = 0;
    for (const [v, n] of built) this.versions.set(v, n);
    this.root = root;
  }
```

**Past versions at a restart.** `load` gives a restarted tree its current version and no other: the versions before it were root pointers in the process that stopped. What the store has of them is what each commit overwrote, the `NodeRecord`s `takeRecords()` handed over, which the database wrote into each version's history record. `loadVersions` builds the past versions from those:

```ts
  /**
   * Give a tree that holds only its current version the versions before it, from what each later commit overwrote
   * (the store's history records, a restart): `records` by the version of the commit that made them, `lowest` the
   * oldest version they describe. A commit's records are what the version before it differs by, so each older
   * version is built against the next newer one from that commit's records alone, newest first, sharing every
   * subtree the commit left alone; a dropped tree keeps the records as its own. Every node taken from a record
   * must hash to what its parent says, and a node a version needs that no record holds is an error: the caller
   * falls back on replaying the keys.
   */
  loadVersions(lowest: number, records: Map<number, NodeRecord[]>): void {
    if (this.version < 0 || this.pending.size > 0) throw new Error('past versions are loaded into a committed tree');
    if ((this.source ? this.roots.size : this.versions.size) > 1) throw new Error('past versions are loaded into a tree that holds none');
    if (lowest >= this.version) return;
    const versions = [...records.keys()].filter((v) => v > lowest && v <= this.version).sort((a, b) => a - b);
    const rootString = str(this.rootKey);
    const path = new Uint8Array(32);
    let newer: Node | null = this.source ? null : (this.versions.get(this.version) ?? null);
    let hash = this.source ? this.storedRootHash() : (newer?.hash ?? EMPTY);
    // Newest first: before commit v the tree was what it is after, with v's records in place of what v wrote.
    let upTo = this.version;
    for (let i = versions.length - 1; i >= 0; i--) {
      const v = versions[i]!;
      const before = new Map<string, Uint8Array | null>();
      for (const [key, enc] of records.get(v)!) before.set(str(key), enc);
      if (!this.source) this.replaced.set(v, before.size);
      // The versions from v up to the next recorded one are the tree as built so far.
      for (let u = upTo - 1; u >= v; u--) this.source ? this.roots.set(u, hash.slice()) : this.versions.set(u, newer);
      upTo = v;
      if (before.size === 0) continue;
      const rootEnc = before.get(rootString);
      if (rootEnc !== undefined) hash = rootEnc ? hashOfEncoding(rootEnc) : EMPTY;
      if (!this.source) {
        const read = (k: Uint8Array): Uint8Array | null => before.get(str(k)) ?? null;
        newer = isEmpty(hash) ? null : this.build(read, path, 0, hash, newer, true);
      }
    }
    for (let u = upTo - 1; u >= lowest; u--) this.source ? this.roots.set(u, hash.slice()) : this.versions.set(u, newer);
    if (this.source) {
      // The records themselves are what a dropped tree answers past versions from; per node they must ascend.
      for (const v of versions) {
        const keys: string[] = [];
        for (const [key, enc] of records.get(v)!) {
          const s = str(key);
          let entries = this.history.get(s);
          if (!entries) this.history.set(s, (entries = []));
          entries.push({ v, enc });
          this.historyCount++;
          keys.push(s);
        }
        if (keys.length > 0) this.historyByVersion.set(v, keys);
      }
    }
    this.floor = lowest;
  }
```

`records` holds, by the version of the commit that made them, this tree's records, and `lowest` is the oldest version the caller wants described. The tree must be committed, with nothing pending, and hold no version but the current one. The argument is in the comment: the records of commit v are exactly what version v - 1 differs from version v by. So the loop goes newest first. Before it handles the records of v, the tree built so far (`newer`, and its root hash `hash`) is the tree at every version from v up to the next recorded one above, and those versions are set to it; a version with no records for this tree changed nothing in it and shares the root pointer outright. Then the tree before v is built: if v's records name the root node, the root hash before v is the hash of that encoding (or `EMPTY` where there was none), and `build` is called with `read` looking only in v's records and `same` set to the newer tree. `build` returns the newer tree's node wherever the hash it is asked for matches, so it descends only into what the commit changed and shares every subtree the commit left alone, as live versions do; with `check` true every encoding it takes from a record must hash to what its parent says; and a node it needs that the records do not hold is its `a sparse tree node is missing from the store` error. If the records of v do not name the root, the root did not change, `hash` is still the newer tree's, and `build` returns the newer tree at once. After the loop the versions from the oldest recorded one down to `lowest` are set to the last tree built, and `floor` is lowered to `lowest`.

A dropped tree builds nothing. It keeps a root hash per version (`roots`), taken from the same walk over the root node's records, and then files the records themselves, oldest version first, into `history` and `historyByVersion`: they are the before-image records it would have kept had it been dropped all along, and `nodeAt` answers a past version from them. Nothing is checked against a parent in that case, since nothing is built. The cost either way is the nodes the window's commits changed, where replaying every key (`rebuildIndexVersions` in `src/db/database.ts`, below) costs the whole key set; any error is the caller's signal to fall back on that replay.

The sparse trees are where the heap of the tree tier goes, a node object and two small typed arrays per node, where the dense chunks live in array buffers; that is why the database drops both kinds with one dial and why the rebuild estimate counts sparse leaves (below). `test/db.test.ts` ("sparse merkle tree: dropped") runs forty versions of random sets and deletes over a small key space, so leaves split and collapse often, on a resident tree and one dropped twice, once in the middle of its writes, and rebuilt twice, and requires the same roots, the same `get`, the same proofs sibling for sibling at every retained version, and a store holding exactly the resident tree's nodes.

### src/db/freeze.ts

Purpose: `deepFreeze`, the one function that makes "immutable records" true at run time, in a file of its own so that both the type index (which freezes what it decodes from the arena) and the database (which freezes what callers create and modify) can import it. `src/db/database.ts` re-exports it, so code that imported it from there still does.

```ts
/**
 * A record is immutable once stored: the live cache, the undo log and the
 * callers that hold one all point at the same object, so a change in place
 * would corrupt every one of them. Freezing reaches every nested object and
 * array. Byte arrays cannot be frozen in JavaScript, so a record's hashes
 * and keys remain the one thing a caller must not write into.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const v of Array.isArray(value) ? value : Object.values(value)) deepFreeze(v);
  return value;
}
```

It freezes the record and then every plain object and array nested in it, so an evaluator that assigned to a field, or pushed into an account's array of keys or a validator's list of pending changes, throws in strict mode instead of corrupting the old value that the undo log and the hot cache point at (they keep references, not copies). The one thing it cannot reach is a byte array: `Object.freeze` on a typed array throws, so `ArrayBuffer.isView` stops the recursion there, and a record's hashes and keys remain the one thing a caller must not write into. The cost was measured at 0.77 microseconds per account-like record against 0.06 microseconds for the shallow `Object.freeze` it replaced. Four places call it: `create` and `modify` in the database, on what the caller built; `getAt`, on a past value it decodes from the history; and the type index, on every object it decodes from the arena, so whatever `get` returns, cached or freshly decoded, is frozen.

### src/db/arena.ts

Purpose: the slabs of encoded bytes that hold every committed object (see "Objects as bytes" above), knowing nothing of types or objects beyond the two numbers in a header.

Exports:

- `HEADER = 10` and `MAX_ENTRY`, the largest encoding an entry can hold: a slab's maximum, 16 MiB, less the header. No object comes near it; STATE-PAGING.md puts the largest, the dynamic properties with a thousand validators, under 2 MiB.
- `interface ArenaOwner { refOf(type, instance); relocate(type, instance, ref); released(type, instance) }`: whoever holds the references. Compaction asks it whether an entry is still current and tells it where the entry moved; `shrink` tells it that an entry's slab was released and its bytes are now only in the owner's store.
- `packRef(slab, offset)`, `slabOf(ref)`, `offsetOf(ref)`: a reference and its two halves, by multiplication, division and remainder by 2^24 rather than by shifts, for the reason given under `src/db/merkle.ts`: JavaScript's bitwise operators work on 32 bits. The slab number of a reference is itself two things, a slot and a generation (`generation * 2^16 + slot`), and `packRef` refuses a number or an offset that does not fit.
- `interface ArenaStats { slabs; capacity; used; dead }`: the slabs holding bytes, the bytes they can hold, the bytes written into them, and how many of those are dead.
- `class Arena` with `stats`, `alloc(type, instance, bytes)`, `read(ref)`, `free(ref)`, `maintain()` and `shrink(limit)`.

The header comment is the design:

```ts
/**
 * A log-structured arena for the encoded objects of the database
 * (STATE-PAGING.md section 3). Objects are kept as their canonical bytes,
 * packed into a few large slabs, instead of as decoded JavaScript objects:
 * an account under secp256k1 is 117 bytes encoded and about a kilobyte
 * decoded, and the difference is most of what the heap held per account.
 *
 * Every entry is a 10-byte header (type, instance, length) followed by the
 * encoding; a reference is the slab number and the offset of the header,
 * packed into one number. Slabs are filled by a bump allocator and never
 * written in place: a new encoding of an object is a new entry, the old one
 * is counted dead, and after a root a slab with nothing live left is released
 * outright, and one that is more than half dead is compacted by copying its
 * live entries into the current slab and releasing it. The header is what
 * makes compaction possible: it names the owner, which says whether the entry
 * is still its current value.
 *
 * A released slab's number is given to the next slab, with its generation
 * counted up, so slab numbers stay as few as the slabs alive at once and a
 * reference stays exact: 24 bits of offset (a slab is at most 16 MiB), 16 of
 * slot and 13 of generation make 53, all a double holds without rounding. The
 * generation is what refuses a stale reference into a slot used again; it
 * wraps after 8,192 reuses of one slot, which is harmless because the owner
 * never keeps a reference into a released slab (compaction moves them all).
 *
 * The arena is a cache when the owner has a store behind it (STATE-PAGING.md
 * section 3.4): shrink() releases whole slabs until the arena is within a
 * byte limit, telling the owner of every live entry in them that its bytes
 * are now only in the store. Which slab goes is CLOCK again, a bit per slab
 * set by every read: a slab nothing has read since the last pass goes first.
 * The slabs are ArrayBuffers, outside V8's heap, so the limit is the owner's
 * to set in bytes; the memory guard, which watches the heap, does not see them.
 */
```

A slab is `{ buf, used, dead, generation, touched }`, and `buf` becomes `null` when the slab is released; its slot then waits in the `spare` list for the next slab. `alloc` counts what it writes (for compaction's budget) and hands the entry to `put`, which refuses an oversized encoding, opens a new slab when the current one cannot take the entry, and writes the header byte by byte, big-endian, in front of the encoding:

```ts
  private newSlab(need: number): void {
    // The first slab is small so a tiny database costs little; each next doubles up to the maximum.
    const size = Math.max(need, Math.min(MAX_SLAB, FIRST_SLAB * 2 ** this.created));
    this.created++;
    const slot = this.spare.pop();
    if (slot !== undefined) {
      const s = this.slabs[slot]!;
      s.buf = new Uint8Array(size);
      s.generation = (s.generation + 1) % GENERATIONS;
      s.touched = false;
      this.current = slot;
      return;
    }
    if (this.slabs.length >= SLOTS) throw new RangeError(`the arena holds at most ${SLOTS} slabs at once`);
    this.slabs.push({ buf: new Uint8Array(size), used: 0, dead: 0, generation: 0, touched: false });
    this.current = this.slabs.length - 1;
  }

  private refAt(slot: number, offset: number): number {
    return packRef(this.slabs[slot]!.generation * SLOTS + slot, offset);
  }

  private slabFor(ref: number): Slab | undefined {
    const id = slabOf(ref);
    const slab = this.slabs[id % SLOTS];
    return slab && slab.generation === Math.floor(id / SLOTS) ? slab : undefined;
  }

  private release(slot: number): number {
    const slab = this.slabs[slot]!;
    const size = slab.buf!.length;
    slab.buf = null;
    slab.used = 0;
    slab.dead = 0;
    this.spare.push(slot);
    return size;
  }

  /** Store an encoding; returns its reference. */
  alloc(type: number, instance: number, bytes: Uint8Array): number {
    this.written += HEADER + bytes.length;
    return this.put(type, instance, bytes);
  }

  private put(type: number, instance: number, bytes: Uint8Array): number {
    if (bytes.length > MAX_ENTRY) throw new RangeError(`an encoding of ${bytes.length} bytes does not fit the arena (at most ${MAX_ENTRY})`);
    const need = HEADER + bytes.length;
    if (this.current < 0 || this.slabs[this.current]!.used + need > this.slabs[this.current]!.buf!.length) this.newSlab(need);
    const slab = this.slabs[this.current]!;
    const buf = slab.buf!;
    const at = slab.used;
    buf[at] = type >>> 8;
    buf[at + 1] = type & 0xff;
    buf[at + 2] = instance >>> 24;
    buf[at + 3] = (instance >>> 16) & 0xff;
    buf[at + 4] = (instance >>> 8) & 0xff;
    buf[at + 5] = instance & 0xff;
    buf[at + 6] = bytes.length >>> 24;
    buf[at + 7] = (bytes.length >>> 16) & 0xff;
    buf[at + 8] = (bytes.length >>> 8) & 0xff;
    buf[at + 9] = bytes.length & 0xff;
    buf.set(bytes, at + HEADER);
    slab.used += need;
    return this.refAt(this.current, at);
  }
```

A new slab is as large as the next step of the doubling, `min(16 MiB, 256 KiB × 2^created)` with `created` the slabs made so far, or as the entry that needs it if that is larger. The count is of slabs ever made, so a node that released its early slabs does not go back to small ones. A new slab takes a spare slot if there is one, with the slot's generation counted up and its `touched` mark cleared, and a new slot otherwise, up to 65,536 slots at once. `refAt` builds a reference from a slot, its present generation and an offset; `slabFor` goes the other way and answers nothing when the generation in the reference is not the slot's present one, which is how a stale reference into a slot used again is refused instead of reading someone else's bytes. The bump allocator never looks back: when an entry does not fit, the rest of the current slab stays unused and the entry opens the next one.

`read(ref)` parses the header, marks the slab as touched (the mark `shrink` reads, below) and returns a `subarray` of the slab, a view and not a copy, "valid until the next compaction"; a reference into a slab that was released, or never made, throws `RangeError`. `free(ref)` only adds the entry's size, header included, to its slab's `dead`. Reclaiming is `maintain`:

```ts
  /**
   * After a root: release every slab with nothing live left, which costs no copying however many there are, and
   * compact slabs that are more than half dead, copying their live entries into the current slab and telling the
   * owner where they went. No further slab is started once the bytes copied have reached what alloc() wrote since
   * the last call (at least MIN_COPY); a slab that was started is finished, so a call can copy up to the live half
   * of one slab (under 8 MiB) more than that. Each compacted slab gives back more than it copies, so reclaiming
   * keeps pace with any rate of writes and a backlog drains, while the pause stays in proportion to the block's
   * own writes. Returns the bytes released.
   */
  maintain(): number {
    let released = 0;
    for (let s = 0; s < this.slabs.length; s++) {
      const slab = this.slabs[s]!;
      if (s !== this.current && slab.buf && slab.used > 0 && slab.dead >= slab.used) released += this.release(s);
    }
    const budget = Math.max(MIN_COPY, this.written);
    let copied = 0;
    for (let s = 0; s < this.slabs.length && copied < budget; s++) {
      const slab = this.slabs[s]!;
      if (s === this.current || !slab.buf || slab.used === 0 || slab.dead * 2 <= slab.used) continue;
      const buf = slab.buf;
      for (let at = 0; at < slab.used; ) {
        const ref = this.refAt(s, at);
        const h = this.header(ref);
        if (this.owner.refOf(h.type, h.instance) === ref) {
          const moved = this.put(h.type, h.instance, buf.subarray(at + HEADER, at + HEADER + h.length));
          this.owner.relocate(h.type, h.instance, moved);
          copied += HEADER + h.length;
        }
        at += HEADER + h.length;
      }
      released += this.release(s);
    }
    this.written = 0;
    return released;
  }
```

Two passes. The first releases every slab that holds nothing live (`dead >= used`), which costs no copying however many there are. The second compacts slabs that are more than half dead until the bytes copied reach the budget: what `alloc` wrote since the last call, the root's block, and at least 16 MiB. The loop tests `copied < budget` before it takes up a slab and then copies every live entry of that slab, so the budget is where it stops taking slabs and not a ceiling on the bytes: the last slab can carry the pass over it by up to its live bytes, less than half of the slab. The current slab is never released or compacted, since new entries go there, nor is an empty or released one. The walk goes from header to header up to `used`, which works only because every entry carries its length, and an entry is live exactly when the owner's table still holds this reference for that type and instance: an object written again since has a newer entry, and a removed one has none, so the old reference is no longer in the table. A live entry is copied with `put` into the current slab (not `alloc`, so compaction's own copies do not count as writes), which may open a new one, and the owner learns its new reference through `relocate`. A compacted slab gives back more than was copied out of it, so reclaiming keeps pace with any rate of writes. The return value is the bytes released. The database calls `maintain()` at the end of every `root()`, while the node idles until the next proposal.

**The arena as a cache.** Everything above keeps every committed encoding in memory. `shrink` is what lets the arena hold fewer, when its owner has a store that holds them all (STATE-PAGING.md section 3.4):

```ts
  /**
   * Release whole slabs until the arena's capacity is within `limit` bytes, never the current one (so the least it
   * comes down to is that slab, 16 MiB at most). Each live entry of a released slab is handed to the owner as
   * released: the caller must know that its store holds every committed encoding. Slabs nothing has read since the
   * last call go first, in slot order; the others lose their mark and go on a second pass if the first was not
   * enough. Returns the bytes released.
   */
  shrink(limit: number): number {
    let capacity = 0;
    for (const s of this.slabs) if (s.buf) capacity += s.buf.length;
    let released = 0;
    for (let pass = 0; pass < 2 && capacity > limit; pass++) {
      for (let s = 0; s < this.slabs.length && capacity > limit; s++) {
        const slab = this.slabs[s]!;
        if (s === this.current || !slab.buf) continue;
        if (pass === 0 && slab.touched) {
          slab.touched = false;
          continue;
        }
        for (let at = 0; at < slab.used; ) {
          const h = this.header(this.refAt(s, at));
          if (this.owner.refOf(h.type, h.instance) === this.refAt(s, at)) this.owner.released(h.type, h.instance);
          at += HEADER + h.length;
        }
        const size = this.release(s);
        capacity -= size;
        released += size;
      }
    }
    return released;
  }
```

It adds up the capacity of the slabs and, while that is over the limit, releases whole slabs. The current slab is skipped, so the arena never comes down below it. Which slab goes is CLOCK again, as in the hot cache, with one bit per slab instead of one per object: `read` sets `touched`, and the first pass over the slots skips a touched slab and clears its mark, so a slab nothing has read since the last call goes first; if the first pass did not release enough, the second takes the others in slot order. Before a slab is released its entries are walked as compaction walks them, and for each one that is still current the owner's `released(type, instance)` is called. A dead entry is not reported: its object has a newer encoding elsewhere, or none. After that the slab's buffer is let go and its slot is spare, and any reference into it is refused by the generation check once the slot is used again, and by the missing buffer until then.

The arena does not know where the bytes are now, and does not check that they are anywhere: the comment says the caller must know that its store holds every committed encoding. The database makes sure of that by calling `shrink` only after the application has written the last root (`dropChanges`, under `src/db/database.ts`). The limit is in bytes, and it is not one of the memory guard's dials ([chapter 8](08-node.md)), for the reason the header comment gives: a slab is a `Uint8Array`, whose buffer V8 allocates outside its heap, and the guard takes its levels from the heap. Releasing slabs would not lower the figure it acts on, so how much the arena may take is the operator's to set.

### src/db/index.ts

Purpose: one type's objects and indices, Graphene's `generic_index` without Boost's multi-index containers: the type's table of references into the arena, its hot cache of decoded objects, and its secondary indices.

Exports:

- `class DbError extends Error`: every rule violation in the database layer throws this, so the application can tell a failed transaction (a `DbError`) from a bug.
- `interface IndexDef<T> { name; unique; authenticated?; key(obj, k) }`: an index definition. `key` writes the object's key into a `KeyWriter`.
- `interface ObjectType<T> { id; name; encode(w, obj); decode(r, id); indices }`: a type. The doc comments carry two invariants: the id is "Fixed forever: it is in every id and every leaf hash", and `encode` is the canonical encoding hashed into the state root, which does not write the id because the leaf position implies it. `decode` receives the id for the same reason.
- `MAX_INSTANCE = 2 ** 32 - 2`: the largest instance the primary index accepts, "the largest instance a JavaScript array can index". `src/db/id.ts` allows 48 bits in an id; this is the bound the per-instance tables keep, and an instance within it also fits the four bytes the arena's header gives it.
- `type ObjectFetch = (id) => bytes | undefined`: where committed encodings are read from when the arena does not hold them, the application's store by id. The database passes it to every type, or `null` when it has no such store.
- `interface HotBudget { limit; size; hits; misses }`: how many decoded objects the hot caches of all types may hold together, how many they hold, and how many reads the caches answered and how many decoded from the arena since the database was made. The database makes one and hands every type the same object.
- `idBytes(id)`: the eight big-endian bytes of an id, the value a unique index entry stores and the sparse trees hash.
- `class TypeIndex<T>`: the per-type container.

Each secondary index is a `Secondary`: its definition, the four bytes every one of its store keys starts with, and either a B+ tree or, while that is dropped, an overlay:

```ts
/** One secondary index: its definition, where its entries live in the store, and its tree or, while that is dropped, its overlay. */
interface Secondary<T> {
  def: IndexDef<T>;
  /** 'i', type, position: the first bytes of every store key of this index. */
  header: Uint8Array;
  tree: BPlusTree<ObjectId> | null;
  /** While the tree is dropped: per key, what the writes since the last root made of it (null: released). */
  overlay: BPlusTree<ObjectId | null> | null;
}
```

The type's private fields are the design of "Objects as bytes" and of the index tier in data:

```ts
  private readonly arena: Arena;
  private readonly budget: HotBudget;
  /** The store's index entries as of the last root, which a dropped index falls back on. */
  private readonly base: IndexStore;
  /** Secondary indices in definition order (an index's position is its place here), and by name. */
  private readonly secondary: Secondary<T>[] = [];
  private readonly byName = new Map<string, Secondary<T>>();
  private readonly retain: number;
  /** Arena reference of each committed instance (ABSENT when there is none, STORED when its bytes are only in the store) and its encoding's length. */
  private refs = new Float64Array(0);
  private lens = new Uint32Array(0);
  /**
   * Decoded objects by instance; null is a tombstone for a removal the arena has not seen. The map's order is CLOCK's
   * ring: the hand starts at the front, and an entry it spares goes to the back.
   */
  private readonly hot = new Map<number, T | null>();
  /** CLOCK's second-chance bit per instance. */
  private touched = new Uint8Array(0);
  /** Instances written since the last root: never evicted. */
  private readonly pinned = new Set<number>();
  /** Set when an eviction pass found nothing clean left to drop; cleared at the next root, which unpins. */
  private saturated = false;
  /**
   * For every pinned instance, its keys at the last root and now. A write computes both anyway (to unindex the old
   * value and index the new one); kept, they make a root's index changes a comparison instead of a re-encoding.
   */
  private readonly dirtyKeys = new Map<number, DirtyKeys>();
  /** Objects with a committed encoding, in the arena or only in the store: each has one entry in every index, for estimates. */
  committedCount = 0;
  /** How many of them are only in the store. */
  storedCount = 0;
  private readonly fetch: ObjectFetch | null;
```

`refs`, `lens` and `touched` grow together in `ensure`, doubling and never below 16 slots, with new references set to `ABSENT`; a reference needs a `Float64Array` because it packs a slab number above the low 24 bits, up to 53 bits in all. A reference is never negative, so two negative numbers serve as marks:

```ts
/** What the reference table holds for an instance with no committed encoding, and for one whose encoding is only in the store. */
const ABSENT = -1;
const STORED = -2;

/** Where committed encodings are read from when the arena does not hold them: the application's store, by id. */
export type ObjectFetch = (id: ObjectId) => Uint8Array | undefined;
```

`ABSENT` is an instance with no committed object. `STORED` is a committed object whose bytes the arena no longer holds, because the slab they were in was released to keep the arena within its byte limit, or because they were never loaded at a restart; `fetch` is how they are read then. `pinned` is what keeps a written object safe from eviction, and `saturated` is what stops a type whose cache is all pinned from sweeping in vain on every write. `base` is the database's view of the store as of the last root (the application's store under the changes of roots not yet written), `secondary` is in definition order because an index's position in it is the position in its store keys, `dirtyKeys` is what makes a root's index report a comparison of byte arrays, and `committedCount` feeds the memory guard's rebuild estimate; it counts every committed object, `storedCount` those of them that are `STORED`.

The constructor takes the arena, the shared budget and the store view besides the type and the retention window, whether the trees start resident, and the object fetch or `null`; it builds one `Secondary` per index, with a `BPlusTree` or an empty overlay, and, for an authenticated index, one `SparseMerkleTree` with the retention window and the node header of its position:

```ts
  constructor(type: ObjectType<T>, retainVersions: number, arena: Arena, budget: HotBudget, base: IndexStore, resident = true, fetch: ObjectFetch | null = null) {
    this.type = type;
    this.fetch = fetch;
    this.retain = retainVersions;
    this.arena = arena;
    this.budget = budget;
    this.base = base;
    if (type.indices.length > 256) throw new Error(`${type.name}: more than 256 indices`);
    type.indices.forEach((ix, position) => {
      if (this.byName.has(ix.name)) throw new Error(`${type.name}: duplicate index ${ix.name}`);
      const s: Secondary<T> = { def: ix, header: indexHeader(type.id, position), tree: resident ? new BPlusTree() : null, overlay: resident ? null : new BPlusTree() };
      this.secondary.push(s);
      this.byName.set(ix.name, s);
      if (ix.authenticated) {
        this.trees.set(ix.name, new SparseMerkleTree(retainVersions, nodeHeader(type.id, position)));
        this.authenticated.push(ix.name);
      }
    });
    // A proof of this type carries a root for each, and a decoder of proofs refuses more.
    if (this.authenticated.length > MAX_AUTHENTICATED_INDICES) throw new Error(`${type.name}: more than ${MAX_AUTHENTICATED_INDICES} authenticated indices`);
  }
```

`authenticated` keeps the names in definition order; that order is the order of `indexRoots` in the type leaf, which is why `KeyProof.indexPosition` is meaningful and why reordering a type's authenticated indices among themselves would change the app hash; reordering any of its indices changes the layout of the `'i'` and `'n'` keys in the store. Duplicate index names, more than 256 indices (the position is one byte) and more than 16 authenticated indices are rejected with plain `Error`s at construction: they are configuration mistakes, not runtime failures. The 16 is `MAX_AUTHENTICATED_INDICES` of `src/db/proof.ts`, the one constant `decodeProof`, `decodeKeyProof` and the snapshot manifest's decoder ([chapter 11](11-application.md)) also bound their lists of index roots by, so a type the constructor accepts makes proofs and manifests that decode. The core types have four at most (the redelegation entries).

**Reads.** `get` is the cache, then the arena, then, for an object the arena let go, the store:

```ts
  /** The arena released the slab an instance's bytes were in: from now on they are read from the store. */
  released(instance: number): void {
    this.refs[instance] = STORED;
    this.storedCount++;
  }

  /** The committed encoding of an instance that has one: a view into the arena, or the store's copy. */
  private committedBytes(instance: number): Uint8Array {
    const ref = this.refs[instance]!;
    if (ref >= 0) return this.arena.read(ref);
    const bytes = this.fetch?.(objectId(this.type.id, instance));
    if (!bytes) throw new DbError(`${this.type.name} ${instance}: its bytes are neither in the arena nor in the store`);
    return bytes;
  }
```

`released` is the type's part of `ArenaOwner.released`: the arena calls it, through the database, for every live entry of a slab `shrink` is about to release. Nothing else about the object changes. `committedBytes` is the one place that knows where an object's committed encoding is: a view into the arena for a real reference, the store's copy for a `STORED` one. An object marked `STORED` that the store does not hold is a broken store, and the read throws rather than answer that the object is absent. Everything that needs committed bytes goes through it: the decode below, `bytesOf` (and so proofs, the history a root records, exports and snapshots), and `checkEntries`.

```ts
  private decodeAt(instance: number): T {
    return deepFreeze(decode(this.committedBytes(instance), (r) => this.type.decode(r, objectId(this.type.id, instance))));
  }

  get(instance: number): T | undefined {
    const v = this.hot.get(instance);
    if (v !== undefined) {
      // A cached object, or a tombstone (null), which reads as absent.
      this.touched[instance] = 1;
      this.budget.hits++;
      return v ?? undefined;
    }
    if (this.refAt(instance) === ABSENT) return undefined;
    this.budget.misses++;
    const obj = this.decodeAt(instance);
    this.cache(instance, obj);
    return obj;
  }

  has(instance: number): boolean {
    if (this.hot.has(instance)) return this.hot.get(instance) !== null;
    return this.refAt(instance) !== ABSENT;
  }
```

Anything in the cache answers, and counts a hit: an object, whose touched bit is set, or a tombstone, as absent. Otherwise an instance marked `ABSENT` is absent, and any other counts a miss and is decoded from its committed bytes, frozen, and cached, entering with its bit clear. For a `STORED` object those bytes come from the store, and the decoded object is cached like any other, but the bytes are not written back into the arena: a read never grows it. `has` answers without decoding anything: a cached entry decides, else the table, where `STORED` counts as present. The two counters are the budget's, shared by every type, and `memory()` reports them as `hotHits` and `hotMisses`.

**The cache and eviction.**

```ts
  private cache(instance: number, value: T | null): void {
    this.ensure(instance);
    if (!this.hot.has(instance)) this.budget.size++;
    this.hot.set(instance, value);
    this.touched[instance] = 0;
    if (!this.saturated) this.evict();
  }

  private uncache(instance: number): void {
    if (this.hot.delete(instance)) this.budget.size--;
  }

  /**
   * Over budget: sweep this type's cached entries with the clock hand, giving a touched one a second chance and
   * evicting clean ones that have not been touched since the hand last passed, until the budget is met. The hand
   * walks the entries, not the instances, so the cost follows what is cached however far apart its instances lie.
   * Pinned objects stay whatever the budget, and go to the back so the next sweep does not walk them again first. Each
   * entry is passed at most twice (once to clear its bit, once to evict it), and a type that cannot find victims (its
   * cache all pinned, as while a genesis is built) marks itself saturated and does no more work until the next root
   * unpins.
   */
  evict(): void {
    let over = this.budget.size - this.budget.limit;
    if (over <= 0) return;
    if (this.hot.size === this.pinned.size) {
      this.saturated = true;
      return;
    }
    let visits = 2 * this.hot.size;
    for (const [i, value] of this.hot) {
      if (over <= 0 || visits-- <= 0) break;
      if (this.pinned.has(i) || this.touched[i]) {
        this.touched[i] = 0;
        // To the back of the ring; iteration reaches it again after the rest.
        this.hot.delete(i);
        this.hot.set(i, value);
        continue;
      }
      this.hot.delete(i);
      this.budget.size--;
      over--;
      if (this.hot.size === this.pinned.size) break;
    }
    // Saturated means nothing clean is left to evict, not that this pass found none.
    this.saturated = over > 0 && this.hot.size === this.pinned.size;
  }

  /** A root is over: the pins are off, so the budget can be enforced again, and an overlay has nothing left to say. */
  afterRoot(): void {
    this.saturated = false;
    this.evict();
    for (const s of this.secondary) s.overlay?.clear();
  }
```

`cache` counts a new entry against the shared budget, clears its touched bit (a fresh decode has not earned a second chance, and a write does not need one, since it is pinned), and asks `evict` for room unless the type is saturated. `evict` sweeps the cached entries in the map's order, which is the clock's ring: an entry that is pinned or touched has its bit cleared and goes to the back of the map (deleted and set again), and a clean, untouched one is deleted, until the budget is met. The hand walks what is cached, not the table of instances, so cached objects far apart among the instances cost no more; each entry is passed at most twice (the sweep stops after twice the cache's size), so a write never pays for more than that. The budget is shared but each type evicts only its own entries, so a type that cannot find a victim leaves the total over until another type caches something, the next root, or a new limit. `saturated` is set only when everything the type has cached is pinned, as while a genesis is being built, every object written and none rooted yet; `afterRoot`, which the database calls on every type once a root has unpinned everything, clears it, brings the cache back under the budget in one pass, and empties every overlay, since the store with the root's changes now says what the overlay said. The database's `setHotLimit` calls `evict` on every type for the same reason.

**Writes.**

```ts
  /** Write a value (create or modify). Fails, changing nothing, if a unique key is already taken by another object. */
  insert(obj: T): void {
    const keys = this.keysOf(obj);
    this.checkUnique(obj, keys);
    const instance = instanceOf(obj.id);
    if (instance > MAX_INSTANCE) throw new DbError(`${this.type.name}: instance ${instance} is beyond the index`);
    const old = this.get(instance);
    // A key the write leaves as it was is left alone in the tree, the overlay and the sparse tree: taking it out and
    // putting it back says the same, and most writes change no key (a balance's amount, a validator's counters).
    const oldKeys = old ? this.keysOf(old) : null;
    const same = oldKeys ? keys.map((k, i) => bytesEqual(k, oldKeys[i]!)) : null;
    if (oldKeys) this.unindexKeys(oldKeys, same);
    this.wrote(instance, oldKeys, keys);
    this.pinned.add(instance);
    this.cache(instance, obj);
    this.indexKeys(obj, keys, same);
  }

  /** Remember an instance's keys as committed (on its first write since the root) and as they now stand. */
  private wrote(instance: number, before: Uint8Array[] | null, now: Uint8Array[] | null): void {
    if (this.secondary.length === 0) return;
    const d = this.dirtyKeys.get(instance);
    if (d && this.pinned.has(instance)) d.current = now;
    else this.dirtyKeys.set(instance, { committed: before, current: now });
  }
```

```ts
  private unindex(obj: T): Uint8Array[] {
    const keys = this.keysOf(obj);
    this.unindexKeys(keys, null);
    return keys;
  }

  private unindexKeys(keys: Uint8Array[], skip: boolean[] | null): void {
    for (let i = 0; i < keys.length; i++) {
      if (skip?.[i]) continue;
      const s = this.secondary[i]!;
      const k = keys[i]!;
      if (s.tree) s.tree.delete(k);
      else s.overlay!.set(k, null);
      this.trees.get(s.def.name)?.delete(k);
    }
  }

  erase(obj: T): void {
    const keys = this.unindex(obj);
    const instance = instanceOf(obj.id);
    this.wrote(instance, keys, null);
    this.pinned.add(instance);
    this.cache(instance, null);
  }
```

The uniqueness checks (`checkUnique`, shared with the import path) run before anything changes, so a `modify` that would collide on a name leaves the old object in place; they go through `find` (below), so they consult the tree while it is resident, and otherwise the overlay and then the store. The instance check sits with them: an instance past `MAX_INSTANCE` is refused with a `DbError` rather than written, since the tables are indexed by instance and the arena header holds it in four bytes. Nothing in `src/db/` creates ids that large, but `importObject` takes ids from a store or a snapshot, and `insert` and the imports (`importBytes`, which `importCommitted` goes through, and `importStored`) are the doors every object comes through. A replace reads the old object (from the cache, or decoded from the arena), computes its keys and compares them with the new ones: a key the write leaves as it was is skipped by both `unindexKeys` and `indexKeys` (`same`), since taking an entry out and putting the same entry back says nothing, and most writes change no key at all, a balance's amount or a validator's counters. That matters most for the sparse tree, where each of the two writes copies a path from the root. For the keys that did change it unindexes the old ones, then pins the instance, caches the new object, and writes its keys with `indexKeys`: into the B+ tree, or while that is dropped into the overlay (`unindex` sets null there, a release), and where present into the sparse tree with the 8-byte id as the value, which takes the same writes whether its own nodes are resident or not. `wrote` keeps, per pinned instance, the keys the object had at the last root (from its first write since then) and the keys it has now, both of which the write computed anyway; a root compares those arrays to report its index changes instead of encoding keys again. `erase` unindexes and caches a tombstone, pinned: the object is gone for every read at once, while its committed bytes stay in the arena until the root frees them. Neither writes to the arena, and the database's `undoSession` restores old values through the same two methods, so a transaction that fails writes nothing there either, and while the trees are dropped its overlay entries are put back by the same calls.

The import path skips the cache altogether, and comes in two forms:

```ts
  /** Load a committed object straight into the arena (import), decoded only to build its index entries. */
  importCommitted(obj: T, bytes: Uint8Array): void {
    const keys = this.keysOf(obj);
    this.checkUnique(obj, keys);
    this.importBytes(instanceOf(obj.id), bytes);
    this.indexKeys(obj, keys);
  }

  /** Load a committed object whose index entries the store already holds (a restart): no decode at all. */
  importBytes(instance: number, bytes: Uint8Array): void {
    if (instance > MAX_INSTANCE) throw new DbError(`${this.type.name}: instance ${instance} is beyond the index`);
    if (this.has(instance)) throw new DbError(`${this.type.name}: instance ${instance} imported twice`);
    this.ensure(instance);
    this.refs[instance] = this.arena.alloc(this.type.id, instance, bytes);
    this.lens[instance] = bytes.length;
    this.committedCount++;
  }

  // ...

  /**
   * After importBytes: fill the B+ trees when resident, and the sparse trees unless `sparse` is false (their nodes
   * were loaded from the store), from the store's entries. They come in key order, which is the B+ tree's cheapest
   * order to grow in.
   */
  loadIndexEntries(sparse = true): void {
    for (const s of this.secondary) {
      const smt = sparse ? this.trees.get(s.def.name) : undefined;
      if (!s.tree && !smt) continue;
      for (const [k, v] of this.base.range(s.header, afterPrefix(s.header)!)) {
        this.checkShape(s, k, v);
        const key = k.subarray(INDEX_HEADER);
        s.tree?.set(key, this.storedId(s, k, v));
        smt?.set(key, idBytes(this.storedId(s, k, v)));
      }
    }
  }
```

`importCommitted` is the snapshot path and the path of a store from before phase two: the bytes go straight into the arena, the decoded object serves for its index keys and is dropped, and nothing is pinned. `importBytes` is the restart path: no decode at all, only the bytes into the arena, and once every object is in, `loadIndexEntries` walks each index's prefix in the store once and fills the B+ tree, in key order, the tree's cheapest order to grow in, and the sparse tree from the same entries unless its nodes were loaded from the store themselves. `checkShape` refuses an entry that does not look like one (a unique index's value is an 8-byte id, a non-unique key ends in one and has no value), and `checkEntries()`, which the database calls after the load unless told not to, decodes every committed object once and requires the stored entries to be exactly the ones the objects make. Measured at 192,000 accounts when the entries were first stored, the two restart paths cost the same within a few percent, both dominated then by hashing the name tree, and the one that reads the entries is the one a node with dropped trees does anyway (STATE-PAGING.md 4.4). A second import of the same instance is refused either way.

A third import leaves the bytes where they are:

```ts
  /** Load a committed object as importBytes does, but leave its bytes in the store: the arena is full enough. */
  importStored(instance: number): void {
    if (instance > MAX_INSTANCE) throw new DbError(`${this.type.name}: instance ${instance} is beyond the index`);
    if (this.has(instance)) throw new DbError(`${this.type.name}: instance ${instance} imported twice`);
    if (!this.fetch) throw new DbError(`${this.type.name}: no store to leave an object's bytes in`);
    this.ensure(instance);
    this.refs[instance] = STORED;
    this.committedCount++;
    this.storedCount++;
  }
```

The database calls it at a restart for the objects that would take the arena over its byte limit (under `importObject`, below). The object is counted as committed and as stored, and its first read fetches it.

**What a root does with a type.** The database's dirty loop (below) asks for the pending value and then flushes or settles it:

```ts
  /** The value written since the last root (null for a removal), or undefined when nothing is pending. */
  pending(instance: number): T | null | undefined {
    return this.pinned.has(instance) ? this.hot.get(instance) : undefined;
  }

  /** The committed encoding, a view into the arena or the store's copy; undefined when there is none. */
  bytesOf(instance: number): Uint8Array | undefined {
    return this.refAt(instance) === ABSENT ? undefined : this.committedBytes(instance);
  }

  /** The current encoding: a pending value's, or the committed bytes. Null for a removal, undefined when absent. */
  bytesFor(instance: number): Uint8Array | null | undefined {
    const pending = this.pending(instance);
    if (pending !== undefined) return pending ? encode((w) => this.type.encode(w, pending)) : null;
    return this.bytesOf(instance);
  }
```

```ts
  /**
   * A root has encoded a pending value: write it to the arena (or free the old entry for a removal)
   * and unpin it. The decoded object stays cached, clean, until evicted.
   */
  flush(instance: number, bytes: Uint8Array | null): void {
    const old = this.refAt(instance);
    if (old >= 0) this.arena.free(old);
    else if (old === STORED) this.storedCount--;
    if (old !== ABSENT) this.committedCount--;
    this.ensure(instance);
    if (bytes) {
      this.committedCount++;
      this.refs[instance] = this.arena.alloc(this.type.id, instance, bytes);
      this.lens[instance] = bytes.length;
    } else {
      this.refs[instance] = ABSENT;
      this.lens[instance] = 0;
      this.uncache(instance);
    }
    this.pinned.delete(instance);
    this.dirtyKeys.delete(instance);
  }

  /** A root found a pending value equal to the committed one: nothing to write, just unpin. */
  settle(instance: number): void {
    this.pinned.delete(instance);
    this.dirtyKeys.delete(instance);
    if (this.hot.get(instance) === null) this.uncache(instance);
  }
```

`pending` returns a value only for a pinned instance: the object written since the last root, `null` for a removal, and `undefined` when nothing is pending, which is how the root tells an imported object (in the arena, never pinned) from a written one. `flush` frees the old entry (or, for an object that was `STORED`, only takes it off `storedCount`, there being no entry to free) and writes the new bytes, or for a removal clears the reference and drops the tombstone, keeps `committedCount` right, and unpins. Writing the new bytes is always an `alloc` in the current slab, so an object that was only in the store is in the arena again once it has been written: a written object stays cached, now clean, a candidate for eviction like any other, and its dirty keys are forgotten, since the root has reported them. `settle` is for a value written and written back: nothing to write, the pin comes off, and a tombstone for an object that never reached the arena is dropped. `bytesOf` is the committed encoding, a view into the arena or the store's copy; `bytesFor` prefers a pending value's encoding, so export and snapshots taken between roots see the live state.

**The rest.** `instances()` yields every present instance in ascending order through `has`, so a type's objects can be walked without decoding any; `rebuildIndexVersions`, `exportObjects` and `encodeSnapshot` walk them that way. `truncate(before)` is the undo of creates: it drops cache entries, pins and dirty keys from `before` on and resets the counter (none of those instances has a reference to clear, a created object reaching the arena only at a root, with no session open), so the next create reuses the instance an undone create had taken. `keyFor(obj, index)` returns one index key, which `rebuildIndexVersions` uses, and `freshTree(name)` an empty sparse tree keyed in the store as the index's own is. `replaceTree` swaps in a rebuilt sparse tree, and if the one it replaces was dropped, drops the new one to the same store first. `refAt`, `relocate` and `released` are the type's half of the arena's owner interface, which the database forwards by type. `index(name)` returns an index's B+ tree and throws on an unknown name or a dropped tree; `resident` says whether the type's trees are there (a type's indices are dropped or kept together), and `hotSize` is the size of the type's cache.

`clear()` frees every arena entry, empties the tables, the cache, the pins, the dirty keys, the B+ trees and the overlays, gives the cache's entries back to the budget, and resets the counter, `committedCount` and `storedCount`, but leaves the sparse trees; nothing in `src/` or `test/` calls it.

**The B+ trees as a cache over the store.** Every read of an index goes through two private methods that know whether the tree is there:

```ts
  /** The id a stored entry names: a unique entry's value, a non-unique key's last eight bytes. */
  private storedId(s: Secondary<T>, k: Uint8Array, v: Uint8Array): ObjectId {
    return s.def.unique ? u64At(v, 0) : u64At(k, k.length - 8);
  }

  private find(s: Secondary<T>, k: Uint8Array): ObjectId | undefined {
    if (s.tree) return s.tree.get(k);
    const o = s.overlay!.get(k);
    if (o !== undefined) return o ?? undefined;
    const v = this.base.get(entryKey(s.header, k));
    return v === undefined ? undefined : this.storedId(s, k, v);
  }

  /** The id under an exact key: a tree walk, or while dropped an overlay probe and a store read. */
  lookupId(name: string, k: Uint8Array): ObjectId | undefined {
    return this.find(this.secondaryIndex(name), k);
  }

  /**
   * Entries from `start` in key order, all of them to the end of the index, or with `prefix` given only those
   * that start with it. While dropped: a store cursor merged with the overlay.
   */
  entries(name: string, start: Uint8Array, prefix: Uint8Array | null): IterableIterator<[Uint8Array, ObjectId]> {
    return this.entriesOf(this.secondaryIndex(name), start, prefix);
  }

  /** Not a generator itself, so a resident scan costs what the tree's iterator costs and nothing on top. */
  private entriesOf(s: Secondary<T>, start: Uint8Array, prefix: Uint8Array | null): IterableIterator<[Uint8Array, ObjectId]> {
    if (s.tree) return prefix ? s.tree.scan(prefix) : s.tree.scanFrom(start);
    return this.fallbackEntries(s, start, prefix);
  }

  private *fallbackEntries(s: Secondary<T>, start: Uint8Array, prefix: Uint8Array | null): IterableIterator<[Uint8Array, ObjectId]> {
    const end = prefix ? afterPrefix(prefix) : null;
    const stored = this.base.range(entryKey(s.header, start), end ? entryKey(s.header, end) : afterPrefix(s.header)!);
    const self = this;
    function* fromStore(): IterableIterator<[Uint8Array, ObjectId]> {
      for (const [k, v] of stored) yield [k.subarray(INDEX_HEADER), self.storedId(s, k, v)];
    }
    yield* overlaid(fromStore(), until(s.overlay!.entriesFrom(start), end));
  }
```

Resident, a lookup is the tree's `get` and a scan the tree's iterator, with nothing on top (`entriesOf` is not a generator for that reason). Dropped, a lookup is an overlay probe (an id, or null for a key the writes since the root released, which reads as absent) and otherwise one store read under the index's header, decoding the id from a unique entry's value or from the last eight bytes of a non-unique key; a scan is the store's range under the header, from `start` to the end of the prefix or of the index, with the header stripped from each key, laid under the overlay's entries by `overlaid` (`src/db/indexstore.ts`), so entries the open sessions added appear in order, entries they removed are skipped, and a key both released and taken again yields the new id. This is what `lookup`, `scan`, `range` and `scanFrom` in the database read through, and what `checkUnique` consults on every write. The dial itself:

```ts
  /**
   * Drop the B+ trees and fall back on the store. `changed` is every object of this type written since the last
   * root, as its committed value and its current one (null for none): what the overlay must say from now on.
   */
  dropTrees(changed: [T | null, T | null][]): void {
    if (!this.resident) return;
    for (const s of this.secondary) {
      s.tree = null;
      s.overlay = new BPlusTree();
    }
    // Every key a write released first, then every key one took, so a key passed between two objects ends taken.
    for (const [before] of changed) if (before) this.keysOf(before).forEach((k, i) => this.secondary[i]!.overlay!.set(k, null));
    for (const [, now] of changed) if (now) this.keysOf(now).forEach((k, i) => this.secondary[i]!.overlay!.set(k, now.id));
  }

  /** Build the B+ trees again from what the fallback reads (the store with the overlay on top) and drop the overlays. */
  rebuildTrees(): void {
    if (this.resident) return;
    const built = this.secondary.map((s) => {
      const tree = new BPlusTree<ObjectId>();
      for (const [k, id] of this.entriesOf(s, new Uint8Array(0), null)) tree.set(k, id);
      return tree;
    });
    this.secondary.forEach((s, i) => {
      s.tree = built[i]!;
      s.overlay = null;
    });
  }
```

The overlay must be, from the moment of the drop, the difference between the last root and now, and the database hands `dropTrees` exactly what that difference is made of: every object of the type written since the last root, as the value the root shadow holds for it and its current value. All the releases go in before all the takes, so a key that passed from one object to another inside the block ends with its new owner, and a key an object kept is released and taken again, which leaves it as it was. From then on the writes themselves keep the overlay (the `overlay!.set` branches of `indexKeys` and `unindex`), and a root empties it. `rebuildTrees` walks the merged view, store and overlay, into fresh trees and drops the overlays; it may be called mid-block too, since the merged view already says what the trees must say. The root's report is a comparison:

```ts
  /**
   * The index entries a root reports for one object that went from `before` to `after` (null: absent): a
   * released key is removed, a taken one added, and a key it kept is left alone. The keys the writes recorded
   * are used when there are any; `after` is then only asked for its id.
   */
  diffEntries(before: T | null, after: T | null, removed: IndexEntryChange[], added: IndexEntryChange[], instance?: number): void {
    if (this.secondary.length === 0) return;
    const d = instance === undefined ? undefined : this.dirtyKeys.get(instance);
    const old = d ? d.committed : before ? this.keysOf(before) : null;
    const now = d ? d.current : after ? this.keysOf(after) : null;
    for (let i = 0; i < this.secondary.length; i++) {
      const s = this.secondary[i]!;
      const o = old?.[i];
      const n = now?.[i];
      if (o && n && bytesEqual(o, n)) continue;
      if (o) removed.push({ key: entryKey(s.header, o), value: null });
      if (n) added.push({ key: entryKey(s.header, n), value: s.def.unique ? idBytes(after!.id) : EMPTY_VALUE });
    }
  }
```

Per index, a key the object kept writes nothing, so the balances a transfer changes, in amount and in no key, cost no index write (the transfer's recent transaction id is a new object and writes its entries, and so does a balance made by a first receipt); a released key is a removal and a taken one an addition with the id as value for a unique index and nothing for a non-unique one, whose key already ends with the id. The keys come from `dirtyKeys` when the writes recorded them, and are computed from the objects only when the database calls without an instance (the drop of a database that has no store, which must build its in-memory store's view of the dirty set). `indexEntries()` yields every entry of every index as it stands, through `entriesOf`, so it reads the store while dropped, and `checkStore(store)` (for tests) compares the resident trees with the store both ways: every tree entry must be there with its value, and the store may hold no more entries under an index's header than the tree has.

### src/db/proof.ts

Purpose: the proof shapes, their verifiers and their encodings, with no dependency on the database so a light client can import this file alone (`src/light/client.ts` and `src/light/verify.ts` import only `verifyObjectProof` and `verifyKeyProof` from here, the second with the two proof types).

Exports:

- `interface ObjectProof`: `height`, `id`, `value` (encoding or null), `nextInstance`, `typeRoot`, `typeSiblings`, `indexRoots`, `typeIndex`, `typeCount`, `topSiblings`.
- `interface KeyProof`: `height`, `type`, `indexPosition`, `key`, `proof: SmtProof`, then the same type-leg fields.
- `idKey(id)`, `typeKey(type)`, `typeValue(nextInstance, typeRoot, indexRoots)`: the leaf keys and the type leaf's value.
- `objectLeaf(id, value)`, `typeLeaf(type, nextInstance, typeRoot, indexRoots)`: the two leaf hashes.
- `typeLegMatches(appHash, p)`: the shared type leg.
- `verifyObjectProof(appHash, p)`: boolean.
- `verifyKeyProof(appHash, p)`: the value, null for absence, undefined for a proof that does not lead to the app hash.
- `encodeProof` / `decodeProof` / `proofToBytes` / `proofFromBytes` and `encodeKeyProof` / `decodeKeyProof` / `keyProofToBytes` / `keyProofFromBytes`: the wire forms. The RPC ships proofs as hex of these bytes and never re-serialises them.

The type leaf's value fixes the order of the three commitments:

```ts
export function typeValue(nextInstance: bigint, typeRoot: Uint8Array, indexRoots: Uint8Array[]): Uint8Array {
  return encode((w) => w.u64(nextInstance).fixed(typeRoot).array(indexRoots, (w, r) => w.fixed(r)));
}
```

The array of index roots is length-prefixed by the codec, so a type with no authenticated indices has a 4-byte zero count there. DESIGN.md section 6 states the same shape: `type leg: key = 2-byte type, value = nextInstance || typeRoot || indexRoots`.

The type leg is shared by both verifiers:

```ts
export function typeLegMatches(appHash: Uint8Array, p: { type: number; nextInstance: bigint; typeRoot: Uint8Array; indexRoots: Uint8Array[]; typeIndex: number; typeCount: number; topSiblings: Uint8Array[] }): boolean {
  if (p.typeIndex >= p.typeCount || p.topSiblings.length !== heightFor(p.typeCount)) return false;
  const top = rootFromPath(typeLeaf(p.type, p.nextInstance, p.typeRoot, p.indexRoots), p.typeIndex, p.topSiblings);
  return bytesEqual(top, appHash);
}
```

`verifyObjectProof` is the two-shape absence logic described in the concepts:

```ts
  if (instance < count) {
    if (p.typeSiblings.length !== heightFor(count)) return false;
    const leaf = p.value === null ? EMPTY : objectLeaf(p.id, p.value);
    typeRoot = rootFromPath(leaf, instance, p.typeSiblings);
    if (!bytesEqual(typeRoot, p.typeRoot)) return false;
  } else {
    // Beyond the counter nothing can exist; the counter itself is what the top tree vouches for.
    if (p.value !== null || p.typeSiblings.length !== 0) return false;
    typeRoot = p.typeRoot;
  }
  return typeLegMatches(appHash, { ...p, type, typeRoot });
```

The path length must equal `heightFor(count)` exactly, which ties the path to the counter in the proof; and the counter is in turn hashed into the type leaf, so a prover cannot shrink the tree to hide an object. The header comment observes that ICS23 would prove absence by the two neighbouring leaves; with the empty-subtree rule both forms work, and the dense layout makes the empty-leaf form natural.

The wire form of a key proof, from `encodeKeyProof`, is: height u64, type u16, index position u8, key as length-prefixed bytes, the sibling array, an option holding the end leaf's 32-byte key hash and its value, then the type leg (counter, type root, index roots, type index, type count, top siblings). Decoding bounds every array: 64 siblings per dense-tree leg, 16 index roots, 256 sparse-tree siblings, 4 KiB keys and leaf values. A proof is about one height, and the height is carried in the proof so the light client knows which header (height + 1) to check it against. README.md measures a name proof at 958 bytes and building one at 276,000 per second on a small state; verifying one runs at 54,300 per second (docs/benchmarks.md section 4.3). The transaction and result proofs of RPC-SYNC-PROOFS.md section 2.2 are not in this file: that section places their verifiers in `src/types/txproof.ts`, which builds them from the same `leafHash` and `rootFromPath`.

### src/db/database.ts

Purpose: the object database itself: types, sessions, the committed and historical views, the per-version root, change reporting, persisted history, proofs, restoring of index history, and bulk import/export.

Exports:

- `deepFreeze(value)`: re-exported from `src/db/freeze.ts` (above), so code that imported it from here still does; `IndexEntryChange` and `IndexStore` are re-exported from `src/db/indexstore.ts` the same way.
- `interface DatabaseOptions { retainVersions?, hotObjects?, indexStore?, indexTrees?, trees?, treeChunks?, objectStore?, arenaBytes?, historyStore? }`: the window, where 0 keeps only the current version and `DEFAULT_RETAIN` is 100; the budget of decoded objects the hot caches share, unbounded by default (`DEFAULT_HOT` is `Infinity`); the store that holds the index entries and the trees the application writes from each root's change list, without which a database that drops a tier keeps the entries in memory instead; whether the secondary indices' B+ trees and the Merkle trees start resident (both default to yes); how many dense tree chunks dropped trees keep cached between reads (`DEFAULT_TREE_CHUNKS` is 4,096, at most 128 MiB); where the application keeps every committed object, as a function from id to bytes (`objectStore`); the most bytes the arena's slabs may take with such a store behind it (`arenaBytes`, unbounded by default, and ignored without an object store); and where the application keeps each root's encoded history record, as a function from version to bytes (`historyStore`, of the exported type `HistoryFetch`), from which a past version the window in memory no longer holds is answered.
- `setDefaultIndexTrees(resident)` and `setDefaultTrees(resident)`: where the last two options default from, so that `test/setup.ts` can start every database of a run with a tier dropped (`INDEX_TREES=0`, `TREES=0`; [chapter 15](15-tests.md)).
- `interface DatabaseMemory { arena; arenaLimit; storedObjects; objects; hotObjects; hotLimit; historyBytes; history; historyWindow; lowestVersion; indexTrees; trees; treeChunks; treeChunkLimit; hotHits; hotMisses; chunkHits; chunkMisses }`: what `memory()` reports, for the memory guard and status: the arena's figures, its byte limit and how many committed objects have their bytes only in the store; the mode of each tier (`objects` is `resident` or `capped`, `history` is `resident` or `trimmed`, `indexTrees` is `resident`, `dropped` or `partial`, `trees` is `resident` or `dropped`), the decoded objects cached and their limit, the bytes of past values, how many past versions are kept in memory just now and the oldest version that can be asked for (with a history store, the oldest its records reach, whatever the window holds), the chunks cached and their limit, and the hit and miss counts of both caches.
- `estimateTiers(types, countOf)`: about how many bytes of heap the index trees and the Merkle trees of a set of types would take resident, from a count of objects per type, with the figures `rebuildEstimate()` uses (210 bytes per index entry, 2,000 per leaf of an authenticated index). The application calls it before it opens a store, with the type counters the store holds, to decide whether the tiers fit the heap ([chapter 11](11-application.md)).
- `interface ObjectChange { id; bytes | null }` and `interface Changes { version; objects; counters; history; indices; trees }`: what one `root()` changed, for a store. `indices` is the index entries added (with their value) and removed (null), as store keys, removals first; `trees` the dense tree chunks and sparse tree nodes written or deleted, whose values may be views of live chunks until `dropChanges()`.
- `interface HistoryRecord { trees; objects; counters; nodes }` and `TOP_TREE = 0`: what was true before one version.
- `encodeHistory(w, h)` / `decodeHistory(r)`: the record's wire form.
- `class UndoSession`: `created`, `modified`, `removed`, `counters`, `isActive`, `undo()`, `commit()`.
- `class ObjectDatabase`: everything else.

The record itself:

```ts
export interface HistoryRecord {
  /** Tree records by tree: a type id, or TOP_TREE for the tree over the types. */
  trees: { tree: number; records: TreeRecords }[];
  /** Before this version the object was these bytes, or did not exist. */
  objects: [ObjectId, Uint8Array | null][];
  /** Before this version the type's counter was this. */
  counters: [number, number][];
  /**
   * Before this version the sparse tree node under this store key was this encoding, or absent. Null when the
   * root kept no list (a database with no store and its trees resident) and in records written before there was one.
   */
  nodes: NodeRecord[] | null;
}
```

The first three fields are the dense trees' records, the objects' encodings before the version and the counters before it, as in the example under "Versions, history and the retention window". The fourth is the sparse trees' share: each `NodeRecord` is a node's store key and its encoding before the version, or null if there was no node under that key. With it a record holds everything its version overwrote, in every structure a proof reads, which is what lets a past version be read from the records alone. `nodes` is null when a tree kept no list of what it overwrote: a database with no store and resident trees does not ask its sparse trees to report, and has no use for the list.

The record's encoding is the one that ends up on disk under the application's `'h' || version` key:

```ts
export function encodeHistory(w: Writer, h: HistoryRecord): void {
  w.array(h.trees, (w, t) => {
    w.u16(t.tree).option(t.records.sizeBefore, (w, n) => w.u64(BigInt(n)));
    w.array(t.records.nodes, (w, [k, j, hash]) => w.u8(k).u64(BigInt(j)).fixed(hash));
  });
  w.array(h.objects, (w, [id, bytes]) => w.u64(id).option(bytes, (w, b) => w.bytes(b)));
  w.array(h.counters, (w, [type, n]) => w.u16(type).u64(BigInt(n)));
  w.option(h.nodes, (w, nodes) => w.array(nodes, (w, [key, before]) => w.bytes(key).option(before, (w, b) => w.bytes(b))));
}

export function decodeHistory(r: Reader): HistoryRecord {
  return {
    trees: r.array((r) => ({
      tree: r.u16(),
      records: {
        sizeBefore: r.option((r) => r.u53()),
        nodes: r.array((r) => [r.u8(), r.u53(), r.fixed(HASH_SIZE)] as [number, number, Uint8Array]),
      },
    })),
    objects: r.array((r) => [r.u64(), r.option((r) => r.bytes())] as [ObjectId, Uint8Array | null]),
    counters: r.array((r) => [r.u16(), r.u53()] as [number, number]),
    // A record written before the sparse nodes were kept ends here.
    nodes: r.remaining() === 0 ? null : r.option((r) => r.array((r) => [r.bytes(), r.option((r) => r.bytes())] as NodeRecord)),
  };
}
```

A dense node record is 1 + 8 + 32 bytes; a level fits in a u8 because heights are at most 48. The sizes, node indices and counters are plain numbers in memory and u64 in the record, so the decoder reads them with `u53()` ([chapter 1](01-codec.md)), which refuses a value too large to hold exactly where `Number(r.u64())` would round it. The objects carry their full "before" encoding, which is why DESIGN.md's simplification list notes that history is written in full per version. The sparse nodes come last, as an option of an array of key and optional encoding. A record written before the list existed ends after the counters, and `decodeHistory` reads it so: with nothing left to read, `nodes` is null. Every later record carries the option's flag byte, so the two cannot be confused. The fixed layout matters twice: a restart decodes records with `decodeHistory`, and a read of a past version from the store walks the same bytes without decoding them (`scanHistory`, under "Past versions from the store" below).

A session is a small record of what it first touched:

```ts
export class UndoSession {
  private readonly db: ObjectDatabase;
  readonly created = new Set<ObjectId>();
  /** id to the value it had when this session first touched it. */
  readonly modified = new Map<ObjectId, AnyObject>();
  readonly removed = new Map<ObjectId, AnyObject>();
  /** type to its counter when this session first created an object of it. */
  readonly counters = new Map<number, number>();
  private active = true;
```

`undo()` and `commit()` delegate to the database and mark the session inactive, so a second close throws.

**Construction.** The constructor sets the history window to the whole retention, makes the shared budget and the arena, with the database itself as the arena's owner, each question forwarded to the type the entry names, and notes the object store, the history store and the arena's limit; then the two views of the store that dropped tiers read through; then a `TypeIndex` (given the arena, the budget, the index view, whether its trees start resident, and the object store) and a `DenseMerkleTree` per type, both with the retention window, plus one top tree sized to the number of types:

```ts
  constructor(types: ObjectType<any>[], opts: DatabaseOptions = {}) {
    this.retain = Math.max(0, opts.retainVersions ?? DEFAULT_RETAIN);
    this.window = this.retain;
    this.hotBudget = { limit: Math.max(0, opts.hotObjects ?? DEFAULT_HOT), size: 0, hits: 0, misses: 0 };
    this.arena = new Arena({
      refOf: (type, instance) => this.types.get(type)?.refAt(instance) ?? -1,
      relocate: (type, instance, ref) => this.types.get(type)!.relocate(instance, ref),
      released: (type, instance) => this.types.get(type)!.released(instance),
    });
    this.objectStore = opts.objectStore ?? null;
    this.historyStore = opts.historyStore ?? null;
    this.arenaLimit = Math.max(0, opts.arenaBytes ?? Infinity);
    this.store = opts.indexStore ?? null;
    const resident = opts.indexTrees ?? defaultIndexTrees;
    if (!resident && !this.store) this.ownStore = new MemoryIndexStore();
    this.base = {
      get: (k) => {
        const v = this.unwrittenEntries()?.get(k);
        return v !== undefined ? (v ?? undefined) : this.backing()?.get(k);
      },
      range: (start, end) => {
        const stored = this.backing()?.range(start, end) ?? [][Symbol.iterator]();
        const pending = this.unwrittenEntries();
        return pending ? overlaid(stored, until(pending.entriesFrom(start), end)) : stored;
      },
    };
    this.chunkCache = new ChunkCache(opts.treeChunks ?? DEFAULT_TREE_CHUNKS);
    this.treeBase = {
      get: (k) => {
        const v = this.unwrittenEntries()?.get(k);
        return v !== undefined ? (v ?? undefined) : (this.store ?? this.ownTreeStore)?.get(k);
      },
      range: (start, end) => {
        const stored = (this.store ?? this.ownTreeStore)?.range(start, end) ?? [][Symbol.iterator]();
        const pending = this.unwrittenEntries();
        return pending ? overlaid(stored, until(pending.entriesFrom(start), end)) : stored;
      },
    };
    // Every type's tree and the tree over the types take a place in the chunk cache when the trees are dropped.
    if (types.length + 1 > MAX_SLOTS) throw new Error(`${types.length} object types: a database holds at most ${MAX_SLOTS - 1}`);
    for (const t of types) {
      if (this.types.has(t.id)) throw new Error(`duplicate object type ${t.id}`);
      if (t.id === TOP_TREE) throw new Error(`type id ${TOP_TREE} names the tree over the types`);
      this.types.set(t.id, new TypeIndex(t, this.retain, this.arena, this.hotBudget, this.base, resident, this.objectStore));
      this.trees.set(t.id, new DenseMerkleTree(this.retain, t.id));
    }
    this.order = [...this.types.keys()].sort((a, b) => a - b);
    this.top = new DenseMerkleTree(this.retain, TOP_TREE);
    this.top.resize(this.order.length);
    this.treesResident = true;
    if (!(opts.trees ?? defaultTrees)) this.dropTrees();
  }
```

`order` is the type ids sorted ascending; a type's position in it is its leaf in the top tree, so the app hash depends on the set of registered types and nothing else about registration order. Duplicate type ids throw, and so does type 0, which names the tree over the types in the store's chunk keys (the note under `src/db/id.ts` is answered here). So does a list of more than 511 types, before any tree is made: every type's dense tree and the tree over the types take a slot in the chunk cache when the trees are dropped, and the cache has 512 (`MAX_SLOTS`, exported by `src/db/merkle.ts`). The two views are the layering of "A dropped tier reads the store": `base`, which the types read their index entries through, is the backing store (the application's, or the in-memory stand-in a database without one builds when it first drops a tree) under the change lists of roots the application has not written yet, `unwritten`, which `unwrittenEntries()` turns into one map the first time something reads it; `treeBase` is the same over the store or the trees' own stand-in. Both stand-ins are what a store written at every root would hold now; the index one is built by `dropIndexTrees` from `indexEntries()` with the dirty set's changes taken back, the tree one by `dropTrees` from `treeEntries()`, and each goes when its tier is resident again. Every `DenseMerkleTree` is given its type id as its tree id, and a database asked to start with its trees dropped drops them at the end of construction, when the trees are empty.

**The dials.** Three pairs of methods turn the tiers down and up, two more set the history window and the arena's limit, and two report what the database holds:

```ts
  /** Change the hot caches' shared budget at run time (the memory guard's first dial); the excess is evicted at once. */
  setHotLimit(limit: number): void {
    this.hotBudget.limit = Math.max(0, limit);
    for (const ti of this.types.values()) ti.evict();
  }

  memory(): DatabaseMemory {
    const withIndices = [...this.types.values()].filter((ti) => ti.type.indices.length > 0);
    const resident = withIndices.filter((ti) => ti.resident).length;
    const indexTrees = resident === withIndices.length ? 'resident' : resident === 0 ? 'dropped' : 'partial';
    return {
      arena: this.arena.stats,
      arenaLimit: this.objectStore ? this.arenaLimit : Infinity,
      storedObjects: [...this.types.values()].reduce((n, ti) => n + ti.storedCount, 0),
      objects: this.hotBudget.limit === Infinity ? 'resident' : 'capped',
      hotObjects: this.hotBudget.size,
      hotLimit: this.hotBudget.limit,
      historyBytes: this.historyBytes,
      history: this.window === this.retain ? 'resident' : 'trimmed',
      historyWindow: this.window,
      lowestVersion: this.version < 0 ? 0 : this.lowestVersion,
      indexTrees,
      trees: this.treesResident ? 'resident' : 'dropped',
      treeChunks: this.chunkCache.size,
      treeChunkLimit: this.chunkCache.limit,
      hotHits: this.hotBudget.hits,
      hotMisses: this.hotBudget.misses,
      chunkHits: this.chunkCache.hits,
      chunkMisses: this.chunkCache.misses,
    };
  }
```

`setHotLimit` changes the shared limit and lets every type evict down to it at once; the node calls it on every level change of the memory guard, when its application is the core one ([chapter 8](08-node.md)). A limit below what is pinned is not met until the next root unpins: written objects stay whatever the budget. `memory()` reports the arena's `stats`, its limit (no limit when there is no object store, whatever was asked for) and the objects whose bytes are only in the store, summed over the types; each tier's mode, `history` being `trimmed` whenever the window is narrower than the retention; the index trees counted over the types that have indices so that a type without any does not make the answer `partial`; the decoded objects cached and their limit; the bytes of past values the window keeps, which `historyBytes` counts up as history is recorded or loaded and down as it is pruned, with the window's present width and the oldest version it reaches; the chunks cached for dropped trees and their limit; and the hit and miss counts of both caches, from which a rate follows; the RPC's `status` carries it all ([chapter 12](12-rpc.md)). The index tier's dial:

```ts
  /**
   * Drop the B+ trees of one type's secondary indices, or of every type's: lookups and scans then read the store,
   * with the writes since the last root laid over it. Sessions may be open; the overlay starts from what is dirty.
   */
  dropIndexTrees(type?: ObjectType<any>): void {
    if (!this.backing()) {
      // No application store: one in memory stands in, holding what a store written at every root would hold now,
      // the entries as of the last root (none before the first). That is the trees as they stand with the writes
      // since then taken back: a key a write took and released again before the drop must not linger in it.
      const own = new MemoryIndexStore();
      if (this.version >= 0) {
        for (const type of this.order) own.apply(Array.from(this.typeIndexById(type).indexEntries(), ([key, value]) => ({ key, value })));
        const removed: IndexEntryChange[] = [];
        const added: IndexEntryChange[] = [];
        for (const id of this.dirty) {
          const ti = this.typeIndexById(typeOf(id));
          const instance = instanceOf(id);
          ti.diffEntries(instance < ti.nextInstance ? (ti.get(instance) ?? null) : null, this.shadow.get(id) ?? null, removed, added);
        }
        own.apply(removed);
        own.apply(added);
      }
      this.ownStore = own;
    }
    for (const ti of type ? [this.typeIndex(type) as TypeIndex<AnyObject>] : this.types.values()) {
      if (!ti.resident) continue;
      const changed: [AnyObject | null, AnyObject | null][] = [];
      for (const id of this.dirty) {
        if (typeOf(id) !== ti.type.id) continue;
        const instance = instanceOf(id);
        changed.push([this.shadow.get(id) ?? null, instance < ti.nextInstance ? (ti.get(instance) ?? null) : null]);
      }
      ti.dropTrees(changed);
    }
  }

  /** Build the dropped B+ trees again from the store (and the overlay), for one type or for all. */
  rebuildIndexTrees(type?: ObjectType<any>): void {
    for (const ti of type ? [this.typeIndex(type) as TypeIndex<AnyObject>] : this.types.values()) ti.rebuildTrees();
    // The in-memory stand-in for a store is only there for dropped trees to fall back on.
    if (!this.store && [...this.types.values()].every((ti) => ti.resident)) this.ownStore = null;
  }
```

For each type the drop collects every dirty object of the type as the pair the overlay is built from, the value the root shadow holds (what the object was at the last root, null for one that did not exist) and the current value (null for one removed, or created and undone), and the type does the rest. Dropping with a store behind is cheap, since it touches only what is dirty; a database without one first builds the stand-in, the entries as the trees hold them with the dirty set's changes taken back (the diff run backwards, current value to committed value). Rebuilding reads a type's whole prefix, 295 ms for every type at 100,000 balances over LMDB (docs/benchmarks.md section 4.11). `indexTreesResident(type)` answers for one type, and the getter `treesAreResident` for the Merkle trees. The tree tier's dial is one method each way:

```ts
  /**
   * Drop every Merkle tree, the dense chunks and the sparse nodes together: from now on a root reads the paths it
   * changes from the store (dense chunks through the shared LRU) and writes the changed ones back through the change
   * list, and proofs walk the store. Sessions may be open: the trees hold nothing of them but the sparse trees'
   * writes, which become pending writes. Without an application store the trees go to a store in memory.
   */
  dropTrees(): void {
    if (!this.treesResident) return;
    if (!this.store) {
      // What a store written at every root would hold now: the trees as of the last root (nothing before the first).
      const own = new MemoryIndexStore();
      if (this.version >= 0) own.apply(Array.from(this.treeEntries(), ([key, value]) => ({ key, value })));
      this.ownTreeStore = own;
    }
    for (const tree of this.denseTrees()) tree.drop(this.treeBase, this.chunkCache);
    for (const smt of this.sparseTrees()) smt.drop(this.treeBase);
    this.treesResident = false;
  }

  /** Read every dropped tree back from the store and keep it resident again. */
  rebuildTrees(): void {
    if (this.treesResident) return;
    for (const tree of this.denseTrees()) tree.rebuild();
    for (const smt of this.sparseTrees()) smt.rebuild();
    this.chunkCache.clear();
    this.ownTreeStore = null;
    this.treesResident = true;
  }
```

The tree over the types, every type's tree and every authenticated index's sparse tree go together and come back together, and the chunk cache is emptied at the rebuild, its contents being resident again. Each dense tree takes a slot in the chunk cache at its first drop and keeps it, and the cache has 512 (`MAX_SLOTS` in `src/db/merkle.ts`), enough for 511 types and the top tree. The constructor refuses more types than that, so the loop never runs out of slots part of the way through. The application registers far fewer types. What the guard asks before rebuilding is the estimate:

```ts
  /**
   * About how many bytes of heap rebuilding what is dropped would take, per tier (0 for a resident one): every
   * committed object has one entry in each of its type's indices and one leaf in each authenticated index's sparse
   * tree, and a sparse tree also builds a node for each record its retained versions hold, the subtrees they share
   * with a newer version built once; the reads and keys a rebuild throws away count too (SPARSE_LEAF_GARBAGE). The
   * memory guard rebuilds only what fits.
   */
  rebuildEstimate(): { indexTrees: number; trees: number } {
    let entries = 0;
    let leaves = 0;
    let dropped = false;
    for (const ti of this.types.values()) {
      if (!ti.resident) {
        dropped = true;
        entries += ti.committedCount * ti.type.indices.length;
      }
      leaves += ti.committedCount * ti.authenticated.length;
    }
    let history = 0;
    if (!this.treesResident) for (const smt of this.sparseTrees()) history += smt.historyNodes;
    const trees = leaves * (SPARSE_LEAF_HEAP + SPARSE_LEAF_GARBAGE) + history * SPARSE_HISTORY_NODE_HEAP;
    // A dropped tier never reads zero, however empty, so that zero means nothing is dropped.
    return { indexTrees: dropped ? Math.max(1, entries * INDEX_ENTRY_HEAP) : 0, trees: this.treesResident ? 0 : Math.max(1, trees) };
  }
```

`INDEX_ENTRY_HEAP` is 210 bytes and `SPARSE_LEAF_HEAP` 1,000, what dropping the two tiers gave back at 192,000 accounts within a few percent (STATE-PAGING.md section 7). A rebuild of the sparse trees allocates more than it keeps: `SPARSE_LEAF_GARBAGE` is another 1,000 bytes per leaf, the encodings read from the store and the keys they are read by, which the collector takes back afterwards, and `SPARSE_HISTORY_NODE_HEAP` is 500 bytes per record of a retained version (`historyNodes`, the count each dropped sparse tree keeps of its records), the node built for that version with its reads. The guard compares the estimate with the heap's headroom, which garbage takes up as well, so the estimate counts what is allocated and not only what stays. It comes from the committed objects, not from what was resident when the trees went, so a database whose trees were dropped from the start can still say what rebuilding would cost (`test/db.test.ts` requires more than 2,000 bytes for each of 1,550 live items). The history window is the dial the guard turns down at `warn`, with the index trees, and lets grow back last, once both tiers are resident again ([chapter 8](08-node.md)):

```ts
  /**
   * Keep only the last `versions` past versions in memory from now on, never more than the database was made to
   * retain (STATE-PAGING.md section 7). Lowering it forgets the older ones at once, in the value history and in
   * every tree, and they stay forgotten: raising it again lets the window grow back one root at a time. Nothing a
   * block does reads a past version, so only proofs and queries at past heights notice. Every root still reports
   * its history record in full, so the store keeps the whole window and a restart has it back; and with a history
   * store, a version the window has forgotten is read from those records (past(), below), slower and no less right.
   */
  setHistoryWindow(versions: number): void {
    this.window = Math.max(0, Math.min(this.retain, versions));
    for (const tree of this.denseTrees()) tree.setWindow(this.window);
    for (const smt of this.sparseTrees()) smt.setWindow(this.window);
    if (this.version < 0) return;
    const min = this.version - this.window;
    if (min > this.floor) this.floor = min;
    this.pruneHistory(min);
  }

  get historyWindow(): number {
    return this.window;
  }

  // ...

  /** The newest version whose history record a store need no longer keep: the one that left the full window, trimmed or not. */
  get lastStaleVersion(): number {
    return this.version - this.retain;
  }

  /**
   * About how many bytes of heap the window of past versions holds: the past values, the dense trees' records, and
   * for the sparse trees the records kept while they are dropped or, resident, the nodes their retained commits
   * replaced. What trimming the window gives back, and what letting it grow again will take.
   */
  historyEstimate(): number {
    let dense = 0;
    for (const tree of this.denseTrees()) dense += tree.historyEntries;
    let sparse = 0;
    for (const smt of this.sparseTrees()) sparse += smt.historyNodes;
    return this.historyBytes + this.historyValues * VALUE_HISTORY_HEAP + dense * DENSE_HISTORY_HEAP + sparse * SPARSE_HISTORY_NODE_HEAP;
  }
```

`retain` is how many past versions the database records, fixed at construction; `window` is how many of them it keeps in memory just now. `setHistoryWindow` clamps the window to the retention, passes it to every dense and sparse tree (`setWindow`, above), raises the floor to the oldest version still kept and prunes the value and counter history below it. All of that happens at once: the heap is given back when the call returns, not as roots go by. Raising the window, which the node does with `Infinity` or with its `retain.memoryVersions` ([chapter 8](08-node.md)), prunes nothing and brings nothing back. The window in memory begins at the larger of the floor and `version - window` (the private `windowStart`), and `root()` raises the floor as the trimmed window moves (the excerpt at the end of step 3), so after the window is widened the floor stays where the trimmed window left it and the window grows by one version per root until it is `retain` wide.

What the store keeps is deliberately not the window's business. A root records history whenever `retain > 0`, whatever the window, so `lastChanges.history` is complete at every root, and `lastStaleVersion`, the version whose record the application may delete, is counted from `retain`. The store therefore holds the whole configured window while the one in memory is trimmed, and a restart reads it back ([chapter 11](11-application.md)). Nothing in a block reads a past version, so trimming changes no root. What a trimmed database does differently depends on whether it has a history store. Without one, `lowestVersion` is the start of the window in memory, and `checkVersion` refuses a version below it with `version ... is not available`. With one, `lowestVersion` stays where the store's records reach and the version is read from them, which the next passage describes.

`historyEstimate()` is what the node notes before it trims and compares with the heap's room before it widens: the bytes of the past values, and per past value, per dense tree record and per sparse tree record a rough figure for the entry and its slots in the maps (`VALUE_HISTORY_HEAP` 150, `DENSE_HISTORY_HEAP` 250, `SPARSE_HISTORY_NODE_HEAP` 500). The sparse trees are counted in either mode through `historyNodes`: dropped, they hold a record for each node a retained commit overwrote; resident, their past versions are root pointers sharing most nodes with the current tree, and what they do not share is the nodes the retained commits replaced, which each tree counts in `replaced` (above). So the estimate the node takes at `warn`, with the Merkle trees still resident, includes the sparse trees' past versions.

**Past versions from the store.** A trimmed window, or a store opened without reading its window back ([chapter 11](11-application.md)), leaves the database with fewer past versions in memory than the store has history records for. Given the application's store of those records (`historyStore`), the database answers for the versions in between from the records. Two things change: what `lowestVersion` says, and where a read below the window in memory goes.

```ts
  /**
   * The oldest version proofs can still be made for: the oldest in the window in memory, or, with a store of
   * history records, the oldest the records reach, which trimming the window does not change.
   */
  get lowestVersion(): number {
    if (!this.historyStore) return this.windowStart;
    return Math.min(this.windowStart, Math.max(this.storedFloor, this.version - this.retain));
  }

  /** The oldest version the window in memory describes. */
  private get windowStart(): number {
    return Math.max(this.floor, this.version - this.window);
  }

  // ...

  /**
   * The store holds the history record of `version`, which this database was not given (loadHistory): a store
   * opened without reading its window back. The records are taken to be there for every version from it to the current one.
   */
  noteStoredHistory(version: number): void {
    if (version - 1 < this.storedFloor) this.storedFloor = Math.max(0, version - 1);
    let i = this.recorded.length;
    while (i > 0 && this.recorded[i - 1]! > version) i--;
    if (this.recorded[i - 1] !== version) this.recorded.splice(i, 0, version);
  }
```

`windowStart` is the old `lowestVersion`: the oldest version the window in memory describes. Without a history store that is still the answer. With one, the answer is the oldest version the store's records reach, `max(storedFloor, version - retain)`, or `windowStart` should that be lower. The second term is the edge of the configured window, below which the application has deleted the records (`lastStaleVersion`). `storedFloor` is the oldest version the records present can describe: `root()` sets it, with `floor`, to the version of the first root, before which there are no records; `loadHistory` lowers it for each record it is given, by calling `noteStoredHistory`; and the application calls `noteStoredHistory(version)` directly for each record it leaves in the store when it opens a store paged. A record for version v describes v-1, hence the `version - 1`. Trimming the window raises `floor` and leaves `storedFloor` alone, so `lowestVersion` does not move.

`noteStoredHistory` also enters the version in `recorded`, the ascending list of the versions inside the full window that have a history record. `root()` appends each version after the first to it (the first root overwrites nothing and has no record) and drops from its front the versions that have left the full window, `version - retain` and below, whose records the application deletes. It is the database's own account of which records the store must hold, and the scan below goes by it.

A read of a past version begins by saying what it will look at, and gets back what the records say of it:

```ts
/** What a read of a past version needs from the store's records: the entries it will look at, and no others. */
interface Wanted {
  objects: Set<ObjectId>;
  counters: Set<number>;
  /** By tree (a type id, or TOP_TREE), node positions. */
  trees: Map<number, Set<number>>;
  /** Sparse tree nodes, by nodeString of their store keys. */
  nodes: Set<string>;
}

/** What the records say of them: for each one a version after the one asked about changed, what it was before the first such change. */
interface Past {
  objects: Map<ObjectId, Uint8Array | null>;
  counters: Map<number, number>;
  trees: Map<number, PastTree>;
  nodes: PastNodes;
}

/** Bytes of one tree node in a history record: level u8, index u64, hash. */
const NODE_RECORD = 9 + HASH_SIZE;
```

`Wanted` is four sets: object ids, type ids for counters, node positions by dense tree, and sparse tree store keys as strings. `Past` has a map for each, filled only with the entries some later version changed. `past()` does the scan:

```ts
  /**
   * What the store's records say of `want` as of a version older than the window in memory, or null for a version
   * the window holds. Each record says what its version overwrote, so the records of every version after the one
   * asked about are scanned, oldest first, and the first to name an entry has its value then; an entry none of them
   * names has not changed since and is read as it is now. The last root's record may not be in the store yet: it
   * is taken from the change list the application is still to write. A record the store should hold and does not
   * is a refusal: without it an entry it named would be read as it is now, a wrong answer with nothing to show for it.
   */
  private past(version: number, ask: () => Partial<Wanted>): Past | null {
    // What is wanted is worked out only when the store is asked: for a version in memory, which is nearly every
    // call, listing the entries a proof would read costs more than the proof.
    if (!this.historyStore || version >= this.windowStart) return null;
    const want = ask();
    const wanted: Wanted = { objects: want.objects ?? new Set(), counters: want.counters ?? new Set(), trees: want.trees ?? new Map(), nodes: want.nodes ?? new Set() };
    const past: Past = { objects: new Map(), counters: new Map(), trees: new Map(), nodes: new Map() };
    // Every tree asked about is answered for, also one no record names: nothing has changed it since.
    for (const tree of wanted.trees.keys()) past.trees.set(tree, { size: null, nodes: new Map() });
    for (const v of this.recorded) {
      if (v <= version) continue;
      const unwritten = this.changes?.version === v ? this.changes.history : null;
      const record = unwritten ? encode((w) => encodeHistory(w, unwritten)) : this.historyStore(v);
      if (!record) throw new RangeError(`version ${version} is not available: the store has no history record of version ${v}`);
      if (!scanHistory(record, wanted, past)) throw new RangeError(`version ${version} is not available: the record of version ${v} was written without the sparse tree nodes`);
    }
    return past;
  }
```

It returns null at once for a database without a history store and for a version the window in memory holds; every caller then reads memory as before, so the common case pays one comparison. Otherwise it loops over the recorded versions after the one asked about, oldest first, fetching each record from the store. The newest may not be there yet: between `root()` and the application's write, the last root's record exists only in `changes.history`, and it is encoded on the spot so that one scanner serves both. The loop runs over `recorded` and not over every version number, so a version at which no root was taken is never asked for, and a version in the list whose record the store does not return is a record that has gone missing. That is a refusal, `version N is not available: the store has no history record of version V`: scanning on without it would read whatever that version overwrote as it is now, a wrong answer with nothing to show for it. (As first written the loop ran over the version numbers and skipped a version with no record as one with no root, which is exactly that wrong answer on a damaged store.) Each tree asked about gets a `PastTree` before the scan, since a tree no record names must still be answered for: unchanged, as it is now.

The scanner is where the order of the loop becomes the rule "the first record to name an entry wins":

```ts
/**
 * Take from one encoded history record what `want` names and `past` does not have yet. Records are scanned in
 * ascending version order, so what is found first is what was true at the version asked about. The record is
 * walked where it lies, by the layout encodeHistory gives it, and only the entries wanted are copied out: a record
 * is some hundreds of kilobytes, a read wants a few dozen entries of it, and decoding it whole for each would cost
 * the memory the trimmed window was to save. Returns false if sparse nodes are wanted and the record has no list of them.
 */
function scanHistory(b: Uint8Array, want: Wanted, past: Past): boolean {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  const u32 = () => ((p += 4), view.getUint32(p - 4));
  const u64 = () => ((p += 8), view.getUint32(p - 8) * 2 ** 32 + view.getUint32(p - 4));
  const bytes = () => {
    const n = u32();
    return b.subarray(p, (p += n));
  };
  for (let trees = u32(); trees > 0; trees--) {
    const tree = view.getUint16(p);
    p += 2;
    const sizeBefore = b[p++] === 1 ? u64() : null;
    const count = u32();
    const wanted = want.trees.get(tree);
    if (wanted) {
      const found = past.trees.get(tree)!;
      if (found.size === null) found.size = sizeBefore;
      for (let i = 0, q = p; i < count; i++, q += NODE_RECORD) {
        const position = nodePosition(b[q]!, view.getUint32(q + 1) * 2 ** 32 + view.getUint32(q + 5));
        if (wanted.has(position) && !found.nodes.has(position)) found.nodes.set(position, b.slice(q + 9, q + NODE_RECORD));
      }
    }
    p += count * NODE_RECORD;
  }
  for (let objects = u32(); objects > 0; objects--) {
    const id = view.getBigUint64(p);
    p += 8;
    const before = b[p++] === 1 ? bytes() : null;
    if (want.objects.has(id) && !past.objects.has(id)) past.objects.set(id, before && before.slice());
  }
  for (let counters = u32(); counters > 0; counters--) {
    const type = view.getUint16(p);
    p += 2;
    const count = u64();
    if (want.counters.has(type) && !past.counters.has(type)) past.counters.set(type, count);
  }
  if (want.nodes.size === 0) return true;
  if (p === b.length || b[p++] !== 1) return false;
  for (let nodes = u32(); nodes > 0; nodes--) {
    const key = nodeString(bytes());
    const before = b[p++] === 1 ? bytes() : null;
    if (want.nodes.has(key) && !past.nodes.has(key)) past.nodes.set(key, before && before.slice());
  }
  return true;
}
```

It reads the record with a `DataView` and a position, following the layout `encodeHistory` writes: a u32 count of trees, and per tree a u16 id, an optional u64 size, a u32 count and that many 41-byte node records; a u32 count of objects, each a u64 id and optional length-prefixed bytes; a u32 count of counters, each a u16 and a u64; and the optional list of sparse nodes. In every section the test is the same: the entry is wanted, and `past` does not have it yet. Because the records are scanned in ascending version order, the first record to name an entry is the earliest change after the version asked about, and what it holds, the value before that change, is the value at that version. A later record naming the same entry holds a later value and is ignored. For a tree's size the test is `found.size === null`, and a record that names the tree without having changed its size contributes `null` and leaves the question open for the next.

Nothing is decoded that is not wanted. A tree that is not wanted is skipped in one step (`p += count * NODE_RECORD`); in a wanted one each node's position is computed from its nine header bytes and only a hit copies the hash out. Unwanted objects cost reading a length. The copies (`slice()`) matter: the record is a view of the store's memory, valid only for as long as the store says, and what is returned outlives it. A record of a block of scattered transfers is some hundreds of kilobytes with tens of thousands of entries, and a proof wants a few dozen of them; decoding every record of the window whole for each read would allocate, per read, about what the trimmed window was holding. As written, a read allocates its few dozen entries and drops them when it returns. Nothing is cached between reads, so the cost of a trimmed window is paid in the time of past reads and not in memory: a read from the records is slower than one from memory, more so the further back the version, since every later record is scanned. Measured at 192,000 accounts under blocks of 440 to 570 transfers, an account proof takes 0.08 ms from memory, 8.9 ms fifty versions back and 20 ms a hundred back in the published run, 0.1 to 0.35 ms per record across the runs (docs/benchmarks.md section 4.13).

The function returns false in one case: sparse nodes are wanted and the record has no list of them, either because it ends after the counters (written before the list existed) or because its option is absent (`nodes: null`). `past()` turns that into `RangeError: version ... is not available: the record of version ... was written without the sparse tree nodes`. A read that wants no sparse node returns before the check, so objects, counters and dense tree nodes are read from such records without complaint.

What a proof wants is put together by two helpers:

```ts
  /** The entries of the dense trees a proof through a type's tree (to one instance of it, if given) and the top tree reads. */
  private wantedTrees(type: number, instance?: number): Map<number, Set<number>> {
    return new Map([
      [type, new Set(this.trees.get(type)!.pastPositions(instance))],
      [TOP_TREE, new Set(this.top.pastPositions(this.order.indexOf(type)))],
    ]);
  }

  /** The root nodes of a type's authenticated indices, and with an index and a key, the nodes down the key's path in it. */
  private wantedNodes(ti: TypeIndex<AnyObject>, index?: string, key?: Uint8Array): Set<string> {
    const out = new Set<string>();
    for (const name of ti.authenticated) for (const k of ti.trees.get(name)!.pastKeys(name === index ? key : undefined)) out.add(nodeString(k));
    return out;
  }
```

`wantedTrees` asks the type's tree and the top tree for the positions a root and a path may read at any past version (`pastPositions`, under the dense tree above). `wantedNodes` asks each authenticated index's sparse tree for its root node's key, since a type leaf carries every index root, and for the index a key proof is about, every key down the path (`pastKeys`). Step 5 below shows the proof methods using them.

The last piece of the machinery is `dropChanges`, with the arena's limit after it:

```ts
  /**
   * Forget the last change list once a store has written it; it holds the encoded bytes of every changed object.
   * It is also the word that the store now holds the index entries, so dropped indices read them from there.
   */
  dropChanges(): void {
    this.changes = null;
    this.unwritten = [];
    this.unwrittenMap = null;
    for (const tree of this.denseTrees()) tree.release();
    // And that it holds every committed object, so the arena may let go of what is over its limit.
    this.objectsStored = this.version >= 0;
    this.shrinkArena();
  }

  // ---- the object tier ----

  private shrinkArena(): void {
    if (this.objectStore && this.objectsStored && this.arenaLimit !== Infinity) this.arena.shrink(this.arenaLimit);
  }

  /**
   * Hold the arena within this many bytes from now on (Infinity: no limit). It takes effect at once if the store
   * holds every committed object, and otherwise when the application has written the last root (dropChanges). The
   * current slab always stays, so the arena never goes below it. Ignored without an object store.
   */
  setArenaLimit(bytes: number): void {
    this.arenaLimit = Math.max(0, bytes);
    this.shrinkArena();
  }
```

Until the application calls it, every root since the last write lays its index and tree changes over the store (`unwritten`), so a dropped index or tree between `finalizeBlock` and `commit` reads what the root said and not what the store still says, and the dense trees keep their handed-out chunks copy-on-write. `test/db.test.ts` delays the write of some roots on purpose and reads in between.

The same call is the word that the store holds every committed object, which is what the arena's limit waits for. Between a root and the application's write of it, the encodings the root wrote are in the arena and nowhere else; a slab released then would lose them. So `root()` clears `objectsStored`, `dropChanges()` sets it, and `shrinkArena()` does nothing unless it is set, there is an object store and a limit was given. With all three, `Arena.shrink` releases slabs down to the limit and each type marks the objects that were in them `STORED` (under `src/db/arena.ts` and `src/db/index.ts`). `setArenaLimit` changes the limit at run time and shrinks at once if the store is up to date; lifting the limit releases nothing and brings nothing back, since a read never refills the arena. Nothing in the node calls it: the limit is given once, at construction, from the CLI's `--arena` ([chapter 14](14-wallet-cli.md)), because the slabs are outside the heap the memory guard measures and the guard has no figure to turn this dial by.

**Reads.** `get(type, id)` is a map lookup for the type and then the type index's `get`, a cache hit or a decode from the arena (or from the store's copy, for an object the arena let go), and returns null if the id's type does not match. `lookup(type, index, key)` is an exact match on a unique index. `scan` and `range` are prefix scans on any index, yielding objects in key order. `scanFrom(type, index, start)` yields `[key, object]` pairs from the first key at or after `start` to the end of the index, with no prefix test: it exists for paged listings, where the caller holds the last key it served and wants to resume just past it, and it yields the key alongside the object so the caller can tell where the next page starts. `nextInstance(type)` is the live counter. All of these see the live state, sessions included; the committed view is separate.

**Life of a change, step 1: writing inside a session.** `create` allocates the next instance, deep-freezes the object, checks that it carries the id it was given, and inserts it into the type index (which enforces unique keys, updates the sparse trees and pins the object in the hot cache). Then it records what the root and the session will need:

```ts
    const obj = deepFreeze(init(id));
    if (obj.id !== id) throw new DbError('object must carry the id it was given');
    ti.insert(obj);
    if (!this.counterShadow.has(type.id)) this.counterShadow.set(type.id, ti.nextInstance);
    if (!this.shadow.has(id)) this.shadow.set(id, null);
    const s = this.session;
    if (s) {
      if (!s.counters.has(type.id)) s.counters.set(type.id, ti.nextInstance);
      s.created.add(id);
    }
    ti.nextInstance++;
    this.dirty.add(id);
```

The `shadow` map remembers, for every object written since the last root, its value at that root (null for one that did not exist), and only the first write sets it. `counterShadow` does the same for counters. `dirty` is the set of ids `root()` must look at. The session, if one is open, gets the same first-touch records in its own maps. `deepFreeze` (from `src/db/freeze.ts`, above) is what backs "immutable records" at runtime: the old value the undo log and the shadow point at cannot be changed in place by whoever modifies the object next.

`modify(type, id, fn)` reads the current object, deep-freezes `fn(old)`, refuses a changed id, and reinserts:

```ts
    const next = deepFreeze(fn(old));
    if (next.id !== id) throw new DbError('modify may not change the id');
    ti.insert(next);
    if (!this.shadow.has(id)) this.shadow.set(id, old);
    const s = this.session;
    if (s && !s.created.has(id) && !s.modified.has(id)) s.modified.set(id, old);
    this.dirty.add(id);
    return next;
```

The session records `old` only if the session neither created nor already modified the object, so a session's `modified` holds the value from before the session's first touch. `remove` erases and then moves the id through the session's state machine:

```ts
    ti.erase(old);
    if (!this.shadow.has(id)) this.shadow.set(id, old);
    const s = this.session;
    if (s) {
      if (s.created.has(id)) s.created.delete(id);
      else if (s.modified.has(id)) {
        s.removed.set(id, s.modified.get(id)!);
        s.modified.delete(id);
      } else s.removed.set(id, old);
    }
    this.dirty.add(id);
```

Created in this session, forget it; modified in this session, move the original old value to `removed`; otherwise record the current value in `removed`. All three writes end with `this.dirty.add(id)`.

**Step 2: closing a session.** `startSession` pushes a new `UndoSession`; `sessionDepth` tells how many are open. Both closes go through `popSession`, which throws `DbError` if the session is already closed or is not the innermost. `undoSession` restores in a deliberate order:

```ts
    // Erase first, then put old values back, so a restored unique key never collides
    // with a value that is itself about to go.
    for (const id of s.created) {
      const ti = this.typeIndexById(typeOf(id));
      const cur = ti.get(instanceOf(id));
      if (cur) ti.erase(cur);
      this.dirty.add(id);
    }
    for (const id of s.modified.keys()) {
      const ti = this.typeIndexById(typeOf(id));
      const cur = ti.get(instanceOf(id));
      if (cur) ti.erase(cur);
    }
    for (const [id, old] of s.modified) {
      this.typeIndexById(typeOf(id)).insert(old);
      this.dirty.add(id);
    }
    for (const [id, old] of s.removed) {
      this.typeIndexById(typeOf(id)).insert(old);
      this.dirty.add(id);
    }
    for (const [type, before] of s.counters) this.typeIndexById(type).truncate(before);
```

The erase-then-insert order is what makes "undo restores unique keys that were swapped around" in `test/db.test.ts` pass: if a and b exchanged names through a temporary, restoring a's name while b still holds it would throw. Counters roll back through `truncate`, which forgets every instance from the old counter on, so the next create reuses the instance that the undone create had taken. The old values go back into the hot cache through `insert`, pinned like any write, and nothing touches the arena. Note that every undone id is added to `dirty`; `root()` will compare it against the shadow and find nothing changed.

`commitSession` folds a session into its parent, or does nothing more than pop if there is no parent (the changes are already in the live state):

```ts
    const parent = this.session;
    if (!parent) return;
    for (const [type, before] of s.counters) if (!parent.counters.has(type)) parent.counters.set(type, before);
    for (const id of s.created) parent.created.add(id);
    for (const [id, old] of s.modified) {
      if (parent.created.has(id) || parent.modified.has(id)) continue;
      parent.modified.set(id, old);
    }
    for (const [id, old] of s.removed) {
      if (parent.created.has(id)) parent.created.delete(id);
      else if (parent.modified.has(id)) {
        parent.removed.set(id, parent.modified.get(id)!);
        parent.modified.delete(id);
      } else parent.removed.set(id, old);
    }
```

The fold applies the same first-touch rules as the writes: the parent keeps its own counters and old values where it has them, inherits the child's where it does not, and a removal of something the parent created cancels out. This is the nested case: a checked transaction's session commits into the pending session, and if the pending session is later undone, the transaction's effects go with it; inside a block the parent is the block's session.

**The committed view.** `getCommitted` and `committedNextInstance` read the root shadow:

```ts
  /**
   * The object as of the last root(), whatever has been written since, inside a session or outside one: the first
   * write to an object after a root keeps the value it had at that root, for the next root to compare with.
   */
  getCommitted<T extends AnyObject>(type: ObjectType<T>, id: ObjectId): T | null {
    if (this.shadow.size > 0) {
      const before = this.shadow.get(id);
      if (before !== undefined) return before as T | null;
    }
    return this.get(type, id);
  }

  /** A type's instance counter as of the last root(): the first create after a root keeps it. */
  committedNextInstance(type: number): number {
    return this.counterShadow.get(type) ?? this.typeIndexById(type).nextInstance;
  }
```

The root shadow the writes keep (above) is the committed view. It holds, for every object written since the last root, the value the object had at that root, null for one that did not exist then, and `root()` empties it. So an id the shadow has is answered from it, a created one as null and a modified or removed one as its old value, and an id it does not have has not been written since the root, so the live object is the committed one. It does not matter where the write was made: in an open session, in a session committed or undone since, or with no session open at all, since every write goes through the same first-touch record. `committedNextInstance` is the same for a type's counter. `getAt`, `bytesAt`, `countAt` and `proofAt` for the last root, or for any version since the object last changed in a root, end in these two (`bytesIn` reads the shadow itself, below), so a proof made between two roots verifies against the root of its version whatever has been written since. Before the first root there is no committed state, and every object created so far is answered as null. The application writes only inside the block's session or the mempool's after genesis, but the view does not depend on that. `test/db.test.ts` ("proofs describe committed state while a session is open") shows a proof made with a session open verifying against the root computed before it, and `src/app/core/app.ts` serves its account, balance and global-object queries through `getCommitted` for the same reason (review finding 19 was about RPC methods that read live state instead).

**Step 3: `root(version)`.** This is the only method that touches the dense trees, and the only one that commits a version of a sparse tree (a resident sparse tree has already taken each write as it was made). It refuses to run with a session open and requires versions to increase; the first root sets the floor and marks every type touched so that every type leaf is written. Then it decides what the root reports for the index tier and runs the dirty loop:

```ts
    // The index entries this root changes. The first root of a database writes every entry, since the store holds
    // none of them yet, unless the objects came from a store that does (a restart); after that, each changed
    // object's committed keys against its new ones. A database with no store to keep (none given, trees resident)
    // reports none.
    const removed: IndexEntryChange[] = [];
    const added: IndexEntryChange[] = [];
    const first = this.version < 0;
    const reportIndices = this.backing() !== null;
    if (reportIndices && first && !this.importsIndexed) for (const type of this.order) for (const [key, value] of this.typeIndexById(type).indexEntries()) added.push({ key, value });
    for (const id of this.dirty) {
      const type = typeOf(id);
      const ti = this.typeIndexById(type);
      const tree = this.trees.get(type)!;
      tree.resize(ti.nextInstance);
      const instance = instanceOf(id);
      if (instance >= ti.nextInstance) continue; // created and undone: it never existed
      const pending = ti.pending(instance);
      let bytes: Uint8Array | null;
      if (pending === undefined) {
        // Imported straight into the arena (the first root after an import): hash the bytes as they are.
        bytes = ti.bytesOf(instance)?.slice() ?? null;
      } else {
        const before = this.shadow.get(id);
        if (before !== undefined && before === pending) {
          ti.settle(instance); // written and written back
          continue;
        }
        // Encoded once here, however many times it was modified since the last root.
        bytes = pending ? encode((w) => ti.type.encode(w, pending)) : null;
        if (reportIndices && !first) ti.diffEntries(before ?? null, pending, removed, added, instance);
        ti.flush(instance, bytes);
        if (keepHistory && before !== undefined) {
          const beforeBytes = before ? encode((w) => ti.type.encode(w, before)) : null;
          let entries = this.valueHistory.get(id);
          if (!entries) this.valueHistory.set(id, (entries = []));
          entries.push({ v: version, bytes: beforeBytes });
          this.historyValues++;
          this.historyBytes += beforeBytes?.length ?? 0;
          historyIds.push(id);
          record.objects.push([id, beforeBytes]);
        }
      }
      tree.setLeaf(instance, bytes ? objectLeaf(id, bytes) : EMPTY);
      objects.push({ id, bytes });
      touched.add(type);
    }
    this.dirty.clear();
    this.shadow.clear();
    // The trees' changes go to the store whenever there is one, and always while the trees are dropped, the store
    // being where they live; not from the first root of a restart, whose trees the store already has.
    const reportTrees = (this.store !== null && !(first && this.treesStored)) || !this.treesResident;
    const treeChanges: StoreChange[] = [];
    const indices = removed.length === 0 ? added : removed.concat(added);
    // The store dropped indices read must say what this root says before the overlays are emptied.
    if (this.store) {
      if (indices.length > 0) {
        this.unwritten.push(indices);
        if (this.unwrittenMap) for (const c of indices) this.unwrittenMap.set(c.key, c.value);
      }
    } else this.ownStore?.apply(indices);
    // Pins are off; each type's hot cache comes back under the budget in one pass.
    for (const ti of this.types.values()) ti.afterRoot();
    if (historyIds.length > 0) this.valueHistoryByVersion.set(version, historyIds);
```

Each dirty id falls into one of four cases. An instance at or past the counter was created and undone, and never existed. An instance with nothing pending was put straight into the arena by `importObject` (the first root after an import, which is the restart path): its committed bytes are hashed as they are, with no decode and no encode, and copied out of the slab with `slice()` because the change list must outlive the next compaction. A pending value that is the same reference as the shadow was written and written back (a modify undone, an object created and removed again) and is settled and skipped, which is why `test/db.test.ts` ("reports what each root changed") sees neither `b` nor `c` in the change list. Everything else is encoded once, however many times it was modified since the last root, has its index changes reported through `diffEntries` (the committed keys against the current ones, from the keys the writes kept), is flushed into the arena (which frees the old entry and unpins the object), hashed into its leaf and pushed onto the change list; when history is kept (`retain > 0` and this is not the first root), the value before is encoded too and remembered as bytes, both in `valueHistory` and in the record a store will write, and counted in `historyBytes`. The comparison is by reference, not by value: an object modified to an equal but distinct record is treated as changed, hashed, and reported, which is harmless. The index entries are reported whenever there is a store to keep them, the application's or the in-memory stand-in; the first root of a database reports every entry, the genesis, unless the objects were imported with their entries already in the store (a restart), and after that only what changed. The trees are reported whenever there is an application store, except from the first root of a restart whose trees the store already holds, and always while they are dropped, the store being where they live then. Before the overlays are emptied, the root's index changes are laid over the store (`unwritten`) or applied to the stand-in, so a dropped index keeps answering what the root says. Then nothing is pinned, and `afterRoot` brings every type's cache back under the budget and clears the overlays.

Counters follow the same pattern:

```ts
    const counters = new Map<number, number>();
    for (const [type, before] of this.counterShadow) {
      const now = this.typeIndexById(type).nextInstance;
      if (now === before) continue;
      counters.set(type, now);
      touched.add(type);
      if (keepHistory) {
        let entries = this.counterHistory.get(type);
        if (!entries) this.counterHistory.set(type, (entries = []));
        entries.push({ v: version, count: before });
        record.counters.push([type, before]);
      }
    }
    this.counterShadow.clear();
```

Then every type tree advances, touched or not, so that historical reads line up across trees, and each one's changed chunks and nodes are collected:

```ts
    // Every tree advances to the version, touched or not, so historical reads line up.
    for (const type of this.order) {
      const ti = this.typeIndexById(type);
      const tree = this.trees.get(type)!;
      tree.resize(ti.nextInstance);
      tree.reporting = reportTrees;
      const typeRoot = tree.root(version);
      for (const c of tree.takeChunks()) treeChanges.push(c);
      const indexRoots = ti.authenticated.map((name) => {
        const smt = ti.trees.get(name)!;
        const r = smt.commit(version, reportTrees);
        for (const c of smt.takeNodes()) treeChanges.push(c);
        // What the commit overwrote goes into the history record; one tree without a list leaves the record without.
        const overwritten = smt.takeRecords();
        if (overwritten && record.nodes) for (const n of overwritten) record.nodes.push(n);
        else record.nodes = null;
        return r;
      });
      const previous = this.lastIndexRoots.get(type);
      if (!previous || indexRoots.some((r, i) => !bytesEqual(r, previous[i]!))) touched.add(type);
      this.lastIndexRoots.set(type, indexRoots);
      if (touched.has(type)) this.top.setLeaf(this.order.indexOf(type), typeLeaf(type, BigInt(ti.nextInstance), typeRoot, indexRoots));
      const recs = tree.lastRecords;
      if (keepHistory && (recs.nodes.length > 0 || recs.sizeBefore !== null)) record.trees.push({ tree: type, records: recs });
    }
    this.top.reporting = reportTrees;
    const root = this.top.root(version);
    for (const c of this.top.takeChunks()) treeChanges.push(c);
    if (keepHistory && this.top.lastRecords.nodes.length > 0) record.trees.push({ tree: TOP_TREE, records: this.top.lastRecords });
    // As with the index entries: dropped trees must read what this root wrote before the store has it.
    if (this.store) {
      if (treeChanges.length > 0) {
        this.unwritten.push(treeChanges);
        if (this.unwrittenMap) for (const c of treeChanges) this.unwrittenMap.set(c.key, c.value);
      }
    } else this.ownTreeStore?.apply(treeChanges);
    this.version = version;
    this.changes = { version, objects, counters, history: keepHistory ? record : null, indices, trees: treeChanges };
```

A type leaf is rewritten when its objects changed, its counter moved, or any authenticated index root changed. The sparse trees are committed here and nowhere else, so their versions coincide with the dense trees'. Whether the trees report their changes is set per root (`reporting`, and `commit`'s second argument), and whatever a root over resident trees changed in a type's tree, in its sparse trees and in the top tree is taken from each one once and gathered into `treeChanges`; a root over dropped trees reports the same way, its private copies and the nodes it wrote. The top tree's records go in under `TOP_TREE`. Each sparse tree is also asked for what its commit overwrote (`takeRecords()`), and those node records are gathered into `record.nodes`, which starts as an empty list; a tree that kept no list (the root did not ask it to report, there being no store) makes `record.nodes` null for the whole record, since a list that is not complete could not be trusted to say that a node was unchanged. The tree changes are laid over the store, or applied to the stand-in, like the index changes, and the version advances and `lastChanges` is set with both lists; then the floor is raised if a trimmed window has moved past it, and `pruneHistory(version - window)` drops object and counter history that only serves versions outside the window, taking its bytes off `historyBytes` and its entries off `historyValues`, and mirroring the tree's `prune` (the trees prune themselves inside their own `root`), including the guard against an id whose entries an earlier version's pass already emptied. The very last step is the arena's:

```ts
    // What a trimmed window forgot stays forgotten when the window is widened again.
    if (version - this.window > this.floor) this.floor = version - this.window;
    if (this.retain > 0) this.pruneHistory(version - this.window);
    // Slabs the block left more than half dead are compacted now, while the node idles.
    this.arena.maintain();
    return root;
```

A block rewrites every object it touches, so the slabs written before it collect dead entries; the ones with nothing live left are released here and the ones now more than half dead are copied out and released, slab by slab until the copies reach what the block wrote (16 MiB at least; the last slab is finished even when it passes that). The change list is safe from it: every object encoding in it is a fresh one or a copy, not a view into the arena (a dense tree's chunks in the list are views into the tree's own buffers, which the tree copies before it writes to them again).

**Step 4: what the store does with it.** `lastChanges` holds the encoded bytes of every changed object, the index entries added and removed and the chunks and nodes changed, and `src/app/core/app.ts` writes them in one key-value transaction: a put or delete per object, the index entries in order (removals first), the chunks and nodes, the moved counters, the history record under `'h' || version`, a delete of the history record for the version that just left the full window (`lastStaleVersion`, not the trimmed window's edge), and the height and app hash. Then it calls `dropChanges()`. Review finding 36 is why that method exists: the change list after genesis is a second copy of the whole state, and after a restart the same again (the root was then recomputed over every object; a restart now takes the trees from the store, step 6), measured at 500 MiB per gigabyte of genesis; `test/genesis.test.ts` asserts `db.lastChanges` is null in both situations. Since phase two it is also the word that the store is up to date, as described with `dropChanges` above. `test/db.test.ts` checks the lists against the store after every root: written to a `MemoryKv`, the `'i'` keys equal `indexEntries()` and the `'t'` and `'n'` keys equal `treeEntries()`, and `checkIndexStore()` finds nothing to report.

**Step 5: proofs at any version in the window.** `checkVersion` requires a computed root and a version in `[lowestVersion, currentVersion]`, where `lowestVersion` is the start of the window in memory or, with a history store, the oldest version the store's records reach ("Past versions from the store" above). `getAt(type, id, version)`, `bytesAt(id, version)` and `countAt(type, version)` are the historical reads:

```ts
  /** The object as of a past version inside the retention window. */
  getAt<T extends AnyObject>(type: ObjectType<T>, id: ObjectId, version: number): T | null {
    this.checkVersion(version);
    const before = this.past(version, () => ({ objects: new Set([id]) }))?.objects.get(id);
    if (before !== undefined) return before ? deepFreeze(decode(before, (r) => type.decode(r, id))) : null;
    const entries = this.valueHistory.get(id);
    if (entries) for (const e of entries) if (e.v > version) return e.bytes ? deepFreeze(decode(e.bytes, (r) => type.decode(r, id))) : null;
    return this.getCommitted(type, id);
  }

  // ...

  /** The encoding of an object as of a past version inside the window, without decoding it: for snapshots and proofs. */
  bytesAt(id: ObjectId, version: number): Uint8Array | null {
    this.checkVersion(version);
    return this.bytesIn(this.past(version, () => ({ objects: new Set([id]) })), id, version);
  }

  /** As bytesAt, with what the store's records say if the version is older than the window. */
  private bytesIn(past: Past | null, id: ObjectId, version: number): Uint8Array | null {
    const before = past?.objects.get(id);
    if (before !== undefined) return before;
    const entries = this.valueHistory.get(id);
    if (entries) for (const e of entries) if (e.v > version) return e.bytes;
    const ti = this.typeIndexById(typeOf(id));
    // As getCommitted: an object written since the last root is read as of that root.
    if (this.shadow.size > 0) {
      const old = this.shadow.get(id);
      if (old !== undefined) return old ? encode((w) => ti.type.encode(w, old)) : null;
    }
    return ti.bytesFor(instanceOf(id)) ?? null;
  }

  countAt(type: number, version: number): number {
    this.checkVersion(version);
    return this.countIn(this.past(version, () => ({ counters: new Set([type]) })), type, version);
  }

  private countIn(past: Past | null, type: number, version: number): number {
    const before = past?.counters.get(type);
    if (before !== undefined) return before;
    const entries = this.counterHistory.get(type);
    if (entries) for (const e of entries) if (e.v > version) return e.count;
    return this.committedNextInstance(type);
  }
```

Each read asks `past()` first, naming the one object or counter it is about. For a version inside the window in memory that is null and the read goes on as it always did; for an older one the map either has the entry, whose value (null for an object that did not exist) is the answer, or does not, which means nothing has changed it since and the read falls through to the current value. `bytesIn` and `countIn` are `bytesAt` and `countAt` with the result of a `past()` call the caller has already made, so that a proof, which needs the object, the counter and the tree nodes at once, scans the records once and not once per piece. In memory, the first entry with `v > version` holds the value before that later change, which is the value at `version`, as bytes, decoded and frozen here; with no such entry the committed value is right, so a historical read also looks past whatever has been written since the last root, as the versions test checks with a session open. `bytesAt` is the same walk without the decode: a history entry's bytes as they are, else the encoding of the value the root shadow holds for an object written since the last root (null for one created since, as `getCommitted` answers), else the type index's current encoding, which is a view into the arena when nothing is pending. Snapshot export ([chapter 11](11-application.md)) and proofs take their bytes from it.

`getAt` answers for one id, and the caller has to know which. For a type whose objects are removed, the indices do not say: an index is of now, and an object removed since a past version is not in it. `changedSince(type, version)` gives the ids that are missing:

```ts
  /**
   * Every object of a type that a version after `version` created, changed or removed, or that the block in
   * progress removed. An index is of now: it lists what exists, and an object removed since a past version is not
   * in it. These together with the objects of now are all that can have existed at that version, so a query about
   * a past version reads each as of then (getAt) and keeps what was there.
   */
  changedSince(type: ObjectType<any>, version: number): ObjectId[] {
    this.checkVersion(version);
    const out = new Set<ObjectId>();
    for (const [v, ids] of this.valueHistoryByVersion) if (v > version) for (const id of ids) if (typeOf(id) === type.id) out.add(id);
    // Versions the window in memory no longer holds are in the store's records, one read and one decode each.
    if (this.historyStore && version < this.windowStart) {
      for (const v of this.recorded) {
        if (v <= version || v > this.windowStart) continue;
        let record = this.changes?.version === v ? this.changes.history : null;
        if (!record) {
          const stored = this.historyStore(v);
          if (!stored) throw new RangeError(`version ${version} is not available: the store has no history record of version ${v}`);
          record = decode(stored, decodeHistory);
        }
        for (const [id] of record.objects) if (typeOf(id) === type.id) out.add(id);
      }
    }
    for (const s of this.sessions) for (const id of s.removed.keys()) if (typeOf(id) === type.id) out.add(id);
    return [...out];
  }
```

It reads three places. `valueHistoryByVersion` is the window in memory's list, per version, of the ids that version wrote history for, and every id of the type under a later version is taken. For a version older than the window in memory the store's history records say the same for the versions the window no longer holds: each recorded version after the one asked for and no later than the oldest the window describes (`v > this.windowStart` is passed over, the list in memory having those) has its record read once and decoded, the record of a root the store has not been given yet taken from the pending change list, and the ids of its `objects` are taken; a record that is missing is refused as `not available`, as `past()` refuses it. Last come the objects the block in progress removed, which the live index no longer lists while the last root still holds them. The result is ids and nothing more: the caller joins them with the objects the index gives now and reads each with `getAt`, which returns null for one that did not exist at the version. The RPC's `validator` and `delegation` do that for delegations and unbonding entries ([chapter 12](12-rpc.md)). The cost, when the version is older than the window in memory, is one record read and decoded for each version between the one asked for and the window, each record once and none of the versions the window holds; otherwise it is nothing but the walk over the in-memory lists.

`proofAt(id, version)` assembles the proof:

```ts
  /** Inclusion or absence proof for an id as of a version inside the retention window. */
  proofAt(id: ObjectId, version: number): ObjectProof {
    this.checkVersion(version);
    const type = typeOf(id);
    const ti = this.typeIndexById(type);
    const tree = this.trees.get(type)!;
    const instance = instanceOf(id);
    const past = this.past(version, () => ({ objects: new Set([id]), counters: new Set([type]), trees: this.wantedTrees(type, instance), nodes: this.wantedNodes(ti) }));
    const count = this.countIn(past, type, version);
    const idx = this.order.indexOf(type);
    return {
      height: BigInt(version),
      id,
      value: this.bytesIn(past, id, version)?.slice() ?? null,
      nextInstance: BigInt(count),
      typeRoot: tree.rootAt(version, past?.trees.get(type)),
      typeSiblings: instance < count ? tree.pathAt(instance, version, past?.trees.get(type)) : [],
      indexRoots: ti.authenticated.map((name) => ti.trees.get(name)!.rootAt(version, past?.nodes)),
      typeIndex: idx,
      typeCount: this.order.length,
      topSiblings: this.top.pathAt(idx, version, past?.trees.get(TOP_TREE)),
    };
  }
```

One `past()` call names everything the proof reads: the object, the type's counter, the positions on the two dense paths and the root nodes of the type's authenticated indices. Its result is handed to each piece, `past?.trees.get(type)` to the type's tree, `past?.nodes` to the sparse trees, and each piece answers from it where it has an entry and from the present where it has none. For a version in the window `past` is null, every `past?.` is undefined, and the calls are the ones this method always made. The value is a copy (`slice()`), since what `bytesIn` returns may be a view into a slab that a later compaction releases. `proof(id)` is `proofAt` at the current version. `typeLeafProofAt(type, version)` returns just the type leg, which the snapshot manifest uses for every type and the importer checks against the header's app hash; `rangeProofAt(type, from, to, version)` returns the siblings for a chunk of instances; `rootAt(version)` is the app hash at a version; `typeOrder` exposes the leaf order. `proveKeyAt(type, index, key, version)` and `proveKey` build a `KeyProof` from the index's sparse tree at that version plus the same type leg, throwing `DbError` if the index is not authenticated. Each of them makes its own `past()` call in the same way: `typeLeafProofAt` wants the counter, the tree positions and the index roots; `rangeProofAt` the positions beside the range (`pastRangePositions`), after a `checkVersion` it did not use to make; `rootAt` the top tree's candidate roots; and `proveKeyAt` what `typeLeafProofAt` wants plus every node down the key's path (`wantedNodes(ti, index, key)`), handing `past?.nodes` to the sparse tree's `proveAt`. README.md measures a past-height object proof with verification at 39,900 per second on the gigabyte state, about an eighth below the current-height figure, because the history lookups are a few map reads per node.

**Step 6: a restart.** `openObjectDatabase` in `src/app/core/app.ts` ([chapter 11](11-application.md)) imports every stored object with `importObject(id, bytes, indexed)`, allowed only before the first root and with no session open; with `indexed`, which is the case for every store written since phase two, the bytes go into the arena as they are and the object is not decoded at all, and otherwise it is decoded once for its index keys, as before; either way the counter is bumped past the instance. Then it sets the counters with `setCounter` (which refuses a counter below an imported object), and takes the indices and the trees from the store:

```ts
  /**
   * After importing objects whose index entries the store holds (importObject with `indexed`): fill the sparse
   * trees, and the B+ trees where resident, from the store's entries instead of decoding every object. With `check`
   * (the default), the entries must then be exactly the ones the objects make: no entry missing, none extra and none
   * naming another object. Nothing in the app hash covers an unauthenticated index, so without this a damaged entry
   * would quietly send a lookup, and the writes that follow it, to the wrong object. It decodes every object of a
   * type with indices, once, keeping none.
   */
  loadIndexEntries(check = true): void {
    if (!this.store || this.importsIndexed !== true || this.version >= 0) throw new DbError('index entries are loaded from the store only after an indexed import');
    // The sparse trees come from the entries unless their nodes are already in place: loaded, or in the store a
    // dropped tree reads.
    const sparse = this.treesResident ? !this.treesLoaded : !this.treesStored;
    for (const ti of this.types.values()) ti.loadIndexEntries(sparse);
    if (check) for (const ti of this.types.values()) ti.checkEntries();
  }
```

```ts
  /**
   * After importing objects whose trees the store holds as of the version about to be rooted (a restart): take the
   * trees from the store instead of computing them, so the first root hashes no object and inserts no key, and
   * reports nothing. With `checkLeaves`, what is taken is checked first, resident or dropped: every dense node above
   * a leaf must be the hash of its children and every sparse node must hash to what its parent says, so the root the
   * caller compares with the app hash commits to every leaf; every imported object must hash to its leaf; and each
   * type's tree must have no more non-empty leaves than objects, so no leaf has lost its object.
   */
  loadTrees(checkLeaves = false): void {
    if (!this.store || this.importsIndexed !== true || this.version >= 0) throw new DbError('trees are loaded from the store only after an indexed import');
    if (this.treesResident) {
      for (const tree of this.denseTrees()) tree.load(this.treeBase);
      for (const smt of this.sparseTrees()) smt.load(this.treeBase, checkLeaves);
    }
    if (checkLeaves) {
      for (const type of this.order) this.trees.get(type)!.resize(this.typeIndexById(type).nextInstance);
      this.top.verify();
      for (const type of this.order) {
        const ti = this.typeIndexById(type);
        const leaves = this.trees.get(type)!.verify();
        if (leaves !== ti.committedCount) throw new DbError(`${ti.type.name}: the stored tree has ${leaves} leaves for ${ti.committedCount} objects`);
      }
      if (!this.treesResident) for (const smt of this.sparseTrees()) smt.verifyStored();
      for (const id of this.dirty) {
        const ti = this.typeIndexById(typeOf(id));
        const bytes = ti.bytesOf(instanceOf(id));
        if (bytes && !bytesEqual(objectLeaf(id, bytes), this.trees.get(typeOf(id))!.node(0, instanceOf(id)))) throw new DbError(`object ${id} does not hash to its leaf in the stored tree`);
      }
    }
    this.dirty.clear();
    this.treesStored = true;
    this.treesLoaded = true;
  }

  /** The store holds the trees as of the version the first root computes, which computes them again anyway (a restart): report none. */
  assumeStoredTrees(): void {
    if (!this.store || this.version >= 0) throw new DbError('only a database about to take its first root over a store can assume its trees are stored');
    this.treesStored = true;
  }
```

`loadTrees` is the default path: every dense tree reads its chunks and every sparse tree its nodes from the store (a database whose trees start dropped reads nothing, the store being what it reads anyway), and `dirty` is cleared, so the first root hashes no object and inserts no key, and reports no tree changes (`treesStored`). The root it then computes equals the stored app hash by construction unless the store is inconsistent, so by itself it would no longer prove that the objects hash to it; with `checkLeaves`, which `openObjectDatabase` passes by default, the trees are checked as well as the objects. Every non-empty dense node above the leaves must be the hash of its two children (`verify()` on the tree over the types and on each type's tree, which returns the number of non-empty leaves, and that number must be the type's object count, so no leaf has lost its object), every sparse node must hash to what its parent says (the `check` argument of the sparse tree's `load`, or `verifyStored()` for a tree that starts dropped and reads the store), and every imported object is hashed and compared with its leaf. The root the application compares with the app hash then commits to every leaf and every leaf to its object, which keeps what the old path had: a corrupt store fails at startup, not when something reads the object. `assumeStoredTrees` is the old path kept beside it (`fromTrees: false`): the trees are computed from the objects as always, and the database is only told not to report chunks the store already has. Then `loadIndexEntries` fills the B+ trees from the `'i'` prefix, and the sparse trees too unless their nodes are already in place, and with `check`, the default, has every type run `checkEntries`: each committed object is decoded once for its keys, each key must be stored naming that object, and each index must hold as many entries as the type has objects. Nothing in the app hash covers an unauthenticated index, so this is the only thing between a damaged entry and a lookup that quietly lands on the wrong object. Measured at 191,896 accounts (STATE-PAGING.md 5.3), before these checks were made in full: the trees from the store with the leaf check 5.18 s, without it 4.56 s, computed from the objects 8.46 s. The tree check adds about 0.78 s and the index entry check about 0.46 s to that. The application then calls `root(height)`, compares with the stored app hash, writes whatever a store from before these phases is missing (that root's index or tree changes), drops the change list, and feeds back the history records inside the window in ascending version order with `loadHistory(version, rec)`:

```ts
  loadHistory(version: number, rec: HistoryRecord): void {
    if (this.version < 0 || version > this.version) throw new DbError(`cannot load history for version ${version}`);
    this.noteStoredHistory(version);
    if (version - 1 < this.floor) this.floor = Math.max(0, version - 1);
    if (version <= this.lowestVersion) return;
    // Every tree can answer for version - 1: the ones this record names from their records, the rest
    // because nothing touched them, so their later state is also their state then.
    this.top.lowerFloor(version - 1);
    for (const tree of this.trees.values()) tree.lowerFloor(version - 1);
    for (const t of rec.trees) (t.tree === TOP_TREE ? this.top : this.trees.get(t.tree))?.loadRecords(version, t.records);
```

It then keeps each object's "before" bytes in `valueHistory` exactly as the store gave them back, decoding nothing (a past value is decoded only when a past version is read), counts them in `historyBytes`, and restores the counter history. The ascending order comes for free from the store: history keys are `'h'` followed by a big-endian u64, so a range scan yields them in version order. The floor is lowered to `version - 1` because a record for v describes the state at v-1, and `noteStoredHistory` lowers `storedFloor` the same way, a record that is loaded being one the store holds. The record's `nodes` are kept for step 7 and not used here: the method ends with

```ts
    if (rec.nodes) this.loadedNodes?.set(version, rec.nodes);
    else this.loadedNodes = null;
```

so `loadedNodes` holds the sparse tree records of every version given back, by version, or is null once one record came without its list (written before the lists were kept, or by a database that kept none).

The two `lowerFloor` lines are the fix for review finding 44. A record names only the trees that changed in its version, and a `DenseMerkleTree`'s floor used to move only inside `loadRecords`, so a type whose objects did not change anywhere in the window (accounts on a quiet chain, where only balances move) kept its floor at the restart height, and `proofAt` for one of its objects at an earlier version threw `RangeError: version ... is not available` from `tree.rootAt` while `lowestVersion` admitted the version. Lowering every tree's floor is sound for exactly the reason the comment gives: a tree the record does not name was untouched in that version, so its current hashes are its hashes then. The regression test in `test/review.test.ts` reopens a store after three transfer blocks and proves both a balance (changed in every retained version) and the faucet account (changed in none) at height 2.

**Step 7: restoring index history.** Sparse-tree versions are root pointers into an in-memory structure, so they do not survive a restart; the store holds the current tree's nodes, and its overwritten ones inside the history records. `restoreIndexVersions()`, which the application calls once the history is loaded, gives every authenticated index its past versions again, from those records when it can:

```ts
  /**
   * After the history has been loaded: give every authenticated index its past versions again, so key proofs at
   * past heights work. From the records' sparse tree nodes when every record given back had them, each older
   * version built from what the commit after it overwrote and sharing the rest (SparseMerkleTree.loadVersions),
   * which costs the nodes the window's blocks changed; otherwise, or if a record does not hold a node a version
   * needs, by replaying the keys from the object history (rebuildIndexVersions), which costs every key. Returns
   * which was used.
   */
  restoreIndexVersions(): 'records' | 'replay' | 'none' {
    if (this.version < 0 || this.sessions.length > 0) throw new DbError('restoring needs a root and no open session');
    const loaded = this.loadedNodes;
    this.loadedNodes = new Map();
    const lowest = this.lowestVersion;
    if (lowest === this.version) return 'none';
    if (loaded) {
      // Each tree's records, by the first bytes of their store keys (nodeHeader).
      const byTree = new Map<string, Map<number, NodeRecord[]>>();
      for (const [v, nodes] of loaded) {
        for (const n of nodes) {
          const header = nodeString(n[0].subarray(0, 4));
          let versions = byTree.get(header);
          if (!versions) byTree.set(header, (versions = new Map()));
          let list = versions.get(v);
          if (!list) versions.set(v, (list = []));
          list.push(n);
        }
      }
      try {
        for (const ti of this.types.values()) {
          for (const name of ti.authenticated) {
            const tree = ti.trees.get(name)!;
            tree.loadVersions(lowest, byTree.get(nodeString(tree.rootKey.subarray(0, 4))) ?? new Map());
          }
        }
        return 'records';
      } catch {
        // The records do not describe these trees; the replay below replaces every one of them, whatever this left.
      }
    }
    this.rebuildIndexVersions();
    return 'replay';
  }
```

It takes `loadedNodes` and resets it, and returns `'none'` if there is no past version to restore. With a list from every record, it sorts the records by tree: a node's store key begins with its tree's four-byte header (`'n'`, the type, the index position; `nodeHeader` in `src/db/smt.ts`), so the first four bytes of a key, as a string, name the tree, and the same four bytes of a tree's `rootKey` find its records. Each tree then gets its records by version through `loadVersions` (`src/db/smt.ts`, above), a tree no record names getting an empty map, which sets every past version to the current tree. That is `'records'`, and it costs the nodes the window's blocks changed. If a record came without its list (`loaded` is null), or `loadVersions` throws because a record lacks a node a version needs or holds one that does not hash to what its parent says, the method falls back on `rebuildIndexVersions()` and returns `'replay'`; the replay builds fresh trees and replaces every one, so whatever the failed attempt left in a tree does not matter. The application logs which of the three it was ([chapter 11](11-application.md)).

`rebuildIndexVersions` is what a restart always did before the records carried the nodes, and is now the fallback. It reconstructs the versions from the object history, which is possible only because the tree has one shape per key set:

```ts
      for (const name of ti.authenticated) {
        const rebuilt = ti.freshTree(name);
        const put = (obj: AnyObject | null) => obj && rebuilt.set(ti.keyFor(obj, name), encode((w) => w.u64(obj.id)));
        const drop = (obj: AnyObject | null) => obj && rebuilt.delete(ti.keyFor(obj, name));
        for (const id of candidates) put(this.getAt(ti.type, id, lowest));
        rebuilt.commit(lowest);
        for (let v = lowest + 1; v <= this.version; v++) {
          // Every key a version released is dropped before any it took, or a swap of keys between two objects would erase one.
          const changed = (this.valueHistoryByVersion.get(v) ?? []).filter((id) => typeOf(id) === type);
          for (const id of changed) {
            const e = this.valueHistory.get(id)!.find((e) => e.v === v)!;
            drop(e.bytes ? decode(e.bytes, (r) => ti.type.decode(r, id)) : null);
          }
          for (const id of changed) put(this.getAt(ti.type, id, v));
          rebuilt.commit(v);
        }
        if (!bytesEqual(rebuilt.rootHash(), ti.trees.get(name)!.rootHash())) throw new DbError(`${ti.type.name}.${name}: rebuilt index does not match the live one`);
        ti.replaceTree(name, rebuilt);
      }
```

The candidates are every present instance of the type (`instances()`, which decodes nothing) plus every id of the type with history. The history holds bytes, so the keys a version released are found by decoding each changed object's earlier bytes in the loop, and `getAt` decodes the values it puts. The tree is built at the lowest version, committed, then replayed one version at a time. The comment on the inner loop is review finding 12: the first version of this code dropped and re-added per object, so when two objects swapped keys in one block (validator keys A to temporary, B to A, temporary to B), a later drop erased a key the previous put had just taken, and every affected node failed to restart with "rebuilt index does not match the live one". Dropping every released key before putting any taken key fixes it; `test/review.test.ts` reproduces the swap. The final check against the live root is the safety net: if the rebuild is wrong in any way, the node refuses to start rather than serve wrong proofs. The rebuilt tree is made by `freshTree`, so it carries the index's node header, and `replaceTree` drops it to the store first when the tree it replaces is dropped, turning its versions into before-image records. README.md's large-genesis figures show what it cost: of the 11.8 s restart of the first build measured, 3.7 s was this rebuild, which is why it notes the authenticated name index is "built twice, once live and once to recover past versions"; with the indices and the trees loaded from the store, this replay was most of what was left of a restart (STATE-PAGING.md 5.3: 3.5 s of history at height 1 in a 5.2 s restart), which is why `restoreIndexVersions` takes the versions from the records when it can (the restart measured with it: 2.85 s in all, 2 ms of it the history). The method returns early when `lowestVersion === version`, that is, when no history was loaded.

**Bulk import and export.** `importObject(id, bytes, indexed)` loads one object into a fresh database:

```ts
  /**
   * Load one object into an empty database, before the first root(). Counters are set separately. With `indexed`,
   * the index store already holds the object's index entries (a restart from the application's store): the object
   * is not decoded at all, and loadIndexEntries() builds the indices from the store once every object is in.
   */
  importObject(id: ObjectId, bytes: Uint8Array, indexed = false): void {
    if (this.version >= 0 || this.sessions.length > 0) throw new DbError('import only into a fresh database');
    if (this.importsIndexed !== null && this.importsIndexed !== indexed) throw new DbError('an import is indexed or not throughout');
    if (indexed && !this.store) throw new DbError('an indexed import needs the index store');
    this.importsIndexed = indexed;
    const ti = this.typeIndexById(typeOf(id));
    // Decoded once for its index keys and not kept: the arena holds the bytes, the first root hashes them as they are.
    // An indexed import comes from the store, so what does not fit the arena's limit can stay there.
    if (indexed && this.objectStore && this.importedBytes + bytes.length > this.arenaLimit) ti.importStored(instanceOf(id));
    else if (indexed) {
      ti.importBytes(instanceOf(id), bytes);
      this.importedBytes += bytes.length;
    } else ti.importCommitted(decode(bytes, (r) => ti.type.decode(r, id)), bytes);
    if (instanceOf(id) >= ti.nextInstance) ti.nextInstance = instanceOf(id) + 1;
    this.dirty.add(id);
  }
```

Without `indexed` (a snapshot, or a store from before phase two) the object is decoded once, because its index keys are computed from the decoded form, and then dropped: `importCommitted` keeps the bytes in the arena, and the id is marked dirty so the first root hashes them as they are. With `indexed` nothing is decoded; the indices come from the store afterwards (`loadIndexEntries`), which needs a store to come from, and an import is indexed or not throughout, since the first root must know whether to report every entry. An indexed import comes from the application's store, so with an object store and an arena limit the bytes need not all be loaded: `importedBytes` adds up what went into the arena, and an object that would take it past the limit is imported with `importStored`, a `STORED` reference and no copy. Whatever then needs its bytes (the check of every object against its leaf, or a first root that hashes the objects) reads them through the store, and the `dropChanges()` that follows the first root shrinks the arena to its limit as after any root. `treeEntries()` and `indexEntries()` yield every chunk and node, and every index entry, as they stand, which `writeImportedState` in `src/app/core/app.ts` writes into an empty store after a state-sync import. `exportObjects()` yields every object of every type in id order as encoded bytes, walking `instances()` and taking `bytesFor`, so nothing is decoded: the bytes are views into the arena (or the store's copy, or a pending value's encoding), good until the next compaction, and `src/app/core/app.ts` writes them to the store at once. `counters()` returns the counters. `encodeSnapshot(height, appHash)` writes `SNAPSHOT_VERSION` (2), the height, the hash, and per type in order the counter and the present objects:

```ts
      w.array(this.order, (w, type) => {
        const ti = this.typeIndexById(type);
        const present = [...ti.instances()];
        w.u16(type).u64(BigInt(ti.nextInstance));
        w.array(present, (w, instance) => {
          w.u64(objectId(type, instance));
          w.bytes(ti.bytesFor(instance)!);
        });
      });
```

Each object's bytes come from `bytesFor`, so a snapshot decodes nothing and encodes only an object written since the last root, whose bytes are not made yet. It refuses to run with a session open and is deterministic, which `test/db.test.ts` checks by re-encoding the loaded copy. `loadSnapshot(bytes)` is the inverse into a fresh database, rejecting an object whose id does not match its type section or lies at or past the section's counter, and returns the height and app hash the snapshot claims so the caller can compare them with `root()`. It requires one section for every registered type, in the order `encodeSnapshot` writes them:

```ts
      let sections = 0;
      r.array((r) => {
        const type = r.u16();
        if (sections >= this.order.length || type !== this.order[sections]) throw new DbError(`snapshot section ${sections} is of type ${type}, where type ${this.order[sections] ?? 'none'} belongs`);
        sections++;
        const next = r.u53();
        r.array((r) => {
          const id = r.u64();
          if (typeOf(id) !== type || instanceOf(id) >= next) throw new DbError('snapshot object out of range');
          this.importObject(id, r.bytes());
        });
        this.setCounter(type, next);
      }, this.order.length);
      if (sections !== this.order.length) throw new DbError(`snapshot has ${sections} of ${this.order.length} type sections`);
```

A snapshot that leaves a type out, repeats one or names one out of order is refused with a `DbError` here, before the caller compares the root, which used to be the only guard. The section's counter is read with `u53()`. The state-sync path in `src/app/core/snapshot.ts` does not use this format; it uses `importObject` and `setCounter` directly, chunk by chunk, and checks `typeLeafProofAt` for every type against the manifest, whose `verifyManifest` does make the strict check: the manifest must name every registered type exactly once, in id order.

## How it is tested

`test/db.test.ts` is the unit suite for this directory. Its cases and what each proves:

- "assigns dense ids and serves unique and range lookups": ids are `7.0, 7.1, 7.2`; a unique lookup finds by exact key and not by prefix; a non-unique index scans a group in order; a duplicate name throws `DbError`; modify moves an object between groups; remove clears the name and leaves the counter at 3, so the next create is `7.3`.
- "undoes and commits nested sessions": an inner undo restores an outer modification, a removed object and a counter; the committed view sees through both sessions; an inner commit folds into the outer; the outer undo takes everything back, including the counter, so a later create reuses instance 1.
- "undo restores unique keys that were swapped around": the erase-before-insert order in `undoSession`.
- "refuses out-of-order session closes and a root with sessions open": `popSession` and the `root()` precondition.
- "roots change with every write and prove inclusion and absence": every proof verifies and fails with a tampered value, a different id, or a different root; absence beyond the counter has no path and fails with a forged counter; a type with no objects proves absence; proofs survive the codec; a modify changes the root and invalidates the old proof; a removed instance is an empty leaf with a full-length path.
- "keeps proofs valid as the tree grows across powers of two, and matches a from-scratch build": the root climbing a level does not break anything, and the root is a function of the state, not of how it was built.
- "proofs describe committed state while a session is open": the committed view feeds proofs.
- "snapshots round-trip with the same root and rebuilt indices": `encodeSnapshot` / `loadSnapshot`, including a hole from a removed object, and determinism of the bytes.
- `test/review4.test.ts`, "refuses a snapshot that leaves a type out, repeats one or names one out of order": the snapshot of an empty database over the core types loads, and is then rebuilt from its sections (each a type, a counter and an empty count, 14 bytes) with the last one dropped (`/of \d+ type sections/`), the last one replaced by a copy of the first (`/snapshot section/`) and the first two swapped (`/snapshot section 0/`); `loadSnapshot` throws each time.
- "dense merkle tree: matches a naive computation and proves every leaf at every size": `DenseMerkleTree` against a from-scratch fold for 1 to 11 leaves, every path at every size.
- "releases chunks whose nodes are all empty, and hashes holes like a fresh tree": 4,096 leaves allocate 17 chunks (4 + 2 + 1 at levels 0 to 2, one at each of levels 3 to 12); emptying the first half releases 3; the root equals a fresh tree with only the second half; emptying everything reaches `EMPTY` with no chunks.
- "serves paths at past versions inside the window and forgets older ones": with retention 3, every version in the window reproduces its root and every path, a leaf beyond the old size throws, and a version outside the window is refused.
- "object database: reproduces at a later version the proofs it made at the time": with retention 5 over 12 versions of creates, modifies and removes across two types, `proofAt` at every old version produces byte-identical proofs to the ones made at the time; `getAt` reads through an open session.
- "reports what each root changed, for a persistent store": the change list contents, including that an undone modify and a create-then-remove are not reported.
- "b+ tree: agrees with a reference map under random inserts, overwrites and deletes" and "scans prefixes and ranges in order after sequential inserts": correctness of the tree, including deletion down to empty, prefix scans of 256 keys, and `entriesFrom` after deleting every other key.
- "sparse merkle tree: has one shape per key set whatever the history, and proves presence and absence": 3,000 random writes and deletes equal a sorted rebuild; membership and absence proofs fold to the root; claiming another leaf's value for the queried key does not fold; a version keeps the old tree after everything is deleted.
- "keeps past versions inside the window": `proveAt` and `rootAt` inside a window of 2, refusal outside.
- "counts the nodes its past versions hold while resident, and gives them up with the window": a resident tree made to retain four versions takes eight commits that list their changes; `historyNodes` is at least 4, each of the four retained commits having replaced at least the root. `setWindow(1)` leaves fewer, at least 1, and `setWindow(0)` leaves 0. A second tree whose commits do not list their changes counts 0.
- "object database: key proofs: proves index keys and rebuilds index versions from history": present names prove to their id and absent ones to null at every version; then a fresh database is fed `exportObjects`, `counters`, `loadHistory` for every version and `rebuildIndexVersions`, and every key proof and object proof in the window is byte-identical to the original's. This keeps the replay, now the fallback of a restart, tested on its own.
- "object database: key proofs: proves an entry of a non-unique index present or absent, by its key and the id of its object": membership and absence proofs of `byGroup` entries (the group followed by the id), the index's root unmoved by a write that changes no key, the entries following a change of group and a removal, and the same root in a database filled from the exported objects. The test type's `byGroup` is authenticated, so every other case of the file runs with a non-unique authenticated index as well.
- "object database: arena and hot cache: serves reads from the arena once decoded objects are evicted, and never evicts what is dirty": with a budget of two, five unrooted objects stay cached, pinned, until the root; then the cache keeps its budget while every object reads correctly from the arena, frozen, by id and by name; a removal is a tombstone that hides the object and leaves it out of the export before the root frees its bytes; and with a budget of zero a modified object stays cached until the root, then reads back from the arena.
- "keeps history as bytes, agrees between getAt and bytesAt, and exports after churn what it holds": with a budget of one, `bytesAt` at every version is the encoding of what `getAt` returns, `historyBytes` is counted, every exported object is the encoding of what `get` returns, and the window still closes behind.
- "computes the same roots whatever the cache budget": five versions of creates, modifies and removes give the same roots with a budget of zero as with a million.
- "keeps the budget when the cached objects sit far apart among the instances, as after churn": a thousand objects imported at instances from 1,000,000 up and read once are all cached, and `setHotLimit(10)` leaves ten; in a database of 10,000 objects with the first 9,900 removed, the last hundred are cached under no limit, `setHotLimit(0)` leaves none, and reading them again keeps the cache empty, each fresh decode making room for itself at once.
- "undoes a session in proportion to what it created, not to the objects already cached": 2,000 sessions that each create one object and are undone leave the counter and the cache as they were, and take less than five times as long, plus 5 ms, with 200,000 objects cached as with 1,000, which is `truncate` walking only the instances the session created.
- "object database: index entries and dropped index trees: reports every index entry a root adds and removes, so a store written from them equals the trees": the first root reports every entry; a key changing hands in one block reports its removals before its additions; a value-only change and an object created and removed before a root report nothing; written to a `MemoryKv`, the store equals `indexEntries()` and `checkIndexStore()` is clean, and notices a deleted entry.
- "answers lookups and merged scans from the store and the overlay while the trees are dropped": lookups and scans from the store, pending inserts in order and pending removals skipped, a key removed and re-taken yielding its new owner, uniqueness against the overlay and the store, an undone session restoring the overlay, a read between a root and its write seeing the root's changes, and a rebuild changing nothing.
- "drops and rebuilds with the same roots and lookups as resident trees, under random writes and sessions": twelve seeds of 400 random steps on a resident twin and a dropping one, with the database's own store and with an injected `MemoryKv`, the same observations after every step and the same root at every version.
- "round-trips a drop and a rebuild in the middle of a block without changing a root or a lookup": the dial turned inside blocks changes neither roots nor observations nor entries.
- "object database: trees on disk and dropped trees: reports the chunks and nodes each root changes, so a store written from them holds the trees": the first root reports every chunk and node, a value change no sparse node, an emptied chunk and collapsed nodes deletions, and the store equals `treeEntries()` after every write; a database with no store reports none.
- "gives the same roots, object proofs, key proofs and range proofs with the trees dropped, at every version in the window, through undo and compaction": the acceptance test of STATE-PAGING.md section 9: 26 versions of 3 KB items on a resident twin and one over a `MemoryKv` with a cache of three chunks, dropped and rebuilt inside sessions, some undone, the store written late for some roots, every root and every proof in the window identical, the arena compacted, the cache both hit and missed.
- "runs on trees dropped from the start, with or without a store behind": the same roots and proofs as a resident database, and a rebuild estimate from the objects.
- "estimates a rebuild of the sparse trees with the versions it must build as well as the current one": a database with both tiers dropped and a retention of 40 replaces its whole set of 500 keys at every version; `rebuildEstimate().trees` after thirty versions is more than fifteen times what it is after one, the live keys being the same 500 either way.
- "dense merkle tree: dropped: reads its chunks through a bounded cache and computes the same roots and paths as a resident tree": fourteen versions across chunk boundaries and powers of two, dropped twice to a cache of two chunks, the same roots, paths, range proofs and stored chunks at every retained version.
- "sparse merkle tree: dropped: gives the roots and proofs of a resident tree, writing back only the nodes it changed": forty versions over a small key space, dropped between commits and in the middle of writes, the same roots, lookups and proofs at every retained version, and a store holding exactly the resident tree's nodes.
- "object database: a trimmed history window: forgets the older versions at once, answers the same for the ones it keeps, and grows back", run with the trees resident and with them dropped: two databases with retention 8 and no history store take the same thirteen versions of creates, removes and modifies; one is then trimmed with `setHistoryWindow(2)`. Its `memory()` reports `history: 'trimmed'`, a window of 2 and `lowestVersion` 10, and `historyEstimate()` has fallen; object proofs, key proofs and range proofs at versions 10 to 12 are byte for byte the untrimmed database's, and `proofAt`, `getAt` and `proveKeyAt` at version 9 throw `not available`. Through three more roots the window stays two wide, the roots agree, and `lastChanges.history` equals the untrimmed database's at each, while `lastStaleVersion` is still counted from the full retention (15 - 8). Widened with `setHistoryWindow(Infinity)`, the database reports `resident` and a window of 8 but `lowestVersion` stays 13, and over eleven more roots it is `max(13, v - 8)`, every version from there up proving as the untrimmed one does, until the two agree. Last, with a window of 3, the trees are dropped (or, in the dropped run, rebuilt) and the versions the window holds still prove the same, before and after one more root.
- "object database: past versions from the store: answers for every version the store has a record of, whatever the window in memory holds", run with the trees resident and with them dropped: a database with a history store over a `MemoryKv`, written after every root as the application writes it, against one that never trims. Trimmed to two versions and then to none, it reports `history: 'trimmed'` and the same `lowestVersion` as before, 4, and at every version from there to the current one its roots, object proofs, key proofs (present, absent, and a name that passed from one item to another), range proofs, type leaves and past values are the untrimmed database's, while a version below the lowest is `not available`. Through four more roots the same holds before the store has the new root's record as well as after. Widened again, the window in memory takes over from the records a version at a time through six more roots and a drop (or rebuild) of the trees, the two agreeing throughout. Last, a record is deleted from the store: a version after it is still answered correctly, and one before it is refused with `no history record of version 20`, for a root and for an object proof alike.
- "...: gives a reopened database its sparse trees' past versions from the records, or by replay without them", run with the trees resident and with them dropped: a store written through thirteen versions is reopened twice as a restart reopens it (objects imported as indexed, trees and index entries loaded from the store, the root compared), once with every history record as stored and once with one record's `nodes` set to null. `restoreIndexVersions()` returns `records` the first time and `replay` the second; either way every version of the window gives the roots, proofs and past values of the database that never stopped, and three more roots on the reopened database keep doing so as the window moves.
- "...: lists what a past version held of a type whose objects were removed since, from memory and from the store": a database with a history store takes versions 0 to 5 of the same steps, written after every root. The items of now joined with `changedSince(ItemType, 2)`, each read with `getAt` at version 2 and kept if not null, are the 100 items version 2 held, the 120 made by then less the ten version 1 removed and the ten version 2 removed; the items of now alone give 90, missing the ten version 3 removed. `changedSince(ItemType, 5)` is empty and `changedSince(CounterType, 4)` is the one counter. With `setHistoryWindow(0)` the store's records give the same 100 for version 2 and 160 for version 4, and version 6, which does not exist, throws `not available`. An item removed in an open session is listed by `changedSince(ItemType, 5)` and the session is undone.
- "...: reads a record written before the sparse tree nodes were kept, and refuses to prove a key from it": the store's records are rewritten as an earlier build wrote them, ending after the counters. They decode with `nodes: null`; with the window at zero the root and the proof of an object whose type has no authenticated index still come from them, and `proveKeyAt` and the proof of an item, whose type has one, throw `not available`.
- "object database: an arena within a byte limit: reads released objects from the store, gives the same roots and proofs, and takes written objects back": a database with `arenaBytes: 0`, a cache of 50 objects and a `MemoryKv` behind it (written as the application writes it, objects under `'o'` keys and the index and tree changes, then `dropChanges()`) against one with no limit, through six versions of 4,000 creates with removes and modifies. `setArenaLimit(0)` between a root and the store's write releases nothing, the bytes being nowhere else; after the write the arena is one slab and more than 15,000 objects are counted in `storedObjects`. Reads by id, by unique key and by scan, a past value, the export and the snapshot all equal the unbounded database's. Objects only in the store are modified, removed and undone like any other; after the next root the removed one and the written one are no longer counted as stored, and the proofs agree. Lifting the limit releases nothing more, and deleting an object from the store makes its read throw `neither in the arena nor in the store`.
- "ignores the limit without a store to read from": a database with `arenaBytes: 0` and no object store keeps several slabs, reports no limit and no stored objects.

`test/arena.test.ts` tests the arena alone, with a `Map` as its owner: "stores encodings across growing slabs and reads them back" (a 300,000-byte entry opens a second slab of 512 KiB, `used` counts every header, an encoding past `MAX_ENTRY` and a reference into a slab never made are refused), and "counts freed entries dead and compacts a slab that is more than half dead, moving the live ones" (nothing is compacted while the slab is the current one; once it is not, its live quarter moves to the next slab, byte for byte, the owner gets the new references, 256 KiB is released, and the next slab takes the released slab's slot with a new generation, so a stale reference stays refused). Its second group, "arena reclamation", covers the release of wholly dead slabs without copying, compaction keeping up with a backlog, and the reuse of slab numbers. Its third, "arena as a cache", is `shrink`: "releases whole slabs down to a byte limit, unread ones first, and tells the owner of every live entry" fills four slabs (256 KiB, 512 KiB, 1 MiB and 2 MiB) with twelve entries of 200,000 bytes and frees one; a limit at the present capacity releases nothing; with the second slab read, a limit one byte lower releases the first slab and reports its one live entry, and a lower one the third slab with its five; a limit of zero then releases the second slab too, read or not, reporting its live entry and not the freed one, and leaves only the current slab, whose entries still read; and a new entry takes a spare slot.

`test/review5-app.test.ts` has four cases on this layer. "answers with the state of the last root after writes made outside a session": after a root, an object is modified, one removed and one created with no session open; `getCommitted`, `committedNextInstance`, `countAt` and `getAt` at the root's version answer as of the root, and `proofAt` for each of the three verifies against the root's hash, the created one as absent; the same holds with a session opened over them and a further write in it, and after that session is undone; the next root then makes the new values the committed ones and the old root's proof still verifies. "refuses more types than its dropped trees have places for, before any tree is touched": 512 types throw `at most 511`, and a database of 511 drops its trees, rebuilds them, drops them again and proves an object against its root. "refuses more authenticated indices on a type than a proof can be decoded with": a type with 17 throws, and one with 16 makes a proof that survives encoding and decoding with its 16 index roots and verifies. "keeps its own copy of a value set in a sparse tree": resident and dropped, a value buffer overwritten after `set` leaves `get` and the committed root as they are for a tree given a copy.

`test/review.test.ts` adds the regressions from REVIEW-2026-10-28.md that belong to this layer: "rebuilds index history correctly when two objects swap keys in one version" (finding 12), "prunes sparse tree versions even with a zero retention window" (finding 29), and "proves a past height for an object type nothing changed in the window, after a restart" (finding 44: an application on a `MemoryKv` runs three transfer blocks, is reopened from the store, and proves a balance and the faucet account at height 2 against `db.rootAt(2)`).

`test/app.test.ts` exercises the database through the real application: "proves objects against the app hash" (a proof goes stale when another type's leaf changes the top tree); "proves past heights inside the retention window" (balances at heights 2 to 6 decode to the expected amounts, a height outside the window throws, a proof against the wrong hash fails); "proves account names present and absent, now and at past heights" (key proofs for names and symbols, tampering, a name proven absent against the genesis hash, and index roots agreeing between an object proof and a key proof at the same height); and "restarts from the store with the same app hash and keeps producing the same hashes" (after a restart the window is provable again from height 0, name proofs at past heights are byte-identical, and after more blocks the oldest versions leave memory and the store), and "keeps the whole history window in the store while the one in memory is trimmed, so a restart has it back" (an application whose database is trimmed to one version after its third block still proves heights 2 to 6 at height 6 byte for byte as an application that was never trimmed, the heights below 5 from the history records 3 to 6 in its store, a restart from that store logs `indexVersions: 'records'` and proves the same heights from the window it reads back, and the same store with one history record deleted opens with the heights below the gap not provable, refused and not answered from what is left, their records deleted by the next commit). Its second group, "core application: index entries in the store", is the application's side of the index and tree tiers: the store's entries, chunks and nodes equal the database's after every commit; an application reopened from them has the same hash and the same proofs, by the default path, with the leaves checked, recomputing from the objects, and with the trees dropped; a tampered object is caught by the leaf check and by the recomputing path; a store from before these phases is filled in on opening; a state imported from a snapshot is written with its entries and trees; and blocks run with the index trees, or both tiers, dropped and rebuilt on the way, with the mempool's session open, give the hashes, results and proofs of an application that never drops them ([chapter 11](11-application.md)). Its third group, "core application: a store opened without room for it", reopens a store with no heap room (both tiers dropped, no history window read) and with an arena limit of zero (every object left in the store) and runs blocks on each against a resident application ([chapter 11](11-application.md)).

`test/memory.test.ts` drives the dials from the memory guard: a node whose heap is driven to `warn` has its index trees dropped (the test helper makes its nodes with `indexTrees: 'memory'`; by default a node never builds them) and its history window trimmed to two versions, and driven on to `pressure` has its cache capped at 10,000 and its Merkle trees dropped too; it keeps following the chain on the fallbacks, proves objects against them as a validator with resident trees does, and rebuilds them at `ok` only once the estimate fits within half the heap limit; its history window is restored after the trees are back ([chapter 8](08-node.md)). And every suite runs with a tier dropped from the start under `INDEX_TREES=0` and `TREES=0` ([chapter 15](15-tests.md)).

`test/genesis.test.ts` ("loads a genesis whose application state is in a file ...") checks that neither a fresh nor a reopened database keeps `lastChanges`, finding 36.

## Limitations and ideas

Known simplifications, from DESIGN.md section 10 and the code:

- An authenticated index proves one entry present or absent. For a non-unique index the entry is the key with an object's id, so "this object is under this key" and "it is not" can be proven, and "these are all the objects under this key" cannot: the sparse tree is keyed by the hash of the entry, and entries that are neighbours in the index are nowhere near each other in it.
- History records are written in full per version. The window is counted in versions, not in time: a restart finds the records of the window in its own store however long the node was down, and the blocks it catches up on add theirs as usual. Only a node that starts from an empty database or from a snapshot begins its window at the height it starts at.
- The B+ tree merges but never borrows, so fill can degrade under adversarial delete patterns.
- Versions must be consecutive for leaf and inner history to agree (`pendingVersion` in `src/db/merkle.ts`); the code relies on callers using heights.
- All consensus state is resident by default, by design: README.md measures a 1 GB genesis at about 1.0 GB of heap and array buffers after a restart, and 961 MiB of heap plus 1,637 MiB of array buffers with the original and the synced state both loaded at the end of a local state-sync run. The peak while a node joins, when the chunks, the rebuilt state and the opened store are held together, was not measured; README.md's figure for it, about three times the state's resting memory, is an estimate to plan with. Every tier is now also in LMDB, a node leaves its index trees there unless its config says `indexTrees: 'memory'` ([chapter 8](08-node.md)), and the memory guard can drop the index trees and the Merkle trees, which took the database to 57% of the heap it holds resident with a full history window (40 to 50% in an earlier build's run on a state with no history yet), and a store whose tiers do not fit the heap is opened with them dropped (STATE-PAGING.md section 9.1).
- A version the window in memory no longer covers is read from the store's history records, and that read scans the record of every later version each time: nothing is cached, and no index says which records name an entry, so the cost grows with how far back the version is and with the size of the blocks since. That is the price of keeping the read free of memory. A record written before the sparse tree nodes were kept cannot serve an object proof for a type with an authenticated index, or a key proof. A store that has lost a record inside the window is refused and not answered for from what is left: the read throws, and at the next opening the heights below the gap are no longer provable ([chapter 11](11-application.md)).
- The arena's limit is a byte budget set by hand, because the slabs are outside the heap the memory guard watches; nothing lowers it when the machine runs short of memory, the current slab (16 MiB at most) always stays, and an object read from the store is not kept in the arena, so a state read far more than it is written pays an LMDB read on every miss of the hot cache.
- The recent transaction ids are still growth no dial sheds.
- `changedSince()` takes the removals of the block in progress from the open sessions, so it does not list an object removed with no session open since the last root, although the committed view still holds it. The application never writes that way.
- A database holds at most 511 object types, the chunk cache having 512 slots for the dense trees, and a type at most 16 authenticated indices, the number of index roots a proof or a snapshot manifest is decoded with.
- The arena's compaction budget is tested between slabs, so one pass can copy up to the live bytes of its last slab (under 8 MiB) more than the budget.
- The sparse trees' past versions are in the store only as the nodes each commit overwrote, inside the history records. A restart builds them from those (step 7); a window that holds a record written before the nodes were kept is still restored by replaying every account, which was most of what a restart cost.
- A chunk on disk is 1,024 hashes, so a block whose leaves are scattered over a large state rewrites nearly every chunk of the trees it touches (12 MiB per root at 192,000 accounts); smaller chunks would about halve that.

Exercises:

1. Add borrowing from a sibling to `rebalance` in `src/db/bptree.ts` and measure average leaf fill after the random test's 60,000 operations, before and after.
2. Convert an `ObjectProof` into two ICS23 `ExistenceProof` messages (one per leg) and check them with an off-the-shelf ICS23 verifier configured with the spec in the header of `src/db/proof.ts`.
3. Write a property test for range proofs: for random leaf counts and ranges, `rangeProofAt` and `rootFromRange` must agree with `rootAt`, and a proof with one sibling dropped, duplicated or swapped must make `rootFromRange` return null or a different root.
4. This exercise used to ask for the sparse trees' past versions to be taken from the store at a restart instead of being replayed from the objects. That is done (`restoreIndexVersions` and `SparseMerkleTree.loadVersions`, step 7). What is left of it: measure both paths on a large state by reopening the same store once as it is and once with one history record rewritten without its `nodes`, and compare the `historyMs` the line `loaded application state` reports for `indexVersions: 'records'` and for `'replay'` against the 3.5 s of history STATE-PAGING.md 5.3 reports for the replay and the 2 ms section 7.3 reports for the records.
5. A non-unique index is authenticated with a sparse tree over `key || id`, which proves one entry at a time. Design a proof for "every entry with this prefix": an ordered tree whose shape does not depend on the history of writes, and note what the type leaf would have to carry.
6. `loadSnapshot` now requires every registered type's section in `order`. Give the snapshot a version of its type list, so that a database with one more registered type can load a snapshot written before the type existed, and add the test.
7. Make the dense tree's chunk size a parameter of the store (STATE-PAGING.md 5.3 suggests smaller chunks on disk would about halve a scattered block's commit): keep 1,024 hashes in memory, write a chunk as several keys, and measure the commit of the scale suite's block of 2,400 random transfers and the cost of a root over dropped trees at each size.
8. Measure what opening a store paged takes (STATE-PAGING.md section 9.1): start a node on a large state with a `--heap` well below its resident heap, with and without `--arena`, and record the heap and the array buffers once it has opened, which tiers `loaded application state` reports as `paged`, and how long the history window takes to fill again.

## Where to next

[Chapter 10, the store](10-store.md): the key-value interface the change lists and history records are written to, LMDB behind it, and the block store.
