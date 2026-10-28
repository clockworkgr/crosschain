# 2. Hashing, keys and signature verification

This part gives the node its three cryptographic tools: SHA-256 for naming things (`src/crypto/hash.ts`), ML-DSA-44 for proving who said them (`src/crypto/keys.ts`), and a pool of worker threads that checks signatures without stalling consensus (`src/crypto/verifier.ts` and `src/crypto/verify-worker.ts`). It consumes the bytes produced by [the codec](01-codec.md): every hash is a hash of an encoding, every signature is over an encoding. It feeds almost everything above it: [the chain types](03-types.md) take their address and signature sizes from here, [consensus](04-consensus.md) signs votes and proposals through the private validator and verifies them through a `Verifier`, [the p2p layer](06-p2p.md) authenticates peers with the same keys, [the application](11-application.md) verifies transaction signatures in batches, and [the light client](13-light-client.md) checks commits.

## Concepts

### Hashes as names

A cryptographic hash turns any byte string into a fixed 32-byte digest such that finding two inputs with the same digest is infeasible. A blockchain uses that property to give every object a short, unforgeable name. In this chain a block is named by the hash of its header (`headerHash` in `src/types/block.ts`), a transaction by the hash of its bytes (`txHash`), a validator by the hash of its public key (`addressOf` here), and a whole validator set by the hash of its encoding. Merkle trees ([chapter 9](09-database.md)) stack hashes to name a whole state with one digest. Because a hash names bytes, not objects, the canonical encoding of [chapter 1](01-codec.md) is a precondition for all of this.

The hash is SHA-256 from Node's built-in `node:crypto`, the same function Bitcoin, Tendermint and Cosmos use. The only question a post-quantum design has to ask about it is answered in the source comment: Grover's algorithm gives a quantum computer a quadratic speed-up on preimage search, which halves SHA-256's 256-bit preimage strength to 128 bits. 128 bits is still far beyond reach, so SHA-256 stays. (`DESIGN.md` section 4 says the same.)

### Signatures, and why these are so large

A digital signature scheme has a key pair. The holder of the secret key produces a signature over a message; anyone with the public key can check it, and nobody without the secret key can forge one. Validators sign votes with it, users sign transactions, and nodes sign their p2p handshake.

Most chains use Ed25519 or secp256k1, whose keys are 32 bytes and signatures 64 bytes. Both rest on the hardness of discrete logarithms, which Shor's algorithm breaks on a large enough quantum computer. This chain uses ML-DSA-44, the lattice-based scheme standardized by NIST in FIPS 204 (the scheme was called Dilithium before standardization). The `44` is a parameter set at NIST security level 2; the sizes are in the code and are what every later design decision has to live with:

```ts
export const SEED_SIZE = 32;
export const PUBLIC_KEY_SIZE = 1312;
export const SECRET_KEY_SIZE = 2560;
export const SIGNATURE_SIZE = 2420;
export const ADDRESS_SIZE = 32;
```

A public key is 41 times larger than an Ed25519 key and a signature 38 times larger. `DESIGN.md` section 5 lists the consequences it accepts: "a simple transfer tx is ~2.5 KB, nearly all of it the one signature" and "a block commit is 2420 B × validators. 100 validators ≈ 240 KB per block." `README.md` measures a signed transfer at 2.5 KiB, with 1,668 fitting in the default 4 MiB block. The same section explains why validators are referenced by 32-byte address and why accounts are referenced by id rather than key in the application: the key is stored once and never sent again.

There is also no signature aggregation for ML-DSA, unlike BLS. A commit is therefore a list of individual signatures, one per validator, which is why `Commit.signatures` in [chapter 3](03-types.md) is an array and why the light client downloads full commits.

The sizes compound through the data structures above this layer. From the constants alone:

| object | size | where it comes from |
|---|---|---|
| address | 32 B | `sha256(publicKey)` |
| validator in a stored set | 1,328 B | key 1,312 + power 8 + priority 8 (`ValidatorSet.encode`) |
| vote on the wire | 2,438 B or 2,470 B | 18 B of fields (nil) or 50 B (block hash) + 2,420 B signature |
| commit for N validators | about 2,421 × N B | one optional signature per validator |
| commit, 4 validators | about 9.7 KB | |
| commit, 100 validators | about 242 KB | `DESIGN.md` section 5: "100 validators ≈ 240 KB per block" |
| signed transfer | 2.5 KiB | `README.md`; "50 bytes of operation and 2,420 bytes of signature" |

Every number in the Performance section of `README.md` traces back to this table: "Signatures set every limit."

### One scheme, one address format

`DESIGN.md` section 5 decides "One scheme in the codebase." Validator votes, proposals, transactions and node identity all use ML-DSA-44. An address is `sha256(publicKey)`, all 32 bytes. Cosmos SDK derives validator addresses the same way but truncates to 20 bytes; keeping the full digest here costs 12 bytes and avoids the question of whether truncation is safe against a quantum adversary.

### Domain separation

A signature proves "this key signed these bytes". It does not by itself say what the bytes meant. If the bytes a validator signs for a vote could also be read as a transaction, an attacker could replay the vote signature as a transaction. If the same bytes could be a vote on a different chain with the same validator key, a signature could be replayed across chains. The usual defence is to prefix the message with a tag; Tendermint puts the chain id inside the vote's sign bytes, and the Cosmos SDK signs a document that names the chain.

FIPS 204 builds the mechanism in: `sign` and `verify` take a *context* string of up to 255 bytes that is bound into the signature. A signature made with one context never verifies under another. This chain uses the context `"<chainId>/<purpose>"` with four purposes, so the domain separation is enforced by the signature scheme rather than by every caller remembering a prefix. `signContext` in `src/crypto/keys.ts` is the only place the string is built.

### Deterministic signing

FIPS 204 allows the signer to mix in fresh randomness ("hedged" signing) or not. With randomness, signing the same message twice yields two different signatures, so a signed transaction would have many valid byte forms and many hashes. `DESIGN.md` section 5 chooses `extraEntropy: false` everywhere: "A tx then has exactly one byte representation and one hash." The same property is what lets the double-sign guard in [chapter 4](04-consensus.md) allow an identical re-sign of the same vote while refusing a different one: identical input means byte-identical output.

### Why verification leaves the main thread

Node runs JavaScript on one thread. `DESIGN.md` section 4 keeps the whole consensus state machine on that thread with no locks. Verifying one ML-DSA-44 signature in pure JavaScript costs about 0.8 ms of CPU (`README.md`, Performance). A block of a thousand transactions would hold the event loop for most of a second, during which no consensus timer fires and no vote is processed. The header comment of `src/crypto/verifier.ts` states the policy:

```ts
/**
 * Signature verification is the one CPU-heavy operation in the node, and it
 * sits on the hot path of consensus. On the main thread a block of a thousand
 * transactions would stall the event loop, and with it every consensus timer,
 * for about a second. So verification is the only thing that leaves the main
 * thread. Signing stays on the main thread: it happens once per consensus
 * step and keeping it inline makes the persist-then-broadcast ordering of the
 * double-sign guard trivial.
 */
```

Node's `worker_threads` run JavaScript in parallel with their own event loops; messages between them are copied (structured clone). The pool here is a fixed set of workers that each take a batch of `(signature, message, publicKey, context)` jobs and return booleans. `README.md` reports 1,200 verifications per second on one thread and 8,300 per second on the pool with 11 threads. Signing stays inline because it happens once per consensus step (3 to 9 ms, per `README.md`) and because the private validator must persist its last signed vote to disk *before* the signature exists anywhere else; an asynchronous signer would complicate that ordering.

## The code, file by file

### src/crypto/hash.ts

Pure functions over bytes; no state. Six exports.

**`HASH_SIZE = 32`** and **`ZERO_HASH`**, a fresh 32-byte array of zeros. `ZERO_HASH` is the value of hash fields that have nothing to point at: the `lastBlockHash` of block 1, `commitHash(null)`, and the `evidenceHash` of an empty evidence list in `src/types/block.ts`. It is distinct from the Merkle tree's empty value `EMPTY = sha256(0x02)` in `src/db/merkle.ts`, which is what an empty *tree* hashes to. An empty block's `dataHash` is `EMPTY`, not `ZERO_HASH`; the two should not be confused.

**`sha256(...parts)`** streams any number of byte arrays into one digest:

```ts
export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}
```

The parts are concatenated as far as the hash is concerned; `sha256(a, b)` equals `sha256(concat(a, b))`. That means a caller must not rely on the part boundaries for meaning: `sha256(x, yz)` and `sha256(xy, z)` collide. Every caller in the chain either hashes a single canonical encoding (where the codec's length prefixes delimit fields) or, in `src/db/merkle.ts`, hashes fixed-size pieces behind a one-byte prefix and varint lengths, which is the ICS23 shape. The return is a fresh `Uint8Array` wrapping the digest.

**`toHex(b)`** and **`fromHex(s)`** convert for display, JSON-RPC and log output. `fromHex` validates before converting:

```ts
export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error(`bad hex: ${s}`);
  return new Uint8Array(Buffer.from(s, 'hex'));
}
```

Without the check, `Buffer.from('zz', 'hex')` returns an empty buffer and `Buffer.from('abc', 'hex')` silently drops the odd nibble. Both would turn malformed RPC or genesis input into a wrong value rather than an error.

**`bytesEqual(a, b)`** compares two arrays, treating `null` as a value: two `null`s are equal, a `null` and an array are not. That is why it can compare vote block hashes, where `null` means a nil vote. It is a plain loop, not constant-time; nothing secret is compared with it (addresses, hashes, signatures that have already been verified), so timing does not matter.

**`compareBytes(a, b)`** is `memcmp`: it returns the difference of the first differing byte, or the length difference if one is a prefix of the other. It gives the total order used to sort validators by address in `src/types/validator.ts` and to put duplicate-vote evidence in canonical order in `src/types/evidence.ts`.

### src/crypto/keys.ts

Wraps `@noble/post-quantum/ml-dsa.js`, the pure-JavaScript ML-DSA implementation from the noble cryptography libraries (`package.json` pins `^0.7.1`). Nine exports plus the size constants quoted above.

**`interface KeyPair`** holds `seed`, `publicKey`, `secretKey` and `address`, all `readonly Uint8Array`. The comment on `address` says why it exists: "sha256(publicKey). Keys are too big to use directly as identifiers."

**`generateSeed()`** returns 32 bytes from `node:crypto`'s `randomBytes`. **`keyPairFromSeed(seed)`** derives everything else:

```ts
/** Key generation is deterministic from the seed, so only the seed is ever stored. */
export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== SEED_SIZE) throw new Error(`seed must be ${SEED_SIZE} bytes`);
  const { publicKey, secretKey } = ml_dsa44.keygen(seed);
  return { seed, publicKey, secretKey, address: addressOf(publicKey) };
}
```

ML-DSA key generation is a deterministic expansion of the seed, so `DESIGN.md` section 5 rules "persist the 32-byte seed only. Derive the keypair at startup." That is visible in the node's configuration: `NodeConfig` in `src/node/node.ts` takes a `nodeKeySeed` for the p2p identity and an optional `validatorSeed` for the consensus key (`null` for a full node that does not vote), and the constructor derives the node key with `keyPairFromSeed(cfg.nodeKeySeed)`. The keystore in [chapter 14](14-wallet-cli.md) encrypts seeds, never expanded keys. The test helper `seedFor(label)` in `test/helpers.ts` makes a seed as `sha256('seed:' + label)` so every test validator has a reproducible key, and `makeTestnet` derives validator and node seeds from the chain id and the node index.

**`addressOf(publicKey)`** is `sha256(publicKey)`.

**`type SignPurpose = 'vote' | 'proposal' | 'tx' | 'p2p'`** enumerates the four domains, and **`signContext(chainId, purpose)`** builds the FIPS 204 context:

```ts
export function signContext(chainId: string, purpose: SignPurpose): Uint8Array {
  const ctx = new TextEncoder().encode(`${chainId}/${purpose}`);
  if (ctx.length > 255) throw new Error('sign context too long');
  return ctx;
}
```

The 255-byte limit is the standard's. A chain id of up to about 245 bytes fits. For a chain named `demo`, `signContext('demo', 'vote')` is the nine bytes `64656d6f2f766f7465`, the ASCII of `demo/vote`. Callers build the context once and keep it: `src/consensus/privval.ts` stores `voteCtx` and `proposalCtx` in its constructor, `src/p2p/network.ts` stores `p2pCtx`, and `src/app/core/app.ts` stores the `tx` context.

Who signs and who verifies, by purpose:

| purpose | signer | message | verifier |
|---|---|---|---|
| `vote` | `PrivValidator.signVote` in `src/consensus/privval.ts` | `voteSignBytes(chainId, vote)` | consensus on every received vote; `verifyDuplicateVoteEvidence` in `src/consensus/evidence.ts`; the light client on commits |
| `proposal` | `PrivValidator.signProposal` | `proposalSignBytes(chainId, proposal)` | consensus on every received proposal |
| `tx` | `signTransaction` in `src/app/core/client.ts` (the wallet side) | the transaction body | `CoreApp` in `src/app/core/app.ts`, at mempool admission and in blocks |
| `p2p` | `Network` in `src/p2p/network.ts` during the handshake | `handshakeSignBytes` over both hello messages, each carrying a fresh nonce (`DESIGN.md` section 3) | the other side of the handshake |

The same key type serves all four rows, but a validator's consensus key, a node's p2p identity key and a user's account keys are separate key pairs; the context only prevents one *signature* from being read in another role.

**`sign(msg, secretKey, context)`** calls noble with `extraEntropy: false`:

```ts
export function sign(msg: Uint8Array, secretKey: Uint8Array, context: Uint8Array): Uint8Array {
  return ml_dsa44.sign(msg, secretKey, { context, extraEntropy: false });
}
```

It is never called with a raw object; the message is always a dedicated sign-bytes encoding such as `voteSignBytes` or `proposalSignBytes` from [chapter 3](03-types.md), or a transaction body.

**`verify(sig, msg, publicKey, context)`** never throws:

```ts
export function verify(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array, context: Uint8Array): boolean {
  if (sig.length !== SIGNATURE_SIZE || publicKey.length !== PUBLIC_KEY_SIZE) return false;
  try {
    return ml_dsa44.verify(sig, msg, publicKey, { context });
  } catch {
    return false;
  }
}
```

The size checks come first so a peer cannot make the library do work on garbage, and the `try/catch` turns any library exception on a malformed key or signature into "invalid". A verifier that could throw would be a denial-of-service lever in a worker thread, where an uncaught exception kills the worker.

### src/crypto/verifier.ts

Defines the job and the interface consensus, the network and the application depend on, and two implementations.

**`interface VerifyJob`** is one check: `sig`, `msg`, `publicKey`, `context`, all `Uint8Array`. **`interface Verifier`** has three methods:

```ts
export interface Verifier {
  verify(jobs: VerifyJob[]): Promise<boolean[]>;
  verifyOne(job: VerifyJob): Promise<boolean>;
  close(): Promise<void>;
}
```

`verify` is the batch form: it returns one boolean per job in order and never rejects a whole batch because one signature is bad. `verifyOne` is sugar for a single job. Both are asynchronous even in the inline implementation, so callers are written once and work with either. Everything above this layer takes a `Verifier` by dependency injection (`NodeConfig.verifier`, `CoreApp` options, `LightClient.trust`), which is what lets tests swap in a slow or inline one.

**`class InlineVerifier`** verifies on the calling thread:

```ts
/** Verifies on the calling thread. Used in tests and small simulations. */
export class InlineVerifier implements Verifier {
  async verify(jobs: VerifyJob[]): Promise<boolean[]> {
    return jobs.map((j) => verify(j.sig, j.msg, j.publicKey, j.context));
  }
  async verifyOne(job: VerifyJob): Promise<boolean> {
    return verify(job.sig, job.msg, job.publicKey, job.context);
  }
  async close(): Promise<void> {}
}
```

The whole test suite shares one instance (`export const verifier = new InlineVerifier()` in `test/helpers.ts`). Something to notice: `src/node/node.ts` defaults to it as well (`this.verifier = cfg.verifier ?? new InlineVerifier()`), and only `src/cli.ts`, `scripts/localnet.ts` and the benchmarks construct a `WorkerVerifier`. `DESIGN.md` section 4 says "The main thread never calls verify directly outside tests"; that is true of a node started by the CLI, but not of a `Node` constructed without a verifier. Section 10 now records this among the known simplifications: "The node defaults to the inline verifier; the CLI, the local network script and the benchmarks pass the worker pool. A node built from code should do the same."

**`class WorkerVerifier`** spreads batches across a fixed pool. Its state is the `workers` array (one slot per thread; a slot's worker may be replaced), an `inflight` count per slot, a `pending` map from job id to the promise callbacks and the slot that holds the job, a job id counter, a round-robin cursor and a `closed` flag. The constructor fills the slots:

```ts
  constructor(size = Math.max(1, cpus().length - 1)) {
    for (let i = 0; i < size; i++) {
      this.workers.push(this.spawn(i));
      this.inflight.push(0);
    }
  }
```

The default size is one fewer than the CPU count, leaving a core for the main thread (`DESIGN.md` section 4: "size = cpu count - 1"). The private **`spawn(index)`** creates one worker for a slot and wires its three events:

```ts
  private spawn(index: number): Worker {
    const w = new Worker(new URL('./verify-worker.ts', import.meta.url));
    w.on('message', (m: { id: number; results: boolean[] }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      this.settle(p.worker);
      p.resolve(m.results);
    });
    // A worker that dies fails only the jobs it held, and is replaced so the pool keeps its size.
    const failed = (e: Error) => {
      if (this.workers[index] !== w) return;
      for (const [id, p] of this.pending) {
        if (p.worker !== index) continue;
        this.pending.delete(id);
        p.reject(e);
      }
      this.inflight[index] = 0;
      if (!this.closed) this.workers[index] = this.spawn(index);
    };
    w.on('error', failed);
    w.on('exit', (code) => {
      if (!this.closed) failed(new Error(`verification worker exited with code ${code}`));
    });
    // Workers must not keep the process alive on their own, only while a caller waits on them.
    w.unref();
    return w;
  }
```

The worker file is referenced by a `.ts` URL, which works because Node 24 strips types natively; there is no build step anywhere in this repository. A `'message'` answers one batch: look the id up, forget it, settle the slot, resolve. A `'error'` (an uncaught exception in the worker) or any `'exit'` while the pool is open runs `failed`, which rejects only the batches that slot held, zeroes its in-flight count and spawns a replacement into the same slot, so the pool keeps its size and the round-robin cursor never points at a dead thread. The exit code is not consulted: a worker that leaves with code 0 (its event loop ran dry, or something called `process.exit()` inside it) is just as gone as one that crashed, and the batches it held would otherwise wait forever, since nothing else ever resolves them. The first line of `failed` guards against a stale event from a worker that has already been replaced, and the `closed` check stops a pool that is shutting down from respawning. This is the resolution of review finding 40; before it, one worker's error rejected every pending job in the pool and the dead worker stayed in rotation, so later jobs sent to it never completed.

The `ref`/`unref` dance is the fix for the earlier review finding 34. A referenced worker keeps the Node process alive; an unreferenced one does not. Workers start unreferenced (the `w.unref()` at the end of `spawn`) so an idle pool never prevents exit, but the first job sent to a slot references its worker (`if (this.inflight[worker]!++ === 0) w.ref()` in `submit`) and the private `settle` unreferences it again when its last job completes:

```ts
  private settle(worker: number): void {
    if (--this.inflight[worker]! === 0) this.workers[worker]!.unref();
  }
```

Before the fix, a CLI command whose only pending work was a verification would exit before the answer arrived, with the promise never settled.

The private **`submit(jobs)`** posts one batch to the next worker round-robin and returns a promise keyed by id. If the pool is closed it rejects at once with `'verifier closed'`. **`verify(jobs)`** splits a batch so every worker gets a share:

```ts
  async verify(jobs: VerifyJob[]): Promise<boolean[]> {
    if (jobs.length === 0) return [];
    // Chunk large batches so every worker gets a share.
    const chunk = Math.max(1, Math.ceil(jobs.length / this.workers.length));
    const parts: Promise<boolean[]>[] = [];
    for (let i = 0; i < jobs.length; i += chunk) parts.push(this.submit(jobs.slice(i, i + chunk)));
    return (await Promise.all(parts)).flat();
  }
```

A batch of 1,500 transaction signatures on an 11-worker pool becomes eleven chunks of up to 137 jobs, posted to eleven workers at once, and the results are flattened back into the original order. This is why batching matters so much upstream: review finding 32 found that after an unrelated fix the application was handing the pool one signature at a time, running a cold block at single-thread speed (930 transfers per second); batching the block's uncached signatures first restored 5,100 per second. **`verifyOne(job)`** is `submit([job])` and takes the first result. **`close()`** settles everything before it stops the threads:

```ts
  async close(): Promise<void> {
    this.closed = true;
    const e = new Error('verifier closed');
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
```

Every batch still in flight is rejected with `'verifier closed'`, the same error a `submit` after closing gets, so a caller awaiting a result across shutdown sees a rejection rather than a promise that never settles. The `closed` flag is set first, so the `'exit'` events the terminations produce do not trigger `failed` and respawn anything.

Each `postMessage` copies the job arrays into the worker (a signature, a key, the message and the context: about 4 KB per transaction) and copies only booleans back. The copying is a real cost but far below the verification itself.

A batch through the pool, step by step, for a block of 500 transactions on a pool of 4 workers:

1. The application collects the 500 uncached `VerifyJob`s and calls `verifier.verify(jobs)` once.
2. `verify` computes `chunk = ceil(500 / 4) = 125` and calls `submit` four times with `jobs.slice(0, 125)`, `(125, 250)`, `(250, 375)`, `(375, 500)`.
3. Each `submit` takes the next worker in round-robin order, increments that worker's `inflight` (calling `ref()` on the transition from 0), records the promise under a fresh `id`, and posts `{ id, jobs }`.
4. Each worker runs `verify` 125 times, about 100 ms of CPU each, in parallel, and posts `{ id, results }` back.
5. Each `'message'` handler looks the `id` up, deletes it, calls `settle` (decrementing `inflight` and calling `unref()` at 0), and resolves the promise with the 125 booleans.
6. `Promise.all` waits for all four, `.flat()` joins them in submission order, and the application gets 500 booleans in the order it sent the jobs.

The main thread was free for the whole of step 4; consensus timers and incoming votes ran as usual. Had the application instead called `verifyOne` 500 times in a loop awaiting each, the pool would have been used one worker at a time, which is precisely what review finding 32 observed.

Failure modes worth knowing:

- A worker that dies takes the batches it held with it: those promises reject with the worker's error, and the caller decides whether to resubmit. Nothing is retried automatically. Worker errors should not happen in practice, because `verify` in `keys.ts` catches everything the library can throw, so this is a recovery path for the unexpected (an out-of-memory in the thread, a killed thread), not for bad signatures, which are ordinary `false` results.
- A batch is rejected as a whole, not per job; `Promise.all` in `verify` then rejects the caller's whole call even if the other chunks succeeded.
- A worker that exits with code 0 while the pool is open is not replaced, since the handler treats a clean exit as intentional. The worker script never exits on its own, so this does not arise.
- `close()` rejects what is pending and then terminates; a `submit` after `close()` rejects immediately.

### src/crypto/verify-worker.ts

The body of each worker thread, eighteen lines:

```ts
import { parentPort } from 'node:worker_threads';
import { verify } from './keys.ts';
import type { VerifyJob } from './verifier.ts';

interface Request {
  id: number;
  jobs: VerifyJob[];
}

parentPort!.on('message', (req: Request) => {
  const results = req.jobs.map((j) => verify(j.sig, j.msg, j.publicKey, j.context));
  parentPort!.postMessage({ id: req.id, results });
});
```

It imports the same `verify` as the inline verifier, so the two implementations cannot disagree. The `import type` of `VerifyJob` is erased, so the worker does not load `verifier.ts` and does not try to construct a pool of its own. The `id` is echoed back so the main thread can match an answer to its promise regardless of the order in which workers finish.

## How it is tested

`test/units.test.ts`, `describe('ML-DSA-44 keys')`, has three cases, all on a key derived from `seedFor('k')`.

**`signs deterministically and binds the context`** signs the same message twice and asserts the signatures are byte-identical, then checks that the signature verifies under its own context and fails under `signContext('c', 'vote')` (different purpose), `signContext('other', 'tx')` (different chain) and a different message. This is the domain-separation guarantee in four lines:

```ts
    expect(verify(s1, msg, kp.publicKey, ctx)).toBe(true);
    expect(verify(s1, msg, kp.publicKey, signContext('c', 'vote'))).toBe(false);
    expect(verify(s1, msg, kp.publicKey, signContext('other', 'tx'))).toBe(false);
    expect(verify(s1, new Uint8Array([0]), kp.publicKey, ctx)).toBe(false);
```

**`derives the same key from the same seed and addresses are hashes`** proves `keyPairFromSeed` is deterministic and that `addressOf` is `sha256` of the public key.

**`verifies in worker threads`** builds a two-worker `WorkerVerifier`, makes five valid signatures, zeroes the first eight bytes of the third, and asserts the pool returns `[true, true, false, true, true]`. With two workers and five jobs the chunk size is three, so the batch is split across both workers and reassembled in order; the corrupted signature proves that a bad job yields `false` rather than an exception or a rejected batch. The pool is closed in a `finally`.

`test/review.test.ts`, **`settles pending verifications when the worker pool closes`**, is the regression for review finding 40's second half. It builds a one-worker pool, submits a batch of 500 copies of one valid job (several hundred milliseconds of work for a single thread), attaches a `rejects.toThrow(/verifier closed/)` expectation *before* calling `close()`, so that the rejection is observed rather than unhandled, then closes the pool and awaits the expectation. Before the fix that promise never settled. Its neighbour, **`replaces a verification worker that dies, failing only the jobs it held`**, builds a one-worker pool, queues 300 `verifyOne` calls, then reaches into the pool and calls `terminate()` on the worker, which ends it with exit code 1. At least one of the pending promises rejects with `/exited/`, and a fresh `verifyOne` on the same pool resolves `true`: the replacement in the same slot answers it.

`test/network.test.ts`, **`delivers a message sent the instant a peer connects, while the other side is still verifying the handshake`**, wraps the inline verifier in a custom `Verifier` whose `verifyOne` sleeps 100 ms. It exists to reproduce review finding 33 (a frame arriving while the handshake signature was still in the pool was dropped), and it shows that the `Verifier` interface is the seam the network depends on: any object with `verify`, `verifyOne` and `close` will do.

Every other suite depends on this layer through the shared `InlineVerifier` in `test/helpers.ts` and through `keyPairFromSeed`, `sign` and `signContext`, which the engine, recovery and sync tests use to forge conflicting votes for evidence. `test/review.test.ts`, **`does not let a cached verification vouch for different signature bytes`**, replaces a valid signature with `new Uint8Array(SIGNATURE_SIZE)` and checks the application rejects it on both a warm and a cold node (review finding 2).

`bench/crypto.bench.ts` measures `keyPairFromSeed`, `sign`, inline `verify`, `sha256` over 2.5 KB, and `WorkerVerifier.verify` over 256 signatures; the `README.md` Performance table is its output.

## Limitations and ideas

Known simplifications:

- A batch on a worker that dies is rejected, not retried; the caller must resubmit.
- Jobs are copied to workers by structured clone; there is no transfer of ownership and no shared memory.
- `bytesEqual` is not constant-time. That is fine for the values it compares today; it would not be fine for comparing secrets.
- A `Node` constructed without a `verifier` uses `InlineVerifier` (`src/node/node.ts`), which `DESIGN.md` section 10 lists as a known simplification; the CLI, localnet and benchmarks pass a `WorkerVerifier`.
- Signing is synchronous and in pure JavaScript, 3 to 9 ms per signature; a validator signs at most a few times per block, so this is acceptable, but a wallet signing thousands of transactions would notice.

Exercises:

1. Write the test that review finding 40 did not: kill a worker from inside a job (a job whose `msg` is a sentinel that makes the worker call `process.exit(1)`), and assert that only that batch rejects, that the pool still has its size, and that a batch submitted afterwards succeeds on the replacement.
2. Make `verify` retry a chunk once on the replacement worker when its first attempt is rejected by a worker death, and argue whether a retry can ever change the answer for a signature.
3. Measure the structured-clone overhead: time `verify` on 256 jobs through the pool against 256 inline verifications divided by the thread count. Then try passing the job buffers as transferables and see what changes.
4. Add a `SignPurpose` for a new message type (say `'snapshot'`) and trace every place a context is built to see what would have to change. Note that nothing stops two purposes from using the same string; make `signContext` reject unknown purposes at runtime.
5. Replace ML-DSA-44 with ML-DSA-65 (noble exports `ml_dsa65`), update the size constants, and run the suite. Everything should pass; find the tests whose fixtures assume the sizes.
6. Write a constant-time `bytesEqual` and benchmark it against the current one over 32-byte inputs.

## Where to next

[Chapter 3](03-types.md) uses these primitives to define what a validator set, a vote, a block, a commit, evidence, a proposal and the chain state are, and how each is encoded and hashed.
