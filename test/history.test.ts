import { describe, expect, it } from 'vitest';
import { HistoryKind, HistoryLog, historyEntryToBytes, type HistoryEntry } from '../src/app/core/history.ts';
import { objectId, type ObjectId } from '../src/db/id.ts';
import { key } from '../src/db/keys.ts';
import { MemoryKv, prefixEnd, type KvStore } from '../src/store/kv.ts';

const account = (n: number): ObjectId => objectId(2, n);
const entry = (height: number, n: number): HistoryEntry => ({ height: BigInt(height), position: n, opIndex: 0, kind: HistoryKind.operation, txHash: null, data: Uint8Array.of(n & 0xff, n >> 8) });

/** Blocks of entries over a few accounts, one of them in most entries, and what each account's history should then be. */
function blocks(count: number, perBlock: number): { blocks: [ObjectId, HistoryEntry][][]; model: Map<ObjectId, HistoryEntry[]> } {
  const model = new Map<ObjectId, HistoryEntry[]>();
  const out: [ObjectId, HistoryEntry][][] = [];
  let n = 0;
  for (let h = 1; h <= count; h++) {
    const block: [ObjectId, HistoryEntry][] = [];
    for (let i = 0; i < perBlock; i++, n++) {
      const a = account(n % 3 === 0 ? (n * 7) % 5 : 0);
      const e = entry(h, n);
      block.push([a, e]);
      model.set(a, [...(model.get(a) ?? []), e]);
    }
    out.push(block);
  }
  return { blocks: out, model };
}

describe('account history log', () => {
  it('pages an account oldest first and newest first, whatever the other accounts wrote between its entries', () => {
    const kv = new MemoryKv();
    const log = new HistoryLog(kv);
    const { blocks: bs, model } = blocks(40, 13);
    for (const b of bs) kv.write((w) => log.append(w, b));
    // A log opened on the store later reads the same and goes on from where this one stopped.
    for (const l of [log, new HistoryLog(kv)]) {
      for (const [a, want] of model) {
        const total = BigInt(want.length);
        expect(l.total(a)).toBe(total);
        for (const from of [0, 1, 2, 7, 64, want.length - 1, want.length, want.length + 5]) {
          for (const limit of [0, 1, 3, 100, 1000]) {
            const forward = l.read(a, BigInt(from), limit, false);
            expect(forward.total).toBe(total);
            expect(forward.entries.map((e) => [e.sequence, e.position])).toEqual(want.slice(from, from + limit).map((e, i) => [BigInt(from + i), e.position]));
            const newestFirst = want.map((e, i) => [BigInt(i), e.position]).reverse();
            expect(l.read(a, BigInt(from), limit, true).entries.map((e) => [e.sequence, e.position])).toEqual(newestFirst.slice(from, from + limit));
          }
        }
      }
    }
    expect(log.read(account(99), 0n, 10, false)).toEqual({ entries: [], total: 0n });
    const later = new HistoryLog(kv);
    kv.write((w) => later.append(w, [[account(0), entry(41, 9999)]]));
    expect(later.read(account(0), 0n, 1, true).entries[0]!.position).toBe(9999);
    expect(later.total(account(0))).toBe(BigInt(model.get(account(0))!.length + 1));
  });

  it('reaches the old end of a long history in a few dozen reads, and appends a block with a few pages of writes', () => {
    const inner = new MemoryKv();
    let gets = 0;
    const kv: KvStore = { get: (k) => (gets++, inner.get(k)), range: (a, b) => inner.range(a, b), write: (fn) => inner.write(fn) };
    const log = new HistoryLog(kv);
    const N = 5000;
    for (let h = 0; h < N / 100; h++) kv.write((w) => log.append(w, Array.from({ length: 100 }, (_, i): [ObjectId, HistoryEntry] => [account(1), entry(h + 1, h * 100 + i)])));
    // Writing an entry reads its account's head and, on average, one older entry for the skip pointer.
    expect(gets).toBeLessThan(3 * N);
    for (const from of [0, 1, 1234, 2047, 2048, 4095, N - 2]) {
      gets = 0;
      expect(log.read(account(1), BigInt(from), 2, false).entries.map((e) => e.position)).toEqual([from, from + 1]);
      expect(gets).toBeLessThan(100); // log2(5000)² is about 150; the walk is far below the worst case, and nowhere near 5,000
    }
    // The keys of a block's entries are consecutive: they sort together at the end of the log.
    const keys = Array.from(inner.range(Uint8Array.of(0x6c), prefixEnd(Uint8Array.of(0x6c))), ([k]) => Buffer.from(k).readBigUInt64BE(1));
    expect(keys).toEqual(Array.from({ length: N }, (_, i) => BigInt(i)));
  });

  it('writes the heads a slice of the accounts at a time, and has the waiting ones back after a stop', () => {
    const inner = new MemoryKv();
    let headPuts: bigint[] = [];
    const kv: KvStore = {
      get: (k) => inner.get(k),
      range: (a, b) => inner.range(a, b),
      write: (fn) => inner.write((w) => fn({ put: (k, v) => (k[0] === 0x70 && headPuts.push(Buffer.from(k).readBigUInt64BE(1)), w.put(k, v)), del: (k) => w.del(k) })),
    };
    const log = new HistoryLog(kv);
    const ACCOUNTS = 6400;
    const counts = new Map<number, number>();
    let n = 0;
    const perBlock: number[] = [];
    for (let h = 1; h <= 200; h++) {
      // 300 accounts a block from all over the range, in no order.
      const block = Array.from({ length: 300 }, (): [ObjectId, HistoryEntry] => {
        const a = (n * 2654435761) % ACCOUNTS;
        counts.set(a, (counts.get(a) ?? 0) + 1);
        return [account(a), entry(h, n++)];
      });
      headPuts = [];
      kv.write((w) => log.append(w, block));
      perBlock.push(headPuts.length);
      // What a block writes is one stretch of the account numbers, a sixty-fourth of the range (the slices are 128
      // wide once account 6,399 has been seen).
      if (headPuts.length > 0) expect(Number(headPuts.reduce((a, b) => (a > b ? a : b)) - headPuts.reduce((a, b) => (a < b ? a : b)))).toBeLessThan(128);
      // Stopped at any block, a log opened on the store knows every account's count.
      if (h % 37 === 0 || h === 200) {
        const reopened = new HistoryLog(inner);
        for (const [a, count] of counts) expect(reopened.total(account(a))).toBe(BigInt(count));
        expect(reopened.read(account(0), 0n, 1000, false).entries.length).toBe(counts.get(0));
      }
    }
    // Far fewer head writes than head changes: a head changed several times while it waits is written once.
    const written = perBlock.reduce((a, b) => a + b, 0);
    expect(written).toBeLessThan((200 * 300) / 2);
    expect(Math.max(...perBlock)).toBeLessThan(300);
    // The journal is short: the stored heads lag the log by no more than 64 blocks of entries.
    const [length, covered] = [0, 8].map((at) => Buffer.from(inner.get(Uint8Array.of(0x4c))!).readBigUInt64BE(at));
    expect(length).toBe(BigInt(200 * 300));
    expect(Number(length! - covered!)).toBeLessThanOrEqual(64 * 300);
  });

  it('moves a store written before the log into it the first time it is opened', () => {
    const kv = new MemoryKv();
    const { blocks: bs, model } = blocks(12, 9);
    // The layout before: an entry by account and sequence, a count by account.
    kv.write((w) => {
      for (const [a, entries] of model) {
        entries.forEach((e, i) => w.put(key((k) => k.u8(0x61).u64(a).u64(BigInt(i))), historyEntryToBytes(e)));
        w.put(key((k) => k.u8(0x71).u64(a)), key((k) => k.u64(BigInt(entries.length))));
      }
    });
    expect(bs.length).toBe(12);
    const log = new HistoryLog(kv);
    for (const [a, want] of model) {
      expect(log.read(a, 0n, 1000, false).entries.map((e) => [e.sequence, e.height, e.position])).toEqual(want.map((e, i) => [BigInt(i), e.height, e.position]));
      expect(log.read(a, 0n, 2, true).entries.map((e) => e.position)).toEqual(want.slice(-2).reverse().map((e) => e.position));
    }
    for (const prefix of [0x61, 0x71]) expect(Array.from(kv.range(Uint8Array.of(prefix), prefixEnd(Uint8Array.of(prefix))))).toEqual([]);
    // In the log an account's entries keep their order, and the log as a whole is by height.
    const heights = Array.from(kv.range(Uint8Array.of(0x6c), prefixEnd(Uint8Array.of(0x6c))), ([, v]) => Buffer.from(v).readBigUInt64BE(32));
    expect(heights).toEqual(heights.slice().sort((a, b) => Number(a - b)));
    // Opening it again finds nothing to move, and new entries follow the moved ones.
    const again = new HistoryLog(kv);
    kv.write((w) => again.append(w, [[account(0), entry(13, 777)]]));
    expect(again.read(account(0), 0n, 1, true).entries[0]).toMatchObject({ position: 777, sequence: BigInt(model.get(account(0))!.length) });
  });
});
