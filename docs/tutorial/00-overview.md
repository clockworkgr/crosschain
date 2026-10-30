# 0. Overview: a blockchain in fourteen thousand lines

This tutorial reads the code of a complete proof-of-stake blockchain, part by part, in the
order the parts depend on each other. It is written for a programmer who knows TypeScript and
has not built a blockchain before. Every concept is explained the first time it appears, the
code that implements it is quoted, and the chain the idea comes from is named, because almost
nothing here is new: the design takes Tendermint's consensus, Cosmos's split between consensus
and application, BitShares' account model, networking and object database, and the tm2 and
ICS23 conventions for Merkle proofs, and writes them down as simply as possible.

If you want to run the chain first, read [running.md](../running.md). If you want the reasons
behind the design, [DESIGN.md](../../DESIGN.md) records every decision in the order it was
made, with [STAKING.md](../../STAKING.md), [FEES.md](../../FEES.md),
[RPC-SYNC-PROOFS.md](../../RPC-SYNC-PROOFS.md) and [STATE-PAGING.md](../../STATE-PAGING.md) as
the detailed specifications it points to.
[REVIEW-2026-10-28.md](../../REVIEW-2026-10-28.md) records an external review and what each
finding changed; the tutorial refers to findings by number. The test suite is 22 files and 160
tests; `npm test` runs it under ML-DSA-44 and `CHAIN_SCHEME=secp256k1 npm test` runs it again
under secp256k1, the other signature scheme a genesis may choose; `INDEX_TREES=0` and `TREES=0`
run it with the object database's index trees or Merkle trees dropped from the start, the
fallbacks STATE-PAGING.md describes.

## What a node is made of

```
                 wallet / CLI (14)          light client (13)
                        |                        ^
                        v                        | proofs, headers, commits
                +---------------+   events  +-----------+
                |   JSON-RPC    |<----------|           |
                |   (12)        |---------->|           |
                +---------------+  queries  |           |
                        | broadcast         |           |
                        v                   |           |
  peers  <---> +-----------------+          |   node    |
  (06)         |     mempool     |<---------|   (08)    |
               |     (05)        | recheck  |           |
               +-----------------+          |           |
                        | reap              |           |
                        v                   |           |
  peers  <---> +-----------------+  decide  |           |     +-------------------+
  votes,       |    consensus    |--------->| executor  |---->|   application     |
  proposals    |    (04)         |          |   (05)    |     |   (11)            |
               +-----------------+          +-----------+     |  +-------------+  |
                        ^                        |            |  | object db   |  |
  peers  <---> +-----------------+               v            |  |   (09)      |  |
  blocks,      |  block sync /   |          +-----------+     |  +-------------+  |
  snapshots    |  state sync (07)|--------->| block     |     +-------------------+
               +-----------------+          | store (10)|              |
                                            +-----------+              v
                                                  |            +-------------+
                                                  +----------->|  LMDB (10)  |
                                                               +-------------+

  Underneath everything: deterministic encoding (01), hashing and signatures (02),
  and the shared types: validator sets, votes, blocks, evidence, chain state, genesis (03).
```

A **node** owns one of each box except the RPC server: `Node` constructs no `RpcServer`; the
CLI's `start` command and the local network script build one next to the node, and a `Node`
embedded in another program has no RPC until its owner adds one. The **consensus engine** agrees with the other validators on
the next block; the **executor** hands decided blocks to the **application**, which keeps the
state (accounts, balances, validators, delegations) in an in-memory **object database** whose
Merkle root is the app hash every header commits to; the **mempool** holds transactions waiting
for a block; the **network** gossips transactions, votes, proposals and evidence to peers; the
**sync** modules bring a lagging or new node up to date; the **stores** make everything survive
a restart; the **RPC** exposes it all; the **light client** verifies what the RPC says with
proofs; the **wallet and CLI** build and sign transactions.

The one boundary that matters most is between the engine and the application. The engine knows
nothing about accounts or fees; it moves opaque transaction bytes into blocks and calls the
application through five methods: `initChain`, `checkTx`, `finalizeBlock`, `commit`, `info`.
That is the Cosmos ABCI idea, reduced to an interface in `src/app/types.ts`. Chapter 05 documents
it and chapter 11 the one real application behind it.

## The life of a transaction

1. A wallet builds a transaction: operations with an expiration, prices each operation from
   the fee schedule, and signs the body with the chain's signature scheme, ML-DSA-44 or
   secp256k1 as its genesis says ([14](14-wallet-cli.md), [02](02-crypto.md)).
2. It sends the bytes to a node's RPC `broadcastTx` ([12](12-rpc.md)).
3. The node's mempool asks the application `checkTx`: decode, verify the signatures on the
   worker pool, check expiration and replay, resolve the signing keys from the account's
   authorities, evaluate the operations against the pending state. A check that succeeds stays
   in that speculative pending session, so the next check sees its effects; a check that overlaps
   a block in progress waits for the block to finish, and the pending session is undone before
   every block executes ([05](05-mempool-executor.md), [11](11-application.md)). The signature
   verdict is cached.
4. The mempool announces the transaction's hash to peers; peers that do not have it fetch it
   and run their own `checkTx` ([06](06-p2p.md)).
5. The proposer of the next height reaps transactions from its mempool up to the block size and
   proposes a block ([04](04-consensus.md)).
6. Validators prevote and precommit; at more than two thirds of precommits the block is decided
   and the commit (the precommit signatures) is attached ([04](04-consensus.md)).
7. The executor calls `finalizeBlock` first: the application undoes the pending session, prunes
   expired transactions, runs begin-block staking steps, verifies any uncached signatures in one
   batch, evaluates each transaction in order inside its own session, runs end-block (proposals,
   the active set), writes the dynamic properties, and computes the root; all of it inside one
   block session committed just before the root is taken, so a failure half way leaves the
   database as the previous block left it. Only then does the executor save the block, commit,
   results and validator sets in one store batch and call `commit`, which writes the
   application's changes to LMDB ([05](05-mempool-executor.md), [11](11-application.md),
   [09](09-database.md), [10](10-store.md)).
8. The result and the new app hash appear in the next header: execution is deferred by one
   block, because a block is proposed before anyone has executed it ([03](03-types.md)).
9. The RPC pushes a `tx` event, answers `tx` with inclusion and result proofs, and `account`
   with a name proof; the light client checks each against a header whose commit it has
   verified ([12](12-rpc.md), [13](13-light-client.md)).

## The life of a height

1. The engine starts round 0 of height H. The proposer for the round is chosen by Tendermint's
   proposer priority rotation, weighted by voting power ([03](03-types.md)).
2. The proposer signs and gossips a proposal carrying the block. Validators that receive a
   valid proposal in time prevote for it; otherwise they prevote nil when the propose timeout
   fires.
3. More than two thirds of prevotes for the block is a polka; validators that see one lock on
   the block and precommit it. Without a polka they precommit nil at the prevote timeout.
4. More than two thirds of precommits for the block decides it: instant finality, no forks, no
   confirmations to wait for. The engine waits the commit timeout to gather late precommits for
   a fuller commit, then starts height H+1. Without a decision, round r+1 starts with a longer
   timeout and the next proposer.
5. A validator signs at most once per height, round and step; the private validator refuses
   anything else and remembers its last signature on disk across restarts. Two conflicting
   signatures from the same key are evidence; any node that sees them gossips them, and the
   application slashes and tombstones the validator ([04](04-consensus.md), [11](11-application.md)).
6. Validator set changes the application returns at height H take effect at H+2, so that every
   node agrees on who signs H+1 before anyone has executed H ([03](03-types.md), [05](05-mempool-executor.md)).

## Where the ideas come from

| idea | from | chapter |
|---|---|---|
| rounds, locking, +2/3, instant finality, proposer priority, evidence, H+2 set changes | Tendermint / CometBFT | 03, 04 |
| engine and application split with a small interface; deferred app hash | Cosmos SDK (ABCI) | 05 |
| named accounts with owner and active authorities, weighted multi-signature, dense object ids, in-memory state with undo sessions, secondary indices | BitShares / Graphene | 09, 11 |
| inventory-based gossip, address exchange, nonce handshake | Graphene | 06 |
| per-operation fee schedule with premium names and data fees, the signer stating the fee, committee proposals of all parameters | BitShares | 11 |
| delegated stake with shares and an exchange rate, commission, unbonding, redelegation, slashing, jailing, inflation toward a bonded goal | Cosmos SDK x/staking, x/slashing, x/mint | 11 |
| B+ tree store, fan-out 32, leaf and inner hashing conventions | tm2 / gno | 09 |
| proof shapes verifiable by a standard verifier | ICS23 | 09 |
| compacted sparse Merkle tree for key-based proofs | Jellyfish (Diem) | 09 |
| light client with bisection and a trusting period | Tendermint | 13 |
| state sync from a trusted header with chunked snapshots | Cosmos | 07 |
| post-quantum signatures by default, classical secp256k1 as the alternative, one scheme per chain chosen by genesis | ML-DSA-44 (FIPS 204); Bitcoin | 02 |

## Reading order

Bottom up, as the chapters are numbered. Each chapter can be read on its own, but each assumes
the concepts of the ones before it.

1. [Codec](01-codec.md): one byte representation for everything that is hashed or signed.
2. [Crypto](02-crypto.md): sha256, two signature schemes (ML-DSA-44 and secp256k1) behind one
   tagged key format, domain separation, the verification pool.
3. [Types](03-types.md): validator sets and proposer selection, votes, blocks, evidence, chain
   state, genesis, transaction proofs.
4. [Consensus](04-consensus.md): the Tendermint state machine, vote sets, the double-sign
   guard, the evidence pool, block validation.
5. [Mempool and executor](05-mempool-executor.md): admission, reaping, recheck; applying
   decided blocks, crash recovery, the application interface.
6. [Peer to peer](06-p2p.md): transports, framing, the handshake, messages, peer exchange,
   scoring, requests.
7. [Sync](07-sync.md): catching up by blocks; joining by state sync.
8. [Node](08-node.md): wiring it all together, and running a network in one process.
9. [Object database](09-database.md): ids, objects as bytes in an arena behind a cache of
   decoded ones, indices and Merkle trees whose entries, chunks and nodes the store keeps so
   the memory guard can drop them, proofs, versions, snapshots.
10. [Store](10-store.md): the key-value interface, LMDB, the block store.
11. [Application](11-application.md): accounts, assets, balances, fees, staking, history,
    genesis, snapshots, and the block procedure.
12. [RPC](12-rpc.md): JSON-RPC methods, event streams, limits, the client.
13. [Light client](13-light-client.md): verifying headers and queries with proofs.
14. [Wallet and CLI](14-wallet-cli.md): the keystore and the command line.
15. [Tests](15-tests.md): the harness, every suite (22 files, 160 tests, run under either
    signature scheme and with the database's trees resident or dropped), and how to write a new
    test.

Then [benchmarks.md](../benchmarks.md) for what it all costs.

## Conventions used everywhere

- **Ids.** An object id is a 64-bit integer: a 16-bit type and a 48-bit instance, written
  `type.n`: `3.0` is the first account, `4.0` the core asset. Ids are dense: the next instance
  of a type is a counter.
- **Amounts** are `bigint` base units; the core asset has 5 decimals by default, so one token is
  `100000n`. Hashes, keys and signatures are `Uint8Array`; a key or a signature starts with a
  one-byte tag naming its scheme. Times are unix milliseconds as `bigint`.
- **Heights and versions.** Height `h` of the chain is version `h` of the database; version 0 is
  genesis.
- **Encodings.** Everything hashed or signed, and every chain and application record in LMDB,
  goes through the writer in `src/codec`. JSON is used where nothing is hashed: genesis files,
  the RPC, configuration, the keystore, the peer database, the light client's saved anchor and
  the test application's snapshot.
- **Errors.** `TxError` is a transaction's fault and becomes a failed result, and so does a
  `DbError` thrown while applying one (an index refused the change); anything else is a bug,
  propagates out of the application, and halts consensus on the node that hit it (`decide` logs
  `failed to apply decided block; halting` and stops the state machine; the process stays up).
- **Logs.** A logger is a function `(level, message, fields)`; tests use a silent one.

## A short glossary

- **Validator**: a node with a consensus key and voting power, allowed to propose and vote.
- **Signature scheme**: ML-DSA-44 (post-quantum, the default) or secp256k1 (classical, compact);
  genesis names one, and every key and signature on that chain is of it.
- **Voting power**: a validator's weight in votes; here, its bonded tokens in whole units.
- **+2/3**: strictly more than two thirds of the total voting power, the threshold for both
  prevotes and precommits; it guarantees two conflicting decisions would need a third of the
  power to sign both, which is then provable and punishable.
- **Commit**: the set of precommit signatures that finalised a block.
- **App hash**: the Merkle root of the application state after executing a block.
- **Proof**: the sibling hashes that connect a leaf to a root, so a client holding only the
  root can check the leaf.
- **Delegation**: tokens bonded to a validator by another account, counted in its power.
- **Unbonding period**: the time withdrawn stake stays slashable, and the time a light
  client may trust a header.
