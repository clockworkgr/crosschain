# 2. Hashing, keys and signature verification

This part gives the node its three cryptographic tools: SHA-256 for naming things (`src/crypto/hash.ts`), digital signatures for proving who said them (`src/crypto/keys.ts`, which offers two schemes, post-quantum ML-DSA-44 and classical secp256k1, with genesis fixing which one a chain uses), and a pool of worker threads that checks signatures without stalling consensus (`src/crypto/verifier.ts` and `src/crypto/verify-worker.ts`). It consumes the bytes produced by [the codec](01-codec.md): every hash is a hash of an encoding, every signature is over an encoding. It feeds almost everything above it: [the chain types](03-types.md) take their address size and their key and signature decoders from here, [consensus](04-consensus.md) signs votes and proposals through the private validator and verifies them through a `Verifier`, [the p2p layer](06-p2p.md) authenticates peers with the same keys, [the application](11-application.md) verifies transaction signatures in batches, and [the light client](13-light-client.md) checks commits.

## Concepts

### Hashes as names

A cryptographic hash turns any byte string into a fixed 32-byte digest such that finding two inputs with the same digest is infeasible. A blockchain uses that property to give every object a short, unforgeable name. In this chain a block is named by the hash of its header (`headerHash` in `src/types/block.ts`), a transaction by the hash of its bytes (`txHash`), a validator by the hash of its public key (`addressOf` here), and a whole validator set by the hash of its encoding. Merkle trees ([chapter 9](09-database.md)) stack hashes to name a whole state with one digest. Because a hash names bytes, not objects, the canonical encoding of [chapter 1](01-codec.md) is a precondition for all of this.

The hash is SHA-256 from Node's built-in `node:crypto`, the same function Bitcoin, Tendermint and Cosmos use. The only question a post-quantum design has to ask about it is answered in the source comment: Grover's algorithm gives a quantum computer a quadratic speed-up on preimage search, which halves SHA-256's 256-bit preimage strength to 128 bits. 128 bits is still far beyond reach, so SHA-256 stays. (`DESIGN.md` section 4 says the same.)

### Two signature schemes, and why one of them is so large

A digital signature scheme has a key pair. The holder of the secret key produces a signature over a message; anyone with the public key can check it, and nobody without the secret key can forge one. Validators sign votes with it, users sign transactions, and nodes sign their p2p handshake.

Most chains use Ed25519 or secp256k1, whose keys are 32 or 33 bytes and signatures 64 bytes. Both rest on the hardness of discrete logarithms, which Shor's algorithm breaks on a large enough quantum computer. This chain was built around ML-DSA-44, the lattice-based scheme standardized by NIST in FIPS 204 (the scheme was called Dilithium before standardization; the `44` is a parameter set at NIST security level 2), and that is still its default. It also offers secp256k1, the ECDSA curve of Bitcoin and Ethereum, for a chain that would rather have classical compactness than quantum resistance, and a genesis file names which of the two its chain uses. The header comment of `src/crypto/keys.ts` sets the two side by side:

```ts
 *   ML-DSA-44   FIPS 204, NIST level 2, post-quantum. Public key 1312 B,
 *               signature 2420 B, about a millisecond to verify in pure
 *               JavaScript, which is why verification goes through a worker
 *               pool (see verifier.ts).
 *   secp256k1   ECDSA over the Bitcoin curve, RFC 6979 deterministic, low-S
 *               signatures only (a high-S twin of a valid signature is
 *               refused, so a signed object has exactly one encoding).
 *               Public key 33 B compressed, signature 64 B compact.
```

Every public key, secret key and signature carries a one-byte *scheme tag* in front of those raw bytes, 1 for ML-DSA-44 and 2 for secp256k1, so a tagged ML-DSA-44 public key is 1,313 bytes and its signature 2,421, against 34 and 65 for secp256k1. The tag tells a decoder how many bytes follow and a verifier which scheme to run, and it is what lets the chain refuse the other scheme wherever a key or a signature enters it. An ML-DSA-44 key is 39 times the size of a secp256k1 key and a signature 37 times; those sizes are what every later design decision on an ML-DSA-44 chain has to live with. `DESIGN.md` section 5 lists the consequences it accepts: a simple transfer is about 2.5 KB, nearly all of it the one signature, and a commit grows by a full signature per validator. The same section explains why validators are referenced by 32-byte address and why accounts are referenced by id rather than key in the application: the key is stored once and never sent again.

Neither scheme aggregates signatures the way BLS does. A commit is therefore a list of individual signatures, one per validator, which is why `Commit.signatures` in [chapter 3](03-types.md) is an array and why the light client downloads full commits.

The sizes compound through the data structures above this layer. With the tag included:

| object | ML-DSA-44 | secp256k1 | where it comes from |
|---|---|---|---|
| address | 32 B | 32 B | `sha256(publicKey)`, tag included |
| public key | 1,313 B | 34 B | tag + 1,312, or tag + 33 (compressed point) |
| signature | 2,421 B | 65 B | tag + 2,420, or tag + 64 (compact `r` and `s`) |
| validator in a stored set | 1,329 B | 50 B | key + power 8 + priority 8 (`ValidatorSet.encode`) |
| vote on the wire | 2,439 B or 2,471 B | 83 B or 115 B | 18 B of fields (nil) or 50 B (block hash) + the signature |
| commit, N slots, S signatures | 48 + N + 2,421 × S B | 48 + N + 65 × S B | height, round, hash, count, one presence byte per slot, one signature per signer |
| commit, 4 validators, all signing | about 9.7 KB | 312 B | |
| commit, 100 validators, all signing | about 242 KB | about 6.6 KB | |
| signed transfer | about 2.5 KB | about 150 B | a 41-byte operation, 48 bytes of framing and signer address, one signature |

Under ML-DSA-44 every number in the Performance section of `README.md` traces back to this table: "Signatures set every limit." Under secp256k1 the same structures are a few percent of the size, and the block budget, the frame limit and the per-account memory that later chapters quote for ML-DSA-44 shrink with them. What does not shrink much is verification time, as the last of these concepts shows.

### One scheme per chain, one address format

Genesis names the scheme (`signatureScheme`, ML-DSA-44 when absent, so every genesis file written before there were two keeps its meaning), and on a given chain validator votes, proposals, transactions and node identity all use it. The chain refuses the other scheme wherever a key or a signature enters it: genesis validators and accounts, validator-set updates, account authorities, consensus keys, transaction signatures, and the validator sets a state-synced node is served ([chapter 3](03-types.md), [chapter 7](07-sync.md), [chapter 11](11-application.md)). The application also keeps the scheme in its global properties, so it is part of the app hash: two nodes whose genesis files name different schemes never agree on a root. An address is `sha256(publicKey)` over the tagged key, all 32 bytes, so one seed yields a different address under each scheme. Cosmos SDK derives validator addresses the same way but truncates to 20 bytes; keeping the full digest here costs 12 bytes and avoids the question of whether truncation is safe against a quantum adversary.

### Domain separation

A signature proves "this key signed these bytes". It does not by itself say what the bytes meant. If the bytes a validator signs for a vote could also be read as a transaction, an attacker could replay the vote signature as a transaction. If the same bytes could be a vote on a different chain with the same validator key, a signature could be replayed across chains. The usual defence is to prefix the message with a tag; Tendermint puts the chain id inside the vote's sign bytes, and the Cosmos SDK signs a document that names the chain.

FIPS 204 builds the mechanism in: ML-DSA's `sign` and `verify` take a *context* string of up to 255 bytes that is bound into the signature. ECDSA has no such parameter, so for secp256k1 the context is hashed in ahead of the message, length first (`secpDigest` below), which binds it just as firmly. Either way, a signature made with one context never verifies under another. This chain uses the context `"<chainId>/<purpose>"` with four purposes, so the domain separation is enforced by the signing layer rather than by every caller remembering a prefix. `signContext` in `src/crypto/keys.ts` is the only place the string is built.

### Deterministic signing, and one encoding per signed object

FIPS 204 allows the signer to mix in fresh randomness ("hedged" signing) or not. With randomness, signing the same message twice yields two different signatures, so a signed transaction would have many valid byte forms and many hashes. `DESIGN.md` section 5 chooses `extraEntropy: false` everywhere: "A tx then has exactly one byte representation and one hash." The same property is what lets the double-sign guard in [chapter 4](04-consensus.md) allow an identical re-sign of the same vote while refusing a different one: identical input means byte-identical output.

ECDSA raises the same question twice. Textbook ECDSA draws a random nonce for every signature; RFC 6979 derives the nonce from the key and the message instead, and noble's signer does that, so secp256k1 signing here is deterministic too. Then there is a second source of multiple encodings that ML-DSA does not have: an ECDSA signature is a pair `(r, s)`, and `(r, n - s)`, with `n` the curve order, verifies just as well. Anyone, not only the signer, can flip `s` on a signature in flight and produce a second valid byte form of the same transaction with a different hash. Bitcoin lived through that as "transaction malleability" (BIP 62, BIP 146), and the cure is the same here: *low-S*. The signer always emits the smaller of the two `s` values and the verifier refuses the other, so a key over a body has exactly one accepted signature. It matters because a transaction's id is the hash of its bytes, signature included ([chapter 3](03-types.md)): a malleated twin would be a second entry in every mempool and a second id in the transaction index for one and the same body.

### Why verification leaves the main thread

Node runs JavaScript on one thread. `DESIGN.md` section 4 keeps the whole consensus state machine on that thread with no locks. Verifying one ML-DSA-44 signature in pure JavaScript costs about 0.9 ms of CPU, and one secp256k1 signature, also in pure JavaScript, about 0.7 ms (`bench/crypto.bench.ts`: 874 µs and 719 µs mean); the classical scheme is nearly forty times smaller on the wire but not much cheaper to check here, so the pool earns its keep under both. A block of a thousand transactions would hold the event loop for most of a second, during which no consensus timer fires and no vote is processed. The header comment of `src/crypto/verifier.ts` states the policy:

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

Node's `worker_threads` run JavaScript in parallel with their own event loops; messages between them are copied (structured clone). The pool here is a fixed set of workers that each take a batch of `(signature, message, publicKey, context)` jobs and return booleans. The benchmark suite measures 1,144 ML-DSA-44 verifications per second on one thread and 7,437 per second on the pool with 11 threads; for secp256k1, 1,391 and 9,215. Signing stays inline because it happens once per consensus step (about 2 ms for ML-DSA-44, a quarter of a millisecond for secp256k1) and because the private validator must persist its last signed vote to disk *before* the signature exists anywhere else; an asynchronous signer would complicate that ordering.

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

Wraps two libraries behind one interface: `@noble/post-quantum/ml-dsa.js` for ML-DSA-44 and `@noble/curves/secp256k1.js` for ECDSA over secp256k1, both pure JavaScript from the noble cryptography libraries (`package.json` pins `^0.7.1` and `^2.4.0`). The file is a table of scheme implementations, a set of helpers that read the tag, and the operations every caller uses: derive a key pair, sign, verify, build a context.

**`Scheme`, `SchemeTag`, `SchemeName`.** The tag is the one byte in front of every key and signature; the name is what genesis, the keystore and the RPC use:

```ts
export const SEED_SIZE = 32;
export const ADDRESS_SIZE = 32;

export const Scheme = { mlDsa44: 1, secp256k1: 2 } as const;
export type SchemeTag = (typeof Scheme)[keyof typeof Scheme];
export type SchemeName = 'ml-dsa-44' | 'secp256k1';
export const SCHEME_NAMES: readonly SchemeName[] = ['ml-dsa-44', 'secp256k1'];
```

**`schemeTag(name)`** and **`schemeName(tag)`** convert between the two. An unknown name throws `unknown signature scheme "x"; one of ml-dsa-44, secp256k1`, which is the error a genesis file with a misspelt scheme produces when it is loaded.

**`interface SchemeImpl`** (private) is what a scheme has to provide: its tag and name, its three raw sizes, a seed check, key generation, and sign and verify taking a context:

```ts
interface SchemeImpl {
  readonly tag: SchemeTag;
  readonly name: SchemeName;
  /** Raw sizes, without the tag byte. */
  readonly publicKeySize: number;
  readonly secretKeySize: number;
  readonly signatureSize: number;
  validSeed(seed: Uint8Array): boolean;
  keygen(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
  sign(msg: Uint8Array, secretKey: Uint8Array, context: Uint8Array): Uint8Array;
  verify(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array, context: Uint8Array): boolean;
}
```

The ML-DSA-44 entry is a thin wrapper over noble, with the context passed natively and `extraEntropy: false`:

```ts
const mlDsa44: SchemeImpl = {
  tag: Scheme.mlDsa44,
  name: 'ml-dsa-44',
  publicKeySize: 1312,
  secretKeySize: 2560,
  signatureSize: 2420,
  validSeed: () => true,
  keygen: (seed) => ml_dsa44.keygen(seed),
  // Deterministic signing (no extra entropy): the same message signed twice yields identical bytes.
  sign: (msg, secretKey, context) => ml_dsa44.sign(msg, secretKey, { context, extraEntropy: false }),
  verify: (sig, msg, publicKey, context) => ml_dsa44.verify(sig, msg, publicKey, { context }),
};
```

Every seed is valid, because ML-DSA key generation is a deterministic expansion of any 32 bytes. The secp256k1 entry has more to say:

```ts
/** ECDSA signs a digest; the context is bound in by hashing it, length first, ahead of the message. */
function secpDigest(context: Uint8Array, msg: Uint8Array): Uint8Array {
  return sha256(new Uint8Array([context.length]), context, msg);
}

const secp: SchemeImpl = {
  tag: Scheme.secp256k1,
  name: 'secp256k1',
  publicKeySize: 33,
  secretKeySize: 32,
  signatureSize: 64,
  // A 32-byte seed is the secret key itself; the few values at or beyond the curve order are not keys.
  validSeed: (seed) => secp256k1.utils.isValidSecretKey(seed),
  keygen: (seed) => {
    if (!secp256k1.utils.isValidSecretKey(seed)) throw new Error('seed is not a valid secp256k1 secret key');
    return { publicKey: secp256k1.getPublicKey(seed, true), secretKey: seed.slice() };
  },
  sign: (msg, secretKey, context) => secp256k1.sign(secpDigest(context, msg), secretKey, { prehash: false, lowS: true }),
  verify: (sig, msg, publicKey, context) => secp256k1.verify(sig, secpDigest(context, msg), publicKey, { prehash: false, lowS: true }),
};
```

Four things to notice. ECDSA signs a 32-byte digest, not a message, so the context has to be folded into the digest: `secpDigest` hashes the context's length, the context and the message, in that order. The length byte keeps the boundary unambiguous (recall from `sha256` above that parts are concatenated as far as the hash is concerned, so without it a context ending in some byte followed by a message, and the shorter context followed by that byte and the message, would collide); a context is at most 255 bytes, so one byte holds it, and `prehash: false` tells noble the digest is already made. `lowS: true` on both calls is the malleability rule from the Concepts section: the signer canonicalises, the verifier refuses the twin. Third, the seed: there is no derivation step, the 32-byte seed *is* the secret key, and the handful of 32-byte values at or beyond the curve order are not keys, so `validSeed` reports them and `keygen` refuses them. Last, the formats: the public key is the 33-byte compressed point and the signature the 64-byte compact `r` and `s`, the smallest encodings the curve has.

**`SCHEMES`** maps tag to implementation, and the private `impl(tag)` looks one up or throws `unknown signature scheme N`:

```ts
const SCHEMES: Record<SchemeTag, SchemeImpl> = { [Scheme.mlDsa44]: mlDsa44, [Scheme.secp256k1]: secp };
```

**`DEFAULT_SCHEME`** is what `keyPairFromSeed` and `generateSeed` use when no scheme is passed:

```ts
/**
 * The scheme keyPairFromSeed and generateSeed use when none is given: ML-DSA-44,
 * or CHAIN_SCHEME from the environment, so the whole test suite and the local
 * network can run under either scheme. A node always passes its genesis scheme.
 */
export const DEFAULT_SCHEME: SchemeTag = process.env.CHAIN_SCHEME ? schemeTag(process.env.CHAIN_SCHEME) : Scheme.mlDsa44;
```

The environment variable exists for the tests, the benchmarks and `scripts/localnet.ts`, which build their genesis with `signatureScheme: schemeName(DEFAULT_SCHEME)` and so run wholly on secp256k1 under `CHAIN_SCHEME=secp256k1`. Nothing in the node relies on the default: `Node` reads `genesis.signatureScheme` and passes the tag when it derives its node key and its validator key ([chapter 8](08-node.md)), and the keystore records each key's scheme ([chapter 14](14-wallet-cli.md)).

**The size helpers.** `publicKeySize(tag)` and `signatureSize(tag)` give the tagged sizes; `MAX_PUBLIC_KEY_SIZE` and `MAX_SIGNATURE_SIZE` are the ML-DSA-44 ones, for anything that must budget for the largest case:

```ts
/** Tagged sizes: the tag byte plus the raw key or signature. */
export function publicKeySize(tag: SchemeTag): number {
  return 1 + impl(tag).publicKeySize;
}

export function signatureSize(tag: SchemeTag): number {
  return 1 + impl(tag).signatureSize;
}

export const MAX_PUBLIC_KEY_SIZE = 1 + mlDsa44.publicKeySize;
export const MAX_SIGNATURE_SIZE = 1 + mlDsa44.signatureSize;
```

**The tag readers.** `isSchemeTag(n)` says whether a number is a known tag; `schemeOf(bytes)` returns the tag a key or signature starts with, or `null`; `isPublicKey(bytes)` and `isSignature(bytes)` require a known tag *and* exactly that scheme's size:

```ts
export function isSchemeTag(tag: number): tag is SchemeTag {
  return SCHEMES[tag as SchemeTag] !== undefined;
}

/** The scheme a tagged key or signature names, or null when the tag is unknown. */
export function schemeOf(bytes: Uint8Array): SchemeTag | null {
  const s = bytes.length > 0 ? SCHEMES[bytes[0] as SchemeTag] : undefined;
  return s ? s.tag : null;
}

/** A known tag followed by exactly that scheme's key. */
export function isPublicKey(bytes: Uint8Array): boolean {
  const s = schemeOf(bytes);
  return s !== null && bytes.length === publicKeySize(s);
}

export function isSignature(bytes: Uint8Array): boolean {
  const s = schemeOf(bytes);
  return s !== null && bytes.length === signatureSize(s);
}
```

These replace what used to be comparisons against a size constant. `ValidatorSet.create` and `applyUpdates` ([chapter 3](03-types.md)), the network's `vetHello` ([chapter 6](06-p2p.md)), the key-value test application and the core application's authority check ([chapter 11](11-application.md)) call `isPublicKey`; `genesisState` and `nextState`, state sync and the application's signature verifier call `schemeOf` to refuse a key or a signature of the other scheme with a clear message before any verification work.

**The decoders.** A key or a signature is written with the codec's `fixed`, tag included, and read back by `decodePublicKey(r)` or `decodeSignature(r)`, which read the tag and then that scheme's number of bytes; an unknown tag is a `CodecError`, so a peer's bad byte is a malformed message like any other ([chapter 1](01-codec.md)):

```ts
function tagged(tag: SchemeTag, raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + raw.length);
  out[0] = tag;
  out.set(raw, 1);
  return out;
}

/** Read a tagged public key: the tag says how many bytes follow. */
export function decodePublicKey(r: Reader): Uint8Array {
  const tag = r.u8();
  const s = SCHEMES[tag as SchemeTag];
  if (!s) throw new CodecError(`unknown signature scheme ${tag}`);
  return tagged(s.tag, r.fixed(s.publicKeySize));
}

export function decodeSignature(r: Reader): Uint8Array {
  const tag = r.u8();
  const s = SCHEMES[tag as SchemeTag];
  if (!s) throw new CodecError(`unknown signature scheme ${tag}`);
  return tagged(s.tag, r.fixed(s.signatureSize));
}
```

This is the one place the crypto layer reaches down into the codec (`CodecError` and the `Reader` type come from `src/codec/reader.ts`); every decoder of a vote, a proposal, a commit, a validator set, a hello, a handshake signature, an authority or a transaction calls these two where it used to call `fixed` with a constant. The encoding is self-delimiting: a reader that knows nothing about the chain's scheme can still walk the bytes, and the tag costs one byte where a length prefix would cost four.

**`zeroSignature(tag)`** is all zeros of the scheme's signature size behind the tag, "for a stand-in that is never verified": consensus uses it for the proposal it builds around a block fetched from peers ([chapter 4](04-consensus.md)), and a review test uses it to corrupt a transaction.

**`interface KeyPair`** holds `scheme`, `seed`, `publicKey`, `secretKey` and `address`:

```ts
export interface KeyPair {
  readonly scheme: SchemeTag;
  readonly seed: Uint8Array;
  /** Tagged. */
  readonly publicKey: Uint8Array;
  /** Tagged. */
  readonly secretKey: Uint8Array;
  /** sha256(publicKey), tag included. Keys are too big to use directly as identifiers. */
  readonly address: Uint8Array;
}
```

**`generateSeed(scheme)`** draws 32 bytes from `node:crypto`'s `randomBytes` until the scheme accepts them, which is at once for ML-DSA-44 and all but a vanishing fraction of the time for secp256k1. **`keyPairFromSeed(seed, scheme)`** derives everything else and tags the keys:

```ts
export function generateSeed(scheme: SchemeTag = DEFAULT_SCHEME): Uint8Array {
  for (;;) {
    const seed = new Uint8Array(randomBytes(SEED_SIZE));
    if (impl(scheme).validSeed(seed)) return seed;
  }
}

/** Key generation is deterministic from the seed, so only the seed is ever stored. */
export function keyPairFromSeed(seed: Uint8Array, scheme: SchemeTag = DEFAULT_SCHEME): KeyPair {
  if (seed.length !== SEED_SIZE) throw new Error(`seed must be ${SEED_SIZE} bytes`);
  const s = impl(scheme);
  const { publicKey, secretKey } = s.keygen(seed);
  const pk = tagged(s.tag, publicKey);
  return { scheme: s.tag, seed, publicKey: pk, secretKey: tagged(s.tag, secretKey), address: addressOf(pk) };
}
```

Key generation is deterministic from the seed under both schemes, so `DESIGN.md` section 5 rules "persist the 32-byte seed only. Derive the keypair at startup." That is visible in the node's configuration: `NodeConfig` in `src/node/node.ts` takes a `nodeKeySeed` for the p2p identity and an optional `validatorSeed` for the consensus key (`null` for a full node that does not vote), and the constructor derives both with `keyPairFromSeed(seed, scheme)`, where `scheme` is `schemeTag(cfg.genesis.signatureScheme ?? 'ml-dsa-44')`. The keystore in [chapter 14](14-wallet-cli.md) encrypts seeds, never expanded keys, and records each key's scheme beside the ciphertext. The test helper `seedFor(label)` in `test/helpers.ts` makes a seed as `sha256('seed:' + label)` so every test validator has a reproducible key, and `makeTestnet` derives validator and node seeds from the chain id and the node index and expands them with the testnet's scheme. One seed under the two schemes gives two unrelated key pairs with two different addresses, which `test/schemes.test.ts` checks.

**`addressOf(publicKey)`** is `sha256(publicKey)`, over the tagged key.

**`type SignPurpose = 'vote' | 'proposal' | 'tx' | 'p2p'`** enumerates the four domains, and **`signContext(chainId, purpose)`** builds the context:

```ts
export function signContext(chainId: string, purpose: SignPurpose): Uint8Array {
  const ctx = new TextEncoder().encode(`${chainId}/${purpose}`);
  if (ctx.length > 255) throw new Error('sign context too long');
  return ctx;
}
```

The 255-byte limit is FIPS 204's, and `secpDigest` leans on it to fit the length in one byte. A chain id of up to about 245 bytes fits. For a chain named `demo`, `signContext('demo', 'vote')` is the nine bytes `64656d6f2f766f7465`, the ASCII of `demo/vote`. Callers build the context once and keep it: `src/consensus/privval.ts` stores `voteCtx` and `proposalCtx` in its constructor, `src/p2p/network.ts` stores `p2pCtx`, and `src/app/core/app.ts` stores the `tx` context.

Who signs and who verifies, by purpose:

| purpose | signer | message | verifier |
|---|---|---|---|
| `vote` | `PrivValidator.signVote` in `src/consensus/privval.ts` | `voteSignBytes(chainId, vote)` | consensus on every received vote; `verifyDuplicateVoteEvidence` in `src/consensus/evidence.ts`; the light client on commits |
| `proposal` | `PrivValidator.signProposal` | `proposalSignBytes(chainId, proposal)` | consensus on every received proposal |
| `tx` | `signTransaction` in `src/app/core/client.ts` (the wallet side) | the transaction body | `CoreApp` in `src/app/core/app.ts`, at mempool admission and in blocks, after refusing any signature tagged with another scheme than the chain's |
| `p2p` | `Network` in `src/p2p/network.ts` during the handshake | `handshakeSignBytes` over both hello messages, each carrying a fresh nonce (`DESIGN.md` section 3) | the other side of the handshake |

One scheme serves all four rows on a given chain, but a validator's consensus key, a node's p2p identity key and a user's account keys are separate key pairs; the context only prevents one *signature* from being read in another role.

**`sign(msg, secretKey, context)`** reads the tag from the secret key, signs with that scheme and tags the signature:

```ts
/** Sign with the scheme the secret key is tagged with; the signature carries the same tag. */
export function sign(msg: Uint8Array, secretKey: Uint8Array, context: Uint8Array): Uint8Array {
  const s = impl(secretKey[0] ?? 0);
  if (secretKey.length !== 1 + s.secretKeySize) throw new Error('bad secret key size');
  return tagged(s.tag, s.sign(msg, secretKey.subarray(1), context));
}
```

There is no scheme argument: a secret key knows what it is. It is never called with a raw object; the message is always a dedicated sign-bytes encoding such as `voteSignBytes` or `proposalSignBytes` from [chapter 3](03-types.md), or a transaction body.

**`verify(sig, msg, publicKey, context)`** never throws, and refuses a mismatch before any work:

```ts
/** False for a signature of another scheme than the key, or of a size that is not the scheme's. */
export function verify(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array, context: Uint8Array): boolean {
  const scheme = schemeOf(publicKey);
  if (scheme === null || schemeOf(sig) !== scheme || !isPublicKey(publicKey) || !isSignature(sig)) return false;
  try {
    return impl(scheme).verify(sig.subarray(1), msg, publicKey.subarray(1), context);
  } catch {
    return false;
  }
}
```

The key's tag chooses the scheme. A signature tagged otherwise, an unknown tag, or a key or signature of the wrong size for its tag is `false` without a library being called, so a peer cannot make the node do work on garbage, nor pass a secp256k1 signature off against an ML-DSA-44 key. The `try/catch` turns any library exception on a malformed key or signature into "invalid"; a verifier that could throw would be a denial-of-service lever in a worker thread, where an uncaught exception kills the worker. Because the dispatch lives here, the verifier pool in the next file knows nothing about schemes, and a batch may even mix them.

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

Each `postMessage` copies the job arrays into the worker (a signature, a key, the message and the context: about 4 KB per ML-DSA-44 transaction, a few hundred bytes per secp256k1 one) and copies only booleans back. The copying is a real cost but far below the verification itself.

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

`test/units.test.ts`, `describe('keys and signatures')`, has three cases, all on a key derived from `seedFor('k')` with the default scheme, so under `CHAIN_SCHEME=secp256k1` the same three cases run on secp256k1.

**`signs deterministically and binds the context`** signs the same message twice and asserts the signatures are byte-identical, then checks that the signature verifies under its own context and fails under `signContext('c', 'vote')` (different purpose), `signContext('other', 'tx')` (different chain) and a different message. This is the domain-separation guarantee in four lines:

```ts
    expect(verify(s1, msg, kp.publicKey, ctx)).toBe(true);
    expect(verify(s1, msg, kp.publicKey, signContext('c', 'vote'))).toBe(false);
    expect(verify(s1, msg, kp.publicKey, signContext('other', 'tx'))).toBe(false);
    expect(verify(s1, new Uint8Array([0]), kp.publicKey, ctx)).toBe(false);
```

**`derives the same key from the same seed and addresses are hashes`** proves `keyPairFromSeed` is deterministic and that `addressOf` is `sha256` of the tagged public key.

**`verifies in worker threads`** builds a two-worker `WorkerVerifier`, makes five valid signatures, zeroes the first eight bytes of the third (its tag among them, so it is refused as a signature of no known scheme), and asserts the pool returns `[true, true, false, true, true]`. With two workers and five jobs the chunk size is three, so the batch is split across both workers and reassembled in order; the corrupted signature proves that a bad job yields `false` rather than an exception or a rejected batch. The pool is closed in a `finally`.

`test/schemes.test.ts` is the suite for the second scheme and the tags, five cases:

- **`signs and verifies under each scheme, with tagged keys and signatures that tell them apart`** loops over both schemes: the key pair reports its scheme, the public key and the signature start with the tag and are `publicKeySize` and `signatureSize` bytes long, the signature verifies under its context and fails under another purpose, another message and a flipped bit, signing twice gives identical bytes, and a key and a signature written with `fixed` come back through `decodePublicKey` and `decodeSignature`. Then one seed is expanded under both schemes: two different addresses, and neither key verifies the other's signature. `isPublicKey` refuses a truncated key, and the decoders throw `unknown signature scheme 9` and `unknown signature scheme 0` on tags nothing claims.
- **`refuses the high-S twin of a secp256k1 signature, so a signed object has one encoding`** takes a valid signature, replaces `s` with `n - s` using the curve order from noble, and asserts the original verifies and the twin does not.
- **`keeps each key's scheme in the keystore, and reads an old file as ML-DSA-44`** adds one key of each scheme to a keystore, reopens it and checks each comes back with its scheme; then deletes the `scheme` field from the file by hand, as a file written before there were two schemes lacks it, and checks the key reads as ML-DSA-44 ([chapter 14](14-wallet-cli.md)).
- **`refuses a genesis whose validator keys are not of the scheme it names`** calls `genesisState` with an ML-DSA-44 key under `signatureScheme: 'secp256k1'` and with a secp256k1 key under no scheme at all, expecting `/not a secp256k1 key/` and `/not a ml-dsa-44 key/`, and checks that the matching cases set `state.scheme` ([chapter 3](03-types.md)).
- **`runs on secp256k1 keys end to end and refuses keys and signatures of the other scheme`** starts a four-validator testnet with `scheme: Scheme.secp256k1`, waits for height 3, and checks the chain state's and the node key's scheme, that a stored commit holds 65-byte signatures, and that the RPC `status` reports `secp256k1`. It then creates an account with a secp256k1 key, and has the application refuse an ML-DSA-44 authority key (`must be a secp256k1 key`), an ML-DSA-44 consensus key in a `validatorCreate` (`consensus key must be a secp256k1 key`), and an ML-DSA-44 signature relabelled with a secp256k1 account's address (`signature of another scheme than the chain uses`, [chapter 11](11-application.md)).

`test/review.test.ts`, **`settles pending verifications when the worker pool closes`**, is the regression for review finding 40's second half. It builds a one-worker pool, submits a batch of 500 copies of one valid job (several hundred milliseconds of work for a single thread), attaches a `rejects.toThrow(/verifier closed/)` expectation *before* calling `close()`, so that the rejection is observed rather than unhandled, then closes the pool and awaits the expectation. Before the fix that promise never settled. Its neighbour, **`replaces a verification worker that dies, failing only the jobs it held`**, builds a one-worker pool, queues 300 `verifyOne` calls, then reaches into the pool and calls `terminate()` on the worker, which ends it with exit code 1. At least one of the pending promises rejects with `/exited/`, and a fresh `verifyOne` on the same pool resolves `true`: the replacement in the same slot answers it.

`test/network.test.ts`, **`delivers a message sent the instant a peer connects, while the other side is still verifying the handshake`**, wraps the inline verifier in a custom `Verifier` whose `verifyOne` sleeps 100 ms. It exists to reproduce review finding 33 (a frame arriving while the handshake signature was still in the pool was dropped), and it shows that the `Verifier` interface is the seam the network depends on: any object with `verify`, `verifyOne` and `close` will do.

Every other suite depends on this layer through the shared `InlineVerifier` in `test/helpers.ts` and through `keyPairFromSeed`, `sign` and `signContext`, which the engine, recovery and sync tests use to forge conflicting votes for evidence. `test/review.test.ts`, **`does not let a cached verification vouch for different signature bytes`**, replaces a valid signature with `zeroSignature(DEFAULT_SCHEME)` and checks the application rejects it on both a warm and a cold node (review finding 2). Its neighbour, **`accepts both valid signatures a key can make over one body, whichever was seen first`**, is ML-DSA-44 only: it strips the tag from the secret key, signs the body with noble's hedged signer and re-tags the result, a second valid signature the deterministic signer would never produce. It is declared with `it.skipIf(DEFAULT_SCHEME !== Scheme.mlDsa44)`, because under low-S secp256k1 there is no second valid signature to make, and it is the one test the suite skips under `CHAIN_SCHEME=secp256k1` (20 files; 137 tests under ML-DSA-44, 136 run and one skipped under secp256k1, all passing).

`bench/crypto.bench.ts` measures, for each scheme in turn, `keyPairFromSeed`, `sign`, inline `verify`, `WorkerVerifier.verify` over 256 signatures and the round trip of `verifyOne`, then `sha256` over 2.5 KB; it also prints the tagged sizes. On an Apple M4 Pro with 11 verification threads:

| benchmark | ML-DSA-44 | secp256k1 |
|---|---|---|
| public key / signature / secret key, tag included | 1313 / 2421 / 2561 B | 34 / 65 / 33 B |
| `keyPairFromSeed` | 1,400/s (714 µs) | 4,708/s (212 µs) |
| `sign`, 256-byte message | 504/s (1.98 ms) | 4,334/s (231 µs) |
| `verify`, inline | 1,144/s (874 µs) | 1,391/s (719 µs) |
| `WorkerVerifier.verify`, 256 signatures on 11 threads | 7,437/s (34.4 ms per 256) | 9,215/s (27.8 ms per 256) |
| `WorkerVerifier.verifyOne`, round trip | 916/s (1.09 ms) | 1,304/s (767 µs) |

`sha256` over 2.5 KB runs at 776,570 per second. Key generation and signing are where secp256k1 is an order of magnitude cheaper; verification, the operation the node performs by the thousand, is only about a fifth faster, because both schemes run in pure JavaScript. Through the pool that is 134 µs per ML-DSA-44 signature and 109 µs per secp256k1 one across 11 threads.

## Limitations and ideas

Known simplifications:

- A batch on a worker that dies is rejected, not retried; the caller must resubmit.
- Jobs are copied to workers by structured clone; there is no transfer of ownership and no shared memory.
- `bytesEqual` is not constant-time. That is fine for the values it compares today; it would not be fine for comparing secrets.
- A `Node` constructed without a `verifier` uses `InlineVerifier` (`src/node/node.ts`), which `DESIGN.md` section 10 lists as a known simplification; the CLI, localnet and benchmarks pass a `WorkerVerifier`.
- Signing is synchronous and in pure JavaScript, about 2 ms per ML-DSA-44 signature and about 0.2 ms per secp256k1 one; a validator signs at most a few times per block, so this is acceptable, but a wallet signing thousands of ML-DSA-44 transactions would notice.
- A chain's scheme is fixed by its genesis. There is no migration from one scheme to the other on a running chain, and no chain accepts both at once: the tag is a dispatch byte, not a negotiation.
- secp256k1 verification is pure JavaScript, like ML-DSA-44's, and nearly as slow. A native binding would make the classical scheme far cheaper to check, as it is on most chains; nothing here uses one.

Exercises:

1. Write the test that review finding 40 did not: kill a worker from inside a job (a job whose `msg` is a sentinel that makes the worker call `process.exit(1)`), and assert that only that batch rejects, that the pool still has its size, and that a batch submitted afterwards succeeds on the replacement.
2. Make `verify` retry a chunk once on the replacement worker when its first attempt is rejected by a worker death, and argue whether a retry can ever change the answer for a signature.
3. Measure the structured-clone overhead: time `verify` on 256 jobs through the pool against 256 inline verifications divided by the thread count. Then try passing the job buffers as transferables and see what changes.
4. Add a `SignPurpose` for a new message type (say `'snapshot'`) and trace every place a context is built to see what would have to change. Note that nothing stops two purposes from using the same string; make `signContext` reject unknown purposes at runtime.
5. Add ML-DSA-65 as a third scheme (noble exports `ml_dsa65`): a tag, a `SchemeImpl` entry with its sizes, a name. Run the suite under `CHAIN_SCHEME=ml-dsa-65` and find the tests and fixtures that assume one of the two existing sizes.
6. Write a constant-time `bytesEqual` and benchmark it against the current one over 32-byte inputs.

## Where to next

[Chapter 3](03-types.md) uses these primitives to define what a validator set, a vote, a block, a commit, evidence, a proposal and the chain state are, and how each is encoded and hashed.
