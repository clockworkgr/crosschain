import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson, DEFAULT_FEES } from '../src/app/core/genesis.ts';
import { chainParametersFromJson, TYPE } from '../src/app/core/types.ts';
import { fromHex, toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { objectId } from '../src/db/id.ts';
import { keyProofFromBytes, proofFromBytes, verifyKeyProof, verifyObjectProof } from '../src/db/proof.ts';
import { LightClient } from '../src/light/client.ts';
import { RpcProvider } from '../src/light/rpc-provider.ts';
import { verifyTxQuery } from '../src/light/verify.ts';
import { RpcClient, RpcClientError } from '../src/rpc/client.ts';
import { headerFromJson, txQueryFromJson, validatorSetFromJson } from '../src/rpc/json.ts';
import { RpcServer } from '../src/rpc/server.ts';
import { headerHash, txHash } from '../src/types/block.ts';
import { Keystore } from '../src/wallet/keystore.ts';
import { makeTestnet, seedFor, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const faucet = keyPairFromSeed(seedFor('rpc/faucet'));
const alice = keyPairFromSeed(seedFor('rpc/alice'));
const FAUCET_ID = objectId(TYPE.account, 0);

describe('json-rpc', () => {
  let net: Testnet | null = null;
  let server: RpcServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
    await net?.stop();
    net = null;
  });

  async function up(limits?: Partial<{ ratePerSecond: number; burst: number; bodyBytes: number; maxStreams: number }>) {
    net = await makeTestnet({
      validators: 4,
      appFor: (_i, _d, genesis) => new CoreApp({ genesis, verifier }),
      appState: new TextDecoder().decode(appGenesisBytes({ accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '1000000000' }], staking: { inflationMinBps: 0, inflationMaxBps: 0 } })),
    });
    server = new RpcServer(net.nodes[0]!, { port: 0, limits });
    await server.start();
    await waitForHeight(net.nodes, 2n);
    return { rpc: new RpcClient(server.url), node: net.nodes[0]!, chainId: net.genesis.chainId };
  }

  it('answers status, headers, commits, validator sets, objects and keys with proofs that verify', async () => {
    const { rpc, node } = await up();
    const status = await rpc.status();
    expect(status.chainId).toBe(net!.genesis.chainId);
    expect(BigInt(status.latestHeight)).toBeGreaterThanOrEqual(2n);
    expect(status.peers).toBe(3);
    const h = BigInt(status.latestHeight);
    const header = headerFromJson(await rpc.header(h));
    expect(toHex(headerHash(header))).toBe(toHex(headerHash(node.store.loadBlock(h)!.block.header)));
    const commit = await rpc.commit(h);
    expect(commit.signatures.length).toBe(4);
    const vals = await rpc.validators(h);
    expect(validatorSetFromJson(vals).hash()).toEqual(fromHex(vals.hash));
    expect(toHex(validatorSetFromJson(await rpc.validatorSet(vals.hash)).hash())).toBe(vals.hash);
    // An object proof from the RPC verifies against the next header's app hash.
    const obj = await rpc.call('object', { id: '3.0', height: (h - 1n).toString(), prove: true });
    expect(obj.object.name).toBe('faucet');
    expect(verifyObjectProof(header.appHash, proofFromBytes(fromHex(obj.proof)))).toBe(true);
    const acct = await rpc.account('faucet', true);
    expect(acct.account.id).toBe('3.0');
    expect(acct.balances[0].asset).toBe('CORE');
    const nextHeader = headerFromJson(await rpc.header(BigInt(acct.height) + 1n).catch(async () => (await waitForHeight(net!.nodes, BigInt(acct.height) + 1n), rpc.header(BigInt(acct.height) + 1n))));
    expect(toHex(verifyKeyProof(nextHeader.appHash, keyProofFromBytes(fromHex(acct.proof)))!)).toBe(toHex(new Uint8Array([...fromHex('0003000000000000')])));
    const missing = await rpc.account('nobody', true);
    expect(missing.account).toBeNull();
    await expect(rpc.call('header', { height: '999999' })).rejects.toMatchObject({ code: -32001 });
    await expect(rpc.call('nonsense')).rejects.toMatchObject({ code: -32601 });
    expect((await rpc.call('genesis')).chainId).toBe(net!.genesis.chainId);
    expect((await rpc.call('peers')).length).toBe(3);
    expect((await rpc.call('mempool')).count).toBe(0);
    expect((await rpc.call('accounts', {})).map((a: any) => a.name)).toEqual(['faucet']);
  });

  it('broadcasts in sync and commit mode, finds transactions with proofs, and records history', async () => {
    const { rpc, node, chainId } = await up();
    const expiration = () => BigInt(Date.now()) + 60_000n;
    const create = signedTxBytes(chainId, { expiration: expiration(), operations: withFees([{ type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: makeAuthority([alice.publicKey]), active: makeAuthority([alice.publicKey]) }], DEFAULT_FEES) }, [faucet]);
    const r1 = await rpc.broadcastTx(toHex(create), 'commit');
    expect(r1.ok).toBe(true);
    expect(r1.hash).toBe(toHex(txHash(create)));
    const aliceId = objectId(TYPE.account, 1);
    const pay = signedTxBytes(chainId, { expiration: expiration(), operations: withFees([{ type: 'transfer', from: FAUCET_ID, to: aliceId, asset: objectId(TYPE.asset, 0), amount: 5000n }], DEFAULT_FEES) }, [faucet]);
    const r2 = await rpc.broadcastTx(toHex(pay), 'sync');
    expect(r2.status).toBe('added');
    await waitFor(() => node.store.txLocation(txHash(pay)) !== null, 15_000, 'transfer to land');
    const again = await rpc.broadcastTx(toHex(pay), 'commit');
    expect(again.height).toBe(node.store.txLocation(txHash(pay))!.height.toString());
    // A bad transaction is refused with the application's reason.
    const forged = signedTxBytes(chainId, { expiration: expiration(), operations: withFees([{ type: 'transfer', from: FAUCET_ID, to: aliceId, asset: objectId(TYPE.asset, 0), amount: 1n }], DEFAULT_FEES) }, [alice]);
    await expect(rpc.broadcastTx(toHex(forged), 'sync')).rejects.toMatchObject({ code: -32002 });

    const landed = node.store.txLocation(txHash(pay))!;
    await waitForHeight(net!.nodes, landed.height + 1n);
    const t = await rpc.tx(toHex(txHash(pay)), true);
    expect(t.ok).toBe(true);
    expect(t.decoded.operations[0].type).toBe('transfer');
    expect(t.decoded.operations[0].to).toBe('3.1');
    const q = txQueryFromJson(t.proof);
    const sets = (hh: bigint) => node.executor.validatorSetAtHeight(hh)!;
    expect(await verifyTxQuery(chainId, q, sets(q.header.height), sets(q.header.height + 1n), verifier)).toEqual({ ok: true, error: '' });
    await expect(rpc.tx('00'.repeat(32))).rejects.toMatchObject({ code: -32001 });

    const hist = await rpc.call('accountHistory', { account: 'alice' });
    expect(hist.entries.map((e: any) => e.kind)).toEqual(['operation', 'operation']);
    expect(hist.entries[1].data.type).toBe('transfer');
    expect(hist.entries[1].data.amount).toBe('5000');
    expect((await rpc.call('balance', { account: 'alice' })).amount).toBe('5000');
    expect(await rpc.call('delegation', { delegator: 'alice', validator: '7.0' }).catch((e: RpcClientError) => e.code)).toBe(-32001);
  });

  it('streams events, replays blocks from Last-Event-ID, and enforces the limits', async () => {
    const { rpc } = await up({ ratePerSecond: 2, burst: 6, bodyBytes: 2000, maxStreams: 2 });
    const decoder = new TextDecoder();
    // One chunk of a stream. Throws instead of spinning if the stream has ended.
    const read = async (r: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
      const { value, done } = await r.read();
      if (done) throw new Error('stream ended');
      return decoder.decode(value);
    };
    // A stream: the first block event arrives within a block time.
    const res = await fetch(server!.url + '/events?types=block,tx');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    let text = await read(reader);
    while (!text.includes('event: block')) text += await read(reader);
    expect(text).toMatch(/event: block\nid: \d+\ndata: \{"height"/);
    // Streams per address are capped: a second one fits, a third does not.
    const second = await fetch(server!.url + '/events');
    expect(second.status).toBe(200);
    expect((await fetch(server!.url + '/events')).status).toBe(429);
    await reader.cancel();
    await second.body!.cancel();
    // Body limit: refused before the body is read.
    const big = await fetch(server!.url + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: { pad: 'x'.repeat(5000) } }) });
    expect(big.status).toBe(413);
    // Replay: ask for everything after height 1. The server frees a cancelled
    // stream's slot only when it sees the socket close, so allow it a moment.
    const replayFetch = () => fetch(server!.url + '/events?types=block', { headers: { 'Last-Event-ID': '1' } });
    let replay = await replayFetch();
    for (let i = 0; i < 50 && replay.status === 429; i++) {
      await new Promise((r) => setTimeout(r, 20));
      replay = await replayFetch();
    }
    expect(replay.status).toBe(200);
    const r2 = replay.body!.getReader();
    let t2 = await read(r2);
    while (!t2.includes('id: 2\n')) t2 += await read(r2);
    expect(t2).toContain('id: 2\n');
    // A replay costs as much as a costly call, so a second one right away is refused.
    expect((await replayFetch()).status).toBe(429);
    await r2.cancel();
    // Rate limit: with the bucket drained, a burst of cheap calls meets the limit.
    let limited = false;
    for (let i = 0; i < 20 && !limited; i++) {
      try {
        await rpc.status();
      } catch (e) {
        limited = (e as { code?: number }).code === -32004;
      }
    }
    expect(limited).toBe(true);
  });

  it('serves a light client over the RPC', async () => {
    const { rpc, node, chainId } = await up();
    const trusted = headerHash(node.store.loadBlock(2n)!.block.header);
    const client = await LightClient.trust({ chainId, provider: new RpcProvider(rpc), verifier }, 2n, trusted);
    const latest = await client.verifyLatest();
    expect(BigInt((await rpc.status()).latestHeight)).toBeGreaterThanOrEqual(latest.header.height);
    const a = await rpc.account('faucet', true);
    const q = { proof: keyProofFromBytes(fromHex(a.proof)), ...(await (async () => {
      await waitForHeight(net!.nodes, BigInt(a.height) + 1n);
      return { header: headerFromJson(await rpc.header(BigInt(a.height) + 1n)), commit: (await import('../src/rpc/json.ts')).commitFromJson(await rpc.commit(BigInt(a.height) + 1n)) };
    })()) };
    expect(await client.verifyKey(q)).toEqual({ value: fromHex('0003000000000000') });
    await expect(LightClient.trust({ chainId, provider: new RpcProvider(rpc), verifier }, 2n, new Uint8Array(32))).rejects.toThrow(/trusted hash/);
  });
});

describe('json-rpc parameters', () => {
  let net: Testnet | null = null;
  let server: RpcServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
    await net?.stop();
    net = null;
  });

  it('reports the parameters in force so a wallet can price its operations, and the open proposals', async () => {
    net = await makeTestnet({
      validators: 4,
      appFor: (_i, _d, genesis) => new CoreApp({ genesis, verifier }),
      appState: new TextDecoder().decode(appGenesisBytes({ accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '1000000000' }], fees: { transfer: { fee: '250' }, accountCreate: { premiumFee: '20000' } } })),
    });
    server = new RpcServer(net.nodes[0]!, { port: 0 });
    await server.start();
    await waitForHeight(net.nodes, 2n);
    const rpc = new RpcClient(server.url);
    const p = await rpc.parameters();
    expect(p.coreAsset).toEqual({ id: '4.0', symbol: 'CORE', precision: 5 });
    expect(p.fees.scale).toBe(10000);
    expect(p.fees.transfer).toEqual({ fee: '250' });
    expect(p.fees.accountCreate).toEqual({ basicFee: '1000', premiumFee: '20000', pricePerKbyte: '100' });
    expect(p.staking.maxValidators).toBe(21);
    expect(p.staking.unbondingPeriodMs).toBe('604800000');
    // The JSON turns back into exactly the parameters the application holds.
    expect(chainParametersFromJson(p)).toEqual((net.nodes[0]!.app as CoreApp).chainParameters());
    expect(await rpc.proposals()).toEqual([]);
    // A wallet that prices from the schedule gets in; one that uses the defaults is short.
    const fees = chainParametersFromJson(p).fees;
    const aliceId = BigInt(TYPE.account) * 2n ** 48n + 1n;
    const expiration = () => BigInt(Date.now()) + 60_000n;
    const create = signedTxBytes(net.genesis.chainId, { expiration: expiration(), operations: withFees([{ type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: makeAuthority([alice.publicKey]), active: makeAuthority([alice.publicKey]) }], fees) }, [faucet]);
    expect((await rpc.broadcastTx(toHex(create), 'commit')).ok).toBe(true);
    const cheap = signedTxBytes(net.genesis.chainId, { expiration: expiration(), operations: withFees([{ type: 'transfer', from: FAUCET_ID, to: aliceId, asset: objectId(TYPE.asset, 0), amount: 5000n }], DEFAULT_FEES) }, [faucet]);
    await expect(rpc.broadcastTx(toHex(cheap), 'sync')).rejects.toMatchObject({ code: -32002, message: expect.stringMatching(/states a fee of 100, the schedule requires 250/) });
  });
});

describe('keystore', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('seals seeds under a passphrase and refuses the wrong one', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ks-'));
    const path = join(tmp, 'keystore.json');
    const ks = Keystore.create(path, 'correct horse');
    const a = ks.add('alice');
    const b = ks.add('bob', seedFor('ks/bob'));
    expect(ks.list().map((k) => k.name)).toEqual(['alice', 'bob']);
    expect(() => ks.add('alice')).toThrow(/already exists/);
    const again = Keystore.open(path, 'correct horse');
    expect(toHex(again.get('alice').address)).toBe(toHex(a.address));
    expect(toHex(again.seedOf('bob'))).toBe(toHex(seedFor('ks/bob')));
    expect(toHex(again.publicKeyOf('bob'))).toBe(toHex(b.publicKey));
    expect(() => Keystore.open(path, 'wrong')).toThrow(/wrong passphrase/);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(JSON.stringify(raw)).not.toContain(toHex(seedFor('ks/bob')));
  });
});
