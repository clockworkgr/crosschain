/**
 * The node, the executor and the block store: a data directory claimed exclusively and given back last, a node
 * that fails to open giving back what it took, the evidence age read after the block, a commit that fails taking
 * the block's writes with it, pruning in one transaction with the sets by height, a repeated transaction indexed
 * where it succeeded, the memory store writing in order, a heap flag of zero, evidence checked for age before it
 * is pooled, items taken only when they were asked for, and a bound on the evidence in a block.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { appGenesisBytes, authorityJson } from '../src/app/core/genesis.ts';
import { KvStoreApp } from '../src/app/kvstore.ts';
import { encode } from '../src/codec/writer.ts';
import { DEFAULT_LIMITS } from '../src/consensus/consensus.ts';
import { EvidencePool } from '../src/consensus/evidence.ts';
import { MAX_EVIDENCE_PER_BLOCK, validateBlockStructure } from '../src/consensus/validate.ts';
import { sha256, toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed, sign, signContext } from '../src/crypto/keys.ts';
import { Mempool } from '../src/mempool.ts';
import { BlockExecutor } from '../src/node/executor.ts';
import { heapLimitFlag } from '../src/node/memory.ts';
import type { Node } from '../src/node/node.ts';
import { InvKind } from '../src/p2p/messages.ts';
import { KvBlockStore, MemoryBlockStore } from '../src/store/blockstore.ts';
import { MemoryKv, type KvEnv, type KvWriter } from '../src/store/kv.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
import { blockHash, commitHash, evidenceHash, txHash, type Block, type Commit, type Header } from '../src/types/block.ts';
import { encodeEvidence, makeDuplicateVoteEvidence, type DuplicateVoteEvidence } from '../src/types/evidence.ts';
import type { ChainState } from '../src/types/state.ts';
import { txsRoot } from '../src/types/txproof.ts';
import { VoteType, voteSignBytes, type Vote } from '../src/types/vote.ts';
import { silentLogger } from '../src/util/log.ts';
import { makeTestnet, seedFor, sleep, tx, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

/** The block that would follow `state`, as far as its structure goes. */
function blockAfter(state: ChainState, lastCommit: Commit | null, evidence: DuplicateVoteEvidence[] = []): { block: Block; commit: Commit } {
  const header: Header = {
    chainId: state.chainId,
    version: state.version,
    height: state.lastHeight + 1n,
    time: state.lastBlockTime + 1n,
    lastBlockHash: state.lastBlockHash,
    lastCommitHash: commitHash(lastCommit),
    dataHash: txsRoot([]),
    lastResultsHash: state.lastResultsHash,
    validatorsHash: state.validators.hash(),
    nextValidatorsHash: state.nextValidators.hash(),
    appHash: state.appHash,
    evidenceHash: evidenceHash(evidence),
    proposerAddress: state.validators.byIndex(0)!.address,
  };
  const block: Block = { header, txs: [], lastCommit, evidence };
  return { block, commit: { height: header.height, round: 0, blockHash: blockHash(block), signatures: state.validators.validators.map(() => null) } };
}

/** Two votes of validator 0 for different blocks at one height and round. */
function doubleSign(net: Testnet, node: Node, height: bigint, round = 0): DuplicateVoteEvidence {
  const chainId = net.genesis.chainId;
  const key = keyPairFromSeed(net.validatorSeed(0));
  const vote = (fill: number): Vote => {
    const unsigned = { type: VoteType.Prevote, height, round, blockHash: new Uint8Array(32).fill(fill), validatorIndex: node.executor.validatorSetAtHeight(height)!.indexOf(key.address) };
    return { ...unsigned, signature: sign(voteSignBytes(chainId, unsigned), key.secretKey, signContext(chainId, 'vote')) };
  };
  return makeDuplicateVoteEvidence(vote(1), vote(2));
}

describe('the data directory', () => {
  let net: Testnet | null = null;
  let tmp: string | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('is one directory however its path is spelled or linked to', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'r5-lock-'));
    const dir = join(tmp, 'data');
    net = await makeTestnet({ validators: 1, skipStart: [0] });
    const held = await net.makeNode(0, { dataDir: dir });
    try {
      await expect(net.makeNode(0, { dataDir: dir + sep + '.' })).rejects.toThrow(/in use by this process/);
      symlinkSync(dir, join(tmp, 'link'));
      await expect(net.makeNode(0, { dataDir: join(tmp, 'link') })).rejects.toThrow(/in use by this process/);
      // The refused attempts left the holder's claim alone.
      expect(readFileSync(join(dir, 'LOCK'), 'utf8')).toBe(String(process.pid));
    } finally {
      await held.stop();
    }
    expect(existsSync(join(dir, 'LOCK'))).toBe(false);
  });

  it('takes over the claim of a process that is gone and refuses that of one that runs', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'r5-lock-'));
    net = await makeTestnet({ validators: 1, skipStart: [0] });
    const gone = spawnSync(process.execPath, ['-e', '0']).pid;
    writeFileSync(join(tmp, 'LOCK'), String(gone));
    const node = await net.makeNode(0, { dataDir: tmp });
    expect(readFileSync(join(tmp, 'LOCK'), 'utf8')).toBe(String(process.pid));
    await node.stop();

    writeFileSync(join(tmp, 'LOCK'), String(process.ppid));
    await expect(net.makeNode(0, { dataDir: tmp })).rejects.toThrow(new RegExp(`in use by process ${process.ppid}`));
    expect(readFileSync(join(tmp, 'LOCK'), 'utf8')).toBe(String(process.ppid));
    rmSync(join(tmp, 'LOCK'));
  });

  it('takes a stale claim over only while holding the takeover file', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'r5-lock-'));
    net = await makeTestnet({ validators: 1, skipStart: [0] });
    const gone = spawnSync(process.execPath, ['-e', '0']).pid;
    writeFileSync(join(tmp, 'LOCK'), String(gone));
    // Another process holds the takeover file: the stale claim is left alone, and the start gives up saying why.
    writeFileSync(join(tmp, 'LOCK.takeover'), String(gone));
    await expect(net.makeNode(0, { dataDir: tmp })).rejects.toThrow(/LOCK\.takeover may have been left by a process that stopped/);
    expect(readFileSync(join(tmp, 'LOCK'), 'utf8')).toBe(String(gone));
    // With it removed the claim is taken, and the takeover file is not left behind.
    rmSync(join(tmp, 'LOCK.takeover'));
    const node = await net.makeNode(0, { dataDir: tmp });
    expect(readFileSync(join(tmp, 'LOCK'), 'utf8')).toBe(String(process.pid));
    expect(existsSync(join(tmp, 'LOCK.takeover'))).toBe(false);
    await node.stop();
  });

  it('stays claimed until the network is down, and is released after', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'r5-lock-'));
    const lock = join(tmp, 'LOCK');
    net = await makeTestnet({ validators: 1, skipStart: [0] });
    const transport = net.hub.transport('held:1');
    const close = transport.close.bind(transport);
    let claimedAtClose: boolean | null = null;
    transport.close = async () => {
      claimedAtClose = existsSync(lock);
      await close();
    };
    const node = await net.makeNode(0, { dataDir: tmp, transport, listenAddr: 'held:1' });
    await node.start();
    await node.stop();
    expect(claimedAtClose).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('is given back, with the store, by a node that fails to open', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'r5-open-'));
    net = await makeTestnet({ validators: 1, skipStart: [0] });
    class Broken extends KvStoreApp {
      override async initChain(): Promise<never> {
        throw new Error('no genesis for you');
      }
    }
    await expect(net.makeNode(0, { dataDir: tmp, app: new Broken() })).rejects.toThrow(/no genesis for you/);
    expect(existsSync(join(tmp, 'LOCK'))).toBe(false);
    // The same process opens the directory again: neither the claim nor the store environment was left held.
    const node = await net.makeNode(0, { dataDir: tmp });
    expect(node.height).toBe(0n);
    await node.stop();
  });
});

describe('the executor', () => {
  let net: Testnet | null = null;
  let tmp: string | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('reads the evidence age from the application when asked, not at the commit before', async () => {
    const faucet = keyPairFromSeed(seedFor('r5/faucet'));
    const operator = keyPairFromSeed(seedFor('r5/op'));
    net = await makeTestnet({
      validators: 1,
      skipStart: [0],
      engineValidators: false,
      appFor: (_i, _dataDir, genesis) => new CoreApp({ genesis, verifier }),
      appState: (keys) =>
        new TextDecoder().decode(
          appGenesisBytes({
            accounts: [
              { name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '100000000000' },
              { name: 'op0', owner: authorityJson([operator.publicKey]), active: authorityJson([operator.publicKey]), balance: '100000000' },
            ],
            staking: { minSelfBond: 100, minDelegation: 1, validatorCreationFee: 1, unbondingPeriodMs: 2000, inflationMinBps: 0, inflationMaxBps: 0 },
            validators: keys.map((k) => ({ operator: 'op0', consensusKey: toHex(k), selfBond: 200 })),
          }),
        ),
    });
    const node = net.nodes[0]!;
    const app = node.app as CoreApp;
    // What the executor prunes by, asked the way it asks after applying a block.
    const age = () => (node.executor as unknown as { d: { evidenceAgeMs: () => bigint } }).d.evidenceAgeMs();
    const before = app.stakingParameters();
    expect(age()).toBe(before.unbondingPeriodMs);
    // The application's parameters change, as a block that carries a governance change leaves them; no commit listener has run.
    app.stakingParameters = () => ({ ...before, unbondingPeriodMs: before.unbondingPeriodMs * 3n });
    expect(age()).toBe(before.unbondingPeriodMs * 3n);
  });

  it('stores nothing of a block whose application commit throws inside the shared transaction', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'r5-commit-'));
    net = await makeTestnet({ validators: 1, skipStart: [0] });
    class Failing extends KvStoreApp {
      commitSync(): void {
        throw new Error('disk full');
      }
    }
    const env = new LmdbEnv(join(tmp, 'lmdb'));
    try {
      const app = new Failing();
      const store = new KvBlockStore(env.store('chain'));
      const exec = await BlockExecutor.open({ app, store, mempool: new Mempool(app), evidencePool: new EvidencePool(), log: silentLogger, transaction: (fn) => env.transaction(fn) }, net.genesis);
      const { block, commit } = blockAfter(exec.state, null);
      await expect(exec.applyBlock(block, commit)).rejects.toThrow(/disk full/);
      expect(exec.state.lastHeight).toBe(0n);
      expect(store.loadBlock(1n)).toBeNull();
      expect(store.loadState()!.lastHeight).toBe(0n);
      expect(store.loadValidatorsAt(3n)).toBeNull();
    } finally {
      await env.close();
    }
  });

  it('prunes blocks and headers in one transaction each, the set by height going with its block', async () => {
    type Write = { puts: number[]; dels: number[] };
    class Recording extends MemoryKv {
      readonly writes: Write[] = [];
      override write(fn: (w: KvWriter) => void): void {
        const rec: Write = { puts: [], dels: [] };
        super.write((w) =>
          fn({
            put: (k, v) => {
              rec.puts.push(k[0]!);
              w.put(k, v);
            },
            del: (k) => {
              rec.dels.push(k[0]!);
              w.del(k);
            },
          }),
        );
        this.writes.push(rec);
      }
    }
    const chain = new Recording();
    const env: KvEnv = { store: (name) => (name === 'chain' ? chain : new MemoryKv()), transaction: (fn) => fn(), close: async () => {} };
    net = await makeTestnet({ validators: 1, skipStart: [0], limits: { maxEvidenceAgeMs: 1n } });
    const node = await net.makeNode(0, { env, retain: { blocks: 2 } });
    const genesisSet = node.executor.state.validators.hash();
    await node.start();
    try {
      await waitFor(() => node.store.lowestHeight() >= 4n, 20_000, 'blocks to be pruned');
      // Every write that deletes a block ('b') moves the lowest-height marker ('l') too, and no write moves it alone.
      const deleting = chain.writes.filter((w) => w.dels.includes(0x62));
      expect(deleting.length).toBeGreaterThan(0);
      expect(deleting.every((w) => w.puts.includes(0x6c))).toBe(true);
      expect(chain.writes.some((w) => w.puts.includes(0x6c) && !w.dels.includes(0x62))).toBe(false);
      // The sets by height ('V') go with their blocks; those of the heights still held, and the set by hash, stay.
      expect(deleting.every((w) => w.dels.filter((p) => p === 0x56).length === w.dels.filter((p) => p === 0x62).length)).toBe(true);
      const lowest = node.store.lowestHeight();
      expect(node.store.loadValidatorsAt(lowest - 1n)).toBeNull();
      expect(node.store.loadValidatorsAt(1n)).toBeNull();
      expect(node.store.loadValidatorsAt(lowest)).not.toBeNull();
      expect(node.store.loadValidatorsAt(node.height + 2n)).not.toBeNull();
      expect(node.store.loadValidatorSet(genesisSet)).not.toBeNull();

      // Two headers kept alone below the lowest block, older than evidence may be: the next commit lets both go, in one write with their marker.
      const header = node.store.loadBlock(node.height)!.block.header;
      node.store.batch(() => {
        node.store.saveHeader({ ...header, height: lowest - 2n, time: 1n });
        node.store.saveHeader({ ...header, height: lowest - 1n, time: 2n });
        node.store.setLowestHeaderHeight(lowest - 2n);
      });
      const from = chain.writes.length;
      await waitFor(() => node.store.lowestHeaderHeight() === null, 20_000, 'headers to be pruned');
      const headerWrites = chain.writes.slice(from).filter((w) => w.dels.includes(0x48) || w.dels.includes(0x4c));
      expect(headerWrites.length).toBe(1);
      // The two records, and the heights between them and the lowest block by then, which held none.
      expect(headerWrites[0]!.dels.filter((p) => p === 0x48).length).toBeGreaterThanOrEqual(2);
      expect(headerWrites[0]!.dels).toContain(0x4c);
      expect(node.store.loadHeader(lowest - 1n)).toBeNull();
    } finally {
      await node.stop();
    }
  });
});

describe('the stores', () => {
  it('indexes a transaction repeated in one block where it succeeded', () => {
    const raw = new Uint8Array([1, 2, 3]);
    const other = new Uint8Array([9]);
    const block = (height: bigint, txs: Uint8Array[]) => {
      const header = { chainId: 'r5', version: 1, height, time: height, lastBlockHash: new Uint8Array(32), lastCommitHash: new Uint8Array(32), dataHash: txsRoot(txs), lastResultsHash: new Uint8Array(32), validatorsHash: new Uint8Array(32), nextValidatorsHash: new Uint8Array(32), appHash: new Uint8Array(32), evidenceHash: new Uint8Array(32), proposerAddress: new Uint8Array(32) };
      const b = { header, txs, lastCommit: null, evidence: [] };
      return { b, commit: { height, round: 0, blockHash: blockHash(b), signatures: [null] } };
    };
    const store = new MemoryBlockStore();
    // Failed first, succeeded later in the same block: the success is what the index says.
    const late = block(3n, [raw, other, raw]);
    store.saveBlock(late.b, late.commit, [{ ok: false, error: 'insufficient balance' }, { ok: true }, { ok: true }]);
    expect(store.txLocations(txHash(raw))).toEqual([{ height: 3n, index: 2, ok: true, error: '' }]);
    // Succeeded first: the later failure does not take its place.
    const early = block(4n, [raw, raw]);
    store.saveBlock(early.b, early.commit, [{ ok: true }, { ok: false, error: 'duplicate transaction' }]);
    expect(store.txLocations(txHash(raw))[1]).toEqual({ height: 4n, index: 0, ok: true, error: '' });
    // Failed everywhere, or not executed here: the first position.
    const never = block(5n, [other, raw, raw]);
    store.saveBlock(never.b, never.commit, [{ ok: true }, { ok: false, error: 'first' }, { ok: false, error: 'second' }]);
    expect(store.txLocations(txHash(raw))[2]).toEqual({ height: 5n, index: 1, ok: false, error: 'first' });
    const stored = block(6n, [raw, raw]);
    store.saveBlock(stored.b, stored.commit, null);
    expect(store.txLocations(txHash(raw))[3]).toEqual({ height: 6n, index: 0, ok: null, error: '' });
    // One entry per block either way, and it goes with the block.
    store.deleteBlock(3n);
    expect(store.txLocations(txHash(raw)).map((l) => l.height)).toEqual([4n, 5n, 6n]);
  });

  it('applies the operations of one write to the memory store in the order they were made', () => {
    const kv = new MemoryKv();
    const k = Uint8Array.of(1);
    kv.write((w) => {
      w.put(k, Uint8Array.of(7));
      w.del(k);
    });
    expect(kv.get(k)).toBeUndefined();
    kv.write((w) => {
      w.put(k, Uint8Array.of(7));
      w.del(k);
      w.put(k, Uint8Array.of(8));
    });
    expect(kv.get(k)).toEqual(Uint8Array.of(8));
    // A throw still leaves the store as it was.
    expect(() =>
      kv.write((w) => {
        w.del(k);
        throw new Error('stop');
      }),
    ).toThrow(/stop/);
    expect(kv.get(k)).toEqual(Uint8Array.of(8));
  });

  it('reads a heap flag of zero as no flag', () => {
    expect(heapLimitFlag(['--max-old-space-size=0'], '')).toBeNull();
    expect(heapLimitFlag([], '--max_old_space_size=0')).toBeNull();
    // The last one wins, as in V8.
    expect(heapLimitFlag(['--max-old-space-size=512', '--max-old-space-size=0'], '')).toBeNull();
    expect(heapLimitFlag(['--max-old-space-size=0'], '--max-old-space-size=512')).toBeNull();
    expect(heapLimitFlag(['--max-old-space-size=512'], '--max-old-space-size=0')).toBe(512);
  });
});

describe('gossip and block validation', () => {
  let net: Testnet | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
  });

  it('does not pool gossiped evidence that is already too old for a block', async () => {
    const ageMs = 1500n;
    net = await makeTestnet({ validators: 1, limits: { maxEvidenceAgeMs: ageMs } });
    const node = net.nodes[0]!;
    await waitForHeight(net.nodes, 3n);
    const timeOf = (h: bigint) => node.store.loadBlock(h)!.block.header.time;
    await waitFor(() => timeOf(node.height) - timeOf(1n) > ageMs + 200n, 30_000, 'height 1 to age past the limit');
    // No further commit, whose pruning of the pool would hide what was let in.
    node.consensus.stop();
    await node.executor.idle();
    const accept = (ev: DuplicateVoteEvidence) => (node as unknown as { acceptEvidence(peer: string, data: Uint8Array): Promise<void> }).acceptEvidence('peer', encode((w) => encodeEvidence(w, ev)));

    const stale = doubleSign(net, node, 1n);
    await accept(stale);
    expect(node.evidencePool.has(stale)).toBe(false);
    expect(node.evidencePool.size).toBe(0);
    // Beyond the height being decided: not pooled either.
    await accept(doubleSign(net, node, node.height + 2n));
    expect(node.evidencePool.size).toBe(0);

    const young = doubleSign(net, node, node.height);
    await accept(young);
    expect(node.evidencePool.has(young)).toBe(true);
  });

  it('takes an item only from the peer it asked for it', async () => {
    net = await makeTestnet({ validators: 2 });
    const [a, b] = net.nodes as [Node, Node];
    await waitForHeight(net.nodes, 2n);
    // Pushed without an announcement and a fetch: not read.
    const pushed = tx('pushed=1');
    b.network.broadcast({ type: 'item', kind: InvKind.Tx, data: pushed });
    const h = a.height;
    await waitForHeight(net.nodes, h + 3n);
    await sleep(100);
    expect(a.mempool.seen(txHash(pushed))).toBe(false);
    expect(a.store.txLocation(txHash(pushed))).toBeNull();
    // Announced and fetched: taken as before.
    const announced = tx('announced=1');
    expect((await b.submitTx(announced)).status).toBe('added');
    await waitFor(() => a.store.txLocation(txHash(announced)) !== null && a.mempool.seen(txHash(announced)), 20_000, 'the announced transaction to reach the other node');
  });

  it('remembers a bounded number of fetches for a peer that announces and never answers', async () => {
    net = await makeTestnet({ validators: 2 });
    const [a, b] = net.nodes as [Node, Node];
    await waitForHeight(net.nodes, 2n);
    // b counts what a asks of it. One announcement of 3,000 unknown transactions is read in one go, before any
    // answer that b lacks one could free a place: a asks for as many as it remembers for one peer and no more.
    const fetched = new Set<string>();
    b.network.on('fetch', (_peer, m) => {
      for (const h of m.hashes) fetched.add(toHex(h));
    });
    const hashes = Array.from({ length: 3000 }, (_, i) => sha256(new TextEncoder().encode(`unknown/${i}`)));
    b.network.broadcast({ type: 'inv', kind: InvKind.Tx, hashes });
    await waitFor(() => fetched.size >= 2048, 10_000, 'the announcement to be fetched');
    await sleep(300);
    expect(fetched.size).toBe(2048);
  });

  it('refuses a block with more evidence than a block may carry', async () => {
    net = await makeTestnet({ validators: 1 });
    const node = net.nodes[0]!;
    await waitForHeight(net.nodes, 2n);
    node.consensus.stop();
    await node.executor.idle();
    const state = node.executor.state;
    const evidence = Array.from({ length: MAX_EVIDENCE_PER_BLOCK + 1 }, (_, round) => doubleSign(net!, node, state.lastHeight, round));
    const check = (evs: DuplicateVoteEvidence[]) => validateBlockStructure(state, blockAfter(state, node.executor.getLastCommit(), evs).block, { ...DEFAULT_LIMITS }, null, (h) => node.executor.blockTimeAt(h));
    expect(check(evidence)).toBe('too much evidence');
    expect(check(evidence.slice(0, MAX_EVIDENCE_PER_BLOCK))).toBeNull();
  });
});
