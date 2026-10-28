import { afterEach, describe, expect, it } from 'vitest';
import type { KvStoreApp } from '../src/app/kvstore.ts';
import { toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { LightClient } from '../src/light/client.ts';
import { NodeProvider } from '../src/light/provider.ts';
import { headerHash } from '../src/types/block.ts';
import { makeTestnet, tx, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

describe('light client', () => {
  let net: Testnet | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
  });

  it('follows a validator set that changes beyond the trust level by bisecting', async () => {
    // Four validators of power 10. A fifth with power 100 joins, then the first three leave:
    // whoever trusts the genesis set sees only a quarter of it among the final signers.
    net = await makeTestnet({ validators: 4, fullNodes: 1 });
    const chainId = net.genesis.chainId;
    const fifth = keyPairFromSeed(net.validatorSeed(4));
    await waitForHeight(net.nodes, 2n);
    const trustedHeight = net.nodes[3]!.height;
    const trustedHash = headerHash(net.nodes[3]!.store.loadBlock(trustedHeight)!.block.header);

    // Node 4 restarts with its validator key and gets voted in.
    await net.nodes[4]!.stop();
    const withKey = await net.makeNode(4, { validatorSeed: net.validatorSeed(4) });
    net.nodes[4] = withKey;
    await withKey.start();
    await net.nodes[0]!.submitTx(tx(`val:${toHex(fifth.publicKey)}:100`));
    await waitFor(() => withKey.executor.state.validators.indexOf(fifth.address) >= 0, 20_000, 'fifth validator in the set');
    const joined = withKey.height;
    await waitForHeight(net.nodes, joined + 2n);

    for (let i = 0; i < 3; i++) await net.nodes[3]!.submitTx(tx(`val:${toHex(keyPairFromSeed(net.validatorSeed(i)).publicKey)}:0`));
    await waitFor(() => net!.nodes[3]!.executor.state.validators.size === 2, 20_000, () => `two validators left (now ${net!.nodes[3]!.executor.state.validators.size})`);
    const left = net.nodes[3]!.height;
    await waitForHeight(net.nodes, left + 3n);
    expect((net.nodes[3]!.app as KvStoreApp).get('__height')).toBeDefined();

    const client = await LightClient.trust({ chainId, provider: new NodeProvider(net.nodes[3]!), verifier }, trustedHeight, trustedHash);
    expect(client.trusted.validators.size).toBe(4);
    const target = net.nodes[3]!.height;
    const final = await client.verifyToHeight(target);
    expect(final.header.height).toBe(target);
    expect(final.validators.size).toBe(2);
    // It could not skip straight there: at least one intermediate height was verified first.
    expect(client.verifiedHeights.length).toBeGreaterThan(1);
    expect(client.verifiedHeights[client.verifiedHeights.length - 1]).toBe(target);
    for (let i = 1; i < client.verifiedHeights.length; i++) expect(client.verifiedHeights[i]! > client.verifiedHeights[i - 1]!).toBe(true);

    // Sequential verification and the latest height both work from there.
    await waitForHeight(net.nodes, target + 1n);
    await client.verifyToHeight(target + 1n);
    await waitForHeight(net.nodes, target + 3n);
    expect((await client.verifyLatest()).header.height).toBeGreaterThanOrEqual(target + 3n);

    // A provider serving a header the real validators never signed is rejected.
    const liar = new NodeProvider(net.nodes[3]!);
    const real = await liar.signedHeader(target + 2n);
    const forged = { ...real!.header, appHash: new Uint8Array(32) };
    liar.signedHeader = async (h) => (h === target + 2n ? { header: forged, commit: { ...real!.commit, blockHash: headerHash(forged) } } : net!.nodes[3]!.store.loadBlock(h) && { header: net!.nodes[3]!.store.loadBlock(h)!.block.header, commit: net!.nodes[3]!.store.loadBlock(h)!.commit });
    const suspicious = await LightClient.trust({ chainId, provider: liar, verifier }, trustedHeight, trustedHash);
    await expect(suspicious.verifyToHeight(target + 2n)).rejects.toThrow(/commit|signature|power/);

    // Expired trust is refused, at the anchor already.
    await expect(LightClient.trust({ chainId, provider: new NodeProvider(net.nodes[3]!), verifier, trustingPeriodMs: 1n }, trustedHeight, trustedHash)).rejects.toThrow(/trusting period/);
  });
});
