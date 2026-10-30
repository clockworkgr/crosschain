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
    // Slab numbers are never reused, so a stale reference cannot alias a newer entry.
    expect(slabOf(a.alloc(4, 0, bytesOf(10, 1)))).toBeGreaterThan(0);
  });
});
