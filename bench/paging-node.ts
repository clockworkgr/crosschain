/**
 * The node half of the paging suite (paging.bench.ts), run in a child process
 * so that its heap limit is real: `node --max-old-space-size=<MiB>
 * bench/paging-node.ts <dir> <accounts> <seconds>`. It opens the state the
 * parent built in <dir>, starts a single validator over it with the memory
 * guard as a node runs it, keeps its mempool fed with transfers among random
 * accounts, and prints one JSON line per two seconds (blocks, transfers, the
 * guard's level, each tier's mode, the heap), one per guard message, and a
 * summary at the end.
 */
import './scheme.ts';
import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import type { CoreApp } from '../src/app/core/app.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { TYPE } from '../src/app/core/types.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { WorkerVerifier } from '../src/crypto/verifier.ts';
import { objectId } from '../src/db/id.ts';
import { Node } from '../src/node/node.ts';
import { heapInUse, memoryStats } from '../src/node/memory.ts';
import { MemoryHub } from '../src/p2p/memory.ts';
import { loadGenesisFile, type Genesis } from '../src/types/genesis.ts';
import { seed } from './fixtures.ts';
import { CHAIN_ID, POOL, poolKeys } from './bigstate.ts';

const TIMEOUTS = { proposeMs: 400, proposeDeltaMs: 200, prevoteMs: 200, prevoteDeltaMs: 100, precommitMs: 200, precommitDeltaMs: 100, commitMs: 50, gossipMs: 150 };
const NETWORK = { connectIntervalMs: 100, pingIntervalMs: 1000, idleTimeoutMs: 5000, desiredOutbound: 16, maxInbound: 32 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MiB = (n: number) => Math.round(n / 1048576);
const emit = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

const [dir, accountsArg, secondsArg] = process.argv.slice(2);
const N = Number(accountsArg);
const seconds = Number(secondsArg ?? 40);
/** How many transfers the feeder keeps ahead of the chain (about two blocks by default), and how often a window is reported. */
const AHEAD = Number(process.env.BENCH_PAGING_AHEAD ?? 1000);
const WINDOW_S = Number(process.env.BENCH_PAGING_WINDOW ?? 2);
/** BENCH_PAGING_ARENA bounds the arena in MiB, as `start --arena` does. */
const ARENA = process.env.BENCH_PAGING_ARENA ? Number(process.env.BENCH_PAGING_ARENA) * 1048576 : undefined;
/** BENCH_PAGING_MEMORY_VERSIONS keeps that many past versions in memory, as `retain.memoryVersions` does. */
const MEMORY_VERSIONS = process.env.BENCH_PAGING_MEMORY_VERSIONS ? Number(process.env.BENCH_PAGING_MEMORY_VERSIONS) : undefined;
/** BENCH_PAGING_PROFILE names a directory: a CPU profile of the run's first 30 seconds and one of its last 30 are written there. */
const PROFILE = process.env.BENCH_PAGING_PROFILE;
const t0 = performance.now();
const verifier = new WorkerVerifier();
const genesis = loadGenesisFile(join(dir!, 'genesis.json'));
const keys = poolKeys();
const start = performance.now();
const valSeed = seed('paging/val');
const nodeGenesis: Genesis = { ...genesis, validators: [{ publicKey: keyPairFromSeed(valSeed).publicKey, power: 10n, name: 'v0' }] };
// The node opens the state the parent built as its own application, in its own environment, as `start` does: under
// the heap limit a state whose trees would not fit below the warn line is opened paged, and a block's writes and
// the application's are one store transaction.
const node = await Node.create({
  name: 'paged',
  genesis: nodeGenesis,
  dataDir: dir!,
  arenaBytes: ARENA,
  indexTrees: process.env.BENCH_PAGING_INDEX_TREES === 'store' ? 'store' : undefined,
  retain: MEMORY_VERSIONS === undefined ? undefined : { memoryVersions: MEMORY_VERSIONS },
  nodeKeySeed: seed('paging/node'),
  validatorSeed: valSeed,
  transport: new MemoryHub().transport('paged:1'),
  listenAddr: 'paged:1',
  seeds: [],
  verifier,
  timeouts: TIMEOUTS,
  network: NETWORK,
  snapshotInterval: 0,
  memory: { intervalMs: 250 },
  // The guard's own messages, with the second they came at, and how the store was opened.
  log: (_level, msg, fields) => {
    if (msg === 'loaded application state') emit({ event: 'log', s: 0, msg: `${msg}${fields?.paged ? `, left in the store: ${fields.paged}` : ', every tier resident'}` });
    else if (msg.startsWith('memory') || msg.startsWith('shedding') || msg.startsWith('load shedding')) emit({ event: 'log', s: Math.round((performance.now() - start) / 100) / 10, msg, ...fields });
  },
});
const app = node.app as CoreApp;
emit({ event: 'opened', ms: Math.round(performance.now() - t0), heap: MiB(heapInUse(memoryStats())), limit: MiB(memoryStats().heapLimit) });
await node.start();
let blocks = 0;
let committed = 0;
const paged = { blocks: 0, txs: 0 };
node.executor.onCommitted((block) => {
  blocks++;
  committed += block.txs.length;
  if (!app.db.treesAreResident) {
    paged.blocks++;
    paged.txs += block.txs.length;
  }
});
let serial = 0n;
let submitted = 0;
let refused = 0;
const expiration = BigInt(Date.now()) + 3_600_000n;
const rnd = () => Math.floor(Math.random() * N);
// Keep about two blocks' worth ahead of the chain; a transfer refused while the mempool is at its lowered limit is not retried.
const feeder = setInterval(() => {
  if (submitted - committed - refused >= AHEAD) return;
  for (let i = 0; i < 200; i++) {
    const from = rnd();
    let to = rnd();
    while (to === from) to = rnd();
    const ops = withFees([{ type: 'transfer', from: objectId(TYPE.account, from), to: objectId(TYPE.account, to), asset: app.coreAsset, amount: 1n + serial++ }], app.feeSchedule());
    submitted++;
    void node.submitTx(signedTxBytes(CHAIN_ID, { expiration, operations: ops }, [keys[(2 * from + 1) % POOL]!])).then(
      (r) => void (r.status !== 'added' && r.status !== 'seen' && refused++),
      () => {}, // still in flight when the verifier closes at the end
    );
  }
}, 20);
let lastBlocks = 0;
let lastTxs = 0;
let lastRefused = 0;
let lastGc = node.gcScheduler.stats();
const levels: string[] = [];
node.onMemory((level) => levels.push(level));
// Windows end by the clock, and report the time they actually took: a sleep runs late by whatever held the event
// loop (a collection, a commit), and rates taken from the nominal seconds would count that time as free.
const runStart = performance.now();
let lastAt = runStart;
const seconds1 = (ms: number) => Math.round(ms / 100) / 10;
if (PROFILE) {
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  const take = (name: string, fromS: number) =>
    setTimeout(() => {
      void (async () => {
        await session.post('Profiler.start');
        await sleep(30_000);
        const { profile } = await session.post('Profiler.stop');
        writeFileSync(join(PROFILE, `${name}.cpuprofile`), JSON.stringify(profile));
      })();
    }, fromS * 1000);
  take('early', 5);
  take('late', seconds - 40);
}
for (let s = WINDOW_S; s <= seconds; s += WINDOW_S) {
  await sleep(Math.max(0, runStart + s * 1000 - performance.now()));
  const now = performance.now();
  const d = app.db.memory();
  const m = memoryStats();
  const gc = node.gcScheduler.stats();
  emit({
    event: 'window',
    s: seconds1(now - runStart),
    ms: Math.round(now - lastAt),
    blocks: blocks - lastBlocks,
    txs: committed - lastTxs,
    refused: refused - lastRefused,
    mempool: node.mempool.size,
    level: node.memoryLevel,
    objects: d.objects,
    indexTrees: d.indexTrees,
    trees: d.trees,
    heap: MiB(heapInUse(m)),
    young: MiB(m.heapUsed - heapInUse(m)),
    limit: MiB(m.heapLimit),
    arrayBuffers: MiB(process.memoryUsage().arrayBuffers),
    rss: MiB(process.memoryUsage().rss),
    arena: MiB(d.arena.capacity),
    stored: d.storedObjects,
    gcPauses: gc.collections - lastGc.collections,
    gcMs: Math.round(gc.totalMs - lastGc.totalMs),
    gcMax: Math.round(gc.maxMs * 10) / 10,
  });
  lastBlocks = blocks;
  lastTxs = committed;
  lastRefused = refused;
  lastGc = gc;
  lastAt = now;
}
clearInterval(feeder);
// Proofs of random accounts at the newest height and at the oldest provable one, which a trimmed window reads from the store's records.
{
  const time = (height: bigint) => {
    const t = performance.now();
    for (let i = 0; i < 20; i++) app.proofAt(objectId(TYPE.account, rnd()), height);
    return Math.round((performance.now() - t) * 5) / 100;
  };
  const d = app.db.memory();
  const oldest = app.lowestProvableHeight;
  emit({ event: 'proofs', height: Number(app.lastHeight), oldest: Number(oldest), window: d.historyWindow, history: d.history, inMemoryFrom: Number(app.lastHeight) - d.historyWindow, newestMs: time(app.lastHeight), oldestMs: time(oldest), middleMs: time((oldest + app.lastHeight) / 2n) });
}
emit({ event: 'summary', seconds: seconds1(performance.now() - runStart), blocks, txs: committed, pagedBlocks: paged.blocks, pagedTxs: paged.txs, submitted, refused, levels: levels.join(' ') });
await node.stop();
// The verifier is not closed: checks of transfers still in flight would fail with it, and exiting ends its workers.
process.exit(0);
