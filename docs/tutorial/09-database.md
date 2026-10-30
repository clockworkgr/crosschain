# 9. The object database

This chapter covers `src/db/`: the in-memory object database that holds every piece of consensus state the application owns (as encoded bytes in an arena, with a bounded cache of decoded objects over them), the indices that make it queryable, the Merkle trees that turn it into one 32-byte app hash, the proofs that let an outsider check a single object or a single name against that hash, and the undo sessions and version history that let the same structure serve transactions, blocks and queries at past heights. It builds on the deterministic binary codec of [chapter 1](01-codec.md) (every object has exactly one encoding, which is what gets hashed) and the SHA-256 and byte helpers of [chapter 2](02-crypto.md). It is used by [the application](11-application.md), which defines the object types and drives sessions and roots; by [sync](07-sync.md), which exports and imports snapshots with range proofs; by [the RPC](12-rpc.md), which serves objects, keys and proofs; and by [the light client](13-light-client.md), which verifies those proofs with `src/db/proof.ts` and nothing else. `src/types/txproof.ts` from [chapter 3](03-types.md) reuses the dense tree for the block's data hash and results hash. The database itself never touches a disk: what it changed at each root is handed to [the store](10-store.md) as a change list, and the store gives it back on restart.

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

The test suite relies on the same arithmetic: `test/genesis.test.ts` expects the account id `"3.0"` to parse to `3n * 2n ** 48n`. Instances are below 2^48, so `instanceOf(id)` is an exact JavaScript number. Whether it can index an array directly is a separate question: a JavaScript array index stops at 2^32 - 2, so `src/db/index.ts` enforces `MAX_INSTANCE = 2 ** 32 - 2` in `insert` and `importCommitted` and refuses anything beyond it. The 48 bits of the id layout are headroom in the wire format; the primary index guarantees the smaller bound, and that guarantee is what lets the rest of the code treat an instance as a dense array index.

Objects are immutable records. A modification does not mutate; it replaces the object with a new one under the same id. That is what makes undo cheap (an undo log holds references to old values) and what makes "the object as of version v" a well-defined thing to remember. Counters are consensus state too: they are hashed into the type leaf, and a proof that instance 50 of the account type does not exist is a proof about the counter.

### Why everything is in memory, and what it costs

Graphene keeps all consensus state in RAM and this chain makes the same trade-off explicit (DESIGN.md section 6: "State is bounded by RAM"). The disk holds a copy of every object and the history records, nothing the hot path reads. README.md's figures give the shape of the cost: 100,000 objects take 91 MiB; a 1 GB genesis of 193,536 accounts with two ML-DSA keys each sits at 584 MiB of heap plus 536 MiB of key buffers, "roughly its size, since the state stays in memory by design and hex halves to binary while objects and trees add it back". What that buys is reads that do not depend on size: an account by id is 16,000,000 lookups per second at that scale, by name 780,000, and a proof with verification about 40,000 per second. What grows with size is anything that walks every object: genesis, restart, snapshot export and import. Those figures were taken before the arena of the next section, which changed how the objects are held more than how much memory they take.

### Objects as bytes: the arena and the hot cache

"In memory" does not have to mean "as JavaScript objects". A decoded account is a small tree of objects, strings, bigints and arrays, each with its own header in the V8 heap; the header comment of `src/db/arena.ts` puts an account under secp256k1 at 117 bytes encoded and about a kilobyte decoded. And the encoding is needed anyway: it is what a leaf hashes, what the store writes, what a proof carries and what a snapshot ships. So since phase one of STATE-PAGING.md, the specification that turns memory into a cache over LMDB one tier at a time, the database keeps every committed object as its canonical bytes and decodes on demand, with a bounded cache of decoded objects in front.

The bytes live in an arena: a few large `Uint8Array` slabs filled by a bump allocator, the first 256 KiB and each next one twice the last, up to 16 MiB. An entry is a 10-byte header followed by the encoding:

```
offset 0    type       u16   the object's type
offset 2    instance   u32   the object's instance
offset 6    length     u32   bytes of encoding that follow
offset 10   encoding
```

A reference to an entry is the slab number times 2^32 plus the offset of its header, packed into one JavaScript number: the entry at offset 1,000 of slab 3 is `3 * 2^32 + 1000 = 12,884,902,888`. Per type, a `Float64Array` indexed by instance holds each object's reference (-1 for none) and a `Uint32Array` its length. Those two tables are the primary index now, and they are still plain arrays indexed by instance, because instances are dense.

Slabs are never written in place. A new encoding of an object is a new entry at the end of the current slab, and the old entry only has its bytes counted dead. After a root, a slab whose dead bytes are more than half its used bytes is compacted: its entries are walked header by header, each one that is still current (the header names the owning type and instance, and the owner's table says whether this reference is still the object's) is copied into the current slab, the owner is told the new reference, and the slab's buffer is released. At most two slabs are compacted per root, so the pause is bounded by 16 MiB of copying. A slab number is never reused, so a stale reference fails instead of reading someone else's bytes.

Over the arena sits the hot cache: per type a `Map` from instance to decoded, frozen object, under one budget, `hotObjects`, that all types share. A read is a cache hit, or a decode from the arena (about a microsecond for an account) whose result is frozen and cached. When the budget is spent something must go, and choosing well matters: a block keeps touching the same accounts, while an RPC client listing every account touches each one once. The policy is CLOCK, the second-chance approximation of least recently used from operating systems' page replacement: each instance has a touched bit, a hit sets it, a fresh decode enters with it clear, and a hand sweeps the type's instances in order, clearing the bits it finds set (the second chance) and evicting the first cached entry it finds clear. A hit costs one byte store, and nothing is ever sorted.

Worked example with a budget of two and the hand at instance 0. Read 0, then read 1: two misses, both decoded and cached with their bits clear, and the budget is full. Read 0 again: a hit, and its bit is set. Read 2: a miss, so 2 is cached with its bit clear and the cache is one over. The hand looks at 0, finds its bit set, clears it and moves on; it looks at 1, finds its bit clear, and evicts it. The cache holds 0 and 2, both bits clear, and the hand waits at 2. Instance 1, read once, went first; instance 0, read twice, stayed. A scan that reads every account once fills the cache with clear bits, and the hand takes those before anything a block keeps touching.

Writes never leave the cache before a root. An object created or modified since the last root is pinned there, decoded, and never evicted whatever the budget; a removal is a tombstone (`null`) there, which hides the object the arena still holds. `root()` encodes each pinned object once, however many times it was modified, hashes those bytes, writes them to the arena and unpins it. A transaction that fails is undone by putting old decoded values back into the cache, so it costs no arena traffic. Past values are kept the same way: what an object was before a version is kept as its bytes, not as a decoded record, and decoded only when that version is read.

The budget is unbounded by default, so a node with memory to spare decodes each object once, keeps it, and runs nearly as it did before the arena. The memory guard of [chapter 8](08-node.md) caps it as the heap fills: 100,000 objects at `warn`, 10,000 at `pressure`. Measured at 191,896 accounts with two keys each under secp256k1 ([benchmarks.md](../benchmarks.md) section 4.10), against the same run before the arena, the resident mode costs about 6% more memory, the encoded copy beside the decoded one (607 MiB of heap after building against 597, and the array buffers, where the slabs live, at 79 MiB against 41), and 5 to 15% of speed (a block of 500 transfers among random accounts in 24.8 ms against 21.5; `get by id` on the small suite in 72 ns against 42, a map lookup instead of an array index). The capped mode saves 17% of the heap with an empty cache (489 MiB after a restart against 601) at the price of the same block taking twice as long, 41 ms; that is the degraded mode the guard turns on. The arena by itself did not move memory much, because decoded objects were never the bulk: they are about a sixth of the heap, 0.55 KB of the 3.2 KB an account costs, and the secondary indices, the name tree and the Merkle trees are the rest, which is what the later phases of STATE-PAGING.md put on disk.

### Indices as ordered byte keys

A primary index is the table of arena references of the previous section, indexed by instance. A secondary index ("accounts by name", "balances by owner and asset") is a key encoder plus one ordered map from byte strings to ids. The rule that makes every index the same shape, from `src/db/keys.ts`: a key is a byte string whose lexicographic order is the order you want to scan in. Integers are written big-endian so they sort numerically; strings end with a zero byte instead of carrying a length prefix, so `"ab"` sorts before `"abc"` and a prefix scan on `"ab"` finds both; a compound key is the parts written one after another.

Worked examples, using the codec's big-endian integers:

- `k.str('alice')` produces `61 6c 69 63 65 00` (six bytes: the UTF-8 text and a terminator).
- `k.id(owner).id(asset)` produces sixteen bytes: two big-endian u64 ids. The application's `byOwnerAsset` balance index uses exactly this (`test/app.test.ts` looks a balance up with `key((k) => k.id(aliceId).id(app.coreAsset))`).
- A non-unique index appends the object's own id to the key. The test type in `test/db.test.ts` has `byGroup` keyed by a u32 group; its stored keys are 4 bytes of group followed by 8 bytes of id, so every entry is distinct and all entries of one group are adjacent. "Everything in group 1" is then a prefix scan on the 4-byte prefix, and the results come out in id order within the group.

A unique index maps a key to one id and refuses a second object with the same key. A non-unique index is a prefix scan. Both are derived data: they are rebuilt from the objects when a store is loaded, and they are not hashed. The exception is an index marked authenticated, covered below.

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

The prefixes are domain separation. Without them an attacker could present a leaf's preimage as if it were an inner node (or the reverse) and build a path that folds to a genuine root while claiming a different item; with them, the byte that opens the preimage fixes what kind of node it is, and a 64-byte inner preimage cannot be read as a leaf preimage. The review in REVIEW-2026-10-28.md lists "domain-separated Merkle hashing" among the strongest parts of the code base.

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

Storage is per level in chunks of 1024 hashes, allocated when a node in the chunk is first set and released when its last node becomes empty, so memory follows the live objects rather than the counter: a type whose objects come and go, like recent transaction ids, costs only its live window (DESIGN.md section 6). Changed objects are remembered and their paths recomputed in one pass at the end of each block, shared ancestors once; README.md measures a root after 1,000 changed objects at 19 ms.

### The sparse Merkle tree for proofs by key

The dense tree proves things about ids. Users ask about names: "is there an account called alice", "what id does the symbol CORE have". A unique index can be marked `authenticated`, and such an index keeps a second structure beside its B+ tree: a sparse Merkle tree over `sha256(key)`, in `src/db/smt.ts`. Its root goes into the type leaf after the counter and the type root, so a proof by key is a sparse-tree path to one of those roots followed by the same type leg.

Why not hash the B+ tree itself, which would avoid a second structure: the header of `src/db/smt.ts` answers that its root would depend on node layout, which depends on the order of inserts and deletes, and a node that restarts rebuilds its indices from the objects in id order. Two nodes with the same key set but different histories would disagree on the root. A sparse tree keyed by the hash of the key has one shape per key set, so any node, after any history, hashes identically. That property is also what lets past index versions be rebuilt from the object history after a restart instead of persisting tree nodes. DESIGN.md section 6 draws the line the same way: indices are rebuilt on load, the B+ trees are not part of the root, and the unique indices that need proofs are authenticated by sparse Merkle trees whose roots are in the type leg.

A sparse Merkle tree in its textbook form is a binary tree of depth 256 where the bits of the hashed key choose left or right at each level and almost every subtree is empty. The compacted form used here is the Jellyfish shape (from the Jellyfish Merkle tree of the Diem project): every leaf sits at the first depth where its key prefix is unique, inner nodes exist only where two keys share a prefix, and an empty child is the `EMPTY` hash. Keys are hashed so the tree stays balanced whatever names users pick, and so ICS23's SMT spec (`PrehashKey SHA256`) applies.

Worked example. Three keys whose hashes begin with the bits `00`, `01` and `1`, called k1, k2 and k3. After k1 the tree is one leaf. Inserting k2 finds a leaf with a different key at the root; the two agree on bit 0 and differ on bit 1, so both are pushed to depth 2 under an inner node at depth 1, which hangs as the left child of a new root whose right child is empty. Inserting k3 goes right at bit 0 into the empty slot and becomes a leaf at depth 1:

```
root = inner( inner( leaf k1, leaf k2 ), leaf k3 )
```

The membership proof for k2 is the siblings down its path, `[hash(leaf k3), hash(leaf k1)]`, and its own leaf. A query for an absent key whose hash begins with `1` walks right and ends on k3's leaf: the proof is `[hash(inner(k1, k2))]` with k3's leaf, and the verifier accepts it as absence because k3 shares the one bit of path that was walked and therefore owns that whole subtree. If k3 is then removed, the root's right child becomes empty and the same query ends on an empty slot: siblings `[hash(inner(k1, k2))]`, leaf null. Either way the fold reaches the root only if the claimed shape is the real one.

A proof is thus the sibling hashes down the key's path plus what sits at the end of the walk: the key's own leaf (membership), nothing (absence through an empty slot), or another key's leaf that shares the prefix (absence, because that leaf owns the whole subtree and the key would have been pushed below it if present). The value stored in a leaf is the 8-byte id of the object that owns the key.

### Undo sessions and the committed view

Writes go through `create`, `modify` and `remove`. An undo session, Graphene style, records what each write replaced so that everything since the session started can be reverted. Sessions nest, and nesting matters because blocks contain transactions: the application runs each transaction in its own session and undoes it if the transaction fails, inside a block that must either apply fully or be replayed; and the mempool's speculative state is one long-lived session that is undone before every block and rebuilt by re-checking the pending transactions. A block is final, so nothing undoes a block that applied; but the application does bracket each block in a session of its own while it is being applied, committed just before the root is taken, so that a failure half way through (a signature verifier that went away) leaves the database as the previous block left it and the block can be applied again from scratch.

The outermost open session also doubles as the committed view. Whatever it recorded as an old value is what was committed at the last root, which is what queries and proofs must return while the mempool session is open. `getCommitted` looks through every open session, outermost first, and returns the first old value it finds. The trees are never touched by a write; only `root()` hashes, and it must be called with every session closed, so the trees always reflect the last committed state. Nothing speculative is ever written to disk: the pending session is undone before the block runs (DESIGN.md section 6, "Persistence and recovery").

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
```

Every node on the two changed paths is listed, because every one of them was overwritten. The store writes that record next to the block's changes and reads it back on restart, so the whole window is provable again after a restart. Each database and each tree also has a floor: the oldest version it can describe, set to the version of the first root (where it was built) and lowered as history is loaded. A fresh node, or a node that joined by state sync, is provable only from the height it started at. README.md measures the memory side of the window: 85 MiB of heap of version history after 8 blocks of 2,400 scattered transfers each on the gigabyte state, a figure from before the history was kept as bytes.

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

/** Instances are below 2^48, so a plain number is exact and indexes an array. */
export function instanceOf(id: ObjectId): number {
  return Number(id & INSTANCE_MASK);
}
```

Notice that `objectId` accepts type 0, while `ObjectType.id` in `src/db/index.ts` is documented as `1..65535` and `TOP_TREE = 0` in `src/db/database.ts` uses 0 to label the top tree in history records. Nothing in `src/db/` enforces that a registered type is not 0; the core application's types start at 1.

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
- `class DenseMerkleTree`.

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

`rootFromRange` folds a run `[from, from + leaves.length)` level by level. At each level the run is widened to even boundaries with siblings from the proof: a left neighbour if it starts on an odd index, a right neighbour if it ends on an even one, in that order, which is the order `rangeProofAt` emits them; then adjacent pairs are hashed and the indices halve. It returns null if a sibling is missing, left over, or the run does not fit in `count`; with `count === 0` only an empty run with no siblings is accepted and its root is `EMPTY`. A snapshot chunk of 2000 objects therefore costs at most two siblings per level, about the same as one inclusion proof.

**Storage.** `levels[k]` maps a chunk index to a buffer of 1024 node hashes (32 KiB), and `counts[k]` keeps the number of non-empty nodes per chunk so that a chunk whose last node becomes empty is released. A node's chunk is `Math.floor(j / CHUNK)` and its offset in the chunk is `j % CHUNK`, written as arithmetic rather than as `j >> CHUNK_BITS` and `j & (CHUNK - 1)` on purpose: JavaScript's bitwise operators work on 32-bit signed integers, so a shift would turn a leaf index at or above 2^31 into a negative chunk number and silently address the wrong node, while division and remainder are exact for every integer an instance can be. `rawNode(k, j)` reads a node or returns `EMPTY` if its chunk is absent; `node(k, j)` additionally returns `EMPTY` for any index at or past `nodesAt(k) = ceil(size / 2^k)`, so stale data cannot leak past the populated range. `writeNode` is the only writer:

```ts
  private writeNode(k: number, j: number, h: Uint8Array): void {
    const old = this.rawNode(k, j);
    if (bytesEqual(old, h)) return;
    if (this.retain > 0 && this.version >= 0) this.record(k, j, old.slice());
```

It records the old hash for the history before overwriting, allocates a chunk pre-filled with `EMPTY` on first use, counts non-empty nodes in and out, and frees the chunk when the count drops to zero. The `old.slice()` matters: `rawNode` returns a view into the chunk, and the view would change under the history entry when the chunk is overwritten.

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

Shared ancestors are hashed once per level because `parents` is a set. Before that loop, if the leaf count changed since the last root, the old size is pushed onto `sizes` as "before this version the count was n" and reported as `sizeBefore`. After it, the records made by this root are moved into `lastRecords`, and `prune(version - retain)` drops history that only serves versions outside the window. With a zero retention window there is no node history to prune, but the size records would still accumulate one entry per growth, so `root()` clears `sizes` outright in that case: only the current version is askable, and its leaf count is the live `size`. The method returns `rootAt(version)`.

**Reading the past.** `nodeAt(k, j, version)` is the versioned read:

```ts
  nodeAt(k: number, j: number, version: number): Uint8Array {
    if (j >= this.nodesAt(k, this.sizeAt(version))) return EMPTY;
    const entries = this.history[k]?.get(j);
    if (entries) for (const e of entries) if (e.v > version) return e.h;
    return this.rawNode(k, j);
  }
```

Beyond the populated range of that version's size it is `EMPTY`; otherwise the first history entry with `v > version` gives the hash before that later change, and with no such entry the current hash is right. `rootAt`, `pathAt(i, version)` and `rangeProofAt(from, to, version)` all read through it, and `path(i)` is `pathAt` at the current version. `checkVersion` throws if there are unhashed changes or the version is outside `[lowestVersion, currentVersion]`, where

```ts
  get lowestVersion(): number {
    return Math.max(this.floor, this.retain > 0 ? this.version - this.retain : this.version);
  }
```

**History bookkeeping.** `record` calls `addEntry` with the pending version and keeps a list of what this root recorded so a store can persist it. `addEntry` requires ascending versions per node and refuses a second entry for the same node and version, so the first overwrite in a version wins, which is the value before the version. `historyByVersion` lets `prune` find every node touched by a version without scanning:

```ts
  prune(minVersion: number): void {
    for (const [v, list] of this.historyByVersion) {
      if (v > minVersion) continue;
      for (const [k, j] of list) {
        const byIndex = this.history[k]!;
        const entries = byIndex.get(j)!;
        while (entries.length > 0 && entries[0]!.v <= minVersion) entries.shift();
        if (entries.length === 0) byIndex.delete(j);
      }
      this.historyByVersion.delete(v);
    }
    while (this.sizes.length > 0 && this.sizes[0]!.v <= minVersion) this.sizes.shift();
  }
```

An entry tagged v serves reads of versions below v, so entries tagged at or below the window's lowest version serve nothing inside it and go. The floor has a public setter, and `loadRecords(version, rec)` puts records back after a restart:

```ts
  /**
   * Make `version` askable although no record of it was loaded: nothing changed
   * this tree between then and the oldest recorded version, so its entries, or
   * its live state, already describe it.
   */
  lowerFloor(version: number): void {
    if (version < this.floor) this.floor = Math.max(0, version);
  }

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

Between roots `nextVersion` is null, so leaf writes are tagged `version + 1`, while inner-node writes made inside `root(v)` are tagged `v`. The two agree only when roots are called with consecutive versions, which every caller does (heights). Second, a fresh tree's floor is the version of its first root, set inside `root()`; nothing but `lowerFloor` and `loadRecords` moves it afterwards, and a tree never raises it, so once a version is askable it stays askable until the retention window passes it.

### src/db/smt.ts

Purpose: the compacted sparse Merkle tree behind authenticated indices, with versions by root pointer.

Exports:

- `interface SmtLeaf { keyHash; value }` and `interface SmtProof { siblings; leaf }`.
- `class SparseMerkleTree` with `currentVersion`, `lowestVersion`, `set(key, value)`, `delete(key)`, `get(key)`, `rootHash()`, `commit(version)`, `rootAt(version)`, `proveAt(key, version)` and `prove(key)`.
- `smtProofRoot(key, proof)`: the verifier's fold, returning `{ root, value }` (value null for absence) or undefined for a malformed proof.

A node is either a leaf `{ hash, leaf: { keyHash, value } }` or an inner node `{ hash, left, right }` with nullable children; the hash is computed once at construction with the same `leafHash` and `innerHash` as `src/db/merkle.ts`, so a leaf of the sparse tree is `leafHash(sha256(key), value)`. `bit(h, i)` reads bit i of a hash, most significant bit first, so depth 0 uses the top bit of the first byte. Nodes are immutable: `insert` and `remove` return a new node when anything below changed and the same node otherwise, so each write copies only the path from the root and every past version is just a root pointer that the garbage collector keeps alive.

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

Together they guarantee one shape per key set. The test in `test/db.test.ts` checks it with 3000 random sets and deletes against a tree built from the sorted final key set. Setting a key to the value it already has returns the same node, so the root pointer does not change and no path is copied.

`commit(version)` is the versioning:

```ts
  commit(version: number): Uint8Array {
    if (version <= this.version) throw new Error(`version ${version} is not after ${this.version}`);
    this.version = version;
    this.versions.set(version, this.root);
    for (const v of this.versions.keys()) if (v < version - this.retain) this.versions.delete(v);
    return this.rootHash();
  }
```

It requires increasing versions, stores the current root pointer under the version, and drops every stored version below `version - retain`. Review finding 29 (REVIEW-2026-10-28.md) is about the last line: it used to prune only when retention was positive, so `retainVersions: 0` kept every root pointer forever and with them every path those roots reached; it now prunes at any retention, and `test/review.test.ts` asserts that version 3 is gone after committing 0..4 with retention 0. `rootOf(version)` throws a `RangeError` if the version is outside the window or was never committed. `proveAt` walks from that version's root following the key's bits, collecting the sibling at each inner node (`EMPTY` for a missing child), and stops at a leaf or at null:

```ts
  /** Membership or absence proof for a key as of a version. Every buffer in it is a copy; the tree's own stay untouched. */
  proveAt(key: Uint8Array, version: number): SmtProof {
    const keyHash = sha256(key);
    const siblings: Uint8Array[] = [];
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
- `interface ArenaOwner { refOf(type, instance); relocate(type, instance, ref) }`: whoever holds the references. Compaction asks it whether an entry is still current and tells it where the entry moved.
- `packRef(slab, offset)`, `slabOf(ref)`, `offsetOf(ref)`: a reference and its two halves, by multiplication, division and remainder by 2^32 rather than by shifts, for the reason given under `src/db/merkle.ts`: JavaScript's bitwise operators work on 32 bits.
- `interface ArenaStats { slabs; capacity; used; dead }`: the slabs holding bytes, the bytes they can hold, the bytes written into them, and how many of those are dead.
- `class Arena` with `stats`, `alloc(type, instance, bytes)`, `read(ref)`, `free(ref)` and `maintain(maxSlabs = 2)`.

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
 * is counted dead, and a slab that is more than half dead is compacted after
 * a root by copying its live entries into the current slab and releasing it.
 * The header is what makes compaction possible: it names the owner, which
 * says whether the entry is still its current value.
 */
```

A slab is `{ buf, used, dead }`, and `buf` becomes `null` when the slab is compacted away; its number stays taken "so older references never alias". `alloc` refuses an oversized encoding, opens a new slab when the current one cannot take the entry, and writes the header byte by byte, big-endian, in front of the encoding:

```ts
  private newSlab(need: number): void {
    // The first slab is small so a tiny database costs little; each next doubles up to the maximum.
    const size = Math.max(need, Math.min(MAX_SLAB, FIRST_SLAB * 2 ** this.created));
    this.created++;
    this.slabs.push({ buf: new Uint8Array(size), used: 0, dead: 0 });
    this.current = this.slabs.length - 1;
  }

  /** Store an encoding; returns its reference. */
  alloc(type: number, instance: number, bytes: Uint8Array): number {
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
    return packRef(this.current, at);
  }
```

A new slab is as large as the next step of the doubling, `min(16 MiB, 256 KiB × 2^created)` with `created` the slabs made so far, or as the entry that needs it if that is larger. The count is of slabs ever made, so a node that compacted its early slabs away does not go back to small ones. The bump allocator never looks back: when an entry does not fit, the rest of the current slab stays unused and the entry opens the next one.

`read(ref)` parses the header and returns a `subarray` of the slab, a view and not a copy, "valid until the next compaction"; a reference into a slab that was released, or never made, throws `RangeError`. `free(ref)` only adds the entry's size, header included, to its slab's `dead`. Compaction is `maintain`:

```ts
  /**
   * Compact up to `maxSlabs` slabs that are more than half dead, copying their live entries
   * into the current slab and telling the owner where they went. Returns the bytes released.
   */
  maintain(maxSlabs = 2): number {
    let released = 0;
    let done = 0;
    for (let s = 0; s < this.slabs.length && done < maxSlabs; s++) {
      const slab = this.slabs[s]!;
      if (s === this.current || !slab.buf || slab.used === 0 || slab.dead * 2 <= slab.used) continue;
      const buf = slab.buf;
      for (let at = 0; at < slab.used; ) {
        const h = this.header(packRef(s, at));
        if (this.owner.refOf(h.type, h.instance) === packRef(s, at)) {
          const moved = this.alloc(h.type, h.instance, buf.subarray(at + HEADER, at + HEADER + h.length));
          this.owner.relocate(h.type, h.instance, moved);
        }
        at += HEADER + h.length;
      }
      released += buf.length;
      slab.buf = null;
      slab.used = 0;
      slab.dead = 0;
      done++;
    }
    return released;
  }
```

The current slab is never compacted, since new entries go there, nor is an empty or released one. The walk goes from header to header up to `used`, which works only because every entry carries its length, and an entry is live exactly when the owner's table still holds this reference for that type and instance: an object written again since has a newer entry, and a removed one has none, so the old reference is no longer in the table. A live entry is copied with `alloc` into the current slab, which may open a new one, and the owner learns its new reference through `relocate`. The return value is the bytes released. The database calls `maintain()` at the end of every `root()`, while the node idles until the next proposal.

### src/db/index.ts

Purpose: one type's objects and indices, Graphene's `generic_index` without Boost's multi-index containers: the type's table of references into the arena, its hot cache of decoded objects, and its secondary indices.

Exports:

- `class DbError extends Error`: every rule violation in the database layer throws this, so the application can tell a failed transaction (a `DbError`) from a bug.
- `interface IndexDef<T> { name; unique; authenticated?; key(obj, k) }`: an index definition. `key` writes the object's key into a `KeyWriter`.
- `interface ObjectType<T> { id; name; encode(w, obj); decode(r, id); indices }`: a type. The doc comments carry two invariants: the id is "Fixed forever: it is in every id and every leaf hash", and `encode` is the canonical encoding hashed into the state root, which does not write the id because the leaf position implies it. `decode` receives the id for the same reason.
- `MAX_INSTANCE = 2 ** 32 - 2`: the largest instance the primary index accepts, "the largest instance a JavaScript array can index". `src/db/id.ts` allows 48 bits in an id; this is the bound the per-instance tables keep, and an instance within it also fits the four bytes the arena's header gives it.
- `interface HotBudget { limit; size }`: how many decoded objects the hot caches of all types may hold together, and how many they hold. The database makes one and hands every type the same object.
- `class TypeIndex<T>`: the per-type container.

Its private fields are the design of "Objects as bytes" in data:

```ts
  private readonly arena: Arena;
  private readonly budget: HotBudget;
  /** Arena reference of each committed instance (-1 when absent) and its encoding's length. */
  private refs = new Float64Array(0);
  private lens = new Uint32Array(0);
  /** Decoded objects by instance; null is a tombstone for a removal the arena has not seen. */
  private readonly hot = new Map<number, T | null>();
  /** CLOCK's second-chance bit per instance, and where its hand is. */
  private touched = new Uint8Array(0);
  private hand = 0;
  /** Instances written since the last root: never evicted. */
  private readonly pinned = new Set<number>();
  /** Set when an eviction pass found nothing clean left to drop; cleared at the next root, which unpins. */
  private saturated = false;
```

`refs`, `lens` and `touched` grow together in `ensure`, doubling and never below 16 slots, with new references set to -1; a reference needs a `Float64Array` because it packs a slab number above the low 32 bits. `pinned` is what keeps a written object safe from eviction, and `saturated` is what stops a type whose cache is all pinned from sweeping in vain on every write.

The constructor takes the arena and the shared budget besides the type and the retention window, and builds one `BPlusTree` per index and, for an authenticated index, one `SparseMerkleTree` with the retention window:

```ts
  constructor(type: ObjectType<T>, retainVersions: number, arena: Arena, budget: HotBudget) {
    this.type = type;
    this.arena = arena;
    this.budget = budget;
    for (const ix of type.indices) {
      if (this.secondary.has(ix.name)) throw new Error(`${type.name}: duplicate index ${ix.name}`);
      this.secondary.set(ix.name, new BPlusTree());
      if (ix.authenticated) {
        if (!ix.unique) throw new Error(`${type.name}.${ix.name}: only unique indices can be authenticated`);
        this.trees.set(ix.name, new SparseMerkleTree(retainVersions));
        this.authenticated.push(ix.name);
      }
    }
  }
```

`authenticated` keeps the names in definition order; that order is the order of `indexRoots` in the type leaf, which is why `KeyProof.indexPosition` is meaningful and why reordering a type's indices would change the app hash. Duplicate index names and an authenticated non-unique index are rejected with plain `Error`s at construction: they are configuration mistakes, not runtime failures.

**Reads.** `get` is the cache, then the arena:

```ts
  private decodeAt(instance: number): T {
    const bytes = this.arena.read(this.refs[instance]!);
    return deepFreeze(decode(bytes, (r) => this.type.decode(r, objectId(this.type.id, instance))));
  }

  get(instance: number): T | undefined {
    const v = this.hot.get(instance);
    if (v !== undefined) {
      // A cached object, or a tombstone (null), which reads as absent.
      this.touched[instance] = 1;
      return v ?? undefined;
    }
    if (this.refAt(instance) < 0) return undefined;
    const obj = this.decodeAt(instance);
    this.cache(instance, obj);
    return obj;
  }

  has(instance: number): boolean {
    if (this.hot.has(instance)) return this.hot.get(instance) !== null;
    return this.refAt(instance) >= 0;
  }
```

Anything in the cache answers: an object, whose touched bit is set, or a tombstone, as absent. Otherwise an instance with no reference is absent, and one with a reference is decoded from the arena, frozen, and cached, entering with its bit clear. `has` answers without decoding anything: a cached entry decides, else the table.

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
   * Over budget: sweep this type's instances with the clock hand, giving a touched entry a second chance and
   * evicting the first clean one that has not been touched since the hand last passed. Pinned objects stay
   * whatever the budget. The sweep is bounded, and a type that cannot find victims (its cache all pinned, as
   * while a genesis is built) marks itself saturated and does no more work until the next root unpins.
   */
  evict(): void {
    let over = this.budget.size - this.budget.limit;
    if (over <= 0) return;
    const n = this.refs.length;
    if (n === 0 || this.hot.size === this.pinned.size) {
      this.saturated = true;
      return;
    }
    // The sweep is bounded per call; what it does not manage now, the next call continues from the hand.
    for (let scanned = 0, cap = Math.min(2 * n, 2 * over + 256); over > 0 && scanned < cap; scanned++) {
      const i = this.hand;
      this.hand = i + 1 >= n ? 0 : i + 1;
      if (!this.hot.has(i) || this.pinned.has(i)) continue;
      if (this.touched[i]) {
        this.touched[i] = 0;
        continue;
      }
      this.hot.delete(i);
      this.budget.size--;
      over--;
    }
    // Saturated means nothing clean is left to evict, not that this window found none.
    this.saturated = over > 0 && this.hot.size === this.pinned.size;
  }

  /** A root is over: the pins are off, so the budget can be enforced again. */
  afterRoot(): void {
    this.saturated = false;
    this.evict();
  }
```

`cache` counts a new entry against the shared budget, clears its touched bit (a fresh decode has not earned a second chance, and a write does not need one, since it is pinned), and asks `evict` for room unless the type is saturated. `evict` sweeps from the hand, wrapping at the end of the table: an instance that is not cached, or is pinned, is passed over; a touched one has its bit cleared; the first clean, untouched one is deleted. The sweep is bounded per call, at twice the excess plus 256 instances and never more than twice the table, so a write never pays for a full scan, and what one call leaves the next continues from the hand. The budget is shared but each type evicts only its own entries, so a type that cannot find a victim leaves the total over until another type caches something, the next root, or a new limit. `saturated` is set only when everything the type has cached is pinned, as while a genesis is being built, every object written and none rooted yet; `afterRoot`, which the database calls on every type once a root has unpinned everything, clears it and brings the cache back under the budget in one pass. The database's `setHotLimit` calls `evict` on every type for the same reason.

**Writes.**

```ts
  /** Write a value (create or modify). Fails, changing nothing, if a unique key is already taken by another object. */
  insert(obj: T): void {
    const keys = this.keysOf(obj);
    this.checkUnique(obj, keys);
    const instance = instanceOf(obj.id);
    if (instance > MAX_INSTANCE) throw new DbError(`${this.type.name}: instance ${instance} is beyond the index`);
    const old = this.get(instance);
    if (old) this.unindex(old);
    this.pinned.add(instance);
    this.cache(instance, obj);
    this.indexKeys(obj, keys);
  }
```

```ts
  private unindex(obj: T): void {
    for (const [ix, k] of this.keysOf(obj)) {
      this.secondary.get(ix.name)!.delete(k);
      this.trees.get(ix.name)?.delete(k);
    }
  }

  erase(obj: T): void {
    this.unindex(obj);
    const instance = instanceOf(obj.id);
    this.pinned.add(instance);
    this.cache(instance, null);
  }
```

The uniqueness checks (`checkUnique`, shared with the import path) run before anything changes, so a `modify` that would collide on a name leaves the old object in place. The instance check sits with them: an instance past `MAX_INSTANCE` is refused with a `DbError` rather than written, since the tables are indexed by instance and the arena header holds it in four bytes. Nothing in `src/db/` creates ids that large, but `importObject` takes ids from a store or a snapshot, and `insert` and `importCommitted` are the two doors every object comes through. A replace reads the old object (from the cache, or decoded from the arena) and unindexes its keys, then pins the instance, caches the new object, and writes its keys into the B+ tree and, where present, the sparse tree with the 8-byte id as the value. `erase` unindexes and caches a tombstone, pinned: the object is gone for every read at once, while its committed bytes stay in the arena until the root frees them. Neither writes to the arena, and the database's `undoSession` restores old values through the same two methods, so a transaction that fails writes nothing there either.

The import path skips the cache altogether:

```ts
  /** Load a committed object straight into the arena (import), decoded only to build its index entries. */
  importCommitted(obj: T, bytes: Uint8Array): void {
    const keys = this.keysOf(obj);
    this.checkUnique(obj, keys);
    const instance = instanceOf(obj.id);
    if (instance > MAX_INSTANCE) throw new DbError(`${this.type.name}: instance ${instance} is beyond the index`);
    if (this.has(instance)) throw new DbError(`${this.type.name}: instance ${instance} imported twice`);
    this.ensure(instance);
    this.refs[instance] = this.arena.alloc(this.type.id, instance, bytes);
    this.lens[instance] = bytes.length;
    this.indexKeys(obj, keys);
  }
```

The bytes go straight into the arena, the decoded object serves for its index keys and is dropped, and nothing is pinned. A second import of the same instance is refused.

**What a root does with a type.** The database's dirty loop (below) asks for the pending value and then flushes or settles it:

```ts
  /** The value written since the last root (null for a removal), or undefined when nothing is pending. */
  pending(instance: number): T | null | undefined {
    return this.pinned.has(instance) ? this.hot.get(instance) : undefined;
  }

  /** The committed encoding, a view into the arena; undefined when the arena holds none. */
  bytesOf(instance: number): Uint8Array | undefined {
    const ref = this.refAt(instance);
    return ref < 0 ? undefined : this.arena.read(ref);
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
    this.ensure(instance);
    if (bytes) {
      this.refs[instance] = this.arena.alloc(this.type.id, instance, bytes);
      this.lens[instance] = bytes.length;
    } else {
      this.refs[instance] = -1;
      this.lens[instance] = 0;
      this.uncache(instance);
    }
    this.pinned.delete(instance);
  }

  /** A root found a pending value equal to the committed one: nothing to write, just unpin. */
  settle(instance: number): void {
    this.pinned.delete(instance);
    if (this.hot.get(instance) === null) this.uncache(instance);
  }
```

`pending` returns a value only for a pinned instance: the object written since the last root, `null` for a removal, and `undefined` when nothing is pending, which is how the root tells an imported object (in the arena, never pinned) from a written one. `flush` frees the old entry and writes the new bytes, or for a removal clears the reference and drops the tombstone, and unpins: a written object stays cached, now clean, a candidate for eviction like any other. `settle` is for a value written and written back: nothing to write, the pin comes off, and a tombstone for an object that never reached the arena is dropped. `bytesOf` is the committed encoding, a view into the arena; `bytesFor` prefers a pending value's encoding, so export and snapshots taken between roots see the live state.

**The rest.** `instances()` yields every present instance in ascending order through `has`, so a type's objects can be walked without decoding any; `rebuildIndexVersions`, `exportObjects` and `encodeSnapshot` walk them that way. `truncate(before)` is the undo of creates: it drops cache entries and pins from `before` on, clears their references, and resets the counter, so the next create reuses the instance an undone create had taken. `keyFor(obj, index)` returns one index key, which `rebuildIndexVersions` uses. `replaceTree` swaps in a rebuilt sparse tree. `refAt` and `relocate` are the type's half of the arena's owner interface, which the database forwards by type. `index(name)` throws on an unknown name, and `hotSize` is the size of the type's cache.

`clear()` frees every arena entry, empties the tables, the cache, the pins and the B+ trees, gives the cache's entries back to the budget, and resets the counter, but leaves the sparse trees; nothing in `src/` or `test/` calls it.

### src/db/proof.ts

Purpose: the proof shapes, their verifiers and their encodings, with no dependency on the database so a light client can import this file alone (`src/light/client.ts` and `src/light/verify.ts` import only `verifyObjectProof` and `verifyKeyProof` from here).

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

The wire form of a key proof, from `encodeKeyProof`, is: height u64, type u16, index position u8, key as length-prefixed bytes, the sibling array, an option holding the end leaf's 32-byte key hash and its value, then the type leg (counter, type root, index roots, type index, type count, top siblings). Decoding bounds every array: 64 siblings per dense-tree leg, 16 index roots, 256 sparse-tree siblings, 4 KiB keys and leaf values. A proof is about one height, and the height is carried in the proof so the light client knows which header (height + 1) to check it against. README.md measures a name proof at 958 bytes and its verification at 400,000 per second on a small state. The transaction and result proofs of RPC-SYNC-PROOFS.md section 2.2 are not in this file: that section places their verifiers in `src/types/txproof.ts`, which builds them from the same `leafHash` and `rootFromPath`.

### src/db/database.ts

Purpose: the object database itself: types, sessions, the committed and historical views, the per-version root, change reporting, persisted history, proofs, rebuild of index history, and bulk import/export.

Exports:

- `deepFreeze(value)`: re-exported from `src/db/freeze.ts` (above), so code that imported it from here still does.
- `interface DatabaseOptions { retainVersions?, hotObjects? }`: the window, where 0 keeps only the current version and `DEFAULT_RETAIN` is 100; and the budget of decoded objects the hot caches share, unbounded by default (`DEFAULT_HOT` is `Infinity`).
- `interface DatabaseMemory { arena; hotObjects; hotLimit; historyBytes }`: what `memory()` reports, "what the database holds in memory besides the trees and indices, for the memory guard and status".
- `interface ObjectChange { id; bytes | null }` and `interface Changes { version; objects; counters; history }`: what one `root()` changed, for a store.
- `interface HistoryRecord { trees; objects; counters }` and `TOP_TREE = 0`: what was true before one version.
- `encodeHistory(w, h)` / `decodeHistory(r)`: the record's wire form.
- `class UndoSession`: `created`, `modified`, `removed`, `counters`, `isActive`, `undo()`, `commit()`.
- `class ObjectDatabase`: everything else.

The history record's encoding is the one that ends up on disk under the application's `'h' || version` key:

```ts
export function encodeHistory(w: Writer, h: HistoryRecord): void {
  w.array(h.trees, (w, t) => {
    w.u16(t.tree).option(t.records.sizeBefore, (w, n) => w.u64(BigInt(n)));
    w.array(t.records.nodes, (w, [k, j, hash]) => w.u8(k).u64(BigInt(j)).fixed(hash));
  });
  w.array(h.objects, (w, [id, bytes]) => w.u64(id).option(bytes, (w, b) => w.bytes(b)));
  w.array(h.counters, (w, [type, n]) => w.u16(type).u64(BigInt(n)));
}
```

A node record is 1 + 8 + 32 bytes; a level fits in a u8 because heights are at most 48. The objects carry their full "before" encoding, which is why DESIGN.md's simplification list notes that history is written in full per version.

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

**Construction.** The constructor makes the shared budget and the arena first, with the database itself as the arena's owner, each question forwarded to the type the entry names; then it builds a `TypeIndex` (given the arena and the budget) and a `DenseMerkleTree` per type, both with the retention window, plus one top tree sized to the number of types:

```ts
  constructor(types: ObjectType<any>[], opts: DatabaseOptions = {}) {
    this.retain = Math.max(0, opts.retainVersions ?? DEFAULT_RETAIN);
    this.hotBudget = { limit: Math.max(0, opts.hotObjects ?? DEFAULT_HOT), size: 0 };
    this.arena = new Arena({
      refOf: (type, instance) => this.types.get(type)?.refAt(instance) ?? -1,
      relocate: (type, instance, ref) => this.types.get(type)!.relocate(instance, ref),
    });
    for (const t of types) {
      if (this.types.has(t.id)) throw new Error(`duplicate object type ${t.id}`);
      this.types.set(t.id, new TypeIndex(t, this.retain, this.arena, this.hotBudget));
      this.trees.set(t.id, new DenseMerkleTree(this.retain));
    }
    this.order = [...this.types.keys()].sort((a, b) => a - b);
    this.top = new DenseMerkleTree(this.retain);
    this.top.resize(this.order.length);
  }
```

`order` is the type ids sorted ascending; a type's position in it is its leaf in the top tree, so the app hash depends on the set of registered types and nothing else about registration order. Duplicate type ids throw.

**The dial.** Two methods turn the cache down and up and report what the database holds:

```ts
  /** Change the hot caches' shared budget at run time (the memory guard's first dial); the excess is evicted at once. */
  setHotLimit(limit: number): void {
    this.hotBudget.limit = Math.max(0, limit);
    for (const ti of this.types.values()) ti.evict();
  }

  memory(): DatabaseMemory {
    return { arena: this.arena.stats, hotObjects: this.hotBudget.size, hotLimit: this.hotBudget.limit, historyBytes: this.historyBytes };
  }
```

`setHotLimit` changes the shared limit and lets every type evict down to it at once; the node calls it on every level change of the memory guard, when its application is the core one ([chapter 8](08-node.md)). A limit below what is pinned is not met until the next root unpins: written objects stay whatever the budget. `memory()` reports the arena's `stats`, the decoded objects cached and their limit, and the bytes of past values the window keeps, which `historyBytes` counts up as history is recorded or loaded and down as it is pruned; the RPC's `status` carries it ([chapter 12](12-rpc.md)).

**Reads.** `get(type, id)` is a map lookup for the type and then the type index's `get`, a cache hit or a decode from the arena, and returns null if the id's type does not match. `lookup(type, index, key)` is an exact match on a unique index. `scan` and `range` are prefix scans on any index, yielding objects in key order. `scanFrom(type, index, start)` yields `[key, object]` pairs from the first key at or after `start` to the end of the index, with no prefix test: it exists for paged listings, where the caller holds the last key it served and wants to resume just past it, and it yields the key alongside the object so the caller can tell where the next page starts. `nextInstance(type)` is the live counter. All of these see the live state, sessions included; the committed view is separate.

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

The fold applies the same first-touch rules as the writes: the parent keeps its own counters and old values where it has them, inherits the child's where it does not, and a removal of something the parent created cancels out. This is the transaction-inside-block case: a transaction's session commits into the pending session, and if the pending session is later undone, the transaction's effects go with it.

**The committed view.** `getCommitted` and `committedNextInstance` walk `sessions` from the outermost:

```ts
  getCommitted<T extends AnyObject>(type: ObjectType<T>, id: ObjectId): T | null {
    for (const s of this.sessions) {
      if (s.created.has(id)) return null;
      const m = s.modified.get(id);
      if (m) return m as T;
      const r = s.removed.get(id);
      if (r) return r as T;
    }
    return this.get(type, id);
  }
```

A created id is null, a modified or removed id is its old value, and otherwise the live object is the committed one. The outermost session is consulted first because an inner session's old value may be something the outer session wrote. `test/db.test.ts` ("proofs describe committed state while a session is open") shows a proof made with a session open verifying against the root computed before it, and `src/app/core/app.ts` serves its account, balance and global-object queries through `getCommitted` for the same reason (review finding 19 was about RPC methods that read live state instead).

**Step 3: `root(version)`.** This is the only method that touches the trees. It refuses to run with a session open and requires versions to increase; the first root sets the floor and marks every type touched so that every type leaf is written. The dirty loop:

```ts
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
        ti.flush(instance, bytes);
        if (keepHistory && before !== undefined) {
          const beforeBytes = before ? encode((w) => ti.type.encode(w, before)) : null;
          let entries = this.valueHistory.get(id);
          if (!entries) this.valueHistory.set(id, (entries = []));
          entries.push({ v: version, bytes: beforeBytes });
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
    // Pins are off; each type's hot cache comes back under the budget in one pass.
    for (const ti of this.types.values()) ti.afterRoot();
    if (historyIds.length > 0) this.valueHistoryByVersion.set(version, historyIds);
```

Each dirty id falls into one of four cases. An instance at or past the counter was created and undone, and never existed. An instance with nothing pending was put straight into the arena by `importObject` (the first root after an import, which is the restart path): its committed bytes are hashed as they are, with no decode and no encode, and copied out of the slab with `slice()` because the change list must outlive the next compaction. A pending value that is the same reference as the shadow was written and written back (a modify undone, an object created and removed again) and is settled and skipped, which is why `test/db.test.ts` ("reports what each root changed") sees neither `b` nor `c` in the change list. Everything else is encoded once, however many times it was modified since the last root, flushed into the arena (which frees the old entry and unpins the object), hashed into its leaf and pushed onto the change list; when history is kept (`retain > 0` and this is not the first root), the value before is encoded too and remembered as bytes, both in `valueHistory` and in the record a store will write, and counted in `historyBytes`. The comparison is by reference, not by value: an object modified to an equal but distinct record is treated as changed, hashed, and reported, which is harmless. After the loop nothing is pinned, and `afterRoot` brings every type's cache back under the budget.

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

Then every type tree advances, touched or not, so that historical reads line up across trees:

```ts
    for (const type of this.order) {
      const ti = this.typeIndexById(type);
      const tree = this.trees.get(type)!;
      tree.resize(ti.nextInstance);
      const typeRoot = tree.root(version);
      const indexRoots = ti.authenticated.map((name) => ti.trees.get(name)!.commit(version));
      const previous = this.lastIndexRoots.get(type);
      if (!previous || indexRoots.some((r, i) => !bytesEqual(r, previous[i]!))) touched.add(type);
      this.lastIndexRoots.set(type, indexRoots);
      if (touched.has(type)) this.top.setLeaf(this.order.indexOf(type), typeLeaf(type, BigInt(ti.nextInstance), typeRoot, indexRoots));
      const recs = tree.lastRecords;
      if (keepHistory && (recs.nodes.length > 0 || recs.sizeBefore !== null)) record.trees.push({ tree: type, records: recs });
    }
    const root = this.top.root(version);
```

A type leaf is rewritten when its objects changed, its counter moved, or any authenticated index root changed. The sparse trees are committed here and nowhere else, so their versions coincide with the dense trees'. The top tree's records go in under `TOP_TREE`. Finally the version advances, `lastChanges` is set, and `pruneHistory(version - retain)` drops object and counter history that only serves versions outside the window, taking its bytes off `historyBytes` and mirroring the tree's `prune` (the trees prune themselves inside their own `root`). The very last step is the arena's:

```ts
    if (this.retain > 0) this.pruneHistory(version - this.retain);
    // Slabs the block left more than half dead are compacted now, while the node idles.
    this.arena.maintain();
    return root;
```

A block rewrites every object it touches, so the slabs written before it collect dead entries, and the ones now more than half dead, two at most, are copied out and released here. The change list is safe from it: every byte array in it is a fresh encoding or a copy.

**Step 4: what the store does with it.** `lastChanges` holds the encoded bytes of every changed object, and `src/app/core/app.ts` writes them in one key-value transaction: a put or delete per object, the moved counters, the history record under `'h' || version`, a delete of the history record for the version that just left the window, and the height and app hash. Then it calls `dropChanges()`. Review finding 36 is why that method exists: the change list after genesis is a second copy of the whole state, and after a restart (where the root is recomputed over every object) the same again, measured at 500 MiB per gigabyte of genesis; `test/genesis.test.ts` asserts `db.lastChanges` is null in both situations.

**Step 5: proofs at any version in the window.** `checkVersion` requires a computed root and a version in `[lowestVersion, currentVersion]`, where the database's `lowestVersion` has the same shape as a tree's: the larger of its floor and `version - retain`. `getAt(type, id, version)` and `countAt(type, version)` are the historical reads:

```ts
  /** The object as of a past version inside the retention window. */
  getAt<T extends AnyObject>(type: ObjectType<T>, id: ObjectId, version: number): T | null {
    this.checkVersion(version);
    const entries = this.valueHistory.get(id);
    if (entries) for (const e of entries) if (e.v > version) return e.bytes ? deepFreeze(decode(e.bytes, (r) => type.decode(r, id))) : null;
    return this.getCommitted(type, id);
  }

  /** The encoding of an object as of a past version inside the window, without decoding it: for snapshots and proofs. */
  bytesAt(id: ObjectId, version: number): Uint8Array | null {
    this.checkVersion(version);
    const entries = this.valueHistory.get(id);
    if (entries) for (const e of entries) if (e.v > version) return e.bytes;
    const ti = this.typeIndexById(typeOf(id));
    for (const s of this.sessions) {
      if (s.created.has(id)) return null;
      const old = s.modified.get(id) ?? s.removed.get(id);
      if (old) return encode((w) => ti.type.encode(w, old));
    }
    return ti.bytesFor(instanceOf(id)) ?? null;
  }
```

The first entry with `v > version` holds the value before that later change, which is the value at `version`, as bytes, decoded and frozen here; with no such entry the committed value is right, so a historical read also looks through open sessions, as the versions test checks. `bytesAt` is the same walk without the decode: a history entry's bytes as they are, else the encoding of an old value an open session recorded (looking through sessions as `getCommitted` does), else the type index's current encoding, which is a view into the arena when nothing is pending. Snapshot export ([chapter 11](11-application.md)) and proofs take their bytes from it. `proofAt(id, version)` assembles the proof:

```ts
    return {
      height: BigInt(version),
      id,
      value: this.bytesAt(id, version)?.slice() ?? null,
      nextInstance: BigInt(count),
      typeRoot: tree.rootAt(version),
      typeSiblings: instance < count ? tree.pathAt(instance, version) : [],
      indexRoots: ti.authenticated.map((name) => ti.trees.get(name)!.rootAt(version)),
      typeIndex: idx,
      typeCount: this.order.length,
      topSiblings: this.top.pathAt(idx, version),
    };
```

The value is a copy (`slice()`), since what `bytesAt` returns may be a view into a slab that a later compaction releases. `proof(id)` is `proofAt` at the current version. `typeLeafProofAt(type, version)` returns just the type leg, which the snapshot manifest uses for every type and the importer checks against the header's app hash; `rangeProofAt(type, from, to, version)` returns the siblings for a chunk of instances; `rootAt(version)` is the app hash at a version; `typeOrder` exposes the leaf order. `proveKeyAt(type, index, key, version)` and `proveKey` build a `KeyProof` from the index's sparse tree at that version plus the same type leg, throwing `DbError` if the index is not authenticated. README.md measures a past-height object proof with verification at 37,000 per second on the gigabyte state, within a tenth of the current-height figure, because the history lookups are a few map reads per node.

**Step 6: a restart.** `openObjectDatabase` in `src/app/core/app.ts` imports every stored object with `importObject(id, bytes)` (allowed only before the first root and with no session open; it puts the bytes into the arena as they are, decodes them once for the index keys, and bumps the counter past the instance), sets the counters with `setCounter` (which refuses a counter below an imported object), calls `root(height)`, compares with the stored app hash, drops the change list, and then feeds back the history records inside the window in ascending version order with `loadHistory(version, rec)`:

```ts
  loadHistory(version: number, rec: HistoryRecord): void {
    if (this.version < 0 || version > this.version) throw new DbError(`cannot load history for version ${version}`);
    if (version - 1 < this.floor) this.floor = Math.max(0, version - 1);
    if (version <= this.lowestVersion) return;
    // Every tree can answer for version - 1: the ones this record names from their records, the rest
    // because nothing touched them, so their later state is also their state then.
    this.top.lowerFloor(version - 1);
    for (const tree of this.trees.values()) tree.lowerFloor(version - 1);
    for (const t of rec.trees) (t.tree === TOP_TREE ? this.top : this.trees.get(t.tree))?.loadRecords(version, t.records);
```

It then keeps each object's "before" bytes in `valueHistory` exactly as the store gave them back, decoding nothing (a past value is decoded only when a past version is read), counts them in `historyBytes`, and restores the counter history. The ascending order comes for free from the store: history keys are `'h'` followed by a big-endian u64, so a range scan yields them in version order. The floor is lowered to `version - 1` because a record for v describes the state at v-1.

The two `lowerFloor` lines are the fix for review finding 44. A record names only the trees that changed in its version, and a `DenseMerkleTree`'s floor used to move only inside `loadRecords`, so a type whose objects did not change anywhere in the window (accounts on a quiet chain, where only balances move) kept its floor at the restart height, and `proofAt` for one of its objects at an earlier version threw `RangeError: version ... is not available` from `tree.rootAt` while `lowestVersion` admitted the version. Lowering every tree's floor is sound for exactly the reason the comment gives: a tree the record does not name was untouched in that version, so its current hashes are its hashes then. The regression test in `test/review.test.ts` reopens a store after three transfer blocks and proves both a balance (changed in every retained version) and the faucet account (changed in none) at height 2.

**Step 7: rebuilding index history.** Sparse-tree versions are root pointers into an in-memory structure, so they do not survive a restart. Rather than persisting tree nodes, `rebuildIndexVersions` reconstructs them from the object history, which is possible only because the tree has one shape per key set:

```ts
      for (const name of ti.authenticated) {
        const rebuilt = new SparseMerkleTree(this.retain);
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

The candidates are every present instance of the type (`instances()`, which decodes nothing) plus every id of the type with history. The history holds bytes, so the keys a version released are found by decoding each changed object's earlier bytes in the loop, and `getAt` decodes the values it puts. The tree is built at the lowest version, committed, then replayed one version at a time. The comment on the inner loop is review finding 12: the first version of this code dropped and re-added per object, so when two objects swapped keys in one block (validator keys A to temporary, B to A, temporary to B), a later drop erased a key the previous put had just taken, and every affected node failed to restart with "rebuilt index does not match the live one". Dropping every released key before putting any taken key fixes it; `test/review.test.ts` reproduces the swap. The final check against the live root is the safety net: if the rebuild is wrong in any way, the node refuses to start rather than serve wrong proofs. README.md's large-genesis figures show the cost: of an 11.8 s restart, 3.7 s is this rebuild, which is why it notes the authenticated name index is "built twice, once live and once to recover past versions". The method returns early when `lowestVersion === version`, that is, when no history was loaded.

**Bulk import and export.** `importObject(id, bytes)` loads one object into a fresh database:

```ts
  /** Load one object into an empty database, before the first root(). Counters are set separately. */
  importObject(id: ObjectId, bytes: Uint8Array): void {
    if (this.version >= 0 || this.sessions.length > 0) throw new DbError('import only into a fresh database');
    const ti = this.typeIndexById(typeOf(id));
    // Decoded once for its index keys and not kept: the arena holds the bytes, the first root hashes them as they are.
    ti.importCommitted(decode(bytes, (r) => ti.type.decode(r, id)), bytes);
    if (instanceOf(id) >= ti.nextInstance) ti.nextInstance = instanceOf(id) + 1;
    this.dirty.add(id);
  }
```

The object is decoded once, because its index keys are computed from the decoded form, and then dropped: `importCommitted` keeps the bytes in the arena, and the id is marked dirty so the first root hashes them as they are. `exportObjects()` yields every object of every type in id order as encoded bytes, walking `instances()` and taking `bytesFor`, so nothing is decoded: the bytes are views into the arena (or a pending value's encoding), good until the next compaction, and `src/app/core/app.ts` writes them to the store at once. `counters()` returns the counters. `encodeSnapshot(height, appHash)` writes `SNAPSHOT_VERSION` (2), the height, the hash, and per type in order the counter and the present objects:

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

Each object's bytes come from `bytesFor`, so a snapshot decodes and encodes nothing. It refuses to run with a session open and is deterministic, which `test/db.test.ts` checks by re-encoding the loaded copy. `loadSnapshot(bytes)` is the inverse into a fresh database, rejecting an object whose id does not match its type section or lies at or past the section's counter, and returns the height and app hash the snapshot claims so the caller can compare them with `root()`. It bounds the type array by the number of registered types but does not check that every registered type is present or that sections arrive in `order`. The state-sync path in `src/app/core/snapshot.ts` does not use this format; it uses `importObject` and `setCounter` directly, chunk by chunk, and checks `typeLeafProofAt` for every type against the manifest, whose `verifyManifest` does make the strict check: the manifest must name every registered type exactly once, in id order.

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
- "dense merkle tree: matches a naive computation and proves every leaf at every size": `DenseMerkleTree` against a from-scratch fold for 1 to 11 leaves, every path at every size.
- "releases chunks whose nodes are all empty, and hashes holes like a fresh tree": 4096 leaves allocate 17 chunks (4 + 2 + 1 at levels 0 to 2, one at each of levels 3 to 12); emptying the first half releases 3; the root equals a fresh tree with only the second half; emptying everything reaches `EMPTY` with no chunks.
- "serves paths at past versions inside the window and forgets older ones": with retention 3, every version in the window reproduces its root and every path, a leaf beyond the old size throws, and a version outside the window is refused.
- "object database: reproduces at a later version the proofs it made at the time": with retention 5 over 12 versions of creates, modifies and removes across two types, `proofAt` at every old version produces byte-identical proofs to the ones made at the time; `getAt` reads through an open session.
- "reports what each root changed, for a persistent store": the change list contents, including that an undone modify and a create-then-remove are not reported.
- "b+ tree: agrees with a reference map under random inserts, overwrites and deletes" and "scans prefixes and ranges in order after sequential inserts": correctness of the tree, including deletion down to empty, prefix scans of 256 keys, and `entriesFrom` after deleting every other key.
- "sparse merkle tree: has one shape per key set whatever the history, and proves presence and absence": 3000 random writes and deletes equal a sorted rebuild; membership and absence proofs fold to the root; claiming another leaf's value for the queried key does not fold; a version keeps the old tree after everything is deleted.
- "keeps past versions inside the window": `proveAt` and `rootAt` inside a window of 2, refusal outside.
- "object database: key proofs: proves index keys and rebuilds index versions from history": present names prove to their id and absent ones to null at every version; then a fresh database is fed `exportObjects`, `counters`, `loadHistory` for every version and `rebuildIndexVersions`, and every key proof and object proof in the window is byte-identical to the original's.
- "object database: arena and hot cache: serves reads from the arena once decoded objects are evicted, and never evicts what is dirty": with a budget of two, five unrooted objects stay cached, pinned, until the root; then the cache keeps its budget while every object reads correctly from the arena, frozen, by id and by name; a removal is a tombstone that hides the object and leaves it out of the export before the root frees its bytes; and with a budget of zero a modified object stays cached until the root, then reads back from the arena.
- "keeps history as bytes, agrees between getAt and bytesAt, and exports after churn what it holds": with a budget of one, `bytesAt` at every version is the encoding of what `getAt` returns, `historyBytes` is counted, every exported object is the encoding of what `get` returns, and the window still closes behind.
- "computes the same roots whatever the cache budget": five versions of creates, modifies and removes give the same roots with a budget of zero as with a million.

`test/arena.test.ts` tests the arena alone, with a `Map` as its owner: "stores encodings across growing slabs and reads them back" (a 300,000-byte entry opens a second slab of 512 KiB, `used` counts every header, an encoding past `MAX_ENTRY` and a reference into a slab never made are refused), and "counts freed entries dead and compacts a slab that is more than half dead, moving the live ones" (nothing is compacted while the slab is the current one; once it is not, its live quarter moves to the next slab, byte for byte, the owner gets the new references, 256 KiB is released, and a new entry never reuses the released slab's number).

`test/review.test.ts` adds the regressions from REVIEW-2026-10-28.md that belong to this layer: "rebuilds index history correctly when two objects swap keys in one version" (finding 12), "prunes sparse tree versions even with a zero retention window" (finding 29), and "proves a past height for an object type nothing changed in the window, after a restart" (finding 44: an application on a `MemoryKv` runs three transfer blocks, is reopened from the store, and proves a balance and the faucet account at height 2 against `db.rootAt(2)`).

`test/app.test.ts` exercises the database through the real application: "proves objects against the app hash" (a proof goes stale when another type's leaf changes the top tree); "proves past heights inside the retention window" (balances at heights 2 to 6 decode to the expected amounts, a height outside the window throws, a proof against the wrong hash fails); "proves account names present and absent, now and at past heights" (key proofs for names and symbols, tampering, a name proven absent against the genesis hash, and index roots agreeing between an object proof and a key proof at the same height); and "restarts from the store with the same app hash and keeps producing the same hashes" (after a restart the window is provable again from height 0, name proofs at past heights are byte-identical, and after more blocks the oldest versions leave memory and the store).

`test/genesis.test.ts` ("loads a genesis whose application state is in a file ...") checks that neither a fresh nor a reopened database keeps `lastChanges`, finding 36.

## Limitations and ideas

Known simplifications, from DESIGN.md section 10 and the code:

- Only unique indices can be authenticated. Balances by owner and the other non-unique indices are not in the state root, so "all balances of account X" cannot be proven, only each balance by id.
- History records are written in full per version; a node down longer than the window starts its window afresh from the height it resumes at.
- The B+ tree merges but never borrows, so fill can degrade under adversarial delete patterns.
- Versions must be consecutive for leaf and inner history to agree (`pendingVersion` in `src/db/merkle.ts`); the code relies on callers using heights.
- `loadSnapshot` does not check that every registered type is present (noted and left in REVIEW-2026-10-28.md).
- All consensus state lives in memory, by design: README.md measures a 1 GB genesis at about 1.1 GB of process memory at rest, and a node joining by state sync at about three times the state during the join. Phase one of STATE-PAGING.md keeps the objects as bytes behind a bounded cache, but decoded objects were only about a sixth of the heap; the secondary indices, the name tree and the Merkle trees, the other five sixths, stay resident until the later phases put them in LMDB.

Exercises:

1. Add borrowing from a sibling to `rebalance` in `src/db/bptree.ts` and measure average leaf fill after the random test's 60,000 operations, before and after.
2. Convert an `ObjectProof` into two ICS23 `ExistenceProof` messages (one per leg) and check them with an off-the-shelf ICS23 verifier configured with the spec in the header of `src/db/proof.ts`.
3. Write a property test for range proofs: for random leaf counts and ranges, `rangeProofAt` and `rootFromRange` must agree with `rootAt`, and a proof with one sibling dropped, duplicated or swapped must make `rootFromRange` return null or a different root.
4. Persist sparse-tree versions instead of rebuilding them: write the path copied by each `set` and `delete` to the store, and compare restart time against the 3.7 s the README reports for the rebuild.
5. Authenticate a non-unique index with a sparse tree over `key || id` and design a proof for "every entry with this prefix"; note what the type leaf would have to carry.
6. Make `loadSnapshot` strict: require every registered type in `order`, and add a test that a snapshot with a missing or extra type is rejected.
7. Count the hot cache's hits and misses per type, report them in `memory()`, and run the genesis benchmark's block of random transfers with the cache capped at 100,000 and at 10,000: how closely does the block time follow the miss rate?

## Where to next

[Chapter 10, the store](10-store.md): the key-value interface the change lists and history records are written to, LMDB behind it, and the block store.
