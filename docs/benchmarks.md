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
a check of every object against its leaf and the rebuild of the name tree's past versions. The
ML-DSA-44 gigabyte was not rerun; the 192,000-account secp256k1 run went from 8.4 to 5.2 s.

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

The fallback, from the db suite at 100,000 balances and 21,000 accounts (per 1,000 lookups and
per 100 scanned entries, the same runs):

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

Dropped trees, from the db suite (100,000 balances and 21,000 accounts, the trees over LMDB;
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
store still fails at startup) is about an eighth; what is left is mostly the history, 3.5 s at
height 1 to rebuild the sparse trees' past versions by replaying every account, which the store
does not hold in a form to load. A root over dropped trees costs about what a resident one does
once the upper levels are cached (215 of the 256 cached chunks after these runs); the first one
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
limit in MiB).

| seconds | what happened |
|---|---|
| 0 | store opened in 1.24 s (the trees from their chunks), 396 MiB of heap; 3,300 to 3,600 transfers per 2 s |
| 4 to 9 | `warn` (the cache capped) as the mempool's pending session and the history window fill the heap |
| 9.2 | `pressure` at 669 MiB: mempool paused, index trees and Merkle trees dropped; next sample 225 MiB, `ok` |
| 13.3 | after ten samples, the index trees rebuilt; the Merkle trees stay dropped, 183 MiB needed and 96 MiB of room |
| 21.5 | `pressure` again at 633 MiB, index trees dropped; from then on rebuilding never fits (313 MiB needed, no room) |
| 30 to 43 | `warn` and `pressure` alternate around 550 to 580 MiB after collections, all tiers dropped, mempool paused and resumed |

In all: 107 blocks and 59,128 transfers in 40 s (1,478 a second, against 1,700 to 1,800 in the
first eight seconds), 79 of the blocks and 44,036 of the transfers committed with the Merkle
trees dropped, and no abort.

Then the database alone, in the parent process after the node session (so with a full history
window): blocks of 500 random transfers, six per mode, checked through `checkTx` first as
admission does, then finalized and committed to LMDB; the modes added up as the guard's levels
add them:

| mode | blocks/s | transfers/s | finalize | commit | checkTx of 500 | heap after | array buffers |
|---|---:|---:|---:|---:|---:|---:|---:|
| resident | 7.2 | 3,579 | 50.3 ms | 89.4 ms | 55.8 ms | 1,125 MiB | 114 MiB |
| cache capped at 10,000 | 7.0 | 3,478 | 49.8 ms | 93.9 ms | 51.1 ms | 936 MiB | 113 MiB |
| and index trees dropped | 7.6 | 3,820 | 40.4 ms | 90.5 ms | 49.9 ms | 761 MiB | 102 MiB |
| and Merkle trees dropped | 5.7 | 2,869 | 45.9 ms | 128 ms | 57.9 ms | 543 MiB | 81 MiB |
| everything rebuilt (1.06 s) | 7.0 | 3,518 | 46.7 ms | 95.4 ms | 48.4 ms | 948 MiB | 116 MiB |

Analysis. The node is the point of the suite: a heap a quarter larger than its resident state,
a load that fills the rest within ten seconds, and a node that kept committing for the whole
run with every tier dropped for most of it. Two runs before the guard's changes show what they
are for: with the levels' lines taken from V8's `heap_size_limit`, which includes the young
generation's reserve, the same node reached `warn` and died of an out-of-memory error at 19.5 s
without ever shedding, because `pressure` sat past the point of the abort; with the lines fixed
and the trees rebuilt at the first `ok` sample, it changed level 30 times in 40 seconds,
rebuilding each time, and committed 622 transfers a second. What still grows under this load and
drives the late alternation is not a tier the guard can drop: the history window (100 versions
of overwritten tree nodes and object bytes, each block of scattered transfers adding tens of
thousands of records) and the recent transaction ids. The same mode suite run on the state
before any node session (no history yet) gave 10.6, 10.2, 11.5, 10.7 and 10.3 blocks a second
and 493, 512, 382, 189 and 617 MiB of heap: the index trees give back 130 to 175 MiB and the
Merkle trees 190 to 220 MiB, the cache up to 190 MiB when it holds 200,000 decoded objects
(nothing when it held fewer than its cap), and with everything dropped the database runs on 40
to 50% of its resident heap. Throughput holds within 10% until the Merkle trees go, and falls by
5 to 20% with them (a rerun measured 6.7 against 7.0 blocks a second), all of it in the commit:
a root over dropped trees reads its chunks from LMDB and writes private copies, where a resident
one writes in place. The index trees dropped cost nothing a block of transfers notices (the
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
- **Persistence bounds nothing yet.** Two LMDB write transactions per block, one for the chain
  store (block, commit, results, validator sets, state) and one for the application's changes,
  about 10 ms each; a snapshot or pruning adds its own. The application's transaction carries
  the index entries and the tree chunks and nodes a block changed (sections 4.11 and 4.12):
  9.6 ms after a 500-transfer block at 1,001 accounts, and a fifth more for a block scattered
  over 192,000 accounts, whose chunks are about 12 MiB.
- **Memory is the state plus the history window.** About 1.1 GB per gigabyte of ML-DSA-44
  genesis, half of it the keys themselves (a fortieth of that under secp256k1), plus changed
  objects times retained versions, plus two copies more during a state-sync join. The other
  half is the object database's own objects, indices and trees, the same under both schemes:
  measured per account with its balance and two keys, 6.1 KB under ML-DSA-44 and 3.5 KB under
  secp256k1, with everything resident.
- **Paging bounds memory by the working set, not the state.** Under the memory guard the
  state is a cache over LMDB: the cache of decoded objects capped at `warn`, the index trees
  and then the Merkle trees dropped at `pressure`, rebuilt at `ok` when they fit. With
  everything dropped the database runs on 40 to 50% of its resident heap at 5 to 20% less
  throughput, all of it in the commit (section 4.13), and a node whose heap was a quarter
  larger than its resident state kept committing under a full mempool for the whole run. What
  it does not shed is the history window and the recent transaction ids, and a store cannot yet
  be opened with its tiers dropped, so the resident state must still fit the heap once, at
  startup.
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

A node that pages (the memory guard's `pressure` level; [running.md](running.md) section 12)
needs less memory than that, with two provisos. With the cache capped and the index and Merkle
trees dropped the database runs on 40 to 50% of its resident heap (section 4.13), so the heap
must hold the resident state once, at startup, since a store cannot yet be opened with its tiers
dropped, and what the guard pages away is the load's growth: the mempool's pending session, the
history window, the recent transaction ids. Plan the heap for the resident state plus a margin,
and expect a node that lives at its limit to run 5 to 20% slower, all of it in the commit, with
the trees coming back only when they fit under the `warn` line. On disk the store grows for it:
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
a laptop; paged, 40 to 50% of that, with the resident state still needed once at startup (above).
Signature scheme is the right knob for disk and bandwidth; for memory at that scale the knobs
are the memory guard's dials and, beyond them, the history window and opening a store already
paged, items 1 and 3 below.

## 8. Further work the numbers point to

1. **History window paging.** The history window and the recent transaction ids are the growth
   no dial of the memory guard sheds: 100 versions of overwritten tree nodes and object bytes,
   tens of thousands of records per block of scattered transfers, which is what drove the paging
   benchmark's node from `ok` back to `pressure` with every tier dropped (section 4.13). Prior
   values are already bytes (section 4.10); what remains is to keep them in the store and only
   the roots in memory, so that a node can live at its limit under load.
2. **Cold slab release.** STATE-PAGING.md's eviction order releases cold arena slabs at `warn`,
   between the decoded cache and the index trees; it is not built, so the encoded copy of every
   object stays in memory whatever the level.
3. **Opening a store with its tiers dropped.** A node builds every tier resident before the guard
   samples, so a `--heap` below the resident state aborts at startup rather than paging from the
   first block; opening with the index trees and Merkle trees dropped when the heap is known to
   be too small for them is what would let a state larger than the heap run at all.
4. **The sparse trees' past versions at restart.** The store holds the current nodes, not past
   ones, so a restart rebuilds the name tree's retained versions by replaying every account, 3.5 s
   of the 5.2 s restart at 192,000 accounts (section 4.12); keeping the window's before-images in
   the store would remove most of what is left of a restart.
5. **Smaller chunks.** A chunk of 1,024 hashes makes a block scattered over the state rewrite
   nearly every chunk of the trees it touches, about 12 MiB per root at 192,000 accounts, a fifth
   of the commit (section 4.12); smaller chunks on disk would cut that about in half at this size,
   and the dropped-mode root, which reads and writes whole chunks, with it.
6. **State sync.** Stream chunks into the store instead of holding them all, then rebuild from
   the store; that removes one of the three copies and most of the peak.
7. **Signatures per block.** A per-signature or per-kilobyte transaction fee would price the
   96% of block space that ML-DSA-44 signatures take; FEES.md leaves it open.
8. **Block space.** Larger blocks or a shorter commit timeout raise the network's rate directly
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
