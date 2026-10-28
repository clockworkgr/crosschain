# Benchmarks

What is measured, how, what the numbers were on one machine, and what they say about where the
time and the memory go. The benchmark code is in `bench/`; the figures here are from the runs
that produced the summary in the [README](../README.md#performance).

## 1. Running them

```sh
npm run bench                  # crypto, codec, db, store, app, network: about two and a half minutes
npm run bench -- db app        # a subset
npm run bench:genesis          # the genesis and scale suites on a 1 GB genesis: about six minutes
BENCH_GENESIS_MB=100 npm run bench:genesis   # a smaller genesis
BENCH_KEEP=1 npm run bench:genesis           # keep the generated files and stores for inspection
BENCH_LOG=debug npm run bench -- network     # log the late-joining node of the network suite
```

Both scripts run Node with `--expose-gc` so memory can be measured after a collection. Nothing
else is special: the benchmarks are plain TypeScript run by Node like the rest of the code.
Temporary files go under the system temp directory. The genesis and scale suites keep theirs when
`BENCH_KEEP` is set; the app and store suites always remove theirs.

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
- **Signing varies.** ML-DSA-44 signing has a rejection loop; its mean moved between 3 and 9 ms
  from run to run. Verification is stable at about 0.8 ms.
- **p99 is mostly garbage collection.** Iterations that allocate see a 10 ms 99th percentile on
  a 1 ms median; that is a collection landing in the window, not the operation.
- **RSS is not a budget.** Resident set size includes LMDB's memory map (file-backed, evictable)
  and pages the allocator keeps after a release. Heap plus array buffers after a collection is
  the figure that says what the process needs.
- **Sizes are MiB** (2^20 bytes) throughout; "1 GB genesis" means 1,000 MiB of JSON.
- **Numbers move a few percent between runs.** Tables show one run each; ranges are noted where
  two runs differed noticeably.
- **The tables are copied from one run's output.** The runner prints the machine, the date and
  its tables and saves nothing, so a figure here is an observation on that day, not a constant:
  rerun and compare before relying on one.
- **Two suites bypass what a deployed node would pay.** The scale suite's RPC figures are
  measured with the server's rate limiter raised out of the way (10⁹ tokens a second, costly
  calls charged one), and its state-sync figure runs the pipeline inside one process from the
  local store, without peers or light-client verification; sections 4.8 and 5 say so where they
  apply.

## 4. The suites

### 4.1 crypto

What the whole system rests on: ML-DSA-44 key generation, signing and verification, sha256, and
the worker pool that spreads verification over threads.

| benchmark | ops/s | mean |
|---|---:|---:|
| keyPairFromSeed | 1,489 | 672 µs |
| sign (256 B message) | 107 to 333 | 3 to 9 ms |
| verify, inline | 1,200 | 833 µs |
| sha256 (2.5 KB) | 802,000 | 1.2 µs |
| WorkerVerifier.verify, 256 signatures on 11 threads | 8,274 | 31 ms per 256 |
| WorkerVerifier.verifyOne (round trip) | 978 | 1.02 ms |

Sizes: public key 1,312 bytes, signature 2,420, secret key 2,560.

Analysis. One core verifies 1,200 signatures a second; eleven threads reach 8,300, a speed-up of
6.9, with the rest lost to serialising jobs into worker messages. A single job through the pool
costs 1 ms round trip, the same as verifying inline, so the pool only pays when it is given
batches; that fact shaped the application change in section 6. Hashing is three orders of
magnitude cheaper than any signature operation and never appears in a profile.

### 4.2 codec

| benchmark | ops/s |
|---|---:|
| encodeTransaction | 928,000 |
| decodeTransaction | 2,730,000 |
| txHash | 788,000 |
| txsRoot over 500 transactions | 651 (1.5 ms) |

A signed transfer is 2,509 bytes: a 41-byte operation, 48 bytes of framing and signer address,
and a 2,420-byte signature. The suite's estimate of how many fit a 4 MiB block, 1,668, subtracts
a 2 KiB shell; the proposer measures the real shell (header, previous commit, evidence) and keeps
1 KiB spare, so the count depends on the validator set and the evidence, and the four-validator
network in section 4.6 filled a block with 1,664. Encoding and decoding are microseconds and
never matter.

### 4.3 db

The object database on its own, in memory, with 100,000 balance objects and later 20,000
accounts whose names live in a sparse Merkle tree.

| benchmark | ops/s | mean |
|---|---:|---:|
| create 100,000 balance objects | 628,000 | 159 ms for all |
| first root over 100,000 objects | | 307 ms |
| modify 100 balances + root | 436 | 2.3 ms |
| modify 1,000 balances + root | 51.5 | 19 ms |
| modify 10,000 balances + root | 6.5 | 155 ms |
| get by id | 23,800,000 | 42 ns |
| lookup by unique index (byOwnerAsset) | 1,040,000 | 1 µs |
| scan 100 entries of a non-unique index | 14,500,000 | 70 ns per entry |
| object proof (current version) | 88,000 | 11 µs |
| object proof at a past version | 82,600 | 12 µs |
| verifyObjectProof | 66,700 | 15 µs |
| session: modify 1,000 then undo | 96 | 10 ms |
| create 20,000 accounts (name index is an SMT) + root | | 702 ms |
| create 1,000 accounts + root (1,000 SMT inserts) | 32 | 31 ms |
| name proof | 219,000 | 4.6 µs |
| verifyKeyProof | 54,000 | 18 µs |

Measurements: 100,000 balances with their trees take 91 MiB of heap; an object proof is 777 bytes
with 21 sibling hashes; a name proof 958 bytes. After the suite's 1,061 versions of heavy churn
the heap holds 782 MiB.

Analysis. The root after a block costs about 15 µs per changed object plus the hashing of each
changed object's bytes, and it scales linearly with the number of changes: 100 changes in 2 ms,
1,000 in 19, 10,000 in 155. A lookup by id is a map and an array access; a lookup by index walks
a B+ tree, whose depth grows with the log of the state, and at the sizes measured neither showed
it. The sparse Merkle tree for names costs about 30 µs per insert, five times a dense
leaf, which is why only unique indices that need proofs are authenticated. The last line is the
one to remember: version history is retained objects times retained versions, and a benchmark
that modifies 10,000 objects per version for 100 versions keeps a million prior values. At
realistic block sizes that is tens of megabytes; the retention window is the knob.

Two costs were added on purpose after the second review and measured again. A record is now
frozen through every nested object and array when it is created or modified, about 0.7 µs for an
account-sized record; on the small balance objects of the create benchmark that shows as the rate
falling from 731,000 to 628,000 objects per second, and in the modify rows, where hashing
dominates, it does not show at all. And a name proof is built from copies of the tree's hashes
rather than references to them, which took it from 2.5 µs to 4.6 µs. Both are a small fraction of
the request they serve, and both close a way for a careless caller to corrupt the database.

### 4.4 store

LMDB through the key-value interface, and the block store on top of it.

| benchmark | ops/s | mean |
|---|---:|---:|
| write transaction: 1 put of 100 B (commit + sync) | 228 | 4.4 ms |
| write transaction: 1,000 puts of 100 B | 160,700 puts/s | 6.2 ms per transaction |
| get (random key) | 975,000 | 1 µs |
| range scan of 1,000 entries | 2,390,000 entries/s | 0.4 µs per entry |
| saveBlock (500 txs, results, tx index) | 122 | 8.2 ms |
| loadBlock | 2,567 | 0.4 ms |
| loadResults | 24,000 | 42 µs |

Analysis. A write transaction costs about 4 ms regardless of size, which is the sync to disk;
a thousand puts cost 2 ms more. Everything the node writes per block (the block, the results,
the index, the application's changes) is a handful of transactions, so persistence is under
15 ms a block. Reads are memory-mapped and cost as much as a hash lookup plus a copy.

### 4.5 app

The core application on its own: admission, blocks with and without cached signatures, commit to
memory and to LMDB. The genesis has 1,001 accounts; transfers are pre-signed.

| benchmark | ops/s | mean |
|---|---:|---:|
| checkTx, inline verifier, one at a time (500 txs) | 965 | 518 ms per 500 |
| checkTx, worker pool, 32 in flight (2,000 txs) | 6,677 | 300 ms per 2,000 |
| finalizeBlock 500 transfers, cold, inline verifier | 947 | 528 ms |
| finalizeBlock 500 transfers, cold, worker pool | 6,292 | 80 ms |
| finalizeBlock 500 transfers, warm (signatures cached by checkTx) | 27,400 | 18 ms |
| finalizeBlock 1,500 transfers, warm (about 3.6 MiB with a block shell) | 26,100 | 57 ms |
| finalizeBlock, empty block | 31,700 | 32 µs |
| commit to memory (after a 500-transfer block) | 380 | 2.6 ms |
| commit to LMDB (after a 500-transfer block) | 114 | 8.8 ms |

Genesis with 1,001 accounts parses, applies and roots in 79 ms.

Analysis. A warm block, whose signatures the mempool already verified, runs at 26,000 transfers a
second: evaluation, the per-transaction key resolution and authority check, the history
records and the root together cost under 40 µs per transfer. A cold block, where every
signature must be verified, runs at the pool's speed, 6,300 a second. The difference is the
whole cost of signatures and the reason the mempool verifies at admission: a validator that saw
the transactions through gossip spends 57 ms on 1,500 transfers (about 3.6 MiB with a block
shell; the benchmark hands the transactions straight to the application, without building a
block), one that did not spends 240 ms. Commit to LMDB is 9 ms, one write transaction for the
application's store.

### 4.6 network

Whole nodes: four validators on the in-memory transport, then a fifth node catching up.

| measurement | value |
|---|---|
| engine only, empty blocks, commit timeout 50 ms | 9.5 blocks/s, 105 ms per block |
| core app, 6,000 transfers submitted to one node, until all committed | 5.4 s: 1,116 tx/s, 6 blocks, 1,000 txs per block on average, largest 1,664 txs (4.00 MiB) |
| submitted / rejected / failed / left queued | 6,000 / 0 / 0 / 0 |
| block sync, 8 blocks holding 6,000 transfers | 1.3 s: 6.2 blocks/s, 4,629 tx/s; app hash agrees (compared when both nodes are at the same height; the benchmark says so instead when they are not) |

Analysis. With the test timeouts a height takes 105 ms: the commit timeout of 50 ms plus three
message rounds with signing at each. Under load the network settles at a full block a second,
about 1,100 transfers a second, and the limit is block space: each node admits the transfers
at pool speed and the proposer fills the 4 MiB. Raising the block size or lowering the commit
timeout would raise the number; neither changes the cost per transfer. Block sync runs at
4,600 transfers a second, which is the cold block speed from section 4.5 less the fetch
round trips.

### 4.7 genesis

A gigabyte of application genesis: 193,536 accounts with two keys each, written as JSON, parsed
as a token stream, built, written to LMDB, read, snapshotted and reopened.

| measurement | value |
|---|---|
| parse as a token stream (stream-json) | 6.4 s, 157 MiB/s |
| build: objects and indices, first root, write to LMDB | 8.0 s (apply 3.7 s, root 3.5 s, persist 0.8 s) |
| memory after building | heap 584 MiB, array buffers 536 MiB; peak RSS 3.7 GB |
| LMDB on disk | 614 MiB; 1,120 MiB after one snapshot |
| account by id / by name / balance | 16,000,000 / 821,000 / 971,000 per second |
| object proof + verify / name proof + verify | 41,800 / 46,500 per second; 3.4 KiB (22 siblings) and 932 B |
| block of 500 transfers at this size | finalize 25 ms, commit 11 ms |
| state snapshot | 3.5 s |
| restart from LMDB | 11.8 s: read and decode 387,575 objects 4.9 s, indices and root 3.1 s, index history rebuild 3.7 s |
| memory after restart | heap 588 MiB, array buffers 538 MiB |

Analysis. The state is its keys: 387,000 ML-DSA public keys are 508 MiB, and the heap around
them (objects, indices, trees) is about the same again, so a gigabyte of hex genesis is 1.1 GB
at rest. Lookups are the same speed as with a thousand accounts; proofs grow by one sibling per
doubling (22 siblings here against 21 for 100,000 balances). Parsing runs at 157 MiB/s, about
the speed of the hashing of the keys it yields. Building is apply (decode, index, tree leaves),
root (hash every object, build the trees, build the name tree) and a single LMDB transaction
of 614 MiB. The restart costs more than the build because the store is read object by object
and the name tree is built twice: once live while importing, once in `rebuildIndexVersions` to
recover past-version proofs. The second build is the one obvious saving left on this path.

### 4.8 scale

Steady state on top of that genesis.

| measurement | value |
|---|---|
| RPC, 16 clients, idle chain: account by name with proof / object with proof / history / status | 6,467 / 7,011 / 9,658 / 10,376 calls/s |
| RPC broadcastTx, 16 clients, 2,000 transfers until committed, one validator | 814 ms: 2,456 tx/s, 7 blocks |
| the same with 8 clients reading accounts with proofs throughout | 1.1 s: 1,823 tx/s and 1,892 reads/s |
| 8 blocks of 300 transactions of 8 transfers each, random accounts | per block: admit 46 ms, finalize 85 ms, commit 43 ms; 18,700 transfers/s applied |
| growth over those blocks | LMDB +33 MiB; heap in use +148 MiB (the process's heap-used difference across the blocks, not an isolated measure of the 8 retained versions) |
| object proof / name proof at a past height, verified | 38,700 / 43,900 per second |
| account history, newest 20 entries | 991,000 per second |
| state sync pipeline, local, 201 chunks (504 MiB) | export 4.6 s, read and verify chunks 3.5 s, rebuild and check roots 10.3 s, write 4.2 s, open 14.1 s: 36.6 s in all; no peer transfer or header verification |
| memory with the original and the synced state both loaded | heap 1,292 MiB, array buffers 1,074 MiB |

Analysis. The RPC path is bounded by JSON and proof serialisation, not by the state: six to ten
thousand calls a second from one process. These are the server's rates, measured with its rate
limiter raised to 10⁹ tokens a second and costly calls charged one token; a public endpoint with
the defaults (section 8 of [running.md](running.md)) admits far less per client. A single
validator takes 2,450 transfers a second through the RPC, which is the mempool admission rate
(section 4.5) less the HTTP overhead, and keeps 1,800 a second while serving 1,900 proof reads a
second alongside. Scattered batch transfers cost 35 µs per transfer in finalize, against under
40 µs with a thousand accounts: the tree is bigger but a block changes only a few thousand of
387,000 leaves. The heap grew 18 MiB per block at 2,700 changed objects a version, an upper
bound on what the history window costs that also includes whatever else those blocks left
allocated. The state-sync figure is the pipeline alone, in one process from the local store:
export, read the chunks back and verify them, rebuild, write, reopen, with no peer transfer and
no light-client verification of the header. It is bounded by walking every object three times
(export, rebuild, open) and by holding three copies of the state while it does so.

## 5. What bounds what

- **Signatures bound everything that touches a transaction.** 0.8 ms of CPU per signature,
  verified once per node, at admission or in the block, and reused while its cache entry lasts
  (the cache holds 20,000 transaction bodies; a signer whose key an earlier transaction of the
  same block introduces is verified in the per-transaction pass). A node admits 6,700 transfers
  a second on eleven threads; a network of such nodes commits what its block space allows.
- **Block space bounds the live network.** About 1,660 transfers per 4 MiB block (1,664 with
  four validators' commit in the shell) at about one block a second with these timeouts.
  Signatures are 96% of a transfer's bytes.
- **The root bounds nothing yet.** 15 µs per changed object plus hashing; 2,400 scattered
  transfers in 85 ms on a 387,000-leaf tree.
- **Persistence bounds nothing yet.** Two LMDB write transactions per block, one for the chain
  store (block, commit, results, validator sets, state) and one for the application's changes,
  about 10 ms each; a snapshot or pruning adds its own.
- **Memory is the state plus the history window.** About 1.1 GB per gigabyte of genesis, plus
  changed objects times retained versions, plus two copies more during a state-sync join.
- **Disk is the blocks.** 2.5 KiB per transfer; state is smaller than its genesis; a snapshot
  doubles the state store while kept.

## 6. What the benchmarks found

Benchmarking is how six defects were found and fixed. They are finding 30 and findings 32 to 36
in [REVIEW-2026-10-28.md](../REVIEW-2026-10-28.md).

| finding | before | after |
|---|---|---|
| Block sync recursed between its check and drain steps, overflowing the stack on every peer status during a sync; the overflow was swallowed as a rejection | 7,492 state reads per status message | a handful |
| A cold block verified one signature at a time because the per-transaction key resolution had serialised verification; the worker pool idled | 930 transfers/s cold | 6,300 (batch pre-verification; the per-transaction resolution kept) |
| A request sent the instant a peer connected was dropped while the other side still verified the handshake signature; a joining node waited out a 5-second timeout | block sync 929 tx/s | 4,600 |
| The worker verifier let the process exit while a caller awaited it | a benchmark exited with an unsettled promise | workers held while jobs are in flight |
| A genesis over 512 MB could not be loaded (V8's string limit, and the whole document parsed at once) | impossible | 15 s per gigabyte through a token stream |
| The encoded bytes of every changed object were retained after a store had written them, after genesis and after every restart | +500 MiB per gigabyte of state, twice | released once written |

## 7. Sizing a node

For a chain with `S` bytes of application state (roughly the genesis size), `B` blocks kept and
`T` transfers a block:

- memory: 1.1 × S of heap and array buffers at rest (the resident set is larger); about 3 × S in
  all while joining by state sync, when the chunks, the rebuilt state and the opened store are
  held together; add the history window (changed objects per block × retained versions × their
  size);
- disk: 0.6 × S for the state, 1.2 × S with a snapshot, plus 2.5 KiB × T × B for blocks;
- CPU: one core verifies 1,200 signatures a second; a validator should have enough threads to
  admit the network's full rate with margin, since a block it did not see through gossip costs
  it the whole verification again.

## 8. Further work the numbers point to

1. **Restart.** Build the name tree once on reopen, or persist the sparse tree's node history, to
   remove the 3.7 s rebuild per gigabyte; hash stored bytes directly on import instead of
   re-encoding every object.
2. **State sync.** Stream chunks into the store instead of holding them all, then rebuild from
   the store; that removes one of the three copies and most of the peak.
3. **Signatures per block.** A per-signature or per-kilobyte transaction fee would price the
   96% of block space that signatures take; FEES.md leaves it open.
4. **Block space.** Larger blocks or a shorter commit timeout raise the network's rate directly
   until admission (6,700/s per node) binds.
5. **History memory.** Store prior values compactly (bytes, not decoded objects) or drop them to
   the store, keeping only the roots in memory.

## 9. Adding a benchmark

A suite is a module with `export async function run()` that calls `suite(name)` once and then
`bench(...)` and `fact(...)`; register it in the `suites` map in `bench/run.ts`, and add it to
`DEFAULT_SUITES` only if it runs in well under a minute and needs nothing on disk. Use
`bench/fixtures.ts` for accounts and signed transfers, `bench/bigstate.ts` for the large state,
and keep every iteration independent of the previous one (replay protection refuses a
transaction a second time; use `before` to rebuild). Report sizes and memory with `fact`, and
make the benchmark fail loudly on a wrong result: a transfer that fails or a proof that does not
verify is a bug, not a number.
