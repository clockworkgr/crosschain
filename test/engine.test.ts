import { afterEach, describe, expect, it } from 'vitest';
import type { KvStoreApp } from '../src/app/kvstore.ts';
import { keyPairFromSeed, sign, signContext } from '../src/crypto/keys.ts';
import { makeDuplicateVoteEvidence } from '../src/types/evidence.ts';
import { genesisState, PROTOCOL_VERSION } from '../src/types/state.ts';
import { validateBlockStructure } from '../src/consensus/validate.ts';
import { DEFAULT_LIMITS } from '../src/consensus/consensus.ts';
import { VoteType, voteSignBytes, type Vote } from '../src/types/vote.ts';
import { makeTestnet, waitFor, waitForHeight, type Testnet } from './helpers.ts';

describe('engine changes for staking', () => {
  let net: Testnet | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
  });

  it('folds a precommit that arrives after the decision into the stored commit', async () => {
    net = await makeTestnet({ validators: 4, timeouts: { commitMs: 1500 } });
    const chainId = net.genesis.chainId;
    await waitForHeight(net.nodes, 2n);
    // Cut validator 3 off: the other three decide with three signatures.
    net.hub.isolate(net.addrOf(3), [0, 1, 2].map(net.addrOf));
    const node = net.nodes[0]!;
    const h0 = node.height;
    await waitFor(() => node.height === h0 + 1n, 15_000, 'a decision without validator 3');
    const h = node.height;
    const before = node.store.loadBlock(h)!.commit;
    expect(before.signatures.filter((s) => s !== null).length).toBe(3);
    expect(node.consensus.height).toBe(h); // still inside the commit timeout

    // Validator 3's precommit for the decided block turns up late (we hold its key).
    const late = keyPairFromSeed(net.validatorSeed(3));
    const set = node.executor.state.lastValidators;
    const idx = set.indexOf(late.address);
    expect(before.signatures[idx]).toBeNull();
    const unsigned = { type: VoteType.Precommit, height: h, round: before.round, blockHash: before.blockHash, validatorIndex: idx };
    const vote: Vote = { ...unsigned, signature: sign(voteSignBytes(chainId, unsigned), late.secretKey, signContext(chainId, 'vote')) };
    await node.consensus.handleVote(vote, 'late');
    const after = node.store.loadBlock(h)!.commit;
    expect(after.signatures.filter((s) => s !== null).length).toBe(4);
    expect(after.signatures[idx]).not.toBeNull();
  });

  it('drops evidence older than the configured age by block time, and keeps young evidence', async () => {
    const ageMs = 3000n;
    net = await makeTestnet({ validators: 4, limits: { maxEvidenceAgeMs: ageMs } });
    const chainId = net.genesis.chainId;
    const node = net.nodes[0]!;
    await waitForHeight(net.nodes, 3n);
    const timeOf = (h: bigint) => node.store.loadBlock(h)!.block.header.time;
    await waitFor(() => timeOf(node.height) - timeOf(2n) > ageMs + 500n, 30_000, 'height 2 to age past the limit');

    const victim = keyPairFromSeed(net.validatorSeed(3));
    const forge = (height: bigint, fill: number): Vote => {
      const set = node.executor.validatorSetAtHeight(height)!;
      const unsigned = { type: VoteType.Prevote, height, round: 0, blockHash: new Uint8Array(32).fill(fill), validatorIndex: set.indexOf(victim.address) };
      return { ...unsigned, signature: sign(voteSignBytes(chainId, unsigned), victim.secretKey, signContext(chainId, 'vote')) };
    };
    const stale = makeDuplicateVoteEvidence(forge(2n, 1), forge(2n, 2));
    expect(node.evidencePool.add(stale)).toBe(true);
    // Node 0 proposes within a few heights and discards it instead of proposing a block others would reject.
    const h = node.height;
    await waitForHeight(net.nodes, h + 8n, 30_000);
    expect(node.evidencePool.size).toBe(0);
    expect(net.nodes.every((n) => (n.app as KvStoreApp).slashed.length === 0)).toBe(true);

    const recent = node.height;
    const young = makeDuplicateVoteEvidence(forge(recent, 3), forge(recent, 4));
    expect(node.evidencePool.add(young)).toBe(true);
    await waitFor(() => net!.nodes.every((n) => (n.app as KvStoreApp).slashed.some((m) => m.height === recent)), 20_000, 'young evidence to reach every app');
  });

  it('rejects a block from another protocol version', async () => {
    net = await makeTestnet({ validators: 4 });
    await waitForHeight(net.nodes, 2n);
    const node = net.nodes[0]!;
    const { block } = node.store.loadBlock(node.height)!;
    const foreign = { ...block, header: { ...block.header, version: block.header.version + 1 } };
    expect(validateBlockStructure(node.executor.state, foreign, DEFAULT_LIMITS, null, () => null)).toMatch(/protocol version/);
    expect(node.executor.state.version).toBe(PROTOCOL_VERSION);
    expect(block.header.lastResultsHash.length).toBe(32);
  });

  it('refuses a genesis with no validators from either side', () => {
    expect(() => genesisState({ chainId: 'x', genesisTime: 0n, appState: new Uint8Array() }, new Uint8Array(32))).toThrow(/no validators/);
    expect(() => genesisState({ chainId: 'x', genesisTime: 0n, appState: new Uint8Array() }, new Uint8Array(32), [])).toThrow(/no validators/);
  });
});
