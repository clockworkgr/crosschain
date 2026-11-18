# Benchmarks

What is measured, how, what the numbers were on one machine, and what they say about where the
time and the memory go. The benchmark code is in `bench/`; the figures here are from one batch
of runs made on 2026-11-15 (section 3), except where a passage says it records an earlier
build, and the [README](../README.md#performance) summarises them.

## 1. Running them

```sh
npm run bench                  # crypto, codec, db, store, app, network: two to three minutes
npm run bench -- db app        # a subset
npm run bench:genesis          # the genesis and scale suites on a 1 GB genesis: about three minutes
BENCH_GENESIS_MB=100 npm run bench:genesis   # a smaller genesis
CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 npm run bench -- paging   # the paging suite: that state under the memory guard's modes (section 4.13)
BENCH_PAGING_HEAP=700 CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 npm run bench -- paging   # with the node's heap limit set in MiB
BENCH_PAGING_SECONDS=600 BENCH_PAGING_WINDOW=20 BENCH_PAGING_AHEAD=4000 BENCH_PAGING_MODES=0 CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 npm run bench -- paging   # a stress run: ten minutes, 20 s windows, 4,000 transfers kept ahead, node only
node bench/cold-reads.ts <dir> <accounts> [reads]   # time index reads one by one from a store the paging suite built (section 4.13)
BENCH_KEEP=1 npm run bench:genesis           # keep the generated files and stores for inspection
BENCH_LOG=debug npm run bench -- network     # log the late-joining node of the network suite
CHAIN_SCHEME=secp256k1 npm run bench         # every suite on secp256k1 keys; ML-DSA-44 without it
```

Both scripts run Node with `--expose-gc` so memory can be measured after a collection. Nothing
else is special: the benchmarks are plain TypeScript run by Node like the rest of the code.
Temporary files go under the system temp directory. The genesis, scale and paging suites keep
theirs when `BENCH_KEEP` is set; the app and store suites always remove theirs. The paging
suite is not part of `bench:genesis`: it builds the same large state, runs a node in a child
process under a real heap limit for 40 seconds and then the database through each mode the
guard can set, so it is asked for by name.

`bench/cold-reads.ts <dir> <accounts> [reads]` is a script of its own, not a suite. It opens
the application store the paging suite built in `<dir>` read-only and without a node, since a
node reads its whole store when it opens and would warm it, and reads it as a node with
`indexTrees: 'store'` reads its indices: an account by name (one index entry), the account's
object by the id found, and a page of twenty index entries in name order from a random name,
`reads` times each (3,000 when absent). Every read is timed on its own and the times are
printed in groups of 500, first to last, as mean, median, 99th percentile and longest, in
microseconds. `<accounts>` is the number of accounts in the store, from which the names are
drawn. It is meant to run after the store's volume has been remounted, so that none of the
store is in the operating system's page cache; the paging suite does both between building
the store and starting its node when `BENCH_PAGING_BEFORE_NODE` is that command. The run of
section 4.13 was made on macOS, where `hdiutil` detaches and attaches a disk image, with
`TMPDIR` on the image so that the suite builds its store there:

```sh
TMPDIR=<image>/tmp CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=150 BENCH_PAGING_SECONDS=4 BENCH_PAGING_MODES=0 BENCH_PAGING_BEFORE_NODE="hdiutil detach <image> && hdiutil attach <file> && node bench/cold-reads.ts <image>/tmp/crosschain-paging-* 514008 5000" node --expose-gc bench/run.ts paging
```

`<image>` is where the image is mounted and `<file>` the image's file.

Each suite prints its results as it goes and the runner ends with two markdown tables: one of
rates (`ops/s`, mean, median and 99th percentile of an iteration) and one of measurements that
are not rates (sizes, counts, memory, elapsed phases).

## 2. The harness

`bench/harness.ts` is sixty lines of substance:

- `bench(name, options, fn)` runs `fn` for `warmup` untimed iterations (default one), then until
  a time budget (`maxMs`, default 2 s) or an iteration count (`iterations`) runs out, with at
  least `minIterations` measured (default three). The admission benchmarks, which cannot submit a
  transaction twice, set no warm-up and a single iteration. It records the wall time of each
  iteration with `performance.now()`, sorts the samples, and
  reports ops per second as `batch × iterations / total`, where `batch` is the number of work
  units one iteration performs (a loop of a thousand lookups has `batch: 1000`). The median and
  the 99th percentile come from the sorted samples. An optional `before` hook runs untimed
  before every iteration, which is how the application benchmarks get a fresh application for
  each block without timing its construction.
- `fact(name, value)` records a measurement that is not a rate.
- `heapMiB()` and, in `bench/bigstate.ts`, `memory()` read `process.memoryUsage()` after forcing
  garbage collection; `memory()` lets the event loop turn and collects twice, because array
  buffers (the backing stores of every key and hash) are released by a sweep after the first
  collection and a single call under-reports what is free.
- `machine()` prints the CPU model, core count, memory, Node version and platform at the top of
  every run.

Suites are modules exporting `run()`; `bench/run.ts` runs the ones named on the command line, or
the default six. `bench/fixtures.ts` holds the shared material: a thousand funded user accounts,
a genesis with and without validators, and pre-signed transfers between the users, signed once
and cached, because signing is the slow part of setting up.

## 3. Method and caveats

- **One machine, one process.** All figures are from an Apple M4 Pro (12 cores, 48 GB) on Node
  24.13, macOS. The network suites run four validators inside the benchmark process on the
  in-memory transport with one millisecond of simulated latency, sharing one verification pool
  of eleven threads. They measure the engine and the application, not the wire or the kernel.
- **One batch.** Every figure that describes the node as it stands is from one batch of runs
  made on 2026-11-15, one after another on the idle machine, on the code as it stood that day:
  the paging suite in the configurations of section 4.13, then the six default suites and the
  genesis and scale suites under each scheme, whose figures here are from the runs made after
  the paging ones. Each configuration was run once unless a table
  shows several runs. Passages that record what an earlier build measured, to explain why
  something was changed, say so; those builds cannot be run again and their figures are as they
  were recorded then.
- **Signing varies.** ML-DSA-44 signing has a rejection loop; its mean was 2.85 ms in this
  batch and earlier runs read between 2 and 9 ms. secp256k1 signing has no such loop and stays
  at 0.23 ms. Verification is stable under both, about 0.9 ms and 0.7 ms.
- **One scheme per run.** Every suite runs under the chain's default scheme, ML-DSA-44, unless
  `CHAIN_SCHEME=secp256k1` is set; the crypto suite alone measures both schemes in one run.
  Sections 4.1 to 4.8 are from the ML-DSA-44 runs, section 4.9 from the secp256k1 runs, and the
  paging suite of section 4.13 ran under secp256k1.
- **p99 holds outliers.** Iterations that allocate see a 10 ms 99th percentile on a 1 ms
  median. A garbage collection landing in the iteration is a possible cause; the harness
  records elapsed time only and does not attribute it.
- **RSS is not a budget.** Resident set size includes LMDB's memory map (file-backed,
  evictable) and pages the allocator keeps after a release. Heap plus array buffers after a
  collection is the figure that says what the process needs.
- **Sizes are MiB** (2^20 bytes) throughout; "1 GB genesis" means 1,000 MiB of JSON.
- **Two runs of one configuration differ.** Where this batch ran a configuration of the node
  under load twice, the two runs differed by up to a tenth: 1,634 and 1,771 transfers a second
  for forty seconds at 1.25 times the resident heap, 1,500 and 1,648 for three minutes with
  readers at 4.0 times, 1,561 and 1,682 with readers at the resident heap, 1,335 and 1,402 and
  then 1,246 and 1,348 for the two window settings at 514,008 accounts. One pair agreed to a
  part in a thousand (1,689 and 1,687). So a difference of less than a tenth between two node
  runs is not read as a difference here. The suites were run once under each scheme.
- **The batch was run again and its figures kept.** On 16 November 2026 the batch was repeated on
  the code as it stood after the block size became the chain's and the shutdown paths were
  closed, all but the three runs that read from a freshly mounted volume. Every node run read
  within a tenth of its 15 November rate but one: the published run of section 4.13 read 1,308
  transfers a second where it had read 1,771. It was the first run of the batch, started as the
  test suite finished; run twice more it read 1,625 and 1,742. The rows of the suites moved
  further, some by a quarter and a few by more, but a second run of the same suites on the
  same code that evening differed from the first by as much (`saveBlock` 82 and 110 a second
  under ML-DSA-44, 94 and 126 under secp256k1), so those differences say nothing about the
  code. The figures in this document are the 15 November ones.
- **A short benchmark can measure the compiler.** The empty-block row of section 4.5 read 175
  microseconds in some runs and 450 in others while it timed twenty blocks after the full
  ones: the engine was running code compiled for the full blocks, or had just discarded it and
  not yet compiled it again. It now runs 1,000 untimed blocks first, and its figure is from a
  run made after the batch (section 4.5). A row measured over few iterations straight after
  different work is open to the same effect.
- **The tables are copied from one run's output.** The runner prints the machine, the date and
  its tables and saves nothing itself, so a figure here is an observation on that day, not a
  constant: rerun and compare before relying on one.
- **Two suites bypass what a deployed node would pay.** The scale suite's RPC figures are
  measured with the server's rate limiter raised out of the way (10⁹ tokens a second, costly
  calls charged one), and its state-sync figure runs the pipeline inside one process from the
  local store, without peers or light-client verification; sections 4.8 and 5 say so where they
  apply.

## 4. The suites

### 4.1 crypto

What the whole system rests on: key generation, signing and verification under each of the two
schemes, sha256, and the worker pool that spreads verification over threads.

| benchmark | ML-DSA-44 ops/s | mean | secp256k1 ops/s | mean |
|---|---:|---:|---:|---:|
| keyPairFromSeed | 1,479 | 0.68 ms | 5,008 | 0.20 ms |
| sign (256 B message) | 351 | 2.85 ms | 4,296 | 0.23 ms |
| verify, inline | 1,130 | 0.89 ms | 1,367 | 0.73 ms |
| WorkerVerifier.verify, 256 signatures on 11 threads | 7,781 | 32.9 ms per 256 | 9,188 | 27.9 ms per 256 |
| WorkerVerifier.verifyOne (round trip) | 940 | 1.06 ms | 1,261 | 0.79 ms |

sha256 over 2.5 KB: 784,962 a second, 1.3 microseconds each (255 microseconds per 200).

Sizes, tag included: ML-DSA-44 public key 1,313 bytes, signature 2,421, secret key 2,561;
secp256k1 public key 34, signature 65, secret key 33.

Analysis. Verification in pure JavaScript is close between the schemes: one core verifies 1,100
ML-DSA-44 or 1,400 secp256k1 signatures a second, and eleven threads reach 7,800 and 9,200,
speed-ups of 6.9 and 6.7, with the rest lost to serialising jobs into worker messages. A single
job through the pool costs about as much as verifying inline (1.1 ms against 0.9 for ML-DSA-44,
0.8 against 0.7 for secp256k1), so the pool only pays when it is given batches; that fact
shaped the application change in section 6. Signing and sizes are not close: secp256k1 signs
twelve times faster and makes a key pair more than three times faster, and its public keys and
signatures are about a fortieth the size (its secret key a seventy-eighth), which takes a
transfer from 2.5 KB to 154 bytes and a validator's share of a commit from 2.4 KB to 66 bytes.
Hashing 2.5 KB is two to three orders of magnitude cheaper than signing or verifying, 180 to
2,200 times across the four operations measured, and never appears in a profile.

### 4.2 codec

| benchmark | ops/s |
|---|---:|
| encodeTransaction | 896,000 |
| decodeTransaction | 1,270,000 |
| txHash | 773,000 |
| txsRoot over 500 transactions | 649 (1.5 ms) |

A signed transfer is 2,510 bytes under ML-DSA-44: a 41-byte operation, 48 bytes of framing and
signer address, and a 2,421-byte signature, tag included; under secp256k1 the signature is 65
bytes and the transfer 154. The suite's line `transfers per block at the
default limit, less the 1 KiB the builder leaves` reads 1,667 (26,539 under secp256k1): 4.00 MiB
of transactions and evidence; the header and the commit are not counted. That is the builder's
own sum, since the limit is on what the proposer chooses and the builder gives the transactions
the limit less the evidence and 1 KiB, so the count no longer depends on the validator set, only
on the evidence. In a network run made after that change the largest block held 1,667 transfers,
the codec's figure exactly, and encoded to 4.01 MiB with its header and commit. The batch's run
in section 4.6 was made under the earlier rule, which counted the header and the commit (about
10 KiB with four signatures) against the limit, and filled a block with 1,663. Encoding and decoding are about a microsecond each and never matter.

### 4.3 db

The object database on its own, in memory, with 100,000 balance objects and later 20,000
accounts whose names live in a sparse Merkle tree.

| benchmark | ops/s | mean |
|---|---:|---:|
| create 100,000 balance objects | 632,000 | 158 ms for all |
| first root over 100,000 objects | | 336 ms |
| modify 100 balances + root | 411 | 2.4 ms |
| modify 1,000 balances + root | 49.0 | 20 ms |
| modify 10,000 balances + root | 6.0 | 166 ms |
| get by id | 13,500,000 | 74 ns |
| lookup by unique index (byOwnerAsset) | 780,000 | 1.3 microseconds |
| scan 100 entries of a non-unique index | 10,500,000 | 95 ns per entry |
| object proof (current version) | 87,600 | 11 microseconds |
| object proof at a past version | 83,000 | 12 microseconds |
| verifyObjectProof | 65,500 | 15 microseconds |
| session: modify 1,000 then undo | 80 | 12.5 ms |
| create 20,000 accounts (name index is an SMT) + root | | 873 ms |
| create 1,000 accounts + root (1,000 SMT inserts) | 36 | 27 ms |
| name proof | 276,000 | 3.6 microseconds |
| verifyKeyProof | 54,300 | 18 microseconds |

Measurements: 100,000 balances with their trees take 94 MiB of heap; an object proof is 777
bytes with 21 sibling hashes; a name proof 958 bytes. The rows from the name proof on run on
100,000 balances and 26,000 accounts. After the 945 versions the suite had created by then, the
last 100 retained, the heap holds 719 MiB.

Analysis. The root after a block costs about 20 microseconds per changed object, the hashing of
each changed object's bytes included, and it scales linearly with the number of changes: 100
changes in 2.4 ms, 1,000 in 20, 10,000 in 166. A lookup by id is two map lookups, the type and
then the instance in the cache of decoded objects (42 ns in the build whose primary index was
an array of objects, 74 ns with the arena of section 4.10); a lookup by index walks a B+ tree,
whose depth grows with the log of the state, and at the sizes measured neither showed it. The
sparse Merkle tree for names costs about 27 microseconds per insert, five times a dense leaf,
which is why only unique indices that need proofs are authenticated. The last line of the
measurements is the one to remember: version history is retained objects times retained
versions, and a benchmark that modifies 10,000 objects per version for 100 versions keeps a
million prior values. At realistic block sizes that is tens of megabytes; the retention window
is the knob.

Two costs were added on purpose after the second review and were measured then, on that build.
A record is frozen through every nested object and array when it is created or modified, about
0.7 microseconds for an account-sized record; on the small balance objects of the create
benchmark that showed as the rate falling from 731,000 to 628,000 objects per second (632,000
in this batch), and in the modify rows, where hashing dominates, it did not show at all. And a
name proof is built from copies of the tree's hashes rather than references to them, which took
it from 2.5 to 4.6 microseconds on that build; it is 3.6 in this batch. Both are a small
fraction of the request they serve, and both close a way for a careless caller to corrupt the
database. An earlier build of this round made every proof list the store entries a past version
might need even when the version was in memory, and a name proof then took about 70
microseconds; the list is now made only when the store is asked.

### 4.4 store

LMDB through the key-value interface, and the block store on top of it.

| benchmark | ops/s | mean |
|---|---:|---:|
| write transaction: 1 put of 100 B (commit + sync) | 250 | 4.0 ms |
| write transaction: 1,000 puts of 100 B | 258,100 puts/s | 3.9 ms per transaction |
| get (random key) | 848,000 | 1.2 microseconds |
| range scan of 1,000 entries | 2,080,000 entries/s | 0.48 microseconds per entry |
| saveBlock (500 txs, results, tx index) | 108 | 9.2 ms |
| loadBlock | 2,548 | 0.4 ms |
| loadResults at a height with no results stored | 1,705,000 | 1 microsecond |

Analysis. A write transaction costs about 4 ms regardless of size, which is the sync to disk; a
thousand puts cost no more than one in this run. What the node writes per block at this size
(the block, the results, the index, 9.2 ms here, and the application's changes, 9.9 ms in
section 4.5) is under 20 ms when written apart, and the node writes them in one transaction
with one sync (section 5). Reads are memory-mapped and cost as much as a hash lookup plus a
copy. The `loadResults` row is a lookup that finds nothing: the benchmark asks for height 1 and
its first saved block is height 2, so the 1.7 million a second is the cost of an absent key,
and reading and decoding stored results was not measured. The figure recorded for an earlier
build, 24,000 a second (42 microseconds), is not compared with it. The `loadBlock` row draws
its heights from 1 up, so a load in every few hundred asks for height 1 and finds nothing
too.

### 4.5 app

The core application on its own: admission, blocks with and without cached signatures, commit to
memory and to LMDB. The genesis has 1,001 accounts; transfers are pre-signed.

| benchmark | ops/s | mean |
|---|---:|---:|
| checkTx, inline verifier, one at a time (500 txs) | 942 | 531 ms per 500 |
| checkTx, worker pool, 32 in flight (2,000 txs) | 5,799 | 345 ms per 2,000 |
| finalizeBlock 500 transfers, cold, inline verifier | 920 | 544 ms |
| finalizeBlock 500 transfers, cold, worker pool | 5,768 | 87 ms |
| finalizeBlock 500 transfers, warm (signatures cached by checkTx) | 25,000 | 20 ms |
| finalizeBlock 1,500 transfers, warm (about 3.6 MiB with a block shell) | 23,600 | 64 ms |
| finalizeBlock, empty block (after 1,000 untimed ones) | 3,501 | 0.29 ms (median 0.27 ms, p99 0.58 ms) |
| commit to memory (after a 500-transfer block) | 293 | 3.4 ms |
| commit to LMDB (after a 500-transfer block) | 102 | 9.9 ms |

Genesis with 1,001 accounts parses, applies and roots in 89 ms.

Analysis. A warm block, whose signatures the mempool already verified, runs at 23,600 to 25,000
transfers a second: evaluation, the per-transaction key resolution and authority check, the
history records and the root together cost 40 to 42 microseconds per transfer. A cold block,
where every signature must be verified, runs at the pool's speed, 5,800 a second. The
difference is the whole cost of signatures and the reason the mempool verifies at admission: a
validator that saw the transactions through gossip spends 64 ms on 1,500 transfers (about 3.6
MiB with a block shell; the benchmark hands the transactions straight to the application,
without building a block), and one that did not would spend about 260 ms, an estimate of three
times the 86.7 ms measured for a cold block of 500, a cold block of 1,500 not having been
measured. Commit to LMDB is 9.9 ms, one write
transaction for the application's store. It was 8.8 ms in the build before the secondary index
entries and the Merkle trees' chunks and nodes were written in that transaction with the
objects (sections 4.11 and 4.12): a 500-transfer block writes about a thousand entries (each
transfer leaves a recent transaction id, which has two indices; the balances change no key),
and at 1,001 accounts its chunks cost nothing measurable. Commit to memory carries the same
bookkeeping: 2.6 ms in that earlier build, 3.1 to 3.9 ms when the change was measured, 3.4 ms
in this batch. An empty block took 32 microseconds when an earlier build was measured and takes
0.29 ms here (286 microseconds at the mean, 273 at the median, 576 at the 99th percentile), over
500 iterations that follow 1,000 untimed ones. That row is from a run made after the batch, with
the benchmark changed, because the one it replaces did not measure one thing. It timed twenty
empty blocks straight after the full blocks, and from run to run it read about 175 microseconds
(5,590 a second, the figure this table carried) or about 450 (2,200 a second). The cause is the
state of the JavaScript engine's compiler, not the chain. The functions an empty block runs
were compiled while the full blocks ran, for what those blocks did. The first twenty or so
empty blocks run that code; then the engine discards it and they run unoptimised, until about
600 blocks later the functions are compiled again for what an empty block does. With the
optimising compilers switched off the time is flat. Twenty iterations caught the first state or
the second, by chance; the benchmark now measures the third.

### 4.6 network

Whole nodes: four validators on the in-memory transport, then a fifth node catching up.

| measurement | value |
|---|---|
| engine only, empty blocks, commit timeout 50 ms | 8.9 blocks/s, 113 ms per block |
| core app, 6,000 transfers submitted to one node, until all committed | 5.9 s: 1,014 tx/s, 7 blocks, 857 txs per block on average, largest 1,663 txs (4.00 MiB; the limit then counted the header and the commit, and a full block now holds 1,667 and encodes to 4.01 MiB) |
| submitted / rejected / failed / left queued | 6,000 / 0 / 0 / 0 |
| block sync, 9 blocks holding 6,000 transfers | 1.8 s: 5.1 blocks/s, 3,419 tx/s; app hash not compared in this run, the two nodes being at heights 9 and 13 when the benchmark looked. As it stands the benchmark always compares: it stops the synced node, waits up to 30 s for a validator to hold the block after the synced node's height, and holds the synced app hash against the app hash in that block's header, failing on a disagreement |

Analysis. With the test timeouts a height takes 113 ms: the commit timeout of 50 ms plus three
message rounds with signing at each. Under load the network committed 1,014 transfers a second,
seven blocks at 1.18 a second; the largest was full at 1,663 transfers and the average held
857. (The limit then counted the header and the commit. It is now on the transactions and the
evidence alone, and in a run made after that change a full block held 1,667 transfers, the
codec's figure exactly, and encoded to 4.01 MiB with its header and commit.) A full block is the limit block space sets: each node admits the transfers at pool speed
and the proposer fills the 4 MiB. Only one of the seven blocks was full, so the run's rate is
below that ceiling, and the run does not separate what held the other blocks short of it.
Raising the block size raises the ceiling and lowering the commit timeout the cadence; neither
changes the cost per transfer. Block sync runs at 3,400 transfers a
second, against 5,800 for a cold block in section 4.5; the rest is the fetch round trips.

### 4.7 genesis

A gigabyte of application genesis: 193,393 accounts with two keys each, written as JSON, parsed
as a token stream, built, written to LMDB, read, snapshotted and reopened.

| measurement | value |
|---|---|
| parse as a token stream (stream-json) | 6.5 s, 154 MiB/s |
| build: objects and indices, first root, write to LMDB | 11.4 s (apply 4.1 s, root 5.4 s, persist 1.8 s) |
| memory after building | heap 590 MiB, array buffers 1,054 MiB; peak RSS 5.2 GB |
| LMDB on disk | 958 MiB; 1,464 MiB after one snapshot |
| account by id / by name / balance | 10,200,000 / 592,000 / 688,000 per second |
| object proof + verify / name proof + verify | 45,700 / 45,500 per second; 3.4 KiB (22 siblings) and 932 B |
| block of 500 transfers at this size | finalize 26 ms, commit 16 ms |
| state snapshot | 0.8 s |
| restart from LMDB | 4.1 s: read 387,289 objects 0.6 s, indices, trees and root with every check 3.5 s, the sparse trees' past versions from the history records 2 ms |
| memory after restart | heap 383 MiB, array buffers 582 MiB |
| the database reopened three ways | trees from their chunks and nodes, every leaf checked against its object 4.0 s; the same with the leaves unchecked 2.3 s; trees computed from the objects 8.1 s |

Analysis. The state is its keys: the array buffers hold 511 MiB once the genesis is parsed,
which is the 387,000 ML-DSA public keys, and the heap around them (objects, indices, trees) is
590 MiB after building. After building the array buffers hold 1,054 MiB, the keys and the arena
of encoded objects (section 4.10), so a gigabyte of hex genesis is 1.6 GB of heap and array
buffers in the process that built it; after a restart it is 965 MiB, 383 MiB of heap and 582
MiB of array buffers. Under secp256k1 the same number of accounts leaves the heap where it is
and the array buffers at 79 to 90 MiB (section 4.9), and the genesis file itself shrinks with
the keys. Lookups by id are the same speed as with a thousand accounts; proofs grow by one
sibling per doubling (22 siblings here against 21 for 100,000 balances), and a name proof is
built and verified as fast as an object proof. Parsing runs at 154 MiB/s. Building is apply
(decode, index, tree leaves), root (hash every object, build the trees, build the name tree)
and a single LMDB transaction of 958 MiB.

The restart is a bit over a third of the build, 4.1 s against 11.4. In the first build measured
it cost more than the build (11.8 s against 8.0 s then), because the store was read object by
object and the name tree was built twice, once live while importing and once to recover
past-version proofs. The restart path has changed since (section 4.12): the trees come back
from their stored chunks and nodes and the indices from their stored entries, so the live build
of the name tree and the hashing of every object for the root are gone from it; the name tree's
past versions, which were rebuilt by replaying every account, come from the store's history
records, in 2 ms at height 1; and what remains is the read, 0.6 s, and the indices, trees and
root with their checks, 3.5 s in the node's restart; the database reopened on its own, in the
table's last row, spends 3.4 s there with every leaf checked against its object and 1.7 s
without. The build went the other way, from 8.0 s to 11.4 s, and the store from 614 MiB to 958
MiB, since the index entries, the chunks and the nodes are written with the objects.

### 4.8 scale

Steady state on top of that genesis.

| measurement | value |
|---|---|
| RPC, 16 clients, idle chain: account by name with proof / object with proof / history / status | 4,316 / 5,653 / 6,197 / 7,136 calls/s |
| RPC broadcastTx, 16 clients, 2,000 transfers until committed, one validator | 1.51 s: 1,329 tx/s, 13 blocks |
| the same with 8 clients reading accounts with proofs throughout | 1.64 s: 1,218 tx/s and 1,226 reads/s |
| 8 blocks of 300 transactions of 8 transfers each, random accounts | per block: admit 66 ms, finalize 86 ms, commit 59 ms; 16,600 transfers/s applied |
| growth over those blocks | LMDB +31 MiB; heap in use +209 MiB (the process's heap-used difference across the blocks, not an isolated measure of the 8 retained versions) |
| object proof / name proof at a past height, verified | 39,900 / 39,000 per second |
| account history, newest 20 entries | 830,000 per second, from the log (991,000 in the earlier build that keyed the history by account) |
| state sync pipeline, local, 201 chunks (504 MiB) | export 1.3 s, read and verify chunks 3.6 s, rebuild and check roots 9.2 s, write 2.8 s, open 9.0 s: 25.9 s in all; no peer transfer or header verification |
| memory with the original and the synced state both loaded | heap 961 MiB, array buffers 1,637 MiB |

Analysis. The RPC path is bounded by JSON and proof serialisation, not by the state: 4,300 to
7,100 calls a second from one process. These are the server's rates, measured with its rate
limiter raised to 10⁹ tokens a second and costly calls charged one token; a public endpoint
with the defaults (section 8 of [running.md](running.md)) admits far less per client. A single
validator takes 1,330 transfers a second through the RPC, in 13 blocks, against 5,800 for
admission alone (section 4.5), and 1,220 a second while serving 1,230 proof reads a second
alongside. Scattered batch transfers cost 36 microseconds per transfer in finalize, against 40
to 42 with a thousand accounts: the tree is bigger but a block changes only a few thousand of
387,000 leaves. The heap grew 26 MiB per block at 2,700 changed objects a version, an upper
bound on what the history window costs that also includes whatever else those blocks left
allocated. The state-sync figure is the pipeline alone, in one process from the local store:
export, read the chunks back and verify them, rebuild, write, reopen, with no peer transfer and
no light-client verification of the header. It is bounded by walking every object three times
(export, rebuild, open) and by holding several copies of the state while it does so: 2.6 GB of
heap and array buffers with the original and the synced state both loaded.

### 4.9 secp256k1

Everything above ran on ML-DSA-44. `CHAIN_SCHEME=secp256k1 npm run bench` runs the same suites
on secp256k1, and `CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 npm run bench:genesis` builds a
genesis of 191,896 accounts with two keys each, about the account count of the gigabyte in
section 4.7, which takes 56 MB of JSON when a key is 68 hex characters instead of 2,626. Same
machine, same batch, same method; the crypto rows are in section 4.1. What changes:

| benchmark | ML-DSA-44 | secp256k1 |
|---|---:|---:|
| signed transfer | 2,510 B | 154 B |
| transfers per block at the default limit, less the 1 KiB the builder leaves | 1,667 | 26,539 |
| checkTx on the worker pool, 32 in flight | 5,799/s | 8,709/s |
| finalizeBlock 500 transfers, cold, worker pool | 5,768/s | 7,330/s |
| finalizeBlock 500 transfers, warm | 25,029/s, 20.0 ms a block | 17,239/s, 29.0 ms a block (median 20.1 ms) |
| finalizeBlock 1,500 transfers, warm | 23,564/s | 29,678/s |
| finalizeBlock, empty block (after 1,000 untimed ones; run after the batch, section 4.5) | 3,501/s, 286 microseconds (median 273, p99 576) | 3,443/s, 290 microseconds (median 277, p99 554) |
| saveBlock, 500 transfers with results and index | 9.2 ms (1.2 MiB) | 8.1 ms (75 KiB) |
| network: 6,000 transfers submitted to one node | 5.9 s, 1,014 tx/s, 7 blocks, the largest full at 1,663 (1,667 under the present rule) | 4.1 s, 1,450 tx/s, 6 blocks, the largest 2,830 transfers (437 KiB) |
| block sync of those blocks | 3,419 tx/s | 5,647 tx/s |
| genesis of 192,000 accounts: parse | 6.5 s at 154 MiB/s | 2.2 s at 25 MiB/s |
| genesis: build (apply, root, persist) | 11.4 s | 7.9 s |
| memory after building: heap + array buffers | 590 + 1,054 MiB | 608 + 79 MiB |
| peak resident set during the build | 5.2 GB | 2.5 GB |
| LMDB on disk, then with a snapshot | 958 MiB, 1,464 MiB | 213 MiB, 248 MiB |
| restart from LMDB | 4.1 s | 2.85 s |
| memory after a restart: heap + array buffers | 383 + 582 MiB | 381 + 90 MiB |
| RPC account by name with a proof, 16 clients | 4,316 calls/s | 6,588 calls/s |
| broadcastTx of 2,000 transfers, 16 clients | 1,329 tx/s | 2,374 tx/s |
| scattered batch transfers applied | 16,576/s | 18,999/s |
| state sync pipeline, local | 201 chunks (504 MiB), 25.9 s | 199 chunks (31.7 MiB), 11.4 s |

Analysis. Verification is the cost that moves least (section 4.1), and the rates that are bound
by it gain a quarter to a half: admission 50%, a cold block 27%. A warm block, bound by
evaluation and the root, shows no consistent difference: 500 transfers took 20.0 ms under
ML-DSA-44 and 20.1 ms at the median under secp256k1, where one slow block pulled the mean to
29.0 ms; 1,500 transfers ran at 23,600 and 29,700 a second, and the scattered batch transfers
of the scale suite at 16,600 and 19,000. What is bound by bytes moves with the sizes: a
transfer is sixteen times smaller, sixteen times more fit a block, and the chain store writes a
sixteenth. The state on disk does not follow: it is 958 MiB against 213 MiB, four and a half
times, where the objects alone were eighteen times apart (614 MiB against 34.6 MiB in the build
that stored nothing else), because the index entries, tree chunks and tree nodes now stored
beside the objects hold ids, names and hashes and not keys. The network figure is not a
block-space figure under secp256k1: the six thousand transfers went into six blocks, the
largest of 2,830 transfers and 437 KiB, far below the 4 MiB limit, so the rate there is the
commit cadence, not the limit. The one number that does not shrink is the heap: 608 MiB for the
same accounts against 590 MiB after building, and 381 against 383 MiB after a restart, because
the keys never lived in the heap (they are array buffers, 1,054 MiB against 79) and what the
heap holds is the object database itself, the account, balance and authority objects, the index
entries, the tree chunks and the name tree. That is 3.2 to 3.3 KB per account after building
and 2.1 KB after a restart, under either scheme, and it is the floor the sizing of section 7
starts from; section 4.10 records how it divided when the arena was introduced.

Three rows moved in both columns since the first build measured, when the index entries and the
trees' chunks and nodes began to be written with the objects and a restart began to read them
back (sections 4.11 and 4.12). In that build the secp256k1 store was 34.6 MiB and 68.3 MiB with
a snapshot, the build took 5.7 s and the restart 8.7 s; the ML-DSA-44 store was 614 MiB and
1,120 MiB, the build 8.0 s and the restart 11.8 s. The stores grew by 179 MiB under secp256k1
and by 344 MiB under ML-DSA-44.

### 4.10 The arena

Phase one of [STATE-PAGING.md](../STATE-PAGING.md) keeps every object of the database as its
encoded bytes in an arena of slabs, with a bounded cache of decoded objects over it
([DESIGN.md](../DESIGN.md) section 6). This table is the record of that change, measured on the
build that made it and not run again: the genesis run of section 4.9 (191,896 accounts with two
keys each under secp256k1, 56 MB) before the arena, with the cache unbounded (the default), and
with it capped at 100,000 objects (what the memory guard sets at `warn`):

| at the time | before | resident (cache unbounded) | capped at 100,000 objects |
|---|---:|---:|---:|
| heap after building | 597 MiB | 607 MiB | 583 MiB |
| heap after a restart | 601 MiB | 585 MiB | 489 MiB |
| array buffers (keys, and from then on the arena) | 41 MiB | 79 MiB | 79 MiB |
| build (apply, root, persist) | 5.7 s | 5.9 s | 5.9 s |
| block of 500 transfers among random accounts | 21.5 ms | 24.8 ms | 41 ms |
| restart from LMDB | 8.7 s | 8.5 s | 8.5 s |

On the small-scale suites under ML-DSA-44 a warm block of 500 transfers went from 27,400 to
25,000 transfers a second, a cold one from 6,290 to 6,040, admission from 6,680 to 6,420, and
`get by id` from 42 to 72 ns (a map lookup instead of an array index).

The node as it stands, from this batch, with the cache unbounded: the heap is 608 MiB after
building and 381 MiB after a restart, the array buffers 79 and 90 MiB, the build takes 7.9 s
and the restart 2.85 s (sections 4.11 and 4.12 are what moved those two), and on the
small-scale suites a warm block of 500 transfers runs at 25,000 a second, a cold one at 5,770,
admission at 5,800 and `get by id` takes 74 ns. The capped configuration was not run again on
the genesis suite; the mode table of section 4.13 has the cache capped at 10,000 objects on the
same state.

Analysis. Resident, the arena cost about 6% more memory (the encoded copy beside the decoded
one) and 5 to 15% of speed, while capped it saved 17% of the heap with an empty cache at the
price of a block of random transfers taking twice as long, which is the degraded mode the
memory guard turns on rather than a mode to run in. By itself it did not move memory much,
because decoded objects were only about a sixth of the heap, 0.55 KB of the 3.2 KB per account,
and the rest was the secondary indices, the name tree and the Merkle trees, which is what the
next two sections put on disk.

### 4.11 The index tier

Phases two and three of [STATE-PAGING.md](../STATE-PAGING.md) (section 4 there): every
secondary index entry is one LMDB key in the application store, written in the same transaction
as the objects of the version that changed it, and the B+ trees become accelerators the memory
guard can drop, lookups and scans falling through to the store merged with the writes since the
last root ([DESIGN.md](../DESIGN.md) section 6). The first two columns are the record of that
change: the phase-three build measured against the phase-one build on the same machine,
alternating the two (single runs varied by about 5%, so most rows give the range of several).
The third column is this batch, on the node as it stands, which has the trees tier and the
restart changes of section 4.12 as well. The genesis rows are at 191,896 accounts under
secp256k1 (56 MB); in the last column the small-suite rows are from the ML-DSA-44 run:

| | before (phase one) | after (phase three, at the time) | this batch |
|---|---:|---:|---:|
| commit to LMDB (after a 500-transfer block) | 8.65 to 9.21 ms, mean 8.95 | 8.86 to 10.0 ms, mean 9.63 | 9.85 ms |
| commit to memory (after a 500-transfer block) | 2.55 to 2.88 ms | 3.13 to 3.87 ms | 3.41 ms |
| modify 1,000 balances + root (db suite, no store) | 19.3 to 19.6 ms | 19.7 to 19.8 ms | 20.4 ms |
| first root over 100,000 objects (db suite, no store) | 323 to 326 ms | 347 to 354 ms | 336 ms |
| genesis: build (apply, root, persist) | 5.96 s | 6.67 to 6.73 s | 7.88 s |
| of which root / persist | 1,569 / 406 ms | 1,809 to 1,903 / 946 to 959 ms | 2,205 / 1,423 ms |
| LMDB on disk after genesis | 34.6 MiB | 92.7 MiB | 213 MiB |
| block of 500 transfers at that size: commit to LMDB | 10.6 ms | 11.8 to 12.2 ms | 13.4 ms |
| restart from LMDB | 8.92 s | 8.43 to 8.49 s | 2.85 s |
| of which import / indices and root | 3,899 / 1,119 ms | 281 to 298 / 4,462 to 4,508 ms | 297 / 2,544 ms |
| heap after a restart | 585 MiB | 572 MiB (array buffers 79 to 90 MiB) | 381 MiB (array buffers 90 MiB) |

The fallback, from the db suite of this batch (the ML-DSA-44 run) at 100,000 balances and
26,000 accounts, per 1,000 lookups and per 100 scanned entries:

| | resident | dropped, in-memory store | dropped, LMDB |
|---|---:|---:|---:|
| lookup by unique index (byOwnerAsset), 1,000 | 1.28 ms | 1.24 ms | 1.22 ms |
| scan 100 entries of a non-unique index (byAsset) | 10 microseconds | 24 microseconds | 92 microseconds (median 53) |
| modify 1,000 balances + root | 20.4 ms | 24.4 ms | |
| rebuild every index tree | | 136 ms | 295 ms |

Analysis. A 500-transfer block writes about a thousand entries (each transfer leaves a recent
transaction id, which has two indices; the balances change no key), and when the change was
made its commit cost about 0.7 ms more, 7%. The genesis writes 576,000 entries (a name, an
owner-asset key and an asset key per account): at the time a third of a second to list them at
the first root, half a second to write them, and 58 MiB of LMDB, about 100 bytes an entry with
LMDB's page overhead; peak RSS during the build rose with them (1.69 to 2.18 GiB), the heap
after building did not (607 MiB then, 608 MiB now). A restart builds the indices from the
stored entries, in key order and with no object decoded, which took the import from 3.9 s to
0.3 s, where it still is, and moved the work into the indices-and-root phase; on that build it
was as fast, within a few percent, as decoding every object for its keys had been (the old
path, kept for a store that predates the entries, took 8.49 s against 8.43 in the same run),
because both were dominated by hashing the name tree, which section 4.12 removed. A lookup
through LMDB costs about what a resident one does, since both are dominated by building the key
and fetching the object (1.22 to 1.28 ms per thousand in all three columns); a scan costs five
to nine times as much, by its median and its mean, the price of copying every key and value out
of LMDB and merging two cursors, still under a microsecond an entry. At genesis scale, `account
by name` over 192,000 accounts measured 1.78 ms per 1,000 resident against 1.81 in a direct
comparison of the two builds at the time (15 rounds each, medians), about 2%, and the genesis
suite of this batch reads 1.73 ms. The db suite's rows carry no store, so they show only the
bookkeeping, the keys kept per dirty object.

### 4.12 The trees tier

Phase four of [STATE-PAGING.md](../STATE-PAGING.md) (section 5 there): the dense trees' changed
chunks and the sparse trees' changed nodes are written at every root, the live trees become
accelerators the guard drops after the index trees, a root over dropped trees reads each
changed leaf's path through a bounded chunk cache and writes the changed chunks back, and a
restart takes the trees from the store, hashing every object against its leaf. The first two
columns are the record of that change, the phase-four build measured against the phase-three
build on the same machine, single runs; the third is this batch, on the node as it stands,
which also checks the stored trees in full at a restart and takes the sparse trees' past
versions from the history records (both below). The genesis rows are at 191,896 accounts under
secp256k1 (56 MB); in the last column the small-suite rows are from the ML-DSA-44 run:

| | before (phase three) | after (phase four, at the time) | this batch |
|---|---:|---:|---:|
| genesis: build (apply, root, persist) | 6.94 s | 7.80 s | 7.88 s |
| of which root / persist | 1,861 / 973 ms | 2,125 / 1,672 ms | 2,205 / 1,423 ms |
| LMDB on disk after genesis | 92.7 MiB | 213 MiB | 213 MiB |
| heap after building | 607 MiB | 607 MiB | 608 MiB |
| restart from LMDB | 8.41 s | 5.2 s (4.6 s without the leaf check) | 2.85 s (1.41 s without the leaf check) |
| of which indices, trees and root | 4,518 ms | 761 ms | 2,544 ms, every check included |
| heap after a restart | 572 MiB | 572 MiB | 381 MiB |
| block of 500 transfers (accounts 0 to 500): commit to LMDB | 13.2 ms | 13.6 ms | 13.4 ms |
| scale suite, block of 2,400 transfers among random accounts: commit | 45.7 ms | 55.1 ms | 49.1 ms |
| scale suite, state sync: write the imported state / open it | 1.09 / 5.72 s | 1.84 / 1.59 s | 1.86 / 3.37 s |
| commit to LMDB (after a 500-transfer block), 1,001 accounts | 9.72 ms | 9.48 to 9.96 ms | 9.85 ms |
| first root over 100,000 objects (db suite, no store) | 358 ms | 347 to 356 ms | 336 ms |
| modify 1,000 balances + root (no store) | 19.3 to 20.5 ms | 19.8 to 20.4 ms | 20.4 ms |
| modify 10,000 balances + root (no store) | 159 to 162 ms | 161 to 167 ms | 166 ms |

The three ways to reopen the same store, in one run of this batch: the trees from their chunks
and nodes with every object hashed against its leaf (the default) 2.84 s, the same without the
leaf check 1.41 s, the trees computed from the objects 5.17 s. The node's restart is 2.85 s:
read 0.30 s, indices, trees and root with every check 2.54 s, the sparse trees' past versions 2
ms, on a heap of 381 MiB afterwards. On the ML-DSA-44 gigabyte the same three are 3.99, 2.29
and 8.13 s and the restart 4.14 s (section 4.7).

Those figures came in three steps, each measured on its build. When the trees were first read
back from the store the three reopens took 5.18, 4.56 and 8.46 s. Then a restart began to check
the stored trees and index entries in full (STATE-PAGING.md 5.3: every dense node against its
children, every sparse node against its parent's hash, every non-empty leaf against an object,
every index entry against the objects), and the same three, before and after in one session,
took 5.08 to 6.48 s (indices, trees and root 1,351 to 2,597 ms), 4.46 to 5.05 s (732 to 1,195
ms; the index entry check still ran) and 8.22 to 8.90 s; the index entry check, which decodes
every object once, was about 0.46 s of that and the tree check about 0.78 s. Then the sparse
trees' past versions began to come from the history records (STATE-PAGING.md section 7.3): each
record holds the nodes its version overwrote, and a restart builds every older version of a
tree from the next newer one and the record between them, sharing what the block left alone,
instead of inserting every account into a fresh tree and replaying the window. At height 1 that
phase went from 3.5 s to 2 ms, the three reopens from 6.48, 5.05 and 8.90 s to 2.84, 1.46 and
5.41 s, and the heap after a restart from 572 MiB, which the replay left, to 381. What a
restart costs now is the checks: without the leaf check it is 1.41 s.

Dropped trees, from the db suite of this batch (the ML-DSA-44 run; 100,000 balances and 26,000
accounts, the trees over LMDB; means, and medians where a slow iteration pulls the mean):

| | resident | dropped |
|---|---:|---:|
| modify 1,000 balances + root | 26.9 ms (median 20.3) | 54.2 ms (median 29.4) |
| modify 10,000 balances + root | 221 ms (median 201) | 231 ms (median 203) |
| object proof, current version, per 100 | 1.14 ms | 1.51 ms |
| object proof, past version, per 100 | 1.20 ms | 1.51 ms |
| name proof (sparse tree), per 100 | 0.36 ms | 1.78 ms |
| drop / rebuild every tree | | 0.6 / 368 ms (0.3 / 63 ms in the secp256k1 run) |

Analysis. The genesis writes about 600,000 sparse nodes (the name tree of 192,000 leaves and
their inner nodes) and 25 MiB of chunks: 120 MiB more of LMDB, and when the change was made 0.7
s more to write and a quarter of a second more to list at the first root, which, with the
entries of section 4.11, is where the build's 5.9 s of section 4.10 became 7.8 s then and is
7.9 s now. A block's commit costs what its chunks cost: a chunk holds 1,024 hashes, so a block
whose leaves are spread over the whole state rewrites nearly every chunk of the trees it
touches, 6.1 MiB per root for a thousand random balances among 100,000 and the same for ten
thousand, about 12 MiB at 192,000 accounts, where the commit of a scattered block grew by a
fifth (9 ms) when the chunks were first written and takes 49 ms in this batch; a block whose
writes are local (the genesis suite's transfers among consecutive accounts) costs nothing
measurable, nor does the 1,001-account application suite. Smaller chunks on disk would cut the
scattered case about in half at this size. The restart is the gain: the trees come back from
their chunks and nodes, so the first root hashes no object and inserts no key into a sparse
tree, and 8.4 s became 5.2 s, of which the leaf check (every object hashed and compared with
its leaf, so that a corrupt object store still fails at startup) was about an eighth; what was
left was mostly the history, 3.5 s at height 1 to rebuild the sparse trees' past versions by
replaying every account, which the history records now hold in a form to load, and the restart
is 2.85 s in all, half of it the leaf check. At the median a root over dropped trees costs what
a resident one does for ten thousand changes (203 against 201 ms) and half as much again for a
thousand (29 against 20 ms) once the upper levels are cached (215 chunks after these runs, of
the 4,096 the cache holds); the first one after a drop reads every chunk it touches from LMDB,
and in the benchmark that root is the untimed warm-up iteration, so it is not in these
figures. The mean of 54.2 ms against a median of 29.4 comes from slow measured iterations
(a 99th percentile of 383 ms, and 243 ms in the resident row), whose cause was not measured.
An object proof costs a third more
dropped than resident, 15 against 11 to 12 microseconds, most of it still building the proof
rather than reading twenty hashes; a name proof reads about twenty nodes from LMDB and costs
five times as much, 18 against 3.6 microseconds. Rebuilding reads 400 chunks and the name
tree's nodes, and every retained version of the name tree from the records. The state-sync rows
moved both ways when the change was made: writing the imported state wrote its entries, chunks
and nodes too (1.09 to 1.84 s), and opening it took the trees from them (5.72 to 1.59 s); in
this batch, with the full checks at opening, they are 1.86 and 3.37 s.

### 4.13 paging

`CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 npm run bench -- paging` builds the 191,896-account
state of section 4.9 and runs it through the memory guard's modes (STATE-PAGING.md section
7.1). First a node, in a child process started with `--max-old-space-size=745`, 1.25 times the
heap of the state with everything resident, the index trees included (596 MiB in every run of
this batch; "the resident heap" below): a single validator over the store, its mempool kept two
blocks ahead with transfers among random accounts, for 40 seconds (`BENCH_PAGING_HEAP` sets
another limit in MiB, `BENCH_PAGING_SECONDS` another length, `BENCH_PAGING_ARENA` a budget for
the arena in MiB, `BENCH_PAGING_MEMORY_VERSIONS` how many past versions the node keeps in
memory, as `retain.memoryVersions` does, `BENCH_PAGING_INDEX_TREES=memory` or `=store` where
the node's index trees are, as `indexTrees` in its config does (unset, the node's default,
`store`), `BENCH_PAGING_READS` how many index reads of each kind a second are asked for beside
the load, `BENCH_PAGING_BEFORE_NODE` a shell command run between building the store and the
node opening it, which is how the volume the store is on (`TMPDIR` chooses it) is remounted so
that none of the store is in the page cache, and `BENCH_PAGING_PROFILE` a directory for two
CPU profiles of thirty seconds each, one starting 5 seconds into the run and one starting 40
seconds before its end: 5 to 35 s and 560 to 590 s of a ten-minute run). Four more switches
belong to the node script alone (`bench/paging-node.ts`, which prints a JSON line per window
and can be run by itself on a state the suite built and kept): `BENCH_PAGING_NO_TX_INDEX`
stores blocks without their transaction index and results, `BENCH_PAGING_EXPIRATION_S` makes
each transfer expire that many seconds after it is signed where they otherwise all expire an
hour after the run starts, and `BENCH_PAGING_STORE_STATS` has the node print, at the end,
what each store holds by the first byte of the key and the pages of its tree, and
`BENCH_PAGING_SYNC_PROBE` has it time, at the end of each window, twenty synced writes of
64 KiB to a file beside the store and report the second fastest as `syncMs`: what the device
asks for a sync at that moment, whatever the node is writing. Every window
line carries `storeMs`, the time spent inside the store's transactions.

The runs of this section are from the batch of 2026-11-15 and on the node's defaults,
`indexTrees: 'store'` and a stored state opened against half the heap limit, except those
marked `memory`. Passages marked as an earlier build are the record of what led to those
defaults: in those builds the index trees were in memory by default (`indexTrees: 'memory'`),
and where the text says the node dropped or rebuilt its index trees, that is such a node. By
default a node never builds them (below). The published run takes its limit from the resident
heap it has just measured, 1.25 times 596 MiB, which is 745 MiB; the other runs are given a
fixed number (`BENCH_PAGING_HEAP`), worked out from 595 MiB, so their limits are 476, 595, 744,
893, 1,190 and 1,488 MiB for 0.8 to 2.5 times, and "the resident figure" as a limit is 595 MiB.
A megabyte apart, 744 and 745 MiB are treated as one configuration. Times in the node's own log
lines are counted from the start of its process, which opens the store first (1.0 s at 34,267
accounts; 3.2 to 3.7 s at 191,896 in every run but one, which took 4.2 s; 8.0 to 9.7 s at
514,008), so they run that much ahead of the load's windows; the tables of windows use the
load's clock and the lists of `warn` times the node's. The proof timings printed after each run
were taken before the fix to proofs of versions held in memory (section 4.3), so the figures
given below for the newest height, and for any height of a window that was never trimmed,
predate it and are not compared with anything; the figures for heights read from the store's
records are not affected.

| seconds | what happened |
|---|---|
| 0 | store opened in 3.3 s with the Merkle trees and the history left in the store, because they do not fit within half the limit; 39 MiB of heap in use; 1,580 and then 1,790 transfers a second in the first two windows |
| 2 to 20 | `ok`, the heap filling from 82 to 490 MiB with the pending session, the cache of decoded objects and the versions since opening; 1,790 to 2,020 transfers a second in each window of two seconds; no room to read the Merkle trees back (366 MiB needed, 269 MiB within half the limit) |
| about 21 | `warn` at 526 of 745 MiB: the window in memory cut to two versions, the cache capped, the mempool admitting up to half its limit; `ok` half a second later at 100 MiB; 1,471 transfers a second in the window that holds it |
| 22 to 40 | `ok` throughout, 92 to 205 MiB, 1,710 to 1,980 transfers a second in each window |

In all: 129 blocks and 72,092 transfers in 40.7 s (1,771 a second), every block committed with
the Merkle trees in the store, one visit to `warn`, none to `pressure`, and no abort. The 508
submissions refused were all in the first two seconds, before the first block; none was refused
afterwards. Rates are by the time each window and the run actually took, and the heap is the
old generation's use, which is what the guard's levels are taken from (below). The node is the
one `start` runs: it opens the state as its own application, and a block's writes and the
application's are one store transaction. After the run, with the window in memory two versions
wide, a proof of an account takes 0.08 ms at the newest height, 8.9 ms fifty heights back and
20 ms at the oldest provable height, a hundred back: the older two are read from the history
records in the store (below). The matrix below has the same configuration once more, reported
in one window: 1,634 transfers a second.

Three earlier builds ran the same configuration, and each is the reason for a change. In the
build just before the defaults changed (`indexTrees: 'memory'`, a stored state opened against
the warn line, 0.7 of the limit) the store was opened with everything in memory on 379 MiB,
`warn` came at about 5 s (539 of 744 MiB), where the index trees were dropped and the window
cut, and the run committed 124 blocks and 69,492 transfers, 1,712 a second, none with the
Merkle trees dropped.

While the index trees and the history window went only at `pressure`, the same run sat at
`warn` from 6.8 s and reached `pressure` at 14.0 s (637 MiB), where both tree tiers were
dropped and the window cut, and the next sample read 45 MiB; the index trees were rebuilt at
17.6 s and the Merkle trees stayed dropped for want of room. It committed 112 blocks and 61,364
transfers (1,508 a second), 80 of the blocks with the Merkle trees dropped. Shedding the index
trees and the window at `warn` kept the node from `pressure` under this limit, and with the
account history stored as a log (below) the next build committed 13% more transfers.

Before the history window was trimmed and the mempool's limit followed the level, the same run
went to `pressure` twice and then alternated between `warn` and `pressure` for its last ten
seconds with the mempool paused and resumed, for 107 blocks and 59,128 transfers: the window
(100 versions of overwritten tree nodes and object bytes) was what kept the heap at its limit
once the trees were gone, and trimming it is what took the heap from 640 to 50 MiB in one
sample.

The same node run over three states and five heap limits, each limit a multiple of the state's
resident heap, secp256k1 throughout, forty seconds each, from this batch:

| genesis | accounts | resident heap | heap limit (factor) | opened | heap after opening | blocks in 40 s | transfers/s | blocks with the Merkle trees dropped | refused | levels reached |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|
| 10 MB | 34,267 | 123 MiB | 98 MiB (0.8) | paged | 25 MiB | 107 | 1,384 | 107 | 508 | `warn` four times, `pressure` three times |
| | | | 122 MiB (1.0) | paged | 25 MiB | 119 | 1,476 | 119 | 508 | `warn` three times, `pressure` once |
| | | | 153 MiB (1.25) | paged | 25 MiB | 123 | 1,487 | 123 | 508 | `warn` twice |
| | | | 183 MiB (1.5) | in memory | 63 MiB | 119 | 1,411 | 5 | 508 | `warn` twice, `pressure` once |
| | | | 244 MiB (2.0) | in memory | 63 MiB | 135 | 1,657 | 0 | 508 | `warn` once |
| 56 MB | 191,896 | 596 MiB | 476 MiB (0.8) | paged | 39 MiB | 116 | 1,599 | 116 | 508 | `warn` once |
| | | | 595 MiB (1.0) | paged | 39 MiB | 112 | 1,589 | 112 | 508 | `warn` once |
| | | | 744 MiB (1.25) | paged | 39 MiB | 116 | 1,634 | 116 | 508 | `warn` once |
| | | | 893 MiB (1.5) | in memory | 258 MiB | 116 | 1,624 | 0 | 508 | `warn` once |
| | | | 1,190 MiB (2.0) | in memory | 258 MiB | 118 | 1,644 | 0 | 508 | `warn` once |
| 150 MB | 514,008 | 1,563 MiB | 1,250 MiB (0.8) | paged | 58 MiB | 94 | 1,336 | 94 | 508 | none |
| | | | 1,563 MiB (1.0) | paged | 58 MiB | 93 | 1,337 | 93 | 508 | none |
| | | | 1,953 MiB (1.25) | paged | 58 MiB | 93 | 1,317 | 93 | 508 | none |
| | | | 2,345 MiB (1.5) | in memory | 660 MiB | 98 | 1,402 | 0 | 508 | none |
| | | | 3,126 MiB (2.0) | in memory | 660 MiB | 99 | 1,417 | 0 | 508 | none |

"Paged" is a store opened with its Merkle trees and its history window left on disk, because
they would not have fitted within half the limit (below, and STATE-PAGING.md section 9.1); "in
memory" is a store opened with both, the index trees being in the store either way. 508 refused
is the feeder's first two seconds, before the first block, and every run refused nothing after
them. Every run committed blocks for the whole forty seconds, none died, and none reached
`critical`. The heap is the old generation's use. Rates differ by a tenth, and once by a little
more, between two runs of one row: the 744 MiB row is the configuration of the published run
above but for a megabyte of limit (745 MiB there), and that run read 1,771 where the table
reads 1,634, and the longer runs below are further runs of the 476 and 595 MiB rows, whose
first forty seconds read 1,640 at 476 MiB against the table's 1,599 and 1,660 to 1,810 at 595
MiB, in five runs, against the table's 1,589. So only differences larger than a tenth are read
here. Three things read off it.

The heap limit does not matter at 192,000 accounts. In the matrix's single runs the node
commits 1,589 to 1,644 transfers a second at every limit from 0.8 to 2.0 times its resident
heap, a spread of 3.5%, less than two runs of one row differ by: with the published run of the
1.25 row, 1,771, the six forty-second runs at this size span 1,589 to 1,771, 11%. It was not so
in earlier builds. While the index trees and the
window went only at `pressure`, less heap was faster: the same rows read 1,520 to 1,560 at 0.8
to 1.25 times, where the node ran with its index trees dropped and two versions of history in
memory, and 1,250 to 1,350 at 1.5 and 2.0 times, where it reached `pressure` late or not at all
and kept both. Of the two it was the index trees that cost the rate, not the window: a load of
transfers runs about a tenth slower while the index trees are in memory (the runs with
`indexTrees: 'memory'`, below), and the window in memory, measured directly, costs it nothing
measurable (the `retain.memoryVersions` table, below). The same matrix before the history trim,
the mempool limit and paged opening ran from 1,145 at 0.8 times to 1,544 at 2.0.

The largest state reads lower opened paged, by less than the spread. At 0.8 to 1.25 times its
resident heap it opens with the Merkle trees in the store and has no room to read them back
within half the limit, and it commits 1,317 to 1,337 transfers a second there against 1,402 and
1,417 with them in memory, 5 to 7% less, which is less than two runs of one row differ by. No
row of this state reached `warn` in forty seconds, so all five kept every version since opening
in memory. In an earlier build the paged rows were a quarter lower (1,070 to 1,110 against
1,410), while the dropped trees' cache held 256 chunks of the 1,100 this state's trees have and
every root read the rest from LMDB. The mode table below gives the same order for a root over
dropped trees (10.0 blocks a second against 11.6 with only the index trees dropped). At 192,000
accounts the three paged rows (1,599, 1,589 and 1,634) and the two others (1,624 and 1,644) are
within 3.5% of each other. Opening takes 42 to 51% of the resident heap when the Merkle trees and
the window are read into memory (63 of 123 MiB, 258 of 596, 660 of 1,563) and 4 to 20% paged
(25, 39 and 58 MiB).

The smallest state is the one that still reaches `pressure`. Against 123 MiB of resident state
the load's own growth (the pending session, the history window, the recent transaction ids) is
several times the state, so what `warn` sheds is not enough at three of the five limits: at 0.8
times it goes to `pressure` three times, at 1.0 times once and at 1.5 times once, in its last
two seconds, where the Merkle trees are dropped as well; at 1.25 and 2.0 times `warn` alone
holds the heap. The rates are 1,384 to 1,487 at 0.8 to 1.5 times and 1,657 at 2.0, and nothing
is refused after the first two seconds at any limit. In earlier builds the node at 0.8 times
its resident heap committed 1,149 transfers a second and refused 236 of 48,200 after its first
two seconds; and with the guard reading the young generation's garbage as use every limit up to
1.5 times the resident figure reached `critical`, where `start` stops the node, and at 0.8
times it refused 43% of what it was sent. Reading the old generation alone, no limit reaches
`critical`.

A stress run holds the same node at its ceiling for ten minutes instead of forty seconds, on the
192,000-account state, the mempool kept 1,000 transfers ahead, reported every 20 seconds with GC
pauses. The first table is the node before the history window was trimmed and the mempool's
limit followed the level (the mempool was paused at `pressure` instead), with one run at a deeper
feed of 4,000:

| heap limit | depth | transfers/s over 10 min | refused | blocks with Merkle trees dropped | longest GC pause |
|---|---:|---:|---:|---:|---:|
| 1,488 MiB (2.5×) | 1,000 | 1,055 | 0.3% | 573 of 1,397 | 222 ms |
| 595 MiB (1.0×) | 1,000 | 939 | 21% | 1,633 of 1,642 | 117 ms |
| 595 MiB (1.0×) | 4,000 | 903 | 36% | 1,342 of 1,355 | 121 ms |
| 476 MiB (0.8×) | 1,000 | 815 | 46% | 1,664 of 1,664 | 239 ms |

The second is the same limits on the builds that followed, in order: first with the window
trimmed and the mempool's limit following the level, then with the mempool's cache of seen
transactions fixed as well, then with the guard reading the old generation, a tier rebuilt only
within half the limit and one store transaction a block, then with the index trees dropped and
the window trimmed at `warn` and the account history stored as a log, its heads written every
64 blocks and a tier rebuilt ten samples after a drop, then with the heads written a slice a
block and nothing rebuilt until the heap has stayed at `ok` as long as the node had run before
the drop (all below), which was the last build with the index trees in memory by default, and
last the node as it stands, from this batch: the index trees in the store and a stored state
opened against half the limit. The largest limit of the first table was run with the last three
and, in this batch, once more with `indexTrees: 'memory'`. The heap is the whole heap's use in
the first two rows of each limit and the old generation's in the others:

| heap limit | node | transfers/s over 10 min | refused | blocks with Merkle trees dropped | visits to `pressure` | heap between | longest GC pause |
|---|---|---:|---:|---:|---:|---:|---:|
| 595 MiB (1.0×) | history trim, mempool limit | 1,088 | 0.08% (508 of 655,400) | 1,475 of 1,491 | 7 | 58 and 484 MiB | 105 ms |
| | and the seen cache fixed | 1,321 | 0.06% (508 of 795,200) | 1,663 of 1,663 | 5 | 133 and 455 MiB | 83 ms |
| | old-generation guard, one transaction a block | 1,322 | 0.06% (508 of 795,800) | 1,644 of 1,644 | 2 | 117 and 492 MiB | 222 ms |
| | paging at `warn`, the history log, heads every 64 blocks, rebuilt after ten samples | 1,574 | 0.05% (508 of 946,600) | 1,820 of 1,820 | 0 (6 to `warn`) | 115 and 428 MiB | 132 ms |
| | heads a slice a block, the wait before a rebuild | 1,619 | 0.05% (508 of 974,200) | 1,865 of 1,865 | 0 (5 to `warn`) | 115 and 437 MiB | 97 ms |
| | as it stands, this batch: index trees in the store, opened against half the limit | 1,610 | 0.05% (508 of 968,400) | 1,857 of 1,857 | 0 (5 to `warn`) | 106 and 433 MiB | 79 ms |
| 476 MiB (0.8×) | history trim, mempool limit | 1,137 | 0.07% (507 of 683,800) | 1,424 of 1,424 | 5 | 78 and 366 MiB | 67 ms |
| | and the seen cache fixed | 1,290 | 0.07% (508 of 776,200) | 1,623 of 1,623 | 4 | 62 and 393 MiB | 63 ms |
| | old-generation guard, one transaction a block | 1,355 | 0.06% (508 of 815,600) | 1,755 of 1,755 | 2 | 124 and 397 MiB | 84 ms |
| | paging at `warn`, the history log, heads every 64 blocks, rebuilt after ten samples | 1,524 | 0.06% (508 of 916,800) | 1,745 of 1,745 | 0 (8 to `warn`) | 92 and 337 MiB | 97 ms |
| | heads a slice a block, the wait before a rebuild | 1,608 | 0.05% (508 of 967,400) | 1,861 of 1,861 | 0 (8 to `warn`) | 92 and 356 MiB | 122 ms |
| | as it stands, this batch: index trees in the store, opened against half the limit | 1,567 | 0.05% (508 of 942,200) | 1,799 of 1,799 | 0 (8 to `warn`) | 118 and 339 MiB | 76 ms |
| 1,488 MiB (2.5×) | paging at `warn`, the history log, heads every 64 blocks, rebuilt after ten samples | 1,528 | 0.06% (508 of 919,400) | 0 of 1,874 | 0 (3 to `warn`) | 312 and 1,049 MiB | 139 ms |
| | heads a slice a block, the wait before a rebuild | 1,485 | 0.06% (508 of 893,400) | 0 of 1,780 | 0 (2 to `warn`) | 327 and 1,045 MiB | 132 ms |
| | as it stands, this batch: index trees in the store, opened against half the limit | 1,508 | 0.06% (508 of 907,800) | 0 of 1,758 | 0 (1 to `warn`) | 316 and 1,054 MiB | 136 ms |
| | this batch with `indexTrees: 'memory'` | 1,522 | 0.06% (508 of 915,600) | 0 of 1,828 | 0 (2 to `warn`) | 327 and 1,057 MiB | 140 ms |

No run died, in any build. In the first table sustained throughput converged on about 900
transfers a second whatever the heap, and what the heap decided was how much load was refused
to hold it there: a fifth at the resident figure, nearly half at 0.8 times it, in bursts of
20,000 to 46,000 transfers each time the mempool was paused. As the node stands nothing is
refused after the first two seconds at any of the three limits (the refusals counted are the
feeder's first submissions, before the first block), the node spends the run at `ok` with one
to eight visits to `warn` of half a second each and none to `pressure`, and it commits 71% more
at the resident figure, 92% more at 0.8 times it and 43% more at 2.5 times it than it did in
the first table. The three limits read 1,610, 1,567 and 1,508, within 7% of each other, and
each is within 3% of the build before it (1,619, 1,608 and 1,485), which is less than two runs
of one configuration differ by: over ten minutes, as over forty seconds, the heap limit decides
what is resident and not what is committed. Five things did that, three of them in the table's
earlier rows. The history window, trimmed to two versions (at `pressure` in those rows, at
`warn` since), was most of what the heap held once the trees were dropped, so one visit frees
several hundred MiB instead of a few tens. The mempool, admitting up to a share of its limit
that follows the level instead of nothing, keeps taking transactions at the rate blocks remove
them, so there is no backlog to refuse when admission begins again. The third was not about
memory at all, and is next. The fourth and the fifth are the rows with paging at `warn` and the
history log, 19% above the rows before them at the resident figure and 12% at 0.8 times it: the
index trees and the window left at `warn`, within the first minute, instead of at `pressure`
minutes into the run, and the account history became a log; both are below, each after the
measurement that pointed at it.

The runs with the first two still slowed as they went: at the resident figure from 1,570
transfers a second in the first twenty seconds to 740 in the last. A CPU profile of thirty
seconds early in such a run against one of thirty seconds late in it separated the causes. The profile,
the commit ablation after it and the per-stretch tables of the ten-minute runs that follow were
made on those earlier builds, with the index trees in memory by default, and were not run again
in the batch of 2026-11-15; the node as it stands is taken up again after them.

| | early in the run | late in the run |
|---|---:|---:|
| `Mempool.remember` (ten-minute run, 5 to 35 s against 560 to 590 s) | 0 | 8.3% of the process, 77 microseconds a transfer |
| the benchmark's own feeder, signing transfers on the node's thread (the same) | 38% | 40% |
| LMDB commits, the application's store and the block store (after the fix below, 5 to 35 s against 140 to 170 s) | 105 microseconds a transfer | 215 microseconds |

The mempool remembers the hashes of the last 100,000 transactions it saw, so that gossip does
not bring them again, and it kept their order in an array it shifted for every transaction once
the cache was full: a move of 100,000 pointers per transfer from the 100,000th on, about 70
seconds into the run, which is where the rate first fell. The order is now a ring, the newest
hash taking the oldest one's place, and the function is gone from the profile; the ten-minute
figures in the table's second rows are with it. The benchmark's node signs its
own load on the thread it runs on, which is saturated, so whatever the node spends per
transfer comes straight off the rate.

What was left looked like the store, and the explanation first given here was that the entries
keyed by a hash (the recent transaction ids' index, the block store's index of transactions)
each land on a page of their own. Tested directly, that is a small part of it. Blocks of 500
random transfers were applied to the 192,000-account state with no node around them, the
application's commit timed, and one kind of write at a time left out of the store. Without the
flush to the device, per block, at the first fifty blocks and at blocks 351 to 400, with the
account history as it then was, two entries a transfer keyed by account and sequence and a
count per account:

| what the commit writes | blocks 1 to 50 | blocks 351 to 400 |
|---|---:|---:|
| everything | 17.0 ms | 26.2 ms |
| without the account history (two entries a transfer, keyed by account) | 13.6 ms | 15.5 ms |
| without the index entries (the recent transaction id by its hash and by its expiration) | 15.7 ms | 21.4 ms |
| without the tree chunks (12 MiB a block) | 12.7 ms | 20.2 ms |
| without all three | 7.3 ms | 8.3 ms |
| the block store's index of transactions by hash, beside it | 1.1 ms | 3.7 ms |

LMDB's own work did grow, by half over 400 blocks, and it grew because entries scattered over
a growing table come to dirty a page each; but most of that was the account history, whose
entries were keyed by account and so landed wherever the two accounts of a transfer are, not
the hash-keyed entries, which were a fifth of it. And all of it is the smaller part of a commit:
with the flush (`F_FULLFSYNC` here) the same commit took 40 to 120 ms, and swung by 40% within
one run with nothing else changed (64 ms at the first blocks, 100 ms at block 250, 70 ms at
block 300 in one run; 40, then 115 in another). A commit is mostly its flush, and the node
paid two a block, one for the chain store and one for the application's. They are in one LMDB
environment, so the block and the application state now go in one transaction with one flush,
and land together or not at all (executor.ts).

The account history is now one log in block order (`HistoryLog`, src/app/core/history.ts): an
entry is appended at the log's end, where the block's other entries are, and what is still
keyed by account is a head per account (its count and the place of its newest entry), kept in
memory and written to the store later: in an earlier build together every 64 blocks, or sooner
when 50,000 of them waited, and as built a slice of the account numbers in every block. The
same ablation, taking the old layout apart first and then with the log; the first two columns
are medians, the third the mean over the last 200 blocks where it was taken:

| what the commit writes | blocks 1 to 50 | blocks 351 to 400 | mean, last 200 blocks |
|---|---:|---:|---:|
| before: entries keyed by account, a count written every block | 17.0 ms | 26.2 ms | 24.8 to 27.2 ms |
| before, without the entries | 14.8 ms | 18.5 ms | |
| before, without the counts | 16.1 ms | 21.1 ms | |
| before, without both | 13.6 ms | 15.5 ms | |
| the log, its heads written at the block that changes them | 15.8 ms | 20.7 ms | |
| the log in an earlier build, the heads every 64 blocks or at 50,000 waiting | 13.4 ms | 17.0 ms | 17.5 to 19.3 ms |
| the log as built, the waiting heads of one slice a block | 15.1 ms | 19.4 ms | 19.2 to 24.0 ms |
| the log without its writes at all (a second run of "without both") | 13.0 ms | 14.9 ms | 15.5 to 18.1 ms |

The old layout cost 3.4 ms a block at the start and 10.7 ms at block 400, of which the entries
were about 7.7 ms and the counts about 3. The log's entries cost about 0.6 ms. Its heads,
written at the block that changes them, cost about 5 ms at block 400, more than the old counts
did, their values being 16 bytes. Written together every 64 blocks they left the median block
at 13.4 and 17.0 ms, but the median does not hold the block that wrote them: under this load,
where a block touches 1,000 accounts, 50,000 heads waited after fifty blocks, before the 64
were up, and that one block in fifty took roughly 100 ms longer without the flush.

As built the heads wait in 64 slices of the account numbers (`HistoryLog.SLICES`), and every
block that has entries writes the waiting heads of one slice, the next in turn; all the slices
are written at once only if 50,000 heads wait (`HistoryLog.HEADS_HELD`). Under this load that
is about 760 to 1,000 heads in every block, where the earlier build wrote none in most blocks
and 50,000 in one. The work is the same in total. An account is rarely named twice within 64
blocks here, so nearly every changed head is one write whichever way they are batched, and
what a head write costs is mostly the write call itself, not the page, the heads of a slice
being neighbours in the store. Averaged over blocks the two builds are within what runs differ
by (the means overlap), and the median as built is 2.4 ms above the earlier build's at block
400 because every block now carries its share. What the slices buy is that no block carries
the batch: the block of about 100 ms more is gone. So the account history costs about 2 ms a
block at the start and 4.5 ms at block 400 (19.4 against 14.9), where the old layout cost 4
and 11.3 (17.0 and 26.2 against the same run): about 60% less, not the 80% that the earlier
build's median alone suggested. What is left of the growth, 13.0 to 14.9 ms with no history
written at all, is the index entries and the tree chunks of the first table.

The ten-minute run showed where the rest of the decline was. Reported per twenty seconds, with
the guard's level and the share of the time spent in collections, at the resident figure,
while the index trees and the window went only at `pressure`:

| seconds | index trees | level | heap in use | collections | transfers/s |
|---|---|---|---:|---:|---:|
| 0 to 100 | resident | `ok` | 220 to 400 MiB | 7% | 1,590 falling to 1,280 |
| 100 to 340 | resident | `ok`, then `warn` from 170 s | 370 to 490 MiB | 7%, 12% by the end | 1,280 falling to 1,050 |
| 345 | dropped at `pressure` (508 of 595 MiB) | | 56 MiB | | |
| 360 to 600 | dropped | `ok` | 120 to 380 MiB | 4 to 5% | 1,330 to 1,560, 1,420 on average |

The node slowed while its index trees were resident and its heap crept towards the pressure
line, each transfer adding two entries to them for its recent transaction id (about 420 bytes
of heap), and it ran a fifth to a third faster, and level, once they were dropped: a block of
transfers looks its balances up by an index, which the store answers, so with the trees in the
store the node keeps up no tree in the heap and only writes their entries, and
the collector has less heap to work on. The first version of this run after the guard's
measure was corrected (below) made it plain by doing worse: trees that just fitted under the
warn line were rebuilt there ten seconds after every drop, the node spent six of its ten
minutes between `warn` and `pressure`, and it committed 1,150 transfers a second. A tier is
now rebuilt only when it fits within half the limit.

So the index trees, on a node that has them in memory, and the history window now go at
`warn` (`onMemoryLevel` in src/node/node.ts), and the Merkle trees still at `pressure`. The same run with that, while a
tier was still rebuilt ten samples after a drop if it fitted:

| seconds | index trees | level | heap in use | collections | transfers/s |
|---|---|---|---:|---:|---:|
| 0 to 40 | resident: opened with them, dropped at the first `warn` at 14 s (422 of 595 MiB), rebuilt at 18 s because they fitted | `ok` | 320 to 360 MiB | 6% | 1,500, then 1,417 |
| 59 | dropped at the second `warn` (418 MiB), for good | | 115 MiB | | 1,288 in the window of the drop |
| 60 to 600 | dropped | `ok`, with `warn` for half a second at 203, 333, 461 and 592 s | 150 to 410 MiB | 4 to 7% | 1,490 to 1,690, 1,598 on average |

There was no decline: every window of twenty seconds from the first minute to the last was
between 1,490 and 1,690 transfers a second. Each `warn` came at 417 to 428 MiB of the 595 and
was followed within half a second by `ok` at 115 to 125 MiB. With the trees and the window
already out, what a `warn` frees is what has gathered since the last one: the hot cache above
its cap of 100,000 objects, and the garbage found by the major collection it starts. The node
at 0.8 times its resident heap did the same on a shorter period: 1,786 and 1,770 in its first
forty seconds, 1,410 to 1,640 afterwards (1,500 on average), `warn` at about 334 of 476 MiB
every 80 seconds or so and `ok` at about 120 MiB half a second later. The node at 2.5 times
showed what was left of the old pattern. Its index trees were dropped at `warn` at 32 s and at
199 s and rebuilt four seconds later each time, because under that limit they fitted within
half of it, and while they were resident (to 291 s, the heap between 650 and 1,010 MiB) it
committed 1,370 to 1,590 transfers a second; after the third `warn` at 291 s they no longer
fitted and stayed dropped, and it committed 1,430 to 1,680 on a heap of 450 to 870 MiB.

That run is why the node now waits before it rebuilds. A load that filled the heap once fills
it again, so at each level other than `ok` the node notes how many guard samples it had run
since something was last rebuilt (or since it started), at least ten (`Node.REBUILD_WINDOW`)
and at most 600 (`Node.REBUILD_WAIT_MAX`, ten minutes at the default interval), and nothing
is rebuilt until the level has been `ok` for that many samples in a row; the tier must still
fit within half the limit.

The same runs as the node stands, from this batch. At the resident figure the store is opened
with the Merkle trees and the history left in it, on 39 MiB, and there are no index trees to
drop. The run commits 1,768 and 1,789 transfers a second in its first forty seconds and 1,502
to 1,723 in every window of twenty seconds from there to the end, 1,607 in the last, 1,610 over
the ten minutes, on a heap of 106 to 433 MiB, with `warn` at 20, 175, 303, 433 and 564 s and
`ok` half a second after each. At 0.8 times the resident heap it opens the same way and commits
1,637 and 1,648 in its first forty seconds and 1,408 to 1,657 afterwards, 1,566 in the last
window, 1,567 over the ten minutes, with `warn` at about 335 of 476 MiB every 72 to 89 seconds
and `ok` at about 120 MiB half a second later.

At 2.5 times the resident heap the store is opened with the Merkle trees and the window in
memory, on 258 MiB. `warn` comes once, at 39 s (1,054 of 1,488 MiB), the window is trimmed and
the cache capped, `ok` follows at 316 MiB, and the window is not read back (291 MiB needed and
194 MiB of room at 76 s). The run commits 1,858 transfers a second in its first twenty seconds,
1,650 to 1,760 to the end of the second minute and 1,366 to 1,594 from there on, 1,402 in the
last window: 1,508 over the ten minutes, with the heap growing from 404 to 990 MiB at the
twenty-second reports. It falls by a quarter from its first window to its last, where the two
paged runs fall by 9% and 4% (below).

The same ten minutes with `indexTrees: 'memory'`, in this batch, show what index trees in
memory cost under this load, per stretch of the run:

| seconds | index trees | what happened | transfers/s |
|---|---|---|---:|
| 0 to 32 | in memory, as opened (398 MiB) | `warn` at 32 s (1,057 of 1,488 MiB): index trees dropped, window trimmed, `ok` at 327 MiB | 1,608 in the first 20 s |
| 32 to 61 | dropped | the node had run 32 s, so it waits about as long at `ok` | 1,571 and 1,559 in the two windows that hold the stretch |
| 61 to 211 | rebuilt at 61 s, within half the limit; the window stays trimmed (232 MiB needed, 24 MiB of room) | `warn` again at 211 s (1,044 MiB) | 1,342 to 1,437, 1,379 on average |
| 211 to 600 | dropped | the node had run 150 s since the rebuild and waits as long, to 360 s, then finds no room (563 MiB needed) and stays paged | 1,488 to 1,667, 1,567 on average |

One rebuild, where the rule of ten samples made two in the earlier build. The run commits 1,522
transfers a second over the ten minutes with two visits to `warn`, and its stretches show what
a rebuild costs under this load: with the index trees in memory the rate is 12% below what it
is after they are dropped. Set beside the default run at the same limit the totals do not show
it: the node with `store` read 1,567 on average over the seconds in which this one had its
index trees in memory, and 1,449 over the seconds after, so the two ten-minute totals, 1,508
and 1,522, are within 1%. A node with `indexTrees: 'memory'` starts with them when they fit,
and rebuilds them when the heap has stayed at `ok` long enough, index reads (accounts by name,
scans) being served from memory then. A proof after the runs takes 0.06, 11 and 23 ms at the
newest height, fifty back and a hundred back at the resident figure, 0.07, 11 and 21 ms at 0.8
times it, and 0.05, 17 and 36 ms at 2.5 times it (0.05, 16 and 32 ms with `memory`).

Whether the index trees are in memory at all is a setting, and measurements of this kind
changed its default. `indexTrees: 'store'` in a node's config, the default, makes a node that
never builds them: index reads go to LMDB from the start, and the guard has no index trees to
drop or to rebuild. `'memory'`, the default of the earlier builds, is the node of the table
just above and of the passages before it. The two ten-minute runs of this batch at 2.5 times
the resident heap, the mempool kept 1,000 transfers ahead, side by side
(`BENCH_PAGING_INDEX_TREES`):

| `indexTrees` | opened with | transfers/s over ten minutes | blocks | heap during the run | visits to `warn` | longest GC pause |
|---|---:|---:|---:|---|---:|---:|
| `memory` | 398 MiB | 1,522 | 1,828 | 327 to 1,057 MiB (420 to 1,039 at the twenty-second reports) | 2 | 140 ms |
| `store` (the default) | 258 MiB | 1,508 | 1,758 | 316 to 1,054 MiB (404 to 990 at the twenty-second reports) | 1 | 136 ms |

Over the whole run the two are within 1%; the `memory` run's own stretches show the cost, 1,342
to 1,437 transfers a second while the index trees were in memory and 1,488 to 1,667 while they
were dropped. With `store` the node opens with a third less heap (258 against 398 MiB), reaches
`warn` once, at 39 s, from the history window and the cache, which are then trimmed and capped,
and has nothing to rebuild but the window. Proofs and the Merkle trees are unaffected. The pair
of runs on the earlier build, which decided the default, read 1,485 with `memory` and 1,552
with `store`.

What `store` gives up is index reads from memory, and that is measured with readers beside the
load. `BENCH_PAGING_READS=200` makes the node read its indices in three ways while it commits,
on a timer that asks for 200 reads a second of each kind: an account by name, a balance by
owner and asset, and a page of twenty accounts in name order from a random name. The node's
thread is busy with the load, and the runs made 7,280 to 9,330 reads of each kind in their
three minutes, 40 to 52 a second. The heap is 2,380 MiB, 4.0 times the resident figure, so that
no run reaches `warn` and the node with `memory` keeps its index trees for the whole of its
three minutes; each read is timed on its own, in microseconds:

| `indexTrees` | readers | transfers/s | opened with | account by name: median, 99th percentile | balance: median, 99th percentile | page of twenty: median, 99th percentile, mean |
|---|---|---:|---:|---:|---:|---:|
| `memory` | first run | 1,378 | 402 MiB | 6, 24 | 7, 18 | 18, 76, 33 |
| `memory` | second run | 1,386 | 402 MiB | 5, 20 | 6, 14 | 17, 43, 28 |
| `memory` | none | 1,390 | 402 MiB | | | |
| `store` | first run | 1,500 | 262 MiB | 5, 38 | 5, 19 | 34, 1,588, 62 |
| `store` | second run | 1,648 | 262 MiB | 4, 33 | 5, 14 | 31, 569, 54 |
| `store` | none | 1,529 | 262 MiB | | | |

A lookup by key costs the same either way at the median, 4 to 7 microseconds, and its 99th
percentile is 20 to 24 microseconds from memory against 33 to 38 from the store for a name,
with no difference for a balance (14 to 19 either way). A page of twenty takes twice as long
from the store at the median, 31 to 34 against 17 to 18 microseconds, and its tail is longer:
over the three minutes the 99th percentile of a page is 569 and 1,588 microseconds from the
store against 43 and 76 from memory. In the run that read 1,588 the 99th percentile of a page
was 85 to 217 microseconds in four of the nine twenty-second windows and 562 to 2,155 in the
other five. The earlier build's two runs of this table read 186 and 215 microseconds for it.
The longest single reads were 2.9 to 7.7 ms for a page and 1.5 to 4.1 ms for a lookup, under
both settings, the longest of all a page from the store. What lengthened a read from memory
was not measured: a collection during the read is a possible cause, and time a read spent
queued behind a commit is not in its figure, each read being timed from the moment its own
call starts. The store
here is in the operating system's page cache, as a node's store is once it has opened it (the
cold-store run below). The readers themselves do not show in the rate: with and without them
the rows of each setting overlap. The setting does: every `store` run is above every `memory`
run, 1,559 against 1,385 on average, 13% more, which agrees with the stretches of the
ten-minute run with `memory` above, though not with the two ten-minute totals. So under this
load `store` costs a scan about 15 microseconds a page at the median and a longer tail, costs a
lookup nothing measurable, and gives back 140 MiB of heap and, in these three-minute runs,
about a ninth of the rate. That is why `store` is the default, and `memory` the setting for a
node that mostly serves scans.

A cold store. The same readers with `store` and 4.0 times the resident heap, for 30 seconds,
the reads reported every two seconds, on a store none of which was in the page cache: it was
built on a disk image that was detached and attached again just before the node opened it
(`BENCH_PAGING_BEFORE_NODE`, with `TMPDIR` on the image). The node opened in 3,661 ms; the
three warm runs with `store` in the table above, under the same heap, opened in 3,359, 3,389
and 4,179 ms, the last being the one run of the batch above 3.7 s. Microseconds, median and
99th percentile:

| seconds of the run | account by name | balance | page of twenty |
|---|---:|---:|---:|
| 0 to 2 | 5, 42 | 5, 23 | 51, 189 |
| from 2 on | 5, 30 to 48 | 5, 12 to 25 | 39 to 47, 79 to 113, and 979 in the window that ends at 6 s |

The node reads its whole store when it opens, the objects into the arena and the index entries
checked against them, so it is the open that meets the cold cache, and index reads after it are
warm from the first. In this batch the cold open is inside the range of the warm ones (3.2 to
3.7 s over the other runs at this size), so the batch does not show what the cold cache adds to
it; the earlier build's run read 3,965 ms cold against 3,355 to 3,545 ms warm. Only a store
that is not in the machine's memory sends index reads to the device; the machine has 48 GiB, so
that was measured without a node (below). The page median is 39 to 51 microseconds on the disk
image against 31 to 34 on the internal volume: a different volume, and nothing is read into the
difference. The run committed 1,383 transfers a second over its 30 seconds.

Reads that reach the device. `bench/cold-reads.ts` (section 1) opens the store read-only
without a node, so nothing has read it first, and times each read on its own. The state is a
150 MB genesis, 514,008 accounts, a store of 576 MiB on disk, on a disk image detached and
attached again before the reads; 5,000 reads of each kind, then the same again at once, warm.
Microseconds, median, 99th percentile and mean:

| reads | account by name | account object | page of twenty |
|---|---:|---:|---:|
| 1 to 500 (cold) | 4, 320, 60 | 140, 315, 96 | 12, 244, 67 |
| 501 to 1,000 | 3, 147, 8 | 3, 201, 31 | 8, 163, 17 |
| 1,001 to 1,500 | 2, 123, 3 | 2, 192, 16 | 7, 124, 9 |
| 2,001 to 2,500 | 2, 5, 2 | 2, 157, 4 | 7, 17, 8 |
| 4,501 to 5,000 | 2, 3, 2 | 2, 8, 3 | 6, 9, 7 |
| second run, 1 to 500 (warm) | 3, 15, 4 | 3, 17, 7 | 9, 44, 12 |
| second run, 4,501 to 5,000 | 1, 3, 2 | 2, 5, 2 | 6, 9, 7 |

The longest single read of the cold run took 4,886 microseconds, an object among reads 4,001 to
4,500; the next longest took 788, a page among the first 500, and the longest of the warm run
982. A read that has to reach the device takes about 140 to 320 microseconds here: that is the
median of the object read among the first 500, when more than half of them missed the cache,
and the 99th percentile of all three kinds among them (320, 315 and 244). From the page cache
a lookup by name or by id takes 1 to 3 microseconds at the median and a page of twenty 6 to 9,
so the two are not one baseline: a lookup that misses takes of the order of a hundred times as
long (the object's median of 140 among the first 500 against 2 to 3 warm) and a page that
misses some tens of times (a 99th percentile of 244 against a warm median of 6 to 9), both
still a fraction of a millisecond. The name index is small, one entry an account, and its 99th
percentile is 5 microseconds from the 1,500th read on; the objects send more than one read in
a hundred to the device for the first 3,000 reads and fewer after, with single reads of about
200 microseconds to the end. The objects are not most of the 576 MiB: 514,008 accounts of 123
bytes and balances of 24 encode to about 72 MiB, and the rest is what the store keeps beside
them (the index entries, the tree chunks and nodes of section 4.12) and LMDB's page overhead.
So on a machine whose memory the store did not fit,
an index lookup that missed would cost a few hundred microseconds on a solid-state disk, and
how many miss depends on how much of the index fits. A node with `indexTrees: 'memory'` would
not pay that for index reads and would pay it for objects all the same. Three caveats. The disk
image's file is on the internal solid-state disk and the host may cache it, so a slower or
busier device would cost more. This is a read-only scan of the store with no node writing to
it. And it is one run. What is still not measured is a node under load on a machine whose
memory the store really exceeds.

The same readers beside the node at its resident figure (595 MiB), where the Merkle trees and
the window are in the store too: twice with the readers and twice without, three minutes a run,
on the defaults. With the readers the node committed 1,561 and 1,682 transfers a second, and
without them 1,689 and 1,687. A name took 5 microseconds at the median and 32 to 33 at the 99th
percentile, a balance 5 and 13, a page 36 to 39 and 139 to 153, and the longest read 1.9 and
3.7 ms. One of the two runs with readers is 8% below the other three, which is what two runs of
one configuration differ by, so the readers are not shown to cost the rate. The pair was
repeated because a single earlier run of this kind, on the earlier build with `memory`, had
read 1,303 against 1,619 without readers; repeated on that build it read 1,633 and 1,644 with
the readers and 1,561 and 1,553 without.

The node as it now opens. When `store` became the default, a stored state was at first still
opened against the warn line, 0.7 of the limit, and at the resident figure that went badly:
with no index trees to make room for, the Merkle trees fitted, the node opened with 258 MiB in
use and ran between about 340 and 420 MiB of its 595, 75 MiB under `warn`. Over ten minutes it
reached `warn` 61 times, every ten seconds, never `pressure`, and committed 1,478 transfers a
second, from 1,650 in its first twenty seconds to about 1,400 in its last minute, where the
same heap with `memory` and the Merkle trees left in the store had committed 1,619 with five
visits. So a stored state is opened against half the limit, the share a rebuild is allowed
(`Node.OPEN_FILL`, 0.5). The node as it stands, `store` and that rule, 191,896 accounts, from
this batch:

| heap limit | run | opened with | heap after opening | transfers/s | visits to `warn` | longest GC pause |
|---|---:|---|---:|---:|---:|---:|
| 476 MiB (0.8×) | 600 s | Merkle trees and history left in the store | 39 MiB | 1,567 | 8 | 76 ms |
| 595 MiB (1.0×) | 600 s | Merkle trees and history left in the store | 39 MiB | 1,610 | 5 | 79 ms |
| 744 and 745 MiB (1.25×) | 40 s each | Merkle trees and history left in the store | 39 MiB | 1,634 and 1,771 | 1 | 67 and 68 ms |
| 893 MiB (1.5×) | 40 s | Merkle trees and history in memory | 258 MiB | 1,624 | 1 | 57 ms |
| 1,190 MiB (2.0×) | 40 s | Merkle trees and history in memory | 258 MiB | 1,644 | 1 | 87 ms |
| 1,488 MiB (2.5×) | 600 s | Merkle trees and history in memory | 258 MiB | 1,508 | 1 | 136 ms |

No run reached `pressure`, and each refused only the feeder's first 508 transfers. Up to 1.25
times the resident heap the Merkle trees and the window do not fit within half the limit and
the store is opened without them, on 39 MiB; from 1.5 times on it is opened with them, on 258
MiB. At the resident figure the visits to `warn` are five, as they were with `memory` and the
Merkle trees left in the store, and the run reads 1,610 where that one read 1,619.

The 2.5× row is the one that declines over its ten minutes: from 1,858 in its first twenty
seconds to 1,425 to 1,594 in its third and fourth minutes and 1,366 to 1,511 from there to the
end, where the paged runs at 0.8 and 1.0 times read 1,566 and 1,607 in their last windows
against 1,637 and 1,768 in their first. The same configuration run for three minutes (the first
row of the arena table, below) starts the same way and is higher at the end of its third
minute, 1,859 falling to 1,619, where the ten-minute run read 1,507. The earlier build's runs
of this row read 1,552, 1,400 and 1,493 over ten minutes, and the text then took the 1,400 for
a slow run: the third of them had CPU profiles of thirty seconds near its start and near its
end (`BENCH_PAGING_PROFILE`) and showed no decline, and its two profiles were alike, the main
thread busy throughout, the collector 1.9 seconds of the thirty early and 2.2 late with the
heap grown from about 700 to 980 MiB, the signature cache 0.2 and 0.4 seconds once it is full
and every new transaction evicts an old one. The profile was not repeated in that batch. A run
made after it, with the same limit and the two profiles, shows where the time goes, and it is
not the heap. The run committed 1,590 a second over its ten minutes, 1,750 to 1,800 in its
first half minute and 1,450 to 1,640 in its last minute. At 39 seconds the heap reached `warn`
(1,046 of 1,488 MiB): the history window was trimmed to two versions and the cache capped, and
from 76 seconds on the node kept them so for want of room to rebuild. The Merkle trees stayed
in memory throughout (the run reports no block committed with them dropped), so this is not
the node of the rows at 0.8 and 1.0 times. Between the two profiles the time the main thread
spends inside the store's commit (lmdb-js's `finishTxn`, the native call that writes a block's
pages) doubles, 2.4 seconds of the thirty early and 4.9 late, with `fsync` 2.3 and 2.5 beside
it; the collector is 2.2 and 2.1, and signing the feeder's transfers on the same thread 8.1
and 7.0. The store grows by some 950,000 transfers, their blocks and their history entries
over the run, and a commit into the larger store costs more: about a twelfth more of the main
thread's time, against a rate that falls by a tenth to a sixth between the first half minute
and the last. The commit is the one cost the profiles show growing, and it accounts for most
of the fall; the early profile also covers the half minute before `warn`, with the whole
window in memory, and how much of the faster start is that was not measured. The 1,366 to
1,511 the batch's run read at its end and the 1,450 to 1,640 of this one are the spread
between two runs. What grows inside the commit, and what the paged rows do, is taken up next.

What made the commit grow. The measurements of this passage and the next two are of the node
before the two tables they find were changed; what was changed, and what it measured after, follows
them. Two tables were keyed by a transaction's hash: the block store's
transaction index (one entry per transaction, kept until the block is pruned) and the
application's record of recent transactions, by which a transaction is refused a second time
(one object and two index entries per transaction, kept until the transaction expires; the
load's transfers expire an hour after the run starts, so none expires in ten minutes). A hash
lands anywhere in its table, so once a table has more leaf pages than a block has
transactions, each transaction of a block dirties a leaf page of its own, and LMDB copies and
writes the whole page, 16 KiB on this machine, for an entry of some 55 bytes. Entries keyed in
the order they are written (blocks by height, the account history's log) fill one page after
another and cost the same however large the table is. Measured on LMDB alone
(`bench/.stress/commit/lmdb-probe.ts`: commits of 500 entries with 41-byte keys and 14-byte
values, to a million entries), a commit of entries keyed in order takes 4.4 to 4.9 ms from the
first hundred thousand to the last; one of entries keyed by 32 random bytes takes 8.4 ms over
the first hundred thousand, 15.7 ms at half a million and 19.0 ms at a million, by when the
table has 5,798 leaf pages. Smaller pages do not help here: with 4 KiB pages the same commit
takes 46.7 ms at a million entries, and with 8 KiB pages 37.0 ms.

On the node the same shows as the time spent inside the store's transactions (a block's writes
and the application's are one), which the node of the suite now reports per window. Five more
runs of ten minutes were made on 2026-11-16, each on a copy of one built state, with thirty-
second windows and the two profiles: the configuration of the 2.5× row; that with blocks
stored without their transaction index (`BENCH_PAGING_NO_TX_INDEX`), twice; that with
transfers that also expire a minute after they are signed (`BENCH_PAGING_EXPIRATION_S=60`);
and the last again with the node at the resident figure (595 MiB), beside a run at 595 MiB
with nothing changed.

| run (limit) | store time per block: first window, at 5 minutes, last window | transfers/s: first window, last window, whole run | native commit in the early and late profile |
|---|---|---|---|
| as the node is (1,488 MiB) | 45, 70, 102 ms | 1,479, 1,333, 1,516 | 3.3 s, 7.7 s |
| no transaction index (1,488 MiB) | 37, 56, 55 ms | 1,697, 1,521, 1,583 | 3.1 s, 4.7 s |
| no transaction index, expiry a minute (1,488 MiB) | 38, 75, 83 ms | 1,761, 1,439, 1,524 | 3.2 s, 6.7 s |
| as the node is (595 MiB, paged) | 67, 95, 71 ms | 1,560, 1,476, 1,415 | 5.4 s, 6.0 s |
| no transaction index, expiry a minute (595 MiB, paged) | 37, 61, 64 ms | 1,728, 1,495, 1,524 | 3.2 s, 5.2 s |

With the index the store's time per block rises through the whole run, 45 ms to 102, and the
rate falls from a highest window of 1,713 to 1,333; the run left 922,369 index entries in
5,950 leaf pages. Without the index the store's time rises for four and a half minutes, 37 ms
to 55, and stays at 53 to 56 ms from there to the end, the rate at 1,520 to 1,600: the index is
about half of what a commit costs by the tenth minute, and the growth that goes on after the
fifth minute is its growth. The first of the two runs without the index ended the same way
(55 ms a block and 1,541 transfers a second in its last window) and had windows of 1,008 to
1,236 between 30 and 90 seconds and of 1,220 to 1,459 between 180 and 300 that the second did
not have; it started straight after the previous run's store was deleted, and the later runs
waited 45 seconds. What still grows without the index is the application's table of recent
transactions: 956,274 records by the end, each with an entry under its hash.

A short expiry does not make that table cheap. With transfers expiring after a minute the
table holds about 86,000 records and no more, yet the store's time per block is higher than
with the table growing, 83 ms against 55 at the end, with a step from 65 to 78 ms at the
sixth minute: every block now removes as many records as it adds, each removal at a hash of
its own as each insertion is, and what the step at the sixth minute is was not found. A chain
whose wallets sign with a short expiry, as the command line does (a minute), is this row and
not the one above it.

The paged rows. The node at the resident figure runs with the Merkle trees left in the store,
so each block's root reads and writes their chunks inside the same store transaction, and its
store time starts higher, 67 ms a block. It was 79 to 95 ms in most windows up to the sixth
minute and fell back to 69 to 74 ms from 390 seconds to the end, after its third visit
to `warn`; its native commit is 5.4 s of thirty early and 6.0 s late, and its rate was 1,560
in its first window and 1,476 to 1,563 in its last four. Its lowest windows, 1,264, 1,164 and
652 between 120 and 210 seconds, end with the second visit to `warn` (212 seconds, the heap
filling), which is the collector and the guard's shedding, not the store. So the reading
above this passage, that the paged rows decline for the reason the 2.5× row does, is not what
this run shows: the paged node pays the index from the start and does not slow further over
ten minutes. Without the index and with the short expiry the paged node's store time is 37 ms
rising to 61 by the third minute and flat after, its rate 1,728 falling to about 1,570.

What was done about it. Three remedies were measured on 2026-11-17 and two were kept. For the
transaction index, `bench/.stress/commit/index-probe.ts` writes 500 entries a commit beside a
block-sized value to two million entries under each layout, and then looks hashes up:

| layout of the index | commit at 200,000 entries, at a million, at two million | a lookup by hash after 4,000 blocks |
|---|---|---|
| by hash and height (as it was) | 10.8, 19.0, 29.3 ms | 0.008 ms |
| in the order written (no index by hash at all) | 4.2, 4.2, 3.7 ms | |
| by segment of 8 blocks, then hash | 4.7, 4.6, 5.2 ms | 0.95 ms |
| by segment of 32 blocks, then hash | 7.4, 5.1, 5.1 ms | 0.27 ms |
| by segment of 128 blocks, then hash | 10.6, 11.0, 10.7 ms | 0.10 ms |
| by hash, written once every 16 blocks | 6.2, 15.5, 52.2 ms | 0.009 ms |
| by hash, written once every 64 blocks | 4.5, 5.6, 11.2 ms | 0.009 ms |

Keyed by a segment of blocks first, the entries of a block go among those of the blocks around
it, on pages that are being written anyway, and the commit costs what it cost on the first day
however long the chain is; a lookup has to ask every segment, a read or two each, so it costs
what the commit no longer does, 0.27 ms over 4,000 blocks at 32 blocks a segment and in that
proportion some 60 ms over a million blocks kept (larger segments behind the small ones were
added afterwards to bound it; "The lookup, bounded" below). Holding the entries back and writing many
blocks' worth at once only puts the growth off. The index is now kept in segments of 32 blocks
(`TX_SEGMENT_BLOCKS`, chapter 10 of the tutorial). For the record of recent transactions the
remedy is one index in place of two, by expiration and then id: a transaction's id covers its
expiration, so the pair is still an exact lookup, and transactions signed around the same time
land together.

Ten-minute runs of the node at 2.5 times the resident heap, each on a copy of one built state,
with transfers that expire thirty minutes after they are signed
(`BENCH_PAGING_EXPIRATION_S=1800`, so that none expires during the run and the expirations move
as the clock does). The first five were made with the two layouts behind switches, before they
were written into the node, the last three with the node as it now is:

| run | store time per block: first window, at 5 minutes, last window | transfers/s: first window, last window, whole run |
|---|---|---|
| as it was | 39, 70, 71 ms | 1,817, 1,544, 1,559 |
| index in segments only | 38, 54, 80 ms | 1,829, 1,473, 1,549 |
| recent transactions by expiration only | 62, 80, 55 ms | 1,683, 1,572, 1,557 |
| both | 39, 43, 44 ms | 1,755, 1,622, 1,687 |
| recent transactions by expiration, no index at all | 37, 40, 43 ms | 1,676, 1,656, 1,671 |
| the node as it now is, first run | 61, 66, 67 ms | 1,648, 1,525, 1,479 |
| the node as it now is, second run | 37, 44, 66 ms | 1,836, 1,614, 1,656 |
| the node as it now is, third run | 62, 66, 67 ms | 1,657, 1,573, 1,588 |

With both, the store's time per block stays where it starts for the whole run, as it does with
no index at all, and the rate with it; either alone leaves the other table growing and changes
little. Three things in the table were not explained when it was made. A run starts at about
38 ms a block or at about 62, whichever layout it has (the third, sixth and eighth rows start
high), and keeps the difference to its end: the native commit is 3.1 to 3.3 s of the first
profile's thirty seconds in the runs that start low and 4.8 to 5.1 s in those that start high,
on copies of the same store. Some runs have a few slow windows after the sixth minute (the
second row from 390 seconds, the sixth at 360 to 420 seconds, where its lowest window is 604
transfers a second, the seventh at 360 to 420 seconds), as the run with a short expiry above
had. And the seventh row's last window reads 66 ms where the nineteen before it read 37 to 51.
The sixth row was made while other work ran on the machine; the seventh and eighth were not.

The two levels are the machine's, not the node's. Ten runs of 62 seconds were made one after
another, each on a fresh copy of the state, with a hundred synced writes of 64 KiB timed before
and after each. The first run read 36 and 38 ms a block in its two windows. The second read 38
in its first window and 62 in its second, and the eight runs after it read 60 to 65 in every
window: the level changed once, in the middle of a run, and stayed for every copy made
afterwards. The synced writes changed with it. Their fastest tenth took 3.05 ms before the
change and 3.9 to 4.0 ms after it, in the copy's directory and in a file that no run touched;
a commit of the node, which syncs megabytes where the probe syncs 64 KiB, lost 24 ms. What
puts the device (an internal SSD, 95% full) in one state or the other was not found, and
nothing the node does selects it. So a store time is comparable between two runs only where
the device was in the same state, the seventh row's last window is such a change and not the
index, and a run that begins low and ends high has to be read window by window.
`BENCH_PAGING_SYNC_PROBE` (among the node script's switches at the head of this section) puts the probe in every window for that.
It is a sample of twenty writes at the window's end, and a single window's figure can read
high with the store time unmoved; a run of windows that read alike is the sign.

With the probe in each window, the node before these two changes and the node after them, ten
minutes each, one after the other:

| run | windows with `syncMs` near 3.9 | windows with `syncMs` near 3.0 | transfers/s over the run |
|---|---|---|---|
| before | 0 to 180 s: 67, 79, 83, 86, 88, 88 ms a block | 180 to 600 s: 63, 62, 63, 66, 67, 67, 68, 68, 69, 71, 73, 71, 71, 73 ms | 1,550 |
| after | (three windows, 210 to 300 s, read 3.7 to 3.9 with the store time unmoved) | 36, 38, 39, 41, 42, 40, 42, 42, 42, 43, 42, 47, 42, 44, 43, 43, 43, 43, 42, 42 ms | 1,724 |

In the same state of the device the store's time before the change climbs from 39 ms (the
first row of the table above) through 62 at four minutes to 73 at ten, and after it stays
between 39 and 44 after the first minute, but for one window of 47 at 360 seconds; the last window commits 1,514 transfers a second
before and 1,814 after. The slow windows after the sixth minute did not appear in either run
(the lowest window after the change is 1,565 at 360 seconds) and are still not explained.

The lookup, bounded. The segments made a lookup by hash cost what the commit no longer did: a
read or two for every 32 blocks held, some 60 ms over a million. Behind them the store now
keeps larger segments, each holding 32 of the level below (1,024 blocks, 32,768, and so on),
and moves a segment's entries up once the 32 are all behind the latest block: copied in the
order of the larger segment's keys, then removed (`mergeTxLevel`, chapter 10 of the tutorial).
A probe of the layout on LMDB alone, 20,000 blocks of 500 entries (10 million), one commit a
block:

| | commit a block, by stretches of 2,000 blocks | a lookup by hash at the end | leaf pages |
|---|---|---|---|
| segments of 32 blocks alone | 5.4 to 7.5 ms | 632 reads, 1.42 ms | 67,262 |
| with the larger segments behind them | 6.2 to 7.8 ms | 44 reads, 0.11 ms | 46,117 |

The probe is not the store's code. It copied in larger steps than the store does, a larger
segment in some 85 blocks, and removed its small ones in 170, so its averages over 2,000 blocks
hide what a block pays while that goes on. The block store itself, as it now is against as it
was, saving 2,400 blocks of 600 transactions of 430 bytes on LMDB with nothing else in the
environment, three runs of each one after the other, a hundred blocks to a figure. Its budget
is 1,800 entries a block here, so the first larger segment (613,800 entries, heights 1 to 1,023) is copied in the
341 blocks after block 1,024 and its small ones are removed in the 341 after that:

| | blocks 1 to 1,000 | 1,001 to 1,400 (copying) | 1,401 to 1,700 (removing) | 1,701 to 2,000 | 2,001 to 2,400 (copying the next) |
|---|---|---|---|---|---|
| segments alone | 6.2 to 7.6 ms a block | 6.1 to 7.3 | 6.1 to 7.2 | 6.1 to 7.2 | 6.3 to 7.2 |
| with the larger segments | 6.6 to 7.5 | 8.8 to 10.4 | 11.1 to 12.5 | 6.5 to 8.3 | 8.2 to 10.3 |

Copying adds about 3 ms to a block's save and removing about 5, for two blocks in three, and a
block with nothing to move pays a few tenths for asking each level whether it has. A profile
puts the cost in the calls into LMDB, a range read and a put for each entry copied, a range
read, a point read and a delete for each removed, and not in the commit. A first version
removed each stretch of keys right after copying it, a few entries from the front of all 32
small segments at every block, which rewrote 32 pages a block: a node's store time went from
44 ms a block to 58 and more once the first 1,024 blocks were behind it, and the removal was
changed to go through the small segments front to back, which frees whole pages. With that,
one ten-minute run of the node read 45 to 52 ms a block in the six windows after block 1,024
(1,483 to 1,695 transfers a second), against 44 to 46 in the same windows of a run without the
larger segments (1,520 to 1,791). Other work was running on the machine through the node runs
(the first seven minutes of that one read up to 171 ms a block, before any entry had moved,
and a second pair was lost to it altogether), and they were made before the step was given
its present form (it now takes the entries that come next from whichever small segments have
them, where it took an equal share from each, and writes above what it finds missing there
when removing, where it began the copy again). So the node figures are an indication and the
store's own, above, are the measurement: three to five milliseconds of a block's 44 while a
move is under way.

The expirations have to move for the second remedy to do anything. The suite's own load signs
every transfer with one expiration, an hour after the run starts, and under it the new index
has the same expiration in front of every id and is as scattered as the old one was. The node
as it now is, under that load: 38 ms a block in the first window, 55 at five minutes and 56 in
the last, 1,771 transfers a second in the first window, 1,626 in the last and 1,587 over the
run, against 45, 70 and 102 ms and 1,516 over the run before. A wallet that signs with an
expiration a fixed time ahead, as the command line does, is the load of the table above; one
that picks expirations at random across the hour allowed is this one.

The window in memory, measured directly. `retain.memoryVersions` sets how many of the provable
versions a node keeps in memory, the store answering for the rest. The node that never reaches
`warn`, 514,008 accounts under 3,126 MiB (2.0 times its resident heap), was run for 120 seconds
twice with the whole window of 100 versions and twice with two
(`BENCH_PAGING_MEMORY_VERSIONS=2`), the two settings interleaved (the proofs from memory
predate the fix of section 4.3):

| window in memory | transfers/s | heap at the twenty-second reports | longest GC pause | proof at the newest height, fifty back, a hundred back |
|---|---:|---|---:|---|
| 100 versions (the default), first run | 1,335 | 1,060 to 1,603 MiB; never reached `warn` | 202 ms | 0.04, 0.01 and 0.01 ms |
| 100 versions, second run | 1,402 | 1,108 to 1,767 MiB; never reached `warn` | 237 ms | 0.13, 0.03 and 0.09 ms |
| 2 versions, first run | 1,246 | 880 to 1,141 MiB | 127 ms | 0.04, 13 and 25 ms |
| 2 versions, second run | 1,348 | 819 to 1,057 MiB | 178 ms | 0.04, 13 and 33 ms |

Throughput is not shown to depend on the window: 1,246 to 1,402 transfers a second in the four
runs, and the two runs of each setting differ from each other (5% and 8%) by as much as the
settings' means do (1,369 with 100 versions, 1,297 with two, 5%). The first run with two
versions ended on a window of 866 transfers a second, the lowest of any window in the four
runs; its other five read 1,185 to 1,460. An earlier reading of the matrix here, that a node
keeping its whole window commits less because the collector traces several hundred MiB of it,
was not supported either: it rested on one row of an earlier matrix, which was the spread
between runs, and what slowed the 192,000-account node at 1.5 and 2.0 times its resident heap,
before `warn` paged it, was its index trees being in memory. What the setting buys is memory
and pause length: about 500 to 700 MiB less heap at this size (1,057 to 1,141 MiB at the
highest report against 1,603 to 1,767) and a longest pause of 127 to 178 ms against 202 to 237
ms. What it costs is the proofs at past heights, 13 to 33 ms from the store instead of a small
fraction of a millisecond from memory.

The guard's measure. The limit is the old generation's, and the guard compared it with V8's
`used_heap_size`, which counts the young generation too: up to a semi-space, 64 MiB as `start`
runs the node, of garbage that the next minor collection frees and that never reaches the old
generation. On a heap of several hundred MiB that brought `pressure` a little early. On a small
one it was most of the reading: the 34,000-account node under 153 MiB logged `critical` at
"162 of 153 MiB" and read 42 MiB a sample later. The levels are now taken from the old
generation's use alone (`heapOld`, every space but the two young ones), and the small state's
rows of the matrix above are the result.

Past versions from the store. With the window in memory trimmed to two versions, or never read
back (a store opened paged), a proof or a query at an older height is answered from the history
records the store keeps for the full window: the records of every version after the one asked
about are scanned, oldest first, for the few dozen entries the answer needs (STATE-PAGING.md
section 7.3). Twenty proofs of random accounts after each run, per proof, from this batch:

| state, heap limit | newest height | fifty heights back | a hundred back (the oldest provable) | window in memory |
|---|---:|---:|---:|---|
| 34,267 accounts, 122 MiB | 0.05 ms | 4.0 ms | 11 ms | 2 versions |
| 191,896 accounts, 745 MiB (the published run) | 0.08 ms | 8.9 ms | 20 ms | 2 versions |
| 191,896 accounts, 595 MiB, after ten minutes | 0.06 ms | 11 ms | 23 ms | 2 versions |
| 191,896 accounts, 298 MiB, opened paged, after two minutes | 0.07 ms | 9.3 ms | 19 ms | 2 versions |
| 191,896 accounts, 1,488 MiB, after ten minutes | 0.05 ms | 17 ms | 36 ms | 2 versions |
| 514,008 accounts, 3,126 MiB, `retain.memoryVersions` 2, two runs | 0.04 ms | 13 ms | 25 and 33 ms | 2 versions |
| 514,008 accounts, 3,126 MiB, never trimmed, two runs | 0.04 and 0.13 ms | 0.01 and 0.03 ms | 0.01 and 0.09 ms | 100 versions |

A read from the records costs 0.1 to 0.35 ms per version between the height asked about and the
newest, a record of a block of 440 to 570 transfers being some hundreds of kilobytes to walk,
and it holds no memory afterwards; from the window in memory the same proof took a tenth of a
millisecond or less at any height before the fix of section 4.3, and was not timed after it.
Over every run of the batch that ended with a window of two versions, by state: at 34,267
accounts (five runs) fifty heights back took 3.9 to 5.5 ms and a hundred back 9.3 to 13 ms; at
191,896 accounts (twenty-one runs) 3.6 to 17 ms and 9.3 to 36 ms; at 514,008 accounts (two
runs) 13 ms and 25 and 33 ms. The newest height read 0.04 to 0.08 ms in all of them. An earlier
build read the same figures at 514,000 accounts as at 192,000, and the text then said that the
cost follows the blocks' size and not the state's. This batch does not show that cleanly, with
blocks of about the same size throughout: the ranges above rise with the state, and the range
at 191,896 accounts is as wide as the difference between the states. Of its twenty-one runs, a
hundred heights back took 16 to 24 ms in the thirteen of forty seconds to three minutes at half
the resident heap or more with the arena unbounded or at 32 MiB (the published run and the
matrix among them), 9.3 and 12 ms under the two smallest heaps of the table below, 15 and 29 ms
in the two runs with a 16 MiB arena, 21 and 23 ms after ten minutes paged (the 0.8 and 1.0
times runs), and 32 and 36 ms after ten minutes at 2.5 times the resident heap. Before the
records were read, the node of the second row could prove three heights and refused the other
ninety-eight.

The same state opened under heaps it used to abort under, below the 258 MiB that opening it
with the Merkle trees and the window in memory takes (STATE-PAGING.md section 9.1): the node
estimates each tier from the store's counters and leaves out what does not fit within half the
limit (the node as it now opens, above), and the history window with it. From this batch:

| heap limit | of the resident heap | opened with | heap after opening | run | transfers/s | levels reached |
|---|---:|---|---:|---:|---:|---|
| 298 MiB | 0.5 | Merkle trees and history left in the store | 34 MiB | 120 s | 1,530 | `warn` five times |
| 208 MiB | 0.35 | Merkle trees and history left in the store | 33 MiB | 60 s | 1,476 | `warn` four times |
| 149 MiB | 0.25 | Merkle trees and history left in the store | 34 MiB | 60 s | 1,211 | `warn` twice, the second from 14 s to the end of the run |

All three opened in 3.2 to 3.3 seconds and committed for the whole run, every block with the
Merkle trees in the store. After each run twenty proofs of random accounts were built at each
of three heights, the newest, fifty back and a hundred back, the oldest provable: 0.06 to 0.07
ms, 3.6 to 9.3 ms and 9.3 to 19 ms a proof. The benchmark asks for proofs only there, after
the load has ended, and does not verify them, so it does not show every height of the window
provable throughout a run. None reached `pressure`, where each of the three went once in an
earlier round, for 1,357, 1,197 and 1,171 transfers a second. With the index trees in the store
all three open on the same 33 to 34 MiB; the earlier build, which built them when they fitted,
opened the first two on about 155 MiB. A quarter of the resident heap is enough under this
load: the node commits 1,211 transfers a second there, at `warn` for most of the run with the
cache capped, where the same run reached `critical` once while the guard counted the young
generation, and two thirds was the floor before stores were opened paged. The collector's share
grows as the heap shrinks: 1.2 to 1.7 seconds of every twenty at 298 MiB, 2.2 to 3.3 at 208 MiB
and 3.5 to 4.6 at 149 MiB. The first run at 208 MiB, before any of these figures, found a fault
of its own: opening leaves garbage several times what it keeps, and the guard's first sample
read 211 MiB of 208 and reported `critical` for a node that held 75 MiB. The node collects once
before the guard's first sample.

The arena's budget. The encoded objects are in the arena, outside the heap, where the guard
does not see them; `start --arena <MiB>` bounds it and leaves the rest in the store
(STATE-PAGING.md section 3.4). The same node for three minutes under a heap 2.5 times the
state, with no budget, 32 MiB and 16 MiB, and then at half the resident heap as well, from this
batch:

| heap limit | arena budget | arena | objects left in the store, first report to last | array buffers | transfers/s over 3 min |
|---|---:|---:|---:|---:|---:|
| 1,488 MiB | none | 48 to 64 MiB | 0 | 102 to 142 MiB | 1,694 |
| 1,488 MiB | 32 MiB | 32 MiB | 124,000 to 211,000 (237,000 at most) | 84 to 111 MiB | 1,692 |
| 1,488 MiB | 16 MiB | 16 MiB | 310,000 to 627,000 | 69 to 94 MiB | 1,577 |
| 298 MiB | 16 MiB | 16 MiB | 316,000 to 375,000 (485,000 at most) | 70 to 90 MiB | 1,381 |

The arena holds its budget exactly, and what it gives back is what it no longer holds: 48 MiB
fewer array buffers at 16 MiB than with none, by the end of the run, when the unbounded arena
has grown to 64 MiB with the recent transaction ids. Throughput is the same with no budget and
with 32 MiB, 1,694 and 1,692 transfers a second, and 7% lower at 16 MiB, 1,577, which is inside
what two runs of one configuration differ by; the 16 MiB run's last three windows read 1,488,
1,330 and 1,354 where the other two runs read 1,586 to 1,678 in theirs. Each of the three had
one visit to `warn`. At 16 MiB 310,000 objects are left in the store at the first report and
627,000 at the last, the state having grown by then with the recent transaction ids, and they
are read from LMDB when they are wanted: the decoded-object cache is in front of the arena, so
an object in use is read once. At 16 MiB 69 to 94 MiB of array buffers remain (the tree chunks
being written, the mempool's transactions, the keys and hashes of the decoded objects). The
process's resident set does not follow at this size: it moves by several hundred MiB with the
collector and with LMDB's mapped pages, which the operating system counts against the process
and gives back under pressure, so the arena's 50 MiB cannot be read off it. The budget is worth
setting where the encoded state is large against the heap, an ML-DSA-44 state above all, whose
keys are most of it and are all in the arena. The last row is the two together: half the
resident heap and a 16 MiB arena, 1,381 transfers a second for three minutes on 148 to 198 MiB
of heap at the reports and 70 to 90 MiB of buffers, with five visits to `warn` and none to
`pressure`.

Then the database alone, in the parent process after the node session (so with a full history
window): blocks of 500 random transfers, six per mode, checked through `checkTx` first as
admission does, then finalized and committed to LMDB; the modes added up as the guard's levels
add them. From the published run of this batch:

| mode | blocks/s | transfers/s | finalize | commit | checkTx of 500 | heap after | array buffers |
|---|---:|---:|---:|---:|---:|---:|---:|
| resident | 9.3 | 4,669 | 50.4 ms | 56.7 ms | 71.3 ms | 945 MiB | 116 MiB |
| cache capped at 10,000 | 10.5 | 5,236 | 49.0 ms | 46.6 ms | 52.7 ms | 941 MiB | 116 MiB |
| and index trees dropped | 11.6 | 5,824 | 39.6 ms | 46.2 ms | 55.6 ms | 760 MiB | 102 MiB |
| and Merkle trees dropped | 10.0 | 4,983 | 42.0 ms | 58.4 ms | 49.9 ms | 537 MiB | 86 MiB |
| everything rebuilt (1.06 s) | 9.9 | 4,959 | 54.5 ms | 46.3 ms | 59.5 ms | 951 MiB | 117 MiB |

The commits include the flush to the device. In the earlier build that keyed the account
history by account the same five modes ran at 8.7, 8.8, 10.0, 8.3 and 8.7 blocks a second with
commits of 62, 63, 58, 76 and 63 ms, against 46 to 58 ms here. The rebuild is estimated at 149
MiB for the index trees and 366 MiB for the Merkle trees.

Analysis. The node is the point of the suite: a heap a quarter larger than the resident state,
a store opened without its Merkle trees and its history on 39 MiB, a load that brings it to
`warn` after twenty seconds, and a node that kept committing for the whole run with its index
trees, its Merkle trees and all but two versions of its history in the store. Two runs of
builds before the guard's changes show what they are for: with the levels' lines taken from
V8's `heap_size_limit`, which includes the young generation's reserve, the same node reached
`warn` and died of an out-of-memory error at 19.5 s without ever shedding, because `pressure`
sat past the point of the abort; with the lines fixed and the trees rebuilt at the first `ok`
sample, it changed level 30 times in 40 seconds, rebuilding each time, and committed 622
transfers a second. With the tiers dropped but the history window whole (100 versions of
overwritten tree nodes and object bytes, each block of scattered transfers adding tens of
thousands of records), the window kept the heap at its limit and the run ended alternating
between `warn` and `pressure`; trimmed, it does not.

In the mode table the index trees give back 181 MiB of heap and the Merkle trees 223 MiB, and
with both dropped and the cache capped the database runs on 537 MiB, 57% of the 945 MiB it
holds resident with a full history window. An earlier build ran the same mode suite on the
state before any node session (no history yet), with the account history still keyed by
account, and gave 10.6, 10.2, 11.5, 10.7 and 10.3 blocks a second and 493, 512, 382, 189 and
617 MiB of heap: there the index trees gave back 130 to 175 MiB and the Merkle trees 190 to 220
MiB, the cache up to 190 MiB when it held 200,000 decoded objects (nothing when it held fewer
than its cap), and with everything dropped the database ran on 40 to 50% of its resident heap;
that variant was not run in this batch. No mode is slower than the resident row, which is the
first one measured after the node session and reads 9.3 blocks a second where the same
configuration, rebuilt at the end, reads 9.9; the fastest is the one with only the index trees
dropped, 11.6. With the Merkle trees dropped as well it is 10.0 against 11.6 (8.3 against 10.0
in the build before the history log), where it was 7.7 against 9.4 while the dropped trees'
cache held 256 chunks: the trees of this state have about 420, so a root read the rest from
LMDB at every block, and at 514,000 accounts, whose trees have 1,100, a block of 500 transfers
took 271 ms to finalize against 60 to 69 with every chunk cached and 45 to 73 resident. The
cache holds 4,096 chunks, 128 MiB at most and outside the heap, so the dense trees of up to two
million leaves are read once after a drop and the cache bounds only larger ones. The index
trees dropped cost nothing a block of transfers notices (the transfers' balance lookups are answered from the store; a
block's finalize even gets faster without the B+ tree updates, 39.6 ms against 49.0).

## 5. What bounds what

- **Signatures bound everything that touches a transaction.** 0.7 to 0.9 ms of CPU per
  signature, secp256k1 to ML-DSA-44, verified once per node, at admission or in the block, and
  reused while its cache entry lasts (the cache holds 20,000 transaction bodies; a signer whose
  key an earlier transaction of the same block introduces is verified in the per-transaction
  pass). A node admits 5,800 ML-DSA-44 or 8,700 secp256k1 transfers a second on eleven threads;
  a network of such nodes cannot commit more than its block space allows.
- **Block space is the ceiling of the live network, and the runs were below it.** A full block
  holds 1,667 transfers, the codec's figure exactly, and encodes to 4.01 MiB with its header and
  commit (1,663 in the batch's run, when the 4 MiB limit counted the header and the commit), at
  about one block a second with these timeouts. The run of section 4.6 committed 1,014 a second in seven
  blocks that held 857 transfers on average, one of them full, and the secp256k1 run 1,450 a
  second with its largest block at 437 KiB of the 4 MiB (section 4.9). So block space is a
  limit these runs reached in one block, not what set their rates, and what did set them end
  to end was not separated. Signatures are 96% of a transfer's bytes under ML-DSA-44 and 42%
  under secp256k1.
- **The root bounds nothing yet.** About 20 microseconds per changed object, hashing included;
  2,400 scattered transfers in 86 ms on a 387,000-leaf tree.
- **Persistence is one flush a block.** A block's chain writes (block, commit, results,
  validator sets, state) and the application's changes are one LMDB transaction when the node
  holds the application, where they were two; a snapshot or pruning adds its own. The
  application's commit is 9.9 ms after a 500-transfer block at 1,001 accounts and 46 to 58 ms,
  flush included, for a block of 500 transfers scattered over 192,000 accounts in the mode
  table of section 4.13, whose chunks are about 12 MiB. The ablation of section 4.13, made on
  an earlier build, put LMDB's own work for such a block at 15 to 19 ms (17 to 26 ms before the
  account history became a log) and the commit with its flush at 40 to 120 ms, varying by tens
  of milliseconds from one minute to the next.
- **Memory is the state plus the history window.** A gigabyte of ML-DSA-44 genesis is 1.6 GB of
  heap and array buffers in the process that built it and 1.0 GB after a restart. The keys are
  half a gigabyte of that (a fortieth as much under secp256k1), held twice after building,
  decoded and in the arena, and once after a restart. Add changed objects times retained
  versions, and a second copy of the state at the end of a state-sync join (2.6 GB with the
  original and the synced state both loaded in the local pipeline of section 4.8). The rest is
  the object database's own objects, indices and trees, the same under both schemes. Measured
  per account with its balance and two keys, with everything resident: 5.2 KB under ML-DSA-44
  and 2.6 KB under secp256k1 after a restart, 8.9 KB and 3.8 KB after building.
- **Paging bounds memory by the working set, not the state.** Under the memory guard the state
  is a cache over LMDB: the cache of decoded objects capped at `warn` (and the index trees
  dropped there, on a node with `indexTrees: 'memory'`; by default they are never built), the
  Merkle trees dropped at `pressure`, rebuilt once the heap has stayed at `ok` for as long as
  the node had run before the drop and they fit within half the limit. With everything dropped
  the database runs on 57% of the heap it holds resident in the mode table of this batch, and
  on 40 to 50% in an earlier build's run on a state with no history yet, at the throughput it
  has resident or above it (section 4.13). The history window is trimmed at `warn` and the
  mempool admits up to a share of its limit that follows the level, so a node held at or below
  its resident heap refuses nothing after the feeder's first 508 submissions, at startup, and
  commits 1,567 and 1,610 transfers a second for ten
  minutes, at 0.8 times and at the resident figure, without reaching `pressure`; a store whose
  tiers do not fit within half the limit is opened with them left on disk, down to a quarter of
  the resident heap under that load; and a height the trimmed window no longer holds is proven
  from the store's records, in 0.1 to 0.35 ms per version back instead of a tenth of a
  millisecond. The arena, outside the heap, has its own budget: throughput was the same with a
  budget of 32 MiB as with none and read 7% lower at 16 MiB, a quarter of what the unbounded
  arena grew to, which is inside what two runs differ by.
- **A loaded node is faster without its index trees in memory, so by default it never builds
  them.** The builds that led to this kept them in memory (`indexTrees: 'memory'`, the default
  at the time). While the index trees and the history window went only at `pressure`, the rate
  fell by a third over the first minutes of a full load, as the heap climbed towards the
  pressure line, and returned to 1,330 to 1,560 transfers a second, level, once they were
  dropped; and at 192,000 accounts the node with twice its resident heap committed 1,250 where
  the one at 0.8 times it committed 1,520. As the node stands the ten-minute run at the
  resident heap holds 1,502 to 1,789 in every window of twenty seconds, and the forty-second
  rate is 1,589 to 1,644 in the matrix's single runs at every limit from 0.8 to 2.0 times the
  resident heap (1,771 in the published run at 1.25 times). Of the two it
  is the index trees that a load of transfers pays for, about a tenth of its rate while they
  are in memory: in this batch 1,385 against 1,559 transfers a second over three minutes at 4.0
  times the resident heap, and 1,379 against 1,567 between the stretches of the ten-minute run
  with `memory` at 2.5 times, though the totals of the two ten-minute runs at 2.5 times, 1,522
  with `memory` and 1,508 with `store`, do not differ. The window in memory costs the rate
  nothing measurable (1,246 to 1,402 transfers a second with 100 versions or with two at
  514,000 accounts), and what trimming it gives back is heap and pause length. The store's part
  was the account history, whose entries, keyed by account, came to dirty a page each: in the
  ablation of the earlier builds the application's commit grew from 17 to 26 ms over 400 blocks
  with them and from 15.1 to 19.4 ms with the history as a log (section 4.13).
- **Disk is the blocks.** 2.5 KiB per transfer under ML-DSA-44, 154 bytes under secp256k1. The
  state, with its index entries, chunks and nodes stored beside the objects (section 4.12), is
  about the size of an ML-DSA-44 genesis (958 MiB for the gigabyte) and about four times a
  secp256k1 one (213 MiB for a 56 MB genesis); a snapshot adds the objects again while kept
  (506 MiB and 34 MiB).

## 6. What the benchmarks found

Benchmarking is how six defects were found and fixed. They are finding 30 and findings 32 to 36
in [REVIEW-2026-10-28.md](../REVIEW-2026-10-28.md). The figures of the table are those of the
builds that made the fixes:

| finding | before | after, when it was fixed |
|---|---|---|
| Block sync recursed between its check and drain steps, overflowing the stack on every peer status during a sync; the overflow was swallowed as a rejection | 7,492 state reads per status message | a handful |
| A cold block verified one signature at a time because the per-transaction key resolution had serialised verification; the worker pool idled | 930 transfers/s cold | 6,300 (batch pre-verification; the per-transaction resolution kept) |
| A request sent the instant a peer connected was dropped while the other side still verified the handshake signature; a joining node waited out a 5-second timeout | block sync 929 tx/s | 4,600 |
| The worker verifier let the process exit while a caller awaited it | a benchmark exited with an unsettled promise | workers held while jobs are in flight |
| A genesis over 512 MB could not be loaded (V8's string limit, and the whole document parsed at once) | impossible | 15 s per gigabyte through a token stream |
| The encoded bytes of every changed object were retained after a store had written them, after genesis and after every restart | +500 MiB per gigabyte of state, twice | released once written |

In this batch a cold block runs at 5,800 transfers a second under ML-DSA-44 and 7,300 under
secp256k1, block sync at 3,400 and 5,600, and a gigabyte of genesis parses and builds in 17.9 s
(6.5 s and 11.4 s), the build writing the index entries, chunks and nodes as well as the
objects.

A seventh came from profiling the paging node (section 4.13): the mempool shifted an array of
100,000 hashes for every transaction once its cache of seen transactions was full, 8% of a
loaded node's process; as a ring it costs nothing, and the ten-minute rate at the resident heap
went from 1,088 to 1,321 transfers a second.

Three more came from asking why that node still slowed, and why a small state reached
`critical` (section 4.13). The memory guard compared the old generation's limit with the whole
heap's use, the young generation's garbage included, which on a 153 MiB heap read as 162 MiB a
moment before a collection left 42: every limit up to 1.5 times a 34,000-account state's
resident heap reached `critical`, and none does now. The cache of chunks that dropped Merkle
trees read through held 256, fewer than the trees of a state of 200,000 accounts have, so a
root read the rest from LMDB at every block: 271 ms to finalize a block at 514,000 accounts
against 60 to 69 with them cached. And a block was two store transactions, each with its flush
to the device, where one holds both.

Two changes of design came from the same measurements (section 4.13). The commit ablation
showed the account history, two entries a transfer keyed by account, to be 10.7 ms of a 26 ms
commit after 400 blocks; as a log in block order it is 4.5. And the ten-minute run showed the
node committing a fifth to a third more once its index trees were dropped, which happened only
at `pressure`, minutes into the run; the index trees and the history window were made to go at
`warn`. With both, the ten-minute rate at the resident heap went from 1,322 to 1,574 transfers
a second, and to 1,619 in the build after. A third followed: the index trees are left in the
store by default and a stored state is opened against half the limit, and the same run reads
1,610 in this batch, 1,768 in its first window and 1,607 in its last.

## 7. Sizing a node

For a chain with `S` bytes of application state (roughly the genesis size), `B` blocks kept and
`T` transfers a block:

- memory: under ML-DSA-44, 1.0 × S of heap and array buffers after a restart and 1.6 × S in the
  process that built the state from its genesis (the resident set is larger); 2.6 × S with two
  copies of the state loaded, as at the end of a local state-sync run, and more while joining,
  when the chunks, the rebuilt state and the opened store are held together, which was not
  measured; add the history window (changed objects per block × retained versions × their
  size). S is mostly keys under ML-DSA-44: an account's two keys are 2,626 bytes against 68
  under secp256k1, so the same accounts make a far smaller S there, while the objects, indices
  and trees around the keys cost the same;
- disk: under ML-DSA-44 1.0 × S for the state and 1.5 × S with a snapshot; under secp256k1 3.8
  × S and 4.4 × S, the index entries, chunks and nodes being most of it; plus 2.5 KiB × T × B
  for blocks under ML-DSA-44 (154 bytes × T × B under secp256k1); a commit of N validators is
  48 + N bytes plus 2,421 or 65 per signature, and every stored block holds two of them, the
  previous block's commit inside the block and its own commit beside it;
- CPU: one core verifies 1,100 ML-DSA-44 or 1,400 secp256k1 signatures a second; a validator
  should have enough threads to admit the network's full rate with margin, since a block it did
  not see through gossip costs it the whole verification again.

A node that pages (the memory guard's `warn` and `pressure` levels; [running.md](running.md)
section 12) needs less memory than that, with two provisos. With the cache capped and the index
and Merkle trees dropped the database ran on 57% of the heap it holds resident in this batch
and on 40 to 50% in an earlier build's run (section 4.13), and a store whose tiers would not
fit within half the limit is opened with them left on disk, so the heap need not hold the
resident state even once: a quarter of the resident heap was enough at 192,000 accounts under a
full load. What the guard pages away besides is the load's growth: the mempool's pending
session, the history window, the recent transaction ids. A state small against the load (tens
of thousands of accounts) is paged the same way: at 34,000 accounts every limit from 0.8 to
twice the resident heap ran without reaching `critical`. Expect a node that lives paged to
commit what a resident one does, within 3.5% at 192,000 accounts and 5 to 7% less at 514,000
in the matrix's forty-second runs, both inside what two runs differ by, with the trees coming
back only
when they fit within half the limit, and a proof at a height the trimmed window no longer holds
to take milliseconds instead of a tenth of one. On disk the store holds every index entry,
every dense tree chunk and every sparse tree node beside the objects: 213 MiB for 192,000
secp256k1 accounts, about 1.2 KB an account, where the objects alone were 34.6 MiB in the build
that stored nothing else, and 958 MiB against 614 MiB for 193,000 ML-DSA-44 accounts, 5.2 KB an
account (sections 4.9, 4.11 and 4.12). A block scattered over the state rewrites about 12 MiB
of chunks per commit.

Per account, from the genesis suite at 192,000 to 193,000 accounts with two keys and one
balance each (sections 4.7 and 4.9), divided through:

| per account | ML-DSA-44 | secp256k1 |
|---|---:|---:|
| the two public keys, tags included | 2,626 B | 68 B |
| LMDB on disk | 5,190 B | 1,170 B |
| LMDB on disk with a snapshot | 7,940 B | 1,350 B |
| memory after a restart, heap and array buffers | 5,230 B | 2,570 B |
| of which heap | 2,080 B | 2,080 B |
| memory after building from genesis, heap and array buffers | 8,910 B | 3,750 B |
| of which heap | 3,200 B | 3,320 B |
| heap as a node opens the store by default, index trees left in the store (section 4.13) | not measured | 1,410 B |
| of the heap after building, decoded objects (section 4.10, an earlier build) | about 0.55 KB | about 0.55 KB |
| of the heap after building, indices, name tree and Merkle trees (the same) | about 2.65 KB | about 2.65 KB |

A worked example: ten million accounts with two keys each, a hundred validators, one-second
blocks, the default seven-day unbonding period. The figures are a linear extrapolation from a
point fifty times smaller; lookups are hash and tree based, so the shape should hold, but
nothing has been measured at that scale.

| ten million accounts, 100 validators | ML-DSA-44 | secp256k1 |
|---|---:|---:|
| state on disk, then with a snapshot | 52 GB, 79 GB | 12 GB, 14 GB |
| memory after a restart | 52 GB | 26 GB |
| memory in the process that built the state from genesis | 89 GB | 38 GB |
| memory with two copies of the state loaded, as at the end of a local state-sync run | about 140 GB | about 63 GB |
| a full commit (100 signatures) | 242 KB | 6.6 KB |
| the two commits stored with each block, per day at one block a second (an estimate, before headers and transactions) | 42 GB | 1.15 GB |
| the same over the seven days the evidence window keeps | 293 GB | 8 GB |
| restart (read, indices, trees and root with every check) | about 3.6 minutes | about 2.5 minutes |

Using one key as both owner and active does not shrink these figures: an account stores its
two authorities separately, each with its key in full, and encodes to 2,681 bytes under
ML-DSA-44 and 123 under secp256k1 whether the two keys are equal or not. Two conclusions. On
disk and in commits secp256k1 removes most of the cost of the chain: the state of ten million
accounts is 12 GB against 52 GB and the commits of the evidence window about 8 GB, where
ML-DSA-44 needs nearly three hundred. In memory it does
not: the floor is the object database's own representation in the heap, 2.1 KB per account
after a restart with every tier in memory, under either scheme, and 1.4 KB as a node opens the
store by default, with the index trees left in it (measured under secp256k1), so ten million
accounts need 14 to 21 GB of JavaScript heap to run with their Merkle trees in memory, above
Node's default old-space limit (`--max-old-space-size`) and beyond a laptop; paged, a quarter
of the resident heap was enough at 192,000 accounts (section 4.13), and the encoded objects,
outside the heap, can be bounded with `--arena`. Signature scheme is the right knob for disk
and bandwidth; for memory at that scale the knobs are the memory guard's dials, the heap limit
a store is opened under, and the arena's budget.

## 8. Further work the numbers point to

1. **Index reads from a store larger than memory.** Index trees in memory cost a load of
   transfers about a tenth of its rate (the runs with `indexTrees: 'memory'`, section 4.13), so
   `indexTrees: 'store'` is the default and a node never builds them. What that costs index
   reads (accounts by name, scans) is measured on a node under load, with the store in the page
   cache and with none of it there when the node opened it (section 4.13): a lookup by key the
   same, a page of a scan about twice as long at the median, with a longer tail. What a read
   costs when it reaches the device is measured too, on a store read cold without a node
   (section 4.13): about 140 to 320 microseconds, against medians of 1 to 3 for a lookup and 6
   to 9 for a page of twenty from the page cache. What is
   not measured is a node under load on a machine whose memory the store really exceeds.
2. **The checks at a restart.** With the past versions read from the history records a restart
   at 192,000 accounts is 2.85 s, and 1.4 s without the check of every object against its leaf
   (section 4.12): what is left is the checks themselves, which could run after the node has
   started serving, or over a sample.
3. **Smaller chunks.** A chunk of 1,024 hashes makes a block scattered over the state rewrite
   nearly every chunk of the trees it touches, about 12 MiB per root at 192,000 accounts, a
   fifth of the commit when the chunks were first written (section 4.12); smaller chunks on
   disk would cut that about in half at this size, and the dropped-mode root, which reads and
   writes whole chunks, with it.
4. **State sync.** Stream chunks into the store instead of holding them all, then rebuild from
   the store; that removes one of the copies and most of the peak.
5. **Signatures per block.** A per-signature or per-kilobyte transaction fee would price the
   96% of block space that ML-DSA-44 signatures take; FEES.md leaves it open.
6. **Block space.** Larger blocks raise the network's ceiling and a shorter commit timeout its
   cadence, until admission (5,800/s per node under ML-DSA-44) binds; the network runs here
   filled one block of seven, so what either would do to the measured rate is not known.
7. **What the transaction index now costs a lookup.** The two tables that made a block's
   write grow with the chain were changed (section 4.13): the transaction index is kept in
   segments of 32 blocks and the record of recent transactions under one index by expiration.
   A lookup by hash read every segment the node held, a quarter of a millisecond over
   4,000 blocks in the probe and so some 60 ms over a million. Larger segments behind the small
   ones now bound it (section 4.13): 44 reads and 0.11 ms over 20,000 blocks, a few dozen
   segments a level however long the chain, for 3 to 5 ms of a block's save while entries are
   being moved up. A `tx` call makes the lookup, and a `broadcastTx` in commit mode of a
   transaction the mempool has seen before and no longer holds; a broadcast of one it has just
   admitted, or still holds, waits for the block and looks nothing up. The node runs that
   measured the cost of moving the entries were made on a busy machine and want repeating on a
   quiet one. The record of recent transactions is cheap only while expirations
   move with the clock; transactions signed with expirations spread over the allowed hour
   scatter it as before. Runs of one configuration that differ by 25 ms a block from their
   first window turned out to be two states of the machine's disk (section 4.13;
   `BENCH_PAGING_SYNC_PROBE` labels each window with it), and what puts the disk in either was
   not found. The slow windows after the sixth minute of some runs are not explained.

## 9. Adding a benchmark

A suite is a module with `export async function run()` that calls `suite(name)` once and then
`bench(...)` and `fact(...)`; register it in the `suites` map in `bench/run.ts`, and add it to
`DEFAULT_SUITES` only if it runs in well under a minute and needs nothing on disk. Use
`bench/fixtures.ts` for accounts and signed transfers, `bench/bigstate.ts` for the large state,
and keep every iteration independent of the previous one (replay protection refuses a
transaction a second time; use `before` to rebuild). Report sizes and memory with `fact`, and
make the benchmark fail loudly on a wrong result: a transfer that fails or a proof that does not
verify is a bug, not a number.
