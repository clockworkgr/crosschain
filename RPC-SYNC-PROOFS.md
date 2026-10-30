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
| transaction index | by hash in the chain store; per-account operation history in the app store, one entry per operation, including virtual operations |
| wire protocol | JSON-RPC 2.0 over HTTP, decoded objects as JSON, proofs and raw transactions as hex of the binary encoding |
| broadcast | `sync` (after checkTx) and `commit` (after inclusion, with the result) |
| push | Server-Sent Events: blocks, transaction results, account history, validator set changes |
| exposure | loopback by default, configurable bind, CORS open, body and per-address rate limits; costly calls and new streams refused while the node sheds load under memory pressure |
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

### 2.2 Proofs

- `TxProof { height, index, tx, siblings }` verifies against `header(height).dataHash`.
- `ResultProof { height, index, ok, error, siblings }` verifies against
  `header(height + 1).lastResultsHash`.

Both are ordinary dense-tree path proofs; `src/types/txproof.ts` holds the two verifiers,
and `src/light/client.ts` gains `verifyTx`, which verifies headers `height` and
`height + 1` and checks both legs. The transaction hash is `sha256` of the raw bytes,
which the mempool already uses.

### 2.3 Transaction index

The chain store gains `'t' || txHash -> (height u64, index u32, ok u8, error string)`,
written by the executor in the same transaction as the block. It is derived data,
outside the state root, and is rebuilt by replay or by backfill (section 4.2).

### 2.4 Account history

The application keeps, outside the state root, one history entry per operation per
account the operation names, plus virtual entries for what the chain does on its
own. Only the operations of transactions that succeeded are recorded; a failed
transaction has no effect and is found through the transaction index. Stored in the
application's own store, next to the objects:

- `'a' || accountId || sequence u64 -> entry`, with `sequence` counting up per
  account from 0, and `'q' || accountId -> next sequence`.
- `entry = { height, position (u32, 0xffffffff for a virtual entry), opIndex (u32),
  kind (u8), txHash (option), data (bytes) }` where `data` is the encoded operation,
  or the encoded virtual operation. There is no result in the entry: every recorded
  operation succeeded.
- Accounts named by an operation: transfer from and to; accountCreate registrar and
  the new account; accountUpdate account; assetCreate and assetIssue issuer, and the
  recipient of an issue; validatorCreate and validatorUpdate operator;
  delegate, undelegate and redelegate delegator and the validators' operators;
  unjail, proposalCreate and proposalSignal operator.
- Virtual operations: `reward { validator, amount, commission }` to the operator,
  `slash { validator, amount, doubleSign }` to the operator, `jail`, `unjail`,
  `tombstone` to the operator, `unbondingMatured { validator, tokens }` and
  `redelegationMatured` to the delegator, `forcedUnbond { validator, tokens }` to
  each delegator of a tombstoned validator. Rewards are recorded per validator per
  block, not per delegator: a delegator's share is implicit in the exchange rate.

Entries are collected during `finalizeBlock` and written by `commit`, so a crash
between the two is repaired by the existing replay. A node that state-synced has
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
string `method`, an id of another type) is answered `-32600` with `id: null`.
`GET /events` is the Server-Sent Events stream. `GET /health` returns height, peer count and
the memory guard's level (`memory`). Default bind `127.0.0.1`
on the p2p port plus one; config `rpcListen` sets host and port. Responses carry
`Access-Control-Allow-Origin: *`. Bodies over 1 MB are rejected with HTTP 413. Each
remote address has a token bucket of 50 tokens per second with a burst of 100: every
HTTP request costs one token, and a costly method (`block`, `object`, `key`,
`account`, `delegation`, `accountHistory`, `tx`, `broadcastTx`, `accounts`,
`proposals`, whether or not a proof is requested) costs four more when it is
dispatched, so a batch of cheap methods costs one token in all. An empty bucket at
the request stage returns HTTP 429 with a `-32004` error body; at the dispatch stage
it returns the `-32004` error for that method inside an HTTP 200 response. At most 8
event streams per address, and a reconnect that asks for replay pays the costly
price; over either limit the stream request gets HTTP 429. While the node sheds load
under memory pressure (DESIGN.md section 4), a costly method is answered `-32004` with
`node under memory pressure` before its bucket is consulted, so the refusal costs the
caller nothing, and a `GET /events` request gets HTTP 503; cheap methods, `/health` and
the streams already open are unaffected.

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
  is answered in its place), `-32601` unknown method, `-32602` for bad parameters,
  including a proof requested for a height outside the provable window, `-32001`
  not found, `-32002` check failed (with the application's message), `-32003`
  timeout, `-32004` rate limited.

### 3.3 Methods

| method | parameters | returns |
|---|---|---|
| status | | chain id, protocol version, `signatureScheme` (`ml-dsa-44` or `secp256k1`), latest height, hash and time, app hash, catching-up flag, lowest retained height, the height joined at by state sync (or null), peer count, validator address if any, `memory` (the guard's `level`, whether the node is `shedding`, and in bytes `heapUsed`, `heapLimit`, `heapTotal`, `arrayBuffers`, `external`, `rss`), `gc` (`available`, that is whether collections can be scheduled; the collections V8 ran since start as `collections`, `minor`, `major`, `incremental` with their pauses `totalMs`, `maxMs`, `lastMs`; and the `scheduledMinor` and `scheduledMajor` ones the node asked for), `rpcVersion` 1 |
| genesis | | the genesis document, `signatureScheme` included when the file names one (absent means `ml-dsa-44`), without `appStateFile`: an application genesis kept in a file is not served |
| header | height? | header; below the lowest retained block, a header the node keeps alone (section 4.2), where `block` and `commit` answer `-32001` |
| block | height? | header, transactions (hex), lastCommit, evidence, and the block's own commit |
| commit | height? | the commit for that height |
| validators | height? | the set that signs that height: hash, total power, proposer address, members with address, public key and power (no priorities) |
| validatorSet | hash | a set by hash, same shape |
| object | id, height?, prove? | type, height, the object as of that height or null, with `proof` hex when asked |
| key | type, index, key (hex), height?, prove? | `{ height, id, proof? }`: the object id the key maps to now (`"type.n"`) or null, with the key proof at `height` when asked |
| account | name, height?, prove? | account object or null; with it the balances (asset symbol, id, precision, amount), the operated validator's id or null, and the history count, all current; the name proof at `height` when asked |
| validator | operator (name) or id (validator id) | validator object with status, active flag, power, self-bond, delegator count, operator name; current state only |
| delegation | delegator, validator, height?, prove? | the delegation with its tokens' worth or null, and the pending unbonding entries, current; the key proof at `height` when asked |
| balance | account, asset? | account id, asset id, amount; current state only |
| accountHistory | account, from?, limit?, reverse? | entries with sequence numbers, and the total; pagination below |
| tx | hash, prove? | `{ hash, height, index, ok, error, tx, decoded, proof? }`; `proof` holds `txProof`, the signed header, and `resultProof` with the next signed header, or nulls for those while the next block does not exist |
| broadcastTx | tx hex, mode? (`sync` default, or `commit`), timeoutMs? (default 30 000, at most 120 000) | `sync`: `{ hash, status }`; `commit`: `{ hash, height, index, ok, error }` once included; `-32004` while the mempool is paused under memory pressure |
| accounts | after? (name cursor, exclusive), limit? | accounts by name with id and core balance |
| parameters | | height, core asset (id, symbol, precision), maximum transaction expiration, the fee schedule and the staking parameters in force |
| proposals | | open proposals, soonest to expire first, each with the full parameters it would adopt |
| mempool | | count, bytes, the first 100 hashes |
| peers | | connected peers: id, address, direction, height, latency |
| snapshots | | reserved: an empty list (snapshot heights are exchanged over p2p, not the RPC) |

Omitted heights default to the latest. An `account` or `delegator` parameter takes
an account name or id; a `validator` parameter takes the operator's name or the
validator's id; the `account` method itself takes a name. `object` reads the object as of the requested height;
`key`, `account` and `delegation` look the key up in the live index and return
current objects, and only their proof is about the requested height, so an answer
about a past height is read from the proof, not from the object fields.

Pagination: `accountHistory` returns 20 entries by default and at most 100, oldest
first from sequence `from` (default 0); with `reverse`, entries come newest first and
`from` is an offset from the newest entry, not a sequence number. `accounts` starts
after the name in `after` and returns at most `limit` (default 50, at most 200),
`limit: 0` being honoured.

Broadcast: `sync` answers after checkTx with status `added` or `seen`. `seen` means
the hash is in the mempool's recently-seen cache, which includes transactions it
rejected earlier and ones already committed; it is not inclusion. Admission failures
(`invalid`, `too-large`, `full`) are `-32002`; a mempool paused under memory pressure
answers `paused` inside the node and `-32004` with the reason, `node under memory
pressure`, over the RPC. `commit` waits for inclusion: a
transaction seen before that is neither pending nor committed is refused at once
(`-32002`) rather than waited for; a timeout answers `-32003` and leaves the
transaction in the mempool, where a later `tx` call can still find it once included;
once 1 000 commit waits are outstanding a further one answers `-32004`, and the
client should broadcast in `sync` mode and poll `tx`.

### 3.4 Events

`GET /events?types=block,tx,account,validatorSet&tx=<hash>&account=<name>`.

- `block`: height, hash, time, transaction count, app hash, results summary.
- `tx`: hash, height, index, ok, error; filtered to one hash when asked.
- `account`: an account's new history entries; filtered by account.
- `validatorSet`: height and the updates the application emitted.

Event ids are heights; a reconnect with `Last-Event-ID` replays `block` events from
the store, at most the last 1000 blocks, and stops at a missing block. A stream whose
client has more than 1 MiB queued unread is ended; it resumes with `Last-Event-ID`.
No stream is opened while the node sheds load: the request is answered HTTP 503, and the
client retries once `/health` reports `ok` or `warn`.
`broadcastTx` in `commit` mode is implemented on the same internal listener, with at
most 1000 waiters at once.

### 3.5 Light client over RPC

`src/light/rpc-provider.ts` implements `LightProvider` with `fetch` against the
methods above, `header` serving the headers alone that backward verification walks.
The CLI keeps its trusted state in `light.json` next to the keystore (height and
hash) and updates it as it verifies forward.

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

`keystore.json`: `{ version: 1, kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt },
keys: { [name]: { address, publicKey, scheme, iv, ciphertext, tag } } }`. One key is
derived from the passphrase and the salt; every seed is sealed with AES-256-GCM under
it with its own IV. `scheme` is `ml-dsa-44` or `secp256k1`, the scheme the seed's key
pair is derived under; a key sealed before the field existed has none and is read as
ML-DSA-44. The passphrase comes from `--passphrase-file`, the `CHAIN_PASSPHRASE`
variable, or a hidden prompt. Commands: `keys add <name> [--scheme <name>]`, `keys
list` (name, scheme, address), `keys import <name> <seed hex> [--scheme <name>]`,
`keys export <name>`; `--scheme` is ML-DSA-44 when absent, and a chain refuses a key
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
New: `history <account>`, `tx <hash>`, `verify-tx <hash>` (light-client verified),
`light trust <height> <hash>`, `light verify [height]`.

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
   often it is listed); choose the highest height offered by at least two peers, or
   the highest offered at all when no height has two; verify header H+1 with the
   light client, which means H+1 may not precede the anchor.
3. Fetch the manifest from the snapshot's peers in turn and verify it: the right
   format, every registered type exactly once in order, each type leaf folding to
   header H+1's app hash through its top-tree path, chunk counts matching the
   counters. A peer serving a bad manifest is charged 50 points and the next is
   asked.
4. Fetch chunks from up to four of those peers in parallel, verifying each by its
   manifest hash, its range and its range proof against the type root, and load it
   into a fresh database. A bad chunk charges its peer 50 points and excludes it as a
   source for the rest of the join, as do three timeouts; the chunk is refetched
   elsewhere.
5. Set counters, compute `root(H)`, compare with the app hash; rebuild the
   authenticated indices and check their roots against the manifest.
6. Fetch block H with its commit from one of the peers; the body must match the
   header and the commit must verify against the set of H, or that peer is charged
   50 points and the next is asked. Fetch the exact validator sets, priorities
   included, for H, H+1 and H+2 by height and check them against the headers' set
   hashes and against the proposers the chain used at H and H+1 (any round up to the
   commit's round, since a re-proposed block keeps its first proposer's name). Every
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

Without the anchor the node replays from genesis; with one, no peer within the wait
or no snapshot offered also falls back to genesis, while a snapshot that cannot be
completed (no valid manifest, every source failed, a chunk count mismatch, no block
H with a valid commit, no peer serving the headers below H) aborts startup; a
restart tries again.

### 4.3 Batched block sync

A window of 32 heights ahead of the applied height is kept requested, at most 8
heights per request, spread across up to 4 peers that report having them. A serving
node answers with at most 64 blocks and stops adding blocks past 16 MiB (the first
always goes). Responses land in a buffer and are applied in order; heights that
consensus decided meanwhile are discarded from the buffer. A request that times out
or returns a bad block is re-issued to another peer; the first peer's height is
forgotten, and a bad block costs it 50 points, while a mere timeout does not. Clock
drift is not checked on synced blocks.

### 4.4 Evidence gossip

Evidence becomes an inventory item kind next to transactions: announce by key,
fetch, verify against the validator set at its height, add to the pool, pass on. A
hash a peer announces is fetched at most once while a fetch for it is outstanding
(ten seconds, or until the item or a not-found arrives), in batches of 256. A newly
connected peer receives every pending evidence key, in `inv` messages of 256, with
its catch-up proposals and votes.

### 4.5 Immediate block fetch

When a height has +2/3 precommits for a hash and no valid proposal for it, consensus
broadcasts a request for the block by height; a block whose hash matches
is validated and decided as if proposed. This replaces falling a height behind.

### 4.6 Peer scoring

Points per offence: bad vote or proposal signature 20, proposal body not matching
its header 20, malformed message 20, malformed or invalid evidence 20, bad manifest,
chunk, commit or batch of headers during state sync 50, bad block during sync or
backfill 50, an
oversized or repetitive fetch 5. Unsolicited responses are ignored without charge.
Points decay by one per minute. At 100 the peer is disconnected and its node id is
banned for an hour; if the node dialed it, the dialed address backs off in the peer
database for the same time, doubling on each repeat. An inbound peer's advertised
address is only a claim and is never banned on its account.

### 4.7 Retention

`retain: { blocks?: number, versions?: number, snapshots?: number }`, every field
optional; `blocks` left out keeps every block. After each commit, blocks below
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
Validator sets, by hash and by height, and account history are not pruned.
`versions` is the provable window (default 100 heights, whose history is held in
memory and in the store); `snapshots` the heights kept (default 2, at least 1).
Suggested presets: validator `{ blocks: 10000, versions: 100, snapshots: 2 }`, query
node `{ versions: 10000, snapshots: 2 }`, archive: no `blocks` and as many
`versions` as memory allows.

## 5. Defaults

| parameter | default |
|---|---|
| protocol version | 1 |
| signature scheme | `ml-dsa-44` when genesis names none; `secp256k1` the other choice |
| rpc bind | 127.0.0.1, p2p port + 1 |
| rpc body limit | 1 MB |
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
| ban threshold | 100 points, 1 hour, doubling per repeat |
| memory guard | sampled every second; `warn` at 70% of the heap limit, `pressure` at 85%, `critical` at 95%, each left 5 points below its threshold |
| scheduled major collection | once the heap has grown 256 MiB, or a tenth of the limit, since the last one |
| heap limit (`start`) | three quarters of physical memory, `--heap <MiB>` otherwise, at least 256; a 64 MiB semi-space |

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
catching a header that is not the one the header above names. The CLI is not driven
by a test, and no test compares the index or history with a replayed node's.

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
height from a fetched block.

Schemes (`test/schemes.test.ts`, five cases): signing, verifying, tagging and codec
round trips under each scheme, cross-scheme refusal and unknown tags; the high-S twin
of a secp256k1 signature refused; the keystore keeping each key's scheme and reading
an old file as ML-DSA-44; genesis refusing validator keys of the wrong scheme under
each default; and a four-validator chain on secp256k1 end to end: 65-byte commit
signatures, `status.signatureScheme`, an account created with a secp256k1 key, and
refusals of an ML-DSA authority key, an ML-DSA consensus key and an ML-DSA signature
under a secp256k1 address. The whole suite runs under either scheme with
`CHAIN_SCHEME`.

Memory (`test/memory.test.ts`, four cases): the guard moving through its levels with
hysteresis on injected samples, several levels in one sample, the reported sequence and
the threshold check; the scheduler's decisions with an injected collector (a minor
collection per commit, a major one on growth measured from the last, the fraction cap,
nothing without a collector); the observer counting real collections after garbage is
allocated; and a full node in a two-validator testnet whose guard is fed invented
samples: at 90% of the limit it sheds (the mempool paused, `submitTx` `paused`,
`broadcastTx` and `block` `-32004`, `/events` 503, `/health` and `status` reporting
`pressure`) while still following the chain, at 50% it resumes, and at 99% it reports
`critical`.
