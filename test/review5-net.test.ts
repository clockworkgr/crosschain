/**
 * Networking, sync, consensus intake and the mempool at their edges: what the peer database records and survives,
 * how a refused handshake ends, which address a ban and the connect loop go by, which address lists are taken,
 * what block sync and state sync accept from a peer, what a vote or a proposal may cost before it is checked, and
 * what the mempool remembers and admits when checks run at once.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { appGenesisBytes, authorityJson } from '../src/app/core/genesis.ts';
import { CORE_TYPES } from '../src/app/core/types.ts';
import type { Application, CheckTxOptions } from '../src/app/types.ts';
import { Reader } from '../src/codec/reader.ts';
import { encode } from '../src/codec/writer.ts';
import { DEFAULT_LIMITS, MAX_ROUND_AHEAD } from '../src/consensus/consensus.ts';
import { DEFAULT_SCHEME, keyPairFromSeed } from '../src/crypto/keys.ts';
import { InlineVerifier } from '../src/crypto/verifier.ts';
import { Mempool } from '../src/mempool.ts';
import { MemoryHub } from '../src/p2p/memory.ts';
import { decodeMessage, type Message } from '../src/p2p/messages.ts';
import { Network, type NetworkConfig } from '../src/p2p/network.ts';
import { PeerDb } from '../src/p2p/peerdb.ts';
import { Requester } from '../src/p2p/request.ts';
import type { Conn, Transport } from '../src/p2p/transport.ts';
import { MemoryBlockStore } from '../src/store/blockstore.ts';
import { MemoryKv } from '../src/store/kv.ts';
import { BlockSync } from '../src/sync/blocksync.ts';
import { stateSync } from '../src/sync/statesync.ts';
import { blockHash, headerHash, txHash, type Block, type Commit } from '../src/types/block.ts';
import type { Proposal } from '../src/types/proposal.ts';
import type { ChainState } from '../src/types/state.ts';
import { ValidatorSet } from '../src/types/validator.ts';
import { VoteType, type Vote } from '../src/types/vote.ts';
import { makeTestnet, seedFor, sleep, tx, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

describe('the peer layer', () => {
  const nets: Network[] = [];
  afterEach(async () => {
    await Promise.all(nets.splice(0).map((n) => n.stop()));
  });
  const makeNet = (name: string, transport: Transport, cfg: Partial<NetworkConfig> = {}): Network => {
    const n = new Network({ chainId: 'r5', nodeKey: keyPairFromSeed(seedFor(`r5/net/${name}`)), transport, listenAddr: `${name}:1`, peerDb: new PeerDb(), verifier: new InlineVerifier(), getHeight: () => 0n, log: () => {}, connectIntervalMs: 50, pingIntervalMs: 200, idleTimeoutMs: 5000, ...cfg });
    nets.push(n);
    return n;
  };

  it('counts one success for one outbound connection', async () => {
    const hub = new MemoryHub();
    const db = new PeerDb(null, ['a:1']);
    const a = makeNet('a', hub.transport('a:1'));
    const b = makeNet('b', hub.transport('b:1'), { peerDb: db, listenAddr: null }); // dials and is not dialed back
    await a.start();
    await b.start();
    await waitFor(() => b.peers.size === 1 && a.peers.size === 1, 5000, 'the two to connect');
    expect(db.all().find((r) => r.addr === 'a:1')!.successes).toBe(1);
  });

  it('leaves a connection it refused open for a moment, so the rejection can leave before the close', async () => {
    const hub = new MemoryHub();
    const inner = hub.transport('a:1');
    const times: { reject?: number; close?: number } = {};
    // The accepting side's connections, watched: when the rejection was sent and when the connection was closed.
    const watched: Transport = {
      dial: (addr) => inner.dial(addr),
      close: () => inner.close(),
      listen: (addr, onConn) =>
        inner.listen(addr, (conn) => {
          const seen: Conn = {
            get remoteAddr() {
              return conn.remoteAddr;
            },
            get closed() {
              return conn.closed;
            },
            send(frame) {
              if (decodeMessage(frame).type === 'reject') times.reject ??= performance.now();
              conn.send(frame);
            },
            onFrame: (cb) => conn.onFrame(cb),
            onClose: (cb) => conn.onClose(cb),
            close() {
              times.close ??= performance.now();
              conn.close();
            },
          };
          onConn(seen);
        }),
    };
    const a = makeNet('a', watched);
    const b = makeNet('b', hub.transport('b:1'), { chainId: 'another-chain' });
    await a.start();
    await b.start();
    await expect(b.connect('a:1')).rejects.toThrow(/rejected: wrong chain id/);
    await waitFor(() => times.close !== undefined, 2000, 'the refused connection to close');
    expect(times.reject).toBeDefined();
    expect(times.close! - times.reject!).toBeGreaterThanOrEqual(40);
  });

  it('excludes and bans a peer by the address it dialed, whatever that resolved to', async () => {
    const hub = new MemoryHub();
    const inner = hub.transport('b:1');
    const dials: string[] = [];
    // A name that resolves to another address, as a host name does over TCP: the connection reports the address.
    const resolving: Transport = {
      dial: (addr) => {
        dials.push(addr);
        return inner.dial(addr === 'name:1' ? 'a:1' : addr);
      },
      listen: (addr, onConn) => inner.listen(addr, onConn),
      close: () => inner.close(),
    };
    const db = new PeerDb(null, ['name:1']);
    // The other side advertises no address, so the name is the only record this node has of it.
    const a = makeNet('a', hub.transport('a:1'), { advertiseAddr: '' });
    const b = makeNet('b', resolving, { peerDb: db, listenAddr: null }); // not dialed back, so its connection is the one it made
    await a.start();
    await b.start();
    await waitFor(() => b.peers.size === 1, 5000, 'the dial by name to connect');
    const peer = b.peers.get(a.id)!;
    expect(peer.remoteAddr).toBe('a:1');
    expect(peer.dialedAddr).toBe('name:1');
    // Past the first backoff, the connect loop still leaves the address of a connected peer alone.
    await sleep(1300);
    expect(dials).toEqual(['name:1']);
    expect(b.peers.get(a.id)).toBe(peer);
    // A ban lands on the record that was dialed, and makes no record of the resolved address.
    b.score(a.id, 100, 'test');
    expect(b.peers.size).toBe(0);
    expect(db.isBanned('name:1')).toBe(true);
    expect(db.all().map((r) => r.addr)).toEqual(['name:1']);
    expect(db.candidates(new Set(), Date.now() + 120_000)).toEqual([]);
  });

  it('takes an address list only in answer to its own request', async () => {
    const hub = new MemoryHub();
    const db = new PeerDb(null, ['a:1']);
    const a = makeNet('a', hub.transport('a:1'));
    const b = makeNet('b', hub.transport('b:1'), { peerDb: db, listenAddr: null }); // dials and is not dialed back
    await a.start();
    await b.start();
    await waitFor(() => b.peers.size === 1 && a.peers.size === 1, 5000, 'the two to connect');
    await sleep(100); // the exchange each side begins on connecting is over
    const toB = a.peers.get(b.id)!;
    toB.send({ type: 'addrResponse', addrs: ['unasked:1'] });
    await sleep(100);
    expect(db.all().map((r) => r.addr)).not.toContain('unasked:1');
    expect(b.peers.size).toBe(1);
  });

  it('starts from its seeds when the peer file is cut short, and replaces the file whole when it saves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crosschain-peers-'));
    try {
      const file = join(dir, 'peers.json');
      writeFileSync(file, '[{"addr":"old:1","lastSeen":0,"lastAtt');
      const db = new PeerDb(file, ['seed:1']);
      expect(db.all().map((r) => r.addr)).toEqual(['seed:1']);
      db.markFailure('seed:1');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([{ addr: 'seed:1', lastSeen: 0, lastAttempt: 0, failures: 1, successes: 0 }]);
      expect(existsSync(`${file}.tmp`)).toBe(false);
      expect(new PeerDb(file).all()[0]!.failures).toBe(1);
      // Valid JSON that is no list of records is no peer file either.
      writeFileSync(file, '{"addr":"x:1"}');
      expect(new PeerDb(file).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('block sync', () => {
  const zero = new Uint8Array(32);
  const blockAt = (height: bigint): { block: Block; commit: Commit } => {
    const block: Block = {
      header: { chainId: 'r5', version: 0, height, time: height, lastBlockHash: zero, lastCommitHash: zero, dataHash: zero, lastResultsHash: zero, validatorsHash: zero, nextValidatorsHash: zero, appHash: zero, evidenceHash: zero, proposerAddress: zero },
      txs: [],
      lastCommit: null,
      evidence: [],
    };
    return { block, commit: { height, round: 0, blockHash: blockHash(block), signatures: [] } };
  };

  /** A block sync with one peer, whose answers the test writes; nothing here verifies a block for real. */
  function harness(opts: { respond: (from: bigint, count: number) => { block: Block; commit: Commit }[]; deciding?: boolean; perRequest?: number }) {
    const handlers = new Map<string, (peer: { id: string }, m: { height: bigint }) => void>();
    const peer = { id: 'peer', send: () => {} };
    const network = { on: (type: string, fn: (peer: { id: string }, m: { height: bigint }) => void) => handlers.set(type, fn), onPeer: () => {}, onPeerGone: () => {}, peers: new Map([[peer.id, peer]]) } as unknown as Network;
    const requester = { request: async (_p: unknown, m: Extract<Message, { type: 'blocksRequest' }>) => ({ type: 'blocksResponse', from: m.from, blocks: opts.respond(m.from, m.count) }) } as unknown as Requester;
    const h = { ours: 0n, applied: [] as bigint[], scores: [] as [string, number][] };
    const sync = new BlockSync({
      chainId: 'r5',
      getState: () => ({ lastHeight: h.ours }) as ChainState,
      applyBlock: async (block) => {
        h.applied.push(block.header.height);
      },
      validatorSetAtHeight: () => null,
      blockTimeAt: () => null,
      store: new MemoryBlockStore(),
      verifier,
      limits: DEFAULT_LIMITS,
      network,
      requester,
      isConsensusDeciding: () => opts.deciding ?? false,
      onBlockApplied: () => {},
      log: () => {},
      scorePeer: (id, points) => h.scores.push([id, points]),
      lagGraceMs: 0,
      window: opts.perRequest ?? 8,
      perRequest: opts.perRequest ?? 8,
    });
    const buffer = (sync as unknown as { buffer: Map<bigint, unknown> }).buffer;
    return { sync, h, buffer, status: (height: bigint) => handlers.get('status')!(peer, { height }) };
  }

  it('applies nothing after it was stopped, though a block was being verified', async () => {
    const t = harness({ respond: (from, count) => Array.from({ length: count }, (_, i) => blockAt(from + BigInt(i))) });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let verifying = false;
    (t.sync as unknown as { verify: () => Promise<string | null> }).verify = async () => {
      verifying = true;
      await gate;
      return null;
    };
    t.sync.start();
    t.status(2n);
    await waitFor(() => verifying, 2000, 'the first block to reach verification');
    t.sync.stop();
    release();
    await sleep(20);
    expect(t.h.applied).toEqual([]);
  });

  it('lets go of the blocks it held once no peer is ahead', async () => {
    // Consensus is deciding, so what arrives is held and not applied.
    const t = harness({ respond: (from, count) => Array.from({ length: count }, (_, i) => blockAt(from + BigInt(i))), deciding: true });
    t.sync.start();
    t.status(2n);
    await waitFor(() => t.buffer.size === 2, 2000, 'both blocks to be held');
    expect(t.sync.isSyncing).toBe(true);
    // Consensus decided both heights itself; the peer reports the same height again.
    t.h.ours = 2n;
    t.status(2n);
    expect(t.buffer.size).toBe(0);
    expect(t.sync.isSyncing).toBe(false);
    t.sync.stop();
  });

  it('uses nothing of a response with more blocks than it asked for, and charges the peer', async () => {
    const asked: number[] = [];
    const t = harness({
      respond: (from, count) => {
        asked.push(count);
        return Array.from({ length: count + 3 }, (_, i) => blockAt(from + BigInt(i)));
      },
      deciding: true,
      perRequest: 4,
    });
    t.sync.start();
    t.status(20n);
    await waitFor(() => t.h.scores.length > 0, 2000, 'the peer to be charged');
    expect(asked).toEqual([4]);
    expect(t.h.scores).toEqual([['peer', 50]]);
    expect(t.buffer.size).toBe(0);
    t.sync.stop();
  });

  it('charges a peer for a block of another height and for a commit that names another block', async () => {
    for (const spoil of ['height', 'commit'] as const) {
      const t = harness({
        respond: (from, count) => {
          const blocks = Array.from({ length: count }, (_, i) => blockAt(from + BigInt(i)));
          if (spoil === 'height') blocks[1] = blockAt(from + 7n);
          else blocks[1]!.commit.blockHash = new Uint8Array(32).fill(9);
          return blocks;
        },
        deciding: true,
        perRequest: 4,
      });
      t.sync.start();
      t.status(20n);
      await waitFor(() => t.h.scores.length > 0, 2000, `the peer to be charged (${spoil})`);
      expect(t.h.scores).toEqual([['peer', 50]]);
      expect(t.buffer.size).toBe(0);
      t.sync.stop();
    }
  });
});

describe('state sync', () => {
  let net: Testnet | null = null;
  let joiner: Network | null = null;
  afterEach(async () => {
    await joiner?.stop();
    joiner = null;
    await net?.stop();
    net = null;
  });

  it('passes over a snapshot from before the trusted height, and charges a peer for a manifest that does not decode', async () => {
    const faucet = keyPairFromSeed(seedFor('r5/faucet'));
    net = await makeTestnet({
      validators: 4,
      appFor: (i, _d, genesis) => new CoreApp({ genesis, verifier, snapshotInterval: i < 2 ? 6 : 0, snapshotChunkObjects: 2, retainVersions: 50 }),
      appState: new TextDecoder().decode(appGenesisBytes({ accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '1000000000' }], staking: { inflationMinBps: 0, inflationMaxBps: 0 } })),
    });
    const sources = net.nodes.slice(0, 2);
    const apps = sources.map((n) => n.app as CoreApp);
    await waitForHeight(net.nodes, 8n);
    // Two of the four validators stop, and the chain with them, before the next snapshot is due at 12.
    await Promise.all(net.nodes.slice(2).map((n) => n.stop()));
    await waitFor(() => apps.every((a) => a.snapshotHeights().includes(6n)), 15_000, 'snapshot at 6 on both sources');
    const top = sources.reduce((m, n) => (n.height < m ? n.height : m), sources[0]!.height);
    expect(top).toBeLessThan(12n);
    expect(apps.every((a) => !a.snapshotHeights().includes(12n))).toBe(true);

    const network = new Network({ chainId: net.genesis.chainId, nodeKey: keyPairFromSeed(seedFor('r5/joiner')), transport: net.hub.transport('joiner:1'), listenAddr: null, peerDb: new PeerDb(null, [net.addrOf(0), net.addrOf(1)]), verifier, getHeight: () => 0n, log: () => {}, connectIntervalMs: 50 });
    joiner = network;
    const requester = new Requester(network);
    await network.start();
    await waitFor(() => network.peers.size === 2, 5000, 'the joiner to reach both sources');
    const join = (trustHeight: bigint) =>
      stateSync({ chainId: net!.genesis.chainId, network, requester, verifier, chainStore: new MemoryBlockStore(), appKv: new MemoryKv(), types: CORE_TYPES, log: () => {}, trustHeight, trustHash: headerHash(sources[0]!.store.loadBlock(trustHeight)!.block.header), scheme: DEFAULT_SCHEME, evidenceAgeMs: () => 0n, requestTimeoutMs: 2000 });

    // Trust begins two heights or more after the only snapshot: nothing can verify it, so it is no candidate.
    expect(top).toBeGreaterThanOrEqual(8n);
    expect(await join(top)).toBeNull();

    // Trust from before the snapshot, and both sources answer the manifest request with bytes that are no manifest.
    for (const app of apps) app.manifestBytes = () => new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    await expect(join(2n)).rejects.toThrow(/no valid manifest/);
    for (const n of sources) expect(network.scoreOf(n.network.id)).toBeGreaterThan(40); // one offence, minus a moment of decay
  });
});

describe('consensus intake', () => {
  let net: Testnet | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
  });

  it('drops a vote for a round far ahead before verifying it, holds few unchecked proposals from one peer, and forgets block requests with the height', async () => {
    // Two of four validators: the height stays where it is until the others start.
    net = await makeTestnet({ validators: 4, skipStart: [2, 3] });
    const node = net.nodes[0]!;
    const consensus = node.consensus;
    expect(consensus.height).toBe(1n);

    // A bad signature costs its sender points when it is verified; a vote dropped first costs nothing.
    const vote = (round: number): Vote => ({ type: VoteType.Prevote, height: 1n, round, blockHash: null, validatorIndex: 0, signature: new Uint8Array(64) });
    await consensus.handleVote(vote(consensus.round + MAX_ROUND_AHEAD + 1), 'far');
    expect(node.network.scoreOf('far')).toBe(0);
    await consensus.handleVote(vote(consensus.round + 1), 'near');
    expect(node.network.scoreOf('near')).toBeGreaterThan(19);

    // Proposals for the next height wait unchecked. One peer fills two places and no more; another still gets in.
    const held = () => (consensus as unknown as { nextHeightProposals: { from: string | null }[] }).nextHeightProposals;
    // The block is of another height than the proposal, so each is dropped at a glance when the height starts.
    const junk = (round: number) => ({ height: 2n, round, polRound: -1, block: { header: { height: 0n } }, signature: new Uint8Array(64) }) as unknown as Proposal;
    for (let r = 0; r < 10; r++) void consensus.handleProposal(junk(r), 'junk');
    expect(held().filter((e) => e.from === 'junk').length).toBe(2);
    void consensus.handleProposal(junk(0), 'other');
    expect(held().filter((e) => e.from === 'other').length).toBe(1);

    // The hashes of blocks asked for are kept for the height they belong to and no longer.
    const fetchRequested = (consensus as unknown as { fetchRequested: Set<string> }).fetchRequested;
    fetchRequested.add('a-hash-of-height-1');
    await net.nodes[2]!.start();
    await net.nodes[3]!.start();
    await waitForHeight(net.nodes, 2n);
    expect(fetchRequested.has('a-hash-of-height-1')).toBe(false);
    expect(held().filter((e) => e.from === 'junk').length).toBe(0);
  });
});

describe('a validator set from bytes', () => {
  it('has no proposer when it is empty, and says so in the one way create() does', () => {
    const empty = (proposerIndex: bigint) => encode((w) => w.array([], () => {}).i64(proposerIndex));
    expect(ValidatorSet.decode(new Reader(encode((w) => ValidatorSet.create([]).encode(w)))).size).toBe(0);
    expect(ValidatorSet.decode(new Reader(empty(-1n))).size).toBe(0);
    for (const i of [0n, 5n, -2n]) expect(() => ValidatorSet.decode(new Reader(empty(i)))).toThrow(/proposer index out of range/);
  });
});

describe('the mempool', () => {
  /** An application that admits as the core application does: after its last wait, and applies what was admitted. */
  function gatedApp() {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const applied: Uint8Array[] = [];
    const app = {
      checkTx: async (bytes: Uint8Array, opts: CheckTxOptions = {}) => {
        await gate;
        const refused = opts.admit?.() ?? null;
        if (refused !== null) return { ok: false, error: refused };
        if (bytes[0] === 0xee) return { ok: false, error: 'refused after it was admitted' };
        applied.push(bytes);
        return { ok: true };
      },
    } as unknown as Application;
    return { app, applied, release: () => release() };
  }

  it('admits one of two transactions checked at once for the last place, and applies only that one', async () => {
    const { app, applied, release } = gatedApp();
    const pool = new Mempool(app, { maxTxs: 1 });
    const a = pool.addTx(new Uint8Array([1]));
    const b = pool.addTx(new Uint8Array([2]));
    release();
    expect((await a).status).toBe('added');
    expect((await b).status).toBe('full');
    expect(applied).toEqual([new Uint8Array([1])]);
    // The refused one was not remembered, and the place the first held while checked is its place in the pool now.
    expect(pool.accepting).toBe(false);
    await pool.update([new Uint8Array([1])]);
    expect(pool.accepting).toBe(true);
    expect((await pool.addTx(new Uint8Array([2]))).status).toBe('added');
  });

  it('gives back the place of a transaction that was admitted and then refused', async () => {
    const { app, release } = gatedApp();
    release();
    const pool = new Mempool(app, { maxTxs: 1 });
    expect((await pool.addTx(new Uint8Array([0xee]))).status).toBe('invalid');
    expect(pool.accepting).toBe(true);
    expect((await pool.addTx(new Uint8Array([3]))).status).toBe('added');
  });

  it('keeps a transaction it forgot and saw again for as long as any other, and never forgets one that is pooled', async () => {
    let fail = true;
    const app = {
      checkTx: async () => {
        if (fail) throw new Error('verifier closed');
        return { ok: true };
      },
    } as unknown as Application;
    const pool = new Mempool(app, { cacheSize: 3 });
    // The first check of x decides nothing, so x is forgotten; it comes again and is remembered then.
    await expect(pool.addTx(tx('x'))).rejects.toThrow(/verifier closed/);
    fail = false;
    expect((await pool.addTx(tx('x'))).status).toBe('added');
    await pool.update([tx('x')]); // committed: only the cache knows it now
    expect((await pool.addTx(tx('a'))).status).toBe('added');
    // The cache is full and b takes the oldest place, the one x's first coming left behind. x itself stays.
    expect((await pool.addTx(tx('b'))).status).toBe('added');
    expect(pool.seen(txHash(tx('x')))).toBe(true);
    expect((await pool.addTx(tx('x'))).status).toBe('seen');
    // c takes the place x holds now, and x is gone.
    expect((await pool.addTx(tx('c'))).status).toBe('added');
    expect(pool.seen(txHash(tx('x')))).toBe(false);

    // A cache of one place lets go of a at once, but a is in the pool, and is neither checked nor announced twice.
    const small = new Mempool(app, { cacheSize: 1 });
    let announced = 0;
    small.on('tx', () => announced++);
    expect((await small.addTx(tx('a'))).status).toBe('added');
    expect((await small.addTx(tx('b'))).status).toBe('added');
    expect(small.seen(txHash(tx('a')))).toBe(true);
    expect((await small.addTx(tx('a'))).status).toBe('seen');
    expect(announced).toBe(2);
    expect(small.size).toBe(2);
  });
});
