# Transaction proofs, RPC and sync specification

Status: implemented in three stages as laid out below (tests: `txproof`, `rpc`,
`sync`, and additions to `chain` and `engine`). Decisions were taken in conversation
on 2026-10-28 after a review of the implemented chain (`DESIGN.md` sections 1 to 9,
`STAKING.md`). Settled during implementation: validator sets are stored by the
height they sign with their proposer priorities so a joiner continues consensus
exactly; the `light` CLI subcommand takes the target first; history entries are
recorded only for transactions that succeeded.
Economics, governance beyond staking parameters, and cross-chain connections are
out of this round; proofs stay ICS23-shaped for the latter.

## 1. Summary of decisions

| topic | decision |
|---|---|
| transaction proofs | Merkle data hash for inclusion; a results hash in the next header for success and error, deferred like the app hash |
| header | breaking change now, with a protocol `version` field added at the same time and checked by validation |
| transaction index | by hash in the chain store, one entry per block a transaction is in; per-account operation history in the app store, one entry per operation, including virtual operations |
| wire protocol | JSON-RPC 2.0 over HTTP, decoded objects as JSON, proofs and raw transactions as hex of the binary encoding |
| broadcast | `sync` (after checkTx) and `commit` (after inclusion, with the result) |
| push | Server-Sent Events: blocks, transaction results, account history, validator set changes |
| exposure | loopback by default, configurable bind, an optional shared token (`Authorization: Bearer`), CORS open, body and per-address rate limits; costly calls and new streams refused while the node sheds load under memory pressure |
| keys | encrypted keystore, scrypt and AES-256-GCM, each key recorded with its signature scheme, passphrase on signing, a lock file around every write |
| CLI | an RPC client; the inbox file and read-only store access are removed; the light client gets an RPC provider |
| state sync | periodic snapshots every K blocks, last two kept, chunks with range proofs baked in, served over p2p; the headers of the evidence window below the join, installed with the state in one transaction |
| trust anchor | operator supplies a trusted height and header hash; the light client bisects to the snapshot height and walks the hash chain back for earlier heights |
| gap | old blocks backfilled in the background after joining; can be disabled |
| hardening | batched block sync from several peers, evidence gossip, immediate fetch of a block seen in +2/3 precommits, peer scoring and bans |
| retention | configurable blocks kept, provable window, snapshots kept; headers kept alone go with the evidence window |
| staging | headers and proofs, then RPC and wallet, then sync |

## 2. Stage one: headers, transaction proofs, results, indices

### 2.1 Header

Two fields are added and one changes meaning.

- `version` (u32): the protocol version. Genesis carries it under `consensus.version`
  and chain state keeps it; validation rejects a header whose version differs from
  the state's. The first version with this header is 1. Future breaking changes bump
  it, and a later upgrade mechanism can switch it at a height; for now it is fixed per
  chain.
- `dataHash`: the root of a dense Merkle tree (`src/db/merkle.ts`) over the block's
  transactions, leaf key the u32 position, leaf value the raw transaction bytes, in
  the ICS23 leaf shape already used for state. An empty block hashes to the empty
  value.
- `lastResultsHash`: the root of the same kind of tree over the previous block's
  transaction results, leaf key the u32 position, leaf value `encode(ok: u8, error:
  string)`. Height 1 carries the empty value. Deferred like `appHash`: the results
  of block N are committed by header N+1.

The executor computes the results root from `finalizeBlock`'s results and keeps it
in chain state as `lastResultsHash`; block validation checks the header's value
against the state, as it does for `appHash`. The genesis files `init` writes change
shape; existing data directories are discarded.

One more field was added at the end of the header later:

- `prioritiesHash`: `sha256(P(validators) ‖ P(nextValidators))`, where `P(set)` is the
  SHA-256 of the set's priorities (an array of i64 in the set's order) followed by its
  proposer's index (i64). `validatorsHash` and `nextValidatorsHash` cover members and
  powers; with this a header names both sets exactly. Validation checks it against the
  state's two sets.

There is one protocol version, 1; a node starting a chain from a genesis that names another refuses it (a node opening a store it already has, or joining by state sync, takes the version from its state or the verified header and does not look at the genesis again).

### 2.2 Proofs

- `TxProof { height, index, tx, siblings }` verifies against `header(height).dataHash`.
- `ResultProof { height, index, ok, error, siblings }` verifies against
  `header(height + 1).lastResultsHash`.

Both are ordinary dense-tree path proofs. Neither states how many transactions the
block has: the root commits to the tree's height, which is the path's length, and not
to the count, so a proof carrying one would state something it does not prove. The
verifiers require the index to be one the path's length can address (`index <
2 ** siblings.length`), and the decoders read at most 32 siblings; a leaf is hashed
apart from an inner node, so a path of another length cannot lead to the same root.
`src/types/txproof.ts` holds the two verifiers,
and `src/light/client.ts` gains `verifyTx`, which verifies headers `height` and
`height + 1` and checks both legs. The transaction hash is `sha256` of the raw bytes,
which the mempool already uses.

### 2.3 Transaction index

The chain store gains `'x' || segment u64 || txHash || height u64 -> (height u64,
index u32, ok u8, error string)`, written by the executor in the same transaction as
the block. The segment is the height divided by 32 (`TX_SEGMENT_BLOCKS`). A
transaction that failed can be included again, so one hash can have several entries,
one per block that carries it: `txLocations(hash)` lists every block still held that
carries the transaction, oldest first, and `txLocation(hash)` is the block it
succeeded in if there is one, else the newest. Within one block a hash is indexed
once: at the first position where it succeeded, or at its first position when it
succeeded at none. So a block that carries a transaction twice, failing at the first
position and succeeding at a later one (a proposer can build such a block; the
mempool never offers one), is indexed at the later one, and `tx` reports the success.
Pruning a block removes that block's
entry only.

The segment comes first in the key because of what a write costs. Keyed by the hash
first, the entries of one block land anywhere in the index, and once the index is
large each of them is on a 16 KiB page of its own, so a block's write grows with the
chain (docs/benchmarks.md section 4.13). Keyed by the segment first, a block's
entries lie among those of the few blocks around it, on pages that are being written
anyway. The price is the lookup. `txLocations(hash)` asks each segment the store
holds for the hash: it reads from where the hash would be in a segment, and the first
key there is either an entry of the hash or names the next segment that has anything,
so segments with no entries are passed over. That is a read or two per segment that holds something
instead of one range read.

With segments of 32 blocks alone a lookup would grow with the blocks a node keeps,
some 60 ms over a million. So behind them come larger segments, each holding 32 of
the level below: level 1 is 1,024 blocks, level 2 is 32,768, and so on to level 11,
under `'y' || level u8 || segment u64 || txHash || height u64` with the same value.
Once the 32 segments of a larger one are all behind the latest block, and none of its
blocks is below the lowest height, their entries are copied into it and then removed
(`mergeTxLevel`), a step with each block whose transactions are indexed, of three
times the block's entries or 512. The latest block is the highest one saved with its
results (`'M'`), so the blocks a backfill stores make their steps too, behind the
block the node last applied. The copy merges the 32: it takes the entries that come
next in the order of hash and height, whichever of the 32 they are in, so the larger
segment is written in the order of its keys. The removal goes through the 32 front to
back; an entry the larger segment holds with the same value is removed, and one it
does not (it arrived, or was written again, after the copy had passed its place) is
written there first. Where the work stands is under `'m' || level u8`, written with
the entries. A segment's move takes the blocks that follow its becoming due, a few
hundred for a full segment of level 1, and until it is done its entries are found
where they still are.
A lookup asks level 0 and then each level above, a few dozen segments a level: 44
reads and 0.11 ms over 20,000 blocks of 500 transactions in a probe, where the small
segments alone took 632 reads and 1.42 ms. A node pays for it with 3 to 5
milliseconds of a block's save while a move is under way (docs/benchmarks.md section
4.13). An entry above level 0 is a copy: it is not removed with its block but dropped
with its whole segment once that lies below the lowest height, and a lookup answers
with one only if the block of its height is still held.

The index was first keyed `'t' || txHash`, one entry per hash, the last block written
winning, and then `'t' || txHash || height`. Both have the height in the value. A
store of either layout has its entries moved into the segments once, when it is next
opened (`migrateTxIndex`), 5,000 entries a write, and `'T'` records the layout (3)
with the last write, so a move that was cut short is taken up again. A store opened
read-only is left as it is and its old entries are read where they lie, under
`'t'`; any other failure of a write of the move stops the store from opening. The index is derived data,
outside the state root, and is rebuilt by replay or by backfill (section 4.2).

### 2.4 Account history

The application keeps, outside the state root, one history entry per operation per
account the operation names, plus virtual entries for what the chain does on its
own. Only the operations of transactions that succeeded are recorded; a failed
transaction has no effect and is found through the transaction index. Stored in the
application's own store, next to the objects:

- One log in block order: `'l' || place u64 -> account u64, sequence u64, prev u64,
  skip u64, entry`. `place` grows by one per entry, so a block's entries are
  consecutive keys at the end of the log. `sequence` counts up per account from 0.
  `prev` is the place of the account's previous entry, and `skip` the place of its
  entry whose sequence is this one's with its lowest set bit cleared (entry 12 points
  at 8, 8 at 0, 7 at 6); each is `0xffffffffffffffff` where there is no such entry.
- `'p' || accountId -> count u64, place of the newest entry u64`, the account's head,
  and `'L' -> the log's length u64, covered u64`, where `covered` is how many of the
  log's entries the stored heads account for: the place in the log of the oldest
  change whose head is still waiting to be written, or the length when none waits.
- The heads are keyed by account, so writing them at every block would be scattered
  writes again. The heads a block changes wait in memory, in 64 slices of the account
  numbers (`HistoryLog.SLICES`), and every block that has entries writes the waiting
  heads of one slice, the next in turn: a block writes neighbours in the store, no
  single block carries the whole batch, and a head is written within 64 such blocks
  of its change while the span of the slices stays as it is. A slice spans one account
  number at first, and the span doubles (slices 2i and 2i+1 becoming slice i) whenever
  an account number beyond the last slice turns up. A doubling moves the waiting heads
  to their new slices without moving the turn, so a head whose new slice the turn has
  just passed waits up to 64 blocks more; the log covers it meanwhile, as below. All the slices are written at once only when 50,000 heads wait
  (`HistoryLog.HEADS_HELD`), or when a store with the earlier layout is moved into
  the log. The log is their journal: a log opened after a stop reads the entries
  from `covered` to the end, each of which names its account and sequence, and has
  the waiting heads back.
- An account is read from its newest entry backwards: the skip pointer while it does
  not pass the sequence wanted, else the previous entry, so any entry is found in
  about log² steps and a page from the old end of a long history does not walk the
  whole of it. Writing an entry finds its `skip` target by the same walk.
- The entries were first stored as `'a' || accountId || sequence u64 -> entry` with
  `'q' || accountId -> next sequence`. A block of transfers names accounts all over
  the state, so those keys dirtied a store page for every account a block named,
  where appending to the log writes a few pages a block. A store written with the earlier layout
  is moved into the log the first time it is opened, by height and with each
  account's entries in their order, and the old keys are removed in the same write
  (`HistoryLog.migrate`, `src/app/core/history.ts`).
- `entry = { height, position (u32, 0xffffffff for a virtual entry made outside a transaction; `unjail`'s, made inside one, keeps that transaction's position, hash and operation index), opIndex (u32),
  kind (u8), txHash (option), data (bytes) }` where `data` is the encoded operation,
  or the encoded virtual operation. There is no result in the entry: every recorded
  operation succeeded.
- Accounts named by an operation: transfer from and to; accountCreate registrar and
  the new account; accountUpdate account; assetCreate and assetIssue issuer, and the
  recipient of an issue; validatorCreate and validatorUpdate operator;
  delegate, undelegate and redelegate delegator and the validators' operators;
  unjail, proposalCreate and proposalSignal operator.
- Virtual operations: `reward { validator, amount, commission }` to the operator,
  `slash { validator, amount, doubleSign }` to the operator (`doubleSign` is true for
  a slash on evidence of any kind and false for downtime), `jail`, `unjail`,
  `tombstone` to the operator, `unbondingMatured { validator, tokens }` and
  `redelegationMatured` to the delegator, `forcedUnbond { validator, tokens }` to
  each delegator of a tombstoned validator. Rewards are recorded per payment to a
  validator, not per delegator: a delegator's share is implicit in the exchange rate. A
  proposer that also signed the previous commit gets two entries in the block, one for
  the bonus and one for its share as a signer.

Entries are collected during `finalizeBlock` and written by `commit`, so a crash
between the two is repaired by the existing replay. A store write that fails takes
the log back to what the store has (`HistoryLog.rollback`: the length, the coverage
and the waiting heads are read again), and the block's entries are appended again
when the block is next written. A node that state-synced has
history only from its snapshot height; replay from genesis is the way to get all
of it. Block pruning never touches account history, which grows for as long as the
node runs.

## 3. Stage two: RPC, events, keystore, CLI

### 3.1 Server

Built on `node:http`, no framework. `POST /` takes a JSON-RPC 2.0 request or a batch
of 1 to 20, executed in order; `params`, when present, must be an object, and a
request id must be a string, a number or null. A request without an `id` member is
a notification: it is carried out and not answered, not even with an error (an
unknown method, bad parameters, a rate limit or a failure all go unreported); a
single notification, or a batch holding only notifications, gets HTTP 204 with an
empty body, and a mixed batch an array holding only the answers to the requests
that carried an id. An object that is not a request at all (no `jsonrpc: '2.0'`, no
string `method`, an id of another type) is answered `-32600`, with its own id when
that is a string, a number or null and with `id: null` otherwise.
`GET /events` is the Server-Sent Events stream. `GET /health` returns height, peer count and
the memory guard's level (`memory`). Default bind `127.0.0.1`
on the p2p port plus one; config `rpcListen` sets host and port. Responses carry
`Access-Control-Allow-Origin: *`. With `rpcToken` set in the node's config, `POST /` and
`GET /events` answer 401 to a request that does not carry it as `Authorization: Bearer <token>`
(the event stream also takes `?token=<token>`), and such a request spends a token of the
address's bucket like a call; once the bucket is empty the answer is 429. Neither has a body. Bodies over 1 MiB are rejected with HTTP 413. Each
remote address has a token bucket of 50 tokens per second with a burst of 100: every
`POST /` costs one token, which covers its first call (`OPTIONS`, `GET /health` and a
`GET /events` without replay cost none); each further call of a
batch costs one more, taken before its method is looked up; and a costly method
(`block`, `object`, `key`, `account`, `validator`, `delegation`, `balance`,
`accountHistory`, `tx`, `broadcastTx`, `accounts`, `proposals`, whether or not a
proof is requested) costs four more when it is dispatched, so a batch costs what its
calls would have cost one by one. An empty bucket at
the request stage returns HTTP 429 with a `-32004` error body; at the dispatch stage,
or for a further call of a batch that cannot pay,
it returns the `-32004` error for that call in its place inside an HTTP 200 response. At most 8
event streams per address, and a reconnect that asks for replay pays the costly
price; over either limit the stream request gets HTTP 429. While the node sheds load
under memory pressure (DESIGN.md section 4), a costly method other than `broadcastTx` is
answered `-32004` with `node under memory pressure` before the four tokens of a costly
call are taken, and a `GET /events` request gets HTTP 503; cheap methods, `/health` and
the streams already open are unaffected, and `broadcastTx` is still served, the
mempool's lowered limit being its throttle then.

### 3.2 Encoding

- bytes: lowercase hex, no prefix; hashes, addresses, public keys, signatures. A public
  key or signature is hex of its tagged bytes, the first byte naming the scheme
  (DESIGN.md section 5): 1313 or 34 bytes for a key, 2421 or 65 for a signature,
  under ML-DSA-44 or secp256k1. The binary encodings the RPC passes through as hex
  (a commit's signatures, a validator set's keys, an authority's keys, a transaction's
  signatures; likewise a vote, a proposal, the p2p hello and the handshake signatures)
  read the tag and then that scheme's size, in place of the fixed size they read before.
- 64-bit integers: decimal strings. Smaller counters: JSON numbers.
- object ids: `"type.n"`. Times: decimal strings of unix milliseconds.
- objects: decoded per type with the TypeScript field names; authorities expanded.
- proofs and raw transactions: hex of the chain's binary encoding, which the
  existing verifiers decode. The RPC never re-serialises a proof.
- headers and commits: JSON with hex fields; a missing signature is `null`.
- errors: JSON-RPC error objects; `-32700` parse error (HTTP 400), `-32600` invalid
  request (a batch outside 1 to 20 is refused whole with HTTP 400; a malformed member
  is answered in its place), `-32601` unknown method (a name every JavaScript object
  inherits, such as `toString` or `constructor`, is unknown like any other: the method
  table is asked only for names of its own), `-32602` for bad parameters, `-32001`
  not found, including a state query for a height the application does not hold, `-32002` check failed (with the application's message), `-32003`
  timeout, `-32004` rate limited, `-32000` with `server is stopping` for a request that
  reaches dispatch once the server has begun to stop.

### 3.3 Methods

| method | parameters | returns |
|---|---|---|
| status | | chain id, protocol version, `signatureScheme` (`ml-dsa-44` or `secp256k1`), latest height, hash and time, app hash, catching-up flag, lowest retained height, the height joined at by state sync (or null), peer count, validator address if any, `memory` (the guard's `level`, whether the node is `shedding`, and in bytes `heapUsed`, `heapLimit`, `heapTotal`, `arrayBuffers`, `external`, `rss` and, under a heap limit, `heapOld`, the old generation's use, from which the level is taken; and `database`, the object database's own figures as `ObjectDatabase.memory()` gives them, or null for an application other than the core one), `gc` (`available`, that is whether collections can be scheduled; the collections V8 ran since start as `collections`, `minor`, `major`, `incremental` with their pauses `totalMs`, `maxMs`, `lastMs`; and the `scheduledMinor` and `scheduledMajor` ones the node asked for), `rpcVersion` 1 |
| genesis | | the genesis document, `signatureScheme` included when the file names one (absent means `ml-dsa-44`), without `appStateFile`: an application genesis kept in a file is not served |
| header | height? | header; below the lowest retained block, a header the node keeps alone (section 4.2), where `block` and `commit` answer `-32001` |
| block | height? | header, transactions (hex), lastCommit, evidence, and the block's own commit |
| commit | height? | the commit for that height |
| validators | height? | the set that signs that height: hash, total power, proposer address (`null` for a height whose set the node holds only by hash, a backfilled block or a header kept alone), members with address, public key and power (no priorities) |
| validatorSet | hash | a set by hash, same shape |
| object | id, height?, prove? | type, height, the object as of that height or null, with `proof` hex when asked |
| key | type, index, key (hex), height?, prove? | `{ height, id, proof? }`: the object id the key mapped to at `height` (`"type.n"`) or null, read from the key proof at `height`, which is returned when asked; the index must be authenticated, and for a non-unique one the key is an entry, the index key followed by the object's id |
| account | name, height?, prove? | `height`, the account object or null; with it the balances (asset symbol, id, precision, amount), the operated validator's id or null, and the history count, all as of `height`; the name proof at `height` when asked |
| validator | operator or id (either takes the operator's name, the operator's account id or the validator's id), height? | `height`, the validator object with status, active flag, power, self-bond and operator name as of `height`; `delegators`, the count of its delegations as of `height` |
| delegation | delegator, validator, height?, prove? | `height`, the delegation with its tokens' worth as of `height` or null; `unbonding`, the entries pending as of `height`; the key proof at `height` when asked |
| balance | account, asset?, height? | `height`, account id, asset id, amount as of `height` |
| accountHistory | account, from?, limit?, reverse? | entries with sequence numbers, and the total; pagination below |
| tx | hash, prove? | `{ hash, height, index, ok, error, tx, decoded, attempts?, proof? }`: the block the transaction succeeded in if there is one, else the newest that carries it; `attempts` lists height, index, ok and error for every block still held that carries it, oldest first, when there is more than one; `proof` holds `txProof`, the signed header, and `resultProof` with the next signed header, or nulls for those while the next block does not exist. The lookup by hash costs a read or two for each segment of the index that holds something, a few dozen a level however many blocks the node keeps (section 2.3; 0.11 ms over 20,000 blocks of 500 transactions in a probe) |
| broadcastTx | tx hex, mode? (`sync` default, or `commit`), timeoutMs? (default 30 000, at most 120 000) | `sync`: `{ hash, status }`; `commit`: `{ hash, height, index, ok, error }` once included; `-32004` while the mempool is full at a limit lowered under memory pressure, or paused |
| accounts | after? (name cursor, exclusive), limit? | accounts by name with id and core balance |
| parameters | | height, core asset (id, symbol, precision), maximum transaction expiration, the fee schedule and the staking parameters in force |
| proposals | | open proposals, soonest to expire first, each with the full parameters it would adopt |
| mempool | | count, bytes, the first 100 hashes |
| peers | | connected peers: id, address, direction, height, latency, and `clockOffsetMs`, how far the peer's clock is ahead of this node's by its last pong (null before the first) |
| snapshots | | reserved: an empty list (snapshot heights are exchanged over p2p, not the RPC) |

Omitted heights default to the latest. An `account` or `delegator` parameter takes
an account name or id; a `validator` parameter, and `operator` or `id` of the
`validator` method, takes the operator's name, the operator's account id or the
validator's id: an id of the account type is resolved through the operator index at
the height asked, as a name is, any other id is taken as a validator's, and an account
that runs no validator is `-32001` with `<ref> runs no validator`. The `account`
method itself takes a name. Every state query (`object`,
`key`, `account`, `validator`, `delegation`, `balance`) answers as of one height, the
one in `height` or the last committed one, and returns it, so a value and the proof
beside it are about the same state. A height outside what the application holds, from
its lowest provable height to the last committed one, is refused with `-32001` and
`the state at height H is not kept (heights A to B are)`. An authenticated index is read at
the height from the index's own tree: the key proof is made first and the id taken
from its leaf (for a non-unique index `key` takes one entry, the index key followed by the
object's id, and answers that id or null), and the live index, which holds the writes of the block in progress
and says nothing of a past height, is not asked. `account` finds the account through
the name index at the height and reads it, its balances, its validator and its
history count as of it; a balance object is never removed, so the balances the
account has now are all it ever had, each read as it was then, one created since
reading as absent. A name that cannot be an index key (one holding a zero byte) gives
`account: null`, and with `prove` a `-32602` error, there being nothing to prove. The
name is not checked against the rules for account names: any other name no account
has, `A` for one, gives `account: null` and with `prove` a proof of absence. `balance` by a name that had no
account at the height is `-32001`; by id it is 0. Two fields list objects that are
removed, which the index of today no longer holds: `validator`'s `delegators` (a
delegation goes with its last share) and `delegation`'s `unbonding` (an entry goes
when it matures). Both are answered for any height the node holds: to the ids the
index gives now are added, at a past height, those of the type that a later height
created, changed or removed (`ObjectDatabase.changedSince`), and each is read as of
the height and kept if it existed then and belongs to the validator, or to the
delegator and the validator. At the latest height that is the index scan and the
objects of the type that an open session (the block in progress) has removed, which
the committed answer still holds; at a
past height it costs one read as of the height for each object of the type changed
since, and for a height older than the window in memory one history record, read
once and decoded, for each height between the one asked for and the window.
`accountHistory` and the listings read the latest state.

Pagination: `accountHistory` returns 20 entries by default and at most 100, oldest
first from sequence `from` (default 0); with `reverse`, entries come newest first and
`from` is an offset from the newest entry, not a sequence number. `accounts` starts
after the name in `after` and returns at most `limit` (default 50, at most 200),
`limit: 0` being honoured.

Broadcast: `sync` answers after checkTx with status `added` or `seen`. `seen` means
the hash is in the pool or in the mempool's recently-seen cache, which includes
transactions it rejected earlier and ones already committed; it is not inclusion. Admission failures
(`invalid`, `too-large`, `full`) are `-32002`, except that a pool found `full` while
the memory guard's level is not `ok` answers `-32004` with the pool's reason (`mempool
full: its limit is lowered while the node is short of memory`), the transaction not
being at fault; a mempool paused at the guard's `critical` level answers `paused`
inside the node and `-32004` with the reason, `node out of memory`, over the RPC.
`commit` waits for inclusion: a
transaction seen before that is neither pending nor committed is refused at once
(`-32002`) rather than waited for; a timeout answers `-32003` and leaves the
transaction in the mempool, where a later `tx` call can still find it once included;
once 1 000 commit waits are outstanding a further one answers `-32004`, and the
client should broadcast in `sync` mode and poll `tx`. When the server is stopped,
every wait outstanding is answered at once as a timeout is, and the server's
listener is taken back from the executor (`BlockExecutor.onCommitted` returns the function
that removes it), so a node whose server is replaced keeps nothing of the old one.
Stopping closes idle connections at once and cuts one in the middle of a request after
a grace of one second (the caller may give another; the CLI gives none when it stops
for want of heap). A connection that is cut does not end the method its request
called, so the stop then waits, one second at most, for the requests still being
handled, each until its method has returned and its answer is written: a broadcast
that was waiting on the mempool and ends within that second has ended before the stop
returns, and whoever closes the node's stores afterwards does not close them under it.
A method that takes longer is not cancelled, and the stop returns without it. When it
next touches the store of a node that has stopped, the store throws `StoreClosedError`,
`the store is closed` (every call on a closed LMDB environment does, from the moment
its close is called), and the method's handler turns that into an error answer on a
connection already cut. A request that reaches
dispatch once the server is stopping is answered `-32000` with `server is stopping`
and its method is not called.

### 3.4 Events

`GET /events?types=block,tx,account,validatorSet&tx=<hash>&account=<name or id>`.
`types` left out means `block`; an unknown type is answered HTTP 400, and an `account`
that does not exist 404: a name no account has, an id no account has, an id of
another type or one that is malformed, and any `account` on a node whose application
is not the core one.

- `block`: height, hash, time, transaction count, the count of failed transactions,
  app hash, proposer address.
- `tx`: hash, height, index, ok, error; filtered to one hash when asked.
- `account`: an account's new history entries; filtered by account.
- `validatorSet`: height and the updates the application emitted.

Event ids are heights; a reconnect with `Last-Event-ID` replays `block` events from
the store, at most the last 1000 blocks, with the fields of a live event
(`blockEventJson` makes both), and stops at a missing block. On replay the count of
failed transactions is taken from the stored results; it is `null` for a block with
transactions whose results the node does not hold (one it backfilled after a state
sync) and 0 for an empty block. A stream whose
client has more than 1 MiB queued unread is ended; it resumes with `Last-Event-ID`.
No stream is opened while the node sheds load: the request is answered HTTP 503, and the
client retries once `/health` reports `ok` or `warn`.
`broadcastTx` in `commit` mode is implemented on the same internal listener, with at
most 1000 waiters at once. A call in that mode whose transaction the mempool reported
`seen` and no longer holds looks the hash up in the transaction index, in case the
transaction is already in a block, at the cost of a `tx` lookup
(section 2.3); one whose transaction is pending, just admitted or admitted before, waits
for the block and makes no lookup.

### 3.5 Light client over RPC

`src/light/rpc-provider.ts` implements `LightProvider` with `fetch` against the
methods above, `header` serving the headers alone that backward verification walks.
The CLI keeps its trusted state in `light.json` next to the keystore (`{ chainId,
height, hash }`) and updates it as it verifies forward. A file that names another
chain than the node's stops the command with exit code 1 and `<path>/light.json holds
a trusted header of chain X, and this node is on chain Y; use the keystore directory
of that chain, or set a new anchor with: light <target> trust <height> <hash>`; a file
written before the chain id was kept names none, is accepted and is written back with
it; `light <target> trust` overwrites the file.

A height before the trusted one is verified backwards: the client walks down from
the trusted header one header per step, each required to carry the expected height
and to hash to the `lastBlockHash` of the one above it. No commit is checked on the
way, since every header names the hash of the one before it and the trusted header
stands for the whole chain before it. The walk is bounded by `maxBackwardSteps`
(default 100 000; beyond it the client asks for an anchor nearer the height), the
headers passed are cached by height (10 000, cleared when full), and the trusted
header does not move. `verifyState`, `verifyKey` and `verifyTx` take whichever
direction the height needs, so `verify-tx` and `account` work for heights before
the anchor.

### 3.6 Keystore

`keystore.json`: `{ version: 2, kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt },
keys: { [name]: { address, publicKey, scheme, iv, ciphertext, tag } } }`. One key is
derived from the passphrase and the salt; every seed is sealed with AES-256-GCM under
it with its own IV. `scheme` is `ml-dsa-44` or `secp256k1`, the scheme the seed's key
pair is derived under. A version 2 file names the scheme of every key, and a key in
it with no `scheme` is damaged (`key <name> names no scheme; the keystore entry is
damaged`). A version 1 file, written before, may hold keys sealed before the field
existed; such a key has none and is read as ML-DSA-44. A version 1 file is read as it
is, reading never writes, and the next change (`add`, `remove`) writes it as version
2 with every key's scheme filled in. Any other version is refused with `unsupported
keystore`, on opening and on every write. A key may have any name, `constructor`,
`toString` and `__proto__` among them: the keys are held in an object without a
prototype and looked up as its own properties. The passphrase comes from `--passphrase-file`, the `CHAIN_PASSPHRASE`
variable, or a hidden prompt. Commands: `keys add <name> [--scheme <name>]`, `keys
list` (name, scheme, address), `keys import <name> <seed hex> [--scheme <name>]`,
`keys export <name>`, `keys remove <name>` (prints `removed <name> <address>`; the
seed goes with the entry, and a name that is not there is refused with `no key named
<name>`); `--scheme` is ML-DSA-44 when absent, and a chain refuses a key
of the other scheme. `init [--scheme <name>]` writes the faucet and operator keys, of
the chain's scheme, into the testnet's keystore and prints the passphrase it chose.

Every write (`create`, `add`, `remove`) takes a lock file `<keystore>.lock` beside the
file, created exclusively and retried every 20 ms for up to 5 s (a lock older than
30 s was left by a process that died and is removed; otherwise the write fails with
`<path> is locked by another process`), re-reads the file from disk, whose `kdf.salt`
must be the one this handle derived its key from (else `<path> was recreated with
another passphrase; open it again`), applies the change to the keys as they stand
there, writes the file atomically and releases the lock. So two handles, or two
processes, over one keystore keep each other's keys; a name that appeared meanwhile
is refused with `key <name> already exists`. `list` and `has` reflect the file as the
handle last read or wrote it.

### 3.7 CLI

A client command names a node directory (its RPC is `http://127.0.0.1:<p2p port + 1>` unless
`rpcListen` says otherwise, and its keystore sits next to the testnet) or a URL; `--rpc <url>`
sends a directory target's calls elsewhere while keeping its keystore. `create-validator`
needs the directory, since it reads the consensus key from it, and derives that key with
the chain's scheme; `create` makes the new account's key in the chain's scheme too, both
asking `status` for it. `start` opens the RPC. The
inbox file, the read-only store opening and the per-account seed files go away. `show`
reads through the RPC.
New: `history <target> <account>`, `tx <target> <hash>`, `verify-tx <target> <hash>`
(light-client verified), `light <target> trust <height> <hash>`,
`light <target> verify [height]`.

No command, or one the CLI does not know, prints `usage: see the comment at the top of
src/cli.ts` and exits with code 1, whatever follows it; a known client command without its
target says `missing target` (`start` says `missing node directory` and `join` `missing dir`). Amounts of an asset of precision 0 are printed without
a decimal point. `verify-tx` prints `verified: included at height H, succeeded` (or
`failed: <error>`) when both proofs check; `included at height H; this node does not
hold the results of that block` when the node holds the next block but not the
results, having fetched the block after a state sync; and `included at height H;
result not yet committed` only while there is no next block.

## 4. Stage three: snapshots, state sync, hardening, retention

### 4.1 Snapshots

Every K blocks (`snapshotInterval`, default 1000; 0 disables) at heights divisible by
K, after commit, the application exports its state at that height:

- Per type, in id order, chunks of C instance slots (`snapshotChunkObjects`, default
  2000, at least 1): `{ height, type, index, from, to, objects: [instance, bytes][],
  siblings }` covering instances `[from, to)` below the type's counter. Removed
  instances are holes, so a chunk may hold fewer than C objects or none at all;
  `siblings` are the hashes needed to fold the chunk's leaves (the empty hash for a
  hole) to the type root at that height (the standard range proof over a complete
  binary tree, read from the dense tree inside its version window at export time).
- A manifest: `{ format (1), height, appHash, chunkObjects, types: [{ type,
  nextInstance, typeRoot, indexRoots, typeIndex, typeCount, topSiblings,
  chunkHashes }] }`, one entry per registered type in id order, where `topSiblings`
  is the type leaf's path up the top tree and `chunkHashes` are sha256 of each
  chunk's encoding; the chunk count is their length.

Stored in the application's store under a manifest key per height and a chunk key per
height, type and chunk number; the last `snapshotsKept` heights are kept (default 2,
at least 1). New p2p messages `snapshotsRequest`, `manifestRequest(height)` and
`chunkRequest(height, type, n)` serve them; the status message carries only the
height, so a joining node asks for snapshots explicitly.

### 4.2 State sync

Config: `stateSync: { trustHeight, trustHash, backfill?: true }`. On an empty data
directory with a trust anchor:

1. Wait for a peer (30 s, then fall back to replay from genesis) and a moment for a
   second one. Fetch headers, commits and validator sets from peers
   (`headerRequest(height)` and `validatorSetRequest(hash)` are added as p2p
   messages) and start the light client from the anchor, which must be younger than
   the trusting period (4 days by default) and not from the future.
2. Ask every peer for its snapshot heights (a height counts once per peer, however
   often it is listed). Only a height H with `H + 1 >= trustHeight` is a candidate:
   header H+1 fixes the snapshot's app hash, and trust only moves forward to it.
   Choose the highest candidate offered by at least two peers, or the highest
   offered at all when none has two; verify header H+1 with the light client.
3. Fetch the manifest from the snapshot's peers in turn and verify it: the right
   format, every registered type exactly once in order, each type leaf folding to
   header H+1's app hash through its top-tree path, chunk counts matching the
   counters. A peer serving a manifest that fails these checks, or bytes that do not
   decode as a manifest at all, is charged 50 points and the next is asked.
4. Fetch chunks from up to four of those peers in parallel, verifying each as it
   arrives by its manifest hash, its range and its range proof against the type root,
   and keep it; when all are there, load them into a fresh database. A bad chunk charges its peer 50 points and excludes it as a
   source for the rest of the join; three requests that fail or time out exclude a peer too, without a charge. The chunk is refetched
   elsewhere.
5. Set counters (importing the objects has built their indices, the authenticated ones'
   trees included), compute `root(H)`, compare with the app hash, and check the index
   roots against the manifest.
6. Fetch the exact validator sets, priorities
   included, for H, H+1 and H+2 by height and check them against the headers' set
   hashes and against `prioritiesHash` (section 2.1): the sets of H+1 and H+2 come from
   one peer and must hash to header H+1's value, then the set of H with the set of H+1
   to header H's; a peer whose sets have the right set hashes and not the right
   priorities is charged 50 points and the next is asked (a set with another set hash is
   passed over without a charge). Then fetch block H with its commit from one of the peers; the body must match the
   header and the commit must verify against the set of H, or that peer is charged
   50 points and the next is asked. Every
   key in the three sets must be of the scheme the node's genesis names, else the
   join stops with `state sync: a validator key is not a <scheme> key; this is not
   the chain genesis describes`.
7. Fetch the headers below H as far back as evidence may reach: a block after H may
   carry evidence of a double sign at any height within the evidence age, and
   applying it takes the validator set and the time of that height, which every
   other node reads from its own blocks. The age is the operator's `maxEvidenceAgeMs`
   or the unbonding period held by the imported state; the walk ends at the first
   header whose time is before `time(H)` minus that age, which is not stored.
   Starting with header H's `lastBlockHash` at height H-1, every header must carry
   the expected height, the chain id and the expected hash, so each is bound to the
   one above it and no commit is needed. A new p2p pair serves them:
   `headersRequest(height, count)` (code 46) and `headersResponse(height, headers)`
   (code 47), the answer running downward from `height` with as many consecutive
   headers as the serving node holds, from its blocks or kept alone, at most 1000
   per response. The snapshot's peers are asked in turn; a batch stops at the first
   header off the chain, and a peer whose first header is off it is charged 50
   points. The validator set a header names is fetched by hash
   (`validatorSetRequest`) when the store lacks it. Records are written to the chain
   store as each batch arrives, and a record already on disk whose hash is the
   expected one is reused without a request, so an interrupted join resumes where it
   stopped. When no peer serves a needed batch the join fails with `state sync: no
   peer serves the headers below H that evidence may still name`.
8. Install, in one transaction across the application and chain stores: the imported
   state, the three sets by hash and by height, block H with its commit, the lowest
   height H, the lowest header height (the lower of an existing marker and the
   walk's) and the chain state at H (block hash and time from the header, the scheme
   from genesis). A crash
   leaves either a complete join or nothing, so a restart simply joins again. Then
   hand over to block sync from H+1.
9. With `backfill` (the default), keep fetching earlier blocks downward one at a
   time whenever block sync is idle, checking each against the hash chain and its
   commit against its validator set, storing them and their transaction index, until
   genesis or the edge of the block retention window, where pruning would undo it.
   A backfilled block replaces the header record of its height. History before H is
   not reconstructed.

Without the anchor the node replays from genesis; with one, no peer within the wait,
no snapshot offered, or none offered at or above the trust height less one (`state
sync: every snapshot offered is from before the trusted height; replaying from
genesis`, a warning) also falls back to genesis, while a snapshot that cannot be
completed (no valid manifest, every source failed, a chunk count mismatch, no block
H with a valid commit, no peer serving the headers below H) aborts startup; a
restart tries again.

### 4.3 Batched block sync

A window of 32 heights ahead of the applied height is kept requested, at most 8
heights per request, spread across up to 4 peers that report having them. A serving
node answers with at most 64 blocks and stops adding blocks past 16 MiB (the first
always goes). A response must hold at most the `count` blocks asked for, the block
at place i being of height `from + i` with a commit that names its hash; one that
does not is not used at all, costs its peer 50 points (`blocks response does not
match the request`) and has the peer's height forgotten. Responses land in a buffer
and are applied in order; heights that consensus decided meanwhile are discarded
from the buffer, and the whole buffer is dropped when no connected peer is ahead any
longer. A request that times out or returns a bad block is re-issued to another
peer; the first peer's height is forgotten, and a bad block costs it 50 points,
while a mere timeout does not. A sync that is stopped while a block is being
verified applies nothing after the verification returns. Clock drift is not checked
on synced blocks.

### 4.4 Evidence gossip

Evidence becomes an inventory item kind next to transactions: announce by key,
fetch, verify against the validator set at its height, add to the pool, pass on.
Before it is verified, fetched evidence is held to the age rule a block would hold
it to (`evidenceAgeOk`, at the next height and the last block's time): evidence that
is too old, names a height the node does not know, or lies beyond the height being
decided is dropped, neither pooled nor charged to the peer, which may be ahead of
this node or hold history this node has pruned. A block may carry at most 16 pieces
(`MAX_EVIDENCE_PER_BLOCK`); a proposer takes no more from its pool, and
`validateBlockStructure` refuses a block with more (`too much evidence`). The
pool lets go of evidence, pending or committed, and of its inventory entry once it is
older than the evidence age, on every node after every commit, and holds at most
1,000 pending pieces (`EvidencePool.MAX_PENDING`) and 32 MiB of them
(`MAX_PENDING_BYTES`), refusing more; it also refuses a piece that encodes to more
than this node as proposer would give one (`maxRecordBytes`, half the block size less the
builder's margin), so that nothing waits in the pool that the node could never propose. A
hash a peer announces is fetched at most once while a fetch for it is outstanding
(ten seconds, after which another peer that announces it may be asked, four at most,
or until the item arrives or every peer asked has said it lacks it), in
batches of 256. A fetch is remembered by kind and hash for one minute from the first
time it is sent, whatever is asked after; a node remembers 20,000 at most and 2,048
for one peer, and asks a peer at its limit nothing more until answers or expiry free
places. When the 20,000 are in use only the hash there is no place for is passed over,
not the rest of the announcement, and a peer that disconnects is taken out of every
fetch still outstanding, so what it announces after it reconnects is asked for again.
An `item` is processed only when its hash was fetched from the peer
that sends it, as that kind, within that minute; any other is dropped
unread and without a charge, so a peer cannot push transactions or evidence past the
announce-and-fetch round. A newly
connected peer receives every pending evidence key, in `inv` messages of 256, with
its catch-up proposals, proposal heads and votes.

The two halves of a proof of two proposals reach one node without the pool. A node
sends a proposal on whole only when it is valid and its round takes it; of any other
whose signature verified it sends the head (`proposalHead`, code 22: height, round,
proof-of-lock round, block hash and signature, 2,474 bytes under ML-DSA-44 and 118
under secp256k1) to every peer but the sender, if that is the first thing it holds
for the round, and it sends one on in the same way when a head is the first it hears
of a round. A head is verified only for a round of the current height within 1,000 of
the node's own or a round a kept height reached, and not when it says what is held
for the round or the round's proposer was already reported; one signed head is
verified once however many peers send it together, 64 are verified at a time and one
over that is dropped; a bad signature costs 20 points. A whole proposal that arrives
after its height, for a round the kept height holds nothing for, has its head recorded
and sent on in the same way. Heads go to the peers connected when they are first held,
and a peer that connects is handed those of the current height and of the 16 heights
kept after they are over (the newest first, 64 at most), so nodes that were apart
during a height compare what they held when they meet within those; later they do not. With what the node holds for the round it is the evidence, which then travels
as above.

### 4.5 Immediate block fetch

When a height has +2/3 precommits for a hash and no valid proposal for it, consensus
broadcasts a request for the block by height; a block whose hash matches
is validated and decided as if proposed. This replaces falling a height behind.

### 4.6 Peer scoring

Points per offence: bad signature on a vote, a proposal or a proposal head 20, proposal body not matching
its header 20, malformed message 20, malformed or invalid evidence 20, bad manifest,
chunk, commit or batch of headers during state sync 50, bad block during sync or
backfill 50, a block sync response that does not match its request 50, an
oversized or repetitive fetch 5, votes arriving faster than they may be verified with
no room left for them to wait 10 (at most once a second for a peer). A proposal for the next height is held until that
height starts only if it is fresh (no proof of lock), its round is no more than 1,000,
its block is of that height and its signature verifies with the key of the validator,
in the next height's set, that the block names as proposer; a bad signature costs the
sender its 20 points, and one there is no place for is dropped before its signature is
verified. There are 8 places, 2 for one validator and one for a validator and round,
counted by the proposal's signer and not by the peer that relays it: any peer may relay
a proposal a validator signed, and nothing takes a place without the signature of a
validator of the next height's set; four validators together can still fill
them, and a proposal not held is sent again while its round lasts. A vote for the height being decided or the next that is more than 1,000 rounds ahead of the
node's round is dropped before its signature is verified. A response to a request the node
awaits (blocks, headers, validator sets, snapshots, manifests, chunks) that matches no
outstanding request is ignored without charge. Nothing is taken unasked: one
`addrResponse` is taken for each `addrRequest` the node sent that peer and any other
is ignored, and an `item` that was not fetched from its sender is dropped (4.4),
both without a charge.
Points decay by one per minute. At 100 the peer is disconnected and its node id is
banned. If the node dialed it, the address as it was dialed (`Peer.dialedAddr`, the
record the peer database holds, whatever the name resolved to) is banned for an hour
that doubles with each ban of that address, the connect loop passes it over, and the
id is banned until the same time. An inbound peer's id is banned for an hour each
time; its advertised address is only a claim and is never banned on its account. A
peer's advertised address and the name it was dialed by are separate records in the
peer database, and when two nodes dial each other and the inbound connection is the
one that survives, the dialed address is dialed again, with backoff. A connection
the node refuses with a `reject` frame is closed 50 ms later, by a timer alone, so
the frame can leave first; a handshake that fails otherwise is closed at once. A
network that is stopped does not wait for those timers: it clears them and closes the
connections, ends the dials still connecting, and sends nothing on a connection that
opens after the stop. A handshake step given a connection that has already closed
fails at once (`closed during handshake`) and does not wait for the handshake
timeout.

### 4.7 Retention

`retain: { blocks?: number, versions?: number, snapshots?: number, memoryVersions?:
number }`, every field optional; `blocks` left out keeps every block. After each commit, blocks below
`lastHeight - blocks` are deleted with their results and transaction index entries,
never below the newest snapshot height and never inside the evidence window: a block
whose time is within the evidence age (the unbonding period) of the latest block
stays, since evidence is checked against the validator set and time of its height.
The headers a state-synced node keeps alone below its lowest block (section 4.2) are
pruned by the evidence window alone, whatever `blocks` says: after each commit,
records older than the evidence age of the latest block are deleted from the lowest
up and the marker moves, or is cleared when none remain; a backfilled block replaces
the record of its height. So a state-synced node checks evidence as far back as the
window reaches, as a node that replayed from genesis does.
Each pass, over blocks or over headers, is one store transaction, so what is deleted
goes with the marker that says so. The evidence age is read from the application
each time the executor asks, so a block that lengthens the unbonding period is pruned
behind with the new age; heights deleted under the shorter one are gone, and until a
full new window has passed a pruning node refuses evidence that names them.
A validator set stored by height is deleted with the block of its height (records
below the lowest block in a store pruned by an earlier build stay). A validator set
stored by hash is deleted after a pass once the heights removed carried its hash, no
header still held names it (as `validatorsHash` or `nextValidatorsHash`) and the
current state does not use it. Account history is not pruned.
`versions` is the provable window (default 100 heights, whose history is held in
memory and in the store); `memoryVersions` is how many of those heights are kept in
memory (all of them when left out), the store answering for the rest; `snapshots` the
heights kept (default 2, at least 1).
Suggested presets: validator `{ blocks: 10000, versions: 100, snapshots: 2 }`, query
node `{ versions: 10000, snapshots: 2 }`, archive: no `blocks` and as many
`versions` as memory allows.

## 5. Defaults

| parameter | default |
|---|---|
| protocol version | 1 |
| signature scheme | `ml-dsa-44` when genesis names none; `secp256k1` the other choice |
| rpc bind | 127.0.0.1, p2p port + 1 |
| rpc body limit | 1 MiB |
| rpc rate | 50/s per address, burst 100, costly calls 5 |
| event streams per address | 8 |
| broadcast commit timeout | 30 s, at most 120 s |
| accountHistory page | 20, at most 100 |
| accounts page | 50, at most 200 |
| event replay | the last 1000 blocks |
| scrypt | N 32768, r 8, p 1 |
| light client trusting period | 4 days |
| light client backward walk | at most 100 000 headers below the trusted one; 10 000 cached |
| keystore lock | retried every 20 ms for 5 s; a lock older than 30 s is stale |
| state sync peer wait | 30 s |
| snapshot interval | 1000 blocks |
| chunk size | 2000 instance slots |
| snapshots kept | 2, at least 1 |
| sync window | 32 heights, 8 per request, 4 peers; 64 blocks or 16 MiB per response |
| headers per response | 1000, downward from the height asked |
| ban threshold | 100 points, 1 hour, doubling per repeat for an address the node dialed |
| evidence per block | at most 16 pieces |
| next-height proposals held | 8, at most 2 signed by one validator |
| block size | `consensus.maxBlockBytes` in the genesis, 65,536 to 16,777,216 bytes; 4 MiB when absent (`init --max-block-bytes <n>` writes it). It bounds the encoded transactions and evidence; the header and the last commit are not counted. A proposer gives evidence at most half of it |
| validators in a set | at most 2,000, so that a block of the largest size with two commits fits the 32 MiB frame |
| transaction size (mempool) | 1 MiB, or four bytes under half the block size if that is less, so that an admitted transaction always fits the half of a block left to transactions |
| memory guard | sampled every second; `warn` at 70% of the heap limit, `pressure` at 85%, `critical` at 95%, each left 5 points below its threshold |
| scheduled major collection | once the heap has grown 256 MiB, or a tenth of the limit, since the last one |
| heap limit (`start`) | three quarters of physical memory, `--heap <MiB>` otherwise, at least 256; a 64 MiB semi-space. An old-space limit already set on Node's command line or in `NODE_OPTIONS` is kept in place of both |

## 6. Tests

Stage one: a transaction's inclusion proof verifies against the data hash and fails
when the transaction is tampered with; result proofs, failures included, verify
against the results hash; a block from another protocol version is rejected; on a
live four-validator network with a full node, a state proof from one node verifies
against the next header on every node, and a transaction query verifies through the
light client (`test/txproof.test.ts`, `test/engine.test.ts`, `test/chain.test.ts`).

Stage two (`test/rpc.test.ts`): against a running node, `status`, headers, commits,
validator sets, objects and keys with proofs that verify; broadcast in `sync` and
`commit` mode, `tx` with proofs, and the account history it leaves; event streams,
replay from `Last-Event-ID`, the stream limit (429), the body limit (413) and the
replay budget; a light client over the RPC provider; `parameters` and `proposals`;
the keystore round-trips and refuses a wrong passphrase. `test/review2.test.ts` adds
two keystore handles over one file keeping each other's keys and leaving no lock
behind, a lone notification answered with 204 and a mixed batch answered only for
the request with an id, and a light client walking back from its anchor, refusing a
height before genesis, one after the anchor and one beyond `maxBackwardSteps`, and
catching a header that is not the one the header above names. `test/review4.test.ts`
(thirteen cases) adds the state queries at a height with their proofs, a height not kept,
the peers' clock offsets and a batch paying for each of its calls; the transaction
index with one transaction in three blocks and an index of the old layout moved when
the store is opened; a snapshot
with a section missing, repeated or out of order; the evidence pool's pruning and
bound; the codec's `u53` and `i53`; `Keystore.remove`; a peer clock read from its
pong; and a node that makes and closes its own verifier pool. Two tests run the
CLI as a process: `start` against a directory that does not exist, for the heap limit
it keeps (`test/review3.test.ts`), and `keys add` and `keys remove`
(`test/review4.test.ts`). `test/review5-rpc.test.ts` (twelve cases) stops a server and
finds its listener gone from the executor and a commit wait answered; stops one with a
method still running and finds the method, which ends within the stop's one-second wait, ended when the stop returns; replays a block
event with the fields of the pushed one, and with `failed: null` when the results
are not held; opens an account stream only for an account there is, by name or by
id; answers `-32601` for `toString` and a malformed request under the id it carries;
finds a validator by its operator's account id; keeps keystore keys named
`constructor`, `toString` and `__proto__`; checks the light client's trusting period
at verification time on an injected clock; runs `init` with a `--max-block-bytes` it
refuses, which writes nothing, and with one it takes, which is then in the genesis, and
`start` on a node of that testnet as a process, which runs past its first status line,
holds its directory against a second `start`, and on `SIGINT` exits 0 with the `LOCK`
file gone; and runs the CLI as a process against a
node for an unknown command, `show` on an asset of precision 0, `verify-tx` with
and without the block's results, and `light verify` with an anchor of another chain
and one without a chain id. The other client commands (`transfer`, `account`,
`propose` and the rest) are not driven against a node by any test, and no test
compares the index or history with a replayed node's.

Stage three (`test/sync.test.ts`): a node joins a running testnet from a snapshot,
serves queries at once, rejects a corrupted chunk (its source is charged 50 points
and asked for nothing more; a ban takes 100) and completes from another peer, holds
the headers below the snapshot, then backfills to genesis and the headers are gone;
a node that joined without backfill applies a block carrying evidence for a height
before its join from the headers it fetched, and a light client anchored after the
join verifies a state proof at that height by walking back through its header
records; a joiner with a short evidence age fetches only the headers inside the
window and lets them go once the chain's time has moved on; batched sync across
peers catches up a node started some 45 blocks late, and a node retaining ten
blocks prunes behind that window (with the evidence window switched off, since it
would otherwise keep every block); evidence created on one node reaches a proposer
that never saw the votes; a node with +2/3 precommits and no proposal decides the
height from a fetched block. `test/review5-net.test.ts` (20 cases) covers the peer
layer (one success per outbound dial, a refused connection left open for the
rejection to leave, nothing sent on a connection that opened after a stop and no
refused connection or timer left behind, no wait on a connection that closed
between two steps of its handshake and no timer of the in-memory hub left behind
by a stop, a dial still connecting ended when the
transport is closed, a ban and an exclusion by the address dialed, an address list
taken only in answer to a request, a peer file cut short), block sync (nothing
applied after a stop, no timer set by a stop that came while a block was being
applied, the buffer dropped once no peer is ahead, a response with more
blocks than asked for, a block of another height and a commit naming another block),
state sync (a snapshot from before the trusted height passed over, a manifest that
does not decode charged), consensus intake (the failure of a proposal nobody waits for caught, a vote far ahead dropped unverified, a
vote for the next height held once however often it is sent, a proposal for the next height held only when a validator signed it and two to a
validator, block requests forgotten with the height), an empty
validator set decoded only with proposer index -1, and the mempool (one of two
concurrent checks admitted to the last place, a place given back, a pooled
transaction never forgotten). `test/review5-node.test.ts` (26 cases) covers the data
directory's claim and the takeover of a stale one, a store handed in closed before the claim is given up, a store closed only once whoever still reads it is done, a start that goes no further once a stop has begun and a closed store that answers with `StoreClosedError`, nothing left queued behind a stop made from a commit and no file left open behind a genesis that does not parse, every step of an iteration and every use of a kept writer refused once the disk environment is closed, the evidence age read when asked, a block of which nothing is
stored when the application's commit throws, pruning in one transaction with the
set by height, a past height answered with the set as it had it, proposer included, a set by hash removed once no header held names it, a repeated transaction indexed where it succeeded, the memory store's
write order, a memory environment's transaction undone in every store when it throws, a heap flag of zero, gossiped evidence too old to pool, an item taken
only from the peer asked, the fetches remembered for a peer that never answers bounded,
the block size taken from the genesis by every node alike, evidence given half a block at
most so that the largest transaction admitted still fits, a block bounded by its
transactions and evidence and a validator set by what a frame holds,
and a block with more than 16 pieces of evidence refused.

Schemes (`test/schemes.test.ts`, five cases): signing, verifying, tagging and codec
round trips under each scheme, cross-scheme refusal and unknown tags; the high-S twin
of a secp256k1 signature refused; the keystore keeping each key's scheme, reading
a version 1 file as ML-DSA-44 and writing it as version 2; genesis refusing validator keys of the wrong scheme under
each default; and a four-validator chain on secp256k1 end to end: 65-byte commit
signatures, `status.signatureScheme`, an account created with a secp256k1 key, and
refusals of an ML-DSA authority key, an ML-DSA consensus key and an ML-DSA signature
under a secp256k1 address. The whole suite runs under either scheme with
`CHAIN_SCHEME`.

Account history (`test/history.test.ts`, four cases): blocks of entries over several
accounts appended to the log and every account paged out of it, oldest first and
newest first, from a range of starting points and limits, against a model, also by a
log opened on the store later; a history of 5,000 entries whose old end is reached in
fewer than a hundred reads, written with fewer than three reads an entry, its keys
consecutive in the store; blocks of 300 entries over 6,400 accounts, each block writing
the heads of one stretch of the account numbers and fewer than it changed, a log opened
on the store at any block knowing every account's count, and the stored heads never
more than 64 blocks of entries behind the log; and a store written with the earlier layout moved into the
log when it is opened, with the same sequences, the old keys gone, and new entries
following the moved ones.

Memory (`test/memory.test.ts`, six cases): the guard moving through its levels with
hysteresis on injected samples, several levels in one sample, the reported sequence and
the threshold check; its levels taken from the old generation's use when a sample
carries it; the scheduler's decisions with an injected collector (a minor
collection per commit, a major one on growth measured from the last, the fraction cap,
nothing without a collector); the observer counting real collections after garbage is
allocated; a full node in a two-validator testnet, made with `indexTrees: 'memory'` as
the test helper makes them, whose guard is fed invented
samples: at 75% of the limit (`warn`) it sheds nothing, drops its index trees and trims
its history window to two versions, the Merkle trees staying resident; at 90%
(`pressure`) it sheds (the mempool's limit lowered to a tenth, `submitTx` `full` and
`broadcastTx` `-32004` at that limit, `block` `-32004`, `/events` 503, `/health` and
`status` reporting `pressure`) and drops the Merkle trees while still following the
chain, at 40% it resumes, waits before it considers a rebuild and then says once that
it stays paged, and at 99% it reports `critical`; and a node with
`retain.memoryVersions` 3 and `indexTrees: 'store'` keeping three past versions in memory,
proving a height six back from the store and finding an account by name with its index
trees left in the store.
