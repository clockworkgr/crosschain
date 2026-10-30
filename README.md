# crosschain

A proof-of-stake blockchain built from first principles as a learning tool: Tendermint
consensus with instant finality, a Cosmos-style split between consensus and
application, Graphene-style peer networking, and one signature scheme per chain, chosen
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
npm test                      # 146 tests, about a minute; CHAIN_SCHEME=secp256k1 runs them on secp256k1 keys
node scripts/localnet.ts 4 30 # 4 validators in one process for 30 seconds, driving the app from a faucet, RPC on :26657
```

A real testnet over TCP, one terminal per node:

```sh
export CHAIN_PASSPHRASE=testnet               # the keystore passphrase init prints
node src/cli.ts init ./testnet 4              # genesis, keystore, 4 node directories (p2p 26656, 26658, ...; RPC one port up); --scheme secp256k1 for that scheme
node src/cli.ts start ./testnet/node0         # repeat for node1..node3; --heap <MiB> sets the heap limit (three quarters of memory otherwise)
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
unless `--heap <MiB>` says otherwise, with a memory guard that caps the object database's
cache of decoded objects and sheds load (the mempool, costly RPC calls, new event streams,
the signature cache) as the heap fills and stops the node cleanly with exit code 3 before
V8 would abort it, and with garbage collections scheduled in the idle moment after each
commit. The five-second status line, `status`
and `/health` report the heap, the guard's level and the collection pauses.

Set `LOG=debug` to watch every proposal, vote and timeout. Node state is kept in an
LMDB environment under each node's data directory; of the four runtime dependencies,
`lmdb` is the one that needs native code.

## Performance

`npm run bench` runs the benchmarks in `bench/` (about two and a half minutes;
`npm run bench -- db app` for a subset). The figures below are from an Apple M4 Pro
(12 cores, 11 verification threads) on Node 24, one process. The network suite runs
four validators inside that process on the in-memory transport, so it measures the
engine and the application, not the wire.

| what | result |
|---|---|
| ML-DSA-44 verify | 1,100/s on one thread, 7,400/s on the worker pool |
| ML-DSA-44 sign | 2.0 ms (a rejection loop; earlier runs saw 3 to 9 ms) |
| secp256k1 verify | 1,400/s on one thread, 9,200/s on the worker pool |
| secp256k1 sign | 0.23 ms |
| signed transfer | 2,510 bytes under ML-DSA-44, 154 under secp256k1; 1,664 ML-DSA-44 transfers filled a 4 MiB block in the four-validator run (the codec's estimate with a 2 KiB shell is 1,668) |
| checkTx (admission to the mempool) | 6,700 transfers/s through the pool |
| finalizeBlock, signatures verified at admission | 26,000 transfers/s; 1,500 transfers (about 3.6 MiB with a block shell) in 57 ms |
| finalizeBlock, cold (block sync, or a node that missed the gossip) | 6,300 transfers/s |
| commit after a 500-transfer block | 2.6 ms to memory, 8.8 ms to LMDB |
| object database | root after 1,000 changed objects in 19 ms; 100,000 objects in 91 MiB |
| proofs | object proof 777 bytes, 88,000/s; name proof 958 bytes, 400,000/s |
| four validators, empty blocks | 9.5 blocks/s with a 50 ms commit timeout |
| four validators under load | 1,100 transfers/s sustained, full 4 MiB blocks |
| block sync of those blocks | 4,600 transfers/s |

Signatures set every limit. A signed transfer is 2,510 bytes under ML-DSA-44: a 41-byte
operation, 48 bytes of framing and signer address, and a 2,421-byte signature with its
scheme tag; under secp256k1 the signature is 65 bytes and the transfer 154. Verifying
one costs 0.7 to 0.9 ms of CPU under either scheme. A node verifies a signature once,
at admission or in the block, and
reuses the result while its cache entry lasts (the cache holds 20,000 transaction
bodies); a signer whose key an earlier transaction of the same block introduces is
verified in the per-transaction pass instead of the batch. Block space bounds the live
network: a 4 MiB block holds about 1,660 ML-DSA-44 transfers once the previous commit and the
header are in it, at about a block a second. The object database and the store are
nowhere near their limits at this scale.

### A large genesis

`npm run bench:genesis` writes a 1 GB (1,000 MiB) application genesis (193,536 accounts
with two ML-DSA-44 keys each, named by `appStateFile`), loads it, and measures the result; set
`BENCH_GENESIS_MB` for another size. Same machine:

| what | result |
|---|---|
| parse as a token stream (stream-json) | 6.4 s, 157 MiB/s |
| build objects and indices, first root, write to LMDB | 8.1 s (apply 3.8 s, root 3.5 s, persist 0.9 s) |
| memory holding that state | 584 MiB of heap plus 536 MiB of key buffers; peak RSS during the load 3.5 GB |
| disk | 614 MiB of LMDB for the state; 1.1 GiB with one snapshot for state sync |
| account by id / by name / balance | 16,000,000 / 780,000 / 950,000 per second |
| object proof + verify / name proof + verify | 40,000 / 46,000 per second; 3.4 KiB and 932 B |
| a block of 500 transfers | 25 ms to finalize, 10 ms to commit |
| snapshot export | 3.5 s |
| restart from LMDB | 11.8 s (decode 5.0 s, root 3.2 s, rebuilding index history 3.7 s) |

Memory is dominated by the keys themselves (ML-DSA-44 keys; under secp256k1 the same accounts
hold a fortieth as many key bytes): a 1 GB genesis is about 1.1 GB of heap and
array buffers at rest (measured after a collection; the resident set is larger, since it
counts LMDB's memory map and pages the allocator keeps), roughly its size, since the
state stays in memory by design and hex halves to binary while objects and trees add it
back. Node's default heap limit suffices. At the sizes measured, lookups by id and by
name ran as fast as with a thousand accounts, although a lookup by name walks a B+ tree
whose depth grows with the log of the state, as does the length of a proof. A restart
costs more than the first load because the store is read object by object and the
authenticated name index is built twice, once live and once to recover past versions.

### Steady state at that size

The same command continues with a `scale` suite on the gigabyte state: one validator
carrying it, serving JSON-RPC while it produces blocks (with the server's rate limiter
raised out of the way, to 10⁹ tokens a second and costly calls charged one, so the
figures are the server's and not the limiter's); blocks of batch transfers that touch
accounts all over the state; proofs at past heights and history after them; and the
state-sync pipeline run locally into a fresh store.

| what | result |
|---|---|
| RPC, 16 clients, chain idle: account by name with proof / object with proof / history / status | 6,000 / 6,500 / 9,600 / 9,200 calls/s |
| RPC broadcastTx, 16 clients, 2,000 transfers until committed | 2,150 tx/s over 8 blocks |
| the same with 8 clients reading accounts with proofs throughout | 1,460 tx/s and 1,490 reads/s |
| blocks of 300 transactions of 8 transfers each, random accounts | per block: admit 50 ms, finalize 93 ms, commit 43 ms; 17,700 transfers/s applied |
| growth over 8 such blocks | 36 MiB of LMDB; heap in use grew 85 MiB (the process's heap-used difference across the blocks, not an isolated measure of the version history) |
| object proof / name proof at a past height, with verification | 37,000 / 43,000 per second |
| account history, newest 20 entries | 930,000 per second |
| state sync pipeline, local, 201 chunks, 504 MiB: export, read and verify chunks, rebuild, write, open | 37 s in all (export 4.6 s, read and verify 3.5 s, rebuild and check roots 10.3 s, write 4.2 s, open 14.1 s); no peer transfer or header verification |
| memory with the original and the synced state both loaded | 1.3 GB of heap plus 1.1 GB of key buffers |

At this size reads and proofs ran as fast as on the small state; what grows is the
per-block root (scattered writes reach more of a bigger tree) and anything that walks
every object: genesis, restart, snapshot export and import. A node joining by state
sync holds the whole gigabyte in chunks before it can rebuild, so plan for about
three times the state's resting memory in all during the join (chunks, the rebuilt
state and the opened store).

## Reading order

Each file opens with a comment explaining what it does and why. A good path through
the code, from the bottom up:

1. `src/codec/writer.ts` — one byte representation for everything that is hashed or signed.
2. `src/crypto/keys.ts` — ML-DSA-44 and secp256k1 behind one tagged key and signature format, one scheme per chain, with context strings for domain separation.
3. `src/types/validator.ts` — the validator set and Tendermint's proposer selection.
4. `src/types/block.ts`, `src/types/vote.ts` — what a block, a commit and a vote are.
5. `src/consensus/privval.ts` — the double-sign guard. Short, and the most important safety property in the node.
6. `src/consensus/votes.ts` — how +2/3 is counted.
7. `src/consensus/consensus.ts` — the state machine. Every rule cites its line in the Tendermint paper.
8. `src/app/types.ts` — the application interface; `src/app/kvstore.ts` is the toy app the engine tests use.
9. `src/node/executor.ts` — how a decided block becomes state, and crash recovery.
10. `src/p2p/network.ts` — handshake, peer exchange, duplicate connections.
11. `src/sync/blocksync.ts` — how a lagging node catches up.
12. `src/node/node.ts` — the wiring.
13. `src/db/id.ts`, `src/db/keys.ts`, `src/db/arena.ts`, `src/db/index.ts` — typed objects, dense ids, objects kept as bytes in an arena behind a cache of decoded ones, and indices as ordered byte keys.
14. `src/db/bptree.ts` — the B+ tree behind every index and the in-memory store.
15. `src/db/merkle.ts`, `src/db/proof.ts` — the dense Merkle tree, its versions, and how an ICS23-shaped proof is checked.
16. `src/db/smt.ts` — the sparse Merkle tree behind proofs by name, and why the B+ tree is not hashed.
17. `src/db/database.ts` — undo sessions, the committed view, the root per height, history and its persistence.
18. `src/store/kv.ts`, `src/store/lmdb.ts` — the key-value interface and LMDB behind it.
19. `src/app/core/authority.ts`, `src/app/core/tx.ts` — authorities and the transaction format.
20. `src/app/core/evaluate.ts` — the state transition rules, one case per operation.
20a. `src/app/core/staking.ts` — shares and exchange rate, rewards, mint, slashing, proposals, the active set.
21. `src/app/core/app.ts` — the application: sessions, signature cache, blocks, persistence, queries.
22. `src/light/client.ts` — the light client: sequential and skipping verification, bisection, the hash chain walked backwards, query checks.
23. `src/types/txproof.ts` — transaction inclusion and result proofs.
24. `src/rpc/server.ts`, `src/rpc/methods.ts` — the JSON-RPC surface.
25. `src/app/core/snapshot.ts`, `src/sync/statesync.ts` — snapshots with range proofs and joining from one.
26. `src/sync/blocksync.ts` — windows of blocks from several peers, and backfill.

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
src/sync        block sync
src/node        executor, memory guard and collection scheduler, node
src/db          object database: ids, arena and hot cache, B+ tree indices, versioned Merkle tree, proofs, sessions
src/store       key-value interface, LMDB, block store
src/light       light client, providers (in-process and RPC), query verification
src/rpc         JSON-RPC server, events, client
src/wallet      encrypted keystore
src/app         application interface and the key-value test app
src/app/core    the core application: accounts, assets, balances, transactions
scripts/        in-process localnet
test/           vitest suites
```
