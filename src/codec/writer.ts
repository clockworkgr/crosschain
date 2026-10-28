/**
 * Binary encoding primitives.
 *
 * Everything that is hashed, signed, or sent over the wire goes through this
 * writer, so every object has exactly one byte representation. JSON is
 * deliberately not used for anything consensus-critical: key order, number
 * formatting and BigInt all make it non-canonical.
 *
 * Layout rules (big-endian everywhere):
 *   u8          1 byte
 *   u16         2 bytes
 *   u32         4 bytes
 *   u64 / i64   8 bytes (BigInt; i64 is two's complement)
 *   bool        1 byte, 0 or 1
 *   fixed(n)    raw bytes, no prefix (both sides know the length)
 *   bytes       u32 length prefix + raw bytes
 *   string      u32 length prefix + utf-8 bytes
 *   option(x)   u8 flag (0 absent, 1 present) then x
 *   array(xs)   u32 count then the elements
 */
export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`u8 out of range: ${v}`);
    this.ensure(1);
    this.buf[this.len++] = v;
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  u16(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
    this.ensure(2);
    this.view.setUint16(this.len, v);
    this.len += 2;
    return this;
  }

  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`u32 out of range: ${v}`);
    this.ensure(4);
    this.view.setUint32(this.len, v);
    this.len += 4;
    return this;
  }

  u64(v: bigint): this {
    if (v < 0n || v > 0xffffffffffffffffn) throw new RangeError(`u64 out of range: ${v}`);
    this.ensure(8);
    this.view.setBigUint64(this.len, v);
    this.len += 8;
    return this;
  }

  i64(v: bigint): this {
    if (v < -(1n << 63n) || v >= 1n << 63n) throw new RangeError(`i64 out of range: ${v}`);
    this.ensure(8);
    this.view.setBigInt64(this.len, v);
    this.len += 8;
    return this;
  }

  /** Raw bytes with no length prefix. The reader must know the length. */
  fixed(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** Length-prefixed bytes. */
  bytes(b: Uint8Array): this {
    this.u32(b.length);
    return this.fixed(b);
  }

  string(s: string): this {
    // A lone surrogate would be written as U+FFFD, so two different strings would share an encoding.
    if (/\p{Surrogate}/u.test(s)) throw new RangeError('string is not well-formed UTF-16');
    return this.bytes(new TextEncoder().encode(s));
  }

  option<T>(v: T | null, f: (w: Writer, v: T) => void): this {
    if (v === null) return this.u8(0);
    this.u8(1);
    f(this, v);
    return this;
  }

  array<T>(xs: readonly T[], f: (w: Writer, x: T) => void): this {
    this.u32(xs.length);
    for (const x of xs) f(this, x);
    return this;
  }

  /** Returns a copy of the bytes written so far. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Convenience: run an encoding function and return the bytes. */
export function encode(f: (w: Writer) => void): Uint8Array {
  const w = new Writer();
  f(w);
  return w.finish();
}
