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
npm test                 # 299 tests, about two minutes
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
genesis (section 6). While it runs, the CLI's query commands (`show`, `account`, `history`,
`tx`, `verify-tx`, `parameters`, `proposals`, `light`) work against it. The script keeps its
keys in memory and writes no keystore, so a command that signs needs one made by hand: the
faucet's seed is the SHA-256 of the text `faucet` and operator N's that of `opN`, which
`keys import <name> <seedHex>` takes (with `--scheme` when the script runs on secp256k1), and
the command then names the file with `--keystore`. `create-validator` needs a node directory
and does not work against the script.

```sh
node src/cli.ts show http://127.0.0.1:26657
```

## 3. A real network over TCP

### 3.1 Initialise

```sh
export CHAIN_PASSPHRASE=testnet
node src/cli.ts init ./testnet 4 26656                      # ML-DSA-44 signatures
node src/cli.ts init ./testnet 4 26656 --scheme secp256k1   # or secp256k1; one scheme per chain
node src/cli.ts init ./testnet 4 26656 --max-block-bytes 1048576   # or with blocks of 1 MiB; 4 MiB without the flag
```

`init [dir] [validators] [basePort] [--scheme ml-dsa-44|secp256k1] [--max-block-bytes <n>]` (by default `testnet`, 4 validators and base port 26656) writes:

| path | content |
|---|---|
| `testnet/genesis.json` | the chain: id, signature scheme, genesis time, consensus settings, and the application genesis inline (a faucet with 10,000,000 tokens, one operator account per validator with 50,000, and the validators with a self-bond of 20,000 each) |
| `testnet/keystore.json` | an encrypted keystore holding the faucet key and the operator keys `op0`..`opN`, all of the chain's scheme, under the passphrase from `CHAIN_PASSPHRASE` (default `testnet`) |
| `testnet/nodeN/config.json` | one per node: name, p2p listen address, RPC address, seeds, the node key seed, and the validator (consensus) key seed |

Ports go up in steps of two from `basePort`: node 0 listens for peers on 26656 and serves RPC on
26657, node 1 on 26658 and 26659, and so on. `--scheme` fixes the signature scheme of every key
and signature on the chain, ML-DSA-44 when absent (section 6); every key `init` makes, in the
keystore and in the node directories, is of it. `--max-block-bytes` sets the chain's block size,
`consensus.maxBlockBytes` in the genesis (section 6): a whole number from 65,536 to 16,777,216.
Without the flag the genesis has no such field and the chain uses 4 MiB (4,194,304). The value is
checked before anything is written, so one outside the range makes no directory: `init` prints
`genesis: consensus.maxBlockBytes must be a whole number from 65536 to 16777216` and exits 1.

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
or `CROSSCHAIN_CHILD` is set, it runs in place instead. A `--max-old-space-size=0` is read as
no flag, which is what it means to V8, the last flag deciding as V8 has it: with a 0 in
`NODE_OPTIONS` or among `node`'s own arguments `start` wraps itself and sets its limit as usual
(the limit it passes to its child follows the arguments it was started with, and so decides). A
node that runs with no limit in effect takes its levels from the limit V8 chose. `--arena <MiB>` (a whole number, at
least 16) bounds the encoded objects the database keeps in memory outside the heap; without it
all of them are kept, and with it the rest are read from the store (section 12). The node then reads `config.json` and the `genesis.json` in the parent directory, opens
LMDB under `nodeN/data/lmdb` (the application state comes back from the store with its indices
and trees, every tree node, leaf and index entry checked against the objects, and with the
window of past heights from the history records, the line `loaded application state` saying
with `indexVersions=records` that the name trees' past versions were taken from them and
with `indexVersions=replay` that they were rebuilt from the accounts instead, and with `indexVersions=none` that the window was not read back because the state was opened paged; section 12), connects to the seeds, and serves
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
requests still open get a second (none at `critical`) before their connections are closed,
and the store is closed only after that, so a request that finishes in time reads a store
that is still open. A request whose connection was cut may still be running inside the node
(a `broadcastTx` waiting on the mempool, for one): the RPC server waits up to one second more
for those to end, and a request that arrives once the server is stopping is answered `-32000`,
`server is stopping`. A request that takes longer than that second is not cancelled, and the
store is closed without it; so is work of consensus or block sync that was waiting on a
signature verification or on a peer's answer when the node stopped. Such work ends when it
resumes, either at its own check that the node still runs or because the closed store answers
every call with the error `the store is closed`, and the store is not touched after it is
closed. A signature that was being verified on the node's verifier pool when the pool was closed ends with the error `verifier closed` instead. Work begun for a peer's message that ends in either way is logged as `handling a ... failed`, at `debug`, and so is a validator's own proposal, or one it held for the height, that was being verified at that moment; none of it is left as an error nobody handles, which would end the process before the stop was done. A log line with one of these errors during a stop is harmless (section 13). The network and block sync leave no timer of their own to fire after the stop: a dial still in progress is ended, a connection the node had refused and was about to close is closed at once, a handshake on a connection that has closed ends at its next step and does not wait for the 10-second handshake timeout, block sync sets no timer once it is stopped and its next backfill step is taken back, and so is the collection queued for the moment after the last commit. The status line stops as the shutdown begins, since it reads the application and the store is about to be closed. The claim on the data directory is given up last (section 5). If
something fails while the node stops, the line `stopping failed` is logged with the error,
the remaining steps are still carried out, the claim included, and the exit code is 1 unless
it was already another (3 stays 3).

A signal that comes before the node is ready, while it reads a large genesis or joins by state
sync, is acted on as soon as the node has been made: the store is closed and the claim given
up as on any stop. If the node has not been made five seconds after the signal the process exits
as it is, which is safe for the store and leaves a `LOCK` naming a process that is gone; the
next start takes it over (section 5). If the node cannot start, or its RPC server cannot,
most often because another process is listening on the RPC address, the line `start failed`
is logged with the error, the node is stopped like any other, so the store is closed and the
claim given up, and the process exits with code 1.
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
default); an amount with more decimals than the precision is refused. The exception is
`propose`: its values replace the parameters as `parameters` prints them, where fees and staking
amounts are in base units, so at precision 5 `staking.minSelfBond=10000` is 0.1 tokens and
10,000 tokens is `staking.minSelfBond=1000000000`. Validators are named by their operator
account.

| command | what it does |
|---|---|
| `init [dir=./testnet] [validators=4] [basePort=26656] [--scheme ml-dsa-44\|secp256k1] [--max-block-bytes <n>]` | writes a genesis, a keystore and one directory per validator, every key of the named scheme, ML-DSA-44 when absent; `--max-block-bytes` sets the chain's block size in the genesis, 65,536 to 16,777,216, 4 MiB when absent (section 3.1) |
| `start <nodeDir> [--heap <MiB>] [--arena <MiB>]` | runs a node with its RPC under a heap limit of three quarters of memory, or the given size in MiB (section 3.2); stops cleanly with exit code 3 when the heap nears the limit. `--arena` bounds the encoded objects kept in memory outside the heap (at least 16 MiB; all of them by default), the rest being read from the store (section 12) |
| `join <dir> <nodeN> <seedAddr> <trustHeight> <trustHash> [basePort=26700]` | writes a directory for a node that joins by state sync from a header the operator trusts (section 9); refuses to touch a directory that already has a `config.json` |
| `keys list` | names, schemes and addresses in the keystore (`--keystore <path>`, default `./keystore.json`, for every `keys` command) |
| `keys add <name> [--scheme ml-dsa-44\|secp256k1]` | generates a key under that name, of the given scheme (ML-DSA-44 when absent); it must be the chain's, which `status` reports |
| `keys import <name> <seedHex> [--scheme ml-dsa-44\|secp256k1]` | adds a key from a 32-byte seed, derived under the given scheme (ML-DSA-44 when absent) |
| `keys export <name>` | prints a key's seed |
| `keys remove <name>` | removes a key from the keystore and prints `removed <name> <address>`; the seed goes with the entry, so only an export made beforehand brings the key back. A name that is not there is refused with `no key named <name>` |
| `show <target>` | chain status, the active validators, and the first 50 accounts by name with their balances |
| `account <target> <name>` | the account, its balances and its validator, with the proof that the name maps to this account (or to none) verified by the light client; the command asks one height back, and the balances and the history count are those of that same height; the balances themselves are the node's answer, not proven |
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
| `propose <target> <operator> <path=value>...` | a validator proposes the live parameters with changes, e.g. `fees.transfer.fee=250 staking.maxValidators=9`; amounts are in base units, not whole tokens |
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
| `retain.blocks` | how many blocks behind the latest to keep (the latest and that many before it); unset keeps all. Blocks whose time is within the evidence window (the unbonding period) and the newest snapshot's height are kept whatever the setting, since evidence of double signing must still be checked against them. A pruned node answers `lowestHeight` in `status`; `block`, `commit`, `tx` and event replay stop there, while validator sets by hash, account history and the provable application versions are kept on their own terms. When a proposal lengthens the unbonding period the window grows at once, but blocks pruned under the shorter one are gone: until a full new period has passed, the node refuses evidence for those heights. Below its lowest block a node that joined by state sync keeps the headers alone that evidence may still name (section 9); they are pruned by the evidence window, not by this setting, a backfilled block replaces each, and `header` serves them |
| `retain.versions` | how many past heights stay provable, beyond the current one (default 100): the window for proofs at past heights and for the light client's queries. Under memory pressure the node keeps only the last two in memory until the heap has room again (section 12); the store keeps the whole window, and a proof or query at an older height in it is read from the store's history records, slower |
| `retain.memoryVersions` | how many of the `retain.versions` past heights are kept in memory; unset keeps all of them until memory fills. The store keeps the whole window either way, so every height in `retain.versions` stays provable: a proof or query at a height older than the ones in memory is read from the store's history records, 0.1 to 0.35 ms per height back against a tenth of a millisecond or less from memory. For a node with a large heap, which never reaches `warn` and would otherwise keep the whole window in its heap (section 12). What a short window buys is memory and pause length: measured at 514,000 accounts under twice the resident heap, two versions in memory instead of a hundred took about 500 to 700 MiB off the heap (1,057 to 1,141 MiB at the highest report against 1,603 to 1,767) and the longest collection pause from 202 to 237 ms down to 127 to 178 ms. What it costs is slower proofs at past heights, 13 to 33 ms fifty and a hundred heights back instead of a small fraction of a millisecond. Throughput was not shown to depend on it. When the node has trimmed the window under memory pressure and restores it, it restores it to this setting |
| `indexTrees` | where the application's secondary indices (an account by name, scans) are read from: `store` (the default) or `memory`. With `store` the node never builds their B+ trees: index reads go to LMDB from the start, and the guard has no index trees to drop or rebuild. With `memory` it keeps them in its heap while they fit, drops them at `warn` and rebuilds them once the heap has had room for long enough (section 12). Keep `store` unless the node mostly serves scans. Measured at 192,000 accounts under four times the resident heap, the node with `store` committed 13% more (1,559 transfers a second against 1,385, the means of three runs each) and opened with 262 MiB of heap in use instead of 402, a third less; a lookup by key took 4 to 7 microseconds at the median either way and a page of twenty accounts in name order 31 to 34 from the store against 17 to 18 from memory, with a longer tail from the store. Proofs and the Merkle trees are unaffected |
| `retain.snapshots` | how many state snapshots to keep (default 2, never fewer than 1) |
| `snapshotInterval` | export a state snapshot every this many blocks (default 1000; `0` disables), in chunks of 2,000 objects. Peers need snapshots to serve state sync |

Consensus timeouts and limits are not in `config.json`: a node started by the CLI runs with the
defaults (propose 3 s plus 500 ms per round, prevote and precommit 1 s plus 500 ms per round, a
1 s pause after each commit, votes re-sent every 500 ms while a round is open, 15 s of tolerated
clock drift on a fresh proposal, at most 16 pieces of evidence in a block,
rounds more than 1,000 ahead ignored). The timeouts, the clock drift
and the evidence age are `timeouts` and `limits` options of `Node` for a program that embeds
one. The 16 pieces of evidence and the 1,000 rounds are constants of the engine. The 16 is a
rule of the chain: a proposer takes no more from its pool, and every node refuses a block that
carries more (`too much evidence`). The block size is a rule of the chain too, and it is in
`genesis.json` (`consensus.maxBlockBytes`, below; 4 MiB when the file names none): a node takes
it from there and from nowhere else, so every node of a chain holds the same figure. It bounds
what a proposer chooses, the transactions and the evidence of a block; the header and the last
commit are not counted, so an empty block is within it whatever the validator set. A validator
set holds at most 2,000 members, a constant of the engine: a block with the largest size a
genesis may set and two commits of that many signatures still fits one network frame. The
clock drift is each node's own: it is applied only to a fresh proposal when the node decides
its prevote, never to a block being committed or synced, so nodes that differ in it still
agree on every block.

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
holds the pid of the process using the directory. A second node started on the same directory
while that process runs is refused, until the first has stopped: the node removes the
file as the last step of its own shutdown, after it has closed the network, let the block
being applied finish its writes and closed the LMDB environment, and also when it fails while
starting. `start` hands its node the directory alone: the node claims it and then opens the
environment, so a second `start` on a directory in use is refused before it has opened
anything there. The RPC server is stopped before the environment is closed, so the file never
goes while the store is open, and a request that ends within the server's one-second wait is
answered from an open store; one that takes longer is answered with an error by the closed
store and reads nothing. The file appears with the pid already
in it: the node writes the pid to a file of its own, `LOCK.<pid>.<8 hex digits>`, links it to
`LOCK` with a hard link, which fails when a `LOCK` is there, and removes its own file. So
of two nodes started at the same moment one gets the directory and the other is refused, and
the data directory has to be on a filesystem that has hard links. A
`LOCK` left by a process that no longer runs (a crash, a `kill -9`) is taken over at the next
start without anything to do by hand, and of two processes that find the same stale file at
the same instant only one gets the directory: a stale `LOCK` is removed only by a process
holding a second file, `LOCK.takeover`, which it creates exclusively and removes a few file
operations later. A process killed in that short span leaves `LOCK.takeover` behind, and the
next start on the directory gives up after 50 attempts, about a second, naming the file; check
that no node runs on the directory and remove the file. A process killed between writing its
own `LOCK.<pid>.<hex>` file and removing it leaves that file behind; it is harmless and can be
deleted. The claim trusts the pid, so a `LOCK` whose pid has since been given to an
unrelated process reads as in use until that process exits or the file is removed. Two nodes in one process are told apart by the directory's real path, however
it is spelled or linked to. `peers.json` is written beside itself and renamed into place, and
a file that cannot be read (cut short by a crash of an earlier build, or edited by hand into
something that is not a list) is taken as empty: the node starts from its `seeds` and writes
a fresh one. Back a node up by copying `data` while the node is stopped.

## 6. Genesis

`genesis.json`:

```json
{
  "chainId": "chain-1a2b3c4d",
  "signatureScheme": "ml-dsa-44",
  "genesisTime": "1761600000000",
  "validators": [{ "publicKey": "<hex>", "power": "10", "name": "v0" }],
  "consensus": { "maxEvidenceAgeMs": "604800000", "version": 2 },
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
| `consensus.version` | the protocol version every header must carry: 2, which `init` writes and which is the default when absent, or 1. Under version 2 every header commits to the proposer priorities of its validator sets, so a node joining from a snapshot can check the sets it is given exactly; a version 1 chain's headers have no such field, and a genesis that names 1 keeps running as it did. Any other value is refused when a node first starts on the file (`genesis asks for protocol version 3; this node runs 1 and 2`). It cannot change after genesis. A genesis file written by hand before version 2 existed, with no `version` field, meant 1: a data directory already started from it keeps running (the version is in its stored chain state), but a new node given that file would start under version 2 and refuse the chain's blocks (`protocol version 1, expected 2`), so add `"version": 1` to such a file. Files written by `init` always named the version |
| `consensus.maxBlockBytes` | the most bytes the transactions and evidence of a block may encode to (its header and last commit are not counted, so a whole block is that much larger): a whole number from 65,536 to 16,777,216, written as a JSON number; 4 MiB (4,194,304) when absent. `init` writes the field when it is given `--max-block-bytes` and leaves it out otherwise (section 3.1). Any other value is refused when the file is read (`genesis: consensus.maxBlockBytes must be a whole number from 65536 to 16777216`). Every node holds a block over it invalid (`block too large`), whether proposed, committed or synced, so set it before the chain starts and keep the file the same on every node. The mempool's limit on one transaction follows it: 1 MiB, or four bytes under half the block size where that is less. A proposer gives evidence at most half the limit, so an admitted transaction always fits the next block it is first in line for |
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
accounts loads in about 18 seconds (see [benchmarks.md](benchmarks.md)).

## 7. Keys and signing

The keystore (`keystore.json`) holds named 32-byte seeds encrypted with a key derived from the
passphrase by scrypt, under AES-256-GCM, each with the scheme its key pair is derived under;
`keys list` prints it beside the name. The file has a version: version 2 names the scheme of
every key, and a version 1 file, written before, in which a key may name none, reads as
ML-DSA-44 for such a key. Reading leaves a version 1 file as it is; the next `keys add`,
`keys import`, `keys remove` or `create` writes it as version 2 with every scheme filled in. A
key of a version 2 file that names no scheme is refused as damaged, and a file of any other
version with `unsupported keystore`. The file is written atomically. The CLI opens it for any
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

A transaction holds at most 64 operations and 16 signatures; a node's mempool refuses one over
1 MiB (or over four bytes under half the chain's block size, where `consensus.maxBlockBytes` in the
genesis makes that less), queues 10,000 of them and remembers the last 100,000 hashes it has seen. That limit is the
mempool's admission rule, not a rule of block validation: a larger transaction in a block that a
proposer built some other way is executed like any other, within the block size, which every
node holds alike. Over the RPC,
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
| `status` | | chain id, protocol version, `signatureScheme` (`ml-dsa-44` or `secp256k1`), latest height, hash, time and app hash, `catchingUp`, `lowestHeight` kept, `joinedAt` (state sync; forgotten at a restart), peer count, this node's validator address, `memory` (`level`, `shedding`, and in bytes `heapUsed`, `heapLimit`, `heapTotal`, `arrayBuffers`, `external`, `rss` and, under a heap limit as `start` sets one, `heapOld`, the old generation's use, which is the figure the level is taken from; and `database`, the object database's own figures: `arena` with its `slabs` and, in bytes, their `capacity`, the `used` bytes written into them and the `dead` ones among those; `arenaLimit`, the most bytes the slabs may take (`start --arena`), `null` while unbounded, and `storedObjects`, how many objects have their bytes only in the store because of it; `objects`, `resident` while every decoded object is kept or `capped` under the guard's cap, with `hotObjects` and `hotLimit` for the decoded objects cached and the cap, `null` while unbounded; `historyBytes` for the past values the provable window keeps; `history`, `resident` while the whole window of past versions is kept in memory or `trimmed` while the guard has cut it, with `historyWindow`, how many past versions are kept in memory just now, and `lowestVersion`, the oldest height that can be proven, which trimming does not change because older heights are read from the store's history records; `indexTrees`, `resident`, `dropped` or `partial` (dropped for some types; `dropped` from the start unless `indexTrees` in `config.json` is `memory`), and `trees`, `resident` or `dropped`, for the secondary indices' B+ trees and the Merkle trees; `treeChunks` and `treeChunkLimit` for the dense tree chunks cached while the trees are dropped and how many may be (4,096); and `hotHits`, `hotMisses`, `chunkHits` and `chunkMisses`, the reads the decoded-object cache and the chunk cache answered and the reads that went to the arena or the store, from which the hit rates follow; `database` is `null` for an application other than the core one), `gc` (`available`; the collections V8 ran since start as `collections`, `minor`, `major`, `incremental`, their pauses as `totalMs`, `maxMs`, `lastMs`; the `scheduledMinor` and `scheduledMajor` ones the node asked for), `rpcVersion` | |
| `genesis` | | the genesis document (without any application state file path) | |
| `header` | `height?` | the header; below the lowest block, one the node keeps alone when it has it (section 9) | |
| `block` | `height?` | header, transactions (hex), last commit, evidence, commit | yes |
| `commit` | `height?` | the commit (precommit signatures) for a height | |
| `validators` | `height?` | the validator set that signs that height: its hash, total power, members with their powers, and a proposer (proposer priorities are not included). That is the proposer of the height's first round, for the latest height, the two after it and every older height whose set the node still holds by height: the heights it applied itself, and the one whose snapshot it joined at, while their blocks are not pruned. For a block backfilled below a state-sync join, or a header kept alone, the set is read by its hash: the members and powers are that height's, and `proposer` is `null`, because the copy stored under the hash carries a later height's proposer | |
| `validatorSet` | `hash` | a set by its hash, for light clients following set changes | |
| `object` | `id`, `height?`, `prove?` | any object by id as JSON, with an object proof on request | yes |
| `key` | `type`, `index`, `key`, `height?`, `prove?` | a lookup in an authenticated unique index (`account`/`byName`, `asset`/`bySymbol`, ...) as of the height, with a key proof; the id is the one the proof proves | yes |
| `account` | `name`, `height?`, `prove?` | account, balances (each with its asset's precision), its validator, history count, all as of the height, and a proof that the name maps to this account or to none | yes |
| `validator` | `operator` or `id`, `height?` | the validator with status, power, self-bond and operator name as of the height; `delegators`, the count of its delegations as of the height | yes |
| `delegation` | `delegator`, `validator`, `height?`, `prove?` | the delegation (shares and their token value as of the height), with a key proof; `unbonding`, the entries pending as of the height | yes |
| `balance` | `account`, `asset?`, `height?` | one balance as of the height | yes |
| `accountHistory` | `account`, `from?`, `limit?` (default 20, max 100), `reverse?` | the account's id, the `total` of its entries, and history entries with sequence numbers, oldest first from sequence `from`; with `reverse`, newest first, and `from` counts entries back from the newest | yes |
| `tx` | `hash`, `prove?` | where the transaction landed (the block it succeeded in if there is one, else the newest that carries it), its result, the decoded operations, and inclusion and result proofs; `attempts`, the height, position and result in every block still held that carries it, oldest first, when there is more than one. The lookup by hash costs a read or two for each segment of the index that holds something, and the index keeps those to a few dozen a level by moving entries into larger segments behind the latest block (0.11 ms over 20,000 blocks of 500 transactions in a probe), so it does not grow with the blocks kept | yes |
| `broadcastTx` | `tx` (hex), `mode?` (`sync`, the default, or `commit`), `timeoutMs?` (default 30,000, at most 120,000) | `sync`: the mempool's verdict, `added` or `seen`; `commit`: waits for inclusion and returns height, position and result; `-32004` when the mempool is full at a limit lowered because memory is short | yes |
| `accounts` | `limit?` (default 50, max 200), `after?` | accounts by name with their core balance, paged by name; `after` is the last name of the previous page and is not repeated | yes |
| `parameters` | | the height, the core asset, `maxTxExpirationMs`, the fee schedule and the staking parameters in force | |
| `proposals` | | open parameter proposals with the full parameters each would adopt | yes |
| `mempool` | | count, bytes and the first hundred hashes | |
| `peers` | | connected peers with addresses, direction, height, latency and `clockOffsetMs`: how far the peer's clock is ahead of this node's in milliseconds (negative when behind), from its last pong, `null` before the first. It is what the peer claims, good for noticing a wrong clock and nothing more | |
| `snapshots` | | reserved: an empty list (snapshot heights are exchanged between peers, not over the RPC) | |

`account` takes a name; the account parameters of `balance`, `accountHistory` and `delegation`
take a name or an id (`3.n`); a validator is named by its operator, as a name or as the
operator's account id (`3.n`), or by its own id (`7.n`), in `validator.operator`,
`validator.id` and `delegation.validator` alike; an account that runs no validator answers
`-32001`, `<ref> runs no validator`. Every state query (`object`, `key`,
`account`, `validator`, `delegation`, `balance`) answers as of one height, the one in `height` or
the last committed one, and returns that `height`, so a value and the proof beside it are about
the same state. A height outside what the node holds (`memory.database.lowestVersion` in `status`
to the latest) is refused with `-32001`, `the state at height H is not kept (heights A to B are)`.
An account's balances at a past height are the balances it has now, each read as it was then; a
name that cannot be an index key (one holding a zero byte) gives `account: null`, and with
`prove` a `-32602` error, since there is nothing to prove; any other name no account has,
allowed as an account name or not, gives `account: null` and with `prove` a proof of absence. `balance` by a name that had no account at the height answers `-32001`, and by
id 0. `validator`'s `delegators` and `delegation`'s `unbonding` are answered for any height the
node holds, although a delegation is removed when its last share goes and an unbonding entry when
it matures: at a past height the node also looks at every delegation or entry changed or removed
since and reads each as it was then, so such a query costs more the further back it asks.

The `seen` verdict of `broadcastTx` means the node has the hash in its pool or in its recent
cache, which includes transactions it rejected; it does not mean the transaction is pending or included. In
commit mode a transaction seen before that is neither pending nor committed is refused at once
with `-32002`, and a timeout does not remove a pending transaction from the mempool. At most
1,000 commit waits are held at a time; beyond that the call answers `-32004` and the client
should broadcast in sync mode and poll `tx`. A call in commit mode whose transaction the
mempool has seen before and no longer holds looks the hash up among the blocks, in case it is
already in one, at the cost the `tx` row gives. One
whose transaction was just admitted, or is still pending, waits for the block that carries it
and looks nothing up, so a transaction that failed in an earlier block and is admitted again
is answered with the new attempt. While the mempool still remembers its hash it is not admitted
again: the answer is `seen`, and the call returns the earlier failure.

Errors carry JSON-RPC codes: `-32700` unparsable body, `-32600` malformed request (also a batch
outside 1 to 20 requests; a malformed request is answered with its own id when that is a string, a number or null, and with `id: null` otherwise), `-32601` unknown method (a name every JavaScript object inherits, such as `toString`, included), `-32602` bad parameters, `-32001` not found (including a `height`
whose state the node does not hold), `-32002` the mempool refused
the transaction (the message says why), `-32003` not included before the timeout, `-32004` rate
limited, `-32000` with `server is stopping` when the request reached a node that is shutting down.

While the node sheds load under memory pressure (section 12), every costly method but
`broadcastTx` answers `-32004` with `node under memory pressure` before the extra tokens of a
costly call are taken (the one token of the request, or of a further call in a batch, is taken
first), and `GET /events` answers HTTP 503; the cheap methods, `/health` and the streams
already open keep working, and everything resumes once the heap eases. `broadcastTx` is still
served, because the mempool's limit is what throttles it then: from the guard's `warn` level
the mempool admits up to a lowered limit (section 12), and a `broadcastTx` that
finds it full at that limit answers `-32004` with `mempool full: its limit is lowered while the
node is short of memory` rather than `-32002`: the transaction is not at fault, and the client
tries again later. At `critical` the mempool is paused and `broadcastTx` answers `-32004` with
`node out of memory`.

Limits per client address: a token bucket of 100 refilled at 50 a second. Every `POST` of
JSON-RPC spends one token, which pays for its first call, and is refused with HTTP 429 when it
cannot (`GET /health` and an event stream opened without replay spend none; a replay spends
five, section 8.1);
each further call of a batch spends one more, and each costly method 4 more, a call that cannot
pay being answered with a `-32004` error in its place inside the HTTP 200 response. A batch of up
to 20 requests therefore costs one token per call plus 4 per costly call, what its calls would
have cost one by one, and its requests run one after another. Request
bodies up to 1 MiB; 8 event streams. `RpcServer` takes other values; the defaults are for a
public endpoint.

### 8.1 Event streams

`GET /events?types=block,tx,account,validatorSet` is a server-sent event stream. Each event has
the block height as its id. `types` left out means `block`; a type that is not one of the four is
refused with HTTP 400, and an `account` that does not exist, by name or by id, with 404:

| event | when | data |
|---|---|---|
| `block` | every committed block | height, hash, time, transaction count, failures, app hash, proposer |
| `tx` | every transaction in a block; `tx=<hash>` narrows to one | hash, height, index, ok, error |
| `account` | every history entry of one account, with `account=<name or id>` | the entry |
| `validatorSet` | when the set changes | the updates |

A client that reconnects sends `Last-Event-ID: <height>` and receives the blocks after it, from
within the last 1,000; the replay costs as much as a costly call and is refused with 429 when the
client cannot afford it, rather than opening a stream with a gap. Only `block` events are replayed,
with the fields of a live one, and the replay stops at a block the node has pruned. In the replay of
a block whose results the node does not hold, one it fetched by backfill after a state sync,
the count of failures (`failed`) is `null` if the block has transactions and 0 if it has none. A stream whose client has stopped reading is closed once a megabyte of events is
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
offer, or else the newest offered, among those the trusted header can vouch for: the header
after the snapshot must not be older than the trusted header, so a snapshot at height H needs a
trusted height of H + 1 or lower, and a snapshot below that is not considered. So trust a
header from before the newest snapshot. The headers let the node check evidence for heights
before its join as any other node does; it keeps them until the evidence window moves past them.
With `backfill` (on by default) it then fetches the blocks before the snapshot in the background,
newest first, checking each against the hash chain, down to genesis or to the floor
`retain.blocks` sets, each replacing the header it kept alone for that height.
Peers serve a snapshot only if they export them (`snapshotInterval`), so a chain of nodes with
`snapshotInterval: 0` cannot be joined this way. If no peer connects within 30 seconds, or none
offers a snapshot, or every snapshot offered is from before the trusted height, the node logs
it and replays from genesis instead; a snapshot for which no
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
   restarts never signs two different proposals or votes for one height, round and step, nor
   anything for a step behind the last it signed, because the sign state file remembers the
   last signature; asked for the same one again, it gives the signature it made.

5. Validators change the chain's parameters by proposal: `propose` with the changes, `signal`
   from the others; more than two thirds of active stake adopts at the end of the block. Fees and
   staking parameters travel together, as in [FEES.md](../FEES.md) section 4.

## 11. The light client

The light client follows the chain from a trusted header by verifying commits, bisecting through
validator set changes, and never trusting a header older than the trusting period (4 days by
default, below the unbonding period). The CLI keeps its anchor in `light.json` next to the
keystore, with the chain id it belongs to (`{ chainId, height, hash }`). An anchor of another
chain than the node's is refused, exit code 1, with `<path>/light.json holds a trusted header of
chain X, and this node is on chain Y; use the keystore directory of that chain, or set a new
anchor with: light <target> trust <height> <hash>`; a `light.json` written before the chain id
was kept is accepted and written back with it, and `light trust` overwrites the file. `account` and `verify-tx` use it to check proofs: an account's name proof is verified
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
the node holds, before or after the anchor. A height of which a state-synced node keeps the
header alone has no block and no index entry, so the transaction is not found there. A block
the node did not execute itself (one fetched by backfill, or the block at the snapshot height)
has no stored results: the inclusion is proven and the result is not, and the CLI prints
`included at height H; this node does not hold the results of that block`; ask a node that
executed the block. `included at height H; result not yet committed` is printed only while the
next block does not exist yet, and the result proof follows with it. What `account` proves is the mapping
from the name to the account id, or its absence; the balances and the rest of the account are the
node's answer, unproven.

## 12. Operating notes

- **Disk.** A full block holds 4 MiB of transactions and evidence by default
  (`consensus.maxBlockBytes`, section 6), with its header and last commit beside them, a
  transfer in it 2.5 KiB under ML-DSA-44 or 154 bytes under secp256k1; the state, with its index entries, chunks and nodes stored beside the
  objects, is about the size of an ML-DSA-44 genesis (a gigabyte becomes 958 MiB of LMDB) and
  about four times a secp256k1 one (213 MiB for the 56 MB genesis of the same accounts); a
  snapshot adds the objects again while it is kept (506 MiB and 34 MiB). `retain.blocks` prunes
  blocks outside the evidence window, and the headers a state-synced node keeps alone go as the
  window moves on; snapshots are kept to `retain.snapshots`. A validator set stored by height
  goes with the block of its height (in a store pruned by an earlier build the ones below the
  lowest block stay). A validator set stored by hash goes once the heights that carried its
  hash are pruned and neither a header still held nor the chain state (the sets of the last,
  the current and the next height) names it. Account history is never pruned and grows
  with use. The application store holds, beside the objects,
  every secondary index entry and the Merkle trees' chunks and nodes, written in the same
  transaction as the objects they belong to, which is what lets the node page them (below):
  at 192,000 secp256k1 accounts the genesis store is 213 MiB where the objects alone were
  34.6, about 1.2 KB an account in all (docs/benchmarks.md sections 4.11 and 4.12), and a block
  scattered over the whole state rewrites about 12 MiB of chunks. A store written before they
  existed has no entries or chunks; the first open computes them from the objects, as a
  restart always did, writes them once, and from then on the node restarts from them.
- **Memory.** With memory to spare the whole state stays in memory: about 1.0 GB per gigabyte
  of ML-DSA-44 genesis after a restart and 1.6 GB in the process that built it, plus the version history (changed objects times the retention window) and,
  during a state sync join, two more copies. `start` runs the node under a heap limit of three
  quarters of physical memory (`--heap <MiB>` sets another; section 3.2), since V8's own default
  is a few gigabytes whatever the machine has, and a state that outgrows the limit aborts the
  process; as the heap fills the memory guard (next bullet) pages the state to the store.
  Per account with its balance and two keys the measured resident cost is 5.2 KB under
  ML-DSA-44 and 2.6 KB under secp256k1 after a restart, 8.9 KB and 3.8 KB after building from
  genesis (docs/benchmarks.md section 7): the keys account for
  the difference, the object database's own objects, indices and trees for the rest (about
  2.1 KB of heap after a restart and 3.2 to 3.3 KB after building, of which, when an earlier
  build divided it, the decoded objects were 0.55 KB and the indices, the name tree and the
  Merkle trees the other 2.65 KB), so ten million accounts need 14 to 21 GB of heap under
  either scheme to run with their Merkle trees in memory; with everything the guard can drop
  dropped the database ran on 57% of its resident heap (40 to 50% in an earlier build's run on
  a state with no history yet). On disk the same accounts are 5.2 KB and 1.2 KB each; they were
  3.3 KB and 190 bytes before the index entries, chunks and nodes were stored, which add about
  1.9 KB and 1 KB an account.
- **The memory guard.** The node samples its heap every second and holds a level by how full
  it is (the old generation's use against its limit; below); each level turns the object database's dials (STATE-PAGING.md section 7), so a
  filling heap trades speed for room before anything is refused. `ok`: the database keeps
  every object it has decoded and its Merkle trees resident, and its index trees too if `indexTrees`
  in `config.json` is `memory`; by default they are never built, every lookup and scan reads the
  store, and what follows about dropping and rebuilding them does not apply. `warn`, at 70% of the
  limit (`memory: heap filling`): a major collection is started and the database's cache of
  decoded objects is capped at 100,000, the rest evicted at once; an object evicted and read
  again is decoded afresh from the arena of encoded bytes, about a microsecond for an account;
  the secondary indices' B+ trees, on a node that has them, are dropped, every lookup becoming one LMDB read and every
  scan an LMDB cursor merged with the writes of the block in progress; the window of past
  versions kept in memory is cut to the last two (below);
  and the mempool admits up to half its limit, 5,000 transactions, and refuses what arrives
  while it holds that many. No RPC method or event stream is refused at
  `warn`: a block of transfers looks its balances up by an index, which the store answers, and reads no past version, and a loaded
  node commits about a tenth more with its index trees in the store than in its heap and no
  less with the window there.
  `pressure`, at 85% (`memory: shedding load`): the cache is capped at 10,000; the Merkle trees are dropped as well,
  every root and proof reading its paths from the chunks and nodes in the store through a
  cache of 4,096 chunks (at most 128 MiB of buffers, outside the heap, enough to hold the
  dense trees of about two million objects whole); and the mempool admits up to a tenth of its limit, 1,000 transactions, costly RPC
  methods (all but `broadcastTx`, which the mempool's limit throttles) and new event streams are refused, and the signature
  cache is dropped, while consensus and block sync go on with whatever is pooled, so a
  validator keeps voting and a full node keeps following, now through the store. `critical`,
  at 95% (`memory: heap at the limit; stopping before the process aborts`): the mempool is
  paused and the CLI stops the
  node cleanly, the node and its RPC server together, then the store and the verifier, and exits with code 3, so a
  supervisor restarts it with a larger heap instead of finding a process V8 aborted. The
  guard only compares a sample of the heap with the threshold: it does not know what filled
  the heap, one sample can go from `ok` straight to `critical`, and a heap that fills between
  two samples, a second apart, still aborts the process. A level is left only once the heap
  is 5 points below the threshold it was entered at (`memory: easing`), so a heap hovering at
  a threshold does not flap, and one sample may cross several levels. Back at `ok` the cap is
  lifted at once, but the trees are rebuilt only when they fit: dropping them frees so much
  (181 MiB for the index trees and 223 MiB for the Merkle trees at 192,000
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
  Measured at 192,000 accounts under load, a proof takes 0.1 to 0.35 ms per height back, 9 to 36 ms at the oldest of a hundred, against a tenth of a millisecond or less from memory (docs/benchmarks.md section 4.13). Every height in
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
  with the whole window in memory the node committed 1,335 and 1,402 transfers a second
  on a heap that reached 1,603 and 1,767 MiB at its reports with a longest collection pause
  of 202 and 237 ms; with two versions, 1,246 and 1,348 on a heap that reached 1,141 and
  1,057 MiB with a longest pause of 127 and 178 ms. Throughput is not shown to depend on the
  window: the two runs of each setting differ by as much as the settings do. A short window
  saves about 500 to 700 MiB at that size and shortens the pauses, and a proof fifty or a
  hundred heights back takes 13 to 33 ms instead of a small fraction of a millisecond. Whether the index trees are in memory at all is a setting
  as well: `indexTrees` in `config.json`, `store` by default. With `store` the node never
  builds them, reads every index from LMDB as a node with `memory` does after a drop, and does not count
  them among what it waits to rebuild, so `status` shows `indexTrees: dropped` from the start and for good.
  With `memory` it starts with them resident when they fit, drops them at `warn` and
  rebuilds them after the wait, as described above. Keep `store` unless the node mostly
  serves scans (pages of accounts in name order and the like). Measured at 192,000 accounts
  under a heap of 1,488 MiB, 2.5 times the resident heap, for ten minutes: with `memory` the
  node opened with 398 MiB of heap in use, committed 1,522 transfers a second in 1,828
  blocks and reached `warn` twice, with a longest collection pause of 140 ms; with `store`
  it opened with 258 MiB, a third less, committed 1,508 a second in 1,758 blocks and
  reached `warn` once, at 39 s, from the history window and the cache, with a longest
  pause of 136 ms. Over the whole run the two rates are within 1%, less than two runs
  differ by; the `memory` run's own stretches show the cost of the trees (below). After that
  one `warn` the node with `store` has nothing to rebuild but the window. What `store` gives up is
  index reads from memory, and that is little: with 200 reads a second of each kind asked
  for while the node commits, a lookup by key (an account by name, a balance) takes 4 to 7
  microseconds at the median with either setting, and a page of twenty accounts in name order
  takes 31 to 34 microseconds from the store against 17 to 18 from memory, with a longer tail
  (a 99th percentile of 569 and 1,588 microseconds against 43 and 76); the runs with `store`
  committed 13% more. A store none of which was in the operating system's page cache when the node
  opened it read the same from the first seconds, because the node reads its whole store
  when it opens (the open took 3,661 ms, inside the range of the warm opens, 3,359 to 4,179
  ms). A read that does reach the
  disk, measured on a 576 MiB store read cold without a node, takes of the order of 140 to 320
  microseconds for a lookup that missed (one median and the 99th percentiles of the cold
  reads) against 1 to 3 from the page cache; a node under load on a machine whose
  memory the store exceeds was not measured. Proofs and the Merkle trees are unaffected. What paging costs (docs/benchmarks.md sections 4.10 to 4.13): with
  the cache capped a block of transfers among random accounts took about twice as long on an
  empty cache when the cap was first measured, and is no slower than resident in the mode
  table of the current runs (10.5 against 9.3 blocks a second of 500 transfers); the
  index trees dropped cost a block of transfers nothing (a lookup through LMDB costs about
  what a resident one does, a scan five to nine times as much, still under a microsecond an
  entry); the Merkle trees dropped as well cost about a seventh against the index trees alone
  dropped, and nothing against the resident mode, now that their chunk cache
  holds every chunk (10.0 against 11.6 and 9.3 blocks a second; with a cache of 256
  chunks it was 7.7 against 9.4), the first root after a drop reading its chunks from LMDB
  (a root over 1,000 changes 54 ms against 27 on average, 29 against 20 at the median) and a name proof
  costing five times as much; and with everything dropped the database runs
  on 57% of its resident heap (40 to 50% in an earlier build's run on a state with no history
  yet). What the guard buys is a node that keeps committing at
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
  decides beforehand: it takes half the heap limit less the old generation's heap in use as the room, and
  estimates the index trees and the Merkle trees from the object counts in the store (210
  bytes per index entry, 2,000 per name-tree leaf). If the index trees do not fit they are
  left in the store, then the Merkle trees if they do not fit what remains. When either is left
  out the history window is not read back either, because reading it takes more heap than the
  trees: the node starts with no window in memory, which fills again a block at a time. The
  records stay in the store until they age out, and the heights before the one the node
  opened at are proven from them as under a cut window, so `lowestVersion` is what it would
  have been. The line
  `loaded application state` then carries `paged=indexTrees, trees, history`, naming what was
  left out, and the trees are rebuilt later if room appears, as after a drop (`indexTrees`
  is named only on a node with `indexTrees: memory`; by default they are in the store by
  choice and are not listed). Measured on the defaults
  (docs/benchmarks.md section 4.13), a 192,000-account state that takes 596 MiB resident
  opened and ran under a `--heap` of a quarter of that (149 MiB: every tier left in the
  store, 34 MiB of heap after opening, 1,211 transfers a second for a minute without reaching
  `pressure`), and at the resident figure or 0.8 times
  it committed 1,610 and 1,567 transfers a second for ten minutes with nothing refused after
  the first two seconds and no visit to `pressure`. A `--heap` below the resident state
  costs a loaded node no throughput: at 192,000 accounts it committed 1,589 to 1,644
  transfers a second over forty seconds in the matrix's single runs at every limit from 0.8 to 2.0 times its resident
  heap, a spread of 3.5%, less than two runs of one limit differ by. What it costs is the reads that go through the store,
  scans, name proofs and proofs at heights the trimmed window no longer holds. What the
  `warn` level is for is the slow stretch of a long run. While the index trees were dropped
  only at `pressure`, under a sustained full load
  the rate fell by a third over the first minutes, while the index trees were resident and
  the heap climbed towards the pressure line (each transfer adds two entries to them, and
  collections took 7 to 12% of the time), and returned to 1,330 to 1,560 transfers a second,
  level, once they were dropped; by default they are now never built, on a node that has them
  they are dropped at `warn`, with the history window,
  and the same ten-minute run on the defaults holds 1,502 to 1,789 transfers a second in
  every window of twenty seconds, at `ok` but for half a second at `warn` every two minutes
  or so. Under a
  heap of 2.5 times the resident state the same run with `indexTrees: memory` shows the wait
  before a rebuild: the
  index trees were dropped at `warn` 32 seconds in and rebuilt 29 seconds later, dropped
  again at 211 seconds and, after a wait as long as the node had run since the rebuild,
  left in the store for want of room. The node committed 1,342 to 1,437 transfers a
  second while they were resident after the rebuild and 1,488 to 1,667 after the second
  drop: resident index
  trees cost such a load about a tenth, and in return index reads (accounts by name,
  scans) are served from memory. That tenth is why the default is `store`.
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
  only in the store (`arenaLimit`, `storedObjects`). Without `--arena` nothing is released. Measured on a 192,000-account secp256k1 state (docs/benchmarks.md section 4.13), a budget of 32 MiB cost no throughput (1,692 transfers a second against 1,694 without one) and one of 16 MiB read 7% lower (1,577), which is inside what two runs differ by, and 16 MiB, a quarter of what the arena otherwise grew to, saved 48 MiB of array buffers; it matters more for an ML-DSA-44 state, whose keys are most of the arena.
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
| `missing <argument>` | the command's arguments are positional, and one given as an empty string counts as missing; see section 4 |
| `usage: see the comment at the top of src/cli.ts`, exit code 1 | no command, or one the CLI does not know, whatever follows it; a known command without its target says `missing target` |
| the keystore refuses to open | wrong passphrase; `CHAIN_PASSPHRASE` or `--passphrase-file` must match the one `init` printed |
| `dial failed` in the log under `LOG=debug`, with `err=connect ECONNREFUSED ...` | a seed is not running yet; the node keeps dialling and starts once it has peers |
| no blocks, round numbers climbing in `status` | two thirds or less of the voting power is online; more than two thirds is needed |
| `rate limited` (`-32004`) | the client exceeded the token bucket: a JSON-RPC request spends one token, each further call of a batch one more and each costly call four more, from 100 refilled at 50 a second |
| `peer clock differs from this node` in the log, with `offsetMs` | a peer's clock, as its pong states it, is 2 seconds or more from this node's (`clockOffsetMs` in `peers`). The line comes when a peer is first seen to be that far off, and again only after its offset has been below 2 seconds in between. The offset is what the peer claims. A node tolerates 15 s of clock drift on a fresh proposal (section 5), so a clock that is off should be set right before it reaches that |
| `node under memory pressure` (`-32004`), or HTTP 503 from `/events` | the node is shedding load at the guard's `pressure` level (section 12): costly calls other than `broadcastTx` and new event streams are refused until the heap eases; cheap calls and `/health`, which reports the level, still answer, and `broadcastTx` is admitted up to the mempool's lowered limit |
| `mempool full: its limit is lowered while the node is short of memory` (`-32004`) | the heap is at `warn` or above and the mempool already holds as many transactions as it admits at that level (half its limit at `warn`). Nothing is wrong with the transaction: send it again once blocks have taken some out |
| `... is not available: the record of version N was written without the sparse tree nodes`, for a height inside `retain.versions` | the history window in memory was trimmed at `warn` or above (`status` shows `history: trimmed`), is kept short by `retain.memoryVersions`, or the store was opened paged without it, so the height is read from the store's history records, and the record named was written by an earlier build that did not keep what a proof of an account or a name needs. Such records age out after `retain.versions` blocks; a restart with enough heap reads the whole window into memory and proves the height at once |
| `... is not available: the store has no history record of version V`, or after a restart a `provableFrom` in the line `loaded application state` (`lowestVersion` in `status`) higher than `retain.versions` gives | the store has lost a history record (a damaged store). A height whose proof would need the missing record is refused, since answering from the records that are left would give a wrong proof. At the next start the node uses only the records that are unbroken up to the current height: the heights below the gap are not provable, their records are deleted with the next commit, and the window fills again as blocks are applied |
| a proof or query at a past height is slow | the same situation with current records: heights older than the window in memory (`historyWindow` in `status`) are read from the store's history records (section 12). The window grows back a block at a time once the heap has room (`memory: history window restored`), up to `retain.memoryVersions` when that is set |
| `memory: heap filling` | the heap is 70% full (`warn`); a major collection was started, the database's cache capped at 100,000 decoded objects, its index trees dropped if `indexTrees` is `memory` (by default they were never built), lookups and scans reading the store, the history window in memory cut to the last two versions, and the mempool's limit halved, a transaction that arrives while the pool holds that many being refused (the `mempool full` row above). No RPC method or event stream is refused yet. Watch `heap=` in the status line, and plan a larger `--heap` if it keeps climbing |
| `memory: shedding load`, then `shedding load: mempool limit lowered, costly requests refused` | the heap is 85% full (`pressure`): the mempool admits up to a tenth of its limit (`limit` in the line) and fetches nothing while it holds that many, costly RPC calls and new streams are refused, the signature cache is dropped, the database's cache is capped at 10,000 decoded objects, and its Merkle trees are dropped (after the index trees that went at `warn`, on a node with `indexTrees: memory`), roots and proofs reading the store like lookups and scans, the history window in memory staying at the last two versions; consensus and block sync go on. `memory: easing` and `load shedding over` follow once the heap falls 5 points below the threshold; the trees come back only when they fit (next row) |
| `memory: staying paged until the heap has room to rebuild` | the heap eased to `ok` with the Merkle trees dropped (or the index trees, on a node with `indexTrees: memory`) or the history window trimmed, and rebuilding them (`needs`) does not fit within half the heap limit beside the heap of the last ten samples (`room`). The line comes once per drop, after the wait at `ok` that precedes any rebuild (section 12). Nothing is wrong: the node runs on the store, its blocks at the rate they have resident within a tenth and its scans and proofs slower (section 12), and rebuilds when the room appears (`memory: Merkle trees rebuilt`, and `memory: index trees rebuilt` under `indexTrees: memory` only); a larger `--heap` brings the trees back for good |
| `memory: heap at the limit; stopping before the process aborts (raise --max-old-space-size or --heap)`, then exit code 3 | the heap is 95% full (`critical`); the node stopped cleanly rather than wait for V8 to abort it. Start it again with a larger `--heap`, or on a machine with more memory. The guard acts on the heap figure alone and does not say what filled the heap; when the level was reached with every tier already dropped, nothing but the limit changes that |
| `loaded application state` with `paged=indexTrees, trees, history` | the trees named were estimated not to fit within half the heap limit and were left in the store, and the history window was not read back (section 12); `indexTrees` appears only under `indexTrees: memory`. Nothing is wrong: the node runs on the store, its blocks at the rate they have resident within a tenth and its scans and proofs slower, proves the heights before the one it opened at from the store's history records, and rebuilds the trees if room appears. A larger `--heap` opens the state whole |
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
| `genesis: consensus.maxBlockBytes must be a whole number from 65536 to 16777216` | `consensus.maxBlockBytes` in `genesis.json` is out of range, not a whole number, or written as a string; leave the field out for 4 MiB. `init` prints the same for a `--max-block-bytes` it refuses, and then writes nothing |
| `N validators exceed the limit 2000` | a validator set of more than 2,000 members: the engine's `validators` list in `genesis.json` names too many, or an embedded application returned updates that make such a set, and the node halted rather than apply them. The core application cannot: its `maxValidators` is at most 1,000 |
| `state sync: a validator key is not a secp256k1 key; this is not the chain genesis describes` | the peers serve a chain of another scheme than the local `genesis.json` names: the wrong genesis file, or seeds on another chain |
| `catchingUp: true` for long | the node is far behind and fetching blocks; verification runs at a few thousand transfers a second |
| `state sync: no peers; replaying from genesis` | no peer connected within 30 seconds of starting; check the seeds and that they are running |
| `state sync: no peer offers a snapshot; replaying from genesis` | the connected peers export no snapshots (`snapshotInterval: 0`) or have not reached their first one |
| `state sync: no peer serves the headers below H that evidence may still name` | the peers offering the snapshot do not hold the headers from H back to the evidence window (they joined by state sync themselves and have let theirs go, or run a shorter evidence age); start the node again once a peer that keeps its blocks is connected, and it reuses the headers it already stored |
| `block H carries evidence for height h, whose validator set this node does not hold; its history does not reach that far` | the node halted rather than apply the block differently from the rest of the network: its headers do not reach back to h (a data directory written before header records existed, an embedded node given a shorter evidence age than the chain's unbonding period, or an unbonding period lengthened by proposal since the join); stop it, delete `data/lmdb` only (keep `priv_validator_state.bin`) and join again |
| `keystore.json is locked by another process` | another command held the keystore's lock (`keystore.json.lock` beside it) for the 5 seconds a write waits; run the command again. A lock left by a process that died is cleared after 30 seconds |
| `data directory ... is in use by process N` (or `by this process`) | another node has the directory open (its pid is in `data/LOCK`), or is still stopping: the file goes once its network is closed, the block being applied has finished its writes and the store is closed, just before the process exits; stop it first and wait for it to exit. A `LOCK` whose process is gone is taken over by the next start; if N is not a node (the pid of a node that crashed, given since to another process), remove `data/LOCK` |
| `start failed` in the log with `err=listen EADDRINUSE: address already in use ...`, then exit code 1 | another process is listening on the node's RPC address (`rpcListen`, by default the p2p port plus one), often a node already running with the same `config.json` ports. The node was up by then, so it is stopped like any other before the process exits: the store is closed and `data/LOCK` removed, and nothing has to be cleaned up. Free the address or change `rpcListen` (section 5) and start again. `start failed` with another error is a failure of the node's own start, handled the same way |
| `stopping failed` in the log, then exit code 1 | a step of the shutdown failed (the error is in the line). The other steps were still carried out and the claim on the data directory given up; the exit code is 1 unless the node was stopping with another, such as 3 |
| `server is stopping` (`-32000`) | the request reached a node that is shutting down; send it to another node, or again once this one is back |
| `the store is closed` in a log line while the node stops, on its own or as the `err` of `handling a proposal failed` (or `a vote`, `a fetched block`, `a transaction`, `evidence`) | harmless: something that was waiting when the node stopped (a request to a peer, a signature verification, an RPC method that ran for more than the second the server waits) resumed after the store was closed, and the store refused the call instead of being read or written. Work the node had begun for a peer's message is logged as `handling a ... failed` with that error, or with `verifier closed` if it resumed to the verifier pool the node had closed; once the node is stopping the line is at `debug`, so it shows only at that log level. A validator's own proposal, or one it held for the height, that was being verified at the stop is logged by consensus with the same words and its height and round (`h`, `r`). Nothing was lost and nothing has to be done. Outside a stop `the store is closed` means a program that embeds a node used a store after closing it, and `handling a ... failed`, then at `warn` (at `error` for a validator's own proposal or one it held), is a handler that failed while the node ran: its `err` says how |
| `data directory ...: could not claim it in 50 attempts; <path>/LOCK.takeover may have been left by a process that stopped while taking over a stale claim: check that no node runs on the directory, then remove it` | most likely a node was killed in the few file operations for which it held `LOCK.takeover` while taking over a stale `LOCK`, and the file is never removed automatically; make sure no node runs on the directory, delete `data/LOCK.takeover` if it is there and start again. If it is not there, other processes kept claiming and releasing the directory during the attempts: start again |
| `<path>/light.json holds a trusted header of chain X, and this node is on chain Y` | the keystore directory's light client anchor belongs to another chain; use that chain's keystore directory (`--keystore`), or anchor afresh with `light <target> trust <height> <hash>` |
| `included at height H; this node does not hold the results of that block` from `verify-tx` | the node fetched the block after a state sync and never executed it; the inclusion is proven, and a node that executed the block proves the result |
| `state sync: every snapshot offered is from before the trusted height; replaying from genesis` | the trusted height in `stateSync` is more than one above every snapshot the peers offer; stop the node, delete its `data`, and join again with a trusted header from before the newest snapshot (section 9) |
| `the application failed while taking the root of block N (...) and holds changes it cannot undo: restart the node, the store has the state of the block before` | a block failed after its changes could no longer be undone in memory; nothing of it was written. Restart the node: it opens the state of the block before and goes on from there |
| a block fails to apply with a store error (disk full, an LMDB error) | the application's write failed inside the block's transaction, so neither the block nor the chain state was stored; free the cause and restart the node, which finds the chain and the application at the same height |
| `authority can never be satisfied: its member accounts do not lead to keys enough for the threshold` | an `accountCreate` or `accountUpdate` whose new authority no set of signatures could meet, such as one that names only the account itself; give it keys, or member accounts whose keys reach the threshold |
| `authority can never be satisfied: it needs more than the 16 signatures a transaction can carry` | an `accountCreate` or `accountUpdate` whose new authority counts more than 16 keys through its member accounts and cannot reach its threshold with 16 signatures, the most a transaction carries; lower the threshold, raise weights, or name member accounts that need fewer keys. Keys shared by two member accounts are counted once for each, so an authority that shared keys would just fit can be refused too |
| `validator has lost all its tokens to slashing and takes no delegation` | a `delegate` to (or a redelegation into) a validator slashed of its whole stake; choose another validator |
| `stored objects do not hash to the stored app hash` | the application store is corrupt or from another version; stop the node, delete `data/lmdb` only and resync, keeping `data/priv_validator_state.bin`, the double-sign guard |
| `object <id> does not hash to its leaf in the stored tree` | the same, found earlier: at startup the Merkle trees came back from their stored chunks and nodes, every object was hashed against the leaf the tree holds for it, and one did not match. The fix is the row above |
| `the stored tree has n leaves for m objects`, `... is not the hash of its children`, `sparse tree node ... does not hash to what its parent says` | the same: a stored object is missing while its tree still holds its leaf, or a stored tree node is damaged. The fix is the row above |
| `<type>.<index>: the stored entry for object <id> is missing` (or `is object <id>'s`, `the store holds n entries for m objects`, `a stored index entry is malformed`) | the same: the stored index entries do not match the objects, which the app hash cannot show for an index it does not cover. The fix is the row above |
