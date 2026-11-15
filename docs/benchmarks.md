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
CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 npm run bench -- paging   # the paging suite: that state under the memory guard's modes (section 4.13)
BENCH_PAGING_HEAP=700 CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 npm run bench -- paging   # with the node's heap limit set in MiB
BENCH_PAGING_SECONDS=600 BENCH_PAGING_WINDOW=20 BENCH_PAGING_AHEAD=4000 BENCH_PAGING_MODES=0 ... npm run bench -- paging   # a stress run: ten minutes, 20 s windows, 4,000 transfers kept ahead, node only
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
- **Signing varies.** ML-DSA-44 signing has a rejection loop; its mean has moved between 2 ms
  (the run in section 4.1) and 9 ms from run to run. secp256k1 signing has no such loop and
  stays at 0.23 ms. Verification is stable under both, about 0.9 ms and 0.7 ms.
- **One scheme per run.** Every suite runs under the chain's default scheme, ML-DSA-44, unless
  `CHAIN_SCHEME=secp256k1` is set; the crypto suite alone measures both schemes in one run.
  The figures below are from ML-DSA-44 runs except where both are given.
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

What the whole system rests on: key generation, signing and verification under each of the two
schemes, sha256, and the worker pool that spreads verification over threads.

| benchmark | ML-DSA-44 ops/s | mean | secp256k1 ops/s | mean |
|---|---:|---:|---:|---:|
| keyPairFromSeed | 1,400 | 714 µs | 4,708 | 212 µs |
| sign (256 B message) | 504 | 1.98 ms | 4,334 | 231 µs |
| verify, inline | 1,144 | 874 µs | 1,391 | 719 µs |
| WorkerVerifier.verify, 256 signatures on 11 threads | 7,437 | 34.4 ms per 256 | 9,215 | 27.8 ms per 256 |
| WorkerVerifier.verifyOne (round trip) | 916 | 1.09 ms | 1,304 | 767 µs |

sha256 over 2.5 KB: 776,570 a second, 1.3 µs each (258 µs per 200).

Sizes, tag included: ML-DSA-44 public key 1,313 bytes, signature 2,421, secret key 2,561;
secp256k1 public key 34, signature 65, secret key 33.

Analysis. Verification in pure JavaScript is close between the schemes: one core verifies
1,100 ML-DSA-44 or 1,400 secp256k1 signatures a second, and eleven threads reach 7,400 and
9,200, speed-ups of 6.5 and 6.6, with the rest lost to serialising jobs into worker messages.
A single job through the pool costs about as much as verifying inline (1.1 ms against 0.9 for
ML-DSA-44, 0.8 against 0.7 for secp256k1), so the pool only pays when it is given batches;
that fact shaped the application change in section 6. Signing and sizes are not close:
secp256k1 signs more than eight times faster and makes a key pair three times faster, and
its keys and signatures are about a fortieth the size, which takes a transfer from 2.5 KB to
154 bytes and a validator's share of a commit from 2.4 KB to 66 bytes. Hashing is three
orders of magnitude cheaper than any signature operation and never appears in a profile.

### 4.2 codec

| benchmark | ops/s |
|---|---:|
| encodeTransaction | 928,000 |
| decodeTransaction | 2,730,000 |
| txHash | 788,000 |
| txsRoot over 500 transactions | 651 (1.5 ms) |

A signed transfer is 2,510 bytes under ML-DSA-44: a 41-byte operation, 48 bytes of framing and
signer address, and a 2,421-byte signature, tag included; under secp256k1 the signature is 65
bytes and the transfer 154. The suite's estimate of how many fit a 4 MiB block, 1,668, subtracts
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
| get by id | 13,800,000 | 72 ns |
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
1,000 in 19, 10,000 in 155. A lookup by id is two map lookups, the type and then the instance in
the cache of decoded objects (42 ns when the primary index was an array of objects, 72 ns since
the arena of section 4.10); a lookup by index walks a B+ tree, whose depth grows with the log of
the state, and at the sizes measured neither showed it. The sparse Merkle tree for names costs
about 30 µs per insert, five times a dense leaf, which is why only unique indices that need proofs are authenticated. The last line is the
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
| commit to memory (after a 500-transfer block) | 260 to 320 | 3.1 to 3.9 ms |
| commit to LMDB (after a 500-transfer block) | 104 | 9.6 ms |

Genesis with 1,001 accounts parses, applies and roots in 79 ms.

Analysis. A warm block, whose signatures the mempool already verified, runs at 26,000 transfers a
second: evaluation, the per-transaction key resolution and authority check, the history
records and the root together cost under 40 µs per transfer. A cold block, where every
signature must be verified, runs at the pool's speed, 6,300 a second. The difference is the
whole cost of signatures and the reason the mempool verifies at admission: a validator that saw
the transactions through gossip spends 57 ms on 1,500 transfers (about 3.6 MiB with a block
shell; the benchmark hands the transactions straight to the application, without building a
block), one that did not spends 240 ms. Commit to LMDB is 9.6 ms, one write transaction for the
application's store. It was 8.8 ms before the secondary index entries and the Merkle trees'
chunks and nodes were written in that transaction with the objects (sections 4.11 and 4.12): a
500-transfer block writes about a thousand entries (each transfer leaves a recent transaction
id, which has two indices; the balances change no key), about 0.7 ms, 7%, and at 1,001 accounts
its chunks cost nothing measurable. Commit to memory carries the same bookkeeping, 2.6 ms
before and 3.1 to 3.9 since.

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
at rest. The suite ran under ML-DSA-44; under secp256k1 the same 387,000 keys would be 13 MiB,
the objects, indices and trees around them would cost the same, and the genesis file itself
shrinks with the keys. Lookups are the same speed as with a thousand accounts; proofs grow by one sibling per
doubling (22 siblings here against 21 for 100,000 balances). Parsing runs at 157 MiB/s, about
the speed of the hashing of the keys it yields. Building is apply (decode, index, tree leaves),
root (hash every object, build the trees, build the name tree) and a single LMDB transaction
of 614 MiB. The restart costs more than the build because the store is read object by object
and the name tree is built twice: once live while importing, once in `rebuildIndexVersions` to
recover past-version proofs. The second build is the one obvious saving left on this path.
Since this run the restart path has changed (section 4.12): the trees come back from their
stored chunks and nodes and the indices from their stored entries, so the live build of the
name tree and the hashing of every object are gone from it, and what remains is the import,
a check of every object against its leaf; the name tree's past versions, which were rebuilt by
replaying every account, now come from the store's history records. The ML-DSA-44 gigabyte was
not rerun; the 192,000-account secp256k1 run went from 8.4 s to 5.2 and then to 2.9.

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
| account history, newest 20 entries | 991,000 per second keyed by account; 1,023,000 from the log, in a later run of the suite |
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

### 4.9 secp256k1

Everything above ran on ML-DSA-44. `CHAIN_SCHEME=secp256k1 npm run bench` runs the same suites
on secp256k1, and `CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 npm run bench:genesis` builds a
genesis of 191,896 accounts with two keys each, the account count of the gigabyte in section 4.7,
which takes 56 MB of JSON when a key is 68 hex characters instead of 2,626. Same machine, same
method; the crypto rows are in section 4.1. What changed:

| benchmark | ML-DSA-44 | secp256k1 |
|---|---:|---:|
| signed transfer | 2,510 B | 154 B |
| transfers per 4 MiB block, estimate | 1,668 | 26,533 |
| checkTx on the worker pool, 32 in flight | 6,677/s | 9,216/s |
| finalizeBlock 500 transfers, cold, worker pool | 6,292/s | 7,065/s |
| finalizeBlock 500 transfers, warm | 27,400/s | 28,321/s |
| saveBlock, 500 transfers with results and index | 8.2 ms (1.2 MiB) | 5.7 ms (75 KiB) |
| network: 6,000 transfers submitted to one node | 5.4 s, 1,116 tx/s, blocks full at 1,664 | 3.7 s, 1,618 tx/s, blocks of 1,000 |
| block sync of those blocks | 4,629 tx/s | 6,182 tx/s |
| genesis of 192,000 accounts: parse | 6.4 s at 157 MiB/s | 2.3 s at 25 MiB/s |
| genesis: build (apply, root, persist) | 8.0 s | 5.7 s (7.8 s since the index entries, chunks and nodes are written with it; section 4.12) |
| memory after building: heap + array buffers | 584 + 536 MiB | 597 + 41 MiB |
| peak resident set during the build | 3.7 GB | 1.7 GB |
| LMDB on disk, then with a snapshot | 614 MiB, 1,120 MiB | 34.6 MiB, 68.3 MiB (the state 213 MiB since; 4.12) |
| restart from LMDB | 11.8 s | 8.7 s (5.2 s from the stored trees; 4.12) |
| RPC account by name with a proof, 16 clients | 6,467 calls/s | 8,155 calls/s |
| broadcastTx of 2,000 transfers, 16 clients | 2,456 tx/s | 3,130 tx/s |
| scattered batch transfers applied | 18,700/s | 18,360/s |
| state sync pipeline, local | 201 chunks (504 MiB), 36.6 s | 199 chunks (31.7 MiB), 13.9 s |

Analysis. Verification is the one cost that barely moves (section 4.1), so the rates that are
bound by it, admission and a cold block, gain a third at most; a warm block, bound by evaluation
and the root, does not move at all. Everything that is bound by bytes moves by the ratio of the
sizes: a transfer is sixteen times smaller, sixteen times more fit a block, the chain store
writes a sixteenth, and the state on disk is an eighteenth. The network figure is not a
block-space figure under secp256k1: six thousand transfers went into six blocks of a thousand
because the proposer reaps a thousand at a time, not because the blocks were full, so the rate
there is the commit cadence, not the limit. The one number that does not shrink is the heap:
597 MiB for the same accounts against 584 MiB, because the keys never lived in the heap (they
are array buffers, 536 MiB against 41) and what the heap holds is the object database itself,
the account, balance and authority objects, the index entries, the tree chunks and the name
tree. That is about 3.2 KB per account under either scheme, and it is the floor the next
section sizes from; section 4.10 measures how it divides. Three secp256k1 rows carry a second
figure: the build, the store and the restart moved when the index entries and the trees' chunks
and nodes began to be written with the objects (sections 4.11 and 4.12), the store sixfold, the
build a third slower and the restart two fifths shorter. The ML-DSA-44 column was not rerun;
the entries, chunks and nodes hold ids, names and hashes, not keys, so the same additions are
expected there.

### 4.10 The arena

Phase one of [STATE-PAGING.md](../STATE-PAGING.md) keeps every object of the database as its
encoded bytes in an arena of slabs, with a bounded cache of decoded objects over it
([DESIGN.md](../DESIGN.md) section 6). The genesis run of section 4.9 (191,896 accounts with two
keys each under secp256k1, 56 MB) before the arena, with the cache unbounded (the default), and
with it capped at 100,000 objects (what the memory guard sets at `warn`):

| | before | resident (cache unbounded) | capped at 100,000 objects |
|---|---:|---:|---:|
| heap after building | 597 MiB | 607 MiB | 583 MiB |
| heap after a restart | 601 MiB | 585 MiB | 489 MiB |
| array buffers (keys, and now the arena) | 41 MiB | 79 MiB | 79 MiB |
| build (apply, root, persist) | 5.7 s | 5.9 s | 5.9 s |
| block of 500 transfers among random accounts | 21.5 ms | 24.8 ms | 41 ms |
| restart from LMDB | 8.7 s | 8.5 s | 8.5 s |

On the small-scale suites under ML-DSA-44 a warm block of 500 transfers went from 27,400 to
25,000 transfers a second, a cold one from 6,290 to 6,040, admission from 6,680 to 6,420, and
`get by id` from 42 to 72 ns (a map lookup instead of an array index).

Analysis. Resident, the arena costs about 6% more memory (the encoded copy beside the decoded
one) and 5 to 15% of speed, while capped it saves 17% of the heap with an empty cache at the price
of a block of random transfers taking twice as long, which is the degraded mode the memory guard
turns on rather than a mode to run in. By itself it does not move memory much, because decoded
objects were only about a sixth of the heap, 0.55 KB of the 3.2 KB per account, and the rest is
the secondary indices, the name tree and the Merkle trees, which is what the next two sections
put on disk.

### 4.11 The index tier

Phases two and three of [STATE-PAGING.md](../STATE-PAGING.md) (section 4 there): every
secondary index entry is one LMDB key in the application store, written in the same transaction
as the objects of the version that changed it, and the B+ trees become accelerators the memory
guard can drop, lookups and scans falling through to the store merged with the writes since the
last root ([DESIGN.md](../DESIGN.md) section 6). Measured against the phase-one code on the same
machine, alternating the two (single runs vary by about 5%, so most rows give the range of
several); the genesis rows at 191,896 accounts under secp256k1 (56 MB):

| | before | after |
|---|---:|---:|
| commit to LMDB (after a 500-transfer block) | 8.65 to 9.21 ms, mean 8.95 | 8.86 to 10.0 ms, mean 9.63 |
| commit to memory (after a 500-transfer block) | 2.55 to 2.88 ms | 3.13 to 3.87 ms |
| modify 1,000 balances + root (db suite, no store) | 19.3 to 19.6 ms | 19.7 to 19.8 ms |
| first root over 100,000 objects (db suite, no store) | 323 to 326 ms | 347 to 354 ms |
| genesis: build (apply, root, persist) | 5.96 s | 6.67 to 6.73 s |
| of which root / persist | 1,569 / 406 ms | 1,809 to 1,903 / 946 to 959 ms |
| LMDB on disk after genesis | 34.6 MiB | 92.7 MiB |
| block of 500 transfers at that size: commit to LMDB | 10.6 ms | 11.8 to 12.2 ms |
| restart from LMDB | 8.92 s | 8.43 to 8.49 s |
| of which import / indices and root | 3,899 / 1,119 ms | 281 to 298 / 4,462 to 4,508 ms |
| heap after a restart | 585 MiB | 572 MiB (array buffers 79 to 90 MiB) |

The fallback, from the db suite at 100,000 balances and 24,000 or more accounts (the suite then
ran its account-creation row as many times as its time budget allowed, at least four; it now runs
it a fixed six times, prints the state, 26,000 accounts, and the rows that follow run on that;
per 1,000 lookups and per 100 scanned entries, the same runs):

| | resident | dropped, in-memory store | dropped, LMDB |
|---|---:|---:|---:|
| lookup by unique index (byOwnerAsset), 1,000 | 1.04 to 1.34 ms | 1.18 to 1.46 ms | 1.02 to 1.20 ms |
| scan 100 entries of a non-unique index (byAsset) | 9 to 13 µs | 24 to 28 µs | 50 to 57 µs |
| modify 1,000 balances + root | 19.7 to 20.8 ms | 22.1 to 23.0 ms | |
| rebuild every index tree | | 130 to 138 ms | 182 to 212 ms |

Analysis. A 500-transfer block writes about a thousand entries (each transfer leaves a recent
transaction id, which has two indices; the balances change no key), so its commit costs about
0.7 ms more, 7%. The genesis writes 576,000 entries (a name, an owner-asset key and an asset
key per account): a third of a second to list them at the first root, half a second to write
them, and 58 MiB of LMDB, about 100 bytes an entry with LMDB's page overhead; peak RSS during
the build rose with them (1.69 to 2.18 GiB), the heap after building did not (607 MiB). A
restart now builds the indices from the stored entries, in key order and with no object
decoded, which took the import from 3.9 s to 0.3 s and moved the work into the indices-and-root
phase; it is as fast, within a few percent, as decoding every object for its keys was (the old
path, kept for a store that predates the entries, took 8.49 s against 8.43 in the same run),
because both are dominated by hashing the name tree, which section 4.12 removes. A lookup
through LMDB costs about what a resident one does, since both are dominated by building the key
and fetching the object (the resident row varies more between runs than the difference); a scan
costs four to six times as much, the price of copying every key and value out of LMDB and
merging two cursors, still under a microsecond an entry. At genesis scale, `account by name`
over 192,000 accounts measured 1.78 ms per 1,000 resident against 1.81 in a direct comparison of
the two builds (15 rounds each, medians), about 2%. The db suite's rows carry no store, so they
show only the bookkeeping, the keys kept per dirty object.

### 4.12 The trees tier

Phase four of [STATE-PAGING.md](../STATE-PAGING.md) (section 5 there): the dense trees' changed
chunks and the sparse trees' changed nodes are written at every root, the live trees become
accelerators the guard drops after the index trees, a root over dropped trees reads each changed
leaf's path through a bounded chunk cache and writes the changed chunks back, and a restart
takes the trees from the store, hashing every object against its leaf. Measured against the
phase-three code on the same machine; the genesis rows at 191,896 accounts under secp256k1
(56 MB), single runs:

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
| commit to LMDB (after a 500-transfer block), 1,001 accounts | 9.72 ms | 9.48 to 9.96 ms |
| first root over 100,000 objects (db suite, no store) | 358 ms | 347 to 356 ms |
| modify 1,000 balances + root (no store) | 19.3 to 20.5 ms | 19.8 to 20.4 ms |
| modify 10,000 balances + root (no store) | 159 to 162 ms | 161 to 167 ms |

The three ways to reopen the same store, in one run: the trees from their chunks and nodes
with every object hashed against its leaf (the default) 5.18 s, the same without the leaf
check 4.56 s, the trees computed from the objects 8.46 s.

Since then a restart checks the stored trees and index entries in full (STATE-PAGING.md 5.3:
every dense node against its children, every sparse node against its parent's hash, every
non-empty leaf against an object, every index entry against the objects). The same three
reopens, before and after in one session: 5.08 to 6.48 s (indices, trees and root 1,351 to
2,597 ms), 4.46 to 5.05 s (732 to 1,195 ms; the index entry check still runs) and 8.22 to
8.90 s. The index entry check, which decodes every object once, is about 0.46 s of that and
the tree check about 0.78 s.

And since then the sparse trees' past versions come from the history records (STATE-PAGING.md
section 7.3): each record holds the nodes its version overwrote, and a restart builds every
older version of a tree from the next newer one and the record between them, sharing what the
block left alone, instead of inserting every account into a fresh tree and replaying the
window. At height 1 that phase went from 3.5 s to 2 ms, and the same three reopens from 6.48,
5.05 and 8.90 s to 2.84, 1.46 and 5.41 s; the node's restart is 2.91 s (read 0.31 s, indices,
trees and root with every check 2.59 s, history 2 ms), on a heap of 381 MiB afterwards where
the replay left 572. What a restart costs now is the checks: without the leaf check it is
1.46 s.

Dropped trees, from the db suite (100,000 balances and 24,000 or more accounts, as above, the trees over LMDB;
means, and medians where a first cold iteration pulls the mean):

| | resident | dropped |
|---|---:|---:|
| modify 1,000 balances + root | 20.2 ms | 53.7 ms (median 23.8) |
| modify 10,000 balances + root | 170 ms | 207 ms (median 179) |
| object proof, current version, per 100 | 1.13 ms | 1.35 ms |
| object proof, past version, per 100 | 1.14 ms | 1.35 ms |
| name proof (sparse tree), per 100 | 428 µs | 1.87 ms |
| drop / rebuild every tree | | 0.3 / 180 ms |

Analysis. The genesis writes about 600,000 sparse nodes (the name tree of 192,000 leaves and
their inner nodes) and 25 MiB of chunks: 120 MiB more of LMDB, 0.7 s more to write and a
quarter of a second more to list at the first root, which, with the entries of section 4.11, is
where the build's 5.9 s of section 4.10 became 7.8. A block's commit costs what its chunks
cost: a chunk holds 1,024 hashes, so a block whose leaves are spread over the whole state
rewrites nearly every chunk of the trees it touches, 6.1 MiB per root for a thousand random
balances among 100,000 and the same for ten thousand, about 12 MiB at 192,000 accounts, where
the commit of a scattered block grows by a fifth (9 ms); a block whose writes are local (the
genesis suite's transfers among consecutive accounts) costs nothing measurable, nor does the
1,001-account application suite. Smaller chunks on disk would cut the scattered case about in
half at this size. The restart is the gain: the trees come back from their chunks and nodes, so
the first root hashes no object and inserts no key into a sparse tree, and 8.4 s became 5.2, of
which the leaf check (every object hashed and compared with its leaf, so that a corrupt object
store still fails at startup) is about an eighth; what was left was mostly the history, 3.5 s at
height 1 to rebuild the sparse trees' past versions by replaying every account, which the
history records now hold in a form to load (above: 2.9 s in all). A root over dropped trees costs about what a resident one does
once the upper levels are cached (215 chunks after these runs, of the 256 the cache then held); the first one
after a drop reads every chunk it touches from LMDB, which is the cold iteration behind the
53.7 ms mean. Object proofs cost about the same dropped as resident, being dominated by building
the proof rather than reading twenty hashes; a name proof reads about twenty nodes from LMDB and
costs four times as much. Rebuilding reads 400 chunks and the name tree's 42,000 nodes, and
every retained version of the name tree from the records. The state-sync rows moved both ways:
writing the imported state now writes its entries, chunks and nodes too (1.09 to 1.84 s), and
opening it takes the trees from them (5.72 to 1.59 s).

### 4.13 paging

`CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 npm run bench -- paging` builds the 191,896-account
state of section 4.9 and runs it through the memory guard's modes (STATE-PAGING.md section 7.1).
First a node, in a child process started with `--max-old-space-size=744`, 1.25 times the heap of
the resident state (595 MiB): a single validator over the store, its mempool kept two blocks
ahead with transfers among random accounts, for 40 seconds (`BENCH_PAGING_HEAP` sets another
limit in MiB, `BENCH_PAGING_SECONDS` another length, `BENCH_PAGING_ARENA` a budget for the arena
in MiB, `BENCH_PAGING_MEMORY_VERSIONS` how many past versions the node keeps in memory, as
`retain.memoryVersions` does, `BENCH_PAGING_INDEX_TREES=memory` or `=store` where the node's
index trees are, as `indexTrees` in its config does (unset, the node's default, `store`),
`BENCH_PAGING_READS` how many index
reads of each kind a second are made beside the load, `BENCH_PAGING_BEFORE_NODE` a shell
command run between building the store and the node opening it, which is how the volume the
store is on (`TMPDIR` chooses it) is remounted so that none of the store is in the page cache,
and `BENCH_PAGING_PROFILE` a directory
for CPU profiles of the run's first and last thirty seconds). The runs of this section were
made with `indexTrees: 'memory'`, which was the default when they were made, except those
marked `store`: where the text says the node drops or rebuilds its index trees, that is a
node with `memory`. By default a node now never builds them (below).

| seconds | what happened |
|---|---|
| 0 | store opened in 3.5 s (the trees from their chunks, the index entries checked against the objects), 379 MiB of heap in use; 1,500 and then 1,800 transfers a second as the pending session and the history window fill the heap, 445 and then 502 MiB |
| about 5 | `warn` at 539 of 744 MiB: the index trees dropped, the history window cut to two versions, the cache capped, the mempool admitting up to half its limit; next sample 308 MiB, `ok` |
| 5 to 40 | `ok` throughout, 311 to 501 MiB, 1,520 to 2,010 transfers a second in each window of two seconds, the Merkle trees resident; the index trees stay dropped, 161 to 183 MiB needed for them and no room within half the limit (372 MiB) |

In all: 124 blocks and 69,492 transfers in 40.6 s (1,712 a second), no block committed with the
Merkle trees dropped, one visit to `warn`, none to `pressure`, and no abort.
The 508 submissions refused were all in the first two seconds, before the first block; none was
refused afterwards. Rates are by the time each window and the run actually took, and the heap
is the old generation's use, which is what the guard's levels are taken from (below). The node
is the one `start` runs: it opens the state as its own application, and a block's writes and
the application's are one store transaction. After the run,
with the window in memory two versions wide, a proof of an account takes 0.04 ms at the newest
height, 9.2 ms fifty heights back and 19 ms at the oldest provable height, a hundred back: the
older two are read from the history records in the store (below).

While the index trees and the history window went only at `pressure`, the same run sat at
`warn` from 6.8 s and reached `pressure` at 14.0 s (637 MiB), where both tree tiers were
dropped and the window cut, and the next sample read 45 MiB; the index trees were rebuilt at
17.6 s and the Merkle trees stayed dropped for want of room. It committed 112 blocks and 61,364
transfers (1,508 a second), 80 of the blocks with the Merkle trees dropped. Shedding the index
trees and the window at `warn` keeps the node from `pressure` under this limit, so the Merkle
trees stay resident, and with the account history stored as a log (below) the run commits 13%
more transfers.

Before the history window was trimmed and the mempool's limit followed the level, the same run
went to `pressure` twice and then alternated between `warn` and `pressure` for its last ten
seconds with the mempool paused and resumed, for 107 blocks and 59,128 transfers: the window
(100 versions of overwritten tree nodes and object bytes) was what kept the heap at its limit
once the trees were gone, and trimming it is what took the heap from 640 to 50 MiB in one
sample.

The same node run over three states and five heap limits, each limit a multiple of the state's
resident heap, secp256k1 throughout, forty seconds each:

| genesis | accounts | resident heap | heap limit (factor) | opened | heap after opening | blocks in 40 s | transfers/s | blocks with the Merkle trees dropped | refused | levels reached |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|
| 10 MB | 34,267 | 123 MiB | 98 MiB (0.8) | paged | 39 MiB | 115 | 1,499 | 115 | 508 | `warn` four times, `pressure` three times |
| | | | 122 MiB (1.0) | paged | 46 MiB | 121 | 1,497 | 121 | 508 | `warn` three times, `pressure` once |
| | | | 153 MiB (1.25) | resident | 88 MiB | 122 | 1,530 | 80 | 508 | `warn` three times, `pressure` once |
| | | | 183 MiB (1.5) | resident | 88 MiB | 122 | 1,476 | 0 | 508 | `warn` twice |
| | | | 244 MiB (2.0) | resident | 88 MiB | 139 | 1,711 | 0 | 508 | `warn` once |
| 56 MB | 191,896 | 596 MiB | 476 MiB (0.8) | paged | 211 MiB | 129 | 1,757 | 129 | 508 | `warn` once |
| | | | 595 MiB (1.0) | paged | 155 MiB | 127 | 1,653 | 127 | 508 | `warn` once |
| | | | 744 MiB (1.25) | resident | 379 MiB | 132 | 1,800 | 0 | 508 | `warn` once |
| | | | 893 MiB (1.5) | resident | 409 MiB | 131 | 1,801 | 0 | 508 | `warn` once |
| | | | 1,190 MiB (2.0) | resident | 398 MiB | 127 | 1,664 | 0 | 508 | `warn` once |
| 150 MB | 514,008 | 1,563 MiB | 1,250 MiB (0.8) | paged | 390 MiB | 106 | 1,386 | 106 | 508 | `warn` once |
| | | | 1,563 MiB (1.0) | paged | 390 MiB | 102 | 1,359 | 102 | 508 | `warn` once |
| | | | 1,953 MiB (1.25) | resident | 991 MiB | 117 | 1,639 | 0 | 508 | `warn` once |
| | | | 2,345 MiB (1.5) | resident | 1,035 MiB | 114 | 1,576 | 0 | 508 | `warn` once |
| | | | 3,126 MiB (2.0) | resident | 1,035 MiB | 112 | 1,450 | 0 | 508 | none |

"Paged" is a store opened with its Merkle trees and its history window left on disk, because
they would not have fitted under the `warn` line (below, and STATE-PAGING.md section 9.1); 508
refused is the feeder's first two seconds, before the first block, and every run refused
nothing after them. Every run committed blocks for the whole forty seconds, none
died, and none reached `critical`. The heap
is the old generation's use. Rates differ by up to a tenth between two runs of one row. Four
rows were run a second time: the 744 MiB row read 1,620 where the table reads 1,800 (the
published run above is the same configuration and read 1,712), the 1,190 MiB row 1,589 against
1,664, the 98 MiB row 1,403 against 1,499 with the same levels reached, and the 192,000-account
state opened with nothing under 149 MiB (the table of small heaps below) 1,179 against 1,193,
with one visit to `pressure` where the first run had none. So only differences larger than a
tenth are read here. Three things read off it.

The heap limit does not matter at 192,000 accounts. The node commits 1,650 to 1,800 transfers
a second at every limit from 0.8 to 2.0 times its resident heap, which is the spread between
runs. While the index trees and the window went only at `pressure`, less heap was faster: the
same rows read 1,520 to 1,560 at 0.8 to 1.25 times, where the node ran with its index trees
dropped and two versions of history in memory, and 1,250 to 1,350 at 1.5 and 2.0 times, where
it reached `pressure` late or not at all and kept both. Of the two it was the index trees that
cost the rate, not the window: resident index trees cost a load of transfers about a tenth
(the ten-minute run at 2.5 times, below), and the window in memory, measured directly, costs it
nothing (the `retain.memoryVersions` table, below). Those nodes now reach `warn` once and run
on with the index trees in the store and two versions in memory like the others, and every row
of this state is 100 to 450 transfers a second above what it was, the
two changes together: paging at `warn`, and the account history stored as a log, which
shortened every commit (below). The one row of the table that never reaches `warn`, 514,000
accounts at 2.0 times, keeps the whole window and reads 1,450 against 1,576 and 1,639 for the
two resident rows of its state that trimmed it. That is the spread between runs and not the
window: the same node run four more times, twice with the whole window and twice with two
versions, committed 1,255 to 1,369 transfers a second with the two settings interleaved
(below). The same matrix before the history trim, the mempool limit and paged
opening ran from 1,145 at 0.8 times to 1,544 at 2.0.

The largest state opened paged commits less than it does resident. At 0.8 and 1.0 times its
resident heap it opens with the Merkle trees in the store and never has the room to rebuild
them, and it commits 1,360 to 1,390 transfers a second there against 1,450 to 1,640 resident,
4 to 17% less. It was a quarter less (1,070 to 1,110 against 1,410) while the dropped
trees' cache held 256 chunks of the 1,100 its trees have and every root read the rest from
LMDB, and with the cache holding them all the previous round read no difference (1,040 to 1,280
against 1,150 to 1,320). The difference this round is of the size the mode table below gives
for a root over dropped trees (10.3 blocks a second against 12.1 with only the index trees
dropped), and it is larger than the spread between runs only against the two resident rows
that paged at `warn`. At 192,000 accounts the two paged rows (1,757 and 1,653) are inside the resident rows' spread.
Opening takes two thirds of the resident heap when the store is opened resident (379 of
596 MiB, 991 of 1,563) and a quarter to a third paged (155 and 211 MiB, 390 MiB).

The smallest state is the one that still reaches `pressure`. Against 123 MiB of resident state
the load's own growth (the pending session, the history window, the recent transaction ids) is
several times the state, so what `warn` sheds is not enough at the three lowest limits: they
go to `pressure` one to three times, where the Merkle trees are dropped as well, and at 1.5 and
2.0 times `warn` alone holds the heap. The rates are 1,480 to 1,530 at 0.8 to 1.5 times and
1,711 at 2.0, and the node at 0.8 times its resident heap, which committed 1,149 transfers a
second in the previous round and refused 236 of 48,200 after its first two seconds, commits
1,499 and refuses none. With the guard reading the young generation's garbage as use every
limit up to 1.5 times the resident figure reached `critical`, where `start` stops the node, and
at 0.8 times it refused 43% of what it was sent; reading the old generation alone, no limit
reaches `critical`.

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

The second is the two constrained limits run again, first with the window trimmed and the
mempool's limit following the level, then with the mempool's cache of seen transactions fixed as
well, then with the guard reading the old generation, a tier rebuilt only within half the limit
and one store transaction a block, then with the index trees dropped and the window trimmed at
`warn` and the account history stored as a log, its heads written every 64 blocks and a tier
rebuilt ten samples after a drop, and last, at the resident figure, as the node now stands:
the heads written a slice a block, and nothing rebuilt until the heap has stayed at `ok` as
long as the node had run before the drop (all below). The largest limit of the first table was
run again with the last two builds and is the last two rows; the limit of 0.8 times was not
run again with the last. The heap is the whole heap's use in the first two rows of each limit
and the old generation's in the others:

| heap limit | node | transfers/s over 10 min | refused | blocks with Merkle trees dropped | visits to `pressure` | heap between | longest GC pause |
|---|---|---:|---:|---:|---:|---:|---:|
| 595 MiB (1.0×) | history trim, mempool limit | 1,088 | 0.08% (508 of 655,400) | 1,475 of 1,491 | 7 | 58 and 484 MiB | 105 ms |
| | and the seen cache fixed | 1,321 | 0.06% (508 of 795,200) | 1,663 of 1,663 | 5 | 133 and 455 MiB | 83 ms |
| | old-generation guard, one transaction a block | 1,322 | 0.06% (508 of 795,800) | 1,644 of 1,644 | 2 | 117 and 492 MiB | 222 ms |
| | paging at `warn`, the history log, heads every 64 blocks, rebuilt after ten samples | 1,574 | 0.05% (508 of 946,600) | 1,820 of 1,820 | 0 (6 to `warn`) | 115 and 428 MiB | 132 ms |
| | as it now stands: heads a slice a block, the wait before a rebuild | 1,619 | 0.05% (508 of 974,200) | 1,865 of 1,865 | 0 (5 to `warn`) | 115 and 437 MiB | 97 ms |
| 476 MiB (0.8×) | history trim, mempool limit | 1,137 | 0.07% (507 of 683,800) | 1,424 of 1,424 | 5 | 78 and 366 MiB | 67 ms |
| | and the seen cache fixed | 1,290 | 0.07% (508 of 776,200) | 1,623 of 1,623 | 4 | 62 and 393 MiB | 63 ms |
| | old-generation guard, one transaction a block | 1,355 | 0.06% (508 of 815,600) | 1,755 of 1,755 | 2 | 124 and 397 MiB | 84 ms |
| | paging at `warn`, the history log, heads every 64 blocks, rebuilt after ten samples | 1,524 | 0.06% (508 of 916,800) | 1,745 of 1,745 | 0 (8 to `warn`) | 92 and 337 MiB | 97 ms |
| | as it now stands: heads a slice a block, the wait before a rebuild | 1,608 | 0.05% (508 of 967,400) | 1,861 of 1,861 | 0 (8 to `warn`) | 92 and 356 MiB | 122 ms |
| 1,488 MiB (2.5×) | paging at `warn`, the history log, heads every 64 blocks, rebuilt after ten samples | 1,528 | 0.06% (508 of 919,400) | 0 of 1,874 | 0 (3 to `warn`) | 312 and 1,049 MiB | 139 ms |
| | as it now stands: heads a slice a block, the wait before a rebuild | 1,485 | 0.06% (508 of 893,400) | 0 of 1,780 | 0 (2 to `warn`) | 327 and 1,045 MiB | 132 ms |

No run died, before or after. Before, sustained throughput converged on about 900 transfers a
second whatever the heap, and what the heap decided was how much load was refused to hold it
there: a fifth at the resident figure, nearly half at 0.8 times it, in bursts of 20,000 to
46,000 transfers each time the mempool was paused. Now nothing is refused after the first two
seconds at any of the three limits (the refusals counted are the feeder's first submissions,
before the first block), the node spends the run at `ok` with two to eight visits to `warn`
of half a second each and none to `pressure`, and it commits 72% more at the resident figure,
97% more at 0.8 times it and 41% more at 2.5 times it than it did in the first table. The three
limits read 1,619, 1,608 and 1,485 in their last rows, and the last two builds differ at each
limit (1,574 and 1,619, 1,524 and 1,608, 1,528 and 1,485) by less than two runs of
one row do: over ten minutes, as over forty seconds, the heap limit
decides what is resident and not what is committed. Five things did that, three of them in the
table's earlier rows. The history window, trimmed to two versions (at `pressure` in those
rows, at `warn` now), was most of what the heap held once the trees were dropped, so one visit
frees several hundred MiB instead of a few tens. The mempool, admitting up to a share of its
limit that follows the level instead of nothing, keeps taking transactions at the rate blocks
remove them, so there is no backlog to refuse when admission begins again. The third was not
about memory at all, and is next. The fourth and the fifth are the rows with paging at `warn`
and the history log, 19% above the rows before them at the resident figure and 12% at 0.8 times it: the index trees
and the window leave at `warn`, within the first minute, instead of at `pressure` minutes into
the run, and the account history is a log; both are below, each after the measurement that
pointed at it.

The runs with the first two still slowed as they went: at the resident figure from 1,570
transfers a second in the first twenty seconds to 740 in the last. A CPU profile of the first
thirty seconds of such a run against one of its last thirty separated the causes:

| | early in the run | late in the run |
|---|---:|---:|
| `Mempool.remember` (ten-minute run, 5 to 35 s against 560 to 590 s) | 0 | 8.3% of the process, 77 µs a transfer |
| the benchmark's own feeder, signing transfers on the node's thread (the same) | 38% | 40% |
| LMDB commits, the application's store and the block store (after the fix below, 5 to 35 s against 140 to 170 s) | 105 µs a transfer | 215 µs |

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
transfers looks up no index, so with the trees in the store it only writes their entries, and
the collector has less heap to work on. The first version of this run after the guard's
measure was corrected (below) made it plain by doing worse: trees that just fitted under the
warn line were rebuilt there ten seconds after every drop, the node spent six of its ten
minutes between `warn` and `pressure`, and it committed 1,150 transfers a second. A tier is
now rebuilt only when it fits within half the limit.

So the index trees and the history window now go at `warn` (`onMemoryLevel` in
src/node/node.ts), and the Merkle trees still at `pressure`. The same run with that, while a
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
every 80 seconds or so and `ok` at about 120 MiB half a second later (that is the build
before the last; the node as it now stands, run again, commits 1,608 over the ten minutes,
every window between 1,534 and 1,693, with the same eight visits to `warn`). The node at 2.5 times
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

The two runs again as the node now stands. At the resident figure the store is opened with the
Merkle trees and the history left in it, the index trees are dropped at the first `warn`, at
13 s, and are never rebuilt (584 MiB needed for everything, and no room for it). The run
commits 1,757 and 1,779 transfers a second in its first forty seconds and 1,530 to 1,710 in
every window of twenty seconds from there to the end, 1,619 over the ten minutes, on a heap of
115 to 437 MiB, with `warn` at 13, 165, 291, 416 and 549 s and `ok` half a second after each.
At 2.5 times the resident heap, per stretch of the run:

| seconds | index trees | what happened | transfers/s |
|---|---|---|---:|
| 0 to 34 | resident, as opened | `warn` at 34 s (1,045 of 1,488 MiB): index trees dropped, window trimmed, `ok` at 327 MiB | 1,605 in the first 20 s |
| 34 to 65 | dropped | the node had run 34 s, so it waits 30 s at `ok` | 1,550 to 1,610 |
| 65 to 211 | rebuilt at 64.6 s, within half the limit; the window stays trimmed (240 MiB needed, no room) | `warn` again at 210.6 s | 1,310 to 1,440 |
| 211 to 600 | dropped | the node had run 146 s since the rebuild and waits as long, to 360 s, then finds no room (565 MiB needed) and stays paged | 1,420 to 1,600, 1,517 on average |

One rebuild, where the rule of ten samples made two, at 36 and 203 s. The run commits 1,485
transfers a second over the ten minutes with two visits to `warn`, and the stretches show what
a rebuild costs under this load: resident index trees take about a tenth off the rate. A
node with `indexTrees: 'memory'` starts with them when they fit, and rebuilds them when the heap has stayed at `ok`
long enough, index reads (accounts by name, scans) being served from memory then. A
proof after the runs takes 0.07, 12 and 22 ms at the newest height, fifty back and a hundred
back at the resident figure, and 0.04, 15 and 32 ms at 2.5 times it.

Whether the index trees are in memory at all is a setting, and the measurements that follow
changed its default. `indexTrees: 'store'` in a node's
config, the default now, makes a node that never builds them: index reads go to LMDB from the start, and the
guard has no index trees to drop or to rebuild. `'memory'`, the default until then, is the
node of the runs above. The same ten minutes at 2.5 times the resident
heap, the mempool kept 1,000 transfers ahead, with each
(`BENCH_PAGING_INDEX_TREES`):

| `indexTrees` | opened with | transfers/s over ten minutes | blocks | heap during the run | visits to `warn` | longest GC pause |
|---|---:|---:|---:|---|---:|---:|
| `memory` (the default at the time) | 398 MiB | 1,485 | 1,780 | 327 to 1,045 MiB | 2 | 132 ms |
| `store` (the default now) | 258 MiB | 1,552 | 1,823 | 316 to 1,045 MiB (444 to 972 at the twenty-second reports) | 1 | 155 ms |

Over the whole run the two are within what two runs differ by (4.5%); the `memory` run's own
stretches show the cost more clearly, 1,310 to 1,440 transfers a second while the index trees
were resident and 1,420 to 1,600 while they were dropped. With `store` the node opens with a
third less heap (258 against 398 MiB), reaches `warn` once, at 40 s, from the history window
and the cache, which are then trimmed and capped, and has nothing to rebuild but the window.
Proofs and the Merkle trees are unaffected.

What `store` gives up is index reads from memory, and that is measured with readers beside the
load. `BENCH_PAGING_READS=200` makes the node read its indices 200 times a second of each
of three kinds while it commits: an account by name, a balance by owner and asset, and a
page of twenty accounts in name order from a random name. The heap is 2,380 MiB, 4.0 times
the resident figure, so that no run reaches `warn` and the node with `memory` keeps its index
trees for the whole of its three minutes; each read is timed on its own, in microseconds:

| `indexTrees` | readers | transfers/s | opened with | account by name: median, 99th percentile | balance: median, 99th percentile | page of twenty: median, 99th percentile, mean |
|---|---|---:|---:|---:|---:|---:|
| `memory` | 200/s | 1,453 | 402 MiB | 5, 21 | 6, 15 | 17, 48, 27 |
| `memory` | 200/s | 1,383 | 402 MiB | 5, 19 | 6, 14 | 17, 45, 27 |
| `memory` | none | 1,350 | 403 MiB | | | |
| `store` | 200/s | 1,539 | 262 MiB | 5, 34 | 5, 15 | 33, 215, 56 |
| `store` | 200/s | 1,466 | 262 MiB | 5, 35 | 5, 19 | 34, 186, 55 |
| `store` | none | 1,503 | 262 MiB | | | |

A lookup by key costs the same either way at the median, 5 or 6 microseconds, and its 99th
percentile is 19 to 21 microseconds from memory against 34 to 35 from the store for a name,
with no difference for a balance. A page of twenty takes twice as long from the store, 33
against 17 microseconds at the median and about 200 against 47 at the 99th percentile. The
longest single read in any run was 11 ms (a page, from the store) and 2 to 3 ms otherwise,
which is a read that waited behind a collection or a commit, not the index. The store here
is in the operating system's page cache, as a node's store is once it has opened it (the
cold-store run below). The readers themselves do not show in the rate:
with and without them the rows of each setting overlap. The setting does: every `store` run
is above every `memory` run, 1,503 against 1,395 on average, 8% more, which agrees with the
stretches of the ten-minute run above. So under this load `store` costs a scan about 17
microseconds a page and a lookup nothing measurable, and gives back a twelfth of the rate
and 140 MiB of heap. That is why `store` is the default, and `memory` the setting for a node
that mostly serves scans.

A cold store. The same readers with `store` and 4.0 times the resident heap, for 30 seconds,
the reads reported every two seconds, on a store none of which was in the page cache: it was
built on a disk image that was detached and attached again just before the node opened it
(`BENCH_PAGING_BEFORE_NODE`, with `TMPDIR` on the image). The node opened in 3,965 ms, against
3,355 to 3,545 ms warm. Microseconds, median and 99th percentile:

| seconds of the run | account by name | balance | page of twenty |
|---|---:|---:|---:|
| 0 to 2 | 5, 78 | 5, 32 | 52, 182 |
| from 4 on | 5, 33 to 39 | 5, 13 to 28 | 41 to 46, 83 to 106 |

The node reads its whole store when it opens, the objects into the arena and the index entries
checked against them, so the open pays for the cold cache, about half a second here, and index
reads after it are warm from the first. Only a store larger than the machine's memory would
send index reads to the device, and that was not measured (the machine has 48 GiB). The page
median is 41 to 52 microseconds on the disk image against 33 on the internal volume: a
different volume, and nothing is read into the difference.

One more run, with `memory`, put the same readers beside the node at its resident figure (595 MiB), where
the Merkle trees and the window are in the store too and the index trees go at the first
`warn`: a name took 5 microseconds at the median and 54 at the 99th percentile, a balance 6
and 27, a page 37 and 1,127 (one page in a hundred waits a millisecond behind the node's own
work), the longest read 19 ms. That run committed 1,303 transfers a second over its three
minutes, 930 to 1,270 in its first hundred seconds and 1,400 to 1,550 after; the ten-minute
run without readers at the same limit commits 1,619, and one run does not say whether the
readers or the run made the difference. Repeated twice
each way, three minutes a run, it was the run: with the readers the node committed 1,633 and
1,644 transfers a second (a name 5 microseconds at the median and 34 to 37 at the 99th
percentile, a page 33 to 47 and 99 to 146), and without them 1,561 and 1,553.

The node as it now opens. With `store` the default, a stored state was at first still opened
against the warn line, 0.7 of the limit, and at the resident figure that went badly: with no
index trees to make room for, the Merkle trees fitted, the node opened with 258 MiB in use and
ran between about 340 and 420 MiB of its 595, 75 MiB under `warn`. Over ten minutes it reached
`warn` 61 times, every ten seconds, never `pressure`, and committed 1,478 transfers a second,
from 1,650 in its first twenty seconds to about 1,400 in its last minute, where the same heap
with `memory` and the Merkle trees left in the store had committed 1,619 with five visits. So
a stored state is now opened against half the limit, the share a rebuild is allowed
(`Node.OPEN_FILL`, 0.5). The node as it now stands, `store` and that rule, 191,896 accounts:

| heap limit | run | opened with | heap after opening | transfers/s | visits to `warn` | longest GC pause |
|---|---:|---|---:|---:|---:|---:|
| 476 MiB (0.8×) | 600 s | Merkle trees and history left in the store | 39 MiB | 1,536 | 8 | 86 ms |
| 595 MiB (1.0×) | 600 s | Merkle trees and history left in the store | 39 MiB | 1,523 | 5 | 117 ms |
| 744 MiB (1.25×) | 120 s | Merkle trees and history left in the store | 39 MiB | 1,605 | 1 | 98 ms |
| 893 MiB (1.5×) | 120 s | Merkle trees and history in memory | 258 MiB | 1,557 | 2 | 72 ms |
| 1,190 MiB (2.0×) | 120 s | Merkle trees and history in memory | 258 MiB | 1,553 | 1 | 95 ms |
| 1,488 MiB (2.5×) | 600 s | Merkle trees and history in memory | 258 MiB | 1,400 | 1 | 443 ms |

No run reached `pressure`, and each refused only the feeder's first 508 transfers. The 0.8×
row was run before the rule changed and is unaffected by it: it opens paged either way. At
the resident figure the visits to `warn` are five again and every window of twenty seconds
is between 1,330 and 1,680 transfers a second with no decline; 1,523 is below the 1,619 and
1,574 of the two `memory` runs at that limit by less than two runs of one row differ. The
2.5× row is the low one: the same setting at the same limit committed 1,552 in the run
further up, and this run fell from 1,590 to about 1,400 over its first four minutes, had one
window at 839 and its longest pause of 443 ms in its last minute, with the heap between 360
and 960 MiB and one visit to `warn`. Nothing in the node differs between the two runs (the
opening rule does not bear on a heap this size), so the two together are the spread of a
ten-minute run with the Merkle trees and a full heap in memory: about a tenth. A third run of
the same row, with a CPU profile of its first and its last thirty seconds
(`BENCH_PAGING_PROFILE`), committed 1,493 with no decline: 1,585 in its first twenty seconds,
then 1,380 to 1,580 in every window to the end, 1,494 in the last, the longest pause 174 ms.
The two profiles are alike. The main thread is busy for all thirty seconds in both, and the
largest differences are the collector, 1.9 seconds of the thirty early and 2.2 late with the
heap grown from about 700 to 980 MiB, and the signature cache, 0.2 and 0.4 seconds once it is
full and every new transaction evicts an old one. Nothing in the node grows slower over ten
minutes at this size; the run at 1,400 was a slow run.

The window in memory, measured directly. `retain.memoryVersions` sets how many of the provable
versions a node keeps in memory, the store answering for the rest. The node that never reaches
`warn`, 514,008 accounts under 3,126 MiB (2.0 times its resident heap), was run for 120 seconds
twice with the whole window of 100 versions and twice with two
(`BENCH_PAGING_MEMORY_VERSIONS=2`):

| window in memory | transfers/s | heap during the run | longest GC pause | proof at the newest height, fifty back, a hundred back |
|---|---:|---|---:|---|
| 100 versions (the default), first run | 1,355 | 964 to 2,111 MiB; reached `warn` once at about 2,190 MiB and was trimmed there | 290 ms | 0.04, 10 and 19 ms (trimmed by then) |
| 100 versions, second run | 1,255 | 1,584 to 2,139 MiB; never reached `warn` | 300 ms | 0.04, 0.12 and 0.02 ms |
| 2 versions, first run | 1,369 | 1,309 to 1,632 MiB | 199 ms | 0.05, 13 and 28 ms |
| 2 versions, second run | 1,241 | 1,207 to 1,607 MiB | 188 ms | 0.04, 12 and 26 ms |

Throughput does not depend on the window: 1,255 to 1,369 transfers a second either way, the
two settings interleaved. An earlier reading of the matrix here, that a node keeping its whole
window commits less because the collector traces several hundred MiB of it, is not supported.
It rested on one row, 1,450 at this size and limit, which was the spread between runs; and
what slowed the 192,000-account node at 1.5 and 2.0 times its resident heap, before `warn`
paged it, was its index trees being resident. What the setting buys is memory and pause
length: about 500 MiB less heap at this size (a peak of 1,630 against 2,140 MiB) and a longest
pause of 190 to 200 ms against 290 to 300 ms. What it costs is the proofs at past heights, 12
to 28 ms from the store instead of under 0.2 ms from memory.

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
section 7.3). Twenty proofs of random accounts after each run, per proof:

| state, heap limit | newest height | fifty heights back | a hundred back (the oldest provable) | window in memory |
|---|---:|---:|---:|---|
| 34,267 accounts, 122 MiB | 0.69 ms | 3.5 ms | 9.0 ms | 2 versions |
| 191,896 accounts, 744 MiB (the published run) | 0.04 ms | 9.2 ms | 19 ms | 2 versions |
| 191,896 accounts, 595 MiB, after ten minutes | 0.07 ms | 8.2 ms | 19 ms | 2 versions |
| 191,896 accounts, 298 MiB, opened paged | 0.07 ms | 3.5 ms | 13 ms | 2 versions |
| 514,008 accounts, 1,953 MiB | 0.04 ms | 11 ms | 22 ms | 2 versions |
| 514,008 accounts, 3,126 MiB (never trimmed) | 0.04 ms | 0.02 ms | 0.13 ms | 100 versions |

A read from the records costs 0.1 to 0.2 ms per version between the height asked about and the
newest, a record of a block of 400 to 550 transfers being some hundreds of kilobytes to walk,
and it holds no memory afterwards; from the window in memory the same proof takes about a tenth
of a millisecond or less at any height. The cost follows the blocks' size, not the state's: the
514,000-account figures are those of the 192,000-account node. Across the matrix the newest
height takes 0.03 to 0.09 ms, fifty back 3 to 12 ms and a hundred back 8 to 24 ms; the three
34,000-account runs that ended with their Merkle trees dropped, the first row among them, take
0.6 to 0.9 ms at the newest height. Before the records were read, the node at the
second row could prove three heights and refused the other ninety-eight.

The same state opened under heaps it used to abort under, below the 400 MiB that opening it
resident takes (STATE-PAGING.md section 9.1): the node estimates each tier from the store's
counters and leaves out what does not fit below the warn line (half the limit now, see the node as it now
opens, above), and the history window with it.

| heap limit | of the resident heap | opened with | heap after opening | run | transfers/s | levels reached |
|---|---:|---|---:|---:|---:|---|
| 298 MiB | 0.5 | index trees; Merkle trees and history left in the store | 155 MiB | 120 s | 1,594 | `warn` four times |
| 208 MiB | 0.35 | index trees; Merkle trees and history left in the store | 153 MiB | 60 s | 1,439 | `warn` three times |
| 149 MiB | 0.25 | nothing; index trees, Merkle trees and history left in the store | 34 MiB | 60 s | 1,193 | `warn` twice |

All three opened in 3.2 to 3.4 seconds and committed for the whole run, every block
with the Merkle trees dropped, and every height of the window stayed provable from the records
throughout (after the runs, 0.06 to 0.07 ms at the newest height, 3.5 to 12 ms fifty back and
11 to 25 ms a hundred back). None reached `pressure`, where each of the three went once in the
previous round, for 1,357, 1,197 and 1,171 transfers a second. A quarter of the resident heap
is enough under this load: the node opens with
every tier in the store on 34 MiB and commits 1,193 transfers a second, where the same run
reached `critical` once while the guard counted the young generation, and two thirds was the
floor before stores were opened paged. The first run at 208 MiB, before any of these figures,
found a fault of its own: opening leaves garbage several times what it keeps, and the guard's
first sample read 211 MiB of 208 and reported `critical` for a node that held 75 MiB. The node
collects once before the guard's first sample.

The arena's budget. The encoded objects are in the arena, outside the heap, where the guard
does not see them; `start --arena <MiB>` bounds it and leaves the rest in the store
(STATE-PAGING.md section 3.4). The same node for three minutes under a heap 2.5 times the
state, so that nothing else pages, with no budget, 32 MiB and 16 MiB, and then at half the
resident heap as well:

| heap limit | arena budget | arena | objects left in the store, start to end | array buffers | transfers/s over 3 min |
|---|---:|---:|---:|---:|---:|
| 1,488 MiB | none | 48 to 64 MiB | 0 | 112 to 147 MiB | 1,511 |
| 1,488 MiB | 32 MiB | 32 MiB | 124,000 to 215,000 | 94 to 116 MiB | 1,520 |
| 1,488 MiB | 16 MiB | 16 MiB | 315,000 to 652,000 | 77 to 99 MiB | 1,500 |
| 298 MiB | 16 MiB | 16 MiB | 316,000 to 371,000 | 65 to 92 MiB | 1,425 |

The arena holds its budget exactly, and what it gives back is what it no longer holds: 48 MiB
fewer array buffers at 16 MiB than with none, by the end of the run, when the unbounded arena
has grown to 64 MiB with the recent transaction ids. Throughput does not notice the budget
under this heap: 1,500 to 1,520 transfers a second in the three runs, inside the spread between
runs (1,341, 1,341 and 1,305 before this round's changes), each with one visit to `warn`. At
16 MiB 315,000 objects are left in the store at the start and 652,000 at the end, the state
having grown by then with the recent transaction ids (the earlier run ended at 384,000), and
they are read from LMDB when they are wanted: the decoded-object cache is in front of the
arena, so an object in use is read once. At 16 MiB 77 to 99 MiB of array buffers remain (the
tree chunks being written, the mempool's transactions, the keys and hashes of the decoded
objects). The process's
resident set does not follow at this size: it moves by several hundred MiB with the collector
and with LMDB's mapped pages, which the operating system counts against the process and gives
back under pressure, so the arena's 50 MiB cannot be read off it. The budget is worth setting
where the encoded state is large against the heap, an ML-DSA-44 state above all, whose keys
are most of it and are all in the arena. The last row is the two together: half the resident
heap and a 16 MiB arena, 1,425 transfers a second for three minutes on 136 to 200 MiB of heap
and 65 to 92 MiB of buffers, with five visits to `warn` and none to `pressure`.

Then the database alone, in the parent process after the node session (so with a full history
window): blocks of 500 random transfers, six per mode, checked through `checkTx` first as
admission does, then finalized and committed to LMDB; the modes added up as the guard's levels
add them:

| mode | blocks/s | transfers/s | finalize | commit | checkTx of 500 | heap after | array buffers |
|---|---:|---:|---:|---:|---:|---:|---:|
| resident | 10.9 | 5,474 | 50.5 ms | 40.9 ms | 56.9 ms | 950 MiB | 116 MiB |
| cache capped at 10,000 | 10.8 | 5,415 | 49.0 ms | 43.3 ms | 51.0 ms | 946 MiB | 116 MiB |
| and index trees dropped | 12.1 | 6,064 | 41.1 ms | 41.3 ms | 55.2 ms | 771 MiB | 102 MiB |
| and Merkle trees dropped | 10.3 | 5,165 | 52.5 ms | 44.3 ms | 49.9 ms | 544 MiB | 86 MiB |
| everything rebuilt (1.12 s) | 10.7 | 5,349 | 49.9 ms | 43.5 ms | 49.1 ms | 955 MiB | 117 MiB |

The commits include the flush to the device. With the account history keyed by account the
same five modes ran at 8.7, 8.8, 10.0, 8.3 and 8.7 blocks a second with commits of 62, 63, 58,
76 and 63 ms: the commit is a third shorter with the log. The rebuild is estimated at 147 MiB
for the index trees and 366 MiB for the Merkle trees.

Analysis. The node is the point of the suite: a heap a quarter larger than its resident state,
a load that brings it to `warn` within five seconds, and a node that kept committing for the
whole run with its index trees and all but two versions of its history in the store. Two runs
before the guard's changes show what they
are for: with the levels' lines taken from V8's `heap_size_limit`, which includes the young
generation's reserve, the same node reached `warn` and died of an out-of-memory error at 19.5 s
without ever shedding, because `pressure` sat past the point of the abort; with the lines fixed
and the trees rebuilt at the first `ok` sample, it changed level 30 times in 40 seconds,
rebuilding each time, and committed 622 transfers a second. With the tiers dropped but the
history window whole (100 versions of overwritten tree nodes and object bytes, each block of
scattered transfers adding tens of thousands of records), the window kept the heap at its limit
and the run ended alternating between `warn` and `pressure`; trimmed, it does not. The same mode suite run on the state
before any node session (no history yet), with the account history still keyed by account, gave 10.6, 10.2, 11.5, 10.7 and 10.3 blocks a second
and 493, 512, 382, 189 and 617 MiB of heap: the index trees give back 130 to 175 MiB and the
Merkle trees 190 to 220 MiB, the cache up to 190 MiB when it holds 200,000 decoded objects
(nothing when it held fewer than its cap), and with everything dropped the database runs on 40
to 50% of its resident heap. Throughput holds within 10% of the resident figure in every mode but one, which is faster
(the index trees dropped, 12.1 against 10.9 blocks a second). With the Merkle trees
dropped it is 10.3 against 10.9 blocks a second in the table above (8.3 against 8.7 and, in
another run, 8.9 against 9.1 before the history log), where it was 7.7 against 9.4 while the dropped trees' cache held 256 chunks: the
trees of this state have about 420, so a root read the rest from LMDB at every block, and at
514,000 accounts, whose trees have 1,100, a block of 500 transfers took 271 ms to finalize
against 60 to 69 with every chunk cached and 45 to 73 resident. The cache now holds 4,096
chunks, 128 MiB at most and outside the heap, so the dense trees of up to two million leaves
are read once after a drop and the cache bounds only larger ones. The index trees dropped cost nothing a block of transfers notices (the
transfers look up no index; a block's finalize even gets faster without the B+ tree updates).

## 5. What bounds what

- **Signatures bound everything that touches a transaction.** 0.7 to 0.9 ms of CPU per
  signature, secp256k1 to ML-DSA-44, verified once per node, at admission or in the block, and reused while its cache entry lasts
  (the cache holds 20,000 transaction bodies; a signer whose key an earlier transaction of the
  same block introduces is verified in the per-transaction pass). A node admits 6,700 transfers
  a second on eleven threads; a network of such nodes commits what its block space allows.
- **Block space bounds the live network.** About 1,660 transfers per 4 MiB block (1,664 with
  four validators' commit in the shell) at about one block a second with these timeouts.
  Signatures are 96% of a transfer's bytes under ML-DSA-44 and 42% under secp256k1.
- **The root bounds nothing yet.** 15 µs per changed object plus hashing; 2,400 scattered
  transfers in 85 ms on a 387,000-leaf tree.
- **Persistence is one flush a block.** A block's chain writes (block, commit, results,
  validator sets, state) and the application's changes are one LMDB transaction when the node
  holds the application, where they were two; a snapshot or pruning adds its own. LMDB's own
  work for the application's part is 9.6 ms after a 500-transfer block at 1,001 accounts and
  15 to 19 ms for one scattered over 192,000 accounts, whose chunks are about 12 MiB (17 to
  26 ms before the account history became a log); the flush to the device comes on top and is
  more than that again (the commit with it took 40 to 120 ms when the ablation was run, and 41
  to 44 ms in the mode table), and varies by tens of milliseconds from one minute to the next
  (section 4.13).
- **Memory is the state plus the history window.** About 1.1 GB per gigabyte of ML-DSA-44
  genesis, half of it the keys themselves (a fortieth of that under secp256k1), plus changed
  objects times retained versions, plus two copies more during a state-sync join. The other
  half is the object database's own objects, indices and trees, the same under both schemes:
  measured per account with its balance and two keys, 6.1 KB under ML-DSA-44 and 3.5 KB under
  secp256k1, with everything resident.
- **Paging bounds memory by the working set, not the state.** Under the memory guard the
  state is a cache over LMDB: the cache of decoded objects capped at `warn` (and the index trees
  dropped there, on a node with `indexTrees: 'memory'`; by default they are never built), the Merkle trees dropped at `pressure`, rebuilt once the heap has stayed at `ok`
  for as long as the node had run before the drop and they fit within half the limit. With everything dropped the database runs on 40 to 50% of its resident heap at
  the throughput it has resident, within a tenth (section 4.13). The history window is trimmed
  at `warn` and the mempool admits up to a share of its limit that follows the level, so a
  node held at or below its resident heap refuses nothing and commits 1,520 to 1,620 transfers
  a second for ten minutes without reaching `pressure`; a store whose tiers do not fit is
  opened with them left on disk, down to a quarter of the resident heap under that load; and a
  height the trimmed window no longer holds is proven from the store's records, in 0.1 to
  0.2 ms per version back instead of a tenth of a millisecond. The arena, outside the heap, has
  its own budget, which throughput did not notice down to 16 MiB, a quarter of what the
  unbounded arena grew to.
- **A loaded node is faster without its index trees in memory, so it sheds early, and by
  default now never builds them.** The runs here kept them in memory (`indexTrees: 'memory'`,
  the default at the time). While the
  index trees and the history window went only at `pressure`, the rate fell by a third over the
  first minutes of a full load, as the heap climbed towards the pressure line, and returned to
  1,330 to 1,560 transfers a second, level, once they were dropped; and at 192,000 accounts the
  node with twice its resident heap committed 1,250 where the one at 0.8 times it committed
  1,520. Both go at `warn` now: the ten-minute run at the resident heap holds 1,530 to 1,780 in
  every window of twenty seconds, and the forty-second rate is 1,650 to 1,800 at every limit
  from 0.8 to 2.0 times the resident heap. Of the two it is the index trees that a load of
  transfers pays for, about a tenth of its rate while they are resident; the window in memory
  costs it nothing measurable (1,255 to 1,369 transfers a second with 100 versions or with two
  at 514,000 accounts), and what trimming it gives back is heap and pause length. The store's
  part was the account history, whose entries, keyed by account, came to dirty a page each:
  the application's commit grew from 17 to 26 ms over 400 blocks with them and grows from 15.1
  to 19.4 ms with the history as a log (section 4.13).
- **Disk is the blocks.** 2.5 KiB per transfer under ML-DSA-44, 154 bytes under secp256k1;
  state is smaller than an ML-DSA-44 genesis and, since its index entries, chunks and nodes are
  stored, about four times a secp256k1 one (213 MiB for a 56 MB genesis; section 4.12); a
  snapshot adds the objects again while kept.

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

A seventh came from profiling the paging node (section 4.13): the mempool shifted an array of
100,000 hashes for every transaction once its cache of seen transactions was full, 8% of a
loaded node's process; as a ring it costs nothing, and the ten-minute rate at the resident
heap went from 1,088 to 1,321 transfers a second.

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
commit after 400 blocks; as a log in block order it is 4.5. And the ten-minute run showed
the node committing a fifth to a third more once its index trees were dropped, which happened
only at `pressure`, minutes into the run; the index trees and the history window now go at
`warn`. With both, the ten-minute rate at the resident heap went from 1,322 to 1,574 transfers
a second, and to 1,619 as the node now stands, with no decline over the run.

## 7. Sizing a node

For a chain with `S` bytes of application state (roughly the genesis size), `B` blocks kept and
`T` transfers a block:

- memory: 1.1 × S of heap and array buffers at rest (the resident set is larger); about 3 × S in
  all while joining by state sync, when the chunks, the rebuilt state and the opened store are
  held together; add the history window (changed objects per block × retained versions × their
  size). S is mostly keys under ML-DSA-44: an account's two keys are 2,626 bytes against 68
  under secp256k1, so the same accounts make a far smaller S there, while the objects, indices
  and trees around the keys cost the same;
- disk: 0.6 × S for the state, 1.2 × S with a snapshot, plus 2.5 KiB × T × B for blocks under
  ML-DSA-44 (154 bytes × T × B under secp256k1); a commit of N validators adds 48 + N bytes plus
  2,421 or 65 per signature to every block;
- CPU: one core verifies 1,100 ML-DSA-44 or 1,400 secp256k1 signatures a second; a validator
  should have enough threads to admit the network's full rate with margin, since a block it did
  not see through gossip costs it the whole verification again.

A node that pages (the memory guard's `warn` and `pressure` levels; [running.md](running.md) section 12)
needs less memory than that, with two provisos. With the cache capped and the index and Merkle
trees dropped the database runs on 40 to 50% of its resident heap (section 4.13), and a store
whose tiers would not fit is opened with them left on disk, so the heap need not hold the
resident state even once: a quarter of the resident heap was enough at 192,000 accounts under a
full load. What the guard pages away besides is the load's growth: the
mempool's pending session, the history window, the recent transaction ids. A state small
against the load (tens of thousands of accounts) is paged the same way: at 34,000 accounts every
limit from 0.8 to twice the resident heap ran without reaching `critical`. Expect a node that
lives paged to commit what a resident one does, within a tenth at 192,000 accounts and up to
17% less at 514,000 in the forty-second runs, with the trees coming back only
when they fit within half the limit, and a proof at a height the trimmed window no longer holds
to take milliseconds instead of a tenth of one. On disk the store grows for it:
every index entry, every dense tree chunk and every sparse tree node is written beside the
objects, 213 MiB against 34.6 for 192,000 secp256k1 accounts, about 1.1 KB an account in all
(sections 4.11 and 4.12), so ten million secp256k1 accounts would be about 12 GB of state
rather than the 1.9 in the table below, and a block scattered over the state rewrites about
12 MiB of chunks per commit. The addition holds ids, names and hashes, not keys, so it should be
the same under ML-DSA-44, which was not re-measured; the table's disk figures predate it.

Per account, from the genesis suite at 192,000 accounts with two keys and one balance each
(sections 4.7 and 4.9), divided through:

| per account | ML-DSA-44 | secp256k1 |
|---|---:|---:|
| the two public keys, tags included | 2,626 B | 68 B |
| LMDB on disk | 3,330 B | 189 B; 1,164 B with the index entries, chunks and nodes (4.12) |
| memory at rest, heap and array buffers | 6,070 B | 3,490 B |
| of which decoded objects (section 4.10) | about 0.55 KB | about 0.55 KB |
| of which indices, name tree and Merkle trees | about 2.65 KB | about 2.65 KB |

A worked example: ten million accounts with two keys each, a hundred validators, one-second
blocks, the default seven-day unbonding period. The figures are a linear extrapolation from a
point fifty times smaller; lookups are hash and tree based, so the shape should hold, but
nothing has been measured at that scale.

| ten million accounts, 100 validators | ML-DSA-44 | secp256k1 |
|---|---:|---:|
| state on disk, then with a snapshot | 33 GB, 67 GB | 1.9 GB, 3.8 GB |
| memory at rest | 61 GB | 35 GB |
| memory while joining by state sync (chunks, rebuilt state, opened store) | about 180 GB | about 40 GB |
| a full commit (100 signatures) | 242 KB | 6.6 KB |
| blocks per day at one a second | 21 GB | 570 MB |
| blocks the evidence window keeps (seven days) | 146 GB | 4 GB |
| restart (read, decode, index, rebuild) | about 10 minutes | about 8 minutes |

With one key per account (the same key as owner and active) take 1,313 or 34 bytes off the disk
figures and a little more off memory; it changes the ML-DSA-44 column by a third and the
secp256k1 column hardly at all. Two conclusions. On disk and in commits secp256k1 removes the
cost of the chain almost entirely: the state of ten million accounts fits a small SSD and the
evidence window a few gigabytes, where ML-DSA-44 needs a hundred and fifty. In memory it does
not: the floor is the object database's own representation, 3.2 KB per account, five sixths of it
indices and trees, so ten million accounts need tens of gigabytes of JavaScript heap under either
scheme to run resident, above Node's default old-space limit (`--max-old-space-size`) and beyond
a laptop; paged, a quarter of that was enough at 192,000 accounts (section 4.13), and the encoded
objects, outside the heap, can be bounded with `--arena`. Signature scheme is the right knob for
disk and bandwidth; for memory at that scale the knobs are the memory guard's dials, the heap
limit a store is opened under, and the arena's budget.

## 8. Further work the numbers point to

1. **Index reads from a store larger than memory.** Resident index trees cost a load of
   transfers about a tenth of its rate (the ten-minute run at 2.5 times the resident heap,
   section 4.13), so `indexTrees: 'store'` is now the default and a node never builds them.
   What that costs index reads (accounts by name, scans) is measured on a node under load,
   with the store in the page cache and with none of it there when the node opened it
   (section 4.13): a lookup by key the same, a page of a scan about twice as long. A store
   larger than the machine's memory, whose index reads would reach the device, is not
   measured.
2. **The checks at a restart.** With the past versions read from the history records a restart
   at 192,000 accounts is 2.9 s, and 1.5 s without the check of every object against its leaf
   (section 4.12): what is left is the checks themselves, which could run after the node has
   started serving, or over a sample.
3. **Smaller chunks.** A chunk of 1,024 hashes makes a block scattered over the state rewrite
   nearly every chunk of the trees it touches, about 12 MiB per root at 192,000 accounts, a fifth
   of the commit (section 4.12); smaller chunks on disk would cut that about in half at this size,
   and the dropped-mode root, which reads and writes whole chunks, with it.
4. **State sync.** Stream chunks into the store instead of holding them all, then rebuild from
   the store; that removes one of the three copies and most of the peak.
5. **Signatures per block.** A per-signature or per-kilobyte transaction fee would price the
   96% of block space that ML-DSA-44 signatures take; FEES.md leaves it open.
6. **Block space.** Larger blocks or a shorter commit timeout raise the network's rate directly
   until admission (6,700/s per node) binds.

## 9. Adding a benchmark

A suite is a module with `export async function run()` that calls `suite(name)` once and then
`bench(...)` and `fact(...)`; register it in the `suites` map in `bench/run.ts`, and add it to
`DEFAULT_SUITES` only if it runs in well under a minute and needs nothing on disk. Use
`bench/fixtures.ts` for accounts and signed transfers, `bench/bigstate.ts` for the large state,
and keep every iteration independent of the previous one (replay protection refuses a
transaction a second time; use `before` to rebuild). Report sizes and memory with `fact`, and
make the benchmark fail loudly on a wrong result: a transfer that fails or a proof that does not
verify is a bug, not a number.
