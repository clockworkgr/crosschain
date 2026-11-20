/**
 * A validator signs nothing from its start until it is level with a peer, or has waited for one in vain.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySignStateStore, type SignStateStore } from '../src/consensus/privval.ts';
import { toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { Network } from '../src/p2p/network.ts';
import { PeerDb } from '../src/p2p/peerdb.ts';
import { makeTestnet, seedFor, sleep, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

let net: Testnet | null = null;
afterEach(async () => {
  await net?.stop();
  net = null;
});

describe('a validator that starts', () => {
  it('alone, waits for a peer as long as it is told and then makes the blocks itself', async () => {
    net = await makeTestnet({ validators: 1, skipStart: [0] });
    await net.nodes[0]!.stop();
    const node = await net.makeNode(0, { signGraceMs: 1200 });
    net.nodes[0] = node;
    const started = Date.now();
    await node.start();
    await sleep(700);
    // Its own round 0 came and went: nothing proposed, nothing voted.
    expect(node.height).toBe(0n);
    expect(node.privValidator!.lastSigned()).toBeNull();
    await waitForHeight([node], 2n);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
    // The first block is of the round the wait ended in, proposed when it ended and not a timeout later.
    expect(node.store.loadBlock(1n)!.commit.round).toBe(0);
  });

  it('behind its peers and without its sign state, signs nothing in the heights they decided and is not reported', async () => {
    net = await makeTestnet({ validators: 4 });
    await waitForHeight(net.nodes, 3n);
    // The validator that proposed height 1 in round 0: started from nothing it would propose that height again at
    // once, and its peers still hold what it signed there the first time.
    const first = net.nodes[0]!.store.loadBlock(1n)!;
    expect(first.commit.round).toBe(0);
    const i = net.nodes.findIndex((n) => toHex(n.privValidator!.address) === toHex(first.block.header.proposerAddress));
    const address = net.nodes[i]!.privValidator!.address;
    const index = net.nodes[i]!.executor.state.validators.indexOf(address);
    await net.nodes[i]!.stop();
    const others = net.nodes.filter((_, n) => n !== i);
    const stoppedAt = others[0]!.height;
    await waitForHeight(others, stoppedAt + 2n);

    // Back with an empty store and no record of what it signed; every signature it makes from here on is noted.
    const signedAt: bigint[] = [];
    const inner = new MemorySignStateStore();
    const recording: SignStateStore = { load: () => inner.load(), save: (s) => (signedAt.push(s.height), inner.save(s)) };
    const back = await net.makeNode(i, { signState: recording });
    net.nodes[i] = back;
    const decided = others[0]!.height;
    await back.start();
    await waitFor(() => back.height >= others[0]!.height - 1n && back.height > stoppedAt + 2n, 20_000, 'the validator to catch up');
    // It signs again from there on: a commit carries its precommit.
    let signed = 0n;
    await waitFor(() => {
      for (let h = others[0]!.height; h > stoppedAt + 2n && signed === 0n; h--) if (others[0]!.store.loadBlock(h)?.commit.signatures[index]) signed = h;
      return signed > 0n;
    }, 20_000, 'a commit with its precommit');
    expect(signed).toBeGreaterThan(stoppedAt + 2n);
    // The first thing it signed, and so everything, is of a height its peers had not decided when it started.
    expect(signedAt.length).toBeGreaterThan(0);
    expect(signedAt[0]!).toBeGreaterThan(decided);
    // Nobody found two signatures of its in one place.
    for (const n of net.nodes) expect(n.evidencePool.held.pending).toBe(0);
    for (let h = 1n; h <= others[0]!.height; h++) expect(others[0]!.store.loadBlock(h)!.block.evidence).toEqual([]);
  });

  it('is not kept from signing by a peer that says it is ahead and serves none of the blocks', async () => {
    net = await makeTestnet({ validators: 1, skipStart: [0] });
    await net.nodes[0]!.stop();
    const node = await net.makeNode(0, { signGraceMs: 1500 });
    net.nodes[0] = node;
    // A peer that claims height 100 at the handshake and again every 100 ms, and answers no request.
    const liar = new Network({ chainId: net.genesis.chainId, nodeKey: keyPairFromSeed(seedFor('signing/liar')), transport: net.hub.transport('liar:1'), listenAddr: null, peerDb: new PeerDb(null, [net.addrOf(0)]), verifier, getHeight: () => 100n, log: () => {}, connectIntervalMs: 50 });
    const saying = setInterval(() => liar.broadcast({ type: 'status', height: 100n }), 100);
    try {
      await node.start();
      await liar.start();
      await waitFor(() => node.network.peers.size === 1, 1000, 'the peer to connect');
      await sleep(2000);
      // Held for as long as the claim stands: the grace is over, and a peer is ahead.
      expect(node.height).toBe(0n);
      expect(node.privValidator!.lastSigned()).toBeNull();
      // The request for the blocks goes unanswered, and from then on what that peer says of its height is not
      // waited for, however often it says it.
      await waitForHeight([node], 2n, 15_000);
      expect(node.network.peers.size).toBe(1);
    } finally {
      clearInterval(saying);
      await liar.stop();
    }
  });
});
