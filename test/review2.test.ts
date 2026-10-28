import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson, DEFAULT_FEES } from '../src/app/core/genesis.ts';
import { TYPE } from '../src/app/core/types.ts';
import { toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { objectId } from '../src/db/id.ts';
import { LightClient } from '../src/light/client.ts';
import { NodeProvider } from '../src/light/provider.ts';
import { MAX_RECORDS, PeerDb } from '../src/p2p/peerdb.ts';
import { RpcClient } from '../src/rpc/client.ts';
import { headerFromJson, jsonify, parseBigint } from '../src/rpc/json.ts';
import { RpcServer } from '../src/rpc/server.ts';
import { headerHash } from '../src/types/block.ts';
import { Keystore } from '../src/wallet/keystore.ts';
import { makeTestnet, seedFor, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const faucet = keyPairFromSeed(seedFor('review2/faucet'));
const alice = keyPairFromSeed(seedFor('review2/alice'));
const FAUCET_ID = objectId(TYPE.account, 0);

describe('second review: representation and parameters', () => {
  it('refuses a header whose bytes moved between hash fields, and integers a double cannot hold', () => {
    const header = {
      chainId: 'c',
      version: 1,
      height: 5n,
      time: 1_000n,
      lastBlockHash: new Uint8Array(32).fill(1),
      lastCommitHash: new Uint8Array(32).fill(2),
      dataHash: new Uint8Array(32).fill(3),
      lastResultsHash: new Uint8Array(32).fill(4),
      validatorsHash: new Uint8Array(32).fill(5),
      nextValidatorsHash: new Uint8Array(32).fill(6),
      appHash: new Uint8Array(32).fill(7),
      evidenceHash: new Uint8Array(32).fill(8),
      proposerAddress: new Uint8Array(32).fill(9),
    };
    const j = jsonify(header) as Record<string, string>;
    expect(headerHash(headerFromJson(j))).toEqual(headerHash(header));
    // The concatenation of the fields is unchanged, so the hash would be too; the sizes are what stop it.
    const moved = { ...j, lastBlockHash: j.lastBlockHash! + j.lastCommitHash!, lastCommitHash: '' };
    expect(() => headerFromJson(moved)).toThrow(/lastBlockHash must be 32 bytes/);
    expect(() => headerFromJson({ ...j, proposerAddress: j.proposerAddress!.slice(0, 40) })).toThrow(/proposerAddress must be 32 bytes/);
    expect(() => parseBigint(2 ** 53, 'height')).toThrow(/integer/);
    expect(() => parseBigint(-1, 'height')).toThrow(/integer/);
    expect(parseBigint(7, 'height')).toBe(7n);
  });

  it('bounds the peer database and refuses an unnamed key', () => {
    const db = new PeerDb(null, []);
    let added = 0;
    for (let i = 0; i < MAX_RECORDS + 50; i++) if (db.add(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}:26656`)) added++;
    expect(added).toBe(MAX_RECORDS);
    expect(db.size).toBe(MAX_RECORDS);

    const dir = mkdtempSync(join(tmpdir(), 'review2-'));
    try {
      const ks = Keystore.create(join(dir, 'keystore.json'), 'pw');
      expect(() => ks.add('')).toThrow(/needs a name/);
      ks.add('alice');
      expect(() => Keystore.open(join(dir, 'keystore.json'), 'other')).toThrow(/wrong passphrase/);

      // Two handles over one file: each write starts from what is on disk, so neither loses the other's keys.
      const path = join(dir, 'keystore.json');
      const a = Keystore.open(path, 'pw');
      const b = Keystore.open(path, 'pw');
      a.add('a');
      b.add('b');
      expect(Keystore.open(path, 'pw').list().map((k) => k.name).sort()).toEqual(['a', 'alice', 'b']);
      expect(() => b.add('a')).toThrow(/already exists/);
      a.remove('b');
      expect(Keystore.open(path, 'pw').has('b')).toBe(false);
      expect(existsSync(path + '.lock')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('second review: over the network', () => {
  let net: Testnet | null = null;
  let server: RpcServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
    await net?.stop();
    net = null;
  });

  it('holds the RPC to its parameter types, seeks listing cursors, and does not wait for a transaction it has already refused', async () => {
    net = await makeTestnet({
      validators: 4,
      appFor: (_i, _d, genesis) => new CoreApp({ genesis, verifier }),
      appState: new TextDecoder().decode(appGenesisBytes({ accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '1000000000' }], staking: { inflationMinBps: 0, inflationMaxBps: 0 } })),
    });
    server = new RpcServer(net.nodes[0]!, { port: 0 });
    await server.start();
    await waitForHeight(net.nodes, 2n);
    const rpc = new RpcClient(server.url);
    const chainId = net.genesis.chainId;

    await expect(rpc.call('accountHistory', { account: 'faucet', reverse: 'false' })).rejects.toMatchObject({ code: -32602 });
    await expect(rpc.call('account', { name: 'faucet', prove: 'false' })).rejects.toMatchObject({ code: -32602 });
    await expect(rpc.call('accounts', { limit: '5' })).rejects.toMatchObject({ code: -32602 });
    await expect(rpc.call('header', { height: 2 ** 53 })).rejects.toMatchObject({ code: -32602 });
    expect(await rpc.call('accounts', { limit: 0 })).toEqual([]);

    const create = signedTxBytes(chainId, { expiration: BigInt(Date.now()) + 60_000n, operations: withFees([{ type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: makeAuthority([alice.publicKey]), active: makeAuthority([alice.publicKey]) }], DEFAULT_FEES) }, [faucet]);
    expect((await rpc.broadcastTx(toHex(create), 'commit')).ok).toBe(true);
    const names = (after?: string) => rpc.call('accounts', { limit: 10, ...(after === undefined ? {} : { after }) }).then((r: { name: string }[]) => r.map((a) => a.name));
    expect(await names()).toEqual(['alice', 'faucet']);
    expect(await names('alice')).toEqual(['faucet']);
    expect(await names('b')).toEqual(['faucet']);
    expect(await names('faucet')).toEqual([]);

    // Refused once, a transaction is remembered; asking again in commit mode is answered at once, not after the timeout.
    const forged = signedTxBytes(chainId, { expiration: BigInt(Date.now()) + 60_000n, operations: withFees([{ type: 'transfer', from: FAUCET_ID, to: objectId(TYPE.account, 1), asset: objectId(TYPE.asset, 0), amount: 1n }], DEFAULT_FEES) }, [alice]);
    await expect(rpc.broadcastTx(toHex(forged), 'sync')).rejects.toMatchObject({ code: -32002 });
    const started = Date.now();
    await expect(rpc.call('broadcastTx', { tx: toHex(forged), mode: 'commit', timeoutMs: 20_000 })).rejects.toMatchObject({ code: -32002 });
    expect(Date.now() - started).toBeLessThan(5_000);

    // Request ids are strings, numbers or null; anything else is not a request.
    const res = await fetch(server.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: { a: 1 }, method: 'status' }) });
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32600);

    // A request without an id is a notification: carried out, never answered, alone or in a batch.
    const lone = await fetch(server.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'status' }) });
    expect(lone.status).toBe(204);
    expect(await lone.text()).toBe('');
    const mixed = await fetch(server.url, { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', method: 'status' }, { jsonrpc: '2.0', id: 7, method: 'status' }, { jsonrpc: '2.0', method: 'nothing' }]) });
    expect(((await mixed.json()) as { id: unknown }[]).map((a) => a.id)).toEqual([7]);
  });

  it('binds a served header to the height asked for and refuses an anchor from the future', async () => {
    net = await makeTestnet({ validators: 4 });
    await waitForHeight(net.nodes, 5n);
    const chainId = net.genesis.chainId;
    const node = net.nodes[0]!;
    const honest = new NodeProvider(node);
    const anchor = (await honest.signedHeader(2n))!;

    // A genuine header, just not the one asked for.
    const shifted = new NodeProvider(node);
    shifted.signedHeader = (h) => honest.signedHeader(h + 1n);
    const client = await LightClient.trust({ chainId, provider: honest, verifier }, 2n, headerHash(anchor.header));
    (client as unknown as { o: { provider: typeof shifted } }).o.provider = shifted;
    await expect(client.verifyToHeight(4n)).rejects.toThrow(/answered height 4 with header 5/);

    // An anchor further ahead of the clock than drift allows is not a header the chain has produced yet.
    const past = anchor.header.time - 60_000n;
    await expect(LightClient.trust({ chainId, provider: honest, verifier, now: () => past }, 2n, headerHash(anchor.header))).rejects.toThrow(/from the future/);
    // Exactly one trusting period old is already too old.
    const later = (h: bigint) => BigInt(Date.now()) - anchor.header.time + h;
    await expect(LightClient.trust({ chainId, provider: honest, verifier, trustingPeriodMs: 10_000n, now: () => anchor.header.time + 10_000n }, 2n, headerHash(anchor.header))).rejects.toThrow(/trusting period/);
    expect(later(0n)).toBeGreaterThanOrEqual(0n);

    // Heights before the trusted one are reached down the hash chain alone, and a header off that chain is caught.
    const hash4 = headerHash((await honest.signedHeader(4n))!.header);
    const forward = await LightClient.trust({ chainId, provider: honest, verifier }, 4n, hash4);
    expect(headerHash(await forward.verifyBackward(2n))).toEqual(headerHash(anchor.header));
    await expect(forward.verifyBackward(0n)).rejects.toThrow(/not a block/);
    await expect(forward.verifyBackward(5n)).rejects.toThrow(/after the trusted height/);
    const liar = new NodeProvider(node);
    liar.header = async (h) => {
      const real = await honest.header(h);
      return h === 3n && real ? { ...real, appHash: new Uint8Array(32) } : real;
    };
    const lied = await LightClient.trust({ chainId, provider: liar, verifier }, 4n, hash4);
    await expect(lied.verifyBackward(2n)).rejects.toThrow(/header 3 is not the one header 4 names/);
    const near = await LightClient.trust({ chainId, provider: honest, verifier, maxBackwardSteps: 1 }, 4n, hash4);
    await expect(near.verifyBackward(2n)).rejects.toThrow(/more than 1 headers before/);
  });

  it('keeps blocks the evidence window may still name, whatever the retention setting', async () => {
    net = await makeTestnet({ validators: 4 });
    await waitForHeight(net.nodes, 6n);
    const keeper = await net.makeNode(4, { validatorSeed: null, retain: { blocks: 2 } });
    net.nodes.push(keeper);
    await keeper.start();
    await waitFor(() => keeper.height >= 8n, 30_000, () => `retaining node to sync (${keeper.height})`);
    // Seven days of evidence age cover every block of a test chain.
    expect(keeper.store.lowestHeight()).toBe(1n);
    expect(keeper.store.loadBlock(1n)).not.toBeNull();
  });
});
