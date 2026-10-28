import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toHex, ZERO_HASH } from '../src/crypto/hash.ts';
import { KvBlockStore, MemoryBlockStore } from '../src/store/blockstore.ts';
import { MemoryKv, prefixEnd, type KvStore } from '../src/store/kv.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
import { blockHash, type Block, type Commit } from '../src/types/block.ts';

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
});
