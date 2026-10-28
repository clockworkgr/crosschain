/**
 * The core application by itself: admitting transactions (checkTx), running
 * a block (finalizeBlock) with and without cached signatures, and committing
 * to memory and to LMDB. The split between a cold and a warm block is the
 * cost of signature verification; the rest is evaluation and the root.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreApp } from '../src/app/core/app.ts';
import { InlineVerifier, WorkerVerifier, type Verifier } from '../src/crypto/verifier.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
import type { KvStore } from '../src/store/kv.ts';
import { bench, fact, fmtMs, suite } from './harness.ts';
import { makeGenesis, signedTransfers } from './fixtures.ts';

const genesisTime = 1_700_000_000_000n;

export async function run(): Promise<void> {
  suite('app');
  const genesis = makeGenesis(0, genesisTime);
  const inline = new InlineVerifier();
  const pool = new WorkerVerifier();
  const makeApp = (verifier: Verifier, kv?: KvStore) => new CoreApp({ genesis, verifier, kv, retainVersions: 100, snapshotInterval: 0 });
  const t0 = performance.now();
  let app = makeApp(inline);
  fact('genesis with 1,001 accounts: parse, apply, first root', fmtMs(performance.now() - t0));
  const txs = signedTransfers(4000, genesisTime + 60_000n);
  const blockOf = (a: CoreApp, list: Uint8Array[]) => a.finalizeBlock({ height: a.lastHeight + 1n, time: genesisTime + 1000n * (a.lastHeight + 1n), txs: list, proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });

  await bench('checkTx, inline verifier, one at a time (500 txs)', { batch: 500, iterations: 1, warmup: 0, before: () => void (app = makeApp(inline)) }, async () => {
    for (let i = 0; i < 500; i++) {
      const r = await app.checkTx(txs[i]!);
      if (!r.ok) throw new Error(r.error);
    }
  });
  await bench('checkTx, worker pool, 32 in flight (2,000 txs)', { batch: 2000, iterations: 1, warmup: 0, before: () => void (app = makeApp(pool)) }, async () => {
    let next = 0;
    const worker = async () => {
      while (next < 2000) {
        const r = await app.checkTx(txs[next++]!);
        if (!r.ok) throw new Error(r.error);
      }
    };
    await Promise.all(Array.from({ length: 32 }, worker));
  });

  const block500 = txs.slice(0, 500);
  await bench('finalizeBlock 500 transfers, cold, inline verifier', { batch: 500, iterations: 3, warmup: 1, before: () => void (app = makeApp(inline)) }, async () => {
    const r = await blockOf(app, block500);
    if (r.txResults.some((t) => !t.ok)) throw new Error('a transaction failed');
  });
  await bench('finalizeBlock 500 transfers, cold, worker pool', { batch: 500, iterations: 3, warmup: 1, before: () => void (app = makeApp(pool)) }, async () => {
    const r = await blockOf(app, block500);
    if (r.txResults.some((t) => !t.ok)) throw new Error('a transaction failed');
  });
  const warm = async (list: Uint8Array[]) => {
    app = makeApp(pool);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const r = await app.checkTx(list[next++]!);
        if (!r.ok) throw new Error(r.error);
      }
    };
    await Promise.all(Array.from({ length: 32 }, worker));
  };
  await bench('finalizeBlock 500 transfers, warm (signatures cached by checkTx)', { batch: 500, iterations: 3, warmup: 1, before: () => warm(block500) }, async () => {
    const r = await blockOf(app, block500);
    if (r.txResults.some((t) => !t.ok)) throw new Error('a transaction failed');
  });
  const block1500 = txs.slice(0, 1500);
  await bench('finalizeBlock 1,500 transfers, warm (about 3.6 MiB with a block shell)', { batch: 1500, iterations: 3, warmup: 1, before: () => warm(block1500) }, async () => {
    const r = await blockOf(app, block1500);
    if (r.txResults.some((t) => !t.ok)) throw new Error('a transaction failed');
  });
  await bench('finalizeBlock, empty block', { iterations: 20 }, () => blockOf(app, []));

  await bench('commit to memory (after a 500-transfer block)', { iterations: 5, before: async () => void (await blockOf((app = makeApp(pool)), block500)) }, () => app.commit());
  const dir = mkdtempSync(join(tmpdir(), 'crosschain-bench-'));
  const env = new LmdbEnv(dir);
  let n = 0;
  await bench('commit to LMDB (after a 500-transfer block)', { iterations: 5, before: async () => void (await blockOf((app = makeApp(pool, env.store(`app${n++}`))), block500)) }, () => app.commit());
  await env.close();
  rmSync(dir, { recursive: true, force: true });
  await pool.close();
}
