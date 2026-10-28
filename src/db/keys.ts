/**
 * Secondary index keys are byte strings whose lexicographic order is the
 * order we want to scan in. That one rule lets every index, whatever its
 * shape, live in the same ordered map (bptree.ts): "balances of account
 * 7" is the prefix [7], "accounts by name" is the name itself, and a
 * compound key is just the parts written one after another.
 *
 * Integers are big-endian so they sort numerically. Strings end with a zero
 * byte instead of carrying a length prefix, so "ab" sorts before "abc" and a
 * prefix scan on "ab" finds both; a zero byte inside a string is therefore
 * rejected.
 */
import { Writer } from '../codec/writer.ts';

export class KeyWriter {
  private readonly w = new Writer(32);

  u8(v: number): this {
    this.w.u8(v);
    return this;
  }
  u16(v: number): this {
    this.w.u16(v);
    return this;
  }
  u32(v: number): this {
    this.w.u32(v);
    return this;
  }
  u64(v: bigint): this {
    this.w.u64(v);
    return this;
  }
  /** An object id, which is a u64. */
  id(v: bigint): this {
    return this.u64(v);
  }
  fixed(b: Uint8Array): this {
    this.w.fixed(b);
    return this;
  }
  str(s: string): this {
    const b = new TextEncoder().encode(s);
    for (const x of b) if (x === 0) throw new RangeError('index key strings cannot contain a zero byte');
    this.w.fixed(b).u8(0);
    return this;
  }
  finish(): Uint8Array {
    return this.w.finish();
  }
}

export function key(f: (k: KeyWriter) => void): Uint8Array {
  const k = new KeyWriter();
  f(k);
  return k.finish();
}

export function startsWith(b: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > b.length) return false;
  for (let i = 0; i < prefix.length; i++) if (b[i] !== prefix[i]) return false;
  return true;
}
