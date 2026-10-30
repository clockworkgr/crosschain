/**
 * A log-structured arena for the encoded objects of the database
 * (STATE-PAGING.md section 3). Objects are kept as their canonical bytes,
 * packed into a few large slabs, instead of as decoded JavaScript objects:
 * an account under secp256k1 is 117 bytes encoded and about a kilobyte
 * decoded, and the difference is most of what the heap held per account.
 *
 * Every entry is a 10-byte header (type, instance, length) followed by the
 * encoding; a reference is the slab number and the offset of the header,
 * packed into one number. Slabs are filled by a bump allocator and never
 * written in place: a new encoding of an object is a new entry, the old one
 * is counted dead, and a slab that is more than half dead is compacted after
 * a root by copying its live entries into the current slab and releasing it.
 * The header is what makes compaction possible: it names the owner, which
 * says whether the entry is still its current value.
 */
export const HEADER = 10;
const FIRST_SLAB = 256 * 1024;
const MAX_SLAB = 16 * 1024 * 1024;
/** The largest encoding an entry can hold. */
export const MAX_ENTRY = MAX_SLAB - HEADER;
const SLAB_SHIFT = 2 ** 32;

/** Who holds references: asked whether an entry is still current, and told where it moved. */
export interface ArenaOwner {
  refOf(type: number, instance: number): number;
  relocate(type: number, instance: number, ref: number): void;
}

interface Slab {
  /** Null once the slab has been compacted away; its number stays taken so older references never alias. */
  buf: Uint8Array | null;
  used: number;
  dead: number;
}

export const packRef = (slab: number, offset: number): number => slab * SLAB_SHIFT + offset;
export const slabOf = (ref: number): number => Math.floor(ref / SLAB_SHIFT);
export const offsetOf = (ref: number): number => ref % SLAB_SHIFT;

export interface ArenaStats {
  /** Slabs holding bytes, their capacity, the bytes written into them, and the bytes among those that are dead. */
  slabs: number;
  capacity: number;
  used: number;
  dead: number;
}

export class Arena {
  private readonly slabs: Slab[] = [];
  private current = -1;
  private created = 0;
  private readonly owner: ArenaOwner;

  constructor(owner: ArenaOwner) {
    this.owner = owner;
  }

  get stats(): ArenaStats {
    let slabs = 0;
    let capacity = 0;
    let used = 0;
    let dead = 0;
    for (const s of this.slabs) {
      if (!s.buf) continue;
      slabs++;
      capacity += s.buf.length;
      used += s.used;
      dead += s.dead;
    }
    return { slabs, capacity, used, dead };
  }

  private newSlab(need: number): void {
    // The first slab is small so a tiny database costs little; each next doubles up to the maximum.
    const size = Math.max(need, Math.min(MAX_SLAB, FIRST_SLAB * 2 ** this.created));
    this.created++;
    this.slabs.push({ buf: new Uint8Array(size), used: 0, dead: 0 });
    this.current = this.slabs.length - 1;
  }

  /** Store an encoding; returns its reference. */
  alloc(type: number, instance: number, bytes: Uint8Array): number {
    if (bytes.length > MAX_ENTRY) throw new RangeError(`an encoding of ${bytes.length} bytes does not fit the arena (at most ${MAX_ENTRY})`);
    const need = HEADER + bytes.length;
    if (this.current < 0 || this.slabs[this.current]!.used + need > this.slabs[this.current]!.buf!.length) this.newSlab(need);
    const slab = this.slabs[this.current]!;
    const buf = slab.buf!;
    const at = slab.used;
    buf[at] = type >>> 8;
    buf[at + 1] = type & 0xff;
    buf[at + 2] = instance >>> 24;
    buf[at + 3] = (instance >>> 16) & 0xff;
    buf[at + 4] = (instance >>> 8) & 0xff;
    buf[at + 5] = instance & 0xff;
    buf[at + 6] = bytes.length >>> 24;
    buf[at + 7] = (bytes.length >>> 16) & 0xff;
    buf[at + 8] = (bytes.length >>> 8) & 0xff;
    buf[at + 9] = bytes.length & 0xff;
    buf.set(bytes, at + HEADER);
    slab.used += need;
    return packRef(this.current, at);
  }

  private header(ref: number): { buf: Uint8Array; at: number; type: number; instance: number; length: number } {
    const slab = this.slabs[slabOf(ref)];
    if (!slab?.buf) throw new RangeError('reference into a released slab');
    const buf = slab.buf;
    const at = offsetOf(ref);
    const type = (buf[at]! << 8) | buf[at + 1]!;
    const instance = ((buf[at + 2]! << 24) | (buf[at + 3]! << 16) | (buf[at + 4]! << 8) | buf[at + 5]!) >>> 0;
    const length = ((buf[at + 6]! << 24) | (buf[at + 7]! << 16) | (buf[at + 8]! << 8) | buf[at + 9]!) >>> 0;
    return { buf, at, type, instance, length };
  }

  /** The encoding an entry holds: a view into the slab, valid until the next compaction. */
  read(ref: number): Uint8Array {
    const h = this.header(ref);
    return h.buf.subarray(h.at + HEADER, h.at + HEADER + h.length);
  }

  /** Count an entry dead; its bytes are reclaimed by compaction. */
  free(ref: number): void {
    const slab = this.slabs[slabOf(ref)]!;
    slab.dead += HEADER + this.header(ref).length;
  }

  /**
   * Compact up to `maxSlabs` slabs that are more than half dead, copying their live entries
   * into the current slab and telling the owner where they went. Returns the bytes released.
   */
  maintain(maxSlabs = 2): number {
    let released = 0;
    let done = 0;
    for (let s = 0; s < this.slabs.length && done < maxSlabs; s++) {
      const slab = this.slabs[s]!;
      if (s === this.current || !slab.buf || slab.used === 0 || slab.dead * 2 <= slab.used) continue;
      const buf = slab.buf;
      for (let at = 0; at < slab.used; ) {
        const h = this.header(packRef(s, at));
        if (this.owner.refOf(h.type, h.instance) === packRef(s, at)) {
          const moved = this.alloc(h.type, h.instance, buf.subarray(at + HEADER, at + HEADER + h.length));
          this.owner.relocate(h.type, h.instance, moved);
        }
        at += HEADER + h.length;
      }
      released += buf.length;
      slab.buf = null;
      slab.used = 0;
      slab.dead = 0;
      done++;
    }
    return released;
  }
}
