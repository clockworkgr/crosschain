# 15. The tests

`npm test` runs `vitest run` (the `test` script in `package.json`) over every file matching
`test/**/*.test.ts`: twenty-two files, 160 cases, about 5,170 lines counting the shared harness
in `test/helpers.ts` and the setup file. The whole suite takes about a minute (70.9 s, all
passing, on the run this chapter was checked against, under the default ML-DSA-44 keys); nearly
all of that time is the network scenarios, which run real consensus timers. The same suite runs
on the chain's other signature scheme with `CHAIN_SCHEME=secp256k1 npm test` (159 passing and
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
`genesis` cover the core application; `txproof`, `light`, `rpc` and
`sync` cover proofs, clients and catching up; `review` holds one regression test per finding of
the external review and the later cases of the same kind, and `review2` five more that each
span several layers. Files run one after another, never in parallel, for a reason explained
below.

## The harness

Everything the suites share lives in `test/helpers.ts`, 157 lines. It exports two constants,
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
it in memory (the default). `skipStart` creates nodes without starting them, for "node down"
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
      transport: hub.transport(addrOf(i)),
      listenAddr: addrOf(i),
      seeds: allAddrs.filter((a) => a !== addrOf(i)),
      verifier,
      timeouts: { ...FAST_TIMEOUTS, ...opts.timeouts },
      limits: opts.limits,
      network: FAST_NETWORK,
      lagGraceMs: 500,
      log: testLogger(`n${i}`),
      ...overrides,
    });
```

Every node seeds from every other address, uses the shared verifier and the fast timers, and
gives block sync a `lagGraceMs` of 500 ms (default 3,000) before it treats itself as lagging.
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

Run before every test file, it is the whole of the two environment switches:

```ts
import { setDefaultIndexTrees, setDefaultTrees } from '../src/db/database.ts';

if (process.env.INDEX_TREES === '0') setDefaultIndexTrees(false);
if (process.env.TREES === '0') setDefaultTrees(false);
```

`setDefaultIndexTrees(false)` makes every `ObjectDatabase` constructed afterwards start with its
secondary indices' B+ trees dropped, unless its options say otherwise, so every lookup and scan
in the run reads the index store with the overlay of the writes since the last root on top;
`setDefaultTrees(false)` does the same for the Merkle trees, so every root, object proof and key
proof reads chunks and nodes from the store ([chapter 9](09-database.md)). The suites are not
written for either mode in particular, which is the point: an application test that passes with
the trees resident and with them dropped shows that the fallback gives the same hashes and the
same answers, and that is the acceptance test STATE-PAGING.md sets for phases three and four
(section 9). Tests that need a particular mode say so in their own options (`indexTrees: true`
for the resident twin in `test/db.test.ts`), and those win over the default.

## The suites, file by file

Each section names the part of the system the file covers and the chapter that documents it,
then walks every case by its exact title.

### test/units.test.ts

Ten unit tests on the smallest pieces: the codec ([01](01-codec.md)), keys and the worker
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

### test/schemes.test.ts

Five tests on the two signature schemes ([02](02-crypto.md)), from a key pair up to a chain
running on the second one. The first four are unit tests under `describe('signature schemes')`;
the fifth runs a testnet under `describe('a chain on secp256k1')`, with an `RpcServer` stopped
before the network in `afterEach`. These are the only cases that name a scheme explicitly;
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

**`it('refuses the high-S twin of a secp256k1 signature, so a signed object has one encoding')`**.
ECDSA admits two `s` values for every signature, `s` and `n - s`; the test rebuilds the twin
from the curve order (`secp256k1.Point.Fn.ORDER`) and expects it refused while the original
verifies. Without low-S enforcement anyone relaying a transaction could rewrite its signature
and give it a second valid encoding and a second hash.

**`it('keeps each key's scheme in the keystore, and reads an old file as ML-DSA-44')`**. A
keystore gets `ml` with the default scheme and `ec` with secp256k1; reopened, `get` returns each
in its scheme with the same public key, and `list()` reports both schemes. Then the `scheme`
field is deleted from `ml`'s record on disk, as a file written before there were two schemes
would look; reopened again, `ml` is ML-DSA-44 in both `get` and `list` ([14](14-wallet-cli.md)).

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

Three tests on `src/store` ([the store chapter](10-store.md)): the in-memory and LMDB
key-value stores and the block store on top of either. `exerciseKv` is a shared routine: it
writes four keys in one batch, reads one back, finds a missing key `undefined`, ranges over the
prefix `b` with `prefixEnd` and gets `['one', 'two']` in byte order, counts four entries between
`a` and `z`, throws from inside a write and checks the key it put is not there, then deletes a
key. The `block(height)` helper builds a header of zero hashes with the height written into the
app hash.

**`it('memory store orders keys bytewise and makes writes atomic')`**. `exerciseKv(new MemoryKv())`.
The decisive point is the aborted write: a batch that throws leaves nothing behind.

**`it('lmdb store does the same and survives reopening')`**. The same routine on an `LmdbEnv`
in a temporary directory, then the environment is closed and reopened and `c` still reads
`three`; a second, read-only environment on the same path sees the deleted `a` as `undefined`.
The temporary directory is removed in `afterEach`.

**`it('block store finds blocks by height and by hash on both backends')`**. For a
`MemoryBlockStore` and a `KvBlockStore` over an LMDB store: save heights 1 to 5, load height 3
and check the commit's `blockHash` equals `blockHash(block)`, resolve the hash of block 4 to
height 4, resolve an unknown hash to `null`, find height 9 `null`, and find no saved chain state
(`loadState()` is `null`).

### test/arena.test.ts

Two tests on `src/db/arena.ts` ([the database chapter](09-database.md)), the slabs of encoded
bytes under the object database, with no database at all: an `owner()` helper plays the
database's part, holding one reference per `type/instance` in a `Map` and taking relocations
into it, and `bytesOf(n, fill)` makes an encoding of `n` bytes all equal to `fill`.

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
is 1, and a read at slab 0 throws `/released/`). A new entry then gets a reference above slab 0:
slab numbers are never reused, so a stale reference into a released slab fails rather than
reading a newer entry.

### test/db.test.ts

Thirty tests on the object database and the trees beneath it ([the database
chapter](09-database.md)). The fixture defines two object types: `ItemType` (type id 7) with
a unique, authenticated index `byName` and a non-unique `byGroup`, and `CounterType` (type id
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
is `1550 * 1000` for the two dropped databases (a leaf of the name tree per live item, 1,800
created and 250 removed, at 1,000 bytes each) and 0 for the resident one: what rebuilding would
take comes from the objects, not from what was resident when the trees went.

**`it('assigns dense ids and serves unique and range lookups')`** (describe `object database`).
Three items get ids `objectId(7, 0)`, `(7, 1)`, `(7, 2)`; `instanceOf(c.id)` is 2. The unique
index finds `bob` by exact name and nothing for the prefix `bo`; the group range lists names in
insertion order. Creating a second `alice` throws `DbError`. Modifying `bob` into group 2 moves
it between ranges; removing `alice` makes `get` and the name lookup `null`; `nextInstance` is 3
and the next item gets instance 3, so ids are never reused.

**`it('undoes and commits nested sessions')`**. An outer session modifies `alice` and creates
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
so are the object proofs. The history records are captured by the `keyProofBytes` helper into a
module-level `histories` array as a side effect of each call; the comment `// filled below`
marks it.

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
status to `a`, `a` receives 42, and `b` knows `a`'s height 3. The only test in the suite that
opens real sockets for the p2p layer.

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

Two tests on what survives a restart and on evidence ([05](05-mempool-executor.md),
[04](04-consensus.md)), again on the key-value application.

**`it('a validator restarted from disk resumes with its state, key guard and app intact')`**.
Node 0 alone gets a data directory. After a transaction lands, node 0 stops at `stoppedAt`; the
other three keep going three more heights. `net.makeNode(0, { dataDir })` reopens it: before
`start()` its `height` is already `stoppedAt` and the app already has `persist=yes`, both read
back from LMDB and `app.json`. After starting it catches up five heights, and within 20 heights
a commit on node 1 carries its signature at its index: the restarted validator is voting again,
which it could only do if its sign state (the double-sign guard, `priv_validator_state.bin`)
came back consistent with what it had signed. Its block at the catch-up height matches node 1's.

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
app has slashed anyone: node 0 proposed, found the evidence too old by block time, and discarded
it instead of proposing a block the others would reject. Evidence forged at the current height
does reach every app.

**`it('rejects a block from another protocol version')`**. The latest block with
`header.version + 1` fails `validateBlockStructure` with `/protocol version/`; the state's
`version` is `PROTOCOL_VERSION`; `lastResultsHash` is 32 bytes.

**`it('refuses a genesis with no validators from either side')`**. `genesisState` with no
engine validators and no application-supplied set throws `/no validators/`, and so does an
empty application set.

### test/memory.test.ts

Four tests on the memory guard and the collection scheduler of `src/node/memory.ts`
([08](08-node.md)): three unit tests under `describe('memory guard')`, where the heap is
whatever the test says it is, and one network test under `describe('a node under memory
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
`net.makeNode(2, { memory: { stats: () => stats(heap, limit), intervalMs: 20 } })`, so its
guard samples an invented heap against an invented limit fifty times a second; an `onMemory`
listener records the levels and an `RpcServer` is opened on it. At height 2 the level is `ok`,
the database's `hotLimit` is `Infinity`, and `status.memory` is `{ level: 'ok', shedding: false }`.
The heap is set to 900, 90% of the limit: within 5 s `isShedding` is true, the level is
`pressure`, the `hotLimit` is 10,000 and the cache holds no more than that (the first dial: the
cache of decoded objects capped, the excess evicted at once), `memory().indexTrees` and
`memory().trees` are both `dropped` (the second and third: every index read goes to the store
through the overlay, every root and proof reads its paths from the store), `mempool.paused` is
true, `submitTx` answers `paused`, `broadcastTx` and `block` over the RPC reject with `-32004`,
`GET /events` is 503, `/health` reports `memory: 'pressure'`, and `status.memory` is
`{ level: 'pressure', shedding: true, heapUsed: 900, database: { objects: 'capped', indexTrees: 'dropped', trees: 'dropped' } }`.
Then the claims that matter: the node advances two more heights while shedding, because
consensus and block sync are not what is shed, and its blocks ran against the dropped trees, so
a hash that differed from the validators' would have stopped it there; and an object proof of
the faucet at its height, read from the dropped trees, is byte for byte the proof a validator
with its trees resident makes at the same height. Then the heap eases, but not far enough: the
limit is set to four times what `rebuildEstimate()` says the two tiers would take (both
estimates are above zero) and the heap to 64% of it, 6% below the warn line, a quarter of what
rebuilding needs. Within 5 s shedding ends, the level is `ok`, the pool is resumed and the
`hotLimit` is `Infinity` again, and 100 ms later, five samples, both tiers are still `dropped`:
the node runs on the fallbacks at `ok` rather than take the heap straight back up. At 20% of the
limit the next samples rebuild them, `trees` and then `indexTrees` read `resident`,
`accountByName('faucet')` answers from the rebuilt index, `submitTx` answers something other
than `paused` (the test's key-value transaction is refused by the core application, not by the
pause), and `block` answers. At 99% the `critical` level is reported; what to do then (the CLI
stops the node) is the caller's, not the node's. The sequence seen is exactly
`['pressure', 'ok', 'critical']`: 10% to 90% is straight to `pressure` and 90% to 64% straight
to `ok`, one sample crossing several thresholds each way.

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

Sixteen unit tests on `CoreApp` ([11](11-application.md)) with no network: one genesis
validator, a faucet with one billion base units, zero inflation and no block reward, so every
balance is predictable. `block(app, txs)` calls `finalizeBlock` then `commit` with
`blockTime(h) = genesisTime + 1000n * h`. `tx(ops, keys, expiration)` signs with
`DEFAULT_FEES` and an expiration a minute after genesis. `FEES` holds what the default schedule
charges for a transfer and for registering the premium name `alice`. `withAlice()` is the common
fixture: alice registered at height 1 and paid 5,000 at height 2. Eleven cases under
`describe('core application')` cover the account and asset layer; five more under
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

The second group shares one check, `consistent(app, kv)`: the store's `'i'` keys equal
`db.indexEntries()`, `db.checkIndexStore()` reports nothing (every resident tree entry is in
the store with its value, and the store holds no more entries under an index's prefix than the
tree has), and the store's `'t'` and `'n'` keys equal `db.treeEntries()`.

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
alice's object overwritten by bob's bytes is refused: by the default path with
`/does not hash to its leaf/` (the leaf check), and by the recomputing path with
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

### test/staking.test.ts

Twelve unit tests that walk the staking rules of [STAKING.md](../../STAKING.md) and the
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
bytes: a transaction decoded from `rawTx` carries exactly the stated `777n`.

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
byte round-trip; a different transaction, a different index, a `count` of 16 (another tree
height) and the root of only six transactions all fail. Reversing the order changes the root.

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

Six tests on the JSON-RPC server and client ([12](12-rpc.md)), the keystore
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
`broadcastTx(..., 'commit')` of alice's registration returns `ok` and the transaction's hash.
A transfer in `'sync'` mode is `'added'`; once it lands, broadcasting it again in commit mode
returns the height it already landed at. A forged transfer (signed by alice for the faucet) is
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
by hash; `verifyLatest()` reaches the height `status` reports. The faucet's name proof from
`account`, with the header and commit of the next height fetched over the RPC, verifies
through `client.verifyKey` to the id `3.0`. A wrong trusted hash is refused.

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
throws `/wrong passphrase/`; and the raw JSON file does not contain bob's seed in hex.

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
`store.batch(() => { ... })` the test saves a validator set, the set at height 3 and the lowest
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
`trusted.header.height` is 2. `test/light.test.ts` covers the period at verification time; this
covers it at anchoring.

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
