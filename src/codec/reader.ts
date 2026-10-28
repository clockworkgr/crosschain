/**
 * Binary decoding, mirroring Writer. Every read is bounds-checked so a
 * malicious peer cannot make us allocate or read past the buffer.
 */
export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

export class Reader {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private pos: number;

  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
  }

  remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (n > this.remaining()) throw new CodecError(`need ${n} bytes, have ${this.remaining()}`);
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new CodecError(`bad bool ${v}`);
    return v === 1;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos);
    this.pos += 8;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos);
    this.pos += 8;
    return v;
  }

  fixed(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  bytes(maxLen = 64 * 1024 * 1024): Uint8Array {
    const n = this.u32();
    if (n > maxLen) throw new CodecError(`bytes too long: ${n} > ${maxLen}`);
    return this.fixed(n);
  }

  string(maxLen = 1024 * 1024): string {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.bytes(maxLen));
  }

  option<T>(f: (r: Reader) => T): T | null {
    const flag = this.u8();
    if (flag === 0) return null;
    if (flag !== 1) throw new CodecError(`bad option flag ${flag}`);
    return f(this);
  }

  array<T>(f: (r: Reader) => T, maxCount = 1_000_000): T[] {
    const n = this.u32();
    if (n > maxCount) throw new CodecError(`array too long: ${n} > ${maxCount}`);
    // Each element needs at least one byte, which bounds allocation by input size.
    if (n > this.remaining()) throw new CodecError(`array count ${n} exceeds remaining bytes`);
    const out: T[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = f(this);
    return out;
  }

  /** Assert that the whole buffer was consumed. Trailing garbage is an error. */
  finish(): void {
    if (this.remaining() !== 0) throw new CodecError(`${this.remaining()} trailing bytes`);
  }
}

/** Convenience: decode a whole buffer and insist nothing is left over. */
export function decode<T>(buf: Uint8Array, f: (r: Reader) => T): T {
  const r = new Reader(buf);
  const v = f(r);
  r.finish();
  return v;
}
