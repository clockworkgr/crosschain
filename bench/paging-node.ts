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
import { join } from 'node:path';
import { CoreApp } from '../src/app/core/app.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { TYPE } from '../src/app/core/types.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { WorkerVerifier } from '../src/crypto/verifier.ts';
import { objectId } from '../src/db/id.ts';
import { Node } from '../src/node/node.ts';
import { memoryStats } from '../src/node/memory.ts';
import { MemoryHub } from '../src/p2p/memory.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
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
const t0 = performance.now();
const verifier = new WorkerVerifier();
const env = new LmdbEnv(join(dir!, 'lmdb'));
const genesis = loadGenesisFile(join(dir!, 'genesis.json'));
const app = new CoreApp({ genesis, verifier, kv: env.store('app'), snapshotInterval: 0 });
emit({ event: 'opened', ms: Math.round(performance.now() - t0), heap: MiB(memoryStats().heapUsed), limit: MiB(memoryStats().heapLimit) });

const keys = poolKeys();
const start = performance.now();
const valSeed = seed('paging/val');
const nodeGenesis: Genesis = { ...genesis, validators: [{ publicKey: keyPairFromSeed(valSeed).publicKey, power: 10n, name: 'v0' }] };
const node = await Node.create({
  name: 'paged',
  genesis: nodeGenesis,
  // Blocks in LMDB as a node keeps them, not in the heap the guard watches.
  dataDir: join(dir!, 'node'),
  app,
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
  // The guard's own messages, with the second they came at.
  log: (_level, msg, fields) => {
    if (msg.startsWith('memory') || msg.startsWith('shedding') || msg.startsWith('load shedding')) emit({ event: 'log', s: Math.round((performance.now() - start) / 100) / 10, msg, ...fields });
  },
});
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
// Keep about two blocks' worth ahead of the chain; a transfer refused while the mempool is paused is not retried.
const feeder = setInterval(() => {
  if (submitted - committed - refused >= 1000) return;
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
const levels: string[] = [];
node.onMemory((level) => levels.push(level));
for (let s = 2; s <= seconds; s += 2) {
  await sleep(2000);
  const d = app.db.memory();
  const m = memoryStats();
  emit({ event: 'window', s, blocks: blocks - lastBlocks, txs: committed - lastTxs, level: node.memoryLevel, objects: d.objects, indexTrees: d.indexTrees, trees: d.trees, heap: MiB(m.heapUsed), limit: MiB(m.heapLimit) });
  lastBlocks = blocks;
  lastTxs = committed;
}
clearInterval(feeder);
emit({ event: 'summary', blocks, txs: committed, pagedBlocks: paged.blocks, pagedTxs: paged.txs, submitted, refused, levels: levels.join(' ') });
await node.stop();
await env.close();
// The verifier is not closed: checks of transfers still in flight would fail with it, and exiting ends its workers.
process.exit(0);
