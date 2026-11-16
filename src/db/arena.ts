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
 * is counted dead, and after a root a slab with nothing live left is released
 * outright, and one that is more than half dead is compacted by copying its
 * live entries into the current slab and releasing it. The header is what
 * makes compaction possible: it names the owner, which says whether the entry
 * is still its current value.
 *
 * A released slab's number is given to the next slab, with its generation
 * counted up, so slab numbers stay as few as the slabs alive at once and a
 * reference stays exact: 24 bits of offset (a slab is at most 16 MiB), 16 of
 * slot and 13 of generation make 53, all a double holds without rounding. The
 * generation is what refuses a stale reference into a slot used again; it
 * wraps after 8,192 reuses of one slot, which is harmless because the owner
 * never keeps a reference into a released slab (compaction moves them all).
 *
 * The arena is a cache when the owner has a store behind it (STATE-PAGING.md
 * section 3.4): shrink() releases whole slabs until the arena is within a
 * byte limit, telling the owner of every live entry in them that its bytes
 * are now only in the store. Which slab goes is CLOCK again, a bit per slab
 * set by every read: a slab nothing has read since the last pass goes first.
 * The slabs are ArrayBuffers, outside V8's heap, so the limit is the owner's
 * to set in bytes; the memory guard, which watches the heap, does not see them.
 */
export const HEADER = 10;
const FIRST_SLAB = 256 * 1024;
const MAX_SLAB = 16 * 1024 * 1024;
/** The largest encoding an entry can hold. */
export const MAX_ENTRY = MAX_SLAB - HEADER;
/** A reference: (generation * SLOTS + slot) * OFFSETS + offset, below 2^53 so it is exact. */
const OFFSETS = 2 ** 24;
const SLOTS = 2 ** 16;
const GENERATIONS = 2 ** 13;
const SLAB_IDS = SLOTS * GENERATIONS;
/** Whatever a root wrote, compaction may copy at least this much after it: what two half-dead full slabs hold. */
const MIN_COPY = MAX_SLAB;

/** Who holds references: asked whether an entry is still current, and told where it moved. */
export interface ArenaOwner {
  refOf(type: number, instance: number): number;
  relocate(type: number, instance: number, ref: number): void;
  /** The slab holding an entry's bytes was released by shrink(): they are now only in the owner's store. */
  released(type: number, instance: number): void;
}

interface Slab {
  /** Null once the slab has been released; the slot then waits in the free list for the next slab. */
  buf: Uint8Array | null;
  used: number;
  dead: number;
  /** Counted up each time the slot is given a new slab, so a reference into an older one is refused. */
  generation: number;
  /** Read since shrink() last passed over it. */
  touched: boolean;
}

/** A reference from a slab number (its generation and slot, generation * 2^16 + slot) and an offset; refused if either does not fit. */
export function packRef(slab: number, offset: number): number {
  if (!(slab >= 0 && slab < SLAB_IDS && offset >= 0 && offset < OFFSETS)) throw new RangeError(`slab ${slab}, offset ${offset}: not a reference`);
  return slab * OFFSETS + offset;
}
export const slabOf = (ref: number): number => Math.floor(ref / OFFSETS);
export const offsetOf = (ref: number): number => ref % OFFSETS;

export interface ArenaStats {
  /** Slabs holding bytes, their capacity, the bytes written into them, and the bytes among those that are dead. */
  slabs: number;
  capacity: number;
  used: number;
  dead: number;
}

export class Arena {
  private readonly slabs: Slab[] = [];
  /** Slots whose slab was released, for the next slabs to take. */
  private readonly spare: number[] = [];
  private current = -1;
  private created = 0;
  /** Bytes alloc() wrote since the last maintain(), compaction's own copies not counted: what the root's block wrote. */
  private written = 0;
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
    const slot = this.spare.pop();
    if (slot !== undefined) {
      const s = this.slabs[slot]!;
      s.buf = new Uint8Array(size);
      s.generation = (s.generation + 1) % GENERATIONS;
      s.touched = false;
      this.current = slot;
      return;
    }
    if (this.slabs.length >= SLOTS) throw new RangeError(`the arena holds at most ${SLOTS} slabs at once`);
    this.slabs.push({ buf: new Uint8Array(size), used: 0, dead: 0, generation: 0, touched: false });
    this.current = this.slabs.length - 1;
  }

  private refAt(slot: number, offset: number): number {
    return packRef(this.slabs[slot]!.generation * SLOTS + slot, offset);
  }

  private slabFor(ref: number): Slab | undefined {
    const id = slabOf(ref);
    const slab = this.slabs[id % SLOTS];
    return slab && slab.generation === Math.floor(id / SLOTS) ? slab : undefined;
  }

  private release(slot: number): number {
    const slab = this.slabs[slot]!;
    const size = slab.buf!.length;
    slab.buf = null;
    slab.used = 0;
    slab.dead = 0;
    this.spare.push(slot);
    return size;
  }

  /** Store an encoding; returns its reference. */
  alloc(type: number, instance: number, bytes: Uint8Array): number {
    this.written += HEADER + bytes.length;
    return this.put(type, instance, bytes);
  }

  private put(type: number, instance: number, bytes: Uint8Array): number {
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
    return this.refAt(this.current, at);
  }

  private header(ref: number): { buf: Uint8Array; at: number; type: number; instance: number; length: number } {
    const slab = this.slabFor(ref);
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
    this.slabs[slabOf(ref) % SLOTS]!.touched = true;
    return h.buf.subarray(h.at + HEADER, h.at + HEADER + h.length);
  }

  /** Count an entry dead; its bytes are reclaimed by compaction. */
  free(ref: number): void {
    const length = this.header(ref).length;
    this.slabFor(ref)!.dead += HEADER + length;
  }

  /**
   * After a root: release every slab with nothing live left, which costs no copying however many there are, and
   * compact slabs that are more than half dead, copying their live entries into the current slab and telling the
   * owner where they went. No further slab is started once the bytes copied have reached what alloc() wrote since
   * the last call (at least MIN_COPY); a slab that was started is finished, so a call can copy up to the live half
   * of one slab (under 8 MiB) more than that. Each compacted slab gives back more than it copies, so reclaiming
   * keeps pace with any rate of writes and a backlog drains, while the pause stays in proportion to the block's
   * own writes. Returns the bytes released.
   */
  maintain(): number {
    let released = 0;
    for (let s = 0; s < this.slabs.length; s++) {
      const slab = this.slabs[s]!;
      if (s !== this.current && slab.buf && slab.used > 0 && slab.dead >= slab.used) released += this.release(s);
    }
    const budget = Math.max(MIN_COPY, this.written);
    let copied = 0;
    for (let s = 0; s < this.slabs.length && copied < budget; s++) {
      const slab = this.slabs[s]!;
      if (s === this.current || !slab.buf || slab.used === 0 || slab.dead * 2 <= slab.used) continue;
      const buf = slab.buf;
      for (let at = 0; at < slab.used; ) {
        const ref = this.refAt(s, at);
        const h = this.header(ref);
        if (this.owner.refOf(h.type, h.instance) === ref) {
          const moved = this.put(h.type, h.instance, buf.subarray(at + HEADER, at + HEADER + h.length));
          this.owner.relocate(h.type, h.instance, moved);
          copied += HEADER + h.length;
        }
        at += HEADER + h.length;
      }
      released += this.release(s);
    }
    this.written = 0;
    return released;
  }

  /**
   * Release whole slabs until the arena's capacity is within `limit` bytes, never the current one (so the least it
   * comes down to is that slab, 16 MiB at most). Each live entry of a released slab is handed to the owner as
   * released: the caller must know that its store holds every committed encoding. Slabs nothing has read since the
   * last call go first, in slot order; the others lose their mark and go on a second pass if the first was not
   * enough. Returns the bytes released.
   */
  shrink(limit: number): number {
    let capacity = 0;
    for (const s of this.slabs) if (s.buf) capacity += s.buf.length;
    let released = 0;
    for (let pass = 0; pass < 2 && capacity > limit; pass++) {
      for (let s = 0; s < this.slabs.length && capacity > limit; s++) {
        const slab = this.slabs[s]!;
        if (s === this.current || !slab.buf) continue;
        if (pass === 0 && slab.touched) {
          slab.touched = false;
          continue;
        }
        for (let at = 0; at < slab.used; ) {
          const h = this.header(this.refAt(s, at));
          if (this.owner.refOf(h.type, h.instance) === this.refAt(s, at)) this.owner.released(h.type, h.instance);
          at += HEADER + h.length;
        }
        const size = this.release(s);
        capacity -= size;
        released += size;
      }
    }
    return released;
  }
}
