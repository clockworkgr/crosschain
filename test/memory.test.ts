import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { appGenesisBytes, authorityJson } from '../src/app/core/genesis.ts';
import { TYPE } from '../src/app/core/types.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { objectId } from '../src/db/id.ts';
import { proofToBytes } from '../src/db/proof.ts';
import { GcScheduler, heapInUse, heapLimitFlag, MemoryGuard, memoryStats, type MemoryLevel, type MemoryStats } from '../src/node/memory.ts';
import { RpcClient } from '../src/rpc/client.ts';
import { RpcServer } from '../src/rpc/server.ts';
import { silentLogger } from '../src/util/log.ts';
import { makeTestnet, seedFor, sleep, tx, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const stats = (heapUsed: number, heapLimit = 1000): MemoryStats => ({ heapUsed, heapLimit, heapTotal: heapLimit, arrayBuffers: 0, external: 0, rss: heapUsed });

describe('memory guard', () => {
  it('moves through its levels with hysteresis and reports every change', () => {
    let heap = 100;
    const seen: MemoryLevel[] = [];
    const guard = new MemoryGuard({ log: silentLogger, stats: () => stats(heap), onLevel: (level) => seen.push(level) });
    expect(guard.level).toBe('ok');
    const at = (used: number): MemoryLevel => {
      heap = used;
      return guard.check();
    };
    expect(at(699)).toBe('ok');
    expect(at(700)).toBe('warn');
    expect(at(849)).toBe('warn');
    expect(at(850)).toBe('pressure');
    expect(at(960)).toBe('critical');
    // Leaving a level takes a step below its threshold, so a heap hovering at one does not flap.
    expect(at(900)).toBe('critical');
    expect(at(899)).toBe('pressure');
    expect(at(800)).toBe('pressure');
    expect(at(799)).toBe('warn');
    expect(at(650)).toBe('warn');
    expect(at(649)).toBe('ok');
    // Several levels at once, both ways.
    expect(at(999)).toBe('critical');
    expect(at(0)).toBe('ok');
    expect(seen).toEqual(['warn', 'pressure', 'critical', 'pressure', 'warn', 'ok', 'critical', 'ok']);
    expect(guard.stats.heapUsed).toBe(0);
    expect(() => new MemoryGuard({ log: silentLogger, warnAt: 0.9, pressureAt: 0.8 })).toThrow(/thresholds/);
    const real = memoryStats();
    expect(real.heapLimit).toBeGreaterThan(real.heapUsed);
  });

  it('takes its levels from the old generation when the sample gives it, whatever the young generation holds', () => {
    // A heap limit that is the old generation's: garbage in the young generation is not on its way to it.
    let sample: MemoryStats = { ...stats(990), heapOld: 100 };
    const logged: Record<string, unknown>[] = [];
    const guard = new MemoryGuard({ log: (_level, _msg, fields) => void logged.push(fields!), stats: () => sample });
    expect(guard.check()).toBe('ok');
    sample = { ...stats(990), heapOld: 860 };
    expect(guard.check()).toBe('pressure');
    expect(logged[0]).toMatchObject({ level: 'pressure', heap: '0/0 MiB' });
    sample = { ...stats(400 * 1048576, 1000 * 1048576), heapOld: 300 * 1048576 };
    expect(guard.check()).toBe('ok');
    expect(logged[1]).toMatchObject({ level: 'ok', heap: '300/1000 MiB' });
    expect(heapInUse(sample)).toBe(300 * 1048576);
    expect(heapInUse(stats(7))).toBe(7);
    // The process's own sample has the figure only under a limit set for the old generation.
    const real = memoryStats();
    expect(real.heapOld === undefined).toBe(heapLimitFlag() === null);
    if (real.heapOld !== undefined) expect(real.heapOld).toBeLessThanOrEqual(real.heapUsed);
  });

  it('schedules a minor collection after every commit and a major one once the heap has grown enough', async () => {
    let heap = 100;
    const calls: string[] = [];
    const gc = (o?: { type?: 'major' | 'minor'; execution?: 'sync' | 'async' }) => {
      calls.push(`${o?.type}/${o?.execution}`);
      return o?.execution === 'async' ? Promise.resolve() : undefined;
    };
    const s = new GcScheduler({ log: silentLogger, gc, stats: () => stats(heap, 1000), majorGrowthBytes: 50, observe: false });
    expect(s.available).toBe(true);
    s.afterCommit();
    expect(calls).toEqual(['minor/sync']);
    heap = 149; // grown 49 since the start: not yet
    s.afterCommit();
    expect(calls).toEqual(['minor/sync', 'minor/sync']);
    heap = 150;
    s.afterCommit();
    await sleep(0);
    expect(calls).toEqual(['minor/sync', 'minor/sync', 'minor/sync', 'major/async']);
    // The growth is measured from the heap after the last major collection.
    heap = 199;
    s.afterCommit();
    await sleep(0);
    expect(calls.filter((c) => c.startsWith('major')).length).toBe(1);
    heap = 200;
    s.afterCommit();
    await sleep(0);
    expect(calls.filter((c) => c.startsWith('major')).length).toBe(2);
    // The fraction of the limit caps the growth step: 10% of 1000 is 100, less than 500.
    const capped: string[] = [];
    const s2 = new GcScheduler({ log: silentLogger, gc: (o) => void capped.push(o?.type ?? ''), stats: () => stats(heap, 1000), majorGrowthBytes: 500, observe: false });
    heap = 300;
    s2.afterCommit();
    expect(capped).toEqual(['minor', 'major']);
    expect(s.stats()).toMatchObject({ available: true, scheduledMinor: 5, scheduledMajor: 2 });

    // Without --expose-gc nothing is scheduled, and that is reported rather than thrown.
    const off = new GcScheduler({ log: silentLogger, gc: null, observe: false });
    off.afterCommit();
    await off.major();
    expect(off.stats()).toMatchObject({ available: false, scheduledMinor: 0, scheduledMajor: 0 });
  });

  it('counts the collections V8 runs, scheduled or not', async () => {
    const s = new GcScheduler({ log: silentLogger, gc: null });
    s.start();
    // Enough garbage for several young-generation collections.
    let keep: unknown[] = [];
    for (let i = 0; i < 300_000; i++) keep.push({ i, s: 'x'.repeat(40) });
    keep = [];
    await waitFor(() => s.stats().collections > 0, 5_000, 'a collection to be observed');
    const st = s.stats();
    expect(st.minor + st.major + st.incremental).toBeGreaterThan(0);
    expect(st.totalMs).toBeGreaterThan(0);
    expect(st.maxMs).toBeGreaterThanOrEqual(st.lastMs);
    s.stop();
  });
});

describe('a node under memory pressure', () => {
  let net: Testnet | null = null;
  let server: RpcServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
    await net?.stop();
    net = null;
  });

  it('sheds load, keeps following the chain, and resumes when the heap eases', async () => {
    const faucet = keyPairFromSeed(seedFor('memory/faucet'));
    net = await makeTestnet({
      validators: 2,
      fullNodes: 1,
      skipStart: [2],
      appFor: (_i, _d, genesis) => new CoreApp({ genesis, verifier }),
      appState: new TextDecoder().decode(appGenesisBytes({ accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '1000000000' }], staking: { inflationMinBps: 0, inflationMaxBps: 0 } })),
    });
    let heap = 100;
    let limit = 1000;
    const logged: string[] = [];
    const watched = await net.makeNode(2, { memory: { stats: () => stats(heap, limit), intervalMs: 20 }, log: (_level, msg) => void logged.push(msg) });
    net.nodes.push(watched);
    const levels: MemoryLevel[] = [];
    watched.onMemory((level) => levels.push(level));
    await watched.start();
    server = new RpcServer(watched, { port: 0 });
    await server.start();
    const rpc = new RpcClient(server.url);
    await waitForHeight([watched], 2n);
    expect(watched.memoryLevel).toBe('ok');
    const app = watched.app as CoreApp;
    expect(app.db.memory().hotLimit).toBe(Infinity);
    expect(((await rpc.call('status', {})) as { memory: { level: string; shedding: boolean; database: { hotObjects: number } }; gc: { available: boolean } }).memory).toMatchObject({ level: 'ok', shedding: false });

    // At `warn` the node pages what its blocks do not need, and sheds nothing: the index trees are dropped and the
    // window of past versions is cut to the last two, the Merkle trees stay, the mempool admits up to half its limit.
    heap = 750; // 75% of the limit
    await waitFor(() => watched.memoryLevel === 'warn', 5_000, 'the warn level');
    expect(watched.isShedding).toBe(false);
    // (TREES=0 runs the suite with the Merkle trees dropped from the start.)
    expect(app.db.memory()).toMatchObject({ indexTrees: 'dropped', trees: process.env.TREES === '0' ? 'dropped' : 'resident', history: 'trimmed', historyWindow: 2 });
    expect(app.db.memory().hotLimit).toBe(100_000);
    expect(watched.mempool.currentLimit).toBe(watched.mempool.maxTxs / 2);
    expect(await rpc.call('block', {})).toBeTruthy();

    heap = 900; // 90% of the limit
    await waitFor(() => watched.isShedding, 5_000, 'the node to shed load');
    expect(watched.memoryLevel).toBe('pressure');
    // The first dial: the database's cache of decoded objects is capped, and the excess evicted at once.
    expect(app.db.memory().hotLimit).toBe(10_000);
    expect(app.db.memory().hotObjects).toBeLessThanOrEqual(10_000);
    // The index trees stay dropped and the window trimmed, as from `warn`, and now the Merkle trees are dropped too:
    // every root and proof reads its paths from the store.
    expect(app.db.memory().indexTrees).toBe('dropped');
    expect(app.db.memory().trees).toBe('dropped');
    expect(app.db.memory()).toMatchObject({ history: 'trimmed', historyWindow: 2 });
    // The mempool is not paused but admits up to a tenth of its limit; filled to that, it refuses as full, and the
    // RPC says to try again rather than that the transaction is bad.
    expect(watched.mempool.paused).toBe(false);
    expect(watched.mempool.currentLimit).toBe(watched.mempool.maxTxs / 10);
    watched.mempool.setLimit(0);
    expect((await watched.submitTx(tx('set a=1'))).status).toBe('full');
    await expect(rpc.call('broadcastTx', { tx: '0102', mode: 'sync' })).rejects.toMatchObject({ code: -32004 });
    watched.mempool.setLimit(watched.mempool.maxTxs / 10);
    // With room under the lowered limit a broadcast is taken to the application, which is what refuses this one.
    await expect(rpc.call('broadcastTx', { tx: '0102', mode: 'sync' })).rejects.toMatchObject({ code: -32002 });
    await expect(rpc.call('block', {})).rejects.toMatchObject({ code: -32004 });
    expect((await fetch(`${server.url}/events`)).status).toBe(503);
    expect(((await fetch(`${server.url}/health`).then((r) => r.json())) as { memory: string }).memory).toBe('pressure');
    expect(((await rpc.call('status', {})) as { memory: { level: string; shedding: boolean; heapUsed: number } }).memory).toMatchObject({ level: 'pressure', shedding: true, heapUsed: 900, database: { objects: 'capped', indexTrees: 'dropped', trees: 'dropped' } });
    // Consensus is not what is shed: the node keeps following the validators.
    const h = watched.height;
    // Its blocks run against the dropped trees; a hash that differed from the validators' would stop it here.
    await waitFor(() => watched.height >= h + 2n, 15_000, 'the node to keep following the chain while shedding');
    // Proofs at the current height read the dropped trees, and match what a validator with its trees proves.
    const other = net.nodes[0]!.app as CoreApp;
    const at = app.lastHeight;
    await waitFor(() => other.lastHeight >= at, 10_000, 'a validator at the same height');
    expect(Buffer.from(proofToBytes(app.proofAt(objectId(TYPE.account, 0), at))).toString('hex')).toBe(Buffer.from(proofToBytes(other.proofAt(objectId(TYPE.account, 0), at))).toString('hex'));

    // Back under the ok line, but with less room than rebuilding is estimated to take: load shedding ends and the
    // cache is unbounded again, while the trees stay dropped rather than take the heap back up. The room is what is
    // left to half the limit, not to the warn line: either tier would fit under that line here, and would leave the
    // load nothing.
    const estimate = app.db.rebuildEstimate();
    expect(estimate.indexTrees).toBeGreaterThan(0);
    expect(estimate.trees).toBeGreaterThan(0);
    limit = 4 * Math.min(estimate.indexTrees, estimate.trees);
    heap = Math.floor(0.4 * limit); // 30% of the limit to the warn line, more than either tier takes; 10% to half the limit, less than either
    await waitFor(() => !watched.isShedding, 5_000, 'shedding to end');
    expect(watched.memoryLevel).toBe('ok');
    expect(watched.mempool.currentLimit).toBe(watched.mempool.maxTxs);
    expect(app.db.memory().hotLimit).toBe(Infinity);
    // Nothing is even considered at once: the node waits at `ok` for as long as it had run before the drop (a few
    // seconds of samples here), since a load that filled the heap once fills it again.
    const staying = () => logged.filter((m) => m.startsWith('memory: staying paged')).length;
    await sleep(100);
    expect(staying()).toBe(0);
    expect(app.db.memory()).toMatchObject({ indexTrees: 'dropped', trees: 'dropped' });
    // Then it finds no room, says so once however many samples follow, and stays as it is.
    await waitFor(() => staying() === 1, 30_000, 'the node to say it stays paged');
    await sleep(200);
    expect(staying()).toBe(1);
    expect(app.db.memory()).toMatchObject({ indexTrees: 'dropped', trees: 'dropped' });
    // With room, the next sample rebuilds them.
    limit = 4 * (estimate.indexTrees + estimate.trees);
    heap = Math.floor(0.2 * limit);
    await waitFor(() => app.db.memory().trees === 'resident', 5_000, 'the trees to be rebuilt');
    expect(app.db.memory().indexTrees).toBe('resident');
    // And with both back and room left, the window of past versions is let grow again.
    await waitFor(() => app.db.memory().history === 'resident', 5_000, 'the history window to be restored');
    expect(app.accountByName('faucet')?.name).toBe('faucet');
    expect((await watched.submitTx(tx('set a=1'))).status).not.toBe('full'); // refused by the application, not by the limit
    expect(await rpc.call('block', {})).toBeTruthy();
    // Past the critical level the node reports it; what to do then (the CLI stops) is the caller's.
    heap = Math.floor(0.99 * limit);
    await waitFor(() => levels.includes('critical'), 5_000, 'the critical level to be reported');
    // A sample can cross several thresholds at once: 90% to 40% is straight to ok, 20% to 99% straight to critical.
    expect(levels).toEqual(['warn', 'pressure', 'ok', 'critical']);
  });

  it('keeps as many past versions in memory as retain.memoryVersions says, proves the older ones from the store, and leaves the index trees there when told to', async () => {
    const faucet = keyPairFromSeed(seedFor('memory/faucet'));
    net = await makeTestnet({
      validators: 1,
      skipStart: [0],
      appFor: (_i, _d, genesis) => new CoreApp({ genesis, verifier }),
      appState: new TextDecoder().decode(appGenesisBytes({ accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '1000000000' }], staking: { inflationMinBps: 0, inflationMaxBps: 0 } })),
    });
    const node = await net.makeNode(0, { retain: { memoryVersions: 3 }, indexTrees: 'store' });
    net.nodes.push(node);
    await node.start();
    await waitForHeight([node], 8n);
    const app = node.app as CoreApp;
    expect(app.db.memory()).toMatchObject({ history: 'trimmed', historyWindow: 3 });
    // And with indexTrees 'store' the secondary indices are read from the store from the start: a lookup by name works,
    // and nothing waits to be rebuilt.
    expect(app.db.memory().indexTrees).toBe('dropped');
    expect(app.accountByName('faucet')?.name).toBe('faucet');
    await sleep(300);
    expect(app.db.memory().indexTrees).toBe('dropped');
    // The provable window is the store's, not the memory's: a height six back is answered from the history records.
    const at = app.lastHeight;
    expect(app.lowestProvableHeight).toBeLessThanOrEqual(at - 6n);
    expect(app.proofAt(objectId(TYPE.account, 0), at - 6n)).toBeTruthy();
    expect(app.db.rootAt(Number(at - 6n)).length).toBe(32);
  });
});
