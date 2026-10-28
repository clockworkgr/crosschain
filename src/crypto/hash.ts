import { createHash } from 'node:crypto';

export const HASH_SIZE = 32;
export const ZERO_HASH: Uint8Array = new Uint8Array(HASH_SIZE);

/**
 * SHA-256. Grover's algorithm halves its preimage strength to 128 bits under
 * a quantum adversary, which is still ample, so no change from the classical
 * choice is needed here.
 */
export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error(`bad hex: ${s}`);
  return new Uint8Array(Buffer.from(s, 'hex'));
}

export function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Lexicographic comparison, like memcmp. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
