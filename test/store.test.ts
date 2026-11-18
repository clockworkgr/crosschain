import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toHex, ZERO_HASH } from '../src/crypto/hash.ts';
import { KvBlockStore, MemoryBlockStore } from '../src/store/blockstore.ts';
import { MemoryEnv, MemoryKv, prefixEnd, StoreReadOnlyError, type KvStore } from '../src/store/kv.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
import { blockHash, txHash, type Block, type Commit } from '../src/types/block.ts';

function block(height: bigint): { block: Block; commit: Commit } {
  const header = {
    chainId: 'store-test',
    version: 1,
    height,
    time: 1_700_000_000_000n + height,
    lastBlockHash: ZERO_HASH,
    lastCommitHash: ZERO_HASH,
    dataHash: ZERO_HASH,
    lastResultsHash: ZERO_HASH,
    validatorsHash: ZERO_HASH,
    nextValidatorsHash: ZERO_HASH,
    appHash: new Uint8Array(32).fill(Number(height)),
    evidenceHash: ZERO_HASH,
    proposerAddress: new Uint8Array(32),
  };
  const b: Block = { header, txs: [new Uint8Array([1, 2, 3])], lastCommit: null, evidence: [] };
  return { block: b, commit: { height, round: 0, blockHash: blockHash(b), signatures: [null] } };
}

function exerciseKv(kv: KvStore): void {
  const k = (s: string) => new TextEncoder().encode(s);
  kv.write((w) => {
    w.put(k('b/2'), k('two'));
    w.put(k('b/1'), k('one'));
    w.put(k('a'), k('zero'));
    w.put(k('c'), k('three'));
  });
  expect(new TextDecoder().decode(kv.get(k('b/1')))).toBe('one');
  expect(kv.get(k('nope'))).toBeUndefined();
  expect([...kv.range(k('b'), prefixEnd(k('b')))].map(([, v]) => new TextDecoder().decode(v))).toEqual(['one', 'two']);
  expect([...kv.range(k('a'), k('z'))].length).toBe(4);
  expect(() =>
    kv.write((w) => {
      w.put(k('d'), k('four'));
      throw new Error('abort');
    }),
  ).toThrow('abort');
  expect(kv.get(k('d'))).toBeUndefined();
  kv.write((w) => w.del(k('a')));
  expect(kv.get(k('a'))).toBeUndefined();
  // Inside a write, a read sees what the write has done so far, and a range goes on over keys being deleted.
  kv.write((w) => {
    for (let i = 0; i < 200; i++) w.put(k(`n/${String(i).padStart(3, '0')}`), k(`${i}`));
    expect(new TextDecoder().decode(kv.get(k('n/150')))).toBe('150');
    let seen = 0;
    for (const [key] of kv.range(k('n/'), prefixEnd(k('n/')))) {
      if (seen++ % 2 === 0) w.del(key);
    }
    expect(seen).toBe(200);
    expect(kv.get(k('n/000'))).toBeUndefined();
    expect([...kv.range(k('n/'), prefixEnd(k('n/')))].length).toBe(100);
    if (kv.has) expect([kv.has(k('n/001')), kv.has(k('n/000'))]).toEqual([true, false]);
    // A range under way gives what lies ahead of it as it is when it gets there: a key put ahead, a value
    // replaced ahead and a key deleted ahead.
    const seenAhead: string[] = [];
    for (const [key, value] of kv.range(k('n/1'), prefixEnd(k('n/1')))) {
      const name = new TextDecoder().decode(key);
      seenAhead.push(`${name}=${new TextDecoder().decode(value)}`);
      if (name === 'n/101') {
        w.put(k('n/102'), k('put'));
        w.put(k('n/103'), k('replaced'));
        w.del(k('n/105'));
      }
    }
    expect(seenAhead.slice(0, 4)).toEqual(['n/101=101', 'n/102=put', 'n/103=replaced', 'n/107=107']);
    w.del(k('n/102'));
    w.put(k('n/105'), k('105'));
    w.put(k('n/103'), k('103'));
  });
  expect([...kv.range(k('n/'), prefixEnd(k('n/')))].length).toBe(100);
  expect(() =>
    kv.write((w) => {
      w.del(k('n/001'));
      w.put(k('b/1'), k('changed'));
      throw new Error('abort');
    }),
  ).toThrow('abort');
  expect([new TextDecoder().decode(kv.get(k('n/001'))), new TextDecoder().decode(kv.get(k('b/1')))]).toEqual(['1', 'one']);
}

describe('key-value stores', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('memory store orders keys bytewise and makes writes atomic', () => {
    exerciseKv(new MemoryKv());
  });

  it('lmdb store does the same and survives reopening', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lmdb-'));
    const env = new LmdbEnv(join(tmp, 'env'));
    exerciseKv(env.store('t'));
    await env.close();
    const again = new LmdbEnv(join(tmp, 'env'));
    expect(new TextDecoder().decode(again.store('t').get(new TextEncoder().encode('c')))).toBe('three');
    const ro = new LmdbEnv(join(tmp, 'env'), { readOnly: true });
    expect(ro.store('t').get(new TextEncoder().encode('a'))).toBeUndefined();
    // A read-only environment cannot create a database, and says so where it is asked for one.
    expect(() => ro.store('missing')).toThrow(/no database named missing/);
    // And a write to it is refused by name, before anything reaches the native library.
    expect(() => ro.store('t').write((w) => w.put(Uint8Array.of(1), Uint8Array.of(1)))).toThrow(StoreReadOnlyError);
    await ro.close();
    await again.close();
  });

  it('block store finds blocks by height and by hash on both backends', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lmdb-'));
    const env = new LmdbEnv(join(tmp, 'env'));
    for (const store of [new MemoryBlockStore(), new KvBlockStore(env.store('chain'))]) {
      for (let h = 1n; h <= 5n; h++) {
        const { block: b, commit } = block(h);
        store.saveBlock(b, commit);
      }
      const got = store.loadBlock(3n)!;
      expect(got.block.header.height).toBe(3n);
      expect(toHex(got.commit.blockHash)).toBe(toHex(blockHash(got.block)));
      expect(store.heightOf(blockHash(block(4n).block))).toBe(4n);
      expect(store.heightOf(new Uint8Array(32))).toBeNull();
      expect(store.loadBlock(9n)).toBeNull();
      expect(store.loadState()).toBeNull();
    }
    await env.close();
  });

  it('undoes an environment transaction made inside a write that then throws, on both backends', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lmdb-'));
    const disk = new LmdbEnv(join(tmp, 'env'));
    for (const env of [new MemoryEnv(), disk]) {
      const kv = env.store('chain');
      const other = env.store('app');
      const store = new KvBlockStore(kv);
      const k = (s: string) => new TextEncoder().encode(s);
      kv.write((w) => w.put(k('kept'), k('before')));
      // A batch saves a block, an environment transaction inside it saves another and writes to two more stores,
      // and then the batch throws: none of it stays, and what was there before is as it was.
      expect(() =>
        store.batch(() => {
          const one = block(1n);
          store.saveBlock(one.block, one.commit, [{ ok: true }]);
          kv.write((w) => w.put(k('kept'), k('changed')));
          env.transaction(() => {
            const two = block(2n);
            store.saveBlock(two.block, two.commit, [{ ok: true }]);
            other.write((w) => w.put(k('o'), k('1')));
            // A store first asked for here, and a transaction inside this one, are part of it too.
            env.transaction(() => env.store('late').write((w) => w.put(k('l'), k('1'))));
          });
          expect(store.loadBlock(2n)).not.toBeNull();
          expect(new TextDecoder().decode(other.get(k('o')))).toBe('1');
          throw new Error('abort');
        }),
      ).toThrow('abort');
      expect([store.loadBlock(1n), store.loadBlock(2n)]).toEqual([null, null]);
      expect(store.txLocation(txHash(new Uint8Array([1, 2, 3])))).toBeNull();
      expect(new TextDecoder().decode(kv.get(k('kept')))).toBe('before');
      // The write was a transaction of the environment: what the other stores took inside it is undone as well.
      expect([other.get(k('o')), env.store('late').get(k('l'))]).toEqual([undefined, undefined]);
      // And an environment transaction that throws inside a batch that goes on takes only its own writes back.
      store.batch(() => {
        const one = block(1n);
        store.saveBlock(one.block, one.commit, [{ ok: true }]);
        expect(() =>
          env.transaction(() => {
            const two = block(2n);
            store.saveBlock(two.block, two.commit, [{ ok: true }]);
            throw new Error('inner');
          }),
        ).toThrow('inner');
      });
      expect([store.loadBlock(1n) !== null, store.loadBlock(2n)]).toEqual([true, null]);
    }
    await disk.close();
  });

  it('block store on lmdb moves index entries into larger segments within the transactions that save the blocks', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lmdb-'));
    const env = new LmdbEnv(join(tmp, 'env'));
    const kv = env.store('chain');
    const store = new KvBlockStore(kv);
    const tx = (h: bigint, i: number) => Uint8Array.of(Number(h >> 8n), Number(h & 0xffn), i);
    const TOP = 2304n;
    // 64 blocks of twenty transactions a transaction of the store: each step reads what the steps before it in the
    // same transaction wrote.
    for (let from = 1n; from <= TOP; from += 64n) {
      store.batch(() => {
        for (let h = from; h < from + 64n; h++) {
          const { block: b } = block(h);
          const txs = Array.from({ length: 20 }, (_, i) => tx(h, i));
          const full: Block = { ...b, txs };
          store.saveBlock(full, { height: h, round: 0, blockHash: blockHash(full), signatures: [null] }, txs.map((_, i) => ({ ok: i % 2 === 0, error: i % 2 ? `no ${h}` : '' })));
        }
      });
    }
    const check = (st: KvBlockStore) => {
      for (let h = 1n; h <= TOP; h += 13n) {
        expect(st.txLocations(txHash(tx(h, 7))).map((l) => [l.height, l.index, l.ok, l.error])).toEqual([[h, 7, false, `no ${h}`]]);
        expect(st.txLocation(txHash(tx(h, 0)))).toMatchObject({ height: h, index: 0, ok: true });
      }
      expect(st.txLocation(txHash(tx(TOP + 1n, 0)))).toBeNull();
    };
    check(store);
    // The first 2,048 blocks are behind the latest by a whole segment of 1,024 and have moved; the rest have not.
    const under = (a: Uint8Array, b: Uint8Array) => [...kv.range(a, b)].length;
    expect(under(Uint8Array.of(0x79, 1), Uint8Array.of(0x79, 2))).toBe(2048 * 20 - 20); // heights 1 to 2,047
    expect(under(Uint8Array.of(0x78), Uint8Array.of(0x79))).toBe((Number(TOP) - 2047) * 20);
    await env.close();
    const again = new LmdbEnv(join(tmp, 'env'));
    check(new KvBlockStore(again.store('chain')));
    await again.close();
  });
});
