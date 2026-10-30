/**
 * State paging (STATE-PAGING.md section 9, item 5): the large state of the
 * genesis and scale suites (bigstate.ts), run through every mode the memory
 * guard can put the database in, and a node whose guard reaches `pressure`.
 *
 * First a node (paging-node.ts), in a child process started with a heap
 * limit of 1.25 times the resident state (BENCH_PAGING_HEAP sets it in MiB):
 * a single validator over the store, its mempool kept full of transfers. The
 * load takes the heap to the guard's `pressure` line; the suite reports per
 * two seconds the blocks and transfers committed, the guard's level, each
 * tier's mode and the heap, and the guard's messages. A child process,
 * because V8's heap limit is fixed when a process starts.
 *
 * Then the database alone, reopened from the store the node left: blocks of
 * transfers among random accounts, checked (as admission does) and then
 * finalized and committed to LMDB, with the database forced into each mode in
 * turn, as the guard's levels add them up: everything resident; the
 * decoded-object cache capped at 10,000; the index trees dropped as well; the
 * Merkle trees dropped as well; and everything rebuilt. Each mode reports
 * transfers and blocks per second and the memory after it.
 *
 *   CHAIN_SCHEME=secp256k1 BENCH_GENESIS_MB=56 node --expose-gc bench/run.ts paging
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreApp } from '../src/app/core/app.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import type { OperationDraft } from '../src/app/core/tx.ts';
import { TYPE } from '../src/app/core/types.ts';
import { WorkerVerifier } from '../src/crypto/verifier.ts';
import { objectId } from '../src/db/id.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
import { fact, fmtMs, suite } from './harness.ts';
import { buildBigState, CHAIN_ID, MB, memory, POOL, type BigState } from './bigstate.ts';

/** How long the node runs under its heap limit. */
const NODE_SECONDS = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MiB = (n: number) => `${(n / 1048576).toFixed(0)} MiB`;

/** Heap and array buffers after two collections, as numbers. */
async function settled(): Promise<{ heap: number; arrayBuffers: number }> {
  const gc = (globalThis as { gc?: () => void }).gc;
  for (let i = 0; i < 2; i++) {
    await sleep(50);
    gc?.();
  }
  const m = process.memoryUsage();
  return { heap: m.heapUsed, arrayBuffers: m.arrayBuffers };
}

export async function run(): Promise<void> {
  suite(`paging (${MB} MB genesis)`);
  const dir = mkdtempSync(join(tmpdir(), 'crosschain-paging-'));
  const verifier = new WorkerVerifier();
  try {
    let big: BigState | null = await buildBigState(dir, verifier);
    const keys = big.keys;
    const N = big.accounts;
    fact('state built', big.summary);
    fact('memory with everything resident', await memory());
    const resident = await settled();
    const genesis = big.genesis;
    await big.env.close();
    big = null; // the child opens the store itself
    // ---- A node under a real heap limit its load takes it past `pressure` on: a child process, so the limit is
    // V8's own and the collector works against it as it would in a node started with --heap.
    const heapMb = Number(process.env.BENCH_PAGING_HEAP ?? Math.round((1.25 * resident.heap) / 1048576));
    {
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, '--max-semi-space-size=64', '--expose-gc', join(import.meta.dirname, 'paging-node.ts'), dir, String(N), String(NODE_SECONDS)], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
      const lines: Record<string, unknown>[] = [];
      let buffered = '';
      child.stdout.on('data', (d: Buffer) => {
        buffered += d.toString();
        let nl: number;
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          try {
            lines.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // not one of the child's reports
          }
        }
      });
      const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
      const opened = lines.find((l) => l.event === 'opened');
      fact('node: heap limit (--max-old-space-size)', `${heapMb} MiB, 1.25 times the resident heap of the state; the node opened its store in ${opened?.ms} ms with ${opened?.heap} MiB of heap`);
      for (const w of lines.filter((l) => l.event === 'window')) {
        fact(`node, ${String(w.s).padStart(2)} s`, `${w.blocks} blocks, ${w.txs} transfers; ${w.level}, objects ${w.objects}, index trees ${w.indexTrees}, Merkle trees ${w.trees}; heap ${w.heap} of ${w.limit} MiB`);
      }
      for (const l of lines.filter((l) => l.event === 'log')) fact(`node log at ${l.s} s`, `${l.msg}${l.heap ? ` (${l.heap})` : ''}${l.needs ? ` (needs ${l.needs}, room ${l.room})` : ''}`);
      const sum = lines.find((l) => l.event === 'summary');
      if (sum) fact(`node: ${NODE_SECONDS} s in all`, `${sum.blocks} blocks, ${sum.txs} transfers (${(Number(sum.txs) / NODE_SECONDS).toFixed(0)}/s); ${sum.pagedBlocks} blocks holding ${sum.pagedTxs} transfers committed with the Merkle trees dropped; ${sum.submitted} submitted, ${sum.refused} refused; levels: ${sum.levels || 'none'}`);
      else fact('node: did not finish', `exit code ${code}`);
    }
    // The state as the node left it, reopened from the store.
    const env = new LmdbEnv(join(dir, 'lmdb'));
    const app = new CoreApp({ genesis, verifier, kv: env.store('app'), snapshotInterval: 0 });
    const db = app.db;
    fact('memory with the state reopened', await memory());
    const rnd = () => Math.floor(Math.random() * N);
    let serial = 0n;
    const sign = (from: number, ops: OperationDraft[], expiration: bigint) => signedTxBytes(CHAIN_ID, { expiration, operations: withFees(ops, app.feeSchedule()) }, [keys[(2 * from + 1) % POOL]!]);
    const transfers = (n: number, expiration: bigint) =>
      Array.from({ length: n }, () => {
        const from = rnd();
        let to = rnd();
        while (to === from) to = rnd();
        return sign(from, [{ type: 'transfer', from: objectId(TYPE.account, from), to: objectId(TYPE.account, to), asset: app.coreAsset, amount: 1n + serial++ }], expiration);
      });

    // ---- Blocks at each mode of the database.
    {
      const BLOCKS = 6;
      const TXS = 500;
      const modes: [string, () => void][] = [
        ['resident', () => {}],
        ['cache capped at 10,000 objects', () => db.setHotLimit(10_000)],
        ['capped, index trees dropped', () => db.dropIndexTrees()],
        ['capped, index trees and Merkle trees dropped', () => db.dropTrees()],
        [
          'everything resident again',
          () => {
            db.rebuildTrees();
            db.rebuildIndexTrees();
            db.setHotLimit(Infinity);
          },
        ],
      ];
      for (const [mode, dial] of modes) {
        let t = performance.now();
        dial();
        const dialMs = performance.now() - t;
        const batches = Array.from({ length: BLOCKS }, () => transfers(TXS, app.dynamic().time + 3_600_000n));
        const times = { check: 0, finalize: 0, commit: 0 };
        for (const txs of batches) {
          t = performance.now();
          let next = 0;
          await Promise.all(
            Array.from({ length: 32 }, async () => {
              while (next < txs.length) {
                const r = await app.checkTx(txs[next++]!);
                if (!r.ok) throw new Error(r.error);
              }
            }),
          );
          times.check += performance.now() - t;
          t = performance.now();
          const r = await app.finalizeBlock({ height: app.lastHeight + 1n, time: app.dynamic().time + 1000n, txs, proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });
          times.finalize += performance.now() - t;
          if (r.txResults.some((x) => !x.ok)) throw new Error(`a transfer failed: ${r.txResults.find((x) => !x.ok)?.error}`);
          t = performance.now();
          await app.commit();
          times.commit += performance.now() - t;
        }
        const run = (times.finalize + times.commit) / 1000;
        const m = await settled();
        const d = db.memory();
        fact(
          `blocks of ${TXS} random transfers, ${mode}`,
          `${(BLOCKS / run).toFixed(1)} blocks/s, ${((BLOCKS * TXS) / run).toFixed(0)} transfers/s; per block finalize ${fmtMs(times.finalize / BLOCKS)}, commit ${fmtMs(times.commit / BLOCKS)}, checkTx of its ${TXS} ${fmtMs(times.check / BLOCKS)}; switching to the mode ${fmtMs(dialMs)}`,
        );
        const est = db.rebuildEstimate();
        fact(`memory after: ${mode}`, `heap ${MiB(m.heap)}, array buffers ${MiB(m.arrayBuffers)}; ${d.hotObjects.toLocaleString('en-US')} decoded objects, ${d.treeChunks} chunks cached; rebuilding estimated at ${MiB(est.indexTrees)} (index trees) + ${MiB(est.trees)} (Merkle trees)`);
      }
    }
    await env.close();
  } finally {
    await verifier.close();
    if (process.env.BENCH_KEEP) console.log(`kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}
