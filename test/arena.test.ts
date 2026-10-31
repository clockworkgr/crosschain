import { describe, expect, it } from 'vitest';
import { Arena, HEADER, MAX_ENTRY, packRef, slabOf, type ArenaOwner } from '../src/db/arena.ts';

/** An owner holding one reference per (type, instance). */
function owner(): ArenaOwner & { refs: Map<string, number> } {
  const refs = new Map<string, number>();
  return {
    refs,
    refOf: (type, instance) => refs.get(`${type}/${instance}`) ?? -1,
    relocate: (type, instance, ref) => void refs.set(`${type}/${instance}`, ref),
  };
}

const bytesOf = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe('arena', () => {
  it('stores encodings across growing slabs and reads them back', () => {
    const o = owner();
    const a = new Arena(o);
    const sizes = [1, 100, 1000, 100_000, 300_000, 5];
    sizes.forEach((n, i) => o.refs.set(`1/${i}`, a.alloc(1, i, bytesOf(n, i + 1))));
    sizes.forEach((n, i) => {
      const got = a.read(o.refs.get(`1/${i}`)!);
      expect(got.length).toBe(n);
      expect(got[0]).toBe(i + 1);
      expect(got[n - 1]).toBe(i + 1);
    });
    // 256 KiB first, then 512 KiB: the 300,000-byte entry needed a second slab.
    const s = a.stats;
    expect(s.slabs).toBe(2);
    expect(s.used).toBe(sizes.reduce((t, n) => t + n + HEADER, 0));
    expect(s.dead).toBe(0);
    expect(slabOf(o.refs.get('1/4')!)).toBe(1);
    expect(() => a.alloc(1, 9, new Uint8Array(MAX_ENTRY + 1))).toThrow(/does not fit/);
    expect(() => a.read(packRef(7, 0))).toThrow(/released/);
  });

  it('counts freed entries dead and compacts a slab that is more than half dead, moving the live ones', () => {
    const o = owner();
    const a = new Arena(o);
    // Fill the first slab (256 KiB) with 100-byte entries, then free most of them.
    const n = Math.floor((256 * 1024) / (100 + HEADER));
    for (let i = 0; i < n; i++) o.refs.set(`2/${i}`, a.alloc(2, i, bytesOf(100, (i % 250) + 1)));
    expect(a.stats.slabs).toBe(1);
    for (let i = 0; i < n; i++) {
      if (i % 4 === 0) continue; // every fourth stays
      a.free(o.refs.get(`2/${i}`)!);
      o.refs.delete(`2/${i}`);
    }
    expect(a.stats.dead).toBe((n - Math.ceil(n / 4)) * (100 + HEADER));
    // Nothing happens while the slab is the current one; a new slab makes it compactable.
    expect(a.maintain()).toBe(0);
    o.refs.set('3/0', a.alloc(3, 0, bytesOf(256 * 1024, 9))); // forces a second slab
    const before = new Map([...o.refs].filter(([k]) => k.startsWith('2/')).map(([k, ref]) => [k, Buffer.from(a.read(ref)).toString('hex')]));
    const released = a.maintain();
    expect(released).toBe(256 * 1024);
    // The live entries fit beside the big one in the current slab, so one slab holds everything now.
    expect(a.stats.slabs).toBe(1);
    for (const [k, hex] of before) {
      expect(slabOf(o.refs.get(k)!)).toBe(1);
      expect(Buffer.from(a.read(o.refs.get(k)!)).toString('hex')).toBe(hex);
    }
    expect(() => a.read(packRef(0, 0))).toThrow(/released/);
    // The next slab takes the released slab's slot with a new generation, so the stale reference stays refused.
    o.refs.set('5/0', a.alloc(5, 0, bytesOf(MAX_ENTRY, 1)));
    expect(slabOf(o.refs.get('5/0')!)).toBe(2 ** 16);
    expect(() => a.read(packRef(0, 0))).toThrow(/released/);
  });
});

describe('arena reclamation', () => {
  it('releases every fully dead slab at a root without copying from it, however many there are', () => {
    const o = owner();
    let asked = 0;
    const counting: ArenaOwner = { refOf: (t, i) => (asked++, o.refOf(t, i)), relocate: o.relocate };
    const a = new Arena(counting);
    // Entries that fill a slab each: three objects rewritten at every root leave three slabs wholly dead.
    const big = bytesOf(MAX_ENTRY, 7);
    for (let root = 0; root < 8; root++) {
      for (let i = 0; i < 3; i++) {
        const old = o.refs.get(`1/${i}`);
        if (old !== undefined) a.free(old);
        o.refs.set(`1/${i}`, a.alloc(1, i, big));
      }
      asked = 0;
      a.maintain();
      // Nothing in a dead slab is live, so its entries are not even looked at.
      expect(asked).toBe(0);
      expect(a.stats.slabs).toBeLessThanOrEqual(root === 0 ? 4 : 3);
      expect(a.stats.dead).toBe(0);
    }
  });

  it('compacts as much as a root wrote, so a backlog of half-dead slabs does not grow', () => {
    const o = owner();
    const a = new Arena(o);
    const entry = (i: number, fill: number) => o.refs.set(`2/${i}`, a.alloc(2, i, bytesOf(1024 * 1024 - HEADER, fill)));
    for (let i = 0; i < 100; i++) entry(i, 1);
    a.maintain();
    // Three in every five rewritten: every slab the first hundred filled is now more than half dead.
    for (let i = 0; i < 100; i++) {
      if (i % 5 >= 3) continue;
      a.free(o.refs.get(`2/${i}`)!);
      entry(i, 2);
    }
    const before = new Map([...o.refs].map(([k, ref]) => [k, a.read(ref)[0]]));
    a.maintain();
    // One pass did all there was to do: more passes find nothing more than half dead to compact.
    const once = a.stats;
    expect(once.dead).toBeLessThanOrEqual(2 * 1024 * 1024);
    for (let i = 0; i < 20; i++) a.maintain();
    expect(a.stats).toEqual(once);
    for (const [k, first] of before) expect(a.read(o.refs.get(k)!)[0]).toBe(first);
  });

  it('reuses the numbers of released slabs, so references stay small and exact however long the node runs', () => {
    const o = owner();
    const a = new Arena(o);
    const big = bytesOf(MAX_ENTRY, 3);
    let stale = -1;
    for (let root = 0; root < 40; root++) {
      const old = o.refs.get('1/0');
      if (old !== undefined) a.free(old);
      if (root === 20) stale = old!;
      if (o.refs.has('1/1')) a.free(o.refs.get('1/1')!);
      o.refs.set('1/0', a.alloc(1, 0, big));
      o.refs.set('1/1', a.alloc(1, 1, Uint8Array.of(root)));
      a.maintain();
    }
    // Forty roots of slab-sized writes reuse a handful of slab numbers instead of counting up forever.
    for (const ref of o.refs.values()) expect(slabOf(ref) % 2 ** 16).toBeLessThan(8);
    expect(a.read(o.refs.get('1/1')!)).toEqual(Uint8Array.of(39));
    // A reference into a slab whose number has since been reused is still refused, by its generation.
    expect(() => a.read(stale)).toThrow(/released/);
    // References are exact at the limits of what they can hold, and refused beyond them.
    const top = packRef(2 ** 29 - 1, 2 ** 24 - 1);
    expect(slabOf(top)).toBe(2 ** 29 - 1);
    expect(top % 2 ** 24).toBe(2 ** 24 - 1);
    expect(() => packRef(2 ** 29, 0)).toThrow(RangeError);
    expect(() => packRef(0, 2 ** 24)).toThrow(RangeError);
  });
});
