/**
 * Whole nodes: four validators on the in-process transport sharing one
 * verification pool. First the engine alone with empty blocks, then the core
 * application under a steady stream of signed transfers, then a fifth node
 * catching up through block sync.
 */
import { DEFAULT_SCHEME, schemeName } from '../src/crypto/keys.ts';
import { CoreApp } from '../src/app/core/app.ts';
import { KvStoreApp } from '../src/app/kvstore.ts';
import { encode } from '../src/codec/writer.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { WorkerVerifier } from '../src/crypto/verifier.ts';
import { Node } from '../src/node/node.ts';
import { MemoryHub } from '../src/p2p/memory.ts';
import { encodeBlock } from '../src/types/block.ts';
import type { Genesis } from '../src/types/genesis.ts';
import { makeLogger, silentLogger, type LogLevel } from '../src/util/log.ts';
import { fact, fmtBytes, fmtMs, suite } from './harness.ts';
import { makeGenesis, nodeSeed, signedTransfers, validatorSeed } from './fixtures.ts';

const TIMEOUTS = { proposeMs: 400, proposeDeltaMs: 200, prevoteMs: 200, prevoteDeltaMs: 100, precommitMs: 200, precommitDeltaMs: 100, commitMs: 50, gossipMs: 150 };
const NETWORK = { connectIntervalMs: 100, pingIntervalMs: 1000, idleTimeoutMs: 5000, desiredOutbound: 16, maxInbound: 32 };

async function makeNet(genesis: Genesis, validators: number, verifier: WorkerVerifier, engineOnly: boolean) {
  const hub = new MemoryHub();
  hub.latencyMs = 1;
  const addrs = Array.from({ length: validators }, (_, i) => `v${i}:1`);
  const nodes: Node[] = [];
  for (let i = 0; i < validators; i++) {
    nodes.push(
      await Node.create({
        name: `v${i}`,
        genesis,
        dataDir: null,
        app: engineOnly ? new KvStoreApp(null) : undefined,
        nodeKeySeed: nodeSeed(i),
        validatorSeed: validatorSeed(i),
        transport: hub.transport(addrs[i]!),
        listenAddr: addrs[i]!,
        seeds: addrs.filter((a) => a !== addrs[i]),
        verifier,
        timeouts: TIMEOUTS,
        network: NETWORK,
        lagGraceMs: 500,
        snapshotInterval: 0,
        log: silentLogger,
      }),
    );
  }
  for (const n of nodes) await n.start();
  return { hub, addrs, nodes };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(): Promise<void> {
  suite('network');
  const verifier = new WorkerVerifier();

  // Engine only: how fast four validators agree on empty blocks with the fast timeouts.
  {
    const genesis: Genesis = {
      chainId: 'bench-engine',
      signatureScheme: schemeName(DEFAULT_SCHEME),
      genesisTime: BigInt(Date.now()) - 1000n,
      validators: Array.from({ length: 4 }, (_, i) => ({ publicKey: keyPairFromSeed(validatorSeed(i)).publicKey, power: 10n, name: `v${i}` })),
      appState: new TextEncoder().encode('{}'),
    };
    const net = await makeNet(genesis, 4, verifier, true);
    const n0 = net.nodes[0]!;
    while (n0.height < 2n) await sleep(20);
    const h0 = n0.height;
    const seconds = 8;
    const t0 = performance.now();
    await sleep(seconds * 1000);
    const elapsed = (performance.now() - t0) / 1000;
    const blocks = Number(n0.height - h0);
    fact(`engine only: empty blocks in ${seconds} s (commit timeout ${TIMEOUTS.commitMs} ms)`, `${blocks} blocks, ${(blocks / elapsed).toFixed(1)} blocks/s, ${fmtMs((elapsed * 1000) / Math.max(1, blocks))} per block`);
    for (const n of net.nodes) await n.stop();
  }

  // The core application under load: a client keeps one node's mempool topped up with pre-signed transfers.
  {
    const genesis = makeGenesis(4, BigInt(Date.now()) - 1000n);
    const txs = signedTransfers(6000, BigInt(Date.now()) + 600_000n);
    const net = await makeNet(genesis, 4, verifier, false);
    const n0 = net.nodes[0]!;
    while (n0.height < 2n) await sleep(20);
    let committed = 0;
    let failed = 0;
    let blocks = 0;
    let maxBlockBytes = 0;
    let maxTxs = 0;
    n0.executor.onCommitted((block, _commit, results) => {
      blocks++;
      committed += block.txs.length;
      failed += results.filter((r) => !r.ok).length;
      maxTxs = Math.max(maxTxs, block.txs.length);
      if (block.txs.length > 0) maxBlockBytes = Math.max(maxBlockBytes, encode((w) => encodeBlock(w, block)).length);
    });
    // A client keeps two blocks' worth of transfers ahead of the chain, submitting in parallel, until all are in.
    let next = 0;
    let rejected = 0;
    const t0 = performance.now();
    const blocks0 = blocks;
    const feeder = setInterval(() => {
      if (next - committed >= 3000 || next >= txs.length) return;
      const batch = txs.slice(next, Math.min(next + 200, txs.length));
      next += batch.length;
      for (const t of batch) void n0.submitTx(t).then((r) => void (r.status === 'invalid' && rejected++));
    }, 20);
    while (committed < txs.length && performance.now() - t0 < 120_000) await sleep(50); // committed counts every included transaction, failed ones too
    if (committed < txs.length) throw new Error(`only ${committed} of ${txs.length} transfers were committed in two minutes`);
    clearInterval(feeder);
    const elapsed = (performance.now() - t0) / 1000;
    const loaded = blocks - blocks0;
    fact(`core app: ${txs.length.toLocaleString('en-US')} transfers submitted to one node, time until all are committed`, `${fmtMs(elapsed * 1000)}: ${(committed / elapsed).toFixed(0)} tx/s, ${loaded} blocks (${(loaded / elapsed).toFixed(2)} blocks/s), ${(committed / Math.max(1, loaded)).toFixed(0)} txs per block on average, largest ${maxTxs} txs / ${fmtBytes(maxBlockBytes)}`);
    fact('core app: submitted / rejected / failed in block / left queued', `${next} / ${rejected} / ${failed} / ${n0.mempool.size}`);
    const heights = net.nodes.map((n) => n.height);
    fact('core app: heights at the end', heights.map((h) => h.toString()).join(' '));

    // A fifth node joins and catches up by block sync, verifying every block's commit and every transaction.
    const target = n0.height;
    const late = await Node.create({
      name: 'late',
      genesis,
      dataDir: null,
      nodeKeySeed: nodeSeed(99),
      validatorSeed: null,
      transport: net.hub.transport('late:1'),
      listenAddr: 'late:1',
      seeds: net.addrs,
      verifier,
      timeouts: TIMEOUTS,
      network: NETWORK,
      lagGraceMs: 100,
      snapshotInterval: 0,
      log: process.env.BENCH_LOG ? makeLogger('late', process.env.BENCH_LOG as LogLevel) : silentLogger,
    });
    const t1 = performance.now();
    await late.start();
    while (late.height < target) await sleep(20);
    const syncMs = performance.now() - t1;
    const synced = Number(target);
    const syncedTxs = committed;
    fact(`block sync: ${synced} blocks holding ${syncedTxs.toLocaleString('en-US')} transfers`, `${fmtMs(syncMs)}: ${(synced / (syncMs / 1000)).toFixed(1)} blocks/s, ${(syncedTxs / (syncMs / 1000)).toFixed(0)} tx/s`);
    const lateApp = late.app as CoreApp;
    const app0 = n0.app as CoreApp;
    const sameHeight = lateApp.lastHeight === app0.lastHeight;
    const agree = sameHeight && lateApp.lastAppHash.every((b, i) => b === app0.lastAppHash[i]);
    if (sameHeight && !agree) throw new Error('the synced node disagrees with the validators on the app hash');
    fact('block sync: app hash agrees with the validators', sameHeight ? 'yes' : `not compared: heights ${lateApp.lastHeight} and ${app0.lastHeight}`);
    await late.stop();
    for (const n of net.nodes) await n.stop();
    await sleep(200);
  }
  await verifier.close();
}
