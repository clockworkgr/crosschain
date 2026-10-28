/** LMDB through the key-value interface, and the block store on top of it. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZERO_HASH } from '../src/crypto/hash.ts';
import { PROTOCOL_VERSION } from '../src/types/state.ts';
import { blockHash, type Block, type Commit } from '../src/types/block.ts';
import { txsRoot } from '../src/types/txproof.ts';
import { KvBlockStore } from '../src/store/blockstore.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
import { bench, fact, fmtBytes, randomBytes, suite } from './harness.ts';
import { signedTransfers } from './fixtures.ts';

export async function run(): Promise<void> {
  suite('store');
  const dir = mkdtempSync(join(tmpdir(), 'crosschain-bench-'));
  const env = new LmdbEnv(dir);
  const kv = env.store('bench');
  const value = randomBytes(100);
  const keyOf = (i: number) => {
    const k = new Uint8Array(8);
    new DataView(k.buffer).setUint32(4, i);
    return k;
  };
  let n = 0;
  await bench('write transaction: 1 put of 100 B (commit + sync)', {}, () => kv.write((w) => w.put(keyOf(n++), value)));
  await bench('write transaction: 1,000 puts of 100 B', { batch: 1000 }, () =>
    kv.write((w) => {
      for (let i = 0; i < 1000; i++) w.put(keyOf(n++), value);
    }),
  );
  const have = n;
  await bench('get (random key)', { batch: 1000 }, () => {
    for (let i = 0; i < 1000; i++) kv.get(keyOf(Math.floor(Math.random() * have)));
  });
  await bench('range scan of 1,000 entries', { batch: 1000 }, () => {
    let c = 0;
    for (const _ of kv.range(keyOf(0), keyOf(have))) if (++c >= 1000) break;
  });

  const store = new KvBlockStore(env.store('chain'));
  const txs = signedTransfers(500, 1_700_000_060_000n);
  let height = 1n;
  const block = (h: bigint): Block => ({
    header: { chainId: 'bench', version: PROTOCOL_VERSION, height: h, time: 1_700_000_000_000n + h, lastBlockHash: ZERO_HASH, lastCommitHash: ZERO_HASH, dataHash: txsRoot(txs), lastResultsHash: ZERO_HASH, validatorsHash: ZERO_HASH, nextValidatorsHash: ZERO_HASH, appHash: ZERO_HASH, evidenceHash: ZERO_HASH, proposerAddress: new Uint8Array(32) },
    txs,
    lastCommit: null,
    evidence: [],
  });
  const commitFor = (b: Block): Commit => ({ height: b.header.height, round: 0, blockHash: blockHash(b), signatures: [randomBytes(2420), randomBytes(2420), randomBytes(2420), randomBytes(2420)] });
  const results = txs.map(() => ({ ok: true }));
  const sample = block(0n);
  fact('block with 500 transfers and a 4-signature commit', `${fmtBytes(txs.reduce((s, t) => s + t.length, 0))} of transactions`);
  let next: { b: Block; c: Commit } = { b: block(height), c: commitFor(block(height)) };
  await bench('saveBlock (500 txs, results, tx index)', { before: () => void (next = (() => { const b = block(++height); return { b, c: commitFor(b) }; })()) }, () => store.saveBlock(next.b, next.c, results));
  await bench('loadBlock', {}, () => store.loadBlock(1n + BigInt(Math.floor(Math.random() * Number(height - 1n)))));
  await bench('loadResults', {}, () => store.loadResults(1n));
  void sample;
  await env.close();
  rmSync(dir, { recursive: true, force: true });
}
