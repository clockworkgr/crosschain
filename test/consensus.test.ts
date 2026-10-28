import { afterEach, describe, expect, it } from 'vitest';
import { bytesEqual, toHex } from '../src/crypto/hash.ts';
import { KvStoreApp } from '../src/app/kvstore.ts';
import { blockHash } from '../src/types/block.ts';
import { makeTestnet, sleep, tx, waitFor, waitForHeight, type Testnet } from './helpers.ts';

let net: Testnet | null = null;
afterEach(async () => {
  await net?.stop();
  net = null;
});

describe('consensus', () => {
  it('four validators commit blocks and agree on them', async () => {
    net = await makeTestnet({ validators: 4 });
    await waitForHeight(net.nodes, 5n);
    const hashes = net.nodes.map((n) => toHex(blockHash(n.store.loadBlock(3n)!.block)));
    expect(new Set(hashes).size).toBe(1);
    // Every commit must carry +2/3 of the signatures.
    for (const n of net.nodes) {
      const { commit } = n.store.loadBlock(3n)!;
      expect(commit.signatures.filter((s) => s !== null).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('transactions gossip to every node and land in state', async () => {
    net = await makeTestnet({ validators: 4 });
    await waitForHeight(net.nodes, 1n);
    const r = await net.nodes[0]!.submitTx(tx('hello=world'));
    expect(r.status).toBe('added');
    await waitFor(() => net!.nodes.every((n) => (n.app as KvStoreApp).get('hello') === 'world'), 15_000, 'tx applied everywhere');
    const bad = await net.nodes[1]!.submitTx(tx('no-equals-sign'));
    expect(bad.status).toBe('invalid');
  });

  it('keeps going with one of four validators down', async () => {
    net = await makeTestnet({ validators: 4, skipStart: [3] });
    await waitForHeight(net.nodes.slice(0, 3), 4n);
  });

  it('halts with two of four validators down', async () => {
    net = await makeTestnet({ validators: 4, skipStart: [2, 3] });
    await sleep(3000);
    expect(net.nodes[0]!.height).toBe(0n);
    expect(net.nodes[1]!.height).toBe(0n);
  });

  it('halts during a partition and resumes without divergence after healing', async () => {
    net = await makeTestnet({ validators: 4 });
    await waitForHeight(net.nodes, 2n);
    const [a, b] = [[net.addrOf(0), net.addrOf(1)], [net.addrOf(2), net.addrOf(3)]];
    net.hub.partition(a, b);
    const before = net.nodes.map((n) => n.height);
    await sleep(3000);
    const during = net.nodes.map((n) => n.height);
    // At most one more block may have been in flight when the partition hit.
    for (let i = 0; i < 4; i++) expect(during[i]! - before[i]!).toBeLessThanOrEqual(1n);
    net.hub.heal();
    const target = during.reduce((m, h) => (h > m ? h : m), 0n) + 3n;
    await waitForHeight(net.nodes, target);
    const hashes = net.nodes.map((n) => toHex(blockHash(n.store.loadBlock(target)!.block)));
    expect(new Set(hashes).size).toBe(1);
  });

  it('a late-joining full node catches up through block sync', async () => {
    net = await makeTestnet({ validators: 4, fullNodes: 1, skipStart: [4] });
    await waitForHeight(net.nodes.slice(0, 4), 5n);
    const late = net.nodes[4]!;
    await late.start();
    await waitFor(() => late.height >= 5n, 15_000, 'late node to sync');
    expect(late.blockSync.synced).toBeGreaterThanOrEqual(3n);
    // And it keeps following live consensus afterwards.
    const h = late.height;
    await waitFor(() => late.height >= h + 3n, 15_000, 'late node to follow');
    expect(toHex(blockHash(late.store.loadBlock(h)!.block))).toBe(toHex(blockHash(net.nodes[0]!.store.loadBlock(h)!.block)));
  });

  it('adds a validator through the application and it starts signing', async () => {
    net = await makeTestnet({ validators: 4, fullNodes: 1 });
    const newcomer = net.nodes[4]!;
    // The 5th node was created as a full node; give it the key it will be added with.
    await newcomer.stop();
    const withKey = await net.makeNode(4, { validatorSeed: net.validatorSeed(4) });
    net.nodes[4] = withKey;
    await withKey.start();
    await waitForHeight(net.nodes, 2n);

    const pub = toHex(withKey.privValidator!.publicKey);
    const r = await net.nodes[0]!.submitTx(tx(`val:${pub}:10`));
    expect(r.status).toBe('added');

    await waitFor(() => net!.nodes[0]!.executor.state.validators.size === 5, 20_000, 'validator set to grow');
    const activeAt = net.nodes[0]!.height + 1n;
    await waitForHeight(net.nodes, activeAt + 3n);
    const { commit } = net.nodes[0]!.store.loadBlock(activeAt + 2n)!;
    expect(commit.signatures.length).toBe(5);
    const idx = net.nodes[0]!.executor.validatorSetAtHeight(activeAt + 2n)!.indexOf(withKey.privValidator!.address);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(commit.signatures[idx]).not.toBeNull();
  });

  it('removes a validator and the set shrinks', async () => {
    net = await makeTestnet({ validators: 4 });
    await waitForHeight(net.nodes, 1n);
    const victim = net.nodes[3]!;
    const pub = toHex(victim.privValidator!.publicKey);
    await net.nodes[0]!.submitTx(tx(`val:${pub}:0`));
    await waitFor(() => net!.nodes.every((n) => n.executor.state.validators.size === 3), 20_000, 'validator set to shrink');
    const h = net.nodes[0]!.height;
    await waitForHeight(net.nodes, h + 3n);
    expect(net.nodes[0]!.store.loadBlock(h + 2n)!.commit.signatures.length).toBe(3);
  });
});
