# 15. The tests

`npm test` runs `vitest run` (the `test` script in `package.json`) over every file matching
`test/**/*.test.ts`: thirty-three files, 328 cases, about 11,700 lines counting the shared harness
in `test/helpers.ts` and the setup file. The whole suite takes about two minutes under the
default ML-DSA-44 keys; nearly all of that time is the network scenarios, which run real
consensus timers. The same suite runs
on the chain's other signature scheme with `CHAIN_SCHEME=secp256k1 npm test` (327 passing and
one skipped, the case that is about ML-DSA signing): every testnet and application genesis the
suites build names the scheme `DEFAULT_SCHEME` resolves to ([chapter 2](02-crypto.md)), and
every key is derived with it. It also runs with the object database's accelerators turned off
from the start: `INDEX_TREES=0 npm test` drops every secondary index's B+ tree, `TREES=0 npm test`
every Merkle tree, and the two together drop both, so that every lookup, scan, root and proof
in every suite goes through the fallbacks STATE-PAGING.md describes ([chapter 9](09-database.md));
all four combinations pass. One file: `npx vitest run test/staking.test.ts`. One case, by a
substring of its title: `npx vitest run test/consensus.test.ts -t partition`. The nodes are
silent unless you ask: `LOG=debug npm test` (or `info`, `warn`) turns on the per-node logger
through `testLogger`. The files are organised by layer, in the order of this tutorial: `units`,
`store`, `arena` and `db` cover what sits under the engine, and `schemes` the two signature
schemes from a key pair up to a chain running on the second one; `network`, `consensus`,
`recovery` and `engine` run the engine on the toy key-value application, and `memory` covers the
memory guard and the collection scheduler, its node case on the core application so that the
guard's dials on the object database show; `chain`, `app`, `staking`, `staking-net`, `fees` and
`genesis` cover the core application, and `history` the log its account history is stored in; `txproof`, `light`, `rpc` and
`sync` cover proofs, clients and catching up, and `priorities` the proposer priorities a header
commits to, from the two hashes of a validator set to a join from a snapshot; `amnesia` covers a
validator's lock, from the round a prevote signs to a forgotten lock punished on a network, and `faults` the other evidence: two proposals for a round, a prevote on a majority that never was, and what arrives when its height is over; `signing` covers the hold on a validator's signature from its start until it is level with a peer; `review` holds one regression test per finding of
the external review and the later cases of the same kind, `review2` five more that each
span several layers, and `review3` the twelve regressions of the review of the paging and
scheme work (the memory guard, the node and the signature schemes), which this chapter lists
by title at the end of the suites, `review4` thirteen cases, most for the items the first review
noted and left, and the four `review5` files 75 cases for failures and unusual callers at the
edges of every layer: `review5-net` the peer layer, sync, consensus intake and the mempool,
`review5-node` the node, the executor and the block store, `review5-app` the application, the
object database and the codec, and `review5-rpc` the RPC server, the keystore, the command
line and the light client. Files run one after another, never in parallel, for a reason explained
below.

## The harness

Everything the suites share lives in `test/helpers.ts`, 170 lines. It exports two constants,
seven functions, two interfaces and one shared verifier.

### `FAST_TIMEOUTS`

```ts
export const FAST_TIMEOUTS = {
  proposeMs: 400,
  proposeDeltaMs: 200,
  prevoteMs: 200,
  prevoteDeltaMs: 100,
  precommitMs: 200,
  precommitDeltaMs: 100,
  commitMs: 50,
  gossipMs: 150,
};
```

These are the consensus timeouts from [the consensus chapter](04-consensus.md), shortened.
The production defaults in `src/consensus/consensus.ts` (`DEFAULT_TIMEOUTS`) are
`proposeMs: 3000`, `proposeDeltaMs: 500`, `prevoteMs: 1000`, `prevoteDeltaMs: 500`,
`precommitMs: 1000`, `precommitDeltaMs: 500`, `commitMs: 1000` and `gossipMs: 500`. Those
defaults assume real networks with real latency. In a test, all nodes share one process and one
in-memory transport with no latency, so the timeouts are the only thing that limits block rate:
with `commitMs: 1000` every block would wait a full second after being decided, and a test that
needs ten blocks would take ten seconds for nothing. With `FAST_TIMEOUTS` a four-validator
network produces several blocks a second. Shorter timeouts also make failure scenarios resolve
quickly: when a validator is down, every round it should have proposed times out, and with
`proposeMs: 400` that costs well under a second instead of three. The price is sensitivity to a
loaded machine, which is why every wait in the suites allows seconds, not milliseconds. A test
that needs a longer window overrides one value, as `test/engine.test.ts` does with
`timeouts: { commitMs: 1500 }`.

### `FAST_NETWORK`

```ts
export const FAST_NETWORK = { connectIntervalMs: 100, pingIntervalMs: 1000, idleTimeoutMs: 5000, desiredOutbound: 16, maxInbound: 32 };
```

The peer-to-peer timers of [the p2p chapter](06-p2p.md), shortened in the same way: the
defaults in `src/p2p/network.ts` are a connect loop every 1,000 ms, a ping every 10,000 ms,
and an idle drop after 45,000 ms. `desiredOutbound: 16` (default 8) makes every node dial every
other node, so a testnet of five or six nodes is a full mesh within a connect interval or two.

### `seedFor`

```ts
export function seedFor(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(`seed:${label}`));
}
```

Every key in the suites comes from a label: `seedFor('chain/faucet')`,
`seedFor('st/op/a')`. The same label always gives the same key pair through
`keyPairFromSeed` (in `DEFAULT_SCHEME` unless a scheme is passed), so a test can hold the key of
a node it did not create, for example to forge a vote in the name of validator 3
(`keyPairFromSeed(net.validatorSeed(3))`). Each file
prefixes its labels (`rpc/`, `rv/`, `sync/`, `fees/`) so two files never share an account key
by accident.

### `testLogger`

```ts
export function testLogger(name: string): Logger {
  const level = process.env.LOG as LogLevel | undefined;
  return level ? makeLogger(name, level) : silentLogger;
}
```

Silent by default; the `LOG` environment variable turns on the real logger at that level, named
per node (`n0`, `n1`, ...) so the interleaved lines of a whole network can be told apart.

### `verifier`

```ts
export const verifier = new InlineVerifier();
```

One `InlineVerifier` shared by every node in every testnet. The production node uses a
`WorkerVerifier`, a pool of worker threads that checks signatures off the main thread
([the crypto chapter](02-crypto.md)). In a test, six nodes in one process would start six pools,
each of which must be closed, and the threads would compete with the consensus timers for the
machine. The inline verifier calls `verify` synchronously on the calling thread: no threads to
start or close, deterministic ordering, and still a real signature check on every vote,
proposal and transaction. The worker pool has its own unit test in `test/units.test.ts`, and
`test/network.test.ts` wraps the inline verifier in a deliberately slow one to test a race.

### `makeTestnet` and `Testnet`

This is the heart of the harness: it builds a whole network of nodes in one process.

```ts
export interface TestnetOptions {
  validators: number;
  fullNodes?: number;
  powers?: bigint[];
  chainId?: string;
  dataDirFor?: (i: number) => string | null;
  timeouts?: Partial<typeof FAST_TIMEOUTS>;
  limits?: Partial<ValidationLimits>;
  /** The chain's engine settings, written to the genesis. */
  consensus?: Genesis['consensus'];
  /** Indices to create but not start. */
  skipStart?: number[];
  /** The chain's signature scheme; CHAIN_SCHEME from the environment, else ML-DSA-44. */
  scheme?: SchemeTag;
  /** Handed to the application; JSON, or a function of the validator public keys in index order. */
  appState?: string | ((validatorKeys: Uint8Array[]) => string);
  /** False leaves the engine's validator list out of genesis, so the application must supply the set. */
  engineValidators?: boolean;
  /** Application per node. Default is the key-value test app. */
  appFor?: (i: number, dataDir: string | null, genesis: Genesis) => Application;
}
```

`validators` nodes get a validator key; `fullNodes` more are created without one, so they
follow but do not vote. `powers` sets voting power per validator (default 10 each).
`dataDirFor` returns a directory for a node that should persist to LMDB, or `null` to keep
it in memory (the default). `limits` goes into every node's configuration, and `consensus`
into the genesis: the chain's engine settings, which is where a block size has to be set, since
a node takes none from its own configuration ([chapter 8](08-node.md)). `skipStart` creates nodes without starting them, for "node down"
and "late joiner" scenarios. `scheme` is the signature scheme the validator and node keys are
derived with and the genesis names; it defaults to `DEFAULT_SCHEME`, which is `CHAIN_SCHEME`
from the environment or ML-DSA-44, and only `test/schemes.test.ts` passes one explicitly
(`Scheme.secp256k1`). `appState` is the application's genesis document; as a function
it receives the validator public keys, which is how the staking network test puts the engine's
keys into the application's validator list. `engineValidators: false` leaves `validators` out
of the engine genesis entirely, so the application must hand the engine the set from
`initChain`. `appFor` replaces the default `KvStoreApp` with any `Application`, usually a
`CoreApp`.

The body derives everything from the chain id:

```ts
  const chainId = opts.chainId ?? 'test-chain';
  const hub = new MemoryHub();
  const total = opts.validators + (opts.fullNodes ?? 0);
  const validatorSeed = (i: number) => seedFor(`${chainId}/val/${i}`);
  const nodeSeed = (i: number) => seedFor(`${chainId}/node/${i}`);
  const addrOf = (i: number) => `node${i}:1`;
```

One `MemoryHub` from `src/p2p/memory.ts` is the whole network. It hands out a `Transport` per
address (`hub.transport('node0:1')`); a dial is a pair of connected endpoints inside the hub.
The hub is where faults are injected: `hub.latencyMs` delays every frame, `hub.partition(a, b)`
blocks traffic between two groups of addresses, `hub.isolate(addr, others)` cuts one node off,
`hub.heal()` removes all partitions, and `hub.messageFilter` is a predicate over
`(from, to, frame)` that can drop chosen message types. This is why the consensus tests can run
whole networks in one process: the nodes are real `Node` objects running real consensus, real
gossip and real signature checks, but the wire is a function call with an optional timer, so
a test can create a partition, a slow link or a lost proposal in one line and observe every node
directly.

The genesis is built once and shared:

```ts
  const genesis: Genesis = {
    chainId,
    signatureScheme: schemeName(scheme),
    genesisTime: BigInt(Date.now()) - 1000n,
    validators:
      opts.engineValidators === false
        ? undefined
        : validatorKeys.map((publicKey, i) => ({ publicKey, power: opts.powers?.[i] ?? 10n, name: `val${i}` })),
    ...(opts.consensus ? { consensus: opts.consensus } : {}),
    appState: new TextEncoder().encode(appState),
  };
```

`signatureScheme` is the name of the scheme the validator keys above were made with
(`keyPairFromSeed(validatorSeed(i), scheme)`), so the engine's genesis check that every
validator key is of the named scheme passes whichever scheme the run is on, and every node
derives its own keys with the same one ([chapter 8](08-node.md)). The application genesis
documents the suites write by hand (`test/app.test.ts`, `test/staking.test.ts`,
`test/fees.test.ts`, `test/genesis.test.ts`, `test/review.test.ts`) carry the same
`signatureScheme: schemeName(DEFAULT_SCHEME)`. Note `genesisTime`: one second before now, on the wall clock. Network tests therefore run on
real time, and a transaction for a network test needs an expiration of
`BigInt(Date.now()) + 60_000n`. The application unit tests use a fixed genesis time instead;
the difference is a common pitfall, discussed at the end of the chapter.

Each node is created through `makeNode`, which the returned `Testnet` also exposes so a test can
recreate a node later with different settings:

```ts
    const node = await Node.create({
      name: `n${i}`,
      genesis,
      dataDir,
      app: opts.appFor ? opts.appFor(i, dataDir, genesis) : new KvStoreApp(dataDir ? join(dataDir, 'app.json') : null),
      nodeKeySeed: nodeSeed(i),
      validatorSeed: i < opts.validators ? validatorSeed(i) : null,
      ...(dataDir === null && !overrides.dataDir ? { signState: signStateOf(i) } : {}),
      transport: hub.transport(addrOf(i)),
      listenAddr: addrOf(i),
      seeds: allAddrs.filter((a) => a !== addrOf(i)),
      verifier,
      timeouts: { ...FAST_TIMEOUTS, ...opts.timeouts },
      limits: opts.limits,
      network: FAST_NETWORK,
      lagGraceMs: 500,
      log: testLogger(`n${i}`),
      // A node leaves its index trees in the store by default; the suites run with them in memory, so that dropping
      // and rebuilding them is exercised, and in the store under INDEX_TREES=0.
      indexTrees: process.env.INDEX_TREES === '0' ? 'store' : 'memory',
      ...overrides,
    });
```

Every node seeds from every other address, uses the shared verifier and the fast timers, and
gives block sync a `lagGraceMs` of 500 ms (default 3,000) before it treats itself as lagging.
The helper also names `indexTrees`, which a node defaults to `'store'` ([chapter 8](08-node.md)):
it asks for `'memory'` in the default mode, so that the suites exercise a node that builds its
index trees, drops them at `warn` and rebuilds them, and for `'store'` under `INDEX_TREES=0`, so
that in that mode the node never builds them, as the databases of the run do not. A test's
own `indexTrees` in the overrides wins over both.
A node without a data directory is given a `signState`: one `MemorySignStateStore` for each
index, kept by the testnet for as long as it lives, so that a validator a test stops and makes
again with `makeNode` comes back knowing what it last signed, as one restarted on its data
directory does. Without it the second node would sign again in heights the first signed in,
and its peers, which keep the votes of the last sixteen heights, would report it for a double
sign ([chapter 4](04-consensus.md)); `test/staking-net.test.ts` failed that way when the kept
heights were added. A test that means a new chain under the same key passes a store of its own
(`test/recovery.test.ts` does), and one that passes a `dataDir` in the overrides gets the file.
The `overrides` are a `Partial<NodeConfig>`, so `net.makeNode(4, { validatorSeed: net.validatorSeed(4) })`
turns a full node into a validator, and `net.makeNode(0, { dataDir })` reopens a node from
disk. All nodes are created first, then started in index order, except those in `skipStart`.

The returned object:

```ts
export interface Testnet {
  hub: MemoryHub;
  genesis: Genesis;
  nodes: Node[];
  addrOf(i: number): string;
  validatorSeed(i: number): Uint8Array;
  nodeSeed(i: number): Uint8Array;
  makeNode(i: number, overrides?: Partial<NodeConfig>): Promise<Node>;
  stop(): Promise<void>;
}
```

`stop()` stops every node in `nodes`, so a test that creates an extra node must push it into
`net.nodes` (as `test/sync.test.ts` does) or stop it itself. Every network suite stops its
testnet in an `afterEach`, so a failed assertion never leaves timers running into the next test.

### `sleep`, `waitFor` and `waitForHeight`

```ts
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(cond: () => boolean, timeoutMs: number, what: string | (() => string)): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await sleep(20);
  }
}

export function waitForHeight(nodes: Node[], h: bigint, timeoutMs = 20_000): Promise<void> {
  return waitFor(
    () => nodes.every((n) => n.height >= h),
    timeoutMs,
    () => `height ${h} (now ${nodes.map((n) => n.height).join(',')})`,
  );
}
```

A network test almost never sleeps for a fixed time; it waits for a condition. The difference
matters twice over. A fixed sleep is always too long on a fast machine (the test waits the full
time even when the chain got there in a tenth of it) and sometimes too short on a slow one
(the test fails although nothing is wrong). `waitFor` polls the condition every 20 ms and
returns the moment it holds, and fails with a message naming what it was waiting for. Because
`what` may be a function, the message can report the state at the moment of failure, for
example `height 5 (now 5,5,4,5)`, which is usually enough to see which node fell behind.
`waitForHeight` is the common case: every node in a list at or beyond a height, with a default
limit of 20 s. `sleep` is reserved for the opposite kind of claim: that something does not
happen, for which there is no condition to wait on. `test/consensus.test.ts` sleeps three
seconds to show that a network with two of four validators down stays at height 0.

### `tx`

```ts
export function tx(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
```

The transactions of the toy `KvStoreApp` (`src/app/kvstore.ts`) are UTF-8 strings:
`key=value` sets a key, and `val:<hex public key>:<power>` sets a validator's power (0 removes
it). `tx('hello=world')` is the whole transaction. The core application's transactions are
built by `signedTxBytes` from `src/app/core/client.ts` instead.

### `vitest.config.ts`

```ts
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // INDEX_TREES=0 runs the suites with the index trees dropped (test/setup.ts).
    setupFiles: ['test/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Nodes in one test share timers and the event loop; keep files sequential.
    fileParallelism: false,
  },
});
```

Each test and each hook (`afterEach`) may take up to 60 seconds; the network scenarios need
tens of seconds and a stop hook must wait for every node. `fileParallelism: false` runs the
files one at a time. Vitest would otherwise run files in parallel workers, and the consensus
tests depend on timers firing roughly when scheduled: a partition test that measures how far
nodes advance in three seconds, or an evidence test that waits for block time to pass a limit,
gives wrong answers when another file's four-node network is starving the same cores. The TCP
test also binds fixed ports (`127.0.0.1:38881` and `38882`), which two parallel copies could
not share. Within a file, tests already run sequentially.

### `test/setup.ts`

Run before every test file, it is the whole of the three environment switches:

```ts
import { useSchemeFromEnvironment } from '../src/crypto/keys.ts';
import { setDefaultIndexTrees, setDefaultTrees } from '../src/db/database.ts';

useSchemeFromEnvironment();

if (process.env.INDEX_TREES === '0') setDefaultIndexTrees(false);
if (process.env.TREES === '0') setDefaultTrees(false);
```

`useSchemeFromEnvironment()` sets `DEFAULT_SCHEME` from `CHAIN_SCHEME` when the variable is set
([chapter 2](02-crypto.md)); the node code never reads it.
`setDefaultIndexTrees(false)` makes every `ObjectDatabase` constructed afterwards start with its
secondary indices' B+ trees dropped, unless its options say otherwise, so every lookup and scan
in the run reads the index store with the overlay of the writes since the last root on top;
`setDefaultTrees(false)` does the same for the Merkle trees, so every root, object proof and key
proof reads chunks and nodes from the store ([chapter 9](09-database.md)). The suites are not
written for either mode in particular, which is the point: an application test that passes with
the trees resident and with them dropped shows that the fallback gives the same hashes and the
same answers, and that is the acceptance test STATE-PAGING.md sets for phases three and four
(section 9). Tests that need a particular mode say so in their own options (`indexTrees: true`
for the resident twin in `test/db.test.ts`), and those win over the default. A node made by
the harness follows the same switch through its own setting: `makeNode` asks for
`indexTrees: 'store'` under `INDEX_TREES=0` and for `'memory'` otherwise (above), a node's own
default being `'store'`.

## The suites, file by file

Each section names the part of the system the file covers and the chapter that documents it,
then walks every case by its exact title.

### test/units.test.ts

Eleven unit tests on the smallest pieces: the codec ([01](01-codec.md)), keys and the worker
verifier ([02](02-crypto.md)), the validator set ([03](03-types.md)), the signing guard
([04](04-consensus.md)) and the mempool ([05](05-mempool-executor.md)). Nothing here starts a
node.

**`it('round-trips every primitive')`** (describe `codec`). Encodes one of each primitive with
the writer (`u8(255)`, `bool(true)`, `u32(0xdeadbeef)`, `u64(2n ** 64n - 1n)`, `i64(-5n)`,
`bytes`, `string('héllo')`, an `option` of `null` and of `7`, an `array` of two `u64`) and
decodes them with the reader in the same order. The decoded object must `toEqual` the inputs.
This proves writer and reader are exact inverses, including at the top of the `u64` range and
for a non-ASCII string.

**`it('rejects truncated input, trailing bytes, and hostile lengths')`**. A `u32` read from two
bytes throws `CodecError`; a `u8` read from two bytes throws with `/trailing/`; a `bytes` or
`array` whose length prefix is `0xffffffff` throws `CodecError` rather than trying to allocate
four gigabytes. Strict decoding is what makes the codec safe on data from peers: no silent
truncation, no ignored tail, no length a peer can use to exhaust memory.

**`it('round-trips p2p messages')`**. Five wire messages (`addrRequest`, `addrResponse`,
`status`, `inv`, `reject`) pass through `encodeMessage` and `decodeMessage` unchanged.

**`it('signs deterministically and binds the context')`** (describe `keys and signatures`). Two
signatures of the same message under the same context are byte-identical; the signature
verifies under its context and fails under `signContext('c', 'vote')` (another purpose), under
`signContext('other', 'tx')` (another chain) and over a different message. This is domain
separation: a signature made for a transaction on one chain can never be replayed as a vote or
on another chain.

**`it('derives the same key from the same seed and addresses are hashes')`**. `keyPairFromSeed`
of the same seed gives the same public key, and `addressOf(publicKey)` equals
`sha256(publicKey)`.

**`it('verifies in worker threads')`**. Starts a `WorkerVerifier(2)`, builds five jobs with
valid signatures, zeroes the first eight bytes of the third signature, and expects
`[true, true, false, true, true]` from `pool.verify(jobs)`. The pool is closed in `finally` so
a failure does not leave worker threads alive.

**`it('picks proposers in proportion to voting power')`** (describe `validator set`). Three
validators with powers 1, 2 and 3; 600 rounds of `proposer()` followed by
`incrementProposerPriority(1)` on a copy. The counts must be exactly 100, 200 and 300. This is
Tendermint's weighted round robin: over a cycle every validator proposes in exact proportion
to its power.

**`it('applies updates, hashes independently of priorities, and survives a codec round-trip')`**.
`applyUpdates` with a new key grows the set to 3, and the newcomer's `priority` is negative (a
new validator is penalised so it does not propose at once); an update to power 0 shrinks the
set to 2; removing a key that is not there throws `/unknown/`. A copy whose priorities were
bumped three times has the same `hash()` as the original, so the hash in a block header covers
keys and powers only. Encoding and decoding the bumped set keeps the proposer and every
priority.

**`it('refuses to sign backwards or conflicting content, allows identical re-signs')`** (describe
`private validator`). A `PrivValidator` with a `MemorySignStateStore` signs a nil prevote at
height 5, round 1. Signing the identical vote again returns the same bytes; a vote for a block
hash at the same height, round and step throws `DoubleSignError`, as do a lower round and a
lower height. A precommit at the same height and round is allowed (a later step), after which
a prevote at that height and round is refused (a step backwards), and height 6 round 0 is
allowed. This is the double-sign guard: the one piece of state that keeps an honest validator
from ever producing the evidence that would slash it.

**`it('dedupes, rejects invalid, reaps FIFO, and drops committed transactions')`** (describe
`mempool`). A `Mempool` over a `KvStoreApp` with `maxTxBytes: 64`: `a=1` is `'added'`, the
same bytes again are `'seen'`, `bad` (no `=`) is `'invalid'`, 100 bytes is `'too-large'`,
`b=2` is `'added'`. `reap(1_000_000)` returns `['a=1', 'b=2']` in arrival order; `reap(8)` fits
only one. After `update([tx('a=1')])`, the committed transaction is gone and `size` is 1.

**`it('remembers the last transactions it saw, the newest taking the oldest one\'s place')`**.
A `Mempool` with `cacheSize: 3`. Three transactions are `'added'` and then committed through
`update`, which takes them out of the pool; submitted again each is `'seen'`, because the
cache of hashes outlives the pool, so gossip need not bring a committed transaction again.
Seven more transactions are added, which takes the cache round its ring more than twice:
`d=6`, `d=5` and `d=4` are `'seen'`. `mp.seen(...)` is true for `d=3` as well, though the cache
has let it go, because `d=3` is still in the pool, and what is pooled counts as seen whatever
the cache holds. The seven are then committed through `update`, after which only the cache
speaks, and `mp.seen(...)` is false for `d=3` and for `a=1`. The
cache keeps exactly the last `cacheSize` hashes, each new one taking the place of the oldest
([chapter 5](05-mempool-executor.md) has the ring and why it replaced an array shifted for
every transaction).

### test/schemes.test.ts

Five tests on the two signature schemes ([02](02-crypto.md)), from a key pair up to a chain
running on the second one. The first four are unit tests under `describe('signature schemes')`;
the fifth runs a testnet under `describe('a chain on secp256k1')`, with an `RpcServer` stopped
before the network in `afterEach`. These, a few regression cases in `test/review3.test.ts` (off-curve secp256k1 keys, a restart on
a secp256k1 genesis, a handshake between nodes of the two schemes, a keystore holding both) and
the hedged signature in `test/review.test.ts`, with `test/review5-app.test.ts`'s validator key of another scheme than the set's, are the cases that name a scheme explicitly;
everything else in the suite follows `DEFAULT_SCHEME`.

**`it('signs and verifies under each scheme, with tagged keys and signatures that tell them apart')`**.
For each of `Scheme.mlDsa44` and `Scheme.secp256k1`: a key pair from
`keyPairFromSeed(seed, scheme)` reports that scheme, its public key starts with the scheme's tag
byte and is `publicKeySize(scheme)` long; a signature over a message starts with the same tag
and is `signatureSize(scheme)` long; it verifies under its context and fails under the `vote`
context, over a changed message and with one bit flipped; signing again gives identical bytes,
so both schemes are deterministic; the key and signature written with `fixed` decode back
through `decodePublicKey` and `decodeSignature`, which read the size from the tag; and
`generateSeed(scheme)` yields a seed whose key pair is of that scheme. Then one seed under both
schemes: two different addresses, and neither key verifies the other's signature. `schemeOf`
names a key's scheme, `isPublicKey` refuses a truncated key, and a key or a signature whose
first byte is `9` or `0` throws `unknown signature scheme`.

**`it('refuses the high-S twin of a secp256k1 signature, so no one but the signer can make a second valid one')`**.
ECDSA admits two `s` values for every signature, `s` and `n - s`; the test rebuilds the twin
from the curve order (`secp256k1.Point.Fn.ORDER`) and expects it refused while the original
verifies. Without low-S enforcement anyone relaying a transaction could rewrite its signature
and give it a second valid encoding and a second hash.

**`it('keeps each key's scheme in the keystore, reads a version 1 file as ML-DSA-44 and writes it as version 2')`**. A
keystore gets `ml` with ML-DSA-44, named explicitly whatever `CHAIN_SCHEME` says, and `ec` with
secp256k1; reopened, `get` returns each
in its scheme with the same public key, and `list()` reports both schemes. The file on disk
says `version: 2`. Then the version is set to 1 and the `scheme` field is deleted from `ml`'s
record, as a file written before there were two schemes would look; reopened again, the
handle's `version` is 1 and `ml` is ML-DSA-44 in both `get` and `list`. Reading wrote nothing:
the file is still the one the test wrote. `add('new', undefined, Scheme.secp256k1)` on that
handle then writes it as version 2 with a scheme beside every key, `ml-dsa-44`, `secp256k1`
and `secp256k1`, and `ml` opens to the same public key. Then the version 1 file is written
again under another name, `gone.json`, opened, and removed while the handle is open;
`add('later', undefined, Scheme.secp256k1)` on that handle writes the file anew from the
handle's own keys, as version 2 with the schemes `ml-dsa-44`, `secp256k1` and `secp256k1`, and
`ml` opens from it to the same public key: a handle that read a version 1 file names every
key's scheme when it writes, also when the file is no longer there to read. Last the `scheme` field is deleted from
`ec` in the version 2 file: `get('ec')` throws `/names no scheme/`, `list()` throws
`/key ec names no scheme/`, and `get('ml')` still gives its key ([14](14-wallet-cli.md)).

**`it('refuses a genesis whose validator keys are not of the scheme it names')`**. `genesisState`
with `signatureScheme: 'secp256k1'` and an ML-DSA key throws `/not a secp256k1 key/`; with no
scheme named (ML-DSA-44) and a secp256k1 key throws `/not a ml-dsa-44 key/`; the matching pairs
produce a chain state whose `scheme` is the tag named ([03](03-types.md)).

**`it('runs on secp256k1 keys end to end and refuses keys and signatures of the other scheme')`**.
`makeTestnet` with `scheme: Scheme.secp256k1`, four core-application validators and a faucet
whose key is secp256k1. At height 3 the chain state's `scheme` and node 0's `nodeKey.scheme` are
secp256k1, and the commit of block 2 holds signatures of `signatureSize(Scheme.secp256k1)`, 65
bytes, a tag and 64 bytes against 2,421 for ML-DSA-44; `status` over an `RpcServer` reports
`signatureScheme: 'secp256k1'` ([12](12-rpc.md)). An `accountCreate` for alice with a secp256k1
key, signed by the faucet, is `added` and alice exists. The same operation with an ML-DSA key in
the authority is refused with `/must be a secp256k1 key/`; a `validatorCreate` with an ML-DSA
consensus key with `/consensus key must be a secp256k1 key/`; and a transfer signed by the
faucet's seed under ML-DSA-44, relabelled with the faucet's secp256k1 address, with
`/another scheme/`: the scheme check runs before any verification work ([11](11-application.md)).

### test/store.test.ts

Five tests on `src/store` ([the store chapter](10-store.md)): the in-memory and LMDB
key-value stores and the block store on top of either. `exerciseKv` is a shared routine: it
writes four keys in one batch, reads one back, finds a missing key `undefined`, ranges over the
prefix `b` with `prefixEnd` and gets `['one', 'two']` in byte order, counts four entries between
`a` and `z`, throws from inside a write and checks the key it put is not there, then deletes a
key. Then, inside one write, it puts 200 keys and reads one of them back, ranges over them
deleting every other one as it goes and still counts 200, finds the first gone and a hundred
left, and asks `has` for one that is there and one that is not. Still inside that write, a
range over the keys from `n/1` puts `n/102`, replaces `n/103` and deletes `n/105` when it is
given `n/101`, and its next three are `n/102=put`, `n/103=replaced` and `n/107`: what lies
ahead of a range is given as it is when the range gets there, on both stores. And a write that
deletes a key, changes another and throws leaves both as they were. The `block(height)` helper builds a header of zero hashes with the height written into the
app hash.

**`it('memory store orders keys bytewise and makes writes atomic')`**. `exerciseKv(new MemoryKv())`.
The decisive point is the aborted write: a batch that throws leaves nothing behind.

**`it('lmdb store does the same and survives reopening')`**. The same routine on an `LmdbEnv`
in a temporary directory, then the environment is closed and reopened and `c` still reads
`three`; a second, read-only environment on the same path sees the deleted `a` as `undefined`,
and asked for a store named `missing` it throws `/no database named missing/`: a read-only
environment cannot create a database, and says so where it is asked for one. A `write` to its
store `t` throws `StoreReadOnlyError`, before anything reaches the native library.
The temporary directory is removed in `afterEach`.

**`it('block store finds blocks by height and by hash on both backends')`**. For a
`MemoryBlockStore` and a `KvBlockStore` over an LMDB store: save heights 1 to 5, load height 3
and check the commit's `blockHash` equals `blockHash(block)`, resolve the hash of block 4 to
height 4, resolve an unknown hash to `null`, find height 9 `null`, and find no saved chain state
(`loadState()` is `null`).

**`it('undoes an environment transaction made inside a write that then throws, on both backends')`**.
For a `MemoryEnv` and an LMDB environment, with a `KvBlockStore` on the store `chain` holding a
key `kept` with the value `before`: a `batch` saves block 1, changes `kept`, runs an
`env.transaction` that saves block 2, writes to the store `app` and, in a transaction of its
own, to a store `late` first asked for there, sees block 2 and the key in `app`, and throws.
Afterwards neither block is there, the blocks' transaction has no location, `kept` holds
`before`, and `app` and `late` hold nothing. A batch is a write to the store `chain`, and a
write to one store is a transaction of the environment on LMDB; the memory environment makes
it one too, where it used to undo the one store and leave the others. Then a batch that saves block 1 and catches the error of
an environment transaction that saved block 2 and threw: block 1 is there and block 2 is not.

**`it('block store on lmdb moves index entries into larger segments within the transactions that save the blocks')`**.
A `KvBlockStore` over an LMDB store saves 2,304 blocks of twenty transactions, 64 blocks to a
`batch`, odd positions failed with `no <height>`. Inside a batch each step of the move
reads what the steps before it wrote. Every 13th block's
transactions at positions 7 and 0 are found with their height, position, result and error, and
one of block 2,305 is not. Level 1 holds 40,940 entries, those of heights 1 to 2,047, and `'x'`
holds 5,140, those of 2,048 to 2,304. The environment is closed and opened again, and the same
lookups give the same answers.

### test/arena.test.ts

Six tests on `src/db/arena.ts` ([the database chapter](09-database.md)), the slabs of encoded
bytes under the object database, with no database at all: an `owner()` helper plays the
database's part, holding one reference per `type/instance` in a `Map`, taking relocations
into it, and, when the arena says an entry's slab was released, deleting the reference and
noting the entry in a list `gone`; `bytesOf(n, fill)` makes an encoding of `n` bytes all equal
to `fill`.

**`it('stores encodings across growing slabs and reads them back')`**. Six entries of 1, 100,
1,000, 100,000, 300,000 and 5 bytes, each filled with its own byte, read back with their length
and their first and last byte. The first slab is 256 KiB and the second 512 KiB, so the
300,000-byte entry opened a second slab: `stats` shows two slabs, `used` is the sizes plus a
`HEADER` of 10 bytes each, nothing is dead, and that entry's reference names slab 1. An
encoding of `MAX_ENTRY + 1` bytes throws `/does not fit/`, and a reference into slab 7, which
was never made, throws `/released/`.

**`it('counts freed entries dead and compacts a slab that is more than half dead, moving the live ones')`**.
The first slab is filled with as many 100-byte entries as fit, 110 bytes each with the header,
and three of every four are freed and dropped from the owner; `stats.dead` counts exactly their
bytes. `maintain()` releases nothing while that slab is still the current one, the one new
entries go to. A 256 KiB entry forces a second slab, and then `maintain()` returns 262,144, the
bytes released: every live entry was copied into slab 1 beside the big one, the owner was given
its new reference, and it reads back byte for byte as before, while slab 0 is gone (`stats.slabs`
is 1, and a read at slab 0 throws `/released/`). A new entry then takes the released slab's
slot with a new generation (its slab number is 2^16, generation 1 of slot 0), so the stale
reference into the old slab 0 is still refused rather than reading the newer entry.

The group `arena reclamation` has three cases, listed here by title: "releases every fully
dead slab at a root without copying from it, however many there are" (three slab-sized objects
rewritten at eight roots; `maintain()` asks the owner about no entry and leaves nothing dead),
"compacts as much as a root wrote, so a backlog of half-dead slabs does not grow" (a hundred
one-megabyte entries, three in five rewritten; one `maintain()` does all there is to do) and
"reuses the numbers of released slabs, so references stay small and exact however long the
node runs" (forty roots of slab-sized writes use fewer than eight slots, a stale reference is
refused by its generation, and `packRef` is exact at its limits and refuses beyond them).

**`it('releases whole slabs down to a byte limit, unread ones first, and tells the owner of every live entry')`**
(describe `arena as a cache`). Twelve entries of 200,000 bytes fill four slabs of 256 KiB,
512 KiB, 1 MiB and 2 MiB with one, two, five and four entries. Entry 1 is freed and dropped
from the owner, so the second slab holds one dead entry and one live one. `shrink(capacity)`
returns 0: nothing to do while the arena fits. Entry 2 is read, which marks the second slab,
and `shrink(capacity - 1)` returns 262,144 with `gone` equal to `['1/0']`: the first slab went,
the read one was passed over. A limit of 2.5 MiB then releases the third slab, 1 MiB, and
`gone` gains entries 3 to 7; entry 2 still reads. Entry 2 is read again and `shrink(0)`
releases the second slab all the same, on the second pass, reporting entry 2 and not the dead
entry 1. One slab is left, the current one, which is never released; the owner holds entries 8
to 11 and each still reads. A new entry of 1,900,000 bytes then opens a slab in a spare slot,
and `stats.slabs` is 2. This is `Arena.shrink`, the arena as a cache over a store
(STATE-PAGING.md section 3.4).

### test/db.test.ts

Forty-five tests on the object database and the trees beneath it ([the database
chapter](09-database.md)). The fixture defines two object types: `ItemType` (type id 7) with
a unique, authenticated index `byName` and a non-unique one, authenticated as well, `byGroup`, and `CounterType` (type id
3) with no indices. `fresh()` makes a database over both, `mk` creates an item, `byName` and
`inGroup` query the two indices. For the store-backed cases, `persistIndex(db, kv)` writes the
last root's index and tree changes to a `MemoryKv` as the application's commit does and calls
`dropChanges()`; `storeEntries` and `viewEntries` list the store's `'i'` keys and the
database's `indexEntries()` for comparison, `storedTrees` and `treeView` do the same for the
`'t'` and `'n'` keys and `treeEntries()`; `observe(db)` is everything the indices let a caller
see (every name's lookup, every group's scan, a full scan of each index and a cursor from the
middle of each) as one string; `proofsAt(db, v, names)` is everything a version can be asked to
prove (its root, every item's and the counter's object proof, the key proofs of a list of
names, several range proofs and both type leaves); and `prng(seed)` is a small deterministic
generator so a failing sequence can be replayed.

**`it('serves reads from the arena once decoded objects are evicted, and never evicts what is dirty')`**
(describe `object database: arena and hot cache`). A database with `hotObjects: 2`. Five items
created before any root are five dirty objects pinned in a cache of two: `memory().hotObjects`
is 5, the budget exceeded rather than enforced. After `root()` they are in the arena
(`arena.used` above zero) and unpinned, and the cache is back to at most two; every item still
reads its name, an object read back is frozen, the name index finds `c`, and the cache stays
within two after all those reads. Removing `b` makes it unreadable at once, by id and by name,
and leaves it out of `exportObjects`, before the root frees its bytes; after the root it is
still `null` and four objects export. Then `setHotLimit(0)`: a modify of `a` stays readable with
its new value and is the one object cached, pinned; after the root the cache is empty and `a`
still reads 7, decoded from the arena.

**`it('keeps history as bytes, agrees between getAt and bytesAt, and exports after churn what it holds')`**.
`hotObjects: 1` and `retainVersions: 10`. One item is modified at each of versions 2 to 6 while
another item is created each time. At every version 1 to 6, `getAt` returns the value it had
then and `bytesAt` exactly that value's encoding, and `historyBytes` is above zero. Each of the
six exported objects is the encoding of what `get` returns, and the item reads its latest value
after the churn. Ten more roots close the window behind version 1, and `getAt` there throws
`RangeError`.

**`it('computes the same roots whatever the cache budget')`**. The same five versions, twenty
creates each and from version 2 on a modify and a remove, are run with `hotObjects: 0` and with a
million: the two lists of roots are equal. Eviction changes where an object is read from, never
what is hashed.

**`it('reports every index entry a root adds and removes, so a store written from them equals the trees')`**
(describe `object database: index entries and dropped index trees`). A database given a
`MemoryKv` as its `indexStore`, three items, a root: the first root reports six entries (three
names and three group keys with the id appended); written to the store, the `'i'` keys equal
`indexEntries()` and `checkIndexStore()` has nothing to say. Alice gives up her name and bob
takes it in one block, with a new group: six changes, and every removal comes before the first
addition, so applying the list in order leaves the name with bob. A change of value only, and an
object created and removed before the root, report no entry at all. Deleting one `'i'` key from
the store makes `checkIndexStore()` complain.

**`it('answers lookups and merged scans from the store and the overlay while the trees are dropped')`**.
After a root and its write, `dropIndexTrees()` and `memory().indexTrees` is `dropped`; a name
lookup and a group scan come from the store. A pending insert appears in order in the scan and a
pending removal is skipped; a key removed and then taken by another object yields the new owner,
in the lookup and in the scan; uniqueness is checked against the overlay and the store alike,
and a key released by a rename can be taken; an object created and removed leaves nothing
behind; a session that renames, removes and creates while dropped is undone and `observe`
reads exactly as before it. Between a root and the store's write of it the dropped indices read
the root's own changes. After `rebuildIndexTrees()` the trees are `resident`, the store checks
out, and `observe` is unchanged.

**`it('drops and rebuilds with the same roots and lookups as resident trees, under random writes and sessions')`**.
`playTwins` for seeds 1 to 12, 400 steps each, alternately with the database's own in-memory
store and with an injected `MemoryKv`. A resident database and one that starts dropped run the
same random sequence of creates, renames (a unique key changing hands), a name handed from one
object to another inside a block, regroupings, removals, nested sessions committed or undone,
roots, and, on the dropping twin only, the dial turned at arbitrary moments, sessions open or
not; both must throw or not throw alike at every step, `observe` must agree after every step,
and every root must match. With the injected store the write of a root is sometimes delayed to
a later step, so the reads in between must see the root's own changes, and whenever the store
is written it must equal the resident twin's `indexEntries()`.

**`it('round-trips a drop and a rebuild in the middle of a block without changing a root or a lookup')`**.
Six versions of ten creates, a rename into another group and a removal, run once plain and once
with `ItemType`'s trees dropped after each version's creates and rebuilt every second version
before the root; the roots, the observations before and after each root, and the index entries
are identical.

**`it('reports the chunks and nodes each root changes, so a store written from them holds the trees')`**
(describe `object database: trees on disk and dropped trees`). 1,500 items, more than a chunk
of leaves. The first root reports more than three chunks and at least 2,999 sparse nodes (a leaf
per name and at least one inner node fewer); written, the store's `'t'` and `'n'` keys equal
`treeEntries()`. A change of value rewrites the leaf's path and the type leaf and no sparse
node, and deletes nothing. Removing the whole second chunk of leaves reports a chunk deletion,
and a rename reports sparse nodes deleted as leaves move and collapse. A database with no store
and resident trees reports no tree changes at all.

**`it('gives the same roots, object proofs, key proofs and range proofs with the trees dropped, at every version in the window, through undo and compaction')`**.
A resident database and one over a `MemoryKv` with `treeChunks: 3`, both retaining four
versions. Twenty-six versions of 3 KB items (long names, so rewrites leave slabs mostly dead
and the arena compacts), each with four creates, twelve modifications of which a quarter are
renames, a removal every other version, a counter object from version 6 on, and a session that
removes, renames and creates, undone every third version and kept otherwise; the dropping twin
has `dropTrees()` turned at versions 1, 7, 13, 19 and 25 and `rebuildTrees()` at 4, 10, 16 and
22, inside that session, and `dropTrees()` again at 20 outside it. Every root matches; the store is
sometimes written only before the next version, so proofs in between read the root's own
changes; whenever it is written it equals the resident twin's `treeEntries()`; at every version
in the window `proofsAt` for the last twelve names, the first and a very old one is byte for
byte the resident twin's; the chunk cache never holds more than three chunks. At the end the
arena has compacted at least once, the trees are `dropped`, the chunk cache has both hit and
missed, and after a final `rebuildTrees()` every proof in the window still agrees.

**`it('runs on trees dropped from the start, with or without a store behind')`**. Six versions
of 300 creates and, from the second on, 50 removes, on a database with resident trees, one with
`trees: false` and no store, and one with `trees: false` over a `MemoryKv` written after every
root: the same roots and the same `proofsAt` two versions back each time. `rebuildEstimate().trees`
is more than `1550 * 2000` for the two dropped databases (a leaf of the name tree per live item, 1,800
created and 250 removed, at 1,000 bytes kept and 1,000 thrown away each, and on top the nodes of
the retained versions) and 0 for the resident one: what rebuilding would
take comes from the objects, not from what was resident when the trees went.

**`it('assigns dense ids and serves unique and range lookups')`** (describe `object database`).
Three items get ids `objectId(7, 0)`, `(7, 1)`, `(7, 2)`; `instanceOf(c.id)` is 2. The unique
index finds `bob` by exact name and nothing for the prefix `bo`; the group range lists names in
insertion order. Creating a second `alice` throws `DbError`. Modifying `bob` into group 2 moves
it between ranges; removing `alice` makes `get` and the name lookup `null`; `nextInstance` is 3
and the next item gets instance 3, so ids are never reused.

**`it('undoes and commits nested sessions')`**. `alice` is created and a root taken, so that
the committed view the case reads below is that root's. An outer session modifies `alice` and creates
`bob`; an inner session removes `alice`, creates `carol`, modifies `bob`. `inner.undo()` restores
`alice` to the outer session's value, drops `carol`, resets `bob` and the counter. While the
outer session is open, `getCommitted` still sees the original `alice` and no `bob`, and
`committedNextInstance` is 1: the committed view looks through open sessions. A second inner
session that removes `alice` and commits folds into the outer one; `outer.undo()` then restores
everything to the committed state, including the free name `bob` and the counter.

**`it('undo restores unique keys that were swapped around')`**. Rename `a` to `tmp`, `b` to `a`,
`a` to `b` inside a session; `byName('a')` is now `b`'s id; after `undo` the names are back
where they were. Swapping unique keys is the hard case for an undo log because each step's
old value is another object's new value.

**`it('refuses out-of-order session closes and a root with sessions open')`**. With two sessions
open, undoing the outer one first throws `DbError`, and so does `db.root()`; closing them inner
first works and a root can then be taken.

**`it('roots change with every write and prove inclusion and absence')`**. Five items, then a
root `r1`. For every item `db.proof(id)` verifies with `verifyObjectProof(r1, p)`, and fails
with an extra byte on the value, with another id, or against `sha256(r1)`. An id past the type's
counter gets a proof with `value: null` and no `typeSiblings`: the counter in the type leaf
proves there is no such object, and claiming `nextInstance: 6n` fails. A type with no objects
proves its first id absent. `proofFromBytes(proofToBytes(p))` still verifies. After a modify,
the root changes and the new proof verifies against `r2` but not `r1`. After a remove, the gone
item's proof has `value: null` with `heightFor(5)` siblings (an empty leaf on an ordinary
path), verifies, and fails if a value is claimed.

**`it('keeps proofs valid as the tree grows across powers of two, and matches a from-scratch build')`**.
Forty items added one at a time; every third insertion, every proof so far verifies against the
current root, across the tree's growth through 2, 4, 8, 16 and 32 leaves. A second database
built with the same forty inserts has the same root: the root is a function of the content,
not of the history.

**`it('proofs describe committed state while a session is open')`**. Take a root, open a
session, modify `alice` and create `bob`; `db.proof(alice)` still verifies against the root taken
before, and a proof for `bob`'s id says absent and verifies. Proofs, like `getCommitted`, never
leak uncommitted state.

**`it('snapshots round-trip with the same root and rebuilt indices')`**. Ten items, one removed,
one counter; `encodeSnapshot(12n, r)` loaded into a fresh database reports height 12, the same
root, the removed id `null`, the right counter, working `byName` and `byGroup` lookups, a
verifying proof, and re-encodes to identical bytes.

**`it('matches a naive computation and proves every leaf at every size')`** (describe `dense
merkle tree`). Eleven leaves; a `naive` function hashes pairs level by level with `EMPTY`
padding. For each size 1 to 11 the tree's root equals the naive root and every leaf's `path`
folds back to the root through `rootFromPath`.

**`it('releases chunks whose nodes are all empty, and hashes holes like a fresh tree')`**
(describe `dense merkle tree: chunks and versions`). 4,096 leaves give `chunkCount` 17 (the
comment: 4 + 2 + 1 at levels 0 to 2, one at each level 3 to 12). Clearing the lower half
releases three chunks (14 left), and the root equals that of a fresh tree holding only the
upper half; a path for a live leaf and a path for a hole (`EMPTY` at index 100) both fold to
the root. Clearing everything gives the `EMPTY` root and zero chunks.

**`it('serves paths at past versions inside the window and forgets older ones')`**. A tree
retaining 3 versions; ten versions each grow it and rewrite some leaves. After each,
`lowestVersion` is `max(0, v - 3)`; for every retained version `rootAt` matches the root
recorded then, every leaf's `pathAt(i, old)` folds to that root, and a path beyond that version's
size throws `/beyond size/`; a version outside the window throws `/not available/`.

**`it('reads its chunks through a bounded cache and computes the same roots and paths as a resident tree')`**
(describe `dense merkle tree: dropped`). Two trees retaining three versions, the second
reporting its chunks to a `MemoryKv` after every root. Fourteen versions grow the trees across
chunk boundaries and powers of two (600 leaves, then 250 more each time), rewrite forty random
leaves of which every seventh is emptied, and at version 9 empty a whole chunk. The second tree
is dropped to a `ChunkCache(2)` at versions 3 and 10 and rebuilt at 7. At every version the roots
agree and the cache holds at most two chunks; for every retained version the roots, the paths of
the first, last, chunk-boundary and a random leaf, and a range proof agree; and the tree's
`entries()` equal the resident tree's, so the store holds exactly the chunks the resident tree
would write.

**`it('reproduces at a later version the proofs it made at the time')`** (describe `object
database: versions`). A database with `retainVersions: 5`; twelve versions, each in a session,
create, modify, every fourth remove, a counter at version 6. After each root the proof of every
id is recorded as bytes. For every version still in the window, `proofAt(id, old)` gives bytes
identical to those recorded at the time and still verifies against that version's root; a
version outside the window throws `/not available/`. Finally `getAt` looks through an open
session: after an uncommitted modify, `getAt(ids[11], 11)` still returns the committed value.

**`it('reports what each root changed, for a persistent store')`**. After `root(0)`,
`lastChanges` lists both created objects with bytes and the counter for type 7 at 2. A session
then modifies `a`, creates `c` and removes it again, and an inner session's modify of `b` is
undone; after commit and `root(1)` the change list holds only `a`, and the counter is 3: `c`
consumed an id although it never existed at a root. This is exactly what the LMDB store needs
to persist a version.

**`it('agrees with a reference map under random inserts, overwrites and deletes')`** (describe
`b+ tree`). 60,000 operations from a seeded linear congruential generator over 20,000 keys,
two thirds sets and one third deletes, mirrored in a `Map`. `delete` must return what
`Map.delete` returns; every 5,000 rounds the size and the full sorted scan must match; at the
end every key reads the same value, a key never inserted is `undefined`, and deleting everything
empties the tree.

**`it('scans prefixes and ranges in order after sequential inserts')`**. 5,000 three-byte keys.
The prefix `[0, 3]` yields exactly 256 entries, `v768` to `v1023`; `entriesFrom(keyOf(4990))`
yields the last ten; an unused prefix yields nothing; after deleting the even keys the prefix
`[0, 0]` starts `v1, v3, v5` and the size is 2,500.

**`it('has one shape per key set whatever the history, and proves presence and absence')`**
(describe `sparse merkle tree`). 3,000 random sets and deletes over 400 names; a fresh tree
holding only the final set, inserted in sorted order, has the same `rootHash`. After `commit(1)`
every present key's `prove` folds through `smtProofRoot` to the root with its value; the absent
keys `k400`, `nope` and the empty string fold to the root with `value: null`, and taking the
neighbouring leaf's value and claiming it under the absent key's hash does not fold to the root.
Deleting every key gives the `EMPTY` root, yet a proof for `x` still folds to the version 1
root, which the tree kept.

**`it('keeps past versions inside the window')`**. A tree retaining 2 versions; six commits,
each adding `a_i` and deleting `a_{i-2}`. Versions 3 to 5: `rootAt` matches, `proveAt` shows
`a_i` present with its value and `a_{i-2}` absent; `rootAt(2)` throws `/not available/`.

**`it('counts the nodes its past versions hold while resident, and gives them up with the window')`**.
A resident tree retaining 4 versions takes eight commits, each adding one key and listing its
changes (`commit(i, true)`, the records taken with `takeRecords()`). `historyNodes` is then at
least 4: four past versions, each retained commit having replaced at least the root.
`setWindow(1)` leaves fewer, at least 1, and `setWindow(0)` leaves 0. A second tree whose four
commits do not list their changes counts 0. This is the figure `historyEstimate()` takes for a
resident sparse tree ([09](09-database.md)), so that what the node notes when it trims the
window at `warn` includes the sparse trees' past versions.

**`it('gives the roots and proofs of a resident tree, writing back only the nodes it changed')`**
(describe `sparse merkle tree: dropped`). Two trees retaining three versions, keyed under the
node header of type 9, over a key space of 120 names so that leaves split and collapse often.
Forty versions of 25 random sets and deletes; the second tree is dropped to a `MemoryKv` at
versions 3 and 22, and at version 17 in the middle of the writes, which become pending, and
rebuilt at 12 and 30. Before every commit `get` agrees for every seventh key; every commit's root
equals the resident tree's; the nodes the dropped tree reports, written to the store, leave it
holding exactly the resident tree's `entries()`; `lowestVersion` agrees; and for every retained
version `rootAt` and the proofs of 26 keys, present and absent, agree sibling for sibling.

**`it('proves index keys and rebuilds index versions from history')`** (describe `object
database: key proofs`). A database with `retainVersions: 4`; eight versions each create `n_v`,
rename `n_{v-2}` to `r_{v-2}` and remove the object from four versions earlier. At each root,
`verifyKeyProof` of the fresh name returns the encoded object id and the gone names return
`null`, and the bytes of four key proofs are recorded. Then the test does what a restart does:
exports the objects and counters into a fresh database, checks its root at version 7 matches,
loads every version's `HistoryRecord` with `loadHistory` and calls `rebuildIndexVersions`. For
every version in the window, the rebuilt key proofs are byte-identical to the recorded ones, and
so are the object proofs. This is the replay of every key, which a restart now uses only as
its fallback (`restoreIndexVersions`, tested under `past versions from the store` below); the
case keeps it tested on its own. The history records are captured by the `keyProofBytes` helper into a
module-level `histories` array as a side effect of each call; the comment `// filled below`
marks it.

**`it('proves an entry of a non-unique index present or absent, by its key and the id of its object')`**.
Two items in group 5 and one in group 6. Each is proven under `byGroup` by the entry key, the
group followed by the item's id, and the value proven is the id. An item under another group
than its own is proven absent, and so is the group's key alone, which is no entry. The proof
names index position 1, and with position 0 it does not verify. Changing an item's value leaves
the index's root as it was while the state root moves; changing its group and removing the
other item moves it, the old entries are proven absent and the new one present, and the entry
removed is still proven as of the version before. A database filled from the exported objects
has the same root.

**`` it(`forgets the older versions at once, answers the same for the ones it keeps, and grows back (trees ...)`) ``**
(describe `object database: a trimmed history window`). Two cases from one loop, with the
Merkle trees resident and with them dropped. Two databases with `retainVersions: 8` and no
history store, `whole` and `trimmed`, take the same step at every version: forty creates, and from version 1 ten
removes and a modify among the previous version's items, and the counter object set to the
version. After versions 0 to 12 the roots agree, `trimmed.lowestVersion` is 4 and
`historyEstimate()` is above zero. Then `trimmed.setHistoryWindow(2)`: `memory()` reports
`history: 'trimmed'`, `historyWindow: 2` and `lowestVersion: 10`, the estimate has fallen,
`proofsAt` for versions 10, 11 and 12 is the same string as `whole`'s, and `proofAt`, `getAt`
and `proveKeyAt` at version 9 each throw `/not available/`. Versions 13 to 15: the roots agree,
`trimmed.lastChanges.history` equals `whole`'s at each (the record for the store is complete
whatever the window), `lowestVersion` is `v - 2`, the three versions in the window prove the
same, and `rootAt(v - 3)` throws. `lastStaleVersion` is 7, counted from the retention of 8.
Then `setHistoryWindow(Infinity)`: `memory()` says `resident` with a window of 8 but
`lowestVersion` is still 13, and through versions 16 to 26 it is `max(13, v - 8)`, every
version from there to `v` proving as `whole` does, until both databases report the same lowest
version. Last, the window is set to 3 and the trees are dropped (in the dropped run, rebuilt):
versions 23 to 26 still prove the same, and after version 27, versions 24 to 27. This is
`setHistoryWindow` and the `setWindow` of both kinds of tree, with the fix to the three prune
loops for several versions pruned at once. The refusals at version 9 are those of a database
that has only its window in memory; the next describe gives it the store's records.

**`` it(`answers for every version the store has a record of, whatever the window in memory holds (trees ...)`) ``**
(describe `object database: past versions from the store`). Again two cases from one loop,
trees resident and dropped. The describe's own `persist(db, kv)` does what the application's
commit does for history: it writes the last root's index and tree changes to a `MemoryKv`,
puts the root's history record under `historyKey(version)` (`0x68` and the version), deletes
the record of `db.lastStaleVersion`, and calls `dropChanges()`. `step` is the step of the
trimmed-window test with one thing added: from version 2 a name passes from one item to
another, so that a sparse tree leaf changes hands within one version. `whole` has
`retainVersions: 8` and no store; `paged` has the same retention, the `MemoryKv` as its index
store and `historyStore: (v) => kv.get(historyKey(v))`. The check `same(v)` requires that
`paged.lowestVersion` equals `whole`'s, that for every version from there to `v` `proofsAt`
gives the same string and six items read with `getAt` have the same values, and that
`rootAt` one version below the lowest throws `/not available/`. After versions 0 to 12,
`paged.setHistoryWindow(2)` and then `setHistoryWindow(0)`: each time `memory()` reports
`history: 'trimmed'`, the window asked for and `lowestVersion: 4`, which trimming has not
moved, the estimate has fallen, and `same(12)` holds, every proof below the window coming
from the records in the store. Versions 13 to 16: `same(v)` is checked before `persist` as
well as after, so a root whose record the store does not have yet is answered from the
pending change list. Then `setHistoryWindow(Infinity)` and versions 17 to 22: the window in
memory takes over from the records one version at a time and `same(v)` holds throughout,
also across a `dropTrees()` (or, in the dropped run, a `rebuildTrees()`) at version 19. Last,
the record of version 20 is deleted from the store behind the database's back and the window
set to 0: `rootAt(21)` is still `whole`'s, since no record at or below 21 is needed for it,
and `rootAt(19)` and `proofAt` of an item at version 19 each throw
`/no history record of version 20/`. The database keeps the list of the versions that have a
record and scans exactly those, so a record the store does not return is a refusal and not
an answer from what is left, in which whatever version 20 overwrote would be read as it is
now. This is `past()` and `scanHistory` of [chapter 9](09-database.md).

**`` it(`gives a reopened database its sparse trees' past versions from the records, or by replay without them (trees ...)`) ``**.
Two more cases from the same loop. A database with `retainVersions: 8`, the `MemoryKv` as its
index store and its history store, takes versions 0 to 12 with `persist` after each. Then,
once for `'records'` and once for `'replay'`, the test does what a restart does on a copy of
the store: a fresh database over the copy imports the exported objects as indexed
(`importObject(id, bytes, true)`), takes the counters, loads the trees and the index entries
from the store (`loadTrees(true)`, `loadIndexEntries(true)`), computes the root of version
12, which must be the first database's, and calls `dropChanges()`. The records of versions 5
to 12 are decoded from the store and given to `loadHistory`; in the `'replay'` pass the
record of version 9 is given with `nodes: null`, as a record written before the sparse nodes
were kept. `restoreIndexVersions()` must return `'records'` in the first pass and `'replay'`
in the second: one record without its list and nothing is taken from the records. Either
way `lowestVersion` is the first database's, and for every version from there to 12
`proofsAt` gives the same string and the six items read with `getAt` have the same values.
Then the reopened database goes on: a third database with no store runs versions 0 to 15,
and from version 13 the reopened one takes the same step with the same root, persists, and
proves every version of the window as the third does, with `rootAt` one below the lowest
throwing `/not available/`, so the past versions it was given move out of the window as
they should. This is `restoreIndexVersions` and `SparseMerkleTree.loadVersions` of
[chapter 9](09-database.md), with resident trees (each older version built against the next
newer one) and with dropped ones (the records kept as the tree's own history).

**`it('lists what a past version held of a type whose objects were removed since, from memory and from the store')`**.
A database with `retainVersions: 8`, the `MemoryKv` as its index store and its history store
takes versions 0 to 5 with `persist` after each: 240 items made, and from version 1 ten of
the version before removed at each. `live()` is the items that exist now, from
`exportObjects()`; `heldAt(v)` joins them with `changedSince(ItemType, v)`, reads each id with
`getAt` at `v`, keeps the ones that are not `null` and sorts their instance numbers. `heldAt(2)`
must be the 100 items version 2 held: the 120 made by then less the ten version 1 removed and
the ten version 2 removed. The items of now alone give 90 of them, since version 3 removed
ten: an index of now cannot answer for then, which is the case `changedSince` exists for.
`changedSince(ItemType, 5)` is empty, nothing having changed since the current version, and
`changedSince(CounterType, 4)` is the one counter object, which every version modifies. Then
`setHistoryWindow(0)`, so that no past version is in memory: `heldAt(2)` is the same list,
now from the store's records, `heldAt(4)` has 160 items (200 made less 40 removed), and
`changedSince(ItemType, 6)`, a version that does not exist, throws `/not available/`. Last a
session removes item 201: `changedSince(ItemType, 5)` is that one id, the removal of the
block in progress, and the session is undone. This is `changedSince` of
[chapter 9](09-database.md), which the RPC's `validator` and `delegation` use for a past
height ([chapter 12](12-rpc.md)).

**`it('reads a record written before the sparse tree nodes were kept, and refuses to prove a key from it')`**.
A database with a history store runs versions 0 to 3, and after each `persist` the test
overwrites the stored record with the bytes an earlier build wrote: the same record encoded
with `nodes: null`, less its last byte, so that it ends after the counters. The root at
version 1 and the counter object's proof at version 1 are noted, then `setHistoryWindow(0)`.
`decodeHistory` of the stored record of version 2 gives `nodes: null`. `rootAt(1)` and the
counter's proof are what they were: the dense trees, the objects and the counters are in the
old records, and `CounterType` has no authenticated index, so its proof needs no sparse tree
node. `proveKeyAt` on `byName` and `proofAt` of an item, whose type leaf carries the root of
`byName`, each throw `/not available/`.

**`it('reads released objects from the store, gives the same roots and proofs, and takes written objects back')`**
(describe `object database: an arena within a byte limit`). `persistObjects(db, kv)` writes a
root's objects under `0x6f` keys and its index and tree changes to a `MemoryKv`, as the
application does, then calls `dropChanges()`; `objectStore(kv)` reads one object back by id.
`whole` has no store; `bounded` has the store as `indexStore` and `objectStore`, `arenaBytes: 0`
and `hotObjects: 50`. Six versions of 4,000 items with 40 bytes of padding in their names, and
from version 1 three hundred removes and three hundred modifies that also move the item to
group 9. At each version the roots agree; `setArenaLimit(0)` called before the store has the
root leaves `storedObjects` unchanged, since the bytes are nowhere else; after
`persistObjects`, the proofs at the current version are the same string as `whole`'s. At the
end `arenaLimit` is 0, the arena is one slab, more than 15,000 objects are stored, and `whole`
reports `arenaLimit: Infinity, storedObjects: 0`. Every read agrees: eight ids by `get`, a
name by lookup, group 9 by scan, a past value by `getAt`, `exportObjects()` and
`encodeSnapshot`. In both databases a session modifies one stored object and removes another
and is undone, then one is renamed and one removed for good; the root at version 6 agrees and
`storedObjects` is down by exactly two. After the write the removed one reads `null`, the
renamed one is found by its new name, and the proofs agree. `setArenaLimit(Infinity)` releases
nothing more, and with one object deleted from the store its `get` throws
`/neither in the arena nor in the store/`.

**`it('ignores the limit without a store to read from')`**. A database with `arenaBytes: 0` and
no object store: 12,000 items, a root, `dropChanges()` and `setArenaLimit(0)` leave
`storedObjects: 0`, `arenaLimit: Infinity` and more than one slab.

Three earlier cases of this file are not described above; by title: "keeps the budget when the
cached objects sit far apart among the instances, as after churn", "undoes a session in
proportion to what it created, not to the objects already cached" (both under `object
database: arena and hot cache`) and "estimates a rebuild of the sparse trees with the versions
it must build as well as the current one".

### test/network.test.ts

Six tests on `src/p2p` ([the p2p chapter](06-p2p.md)) without consensus: a `Network` with a
`PeerDb`, over the in-memory hub and over TCP. `makeNet` builds one with a chain id, a node key
from a seed, seeds, a height to report, and short timers (connect every 50 ms, ping every
200 ms, idle after 1,000 ms); every network is stopped in `afterEach`.

**`it('handshakes, exchanges status and addresses, and pings')`** (describe `p2p over the
in-memory transport`). `a` reports height 7; `b` seeds from `a`; `c` seeds only from `b`. All
three must reach two peers each, which `c` can only do by learning `a`'s address from `b`.
`b`'s record of `a` shows height 7 and listen address `a:1`; after 500 ms its `latencyMs` is
non-negative and `lastRecv` is within the last 500 ms, so pings are flowing.

**`it('delivers a message sent the instant a peer connects, while the other side is still verifying the handshake')`**.
`a` gets a verifier whose `verifyOne` sleeps 100 ms before answering, as a busy worker pool
would. `b` sends `{ type: 'status', height: 42n }` from its `onPeer` callback, the earliest
possible moment. `a`'s `status` handler must see 42. This guards review finding 33: frames
received while a handshake is still being verified are held and delivered afterwards, not
dropped.

**`it('rejects a peer on another chain and a connection to itself')`**. Chains `one` and `two`:
`b.connect('a:1')` rejects with `/wrong chain/`, `a.connect('a:1')` rejects with `/self/`, and
`a` has no peers.

**`it('a simultaneous dial leaves exactly one connection on each side')`**. With 20 ms of hub
latency, `a` and `b` dial each other at once. At least one dial fulfils; after 200 ms each side
has exactly one peer, and the two sides disagree on `direction` (one inbound, one outbound).
The duplicate-connection rule is what keeps a mesh from doubling every link.

**`it('drops a peer that goes silent')`**. After `b` connects to `a`, `hub.partition` cuts them;
within 3 s `a` has no peers, because the idle timeout of 1,000 ms expired without a ping.

**`it('handshakes over real sockets and delivers framed messages')`** (describe `p2p over TCP`).
Two `TcpTransport` networks on `127.0.0.1:38881` and `38882`; they handshake, `b` sends a
status to `a`, `a` receives 42, and `b` knows `a`'s height 3. The one case that checks a handshake and
a framed message over real p2p sockets (`review5-net` dials a TCP address and `review5-rpc`
starts a whole node through the CLI).

### test/consensus.test.ts

Eight tests on the engine ([04](04-consensus.md), [05](05-mempool-executor.md),
[08](08-node.md)) with the toy key-value application: four validators of power 10, in one
process, on the in-memory hub. Each scenario is a few lines because the harness does the rest.

**`it('four validators commit blocks and agree on them')`**. Wait for height 5 everywhere; the
hash of block 3 is the same on all four nodes; every stored commit for height 3 carries at
least three non-null signatures:

```ts
      expect(commit.signatures.filter((s) => s !== null).length).toBeGreaterThanOrEqual(3);
```

Three of four at equal power is 30 of 40, strictly more than two thirds: the +2/3 rule in
evidence.

**`it('transactions gossip to every node and land in state')`**. `hello=world` submitted at
node 0 is `'added'`; within 15 s every node's app reads `hello` as `world`, so the transaction
was gossiped, included and executed everywhere. `no-equals-sign` is `'invalid'` at admission.

**`it('keeps going with one of four validators down')`**. Node 3 is created but never started;
the other three reach height 4. Liveness with one of four down.

**`it('halts with two of four validators down')`**. Nodes 2 and 3 never start; after a fixed
three-second `sleep`, nodes 0 and 1 are still at height 0. Two of four is half the power, short
of +2/3, so no block can be committed; this is the one place a sleep is the right tool, because
the claim is that nothing happens.

**`it('halts during a partition and resumes without divergence after healing')`**. At height 2
the hub partitions `{0, 1}` from `{2, 3}`. After three seconds each node has advanced by at most
one height (a block that was already in flight). After `heal()`, everyone reaches three heights
beyond the highest seen during the partition, and the block at that height has one hash on all
four nodes. Safety: a partition stalls the chain, it never forks it.

**`it('a late-joining full node catches up through block sync')`**. Four validators and one full
node not started. Once the validators are at 5, the full node starts and reaches 5 with
`blockSync.synced` at least 3 (it fetched blocks rather than watching them being made), then
follows live consensus for three more heights, and its block at a shared height matches node
0's.

**`it('adds a validator through the application and it starts signing')`**. The fifth node was
created as a full node; it is stopped and recreated with `validatorSeed: net.validatorSeed(4)`.
A `val:<its key>:10` transaction grows the set on node 0 to 5. The change takes effect after the
block that carried it, so the test waits for `activeAt + 3` and inspects the commit at
`activeAt + 2`: five signature slots, and the newcomer's slot, found through
`validatorSetAtHeight(...).indexOf(address)`, is not `null`. A validator set change made by the
application reaches the engine and the newcomer really signs.

**`it('removes a validator and the set shrinks')`**. `val:<node 3's key>:0` shrinks every node's
set to 3; the commit two heights later has three signature slots.

### test/recovery.test.ts

Three tests on what survives a restart, on how a block reaches the store and on evidence
([05](05-mempool-executor.md), [04](04-consensus.md)), the first and the last on the key-value
application and the second on the core application.

**`it('a validator restarted from disk resumes with its state, key guard and app intact')`**.
Node 0 alone gets a data directory. After a transaction lands, node 0 stops at `stoppedAt`; the
other three keep going three more heights. `net.makeNode(0, { dataDir })` reopens it: before
`start()` its `height` is already `stoppedAt` and the app already has `persist=yes`, both read
back from LMDB and `app.json`. After starting it catches up five heights, and within 20 heights
a commit on node 1 carries its signature at its index: the restarted validator is voting again,
which it could only do if its sign state (the double-sign guard, `priv_validator_state.bin`)
came back consistent with what it had signed. Its block at the catch-up height matches node 1's.

**`it("saves a block and the application's state in one store transaction when the node holds the application, and in two otherwise")`**.
The executor saves a block and has the application commit inside one transaction of the
environment when the node created the application itself, and one after the other when the
application was handed in ([05](05-mempool-executor.md), `doApply`). The test sees which by
wrapping a `MemoryEnv` in a `KvEnv` of its own, `noting()`: its `transaction(fn)` counts the
call and keeps a depth while `fn` runs, and every store it hands out records, at each `write`,
the store's name and `inside` or `alone` according to that depth. A one-validator chain of the
core application (one faucet account, no inflation) is made unstarted, and `run(env, app)`
makes node 0 over the given environment, with a fresh `MemorySignStateStore` since each run is a
chain from genesis, starts it, waits for height 3 and stops it. First
with `app` undefined, so the node builds its own `CoreApp` on the environment's `app` store: at
least six writes were made inside a transaction, there were exactly half as many transactions
as such writes, and they alternate `chain inside`, `app inside`, the chain's writes first, as
the persistence order has them. Exactly one application write was made outside a transaction,
the one that stored genesis. Then with a `CoreApp` constructed by the test over a separate
`MemoryKv`: the environment saw no transaction at all, and every write it saw, at least three,
is `chain alone`, since that application's store is not in the environment and the executor
was given no `transaction`. In memory the two orders leave the same state, which is why the
test looks at the calls; on LMDB the first is one flush to the device per block and the second
two.

**`it('double-sign evidence is built, included in a block, and handed to the app')`**. The test
holds validator 3's key (`keyPairFromSeed(net.validatorSeed(3))`) and forges two prevotes at the
current consensus height and round 0 for two different block hashes, signed with the vote
context. Both go into node 0's consensus through `handleVote`; the evidence pool holds one
piece. Within 20 s every node's app has a `slashed` entry for the victim at that height: the
evidence was proposed in a block, validated by everyone and handed to the application through
`finalizeBlock`'s `misbehavior`. Node 0's pool is then empty.

### test/engine.test.ts

Four tests, under `describe('engine changes for staking')`, on engine behaviour that the staking
rules depend on ([04](04-consensus.md), [03](03-types.md)): fuller commits, evidence age,
protocol version and genesis validation.

**`it('folds a precommit that arrives after the decision into the stored commit')`**. With
`commitMs: 1500`, so the node stays inside the commit step long enough, validator 3 is isolated
and the other three decide a height with three signatures. The test asserts
`node.consensus.height` is still that height (still inside the commit timeout), forges validator
3's precommit for the decided block at the commit's round, and feeds it in. The stored commit
now has four signatures with validator 3's slot filled. This matters for staking: a validator
whose precommit arrived a moment late must not be recorded as absent and counted toward
downtime.

**`it('drops evidence older than the configured age by block time, and keeps young evidence')`**.
`limits: { maxEvidenceAgeMs: 3000n }`; the test waits until the latest block's time is more than
3.5 s past the time of height 2, then forges duplicate prevotes at height 2 and adds the
evidence to node 0's pool (`add` returns `true`). Within eight heights the pool is empty and no
app has slashed anyone: the executor prunes the pool after every commit, on every node, and a
proposer prunes before it picks evidence, so the stale piece was found too old by block time and
dropped, and no block carried it. Evidence forged at the current height
does reach every app.

**`it('rejects a block from another protocol version')`**. The latest block with
`header.version + 1` fails `validateBlockStructure` with `/protocol version/`; the state's
`version` is `PROTOCOL_VERSION`; `lastResultsHash` is 32 bytes.

**`it('refuses a genesis with no validators from either side')`**. `genesisState` with no
engine validators and no application-supplied set throws `/no validators/`, and so does an
empty application set.

### test/memory.test.ts

Six tests on the memory guard and the collection scheduler of `src/node/memory.ts`
([08](08-node.md)): four unit tests under `describe('memory guard')`, where the heap is
whatever the test says it is, and two network tests under `describe('a node under memory
pressure')`, on the core application so that the guard's dial on the object database can be
checked, with an `RpcServer` stopped before the testnet in `afterEach`. The `stats`
helper makes a sample from a heap-used figure against a limit of 1,000:

```ts
const stats = (heapUsed: number, heapLimit = 1000): MemoryStats => ({ heapUsed, heapLimit, heapTotal: heapLimit, arrayBuffers: 0, external: 0, rss: heapUsed });
```

**`it('moves through its levels with hysteresis and reports every change')`**. A `MemoryGuard`
whose `stats` reads a variable and whose `onLevel` records each level. `check()` at 699 is
`ok` and at 700 `warn`; 849 is `warn` and 850 `pressure`; 960 is `critical`. Down again: 900
is still `critical` and 899 `pressure`; 800 still `pressure` and 799 `warn`; 650 still `warn`
and 649 `ok`. Every level is left 50 below the threshold it was entered at, the 5%
hysteresis, so a heap hovering at a threshold does not flap. Then 999 goes straight to
`critical` and 0 straight to `ok`: several levels in one sample, both ways. The reported
sequence is exactly `['warn', 'pressure', 'critical', 'pressure', 'warn', 'ok', 'critical', 'ok']`
and the guard's `stats` is the last sample. Thresholds that do not rise (`warnAt: 0.9,
pressureAt: 0.8`) throw `/thresholds/`, and a real `memoryStats()` reports a limit above the
heap in use.

**`it('takes its levels from the old generation when the sample gives it, whatever the young generation holds')`**.
The samples here carry `heapOld` beside the helper's fields, as a process under
`--max-old-space-size` reports them. With `heapUsed` at 990 of 1,000 and `heapOld` at 100,
`check()` is `ok`: 99% by the whole heap, 10% by the old generation, and the guard goes by
the second. With `heapOld` at 860 it is `pressure`, and the logged fields carry
`level: 'pressure'` and `heap: '0/0 MiB'`, the figures being bytes here. A sample of 400 MiB
used and 300 MiB old against a limit of 1,000 MiB brings it back to `ok` with
`heap: '300/1000 MiB'` in the log: the log reports the figure the level was taken from.
`heapInUse` of that sample is the 300 MiB, and of a sample without `heapOld`, `stats(7)`, it
is `heapUsed`, 7. Last the process's own sample: `memoryStats().heapOld` is undefined exactly
when `heapLimitFlag()` is null, and when present it is no more than `heapUsed`.

**`it('schedules a minor collection after every commit and a major one once the heap has grown enough')`**.
A `GcScheduler` with an injected `gc` that records `type/execution` and returns a promise for
an asynchronous call, `majorGrowthBytes: 50` and no observer. `afterCommit()` is one
`minor/sync`; at a heap of 149, 49 above the start, a second commit is another minor and no
major; at 150 the third commit adds `major/async`. The growth is measured from the heap after
the last major collection: 199 gives no second major and 200 does. A second scheduler with
`majorGrowthBytes: 500` on a limit of 1,000 runs a major at a heap of 300, because a tenth of
the limit, 100, caps the step. `stats()` of the first reports `scheduledMinor: 5` and
`scheduledMajor: 2`. With `gc: null`, `afterCommit()` and `major()` do nothing and `stats()`
says `available: false`: a node without `--expose-gc` is reported, not broken.

**`it('counts the collections V8 runs, scheduled or not')`**. A scheduler with `gc: null` and
the observer on; 300,000 small objects are allocated and dropped, enough garbage for several
young-generation collections, and the test waits up to 5 s for `stats().collections` to pass
zero. The kinds counted (`minor + major + incremental`) and `totalMs` are above zero, and
`maxMs` is at least `lastMs`. This is the `PerformanceObserver` on `gc` entries, which counts
what V8 does on its own as well as what the scheduler asks for.

**`it('sheds load, keeps following the chain, and resumes when the heap eases')`**. A testnet
of the core application (`appFor` makes a `CoreApp`, and the application genesis holds one
faucet account and no inflation): two validators and a full node that is created but not
started, then made again with
`net.makeNode(2, { indexTrees: 'memory', memory: { stats: () => stats(heap, limit), intervalMs: 20 }, log: (_level, msg) => void logged.push(msg) })`, so its
index trees are in memory whatever the mode of the run (the case is about dropping and
rebuilding them), its guard samples an invented heap against an invented limit fifty times a
second, and `logged` holds every message the node logs; an `onMemory`
listener records the levels and an `RpcServer` is opened on it. At height 2 the level is `ok`,
the database's `hotLimit` is `Infinity`, and `status.memory` is `{ level: 'ok', shedding: false }`.
The heap is set to 750, 75% of the limit: within 5 s the level is `warn`, `isShedding` is
false, and `memory()` reports `indexTrees: 'dropped'`, `trees: 'resident'` (`'dropped'` under
`TREES=0`, where they never were resident) and `history: 'trimmed'` with `historyWindow: 2`. At `warn` the node pages what its blocks do not
need and sheds nothing: the `hotLimit` is 100,000, `mempool.currentLimit` is `maxTxs / 2`, and
`block`, a costly method, still answers.
Then the heap is set to 900, 90% of the limit: within 5 s `isShedding` is true, the level is
`pressure`, the `hotLimit` is 10,000 and the cache holds no more than that (the first dial: the
cache of decoded objects capped, the excess evicted at once), `memory().indexTrees` is still
`dropped` and `memory().trees` now is too (every index read goes to the store
through the overlay, every root and proof reads its paths from the store), `memory()` still reports
`history: 'trimmed'` with `historyWindow: 2` (the window of past versions cut to
the last two, as from `warn`), `mempool.paused` is false and `mempool.currentLimit` is `maxTxs / 10` (the
limit follows the level; the pool is not paused), and with the limit set to zero by the test
`submitTx` answers `full` and `broadcastTx` over the RPC rejects with `-32004` (the server
serves broadcasts while the node sheds and the mempool's limit is the throttle: a full pool is
"try again", not a bad transaction); the test puts the limit back, and the same broadcast
rejects with `-32002`, taken to the application, which refuses the bytes; `block`, a costly
method the server does refuse while the node sheds, rejects with `-32004`;
`GET /events` is 503, `/health` reports `memory: 'pressure'`, and `status.memory` is
`{ level: 'pressure', shedding: true, heapUsed: 900, database: { objects: 'capped', indexTrees: 'dropped', trees: 'dropped' } }`.
Then the claims that matter: the node advances two more heights while shedding, because
consensus and block sync are not what is shed, and its blocks ran against the dropped trees, so
a hash that differed from the validators' would have stopped it there; and an object proof of
the faucet at its height, read from the dropped trees, is byte for byte the proof a validator
with its trees resident makes at the same height. Then the heap eases, but not far enough: the
limit is set to four times what `rebuildEstimate()` says the cheaper of the two tiers would
take (both estimates are above zero) and the heap to 40% of it. That leaves 30% of the limit to
the warn line, which would hold the cheaper tier's 25%, and 10% to half the limit, which holds
neither: the room a rebuild is given is what is left to half the limit (`Node.REBUILD_FILL`),
so a node that rebuilt here would be measuring to the warn line. Within 5 s shedding ends, the level is `ok`, the mempool's limit is `maxTxs` again and the
`hotLimit` is `Infinity` again, and 100 ms later, five samples, both tiers are still `dropped`
and the line `memory: staying paged` has not been logged: nothing is even considered yet,
because the node waits at `ok` for as many samples as it had run before the drop (a few
seconds of them here), a load that filled the heap once being likely to fill it again. Within
30 s the wait is over, the node finds no room and logs the line; 200 ms and ten samples later
it has still logged it exactly once, and both tiers are still `dropped`:
the node runs on the fallbacks at `ok` rather than take the heap straight back up. At 20% of the
limit the next samples rebuild them, `trees` and then `indexTrees` read `resident`, and with both
back and room left `memory().history` reads `resident` again within 5 s (the window is let
grow back last), `accountByName('faucet')` answers from the rebuilt index, `submitTx` answers
something other than `full` (the test's key-value transaction is refused by the core
application, not by the limit), and `block` answers. At 99% the `critical` level is reported; what to do then (the CLI
stops the node) is the caller's, not the node's. The sequence seen is exactly
`['warn', 'pressure', 'ok', 'critical']`: 90% to 40% is straight to `ok` and 20% to 99% straight
to `critical`, one sample crossing several thresholds each way.

**`it('keeps as many past versions in memory as retain.memoryVersions says, proves the older ones from the store, and leaves the index trees there when told to')`**.
One validator of the core application, created but not started and then made again with
`net.makeNode(0, { retain: { memoryVersions: 3 }, indexTrees: 'store' })`. At height 8 its database reports
`history: 'trimmed'` with `historyWindow: 3`, with no guard level involved. With
`indexTrees: 'store'` the secondary indices are read from the store from the start:
`memory().indexTrees` is `dropped`, `accountByName('faucet')` finds the account, and 300 ms
later the trees are still `dropped`, since nothing waits to be rebuilt. The provable
window is the store's, not the memory's: `lowestProvableHeight` is at least six heights
below the latest, `proofAt` gives a proof of the faucet account at the height six back, and
`rootAt` gives a 32-byte root there, both read from the store's history records.

### test/chain.test.ts

One long test that runs the core application ([the application chapter](11-application.md))
on a live network and checks proofs across nodes, with a light client
([13](13-light-client.md)) at the end. Four validators and one full node, each with a
`CoreApp`; the genesis has one `faucet` account.

**`it('gossips signed transactions, agrees on state, and proves it against the next header')`**.
The faucet registers `alice` (`accountCreate`, fees filled by `withFees(..., DEFAULT_FEES)`,
signed by the faucet key); the transaction is `'added'` and alice exists on every node. A
transfer from the faucet signed with alice's key is `'invalid'` at the mempool: a wrong
signature never enters. A real transfer of 12,345 lands everywhere, and the set of app hashes
across the five nodes has at most two members, because nodes may be one block apart.

Then the proof check across nodes. `app.proof(aliceId)` is taken on node 2 at its height `h`.
The state after block `h` is committed in header `h + 1` (deferred app hash, chapter
[03](03-types.md)), so the test waits for `h + 1` and checks on every node:

```ts
      const header = n.store.loadBlock(h + 1n)!.block.header;
      expect(verifyObjectProof(header.appHash, proof)).toBe(true);
```

A proof made by one node verifies against the header every other node holds, including the
full node that never voted; the value decodes to an account named `alice`. `node.queryState`
returns the header, commit and proof together as the RPC would; `verifyStateQuery` with the
validator set at `h + 1` passes, fails with `/proof/` when the value is nulled, and with
`/height/` when the header and commit of another height are substituted. A past height
(`h - 1`) and the latest height verify too. `queryAccountName('alice')` verifies through
`verifyKeyQuery` to the encoded id, and `bob` to `{ value: null }`, a provable absence.

A `LightClient` trusts height 2 by its header hash through a `NodeProvider` on the full node:
`verifyState(q)` passes and the client's trusted header advances to `h + 1`; `verifyKey` returns
alice's id; a query whose header has a zeroed app hash fails with `/not the verified one/`; a
wrong trusted hash is refused with `/trusted hash/`. `queryTx(txHash(pay))` carries a result
proof; `verifyTxQuery` with the sets at `H` and `H + 1` returns `{ ok: true, error: '' }`, and
substituting the `create` bytes into the transaction proof reports `failed: true`; a fresh light
client's `verifyTx` agrees; an unknown hash gives `null`. Finally, on every node, the faucet's
history is `['accountCreate', 'transfer']`, every entry an operation with a transaction hash, and
alice's history in descending order has sequences `[1n, 0n]` with the latest entry's hash equal
to the transfer's.

### test/app.test.ts

Twenty-three unit tests on `CoreApp` ([11](11-application.md)) with no network: one genesis
validator, a faucet with one billion base units, zero inflation and no block reward, so every
balance is predictable. `block(app, txs)` calls `finalizeBlock` then `commit` with
`blockTime(h) = genesisTime + 1000n * h`. `tx(ops, keys, expiration)` signs with
`DEFAULT_FEES` and an expiration a minute after genesis. `FEES` holds what the default schedule
charges for a transfer and for registering the premium name `alice`. `withAlice()` is the common
fixture: alice registered at height 1 and paid 5,000 at height 2. Twelve cases under
`describe('core application')` cover the account and asset layer; six more under
`describe('core application: index entries in the store')` cover what the application writes
for the database's index and tree tiers and how it reopens from them.

**`it('starts from genesis with the core asset and the faucet')`**. The faucet is `3.0` with its
genesis balance; the core asset is `CORE`, its supply equals the faucet's balance, its issuer is
the faucet; height is 0; a proof of the faucet verifies against `lastAppHash`; `nobody` and a
name containing a NUL byte resolve to `null`.

**`it('creates accounts and transfers, charging flat fees into the fee pool')`**. `checkTx` of
the registration is `{ ok: true }`; block 1 creates alice as `3.1` with the faucet as registrar
and charges the faucet `FEES.accountCreate`; block 2 pays her 5,000 plus a transfer fee; block 3
has alice pay 100 back and pay her own fee. The community pool holds exactly
`FEES.accountCreate + 2n * FEES.transfer`, height is 3, and the `appHash` returned by
`finalizeBlock` equals `lastAppHash` after commit.

**`it('rejects malformed, unsigned, foreign-key and forged signatures')`**. Eleven `checkTx`
calls: random bytes are `/malformed/`; no signatures, bob's key and the faucet's key on alice's
transfer are `/no signatures/` and `/no required authority/`; alice signing twice is
`/duplicate signature/`; one flipped bit in a valid signature is `/invalid signature/`; the
valid version is `ok`; a transfer to an account that does not exist is `/does not exist/`;
`Alice` is not a valid `/account name/`; `alice` again is `/taken/`; an authority with threshold
2 and one key of weight 1 can `/never be satisfied/`.

**`it('honours multisig thresholds, account authorities, and owner versus active')`**. Two more
accounts: `multi`, whose active authority needs two of alice, bob and carol and whose owner is
dave; and `child`, whose active authority is alice's account and whose owner is carol. Alice
alone is `/missing active authority of multi/`; alice and carol pass; dave alone passes, because
the owner authority satisfies active. For `child`, alice's key passes through the account
authority, carol's as owner, bob's not at all. Changing `child`'s owner needs the owner: alice
is `/missing owner authority of child/`, carol's block succeeds, after which bob (the new
owner) passes and carol no longer does.

**`it('enforces expiration and refuses replays until the id is forgotten')`**. With `now` the
time of block 2, an expiration of `now` is `/expired/` and `now + 3_600_001n` is `/too far/` (an
hour is the maximum). A transfer expiring at `now + 5_000n` included twice in one block gives
`[true, false]` with `/duplicate/`, and `checkTx` of it afterwards is `/duplicate/`. This is
replay protection: the chain remembers the id of every transaction until its expiration, so
the same bytes cannot be executed twice. Blocks 4 to 6 keep three `RecentTx` objects (the two
from setup live a minute); block 7, whose time reaches the expiration, prunes it to two, and the
transaction is now `/expired/` rather than duplicate: forgotten, but still unreplayable.

**`it('checks pending transactions in sequence and starts over after each block')`**. Two
transfers that each spend 3,000 of alice's 5,000. `checkTx(t1)` is `ok`; `checkTx(t2)` is
`/insufficient CORE/`, because admission runs against a pending session that already holds
`t1`; the committed balance is still 5,000. After an empty block the pending view resets and
`t2` passes on its own. A block with both gives `[true, false]`.

**`it('creates and issues user assets up to the max supply')`**. `assetCreate ALICE` is
`/insufficient CORE/` until alice is funded; then the asset is `4.1`. The faucet trying to issue
it is `/only the issuer/`. Issues of 600, 500 and 400 against a max supply of 1,000 give
`[true, false, true]`, the middle one `/exceed the max supply/`; balances, `currentSupply` and
the `byAsset` range of holders (`faucet` 600, `alice` 400) all agree.

**`it('proves objects against the app hash')`**. Alice's proof verifies and decodes to her
name; an id with no object (`3.50`) proves absent. After one more transfer, the old proof fails
against the new app hash although alice's account object did not change (the balance and
dynamic objects did, so the top tree moved), and fresh proofs for her account and her balance
object verify.

**`it('proves past heights inside the retention window')`**. `retainVersions: 4`; four transfers
of 10 at heights 3 to 6, recording the app hash after each. `lowestProvableHeight` is 2. For
each height 2 to 6, `proofAt(balance.id, h)` verifies against that height's hash and decodes to
`5000n - (h - 2n) * (10n + FEES.transfer)`; alice's account and a `recentTx` object are
provable too. Height 1 throws `/not available/`, and a proof at height 4 does not verify against
the hash of height 3.

**`it('proves account names present and absent, now and at past heights')`**. `proveAccountName`
for `alice` and `faucet` verifies to their encoded ids; `bob`, `alice.sub` and asset `NOPE` are
`null` (provably absent); `CORE` resolves to the core asset. Tampering: a different key is at
most absent (`null` or `undefined`, the test accepts either); a different value or a different
app hash is `undefined` (invalid). Alice's name at height 0 is invalid against the current hash
but provably absent against a fresh app's genesis hash. An object proof and a key proof at the
same height carry the same `indexRoots`; key proof bytes round-trip.

**`it('restarts from the store with the same app hash and keeps producing the same hashes')`**.
App `a` on a `MemoryKv`, app `b` in memory, fed identical blocks: same app hash. A third app
opened on `a`'s store reports `lastHeight: 2n` and the same hash from `info()`, alice's balance,
and `lowestProvableHeight: 0n`: the history came back from the store, and its proofs and name
proofs at heights 0, 1 and 2 are byte-identical to `a`'s. The next block gives the restarted app
and `b` the same hash. After four more blocks the window slides: the lowest provable height is 3,
height 2 throws, and the history keys in the store (prefix `0x68`) are exactly versions
`[4, 5, 6, 7]`.

**`it('keeps the whole history window in the store while the one in memory is trimmed, so a restart has it back')`**.
App `a` on a `MemoryKv` and app `whole` in memory, both with `retainVersions: 4` from
`makeApp`, take the same six blocks: alice's registration, then five transfers to her. After
the third block the test calls `a.db.setHistoryWindow(1)`, as the node does from `warn` on
with a window of two. At height 6 `a.db.memory()` reports `history: 'trimmed'` with
`historyWindow: 1`, and `a.lowestProvableHeight` is 2, the same as `whole`'s: for heights 2 to
6 alice's object proof and her name proof are byte for byte `whole`'s, those below height 5
read from the store's history records, and `proofAt(aliceId, 1n)` throws `/not available/` as
it does for `whole`. The history keys in `a`'s store are `[3, 4, 5, 6]`: `persist` deletes by
`lastStaleVersion`, the edge of the configured window, not by what memory holds. A `CoreApp`
restarted on that store with a logger that keeps the fields of `loaded application state`
shows `indexVersions: 'records'` and `provableFrom: 2` there: the sparse trees' past versions
came from the records, with no account replayed. It reports `lowestProvableHeight: 2n`, and
for heights 2 to 6 its proofs are again `whole`'s, this time from the window it read back.
Then the store is damaged: the history record of version 4 is deleted. An app opened on it
has `lowestProvableHeight: 4n`, since only records 5 and 6 are unbroken up to the current
height; alice's proofs at heights 4 to 6 are `whole`'s, `proofAt(aliceId, 3n)` throws
`/not available/` rather than being answered from record 3 without record 4, and after one
more block the history keys are `[5, 6, 7]`: the record below the gap went with that commit.

The second group shares one check, `consistent(app, kv)`: the store's `'i'` keys equal
`db.indexEntries()`, `db.checkIndexStore()` reports nothing (every resident tree entry is in
the store with its value, and the store holds no more entries under an index's prefix than the
tree has), and the store's `'t'` and `'n'` keys equal `db.treeEntries()`.

**`it('gives a store that kept recent transactions under two indices the one they have now, and still refuses a replay')`**.
An app on a `MemoryKv` registers alice and bob in block 1, pays both from the faucet in block 2
(the second payment expiring 30 seconds after genesis) and in block 3 applies `paid`, a transfer
from alice to bob that expires at 45 seconds. `range(RecentTxType, 'byExpiration')` has five
objects with expirations 30, 45, 60, 60 and 60 seconds after genesis, and a `lookup` of the pair
of 45 seconds and the second one's id finds it. `older(kv)` makes the store as an earlier build
wrote it: a copy with the entries at position 0 of the type replaced by the id alone (the
object's id as the value), and entries at position 1 of the expiration and the object's id. Its
`'i'` keys differ from the original's. An app opened on it has the original's app hash, the
store's entries are then the original's, and it is consistent. A block carrying `paid` again and
a new transfer gives `duplicate transaction` and `ok`; an empty block dated two minutes after
genesis leaves the index empty, and the store is consistent. Then the move is cut short. For each
of its three writes in turn (the old entries removed, the new ones written, position 1 removed),
`openObjectDatabase` is called on a fresh old copy through a wrapper whose write of that number
throws: the call throws `stopped` and the store's entries are not the original's. An app opened
on the copy afterwards leaves exactly the original's entries and is consistent: the move was
made again from the start.

The last part moves more records than one write takes, and calls `migrateRecentTxIndex`
directly. `big()` makes a `MemoryKv` holding 12,000 synthetic `recentTx` objects, with 50
different expirations, and their entries in the two old indices, beside an account object, an
object of the type after `recentTx` and an index entry of that type. 12,000 records are nine
writes: three that remove the old entries at position 0, three that write the new ones and three
that remove position 1. For `stop` from 1 to 9 the move is run on a fresh store through a wrapper
whose write of that number throws, and throws `stopped`; for 10 it runs to the end. The move is
then run again on the store itself, and the store's `'i'` keys are exactly the 12,000 expected
entries, of expiration and transaction id with the object's id as the value, and the one entry
of the other type, untouched; and its objects, of every type, are the ones it started with. A
further call through the wrapper makes no write: a store already moved is
read once and left. Last, a store that cannot be written: `migrateRecentTxIndex` on a fresh old
store through a wrapper whose `write` throws `StoreReadOnlyError` throws
`/older index layout and is opened read-only/` and leaves the store's entries as they were, and
once the store itself has been moved the same wrapper over it is accepted without a word.

**`it('writes the entries with every commit, reopens from them, and fills in a store that predates them')`**
(describe `core application: index entries in the store`). An app on a `MemoryKv` is
consistent after genesis, after a block registering alice and bob, a block paying both, and a
transfer between them; three empty blocks and one dated two minutes on expire every recent
transaction id, and the store is consistent again, their entries gone with them. An app
reopened from the store has the same hash, finds bob by name and his balance, and is
consistent: the indices came from the entries. A copy of the store with every `'i'` key left
out, as a store written before phase two would be, opens to the same hash, and afterwards holds
exactly the entries of the original: they were derived from the objects once and written.

**`it('runs blocks with the trees dropped and rebuilt on the way, with the hashes of an app that never drops them')`**.
`paged.db.dropIndexTrees()` reports `dropped`; every block run on the paged app and on a resident
twin gives the same app hash and the same results: a registration, a payment next to a second
`alice` registration that fails, a `checkTx` against the pending session, as the mempool checks,
that refuses a name taken in the store; after `rebuildIndexTrees()` a block from alice, then
consistent; dropped again, a block registering carol, and the store's entries equal the resident
twin's `indexEntries()`.

**`it('writes the entries of a state imported from a snapshot')`**. `exportSnapshot` in chunks
of three objects, `importSnapshot` into a fresh database, `CoreApp.writeImportedState` into an
empty store: the store's entries and trees equal the original app's, and an app opened on it has
the original's hash and is consistent, the path a node that joined by state sync restarts along.

**`it('writes the trees with every commit and restarts from them, with the proofs of the original')`**.
An app on a `MemoryKv` and a twin in memory run three blocks (two registrations, two payments,
a transfer beside a third registration) with equal hashes, and the store is consistent.
`proofsOf(app)` collects, at every height in the window, the object proofs of the faucet, alice,
bob, an absent account and a balance, and the name proofs of alice, carol and nobody. An app
reopened from the store has the same hash and the identical `proofsOf`, and is consistent: the
trees came from their chunks and nodes. `openObjectDatabase` with `{ fromTrees: false }`
(compute the trees from the objects), `{ checkLeaves: true }` and `{ trees: false }` (start
dropped) each give the same hash and alice's proof at every height. A copy of the store with
alice's object overwritten by bob's bytes is refused: with `checkLeaves: true` by
`/does not hash to its leaf/` (the leaf check), and by the recomputing path
(`fromTrees: false`, here with `checkIndexEntries: false`) with
`/do not hash to the stored app hash/`. The reopened app and the twin keep agreeing on the next
block. A copy of the store with every `'t'` and `'n'` key left out opens to the same hash and
then holds exactly the trees of the original.

**`it('runs blocks with the Merkle trees dropped and rebuilt, with the hashes and proofs of an app that keeps them')`**.
`dropTrees()` and `dropIndexTrees()`, and `memory()` reports both `dropped`. Every block on the
paged app and on a resident twin must agree in hash and results and, at every height in the
window, in the faucet's object proof and the name proofs of alice and bob. While everything is
dropped, `checkTx` refuses a second `alice` and admits a payment. After `rebuildTrees()` a block
from alice is consistent. Then a `checkTx` registering dave leaves pending writes in the
mempool's session, `dropTrees()` is turned in the middle of them, a block registering carol
agrees, and the store's trees equal the resident twin's; both tiers rebuilt, the store is
consistent.

The third group, `describe('core application: a store opened without room for it')`, shares a
`run(reopen)` helper: an app on a `MemoryKv` and a resident twin take two blocks (alice and
bob registered, then 5,000 to alice), the store is reopened by the function given, its
`lastAppHash` must equal the twin's, and `both(txs)` applies a block to the reopened app and
the twin and compares the app hash, the results and, for every height from the reopened app's
`lowestProvableHeight` to its last, alice's object proof and the name proofs of `alice` and
`carol`.

**`it('opens with the trees left in the store and no history window when the heap has no room, and runs on')`**.
Reopened with `heapRoom: 0` and `retainVersions: 4`. `memory()` shows `trees: 'dropped'` and
`indexTrees: 'dropped'`: with no room neither estimate fits. The window was not read back,
so the one in memory starts at height 2, where the store was opened, and is whole
(`history: 'resident'`, `historyWindow: 4`). Yet `lowestProvableHeight` is 0 like the twin's,
and for heights 0 to 2 alice's object proof and her name proof are byte for byte the twin's:
`openObjectDatabase` told the database of the records it left in the store
(`noteStoredHistory`), and the heights before 2 are read from them. A transfer signed by alice and then carol's
registration match the twin through `both`, the lowest provable height still 0, and alice's
balance agrees. The history keys in the store are `[1, 2, 3, 4]`, the records it did not read
among them, and after an empty block `[2, 3, 4, 5]`: they age out as usual. A fourth app on
the same store with `heapRoom: 2 ** 30` reports `lowestProvableHeight: 1n` and proves heights
1 to 5 as the twin does. And `openObjectDatabase` with `heapRoom: 0, indexTrees: true, trees:
true` returns `paged: []` with both tiers `resident`: a tier named explicitly is opened as
asked. This is the open path of STATE-PAGING.md section 9.1.

**`it('leaves the objects in the store when the arena has no room for them, and reads them from there')`**.
Reopened with `arenaBytes: 0`. `memory().storedObjects` is above 5 and `arena.used` is 0:
every object was left in the store. The history window was read (`lowestProvableHeight: 0n`)
and `accountByName('bob')` answers, decoded from the store. After the same two blocks through
`both`, `arena.used` is above zero and `storedObjects` is lower than before but not zero: what
the blocks wrote is in the arena again, the rest still only in the store. Alice's balance and
`exportObjects()` of the whole state equal the twin's.

A fourth group, `describe('core application: a damaged store is refused at restart')`, is not
described here; its three cases, by title: "refuses an object missing while its leaf is still
there", "refuses index entries that are missing, extra or name another object" and "refuses a
dense tree node that is not the hash of its children, and a sparse node that does not hash to
its parent".

### test/history.test.ts

Four unit tests on `HistoryLog` of `src/app/core/history.ts` ([11](11-application.md)), the
log the account history is stored in, each over a `MemoryKv` with no application. `account(n)`
is the object id `2.n` and `entry(height, n)` an operation entry whose `position` is `n`, so a
test can tell entries apart by position. `blocks(count, perBlock)` makes that many blocks of
entries over five accounts, two entries in three going to account 0, and returns beside them
a model: for each account the entries it should have, in order.

**`it('pages an account oldest first and newest first, whatever the other accounts wrote between its entries')`**.
Forty blocks of thirteen entries are appended, one `kv.write` each. Then, for the log that
wrote them and for a second `HistoryLog` opened on the same store, every account's `total` is
the model's length, and `read` is compared with a slice of the model for every `from` in 0, 1,
2, 7, 64, the last sequence, one past it and five past that, and every `limit` in 0, 1, 3, 100
and 1,000, oldest first and newest first, by sequence and position. An account that never
appeared reads as no entries and a total of 0. A third log opened on the store appends one
more entry for account 0, which is then its newest, and its total is one more.

**`it('reaches the old end of a long history in a few dozen reads, and appends a block with a few pages of writes')`**.
The store is wrapped so that every `get` is counted. Fifty blocks of a hundred entries, all
of account 1, are written with fewer than 15,000 reads: an entry reads its account's head
and, on average, one older entry for its skip pointer. Reading two entries oldest first from
sequence 0, 1, 1,234, 2,047, 2,048, 4,095 and 4,998 returns the right positions in fewer than
100 reads each, where following `prev` alone from the newest would take thousands. Last, the
`'l'` keys (prefix `0x6c`) are exactly 0 to 4,999 in
the store's order: a block's entries are consecutive keys at the end of the log.

**`it('writes the heads a slice of the accounts at a time, and has the waiting ones back after a stop')`**.
The store is wrapped so that every put of a `'p'` key (prefix `0x70`) is noted with its
account number. Two hundred blocks of 300 entries are appended, the accounts taken from all
over a range of 6,400 in no order (`n * 2654435761 % 6400`), and the test keeps its own count
per account. After each block the head writes of that block span fewer than 128 account
numbers: one slice, a sixty-fourth of the range, the slices being 128 wide once account 6,399
has been seen. At every 37th block and at the last a second `HistoryLog` is opened on the
store, as after a stop at that block: its `total` is the test's count for every account, the
waiting heads read back from the entries, and it reads account 0's entries in full. Over the
run fewer than 30,000 heads are written for 60,000 changes, since a head changed several
times while it waits is written once, and no block writes as many as 300. At the end the two
numbers under `'L'` are read from the store: the length is 60,000, and `covered` is no more
than 64 blocks of entries (19,200) behind it, so the journal a restart reads is short.

**`it('moves a store written before the log into it the first time it is opened')`**. A store
is filled as the earlier layout had it, an entry under `0x61`, account and sequence, and a
count under `0x71` and account, from the model of twelve blocks of nine entries. A
`HistoryLog` opened on it reads every account with the model's sequences, heights and
positions, oldest first, and its two newest entries newest first; no key with either old
prefix is left; and the heights of the stored `'l'` entries, read at byte 32 of each value,
after the account, the sequence and the two pointers, are in ascending order. A log opened
again moves nothing, and an entry it appends for account 0 gets the sequence after the moved
ones.

### test/staking.test.ts

Sixteen unit tests that walk the staking rules of [STAKING.md](../../STAKING.md) and the
application chapter ([11](11-application.md)) one block at a time. The genesis has a faucet,
three operator accounts `op-a`, `op-b`, `op-c`, a community pool of 1,000 tokens, and two
genesis validators: A with a self-bond of 200 and B with 100, so A alone holds exactly two thirds
of the bonded 300. `PARAMS` makes everything small: at most 3 validators, a 10 s unbonding
period, a self-bond floor of 100, a 10-token creation fee, 10% commission, a 5% proposer bonus, a
5% double-sign slash, a downtime window of 4 blocks at 50%, a 5 s jail, a 0.01% downtime slash,
at most 2 unbonding entries, a 20 s proposal lifetime and zero inflation. `block(app, txs, o)`
finalises and commits a block whose proposer, last-commit signers, misbehaviour and time step
(`dt`, default 1 s) the test chooses. `tx` prices operations from `app.feeSchedule()` and
signs them with an expiration relative to `app.dynamic().time`.

`checkSupply` is the supply invariant:

```ts
/** currentSupply = balances + validator tokens + unbonding + pool, at every height. */
function checkSupply(app: CoreApp): void {
  const db = app.db;
  let sum = 0n;
  for (const b of db.range(BalanceType, 'byAsset', encode((w) => w.u64(CORE)))) sum += b.amount;
  for (const v of db.scan(ValidatorType, 'byPower', new Uint8Array(0))) sum += v.tokens;
  for (const u of db.scan(UnbondingType, 'byCompletion', new Uint8Array(0))) sum += u.tokens;
  sum += db.get(DynamicType, objectId(TYPE.dynamic, 0))!.communityPool; // live view, like the sums above
  expect(sum).toBe(db.get(AssetType, CORE)!.currentSupply);
}
```

Every core token is in exactly one of four places: a balance, a validator's bonded tokens, an
unbonding entry, or the community pool. Rewards, commission, slashing, fees and minting all move
tokens between these places or create them through the asset's `currentSupply`; a bug in any of
them (a reward paid twice, a slash that burns tokens without reducing the supply, an unbonding
entry released and also kept) breaks the equation. Calling it after every scenario turns each
test into a check of the whole accounting, not only the rule under test.

**`it('bootstraps validators from genesis and hands the engine the set')`**. `initChain` returns
the two consensus keys with powers 200 and 100, in that order. Validator 0 belongs to `op-a`,
holds `T(200)` tokens and `T(200) * SHARE_SCALE` shares, all of them in the operator's own
delegation; `op-a` has `T(800)` left; the pool is `T(1000)`, `bonded` is `T(300)`; `op-c` has no
validator. The supply balances, and `proveValidatorAddress` resolves A's consensus address to
`VAL_ID(0)` while C's is provably absent.

**`it('pays the block reward from the pool with a proposer bonus, by stake, with commission minted to operators')`**.
`fixedRewardPerBlock: 10`. Height 1 pays nothing. Height 2, proposed by A and signed by both:
the bonus is `T(10) / 20n` (5%) to A, the remaining 9.5 split 200:100, and the pool shrank by
exactly what was paid (rounding dust stays). The operator's delegation gained shares worth the
commission, the exchange rate rose (one token's worth of shares at genesis is now worth more
than a token), and both whole-token powers moved, so `validatorUpdates` reports `[206n, 103n]`.

**`it('delegates, undelegates through the queue, enforces the entry cap, and releases on maturity')`**.
The faucet delegates `T(50)` to A: its shares are worth at most `T(50)` and more than
`T(50) - 2n`, A's power update is `[250n]`, the faucet paid 50 plus a fee of 100 base units, and
`proveDelegation` resolves to the delegation's id. Three undelegations in one block give
`[true, true, false]`, the third `/pending unbonding/`: `maxEntries: 2`. Both entries complete at
`time + 10_000n`. After 9 s nothing has matured; after one more second the entries are gone and
the balance is back up by their tokens.

**`it('redelegates with the no-chain rule and the self-bond floor')`**. Half of a `T(60)`
delegation moves from A to B: one redelegation entry, a delegation on B worth more than `T(29)`.
Moving it on from B while the entry is pending is `/still redelegating/`; after 10 s the entry is
gone and the move passes `checkTx`. `op-b` undelegating half its self-bond is `/self-bond/`: an
operator cannot drop below the floor.

**`it('slashes redelegated stake where it went: at the destination, or in what was undelegated from there since')`**.
`run(undelegated, tombstoneDestination)` delegates `T(60)` to A, notes the height, moves all
of it to B, then undelegates none, half or all of it from B, optionally has B tombstoned, and
last gives a block evidence against A at the noted height. It returns the cut (5% of the tokens
the redelegation entry recorded), what the delegator lost of its delegation and unbonding
entries at B, what the pool gained, and the entry's tokens afterwards. For none, half and all,
the delegator lost the cut to within a token, the pool gained at least that, the entry is down
by the cut and the supply balances. With B tombstoned in between, for a fault at height 1,
which turned the delegation into an unbonding entry made by that block, the same. And with B slashed to nothing for
downtime (a genesis with `downtimeSlashBps` at 10,000) after half was undelegated from it, the
whole cut comes out of that unbonding entry: the empty delegation pays nothing and is not
counted as having paid. Before the change the delegator who undelegated all lost
nothing.

**`it('lets a slash that follows redelegated stake take an operator below the self-bond, and keeps its validator out of the set until the operator delegates again')`**.
Three genesis validators, A with 200 and B and C with 100 each, all three signing. The operator
of B delegates 60 to A and redelegates all of it into B, its own validator, then undelegates
from B until its delegation there is worth just over 101; a further undelegation of about 2
fails `checkTx` with `/self-bond would fall below/`, and B is in the active set. A is then
punished for a double sign at the height of the delegation. The cut of 3 follows the 60 to B
and comes out of the operator's delegation: it is now worth between 97 and 100, below the
floor no transaction could have taken it under, and the supply still adds up. B is still a
`candidate`, neither jailed (`unjail` fails with `/not jailed/`) nor slashed itself, and the
active set is C alone. A delegation of 50 to B by the faucet changes nothing, since only the
operator's own stake counts toward the self-bond; a delegation of 3 by the operator brings its
delegation back to the floor and B back into the set.

**`it('creates validators with the fee and minimums, ranks the top N, and rotates keys')`**.
`op-c` creating a validator with a 99 self-bond is `/self-bond must be at least/`; with A's
consensus key `/consensus key already in use/`; with 150 it succeeds, costing `T(150)` plus the
`T(10)` creation fee plus 1,000 base units of transaction fee, and the update is `[C, 150n]`
with the active set at powers `[200n, 150n, 100n]`. A fourth operator `op-d` with 120 pushes B
(100) out of a set of three: updates `[120n, 0n]`, active validators `[0, 2, 3]`. Rotating A's
consensus key gives updates `[fresh, 200n]` and `[old, 0n]`: the old key leaves, the new enters
at the same power. The pool after the creation is exactly `pool + T(10) + 1000n`: the creation
fee and the operation fee came in and, with no block reward in this genesis, nothing went out.
(An earlier version of this assertion compared the pool with itself; review finding 48 replaced
it.)

**`it('jails a validator that misses half the window, slashes it a little, and lets it unjail after the period')`**.
B misses four blocks in a row (only A signs). After three it is still a `candidate`; after the
fourth it is `jailed` until `time + 5000n`, its tokens are down by one ten-thousandth, the
update is `[0n]` and the active set has one member. `unjail` is `/jail period/` until the time
passes; delegating to a jailed validator is allowed. After 5 s `unjail` is `/self-bond below/`,
because the slash took the self-bond under the floor; `op-b` delegates `T(1)` more and `unjail`
succeeds, the status is `candidate` again and the update is `[100n]`.

**`it('tombstones a double signer, slashes its stake and later leavers, and unbonds everyone')`**.
The faucet delegates `T(100)` to A, then undelegates half, one height after the infraction
height. A misbehaviour report for A at the infraction height makes A `tombstoned` with zero
tokens and shares and no delegations; there are three unbonding entries on A: the faucet's
earlier entry, now slashed by 5%, and one forced entry per delegation (operator and faucet),
whose total is at most A's tokens less 5%; the pool grew by at least the slash less the block's
reward; the update is `[0n]`. Delegating to A is `/tombstoned/`. A second report of the same
infraction changes nothing. After the unbonding period every entry is paid out and `op-a`'s
balance grew.

**`it('tombstones a validator that forgot a lock like a double signer, at the rate of its own parameter')`**.
The genesis sets `amnesiaSlashBps` to 2,000 beside the 500 of a double sign, so the rate applied
shows. The same sequence as the case before (a delegation, half of it leaving after the
infraction height) ends with a block whose misbehaviour entry has the kind `amnesia`: the
validator is tombstoned with no tokens and power 0, the entry that left after the infraction
has lost a fifth, the delegators' forced entries hold at most four fifths of the stake and no
less than that by a token, and the pool grew by a fifth of it. Evidence of the other kind for
the same validator a block later moves the pool by less than a token, which is all the
test asks (the fixture pays no reward and mints nothing): a tombstoned
validator is punished once. The supply balances, and a genesis with the rate at 10,001 is
refused (`/amnesiaSlashBps must be 0 to 10000/`).

**`it('slashes two proposals at the rate of a double sign, and a prevote on a majority that never was at the rate of a forgotten lock')`**.
Four applications, each from a genesis with `amnesiaSlashBps` at 2,000 and the double-sign rate
at 500, each given one block with a misbehaviour entry of one kind. For `duplicateVote` and
`duplicateProposal` the delegators' forced unbonding entries hold what the validator held less
5%, to within a token; for `amnesia` and `falseCitation`, less 20%. Each validator is
tombstoned and each supply balances.

**`it('mints toward the bonded goal and never past the max supply')`**. Inflation between 7% and
20%. The initial rate is 700 bps (`700n * 100_000n` parts per billion). After a one-hour block,
the rate rose by 13% a year prorated to an hour (the bonded ratio is tiny, so the rate climbs
toward the maximum) and the supply grew by `supply * rate * hour / year` using the new rate; the
mint went to the community pool; the supply balances. A genesis whose `maxSupply` equals the
total already in circulation mints nothing.

**`it('adopts a parameter proposal at two thirds of active stake and expires the rest')`**.
`op-a` proposes `maxValidators: 2` and `minDelegation: T(3)`. The proposal's `signals` hold A
alone, and nothing changes after a block: 200 of 300 is exactly two thirds, not more. A
signalling again is `/already signalled/`; B's signal adopts it: the staking parameters change,
the fee schedule does not, and the proposal is gone. A delegation of `T(2)` is now `/at least/`.
A proposal nobody else signals expires after its 20 s lifetime. Someone who is `/not the
operator/` of a validator cannot propose through it.

**`it('punishes stake whose unbonding matures in the very block that carries the evidence')`**.
The faucet delegates `T(100)` to A and undelegates all of it at height `h`; the one unbonding
entry completes 10 s later. The next block steps time by exactly 10 s and carries a
misbehaviour report for A at `h + 1`, the height at which the undelegated stake was still
signing. The entry is gone afterwards and the faucet's balance rose by its tokens less 5%:
the evidence reached the entry before the queue paid it out, which is why `matureQueues` is
the last step of `beginBlock`. The supply balances.

**`it('adopts parameters with care: pending unbondings follow a longer period, signing windows restart, and no proposal may empty the set')`**.
With an unbonding entry pending, `op-a` proposes an unbonding period of 20 s (twice the old)
and a downtime window of 3 (smaller than 4, but the same byte length), and `op-b` signals.
The period is 20 s, the pending entry's completion moved out by the 10 s difference, and
both validators' signing records have `tracked` 0. Then a proposal setting `minSelfBond` to
`T(201)`, above every self-bond, is signalled through: the parameter stays at `T(100)`, the
proposal is gone, and the active set still has two members. A chain cannot vote itself
validator-less.

**`it('caps the signals a proposal can hold at what its encoding can carry')`**. A proposal
is created, and the test writes a thousand foreign validator ids into its `signals` directly,
as if a larger chain's validators had all signalled; `op-b`'s signal is refused in `checkTx`
with `/maximum number of signals/`, so no proposal is ever stored that `ProposalType.decode`
would refuse to read back.

### test/staking-net.test.ts

One test that runs the staking rules on a live network ([11](11-application.md),
[08](08-node.md)) with the application owning the validator set, and a light client
([13](13-light-client.md)) following the result.

**`it('owns the validator set: delegation raises power, a stopped validator is jailed, and it returns after unjail')`**.
`engineValidators: false`, so the engine genesis names no validators; the application genesis,
built by the `appState` function from the harness's validator keys, declares four operators
`op0` to `op3` each with a self-bond of 200 and the matching consensus key, a block reward of 1,
a downtime window of 8, a 2 s jail and a 5 s unbonding period. At height 3 the engine's set has
four members at power 200 or more: it came from `initChain`. The faucet delegates 300 whole
tokens to validator 0; node 0's engine shows it at power 500 or more within 20 s (the change
takes effect two heights later), and every app's `active` list agrees. Node 3 is stopped: its
validator is `jailed` within 40 s and the engine's set shrinks to three; the chain goes on three
more heights. Node 3 is recreated with its validator key, catches up by block sync, and once the
wall clock is a second past `jailedUntil`, `op3`'s `unjail` brings the set back to four. Two
more heights, then a light client that trusted height 2 calls `verifyLatest()` and sees four
validators at a height past the jailing, and `verifyKey` of the name `op3` returns a value: the
light client followed a set that shrank and grew again, and proved who stands behind a key in
the final set.

### test/fees.test.ts

Four tests on the fee schedule of [FEES.md](../../FEES.md) ([11](11-application.md)): two
genesis validators (A with 200 of 300 bonded, B with 100, "so adoption needs both"), `tx`
pricing from the schedule in force, `rawTx` taking fees exactly as given, and `bodyBytes`
measuring an operation's encoded body.

**`it('prices operations the BitShares way: premium names, data per kilobyte, symbol length, scale')`**.
`isCheapName`: a digit, a dot, a hyphen, or no vowel (y counts as one) makes a name cheap, so
`alice`, `bob` and `xyz` are premium while `alice1`, `al-ice`, `a.b` and `mrkt` are cheap. A
transfer costs 100. Registering `alice` costs `premiumFee` plus the data fee of the body, which
is over twice `publicKeySize(DEFAULT_SCHEME)` because it carries two keys of the chain's scheme;
`alice1` costs `basicFee` plus data;
sixteen-key authorities cost more by more than thirty keys' worth of data fee; an account update
is its flat fee plus data. Asset symbols cost by length: 100,000 for three characters, 50,000
for four, 10,000 for six. `scale: 25_000` turns the 100 transfer into 250, `scale: 0` makes
everything free, and the product is capped at `MAX_SHARE_SUPPLY`. The fee is part of the signed
bytes: a transaction decoded from `rawTx` carries exactly the stated `777n`. And the signature
binds it: a signed transfer decoded, given a fee one higher and encoded again fails `checkTx`
with `/invalid signature/`, not with a different price.

**`it('refuses an operation stating less than the schedule, and charges exactly what is stated')`**.
A transfer stating 99 fails `checkTx` with
`/operation 0 states a fee of 99, the schedule requires 100/`; 100 passes. Stating 1,000 or 250
is allowed and that is what moves: the faucet's balance drops by the stated amounts and the
pool rises by them. A transaction that fails (a transfer to the sender itself) pays nothing. On
a chain with `scale: 0`, a transfer moves only its amount and `withFees` writes a fee of `0n`.

**`it('changes the schedule by validator proposal, and a transaction priced under the old schedule fails rather than paying more')`**.
A transfer is signed at the current price of 100. `op-a` proposes `scale: 20_000` with a transfer
fee of 250; the schedule is unchanged until `op-b` signals, after which `feeSchedule()` equals
the proposal, the staking parameters are untouched and the proposal is gone. The transfer signed
earlier now fails with `/states a fee of 100, the schedule requires 500/`, both in `checkTx` and
in a block (`[false, true]` next to a freshly priced one), and the faucet is charged only for
the one that passed: a signer is never charged more than it signed for. A proposal with
`scale: 2_000_000` is refused up front with `/fee scale must be 0 to 1000000/`.

**`it('takes a partial schedule in genesis over the defaults and refuses a bad one')`**.
`parseAppGenesis` of a document naming only `scale`, `transfer.fee` and
`accountCreate.premiumFee` fills the rest from the defaults; `checkFeeSchedule(DEFAULT_FEES)` is
`null`; a scale of 2,000,000 throws `/fee scale/`, a negative transfer fee throws
`/transfer\.fee/`, and `feeScheduleFromJson` without `accountCreate.basicFee` throws
`/accountCreate\.basicFee missing/`. An app built from a genesis with a transfer fee of 7 prices
transfers at 7.

### test/genesis.test.ts

Two tests on loading the application genesis ([11](11-application.md)), including the
streaming parser introduced for review finding 35.

**`it('parses the same document as one string and as a token stream')`**. A document with a
core asset `TEST` of precision 3, a partial fee schedule, partial staking parameters, a pool of
12, two accounts (alice's active authority references account `3.0`) and one validator.
`parseAppGenesis(bytes)` and `parseAppGenesisStream(Readable.from(...))` give equal results;
the account reference parsed to `3n * 2n ** 48n`, the fee to `7n`, the pool to `12_000n` (12
whole tokens at precision 3). Key order does not matter; `{}` yields no accounts; the empty
string, `{"accounts": 5}` (`/must be an array/`), `{"accounts": [1]}` (`/must be objects/`), two
truncated documents (`/ended early|expected/`) and a top-level array (`/must be an object/`)
are refused. A document with two top-level `accounts` keys, the first holding the faucet and
the second empty, parses to no accounts on both paths, as `JSON.parse` would: the streaming
parser must agree with the inline one on every document, or a genesis would hash differently
depending on how it was loaded. A `CoreApp` built from a genesis whose faucet has a balance of
`'-1'` throws `/negative balance/` rather than treating it as zero.

**`it('loads a genesis whose application state is in a file, and reaches the same app hash as an inline one')`**.
`state.json` and a `genesis.json` naming it as `appStateFile` are written to a temporary
directory. `loadGenesisFile` resolves the path, leaves `appState` empty and omits it when
serialising. A `CoreApp` built with `appGenesis: await loadAppGenesis(g)` has the same
`lastAppHash` and the same id for alice as one built from the inline bytes. `db.lastChanges` is
`null` after construction and again after reopening from a `MemoryKv` (finding 36: the encoded
bytes of every object are not kept around). Without the parsed genesis and with an empty store,
construction throws `/loadAppGenesis/`. An empty file is an empty genesis; a missing file
rejects with `/ENOENT/` rather than hanging.

### test/txproof.test.ts

Two tests on transaction inclusion and result proofs in `src/types/txproof.ts`
([03](03-types.md)), with seven transactions of which every third fails.

**`it('proves inclusion against the data hash and rejects tampering')`**. `txsRoot([])` is
`EMPTY`. For each index, `txProofFor(7n, txs, i)` verifies against the root and survives the
byte round-trip; a different transaction, a different index, a path with one more sibling
(`EMPTY` appended) or one fewer, an index of `i + 8` (the same low bits, but beyond what three
siblings can address), an index of −1 and the root of only six transactions all fail. The
proof carries no count: the path's length is the tree's height, and the position must be one
that length can address. Reversing the order changes the root.

**`it('proves results, including failures, against the results hash')`**. `resultsRoot([])` is
`EMPTY`; each result proof carries the right `ok`, verifies, round-trips, and fails when `ok` is
flipped or a character is appended to the error. A client can prove a transaction failed, and
why.

### test/light.test.ts

One test on the light client ([13](13-light-client.md)) in the case it exists for: a validator
set that changes by more than the trust level.

**`it('follows a validator set that changes beyond the trust level by bisecting')`**. Four
validators of power 10 and a full node. The client will trust the current height on node 3. The
full node restarts with a validator key and is voted in at power 100; then validators 0, 1 and 2
are removed, leaving node 3 (10) and the newcomer (100). Whoever trusts the genesis set sees only
node 3's 10 of the original 40, a quarter, among the final signers, below the one-third trust
level. The client starts with `trusted.validators.size` 4; `verifyToHeight(target)` reaches the
target with a set of 2, and `verifiedHeights` has more than one entry, strictly increasing and
ending at the target: it could not jump straight there and bisected through an intermediate
height whose signers it could trust. Sequential verification of `target + 1` and
`verifyLatest()` work from there. A provider that serves a header with a zeroed app hash at
`target + 2`, next to the real commit with its `blockHash` rewritten to the forged header's
hash, is rejected with `/commit|signature|power/`: the commit names the forged block
consistently, so only the signatures, made over the genuine hash, give it away. A client with a
`trustingPeriodMs` of 1 refuses with `/trusting period/`.

### test/rpc.test.ts

Seven tests on the JSON-RPC server and client ([12](12-rpc.md)), the keystore
([14](14-wallet-cli.md)) and the RPC-backed light client provider. `up(limits)` starts a
four-validator core-application network, an `RpcServer` on node 0 at port 0 (the OS picks),
waits for height 2 and returns an `RpcClient` on `server.url`. The server and the network are
stopped in `afterEach`.

**`it('answers status, headers, commits, validator sets, objects and keys with proofs that verify')`**
(describe `json-rpc`). `status` reports the chain id, a height of 2 or more and 3 peers. The
header at `h` hashes to the stored header's hash; the commit has 4 signatures; the validator set
JSON hashes to its own `hash` field and can be fetched back by that hash. An `object` query for
`3.0` at `h - 1` with `prove: true` names the faucet and its proof verifies against header
`h`'s app hash. `account('faucet', true)` gives id `3.0` with a `CORE` balance, and its name
proof verifies against the next header's app hash to the eight bytes of the id. If that header
does not exist yet, the test catches the error, waits for the height and asks again. A missing
account is `null`; an unknown height is error `-32001`; an unknown method `-32601`; `genesis`,
`peers` (3), `mempool` (count 0) and `accounts` (`['faucet']`) answer.

**`it('broadcasts in sync and commit mode, finds transactions with proofs, and records history')`**.
`broadcastTx(..., 'commit')` of alice's registration returns `ok` and the transaction's hash,
and a counter wrapped around the store's `txLocation` reads 0 after it: a transaction just
admitted is waited for, not looked up.
A transfer in `'sync'` mode is `'added'`; once it lands, broadcasting it again in commit mode
returns the height it already landed at, with one lookup made. (The case ends with a third
transfer broadcast in commit mode twice at once: both calls return `ok` at one height and the
counter has not moved, the second having found the transaction pending.) A forged transfer (signed by alice for the faucet) is
refused with `-32002`. `rpc.tx(hash, true)` after the next height reports `ok`, a decoded
transfer to `3.1`, and a proof that `txQueryFromJson` turns into something `verifyTxQuery`
accepts with the sets at `H` and `H + 1`. An unknown hash is `-32001`. `accountHistory` for
alice holds two operations, the second a transfer of `'5000'`; `balance` is `'5000'`; a
`delegation` that does not exist is `-32001`.

**`it('streams events, replays blocks from Last-Event-ID, and enforces the limits')`**. Limits:
2 calls a second with a burst of 6, 2,000-byte bodies, 2 streams per address. `GET /events?types=block,tx`
answers `text/event-stream`, and the first `event: block` with an `id` and `{"height"` arrives.
A second stream opens; a third is `429`. A 5,000-byte POST is `413` before the body is read.
A replay with `Last-Event-ID: 1` is retried while it answers `429` (the server frees a cancelled
stream's slot only when it sees the socket close), then delivers `id: 2`; a second replay at
once is `429`, because a replay costs as much as a costly call. Then up to twenty `status` calls
must hit `-32004`, the rate limit. The `read` helper throws if a stream has ended instead of
awaiting a finished reader forever; findings 25 and 31 describe why this test once hung the
suite.

**`it('serves a light client over the RPC')`**. A `LightClient` over `RpcProvider` trusts height 2
by hash; `verifyLatest()` reaches a height no later than the one `status` then reports. The
faucet's name proof from
`account`, with the header and commit of the next height fetched over the RPC, verifies
through `client.verifyKey` to the id `3.0`. A wrong trusted hash is refused.

**`it('answers only requests that carry the token, when one is set')`**. One validator on the
toy application. A token shorter than 16 characters is refused by the constructor, and so is
one that is `true`, a number, an object, has spaces or a newline; a client made with the last
throws without the token in its message. A server
with a token, a burst of 8 and no refill answers 401, with `WWW-Authenticate: Bearer` and an
empty body, to a POST without the token, with a token one letter off, with the token outside
`Bearer`, and with it in the query; an `RpcClient` without it throws `/asks for a token/`. With
the header the call returns the chain id, from `fetch` and from a client made with the token.
`/events` is 401 without it and 200 with it in the header or the query. Those were eight calls
and refusals: a ninth, right token or none, is 429. `/health` is 200 throughout and the
preflight allows `Authorization`.

**`it('reports the parameters in force so a wallet can price its operations, and the open proposals')`**
(describe `json-rpc parameters`). A genesis with a transfer fee of 250 and a premium name fee of
20,000. `parameters()` reports the core asset (`4.0`, `CORE`, precision 5), `scale` 10,000, the
two overridden fees and the default `basicFee` and `pricePerKbyte`, 21 maximum validators and a
seven-day unbonding period as a string; `chainParametersFromJson` of it equals the
application's own `chainParameters()`; `proposals()` is empty. A registration priced from the
reported schedule commits; a transfer priced from `DEFAULT_FEES` is refused with `-32002` and
`/states a fee of 100, the schedule requires 250/`. A wallet must ask the chain for prices.

**`it('seals seeds under a passphrase and refuses the wrong one')`** (describe `keystore`).
`Keystore.create(path, 'correct horse')`; `add('alice')` with a random seed and `add('bob', seed)`
with a given one; `list()` names both; adding `alice` again throws `/already exists/`. Reopened
with the passphrase, it returns the same address, seed and public key; the wrong passphrase
throws `/wrong passphrase/`; and the raw JSON file does not contain bob's seed in hex. The file
is then rewritten with `version: 3`, one the code does not know: `open` throws `/unsupported keystore/`, so does `add('carol')`
on the handle opened before, the file gains no `carol`, and no lock file is left behind.

### test/sync.test.ts

Five tests on catching up ([07](07-sync.md)): state sync from a snapshot with backfill, the
headers a joiner fetches for the evidence window and what it does with them, block sync over
many blocks with pruning, and evidence gossip plus deciding a height from a fetched block.
`coreNet` builds four core-application validators of which only nodes 0 and 1 take snapshots,
"so the joiner has exactly two sources, one of them a liar".

**`it('joins from a snapshot, serves queries at once, survives a corrupt chunk, and backfills to genesis')`**.
Snapshots every 6 heights, two objects per chunk. Three accounts are created so the account
type spans two chunks; at height 13 both sources hold a snapshot at 12. The manifest verifies
against header 13's app hash (`verifyManifest` returns `null`) and not against
`lastResultsHash` (`/app hash/`); chunk 0 of the account type verifies, and the same chunk
with one object's bytes replaced by another's fails with `/hash differs/`. Node 1 is then made a
liar: its `chunkBytes` corrupts every chunk it serves. A joiner is created with
`stateSync: { trustHeight: 2n, trustHash, backfill: true }` and no application of its own;
`Node.create` runs the state sync before the node starts, so right after creation `joinedAt`
and `height` are 12, the lowest stored height is 12, and below it the joiner holds headers
alone, back as far as evidence may reach, which on a test chain with a seven-day evidence age
is genesis: `lowestHeaderHeight()` is 1 and its header 7 hashes to node 0's. The app is at 12,
`lowestProvableHeight` is 12 and height 11 throws `/not available/`: nothing before the
snapshot is provable, and the node says so. `user2` exists and the faucet has a balance. The
liar's misbehaviour score on the joiner is above 40: it caught the corrupt chunk, charged its
source and finished from the other. Once started, the joiner catches up, answers `queryState`
at `height - 1` with the header at `height`, and backfills until the lowest stored height is 1
with `blockSync.backfilled` 11; its header 1 equals node 0's. The backfilled blocks replaced
the headers kept alone: `lowestHeaderHeight()` is `null` and header 7 no longer loads as a
record. A transaction in a backfilled block is located with `ok: null`, because backfilled
blocks carry no execution results (a documented simplification).

**`it('applies evidence for a height before its join, from the headers it fetched for the evidence window')`**.
Snapshots every 6 heights; once both sources hold one at 6, a joiner is created with
`backfill: false`, so what it knows of the heights before its snapshot is exactly the headers
state sync fetched: block 3 is `null`, `lowestHeaderHeight()` is 1, header 3 hashes to node
0's, and `executor.blockTimeAt(3n)` is block 3's time read from that record. The test then
holds validator 3's key and forges two prevotes at height 3, before the join, for different
block hashes; the evidence goes into node 0's pool and the test waits for a block after
`joinedAt` to carry it. Applying that block takes the validator set of height 3, named by its
header, and the time of height 3, which the joiner has only as a header record; the joiner must
get past that block and the one after it, whose header fixes the state the evidence produced,
so the stored block carries evidence and the app's height is beyond it. Before the header
records existed, a joiner refused such a block as evidence for an unknown height and banned the
honest peers that served it. Finally a `LightClient` anchored at the joiner's tip, through a
`NodeProvider` on the joiner, verifies node 0's state query for the faucet at height 3 with
`verifyState`: the walk back from the tip to header 4 goes through the joiner's header records
([13](13-light-client.md)).

**`it('fetches at a join only the headers evidence may still name, and lets them go as the window moves on')`**.
The same join with `limits: { maxEvidenceAgeMs: 1500n }`. With `oldest` the join height's
time less the window, every header the joiner kept has a time at or after `oldest`, and the
header just below the lowest kept one (read from node 0) is older than `oldest`; if the joiner
kept none at all, the header below the join height is itself too old. Once started, the chain's
time moves a window past the join, nothing below it can be named by evidence any more, and the
records are pruned: `lowestHeaderHeight()` becomes `null` and the header below the join height
is gone.

**`it('catches up a node that missed many blocks by batched requests across peers, and prunes behind a retention window')`**.
Four validators run to height 45 (60 s allowed) while a full node waits unstarted; once started it
reaches 44 with `blockSync.synced` of at least 40. A sixth node with `retain: { blocks: 10 }`
and `limits: { maxEvidenceAgeMs: 0n }` syncs to 50; its lowest stored height climbs to within
10 of its height, the block below the lowest is `null` and the lowest itself is present. The
zero evidence age is what lets pruning show at all: a node keeps every block whose time is
within the evidence window of the latest, whatever its retention setting, so that evidence can
still be checked against the validator set and time of its height, and a test chain's seven-day
default would cover every block it will ever make.

**`it('gossips evidence from a node that cannot propose, and decides a height from a fetched block')`**.
The full node (the `watcher`, `consensus.isValidator` false) is given forged duplicate prevotes by
validator 3; within 20 s every validator's app has slashed at that height, so evidence travels by
gossip from a node that could never put it in a block itself. Then `hub.messageFilter` drops
every `proposal` frame addressed to validator 3. It still advances four heights: its
`decisions` counter rises and `blockSync.synced` stays `0n`, so it decided each height by
fetching the block its peers precommitted to, not by block sync.

### test/priorities.test.ts

Three tests on proposer priorities and the header's commitment to them ([03](03-types.md),
[07](07-sync.md)). The helper `shifted(set)` copies a set and moves one unit of priority between
two validators that are not proposing: the members, their powers and the proposer of the moment
are the same, so `hash()` cannot tell the copy from the original, nor could a check of which
proposer each height had, and the sets pick different proposers a few heights on. `reindexed(set)`
keeps every priority and marks another validator as the proposer, by changing the last field of
the set's stored form.

**`it('hashes a set by its members and its priorities apart, and commits a header to the priorities')`**.
A set of three validators with powers 3, 2 and 1 and a copy advanced one round have the same
`hash()` and different `prioritiesHash()`; a plain copy has the same; `shifted` has the same
proposer and another hash; `reindexed` has the same `hash()` and the same priorities and again
another `prioritiesHash()`, so the index is committed to and not only the numbers; a set read
back from its stored encoding has the same. The header's hash over two sets differs with their
order. A header with the field decodes to what was encoded, the hash is its last 32 bytes, a
header changed in that hash alone has another block hash, and `headerFromJson(jsonify(h))` gives
it back and refuses JSON that lacks the field.

**`it('starts a chain under the one protocol version, and refuses a block whose header commits to other priorities')`**.
`genesisState` gives version 1 for a genesis that names none or names 1, and throws
`/protocol version 2; this node runs 1/` and `/protocol version 0/`. `check` builds a bare block
of height 1 on the genesis state with a given `prioritiesHash` and runs
`validateBlockStructure`. With the hash of the state's two sets the block passes the hashes of
the sets; with that of the two sets in the wrong order, of the first set alone, of the first set
`shifted` or of the first set `reindexed`, the answer is `'wrong prioritiesHash'`.

**`it('commits every header to the priorities its node holds, and joins from a snapshot only with the sets the headers commit to')`**.
Four core-application validators, two of them taking snapshots every 6 blocks, run to height 9,
and two validators are stopped so the snapshot at 6 stays the latest. On every node, for
heights 1 to 8, the header's `prioritiesHash` is the hash of the sets the
store keeps by height for that height and the next: what a proposer writes and what a node
serves a joiner are the same thing. A bare `Network` then joins through `stateSync` with a
fresh store each time, and the two sources are made to lie by replacing their store's
`loadValidatorsAt` with one that answers `shifted` sets for chosen heights. With source 0 lying
about height 6 and source 1 honest, the join succeeds at 6 and the three sets of the chain state
it wrote, and the set it stored for height 6, have the honest source's `prioritiesHash`. With
source 0 lying about 8 and source 1 about 7, no peer has a pair for header 7: the join rejects
with `/no peer serves the validator sets of heights 7 and 8/` and each source's score has risen
by more than 40 (one charge of 50, less a moment of decay). With both lying about 6, source 0 this
time with a `reindexed` set, it rejects with `/no peer serves the validator set of height 6/`. Turning the check off in `stateSync` fails the
first of these: the joiner takes the shifted set.

### test/amnesia.test.ts

Eight tests on a validator's lock and on the evidence of one forgotten ([03](03-types.md),
[04](04-consensus.md)), in two groups. The helpers sign votes with a fixed key for height 7:
`precommit(round, hash)` and `prevote(round, hash, polRound)`, and `block(n)` is a hash of 32
bytes `n`.

**`it('signs into a prevote the proof-of-lock round it relies on, and counts two votes that differ in it alone as a double sign')`**.
`checkPolRound` allows a prevote for a block in round 3 to name -1, 0 or 2 and refuses 3, -2 and
0.5, and refuses any round in a prevote for nil or in a precommit. The sign bytes differ with the
round named. A vote comes back from its encoding with the round, and `decodeVote` throws for one
that names its own round or a precommit that names any. In a `VoteSet` the same prevote twice is
added once, and the same prevote naming another round is returned as a conflict with the first.
`makeDuplicateVoteEvidence` of the two puts the lower round first; its shape is good, the two in
the other order are not canonical, the same vote twice is `/the same/`, both signatures verify,
and the signature made for one round does not verify on the vote naming the other.

**`it('writes the lock with the precommit that takes it, and signs a prevote for another block only on a proof of lock from that round on')`**.
A `PrivValidator` on a `FileSignStateStore` in a temporary directory. A prevote and a precommit
for nil lock nothing. A precommit for block 1 in round 1 does, and the file's record holds the
lock beside the precommit's step; a second `PrivValidator` opened on the file has it. A prevote
for block 2 in round 2 naming nothing or round 0 throws `DoubleSignError`
(`/locked in round 1/`) and leaves the last signed step where it was; one naming its own round is
refused by `checkPolRound`. Nil and a precommit for nil are signed and the lock stays at round
1; the locked block is refused naming round 0 or nothing and signed naming round 1. A prevote for block 2 naming round 1 is signed, the
precommit for block 2 in round 4 moves the lock there, and block 1 naming round 3 is then
refused. A proposal keeps the lock in the file; the first vote of height 8 writes `null`. Then a lock
that moves: a second validator precommits block 1 in round 1, prevotes nil and precommits
block 2 in round 2, and is asked to prevote block 2 in round 3 on the majority of round 0.
`isAmnesia` says that prevote with the first precommit would be evidence; the guard refuses it,
and the same naming nothing, and signs it naming round 2, which is evidence with neither
precommit. A guard on a `MemorySignStateStore` refuses the same.

**`it('proves a forgotten lock with a precommit and a later prevote for another block that names no round from the lock on')`**.
A precommit for block 1 in round 2 with a prevote for block 2 in round 5 naming round 1, or in
round 3 naming none, is evidence by `checkEvidenceShape` and `isAmnesia`. Eleven pairs are not,
each with its reason: the prevote names round 2 or round 4; it is for the same block; either
vote is for nil; the prevote is of the precommit's round or an earlier one; the heights or the
validators differ; both are prevotes or both precommits. `evidenceKey` is `amnesia/7/0` for any
pair of that validator and height and `7/5/1/0` for a double prevote in round 5. Both kinds
round-trip through the codec under tags 2 and 1, and tag 5, which no kind has, is refused. `verifyEvidence` passes
the good pair and reports `/bad signature/` for a prevote whose round was changed after
signing, a prevote signed by another key and another chain id, `/unknown validator/` for index
4 in a set of one, and the shape's own message for a pair that is no evidence.

**`it('takes its lock up again after a restart in the same height, and commits nothing else there')`**.
One validator on disk runs to height 3 and is stopped. Its sign-state file is overwritten with
a precommit record for the next height, round 0, holding a lock on `block(9)`, a block nobody
has. Restarted, its consensus has `lockedRound` 0 and `lockedHash` that hash, and `status()`
shows it. It then proposes a fresh block each round and prevotes none: after three rounds its
height has not moved and the store has no block for the next height. Without the lock it
commits the first of those proposals, which is the test failing as it should.

**`it('finds a forgotten lock in the votes it holds, whichever came last, and has every application punish it as one')`**.
Four validators on the toy application. `give` signs votes with a validator's key for the
height after the one a node is in, hands them to that node's `handleVote`, where they are held
until the height starts, and waits for the height to pass. Validator 3: a precommit in round 4
and a prevote for another block in round 6 naming round 2. Validator 2, at another node: the
prevote first, naming nothing, then the precommit. Validator 1: a pair whose prevote names
round 5. Every application ends with exactly two slashes, of kind `amnesia`, for validators 3
and 2 at their heights; the chain's blocks hold two pieces of evidence, both `amnesia`, with
the keys of those two; and nothing was made of validator 1. One validator at a time, because
votes of more than a third of the power in a later round take every node to that round, where
their own honest votes would then stand beside the made-up ones.

**`it('counts for its block only once the majority it names is held, however the votes arrive')`**.
A `HeightVoteSet` over four equal validators. Three prevotes for X in round 3 naming round 1,
with nothing held of round 1: `hasQuorumAny` is true, `roundPower` 3, `hasQuorumFor(X)` false
and `quorumValue` undefined. Two prevotes of round 1 change nothing; the third gives round 1
its majority and round 3 its own in the same call. A fourth round-3 prevote counts as it comes,
and `has` tells it from the same vote naming round 0. A line of three rounds added latest
first (round 5 on 3, round 3 on 1) has no majority anywhere until the last vote of round 1,
then all three. A majority for Y in round 1 and for X in round 2 back nothing that names round
1 for X. Prevotes for nil and precommits count at once. A round with two counted votes and
one waiting has its majority when the waiting one is released. And of two prevotes one
validator signed for the same block in one round, one naming a majority that never was and one
naming nothing, the set keeps the one that counts whichever arrived first, and reports the
conflict both times.

**`it('decides a block proposed again in the next round on prevotes that name the first round, and slashes nobody')`**.
Four validators. For one height a message filter keeps the round-0 proposal from one
validator (it prevotes nil) and keeps the round-0 prevote of round 1's proposer from the
other two (they see two prevotes for the block and one for nil, and precommit nil). Round 1's
proposer sees all three prevotes for the block, locks and precommits alone: its `lockedRound`
is 0 when round 1 begins. The filter is lifted; round 1's proposal is the same block with
`polRound` 0. The block is committed in round 1 with the header of round 0's proposer, every
round-1 prevote for a block seen on the wire names round 0, every node stores the same block,
and no node holds evidence or has slashed anyone. The two validators that lacked a prevote of
round 0 got it from the gossip tick, without which their copies of the round-1 prevotes would
wait.

**`it('prevotes the block its lock moved to on the round of that lock, when the block comes back on an older majority')`**.
One `Consensus` built directly, with a `PrivValidator` in memory, a fixed genesis state, an
`EvidencePool` and timeouts of ten minutes, so only what the test hands it moves it. Its
validator has power 1 beside three of power 10, whose keys the test holds: it proposes none of
rounds 0 to 3, the three others are a majority without it, and two of them are the third that
takes it to a later round. The three are named by the rounds they propose, `p0`, `p1`, `p2`, and
`p0` proposes round 3 as well; what they send is what validators following the rules send in
one possible history, which the test's first comment sets out (`p1` missed round 0's proposal,
`p0` saw round 0's majority only after precommitting nil, and so holds D as its valid block
without being locked). Round 0: block D proposed, `p0`'s prevote for it heard. Round 1: block
B, fresh, prevoted by `p0` and `p1`; with its own that is +2/3, and it precommits B: locked, round 1.
Round 2: `p2`'s round-0 prevote for D arrives and completes that majority, with `p1`'s for nil; D is proposed with `polRound` 0 and
prevoted by the three naming round 0; it prevotes nil, sees their majority and precommits D:
locked on D, round 2. Round 3: D proposed with `polRound` 0 again. Its prevote for D names round
2, and with the two others' it is a majority; it precommits, two more precommits decide D, and
the commit handed to `applyBlock` has its signature. The seven votes it broadcast are listed
with the rounds they name, no precommit and prevote among them are `isAmnesia`, a fresh
`HeightVoteSet` takes them without a conflict, and the pool is empty. The same prevote naming
round 0 is `isAmnesia` with the precommit for B. Naming the proposal's round in `prevote`
fails the test at the prevote of round 3: the guard refuses to sign it.

### test/faults.test.ts

Thirteen tests on the evidence that is not two votes of the height a node is in, on the votes one peer may have verified, and on a validator whose signing is held
([03](03-types.md), [04](04-consensus.md)). The helpers sign votes, proposal heads and whole
proposals with one of four fixed keys. `equal` is a set of the four with power 1 each, and
`pre(i, round, hash, polRound)` a prevote of the validator at index `i` of it for height 7.
`machine()` is the single `Consensus` of the last amnesia case: height 1, the validator under
test with power 1 beside three of power 10 played by the test, timeouts of ten minutes, and an
`EvidencePool` the test reads. It takes the verifier to use, keeps in `sent` every proposal and every proposal head consensus
asks the node to send on (the head with the peer left out), and its `sync(round, hash)` stands
for block sync: from then on the state it serves is at height 1, with a commit of that round as
the last one, and `consensus.restart()` is called.

**`it('are evidence against their signer by the two signatures alone, whatever the blocks were')`**
(`describe('two proposals for one round')`). Two heads signed by one key for height 7, round 3
and two hashes: `makeDuplicateProposalEvidence` puts the lower hash first, the shape is good
and `verifyEvidence` passes on a set of that one validator. The same hash on `polRound` -1 and
1 is evidence too, the lower round first. The shape refuses the same head twice, the wrong
order, a `polRound` of the proposal's own round or below -1, and a negative round.
`verifyEvidence` reports `/bad signature/` when the evidence names another round or height
than was signed, when a head's `polRound` is changed, for a head signed by another key, under
another chain id, and for two heads whose bytes were signed with the vote context instead of
the proposal's; and `/unknown validator/` for index 1 in a set of one. The key is
`proposal/7/3/0`, the tag byte 3, and the evidence comes back from its encoding.

**`it('are reported by a node that is given both in the round, once, and not for the same proposal twice')`**.
The machine is given block D for round 0 twice: nothing in the pool. Block E for round 0 signed
by round 1's proposer: nothing, it is no proposal of the round. E signed by round 0's
proposer: one `duplicateProposal` against that proposer, with the hashes of D and E, which
`verifyEvidence` accepts. A third block F adds nothing, and the validator is still in step
`prevote`: it prevoted D and the round kept D. With the pool's `maxRecordBytes` at 0, two proposals for round 1 leave the pool as it was; with the limit lifted, the second handed in again is taken, so a proof the pool had no room for is not lost. Then two proposals of D for round 2, on
`polRound` 0 and 1, handed in at once with `Promise.all`, so that both are in verification
together and the second finds the first recorded: evidence for round 2 with the two rounds.

**`it('are found by a node that has one and is sent what was signed of the other, which a node sends on where it does not send the proposal')`**.
One machine, and `headOf(round, block)` signs a head with the round's proposer. D for round 0
is taken and sent on whole, and no head with it. A head for round 0 that says D does nothing.
One signed by round 1's proposer costs its sender, `liar`, 20 points for `bad proposal
signature`; one that names `polRound` 0 for round 0 and one for height 9 are dropped without a
charge. The head of E for round 0, signed by its proposer, makes the `duplicateProposal`
against it, which `verifyEvidence` accepts, and is not sent on. For round 1 the proposer's
block has a wrong `appHash`: the proposal is not sent on, and its head is, once, with the peer
it came from left out; the same proposal again sends nothing. The head of the valid block for
round 1 then makes the second proof. For round 2 the head of G comes first: it is kept and
sent on (and not a second time when another peer sends it), and the proposal of H that follows
is both the third proof and, being valid in a round that had no proposal, the round's
proposal, sent on whole. For round 3 a head and then the proposal that says the same: no proof,
and the proposal is sent on. `messagesForPeer` then holds the proposals of rounds 0, 2 and 3
and one head, round 1's. After `sync(4, …)` the height is a kept one that reached round 4:
the head of another block for round 3 makes a fourth proof; a head and a whole proposal for
round 5, which the height never reached, do nothing, and three heads were sent on so far. A
whole proposal for round 4, for which nothing is held, has its head kept and sent on and is
itself not sent on, and the head of another block for round 4 makes the fifth proof. A second
machine has a verifier that counts: one head handed in by three peers at once is verified
once and sent on once.

**`it('are found when the second comes out of verification after the height is over, and when the round decided on a block fetched without a signature')`**.
Two machines. The first has a verifier whose `verifyOne` can be made to wait. D is proposed for
round 0 and taken; E, by the same proposer, is handed in with the verifier holding; `sync`
moves the node to height 2 with nothing in the pool; the verifier is let go, and the pool has a
`duplicateProposal` for height 1. The second machine holds D for round 0 and is given
precommits for E from the three heavy validators and then E itself through
`handleFetchedBlock`: it decides E, and the pool is empty, since a fetched block carries no
signature. The proposer's signed proposal of E then arrives and is the second: evidence, which
verifies.

**`it('is proven by the prevotes of the round it names, when +2/3 of the power prevoted something else there')`**
(`describe('a prevote on a majority that never was')`). Validator 3 prevotes X in round 5 naming
round 2; validators 0, 1 and 2 prevoted Y, nil and Y in round 2. The shape is good and
`verifyEvidence` passes on `equal`, also with the accused's own round-2 prevote for Y in place
of validator 0's. With two prevotes it is `/not \+2\/3/`. Ten shapes are refused, each with its
reason: an accused vote that names no round, is for nil or is a precommit; no prevotes; one of
them for X; one of another round; out of order; one validator twice; a precommit among them;
one of another height. A signature moved from one prevote to another, and an accused vote
altered after signing, are `/bad signature/`; a set without validator 3 refuses the evidence.
Power and not heads: in a set where one validator has 10 and three have 1, the three light
ones are not +2/3 and the heavy one with a light one is. The key is `citation/7/3`, the tag 4.

**`it('is found in the votes held whichever comes last, with no more prevotes than make the +2/3')`**.
`faultsShown` over a `HeightVoteSet`, vote by vote, keeping the first evidence for each key as
the pool does. Four round-2 prevotes for something else and then the false prevote: evidence
with the first three by index (equal powers, so the lowest indices). The false prevote first: nothing after two of the others,
evidence with the third. A round in which two of four prevoted X gives nothing, nor does a
round truly named, nor prevotes of another round than the one named. On seven validators, four
prevote nil in round 1, a fifth prevotes X there, and a sixth names round 1 for X in round 2;
the fifth then signs nil for round 1 too. The set reports the conflict and adds nothing, and
`faultsShown` with that second vote gives the false citation, with it as the fifth prevote
against, whether the set had counted the fifth's first vote or held it waiting. The same with the claim arriving last, after both of the fifth's votes in either order: the set has put the second aside (`alternates`), and the proof is five prevotes for nil. And when the vote put aside later takes the place of the one held (both named a round whose majority came afterwards), the displaced one is put aside in its turn and refutes a later claim. A validator that named round 2 falsely in each of 37 later rounds is proven once by the completing prevote. On five validators of power 5, 4, 2, 1 and 1, one of the 1s names round 2 for Y, which takes four prevotes to refute, and then for X, which takes the two heaviest: the one proof made is the second, with the votes of the 5 and the 4. Three prevotes for Y and one for nil refute a claim for X with the nil and two of the three, since nil is the smaller vote. And 117 claims by one validator for as many blocks are answered by one proof in under half a second. Two validators naming
round 2 falsely are two pieces of evidence when the third prevote against arrives.

**`it('is reported by a node from a prevote held for a later round and the prevotes of the round it is in')`**.
The machine is given a prevote of one heavy validator for round 2, block 9, naming round 0;
it stays in round 0, since 10 of 31 is not a third. Round 0 then goes as it does: D proposed,
the validator's own prevote, one more for D (nothing yet: 11 of 31), and a second (21): one
`falseCitation` in the pool, the three prevotes for D in index order against it, verified.
A second machine is given the same false prevote and then, from one of the two others, a
prevote of round 0 for block 9 before its prevote for D: the second is a conflict, and the pool
ends with a `duplicateVote` against that validator and the `falseCitation` its second vote
completed, both verified.

**`it('goes through the round without a vote, and when it may sign takes its part in the round as it stands, a polka included')`**
(`describe('a validator whose signing is held')`). The machine's `signingHeld` gives a reason.
It is given the proposal of round 0 and the three heavy validators' prevotes for its block:
the state machine is in step `precommit`, the private validator has signed nothing and no
vote of the validator is held. The reason is taken away and `signingResumed()` called: the
validator's prevote for the block, naming no round, and its precommit for it are held, the
private validator's lock is of round 0 and so is the state machine's, in step `precommit`.
Before the lock and the round's marks were taken back on resuming, the prevote named round
0, the signer refused it, and nothing was signed.

**`it('are verified up to a number a second, the rest waiting their turn, and a peer is charged only for what there is no room to keep')`**
(`describe('votes from one peer')`). The machine's clock is one the test moves. One validator's
precommits for nil in rounds 0 to 239, all good votes, are handed in as from the peer `relay`,
which is what a peer that has just connected is sent of a height with many rounds: 200 are
held and nothing is charged. Another peer's vote is taken, and one with no peer behind it. Two
hundred votes already held, sent by the other peer, cost none of its budget: its next new vote
is taken. The forty that wait, sent thirty times more, take no further places and cost nothing.
Six hundred milliseconds on, with the clock unmoved, nothing more is held; once the
clock moves a second, all 240 are, and still nothing is charged. Then 1,300 votes with a
signature of zeros in one second: the budget takes 163, 1,024 wait, and for the rest `relay`
is charged 10 points for `vote flood`, once. A second machine has a verifier that counts and
takes 20 ms: one vote handed in by four peers at once is verified once and held, and two votes
that differ only in the signature, one of zeros and one good, are verified both, and the good
one is held. A vote whose verification throws while a copy of it was dropped is not held at
once and is held a moment later, when it has been tried again.

**`it('offers the pool again, when the next height starts, the evidence it had no room for')`**
(`describe('a height that is over')`). The machine's pool is made to refuse everything while
two precommits of one validator for one round arrive, and the second once more: nothing is in
the pool, and the votes are held, so they would never be looked at again. The pool is put
back, `sync` starts the next height, and the double sign is in the pool.

**`it('keeps the rounds up to the one the height was committed in, when block sync and not this node decided it')`**. The machine, in round 0, is given one validator's
precommits of rounds 5 and 7 (10 of 31, so it stays in round 0), and then `sync(5, …)`: the
height was committed in round 5. The same validator's other precommit for round 5 is evidence
of a double sign at height 1, round 5; its other precommit for round 7 is nothing, since that
round was not kept. With the bound taken from the node's own round alone, round 5 is dropped
and the test fails.

**`it('takes no evidence into the pool that is larger than a block gives it, or beyond the bytes that may wait')`**.
A pool whose `maxRecordBytes` is the size of a duplicate-proposal record refuses a false
citation with three prevotes and takes the smaller record: `size` 1, `bytes` its length.
`markCommitted` with both remembers both, the large one too, and nothing waits; the small one
is not taken a second time. Another record is added and pruned, and `bytes` is 0 again.
`MAX_PENDING_BYTES` is 32 MiB.

**`it('is still held against a late vote, a late proposal and a prevote that named one of its rounds, and every application punishes what they show')`**. Four validators on the toy application, run to height 5.
`late` is a height from 2 to 4 that every node decided in round 0. Two prevotes of validator 3
for round 0 of it, for two made-up blocks, are handed to node 0: whatever it held of validator
3, there are now two in one place, and every application is told of a `duplicateVote` at
`late`. The stored block of `late` with one millisecond added to its time is signed as a
proposal for round 0 by that block's proposer and handed to every node (the stored one, handed
in again, is no second proposal): every application is told of one `duplicateProposal` at
`late`, against the proposer. Two conflicting precommits of another validator for round 5 of
`late`, a round it never reached, are handed to node 1. A prevote of that validator for the
next height, round 1, block 9, naming round 0, is handed to node 2 and held until the height
starts; its round 0 then has +2/3 prevotes for the block proposed, and every application is
told of a `falseCitation`. The chain's blocks carried exactly one piece of evidence of each of
the three kinds and each application was told of three faults: nothing came of the votes of
round 5. Last, once the chain is `PAST_HEIGHTS_KEPT` and three heights past `late`, two
conflicting prevotes of a fourth validator for `late` are handed to node 0, and a second later
the count is still three and the pool is empty.

### test/signing.test.ts

Three tests on the hold a node puts on its validator's signature from its start
([08](08-node.md)), on testnets of `makeTestnet`.

**`it('alone, waits for a peer as long as it is told and then makes the blocks itself')`**
(`describe('a validator that starts')`). One validator, made with `signGraceMs: 1200` and
started. After 700 ms, longer than its propose timeout of 400 ms, it is at height 0 and its
private validator has signed nothing: round 0 was its own and it did not propose. It then
reaches height 2, not sooner than 1,200 ms after the start, and block 1 was committed in
round 0: when the hold ended the validator began the round again and proposed, where a
validator left in the prevote step it had passed would have had nobody to move it on.

**`it('behind its peers and without its sign state, signs nothing in the heights they decided and is not reported')`**.
Four validators to height 3. The one that proposed height 1 in round 0 is stopped, and the
other three go on for two heights. It is made again with an empty store and a new
`MemorySignStateStore`, so it starts at height 0 with a guard that refuses nothing; started so
without the hold, it proposes height 1 a second time, and its peers, which keep what it signed
there, report it (the case fails with the hold taken out). With it the validator catches up, a
later commit carries its precommit, the first signature its sign state store was given (the
store notes the height of each) is of a height above the one its peers had decided when it
started, no node has evidence pending and no block of the chain
carries any.

**`it('is not kept from signing by a peer that says it is ahead and serves none of the blocks')`**.
One validator with `signGraceMs: 1500`, and a bare `Network` that dials it, gives height 100
in its handshake, broadcasts a `status` of 100 every 100 ms and answers no request. Two
seconds after it connected, past the grace, the validator is at height 0 and has signed
nothing. Its request for the blocks then times out, the peer is left out of `levelWith`
however often it repeats its height, and the validator reaches height 2 within fifteen
seconds with the peer still connected.

### test/review.test.ts

Thirty-one regression tests. Twenty are one per finding of
[REVIEW-2026-10-28.md](../../REVIEW-2026-10-28.md) that was fixed with a test: thirteen from
the review itself and seven from its later section "Found while documenting" (findings 37 to
49), which records what writing this tutorial turned up. The other eleven came from a later
pass over the same code and pin behaviour of the same kind that the first twenty did not
reach. A regression test reproduces a bug that was found and fixed, so that it can never
return unnoticed: it is written to fail on the code before the fix and pass after. Most are
unit tests, many on a `CoreApp` with one genesis validator `opa` (consensus key `consA`) and a
5% double-sign slash; six run on a network. The later cases reach into more of the system than
the first, which shows in the file's imports: `Mempool` and `Application` for the pool,
`MemoryKv`, `KvWriter`, `KvEnv` and `KvBlockStore` for the store, `WorkerVerifier`, `sign` and
`signContext` for the verification pool, `ml_dsa44` from the post-quantum library for a hedged
signature, `bond` and `reward` for the exchange-rate edges, `checkStakingParameters` with
`MAX_DURATION_MS` and `MAX_SHARE_SUPPLY` for the parameter bounds, `ValidatorSet` for the
total-power bound, `KvStoreApp` for the toy application's validator updates, `decodeMessage`
and `VoteType` for filtering consensus traffic, `LightClient`, `NodeProvider` and `headerHash`
for the anchor, `verifyObjectProof` for proofs after a restart, and `mkdtempSync` for a data
directory to lock.

**`it('rejects decoded validator sets with duplicate members, wrong order or a bad proposer index')`**
(describe `review regressions`). Finding 1, critical: the binary decoder accepted duplicate
keys, which let one trusted key forge light-client trust. The test hand-encodes a set with the
same validator twice (`/duplicate/`), the two validators in reverse order (`/out of order/`) and a
proposer index of 5 (`/proposer index/`); a correct encoding decodes to size 2.

**`it('does not let a cached verification vouch for different signature bytes')`**. Finding 2,
critical: the signature cache was keyed by body and signer, so a corrupted signature on a body
seen before was accepted by warm nodes and rejected by cold ones, splitting state. `checkTx` of
a valid registration primes the cache; the same body with an all-zero signature in a block fails
with `/invalid signature/` and alice does not exist; a cold app that never ran `checkTx` produces
the identical error and the identical app hash.

**`it('resolves keys per transaction as the block executes, so a warm and a cold node agree')`**.
Finding 3, critical: all signing keys were resolved before any transaction executed, so `T1`
(alice hands her active authority to bob) followed by `T2` (bob spends from alice) executed on a
node that had checked both in the mempool and failed on a cold one. Now `[t1, t2]` gives
`[true, true]` on both and the same hash, and `[t2, t1]` gives `[false, true]` with identical
errors and hashes on both. Note `t2`'s expiration is `+ 1n` so it is not a duplicate of any other
transaction.

**`it('refuses issuing the core asset')`**. Finding 27: `assetIssue` of `CORE` by the faucet,
its genesis issuer, is refused in `checkTx` with `/minted by the chain/`, so the supply
invariant cannot be broken by a transaction.

**`it('refuses a delegation worth no shares, one that would overflow the validator, and declines a reward it cannot mint commission on')`**.
Finding 7 and two edges of the exchange rate, on a bare `ObjectDatabase` with hand-made
validators. One holding 1,000,000,001 tokens over 1,000 shares (rewards drove the rate so high
that 100,000 base units buy no whole share) refuses `bond` with `/no shares/`, instead of taking
the tokens and handing back a delegation that owns nothing. One holding `2n ** 64n - 1n` shares
refuses with `/overflow/`, instead of passing admission and throwing `u64 out of range` after
the block was decided. One slashed to zero tokens with 1,000 shares still outstanding makes
`reward` return `false`: there is no rate to mint commission at, and the pool keeps the reward.

**`it('accepts both valid signatures a key can make over one body, whichever was seen first')`**.
The chain's own signer is deterministic, but FIPS 204's default is hedged, so the test signs
the same body a second time with `ml_dsa44.sign` and fresh entropy and gets different valid
bytes, prefixed with the `Scheme.mlDsa44` tag before they go into the transaction, as every
signature on the wire is. The case is declared with `it.skipIf(DEFAULT_SCHEME !== Scheme.mlDsa44)`:
it is about ML-DSA signing, and it is the one case `CHAIN_SCHEME=secp256k1 npm test` skips.
`checkTx` admits the hedged copy, so the cache has seen that one; a block carrying the
deterministic copy first and the hedged one second gives `['ok', 'duplicate transaction']`.
The first is accepted although it was never checked (its signature verifies and is cached in
its own right), and the second is the same transaction again. A cache keyed per signer and
signature, holding a set rather than one hash, is what lets both coexist.

**`it('rolls a block back when verification fails half way, and applies it cleanly on a retry')`**.
A verifier whose `verify` throws `verifier closed` on its first call. `finalizeBlock` on an
application with it rejects with that error and `lastHeight` is still 1: the block session
undid every change the block had made before the throw. With the verifier working again, the
same block applies and its app hash equals that of a clean application fed the same block, so
nothing of the failed attempt survived into the retry.

**`it('bounds staking parameters so every derived timestamp and amount stays representable')`**.
`checkStakingParameters` accepts the defaults and names the offending field for an
`unbondingPeriodMs` of `2n ** 64n - 1n`, a `downtimeJailMs` of `MAX_DURATION_MS + 1n`, a
`minSelfBond` of `0n` and a `fixedRewardPerBlock` above `MAX_SHARE_SUPPLY`.

**`it('refuses validator powers whose total a priority could not track')`**. `ValidatorSet.create`
with two validators of power `2n ** 63n` throws `/total power/`: proposer priorities are
signed 64-bit arithmetic over the total, and a total past `MAX_TOTAL_POWER` would overflow it.

**`it('encodes only well-formed strings')`**. The writer refuses a lone surrogate (`'\uD800'`)
with `/well-formed/`, and a string with an emoji round-trips. A lone surrogate has no UTF-8
encoding, so `TextEncoder` would substitute a replacement character and the string would not
decode to what was given.

**`it('checks a transaction again after a check that threw, instead of calling it seen')`**. A
fake `Application` whose first `checkTx` throws; `addTx` rejects with that error, and the same
bytes submitted again are `'added'`, not `'seen'`: a check that never finished leaves nothing in
the seen cache.

**`it('has the test application refuse a validator update the engine could not apply, and fold repeated ones')`**.
The toy `KvStoreApp`, initialised with alice as its only validator, is given a block of
`val:bob:0`, `val:bob:5` and `val:bob:7`: the results are `[false, true, true]`, since
removing a validator that is not in the set is refused, and the one update reported is
`{ bob, 7n }`, since two updates for one key in a block fold into the last. The engine would
reject a block whose updates removed an unknown key or named one key twice.

**`it('still punishes a double sign reported against a rotated key, and never reuses a key')`**.
Finding 9: rotating a consensus key removed the old address mapping, so evidence against the old
key found no validator. The operator rotates `consA` to `consB`; rotating back to `consA` is
`/already in use/` (a key is never reusable); evidence against `consA` at the earlier height
still tombstones the validator.

**`it('slashes stake that was unbonding during the two-height delay')`**. Finding 10: unbonding
entries created at or before the infraction height were exempt, although stake undelegated at `H`
still signs at `H + 1`. The faucet undelegates at `undelegateHeight`; evidence for
`undelegateHeight + 1n` slashes the entry by 5%:

```ts
    expect(after.tokens).toBe(entry.tokens - (entry.tokens * 500n) / 10_000n);
```

**`it('drops a virtual history entry when the transaction it belongs to fails')`**. Finding 28:
an `unjail` wrote a history entry outside the transaction's discardable buffer, so a failed
transaction left a successful-looking entry. The validator is jailed by four unsigned blocks;
after the jail period a transaction of `unjail` followed by a transfer of a million tokens the
operator does not have fails as a whole, the validator stays jailed, and the operator's history has
no `unjail` entry.

**`it('rebuilds index history correctly when two objects swap keys in one version')`**. Finding
12: rebuilding index versions interleaved each object's deletion and insertion, so swapping two
unique keys in one block made every affected node fail to restart. Objects `a` and `b` swap names
through `tmp` in version 1; a fresh database with the exported objects, the version's history and
`rebuildIndexVersions()` must not throw.

**`it('prunes sparse tree versions even with a zero retention window')`**. Finding 29: with
`retainVersions: 0` the sparse tree never pruned. After five commits, `rootAt(3)` is
`/not available/` and `rootAt(4)` is defined.

**`it('keeps per-block results so a repeated transaction proves its real outcome at each position')`**.
Finding 18: one location per hash meant that a block containing the same transaction twice
(success, then duplicate failure) indexed only the failure, and the result proof for it failed. A
`MemoryBlockStore` saves a block with `[raw, raw]` and results `[ok, duplicate transaction]`;
`txLocation` reports height 5, index 0, `ok: true`; `loadResults(5n)` holds both; the result
proof at index 1 verifies and says `ok: false`.

**`it('does a bounded amount of work on a peer status it cannot act on')`**. Finding 30: block
sync recursed between its check and drain steps on every peer status it could not act on, until
the stack overflowed. A `BlockSync` is built over a fake network with hand-written deps (a
`getState` that counts calls, a `validatorSetAtHeight` and a `blockTimeAt` that answer `null`,
an empty requester); one status message announcing height 10 from a peer nobody can fetch from
must cause fewer than 10 state reads (the review records 7,492 before the fix).

**`it('decodes a string to exactly what was encoded, byte-order mark included, and refuses malformed UTF-8')`**.
Finding 41: `TextDecoder` strips a leading U+FEFF by default, so a string beginning with a
byte-order mark did not decode to what was encoded and the codec was not a bijection. The
string `'﻿name'` survives `encode` and `decode` unchanged, and the two bytes `0xff 0xfe`
written as `bytes` and read back as a `string` throw rather than decoding to a replacement
character. Everything hashed or signed goes through this codec, so a string that does not round
trip is a string two nodes could disagree about.

**`it('does not remember a transaction it refused because the pool filled while checking it')`**.
Finding 38: the seen cache is written before `checkTx` runs, so a duplicate submitted at the
same moment is checked once; but a transaction refused as `'full'` after its check stayed in the
cache, and resubmitting it answered `'seen'` until the cache rolled over. A fake `Application`
whose `checkTx` waits on a gate promise; a `Mempool` with `maxTxs: 1`; two `addTx` calls are
started, then the gate is released: the first is `'added'`, the second `'full'`. Resubmitting
the second is `'full'` again, not `'seen'`, and once `update` removes the first it is
`'added'`.

**`it('saves everything a height needs to the block store in one transaction')`**. Finding 39:
DESIGN.md says a decided height's block, commit and state land in one store transaction, but
the executor wrote them in four, so a crash in between could leave a block indexed without the
state that goes with it. A `Counting` subclass of `MemoryKv` counts calls to `write`. Inside
`store.batch(() => { ... })` (the count set back to 0 once the store is open, since opening a new
store writes the layout of its transaction index once) the test saves a validator set, the set at height 3 and the lowest
height; `kv.writes` is 1 and `loadValidatorsAt(3n)` reads the set back. A `setLowestHeight`
outside a batch costs a second write. The executor saves every decided height inside such a
batch.

**`it('proves a past height for an object type nothing changed in the window, after a restart')`**.
Finding 44: on reload, history lowered a tree's version floor only for the object types a
record named, so a type untouched in every retained version kept its floor at the restart
height, and `proofAt` refused earlier heights that `lowestVersion` admitted. Accounts on a quiet
chain are exactly such a type. A `CoreApp` on a `MemoryKv` runs four blocks, the last three each
a transfer of `T(1)` from the faucet to `opa`, so balances change in every version and accounts
in none. A second app opened on the same store is at height 4, and `proofAt(id, 2n)` for the
balance object `objectId(TYPE.balance, 0)` and for the faucet account both verify against
`reopened.db.rootAt(2)`.

**`it('replaces a verification worker that dies, failing only the jobs it held')`**. A
`WorkerVerifier(1)` with 300 `verifyOne` calls in flight; the test terminates its one worker
through the pool's private `workers` array. Some of the pending promises reject with
`/exited/`, the jobs that worker held, and a fresh `verifyOne` afterwards returns `true` from the
replacement started in the same slot. A worker that dies for any reason, out of memory or
killed, takes its jobs down with it and nothing else; the pool stays usable.

**`it('settles pending verifications when the worker pool closes')`**. Finding 40: a failed
worker rejected every pending job in the pool and stayed in the rotation, and `close()`
terminated workers without settling what they still held, so a caller could wait forever. A
`WorkerVerifier(1)` receives 500 copies of one valid job; the expectation
`rejects.toThrow(/verifier closed/)` is attached to the pending promise before `close()` is
called, "so the rejection is never unhandled", and after `await pool.close()` the rejection
arrives. A closed pool settles what it owes.

**`it('resumes after a restart that left a signature at the current height, by skipping that round')`**
(describe `review regressions on a network`). Finding 5: a validator restarted at an unfinished
height recreated different proposal bytes for round 0, which the signing guard refused, and
consensus stayed in `propose` forever. A single validator with a data directory reaches height 3
and stops; the test writes a `FileSignStateStore` record for height `h + 1`, round 0, step
`Propose`, with fake sign bytes, as if the node had signed a proposal before dying. The restarted
node must reach `h + 2`, and the commit at `h + 1` must be from round 1 or later: it skipped the
round the guard had signed in.

**`it('survives an aborted request body on the RPC')`**. Finding 13: an error while reading a
request body escaped the handler as an unhandled rejection and could terminate the node. A raw
TCP connection sends a POST with `Content-Length: 500` and ten bytes of body, then destroys the
socket; 100 ms later `rpc.status()` still answers with the chain id.

**`it('decides a block re-proposed with a proof of lock after its round stalled past the clock drift limit')`**.
Finding 37, the most serious of the later findings: the clock-drift check ran on every proposal,
including the re-proposal of a block that already had a polka and whose time was set by its
first proposer, so a round that stalled longer than the drift limit (15 s by default) could
never decide that block and the height stalled for good; CometBFT checks timeliness only on
fresh proposals. Four validators with `limits: { maxClockDriftMs: 300 }`. At two consecutive
target heights (so that at least one has a proposer other than node 3) the hub's
`messageFilter` drops three kinds of frame: the round 0 proposal addressed to node 3, which
therefore prevotes and precommits nil; every round 0 prevote addressed to node 2, from anyone,
so that it never sees the polka and precommits nil; and every round 1 proposal, so that round 1
is lost entirely. Nodes 0 and 1 see the polka, lock and precommit, so no node holds three
precommits for the block and the round ends on three precommits of any kind; the block is
re-proposed with `polRound` 0 in round 2 or later, a second or more after it was built and far
past the 300 ms drift limit. The single assertion is liveness:

```ts
    await waitForHeight(n.nodes, n.nodes[0]!.height + 4n, 30_000);
```

The filter is shaped by a lesson about the test itself. Its first version dropped only the
round 0 prevotes that nodes 0 and 1 sent to node 2 and let round 1 through, and it was found not
to fail with the fix reverted: it ran in under a second, because votes are flooded, so node 2
received the round 0 prevotes relayed by node 3, reached the polka after all, and the height was
decided in round 0 with nothing to re-propose. A regression test that passes without the fix
guards nothing. The rebuilt filter was checked both ways: with the fix the test passes in about
7 s, and with it reverted all four nodes sit at the first target height for the full 30 s.

**`it('persists a decided height to the chain store in one transaction')`**. A `Recording`
subclass of `MemoryKv` notes the set of key prefixes each `write` touched, and a single
validator runs on a hand-built `KvEnv` whose `chain` store is that recorder, whose other stores
are fresh `MemoryKv`s and whose `transaction` just runs its callback. By height 3, at least
three batches hold the block (`'b'`), the validator set by height (`'V'`) and the chain state
(`'s'`) together, and no batch holds a block without the other two. Where finding 39's test
checks the store's `batch` in isolation, this one checks that the executor uses it for every
decided height on a live node.

**`it('refuses a second node on a data directory that is in use')`**. One validator on a
temporary directory; `makeNode(0)` for the same directory rejects with `/in use/`, the `LOCK`
file holding the first node's PID. After the testnet stops, the directory can be opened again
and the new node stopped: the lock is released with the node, not left behind.

**`it('refuses a light client anchor older than the trusting period')`**. Finding 43:
`LightClient.trust` checked the anchor's hash and commit but not its age, so a stale anchor was
accepted until the first verification step, and a set that had since unbonded could have signed
it. Two validators; with header 2's hash as the anchor, `trust` with `trustingPeriodMs: 1n`
rejects with `/trusting period/`, while with the default period the same anchor is accepted and
`trusted.header.height` is 2. `test/light.test.ts` makes the same check at the anchor on a larger network. The
trusting-period rule of `timeProblem`, applied at each verification step once the clock has
moved on from the anchor, has its case in `test/review5-rpc.test.ts`, below: "verifies no
header from a trusted one that has reached the trusting period, the next one or a later one".

Findings fixed with tests elsewhere: 33 in `test/network.test.ts` (a message sent the instant a
peer connects), 25 and 31 in `test/rpc.test.ts` (event streams and replay), 36 in
`test/genesis.test.ts` (`lastChanges` is `null` after genesis and reopen), and 35 in
`test/genesis.test.ts` (the streaming genesis parser). Of the later findings, 42, 45, 46 and 47
were fixed without a regression test, 48 is a dead-code and naming pass that also replaced the
staking assertion noted above, and 49 brought the specifications in line with the code.

### test/review2.test.ts

Five tests, each spanning more than one layer, from the same later pass that added the eleven
cases above to `test/review.test.ts`, and extended since as later passes touched the same seams.
They were kept apart because each one exercises a seam between modules rather than one module:
JSON and headers, the peer database and the keystore, the RPC's parameters, its listing cursor
and its notifications, the light client and its provider in both directions, and retention
against the evidence window. The first two are unit tests under
`describe('second review: representation and parameters')`; the other three run a testnet under
`describe('second review: over the network')`, with an `RpcServer` stopped before the network
in `afterEach`.

**`it('refuses a header whose bytes moved between hash fields, and integers a double cannot hold')`**.
A header whose every hash field is 32 bytes of a different fill value is turned into JSON with
`jsonify` and back with `headerFromJson`, and hashes to the same value. Then `lastCommitHash`'s
32 bytes are appended to `lastBlockHash` and `lastCommitHash` is emptied: the concatenation of
the fields is unchanged, so the header hash would be too, and only the sizes can stop it;
`headerFromJson` refuses with `/lastBlockHash must be 32 bytes/`, and a `proposerAddress` of 20
bytes with `/proposerAddress must be 32 bytes/`. `parseBigint(2 ** 53)` and `parseBigint(-1)`
throw `/integer/`, while `parseBigint(7)` is `7n`.

**`it('bounds the peer database and refuses an unnamed key')`**. A `PeerDb` offered 4,146
distinct addresses accepts exactly `MAX_RECORDS` (4,096) of them and reports that size. On a
fresh keystore, `add('')` throws `/needs a name/`; after `add('alice')`, `open` with another
passphrase throws `/wrong passphrase/`. Then two handles are opened over the same file: `a`
adds `a` and `b` adds `b`, and a third `open` lists `['a', 'alice', 'b']`, so each write merged
into what was on disk instead of overwriting the other's; `b.add('a')` throws
`/already exists/`, because `b`'s own write re-read the file and its view now holds `a`;
`a.remove('b')` is gone on the next `open`; and no `keystore.json.lock` is left behind.

**`it('holds the RPC to its parameter types, seeks listing cursors, and does not wait for a transaction it has already refused')`**.
Four core-application validators and an RPC server. `reverse: 'false'`, `prove: 'false'`,
`limit: '5'` and `height: 2 ** 53` are each refused with `-32602`, and `accounts` with
`limit: 0` is `[]`. After alice is registered in commit mode, the listing pages by cursor: no
cursor gives `['alice', 'faucet']`, `after: 'alice'` gives `['faucet']`, `after: 'b'` (a name
nobody has) also gives `['faucet']`, and `after: 'faucet'` gives `[]`. A transfer from the
faucet signed by alice is `-32002` in sync mode; the same bytes in commit mode with a 20 s
timeout are `-32002` again in under 5 s, because a transaction the mempool has already refused
is not waited for. A raw request with `id: { a: 1 }` is answered with `-32600`. A raw `status`
request with no `id` at all is a notification: the answer is HTTP 204 with an empty body. A
batch of a notification, a `status` request with `id: 7` and a notification for the method
`nothing` is answered with an array whose ids are exactly `[7]`: the request with an id gets
its response, and neither notification gets one, not even the one for an unknown method.

**`it('binds a served header to the height asked for and refuses an anchor from the future')`**.
A client trusts height 2 through an honest `NodeProvider`, then has its provider swapped for
one that answers `signedHeader(h)` with the genuine header `h + 1`; `verifyToHeight(4)` rejects
with `/answered height 4 with header 5/`. Two anchors are refused at `trust`: one with a `now`
sixty seconds before the anchor's own time (`/from the future/`), and one with a ten-second
trusting period and a `now` exactly ten seconds after the anchor (`/trusting period/`). Then
backward verification: a client anchored at height 4 by hash walks back with
`verifyBackward(2n)` to a header hashing to the honest header 2; height 0 is refused with
`/not a block/` and height 5 with `/after the trusted height/`; a provider whose `header(3n)`
returns the real header with its `appHash` zeroed is caught with
`/header 3 is not the one header 4 names/`, since the altered header no longer hashes to header
4's `lastBlockHash`; and a client with `maxBackwardSteps: 1` refuses the two-step walk with
`/more than 1 headers before/`.

**`it('keeps blocks the evidence window may still name, whatever the retention setting')`**.
Four validators reach height 6; a fifth node with `retain: { blocks: 2 }` syncs to 8. Its
lowest stored height is still 1 and block 1 loads, because every block within the seven-day
evidence age of the latest is kept whatever the retention floor says. The sync test's pruning
node sets `maxEvidenceAgeMs: 0n` for exactly this reason.

### test/review3.test.ts

Twelve regressions for the findings of the review of the paging and scheme commits: the memory
guard, the node and the signature schemes. They are listed here by group and title, without
the walk-through the other suites have. `the signature cache`: "keeps a block result the same
when shedding clears the cache while the block verifies" and "holds a bounded number of
signatures however many valid variants of one body arrive". `the heap limit`: "is the one Node
applies: the command line over NODE_OPTIONS, quoted options, either spelling" and "set by the
operator in any spelling keeps `start` from putting its own over it". `a node at the critical
level`: "tells a listener added after its first sample the level it is already at" and "stops
its RPC server even while a client holds a request open". `a mempool paused while transactions
are being checked`: "refuses the checks that finish after the pause, without pooling,
gossiping or remembering them" (the pause is now the node's `critical` level only, but the
mempool's handling of it is what this case holds). `secp256k1 public keys`: "are refused
wherever a key enters the chain unless they are points on the curve". `a restart with another
scheme in genesis`: "is refused, by the application state and by the chain state alike". `the
p2p handshake`: "connects peers of the chain scheme and refuses a peer keyed under the other
one, in either direction". `a keystore entry whose scheme was changed`: "fails to open rather
than give another key under the same name" (a key whose `scheme` field was removed is
refused with either message, that it does not derive the recorded key or, the file being
version 2, that it names no scheme). `CHAIN_SCHEME`: "is not read by the node code, so a
stray value cannot stop a node from starting".

### test/review4.test.ts

Thirteen tests, for the thirteen items the first review noted and left (REVIEW-2026-10-28.md,
"Fourth pass: the judgement calls") and for the transaction index as it was put in
segments (six of them), listed by group and title with what each sets up and
asserts.

`state queries at a height, and a batch that pays for its calls`, one case on a testnet with an
`RpcServer`, both stopped in `afterEach`.

**`it('answers balance, account, key, validator and delegation as of the height asked for, with the proof of that height')`**.
Four validators of the core application, made with `engineValidators: false` and a staking
genesis (a faucet, four operators `op0` to `op3`, each validator with a self-bond of 200, an
unbonding period of 2 s), and an RPC server on node 0, given a rate of 10,000 a second and a
burst of 10,000 because the case makes many costly calls in a row. Four transactions go in through `broadcastTx` in commit mode, so the
height of each is known: `created` registers alice, `paid` transfers her 5,000 base units,
`delegated` delegates 300 tokens from the faucet to `op0`'s validator, `paidAgain` transfers 700
more; a `validator` answer for `op0` is kept from before the delegation. `balance` for alice is
`5700` now and `5000` at `paid`, with `height` echoed; by id `3.5` at `created - 1` it is `0`,
and by name there it is `-32001`, since the name led nowhere before the account existed. A
height of 99,999 is `-32001` with `/is not kept/` on `balance`, and `-32001` on `object`. `key`
on `account`/`byName` for alice's name gives `3.5` at `created` and `null` at `created - 1`,
with a proof that `verifyKeyProof` accepts as absence (`null`) against the app hash of header
`created`; `account` at `created - 1` is `null` with a proof that verifies the same way. At
`paid`, `account` has id `3.5`, one balance of `CORE` at `5000`, `history` of `'2'`, and a proof
that verifies against header `paid + 1` to the encoding of alice's id; with no height it has
`5700` and `'3'`. `account` for `NOT A NAME` is `null`. `validator` for `op0` at
`delegated - 1` has the tokens of the answer kept from before, a `delegators` of 1 (the
operator's own delegation), the
self-bond it has now and `operatorName` `op0`; now it has 300 tokens more and two delegators.
`delegation` of the faucet to `op0` at `delegated - 1` is `{ delegation: null, unbonding: [] }`
with a proof of absence against header `delegated`; now its `tokens` are the amount delegated
and `unbonding` is `[]`. Next the objects are removed and the past is asked again. The faucet
undelegates a third of its shares at height `partly` and the rest at `wholly`, which removes
the delegation; the test polls `delegation` until `unbonding` is empty, up to 20 s, the two
entries maturing after 2 s and being removed. Now `delegation` is `null` and `validator` has
1 delegator. At `partly` the delegation is not `null`, `unbonding` has one entry and the
validator has 2 delegators; at `wholly` the delegation is `null`, `unbonding` has two entries
whose tokens sum to the 300 tokens delegated, and the validator has 1 delegator; at
`delegated` `unbonding` is `[]`. None of the entries and neither state of the delegation is
in the index of today: the answers come from `listAt` and `changedSince`
([chapter 12](12-rpc.md)). Then the test waits until every peer of node 0 has a `clockOffsetMs`
and requires the absolute value of each one `peers` returns to be under 1,000: the nodes share one
clock.
Last, a second server on the same node with `ratePerSecond: 0.001` and `burst: 6` is sent two
batches of five `status` calls: the first has five answers and no `-32004`; the second has ids
`[0, 1, 2, 3, 4]` and four `-32004`, one call being answered with the token the first batch
left.

`the transaction index`, six cases on block stores, with a `block(height, txs)` helper that
builds a header of zero hashes with the transactions' data hash and a commit for it.

**`it('keeps every block a transaction is in, answers with the one it succeeded in, and loses only the pruned one')`**.
On a `MemoryBlockStore`, one transaction is saved in block 5 with a failed result
(`insufficient balance`), and `txLocation` gives height 5, `ok: false` and that error. It is
saved again in block 8 at position 1 with success and in block 9 with `duplicate transaction`.
`txLocations` is `[5, 0, false]`, `[8, 1, true]`, `[9, 0, false]`, and `txLocation` is height 8,
index 1, `ok: true`: the success, not the newest. After `deleteBlock(8n)` the heights are 5 and
9 and `txLocation` is height 9, `ok: false`; after blocks 5 and 9 are deleted it is `null`, as
it is for the other transaction of block 8.

**`it('finds a transaction in whichever segments hold it, with blocks far apart and segments missing between')`**.
A `KvBlockStore` on a `MemoryKv` is given fourteen blocks of two transactions each, at heights
1, 2, 3, 30, 31, 32, 33, 64, 500, 1,000, 1,001, 69,999, 70,000 and 90,000, which lie in seven
segments of 32 blocks. Five of them (3, 31, 32, 1,000 and 70,000, in four segments) carry one
transaction at position 1, failed with the error `at <height>`. `txLocations` of its hash is
those five heights in order, each with index 1 and its error, and `txLocation` is height 70,000,
the newest, since it succeeded nowhere. A transaction that is in one block only (1, 500 or
90,000) has that one height, and a hash of 32 zero bytes and one of 32 `0xff` bytes, which sort
before and after every entry of a segment, have none. A second store over the same data through
a wrapper that counts range reads makes at most 25 for one `txLocations`: two per segment held
and one for each of the eleven levels above, not one per entry. By then most of the entries
have moved: saving block 69,999 found the first 1,024 blocks all behind it, and the last saves
took them on to level 2. Every key under `'x'` starts with its block's segment, the u64 after
the prefix being the height at the key's end divided by `TX_SEGMENT_BLOCKS`; every key under
`'y'` is of level 1 or 2 and names the height divided by 1,024 or 32,768; at least 22 are under
`'y'`, and the keys of both hold 28 different pairs of hash and height. Three keys that are not
entries are then put under the prefix: one of 41 bytes, segment 0 and the transaction's hash
with no height, which sorts just before an entry of that hash; one of 2 bytes, `'x'` and `0xff`;
and one of 9 bytes, `'x'` and segment 40. `txLocations` of the transaction is still the five
heights and that of the transaction of block 90,000 still its one, a key of another length being
skipped before anything is read from it; the three keys are deleted again. After
`deleteBlock(32n)` and `deleteBlock(1000n)` the heights are 3, 31 and 70,000, the other
transaction of block 1,000 is `null` and one of block 1,001 is still found.

**`it('moves entries into larger segments behind the latest block, and a lookup asks a few segments however long the chain')`**.
A `KvBlockStore` on a `MemoryKv` is given 34,000 blocks one after another, each with one
transaction of its own and every 700th with `raw` as well, failed with `at <height>`. A second
store over another `MemoryKv` is given the same blocks through a wrapper whose every seventh
`write` throws after the callback has written everything, the step of the move included, each
failed save being made again. At block 1,023 the first store has 1,024
entries under `'x'` and none above: no segment of 1,024 blocks is yet all behind the latest. At
the end the two stores hold the same keys and values under `'x'` and `'y'`: a step that was
undone and made again leaves what one made once leaves. Level 2 holds 32,813 entries, heights 1
to 32,767 and `raw` in 46 of them, in one segment; level 1 holds at most two segments and
level 0 at most forty, and the three levels together hold every entry once, or twice for the
fewer than 600 that are copied and not yet removed. Every 97th block's transaction has its one
location, `raw` its 48 with their errors, and one `txLocations` through a wrapper that counts
range reads makes at most 95, where the 1,063 small segments the blocks were written to would
have taken one or two each. Then a block saved again: block 5 with its result failed, long
after its entry went up. `txLocations` answers `[5, false]` at once, from level 0, and after
eight more blocks still does, with nothing left in segment 0 of level 0: the entry was copied
over the old value above and removed below.
`deleteBlock(1400n)`, a block in the middle, leaves `raw` with 47 locations and block 1,400's
own transaction with none, though their copies are still in level 2. Last, pruning: one batch
deletes heights 1 to 32,999 and sets the lowest height to 33,000. `raw` is at once found at
33,600 only. After 72 more blocks level 2 is empty, its one segment lying wholly below the
lowest height, and level 1 holds 1,026 entries, the segment the lowest height is in: heights
32,768 to 33,791 and `raw` at 32,900 and 33,600. Every 53rd block from 33,000 on has its
location, and block 32,999 has none.

**`it('keeps a result saved while its entry is on the way up, moves a crowded block and backfilled ones, and asks for no block to answer')`**.
Four things in one case, each on a `KvBlockStore` over a fresh `MemoryKv`. First, twice over:
blocks of one transaction are saved until the state under `'m'` and level 0 says the first
1,024 are being removed, at which point block 900's entry is still in its small segment. Block
900 is then saved again with its result failed and the error `later`, the first time alone and
the second time in one `batch` with the next block. `txLocations` of its transaction is
`[900, false, 'later']` at once, and again after eight more blocks, when nothing below height
1,024 is left in level 0; block 899's is still `[899, true]`. A removal that did not compare
values would have removed the new entry and left the old copy to answer; without reads that see
the transaction's own writes the memory store did exactly that.

Second, 1,054 blocks of which only block 10 has transactions, 5,000 of them. All 5,000 are in
one of the 32 segments. After block 1,054 level 0 is empty and level 1 holds 5,000 entries: a
step takes its budget of 512 from whichever segments have entries, ten steps to copy and ten to
remove. Third, on that store, a lookup through a wrapper that counts `get` calls for keys
under `'b'` and passes `has` through: the transaction is found in level 1 and no block is
read.

Fourth, a node that joined at height 3,000. Block 3,000 is saved with `null` results and the
lowest height set to it; then, thirty times, one block is applied (one transaction, results
given) and a batch backfills the hundred blocks below the lowest, ten transactions each with
`null` results, and lowers the lowest height. When the backfill reaches height 1 the latest
block is 3,030 and no height from 1,024 to 2,047 is left in level 0: those 10,240 entries moved
up in the saves that brought the blocks below them, where thirty steps of 512 made for applied
blocks alone could not have moved them. The first 1,024 could not move before the lowest height
was 1; after 45 more applied blocks they have, and level 0 holds 9,605 entries, the 953
backfilled blocks from 2,048 and the 75 applied ones, whose larger segment became due at block
3,072 and is being copied. Every 71st block's transaction has its one location, with `ok` null
for a backfilled block and true for an applied one.

**`it('fills the larger segments on a store that never recorded its latest block, and past keys that are not entries')`**.
Two stores. The first is made as the version before the larger segments left one: the lowest
height set to 2,000, blocks 2,000 to 2,100 saved with results, a chain state with `lastHeight`
2,100 saved (`genesisState` with one validator, the height replaced), and the key `'M'`
deleted. Then only a backfill: 1,999 batches, each saving the block below the lowest height
with `null` results and lowering the lowest height, and no block applied. Afterwards `'M'`
holds 2,100, taken from the chain state by the first save that found it missing; no height
from 1,024 to 2,047 is left in level 0 and level 1 holds at least 1,024 entries; block 1,500's
transaction is found with `ok` null and block 2,050's with `ok` true. Without the marker every
step would have taken the latest block to be 0 and moved nothing.

The second store has seventy keys under `'x'` that are not entries (the prefix, segment 0 and
one byte) before its first entry. Blocks of one transaction are saved to 1,020 and then until
the state under `'m'` says the small segments are being emptied into the first segment of level 1, which is before block
1,035: the steps removed the seventy, 64 in one step and six in the next, and went on. Seventy
more are then put in segment 20, among entries the removal has not reached. Twelve blocks later
no key under `'x'` has a length other than an entry's, no height below 1,024 is in level 0,
level 1 holds 1,023 entries and every 37th block's transaction has its one location.

**`it('moves an index of either older layout into the segments when the store is opened, and reads one it cannot move')`**.
A `MemoryKv` is filled by hand with 12,000 entries under `'t'`, the even ones in the oldest
layout, the hash alone as the key, and the odd ones in the layout after it, the hash and the
height. Both have the height in the value, here 5 to 304, which is ten segments. One more
transaction has two entries by hash and height, failed at height 5 and succeeded at 700, and
`'T'` holds 2, what a store of the second layout says of itself. A `KvBlockStore` is opened on
it. Nothing is left under `'t'` and 12,002 keys are under `'x'`; the first hash reads height 5,
index 0, `ok: false`, `too early`, the last height 304, index 11,999, `ok: true`, and every 37th
hash has exactly its one location. The transaction with two entries has `[5, false]`,
`[700, true]`; saved again in block 9 with a failure its heights are 5, 9 and 700, and after
`deleteBlock(9n)` 5 and 700. A second `KvBlockStore` opened over the same data through a wrapper
that counts range reads makes none, the marker saying nothing is left to move.

Then a move that is cut short. The 12,000 entries are written to a second `MemoryKv`, with no
marker, and a store is opened through a wrapper whose second `write` throws `stopped`: the
constructor throws it, 7,000 entries are left under `'t'` and there is no `'T'`. A failed write
is the caller's to see, and the node would not open. A second `KvBlockStore` is opened over the
half-moved data through `refusing`, a wrapper whose `write` throws `StoreReadOnlyError`, as a
store opened read-only does: it finds every 41st hash at its one location, moved or not.
A `KvBlockStore` opened on the data itself then leaves nothing under `'t'`, `'T'` holds 3, and every 41st hash reads as before. Last, a store over `refusing` on a key-value store
holding one entry by hash alone and two by hash and height for another hash: the first
answers `txLocation` with height 6, index 1, `ok: true`, the second `txLocations` with
`[8, false]`, `[9, true]`, and a hash with no entry `null`.

`snapshots, evidence, the codec`, three unit cases.

**`it('refuses a snapshot that leaves a type out, repeats one or names one out of order')`**.
An `ObjectDatabase` over `CORE_TYPES` with nothing in it is rooted at version 0 and encoded
with `encodeSnapshot`; a fresh database loads the bytes and reports height 0. The bytes are a
version, a height and an app hash (44 bytes), a section count equal to `CORE_TYPES.length`, and
one 14-byte section per type (a type, a counter and an empty count), which the test checks
before it rebuilds the snapshot from chosen sections. Without the last section `loadSnapshot`
throws `/of \d+ type sections/`; with the last replaced by a copy of the first,
`/snapshot section/`; with the first two swapped, `/snapshot section 0/`.

**`it('lets go of pending and committed evidence and its inventory once it is too old, and bounds what waits')`**.
On an `EvidencePool` by itself, with evidence built from two prevotes for different hashes at
a height, their signatures placeholders: `add` of height 3 is `true` and a second is `false`; `add` of height 4 is
`true`. `markCommitted` is given the evidence of height 3 and one of height 5 that was never
pending here, and `held` is `{ pending: 1, committed: 2, inventory: 3 }`; `add` of the
height-5 evidence is `false`, and `hasHash` of its id is `true`. `pruneIf` for heights up to 4
leaves `{ pending: 0, committed: 1, inventory: 1 }` and `hasHash` of the height-3 id `false`;
`pruneIf(() => true)` leaves all three at 0. With height-6 evidence pending, `markCommitted`
of another pair of votes for the same offence leaves `{ pending: 0, committed: 1, inventory: 1 }`
and `hasHash` of the pending pair's id `false`, and `pruneIf(() => true)` empties the pool
again. Then `MAX_PENDING + 10` pieces for different
validators are added: `size` and `held.inventory` are both `MAX_PENDING`.

**`it('refuses a number too large to hold exactly where a 64-bit field is used as one')`**.
A `Reader` over an encoded u64 of 2^53 − 1 gives `Number.MAX_SAFE_INTEGER` from `u53()`, and
over 2^53 throws `/out of range/`. Over an i64, `i53()` gives −1 for −1 and throws for −2^53 and
for 2^62. `decodeProposal` over a height, a round and a lock round of 2^60 throws
`/out of range/`: such a proposal is refused before its block is read.

`the keystore`, one case.

**`it('removes a key by name, for good, and says so when there is none by that name, as does the command')`**. A
keystore created in a temporary directory gets `keep` and `drop`; `remove('drop')` succeeds, a
second `remove('drop')` throws `/no key named drop/` and `remove('never')` throws
`/no key named never/`. A handle opened afresh lists `['keep']`, and no `keystore.json.lock` is
left. Then the command, `node src/cli.ts keys ...` in a child process with `CHAIN_PASSPHRASE`
set: `add temp` exits 0; `remove keep` exits 0 and prints `removed keep` and the key's address;
a second `remove keep` exits non-zero and says `no key named keep`; `list` begins with `temp`;
and `remove temp` against a path with no keystore exits non-zero and creates no file there. The
directory is removed in `finally`.

`the network and the node`, two cases.

**`it('reads a peer clock that runs ahead from its pong')`**. Two bare `Network`s on a
`MemoryHub`, pinging every 100 ms, `b` seeded with `a` and given a `clock` of `Date.now() + 7000`.
Once each has a `clockOffsetMs` for the other, `a`'s for `b` is within 500 of 7,000 and `b`'s
for `a` within 500 of −7,000: `b`'s clock is seven seconds ahead, `a` sees it ahead and `b` sees
`a` behind, each within the trip. `a`'s `latencyMs` for `b` is under 500. Both are stopped in
`finally`.

**`it('makes a verifier pool of its own when it is given none, and closes it when it stops')`**.
`Node.create` with one validator, no data directory and no `verifier` in its config. The
node's verifier is a `WorkerVerifier` by its constructor's name; started, the node reaches
height 2, its blocks signed and checked through the pool; after `stop()`, a `verify` on the
verifier rejects with `/closed/`.

### test/review5-net.test.ts

Twenty tests for the peer layer, block sync, state sync, what consensus takes in ahead of
its round or its height, and the mempool, each at an edge: a failure, a peer that misbehaves, or two things
happening at once. They are listed by group and title with what each sets up and asserts.

`the peer layer`, eight cases. `makeNet(name, transport, cfg)` makes a bare `Network` on chain
`r5` with its own `PeerDb`, an inline verifier, a connect interval of 50 ms and a ping interval
of 200 ms; every network made is stopped in `afterEach`.

**`it('counts one success for one outbound connection')`**. On a `MemoryHub`, `b` has a peer
database seeded with `a:1` and no listen address, so it dials and is not dialed back. Once the
two are connected, the record of `a:1` in `b`'s database has `successes` of 1: one dial that
succeeded is counted once.

**`it('leaves a connection it refused open for a moment, so the rejection can leave before the close')`**.
`a`'s transport is wrapped so that every connection it accepts notes the time a `reject` frame
was sent on it and the time it was closed. `b` is on `another-chain`, and `b.connect('a:1')`
rejects with `/rejected: wrong chain id/`. The accepting side's connection is closed, a
rejection was sent, and the close came at least 40 ms after it: the connection a `reject` went
out on is left to the 50 ms timer.

**`it('sends nothing on a connection that opened after it was stopped, and leaves no refused connection or timer behind')`**.
`b`'s transport is wrapped: its `dial` makes the connection and then waits on a gate before it
returns it, and what it returns records the type of every frame sent on it. `b.connect('a:1')`
is begun and `b` is stopped while the dial is held; the gate is then opened. `connect` rejects
with `/network stopped/`, no frame was sent, and the connection is closed: a dial that
resolves on a stopped network gets no `hello`. The second half is the refused connection of
the case before, seen from the node that refused: `c`, on `another-chain`, dials `a` and is
rejected with `/rejected: wrong chain id/`, and `a`'s `rejected` map holds one connection,
waiting for its 50 ms timer. `a.stop()` is called inside that moment: the map is empty and the
connection is closed, the timer cleared with it.

**`it('does not wait on a connection that closed between two steps of its handshake, and leaves no timer of the wire behind')`**.
`a`'s transport is the hub's, with `listen` wrapped: the connection handed to `a` has its
`onFrame` replaced by one that passes each frame on and then, when the frame was a `hello`,
closes the connection, "as soon as the hello has been handed over: before the handshake goes
on". Both networks are made with a handshake timeout of 60 seconds. `b` dials `a`; once the
`hello` has arrived, `a`'s `pendingInbound` is 0 and its `handshaking` set empty within the
two seconds the test waits: the step that would wait for `auth` found the connection closed
and rejected, where it had waited out the timeout before ([chapter 6](06-p2p.md)). The second
half is about the hub. `a` and `b` are stopped, and the test counts the process's active
timers (`process.getActiveResourcesInfo()`, the entries that are `Timeout`). Two more
networks, `c` and `d`, are made, the hub's latency is set to 5,000 ms, both are started and
`d` dials `c`: 10 ms on there are more timers than before, the connection on its way to `c`
and the `hello` behind it among them. After `c.stop()` and `d.stop()` the count is what it
was: closing a hub transport takes back what was crossing the hub towards it.

**`it('ends a dial that is still connecting when the transport is closed')`**. A `TcpTransport`
dials `10.255.255.1:9`, "an address nothing answers from: the dial stays connecting, or fails
at once where there is no route", and is closed. The dial rejects, the close and the rejection
together take less than a second, and the transport's `dialing` map is empty: the socket was
destroyed and not left to connect or to time out later.

**`it('excludes and bans a peer by the address it dialed, whatever that resolved to')`**. `b`'s
transport records every dial and turns `name:1` into `a:1`, as a host name resolves over TCP;
its database is seeded with `name:1`, and `a` advertises no address. Connected, `b`'s peer has
`remoteAddr` `a:1` and `dialedAddr` `name:1`. After 1.3 s, past the first backoff, the dials are
still `['name:1']` and the peer is the same object: the connect loop leaves the dialed address
of a connected peer alone. `b.score(a.id, 100, 'test')` drops the peer, `isBanned('name:1')` is
true, the database's only record is `name:1`, and it has no candidates two minutes on: the ban
is on the record that was dialed, and none was made for the resolved address.

**`it('takes an address list only in answer to its own request')`**. `a` and `b` connect as in
the first case and the exchange each begins on connecting is given 100 ms to end. `a` then
sends `b` an `addrResponse` naming `unasked:1` that `b` did not ask for. `b`'s database has no
record of `unasked:1`, and the peer is still connected: the list is ignored and costs nothing.

**`it('starts from its seeds when the peer file is cut short, and replaces the file whole when it saves')`**.
A `peers.json` in a temporary directory holds JSON cut off in the middle of a record. A
`PeerDb` on it with the seed `seed:1` holds `seed:1` alone. After `markFailure('seed:1')` the
file parses to that one record with `failures: 1`, no `peers.json.tmp` is left beside it, and a
second `PeerDb` on the file reads the failure back. A file holding valid JSON that is an object
and not a list opens as a database of size 0.

`block sync`, five cases. `harness(opts)` builds a `BlockSync` whose network has one peer, whose
requester answers every `blocksRequest` with what the case's `respond(from, count)` returns,
whose `applyBlock` notes the height and whose `scorePeer` notes the charge; `blockAt(height)`
is a block of zero hashes with a commit naming its hash, and `status(height)` delivers the
peer's status message. Nothing here verifies a block for real.

**`it('applies nothing after it was stopped, though a block was being verified')`**. The sync's
`verify` is replaced by one that waits on a gate. The peer reports height 2, the first block
reaches verification, the sync is stopped and the gate released: `applied` stays empty.

**`it('sets no timer when it was stopped while a block was being applied')`**. `verify` passes
every block, `applyBlock` waits on a gate before it notes the height and moves the node's own
height to it, and `isConsensusDeciding` reads a flag of the test's. The peer reports height 3,
so three blocks are fetched, and the first reaches the application. The flag is then set,
"another block is held and consensus is deciding: a running sync would wait and look again",
the sync is stopped and the gate released. 20 ms on, `applied` is `[1n]` and `graceTimer` is
null: the block that was being applied was applied, nothing after it was, and the 200 ms timer
was not set again after `stop()` had cleared it.

**`it('lets go of the blocks it held once no peer is ahead')`**. With consensus reported as
deciding, the two blocks the peer sends are held in the buffer and `isSyncing` is true. The
test then sets the node's own height to 2, as if consensus had decided both, and the peer
reports height 2 again: the buffer is empty and `isSyncing` is false.

**`it('uses nothing of a response with more blocks than it asked for, and charges the peer')`**.
With four blocks to a request, the peer answers a request for four with seven. One request was
made, for 4; the peer is charged 50 points once; the buffer is empty.

**`it('charges a peer for a block of another height and for a commit that names another block')`**.
Two runs: in one the second block of the response is of the height seven on, in the other its
commit names a hash of nines. Each time the peer is charged 50 points and nothing of the
response is buffered, the well-formed blocks before the bad one included.

`state sync`, one case, the testnet and the joiner's network stopped in `afterEach`.

**`it('passes over a snapshot from before the trusted height, and charges a peer for a manifest that does not decode')`**.
Four validators of the core application, the first two taking a snapshot every 6 blocks in
chunks of 2 objects. At height 8 the other two are stopped, which stops the chain before the
snapshot due at 12, so the snapshot at 6 is the only one. A bare `Network` seeded with the two
sources connects to both and `stateSync` is run on it twice. With the trusted height at the
sources' tip, 8 or more, it returns `null`: the snapshot at 6 lies two heights or more before
where trust begins, nothing could verify it, and the caller replays from genesis. Then both
sources' `manifestBytes` is replaced by seven bytes of `0xff`, and a join trusting height 2
rejects with `/no valid manifest/`, each source's score on the joiner's network above 40: one
charge of 50 for a manifest that does not decode, less a moment's decay.

`consensus intake`, two cases, the testnet stopped in `afterEach`.

**`it('catches the failure of a proposal nobody waits for')`**. Two of four validators are
started. Node 0's `handleProposal` is replaced by a function that rejects with `verifier
closed`, as the node's own verifier pool does once it is closed, and `proposalUnawaited` is
called with a proposal for height 1, round 0, from no peer. The test waits 20 ms and puts the
real method back. It asserts nothing of its own: "an unhandled rejection fails the run; this
one is caught and logged", by the `catch` consensus attaches to its own proposal and to the
ones it held for the height ([chapter 4](04-consensus.md)).

**`it('drops a vote for a round far ahead before verifying it, holds for the next height only proposals a validator signed, and forgets block requests with the height')`**.
Two of four validators are started, so node 0 stays at height 1. A prevote with a signature of
zeros for round `round + MAX_ROUND_AHEAD + 1`, handed to `handleVote` as from the peer `far`,
leaves `far`'s score at 0, while the same vote for `round + 1` from `near` leaves `near` above
19: a bad signature costs its sender 20 points when it is verified, and a vote dropped for its
round is never verified. `signedVote(fill)` makes a prevote of validator 0 for height 2, round
0, for a block hash of 32 bytes of `fill`, signed with that validator's key. The vote for hash
1 is handed to `handleVote` five times from the peer `repeater` and `nextHeightVotes` holds one
entry: a vote for the next height is held once however often it is sent. The vote for hash 2
makes it two, a conflicting vote being held beside the first. `proposal(round, proposer, signer)` then makes a fresh proposal for
height 2 whose block names validator `proposer` and which validator `signer` signs, the
proposer itself unless said otherwise; the block is not one height 2 would accept and the
rounds are 5 and later, so each is dropped when that height starts and none stands where a
real proposal will. One naming validator 0 and signed by validator 1, from the peer `forger`,
is not held and leaves `forger` above 19. One with `polRound: 0` and one whose block is of
height 0, from `junk`, are not held and leave `junk` at 0: neither was verified. Rounds 5 to 9
signed by validator 0 from `junk`, and round 5 again from `other`, leave two entries in
`nextHeightProposals`: a validator takes two places whichever peer relays, and a round held is
not held twice. Rounds 5 to 7 from each of validators 1, 2 and 3 bring it to 8, the most it
holds. A made-up hash is put into `fetchRequested`; the other two validators are started, the
network reaches height 2, and the hash is gone and the buffer is empty.

`a validator set from bytes`, one case.

**`it('has no proposer when it is empty, and says so in the one way create() does')`**. The
encoding of `ValidatorSet.create([])` decodes to a set of size 0, and so does an empty list
followed by a proposer index of −1. An empty list followed by 0, 5 or −2 throws
`/proposer index out of range/`.

`the mempool`, three cases. `gatedApp()` is an application whose `checkTx` waits on a gate,
then asks `admit` as the core application does after its last wait, refuses the byte `0xee`
after admitting it, and notes what it applied.

**`it('admits one of two transactions checked at once for the last place, and applies only that one')`**.
A pool of one place is given two transactions before the gate opens. The first is `'added'`,
the second `'full'`, and the application applied the first alone. `accepting` is false; after
`update` commits the first it is true, and the second, submitted again, is `'added'`: the
refusal was not remembered.

**`it('gives back the place of a transaction that was admitted and then refused')`**. In a pool
of one place the `0xee` transaction is `'invalid'`, `accepting` is true, and another
transaction is `'added'`.

**`it('keeps a transaction it forgot and saw again for as long as any other, and never forgets one that is pooled')`**.
A pool with `cacheSize: 3` over an application whose `checkTx` throws at first. `addTx` of `x`
rejects with `/verifier closed/`, which forgets `x`; submitted again it is `'added'`, and it is
then committed through `update`. `a` and `b` are added, `b` taking the oldest place of the
cache, the one `x`'s first coming left behind: `seen` of `x` is still true and `x` again is
`'seen'`. `c` takes the place `x` holds now, and `seen` of `x` is false. Then a pool with
`cacheSize: 1` and a counter on its `tx` event: `a` and `b` are added, `seen` of `a` is true
although the cache has let it go, `a` again is `'seen'`, two transactions were announced and
the pool holds two.

### test/review5-node.test.ts

Twenty-six tests for the node, the executor and the block store. Two helpers serve several
groups: `blockAfter(state, lastCommit, evidence)` builds the block that would follow a chain
state as far as its structure goes, with a commit of no signatures, and
`doubleSign(net, node, height, round)` signs two prevotes of validator 0 for different hashes
and makes evidence of them.

`the data directory`, nine cases on a one-validator testnet whose node is not started
(`skipStart: [0]`), with a temporary directory removed in `afterEach`.

**`it('is one directory however its path is spelled or linked to')`**. A node is made on
`<tmp>/data`. A second on the same path with `/.` appended, and a third on a symbolic link to
it, are each refused with `/in use by this process/`, and the `LOCK` file still holds this
process's id. After the first node stops there is no `LOCK`.

**`it('takes over the claim of a process that is gone and refuses that of one that runs')`**. A
`LOCK` holding the id of a child process that has already exited is taken over: the node is
made and `LOCK` holds this process's id. With `LOCK` rewritten to the parent's id, a process
that runs, making the node rejects with `in use by process <ppid>` and the file is unchanged.

**`it('takes a stale claim over only while holding the takeover file')`**. `LOCK` and
`LOCK.takeover` are both written with the id of a child process that has already exited, as
if a process had stopped while taking the stale claim over. Making the node rejects with
`/LOCK\.takeover may have been left by a process that stopped/`, after the fifty attempts,
a second or so, in which it waits for the file to go, and `LOCK` still holds the id it was given: nothing removes a claim without
holding the takeover file. With `LOCK.takeover` removed the node is made, `LOCK` holds this
process's id and there is no `LOCK.takeover`.

**`it('stays claimed until the network is down, and is released after')`**. The node's
transport is wrapped so that its `close` notes whether `LOCK` exists. After `start()` and
`stop()` the note is true and `LOCK` is gone: the claim is given up last.

**`it('closes a store it was handed for a directory it claimed before giving the claim up')`**.
As a program that embeds a node may, the test opens an `LmdbEnv` under `<tmp>/lmdb` itself and hands it to
a node made with `dataDir: tmp`. The environment's `close` is wrapped so that its first call
notes whether `LOCK` exists. After `start()` the node is stopped twice at once
(`await Promise.all([node.stop(), node.stop()])`): two callers wait for the one shutdown, and
neither returns with the store still open. The note is then true and `LOCK` is gone:
the node closed the store it was handed while it still held the claim. The test then closes
the environment again, as its owner may after `stop()`, and nothing throws.

**`it('waits for whoever still reads the store before closing it, and releases the claim after')`**.
A node made with `dataDir: tmp` is started and reaches height 2. It is stopped with a
`beforeClose` function that stands for an RPC server finishing its requests: it sleeps 50 ms,
then loads block 1 from the node's store and notes whether `LOCK` exists. The note is height 1
with the file there, so the store answered and the claim stood until the reader was done, and
`LOCK` is gone once `stop` has returned. A second node on the directory, not started, is then
stopped with a function that rejects with `reader failed`: `stop` rejects with
`/reader failed/` and `LOCK` is gone all the same, so a reader that fails keeps neither the
store open nor the directory claimed. A third node is stopped with a function that rejects
with `undefined`: `stop` rejects with `undefined` (`rejects.toBeUndefined()`) and `LOCK` is
gone, so the failure reaches the caller whatever value it is, nothing included. A fourth node
is then made on the directory and stopped.

**`it('does not go on starting once it is being stopped, and answers a closed store with an error')`**.
A node made with `dataDir: tmp` has `start()` called and then, without waiting for it,
`stop()`, and the test waits for both promises together: a stop that overtakes a start. The
start ends where it is and the stop waits for it before it closes anything, so afterwards
the `running` flag of the node's consensus and of its block sync is false, the memory
guard's timer is null and there is no `LOCK`. Had the start gone on, consensus and block sync
would have been started after the stop had passed them, on a store about to be closed. The
test then does what work that outlived the stop would do: `node.store.loadBlock(1n)` throws
a `StoreClosedError` and `node.store.setLowestHeight(1n)` throws `/the store is closed/`, a
read and a write refused by the closed environment before they reach LMDB
([chapter 10](10-store.md)). The last part is on the guard alone. A `MemoryGuard` is given a
`stats` function whose sample has 99 of a heap limit of 100 in use, with no old-space
figure so that the heap figure is the one read, and an `onLevel` that calls the guard's own
`stop()`. `start()` takes the first sample, which is `critical` and calls the listener; the
guard's timer is null afterwards, so a guard stopped from inside its first sample stays
stopped ([chapter 8](08-node.md)).

**`it('leaves nothing queued behind a stop made from a commit, and no file open behind a genesis that does not parse')`**.
A one-validator testnet is made and started. The node's scheduler has its `afterCommit`
wrapped to count the calls that come once the test's flag `stopped` is set, and the test adds
a commit listener of its own, which sets the flag and calls `node.stop()`, once. It runs after
the node's listener: "the node's own listener has queued the collection for after this commit
when this one stops the node". The test waits for the stop and 20 ms more. The scheduler was
not called after the stop, and the node's `afterCommit` and its block sync's `nextBackfill`
are both null: the immediate that was queued was cleared, and none was queued after
([chapter 8](08-node.md)). The second half writes `{"accounts": [1, 2`, a document cut short,
to `state.json` in a temporary directory, counts the entries of `/dev/fd`, and calls
`loadAppGenesis` twenty times on the testnet's genesis with that file as its `appStateFile`.
Every call rejects, and the count of open descriptors afterwards is what it was before:
`loadAppGenesis` closes the file it opened, however the parsing ended
([chapter 11](11-application.md)).

**`it('is given back, with the store, by a node that fails to open')`**. A `KvStoreApp` whose
`initChain` throws makes `makeNode` reject with `/no genesis for you/`. No `LOCK` is left, and
the same process makes a node on the directory again, at height 0: neither the claim nor the
store environment stayed held.

`the executor`, five cases.

**`it('reads the evidence age from the application when asked, not at the commit before')`**.
One validator of the core application with an unbonding period of 2 s, not started. The
function the executor prunes by, `evidenceAgeMs` in its dependencies, gives the application's
`unbondingPeriodMs`. The application's `stakingParameters` is then replaced by one that
answers three times the period, as a block carrying a parameter change would leave it, and the
same function gives three times the period with no commit in between.

**`it('stores nothing of a block whose application commit throws inside the shared transaction')`**.
A `BlockExecutor` over a `KvBlockStore` in an `LmdbEnv`, with the environment's `transaction`
as its shared transaction and a `KvStoreApp` whose `commitSync` throws `disk full`.
`applyBlock` of the first block rejects with `/disk full/`; the executor's state is at height
0, the store has no block 1, its stored state is at height 0 and it has no validator set for
height 3. The block, the set and the chain state went with the application's write.

**`it('prunes blocks and headers in one transaction each, the set by height going with its block')`**.
The chain store is a `MemoryKv` that records, for every write, the first byte of each key put
and deleted. One validator with `maxEvidenceAgeMs: 1n` and `retain: { blocks: 2 }` runs until
its lowest height is 4 or more. Every write that deletes a block (`'b'`) also puts the
lowest-height marker (`'l'`), and no write puts the marker without deleting a block; in each
such write as many sets by height (`'V'`) are deleted as blocks. `loadValidatorsAt` is null
below the lowest block and for height 1, and not null for the lowest block and for the height
two after the latest; the genesis set is still found by its hash. Two headers are then saved
alone below the lowest block with times of 1 and 2 and the lowest-header marker set to the
lower: the next commits delete them in exactly one write, which deletes at least two header
records (`'H'`) and the marker (`'L'`).

**`it('answers for a past height with the set as that height had it, proposer included')`**.
Four validators run to height 8. For every height from 1 to the one before node 0's latest,
the hash of `validatorSetAtHeight(h)` is the `validatorsHash` of the stored block's header
and `hasProposerAt(h)` is true.
Where the block's commit is of round 0, the address of the set's `proposer()` is the header's
`proposerAddress`: a block decided in its first round was proposed by the set's proposer of
that height, which the record by height has and the record by hash, rewritten by later
heights, has not. More than four heights are checked that way.

**`it('removes a validator set by hash once no header held names it')`**. One validator with
`maxEvidenceAgeMs: 1n` and `retain: { blocks: 2 }`; the hash of its set is noted before it
starts. At height 2 a `val:` transaction adds a second validator with power 1, so the set
changes and the first validator, alone, still decides every block. When the state's set has
two members the first set is still in the store. The test then waits for
`loadValidatorSet(first)` to be null, which happens once every block that names the first set
is pruned. Every block from the lowest held to the one before the latest has a
`validatorsHash` other than the first set's, and both sets its header names are found by
hash; the set in use is found too.

`the stores`, five cases.

**`it('indexes a transaction repeated in one block where it succeeded')`**. On a
`MemoryBlockStore`: block 3 holds a transaction at positions 0 and 2, failed at 0 and
succeeded at 2, and `txLocations` has one entry, height 3, index 2, `ok: true`. Block 4 holds
it twice, succeeded then failed as a duplicate: index 0, `ok: true`. Block 5 holds it at 1 and
2, failed both times: index 1 with the first error. Block 6 is saved with no results: index 0,
`ok: null`. After `deleteBlock(3n)` the heights are 4, 5 and 6.

**`it('applies the operations of one write to the memory store in the order they were made')`**.
On a `MemoryKv`, a write that puts a key and then deletes it leaves no value; one that puts,
deletes and puts again leaves the last value; and a write that deletes and then throws leaves
the value as it was.

**`it('refuses every step of an iteration and every use of a writer once the disk environment is closed')`**.
The one case of the group on LMDB: an `LmdbEnv` opened in a temporary directory, which the test
removes in a `finally`. A `write` on its `chain` store puts keys 1, 2 and 3 and keeps the
writer its callback was given in a variable. Once the `write` has returned, a `put` of key 9 on
the kept writer throws `/after its write\(\) returned/` and `get` of key 9 is undefined: "a
writer kept past its write() is of no use". The test then begins an iteration over the whole
store with `range` and steps it once, which yields key 1, and awaits `env.close()`. The next
`next()` on that iteration throws a `StoreClosedError`: the store checks before every step, not
only the first, so an iteration begun before the close stops at the step after it. A `get`, a
new `range` spread into an array, a `write` with an empty callback and the environment's
`transaction` each throw `StoreClosedError` too ([chapter 10](10-store.md)).

**`it('undoes the writes of a memory environment transaction that throws, in every store')`**.
A `MemoryEnv` whose `chain` store holds key 1 with value 1. Inside one `transaction` the store
is written twice, key 1 put with value 2 and key 2 added, then key 1 deleted; a transaction
inside it writes key 1 to the `app` store, which is asked for there for the first time; and the
callback throws `commit failed`, which `transaction` throws on. Afterwards key 1 holds value 1
again, key 2 is absent and the `app` store has nothing under key 1. A transaction that returns
keeps its write of key 2, a write of key 1 made outside any transaction follows, and a
transaction that only throws leaves both as they were: writes after a failed transaction are
not undone by a later one. The last part is a failure inside: an outer transaction puts key 1
with value 5, then runs an inner one that puts key 1 with value 6, writes key 1 to a `late`
store first asked for there and throws `inner`; the outer one catches the error and puts key 2
with value 5. Afterwards key 1 and key 2 both hold value 5 and the `late` store has nothing
under key 1: the inner transaction was undone by itself, and the outer one kept its own writes.

**`it('reads a heap flag of zero as no flag')`**. `heapLimitFlag` is null for
`--max-old-space-size=0` on the command line and for `--max_old_space_size=0` in the options
string; null when a 0 follows a 512 on the command line, and when the command line says 0 and
the options string 512; and 512 when the command line says 512 and the options string 0.

`gossip and block validation`, seven cases.

**`it('does not pool gossiped evidence that is already too old for a block')`**. One validator
with `maxEvidenceAgeMs` of 1,500 runs until the latest block's time is more than 1,700 ms past
block 1's; consensus is then stopped, so that no later commit prunes the pool and hides what
was let in. Evidence of a double sign at height 1, handed to the node's `acceptEvidence` as
gossip, is not in the pool, whose size stays 0; evidence for the height two past the latest is
not pooled either; evidence for the latest height is.

**`it('takes an item only from the peer it asked for it')`**. Two validators. `b` broadcasts
an `item` carrying a transaction that was never announced or fetched; three blocks later `a`
has not seen it and has it in no block. A transaction submitted to `b` in the ordinary way,
announced and fetched, reaches `a`'s index and its mempool's memory.

**`it('remembers a bounded number of fetches for a peer that announces and never answers')`**.
Two validators, past height 2. `b` listens for `fetch` messages and collects the hashes `a`
asks it for, then broadcasts one `inv` of 3,000 transaction hashes that no node holds. `a`
reads the announcement in one go, before any `itemNotFound` from `b` could free a place, so it
asks for as many as it remembers for one peer and no more: the set reaches 2,048
(`MAX_OUTSTANDING_PER_PEER`) within ten seconds and still holds exactly 2,048 after another
300 ms.

**`it('takes the block size from the genesis, for every node alike')`**. Two validators on a
genesis with `consensus: { maxBlockBytes: 65536 }`, and a third node, no validator, made with
`limits: { maxBlockBytes: 1024 }` forced past the type. 200 transactions of about 1 KiB each
are `added` on the first node, and one of half a block and a little more is `too-large`: the
pool's limit is four bytes under half the block size here. Every one of the 200 reaches the third node's
transaction index, so the node configured with another size followed the chain. They lie in
more than three blocks, and the transactions and evidence of the largest of those blocks
(`blockDataBytes`) encode to more than half of 65,536 bytes and not more than it. The genesis written with `genesisToJson` and read with
`genesisFromJson` has the figure, and the same text with 1,024, 64 MiB, 70,000.5 or the string
`"65536"` in its place throws `/maxBlockBytes must be a whole number/`.

**`it('gives evidence half a block at most, so the largest transaction admitted still fits')`**.
One validator on a genesis with `consensus: { maxBlockBytes: MIN_BLOCK_BYTES }`, past height 2.
`MAX_EVIDENCE_PER_BLOCK` pieces of evidence, double signs of validator 0 at height 1 in sixteen
rounds, are added to the node's evidence pool: under ML-DSA-44 the sixteen encode to more than
the whole of 65,536 bytes. A transaction of `MIN_BLOCK_BYTES / 2 - 4` bytes, 32,764, the
largest the pool takes on this chain, is then submitted and is `added`. It is committed within
twenty seconds. In the block that holds it the transactions and evidence (`blockDataBytes`)
encode to no more than 65,536 bytes and the evidence alone to no more than 32,768: the builder
left out the records that did not fit in half the limit and gave the transaction the other
half. The records left out follow in later blocks: the pool's pending count comes down to 0,
and the evidence in the blocks from height 2 to the node's height adds up to 16, so none was
lost.

**`it('bounds a block by what its proposer chose, and a validator set by what a frame holds')`**.
One validator, not started, on a genesis with `consensus: { maxBlockBytes: MIN_BLOCK_BYTES }`.
The block `blockAfter` builds on the node's state, empty, passes `validateBlockStructure` under
that limit. `room` is the limit less what `blockDataBytes` gives for one empty transaction and
no evidence, so a block whose one transaction is `room` bytes long encodes its transactions and
evidence to exactly 65,536 bytes: it passes, and with `room + 1` bytes the answer is
`block too large`, whatever the header and the commit weigh. Then the set: `ValidatorSet.create`
with `MAX_VALIDATORS` entries of power 1 gives a set of 2,000, and with one more throws
`/2001 validators exceed the limit 2000/`. Last, a sum: `MAX_BLOCK_BYTES`, two commits of
`MAX_VALIDATORS` signatures of 2,421 bytes with 16 bytes allowed beside each, and 64 KiB more
are less than `MAX_FRAME`, so the largest block a genesis may allow fits one frame with the two
commits it travels with.

**`it('refuses a block with more evidence than a block may carry')`**. One validator, stopped
at height 2 or later. `validateBlockStructure` on the next block carrying
`MAX_EVIDENCE_PER_BLOCK + 1` pieces of evidence, double signs of validator 0 in as many rounds,
answers `too much evidence`, and with `MAX_EVIDENCE_PER_BLOCK` of them `null`.

### test/review5-app.test.ts

Seventeen tests for the application, the object database, the codec and the toy application. The
application cases run a `CoreApp` over a genesis with a faucet, three operator accounts and two
validators (self-bonds 200 and 100), a downtime window of four blocks and no block reward,
driven a block at a time by `block(app, txs, signers)`. `FlakyKv` is a store over a `MemoryKv`
whose write number `failAt` runs its callback to the end and then throws `disk full`, taking
nothing, as a store does whose transaction fails when it commits.

`a store write that fails`, three cases.

**`it('leaves the account history log where the store is, so the entries can be appended again')`**.
A `HistoryLog` over a `FlakyKv` takes one entry for account `3.3`. A second append, of three
entries for `3.3` and `3.700`, an account beyond the first slices so that the write also widens
them, is made in the write that fails. After `rollback()` the totals are 1 and 0. The same
entries are appended again, then one more for `3.700`: `3.3` reads heights 1, 2, 2 oldest
first and `3.700` reads 3, 2 newest first, and a log opened over the store reads both accounts
as the one that went through the failure does.

**`it('throws out of commit() where it is called, and the block is written by the next commit() with its history')`**.
An application on a `FlakyKv` and a control on a store that never fails apply the same blocks.
After block 2 is finalized the next write is set to fail: `app.commit()` throws `disk full`
where it is called, not as a rejected promise, and an application opened on the store is at
height 1. `commit()` called again writes the block. After a third block the account histories
of the faucet and two operators, whole and as the newest two, equal the control's, the faucet
has four entries, the app hashes agree, and an application reopened from the store is at
height 3 with the control's history for the faucet.

**`it('rejects the promise, with the block written, when only the snapshot after it fails')`**.
With `snapshotInterval: 1` the second write of a commit is the snapshot, and it is the one set
to fail. `commit()` returns a promise that rejects with `disk full`, and an application opened
on the store is at height 1.

`a block that fails after its session is closed`, two cases.

**`it('stops the application until a restart, which has the state of the block before')`**.
After block 1, `db.root` is made to throw once. `finalizeBlock` of block 2 rejects with the
root's error and `lastHeight` stays 1. The same request again rejects with
`/failed while taking the root of block 2.*restart/`, a `checkTx` answers not `ok` with an
error matching `/restart/`, and `commit()` resolves with nothing to write. An application
opened on the store is at height 1 with the operator's balance as it was before the block,
applies the block with its transfer `ok`, and the balance is 6 more.

**`it('still undoes a block that fails while its session is open, and goes on')`**. The
verifier's `verify` rejects once with `the pool is gone`; `finalizeBlock` rejects, `lastHeight`
is 1, and the same request then succeeds and the height is 2.

`staking and authorities`, three cases.

**`it('refuses a delegation to a validator that has shares and no tokens')`**. With
`downtimeSlashBps: 10_000`, the faucet delegates 50 tokens to validator A and four blocks are
signed by A alone, so B is slashed for downtime and the slash takes everything: B has 0 tokens
and more than 0 shares. A `delegate` of 5 tokens to B is refused in `checkTx` with
`/lost all its tokens/`. A block carrying that `delegate` and a `redelegate` of half the
faucet's shares from A to B fails both, the second with the same error; B's tokens are still 0
and A's shares unchanged.

**`it('refuses an account update whose new authority no key leads to')`**. An update making
both authorities of `op-a` a reference to `op-a` itself is refused with
`/can never be satisfied/` in `checkTx` and in a block, and so is one making only the active
authority that. Making the owner alone a reference to the account succeeds: it is satisfied by
the key the active authority keeps. Then a chain of accounts: `op-b`'s active authority is set
to name `op-c`, which has a key, and `op-a`'s to name `op-b`; both succeed. The faucet's active
authority naming `op-a` alone is refused, the key being three accounts away. One with the
faucet's own key, a threshold of 2 and `op-a` as member is refused too, and the same with
`op-c` as member is accepted. And `op-a` is still usable: a transfer from it signed by
`op-c`'s key passes `checkTx`.

**`it('refuses an authority that needs more signatures than a transaction carries')`**. `op-a`'s
active authority is set to sixteen keys with a threshold of 16, the most one transaction can
sign for, and the update succeeds. An update making the faucet's active authority `op-a` and
`op-b` with a threshold of 2 needs seventeen signatures and is refused with
`/more than the 16 signatures/` in `checkTx` and in a block. The same two members with a
threshold of 1 are accepted: seventeen keys count toward it, and the cheaper way is one
signature.

`object database`, four cases on an `ObjectDatabase` over an `Item` type made by
`itemType(id, authenticated)` with a chosen number of authenticated indices.

**`it('answers with the state of the last root after writes made outside a session')`**. Two
items are created and a root taken at version 1; then, with no session open, one is modified,
the other removed and a third created. `getCommitted` gives the first at its old value, the
removed one still there and the new one null; `committedNextInstance` is 2, `countAt(7, 1)` is
2, `getAt` at version 1 gives the old value, and `proofAt` at version 1 proves the first two
present and the third absent against the root. The same holds with a session open and a
further write inside it, and after that session is undone. After the next root `getCommitted`
gives the new value and null for the removed item, and proofs verify against both roots.

**`it('refuses more types than its dropped trees have places for, before any tree is touched')`**.
A database of 512 types throws `/at most 511/`. One of 511 is made, roots, drops its trees,
rebuilds them, drops them again, and proves an object against the root.

**`it('refuses more authenticated indices on a type than a proof can be decoded with')`**. A
type with `MAX_AUTHENTICATED_INDICES + 1` authenticated indices throws
`/more than 16 authenticated indices/`. With exactly 16, an object's proof encoded and decoded
has 16 index roots and verifies.

**`it('keeps its own copy of a value set in a sparse tree')`**. For a resident tree and a
dropped one: a value is set, the caller's buffer is then filled with `0xff`, and `get` still
returns the original bytes and the tree's commit equals that of a reference tree.

`codec`, two cases.

**`it('reads a copy out of a Buffer as out of a Uint8Array')`**. For a `Uint8Array` input and
a `Buffer` input: `bytes()` and `fixed(2)` are read, the input is overwritten, and both results
still hold what was read; the `fixed` result is a plain `Uint8Array` on a buffer of its own.

**`it('grows a writer that was made with no capacity')`**. `new Writer(0)` writes a `u8` and a
`u64`, and 100 fixed bytes, and `new Writer(1)` a `u32`, each finishing with the right bytes.

`the toy application and its validator set`, three cases on `KvStoreApp` with `val:<key>:<power>`
transactions and a genesis set of alice at power 10.

**`it('fails a transaction whose update the engine could not apply to the set')`**. Block 1 adds
bob and removes him: both transactions succeed and there is no validator update. Block 2
removes alice (refused, `/last validator/`), adds bob at `MAX_TOTAL_POWER` (refused,
`/exceed the limit/`), adds bob at `MAX_TOTAL_POWER - 10` (accepted) and raises alice to 11
(refused); the one update is bob's. Block 3 removes alice and then bob: the first succeeds,
the second fails, bob then being the last, and the one update is alice at power 0.

**`it('refuses a validator key of another scheme than the set\'s')`**. A key pair is derived
under the scheme the suite is not running on, secp256k1 under the default and ML-DSA-44 under
`CHAIN_SCHEME=secp256k1`. `checkTx` of a `val:` transaction with that key at power 5 fails with
`/key must be a .* key/`. A block of that transaction followed by one adding bob at power 5
has results failed and succeeded, and its one update is bob's.

**`it('has its validator set back from its file')`**. A `KvStoreApp` on a file adds bob and
commits. A second one opened on the file removes bob and then alice: the first succeeds and the
second fails, which it could not if the set had not come back from the file. The file is then
overwritten with a height and entries and no `validators`, as one written before the set was
kept would be, and opening a `KvStoreApp` on it throws
`/written before the validator set was kept/`.

### test/review5-rpc.test.ts

Twelve tests for the RPC server, the keystore, the command line and the light client.
`readEvents(res, enough)` reads the records of an event stream until `enough` says so and then
closes it.

`the rpc server`, seven cases. `up()` starts four validators of the core application with
`engineValidators: false` and a staking genesis whose operators `op0` to `op3` are the accounts
`3.1` to `3.4` and run the validators `7.0` to `7.3`, an `RpcServer` on node 0 with limits out
of the way, and waits for height 3. Servers and the network are stopped in `afterEach`.

**`it('hears of no commit once it is stopped, and answers those waiting for a transaction')`**.
A second `RpcServer` is started on the same node with its `push` wrapped to count calls. Once a
commit has reached it, a waiter is registered through its events for a hash of zeros with a
timeout of a minute, and `waiting` is 1. `stop()` is called: the waiter's promise resolves to
`null`, `waiting` is 0, and a further `waitForTx` returns `null`. The node commits two more
blocks and the count of `push` calls does not move.

**`it('is stopped only once the methods it was running have returned')`**. The `status` entry
of the server's method table is replaced with a function that sleeps 300 ms, sets a flag and
returns an empty object: a method that is waiting when the server stops, as a broadcast waits
on the mempool. The client calls `status`, and 50 ms later the server is stopped with
`stop(0)`, which cuts the connection at once. When `stop` has returned the flag is set: the
method ran to its end before the server counted as stopped, so whoever closes the node's
stores next does not close them under it. The client's call was rejected, its connection
having been cut, and the test reads that as `null`. The method's 300 ms are well within the
second `stop` waits. A method that took longer than the second would still be running when
`stop` returned, which this case does not exercise; what such a method meets when it then
reads the store of a stopped node is the `StoreClosedError` that
`does not go on starting once it is being stopped, and answers a closed store with an error`
in `test/review5-node.test.ts` checks.

**`it('is not listening after a stop that overtook its start')`**. A second server is made for
the node; `start()` is called and, before it has resolved, `stop()`. The stop waits for the
start and then closes the server, so when both have returned the HTTP server's `listening` is
false. Before the stop waited, it closed a server that was not listening yet, and the listen
that was on its way went through after it.

**`it('replays a block event as it was pushed, failed count and all, and says when it holds no results to count')`**.
A stream of `block` events is read for three records while a transfer is broadcast in commit
mode; the first has `failed` of 0. A stream opened with the `Last-Event-ID` before that first
record replays three records equal to the three pushed. Then the store's `loadResults` is made
to return null, as for blocks fetched after a state sync and never executed: in a replay from
before the transfer's height, the transfer's block is `{ txs: 1, failed: null }` and a block
with no transactions has `failed` of 0.

**`it('opens an account stream only for an account there is, named or by id')`**.
`GET /events?types=account&account=` answers 200 for `op0` and `3.1`, and 404 for `nobody`,
for `3.999`, for the validator id `7.0`, and for `3.999999999999999999999` and `99999999.1`,
numbers no id can hold.

**`it('knows no method by a name every object inherits, and answers a malformed request under the id it carries')`**.
`toString`, `constructor`, `hasOwnProperty` and `__proto__` as method names are each `-32601`.
Posted raw: `{ id: 7, method: 'status' }`, which lacks `jsonrpc`, is `-32600` with `id: 7`; a
request with `id: 'seven'` and a numeric `method` is `-32600` with `id: 'seven'`; one with no
id, and one whose id is an object, are `-32600` with `id: null`.

**`it('finds a validator by the account id of its operator, as by the name')`**. `validator`
with `operator: 'op0'` has id `7.0`; with `operator: '3.1'`, `id: '3.1'` and `id: '7.0'` at the
same height the answers equal it. `delegation` of `op0` to `validator: '3.1'` is op0's own
delegation to `7.0` and equals the answer for `validator: '7.0'` at that height. `validator`
for `3.0`, the faucet, is `-32001` with `/3\.0 runs no validator/`, `delegation` to `3.0` is
`-32001` with `/runs no validator/`, and `validator` with `id: '7.9'` is `-32001` with
`no such validator`.

`the keystore`, one case.

**`it('keeps a key under a name every object inherits, and has none by such a name until one is added')`**.
In a keystore created in a temporary directory, for each of `constructor`, `toString`,
`__proto__` and `hasOwnProperty`: `has` is false, and `get`, `publicKeyOf` and `remove` throw
`no key named <name>`. Each is then added, and a second `add('constructor')` throws
`/already exists/`. The handle and one opened afresh list the four names in the order added,
`has` is true for each, and `get` and `publicKeyOf` give the public key `add` returned. Through
the second handle `__proto__` and `toString` are removed; a third handle lists `constructor`
and `hasOwnProperty` and has no `toString`.

`the command line`, three cases. `cli(...args)` runs `src/cli.ts` in a child process and
collects its exit status and what it wrote to both streams. In the first case the node is a
child process too, started by the command; in the third the node answers from the test's
own process, so the command runs beside it.

**`it('writes the block size it was given into the genesis, and runs a node that stops on a signal with its directory released')`**.
In a temporary directory, with a base port from `freePortPair()` (a port the system gave out for port 0 and released, with the one after it bound and released too, since the node serves its RPC on the p2p port plus one; a number worked out from the process id could be in use), `init` for one validator
with `--max-block-bytes 100` exits 1 with
`/maxBlockBytes must be a whole number from 65536 to 16777216/` and the chain's directory does
not exist: the size is refused before anything is written. `init` with `--scheme` naming
`DEFAULT_SCHEME` and `--max-block-bytes 131072` exits 0, and `consensus.maxBlockBytes` in the
`genesis.json` it wrote is 131072. Then `start` is run on `node0` with `--heap 512` as a child
process whose environment has `CROSSCHAIN_CHILD` emptied, so that the command starts the node
under its heap wrapper, as an operator runs it, with `LOG` set to `info` so that the status line is logged whatever level the suite runs at, and in a process group of its own, which the `finally` ends if the test fails before the node has stopped. The test waits, thirty seconds at most, for an
`info` line `status` with a `height=`, which the command logs every five seconds: the node is
up and has run past a tick of the status interval. The `LOCK` file is then in `node0/data`,
and a second `start` on the same directory exits 1 with `/in use by process/`. The child is
sent `SIGINT` and its exit code is 0 (a `SIGKILL` in `finally` ends it if an expectation
failed first). Afterwards the `LOCK` file is gone and the output matches none of
`stopping failed`, `start failed`, `the store is closed`, `Unhandled` and `Error:`. This is the
suite's test of the command line's shutdown ([chapter 14](14-wallet-cli.md)): a node started
by the command stops on a signal with a clean exit and its directory released. It does not
make a status tick fall during the shutdown, so the clearing of the interval there is not
what it decides.

**`it('points at the usage for a command it does not know, with or without a target after it')`**.
With no arguments, with `frobnicate`, with `frobnicate` and a URL, and with `frobnicate` and a
directory that does not exist, the status is 1 and the output is exactly
`usage: see the comment at the top of src/cli.ts`. `show` with nothing after it prints
`missing target`.

**`it('prints whole amounts of an asset without decimals, keeps the chain with its light client anchor, and says when a node holds no results')`**.
Four validators of the core application on chain `r5-cli`, the core asset of precision 0 and a
faucet of 1,000,000,000 units, with an `RpcServer` on node 0 and a temporary directory for the
keystore path. `show` exits 0 with the faucet's line ending in `1000000000` and the pool and
bonded figures as digits alone. An `accountCreate` is broadcast in commit mode and the next
block awaited; `verify-tx` of its hash prints
`verified: included at height H, succeeded` and exits 0. With the store's `loadResults`
returning null, the last line of `verify-tx` is
`included at height H; this node does not hold the results of that block`, exit 0. The
`light.json` beside the keystore path has `chainId` `r5-cli`. Rewritten with `another-chain`,
it makes `light verify` exit 1 with
`/light\.json holds a trusted header of chain another-chain, and this node is on chain r5-cli/`
and is left naming `another-chain`. Rewritten with the height and hash alone, it is taken:
`light verify` prints `verified height ...`, exits 0, and the file names `r5-cli` again.

`the light client`, one case.

**`it('verifies no header from a trusted one that has reached the trusting period, the next one or a later one')`**.
Four validators at height 6, and a `LightClient` through a `NodeProvider` with a trusting
period of 60 s and a clock the test sets. It trusts height 2 and verifies to 3. With the clock
at the trusted header's time plus the period, `verifyToHeight(4n)` throws
`header 4: trusted header is older than the trusting period`, `verifyToHeight(6n)` the same for
header 6, and `verifyLatest()` an error matching `/older than the trusting period/`; the trusted
height is still 3 and `verifiedHeights` is `[3n]`. With the clock one millisecond earlier,
`verifyToHeight(4n)` succeeds and `verifyToHeight(6n)` returns header 6.

## Writing a new test

Three kinds of test cover almost everything, and the choice follows from what the property
touches.

**A unit test on the database or the application** when the property is about state: a rule in
an evaluator, an accounting identity, a proof, a restart. It is synchronous or nearly so, runs
in milliseconds, and uses no network. For the database, build an `ObjectDatabase` over your own
object types as `test/db.test.ts` does. For the application, build a `CoreApp` from a genesis
and drive it one block at a time with a `block` helper. The one in `test/fees.test.ts` is the
smallest:

```ts
async function block(app: CoreApp, txs: Uint8Array[] = []) {
  const height = app.lastHeight + 1n;
  const res = await app.finalizeBlock({
    height,
    time: app.dynamic().time + 1000n,
    txs,
    proposerAddress: cons[0]!.address,
    lastCommitSigners: height === 1n ? [] : cons.map((k) => k.address),
    misbehavior: [],
  });
  await app.commit();
  return res;
}
```

Build transactions with `signedTxBytes(chainId, { expiration, operations: withFees(ops, app.feeSchedule()) }, keys)`,
assert on `res.txResults`, on `app.balance`, on `app.db` lookups, and on `app.checkTx(...).error`
with a regular expression. If the test touches staking, end it with the `checkSupply` invariant
from `test/staking.test.ts`.

**An in-process network test** when the property is about several nodes: agreement, liveness
under faults, gossip, sync, a validator set change, a restart. Use `makeTestnet`, wait with
`waitFor` and `waitForHeight`, inject faults through `net.hub`, and stop the network in
`afterEach`. The skeleton of every case in `test/consensus.test.ts` is the file's module-level
cleanup:

```ts
let net: Testnet | null = null;
afterEach(async () => {
  await net?.stop();
  net = null;
});
```

and then one case per scenario, each starting its own testnet:

```ts
  it('four validators commit blocks and agree on them', async () => {
    net = await makeTestnet({ validators: 4 });
    await waitForHeight(net.nodes, 5n);
    const hashes = net.nodes.map((n) => toHex(blockHash(n.store.loadBlock(3n)!.block)));
    expect(new Set(hashes).size).toBe(1);
    // Every commit must carry +2/3 of the signatures.
    for (const n of net.nodes) {
      const { commit } = n.store.loadBlock(3n)!;
      expect(commit.signatures.filter((s) => s !== null).length).toBeGreaterThanOrEqual(3);
    }
  });
```

The toy `KvStoreApp` is enough for engine properties; pass `appFor` with a `CoreApp` and an
`appState` from `appGenesisBytes` when the property needs real accounts, as `test/chain.test.ts`
does.

**An RPC test** when the property is about the JSON surface or the client: start the network as
above, then `new RpcServer(net.nodes[0]!, { port: 0 })`, `await server.start()`, and talk to it
through `new RpcClient(server.url)` or raw `fetch`, as `up()` in `test/rpc.test.ts` does. Stop
the server before the network.

Pitfalls the existing tests have already met:

- **Timing.** Never `sleep` to wait for progress; `waitFor` a condition with a limit of seconds
  and a message function that reports the state, as `waitForHeight` does with
  `height ${h} (now ...)`. Reserve `sleep` for
  claims that nothing happens. If the scenario must catch the node inside a step, lengthen that
  one timeout (`timeouts: { commitMs: 1500 }` in `test/engine.test.ts`) rather than racing the
  defaults. Tests that depend on block time passing (evidence age, unbonding, jail periods on a
  network) are the slowest; keep the periods short in the genesis parameters.
- **Replay protection.** The same transaction bytes are a `/duplicate/` the second time, in
  `checkTx` and in a block. Two transactions with the same operations and signer need different
  bytes: `test/app.test.ts` makes each `spend(n)` expire at `genesisTime + 60_000n + n`, and
  `test/review.test.ts` adds `+ 1n` to one expiration.
- **Fee filling with `withFees`.** Every operation must state at least what the schedule in force
  charges, and the fee is inside the signed bytes. Use `withFees(ops, app.feeSchedule())` in a
  unit test and `chainParametersFromJson(await rpc.parameters()).fees` over the RPC.
  `DEFAULT_FEES` is only right when the genesis did not change the schedule; otherwise the
  transaction fails with `states a fee of 100, the schedule requires 250`, as the parameters test
  shows on purpose.
- **Genesis time versus expiration.** A unit-test application runs on a fixed clock:
  `genesisTime = 1_700_000_000_000n` and one second per block, so an expiration must be relative
  to `app.dynamic().time` (`+ 60_000n`); `BigInt(Date.now())` would be years ahead and
  `/too far/` (the limit is an hour). A testnet runs on the wall clock
  (`genesisTime: BigInt(Date.now()) - 1000n`), so there the expiration must be
  `BigInt(Date.now()) + 60_000n`, and anything derived from a fixed time is `/expired/`.
- **Keys.** Derive every key from `seedFor` with a prefix unique to your file, so a faucet in one
  file is never the faucet of another, and in the chain's scheme: `keyPairFromSeed(seed)` with no
  scheme follows `DEFAULT_SCHEME`, which is what `makeTestnet` and the hand-written genesis
  documents name, so a test that passes no scheme anywhere runs correctly under either
  `CHAIN_SCHEME`; a key made with an explicit scheme the chain does not use is refused the moment
  a transaction names it. The validator and node keys of a testnet are `net.validatorSeed(i)` and
  `net.nodeSeed(i)`; a node created as a full node becomes a validator only by recreating it with
  `validatorSeed`.
- **Cleanup.** Stop the testnet in `afterEach`; push extra nodes into `net.nodes` so `stop()`
  reaches them; `rmSync` temporary directories; close `LmdbEnv`s and `WorkerVerifier` pools in
  `finally`. A node left running keeps timers alive into the next test.
- **Dropped trees.** Run a new database or application test under `INDEX_TREES=0` and `TREES=0`
  as well as resident before calling it done: a test that reaches into a type's B+ tree directly
  (`index(name)` throws while it is dropped) or assumes a root reports no store changes will
  pass in one mode and fail in the other. A test that is about one mode says so in its options,
  as the twins in `test/db.test.ts` do with `indexTrees: true` and `indexTrees: false`.
- **Ports.** The RPC uses port 0. Only the TCP p2p test binds fixed ports (38881 and 38882); a
  new TCP test should pick its own.

## Where to next

Back to the [overview](00-overview.md) for the map of the system, and to
[docs/benchmarks.md](../benchmarks.md) for what each part costs at scale.
