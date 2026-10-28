import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { DEFAULT_FEES } from '../src/app/core/genesis.ts';
import { appGenesisBytes, authorityJson } from '../src/app/core/genesis.ts';
import { AccountType, TYPE } from '../src/app/core/types.ts';
import { decode } from '../src/codec/reader.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { objectId } from '../src/db/id.ts';
import { verifyObjectProof } from '../src/db/proof.ts';
import { verifyKeyQuery, verifyStateQuery } from '../src/light/verify.ts';
import { LightClient } from '../src/light/client.ts';
import { NodeProvider } from '../src/light/provider.ts';
import { headerHash, txHash } from '../src/types/block.ts';
import { verifyTxQuery } from '../src/light/verify.ts';
import { HistoryKind } from '../src/app/core/history.ts';
import { decodeOperation } from '../src/app/core/tx.ts';
import { Reader } from '../src/codec/reader.ts';
import { encode } from '../src/codec/writer.ts';
import { toHex } from '../src/crypto/hash.ts';
import { makeTestnet, seedFor, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const faucet = keyPairFromSeed(seedFor('chain/faucet'));
const alice = keyPairFromSeed(seedFor('chain/alice'));
const FAUCET_ID = objectId(TYPE.account, 0);

describe('core application on a live network', () => {
  let net: Testnet | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
  });

  it('gossips signed transactions, agrees on state, and proves it against the next header', async () => {
    net = await makeTestnet({
      validators: 4,
      fullNodes: 1,
      appState: new TextDecoder().decode(
        appGenesisBytes({
          accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '1000000000' }],
        }),
      ),
      appFor: (_i, _dataDir, genesis) => new CoreApp({ genesis, verifier }),
    });
    const apps = net.nodes.map((n) => n.app as CoreApp);
    const chainId = net.genesis.chainId;
    await waitForHeight(net.nodes, 2n);
    const expiration = () => BigInt(Date.now()) + 60_000n;

    const create = signedTxBytes(chainId, { expiration: expiration(), operations: withFees([{ type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: makeAuthority([alice.publicKey]), active: makeAuthority([alice.publicKey]) }], DEFAULT_FEES) }, [faucet]);
    expect((await net.nodes[0]!.submitTx(create)).status).toBe('added');
    await waitFor(() => apps.every((a) => a.accountByName('alice') !== null), 15_000, 'alice to exist everywhere');
    const aliceId = apps[0]!.accountByName('alice')!.id;

    // A transaction signed by the wrong key never enters the mempool.
    const forged = signedTxBytes(chainId, { expiration: expiration(), operations: withFees([{ type: 'transfer', from: FAUCET_ID, to: aliceId, asset: apps[0]!.coreAsset, amount: 1n }], DEFAULT_FEES) }, [alice]);
    expect((await net.nodes[1]!.submitTx(forged)).status).toBe('invalid');

    const pay = signedTxBytes(chainId, { expiration: expiration(), operations: withFees([{ type: 'transfer', from: FAUCET_ID, to: aliceId, asset: apps[0]!.coreAsset, amount: 12_345n }], DEFAULT_FEES) }, [faucet]);
    expect((await net.nodes[1]!.submitTx(pay)).status).toBe('added');
    await waitFor(() => apps.every((a) => a.balance(aliceId) === 12_345n), 15_000, () => `alice paid everywhere (${apps.map((a) => a.balance(aliceId)).join(',')})`);
    expect(new Set(apps.map((a) => a.lastAppHash.join(','))).size).toBeLessThanOrEqual(2); // nodes may be one block apart

    // A proof from one node checks out against the app hash the next header carries, which the full node also holds.
    const node = net.nodes[2]!;
    const app = apps[2]!;
    const h = app.lastHeight;
    const proof = app.proof(aliceId);
    await waitForHeight(net.nodes, h + 1n);
    for (const n of net.nodes) {
      const header = n.store.loadBlock(h + 1n)!.block.header;
      expect(verifyObjectProof(header.appHash, proof)).toBe(true);
    }
    expect(decode(proof.value!, (r) => AccountType.decode(r, proof.id)).name).toBe('alice');
    expect(node.height).toBeGreaterThanOrEqual(h + 1n);

    // The node answers a state query like an RPC would, and a light client checks header, commit and proof together.
    const q = node.queryState(aliceId, h)!;
    expect(q.header.height).toBe(h + 1n);
    const valset = node.executor.validatorSetAtHeight(h + 1n)!;
    expect(await verifyStateQuery(chainId, q, valset, verifier)).toBeNull();
    expect(await verifyStateQuery(chainId, { ...q, proof: { ...q.proof, value: null } }, valset, verifier)).toMatch(/proof/);
    const other = node.store.loadBlock(h)!;
    expect(await verifyStateQuery(chainId, { ...q, header: other.block.header, commit: other.commit }, valset, verifier)).toMatch(/height/);
    // A past height is still provable, against its own next header, and the latest default query works too.
    const earlier = node.queryState(aliceId, h - 1n)!;
    expect(await verifyStateQuery(chainId, earlier, node.executor.validatorSetAtHeight(h)!, verifier)).toBeNull();
    const latest = node.queryState(aliceId)!;
    expect(await verifyStateQuery(chainId, latest, node.executor.validatorSetAtHeight(latest.header.height)!, verifier)).toBeNull();
    // Names too: alice maps to her id, and bob is provably free.
    const byName = node.queryAccountName('alice', h)!;
    const r = await verifyKeyQuery(chainId, byName, valset, verifier);
    expect('value' in r && r.value && toHex(r.value)).toBe(toHex(encode((w) => w.u64(aliceId))));
    const free = await verifyKeyQuery(chainId, node.queryAccountName('bob', h)!, valset, verifier);
    expect(free).toEqual({ value: null });

    // A light client that trusts height 2 by hash verifies forward on its own and checks the same queries.
    const trustedHash = headerHash(node.store.loadBlock(2n)!.block.header);
    const client = await LightClient.trust({ chainId, provider: new NodeProvider(net.nodes[4]!), verifier }, 2n, trustedHash);
    expect(await client.verifyState(q)).toBeNull();
    expect(client.trusted.header.height).toBe(h + 1n);
    expect(await client.verifyKey(byName)).toEqual({ value: encode((w) => w.u64(aliceId)) });
    expect(await client.verifyState({ ...q, header: { ...q.header, appHash: new Uint8Array(32) } })).toMatch(/not the verified one/);
    await expect(LightClient.trust({ chainId, provider: new NodeProvider(net.nodes[4]!), verifier }, 2n, new Uint8Array(32))).rejects.toThrow(/trusted hash/);

    // The transfer can be proven included and successful, by sets the caller trusts and by the light client.
    const txq = node.queryTx(txHash(pay))!;
    expect(txq.resultProof).not.toBeNull();
    const sets = (hh: bigint) => node.executor.validatorSetAtHeight(hh)!;
    expect(await verifyTxQuery(chainId, txq, sets(txq.header.height), sets(txq.header.height + 1n), verifier)).toEqual({ ok: true, error: '' });
    expect(await verifyTxQuery(chainId, { ...txq, txProof: { ...txq.txProof, tx: create } }, sets(txq.header.height), sets(txq.header.height + 1n), verifier)).toMatchObject({ failed: true });
    const fresh = await LightClient.trust({ chainId, provider: new NodeProvider(net.nodes[4]!), verifier }, 2n, trustedHash);
    expect(await fresh.verifyTx(txq)).toEqual({ ok: true, error: '' });
    expect(node.queryTx(new Uint8Array(32))).toBeNull();

    // Account history on every node: the faucet registered alice and paid her; alice received both.
    for (const a of apps) {
      const faucetHistory = a.accountHistory(FAUCET_ID).entries;
      expect(faucetHistory.map((e) => decodeOperation(new Reader(e.data)).type)).toEqual(['accountCreate', 'transfer']);
      expect(faucetHistory.every((e) => e.kind === HistoryKind.operation && e.txHash !== null)).toBe(true);
      const aliceHistory = a.accountHistory(aliceId, 0n, 10, true).entries;
      expect(aliceHistory.map((e) => e.sequence)).toEqual([1n, 0n]);
      expect(toHex(aliceHistory[0]!.txHash!)).toBe(toHex(txHash(pay)));
    }
  });
});
