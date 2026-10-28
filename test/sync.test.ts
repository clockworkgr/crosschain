import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { DEFAULT_FEES } from '../src/app/core/genesis.ts';
import { appGenesisBytes, authorityJson } from '../src/app/core/genesis.ts';
import { chunkFromBytes, chunkToBytes, manifestFromBytes, verifyChunk, verifyManifest } from '../src/app/core/snapshot.ts';
import { TYPE } from '../src/app/core/types.ts';
import type { KvStoreApp } from '../src/app/kvstore.ts';
import { keyPairFromSeed, sign, signContext } from '../src/crypto/keys.ts';
import { LightClient } from '../src/light/client.ts';
import { NodeProvider } from '../src/light/provider.ts';
import { objectId } from '../src/db/id.ts';
import { decodeMessage } from '../src/p2p/messages.ts';
import { headerHash, txHash } from '../src/types/block.ts';
import { makeDuplicateVoteEvidence } from '../src/types/evidence.ts';
import { VoteType, voteSignBytes, type Vote } from '../src/types/vote.ts';
import { makeTestnet, seedFor, tx, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const faucet = keyPairFromSeed(seedFor('sync/faucet'));
const FAUCET_ID = objectId(TYPE.account, 0);

describe('sync', () => {
  let net: Testnet | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
  });

  async function coreNet(extra: { snapshotInterval: number; chunkObjects: number }) {
    net = await makeTestnet({
      validators: 4,
      // Only the first two nodes take snapshots, so the joiner has exactly two sources, one of them a liar.
      appFor: (i, _d, genesis) => new CoreApp({ genesis, verifier, snapshotInterval: i < 2 ? extra.snapshotInterval : 0, snapshotChunkObjects: extra.chunkObjects, retainVersions: 50 }),
      appState: new TextDecoder().decode(appGenesisBytes({ accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '1000000000' }], staking: { inflationMinBps: 0, inflationMaxBps: 0 } })),
    });
    return net;
  }

  it('joins from a snapshot, serves queries at once, survives a corrupt chunk, and backfills to genesis', async () => {
    const n = await coreNet({ snapshotInterval: 6, chunkObjects: 2 });
    const chainId = n.genesis.chainId;
    const node = n.nodes[0]!;
    // Some state to carry: a few accounts, so there are several chunks per type.
    for (let i = 0; i < 3; i++) {
      const k = keyPairFromSeed(seedFor(`sync/user${i}`));
      const create = signedTxBytes(chainId, { expiration: BigInt(Date.now()) + 60_000n, operations: withFees([{ type: 'accountCreate', registrar: FAUCET_ID, name: `user${i}`, owner: { threshold: 1, accounts: [], keys: [{ publicKey: k.publicKey, weight: 1 }] }, active: { threshold: 1, accounts: [], keys: [{ publicKey: k.publicKey, weight: 1 }] } }], DEFAULT_FEES) }, [faucet]);
      await node.submitTx(create);
      await waitFor(() => node.store.txLocation(txHash(create)) !== null, 15_000, `user${i} to land`);
    }
    await waitForHeight(n.nodes, 13n);
    const apps = n.nodes.map((x) => x.app as CoreApp);
    await waitFor(() => apps.slice(0, 2).every((a) => a.snapshotHeights().includes(12n)), 15_000, 'snapshot at 12 on both sources');

    // The snapshot verifies against the next header, and a corrupted chunk does not.
    const manifest = manifestFromBytes(apps[0]!.manifestBytes(12n)!);
    const header13 = node.store.loadBlock(13n)!.block.header;
    expect(verifyManifest(header13.appHash, manifest)).toBeNull();
    expect(verifyManifest(header13.lastResultsHash, manifest)).toMatch(/app hash/);
    const accountType = manifest.types.find((t) => t.type === TYPE.account)!;
    expect(accountType.chunkHashes.length).toBe(2); // faucet plus three users, two per chunk
    const raw = apps[0]!.chunkBytes(12n, TYPE.account, 0)!;
    expect('chunk' in verifyChunk(manifest, raw)).toBe(true);
    const tampered = chunkFromBytes(raw);
    tampered.objects[0]![1] = tampered.objects[1]![1]!;
    expect(verifyChunk(manifest, chunkToBytes(tampered))).toMatchObject({ error: expect.stringMatching(/hash differs/) });

    // One peer serves a corrupt chunk; the joiner must notice, ban it, and finish from the others.
    const liar = apps[1]!;
    const honest = liar.chunkBytes.bind(liar);
    liar.chunkBytes = (h, t, i) => {
      const bytes = honest(h, t, i);
      if (!bytes) return bytes;
      const c = chunkFromBytes(bytes);
      if (c.objects.length > 0) c.objects[0]![1] = new Uint8Array([1, 2, 3]);
      else c.siblings = c.siblings.map(() => new Uint8Array(32));
      return chunkToBytes(c);
    };

    const trustedHash = headerHash(node.store.loadBlock(2n)!.block.header);
    const joiner = await n.makeNode(4, { validatorSeed: null, app: undefined, stateSync: { trustHeight: 2n, trustHash: trustedHash, backfill: true }, snapshotInterval: 6, retain: { versions: 50 } });
    expect(joiner.joinedAt).toBe(12n);
    expect(joiner.height).toBe(12n);
    expect(joiner.store.lowestHeight()).toBe(12n);
    // Below the snapshot it holds headers alone, back as far as evidence may reach: here, to genesis.
    expect(joiner.store.lowestHeaderHeight()).toBe(1n);
    expect(headerHash(joiner.store.loadHeader(7n)!)).toEqual(headerHash(node.store.loadBlock(7n)!.block.header));
    const japp = joiner.app as CoreApp;
    expect(japp.lastHeight).toBe(12n);
    // Nothing before the snapshot is provable, and the node says so instead of inventing a proof.
    expect(japp.lowestProvableHeight).toBe(12n);
    expect(() => japp.proofAt(FAUCET_ID, 11n)).toThrow(/not available/);
    expect(japp.accountByName('user2')).not.toBeNull();
    expect(japp.balance(FAUCET_ID)).toBeGreaterThan(0n);
    expect(japp.accountByName('faucet')!.id).toBe(FAUCET_ID);
    // The joiner caught a corrupt chunk, charged its source, and stopped asking it.
    expect(joiner.network.scoreOf(n.nodes[1]!.network.id)).toBeGreaterThan(40); // one offence, minus a moment of decay
    n.nodes.push(joiner);
    await joiner.start();
    // It follows the chain from there, proves state, and fills in old blocks until genesis.
    await waitFor(() => joiner.height >= node.height - 1n && joiner.height > 14n, 30_000, () => `joiner to catch up (${joiner.height} vs ${node.height})`);
    const q = joiner.queryState(FAUCET_ID, joiner.height - 1n)!;
    expect(q.header.height).toBe(joiner.height);
    await waitFor(() => joiner.store.lowestHeight() === 1n, 30_000, () => `backfill to genesis (lowest ${joiner.store.lowestHeight()})`);
    expect(joiner.blockSync.backfilled).toBe(11n);
    expect(headerHash(joiner.store.loadBlock(1n)!.block.header)).toEqual(headerHash(node.store.loadBlock(1n)!.block.header));
    // The backfilled blocks replaced the headers kept alone.
    expect(joiner.store.lowestHeaderHeight()).toBeNull();
    expect(joiner.store.loadHeader(7n)).toBeNull();
    const old = node.store.loadBlock(3n)!.block;
    if (old.txs.length > 0) expect(joiner.store.txLocation(txHash(old.txs[0]!))).toMatchObject({ height: 3n, ok: null });
  });

  it('applies evidence for a height before its join, from the headers it fetched for the evidence window', async () => {
    const n = await coreNet({ snapshotInterval: 6, chunkObjects: 2 });
    const chainId = n.genesis.chainId;
    const node = n.nodes[0]!;
    await waitForHeight(n.nodes, 7n);
    const apps = n.nodes.map((x) => x.app as CoreApp);
    await waitFor(() => apps.slice(0, 2).every((a) => a.snapshotHeights().includes(6n)), 15_000, 'snapshot at 6 on both sources');
    const trustedHash = headerHash(node.store.loadBlock(2n)!.block.header);
    // No block backfill: what the joiner knows of the heights before its snapshot is the headers state sync fetched.
    const joiner = await n.makeNode(4, { validatorSeed: null, app: undefined, stateSync: { trustHeight: 2n, trustHash: trustedHash, backfill: false }, snapshotInterval: 0, retain: { versions: 50 } });
    const joinedAt = joiner.joinedAt!;
    expect(joinedAt).toBeGreaterThanOrEqual(6n);
    expect(joiner.store.loadBlock(3n)).toBeNull();
    expect(joiner.store.lowestHeaderHeight()).toBe(1n);
    expect(headerHash(joiner.store.loadHeader(3n)!)).toEqual(headerHash(node.store.loadBlock(3n)!.block.header));
    expect(joiner.executor.blockTimeAt(3n)).toBe(node.store.loadBlock(3n)!.block.header.time);
    n.nodes.push(joiner);
    await joiner.start();

    // A validator double-signed at height 3, before the join; the evidence reaches a block, which every node applies.
    const victim = keyPairFromSeed(n.validatorSeed(3));
    const set = joiner.executor.validatorSetAtHeight(3n)!;
    const forge = (fill: number): Vote => {
      const unsigned = { type: VoteType.Prevote, height: 3n, round: 0, blockHash: new Uint8Array(32).fill(fill), validatorIndex: set.indexOf(victim.address) };
      return { ...unsigned, signature: sign(voteSignBytes(chainId, unsigned), victim.secretKey, signContext(chainId, 'vote')) };
    };
    expect(node.evidencePool.add(makeDuplicateVoteEvidence(forge(1), forge(2)))).toBe(true);
    const carried = (): bigint | null => {
      for (let h = joinedAt + 1n; h <= node.height; h++) if ((node.store.loadBlock(h)?.block.evidence.length ?? 0) > 0) return h;
      return null;
    };
    await waitFor(() => carried() !== null, 20_000, 'a block to carry the evidence');
    const at = carried()!;
    // Applying that block takes the set of height 3 (named by its header) and its time; the joiner has both, and
    // the block after it, whose header fixes the state the evidence produced, is accepted too.
    await waitFor(() => joiner.height > at + 1n, 20_000, () => `joiner past the evidence block (${joiner.height} vs ${at})`);
    expect(joiner.store.loadBlock(at)!.block.evidence.length).toBeGreaterThan(0);
    expect((joiner.app as CoreApp).lastHeight).toBeGreaterThan(at);

    // A light client anchored after the join verifies a proof from before it by walking the headers back.
    const tip = joiner.height;
    const client = await LightClient.trust({ chainId, provider: new NodeProvider(joiner), verifier }, tip, headerHash(joiner.store.loadBlock(tip)!.block.header));
    expect(await client.verifyState(node.queryState(FAUCET_ID, 3n)!)).toBeNull();
  });

  it('fetches at a join only the headers evidence may still name, and lets them go as the window moves on', async () => {
    const n = await coreNet({ snapshotInterval: 6, chunkObjects: 2 });
    const node = n.nodes[0]!;
    await waitForHeight(n.nodes, 7n);
    const apps = n.nodes.map((x) => x.app as CoreApp);
    await waitFor(() => apps.slice(0, 2).every((a) => a.snapshotHeights().includes(6n)), 15_000, 'snapshot at 6 on both sources');
    const trustedHash = headerHash(node.store.loadBlock(2n)!.block.header);
    const window = 1500n;
    const joiner = await n.makeNode(4, { validatorSeed: null, app: undefined, stateSync: { trustHeight: 2n, trustHash: trustedHash, backfill: false }, snapshotInterval: 0, retain: { versions: 50 }, limits: { maxEvidenceAgeMs: window } });
    const joinedAt = joiner.joinedAt!;
    const oldest = node.store.loadBlock(joinedAt)!.block.header.time - window;
    const lowest = joiner.store.lowestHeaderHeight();
    // Every header kept is within the window of the join height's time, and the one below the lowest kept is not.
    if (lowest !== null) {
      for (let h = lowest; h < joinedAt; h++) expect(joiner.store.loadHeader(h)!.time).toBeGreaterThanOrEqual(oldest);
      if (lowest > 1n) expect(node.store.loadBlock(lowest - 1n)!.block.header.time).toBeLessThan(oldest);
    } else expect(node.store.loadBlock(joinedAt - 1n)!.block.header.time).toBeLessThan(oldest);
    n.nodes.push(joiner);
    await joiner.start();
    // Once the chain's time has moved a window past the join, nothing below it can be named by evidence, and the headers go.
    await waitFor(() => joiner.store.lowestHeaderHeight() === null, 30_000, () => `headers to age out (lowest ${joiner.store.lowestHeaderHeight()})`);
    expect(joiner.store.loadHeader(joinedAt - 1n)).toBeNull();
  });

  it('catches up a node that missed many blocks by batched requests across peers, and prunes behind a retention window', async () => {
    net = await makeTestnet({ validators: 4, fullNodes: 1, skipStart: [4] });
    await waitForHeight(net.nodes.slice(0, 4), 45n, 60_000);
    const late = net.nodes[4]!;
    await late.start();
    await waitFor(() => late.height >= 44n, 40_000, () => `late node to sync (${late.height})`);
    expect(late.blockSync.synced).toBeGreaterThanOrEqual(40n);

    // A node retaining only ten blocks prunes the rest once it is caught up.
    // Blocks inside the evidence window are kept whatever the retention says; with no window, the window of ten rules.
    const pruned = await net.makeNode(5, { validatorSeed: null, retain: { blocks: 10 }, limits: { maxEvidenceAgeMs: 0n } });
    net.nodes.push(pruned);
    await pruned.start();
    await waitFor(() => pruned.height >= 50n, 40_000, () => `pruning node to sync (${pruned.height})`);
    await waitFor(() => pruned.store.lowestHeight() >= pruned.height - 10n, 10_000, 'pruning to run');
    expect(pruned.store.loadBlock(pruned.store.lowestHeight() - 1n)).toBeNull();
    expect(pruned.store.loadBlock(pruned.store.lowestHeight())).not.toBeNull();
  });

  it('gossips evidence from a node that cannot propose, and decides a height from a fetched block', async () => {
    net = await makeTestnet({ validators: 4, fullNodes: 1 });
    const chainId = net.genesis.chainId;
    await waitForHeight(net.nodes, 2n);
    const watcher = net.nodes[4]!;
    const victim = keyPairFromSeed(net.validatorSeed(3));
    const height = watcher.height;
    const set = watcher.executor.validatorSetAtHeight(height)!;
    const forge = (fill: number): Vote => {
      const unsigned = { type: VoteType.Prevote, height, round: 0, blockHash: new Uint8Array(32).fill(fill), validatorIndex: set.indexOf(victim.address) };
      return { ...unsigned, signature: sign(voteSignBytes(chainId, unsigned), victim.secretKey, signContext(chainId, 'vote')) };
    };
    expect(watcher.evidencePool.add(makeDuplicateVoteEvidence(forge(1), forge(2)))).toBe(true);
    expect(watcher.consensus.isValidator).toBe(false);
    await waitFor(() => net!.nodes.slice(0, 4).every((x) => (x.app as KvStoreApp).slashed.some((m) => m.height === height)), 20_000, 'gossiped evidence to reach every validator');

    // Proposals never reach validator 3; it still decides every height by fetching the block its peers precommitted.
    const target = net.addrOf(3);
    net.hub.messageFilter = (_from, to, frame) => !(to === target && decodeMessage(frame).type === 'proposal');
    const before = net.nodes[3]!.consensus.status().decisions;
    const h0 = net.nodes[3]!.height;
    await waitFor(() => net!.nodes[3]!.height >= h0 + 4n, 30_000, () => `validator 3 to keep deciding (${net!.nodes[3]!.height})`);
    expect(net.nodes[3]!.consensus.status().decisions).toBeGreaterThan(before);
    expect(net.nodes[3]!.blockSync.synced).toBe(0n);
  });
});
