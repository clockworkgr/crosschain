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
- **Validator keys:** ML-DSA-44 or secp256k1, one scheme per chain, named by genesis
  (see §5). No aggregation exists for ML-DSA and none is used for ECDSA, so commits
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
export interface Application {
  initChain(genesis: Genesis): Promise<InitChainResult>;
  checkTx(tx: Uint8Array, opts?: CheckTxOptions): Promise<CheckTxResult>;
  finalizeBlock(req: FinalizeBlockRequest): Promise<FinalizeBlockResult>;
  /**
   * Persist the block just finalized. An application that keeps its state in the engine's store environment does
   * its writes before its first await, so that they join the transaction the engine saves the block in (executor.ts).
   */
  commit(): Promise<void>;
  info(): Promise<{ lastHeight: bigint; lastAppHash: Uint8Array }>;
}
```

Every method is asynchronous (`src/app/types.ts`). `checkTx` is the mempool's admission
check, `finalizeBlock` returns the app hash, the transaction results and the validator
updates, and `info` is the crash recovery handshake. `FinalizeBlockRequest` is what the
executor extracts from a decided block: height, time, the transactions, the proposer
address, the addresses whose precommits are in `lastCommit`, and the misbehaviour the
block's evidence proves. `checkTx` takes an optional `admit` function (`CheckTxOptions`),
which the mempool passes: the application asks it after its last wait, just before the
transaction would go into its pending state, and a transaction the pool no longer takes
(paused, or filled meanwhile) is refused and leaves nothing behind. A transaction the pool lets
through holds a place in it from that answer on (`Mempool.reserved`, counted with the pooled
transactions against the limit and given back on every way out of the check), so of several
transactions checked at once no more are let through and applied than the pool has room for. `initChain` returns `{ appHash, validators? }`; a non-empty
`validators` replaces the genesis list (STAKING.md section 2.3).

- **Execution model:** deferred. Header of block N carries the app hash from executing
  block N-1.
- **Mempool:** consensus receives a tx, calls CheckTx, and if valid stores it and floods
  it to peers. Seen-cache prevents re-gossip loops; a transaction still in the pool counts
  as seen whether or not the cache still holds it. After every commit, all pending txs
  are re-checked and failures evicted. The app keeps a scratch state copy for CheckTx.
- **Block proposal:** proposer reaps txs from mempool (FIFO, bounded by max bytes) and
  sends the whole block in one proposal message. Block parts only if blocks grow large.
- **Block sync:** lagging nodes fetch committed blocks + commits from peers and replay
  through the app. Separate from consensus gossip.
- **Crash recovery:** on startup, consensus calls Info() and replays any blocks the
  app has not committed. A node that holds its own application saves a block and the
  application's state in one store transaction (section 4), so only an application that
  keeps its state elsewhere can be found behind.

## Open questions

- Tx gossip is flood-to-all. Fine for small validator sets; revisit if it grows.

## 3. P2P networking (Graphene / BitShares model)

- **Topology:** flat. One TCP stream per peer, one message type field, no channel
  multiplexing. After the handshake, inbound and outbound peers are indistinguishable.
- **Node identity:** long-lived node keypair of the chain's signature scheme (§5). Node
  id = SHA-256 of the tagged public key.
- **Handshake (mutual, nonce-bound, 1.5 round trips, no ECDH):**
  - A connects and sends hello_A: chain id, node pubkey, 32-byte nonce, advertised
    inbound addr:port, last committed height, user agent.
  - B replies hello_B (same fields, own nonce) plus sig_B over (hello_A || hello_B).
  - A replies auth_A: sig_A over (hello_A || hello_B).
  - Either side may instead send reject: wrong chain, connected to self, already
    connected to this node id, not accepting connections, invalid hello or signature.
  - Signatures use the chain's scheme with context "<chainId>/p2p"; a hello whose key
    is not a well-formed tagged key is rejected. The nonces bind each signature to
    this session, so there is no replay and no need for a shared secret.
  - Transport: authenticated, not encrypted. Every consensus message and tx is
    independently signed, so confidentiality adds nothing. X25519 is dropped entirely.
- **Framing:** 4-byte length, 1-byte message type, binary payload (see §4 codec).
- **Peer database:** persisted. Per endpoint: last seen, last outcome (never connected,
  connected and disconnected, connect failed, rejected, handshake failed), success and
  failure counts. Address request / address reply messages exchange entries. (The
  implementation keeps last seen, the success and failure counts and the ban state of
  an address, at most 4096 entries; the outcome enumeration was not needed. One
  successful outbound dial counts one success. The file is written beside itself and
  renamed into place, and one that cannot be read is taken as empty, the node starting
  from its seeds. One address reply is taken for each address request the node sent
  that peer; any other is ignored.)
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
  The pong also carries the answerer's clock, from which the asker reads how far the
  peer's clock is ahead of its own: the peer's clock when it answered, plus half the
  round trip, less its own clock on receipt (`Peer.clockOffsetMs`, in the RPC's
  `peers`). A pong whose round trip is negative or longer than the idle timeout is
  ignored. A peer is logged when a pong first shows it 2 s or more off, and again each
  time its offset reaches 2 s after a pong that showed less. The offset is what
  the peer claims, good for noticing a wrong clock and nothing more; block times are
  checked against the local clock alone.
- **Gossip, two modes:**
  - **Inventory (announce hash, peer fetches):** transactions. Seen-cache per item type.
    "Item not available" as the negative reply. An item is taken only from a peer it
    was fetched from, as the kind it was fetched as and within a minute of its first fetch (after
    10 s without an answer it may be fetched from another peer as well, four at most); any other
    is dropped unread, without a score. Fetches are remembered by kind and hash, 20,000 at most and
    2,048 for one peer, which is then asked nothing more until answers or the minute free places,
    so peers that announce and never answer cannot make a node remember without limit. When the
    20,000 are in use only the hash there is no place for is passed over, not the rest of the
    announcement, and a peer that disconnects is taken out of every fetch still outstanding, so
    what it announces after it reconnects is asked for again. Committed blocks are announced by a
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
- **Misbehaviour:** an invalid message costs its sender points, by the offence: 20 for
  a message that does not decode, 5 to 50 for the others the consensus, evidence, fetch
  and sync code charge for. Points decay by one a minute, and at 100 the peer is
  disconnected and banned. A failure mark in the peer db is for a dial that did not
  become a peer. Scoring and bans came with stage three (section 9). A ban names the peer's node id
  and, for a peer this node dialed, the address as it was dialed (`Peer.dialedAddr`),
  which is the record the peer database holds and the one the connect loop would pick
  again; an inbound peer's address is not known to be its own, so only its id is
  banned. A peer's advertised address and the name it was dialed by are separate
  records, and when two nodes dial each other and the inbound connection survives, the
  dialed address is dialed again, with the usual backoff.

## 4. Implementation

- **Language / runtime:** TypeScript on Node, strict mode, ES modules. Purpose: a
  readable learning implementation, so clarity beats throughput.
- **Concurrency:** single-threaded event loop. Consensus state machine has no locks.
  Round timeouts are setTimeout.
- **Worker pool, verification only:** Node worker_threads, size = cpu count - 1 and at least 1. A job
  is a batch of (sig, msg, pubkey, context) and returns booleans. In a node the main
  thread never calls verify directly; the tests and the CLI's light client (`account`,
  `verify-tx`, `light`) verify inline, on the main thread. A node given no verifier makes a pool of its
  own and closes it when it stops; several nodes in one process share one and pass
  it. Signing stays on the main thread: once per
  consensus step, ~3 ms under ML-DSA-44 and a twelfth of that under secp256k1, and it
  keeps the persist-then-broadcast order of the double-sign guard trivial.
- **Integers:** heights, times, amounts and voting power are BigInt. Plain numbers are
  doubles and carry only bounded integer fields whose encoding is u8, u16 or u32:
  rounds, the protocol version, basis-point rates, counters, instance numbers. Where
  a 64-bit field is used as a plain number (a proposal's lock round, a validator
  set's proposer index, a snapshot chunk's range, the database's counters), the
  decoder refuses a value beyond `Number.MAX_SAFE_INTEGER` (`Reader.u53`, `i53`):
  rounded, two encodings would decode to one value. No
  floats in state.
- **Codec:** hand-written binary encode/decode per message and per state object,
  Graphene raw-serializer style. Deterministic by construction. JSON is not used for
  anything that gets hashed or signed.
- **Crypto:** @noble/post-quantum ML-DSA-44 or @noble/curves secp256k1 for every
  signature, one scheme per chain (see §5). SHA-256 from Node built-in crypto for
  hashing. Grover halves SHA-256 preimage strength to 128 bits, which is sufficient.
- **Transport abstraction:** one interface, two implementations.
  - TCP via Node net, with manual length-prefix framing.
  - In-memory, linking node instances directly. Supports injected latency, drops, and
    partitions. Used to run many validators in one process for tests and demos.
- **Storage:** one key-value interface (get, range, atomic write, and a transaction
  spanning the stores of one environment), two implementations:
  a B+ tree in memory for tests and simulations, and LMDB (lmdb-js) on disk. Both apply
  the puts and deletes of one write in the order given, so a key put and then deleted in
  one write ends deleted in either. LMDB is
  memory mapped, so reads are synchronous and the whole persistence path stays
  synchronous like the state machine it serves, and a transaction is durable before
  `transactionSync` returns. A data directory is claimed with a `LOCK` file holding
  the owner's pid, so a second node started on it while the owner runs is refused. The
  pid is written to a private file, `LOCK.<pid>.<8 hex>`, which is hard-linked to `LOCK`
  and then unlinked. The link fails when a `LOCK` is there, so of two nodes started at
  the same moment one makes it and the other reads its pid, and `LOCK` never exists
  without a pid in it: a claim created empty and filled afterwards could be read as
  stale in between, and both would start. A file left by a process that no longer runs
  is removed and the link tried again. The removal is done only by a process that holds a second
  exclusively created file, `LOCK.takeover`, and only after it has read the claim again
  and found it still stale, so of two processes that find the same stale file at the
  same instant neither can remove the other's new claim and one gets the directory. A
  process that finds `LOCK.takeover` there waits 20 ms and tries again. Fifty attempts
  are made in all, whichever way each ended, about a second when that file is in the
  way, and then the start fails naming the file. Releasing removes `LOCK` only if it
  still holds this process's pid. Two nodes in one process are told apart by the directory's
  real path, however it was spelled or linked to. The claim is released last when a node
  stops, after the network has stopped, the block being applied has finished its writes
  and the store is closed. `stop` takes an optional function, which the node waits for
  once it has stopped what it runs (consensus, block sync, the network) and the block
  being applied has finished, and before it closes the store, so that whoever still
  reads the store can be done first: the CLI passes the RPC server's stop, and a request
  still being served reads a store that is still open. The RPC server's stop, once its
  connections are closed, waits one second at most for the requests it was still
  handling, each until its method has returned and its answer is written, and answers
  one that reaches dispatch after the stop began with code -32000, `server is stopping`:
  a method that was waiting when its connection was cut, a broadcast waiting on the
  mempool for one, has ended before the store is closed if it ends within that second.
  One that takes longer is not cancelled, and the store is closed without it. The same
  holds inside the node: stopping consensus and block sync does not end work of theirs
  that is suspended on a signature verification or on a request to a peer. Such work
  ends when it resumes. A proposal whose signature was being verified and a backfill
  step whose request or commit verification was out each check that they are still
  running after the wait and return, and anything else that reaches the store finds it
  closed: from the moment `LmdbEnv.close()` is called, every `get`, `range`, `write`,
  `store()` and `transaction()` of that environment throws `StoreClosedError`, `the
  store is closed`, so the call fails in JavaScript and never reaches the native library
  after the environment is gone. An iteration is checked before every step, so one begun
  before the close and stepped after it throws at that step, and the writer a `write`
  hands its callback is good only during the callback: used afterwards it throws. An RPC
  method that outlived the server's wait gets that
  error, and its handler turns it into an error answer on a connection already cut. Work
  the node began for a peer's message and did not wait for (a proposal, a vote, a fetched
  block, a transaction or evidence item) is handed to one place, `detached`, which takes
  whatever it ends with and logs `handling a <what> failed`, at `warn` while the node
  runs and at `debug` once it is stopping: such work that resumes to a closed store or a
  closed verifier pool ends there. A
  stop also waits for a start still on its way: `start()` is one promise, it marks the
  network as started before it waits for it, and after each of its waits (the network,
  the collection, the memory guard's first sample) it goes no further if a stop has
  begun, so a stop that overtakes a start leaves nothing running. A memory guard
  stopped by a listener during its first sample stays stopped. Every step of the node's stop
  (waiting for a start in progress; stopping consensus, block sync and the network; waiting for the block being applied;
  the caller's function; closing the store; closing a verifier pool the node made) is
  tried whatever the ones before it did, the claim is released last, and the first
  failure, whatever value it is, is the one `stop` rejects with. The CLI's `start` sets
  up its signal handlers before it makes the node. A signal that comes while the node is
  being made is acted on once it is made, and the node is then stopped as usual; if the
  node has not been made five seconds after such a signal the process exits as it is,
  which leaves the claim of a process that is gone for the next
  start to take over. A failure of the node's start or of the RPC server's (its address
  in use, for one) is logged as `start failed` and the node is stopped like any other
  before the process exits with status 1, so the store is closed and the claim
  released; a failure while stopping is logged as `stopping failed` and the exit status
  is 1 unless it was already another. The CLI's `start` passes its node the data directory alone: the node claims
  the directory and then opens the LMDB environment, so a second `start` on a directory
  in use is refused before it has opened anything there. The node closes the store it
  opened and also one it was handed for a directory it holds the claim on, as a test or
  a program that embeds a node may hand one: the claim says nobody else writes there, so
  it is not given up while that store is open. Closing an LMDB environment twice is
  closing it once, and every caller is handed the one close to wait for, so the caller
  closing its store again after `stop()` does nothing. Stopping a node twice is stopping
  it once in the same way: `stop()` hands every caller the one shutdown, so two callers
  stopping at once both wait for it, only the first caller's function is waited for,
  and the claim is released when it is done. The verifier pool is closed before the release
  if the node made it; one the caller passed in is the caller's to close. A node that
  fails while it is created gives back what it opened, the claim included, before the
  caller sees the error. A failure in the constructor, which cannot wait, is thrown
  with its cleanup; `Node.create` waits for the cleanup (the store closed if it is the
  node's own or lies in a directory the node claimed, a verifier pool the node made
  closed, the claim released last) and then throws the original error. A failure after
  that goes through `stop()`. The claim is a file and not an operating system lock,
  which leaves these things: it trusts the pid, so a pid given since to an unrelated
  process makes a stale claim look live; a process killed in the few file operations
  for which it holds `LOCK.takeover` leaves that file behind, to be removed by hand
  (while a stale `LOCK` is there too no start can take it over; with no `LOCK` a start
  claims the directory without looking at it); a
  process killed between writing its private file and unlinking it leaves that file,
  which is harmless and can be deleted; and the directory must be on a filesystem that
  has hard links. The CLI reads state through the
  RPC (section 9), never by opening the environment. One environment per node holds
  a `chain` store (blocks, commits and transaction results by height, heights by
  block hash, the transaction index by hash and height, validator sets by hash and by the
  height they sign, the lowest retained height, the headers a state-synced node
  keeps alone below its lowest block as far back as evidence may reach, chain
  state) and an `app` store (every object by id, counters, the secondary index
  entries, the Merkle trees' chunks and nodes, the version history of
  the provable window, account history, snapshot manifests and chunks, height and
  app hash; section 6). Validator sets are
  stored by hash because they rarely change and are 1.3 KB per validator under
  ML-DSA-44 (50 B under secp256k1); a header
  names its set by hash, so the set that signed any past height is two lookups away,
  which is what evidence verification needs. They are also stored by height, with
  proposer priorities, for a node joining by state sync (section 9); that record is
  deleted with the block of its height when the block is pruned. A set by hash goes
  once the heights that carried its hash are pruned and no header still held names it,
  as `validatorsHash` or `nextValidatorsHash`, and the current state does not use it. The double-sign
  guard (last signed height/round/step/bytes/signature) is its own file, written
  temp-fsync-rename before any vote is broadcast. The test app keeps a JSON snapshot of
  its entries and its validator set.
- **Persistence order on commit:** app.finalizeBlock (in memory: begin-block steps,
  signature verification, the transactions, end-block, root), then save block +
  commit + results + the set for height+2 + new chain state (one batch of the chain
  store), then app.commit (the objects that changed, the version's history and the
  account history entries, one write of the application store), then pruning. When the
  node created the application itself, so that both stores are in its one environment,
  the executor runs the two inside a single store transaction (`ExecutorDeps.transaction`,
  `src/node/executor.ts`): the block and the state it produced land together or not at
  all, and the device is flushed once per block. That holds for a failure of the
  application's write too. `CoreApp.commit` is not an async function: a store write that
  fails throws where `commit` is called, inside the transaction, which is aborted with
  the block, the validator set and the chain state the executor had written in it, and
  `applyBlock` rejects with the chain state as it was before the block. (An application
  that has a synchronous `commitSync()` is committed through that instead, to the same
  effect.) The application's memory is then a block ahead of the store, and applying the
  block again makes it refuse everything (section 7), so the node needs a restart, which
  finds the chain and the application at the same height. Only what an application does
  after an await, or a snapshot `CoreApp` takes after its write, fails by rejecting the
  promise: the chain's writes have landed by then, and the block's own if it was the
  snapshot that failed. The flush is what a commit mostly costs
  and where its variance is: the application's commit of a 500-transfer block at 192,000
  accounts measured 17 to 26 ms of LMDB's own work and 40 to 120 ms with the flush
  (`F_FULLFSYNC` on macOS), and a block used to pay for two. (The 17 to 26 ms
  were measured with the account history keyed by account, most of the growth between the
  two figures; it is now a log appended to in block order, section 9, and the same commit
  measured 15 to 19 ms in the same ablation. With its flush it takes 46 to 58 ms in the
  mode table of docs/benchmarks.md section 4.13.) `Application.commit` is
  asynchronous, and what it writes before its first await is what joins the transaction;
  `CoreApp` writes everything there. An application handed to the node (`cfg.app`) keeps
  its state elsewhere and commits after the chain store has, in a transaction of its own.
  So on startup the node still asks the app its height and replays any blocks the app
  missed, checking the app hash matches: that covers the application that commits
  separately.
- **Memory guard and collection scheduling** (`src/node/memory.ts`): the state lives
  in the V8 heap, so the ceiling that matters is the heap limit, past which the process
  aborts with no chance to stop cleanly, and V8's default is a few gigabytes whatever
  the machine has. The node samples the heap every second and holds one of four levels
  by how full it is: `ok`; `warn` at 70% of the limit, which starts a major collection and
  pages what a block does not need, the index trees if the node keeps them in memory and most of the history window (below);
  `pressure` at 85%, which sheds load: costly RPC methods and new event
  streams are refused, the signature cache is dropped (a transaction being verified keeps
  the signers it found, so a block's results do not depend on when that happens), while
  consensus and block sync keep running on whatever is pooled, since a validator that
  stopped voting would be jailed; `critical` at 95%, on which the CLI stops the node
  cleanly and exits with code 3, so a supervisor restarts it with a larger limit instead
  of finding a dead process (the heap is sampled, so an allocation that fills what is
  left between two samples still aborts the process). The mempool is not paused under pressure. Its limit follows
  the level instead (`Node.MEMPOOL_SHARE`, `Mempool.setLimit`): the pool admits up to its
  whole limit at `ok`, half at `warn`, a tenth at `pressure` and nothing at `critical`
  (10,000, 5,000, 1,000 and 0 transactions). Lowering the limit evicts nothing: what is
  pooled stays and is still reaped, and admission begins again once blocks have taken the
  pool below the limit, a check already under way when the limit is reached being refused
  too. A transaction refused at a lowered limit is `full` with an error that says so, which
  `broadcastTx` answers with `-32004` (try again later) while the level is not `ok`; a
  pool that would refuse fetches no transaction its peers announce. Only at `critical` is
  the pool paused (`node out of memory`). `broadcastTx` is a costly method but is not
  refused while the node sheds load, as the others are: the lowered limit is its throttle,
  so a client's transaction gets in whenever a block has made room. Levels are hysteretic, left 5 points below the threshold
  they were entered at, so a heap hovering at a threshold does not flap, and one sample
  may cross several. Each level also turns the object database's dials (section 6;
  `STATE-PAGING.md` section 7), tabled below, so a filling heap trades speed for room
  before anything is refused. The scheduler
  moves collections to known moments: right after each
  commit, when the node idles until the next proposal, a minor collection runs
  synchronously and, once the heap has grown since the last major collection by 256 MiB
  or a tenth of the limit, whichever is less, a major one starts asynchronously, so V8
  rarely picks its own moment inside a round; both need `--expose-gc`, without which
  the scheduler says so once and schedules nothing. Every collection V8 runs, scheduled
  or not, is observed through `perf_hooks` and counted, so an operator sees the pauses
  in the status line and in `status`. The CLI's `start` runs the node as a child
  process under `--max-old-space-size` of three quarters of physical memory (`--heap
  <MiB>` otherwise, at least 256), a 64 MiB semi-space and `--expose-gc`, passing
  signals on and exiting with the child's code. When the operator has already set an
  old-space limit, on Node's command line or in `NODE_OPTIONS`, `start` leaves it
  alone: it starts no child, `--heap` is not read, and the node runs in that process
  under that limit, without the semi-space size and without `--expose-gc` unless they
  were given as well.

The guard's dials, as built (`src/node/node.ts`, `onMemoryLevel` and `rebuildWhatFits`):

| level | heap in use of limit (the old generation's, under a heap limit) | what the database does |
|---|---|---|
| `ok` | under 70% | the cache of decoded objects unbounded; dropped index trees and Merkle trees rebuilt, each only when it fits (below), then the history window let grow back; the mempool at its whole limit |
| `warn` | 70% | the cache capped at 100,000 decoded objects, the excess evicted at once; the index trees dropped; the history window in memory cut to the last two versions; a major collection started; the mempool admits up to half its limit |
| `pressure` | 85% | the cache capped at 10,000; the Merkle trees dropped as well; the mempool admits up to a tenth of its limit; costly RPC methods refused |
| `critical` | 95% | clean stop, the tiers kept dropped and the window trimmed while the node stops, the mempool paused. The guard compares a sample of the heap with the threshold and does not know what filled it; one sample can go from `ok` straight to `critical` |

What the table says of the index trees holds for a node with `indexTrees: 'memory'`. By
default (`'store'`, below) a node never builds them: there is nothing of theirs to drop at
`warn`, which still caps the cache and cuts the window, and only the Merkle trees and the
window are waited for and rebuilt. The runs described next were made with
`indexTrees: 'memory'`, the default at the time.

Rebuilding is conditional because dropping takes a large state from above the pressure
line to well below the ok line in one go (at 192,000 accounts the heap gave back 130 MiB
for the index trees and 193 MiB for the Merkle trees at the time, 181 and 223 MiB in the
current mode table of docs/benchmarks.md section 4.13), and a node that rebuilt everything
at the first `ok` sample took the heap straight back over the pressure line: measured with
the literal rule, it changed level 30 times in 40 seconds, rebuilding each time. So after
a drop the node waits, and then rebuilds a tier only when its estimated heap fits within
half the heap limit (`Node.REBUILD_FILL`) beside the highest of the last ten samples
(`Node.REBUILD_WINDOW`), the index trees first. The wait was those ten samples at first,
ten seconds at the default interval. But a load that filled the heap once fills it again:
in a ten-minute run under a heap 2.5 times the state the index trees were rebuilt four
seconds after each drop and dropped again a few minutes later, and the node committed
less while it had them: resident index trees cost a load of transfers about a tenth
of its rate. So at each level other than `ok` the node sets the wait
(`rebuildAfter`) to the number of guard samples since something was last rebuilt, or
since it started: at least ten and at most 600 (`Node.REBUILD_WAIT_MAX`, ten minutes at
the default interval). Nothing is rebuilt until the level has been `ok` for that many
samples in a row. The same run with the wait rebuilt the index trees once, 29 seconds
after a drop at 32 s, and after the second drop waited as long as it had run since,
found no room and stayed paged to the end.
The room was taken to the warn line at first; with the guard reading the old generation, a
node whose index trees just fitted under that line rebuilt them and then spent minutes
between `warn` and `pressure`, collections taking 7 to 12% of its time against 4 to 5%
with the trees dropped, and committed about a fifth less (1,050 to 1,280 transfers a
second against 1,330 to 1,560). The same measurement moved the index trees and the
history window from `pressure` to `warn`: a loaded node commits more with its index trees
in the store than in its heap (a transfer looks its two balances up by an index, which the store answers, and no index tree is then kept up in the heap), and it used to
reach that state only when the heap arrived at the pressure line, minutes into a full
load. The window goes with them for the heap it gives back; how much of it is in memory
does not change what the node commits. The Merkle trees, which cost a
block something once dropped, still go at `pressure`. Opening a stored state is
judged against half the limit as a rebuild is (`Node.OPEN_FILL`, 0.5). The estimate
(`rebuildEstimate()`) counts 210 bytes of heap per index entry and 1,000 per sparse tree
leaf, which is what dropping them gave back at that size within a few percent, and for the
sparse trees as much again per leaf for what the rebuild reads and throws away, plus 500
bytes per record of a retained version, each of which the rebuild builds a node for. What does
not fit stays dropped, the node running on the fallbacks at `ok`, and the guard asks again
at every sample while the level is `ok`, logging once what it is waiting for (`memory:
staying paged until the heap has room to rebuild`). The limit the guard measures against
is the old generation's: V8's `heap_size_limit` adds the young generation's reserve to
`--max-old-space-size` (192 MiB with 64 MiB semi-spaces), which long-lived objects never
fill, and a process aborts when the old generation is full; with `--heap 744` the levels'
lines taken from 936 MiB put `pressure` past the abort, and a node under load died without
shedding anything, so `memoryStats()` takes the limit from `--max-old-space-size` when the
process was started with it, read as Node reads it: `NODE_OPTIONS` (with its quoting) first,
then `node`'s own arguments, the last one winning, in either spelling V8 takes, and a size
of 0 read as no flag, which is what it means to V8. The use
it is compared with is the old generation's too. V8's `used_heap_size` includes the young
generation, which between two minor collections holds up to a semi-space of garbage
(64 MiB as `start` runs the node) that never reaches the old generation; counted against
an old-generation limit it read as a full heap on a node with a small one (a benchmark
node under a 153 MiB limit logged `critical` at "162/153 MiB", and the next sample, after
a collection, read 42 MiB). So under `--max-old-space-size` a sample also carries
`heapOld`, the bytes in use in every heap space but the young generation's two
(`v8.getHeapSpaceStatistics()`), and the levels, the guard's log fields, the scheduler's
growth test, the node's remembered samples, the room given at opening and the status
line's `heap=` are taken from `heapInUse(stats)`: `heapOld` when the sample has it,
`heapUsed` otherwise. The
mempool's limit is a dial because admission is what grows the heap under load, although
admission through the fallbacks is correct: every pooled transaction pins the objects it
touches decoded in the pending session, and a full mempool held about 330 MiB more live
heap than an idle one in the paging benchmark. Lowered in steps, the node goes on
admitting at the rate its blocks take transactions out, where a pause refused everything
until `ok` and then admitted everything at once.

The history window is a dial too, turned with the index trees. With the cache capped and both tiers dropped, what
still grew under load was the window of past versions (`retain.versions`, 100 by default):
past object values and the records of overwritten tree nodes, tens of thousands per block
of scattered transfers. From `warn` on the node keeps only the last two versions in
memory (`setHistoryWindow(2)`, `Node.HISTORY_WHEN_PAGED`), forgetting the older ones at once. Nothing a block does
reads a past version, so consensus and execution are unaffected. The store is not
trimmed: every root still writes its history record, and the application deletes only the
record of the version that left the configured window, so a restart has the whole window
back. A proof or a query at a height older than the window in memory is answered from
those records (section 6, "Past versions from the store"; `STATE-PAGING.md` section 7.3):
the same answer, slower than from memory and at no cost in memory, so no height stops
being provable when the window is cut. What was forgotten in memory stays forgotten: when
the node widens the window again it grows back one root at a time. It widens it in
`rebuildWhatFits`, last, when both tiers are resident again and its estimate of what the
window held (`historyEstimate()`, taken when it was cut) fits in the room left within
half the heap limit, the room the tiers are rebuilt into.

How much of the window is in memory is also a setting. `retain.memoryVersions` is how
many of the `retain.versions` provable versions the node keeps in memory; unset, it keeps
all of them until memory fills. The store keeps the whole window either way and answers
for the older heights from its history records. The setting is for a node with a large
heap, which never reaches `warn` and would otherwise keep the whole window in its heap.
Measured at 514,008 accounts under twice the resident heap, it buys memory and pause
length, about 500 to 700 MiB less heap (1,057 to 1,141 MiB at the highest report against
1,603 to 1,767) and a longest
collection pause of 127 to 178 ms against 202 to 237 ms, and costs proofs at past
heights 13 to 33 ms instead of a small fraction of a millisecond. Throughput is not shown
to depend on it (1,246
to 1,402 transfers a second with 100 versions in memory or with two). When the guard
has trimmed the window and widens it again, it widens it to this setting.

Whether the index trees are in memory at all is a setting too. `indexTrees` in the node's
config is `'store'` by default: the node never builds them, index reads go to LMDB, and
the guard does not count them among what waits to be rebuilt. With `'memory'` the trees
are kept in the heap while they fit, dropped from `warn` and rebuilt after it, as above;
that was the default until measurements of the kind below, and it is for a node that mostly
serves scans. Measured at 191,896 accounts under 2.5 times the resident
heap for ten minutes, the node with `'store'` opens with 258 MiB of heap in use against 398 MiB, a
third less, commits 1,508 transfers a second against 1,522, which is within 1% (the pair
of runs on the earlier build, which decided the default, read 1,552 against 1,485), and
reaches `warn` once against twice, with nothing to rebuild
but the window (docs/benchmarks.md section 4.13). What it gives up is index reads from
memory, measured with 200 reads a second of each kind beside the load: a lookup by key
takes 4 to 7 microseconds at the median either way, a page of twenty accounts in name order
31 to 34 microseconds from the store against 17 to 18 from memory, with a longer tail (a
99th percentile of 569 and 1,588 microseconds against 43 and 76), and the three runs with
`'store'` commit 13% more than the three with `'memory'` (1,559 against 1,385 transfers a second).
A store none of which was in the page cache when the node opened it reads the same: the
node reads its whole store when it opens, so it is the open that meets the cold cache
(3,661 ms, inside the range of the warm opens, 3,359 to 4,179 ms; 3,965 ms against 3,355
to 3,545 ms on the earlier build) and index reads are warm from the first. What a read costs when it does go to the device
was measured on a store of 576 MiB (514,008 accounts) read cold without a node: of the order of
140 to 320 microseconds for a lookup that missed (one median and the 99th percentiles of
the cold reads) against 1 to 3 from the page cache (docs/benchmarks.md section
4.13). A node under load on a machine whose memory the store exceeds was not measured.
Proofs and the Merkle trees are unaffected. `ObjectDatabase` and `CoreApp` used without
a node still build the trees unless told otherwise.

Two things are decided outside the guard's levels. The arena's slabs are `ArrayBuffer`s
outside V8's heap, which the guard does not see, so the arena is bounded by a byte budget
the operator sets (`start --arena <MiB>`; section 6), not by a level. And a tier that does
not fit the heap would take it past the limit while the store is opened, before the guard's
first sample, so under a heap limit the node tells the application how much room there is
(`heapRoom`: half the limit, `Node.OPEN_FILL`, less the old generation's heap in use) and `openObjectDatabase` estimates
each tier from the type counters in the store with the figures `rebuildEstimate()` uses:
the index trees are opened dropped if they do not fit, then the Merkle trees with the room
left. If either was left out the history window is not read back either, since reading it
puts every tree node and object the window's blocks overwrote into the heap, under a
scattered load more than the trees: the
node starts with an empty window in memory that fills a block at a time, and the records
stay in the store until they age out. The database is told how far back they reach
(`noteStoredHistory`) and reads the heights before the one it opened at from them, so the
provable window is what it would have been. The startup line `loaded application state` then says what was
left out (`paged`), and `rebuildWhatFits` rebuilds the tiers later if room appears
(`STATE-PAGING.md` section 9.1).

## 5. Signatures: ML-DSA-44 or secp256k1, chosen by genesis

- **Two schemes, one per chain.** Genesis names the scheme in `signatureScheme`:
  `"ml-dsa-44"` (FIPS 204, NIST level 2, post-quantum, via
  `@noble/post-quantum/ml-dsa.js`; the default when the field is absent, so every
  earlier genesis keeps its meaning) or `"secp256k1"` (ECDSA over the Bitcoin curve
  via `@noble/curves/secp256k1.js`). The one scheme serves validator votes and
  proposals, transactions and p2p node identity, and cannot change after genesis.
- **Tagged keys and signatures.** Every public key, secret key and signature carries a
  one-byte scheme tag in front of its raw bytes (1 = ML-DSA-44, 2 = secp256k1), so a
  decoder knows how many bytes follow (`decodePublicKey`, `decodeSignature`; an
  unknown tag is a codec error) and a verifier knows which scheme to run. `verify` is
  false when the tags of the key and the signature differ or are unknown.
- **Sizes, tag included:** ML-DSA-44 public key 1313 B, secret key 2561 B, signature
  2421 B; secp256k1 public key 34 B (33 compressed), secret key 33 B, signature 65 B
  (64 compact). Seeds are 32 bytes under both; a secp256k1 seed is the secret key
  itself, and `generateSeed` skips the few values that are not valid keys.
- **The secp256k1 construction:** ECDSA with RFC 6979 deterministic nonces over the
  digest `sha256(len(context) || context || msg)`, so the context is bound in ahead
  of the message with its length; low-S signatures only, on signing and on verifying,
  so the high-S twin of a valid signature is refused and a signed object has one
  encoding. ML-DSA-44 is unchanged: deterministic (`extraEntropy: false`), the
  context taken natively.
- **Where the other scheme is refused:** genesis validators (`genesis validator key is
  not a <scheme> key`) and genesis accounts, validator-set updates (`nextState` halts
  rather than sign with an update that carries one; both applications refuse such a
  key earlier, in checkTx and again in the block), account authorities in accountCreate and accountUpdate (`key
  must be a <scheme> key`), consensus keys in validatorCreate and validatorUpdate
  (`consensus key must be a <scheme> key`), transaction signatures (`signature of
  another scheme than the chain uses`, before any verification work; the batch
  pre-verification skips them too), and the validator sets a state-synced node is
  served (`state sync: a validator key is not a <scheme> key; this is not the chain
  genesis describes`). A peer's hello must carry a well-formed tagged key; a node
  makes its own with the genesis scheme.
- **The scheme in state.** `ChainState.scheme` is the engine's copy, set from genesis
  and carried from block to block; the application's global properties hold the same
  (`GlobalProperties.scheme`, set by `applyGenesis`), so it is part of the app hash
  and two nodes whose genesis files name different schemes never agree on a root. A
  node derives its node key and its validator key with the genesis scheme, and
  `status` reports it as `signatureScheme`.
- **Speed:** measured by `bench/crypto.bench.ts` (`docs/benchmarks.md` section 4.1).
  Verification in pure JavaScript is close between the schemes, 0.9 ms for ML-DSA-44
  and 0.7 ms for secp256k1 on one thread, so verification goes through the worker
  pool under either. Signing is not close, 2.85 ms against 0.23 ms, nor are sizes.
- **API:**
  ```ts
  const keys = keyPairFromSeed(seed32, scheme)           // tagged publicKey and secretKey
  const sig  = sign(msg, keys.secretKey, context)        // the scheme the secret key is tagged with
  const ok   = verify(sig, msg, keys.publicKey, context) // false across schemes or for an unknown tag
  ```
- **Deterministic signing:** a given signer produces the same signature for the same
  body every time, under either scheme. It does not make a transaction unique:
  ML-DSA verification accepts hedged (randomised) signatures too, an ECDSA signer may
  choose another nonce, a body may be signed by any subset of keys that satisfies its
  authorities, and the signatures may come in any order, so a body has several valid
  signed encodings. Identity is the body hash (section 7); every valid encoding is the
  same transaction to replay protection.
- **Domain separation via context:** `"<chainId>/vote"`, `"<chainId>/proposal"`,
  `"<chainId>/tx"`, `"<chainId>/p2p"`. A signature for one purpose can never verify as
  another. Context max is 255 bytes; ML-DSA takes it natively and ECDSA hashes it in.
- **Key storage:** persist the 32-byte seed only, with the scheme beside it in the
  keystore. Derive the keypair at startup.
- **Addresses:** SHA-256 of the tagged public key, so one seed gives a different
  address under each scheme. Keys live in state, in account authorities (§7); a
  transaction signature carries the 32-byte address of its key, and the verifier
  resolves the key from the authorities the transaction requires. Keys are never sent
  with transactions.
- **Verify cache:** keyed by tx id and signer address, holding the hashes of the
  signature bytes that verified, so a second valid signature by the same key over the
  same body is verified and cached on its own. CheckTx verifies on mempool admission;
  FinalizeBlock consults the cache and verifies only what it has not seen, in one
  batch. The cached fact is pure crypto and never goes stale; authority thresholds,
  which depend on state, are rechecked every time. The cache holds 20 000 bodies and
  at most 40,000 signatures across them, four per signer and body, and evicts the
  oldest.
- **Consequences accepted:**
  - a simple transfer tx is 2,510 bytes under ML-DSA-44, nearly all of it the one
    signature, and 154 bytes under secp256k1.
  - a block commit is `48 + N + S × signatureSize` bytes for N validator slots and S
    present signatures (height, round, block hash, a count, one presence byte per
    slot), the signature 2421 or 65 bytes with its tag. 100 validators all signing
    ≈ 242 KB per block under ML-DSA-44 and 6.6 KB under secp256k1. Light clients
    download full commits. Keep the validator set modest under ML-DSA-44.
  - ML-DSA keys dominate state: an account's two keys are 2,626 bytes and a validator
    set 1.3 KB per member, which `docs/benchmarks.md` measures as the bulk of a large
    genesis; secp256k1 removes that (68 and 50 bytes).

## 6. Application state: an object database with a Merkle root

The model is Graphene's (BitShares) object database, which has typed objects with
deterministic ids, multiple indices per type, and all consensus state in memory. It
lacks one thing this chain needs, a state root with inclusion proofs, and its dense
ids make adding one unusually easy.

- **Objects and ids.** Every piece of consensus state is an object with a type (16
  bits) and an instance number (48 bits in the id; the database refuses instances
  beyond 2^32 − 2, so an instance always indexes a dense array), packed into one u64
  id and written `type.n`. A database takes at most 511 object types (each type's tree
  and the tree over the types hold one of the 512 places in the chunk cache dropped
  trees share) and refuses more when it is made. Instances come from a per-type counter, which is itself
  consensus state, and are never reused. Objects are immutable records, frozen
  through every nested object and array (a byte array cannot be frozen in
  JavaScript and is the one thing a caller must not write into); a modification
  replaces the object.
- **Why ids and not keys or names.** An ML-DSA-44 public key is 1313 bytes with its tag
  (a secp256k1 key 34). Referencing accounts by id keeps a transfer at about 40 bytes
  plus its signature; the key is stored once, in the account. Ids are also what makes
  the Merkle tree below trivial.
- **Memory as a cache, LMDB as the truth.** The design began as Graphene's: all
  consensus state in memory, the disk a copy of every object so that a restart reloads
  rather than replays, state bounded by RAM. `STATE-PAGING.md` made memory a cache at
  every tier and LMDB the truth, and all five of its phases are built: the `app` store
  holds, at every committed height, every object's encoding, every secondary index entry,
  the dense trees' chunks and the sparse trees' nodes, beside the history of the provable
  window, account history and snapshots, next to the blocks the engine keeps. With memory
  to spare nothing is evicted and the node runs as the Graphene design does, a lookup in
  tens of nanoseconds; under pressure the memory guard (section 4) evicts tier by tier,
  the decoded objects, then the index trees, then the Merkle trees, and reads fall
  through to the store, whose memory map the operating system pages in and out. What
  bounds the node is then the working set of one block plus the cache it is granted, and
  each type's table by instance (next item), which is not paged: 13 bytes for every
  instance number the type has reached, before the doubling it grows by. Encodings are binary and compact in any case.
- **Indices.** The primary index of a type is a table by instance: slot i describes
  instance i, no hashing at all (what a slot holds is the next item). A secondary index is a key encoder plus one ordered byte map. Keys are
  byte strings whose lexicographic order is the scan order: big-endian integers, strings
  with a zero terminator, compound keys by concatenation. A non-unique index appends
  the object id to the key, so a range query is a prefix scan. The ordered map is a B+
  tree with fan-out 32 (the tm2 shape, without its copy-on-write persistence, since
  indices are derived state): keys in sorted arrays inside each node, binary search at
  every level, iteration by a stack of (node, child) rather than leaf links, merges on
  underflow but no borrowing. The same tree is the in-memory key-value store. The B+
  trees are accelerators: every entry is also a key in the `app` store (two bullets
  down), from which a restart rebuilds them in key order and to which reads fall
  through while they are dropped. They are not part of the root, while the unique
  indices that need proofs are authenticated by sparse Merkle trees whose roots are in
  the type leg (see "Authenticated indices" below).
- **Objects as bytes: the arena and the hot cache.** Tier one of `STATE-PAGING.md`
  (phase one), implemented in `src/db/arena.ts` and `src/db/index.ts`. The
  committed encoding of every object lives in an arena: slabs of bytes, 256 KiB first and
  doubling to 16 MiB, filled by a bump allocator, each entry a 10-byte header (type u16,
  instance u32, length u32) followed by the encoding. A type's primary index is a table
  of references into it (slab and offset packed into one number, -1 for absent, -2 for
  an object whose bytes are only in the store) and of lengths. Slabs are never written in place: a new encoding is a new entry and the old
  one is counted dead; after a root, every slab with nothing live is released without
  copying, and a slab more than half dead is compacted, its live entries copied into the
  current slab (the header names the owner, which says whether an entry is still current)
  and its buffer released; a slab is started on only while less than what the root's block
  wrote (at least 16 MiB) has been copied, and is finished once started, so the copying
  can pass that figure by one slab's live bytes,
  which keeps reclaiming level with the writes. A released slab's number is reused with a
  new generation, so references stay exact. Over
  the arena sits a hot cache of decoded, frozen objects per type, under one budget all
  types share: a read answers from it or decodes from the arena (about a microsecond for
  an account) and caches the result. Eviction is CLOCK: a hit sets the instance's
  touched bit, a fresh decode enters with it clear, and a hand sweeping the cached
  entries sends one whose bit is set to the back with the bit cleared and evicts clean
  ones whose bit is clear until the budget is met, so a one-time read goes first and a
  scan does not wash out a block's working set. Objects
  written since the last root are pinned in the cache, decoded, and never evicted; a
  removal is a tombstone there. root() encodes each dirty object once, hashes the bytes,
  writes them to the arena and unpins the object, so a transaction that fails and is
  undone costs no arena traffic. The budget is unbounded by default, so a node with
  memory to spare keeps every object decoded and runs nearly as before; the memory guard caps
  it (section 4). Given a byte limit (`arenaBytes`, the CLI's `start --arena <MiB>`;
  unbounded by default) the arena is itself a cache over the objects in the `app` store
  (`STATE-PAGING.md` section 3.4): once the application has written a root, whole slabs
  beyond the limit are released, those nothing has read since the last pass first (a
  CLOCK bit per slab) and never the current one; each live object of a released slab is
  marked as stored, and a read that misses the hot cache takes its bytes from the store
  instead. A read does not put it back in the arena; its next write does. At open,
  objects beyond the limit are left in the store rather than loaded. The limit is a byte
  budget and not a dial of the guard because the slabs are outside the heap the guard
  watches. History keeps past values as bytes, decoded only when a past version
  is read, and proofs, snapshots and export take their bytes from the arena or the
  history without a decode and re-encode. Measured at 191,896 accounts under secp256k1
  on the build that introduced it (`docs/benchmarks.md` section 4.10): resident, about 6%
  more memory and 5 to 15% less
  speed; capped at 100,000 objects, 17% less heap with an empty cache and a block of
  random transfers twice as slow. The budget it revealed: decoded objects were about a
  sixth of the heap, 0.55 KB of the 3.2 KB per account, and the secondary indices, the
  name tree and the Merkle trees the other 2.65 KB, which is what the two tiers below
  put on disk.
- **Index entries on disk and droppable index trees.** Tier two of `STATE-PAGING.md`
  (phases two and three; `src/db/indexstore.ts`). Every secondary index entry is one key
  in the `app` store, written and deleted in the same transaction as the objects of the
  version that changed it: `'i' type u16, index position u8, key bytes -> id u64` for a
  unique index, and for a non-unique one the same with the id appended to the key and an
  empty value; the position is the index's place in its type's definition. Bytewise
  order in LMDB is the order the B+ trees keep, so a prefix scan is a range and a cursor
  from a start key is `scanFrom`. Each root reports the entries it added and removed
  (`Changes.indices`, removals first, so a key handed from one object to another in one
  block ends with its new owner), by comparing the keys each dirty object had at the last
  root with its keys now; a transfer, which changes amounts and no key, writes no entry,
  and the first root writes every entry. The B+ trees are accelerators, which a node
  builds only under `indexTrees: 'memory'` (section 4); the guard then drops them from
  `warn` on (`dropIndexTrees`) and rebuilds them from the prefix when memory allows
  (`rebuildIndexTrees`), both with sessions open. While a type's trees are dropped,
  `lookup` is one LMDB get and `scan` an LMDB cursor merged lazily with two layers laid
  over it: the change lists of roots the application has not written yet (the store is a
  block behind between `finalizeBlock` and `commit`, until `dropChanges()` says it is
  written), and per index an overlay B+ tree of the writes since the last root, a key to
  its id or to null for a key released, which the writes keep in place of the dropped
  tree and which a drop in the middle of a block builds from the dirty set. Uniqueness
  checks consult the overlay, then the tree if present, then LMDB. A database without a
  store (tests, a snapshot being imported) builds an in-memory one when it first drops a
  tree and lets it go when every tree is resident again; `INDEX_TREES=0` starts every
  database in the tests dropped. Measured (`docs/benchmarks.md` section 4.11): the
  entries cost a 500-transfer block's commit about 0.7 ms, 7%, when they were added, and
  58 MiB of LMDB at
  192,000 accounts; a lookup through LMDB costs about what a resident one does and a scan
  five to nine times as much, still under a microsecond an entry.
- **Undo sessions.** Nested, Graphene style, with two uses: one session per transaction,
  undone on failure, and one pending session holding the mempool's speculative state,
  undone before every block and rebuilt by the engine's post-commit recheck. A block
  also runs inside one session, committed just before its root is taken and undone
  only if applying the block throws (a verifier gone away), which leaves the database
  as the previous block left it; a block that has been applied is final and is never
  undone. The committed view is the state as of the last root: the first write to an
  object after a root keeps the value it had at that root, for the next root to compare
  with, and `getCommitted`, the committed counter and the committed bytes read that
  first, whatever was written since, inside a session or outside one. That
  is what queries and proofs return while the pending session is open.
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
  recomputed in one pass at the end of each block, shared ancestors once. The chunks a
  root changes are also written to the `app` store at every commit, so the live trees
  are an accelerator the guard can drop (see "Trees on disk" below).
- **Versions.** root(v) is called once per block with the height as the version. With a
  retention window (default 100 heights), every overwritten node hash is remembered as
  "before version v it was x", every overwritten object as its encoding before v, and
  every moved counter likewise. A proof at an older height reads each node, the
  object and the counter through those records; records that only serve heights
  older than the window are dropped after each root. Node positions never change, so
  there is no copy-on-write. The records of each version are written to the store
  with the block's changes and read back on restart, so the whole window is provable
  again after a restart. The sparse trees' past versions come back from the records too
  (`restoreIndexVersions`, `SparseMerkleTree.loadVersions`): each older version is built
  against the next newer one from the nodes the commit between them overwrote, newest
  first, sharing every subtree that commit left alone. That is what a resident tree does,
  and there every node taken from a record is checked against the hash its parent gives
  it. A dropped tree builds nothing: it notes each past version's root hash and files the
  records as its own history, per node and in ascending version, which is the form it
  answers past versions from; nothing is hashed against a parent then. Replaying every key from the object history
  (`rebuildIndexVersions`), which is what a restart did before, remains as the fallback
  for a window that holds a record written without the node list, or a record that lacks
  a node a version needs; the startup line says which was used (`indexVersions`:
  `records`, `replay` or `none`). A history record (`HistoryRecord`) holds, for its version, the
  leaf count and node hashes it overwrote in each dense tree, the encodings of the
  objects it overwrote, the counters before it and, last, the sparse tree nodes each
  commit overwrote, by store key (`nodes`; null in a record written before these were
  kept, and for a database with no store and resident trees). This is the role IAVL's versioned nodes play in Cosmos,
  reduced to an undo log because the tree is dense.
- **Past versions from the store.** The window in memory may hold fewer versions than
  the store has records for: the memory guard trims it to two from `warn` on, and a store
  opened without room for its trees does not read it back (section 4). Given the
  application's store of history records (`historyStore`, a function from a version to
  its encoded record), the database answers for those versions from the records.
  `lowestVersion` is then the oldest version the records reach, whatever the window in
  memory holds. A read of an older version names the entries it will look at (the object,
  the counter, the tree nodes on the proof's paths) and scans the records of every
  version after the one asked about, oldest first (`past`, `scanHistory`): the first
  record to name an entry gives its value at that version, and an entry no record names
  has not changed and is read as it is now. Each record is walked in its encoded form and
  only the wanted entries are copied out; nothing is cached, so such a read costs time
  and not memory. The last root's record, which the application may not have written
  yet, is taken from the pending change list. The database keeps the list of the versions
  that have a record and scans exactly those; a record the store does not return is a
  refusal (`version N is not available: the store has no history record of version V`),
  not an answer from what is left, in which an entry the missing record named would be
  read as it is now. At opening the application likewise uses only the run of records
  that is unbroken up to the current height: below a gap the heights are not provable,
  and their records are deleted with the next commit. A proof that needs sparse tree nodes from a
  record written before they were kept is refused as not available; such records age out
  of the window as blocks are applied.
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
  alone and validator sets by hash) has two implementations: one reads a node in the
  same process (`src/light/provider.ts`), the other a node's RPC
  (`src/light/rpc-provider.ts`), which is what the CLI uses.
- **Authenticated indices.** A unique index can be marked authenticated; the account
  name and asset symbol indices are. Such an index also keeps a compacted sparse
  Merkle tree (`src/db/smt.ts`, the Jellyfish shape) over sha256 of its keys, and the
  roots of a type's authenticated indices go into its type leaf after the counter and
  type root. A type may have at most 16 of them (`MAX_AUTHENTICATED_INDICES`), which is
  what the decoders of proofs and snapshot manifests take; a type defined with more is
  refused. A key proof is the sparse tree's path (membership, an empty slot, or
  another leaf that owns the subtree, which proves absence) plus the same type leg,
  so "no account named alice" is provable. The B+ tree is not hashed on purpose: its
  root would depend on node layout, which depends on the order of writes, and a node
  rebuilds its B+ trees from their stored entries on restart. The sparse tree has one
  shape per key set, so every node, after any history, hashes alike; that is also what
  lets past index versions be rebuilt from the object history after a restart, when
  the store's history records do not hold the nodes each version overwrote (they do
  since STATE-PAGING.md section 7.3; the store holds the current nodes, below). Nodes are immutable and writes
  copy the path, so a past version is a root pointer. Lookups by owner and similar
  non-unique indices stay unauthenticated.
- **Trees on disk and droppable Merkle trees.** Tier three of `STATE-PAGING.md` (phase
  four; `src/db/merkle.ts`, `src/db/smt.ts`). Every root also reports the tree chunks
  and sparse tree nodes it wrote or deleted (`Changes.trees`), and the commit writes
  them with the rest: dense chunks under `'t' tree u16, level u8, chunk u48`, the tree
  being the type id or 0 for the tree over the types, a chunk stored without its
  trailing empty hashes and deleted when it becomes all empty; sparse nodes under
  `'n' type u16, index position u8, path bits packed, depth u8`, an inner node as `0x00`
  with both children's hashes, a leaf as `0x01` with the key hash and the id, so a walk
  down one key's path reads one node per level and finds every sibling hash on the way.
  A tree's leaf count is its type's counter, which the store already keeps. A resident
  sparse tree finds its changed nodes by walking the old and the new root together into
  the subtrees whose hashes differ. The live trees are accelerators: the guard drops
  them all together at `pressure` (`dropTrees`), after the index trees, and rebuilds
  them when memory allows (`rebuildTrees`), both with sessions open. Dropped, a dense
  tree releases its chunks, and a root works on private full-size copies of the chunks
  it changes, read from the store through a `ChunkCache` all the database's trees share
  (4,096 chunks, at most 128 MiB of buffers outside the heap, so trees of up to about two
  million leaves in all stay cached whole; with 256 a block of 500 transfers among 514,000
  accounts read most of its paths from the store and took 271 ms to finalize, against 60
  to 69 ms with every chunk cached); the copies become the
  root's change list. A dropped sparse tree only remembers each key's last write and
  applies them at the root by walking each key's path from the stored nodes with the
  same shape rules, so the root is the same whatever the order; for past versions a
  dropped tree keeps records of what each commit overwrote, as the dense trees do.
  Proofs at the current version read the same way; proofs at past versions need the
  history records, from the window in memory or, for a version it no longer holds, from
  the store ("Past versions from the store" above). `TREES=0` starts every
  database in the tests dropped. Measured (`docs/benchmarks.md` section 4.12): writing
  the chunks costs nothing measurable for a block whose writes are local and was a fifth of
  the commit (about 12 MiB of chunks) for a block scattered over 192,000 accounts when the
  chunks were first written; with
  the trees dropped a root over 1,000 modifications takes 54 ms against 27 (29 against 20
  at the median),
  an object proof a third more and a name proof five times as much; the genesis store
  grew from 92.7 to 213 MiB.
- **Deferred execution caveat.** The state after block N is committed to by the app
  hash in header N+1, so a proof about height N is checked against header N+1 and
  that header's commit.
- **Persistence and recovery.** Each root() reports the objects that changed, the
  counters that moved, the index entries added and removed, and the chunks and nodes
  written or deleted, and the app's commit (`CoreApp.persist`) writes exactly those
  plus the version's history record, the height and the app hash in one LMDB
  transaction, so the store holds every tier's complete state at every committed
  height. On start the app imports every object as bytes with no decode, loads the
  dense and sparse trees from their chunks and nodes (`loadTrees`), builds the B+ trees
  from the index entries in key order (`loadIndexEntries`; the sparse trees too when
  the store has no nodes), and computes the root, which must equal the stored app hash.
  A root read from stored trees equals the stored hash by construction, so the open
  also checks what it read (`checkLeaves`): every dense node against its children and
  every sparse node against the hash its parent gives it, every object hashed and
  compared with its leaf, and each tree's non-empty leaves counted against its objects;
  and it checks the index entries against the objects, each object decoded once for its
  keys (`checkIndexEntries`), since the app hash does not cover an unauthenticated index.
  A corrupt store then fails at startup rather than when something reads it (`object
  <id> does not hash to its leaf in the stored tree`, `the stored tree has n leaves for m
  objects`, `the stored entry for object <id> is missing`). `checkLeaves: false` and
  `checkIndexEntries: false` skip the checks and `fromTrees: false` recomputes the trees
  from the objects, the old path: at 192,000 accounts the restart went from 8.4 to 5.2 s
  with the trees on disk, the full checks took it to 6.5 s (STATE-PAGING.md 5.3), and the past versions read from the history records to 2.85 s. A store written before
  the entries or the chunks existed has no `'i'` or `'t'` prefix; opening it computes
  what is missing from the objects and writes it once. Then the engine replays the
  blocks after the stored height through the existing info() handshake. Nothing
  speculative is ever written: the pending session is undone before the block runs.
- **Reads.** With ids, a read by id is one map lookup for the type and one for the
  instance in the hot cache, or on a miss a decode from the arena; nothing is hashed. Name and symbol lookups go through the
  B+ tree of their index, or one LMDB get while the tree is dropped, and a proof's length grows with the height of the type's
  dense tree (the log of its counter), so those paths do depend on state size, though
  the measured throughput was flat at the sizes tried (`docs/benchmarks.md`). The
  signature cache is the one hash-map lookup on the hot path, on short keys. Nothing
  here benefits from perfect hashing: the key sets that would (operation tags, message
  types) are already small integers in the binary codec.

## 7. Application: accounts, tokens, balances

The first real application on the object database, BitShares style.

| type | id | indices | holds |
|---|---|---|---|
| global | 1 | | core asset id, fee schedule (FEES.md), max transaction expiration, staking parameters, the signature scheme (§5) |
| dynamic | 2 | | height, last block time, community pool, inflation, bonded total, the active set and the expected signers (STAKING.md) |
| account | 3 | byName (unique, authenticated) | name, owner authority, active authority, registrar |
| asset | 4 | bySymbol (unique, authenticated) | symbol, precision, issuer, max and current supply |
| balance | 5 | byOwnerAsset (unique), byAsset | owner, asset, amount |
| recentTx | 6 | byTxId (unique), byExpiration | a tx id kept until it expires |

- **Accounts** are named. Names are 3 to 63 characters of lowercase letters, digits and
  hyphens in dot-separated segments that start with a letter and do not end with a
  hyphen. An account has an owner
  authority and an active authority. An authority is a threshold plus weighted members,
  each a public key or another account; it is satisfied when the weights of the signing
  keys, plus those of member accounts whose active authority is satisfied, reach the
  threshold. Recursion stops at depth 2. An authority set by accountCreate or
  accountUpdate must be one that signatures could satisfy as the state stands: when its
  own keys do not reach the threshold, every key reachable through its member accounts
  to that depth is collected and the authority must be satisfied with all of them
  signing (an update is judged against the account as the update leaves it), else the
  operation fails with `authority can never be satisfied: its member accounts do not
  lead to keys enough for the threshold`. A reference to the account itself counts for
  what the account's active authority, as the update leaves it, leads to: an active
  authority that names only its own account is refused, and an owner authority that
  does is accepted while the active authority keeps keys that reach its threshold. A transaction carries at most 16 signatures, so when more
  than 16 keys count toward the authority the cheapest way to its threshold, a key
  costing one signature and a member account what its active authority costs, must
  fit in 16, else the operation fails with `authority can never be satisfied: it needs
  more than the 16 signatures a transaction can carry`. That count takes a key shared
  by two member accounts once for each, so it errs toward refusal. Owner can change everything including itself;
  active everything else; an owner signature also satisfies an active requirement. A
  new account is registered by an existing one, the registrar, which pays the fee.
  Genesis accounts register themselves; the first one, `3.0`, issues the core asset.
- **Assets** have a symbol (3 to 16 uppercase letters and digits, in dot-separated segments that
  start with a letter), a precision, an
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
  tagged signature (2421 bytes under ML-DSA-44, 65 under secp256k1); the key is
  resolved from the authorities the operations require, walking member accounts to
  depth 2. A signature by any other key, or two by the same key, or one of another
  scheme than the chain's, is rejected, as in BitShares; beyond that any satisfying
  subset of keys in any order is accepted, and so is a hedged ML-DSA signature or an
  ECDSA signature under another nonce, so a body has several valid signed encodings. Replay protection is the expiration plus the set of
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
  compute the root for the height; reopen the pending session. If anything throws
  before the block session is committed (a verifier gone away), the session is undone
  and the database is as the previous block left it. A failure while the root is
  computed comes after that commit and can undo nothing: the block's changes are in
  memory while the height and the app hash have not advanced. The application then marks
  itself failed: `finalizeBlock` throws, every later `finalizeBlock` throws and every
  `checkTx` answers not ok with the same message (`the application failed while taking
  the root of block N (cause) and holds changes it cannot undo: restart the node, the
  store has the state of the block before`), and `commit` writes nothing. Nothing of the
  block was persisted, so a restart recovers. After a block that succeeded, the commit that follows writes the changed objects to
  the store. CheckTx does the same for one transaction inside the pending session: a
  transaction that passes stays applied there, so transactions queued behind each
  other are checked in sequence against each other's effects; a check that overlaps a
  block in progress waits for the block and is then checked against the new state,
  and the pending session is undone before every block.
- **Concurrency:** signature verification is the only await. Everything that touches
  the database is synchronous. In checkTx it runs after the await. In finalizeBlock
  the block session, the pruning and the begin-block steps come before the batch
  verification, and each transaction is applied after its own signatures resolve; a
  checkTx that overlaps a block waits for the block to finish before it touches the
  database, so sessions nest cleanly even though checkTx calls overlap each other and
  finalizeBlock.
- **Validators** come from the application: the active set it computes at the end of each
  block is handed to the engine as updates (section 8 and STAKING.md).
- **Genesis** (`appState`, JSON): the core asset's symbol, precision and max supply; the
  fee schedule (any subset, over the defaults); the expiration window; and the initial
  accounts with their authorities (tagged public keys in hex, of the chain's scheme)
  and core balances. A small one
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
hash, with one entry for every block a transaction is in, and the application keeps per-account history with virtual entries
(`src/app/core/history.ts`), stored as one log in block order: a block's entries are
appended to its end, each pointing back at earlier entries of its account, so a block
writes a few pages of the store where entries keyed by account dirtied one for every
account it named (`RPC-SYNC-PROOFS.md` section 2.4). `src/rpc/` is JSON-RPC 2.0 over HTTP on `node:http`
with Server-Sent Events, per-address token buckets and a body limit; `src/wallet/`
is the scrypt and AES-GCM keystore; the CLI is an RPC client and the light client
has an RPC provider. `src/app/core/snapshot.ts` exports chunks with range proofs
every K blocks; `src/sync/statesync.ts` joins from a trusted header through the
light client, verifies every chunk, and `src/sync/blocksync.ts` requests windows
of blocks from several peers, backfills older blocks by hash chain, and serves
both. State sync takes only a snapshot at or above the trust height less one (the
header after the snapshot fixes its app hash, and trust only moves forward to it);
when none offered qualifies it logs a warning and the node replays from genesis, as
when none is offered, and a manifest that does not decode costs its sender 50 points
and the next source is asked. A block sync response must hold at most the blocks
asked for, each at the height its place in the run gives it and with a commit that
names its hash; otherwise none of it is used and the peer is charged 50 points, as
for a block that fails verification. A sync that was stopped applies nothing more,
and blocks buffered when no peer is ahead any longer are dropped. Evidence travels
by inventory. Gossiped evidence is checked for age, against the next height and the
last block's time, before its signatures are verified: what is too old, names a
height the node does not know or lies beyond the height being decided is dropped
without being pooled and without a score. A block carries at most 16 pieces
(`MAX_EVIDENCE_PER_BLOCK` in `src/consensus/validate.ts`), which block validation
enforces on every node. The pool lets go of evidence, pending or
committed, with its inventory entry once it is older than the evidence age, on every
node after every commit, and holds at most 1,000 pending pieces; a block that +2/3 precommitted but was never
proposed to a node is fetched and decided in place; peers are scored and banned
(`Network.score`); the executor prunes blocks behind a retention window but never
past the newest snapshot nor into the evidence window (blocks whose time is within
the unbonding period of the latest stay, since evidence is checked against the set
and time of its height). The evidence age is read from the application each time it
is asked for (`Node.evidenceAge()`), so a block that lengthens the unbonding period
is pruned behind with the new age; heights deleted under the shorter window are gone,
and until a full new window has passed a pruning node refuses evidence that names
them. Each pruning pass is one store transaction: the blocks, or the headers, go
with the marker that says they are gone, and a block takes the validator set stored
under its height with it. A node joining by state sync also fetches the headers below
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

## 10. Implementation status (2026-11-15)

Everything above is implemented in TypeScript under `src/`. 280 tests in 29 files
pass, and the whole suite passes under either signature scheme
(`CHAIN_SCHEME=secp256k1 npm test`; one ML-DSA-only case is skipped there) and with
either tier of state paging dropped from the start (`INDEX_TREES=0`, `TREES=0`, or
both: every lookup, scan, root and proof through the store). The engine
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
old schedule fails instead of paying more. The schemes suite signs, verifies and
round-trips tagged keys under each scheme, refuses cross-scheme keys and signatures,
unknown tags and the high-S twin, keeps each key's scheme in the keystore, and runs a
four-validator chain on secp256k1 end to end. The memory suite moves the guard through
its levels on injected samples, checks the scheduler's decisions against an injected
collector and its observer against real collections, and runs a full node of the core
application in a two-validator testnet through load shedding and back while it keeps
following the chain, its database's cache capped at `pressure` and unbounded again at
`ok`, its index trees (the test helper asks for `indexTrees: 'memory'`) dropped and its history window trimmed to two versions at `warn`
with the Merkle trees still resident and nothing shed, its Merkle trees dropped at
`pressure` while it follows the chain
and proves objects through the store, both tiers kept dropped at `ok` while rebuilding is estimated
not to fit (after waiting at `ok` as long as it had run before the drop, and saying once that it stays paged), and rebuilt once it does, its history window restored after the trees, and its mempool admitting up to half its
limit at `warn`, a tenth at `pressure` (a transaction beyond it refused as `full`) and all of it at `ok`; and a node with
`retain.memoryVersions` set keeps that many past versions in memory and proves an older height from the store, and with `indexTrees: 'store'` leaves its index trees there and still finds an account by name. The history
suite appends blocks of entries to the account history log and pages every account out
of it in both directions against a model, counts the reads that reach the old end of a
long history, checks that a block writes the heads of one slice of the account numbers and that a log opened after a stop has the waiting ones back, and moves a store written with the earlier layout into the log. The fourth review's suite (`test/review4.test.ts`) asks a node for a balance, an account, a key, a validator and a delegation as of past heights and checks their proofs against the next header's app hash, spends a rate limit with batches, indexes one transaction in three blocks, moves a transaction index of the earlier layout when its store is opened, refuses a snapshot without every type's section and a number too large to hold exactly, prunes and bounds the evidence pool, removes a key from the keystore, reads a peer clock seven seconds ahead from its pong and runs a node on a verifier pool of its own. Four more suites hold one case for each rule added after it. `test/review5-net.test.ts` (15 cases) counts one success for an outbound dial, leaves a refused connection open for the rejection to leave, bans and excludes a peer by the address dialed, takes an address list only in answer to a request, starts from the seeds on a peer file cut short, stops block sync cleanly, refuses a block response that does not match its request, passes over a snapshot below the trust height, drops a vote far ahead before verifying it, holds a vote for the next height once, holds for the next height only proposals a validator signed, and admits one of two transactions checked at once for the pool's last place. `test/review5-node.test.ts` (25 cases) claims a data directory by its real path and releases it last, takes a stale claim over only while holding the takeover file, closes a store it was handed for a directory it claimed before giving the claim up, waits for whoever still reads the store before closing it, does not go on starting once it is being stopped and answers a closed store with an error, refuses every step of an iteration and every use of a writer once the disk environment is closed, reads the evidence age from the application when asked, stores nothing of a block whose application commit throws, prunes in one transaction with the set by height going with its block, answers for a past height with the set as that height had it, removes a validator set by hash once no header held names it, indexes a repeated transaction where it succeeded, undoes the writes of a memory environment transaction that throws, does not pool gossiped evidence that is too old, takes an item only from the peer asked for it, remembers no more than 2,048 fetches for a peer that announces and never answers, takes the block size from the genesis for every node alike, bounds a block by its transactions and evidence and a validator set by what a frame holds, and refuses a block with more than 16 pieces of evidence. `test/review5-app.test.ts` (17 cases) fails a store write under the application and writes the block again with a correct history, stops the application after a failure past the block's session, refuses a delegation to a validator with shares and no tokens and an authority no key leads to or that needs more signatures than a transaction carries, reads the state of the last root after writes outside a session, bounds the object types and the authenticated indices, and has the toy application refuse a validator key of another scheme than its set's. `test/review5-rpc.test.ts` (10 cases) stops a server's events with it, stops a server only once a method it was running has returned (the method ends within the server's one-second wait), replays a block event with the fields of a live one, opens an account stream only for an account there is, finds a validator by its operator's account id, keeps a key under a name every object inherits, and runs the command line for an unknown command, an asset of precision 0, a light client anchor of another chain and a block whose results the node lacks. State paging (`STATE-PAGING.md`) has cases of its
own: the arena suite grows slabs, counts dead bytes and compacts, and releases whole
slabs down to a byte limit, unread ones first; the database suite
evicts clean objects and never dirty ones, keeps history as bytes, checks that the
entries, chunks and nodes each root reports equal the trees when applied to a store,
plays randomised writes, nested sessions, roots, drops and rebuilds against a database
that never drops, and requires the roots, object proofs, key proofs and range proofs of
a dropped database to equal a resident one's at every version in the window, trims the
history window and lets it grow back against a database that never trims, reads every
version the store has a record of from those records with the window in memory trimmed
to two versions and to none (the roots, proofs and past values of a database that never
trims, and a refusal for a key proof from a record written without the sparse tree
nodes), and holds an
arena to a byte limit of zero over a store with the roots, proofs and reads of an
unbounded one; the
application suite restarts from the stored entries and trees, catches a tampered object
by the leaf check, fills in a store written before them, runs blocks with both tiers
dropped and rebuilt against an application that never drops, restarts with its whole
history window from a store written while the window in memory was trimmed, proves the
same heights from the store's records while it is trimmed, and opens a
store with no room for its tiers (both dropped, no history window read, the earlier
heights proven from the records left in the store) and with no room
in the arena (every object read from the store), running blocks on each with the hashes
and proofs of a resident application. All five phases are built;
the paging benchmark (`docs/benchmarks.md` section 4.13) ran a node on its defaults
under a heap limit of
1.25 times its resident state for 40 seconds: opened with its Merkle trees and its history
left in the store, through `warn` once, with the history window in memory cut to two
versions from then on and without reaching `pressure`, for 129
blocks and 72,092 transfers without an abort.

| module | what it is |
|---|---|
| `src/codec/` | deterministic binary writer and reader |
| `src/crypto/` | sha256, tagged keys and signing under ML-DSA-44 or secp256k1, verification worker pool |
| `src/types/` | validator set and proposer selection, votes, evidence, blocks, proposals, genesis, chain state |
| `src/consensus/` | the Tendermint state machine, vote sets, evidence pool, private validator with double-sign guard, block validation |
| `src/mempool.ts` | FIFO pool with checkTx admission and post-commit recheck |
| `src/p2p/` | transport interface, in-memory and TCP transports, wire messages, peer database, network with handshake and peer exchange |
| `src/node/` | block executor with crash recovery, the memory guard with load shedding and the collection scheduler, and the node that wires everything |
| `src/db/` | object ids, index keys, B+ tree, sparse Merkle tree with its nodes on disk, the arena of encoded objects (`arena.ts`), per-type indices with a bounded cache of decoded objects and droppable B+ trees, the index entries' disk form and the merged cursor over store and overlay (`indexstore.ts`), deep freezing of records (`freeze.ts`), dense Merkle tree with chunks and versions and a shared chunk cache for dropped trees, ICS23-shaped object and key proofs, the database with undo sessions, persisted history and the memory dials |
| `src/store/` | key-value interface with environment-wide transactions, in-memory and LMDB stores, block store on top with headers kept alone |
| `bench/` | benchmarks (`npm run bench`): crypto, codec, database, store, application, a four-validator network with block sync, and (`npm run bench:genesis`) a gigabyte genesis: load time, memory, disk, reads at that size, restart, then at that scale a live node serving RPC under load, scattered batch transfers, proofs at past heights, history, and a state-sync import, and (`npm run bench -- paging`) the same state under the memory guard: a node in a child process under a heap limit of 1.25 times its resident heap with its mempool kept full for 40 seconds, then the database through each mode the guard sets; `bench/cold-reads.ts`, run by hand, times index reads on that suite's store with none of it in the page cache |
| `src/light/` | light client with bisection forward and the hash chain walked backward, node-backed and RPC providers, and the checks on state, key and transaction queries |
| `src/rpc/` | JSON-RPC server with events and limits, JSON shapes, methods, a fetch client |
| `src/wallet/` | encrypted keystore, written under a lock file |
| `src/sync/` | batched block sync with backfill, and state sync from snapshots with the headers of the evidence window |
| `src/p2p/request.ts` | request and response matching over the peer protocol |
| `src/app/core/` | authorities, names, object types, transaction format, evaluators, staking rules, genesis, the core application, a signing client |
| `src/app/` | application interface and the key-value test app used by the engine tests |
| `scripts/localnet.ts` | N validators in one process driving the core app from a faucet |
| `src/cli.ts` | init a TCP testnet, start a node with its RPC under a heap limit (stopping with exit code 3 when the heap nears it), keys, accounts, transfers, staking, history, proofs and light-client verification over the RPC |

Known simplifications, all deliberate and all revisitable:

- Amnesia evidence (locking rule violations) is not detected. Only duplicate votes are.
- Vote verification is not rate limited per peer; a vote more than 1,000 rounds ahead
  of the node's round is dropped before its signature is verified.
- Proposals for the next height are held until it starts, 8 in all. One is held only
  if it is fresh (no proof of lock), its round is within 1,000, its block is of that
  height and its signature verifies with the key of the validator, in the next
  height's set, that the block names as proposer; a validator takes 2 places at most
  and one for a round, and a bad signature costs the sender 20 points. The test is
  on the proposal's signer, not on the peer that relays it: any peer may relay a
  proposal a validator signed, nothing takes a place without the signature of a
  validator of the next height's set, and the limits are counted by signer. Four validators that sign proposals for rounds that
  will not come can still fill the 8 and keep the real proposal out until gossip sends
  it again, which it does while its round lasts.
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
- History records are written in full per version and read back on restart (unless the
  store is opened paged for want of heap, section 4), so the provable window survives a
  restart; replaying the blocks missed while down then
  advances the window and drops the versions that fall out of it. A node that joined
  from a snapshot can prove nothing before the snapshot height.
- A failed transaction inside a block pays no fee.
- The size of a block is a rule of the chain, read from the genesis
  (`consensus.maxBlockBytes`, a whole number from 65,536 to 16,777,216, 4 MiB when
  absent) and from nowhere else: it is applied to proposals, to blocks being committed
  and to synced blocks, so every node must hold the same figure, and nothing a node is
  configured with changes it. It bounds what the proposer chooses, the encoded
  transactions and evidence. The header and the last commit are not counted: the header
  has a fixed shape and the commit one signature for each validator, so a limit that
  counted them could be one a large validator set cannot build an empty block under
  (with 64 KiB and 40 ML-DSA-44 validators the commit alone is more), and the chain
  would stop. An empty block is always within the limit, and a whole block is at most
  the limit plus its header and commit. The 16 pieces of evidence a block may carry are
  a rule of the chain as well. A proposer gives evidence at most half the limit, leaving
  the last pieces for later blocks, so the transactions always have at least half; that
  is the builder's rule, not one of validity.
- A validator set holds at most 2,000 members (`MAX_VALIDATORS`). A block travels with
  two commits, the one inside it and its own; with 2,000 ML-DSA-44 signatures in each
  (about 9.2 MiB for the two) and 16 MiB of block data it still fits the 32 MiB network
  frame. The core application's own cap is 1,000. An application whose update makes a
  larger set halts the engine, as a total power beyond the limit does.
- The limit on a transaction is mempool policy: the smaller of 1 MiB and half the
  block size less the four bytes of its length prefix. The builder gives evidence no more
  than the other half, so an admitted transaction always fits the next block it is first
  in line for, whatever evidence is waiting. A block's validity bounds a transaction only through the block's size,
  which every node holds alike, so nodes cannot disagree about a block over it.
- `maxClockDriftMs` (15 s) is a node's own setting. It is applied only to a fresh
  proposal (no proof of lock) when the node decides its prevote, never to a block being
  committed or synced. It is a rule for what a node votes for, like its clock, and
  nodes that differ in it still agree on every block.
- The claim on a data directory is a file, not an operating system lock, because Node's
  standard library has no lock the operating system holds; what follows comes of that. It trusts the
  pid in `LOCK`: a pid given since to an unrelated process makes a stale claim look
  live until that process exits. And a process killed in the few file operations for
  which it holds `LOCK.takeover`, while taking over a stale claim, leaves that file
  behind, and it is never removed automatically. If the stale `LOCK` is still there,
  every start on the directory fails naming the file until it is removed by hand
  (section 4); if the process had already removed the stale `LOCK`, the next start
  claims the directory without looking at `LOCK.takeover`, and the file is in the way
  only of a later takeover. A process killed between writing
  its private `LOCK.<pid>.<8 hex>` file and unlinking it leaves that file, which is
  harmless and can be deleted, and the claim is made with a hard link, so the directory
  must be on a filesystem that has them.
- When a block lengthens the unbonding period, the evidence window grows with it at
  once, but heights a pruning node deleted under the shorter window are gone: until a
  full new window has passed it refuses evidence that names them, and so a block that
  carries such evidence.
- A store write that fails under the application aborts the block's transaction and
  leaves the application's memory a block ahead; a failure while a block's root is
  taken leaves changes that cannot be undone. Either way the application refuses to go
  on and the node needs a restart, which finds the state of the block before.
- An authority is checked for keys that could satisfy it when it is set. A later
  change to a member account (`accountUpdate`) can still leave another account's authority with no keys
  that reach its threshold, or needing more than the 16 signatures a transaction
  carries. That is not checked again on purpose: refusing a member's update because of
  the accounts that name it would let anyone constrain another account's keys by naming
  it in an authority of their own. An authority that rests on another account takes
  that risk. The count of signatures an authority needs takes a key shared by two member
  accounts once for each, so an authority that shared keys would satisfy within 16 can
  be refused.
- In a store pruned by an earlier build the validator sets by height below the lowest
  block stay, and so do the sets by hash that only heights pruned then carried.
- `changedSince()` does not see an object removed outside a session since the last
  root. The node never writes outside a session.
- A validator restarted in the middle of a height forgets its lock: the sign state keeps what
  was signed, not the locked block, so after a restart it may prevote another block in a later
  round of that height. Tendermint's accountability for this (amnesia evidence) is not implemented.
- Index roots inside a type leaf are the SMT roots at that height; the B+ tree indices used for lookups are not authenticated.
- The version history window is trimmed in memory as the heap fills: from `warn` until
  the window has grown back, proofs and queries at heights older than the last two are
  read from the history records in the store, which is slower than from memory, the more
  so the further back the height, since every later record is scanned and nothing is
  cached: 0.1 to 0.35 ms per height back, 9 to 36 ms at the oldest of a hundred at 192,000 accounts, against a tenth of a millisecond or less from memory (docs/benchmarks.md 4.13). A store written before the
  records carried the sparse tree nodes cannot prove such a height until those records
  have aged out of the window (100 blocks by default). The recent transaction ids are
  still growth no dial sheds.
- The mempool is bounded by count, 10,000 transactions, not by bytes; each may be up to
  1 MiB, or four bytes under half the block size where that is less. Under pressure the node lowers the count it admits up to (a half at `warn`, a
  tenth at `pressure`) and evicts nothing: a pool already above the lowered limit stays as
  large as it is until blocks reap it.
- ArrayBuffers (ML-DSA keys, stored bytes, the arena's slabs) live outside the V8 heap and
  outside the memory guard's fraction; a machine that runs out of physical memory for them
  meets the operating system's killer, not V8's limit. The guard reports `arrayBuffers` and
  `rss` beside the heap figures but acts on the heap alone. The arena's share of them can
  be bounded by hand (`start --arena <MiB>`); nothing bounds it automatically, and the
  current slab (16 MiB at most) always stays.
- What the memory guard can drop saves about half of the resident heap, not more: with
  the cache capped and both tiers dropped the database runs on 57% of it in the current
  mode table, on a state with a full history window, and on 40 to 50% in an earlier
  build's run on a state with no history yet (at
  192,000 accounts the index trees give back 181 MiB and the Merkle trees 223 MiB; in the
  earlier run 130 to 175 MiB, 190 to
  220 MiB and the cache up to 190 MiB), at the throughput it has resident or above it,
  now that the dropped trees' chunk cache holds 4,096 chunks. Those figures are the
  database's alone. A node held at its resident heap or 0.8
  times it, with the history window trimmed and the mempool's limit following the level,
  committed 1,570 to 1,610 transfers a second for ten minutes, refused nothing after
  its first two seconds and did not reach `pressure`; under a full load it is about a
  tenth faster with its index trees in the store than with them resident
  (docs/benchmarks.md 4.13), which is why they go at `warn`, the history window with
  them for the heap it holds (1,320 to 1,360 while they
  went at `pressure` and the account history was keyed by account). So a node now
  leaves its index trees in the store unless told otherwise (`indexTrees: 'store'`, the
  default) and gives up little: beside the load a lookup by key takes 4 to 7 microseconds at the median either way and a
  page of twenty 31 to 34 against 17 to 18, with a longer tail (docs/benchmarks.md section 4.13). With
  `indexTrees: 'memory'`, for a node that mostly serves scans, it starts with them
  resident when they fit and rebuilds them when the heap has stayed at `ok` long enough.
  An index read that reaches the device, measured on a store read cold without a node,
  takes of the order of 140 to 320 microseconds against 1 to 3 from the page cache for a
  lookup; a node under
  load on a machine whose memory the store exceeds is not measured. A store whose
  tiers do not fit within half the heap limit is now opened with them dropped and without its history
  window in memory, the heights before the one it opened at proven from the records in
  the store and the window filling a block at a time; that took the floor for `--heap` from two thirds of the
  resident heap to a quarter under the benchmark's load. The store holds the sparse trees' current nodes, and their overwritten ones only inside the
  history records. A restart that reads the window now takes their past versions from
  those records; it used to replay every account for them, most of what remained of a
  restart (3.5 s of 5.2 at 192,000 accounts; the same restart is now 2.85 s, the history
  2 ms of it, and leaves 381 MiB of heap where it left 572), and still does
  for a window that holds a record written before the nodes were kept. And chunks of 1,024 hashes on disk make a
  block scattered over the state rewrite nearly every chunk it touches, a fifth of the
  commit at that size when the chunks were first written; smaller chunks would cut it about in half.
