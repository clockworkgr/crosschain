# Chain Design

Running design document. Decisions are appended as they are made.
Principle: as simple as possible, borrowing proven ideas from other chains.

## 1. Consensus

- **Finality:** instant. No forks.
- **Algorithm:** Tendermint BFT. Fresh implementation in TypeScript, not a fork of CometBFT.
- **Rounds:** propose, prevote, precommit. A valid proposal (or the propose timeout)
  moves a validator to prevote; more than two thirds of the bonded voting power in
  prevotes for one block is a polka, and more than two thirds in precommits decides it.
  Locking on a polka gives safety. Round timeouts give liveness under weak synchrony.
- **Liveness bound:** a quorum is strictly more than two thirds, so the chain halts
  once a third or more of the voting power is offline or partitioned.
- **Proposer selection:** deterministic weighted round-robin (Tendermint priority
  accumulation), computed inside consensus from the validator set, per (height, round).
  The proposer for round r is always derived from the height's base set with one
  increment-by-r call, never incrementally across rounds, because the rescale step is
  not path independent and nodes that skipped rounds would otherwise disagree.
- **Validator keys:** ML-DSA-44 (see §5). No aggregation exists for ML-DSA, so commits
  are linear in validator count.
- **Timestamps:** proposer-based. Proposer sets block time, which must be after the
  previous block's; validators reject a fresh proposal whose time is outside a window
  around their local clock (15 s by default). A block re-proposed with a proof of lock
  keeps the time its first proposer gave it and is not clock-checked again, nor are
  blocks arriving through block sync or fetched after a precommit quorum.
- **Validator set changes:** updates returned by the app at height H take effect at H+2.
- **Slashable faults:** duplicate vote (same height/round, different block). Amnesia
  evidence deferred.
- **Double-sign protection:** every validator persists last signed (height, round, step)
  to disk *before* broadcasting any vote. Non-negotiable.

## 2. Consensus / application split (ABCI-style)

- Consensus engine owns: p2p networking, consensus message gossip, mempool, tx gossip,
  block sync, evidence pool, proposer selection.
- Application owns: tx format and validation, state, state transitions, validator set.
- Txs are opaque bytes to consensus.
- Interface is an in-process TypeScript interface, not a socket.

```ts
interface Application {
  initChain(genesis: Genesis): Promise<InitChainResult>                  // appHash, optional validator set
  checkTx(tx: Uint8Array): Promise<CheckTxResult>                         // mempool admission
  finalizeBlock(req: FinalizeBlockRequest): Promise<FinalizeBlockResult>  // appHash, tx results, validator updates
  commit(): Promise<void>                                                 // persist
  info(): Promise<{ lastHeight: bigint; lastAppHash: Uint8Array }>        // crash recovery handshake
}
```

Every method is asynchronous (`src/app/types.ts`). `FinalizeBlockRequest` is what the
executor extracts from a decided block: height, time, the transactions, the proposer
address, the addresses whose precommits are in `lastCommit`, and the misbehaviour the
block's evidence proves. `initChain` returns `{ appHash, validators? }`; a non-empty
`validators` replaces the genesis list (STAKING.md section 2.3).

- **Execution model:** deferred. Header of block N carries the app hash from executing
  block N-1.
- **Mempool:** consensus receives a tx, calls CheckTx, and if valid stores it and floods
  it to peers. Seen-cache prevents re-gossip loops. After every commit, all pending txs
  are re-checked and failures evicted. The app keeps a scratch state copy for CheckTx.
- **Block proposal:** proposer reaps txs from mempool (FIFO, bounded by max bytes) and
  sends the whole block in one proposal message. Block parts only if blocks grow large.
- **Block sync:** lagging nodes fetch committed blocks + commits from peers and replay
  through the app. Separate from consensus gossip.
- **Crash recovery:** on startup, consensus calls Info() and replays any blocks the
  app has not committed.

## Open questions

- Tx gossip is flood-to-all. Fine for small validator sets; revisit if it grows.

## 3. P2P networking (Graphene / BitShares model)

- **Topology:** flat. One TCP stream per peer, one message type field, no channel
  multiplexing. After the handshake, inbound and outbound peers are indistinguishable.
- **Node identity:** long-lived ML-DSA-44 node keypair. Node id = SHA-256 of public key.
- **Handshake (mutual, nonce-bound, 1.5 round trips, no ECDH):**
  - A connects and sends hello_A: chain id, node pubkey, 32-byte nonce, advertised
    inbound addr:port, last committed height, user agent.
  - B replies hello_B (same fields, own nonce) plus sig_B over (hello_A || hello_B).
  - A replies auth_A: sig_A over (hello_A || hello_B).
  - Either side may instead send reject: wrong chain, connected to self, already
    connected to this node id, not accepting connections, invalid hello or signature.
  - Signatures use ML-DSA-44 with context "<chainId>/p2p". The nonces bind each
    signature to this session, so there is no replay and no need for a shared secret.
  - Transport: authenticated, not encrypted. Every consensus message and tx is
    independently signed, so confidentiality adds nothing. X25519 is dropped entirely.
- **Framing:** 4-byte length, 1-byte message type, binary payload (see §4 codec).
- **Peer database:** persisted. Per endpoint: last seen, last outcome (never connected,
  connected and disconnected, connect failed, rejected, handshake failed), success and
  failure counts. Address request / address reply messages exchange entries. (The
  implementation keeps last seen, the success and failure counts and the ban state of
  an address, at most 4096 entries; the outcome enumeration was not needed.)
- **Connection management:**
  - desired outbound peers and maximum inbound peers (defaults 8 and 32; Graphene
    uses 20 / 200). Handshakes in progress count toward the inbound limit.
  - connect loop tops up outbound from the peer db every second.
  - **minimum self-chosen outbound connections** is enforced so inbound peers can never
    occupy every slot (eclipse defense): the loop keeps dialing until it has its
    outbound count, and only the addresses the node dialed itself (plus its own) are
    taken; an inbound peer's advertised address is a claim and never stops the node
    from dialing it or anyone else. Slot accounting is not symmetric even though
    message handling is.
  - idle peers dropped by a keepalive loop.
  - **duplicate connections** (same node id twice): if both are young it is a
    simultaneous dial and the one initiated by the lower node id survives, which both
    sides compute identically. If the existing one is older than 2 s the peer has
    restarted and the new connection replaces it, so a restarted validator rejoins at
    once instead of waiting for the old socket to time out.
- **Keepalive:** a ping every 10 s carrying the sender's time, echoed by the pong,
  which gives the round-trip latency per peer; a peer silent for 45 s is dropped.
  There is no clock-offset measurement; block times are checked against the local
  clock alone.
- **Gossip, two modes:**
  - **Inventory (announce hash, peer fetches):** transactions. Seen-cache per item type.
    "Item not available" as the negative reply. Committed blocks are announced by a
    status message (height) and pulled through block sync.
  - **Direct push (no round trip):** consensus proposals and votes. Dedup by
    (height, round, validator, vote type). Inventory would add a round trip to each of
    the three Tendermint phases.
  - **Re-send, because a flooded message is sent once:** a peer that was not connected
    at that moment, or was briefly partitioned, never gets it, and one missing vote can
    stall a round. So while a round is unresolved every validator re-sends, every
    `gossipMs`, its own current-round votes and the prevotes behind its valid block
    (the polka a peer needs before it can accept a re-proposal); the proposer of the
    current round re-sends that round's proposal, whether it built the block or
    re-proposed another validator's; and a newly connected peer is handed every
    proposal and vote held for the current height plus the ids of pending evidence.
    Receivers drop duplicates before verifying. This replaces Tendermint's per-peer
    state tracking with something far simpler at the cost of some bandwidth.
- **Block sync:** no fork-point synopsis. Lagging node requests blocks from height H+1.
  Both sides learn the other's height from the hello.
- **Firewall / reachability check:** optional. A node may ask a peer to connect back to
  its advertised endpoint to learn whether it is reachable. Defer.
- **Misbehaviour:** invalid message means disconnect and a failure mark in the peer db.
  Scoring and bans came with stage three (section 9).

## 4. Implementation

- **Language / runtime:** TypeScript on Node, strict mode, ES modules. Purpose: a
  readable learning implementation, so clarity beats throughput.
- **Concurrency:** single-threaded event loop. Consensus state machine has no locks.
  Round timeouts are setTimeout.
- **Worker pool, verification only:** Node worker_threads, size = cpu count - 1. A job
  is a batch of (sig, msg, pubkey, context) and returns booleans. The main thread never
  calls verify directly outside tests. Signing stays on the main thread: once per
  consensus step, ~2 ms, and it keeps the persist-then-broadcast order of the
  double-sign guard trivial.
- **Integers:** heights, times, amounts and voting power are BigInt. Plain numbers are
  doubles and carry only bounded integer fields whose encoding is u8, u16 or u32:
  rounds, the protocol version, basis-point rates, counters, instance numbers. No
  floats in state.
- **Codec:** hand-written binary encode/decode per message and per state object,
  Graphene raw-serializer style. Deterministic by construction. JSON is not used for
  anything that gets hashed or signed.
- **Crypto:** @noble/post-quantum ML-DSA-44 for every signature (see §5). SHA-256 from
  Node built-in crypto for hashing. Grover halves SHA-256 preimage strength to 128
  bits, which is sufficient.
- **Transport abstraction:** one interface, two implementations.
  - TCP via Node net, with manual length-prefix framing.
  - In-memory, linking node instances directly. Supports injected latency, drops, and
    partitions. Used to run many validators in one process for tests and demos.
- **Storage:** one key-value interface (get, range, atomic write, and a transaction
  spanning the stores of one environment), two implementations:
  a B+ tree in memory for tests and simulations, and LMDB (lmdb-js) on disk. LMDB is
  memory mapped, so reads are synchronous and the whole persistence path stays
  synchronous like the state machine it serves, and a transaction is durable before
  `transactionSync` returns. A data directory is claimed with a `LOCK` file holding
  the owner's pid, so a second node on it is refused; the CLI reads state through the
  RPC (section 9), never by opening the environment. One environment per node holds
  a `chain` store (blocks, commits and transaction results by height, heights by
  block hash, the transaction index by hash, validator sets by hash and by the
  height they sign, the lowest retained height, the headers a state-synced node
  keeps alone below its lowest block as far back as evidence may reach, chain
  state) and an `app` store (every object by id, counters, the version history of
  the provable window, account history, snapshot manifests and chunks, height and
  app hash). Validator sets are
  stored by hash because they rarely change and are 1.3 KB per validator; a header
  names its set by hash, so the set that signed any past height is two lookups away,
  which is what evidence verification needs. They are also stored by height, with
  proposer priorities, for a node joining by state sync (section 9). The double-sign
  guard (last signed height/round/step/bytes/signature) is its own file, written
  temp-fsync-rename before any vote is broadcast. The test app keeps a JSON snapshot.
- **Persistence order on commit:** app.finalizeBlock (in memory: begin-block steps,
  signature verification, the transactions, end-block, root), then save block +
  commit + results + the set for height+2 + new chain state (one transaction), then
  app.commit (one transaction with the objects that changed, the version's history
  and the account history entries), then pruning. On startup the node asks the app
  its height and replays any blocks the app missed, checking the app hash matches.

## 5. Signatures: ML-DSA-44 (post-quantum)

- **Scheme:** ML-DSA-44 (FIPS 204, NIST level 2) via `@noble/post-quantum/ml-dsa.js`.
  Used for validator votes and proposals, transactions, and p2p node identity. One
  scheme in the codebase.
- **Sizes:** public key 1312 B, secret key 2560 B, signature 2420 B.
- **Speed:** an external estimate taken when the scheme was chosen, not a measurement
  of this code base: noble pure-JS on an Apple M4, ML-DSA-65, about 294 sign/s and
  610 verify/s, ML-DSA-44 somewhat faster. Budget ~1 ms per verify. Hence the worker
  pool. The benchmark suite (`bench/crypto.bench.ts`) measures ML-DSA-44 as used
  here; `docs/benchmarks.md` has those numbers.
- **API:**
  ```ts
  const keys = ml_dsa44.keygen(seed32)
  const sig  = ml_dsa44.sign(msg, keys.secretKey, { context, extraEntropy: false })
  const ok   = ml_dsa44.verify(sig, msg, keys.publicKey, { context })
  ```
- **Deterministic signing:** `extraEntropy: false` everywhere, so a given signer
  produces the same signature for the same body every time. It does not make a
  transaction unique: ML-DSA verification accepts hedged (randomised) signatures too,
  a body may be signed by any subset of keys that satisfies its authorities, and the
  signatures may come in any order, so a body has several valid signed encodings.
  Identity is the body hash (section 7); every valid encoding is the same transaction
  to replay protection.
- **Domain separation via context:** `"<chainId>/vote"`, `"<chainId>/proposal"`,
  `"<chainId>/tx"`, `"<chainId>/p2p"`. A signature for one purpose can never verify as
  another. Context max is 255 bytes.
- **Key storage:** persist the 32-byte seed only. Derive the keypair at startup.
- **Addresses:** SHA-256 of the public key. Keys live in state, in account authorities
  (§7); a transaction signature carries the 32-byte address of its key, and the verifier
  resolves the key from the authorities the transaction requires. Keys are never sent
  with transactions.
- **Verify cache:** keyed by tx id and signer address, holding the hashes of the
  signature bytes that verified, so a second valid signature by the same key over the
  same body is verified and cached on its own. CheckTx verifies on mempool admission;
  FinalizeBlock consults the cache and verifies only what it has not seen, in one
  batch. The cached fact is pure crypto and never goes stale; authority thresholds,
  which depend on state, are rechecked every time. The cache holds 20 000 bodies and
  evicts the oldest.
- **Consequences accepted:**
  - a simple transfer tx is ~2.5 KB, nearly all of it the one signature.
  - a block commit is `48 + N + 2420 × S` bytes for N validator slots and S present
    signatures (height, round, block hash, a count, one presence byte per slot).
    100 validators all signing ≈ 242 KB per block. Light clients download full
    commits. Keep the validator set modest.

## 6. Application state: an object database with a Merkle root

The model is Graphene's (BitShares) object database, which has typed objects with
deterministic ids, multiple indices per type, and all consensus state in memory. It
lacks one thing this chain needs, a state root with inclusion proofs, and its dense
ids make adding one unusually easy.

- **Objects and ids.** Every piece of consensus state is an object with a type (16
  bits) and an instance number (48 bits in the id; the database refuses instances
  beyond 2^32 − 2, so an instance always indexes a dense array), packed into one u64
  id and written `type.n`. Instances come from a per-type counter, which is itself
  consensus state, and are never reused. Objects are immutable records, frozen
  through every nested object and array (a byte array cannot be frozen in
  JavaScript and is the one thing a caller must not write into); a modification
  replaces the object.
- **Why ids and not keys or names.** An ML-DSA public key is 1312 bytes. Referencing
  accounts by id keeps a transfer at about 40 bytes plus its signature; the key is stored
  once, in the account. Ids are also what makes the Merkle tree below trivial.
- **All consensus state in memory.** The disk holds a copy of every object (so a
  restart reloads rather than replays), the history of the provable window, account
  history and snapshots in the `app` store, next to the blocks the engine keeps.
  State is bounded by RAM, which is the Graphene trade-off made explicit. Encodings
  are binary and compact for that reason.
- **Indices.** The primary index of a type is an array: instance i is `objects[i]`, no
  hashing at all. A secondary index is a key encoder plus one ordered byte map. Keys are
  byte strings whose lexicographic order is the scan order: big-endian integers, strings
  with a zero terminator, compound keys by concatenation. A non-unique index appends
  the object id to the key, so a range query is a prefix scan. The ordered map is a B+
  tree with fan-out 32 (the tm2 shape, without its copy-on-write persistence, since
  indices are derived state): keys in sorted arrays inside each node, binary search at
  every level, iteration by a stack of (node, child) rather than leaf links, merges on
  underflow but no borrowing. The same tree is the in-memory key-value store. Indices
  are rebuilt on load; the B+ trees are not part of the root, while the unique indices
  that need proofs are authenticated by sparse Merkle trees whose roots are in the
  type leg (see "Authenticated indices" below).
- **Undo sessions.** Nested, Graphene style, with two uses: one session per transaction,
  undone on failure, and one pending session holding the mempool's speculative state,
  undone before every block and rebuilt by the engine's post-commit recheck. There is no
  block-level undo because blocks are final. The outermost open session doubles as the
  committed view: whatever it recorded as an old value is what was committed, which is
  what queries and proofs return while the pending session is open.
- **Merkle root, two dense trees.** Per type, a complete binary tree over instance
  numbers, padded on the right with the empty hash, so the shape depends only on the
  counter and the root climbs one level each time the counter crosses a power of two.
  Node (k, j) always covers leaves [j·2^k, (j+1)·2^k), so growth never moves a node.
  Above the types, one tree over the type leaves in type-id order. Hashing follows the
  ICS23 conventions of the tm2 B+ tree, so a standard ICS23 verifier with this spec
  (LeafOp prefix 0x00, key unhashed, value prehashed, varint lengths; InnerSpec child
  order [0,1], prefix 0x01, EmptyChild = H(0x02)) accepts both legs of a proof:
  ```
  leaf      = H(0x00 || varint(len key) || key || varint(32) || H(value))
              object leg: key = 8-byte id, value = encode(object)
              type leg:   key = 2-byte type, value = nextInstance || typeRoot || indexRoots
  inner     = H(0x01 || left || right)
  empty     = H(0x02); two empty children hash to empty, so an empty subtree of any
              height is one value and padding at every level is one EmptyChild
  appHash   = root over the type leaves in type order
  ```
  Nodes are stored per level in chunks of 1024 hashes, allocated when a node in the
  chunk is first set and released when its last node becomes empty, so memory follows
  the live objects rather than the counter: recent transaction ids, which come and go,
  cost only their live window. Changed objects are remembered and their paths
  recomputed in one pass at the end of each block, shared ancestors once.
- **Versions.** root(v) is called once per block with the height as the version. With a
  retention window (default 100 heights), every overwritten node hash is remembered as
  "before version v it was x", every overwritten object as "before v it was o", and
  every moved counter likewise. A proof at an older height reads each node, the
  object and the counter through those records; records that only serve heights
  older than the window are dropped after each root. Node positions never change, so
  there is no copy-on-write. The records of each version are written to the store
  with the block's changes and read back on restart, so the whole window is provable
  again after a restart. This is the role IAVL's versioned nodes play in Cosmos,
  reduced to an undo log because the tree is dense.
- **Proofs.** An object's proof names its height and carries its encoding, the sibling
  hashes up its type tree, the type's counter, the type's position among the types, and
  the siblings up the top tree. Absence has two shapes: an instance at or past the
  counter needs no path, since the counter is bound into the type leaf; a removed
  instance has an empty leaf on an ordinary path. The verifier (`src/db/proof.ts`)
  depends on nothing else, for light clients. A proof is about one height: the node
  serves it (`queryState`, `queryAccountName`) with header height+1, whose app hash
  commits to that state, and that header's commit.
- **Light client** (`src/light/client.ts`). Holds one trusted signed header with the
  validator sets around it, obtained from a height and hash trusted out of band, and
  moves trust forward the Tendermint way: the next header must be signed by the set
  the trusted header named; a later header is accepted when +2/3 of its own set
  signed it and more than a third of the set the trusted header promised for its next
  height is among the signers; otherwise it bisects. Trust expires after a trusting
  period, and headers may not come from the future beyond a clock drift. A state or
  key query is checked by verifying the header after the proven height, comparing it
  with the one the node sent, and checking the proof against its app hash. A height
  before the trusted one is reached backwards: each header must hash to what the one
  above names as its last block hash, and no commit is needed, since the trusted
  header stands for the whole chain before it; the walk is bounded (100 000 headers)
  and the trusted header stays put. The provider interface (signed headers, headers
  alone and validator sets by hash) is what an RPC client would implement; the one
  here reads a node in the same process.
- **Authenticated indices.** A unique index can be marked authenticated; the account
  name and asset symbol indices are. Such an index also keeps a compacted sparse
  Merkle tree (`src/db/smt.ts`, the Jellyfish shape) over sha256 of its keys, and the
  roots of a type's authenticated indices go into its type leaf after the counter and
  type root. A key proof is the sparse tree's path (membership, an empty slot, or
  another leaf that owns the subtree, which proves absence) plus the same type leg,
  so "no account named alice" is provable. The B+ tree is not hashed on purpose: its
  root would depend on node layout, which depends on the order of writes, and a node
  rebuilds its indices from objects on restart. The sparse tree has one shape per key
  set, so every node, after any history, hashes alike; that is also what lets past
  index versions be rebuilt from the object history after a restart instead of
  persisting tree nodes. Nodes are immutable and writes copy the path, so a past
  version is a root pointer. Lookups by owner and similar non-unique indices stay
  unauthenticated.
- **Deferred execution caveat.** The state after block N is committed to by the app
  hash in header N+1, so a proof about height N is checked against header N+1 and
  that header's commit.
- **Persistence and recovery.** State lives in memory; the key-value store holds a copy
  of every object. Each root() reports the objects that changed and the counters that
  moved, and the app's commit writes exactly those plus the height and app hash in
  one LMDB transaction. On start the app reads everything back, rebuilds indices and
  trees, checks the root against the stored app hash, and the engine replays the
  blocks after it through the existing info() handshake. Nothing speculative is ever
  written: the pending session is undone before the block runs.
- **Reads.** With ids, a read by id is one map lookup for the type and one array
  access for the instance; nothing is hashed. Name and symbol lookups go through the
  B+ tree of their index, and a proof's length grows with the height of the type's
  dense tree (the log of its counter), so those paths do depend on state size, though
  the measured throughput was flat at the sizes tried (`docs/benchmarks.md`). The
  signature cache is the one hash-map lookup on the hot path, on short keys. Nothing
  here benefits from perfect hashing: the key sets that would (operation tags, message
  types) are already small integers in the binary codec.

## 7. Application: accounts, tokens, balances

The first real application on the object database, BitShares style.

| type | id | indices | holds |
|---|---|---|---|
| global | 1 | | core asset id, fee schedule (FEES.md), max transaction expiration, staking parameters |
| dynamic | 2 | | height, last block time, community pool, inflation, bonded total, the active set and the expected signers (STAKING.md) |
| account | 3 | byName (unique, authenticated) | name, owner authority, active authority, registrar |
| asset | 4 | bySymbol (unique, authenticated) | symbol, precision, issuer, max and current supply |
| balance | 5 | byOwnerAsset (unique), byAsset | owner, asset, amount |
| recentTx | 6 | byTxId (unique), byExpiration | a tx id kept until it expires |

- **Accounts** are named. Names are 3 to 63 characters of lowercase letters, digits and
  hyphens in dot-separated segments that start with a letter. An account has an owner
  authority and an active authority. An authority is a threshold plus weighted members,
  each a public key or another account; it is satisfied when the weights of the signing
  keys, plus those of member accounts whose active authority is satisfied, reach the
  threshold. Recursion stops at depth 2. Owner can change everything including itself;
  active everything else; an owner signature also satisfies an active requirement. A
  new account is registered by an existing one, the registrar, which pays the fee.
  Genesis accounts register themselves; the first one, `3.0`, issues the core asset.
- **Assets** have a symbol (3 to 16 uppercase letters and digits), a precision, an
  issuer, and a maximum supply of at most 10^15, which keeps every sum of balances
  inside a u64. Only the issuer can issue, up to the maximum. The core asset is created
  at genesis as `4.0` with the genesis balances and community pool as its supply; it
  pays fees and is the staking token, and nobody issues it, its issuer included: its
  supply grows only by the mint (STAKING.md).
- **Balances** are one object per (account, asset), created on first receipt and kept
  at zero rather than removed, so ids stay stable. The byAsset index lists holders.
- **Transactions** are an expiration time, a list of operations (at most 64) and a
  list of signatures (at most 16). The signed message is the body (expiration and
  operations); its hash is the tx id, which is what replay protection remembers. The
  engine, the RPC, the transaction index and account history name a transaction by
  the hash of its full signed bytes instead, so one body signed twice, or by a
  different satisfying subset of keys, is one transaction to the application and two
  to the mempool and the index. Each signature is a 32-byte key address plus the
  2420-byte signature; the key is resolved from the authorities the operations
  require, walking member accounts to depth 2. A signature by any other key, or two
  by the same key, is rejected, as in BitShares; beyond that any satisfying subset of
  keys in any order is accepted, and so is a hedged ML-DSA signature, so a body has
  several valid signed encodings. Replay protection is the expiration plus the set of
  unexpired tx ids, pruned at the start of every block. There are no account nonces,
  so independent transactions from one account never wait for each other, and a
  transaction signed by several accounts needs no agreement on whose nonce to use.
  The expiration must be after the current block time and within the window in
  `global` (default one hour).
- **Operations** and what they require:

  | operation | authority | fee payer |
  |---|---|---|
  | transfer(from, to, asset, amount) | active(from) | from |
  | accountCreate(registrar, name, owner, active) | active(registrar) | registrar |
  | accountUpdate(account, owner?, active?) | owner(account) if owner changes, else active | account |
  | assetCreate(issuer, symbol, precision, maxSupply) | active(issuer) | issuer |
  | assetIssue(issuer, asset, to, amount) | active(issuer), issuer must own the asset | issuer |

- **Fees** follow a BitShares-style schedule in `global` (`FEES.md`): a price per
  operation type, with premium names, short symbols and per-kilobyte data priced on
  their own, and a scale that moves everything at once. Every operation states the
  fee it pays; the chain refuses it below the schedule and charges what was stated,
  so a signer never pays more than it signed for when validators change the
  schedule. Fees are paid in the core asset before the operation runs and go to the
  community pool. A transaction that fails inside a block has no effect and pays
  nothing; proposers only include transactions that passed the mempool, so this is
  rare, and it will be revisited with the fee market if there ever is one.
- **Applying a block:** undo the pending session; open a block session; prune expired
  tx ids; run the staking begin-block steps (STAKING.md section 7); verify every
  uncached signature in one batch on the worker pool (a cache entry says only that a
  signer signed a body, which no state change can invalidate); then for each
  transaction in order, resolve the signers' keys against the state as it stands at
  that point, check the thresholds and apply in its own session; run end-block (the
  proposal tally and the active set); update `dynamic`; commit the block session and
  compute the root for the height; reopen the pending session. If anything throws on
  the way (a verifier gone away), the block session is undone and the database is as
  the previous block left it. The commit that follows writes the changed objects to
  the store. CheckTx does the same for one transaction inside the pending session: a
  transaction that passes stays applied there, so transactions queued behind each
  other are checked in sequence against each other's effects; a check that overlaps a
  block in progress waits for the block and is then checked against the new state,
  and the pending session is undone before every block.
- **Concurrency:** signature verification is the only await. Everything that touches
  the database is synchronous and runs after it, so sessions nest cleanly even though
  checkTx calls overlap each other and finalizeBlock.
- **Validators** come from the application: the active set it computes at the end of each
  block is handed to the engine as updates (section 8 and STAKING.md).
- **Genesis** (`appState`, JSON): the core asset's symbol, precision and max supply; the
  fee schedule (any subset, over the defaults); the expiration window; and the initial
  accounts with their authorities (public keys in hex) and core balances. A small one
  is inline in `genesis.json`; a large one (a token distribution: hundreds of
  megabytes of public keys, beyond what V8 holds as one string) is named by
  `appStateFile` and read as a token stream with `stream-json`, one account at a
  time (`loadAppGenesis`), only at first start, since afterwards the store has the
  state. The encoded change list of a version is dropped once the store has written
  it, so genesis does not keep a second copy of every object in memory.

## 8. Staking

Specified in `STAKING.md` and implemented in `src/app/core/staking.ts` with the
object types in `types.ts` and the operations in `evaluate.ts`: delegated stake with
an exchange-rate share model, a top-N validator set owned by the application, a
community pool fed by fees and a bonded-ratio-targeting mint paying a fixed reward
per block, double-sign and downtime slashing, 7-day unbonding, redelegation, and
parameter changes by validator proposals. The engine changes it needed: commits are
completed with precommits that arrive during the commit timeout, evidence age is a
duration by block time equal to the unbonding period, and genesis may leave the
validator list to the application. Inflation is kept in parts per billion so a
one-second block can move it. The signer share of a block reward is computed on the
stake as it stood before the proposer bonus.

## 9. Transaction proofs, RPC and sync

Specified in `RPC-SYNC-PROOFS.md` and implemented. The header carries a protocol
version, a Merkle data hash over transactions and a results hash for the previous
block's results (`src/types/txproof.ts`); the chain store indexes transactions by
hash and the application keeps per-account history with virtual entries
(`src/app/core/history.ts`). `src/rpc/` is JSON-RPC 2.0 over HTTP on `node:http`
with Server-Sent Events, per-address token buckets and a body limit; `src/wallet/`
is the scrypt and AES-GCM keystore; the CLI is an RPC client and the light client
has an RPC provider. `src/app/core/snapshot.ts` exports chunks with range proofs
every K blocks; `src/sync/statesync.ts` joins from a trusted header through the
light client, verifies every chunk, and `src/sync/blocksync.ts` requests windows
of blocks from several peers, backfills older blocks by hash chain, and serves
both. Evidence travels by inventory; a block that +2/3 precommitted but was never
proposed to a node is fetched and decided in place; peers are scored and banned
(`Network.score`); the executor prunes blocks behind a retention window but never
past the newest snapshot nor into the evidence window (blocks whose time is within
the unbonding period of the latest stay, since evidence is checked against the set
and time of its height). A node joining by state sync also fetches the headers below
the snapshot as far back as evidence may reach, each bound to the one above by its
hash, and keeps them alone until the window moves past them or backfill replaces
them with blocks, so it checks evidence as a node that replayed from genesis does;
the state, the block, the sets and the header marker are installed in one
transaction across both stores, so an interrupted join is simply retried. Evidence
for a height whose validator set a node does not hold halts it rather than being
skipped: a block applied without it would hand the application a different
misbehaviour list than every other node and diverge the state. Validator sets are
also stored by the height they sign, priorities included, because a state-synced
node must continue consensus with the exact proposer priorities.

## 10. Implementation status (2026-10-28)

Everything above is implemented in TypeScript under `src/`. 132 tests in 19 files
pass. The engine
tests (consensus, recovery, network, units) run on the key-value test app; the
database and application have their own suites, and one test runs the core application
on a live four-validator network with a full node, gossiping signed transactions and
checking a proof from one node against the app hash in the next header on every node,
then querying a past height and a name and verifying them with the light client. A
separate test grows a validator set and shrinks it past the trust level and watches
the light client bisect. The staking suite walks every rule one block at a time with
a supply invariant checked after each scenario, and a network test runs an
application-owned set through delegation, a stopped validator being jailed, its
return by unjail, and a light client following the whole sequence. The fee suite prices
operations against the schedule (FEES.md), checks that a stated fee is what is charged,
and adopts a schedule change by proposal, after which a transaction priced under the
old schedule fails instead of paying more.

| module | what it is |
|---|---|
| `src/codec/` | deterministic binary writer and reader |
| `src/crypto/` | sha256, ML-DSA-44 keys and signing, verification worker pool |
| `src/types/` | validator set and proposer selection, votes, evidence, blocks, proposals, genesis, chain state |
| `src/consensus/` | the Tendermint state machine, vote sets, evidence pool, private validator with double-sign guard, block validation |
| `src/mempool.ts` | FIFO pool with checkTx admission and post-commit recheck |
| `src/p2p/` | transport interface, in-memory and TCP transports, wire messages, peer database, network with handshake and peer exchange |
| `src/node/` | block executor with crash recovery, and the node that wires everything |
| `src/db/` | object ids, index keys, B+ tree, sparse Merkle tree, per-type indices, dense Merkle tree with chunks and versions, ICS23-shaped object and key proofs, the database with undo sessions and persisted history |
| `src/store/` | key-value interface with environment-wide transactions, in-memory and LMDB stores, block store on top with headers kept alone |
| `bench/` | benchmarks (`npm run bench`): crypto, codec, database, store, application, a four-validator network with block sync, and (`npm run bench:genesis`) a gigabyte genesis: load time, memory, disk, reads at that size, restart, then at that scale a live node serving RPC under load, scattered batch transfers, proofs at past heights, history, and a state-sync import |
| `src/light/` | light client with bisection forward and the hash chain walked backward, node-backed and RPC providers, and the checks on state, key and transaction queries |
| `src/rpc/` | JSON-RPC server with events and limits, JSON shapes, methods, a fetch client |
| `src/wallet/` | encrypted keystore, written under a lock file |
| `src/sync/` | batched block sync with backfill, and state sync from snapshots with the headers of the evidence window |
| `src/p2p/request.ts` | request and response matching over the peer protocol |
| `src/app/core/` | authorities, names, object types, transaction format, evaluators, staking rules, genesis, the core application, a signing client |
| `src/app/` | application interface and the key-value test app used by the engine tests |
| `scripts/localnet.ts` | N validators in one process driving the core app from a faucet |
| `src/cli.ts` | init a TCP testnet, start a node with its RPC, keys, accounts, transfers, staking, history, proofs and light-client verification over the RPC |

Known simplifications, all deliberate and all revisitable:

- Amnesia evidence (locking rule violations) is not detected. Only duplicate votes are.
- Vote verification is not rate limited per peer.
- Non-unique indices (balances by owner, transactions by expiry, validators by power)
  are not in the state root; only the authenticated unique indices are: account
  names, asset symbols, validators by operator and by current consensus address, and
  delegations by (delegator, validator).
- A state-synced node has account history only from its snapshot height; backfilled
  blocks carry no execution results, so their transactions are indexed as not
  executed here.
- The RPC has no authentication; it is meant for loopback or a query node behind a
  proxy.
- A delegator who redelegates away from a validator and then undelegates from the
  destination escapes a later slash of the source, as in Cosmos.
- Proposer priorities are not covered by the validator set hash. A node joining by
  state sync checks that the sets it is given pick the proposers the chain actually
  used at the snapshot height and the one after, and derives nothing else from them;
  a peer could still craft priorities that pass that check and diverge later.
- The light client's trusting period is the client's choice and must stay below the
  chain's unbonding period; the engine's evidence age follows the unbonding period
  automatically.

`REVIEW-2026-10-28.md` records an external review of the whole codebase and what was
done about each finding.
- History records are written in full per version and read back on restart, so the
  provable window survives a restart; replaying the blocks missed while down then
  advances the window and drops the versions that fall out of it. A node that joined
  from a snapshot can prove nothing before the snapshot height.
- A failed transaction inside a block pays no fee.
- A validator restarted in the middle of a height forgets its lock: the sign state keeps what
  was signed, not the locked block, so after a restart it may prevote another block in a later
  round of that height. Tendermint's accountability for this (amnesia evidence) is not implemented.
- The node defaults to the inline verifier; the CLI, the local network script and the
  benchmarks pass the worker pool. A node built from code should do the same.
- Index roots inside a type leaf are the SMT roots at that height; the B+ tree indices used for lookups are not authenticated.
