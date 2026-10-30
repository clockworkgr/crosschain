/**
 * Signatures: two schemes, one per chain.
 *
 *   ML-DSA-44   FIPS 204, NIST level 2, post-quantum. Public key 1312 B,
 *               signature 2420 B, about a millisecond to verify in pure
 *               JavaScript, which is why verification goes through a worker
 *               pool (see verifier.ts).
 *   secp256k1   ECDSA over the Bitcoin curve, RFC 6979 deterministic, low-S
 *               signatures only (a high-S twin of a valid signature is
 *               refused, so a signed object has exactly one encoding).
 *               Public key 33 B compressed, signature 64 B compact.
 *
 * Genesis names the chain's scheme. Every public key, secret key and signature
 * carries a one-byte scheme tag in front of its raw bytes, so a decoder knows
 * the size that follows and a verifier knows which scheme to run; the chain
 * refuses the other scheme wherever a key or a signature enters it (genesis,
 * validator sets and their updates, account authorities, transactions). One
 * scheme serves validator votes and proposals, transactions and p2p identity.
 */
import { randomBytes } from 'node:crypto';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { CodecError, type Reader } from '../codec/reader.ts';
import { sha256 } from './hash.ts';

export const SEED_SIZE = 32;
export const ADDRESS_SIZE = 32;

export const Scheme = { mlDsa44: 1, secp256k1: 2 } as const;
export type SchemeTag = (typeof Scheme)[keyof typeof Scheme];
export type SchemeName = 'ml-dsa-44' | 'secp256k1';
export const SCHEME_NAMES: readonly SchemeName[] = ['ml-dsa-44', 'secp256k1'];

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

const SCHEMES: Record<SchemeTag, SchemeImpl> = { [Scheme.mlDsa44]: mlDsa44, [Scheme.secp256k1]: secp };

function impl(tag: number): SchemeImpl {
  const s = SCHEMES[tag as SchemeTag];
  if (!s) throw new Error(`unknown signature scheme ${tag}`);
  return s;
}

export function schemeTag(name: string): SchemeTag {
  for (const s of Object.values(SCHEMES)) if (s.name === name) return s.tag;
  throw new Error(`unknown signature scheme "${name}"; one of ${SCHEME_NAMES.join(', ')}`);
}

export function schemeName(tag: SchemeTag): SchemeName {
  return impl(tag).name;
}

/**
 * The scheme keyPairFromSeed and generateSeed use when none is given: ML-DSA-44,
 * or CHAIN_SCHEME from the environment, so the whole test suite and the local
 * network can run under either scheme. A node always passes its genesis scheme.
 */
export const DEFAULT_SCHEME: SchemeTag = process.env.CHAIN_SCHEME ? schemeTag(process.env.CHAIN_SCHEME) : Scheme.mlDsa44;

/** Tagged sizes: the tag byte plus the raw key or signature. */
export function publicKeySize(tag: SchemeTag): number {
  return 1 + impl(tag).publicKeySize;
}

export function signatureSize(tag: SchemeTag): number {
  return 1 + impl(tag).signatureSize;
}

export const MAX_PUBLIC_KEY_SIZE = 1 + mlDsa44.publicKeySize;
export const MAX_SIGNATURE_SIZE = 1 + mlDsa44.signatureSize;

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

/** All zero bytes of a scheme's signature size, for a stand-in that is never verified. */
export function zeroSignature(tag: SchemeTag): Uint8Array {
  return tagged(tag, new Uint8Array(impl(tag).signatureSize));
}

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

export function addressOf(publicKey: Uint8Array): Uint8Array {
  return sha256(publicKey);
}

export type SignPurpose = 'vote' | 'proposal' | 'tx' | 'p2p';

/**
 * A context string (max 255 bytes) bound into every signature: ML-DSA takes
 * it natively, ECDSA gets it hashed in ahead of the message. Using
 * "<chainId>/<purpose>" means a vote signature can never be replayed as a
 * transaction, or on another chain, without any manual message prefixing.
 */
export function signContext(chainId: string, purpose: SignPurpose): Uint8Array {
  const ctx = new TextEncoder().encode(`${chainId}/${purpose}`);
  if (ctx.length > 255) throw new Error('sign context too long');
  return ctx;
}

/** Sign with the scheme the secret key is tagged with; the signature carries the same tag. */
export function sign(msg: Uint8Array, secretKey: Uint8Array, context: Uint8Array): Uint8Array {
  const s = impl(secretKey[0] ?? 0);
  if (secretKey.length !== 1 + s.secretKeySize) throw new Error('bad secret key size');
  return tagged(s.tag, s.sign(msg, secretKey.subarray(1), context));
}

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
