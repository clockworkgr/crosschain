/**
 * Proposer priorities and the header's commitment to them: what the two hashes of a validator set cover, which
 * headers carry the commitment, what block validation and a node joining from a snapshot do with it, and a chain
 * of protocol version 1 that has none.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { appGenesisBytes, authorityJson } from '../src/app/core/genesis.ts';
import { CORE_TYPES } from '../src/app/core/types.ts';
import { Reader } from '../src/codec/reader.ts';
import { encode } from '../src/codec/writer.ts';
import { DEFAULT_LIMITS } from '../src/consensus/consensus.ts';
import { validateBlockStructure } from '../src/consensus/validate.ts';
import { DEFAULT_SCHEME, keyPairFromSeed, schemeName } from '../src/crypto/keys.ts';
import { Network } from '../src/p2p/network.ts';
import { PeerDb } from '../src/p2p/peerdb.ts';
import { Requester } from '../src/p2p/request.ts';
import { headerFromJson, jsonify } from '../src/rpc/json.ts';
import { MemoryBlockStore } from '../src/store/blockstore.ts';
import { MemoryKv } from '../src/store/kv.ts';
import { stateSync } from '../src/sync/statesync.ts';
import { PRIORITIES_VERSION, decodeHeader, encodeHeader, headerHash, type Block, type Header } from '../src/types/block.ts';
import { PROTOCOL_VERSION, genesisState } from '../src/types/state.ts';
import { ValidatorSet, prioritiesHash } from '../src/types/validator.ts';
import { makeTestnet, seedFor, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const keys = [3n, 2n, 1n].map((power, i) => ({ publicKey: keyPairFromSeed(seedFor(`priorities/val/${i}`)).publicKey, power }));

/** The set with one unit of priority moved between two validators that are not proposing: same members, same proposer now. */
function shifted(set: ValidatorSet): ValidatorSet {
  const copy = set.copy();
  const others = copy.validators.filter((v) => v !== copy.proposer());
  others[0]!.priority += 1n;
  others[1]!.priority -= 1n;
  return copy;
}

/** The set with every priority as it was and another validator marked as the proposer: its stored form with the last field changed. */
function reindexed(set: ValidatorSet): ValidatorSet {
  const bytes = encode((w) => set.encode(w));
  const other = (set.indexOf(set.proposer().address) + 1) % set.size;
  return ValidatorSet.decode(new Reader(new Uint8Array([...bytes.subarray(0, bytes.length - 8), ...encode((w) => w.i64(BigInt(other)))])));
}

describe('proposer priorities', () => {
  let net: Testnet | null = null;
  let joiner: Network | null = null;
  afterEach(async () => {
    await joiner?.stop();
    joiner = null;
    await net?.stop();
    net = null;
  });

  it('hashes a set by its members and its priorities apart, and commits a header to the priorities from version 2', () => {
    const set = ValidatorSet.create(keys);
    const later = set.copy();
    later.incrementProposerPriority(1);
    // The members' hash does not move as the set takes its turns; the priorities' hash does.
    expect(later.hash()).toEqual(set.hash());
    expect(later.prioritiesHash()).not.toEqual(set.prioritiesHash());
    expect(set.copy().prioritiesHash()).toEqual(set.prioritiesHash());
    // A different split of the same priorities is a different hash, with the same proposer for now.
    const other = shifted(set);
    expect(other.proposer().address).toEqual(set.proposer().address);
    expect(other.prioritiesHash()).not.toEqual(set.prioritiesHash());
    // So is another proposer over the same priorities: the index is committed to as well.
    const marked = reindexed(set);
    expect(marked.validators.map((v) => v.priority)).toEqual(set.validators.map((v) => v.priority));
    expect(marked.hash()).toEqual(set.hash());
    expect(marked.proposer().address).not.toEqual(set.proposer().address);
    expect(marked.prioritiesHash()).not.toEqual(set.prioritiesHash());
    // A stored set comes back with both.
    const back = ValidatorSet.decode(new Reader(encode((w) => set.encode(w))));
    expect(back.prioritiesHash()).toEqual(set.prioritiesHash());
    // The header's hash is over the two sets in order.
    expect(prioritiesHash(set, later)).not.toEqual(prioritiesHash(later, set));

    expect(PROTOCOL_VERSION).toBe(PRIORITIES_VERSION);
    const zero = new Uint8Array(32);
    const v1: Header = { chainId: 'p', version: 1, height: 1n, time: 1n, lastBlockHash: zero, lastCommitHash: zero, dataHash: zero, lastResultsHash: zero, validatorsHash: zero, nextValidatorsHash: zero, appHash: zero, evidenceHash: zero, proposerAddress: zero };
    const v2: Header = { ...v1, version: 2, prioritiesHash: prioritiesHash(set, later) };
    const bytes1 = encode((w) => encodeHeader(w, v1));
    const bytes2 = encode((w) => encodeHeader(w, v2));
    expect(bytes2.length).toBe(bytes1.length + 32);
    expect(decodeHeader(new Reader(bytes1))).toEqual(v1);
    expect(decodeHeader(new Reader(bytes2))).toEqual(v2);
    expect('prioritiesHash' in decodeHeader(new Reader(bytes1))).toBe(false);
    // The field belongs to the version: neither a version 2 header without it nor a version 1 header with it has an encoding.
    expect(() => headerHash({ ...v1, version: 2 })).toThrow(/needs a prioritiesHash/);
    expect(() => headerHash({ ...v2, version: 1 })).toThrow(/has no prioritiesHash/);
    // A header changed in that hash alone is another block.
    expect(headerHash({ ...v2, prioritiesHash: prioritiesHash(later, set) })).not.toEqual(headerHash(v2));
    // And over the RPC.
    expect(headerFromJson(jsonify(v2))).toEqual(v2);
    expect(headerFromJson(jsonify(v1))).toEqual(v1);
    expect(() => headerFromJson({ ...(jsonify(v2) as object), prioritiesHash: undefined })).toThrow(/prioritiesHash/);
  });

  it('starts a chain under version 1 or 2 and no other, and refuses a block whose header commits to other priorities', () => {
    const genesis = (version?: number) => ({ chainId: 'p', genesisTime: 1n, signatureScheme: schemeName(DEFAULT_SCHEME), validators: keys, appState: new Uint8Array(0), ...(version === undefined ? {} : { consensus: { version } }) });
    expect(genesisState(genesis(), new Uint8Array(32)).version).toBe(2);
    expect(genesisState(genesis(1), new Uint8Array(32)).version).toBe(1);
    expect(() => genesisState(genesis(3), new Uint8Array(32))).toThrow(/protocol version 3/);
    expect(() => genesisState(genesis(0), new Uint8Array(32))).toThrow(/protocol version 0/);

    const check = (version: number, change: (h: Header) => Header) => {
      const state = genesisState(genesis(version), new Uint8Array(32));
      const zero = new Uint8Array(32);
      const base: Header = {
        chainId: 'p', version, height: 1n, time: 2n, lastBlockHash: state.lastBlockHash, lastCommitHash: zero, dataHash: zero, lastResultsHash: state.lastResultsHash,
        validatorsHash: state.validators.hash(), nextValidatorsHash: state.nextValidators.hash(), appHash: state.appHash, evidenceHash: zero,
        proposerAddress: state.validators.proposer().address,
        ...(version >= PRIORITIES_VERSION ? { prioritiesHash: prioritiesHash(state.validators, state.nextValidators) } : {}),
      };
      const block: Block = { header: change(base), txs: [], lastCommit: null, evidence: [] };
      const error = validateBlockStructure(state, block, DEFAULT_LIMITS, null, () => null);
      // Whatever else these bare blocks lack, the hashes of the sets are checked first.
      return { state, error };
    };
    const good = check(2, (h) => h);
    expect(good.error).not.toMatch(/prioritiesHash|validatorsHash/);
    // The sets of the state in the wrong order, the priorities of one of them alone, and those of a set with the same members.
    expect(check(2, (h) => ({ ...h, prioritiesHash: prioritiesHash(good.state.nextValidators, good.state.validators) })).error).toBe('wrong prioritiesHash');
    expect(check(2, (h) => ({ ...h, prioritiesHash: good.state.validators.prioritiesHash() })).error).toBe('wrong prioritiesHash');
    expect(check(2, (h) => ({ ...h, prioritiesHash: prioritiesHash(shifted(good.state.validators), good.state.nextValidators) })).error).toBe('wrong prioritiesHash');
    expect(check(2, (h) => ({ ...h, prioritiesHash: undefined })).error).toBe('wrong prioritiesHash');
    // A version 1 chain checks none, and a header of the other version is refused for its version.
    expect(check(1, (h) => h).error).toBe(good.error);
    expect(check(1, (h) => ({ ...h, version: 2, prioritiesHash: new Uint8Array(32) })).error).toMatch(/protocol version 2, expected 1/);
    expect(check(2, (h) => ({ ...h, version: 1, prioritiesHash: undefined })).error).toMatch(/protocol version 1, expected 2/);
  });

  it('runs a chain of version 1 with headers as they were', async () => {
    net = await makeTestnet({ validators: 4, consensus: { version: 1 } });
    await waitForHeight(net.nodes, 4n);
    for (const node of net.nodes) {
      expect(node.executor.state.version).toBe(1);
      for (let h = 1n; h <= 3n; h++) expect(node.store.loadBlock(h)!.block.header.prioritiesHash).toBeUndefined();
    }
  });

  it('commits every header to the priorities its node holds, and joins from a snapshot only with the sets the headers commit to', async () => {
    const faucet = keyPairFromSeed(seedFor('priorities/faucet'));
    net = await makeTestnet({
      validators: 4,
      appFor: (i, _d, genesis) => new CoreApp({ genesis, verifier, snapshotInterval: i < 2 ? 6 : 0, snapshotChunkObjects: 2, retainVersions: 50 }),
      appState: new TextDecoder().decode(appGenesisBytes({ accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '1000000000' }], staking: { inflationMinBps: 0, inflationMaxBps: 0 } })),
    });
    const sources = net.nodes.slice(0, 2);
    await waitForHeight(net.nodes, 9n);
    // Two of the four validators stop, and the chain with them, so the snapshot at 6 stays the latest.
    await Promise.all(net.nodes.slice(2).map((n) => n.stop()));
    await waitFor(() => sources.every((n) => (n.app as CoreApp).snapshotHeights().includes(6n)), 15_000, 'snapshot at 6 on both sources');
    // Each header names, with its two set hashes and this one, exactly the sets the node kept for its height and the next.
    for (const node of net.nodes) {
      for (let h = 1n; h <= 8n; h++) {
        const header = node.store.loadBlock(h)!.block.header;
        expect(header.version).toBe(2);
        expect(header.prioritiesHash).toEqual(prioritiesHash(node.store.loadValidatorsAt(h)!, node.store.loadValidatorsAt(h + 1n)!));
      }
    }

    const network = new Network({ chainId: net.genesis.chainId, nodeKey: keyPairFromSeed(seedFor('priorities/joiner')), transport: net.hub.transport('joiner:1'), listenAddr: null, peerDb: new PeerDb(null, [net.addrOf(0), net.addrOf(1)]), verifier, getHeight: () => 0n, log: () => {}, connectIntervalMs: 50 });
    joiner = network;
    const requester = new Requester(network);
    await network.start();
    await waitFor(() => network.peers.size === 2, 5000, 'the joiner to reach both sources');
    const join = (chainStore: MemoryBlockStore) =>
      stateSync({ chainId: net!.genesis.chainId, network, requester, verifier, chainStore, appKv: new MemoryKv(), types: CORE_TYPES, log: () => {}, trustHeight: 2n, trustHash: headerHash(sources[0]!.store.loadBlock(2n)!.block.header), scheme: DEFAULT_SCHEME, evidenceAgeMs: () => 0n, requestTimeoutMs: 2000 });

    // A source that hands out its sets with the priorities shifted: the members' hash is right and so is the proposer
    // each height had, which is all a joiner could check before the header said more.
    const honest = sources.map((n) => n.store.loadValidatorsAt.bind(n.store));
    const lie = (i: number, heights: bigint[], how = shifted) => {
      sources[i]!.store.loadValidatorsAt = (h) => {
        const set = honest[i]!(h);
        return set && heights.includes(h) ? how(set) : set;
      };
    };

    // One source lies about the set of the snapshot height alone, the other is honest: the join takes the true sets.
    lie(0, [6n]);
    const store = new MemoryBlockStore();
    expect(await join(store)).toEqual({ height: 6n });
    const state = store.loadState()!;
    expect(state.lastValidators.prioritiesHash()).toEqual(honest[1]!(6n)!.prioritiesHash());
    expect(state.validators.prioritiesHash()).toEqual(honest[1]!(7n)!.prioritiesHash());
    expect(state.nextValidators.prioritiesHash()).toEqual(honest[1]!(8n)!.prioritiesHash());
    expect(store.loadValidatorsAt(6n)!.prioritiesHash()).toEqual(honest[1]!(6n)!.prioritiesHash());

    // Both lie, each about another of the three sets: there is no join, and each is charged.
    const before = sources.map((n) => network.scoreOf(n.network.id));
    lie(0, [8n]);
    lie(1, [7n]);
    await expect(join(new MemoryBlockStore())).rejects.toThrow(/no peer serves the validator sets of heights 7 and 8/);
    sources.forEach((n, i) => expect(network.scoreOf(n.network.id)).toBeGreaterThan(before[i]! + 40));
    // Both lie about the set of the snapshot height, one of them with the priorities right and another proposer marked.
    lie(0, [6n], reindexed);
    lie(1, [6n]);
    await expect(join(new MemoryBlockStore())).rejects.toThrow(/no peer serves the validator set of height 6/);
  });
});
