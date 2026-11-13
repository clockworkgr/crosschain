# Running and using the chain

This guide is for operators and users: how to install, start nodes, keep them running, and
talk to them with the command line, the JSON-RPC, and the light client. How the code works is
the subject of the [tutorial](tutorial/00-overview.md); design decisions are in
[DESIGN.md](../DESIGN.md).

## 1. Requirements and installation

- Node 24 or later. The code is TypeScript run directly by Node; there is no build step.
- `npm install` fetches four runtime dependencies, `@noble/post-quantum` (ML-DSA-44
  signatures), `@noble/curves` (secp256k1 signatures), `lmdb` (the on-disk store, the one
  direct dependency that needs native code) and `stream-json` (streaming parser for large
  genesis files), and three development tools (TypeScript for `npm run typecheck`, Vitest for
  `npm test`, and Node's type definitions).

```sh
git clone <this repository> crosschain && cd crosschain
npm install
npm test                 # 203 tests, about a minute
CHAIN_SCHEME=secp256k1 npm test   # the same suite on secp256k1 keys (one ML-DSA-only case is skipped)
INDEX_TREES=0 npm test   # the same suite with every index B+ tree dropped from the start: lookups and scans through the store
TREES=0 npm test         # and with every Merkle tree dropped: roots and proofs from the stored chunks and nodes; the two combine
npm run typecheck
```

Everything below runs from the repository root. `node src/cli.ts` is the command line; `npm run cli --`
is an alias for it.

## 2. The quickest look: a local network in one process

```sh
node scripts/localnet.ts 4 30      # 4 validators, 30 seconds, RPC on http://127.0.0.1:26657
```

The script starts the given number of validators inside one process on an in-memory transport,
opens a JSON-RPC server on node 0 (`RPC_PORT` changes the port), and drives the application from
a faucet account: every second it registers an account, pays one, or delegates to a validator.
It prints heights, voting powers, mempool size, account count and balances once a second, and
at the end verifies an object proof against the app hash. `CHAIN_SCHEME=secp256k1` in the
environment runs it on secp256k1 keys instead of ML-DSA-44; the same variable switches the
tests and the benchmarks, while a node started from a directory ignores it and follows its
genesis (section 6). While it runs, any CLI command works against it:

```sh
node src/cli.ts show http://127.0.0.1:26657
```

## 3. A real network over TCP

### 3.1 Initialise

```sh
export CHAIN_PASSPHRASE=testnet
node src/cli.ts init ./testnet 4 26656                      # ML-DSA-44 signatures
node src/cli.ts init ./testnet 4 26656 --scheme secp256k1   # or secp256k1; one scheme per chain
```

`init <dir> <validators> [basePort] [--scheme ml-dsa-44|secp256k1]` writes:

| path | content |
|---|---|
| `testnet/genesis.json` | the chain: id, signature scheme, genesis time, consensus settings, and the application genesis inline (a faucet with 10,000,000 tokens, one operator account per validator with 50,000, and the validators with a self-bond of 20,000 each) |
| `testnet/keystore.json` | an encrypted keystore holding the faucet key and the operator keys `op0`..`opN`, all of the chain's scheme, under the passphrase from `CHAIN_PASSPHRASE` (default `testnet`) |
| `testnet/nodeN/config.json` | one per node: name, p2p listen address, RPC address, seeds, the node key seed, and the validator (consensus) key seed |

Ports go up in steps of two from `basePort`: node 0 listens for peers on 26656 and serves RPC on
26657, node 1 on 26658 and 26659, and so on. `--scheme` fixes the signature scheme of every key
and signature on the chain, ML-DSA-44 when absent (section 6); every key `init` makes, in the
keystore and in the node directories, is of it.

### 3.2 Start

One terminal per node:

```sh
node src/cli.ts start ./testnet/node0
node src/cli.ts start ./testnet/node1
node src/cli.ts start ./testnet/node2
node src/cli.ts start ./testnet/node3 --heap 2048   # a heap limit of your own, in MiB
node src/cli.ts start ./testnet/node3 --heap 2048 --arena 512   # and at most 512 MiB of encoded objects in memory
```

`start <nodeDir> [--heap <MiB>] [--arena <MiB>]` first runs itself again as a child process under a heap limit,
because V8's own default is a few gigabytes whatever the machine has, and a state that outgrows
it aborts the process with no chance to stop cleanly: `--max-old-space-size` of three quarters
of physical memory, or the `--heap` figure in MiB (a whole number, at least 256), together with
`--max-semi-space-size=64` (a larger young generation, so fewer minor collections) and
`--expose-gc` (so the node can schedule collections after commits). It prints `start: running
the node under a N MiB heap limit (--heap <MiB> changes it), collections scheduled after
commits`, passes `SIGINT` and `SIGTERM` on to the child, whose shutdown runs once however many
it gets, and exits with the child's code. When `--max-old-space-size` is already in effect (in
`node`'s own arguments or in `NODE_OPTIONS`, quoted or not, with dashes or V8's underscores),
or `CROSSCHAIN_CHILD` is set, it runs in place instead. `--arena <MiB>` (a whole number, at
least 16) bounds the encoded objects the database keeps in memory outside the heap; without it
all of them are kept, and with it the rest are read from the store (section 12). The node then reads `config.json` and the `genesis.json` in the parent directory, opens
LMDB under `nodeN/data/lmdb` (the application state comes back from the store with its indices
and trees, every tree node, leaf and index entry checked against the objects, and with the
window of past heights from the history records, the line `loaded application state` saying
with `indexVersions=records` that the name trees' past versions were taken from them and
with `indexVersions=replay` that they were rebuilt from the accounts instead; section 12), connects to the seeds, and serves
RPC on the configured address. A stored state whose trees are estimated not to fit the heap is
opened paged, with those trees left in the store, and the line `loaded application state` then
ends with `paged=` and what was left out (section 12). Past heights stay provable either way.
Every five seconds it logs a status line: height, peers, mempool size, consensus round, active
validator count, the community pool, `heap=<used>/<limit> MiB` (the old generation's use
against its limit, the `--max-old-space-size` figure, which is what the guard's levels are
taken from; section 12), `memory=<level>` (the memory
guard's level, section 12) and `gc=<n> pauses, <total> ms, longest <max> ms` (every garbage
collection V8 ran since start). `SIGINT` or `SIGTERM` shuts down cleanly; so does the guard's
`critical` level, with exit code 3, so a supervisor can restart the node with a larger `--heap`,
including when the heap is already that full at the guard's first sample. Shutting down stops
consensus and block sync at once and lets the block being applied finish its writes; RPC
requests still open get a second (none at `critical`) before their connections are closed.
Logs go to stderr; `LOG=debug` shows every proposal, vote and timeout, `LOG=warn` only problems.

Blocks are produced as soon as more than two thirds of the voting power is connected: with four
equal validators, three of them. The default timeouts give roughly one block a second on a
local network.

### 3.3 Use it

```sh
node src/cli.ts show ./testnet/node1                        # status, validators, the first 50 accounts by name
node src/cli.ts create ./testnet/node0 alice                # the faucet registers alice; her key goes into the keystore
node src/cli.ts transfer ./testnet/node2 faucet alice 12.5  # whole tokens; waits for inclusion
node src/cli.ts account ./testnet/node3 alice               # balances; the light client verifies the proof that the name maps to this account
node src/cli.ts history ./testnet/node0 faucet              # the newest 50 entries of an account's history
```

A node directory as the target tells the CLI where the RPC is and which keystore to use. A URL
works too, with `--keystore <path>` for signing commands, except for `create-validator`, which
needs the directory's consensus key.

## 4. Command reference

General form: `node src/cli.ts <command> <target> [arguments] [flags]`.

Targets and flags:

| | |
|---|---|
| `<nodeDir>` | a directory written by `init` or `join`: RPC address from its `config.json`, keystore at `../keystore.json` |
| `http://host:port` | an RPC URL; needs `--keystore <path>` for anything that signs; not accepted by `create-validator` |
| `--rpc <url>` | send the calls to this URL instead of the one in a node directory's `config.json`; the keystore and, for `create-validator`, the consensus key still come from the directory |
| `--keystore <path>` | the keystore file to sign with |
| `--passphrase-file <path>` | read the keystore passphrase from a file |
| `CHAIN_PASSPHRASE` | environment variable with the passphrase; without either, the CLI prompts |

Amounts are whole tokens (`12.5`), converted with the core asset's precision (5 decimals by
default); an amount with more decimals than the precision is refused. Validators are named by
their operator account.

| command | what it does |
|---|---|
| `init [dir=./testnet] [validators=4] [basePort=26656] [--scheme ml-dsa-44\|secp256k1]` | writes a genesis, a keystore and one directory per validator, every key of the named scheme, ML-DSA-44 when absent (section 3.1) |
| `start <nodeDir> [--heap <MiB>] [--arena <MiB>]` | runs a node with its RPC under a heap limit of three quarters of memory, or the given size in MiB (section 3.2); stops cleanly with exit code 3 when the heap nears the limit. `--arena` bounds the encoded objects kept in memory outside the heap (at least 16 MiB; all of them by default), the rest being read from the store (section 12) |
| `join <dir> <nodeN> <seedAddr> <trustHeight> <trustHash> [basePort=26700]` | writes a directory for a node that joins by state sync from a header the operator trusts (section 9); refuses to touch a directory that already has a `config.json` |
| `keys list` | names, schemes and addresses in the keystore (`--keystore <path>`, default `./keystore.json`, for every `keys` command) |
| `keys add <name> [--scheme ml-dsa-44\|secp256k1]` | generates a key under that name, of the given scheme (ML-DSA-44 when absent); it must be the chain's, which `status` reports |
| `keys import <name> <seedHex> [--scheme ml-dsa-44\|secp256k1]` | adds a key from a 32-byte seed, derived under the given scheme (ML-DSA-44 when absent) |
| `keys export <name>` | prints a key's seed |
| `show <target>` | chain status, the active validators, and the first 50 accounts by name with their balances |
| `account <target> <name>` | the account, its balances and its validator, with the proof that the name maps to this account (or to none) verified by the light client; the balances themselves are the node's answer, not proven |
| `history <target> <account>` | the newest 50 entries of the account's history: operations it took part in and virtual events (rewards, slashes, matured unbondings); the `accountHistory` RPC method pages further back |
| `tx <target> <hash>` | where a transaction landed: height, position, result, decoded operations |
| `verify-tx <target> <hash>` | the inclusion and result proofs checked by the light client, at any height before or after its anchor (section 11); prints the proven height and result (for the position and the operations, use `tx`) |
| `create <target> <name>` | the faucet registers a new account; its key is created in the keystore, of the chain's scheme |
| `transfer <target> <from> <to> <amount>` | pays `to` from `from` in the core asset |
| `create-validator <nodeDir> <operator> <selfBond>` | registers the node's consensus key, derived under the chain's scheme, as a validator operated by `operator`, bonding `selfBond` |
| `delegate <target> <from> <operator> <amount>` | delegates tokens to the validator run by `operator` |
| `undelegate <target> <from> <operator> <amount>` | starts unbonding that many tokens' worth of shares (all of them when the amount is at or above the delegation's value); they return after the unbonding period |
| `unjail <target> <operator>` | returns a jailed validator to the candidate set after its jail time |
| `parameters <target>` | the fee schedule and staking parameters in force |
| `proposals <target>` | open parameter proposals, each with what it would change |
| `propose <target> <operator> <path=value>...` | a validator proposes the live parameters with changes, e.g. `fees.transfer.fee=250 staking.maxValidators=9` |
| `signal <target> <operator> <proposalId>` | a validator signals support; more than two thirds of active stake adopts |
| `light <target> trust <height> <hash>` | anchors the light client at a header the operator trusts |
| `light <target> verify [height]` | verifies forward from the anchor to the latest (or given) height and saves the new anchor |

Every signing command prices its operations from the chain's fee schedule (`parameters`), signs
with the named account's key, submits in commit mode, and prints `included at height H` or the
failure reason; a transaction that was included but failed, and a proof that does not verify,
exit with status 1. Transactions expire 60 seconds after they are built, or half the chain's
`maxTxExpirationMs` when that is shorter.

## 5. Node configuration

`config.json` in a node directory:

```json
{
  "name": "node0",
  "listenAddr": "127.0.0.1:26656",
  "rpcListen": "127.0.0.1:26657",
  "seeds": ["127.0.0.1:26658", "127.0.0.1:26660", "127.0.0.1:26662"],
  "nodeKeySeed": "<32 bytes hex>",
  "validatorSeed": "<32 bytes hex> or null",
  "stateSync": { "trustHeight": "2", "trustHash": "<hex>", "backfill": true },
  "retain": { "blocks": 100000, "versions": 100, "snapshots": 2 },
  "snapshotInterval": 1000
}
```

| field | meaning |
|---|---|
| `name` | the prefix of log lines |
| `listenAddr` | where peers connect, as `host:port` (an IPv6 host in brackets: `[::1]:26656`); the node also advertises it |
| `rpcListen` | the HTTP address of the JSON-RPC as `host:port`; defaults to the p2p port plus one. The CLI splits it at the colon, so the host is an IPv4 address or a name, not IPv6 |
| `seeds` | peers to dial at start; more are learned by address exchange |
| `nodeKeySeed` | the seed of the key that identifies the node on the network (hex) |
| `validatorSeed` | the seed of the consensus key; `null` makes a full node that follows but does not vote |
| `stateSync` | present only for a node that joins from a snapshot; see section 9 |
| `retain.blocks` | how many blocks behind the latest to keep (the latest and that many before it); unset keeps all. Blocks whose time is within the evidence window (the unbonding period) and the newest snapshot's height are kept whatever the setting, since evidence of double signing must still be checked against them. A pruned node answers `lowestHeight` in `status`; `block`, `commit`, `tx` and event replay stop there, while validator sets, account history and the provable application versions are kept on their own terms. Below its lowest block a node that joined by state sync keeps the headers alone that evidence may still name (section 9); they are pruned by the evidence window, not by this setting, a backfilled block replaces each, and `header` serves them |
| `retain.versions` | how many past heights stay provable, beyond the current one (default 100): the window for proofs at past heights and for the light client's queries. Under memory pressure the node keeps only the last two in memory until the heap has room again (section 12); the store keeps the whole window, and a proof or query at an older height in it is read from the store's history records, slower |
| `retain.memoryVersions` | how many of the `retain.versions` past heights are kept in memory; unset keeps all of them until memory fills. The store keeps the whole window either way, so every height in `retain.versions` stays provable: a proof or query at a height older than the ones in memory is read from the store's history records, about 0.2 ms per height back against under 0.1 ms from memory. For a node with a large heap, which never reaches `warn` and would otherwise keep the whole window in its heap (section 12). What a short window buys is memory and pause length: measured at 514,000 accounts under twice the resident heap, two versions in memory instead of a hundred took about 500 MiB off the heap (a peak of 1,630 against 2,140 MiB) and the longest collection pause from 290 to 300 ms down to 190 to 200 ms. What it costs is slower proofs at past heights, 12 to 28 ms fifty and a hundred heights back instead of under 0.2 ms. Throughput is the same either way. When the node has trimmed the window under memory pressure and restores it, it restores it to this setting |
| `indexTrees` | where the application's secondary indices (an account by name, scans) are read from: `memory` (the default) or `store`. With `memory` the node keeps their B+ trees in its heap while they fit, drops them at `warn` and rebuilds them once the heap has had room for long enough (section 12). With `store` it never builds them: index reads go to LMDB from the start, and the guard has no index trees to drop or rebuild. For a validator or a node that mostly applies blocks and serves few index lookups, or for a small heap. Measured at 192,000 accounts under 2.5 times the resident heap for ten minutes, the node opened with 258 MiB of heap in use instead of 398, a third less, and committed 1,552 transfers a second against 1,485, which is within what two runs differ by. What it costs is index reads from memory; proofs and the Merkle trees are unaffected |
| `retain.snapshots` | how many state snapshots to keep (default 2, never fewer than 1) |
| `snapshotInterval` | export a state snapshot every this many blocks (default 1000; `0` disables), in chunks of 2,000 objects. Peers need snapshots to serve state sync |

Consensus timeouts and limits are not in `config.json`: a node started by the CLI runs with the
defaults (propose 3 s plus 500 ms per round, prevote and precommit 1 s plus 500 ms per round, a
1 s pause after each commit, votes re-sent every 500 ms while a round is open, 15 s of tolerated
clock drift on a fresh proposal, 4 MiB blocks, at most 16 pieces of evidence per block, rounds
more than 1,000 ahead ignored). They are `timeouts` and `limits` options of `Node` for a program
that embeds one.

Environment: `LOG` sets the log level (`debug`, `info`, `warn`, `error`); `CHAIN_PASSPHRASE`
the keystore passphrase. `CHAIN_SCHEME` is read only by the local network script, the tests and
the benchmarks (section 2); a node follows the scheme its genesis names. `CROSSCHAIN_CHILD` is
set by `start` for the child process it runs the node in (section 3.2); `NODE_OPTIONS` with a
`--max-old-space-size` of your own (or `--max_old_space_size`) makes `start` run in place under
that limit.

Data lives under `nodeN/data`: the LMDB environment in `lmdb` holds two stores, `chain` (blocks,
commits, validator sets, results, the transaction index, the headers a state-synced node keeps
alone) and `app` (objects, counters, every secondary index entry, the Merkle trees' chunks and
nodes, version history, account history, snapshots; section 12); next to it are `priv_validator_state.bin`, the consensus
sign state that guards against double signing, `peers.json`, the address book, and `LOCK`, which
holds the pid of the process using the directory (a second node on the same directory is
refused). Back a node up by copying `data` while the node is stopped.

## 6. Genesis

`genesis.json`:

```json
{
  "chainId": "chain-1a2b3c4d",
  "signatureScheme": "ml-dsa-44",
  "genesisTime": "1761600000000",
  "validators": [{ "publicKey": "<hex>", "power": "10", "name": "v0" }],
  "consensus": { "maxEvidenceAgeMs": "604800000", "version": 1 },
  "appState": "{ ...the application genesis as a JSON string... }"
}
```

| field | meaning |
|---|---|
| `chainId` | the chain's identity; signatures are bound to it, so two chains never accept each other's votes or transactions |
| `signatureScheme` | the signature scheme of every validator key, account key and signature on the chain: `ml-dsa-44` (the default when absent, so an older file keeps its meaning; post-quantum, 1,313-byte keys and 2,421-byte signatures) or `secp256k1` (34-byte keys and 65-byte signatures). `init --scheme` sets it; any other value is refused (`unknown signature scheme "x"; one of ml-dsa-44, secp256k1`). It is written into the chain state and into the application's global properties, which the app hash covers, so it cannot be changed after genesis: nodes whose genesis files name different schemes never agree on a block |
| `genesisTime` | unix milliseconds; block 1 must be later |
| `validators` | the engine's initial set, used only when the application supplies none. `init` leaves it out and declares validators in the application genesis instead |
| `consensus.maxEvidenceAgeMs` | how old evidence of double signing may be; `init` sets the unbonding period. A node running the core application follows the staking unbonding period in force instead, so the two never drift apart |
| `consensus.version` | the protocol version every header must carry |
| `appState` | the application genesis, inline |
| `appStateFile` | instead of `appState`: a path (relative to `genesis.json`) to a file holding the application genesis. Use it for large states; the node streams the file at first start and never reads it again |

The application genesis (the content of `appState` or of the file):

```json
{
  "coreAsset": { "symbol": "CORE", "precision": 5, "maxSupply": "1000000000000000" },
  "fees": { "scale": 10000, "transfer": { "fee": "100" }, "accountCreate": { "premiumFee": "5000" } },
  "maxTxExpirationMs": "3600000",
  "accounts": [
    { "name": "faucet", "owner": { "threshold": 1, "keys": [{ "publicKey": "<hex>", "weight": 1 }] },
      "active": { "threshold": 1, "keys": [{ "publicKey": "<hex>", "weight": 1 }] }, "balance": "1000000000000" },
    { "name": "op0", "owner": { "threshold": 1, "keys": [{ "publicKey": "<hex>", "weight": 1 }] },
      "active": { "threshold": 1, "keys": [{ "publicKey": "<hex>", "weight": 1 }] }, "balance": "5000000000" }
  ],
  "staking": { "maxValidators": 21, "unbondingPeriodMs": 604800000, "minSelfBond": 10000 },
  "communityPool": 100000,
  "validators": [{ "operator": "op0", "consensusKey": "<hex>", "selfBond": 20000 }]
}
```

- `accounts` are created in order, so the first is `3.0` and becomes the issuer of the core asset.
  Balances are in base units (with precision 5, `1000000000000` is 10,000,000 tokens). An
  authority is a threshold with weighted keys, each of the chain's scheme (the hex starts with
  the scheme tag), and, optionally, weighted member accounts.
- `fees` is any subset of the schedule, in base units, over the defaults in [FEES.md](../FEES.md).
- `staking` is any subset of the parameters in [STAKING.md](../STAKING.md) section 4; the token
  amounts there (`minSelfBond`, `minDelegation`, `validatorCreationFee`, `fixedRewardPerBlock`) are
  whole tokens. The parameters are checked, at genesis and in every proposal: `maxValidators` 1 to
  1,000, `downtimeWindow` 1 to 100,000 blocks, `maxEntries` 1 to 100, every basis-point rate 0 to
  10,000, durations from 1 ms to 100 years, `minSelfBond` and `minDelegation` at least 1, and
  `inflationMinBps` no more than `inflationMaxBps`.
- `communityPool` is whole tokens created at genesis for rewards.
- `validators` name operator accounts, their consensus public keys (of the chain's scheme), and a self-bond in whole tokens
  taken from the operator's balance. Each operator must be one of the `accounts`, with a balance
  that covers its self-bond, or the genesis is refused.

A genesis with many accounts belongs in a separate file named by `appStateFile`; a gigabyte of
accounts loads in about 15 seconds (see [benchmarks.md](benchmarks.md)).

## 7. Keys and signing

The keystore (`keystore.json`) holds named 32-byte seeds encrypted with a key derived from the
passphrase by scrypt, under AES-256-GCM, each with the scheme its key pair is derived under;
`keys list` prints it beside the name, and a file written before there were two schemes reads
as ML-DSA-44 throughout. The file is written atomically. The CLI opens it for any
command that signs, taking the passphrase from `--passphrase-file`, then `CHAIN_PASSPHRASE`, then
a prompt that echoes nothing.

Two processes may use one keystore: every write takes a lock file `<keystore>.lock` beside it,
re-reads the file, applies the change to the keys as they stand on disk, writes and releases the
lock, so commands run side by side keep each other's keys. The lock is waited for up to 5 seconds
(`keystore.json is locked by another process` afterwards), and one left by a process that died is
removed after 30 seconds. A keystore deleted and created again under another passphrase while a
command holds it open is refused with `keystore.json was recreated with another passphrase; open
it again`.

A transaction is a list of operations with an expiration and one or more signatures. Each
operation states the fee it pays; the CLI fills fees from the live schedule before signing, so a
schedule change between signing and inclusion makes the transaction fail rather than pay more.
There are no account nonces: for replay protection a transaction is identified by the hash of its
body (the operations and the expiration, without the signatures) and refused until its expiration
passes, so unrelated transactions from one account never wait for each other. The hash by which
the RPC, the mempool and account history name a transaction, and which the CLI prints, is the
hash of the signed bytes.

A transaction holds at most 64 operations and 16 signatures and may not exceed 1 MiB; a node's
mempool queues 10,000 of them and remembers the last 100,000 hashes it has seen. Over the RPC,
where a transaction travels as hex inside a request body of at most 1 MiB, it can be a little
under 512 KiB.

Signing keys are of the chain's scheme (section 6): ML-DSA-44, 1,313-byte public keys and
2,421-byte signatures, or secp256k1, 34-byte keys and 65-byte signatures, each with its one-byte
scheme tag in front. A transfer with one signature is 2,510 bytes on the wire under ML-DSA-44,
almost all of it signature, and 154 bytes under secp256k1. A key or signature of the other
scheme is refused wherever it enters the chain, so `keys add --scheme` must name the chain's
scheme; `create` and `create-validator` ask `status` for it and follow it.

## 8. The JSON-RPC

A node started by the CLI serves JSON-RPC 2.0 over HTTP at `rpcListen` (the localnet script does
the same for its node 0; a program that embeds `Node` constructs an `RpcServer` for it
separately):

```sh
curl -s http://127.0.0.1:26657/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"account","params":{"name":"alice","prove":true}}'
```

Conventions: 64-bit integers are decimal strings (a JSON number is accepted when it is a safe
integer), bytes are lowercase hex, booleans are JSON booleans, object ids are `type.n` strings
(accounts are type 3, assets 4), proofs are hex of the chain's binary encoding so the existing
verifiers decode them unchanged. `params`, when present, is an object; a `height` left out means
the latest. A request without an `id` is a notification: the method runs, nothing is answered (not
even an error), a body holding only notifications gets HTTP 204 with no content, and a batch that
mixes them with requests is answered for the requests alone. `GET /health` answers
`{height, peers, memory}`, the last the memory guard's level (section 12).

| method | parameters | result | costly |
|---|---|---|---|
| `status` | | chain id, protocol version, `signatureScheme` (`ml-dsa-44` or `secp256k1`), latest height, hash, time and app hash, `catchingUp`, `lowestHeight` kept, `joinedAt` (state sync; forgotten at a restart), peer count, this node's validator address, `memory` (`level`, `shedding`, and in bytes `heapUsed`, `heapLimit`, `heapTotal`, `arrayBuffers`, `external`, `rss` and, under a heap limit as `start` sets one, `heapOld`, the old generation's use, which is the figure the level is taken from; and `database`, the object database's own figures: `arena` with its `slabs` and, in bytes, their `capacity`, the `used` bytes written into them and the `dead` ones among those; `arenaLimit`, the most bytes the slabs may take (`start --arena`), `null` while unbounded, and `storedObjects`, how many objects have their bytes only in the store because of it; `objects`, `resident` while every decoded object is kept or `capped` under the guard's cap, with `hotObjects` and `hotLimit` for the decoded objects cached and the cap, `null` while unbounded; `historyBytes` for the past values the provable window keeps; `history`, `resident` while the whole window of past versions is kept in memory or `trimmed` while the guard has cut it, with `historyWindow`, how many past versions are kept in memory just now, and `lowestVersion`, the oldest height that can be proven, which trimming does not change because older heights are read from the store's history records; `indexTrees`, `resident`, `dropped` or `partial` (dropped for some types), and `trees`, `resident` or `dropped`, for the secondary indices' B+ trees and the Merkle trees; `treeChunks` and `treeChunkLimit` for the dense tree chunks cached while the trees are dropped and how many may be (4,096); and `hotHits`, `hotMisses`, `chunkHits` and `chunkMisses`, the reads the decoded-object cache and the chunk cache answered and the reads that went to the arena or the store, from which the hit rates follow; `database` is `null` for an application other than the core one), `gc` (`available`; the collections V8 ran since start as `collections`, `minor`, `major`, `incremental`, their pauses as `totalMs`, `maxMs`, `lastMs`; the `scheduledMinor` and `scheduledMajor` ones the node asked for), `rpcVersion` | |
| `genesis` | | the genesis document (without any application state file path) | |
| `header` | `height?` | the header; below the lowest block, one the node keeps alone when it has it (section 9) | |
| `block` | `height?` | header, transactions (hex), last commit, evidence, commit | yes |
| `commit` | `height?` | the commit (precommit signatures) for a height | |
| `validators` | `height?` | the validator set that signs that height: its hash, total power, members with their powers, and the proposer of its first round (proposer priorities are not included) | |
| `validatorSet` | `hash` | a set by its hash, for light clients following set changes | |
| `object` | `id`, `height?`, `prove?` | any object by id as JSON, with an object proof on request | yes |
| `key` | `type`, `index`, `key`, `height?`, `prove?` | a lookup in an authenticated unique index (`account`/`byName`, `asset`/`bySymbol`, ...), with a key proof | yes |
| `account` | `name`, `height?`, `prove?` | account, balances (each with its asset's precision), its validator, history count, and a proof that the name maps to this account or to none | yes |
| `validator` | `operator` or `id` | the validator with status, power, self-bond, delegator count | |
| `delegation` | `delegator`, `validator`, `height?`, `prove?` | the delegation (shares and current token value) and pending unbondings, with a key proof | yes |
| `balance` | `account`, `asset?` | one balance | |
| `accountHistory` | `account`, `from?`, `limit?` (default 20, max 100), `reverse?` | history entries with sequence numbers, oldest first from sequence `from`; with `reverse`, newest first, and `from` counts entries back from the newest | yes |
| `tx` | `hash`, `prove?` | where the transaction landed, its result, the decoded operations, and inclusion and result proofs | yes |
| `broadcastTx` | `tx` (hex), `mode?` (`sync`, the default, or `commit`), `timeoutMs?` (default 30,000, at most 120,000) | `sync`: the mempool's verdict, `added` or `seen`; `commit`: waits for inclusion and returns height, position and result; `-32004` when the mempool is full at a limit lowered because memory is short | yes |
| `accounts` | `limit?` (default 50, max 200), `after?` | accounts by name with their core balance, paged by name; `after` is the last name of the previous page and is not repeated | yes |
| `parameters` | | the core asset, the fee schedule and the staking parameters in force | |
| `proposals` | | open parameter proposals with the full parameters each would adopt | yes |
| `mempool` | | count, bytes and the first hundred hashes | |
| `peers` | | connected peers with addresses, direction, height and latency | |

`account` takes a name; the account parameters of `balance`, `accountHistory` and `delegation`
take a name or an id (`3.n`); a validator is named by its operator (`validator.operator`,
`delegation.validator`) or by its own id (`validator.id`). On `object`, `height` selects the
object's value at that height; on `key`, `account` and `delegation` it selects the height of the
proof only, while the id, the account, its balances and the delegation are the current values.

The `seen` verdict of `broadcastTx` means the node has the hash in its recent cache, which
includes transactions it rejected; it does not mean the transaction is pending or included. In
commit mode a transaction seen before that is neither pending nor committed is refused at once
with `-32002`, and a timeout does not remove a pending transaction from the mempool. At most
1,000 commit waits are held at a time; beyond that the call answers `-32004` and the client
should broadcast in sync mode and poll `tx`.

Errors carry JSON-RPC codes: `-32700` unparsable body, `-32600` malformed request (also a batch
outside 1 to 20 requests), `-32601` unknown method, `-32602` bad parameters (including a `height`
the node no longer has a provable version for), `-32001` not found, `-32002` the mempool refused
the transaction (the message says why), `-32003` not included before the timeout, `-32004` rate
limited.

While the node sheds load under memory pressure (section 12), every costly method but
`broadcastTx` answers `-32004` with `node under memory pressure` before the rate limiter is
consulted, and `GET /events` answers HTTP 503; the cheap methods, `/health` and the streams
already open keep working, and everything resumes once the heap eases. `broadcastTx` is still
served, because the mempool's limit is what throttles it then: from the guard's `warn` level
the mempool admits up to a lowered limit (section 12), and a `broadcastTx` that
finds it full at that limit answers `-32004` with `mempool full: its limit is lowered while the
node is short of memory` rather than `-32002`: the transaction is not at fault, and the client
tries again later.

Limits per client address: a token bucket of 100 refilled at 50 a second. Every HTTP request
spends one token, and is refused with HTTP 429 when it cannot; each costly method in it spends 4
more, answered as a `-32004` error inside the HTTP 200 response. A batch of up to 20 requests
therefore costs one token plus 4 per costly call, and its requests run one after another. Request
bodies up to 1 MiB; 8 event streams. `RpcServer` takes other values; the defaults are for a
public endpoint.

### 8.1 Event streams

`GET /events?types=block,tx,account,validatorSet` is a server-sent event stream. Each event has
the block height as its id:

| event | when | data |
|---|---|---|
| `block` | every committed block | height, hash, time, transaction count, failures, app hash, proposer |
| `tx` | every transaction in a block; `tx=<hash>` narrows to one | hash, height, index, ok, error |
| `account` | every history entry of one account, with `account=<name or id>` | the entry |
| `validatorSet` | when the set changes | the updates |

A client that reconnects sends `Last-Event-ID: <height>` and receives the blocks after it, from
within the last 1,000; the replay costs as much as a costly call and is refused with 429 when the
client cannot afford it, rather than opening a stream with a gap. The replay stops at a block the
node has pruned. A stream whose client has stopped reading is closed once a megabyte of events is
queued for it; the client resumes with `Last-Event-ID`. No stream is opened while the node
sheds load under memory pressure: the request gets HTTP 503, and the client tries again later.

## 9. Joining a running chain

A node needs the chain's `genesis.json` and a directory with a `config.json`. Two ways in:

**Replay from genesis.** Write a `config.json` with `validatorSeed: null`, a fresh `nodeKeySeed`,
and the addresses of running nodes as `seeds`. The node fetches every block from its peers,
verifies each commit against the validator set it knows, and executes it. Throughput is bounded
by signature verification: a few thousand transfers a second.

**State sync.** Pick a header the operator trusts: the height and hash that `light verify` prints
on a node they already run, or a header hash obtained out of band from someone they trust (`show`
prints the height but no hash). The header must be younger than the light client's trusting
period, 4 days. Write the directory with:

```sh
node src/cli.ts join ./testnet node4 127.0.0.1:26656 2 <hash of header 2> 26700
node src/cli.ts start ./testnet/node4
```

The node asks peers for their newest snapshot, verifies its manifest against the app hash in a
header the light client has verified from the trusted one, fetches and verifies every chunk
against the manifest's range proofs (a corrupt chunk costs the peer reputation and is refetched
elsewhere), rebuilds the state, fetches the block at the snapshot height with its validator
sets (whose keys must be of the scheme the local `genesis.json` names, or the join stops) and
the headers below it as far back as evidence of double signing may reach (the unbonding
period), each checked against the hash the header above it names, writes it all in one
transaction, and continues with consensus. The snapshot it picks is the newest that two peers
offer, or else the newest offered, and it must not be older than the trusted header, so trust a
header from before the newest snapshot. The headers let the node check evidence for heights
before its join as any other node does; it keeps them until the evidence window moves past them.
With `backfill` (on by default) it then fetches the blocks before the snapshot in the background,
newest first, checking each against the hash chain, down to genesis or to the floor
`retain.blocks` sets, each replacing the header it kept alone for that height.
Peers serve a snapshot only if they export them (`snapshotInterval`), so a chain of nodes with
`snapshotInterval: 0` cannot be joined this way. If no peer connects within 30 seconds, or none
offers a snapshot, the node logs it and replays from genesis instead; a snapshot for which no
peer supplies a valid manifest, or whose chunks every source fails to deliver, or whose peers do
not hold the headers back to the evidence window, stops the start with an error. A join that
stops, by an error or a crash, has written nothing but the headers fetched so far and the
validator sets they name: start the node again and it joins afresh, reusing those. During the
join the node holds the chunks, the rebuilt state and the opened store at once: plan for about
three times the state size in memory.

## 10. Running a validator

1. Start a node with a `validatorSeed` (every directory from `init` has one; `join` leaves it
   out; add one to a joined node's config before it becomes a validator).
2. Fund an operator account and register:

```sh
node src/cli.ts create ./testnet/node0 operator9
node src/cli.ts transfer ./testnet/node0 faucet operator9 50000
node src/cli.ts create-validator ./testnet/node9 operator9 20000
```

`create-validator` must run against the validator's own directory: it reads the consensus key
from `config.json`. The self-bond must meet `minSelfBond`, and a creation fee goes to the
community pool. The validator enters the active set at the end of the block if its stake is
among the top `maxValidators`; the engine applies set changes two heights later.

3. Delegators join with `delegate`, leave with `undelegate` (tokens return after the unbonding
   period, 7 days by default) or move with redelegation. Rewards come from the community pool,
   fed by fees, slashes and the mint, and are paid every block to the signers of the previous
   commit by stake, with a bonus to the proposer and a commission to the validator.

4. A validator that misses too many blocks in the downtime window is jailed, slashed lightly, and
   leaves the set; after the jail time its operator runs `unjail`. Double signing, proven by
   evidence any node can gossip, slashes 5% and tombstones the validator for good. A node that
   restarts never signs twice for a height and round, because the sign state file remembers
   the last signature.

5. Validators change the chain's parameters by proposal: `propose` with the changes, `signal`
   from the others; more than two thirds of active stake adopts at the end of the block. Fees and
   staking parameters travel together, as in [FEES.md](../FEES.md) section 4.

## 11. The light client

The light client follows the chain from a trusted header by verifying commits, bisecting through
validator set changes, and never trusting a header older than the trusting period (4 days by
default, below the unbonding period). The CLI keeps its anchor in `light.json` next to the
keystore. `account` and `verify-tx` use it to check proofs: an account's name proof is verified
against the app hash in the header after the queried height, since the app hash a header carries
describes the state after the previous block.

```sh
node src/cli.ts light ./testnet/node2 trust 2 <hash of header 2>
node src/cli.ts light ./testnet/node2 verify
node src/cli.ts account ./testnet/node2 alice     # "name proof verified by the light client"
node src/cli.ts verify-tx ./testnet/node2 <hash>  # inclusion and result proofs checked
```

Without a `light.json`, the first command that needs the light client trusts the node's latest
header as it stands and saves it: trust on first use, not an anchor you chose. Run `light trust`
first when it matters; it refuses a header older than the trusting period or from the future.
`light verify` and every verified query at a later height move the anchor up. A height before
the anchor is verified backwards instead: the client walks down from the anchor one header at a
time, each fetched alone with the `header` method and required to hash to what the header above
it names, with no commit to check, since each header stands for the chain before it; the anchor
stays where it was. The walk reaches at most 100,000 headers below the anchor; for an older
height, anchor nearer to it with `light trust`. So `verify-tx` checks a transaction in any block
the node serves a header for, before or after the anchor. What `account` proves is the mapping
from the name to the account id, or its absence; the balances and the rest of the account are the
node's answer, unproven.

## 12. Operating notes

- **Disk.** A full block of transfers is 4 MiB, a transfer in it 2.5 KiB under ML-DSA-44 or 154
  bytes under secp256k1; state is about the size of its keys (a gigabyte of ML-DSA-44 genesis
  becomes 614 MiB of LMDB; secp256k1 keys are a fortieth the size, so the same accounts make a
  far smaller state); a snapshot adds as much again. `retain.blocks` prunes
  blocks outside the evidence window, and the headers a state-synced node keeps alone go as the
  window moves on; snapshots are kept to `retain.snapshots`. Account history and stored validator
  sets are never pruned and grow with use. The application store holds, beside the objects,
  every secondary index entry and the Merkle trees' chunks and nodes, written in the same
  transaction as the objects they belong to, which is what lets the node page them (below):
  at 192,000 secp256k1 accounts the genesis store is 213 MiB where the objects alone were
  34.6, about 1.1 KB an account in all (docs/benchmarks.md sections 4.11 and 4.12), and a block
  scattered over the whole state rewrites about 12 MiB of chunks. A store written before they
  existed has no entries or chunks; the first open computes them from the objects, as a
  restart always did, writes them once, and from then on the node restarts from them.
- **Memory.** With memory to spare the whole state stays in memory: about 1.1 GB per gigabyte
  of genesis, plus the version history (changed objects times the retention window) and,
  during a state sync join, two more copies. `start` runs the node under a heap limit of three
  quarters of physical memory (`--heap <MiB>` sets another; section 3.2), since V8's own default
  is a few gigabytes whatever the machine has, and a state that outgrows the limit aborts the
  process; as the heap fills the memory guard (next bullet) pages the state to the store.
  Per account with its balance and two keys the measured resident cost is 6.1 KB under
  ML-DSA-44 and 3.5 KB under secp256k1 (docs/benchmarks.md section 7): the keys account for
  the difference, the object database's own objects, indices and trees for the rest (about
  3.2 KB, of which the decoded objects are 0.55 KB and the indices, the name tree and the
  Merkle trees the other 2.65 KB), so ten million accounts need tens of gigabytes of heap under
  either scheme to run resident, and 40 to 50% of that with everything the guard can drop
  dropped. On disk the same accounts were 3.3 KB and 190 bytes each before the index entries,
  chunks and nodes were stored; those add about 1 KB an account.
- **The memory guard.** The node samples its heap every second and holds a level by how full
  it is (the old generation's use against its limit; below); each level turns the object database's dials (STATE-PAGING.md section 7), so a
  filling heap trades speed for room before anything is refused. `ok`: the database keeps
  every object it has decoded and its index and Merkle trees resident. `warn`, at 70% of the
  limit (`memory: heap filling`): a major collection is started and the database's cache of
  decoded objects is capped at 100,000, the rest evicted at once; an object evicted and read
  again is decoded afresh from the arena of encoded bytes, about a microsecond for an account;
  the secondary indices' B+ trees are dropped, every lookup becoming one LMDB read and every
  scan an LMDB cursor merged with the writes of the block in progress; the window of past
  versions kept in memory is cut to the last two (below);
  and the mempool admits up to half its limit, 5,000 transactions. Nothing is refused at
  `warn`: a block of transfers looks up no index and reads no past version, and a loaded
  node commits more with both in the store than in its heap.
  `pressure`, at 85% (`memory: shedding load`): the cache is capped at 10,000; the Merkle trees are dropped as well,
  every root and proof reading its paths from the chunks and nodes in the store through a
  cache of 4,096 chunks (at most 128 MiB of buffers, outside the heap, enough to hold the
  dense trees of about two million objects whole); and the mempool admits up to a tenth of its limit, 1,000 transactions, costly RPC
  methods (all but `broadcastTx`, which the mempool's limit throttles) and new event streams are refused, and the signature
  cache is dropped, while consensus and block sync go on with whatever is pooled, so a
  validator keeps voting and a full node keeps following, now through the store. `critical`,
  at 95% (`memory: heap at the limit; stopping before the process aborts`): the mempool is
  paused and the CLI stops the
  node cleanly, RPC, node, store and verifier in that order, and exits with code 3, so a
  supervisor restarts it with a larger heap instead of finding a process V8 aborted; it is
  reached only when one block's working set does not fit. A level is left only once the heap
  is 5 points below the threshold it was entered at (`memory: easing`), so a heap hovering at
  a threshold does not flap, and one sample may cross several levels. Back at `ok` the cap is
  lifted at once, but the trees are rebuilt only when they fit: dropping them frees so much
  (130 to 175 MiB for the index trees and 190 to 220 MiB for the Merkle trees at 192,000
  accounts) that a node which rebuilt them at the first `ok` sample went straight back to
  `pressure`, over and over. And a load that filled the heap once fills it again: trees
  rebuilt a few seconds after a drop were dropped again a few minutes later, the node
  committing about a tenth less while it had its index trees. So the node waits after a drop until the level has
  been `ok` for as many samples in a row as it had run since it last rebuilt something
  (or since it started), at least ten and at most 600, which is ten minutes at the default
  interval. Then it rebuilds a tier
  when its estimated heap (210 bytes per index entry, 2,000 per name-tree leaf and 500 per
  record of a past version it must build again) fits within half
  the heap limit beside the highest of the last ten samples, the index trees first; a tier
  rebuilt right up to the `warn` line left the load no room, and a node that did so
  committed about a fifth less than with the tier left dropped (`memory: index
  trees rebuilt`, `memory: Merkle trees rebuilt`); what does not fit stays dropped, the node
  running on the store at `ok`, and the guard says once what it is waiting for (`memory:
  staying paged until the heap has room to rebuild`, with `needs` and `room` in MiB, once
  per drop) and asks again at every sample. The mempool's limit follows the level rather than the pool being
  paused: lowering it evicts nothing, what is pooled is still reaped, and transactions are
  admitted again as soon as blocks have taken the pool below the limit; while the pool would
  refuse, the node fetches none that peers announce. A refusal at a lowered limit says so
  (`mempool full: its limit is lowered while the node is short of memory`). The history
  window: from `warn` the database keeps only the last two past versions in memory and
  forgets the older ones at once (past object values and the records of overwritten tree
  nodes, which are what still grew with everything else dropped). Nothing consensus does reads
  a past version. The store is not trimmed: it keeps the whole `retain.versions` window, with
  a history record for each height that says what that height overwrote (object bytes,
  counters, tree nodes). What notices the cut is a proof or a query at a height older than
  the last two: it is no longer answered from memory but from those records, by scanning the
  record of every height after the one asked about, so it gives the same answer, takes
  longer the further back the height is, and costs no memory, since nothing read is kept.
  Measured at 192,000 accounts under full blocks, a proof takes about 0.2 ms per height back, 19 ms at the oldest of a hundred, against a tenth of a millisecond from memory (docs/benchmarks.md section 4.13). Every height in
  `retain.versions` therefore stays provable while the window is cut; `status` shows
  `history: trimmed`, the number of versions in memory as `historyWindow`, and the oldest
  provable height, unchanged, as `lowestVersion`. In the running node what was forgotten
  stays forgotten in memory: once both tiers of trees are rebuilt and the node's estimate of
  what the window held fits in the room left within half the heap limit, the window is let grow again (`memory:
  history window restored`), one block at a time, up to `retain.memoryVersions` when that
  is set, and a restart with enough heap reads the
  whole window back, the name trees' past versions from the nodes the history records
  hold (`indexVersions=records` in the line `loaded application state`) without replaying
  the accounts. One exception: a store written by a build from before the history
  records carried the name tree's nodes cannot prove an account or a name from those
  records (`... is not available: the record of version N was written without the sparse
  tree nodes`); they age out after `retain.versions` blocks. A node with a large heap
  never reaches `warn`, so it never trims the window and keeps all of it in its heap.
  `retain.memoryVersions` in
  `config.json` sets how many past versions such a node keeps in memory from the start;
  the store answers for the rest as it does while the window is cut, and `status` shows
  `history: trimmed` with that number as `historyWindow`. Measured at 514,000 accounts
  under a heap of 3,126 MiB, twice the resident heap, for two minutes, twice each way:
  with the whole window in memory the node committed 1,355 and 1,255 transfers a second
  on a heap that peaked at 2,140 MiB with a longest collection pause of 290 to 300 ms;
  with two versions, 1,369 and 1,241 on a peak of 1,630 MiB with a longest pause of 190
  to 200 ms. A short window does not change throughput. It saves about 500 MiB at that
  size and shortens the pauses, and a proof fifty or a hundred heights back takes 12 to
  28 ms instead of under 0.2 ms. Whether the index trees are in memory at all is a setting
  as well: `indexTrees` in `config.json`, `memory` by default. With `store` the node never
  builds them, reads every index from LMDB as it does after a drop, and does not count
  them among what it waits to rebuild, so `status` shows `indexTrees: dropped` for good.
  Choose it for a validator or a node that mostly applies blocks and serves few index
  lookups (accounts by name, scans), or for a small heap. Measured at 192,000 accounts
  under a heap of 1,488 MiB, 2.5 times the resident heap, for ten minutes: by default the
  node opened with 398 MiB of heap in use, committed 1,485 transfers a second in 1,780
  blocks and reached `warn` twice, with a longest collection pause of 132 ms; with `store`
  it opened with 258 MiB, a third less, committed 1,552 a second in 1,823 blocks and
  reached `warn` once, at 40 s, from the history window and the cache, with a longest
  pause of 155 ms. Over the whole run the two rates are within what two runs differ by
  (4.5%); the default run's own stretches show the cost of the trees (below). After that
  one `warn` the node has nothing to rebuild but the window. What the setting gives up is
  index reads from memory, which were not measured under it; proofs and the Merkle trees
  are unaffected. What paging costs (docs/benchmarks.md sections 4.11 to 4.13): with
  the cache capped a block of transfers among random accounts takes about twice as long; the
  index trees dropped cost a block of transfers nothing (a lookup through LMDB costs about
  what a resident one does, a scan four to six times as much, still under a microsecond an
  entry); the Merkle trees dropped cost less than a tenth of throughput now that their chunk cache
  holds every chunk (10.3 against 10.9 blocks a second of 500 transfers; with a cache of 256
  chunks it was 7.7 against 9.4), the first root after a drop reading its chunks from LMDB
  (a root over 1,000 changes 54 ms against 20 on average, 24 at the median) and a name proof
  costing four times as much; and with everything dropped the database runs
  on 40 to 50% of its resident heap. What the guard buys is a node that keeps committing at
  its limit instead of aborting, at the throughput it has resident within a tenth, and a
  clean stop with a reason when even that is not enough. Two things to know. The limit the node measures against and reports is the old
  generation's, the `--max-old-space-size` figure `start` passes (`--heap 512` shows as
  512 MiB), because V8's own `heap_size_limit` adds the young generation's reserve, 192 MiB
  with the 64 MiB semi-spaces, which long-lived objects never fill, and a guard measured
  against it put `pressure` past the point of the abort. The use it is compared with, and
  the `heap=` of the status line, is the old generation's as well (`heapOld` in `status`):
  V8's used heap, `heapUsed`, also counts the young generation, which between two minor
  collections holds up to 64 MiB of garbage that never reaches the old generation, and
  on a small heap that read as full (a node under a 153 MiB limit logged `critical` at
  `162/153 MiB` a moment before a collection left 42). So `heapUsed` in `status` can be
  above the figure in the status line. And a store too large for the heap
  is opened paged. The guard cannot page anything while the store is opened, so the node
  decides beforehand: it takes 0.7 of the heap limit less the old generation's heap in use as the room, and
  estimates the index trees and the Merkle trees from the object counts in the store (210
  bytes per index entry, 2,000 per name-tree leaf). If the index trees do not fit they are
  left in the store, then the Merkle trees if they do not fit what remains. When either is left
  out the history window is not read back either, because reading it takes more heap than the
  trees: the node starts with no window in memory, which fills again a block at a time. The
  records stay in the store until they age out, and the heights before the one the node
  opened at are proven from them as under a cut window, so `lowestVersion` is what it would
  have been. The line
  `loaded application state` then carries `paged=indexTrees, trees, history`, naming what was
  left out, and the trees are rebuilt later if room appears, as after a drop. Measured
  (docs/benchmarks.md section 4.13), a 192,000-account state that takes 595 MiB resident
  opened and ran under a `--heap` of a quarter of that (149 MiB: every tier left in the
  store, 34 MiB of heap after opening, 1,193 transfers a second for a minute without reaching
  `pressure`), and at the resident figure or 0.8 times
  it committed 1,620 and 1,520 transfers a second for ten minutes with nothing refused after
  the first two seconds and no visit to `pressure`. A `--heap` below the resident state
  costs a loaded node no throughput: at 192,000 accounts it committed 1,650 to 1,800
  transfers a second at every limit from 0.8 to 2.0 times its resident heap, which is the
  spread between runs. What it costs is the reads that go through the store,
  scans, name proofs and proofs at heights the trimmed window no longer holds. What the
  `warn` level is for is the slow stretch of a long run. While the index trees were dropped
  only at `pressure`, under a sustained full load
  the rate fell by a third over the first minutes, while the index trees were resident and
  the heap climbed towards the pressure line (each transfer adds two entries to them, and
  collections took 7 to 12% of the time), and returned to 1,330 to 1,560 transfers a second,
  level, once they were dropped; they are now dropped at `warn`, with the history window,
  and the same ten-minute run holds 1,530 to 1,780 transfers a second from its first minute
  to its last, at `ok` but for half a second at `warn` every two minutes or so. Under a
  heap of 2.5 times the resident state the same run shows the wait before a rebuild: the
  index trees were dropped at `warn` 34 seconds in and rebuilt 30 seconds later, dropped
  again at 211 seconds and, after a wait as long as the node had run since the rebuild,
  left in the store for want of room. The node committed 1,310 to 1,440 transfers a
  second while they were resident and 1,420 to 1,600 while they were not: resident index
  trees cost such a load about a tenth, and in return index reads (accounts by name,
  scans) are served from memory.
  The store's part in that was small: LMDB's own work for the
  application's commit grew by half over 400 blocks (17 to 26 ms), most of it the account
  history, whose entries were keyed by account and came to dirty a page each. The account
  history is now one log in block order, a block's entries appended to its end, a few pages
  a block, and the same commit grows from 15.1 to 19.4 ms. The larger and noisier part
  of a commit is the flush to the device, of which a block now pays one (the block and the
  application's state are one transaction) where it paid two.
  Array buffers (ML-DSA keys, stored bytes, the database's arena) live outside the V8 heap and
  outside the guard's fraction, so a machine that runs out of physical memory for them meets
  the operating system's killer, not the guard; `status` reports `arrayBuffers` and `rss`
  beside the heap figures. The arena, the encoded bytes of every object, is the part of them
  that grows with the state, and since the guard does not see it, it is bounded by hand:
  `start --arena <MiB>` (at least 16) holds its slabs within that many MiB. After each commit
  the slabs beyond the limit are released whole, those nothing has read since the last pass
  first and never the one being filled, and an object whose slab was released is read from the
  store (one LMDB read and a decode) when it is not among the decoded objects cached; it is
  kept in the arena again when it is next written. At startup, objects beyond the limit are
  left in the store instead of being loaded. `status` shows the limit and how many objects are
  only in the store (`arenaLimit`, `storedObjects`). Without `--arena` nothing is released. Measured on a 192,000-account secp256k1 state (docs/benchmarks.md section 4.13), budgets of 32 and 16 MiB cost no throughput that could be measured (1,520 and 1,500 transfers a second against 1,511 without one), and 16 MiB, a quarter of what the arena otherwise grew to, saved 48 MiB of array buffers; it matters more for an ML-DSA-44 state, whose keys are most of the arena.
  Collections are scheduled as well: right after every commit, the
  idle moment before the next proposal, a minor collection runs, and a major one is started
  once the heap has grown by 256 MiB or a tenth of the limit since the last; the status line
  and `status` count every pause V8 takes, scheduled or not.
- **CPU.** Signature verification is the only heavy work; the node uses a worker pool of all
  cores but one. One core verifies about 1,100 ML-DSA-44 or 1,400 secp256k1 signatures a second.
- **Monitoring.** The status log line, `GET /health`, and `status` (`catchingUp` is true when a
  peer is more than one block ahead). All three carry the memory guard's level (`memory`); the
  status line and `status` also count the garbage collection pauses since start with their
  total and longest duration (`gc`), so a node whose pauses grow can be seen before it stalls,
  and `status` reports under `memory.database` which tiers of the state are resident or
  dropped, whether the history window is trimmed and how often the caches hit (section 8), so a node that is paging can be seen too.
- **Upgrades.** There is no deployed network and encodings may change between versions. A node
  whose data directory belongs to another chain id refuses to start; a block from another
  protocol version is rejected by validation.

## 13. Troubleshooting

| symptom | cause and fix |
|---|---|
| `missing <argument>` | the command's arguments are positional; see section 4 |
| the keystore refuses to open | wrong passphrase; `CHAIN_PASSPHRASE` or `--passphrase-file` must match the one `init` printed |
| `connection refused` in the log | a seed is not running yet; the node keeps dialling and starts once it has peers |
| no blocks, round numbers climbing in `status` | two thirds or less of the voting power is online; more than two thirds is needed |
| `rate limited` (`-32004`) | the client exceeded the token bucket: a request spends one token and each costly call four more, from 100 refilled at 50 a second |
| `node under memory pressure` (`-32004`), or HTTP 503 from `/events` | the node is shedding load at the guard's `pressure` level (section 12): broadcasts, costly calls and new event streams are refused until the heap eases; cheap calls and `/health`, which reports the level, still answer |
| `mempool full: its limit is lowered while the node is short of memory` (`-32004`) | the heap is at `warn` or above and the mempool already holds as many transactions as it admits at that level (half its limit at `warn`). Nothing is wrong with the transaction: send it again once blocks have taken some out |
| `... is not available: the record of version N was written without the sparse tree nodes`, for a height inside `retain.versions` | the history window in memory was trimmed at `warn` or above (`status` shows `history: trimmed`), is kept short by `retain.memoryVersions`, or the store was opened paged without it, so the height is read from the store's history records, and the record named was written by an earlier build that did not keep what a proof of an account or a name needs. Such records age out after `retain.versions` blocks; a restart with enough heap reads the whole window into memory and proves the height at once |
| `... is not available: the store has no history record of version V`, or after a restart a `provableFrom` in the line `loaded application state` (`lowestVersion` in `status`) higher than `retain.versions` gives | the store has lost a history record (a damaged store). A height whose proof would need the missing record is refused, since answering from the records that are left would give a wrong proof. At the next start the node uses only the records that are unbroken up to the current height: the heights below the gap are not provable, their records are deleted with the next commit, and the window fills again as blocks are applied |
| a proof or query at a past height is slow | the same situation with current records: heights older than the window in memory (`historyWindow` in `status`) are read from the store's history records (section 12). The window grows back a block at a time once the heap has room (`memory: history window restored`), up to `retain.memoryVersions` when that is set |
| `memory: heap filling` | the heap is 70% full (`warn`); a major collection was started, the database's cache capped at 100,000 decoded objects, its index trees dropped, lookups and scans reading the store, the history window in memory cut to the last two versions, and the mempool's limit halved. Nothing is refused. Watch `heap=` in the status line, and plan a larger `--heap` if it keeps climbing |
| `memory: shedding load`, then `shedding load: mempool limit lowered, costly requests refused` | the heap is 85% full (`pressure`): the mempool admits up to a tenth of its limit (`limit` in the line) and fetches nothing while it holds that many, costly RPC calls and new streams are refused, the signature cache is dropped, the database's cache is capped at 10,000 decoded objects, and its Merkle trees are dropped after the index trees that went at `warn`, roots and proofs reading the store like lookups and scans, the history window in memory staying at the last two versions; consensus and block sync go on. `memory: easing` and `load shedding over` follow once the heap falls 5 points below the threshold; the trees come back only when they fit (next row) |
| `memory: staying paged until the heap has room to rebuild` | the heap eased to `ok` with the index trees or the Merkle trees dropped or the history window trimmed, and rebuilding them (`needs`) does not fit within half the heap limit beside the heap of the last ten samples (`room`). The line comes once per drop, after the wait at `ok` that precedes any rebuild (section 12). Nothing is wrong: the node runs on the store, its blocks at the rate they have resident within a tenth and its scans and proofs slower (section 12), and rebuilds when the room appears (`memory: index trees rebuilt`, `memory: Merkle trees rebuilt`); a larger `--heap` brings the trees back for good |
| `memory: heap at the limit; stopping before the process aborts (raise --max-old-space-size or --heap)`, then exit code 3 | the heap is 95% full (`critical`); the node stopped cleanly rather than wait for V8 to abort it. Start it again with a larger `--heap`, or on a machine with more memory: one block's working set did not fit even with every tier dropped, and nothing but the limit changes that |
| `loaded application state` with `paged=indexTrees, trees, history` | the trees named were estimated not to fit the heap and were left in the store, and the history window was not read back (section 12). Nothing is wrong: the node runs on the store, its blocks at the rate they have resident within a tenth and its scans and proofs slower, proves the heights before the one it opened at from the store's history records, and rebuilds the trees if room appears. A larger `--heap` opens the state whole |
| the process aborts while loading the state (V8's out-of-memory error), or reaches `critical` as soon as it starts | the `--heap` is below what opening the store takes even with the trees left in the store (the node opens a state paged when its trees do not fit; section 12). Start with a larger `--heap`; with the resident state under the limit the guard pages only what the load adds |
| `--arena takes a size in MiB, at least 16` | `--arena` was given something other than a whole number of MiB of 16 or more |
| `--heap takes a size in MiB, at least 256` | `--heap` was given something other than a whole number of MiB of 256 or more |
| `gc: not exposed; collections run when V8 decides (start with --expose-gc to schedule them after commits)` | the node runs without `--expose-gc`: `start` found `--max-old-space-size` already set and did not wrap itself, or the node is embedded in a program. Nothing is wrong; collections are simply not scheduled after commits |
| `operation 0 states a fee of X, the schedule requires Y` | the fee schedule changed after the transaction was built; rebuild it |
| `missing active authority of ...` or `no required authority` | signed with a key that is not in the account's authorities |
| `transaction expired` | built more than 60 seconds ago (or half of `maxTxExpirationMs`, when that is shorter), or the sender's clock is behind the chain's |
| `key must be a secp256k1 key` (or `ml-dsa-44`) | an account key of the other scheme than the chain's, in a genesis account or an `accountCreate` or `accountUpdate`; `status` reports the chain's `signatureScheme`, and `keys add <name> --scheme <scheme>` makes a key of it |
| `consensus key must be a secp256k1 key` (or `ml-dsa-44`); `genesis validator <operator>: consensus key must be a ... key` | a `validatorCreate`, a `validatorUpdate` or an application-genesis validator whose consensus key is of the other scheme; `create-validator` derives the key under the chain's scheme, so this comes from a hand-built transaction or genesis |
| `signature of another scheme than the chain uses` | a transaction signed with a key of the other scheme (one added with the wrong `--scheme`); sign with a key of the chain's scheme |
| `genesis validator key is not a secp256k1 key` (or `ml-dsa-44`) | the engine's `validators` list in `genesis.json` holds keys of another scheme than `signatureScheme` names |
| `unknown signature scheme "x"; one of ml-dsa-44, secp256k1` | `signatureScheme` in `genesis.json`, or a `--scheme` flag, is not one of the two names |
| `state sync: a validator key is not a secp256k1 key; this is not the chain genesis describes` | the peers serve a chain of another scheme than the local `genesis.json` names: the wrong genesis file, or seeds on another chain |
| `catchingUp: true` for long | the node is far behind and fetching blocks; verification runs at a few thousand transfers a second |
| `state sync: no peers; replaying from genesis` | no peer connected within 30 seconds of starting; check the seeds and that they are running |
| `state sync: no peer offers a snapshot; replaying from genesis` | the connected peers export no snapshots (`snapshotInterval: 0`) or have not reached their first one |
| `state sync: no peer serves the headers below H that evidence may still name` | the peers offering the snapshot do not hold the headers from H back to the evidence window (they joined by state sync themselves and have let theirs go, or run a shorter evidence age); start the node again once a peer that keeps its blocks is connected, and it reuses the headers it already stored |
| `block H carries evidence for height h, whose validator set this node does not hold; its history does not reach that far` | the node halted rather than apply the block differently from the rest of the network: its headers do not reach back to h (a data directory written before header records existed, an embedded node given a shorter evidence age than the chain's unbonding period, or an unbonding period lengthened by proposal since the join); stop it, delete `data/lmdb` only (keep `priv_validator_state.bin`) and join again |
| `keystore.json is locked by another process` | another command held the keystore's lock (`keystore.json.lock` beside it) for the 5 seconds a write waits; run the command again. A lock left by a process that died is cleared after 30 seconds |
| `data directory ... is in use` | another node has the directory open (its pid is in `data/LOCK`); stop it first |
| `stored objects do not hash to the stored app hash` | the application store is corrupt or from another version; stop the node, delete `data/lmdb` only and resync, keeping `data/priv_validator_state.bin`, the double-sign guard |
| `object <id> does not hash to its leaf in the stored tree` | the same, found earlier: at startup the Merkle trees came back from their stored chunks and nodes, every object was hashed against the leaf the tree holds for it, and one did not match. The fix is the row above |
| `the stored tree has n leaves for m objects`, `... is not the hash of its children`, `sparse tree node ... does not hash to what its parent says` | the same: a stored object is missing while its tree still holds its leaf, or a stored tree node is damaged. The fix is the row above |
| `<type>.<index>: the stored entry for object <id> is missing` (or `is object <id>'s`, `the store holds n entries for m objects`, `a stored index entry is malformed`) | the same: the stored index entries do not match the objects, which the app hash cannot show for an index it does not cover. The fix is the row above |
