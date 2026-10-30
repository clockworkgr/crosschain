import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { appGenesisBytes, authorityJson } from '../src/app/core/genesis.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { GcScheduler, MemoryGuard, memoryStats, type MemoryLevel, type MemoryStats } from '../src/node/memory.ts';
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
    const watched = await net.makeNode(2, { memory: { stats: () => stats(heap), intervalMs: 20 } });
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

    heap = 900; // 90% of the limit
    await waitFor(() => watched.isShedding, 5_000, 'the node to shed load');
    expect(watched.memoryLevel).toBe('pressure');
    // The first dial: the database's cache of decoded objects is capped, and the excess evicted at once.
    expect(app.db.memory().hotLimit).toBe(10_000);
    expect(app.db.memory().hotObjects).toBeLessThanOrEqual(10_000);
    expect(watched.mempool.paused).toBe(true);
    expect((await watched.submitTx(tx('set a=1'))).status).toBe('paused');
    await expect(rpc.call('broadcastTx', { tx: '0102', mode: 'sync' })).rejects.toMatchObject({ code: -32004 });
    await expect(rpc.call('block', {})).rejects.toMatchObject({ code: -32004 });
    expect((await fetch(`${server.url}/events`)).status).toBe(503);
    expect(((await fetch(`${server.url}/health`).then((r) => r.json())) as { memory: string }).memory).toBe('pressure');
    expect(((await rpc.call('status', {})) as { memory: { level: string; shedding: boolean; heapUsed: number } }).memory).toMatchObject({ level: 'pressure', shedding: true, heapUsed: 900 });
    // Consensus is not what is shed: the node keeps following the validators.
    const h = watched.height;
    await waitFor(() => watched.height >= h + 2n, 15_000, 'the node to keep following the chain while shedding');

    heap = 500;
    await waitFor(() => !watched.isShedding, 5_000, 'shedding to end');
    expect(watched.mempool.paused).toBe(false);
    expect(app.db.memory().hotLimit).toBe(Infinity);
    expect((await watched.submitTx(tx('set a=1'))).status).not.toBe('paused'); // refused by the application, not by the pause
    expect(await rpc.call('block', {})).toBeTruthy();
    // Past the critical level the node reports it; what to do then (the CLI stops) is the caller's.
    heap = 990;
    await waitFor(() => levels.includes('critical'), 5_000, 'the critical level to be reported');
    // A sample can cross several thresholds at once: 10% to 90% is straight to pressure, 90% to 50% straight to ok.
    expect(levels).toEqual(['pressure', 'ok', 'critical']);
  });
});
