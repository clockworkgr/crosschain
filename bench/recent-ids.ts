/**
 * What the recent transaction ids hold in memory: `node --expose-gc bench/recent-ids.ts [resident]`.
 *
 * Every transaction leaves an id that is removed when its expiration has passed, so the ids that are there are a
 * window that moves up the instance numbers. This makes that window without the transactions: each version creates
 * 1,600 ids and, once 96,000 are there, removes the 1,600 oldest, and the block is written to an LMDB store as the
 * application writes one. The heap and the array buffers are reported after half a million ids, one, two and four
 * million, over what the process held before the first: a figure that rises with the count is memory that follows
 * every transaction ever applied and not the window.
 *
 * By default the database runs as the memory guard leaves it at `pressure`: its cache capped at 10,000 objects,
 * its index trees and Merkle trees dropped, the history window cut to two versions, the arena held to 16 MiB.
 * With `resident` nothing is dropped.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreApp } from '../src/app/core/app.ts';
import { RecentTxType, TYPE } from '../src/app/core/types.ts';
import { InlineVerifier } from '../src/crypto/verifier.ts';
import type { Changes, ObjectDatabase } from '../src/db/database.ts';
import { objectId } from '../src/db/id.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
import { makeGenesis } from './fixtures.ts';

const PER_VERSION = 1600;
const WINDOW = 96_000;
const paged = process.argv[2] !== 'resident';
const collect = (globalThis as { gc?: () => void }).gc;
if (!collect) throw new Error('run with --expose-gc');

const dir = mkdtempSync(join(tmpdir(), 'crosschain-recent-'));
const env = new LmdbEnv(join(dir, 'lmdb'));
const made = new CoreApp({ genesis: makeGenesis(1, 1_700_000_000_000n), verifier: new InlineVerifier(), kv: env.store('app'), snapshotInterval: 0, ...(paged ? { arenaBytes: 16 * 1024 * 1024 } : {}) });
// The application's own steps around a block, without the block: its session over the pending state and its write.
const app = made as unknown as { db: ObjectDatabase; pending: unknown; closePending(): void; persist(p: { changes: Changes; meta: { height: bigint; appHash: Uint8Array }; history: [] }): void };
const db = app.db;
if (paged) {
  db.setHotLimit(10_000);
  db.dropIndexTrees();
  db.dropTrees();
  db.setHistoryWindow(2);
}

const MiB = (n: number) => (n / 1048576).toFixed(1);
async function settled(): Promise<{ heap: number; buffers: number }> {
  for (let i = 0; i < 3; i++) {
    collect!();
    await new Promise((r) => setTimeout(r, 50));
  }
  const m = process.memoryUsage();
  return { heap: m.heapUsed, buffers: m.arrayBuffers };
}

const base = await settled();
console.log(`${paged ? 'paged' : 'resident'}: before the first id, heap ${MiB(base.heap)} MiB, array buffers ${MiB(base.buffers)} MiB`);
let version = 1;
let total = 0;
for (const target of [500_000, 1_000_000, 2_000_000, 4_000_000]) {
  while (total < target) {
    app.closePending();
    const session = db.startSession();
    for (let i = 0; i < PER_VERSION; i++) db.create(RecentTxType, (id) => ({ id, txId: new Uint8Array(randomBytes(32)), expiration: 1_800_000_000_000n + BigInt(version) }));
    if (total >= WINDOW) for (let i = 0; i < PER_VERSION; i++) db.remove(RecentTxType, objectId(TYPE.recentTx, total - WINDOW + i));
    session.commit();
    const appHash = db.root(version);
    app.persist({ changes: db.lastChanges!, meta: { height: BigInt(version), appHash }, history: [] });
    app.pending = db.startSession();
    version++;
    total += PER_VERSION;
  }
  const m = await settled();
  const d = db.memory();
  console.log(`${total} ids made, ${WINDOW} there: heap +${MiB(m.heap - base.heap)} MiB, array buffers +${MiB(m.buffers - base.buffers)} MiB; ${d.treeChunks} tree chunks cached, ${d.hotObjects} objects decoded, arena ${MiB(d.arena.capacity)} MiB`);
}
await env.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
