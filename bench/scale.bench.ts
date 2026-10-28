/**
 * Steady state on top of the large genesis (bigstate.ts): a single validator
 * with that state producing blocks while RPC clients read and write; blocks
 * of batch transfers that touch accounts all over the state; proofs at past
 * heights and account history after them; and a complete state-sync import
 * of the state into a fresh store, as a joining node does it. Runs with
 * `npm run bench:genesis` or `npm run bench -- scale`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreApp } from '../src/app/core/app.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { chunkCount, decodeManifest, importSnapshot, verifyChunk, verifyManifest, type SnapshotChunk } from '../src/app/core/snapshot.ts';
import type { OperationDraft } from '../src/app/core/tx.ts';
import { CORE_TYPES, TYPE } from '../src/app/core/types.ts';
import { decode } from '../src/codec/reader.ts';
import { toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { WorkerVerifier } from '../src/crypto/verifier.ts';
import type { ObjectDatabase } from '../src/db/database.ts';
import { objectId } from '../src/db/id.ts';
import { verifyKeyProof, verifyObjectProof } from '../src/db/proof.ts';
import { Node } from '../src/node/node.ts';
import { MemoryHub } from '../src/p2p/memory.ts';
import { RpcClient } from '../src/rpc/client.ts';
import { RpcServer } from '../src/rpc/server.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
import type { Genesis } from '../src/types/genesis.ts';
import { silentLogger } from '../src/util/log.ts';
import { bench, fact, fmtBytes, fmtMs, suite } from './harness.ts';
import { seed } from './fixtures.ts';
import { accountName, buildBigState, CHAIN_ID, dirSize, MB, memory, POOL } from './bigstate.ts';

const TIMEOUTS = { proposeMs: 400, proposeDeltaMs: 200, prevoteMs: 200, prevoteDeltaMs: 100, precommitMs: 200, precommitDeltaMs: 100, commitMs: 50, gossipMs: 150 };
const NETWORK = { connectIntervalMs: 100, pingIntervalMs: 1000, idleTimeoutMs: 5000, desiredOutbound: 16, maxInbound: 32 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(): Promise<void> {
  suite(`scale (${MB} MB genesis)`);
  const dir = mkdtempSync(join(tmpdir(), 'crosschain-scale-'));
  const verifier = new WorkerVerifier();
  try {
    const big = await buildBigState(dir, verifier);
    const { app, env, keys } = big;
    const N = big.accounts;
    fact('state built', big.summary);
    const rnd = () => Math.floor(Math.random() * N);
    /** A random account other than `from`. */
    const other = (from: number) => {
      let to = rnd();
      while (to === from) to = rnd();
      return to;
    };
    let serial = 0n;
    /** A transaction from account `from`, signed with its active key. */
    const sign = (from: number, ops: OperationDraft[], expiration: bigint) => signedTxBytes(CHAIN_ID, { expiration, operations: withFees(ops, app.feeSchedule()) }, [keys[(2 * from + 1) % POOL]!]);
    const transfer = (from: number, to: number): OperationDraft => ({ type: 'transfer', from: objectId(TYPE.account, from), to: objectId(TYPE.account, to), asset: app.coreAsset, amount: 1n + serial++ });

    // ---- A single validator carrying this state, serving RPC while it produces blocks.
    let t = performance.now();
    const expiry = BigInt(Date.now()) + 600_000n;
    const single = Array.from({ length: 4000 }, () => {
      const from = rnd();
      return sign(from, [transfer(from, other(from))], expiry);
    });
    fact('4,000 single transfers from random accounts signed', fmtMs(performance.now() - t));
    const hub = new MemoryHub();
    const valSeed = seed('scale/val');
    const nodeGenesis: Genesis = { ...big.genesis, validators: [{ publicKey: keyPairFromSeed(valSeed).publicKey, power: 10n, name: 'v0' }] };
    const node = await Node.create({ name: 'big', genesis: nodeGenesis, dataDir: null, app, nodeKeySeed: seed('scale/node'), validatorSeed: valSeed, transport: hub.transport('big:1'), listenAddr: 'big:1', seeds: [], verifier, timeouts: TIMEOUTS, network: NETWORK, snapshotInterval: 0, log: silentLogger });
    await node.start();
    while (node.height < 2n) await sleep(20);
    const server = new RpcServer(node, { port: 0, limits: { ratePerSecond: 1e9, burst: 1e9, costlyCost: 1, maxStreams: 100 } });
    await server.start();
    const rpc = new RpcClient(server.url);
    let committed = 0;
    let blocks = 0;
    node.executor.onCommitted((block) => {
      blocks++;
      committed += block.txs.length;
    });
    const readers = async (seconds: number, clients: number, call: () => Promise<unknown>) => {
      let n = 0;
      const until = performance.now() + seconds * 1000;
      await Promise.all(Array.from({ length: clients }, async () => {
        while (performance.now() < until) {
          await call();
          n++;
        }
      }));
      return n / seconds;
    };
    for (const [what, call] of [
      ['account by name with a name proof', () => rpc.account(accountName(rnd()), true)],
      ['object by id with an object proof', () => rpc.call('object', { id: `3.${rnd()}`, prove: true })],
      ['account history, newest 20', () => rpc.call('accountHistory', { account: accountName(rnd()), limit: 20, reverse: true })],
      ['status', () => rpc.status()],
    ] as [string, () => Promise<unknown>][]) {
      fact(`rpc ${what}, 16 clients, idle chain`, `${(await readers(3, 16, call)).toFixed(0)} calls/s`);
    }
    const submit = async (txs: Uint8Array[], clients: number) => {
      let next = 0;
      let rejected = 0;
      await Promise.all(Array.from({ length: clients }, async () => {
        while (next < txs.length) {
          try {
            await rpc.broadcastTx(toHex(txs[next++]!), 'sync');
          } catch {
            rejected++;
          }
        }
      }));
      return rejected;
    };
    const c0 = committed;
    const b0 = blocks;
    t = performance.now();
    const rejected = await submit(single.slice(0, 2000), 16);
    while (committed - c0 < 2000 - rejected && performance.now() - t < 60_000) await sleep(20);
    let elapsed = (performance.now() - t) / 1000;
    fact('rpc broadcastTx of 2,000 transfers, 16 clients, until all are committed', `${fmtMs(elapsed * 1000)}: ${((committed - c0) / elapsed).toFixed(0)} tx/s, ${blocks - b0} blocks, ${rejected} rejected`);
    const c1 = committed;
    const b1 = blocks;
    let reads = 0;
    t = performance.now();
    const stop = { done: false };
    const readLoop = Promise.all(Array.from({ length: 8 }, async () => {
      while (!stop.done) {
        await rpc.account(accountName(rnd()), true);
        reads++;
      }
    }));
    const rejected2 = await submit(single.slice(2000), 16);
    while (committed - c1 < 2000 - rejected2 && performance.now() - t < 60_000) await sleep(20);
    stop.done = true;
    await readLoop;
    elapsed = (performance.now() - t) / 1000;
    fact('the same with 8 clients reading accounts with proofs throughout', `${fmtMs(elapsed * 1000)}: ${((committed - c1) / elapsed).toFixed(0)} tx/s, ${blocks - b1} blocks, ${(reads / elapsed).toFixed(0)} reads/s`);
    await server.stop();
    await node.stop();
    fact('memory after the node session', await memory());

    // ---- Blocks of batch transfers touching accounts all over the state.
    const BLOCKS = 8;
    const TXS = 300;
    const OPS = 8;
    t = performance.now();
    const batchExpiry = app.dynamic().time + 3_600_000n;
    const batches = Array.from({ length: BLOCKS }, () =>
      Array.from({ length: TXS }, () => {
        const from = rnd();
        return sign(from, Array.from({ length: OPS }, () => transfer(from, other(from))), batchExpiry);
      }),
    );
    fact(`${BLOCKS * TXS} transactions of ${OPS} transfers each signed`, fmtMs(performance.now() - t));
    const disk0 = dirSize(join(dir, 'lmdb'));
    const mem0 = process.memoryUsage().heapUsed;
    const times = { check: 0, finalize: 0, commit: 0 };
    let applied = 0;
    for (const txs of batches) {
      t = performance.now();
      let next = 0;
      await Promise.all(Array.from({ length: 32 }, async () => {
        while (next < txs.length) {
          const r = await app.checkTx(txs[next++]!);
          if (!r.ok) throw new Error(r.error);
        }
      }));
      times.check += performance.now() - t;
      t = performance.now();
      const r = await app.finalizeBlock({ height: app.lastHeight + 1n, time: app.dynamic().time + 1000n, txs, proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });
      times.finalize += performance.now() - t;
      if (r.txResults.some((x) => !x.ok)) throw new Error('a batch failed: ' + r.txResults.find((x) => !x.ok)?.error);
      applied += txs.length * OPS;
      t = performance.now();
      await app.commit();
      times.commit += performance.now() - t;
    }
    fact(`${BLOCKS} blocks of ${TXS} x ${OPS} scattered transfers`, `per block: checkTx ${fmtMs(times.check / BLOCKS)}, finalize ${fmtMs(times.finalize / BLOCKS)}, commit ${fmtMs(times.commit / BLOCKS)}; ${(applied / ((times.finalize + times.commit) / 1000)).toFixed(0)} transfers/s applied`);
    fact('growth over those blocks', `LMDB +${fmtBytes(dirSize(join(dir, 'lmdb')) - disk0)}, heap-used delta +${fmtBytes(Math.max(0, process.memoryUsage().heapUsed - mem0))} (not an isolated measure of the ${BLOCKS} retained versions)`);

    // ---- Proofs at past heights and account history, now that there is history.
    const h = Number(app.lastHeight);
    const lowest = Number(app.lowestProvableHeight);
    const past = () => Math.max(lowest, h - 1 - Math.floor(Math.random() * (BLOCKS - 1)));
    await bench('object proof at a past height + verify', { batch: 100 }, () => {
      for (let i = 0; i < 100; i++) {
        const v = past();
        if (!verifyObjectProof(app.db.rootAt(v), app.proofAt(objectId(TYPE.account, rnd()), BigInt(v)))) throw new Error('bad proof');
      }
    });
    await bench('name proof at a past height + verify', { batch: 100 }, () => {
      for (let i = 0; i < 100; i++) {
        const v = past();
        if (verifyKeyProof(app.db.rootAt(v), app.proveAccountName(accountName(rnd()), BigInt(v))) === undefined) throw new Error('bad proof');
      }
    });
    await bench('account history, newest 20 entries of random accounts (most have none)', { batch: 100 }, () => {
      for (let i = 0; i < 100; i++) app.accountHistory(objectId(TYPE.account, rnd()), 0n, 20, true);
    });

    // ---- State sync: export, fetch and verify every chunk, rebuild, write, open, as a joining node does.
    t = performance.now();
    app.takeSnapshot();
    const exportMs = performance.now() - t;
    const height = app.lastHeight;
    const manifest = decode(app.manifestBytes(height)!, decodeManifest);
    if (verifyManifest(app.lastAppHash, manifest)) throw new Error('manifest does not verify');
    t = performance.now();
    let chunks: SnapshotChunk[] | null = [];
    let chunkBytes = 0;
    for (const ty of manifest.types) {
      for (let i = 0; i < ty.chunkHashes.length; i++) {
        const raw = app.chunkBytes(height, ty.type, i)!;
        chunkBytes += raw.length;
        const v = verifyChunk(manifest, raw);
        if ('error' in v) throw new Error(v.error);
        chunks.push(v.chunk);
      }
    }
    const verifyMs = performance.now() - t;
    t = performance.now();
    let imported: ObjectDatabase | null = importSnapshot(manifest, chunks, CORE_TYPES, { retainVersions: 100 });
    const importMs = performance.now() - t;
    chunks = null;
    const env2 = new LmdbEnv(join(dir, 'synced'));
    const kv2 = env2.store('app');
    t = performance.now();
    CoreApp.writeImportedState(kv2, imported, height, manifest.appHash);
    const writeMs = performance.now() - t;
    imported = null; // a joining node is done with it here too: what follows reopens the store
    t = performance.now();
    const synced = new CoreApp({ genesis: big.genesis, verifier, kv: kv2, snapshotInterval: 0 });
    const openMs = performance.now() - t;
    if (toHex(synced.lastAppHash) !== toHex(app.lastAppHash)) throw new Error('synced state differs');
    fact(`state sync pipeline, local, ${chunkCount(manifest)} chunks (${fmtBytes(chunkBytes)}) at height ${height}`, `export ${fmtMs(exportMs)}, read + verify chunks ${fmtMs(verifyMs)}, rebuild + check roots ${fmtMs(importMs)}, write to LMDB ${fmtMs(writeMs)}, open ${fmtMs(openMs)}: ${fmtMs(exportMs + verifyMs + importMs + writeMs + openMs)} in all (no peer transfer or header verification)`);
    fact('memory with the original and the synced state loaded', await memory());
    await env2.close();
    await env.close();
  } finally {
    await verifier.close();
    if (process.env.BENCH_KEEP) console.log(`kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}
