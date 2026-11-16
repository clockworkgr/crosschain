# crosschain

A proof-of-stake blockchain built from first principles as a learning tool: Tendermint
consensus with instant finality, a Cosmos-style split between consensus and
application, Graphene-style peer networking, an object database with a Merkle root that
pages its state to LMDB under memory pressure, and one signature scheme per chain, chosen
by genesis: post-quantum ML-DSA-44 or secp256k1. Written in TypeScript so that every
mechanism is readable in one sitting.

`DESIGN.md` records every design decision and why it was made; `STAKING.md`,
`RPC-SYNC-PROOFS.md`, `FEES.md` and `STATE-PAGING.md` are the specifications it points to. The `docs/`
directory holds the full documentation: [running and using the chain](docs/running.md),
[the benchmarks and their analysis](docs/benchmarks.md), and a [part-by-part tutorial
of the whole codebase](docs/tutorial/00-overview.md). This file is the short version.

## Run it

Requires Node 24 (it runs TypeScript directly; there is no build step).

```sh
npm install
npm test                      # 287 tests, about two minutes; CHAIN_SCHEME=secp256k1 runs them on secp256k1 keys, INDEX_TREES=0 or TREES=0 with the database's index or Merkle trees dropped
node scripts/localnet.ts 4 30 # 4 validators in one process for 30 seconds, driving the app from a faucet, RPC on :26657
```

A real testnet over TCP, one terminal per node:

```sh
export CHAIN_PASSPHRASE=testnet               # the keystore passphrase init prints
node src/cli.ts init ./testnet 4              # genesis, keystore, 4 node directories (p2p 26656, 26658, ...; RPC one port up); --scheme secp256k1 for that scheme
node src/cli.ts start ./testnet/node0         # repeat for node1..node3; --heap <MiB> sets the heap limit (three quarters of memory otherwise), --arena <MiB> bounds the encoded objects kept in memory
node src/cli.ts show ./testnet/node1          # status, validators and accounts over the node's RPC
node src/cli.ts create ./testnet/node0 alice  # the faucet registers alice; her key goes into the keystore
node src/cli.ts transfer ./testnet/node2 faucet alice 12.5   # whole tokens; waits for inclusion
node src/cli.ts delegate ./testnet/node1 faucet op1 5000     # validators are named by their operator account
node src/cli.ts undelegate ./testnet/node3 faucet op1 1000   # back in the balance after the unbonding period
node src/cli.ts account ./testnet/node0 alice                # balances; the light client verifies the proof that the name maps to this account
node src/cli.ts history ./testnet/node0 faucet               # the newest 50 entries of an account's history
node src/cli.ts light ./testnet/node2 verify                 # light client verifies forward from a saved anchor
node src/cli.ts parameters ./testnet/node0                   # the fee schedule and staking parameters in force
node src/cli.ts propose ./testnet/node0 op0 fees.transfer.fee=250   # a validator proposes a change (FEES.md)
node src/cli.ts signal ./testnet/node1 op1 12.0              # another signals it; more than two thirds of active stake adopts it
node src/cli.ts join ./testnet node4 127.0.0.1:26656 2 <hash of header 2> 26700   # a node that joins by state sync
```

Every client command except `create-validator` also takes an RPC URL instead of a node
directory, with `--keystore` for signing; `create-validator` reads the consensus key from
the node directory, so it needs one.

A genesis too large to inline (a token distribution with many accounts) goes in its
own file named by `"appStateFile"` in `genesis.json`; the node streams it with
`stream-json` at first start and never reads it again.

`start` runs the node in a child process under a heap limit, three quarters of memory
unless `--heap <MiB>` says otherwise (an old-space limit already set on Node's command
line or in `NODE_OPTIONS` is kept instead: no child is started and `--heap` is not
read), with a memory guard that pages the state as the heap
fills. At 70% of the limit it caps the object database's cache of decoded objects, drops the
secondary indices' B+ trees (on a node set to keep them in memory; by default they are never
built and index reads go to the store), cuts the window of past versions kept in memory to the
last two (the store keeps the whole window, and a proof or query at an older height is read from
the store's history records, slower and at no cost in memory) and halves the mempool's limit. At
85% it drops the Merkle trees as well, lowers the mempool's limit to a tenth and sheds load
(costly RPC calls, new event streams, the signature cache). LMDB holds the index entries and the
trees' chunks and nodes at every height, so lookups, scans, roots and proofs read through the
store, slower, and the node rebuilds the trees once the heap has had room for as long as it took
to fill. At 95% it stops the node cleanly with exit code 3, before V8 would abort it if the heap
has not filled between two of the guard's samples, a second apart. Garbage collections are scheduled in the idle moment after each commit. The
five-second status line and `status` report the heap, the guard's level and the
collection pauses, `/health` the level, and `status` which tiers of the state are resident. A stored state whose
trees do not fit within half the heap limit is opened paged, with them left in the store and its past heights
proven from the store's history records, and `--arena <MiB>`
holds the encoded objects in memory within a byte budget, the rest read from the store.

Set `LOG=debug` to watch every proposal, vote and timeout. Node state is kept in an
LMDB environment under each node's data directory; of the four runtime dependencies,
`lmdb` is the one that needs native code.

## Performance

`npm run bench` runs the benchmarks in `bench/` (about two and a half minutes;
`npm run bench -- db app` for a subset; `npm run bench -- paging` the state paging suite
of docs/benchmarks.md section 4.13). The figures below are from an Apple M4 Pro
(12 cores, 11 verification threads) on Node 24, one process. The network suite runs
four validators inside that process on the in-memory transport, so it measures the
engine and the application, not the wire.

| what | result |
|---|---|
| ML-DSA-44 verify | 1,100/s on one thread, 7,800/s on the worker pool |
| ML-DSA-44 sign | 2.85 ms (a rejection loop; earlier runs read between 2 and 9 ms) |
| secp256k1 verify | 1,400/s on one thread, 9,200/s on the worker pool |
| secp256k1 sign | 0.23 ms |
| signed transfer | 2,510 bytes under ML-DSA-44, 154 under secp256k1; a full block holds 1,667 ML-DSA-44 transfers, the codec's figure exactly (the 4 MiB limit is on the transactions and the evidence, less the 1 KiB the builder leaves), and encodes to 4.01 MiB with its header and commit |
| checkTx (admission to the mempool) | 5,800 transfers/s through the pool |
| finalizeBlock, signatures verified at admission | 25,000 transfers/s; 1,500 transfers (about 3.6 MiB with a block shell) in 64 ms |
| finalizeBlock, cold (block sync, or a node that missed the gossip) | 5,800 transfers/s |
| commit after a 500-transfer block | 3.4 ms to memory, 9.9 ms to LMDB (2.6 and 8.8 in the build before the index entries and tree chunks were written with the objects) |
| object database | root after 1,000 changed objects in 20 ms; 100,000 objects in 94 MiB |
| proofs | object proof 777 bytes, 88,000/s; name proof 958 bytes, 276,000/s |
| four validators, empty blocks | 8.9 blocks/s with a 50 ms commit timeout |
| four validators under load | 1,014 transfers/s over seven blocks, the largest a full 4 MiB |
| block sync of those blocks | 3,400 transfers/s |

Signatures set every limit. A signed transfer is 2,510 bytes under ML-DSA-44: a 41-byte
operation, 48 bytes of framing and signer address, and a 2,421-byte signature with its
scheme tag; under secp256k1 the signature is 65 bytes and the transfer 154. Verifying
one costs 0.7 to 0.9 ms of CPU under either scheme. A node verifies a signature once,
at admission or in the block, and
reuses the result while its cache entry lasts (the cache holds 20,000 transaction
bodies); a signer whose key an earlier transaction of the same block introduces is
verified in the per-transaction pass instead of the batch. Block space bounds the live
network: the 4 MiB a block may give its transactions and evidence hold 1,667 ML-DSA-44
transfers (the header and the previous commit are not counted), at about a block a second. The object database and the store are
nowhere near their limits at this scale.

### A large genesis

`npm run bench:genesis` writes a 1 GB (1,000 MiB) application genesis (193,393 accounts
with two ML-DSA-44 keys each, named by `appStateFile`), loads it, and measures the result; set
`BENCH_GENESIS_MB` for another size. Same machine:

| what | result |
|---|---|
| parse as a token stream (stream-json) | 6.5 s, 154 MiB/s |
| build objects and indices, first root, write to LMDB | 11.4 s (apply 4.1 s, root 5.4 s, persist 1.8 s) |
| memory holding that state | 590 MiB of heap plus 1,054 MiB of array buffers (the keys and the arena of encoded objects) after building, 383 MiB plus 582 MiB after a restart; peak RSS during the load 5.2 GB |
| disk | 958 MiB of LMDB for the state; 1,464 MiB with one snapshot for state sync |
| account by id / by name / balance | 10,200,000 / 592,000 / 688,000 per second |
| object proof + verify / name proof + verify | 45,700 / 45,500 per second; 3.4 KiB and 932 B |
| a block of 500 transfers | 26 ms to finalize, 16 ms to commit |
| snapshot export | 0.8 s |
| restart from LMDB | 4.1 s (read 0.6 s; indices, trees and root with every check 3.5 s; the sparse trees' past versions 2 ms), 2.3 s without the leaf check and 8.1 s when the trees are computed from the objects. The first build measured took 11.8 s (decode 5.0 s, root 3.2 s, rebuilding index history 3.7 s), before the trees were stored; a restart now takes the trees and indices from the store and checks every object against its leaf, which took the 192,000-account secp256k1 run from 8.4 to 5.2 s at the time (docs/benchmarks.md section 4.12); the past versions of the sparse trees, 3.5 s of that 5.2 s when they were rebuilt by replaying every account, now come from the store's history records, and that restart takes 2.85 s (read 0.30 s; indices, trees and root with every check 2.54 s; history 2 ms), 1.41 s without the leaf check and 5.17 s when the trees are computed from the objects, with 381 MiB of heap after it where there were 572 |

Memory is dominated by the keys themselves (ML-DSA-44 keys; under secp256k1 the same accounts
hold a fortieth as many key bytes): a 1 GB genesis is about 1.6 GB of heap and
array buffers in the process that built it and 1.0 GB after a restart (measured after a
collection; the resident set is larger, since it counts LMDB's memory map and pages the
allocator keeps), roughly its size after a restart, since hex halves to binary while
objects and trees add it back. Node's default heap limit suffices. At the sizes measured, lookups by id and by
name ran as fast as with a thousand accounts, although a lookup by name walks a B+ tree
whose depth grows with the log of the state, as does the length of a proof. A restart
cost more than the first load in the first build measured (11.8 s against 8.0 s) because the store was read object by object and
the authenticated name index built twice, once live and once to recover past versions; the
live build is gone now that the trees and indices come back from the store, and the
past-version rebuild went after it: the past versions are taken from the nodes each
commit overwrote, which the history records in the store hold, and the replay of every
account remains only as the fallback for records written before those nodes were kept. A
restart is now a bit over a third of the build, 4.1 s against 11.4 s.

### Steady state at that size

The same command continues with a `scale` suite on the gigabyte state: one validator
carrying it, serving JSON-RPC while it produces blocks (with the server's rate limiter
raised out of the way, to 10⁹ tokens a second and costly calls charged one, so the
figures are the server's and not the limiter's); blocks of batch transfers that touch
accounts all over the state; proofs at past heights and history after them; and the
state-sync pipeline run locally into a fresh store.

| what | result |
|---|---|
| RPC, 16 clients, chain idle: account by name with proof / object with proof / history / status | 4,300 / 5,700 / 6,200 / 7,100 calls/s |
| RPC broadcastTx, 16 clients, 2,000 transfers until committed | 1,330 tx/s over 13 blocks |
| the same with 8 clients reading accounts with proofs throughout | 1,220 tx/s and 1,230 reads/s |
| blocks of 300 transactions of 8 transfers each, random accounts | per block: admit 66 ms, finalize 86 ms, commit 59 ms; 16,600 transfers/s applied |
| growth over 8 such blocks | 31 MiB of LMDB; heap in use grew 209 MiB (the process's heap-used difference across the blocks, not an isolated measure of the version history) |
| object proof / name proof at a past height, with verification | 39,900 / 39,000 per second |
| account history, newest 20 entries | 830,000 per second |
| state sync pipeline, local, 201 chunks, 504 MiB: export, read and verify chunks, rebuild, write, open | 25.9 s in all (export 1.3 s, read and verify 3.6 s, rebuild and check roots 9.2 s, write 2.8 s, open 9.0 s); no peer transfer or header verification |
| memory with the original and the synced state both loaded | 961 MiB of heap plus 1,637 MiB of array buffers |

At this size reads and proofs ran as fast as on the small state; what grows is the
per-block root (scattered writes reach more of a bigger tree) and anything that walks
every object: genesis, restart, snapshot export and import. A node joining by state
sync holds the whole gigabyte in chunks before it can rebuild, so plan for about
three times the state's resting memory in all during the join (chunks, the rebuilt
state and the opened store).

A `paging` suite runs the 192,000-account secp256k1 state under the memory guard: a node
under a heap limit of 1.25 times its resident state opened with its Merkle trees and its
history left in the store, on 39 MiB of heap, and kept committing for 40 seconds with its
index trees and Merkle trees in the store throughout, 129 blocks and 72,092 transfers
(1,771 a second) without an abort,
and with the cache capped and both tiers dropped the database runs on 57% of its
resident heap (40 to 50% in an earlier build's run on a state with no history yet) at the
throughput it has resident or above it; a loaded node is in fact
about a tenth faster with its index trees in the store than with them in memory, which is
where a node leaves them by default (`indexTrees`), how much
of the history window it keeps in memory changes its heap and its pauses but not its rate,
and a quarter of the resident heap was enough under that load
(docs/benchmarks.md section 4.13).

## Reading order

Each file opens with a comment explaining what it does and why. A good path through
the code, from the bottom up:

1. `src/codec/writer.ts`: one byte representation for everything that is hashed or signed.
2. `src/crypto/keys.ts`: ML-DSA-44 and secp256k1 behind one tagged key and signature format, one scheme per chain, with context strings for domain separation.
3. `src/types/validator.ts`: the validator set and Tendermint's proposer selection.
4. `src/types/block.ts`, `src/types/vote.ts`: what a block, a commit and a vote are.
5. `src/consensus/privval.ts`: the double-sign guard. Short, and the most important safety property in the node.
6. `src/consensus/votes.ts`: how +2/3 is counted.
7. `src/consensus/consensus.ts`: the state machine. Every rule cites its line in the Tendermint paper.
8. `src/app/types.ts`: the application interface; `src/app/kvstore.ts` is the toy app the engine tests use.
9. `src/node/executor.ts`: how a decided block becomes state, and crash recovery.
10. `src/p2p/network.ts`: handshake, peer exchange, duplicate connections.
11. `src/sync/blocksync.ts`: how a lagging node catches up.
12. `src/node/node.ts`: the wiring.
13. `src/db/id.ts`, `src/db/keys.ts`, `src/db/arena.ts`, `src/db/index.ts`, `src/db/indexstore.ts`: typed objects, dense ids, objects kept as bytes in an arena behind a cache of decoded ones, indices as ordered byte keys, and the index entries' disk form with the merged cursor a dropped index reads through.
14. `src/db/bptree.ts`: the B+ tree behind every index and the in-memory store.
15. `src/db/merkle.ts`, `src/db/proof.ts`: the dense Merkle tree, its versions, and how an ICS23-shaped proof is checked.
16. `src/db/smt.ts`: the sparse Merkle tree behind proofs by name, and why the B+ tree is not hashed.
17. `src/db/database.ts`: undo sessions, the committed view, the root per height, history and its persistence.
18. `src/store/kv.ts`, `src/store/lmdb.ts`: the key-value interface and LMDB behind it.
19. `src/app/core/authority.ts`, `src/app/core/tx.ts`: authorities and the transaction format.
20. `src/app/core/evaluate.ts`: the state transition rules, one case per operation.
20a. `src/app/core/staking.ts`: shares and exchange rate, rewards, mint, slashing, proposals, the active set.
21. `src/app/core/app.ts`: the application: sessions, signature cache, blocks, persistence, queries.
22. `src/light/client.ts`: the light client: sequential and skipping verification, bisection, the hash chain walked backwards, query checks.
23. `src/types/txproof.ts`: transaction inclusion and result proofs.
24. `src/rpc/server.ts`, `src/rpc/methods.ts`: the JSON-RPC surface.
25. `src/app/core/snapshot.ts`, `src/sync/statesync.ts`: snapshots with range proofs and joining from one.
26. `src/sync/blocksync.ts`: windows of blocks from several peers, and backfill.

Then `test/consensus.test.ts`: each scenario (one validator down, partition, late
joiner, validator set change) is a few lines and runs a whole network in-process.
`test/app.test.ts` walks the application one block at a time, and `test/chain.test.ts`
runs it on a live network and checks a state proof against the next header.

## Layout

```
src/codec       binary encoding
src/crypto      hashing, keys, verification worker pool
src/types       chain data types and their encodings
src/consensus   Tendermint state machine and supporting pieces
src/mempool.ts  transaction pool
src/p2p         transports, messages, peer db, network
src/sync        block sync, state sync from snapshots
src/node        executor, memory guard and collection scheduler, node
src/db          object database: ids, arena and hot cache, B+ tree indices with their entries on disk, versioned Merkle trees with their chunks and nodes on disk, both droppable under memory pressure, proofs, sessions
src/store       key-value interface, LMDB, block store
src/light       light client, providers (in-process and RPC), query verification
src/rpc         JSON-RPC server, events, client
src/wallet      encrypted keystore
src/app         application interface and the key-value test app
src/app/core    the core application: accounts, assets, balances, transactions, staking, fees, history, snapshots
src/util        logger
src/cli.ts      command line: init, start, keys and the RPC client commands
scripts/        in-process localnet
bench/          benchmarks
test/           vitest suites
```
