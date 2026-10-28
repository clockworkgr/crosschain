/**
 * Signatures: ML-DSA-44 (FIPS 204, NIST level 2), post-quantum.
 *
 * One scheme is used everywhere: validator votes and proposals, transactions,
 * and p2p node identity. Sizes are large compared to classical schemes
 * (public key 1312 B, signature 2420 B) and verification costs about a
 * millisecond in pure JavaScript, which is why verification goes through a
 * worker pool (see verifier.ts).
 */
import { randomBytes } from 'node:crypto';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { sha256 } from './hash.ts';

export const SEED_SIZE = 32;
export const PUBLIC_KEY_SIZE = 1312;
export const SECRET_KEY_SIZE = 2560;
export const SIGNATURE_SIZE = 2420;
export const ADDRESS_SIZE = 32;

export interface KeyPair {
  readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
  /** sha256(publicKey). Keys are too big to use directly as identifiers. */
  readonly address: Uint8Array;
}

export function generateSeed(): Uint8Array {
  return new Uint8Array(randomBytes(SEED_SIZE));
}

/** Key generation is deterministic from the seed, so only the seed is ever stored. */
export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== SEED_SIZE) throw new Error(`seed must be ${SEED_SIZE} bytes`);
  const { publicKey, secretKey } = ml_dsa44.keygen(seed);
  return { seed, publicKey, secretKey, address: addressOf(publicKey) };
}

export function addressOf(publicKey: Uint8Array): Uint8Array {
  return sha256(publicKey);
}

export type SignPurpose = 'vote' | 'proposal' | 'tx' | 'p2p';

/**
 * ML-DSA takes a context string (max 255 bytes) that is bound into the
 * signature. Using "<chainId>/<purpose>" means a vote signature can never be
 * replayed as a transaction, or on another chain, without any manual
 * message prefixing.
 */
export function signContext(chainId: string, purpose: SignPurpose): Uint8Array {
  const ctx = new TextEncoder().encode(`${chainId}/${purpose}`);
  if (ctx.length > 255) throw new Error('sign context too long');
  return ctx;
}

/**
 * Deterministic signing (no extra entropy): the same message signed twice
 * yields identical bytes, so every signed object has exactly one hash.
 */
export function sign(msg: Uint8Array, secretKey: Uint8Array, context: Uint8Array): Uint8Array {
  return ml_dsa44.sign(msg, secretKey, { context, extraEntropy: false });
}

export function verify(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array, context: Uint8Array): boolean {
  if (sig.length !== SIGNATURE_SIZE || publicKey.length !== PUBLIC_KEY_SIZE) return false;
  try {
    return ml_dsa44.verify(sig, msg, publicKey, { context });
  } catch {
    return false;
  }
}
