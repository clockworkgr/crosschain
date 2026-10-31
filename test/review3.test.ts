/** Regressions for the findings of the 2026-10-31 review: the memory guard, the node and the signature schemes. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { checkAuthority, makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson } from '../src/app/core/genesis.ts';
import { encodeTransaction, txBodyBytes } from '../src/app/core/tx.ts';
import { toHex, sha256 } from '../src/crypto/hash.ts';
import { DEFAULT_SCHEME, isPublicKey, keyPairFromSeed, Scheme, schemeName, signContext, type KeyPair } from '../src/crypto/keys.ts';
import { InlineVerifier, type VerifyJob } from '../src/crypto/verifier.ts';
import { Mempool } from '../src/mempool.ts';
import { Node } from '../src/node/node.ts';
import type { MemoryLevel, MemoryStats } from '../src/node/memory.ts';
import { RpcServer } from '../src/rpc/server.ts';
import { MemoryHub } from '../src/p2p/memory.ts';
import { Network } from '../src/p2p/network.ts';
import { PeerDb } from '../src/p2p/peerdb.ts';
import { KvStoreApp } from '../src/app/kvstore.ts';
import { MemoryEnv } from '../src/store/kv.ts';
import { Keystore } from '../src/wallet/keystore.ts';
import type { Genesis } from '../src/types/genesis.ts';
import { ValidatorSet } from '../src/types/validator.ts';
import { decode } from '../src/codec/reader.ts';
import { encode } from '../src/codec/writer.ts';
import { seedFor, sleep, waitFor } from './helpers.ts';

const genesisTime = 1_700_000_000_000n;
const stats = (heapUsed: number, heapLimit = 1000): MemoryStats => ({ heapUsed, heapLimit, heapTotal: heapLimit, arrayBuffers: 0, external: 0, rss: heapUsed });

function twoAccountGenesis(chainId: string, a: KeyPair, c: KeyPair, scheme = DEFAULT_SCHEME): Genesis {
  const acct = (name: string, k: KeyPair) => ({ name, owner: authorityJson([k.publicKey]), active: authorityJson([k.publicKey]), balance: '1000000000' });
  return {
    chainId,
    signatureScheme: schemeName(scheme),
    genesisTime,
    validators: [{ publicKey: c.publicKey, power: 10n, name: 'v' }],
    appState: appGenesisBytes({ accounts: [acct('alice', a), acct('carol', c)], staking: { inflationMinBps: 0, inflationMaxBps: 0 } }),
  };
}

/** Another valid signature by the same key over the same body: a fresh nonce, which either scheme allows. */
function variantSignature(chainId: string, body: Uint8Array, k: KeyPair): Uint8Array {
  const context = signContext(chainId, 'tx');
  const entropy = crypto.getRandomValues(new Uint8Array(32));
  if (k.scheme === Scheme.mlDsa44) return new Uint8Array([Scheme.mlDsa44, ...ml_dsa44.sign(body, k.secretKey.subarray(1), { context, extraEntropy: entropy })]);
  const digest = sha256(new Uint8Array([context.length]), context, body);
  return new Uint8Array([Scheme.secp256k1, ...secp256k1.sign(digest, k.secretKey.subarray(1), { prehash: false, lowS: true, extraEntropy: entropy })]);
}

describe('the signature cache', () => {
  it('keeps a block result the same when shedding clears the cache while the block verifies', async () => {
    // One block changes alice's authority to a two-key one and then transfers under it. The second transaction's
    // first signature is verified before the block (prewarm, against the old authority it is skipped for b), the
    // rest during it; pressure arriving while the pool works drops the cache in between.
    const a = keyPairFromSeed(seedFor('r3/race/a'));
    const b = keyPairFromSeed(seedFor('r3/race/b'));
    const c = keyPairFromSeed(seedFor('r3/race/c'));
    const genesis = twoAccountGenesis('race', a, c);
    const run = async (pressure: boolean) => {
      let heap = 100;
      let node: Node | null = null;
      let calls = 0;
      const inline = new InlineVerifier();
      const verifier = {
        verifyOne: (job: VerifyJob) => inline.verifyOne(job),
        close: async () => {},
        verify: async (jobs: VerifyJob[]) => {
          calls++;
          if (calls === 2 && pressure) {
            heap = 900;
            node!.memoryGuard.check();
          }
          return inline.verify(jobs);
        },
      };
      node = await Node.create({ name: 'race', genesis, dataDir: null, nodeKeySeed: seedFor('r3/race/node'), validatorSeed: null, transport: new MemoryHub().transport('race:1'), listenAddr: 'race:1', verifier, gc: { gc: null }, log: () => {}, memory: { stats: () => stats(heap) } });
      const app = node.app as CoreApp;
      const alice = app.accountByName('alice')!.id;
      const carol = app.accountByName('carol')!.id;
      const both = makeAuthority([a.publicKey, b.publicKey], 2);
      const sign = (operations: Parameters<typeof withFees>[0], keys: KeyPair[]) => signedTxBytes('race', { expiration: genesisTime + 60_000n, operations: withFees(operations, app.feeSchedule()) }, keys);
      const txs = [sign([{ type: 'accountUpdate', account: alice, owner: null, active: both }], [a]), sign([{ type: 'transfer', from: alice, to: carol, asset: app.coreAsset, amount: 42n }], [a, b])];
      const r = await app.finalizeBlock({ height: 1n, time: genesisTime + 1000n, txs, proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });
      await app.commit();
      const out = { level: node.memoryLevel, results: r.txResults.map((t) => (t.ok ? 'ok' : t.error)), hash: toHex(r.appHash) };
      await node.stop();
      return out;
    };
    const calm = await run(false);
    const pressed = await run(true);
    expect(calm.results).toEqual(['ok', 'ok']);
    expect(pressed.level).toBe('pressure');
    expect(pressed.results).toEqual(['ok', 'ok']);
    expect(pressed.hash).toBe(calm.hash);
  });

  it('holds a bounded number of signatures however many valid variants of one body arrive', async () => {
    const a = keyPairFromSeed(seedFor('r3/variants/a'));
    const c = keyPairFromSeed(seedFor('r3/variants/c'));
    const app = new CoreApp({ genesis: twoAccountGenesis('variants', a, c), verifier: new InlineVerifier() });
    const alice = app.accountByName('alice')!.id;
    const carol = app.accountByName('carol')!.id;
    const body = { expiration: genesisTime + 60_000n, operations: withFees([{ type: 'transfer' as const, from: alice, to: carol, asset: app.coreAsset, amount: 1n }], app.feeSchedule()) };
    const bytes = txBodyBytes(body);
    for (let i = 0; i < 64; i++) await app.checkTx(encodeTransaction({ ...body, signatures: [{ address: a.address, signature: variantSignature('variants', bytes, a) }] }));
    const cache = (app as unknown as { sigCache: Map<string, Map<string, Set<string>>> }).sigCache;
    let held = 0;
    for (const signers of cache.values()) for (const hashes of signers.values()) held += hashes.size;
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThanOrEqual(4);
  });
});

/** Run a script under the given node flags and NODE_OPTIONS; its stdout, trimmed. */
function runNode(flags: string[], nodeOptions: string, script: string): string {
  const r = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', script], { env: { ...process.env, NODE_OPTIONS: nodeOptions }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

describe('the heap limit', () => {
  const memoryTs = new URL('../src/node/memory.ts', import.meta.url).href;
  const guardLimit = (flags: string[], nodeOptions: string) => Number(runNode(flags, nodeOptions, `const m = await import(${JSON.stringify(memoryTs)}); console.log(m.memoryStats().heapLimit / 1048576);`));

  it('is the one Node applies: the command line over NODE_OPTIONS, quoted options, either spelling', () => {
    expect(guardLimit(['--max-old-space-size=256'], '--max-old-space-size=1024')).toBe(256);
    expect(guardLimit(['--max-old-space-size=1024'], '--max-old-space-size=256')).toBe(1024);
    expect(guardLimit([], '"--max-old-space-size=256"')).toBe(256);
    expect(guardLimit(['--max_old_space_size=256'], '')).toBe(256);
    expect(guardLimit([], '--max_old_space_size=300')).toBe(300);
  });

  it('set by the operator in any spelling keeps `start` from putting its own over it', () => {
    const cli = new URL('../src/cli.ts', import.meta.url).pathname;
    for (const option of ['--max-old-space-size=256', '--max_old_space_size=256', '"--max-old-space-size=256"']) {
      const r = spawnSync(process.execPath, [cli, 'start', '/nonexistent-node-directory'], { env: { ...process.env, NODE_OPTIONS: option, CROSSCHAIN_CHILD: '' }, encoding: 'utf8' });
      expect(r.stdout, option).not.toMatch(/running the node under/);
      expect(r.stderr, option).toMatch(/config\.json/); // it ran in place, and found no node there
    }
  });
});

describe('a node at the critical level', () => {
  it('tells a listener added after its first sample the level it is already at', async () => {
    const node = await Node.create({ name: 'crit', genesis: twoAccountGenesis('crit', keyPairFromSeed(seedFor('r3/crit/a')), keyPairFromSeed(seedFor('r3/crit/c'))), dataDir: null, nodeKeySeed: seedFor('r3/crit/node'), validatorSeed: null, transport: new MemoryHub().transport('crit:1'), listenAddr: 'crit:1', gc: { gc: null }, log: () => {}, memory: { stats: () => stats(990), intervalMs: 60_000 } });
    try {
      await node.start();
      expect(node.memoryLevel).toBe('critical');
      const heard: MemoryLevel[] = [];
      node.onMemory((level) => heard.push(level));
      expect(heard).toEqual(['critical']);
    } finally {
      await node.stop();
    }
  });

  it('stops its RPC server even while a client holds a request open', async () => {
    const node = await Node.create({ name: 'rpc', genesis: twoAccountGenesis('rpc', keyPairFromSeed(seedFor('r3/rpc/a')), keyPairFromSeed(seedFor('r3/rpc/c'))), dataDir: null, nodeKeySeed: seedFor('r3/rpc/node'), validatorSeed: null, transport: new MemoryHub().transport('rpc:1'), listenAddr: 'rpc:1', gc: { gc: null }, log: () => {} });
    const server = new RpcServer(node, { port: 0 });
    const port = await server.start();
    // A POST that announces a body and never sends it.
    const socket = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.on('error', () => {});
    socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"jsonrpc"');
    await new Promise((r) => setTimeout(r, 50));
    try {
      const t0 = performance.now();
      const stopped = await Promise.race([server.stop(0).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
      expect(stopped).toBe(true);
      expect(performance.now() - t0).toBeLessThan(1000);
    } finally {
      socket.destroy();
      await node.stop();
    }
  });
});

describe('a mempool paused while transactions are being checked', () => {
  it('refuses the checks that finish after the pause, without pooling, gossiping or remembering them', async () => {
    const a = keyPairFromSeed(seedFor('r3/pause/a'));
    const c = keyPairFromSeed(seedFor('r3/pause/c'));
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const inline = new InlineVerifier();
    const verifier = { verifyOne: (job: VerifyJob) => inline.verifyOne(job), close: async () => {}, verify: async (jobs: VerifyJob[]) => (await held, inline.verify(jobs)) };
    const app = new CoreApp({ genesis: twoAccountGenesis('pause', a, c), verifier });
    const alice = app.accountByName('alice')!.id;
    const carol = app.accountByName('carol')!.id;
    const txs = Array.from({ length: 5 }, (_, i) => signedTxBytes('pause', { expiration: genesisTime + 60_000n, operations: withFees([{ type: 'transfer', from: alice, to: carol, asset: app.coreAsset, amount: BigInt(i + 1) }], app.feeSchedule()) }, [a]));
    const pool = new Mempool(app);
    let gossiped = 0;
    pool.on('tx', () => gossiped++);
    const checks = txs.map((t) => pool.addTx(t));
    pool.pause('node under memory pressure');
    release();
    const results = await Promise.all(checks);
    expect(results.map((r) => r.status)).toEqual(Array(5).fill('paused'));
    expect(pool.size).toBe(0);
    expect(gossiped).toBe(0);
    expect(results.some((r) => pool.seen(r.hash))).toBe(false);
    // Nor did the application keep them in its pending state: once admission resumes, each is new to it.
    pool.resume();
    expect((await pool.addTx(txs[0]!)).status).toBe('added');
  });
});

describe('secp256k1 public keys', () => {
  // Tag, compressed prefix, and an x coordinate past the field prime: the right size, and no point at all.
  const offCurve = new Uint8Array(34).fill(0xff);
  offCurve[0] = Scheme.secp256k1;
  offCurve[1] = 0x02;

  it('are refused wherever a key enters the chain unless they are points on the curve', async () => {
    const a = keyPairFromSeed(seedFor('r3/points/a'), Scheme.secp256k1);
    const c = keyPairFromSeed(seedFor('r3/points/c'), Scheme.secp256k1);
    expect(isPublicKey(a.publicKey)).toBe(true);
    expect(isPublicKey(offCurve)).toBe(false);
    expect(checkAuthority(makeAuthority([offCurve]), Scheme.secp256k1)).toBe('bad public key');
    expect(() => ValidatorSet.create([{ publicKey: offCurve, power: 1n }])).toThrow(/bad public key/);
    const set = ValidatorSet.create([{ publicKey: a.publicKey, power: 1n }]);
    expect(() => set.applyUpdates([{ publicKey: offCurve, power: 1n }])).toThrow(/bad public key/);
    // A set read back from a peer or the store, with the key swapped for the off-curve one.
    const bytes = encode((w) => set.encode(w));
    bytes.set(offCurve, bytes.indexOf(Scheme.secp256k1));
    expect(() => decode(bytes, ValidatorSet.decode)).toThrow(/bad public key/);
    // An account update that would leave the account with a key nothing can sign for.
    const app = new CoreApp({ genesis: twoAccountGenesis('points', a, c, Scheme.secp256k1), verifier: new InlineVerifier() });
    const alice = app.accountByName('alice')!.id;
    const update = signedTxBytes('points', { expiration: genesisTime + 60_000n, operations: withFees([{ type: 'accountUpdate', account: alice, owner: makeAuthority([offCurve]), active: makeAuthority([offCurve]) }], app.feeSchedule()) }, [a]);
    const r = await app.checkTx(update);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bad public key/);
  });
});

describe('a restart with another scheme in genesis', () => {
  it('is refused, by the application state and by the chain state alike', async () => {
    const a = keyPairFromSeed(seedFor('r3/restart/a'), Scheme.secp256k1);
    const c = keyPairFromSeed(seedFor('r3/restart/c'), Scheme.secp256k1);
    const genesis = twoAccountGenesis('restart', a, c, Scheme.secp256k1);
    // The same file with its scheme taken out: ML-DSA-44, the default.
    const { signatureScheme: _, ...withoutScheme } = genesis;
    const open = (env: MemoryEnv, g: Genesis, app?: KvStoreApp) =>
      Node.create({ name: 'restart', genesis: g, dataDir: null, env, app, nodeKeySeed: seedFor('r3/restart/node'), validatorSeed: seedFor('r3/restart/c'), transport: new MemoryHub().transport('restart:1'), listenAddr: 'restart:1', gc: { gc: null }, log: () => {} });
    const core = new MemoryEnv();
    await (await open(core, genesis)).stop();
    await expect(open(core, withoutScheme)).rejects.toThrow(/application state is for a secp256k1 chain/);
    await (await open(core, genesis)).stop(); // the right genesis still opens it
    const kv = new MemoryEnv();
    await (await open(kv, genesis, new KvStoreApp())).stop();
    await expect(open(kv, withoutScheme, new KvStoreApp())).rejects.toThrow(/data directory is for a secp256k1 chain/);
  });
});

describe('the p2p handshake', () => {
  it('connects peers of the chain scheme and refuses a peer keyed under the other one, in either direction', async () => {
    const hub = new MemoryHub();
    const nets: Network[] = [];
    const net = (name: string, scheme: typeof Scheme.mlDsa44 | typeof Scheme.secp256k1, seeds: string[] = []) => {
      const n = new Network({ chainId: 'handshake', nodeKey: keyPairFromSeed(seedFor(`r3/hs/${name}`), scheme), transport: hub.transport(`${name}:1`), listenAddr: `${name}:1`, peerDb: new PeerDb(null, seeds), verifier: new InlineVerifier(), getHeight: () => 0n, log: () => {}, connectIntervalMs: 50, pingIntervalMs: 200, idleTimeoutMs: 1000 });
      nets.push(n);
      return n;
    };
    try {
      const ml = net('ml', Scheme.mlDsa44);
      const ml2 = net('ml2', Scheme.mlDsa44, ['ml:1']);
      const secp = net('secp', Scheme.secp256k1, ['ml:1']); // dials the ML-DSA node
      const secp2 = net('secp2', Scheme.secp256k1);
      const ml3 = net('ml3', Scheme.mlDsa44, ['secp2:1']); // and the other way round
      for (const n of nets) await n.start();
      await waitFor(() => ml.peers.size >= 1 && ml2.peers.size >= 1, 5000, 'the two ML-DSA nodes to connect');
      await sleep(500);
      expect([...ml.peers.keys()]).toEqual([ml2.id]);
      expect(secp.peers.size).toBe(0);
      expect(secp2.peers.size).toBe(0);
      expect(ml3.peers.size).toBe(0);
    } finally {
      await Promise.all(nets.map((n) => n.stop()));
    }
  });
});

describe('a keystore entry whose scheme was changed', () => {
  it('fails to open rather than give another key under the same name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crosschain-keystore-'));
    try {
      const path = join(dir, 'keystore.json');
      const ks = Keystore.create(path, 'pw');
      ks.add('good', undefined, Scheme.mlDsa44);
      const listed = ks.add('secp', undefined, Scheme.secp256k1);
      for (const damage of [(k: Record<string, unknown>) => (k.scheme = 'ml-dsa-44'), (k: Record<string, unknown>) => delete k.scheme]) {
        const file = JSON.parse(readFileSync(path, 'utf8'));
        const original = { ...file.keys.secp };
        damage(file.keys.secp);
        writeFileSync(path, JSON.stringify(file));
        const reopened = Keystore.open(path, 'pw');
        expect(reopened.get('good').scheme).toBe(Scheme.mlDsa44);
        expect(() => reopened.get('secp')).toThrow(/does not derive the public key and address recorded/);
        file.keys.secp = original;
        writeFileSync(path, JSON.stringify(file));
        expect(toHex(Keystore.open(path, 'pw').get('secp').address)).toBe(toHex(listed.address));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CHAIN_SCHEME', () => {
  it('is not read by the node code, so a stray value cannot stop a node from starting', () => {
    const keysTs = new URL('../src/crypto/keys.ts', import.meta.url).href;
    const nodeTs = new URL('../src/node/node.ts', import.meta.url).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(nodeTs)}); const k = await import(${JSON.stringify(keysTs)}); console.log(k.DEFAULT_SCHEME);`], { env: { ...process.env, CHAIN_SCHEME: 'not-a-scheme' }, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe(String(Scheme.mlDsa44));
  });
});
