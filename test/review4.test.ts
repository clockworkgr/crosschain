/**
 * The items the first review noted and left (REVIEW-2026-10-28.md, "Noted and left as they are"), taken up: state
 * queries that answer as of the height asked for, a batch that pays for each of its calls, a transaction index
 * with every block a transaction is in, proofs that state no count, snapshots with every section, an evidence pool
 * that lets everything go, clock offsets from the ping, exact numbers from the codec and a node that makes its
 * own verifier pool.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson, DEFAULT_FEES } from '../src/app/core/genesis.ts';
import { TYPE } from '../src/app/core/types.ts';
import { Reader } from '../src/codec/reader.ts';
import { encode } from '../src/codec/writer.ts';
import { EvidencePool, evidenceId } from '../src/consensus/evidence.ts';
import { fromHex, toHex } from '../src/crypto/hash.ts';
import { DEFAULT_SCHEME, keyPairFromSeed, schemeName } from '../src/crypto/keys.ts';
import { InlineVerifier } from '../src/crypto/verifier.ts';
import { ObjectDatabase } from '../src/db/database.ts';
import { objectId } from '../src/db/id.ts';
import { key } from '../src/db/keys.ts';
import { keyProofFromBytes, verifyKeyProof } from '../src/db/proof.ts';
import { Node } from '../src/node/node.ts';
import { MemoryHub } from '../src/p2p/memory.ts';
import { Network } from '../src/p2p/network.ts';
import { PeerDb } from '../src/p2p/peerdb.ts';
import { RpcClient } from '../src/rpc/client.ts';
import { headerFromJson } from '../src/rpc/json.ts';
import { RpcServer } from '../src/rpc/server.ts';
import { KvBlockStore, MemoryBlockStore } from '../src/store/blockstore.ts';
import { MemoryKv, prefixEnd } from '../src/store/kv.ts';
import { blockHash, txHash } from '../src/types/block.ts';
import type { DuplicateVoteEvidence } from '../src/types/evidence.ts';
import { decodeProposal } from '../src/types/proposal.ts';
import { txsRoot } from '../src/types/txproof.ts';
import { VoteType } from '../src/types/vote.ts';
import { Keystore } from '../src/wallet/keystore.ts';
import { CORE_TYPES } from '../src/app/core/types.ts';
import { makeTestnet, seedFor, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const faucet = keyPairFromSeed(seedFor('r4/faucet'));
const alice = keyPairFromSeed(seedFor('r4/alice'));
const operators = [0, 1, 2, 3].map((i) => keyPairFromSeed(seedFor(`r4/op/${i}`)));
const FAUCET_ID = objectId(TYPE.account, 0);
const ALICE_ID = objectId(TYPE.account, 5);
const CORE = objectId(TYPE.asset, 0);
const VAL0 = objectId(TYPE.validator, 0);

describe('state queries at a height, and a batch that pays for its calls', () => {
  let net: Testnet | null = null;
  const servers: RpcServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
    await net?.stop();
    net = null;
  });

  it('answers balance, account, key, validator and delegation as of the height asked for, with the proof of that height', async () => {
    net = await makeTestnet({
      validators: 4,
      engineValidators: false,
      appFor: (_i, _dataDir, genesis) => new CoreApp({ genesis, verifier }),
      appState: (keys) =>
        new TextDecoder().decode(
          appGenesisBytes({
            accounts: [
              { name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '100000000000' },
              ...operators.map((k, i) => ({ name: `op${i}`, owner: authorityJson([k.publicKey]), active: authorityJson([k.publicKey]), balance: '100000000' })),
            ],
            staking: { minSelfBond: 100, minDelegation: 1, validatorCreationFee: 1, inflationMinBps: 0, inflationMaxBps: 0 },
            validators: keys.map((k, i) => ({ operator: `op${i}`, consensusKey: toHex(k), selfBond: 200 })),
          }),
        ),
    });
    const node = net.nodes[0]!;
    const server = new RpcServer(node, { port: 0 });
    servers.push(server);
    await server.start();
    await waitForHeight(net.nodes, 3n);
    const rpc = new RpcClient(server.url);
    const chainId = net.genesis.chainId;
    const send = async (operations: any[], signer = faucet): Promise<bigint> => {
      const r = await rpc.broadcastTx(toHex(signedTxBytes(chainId, { expiration: BigInt(Date.now()) + 60_000n, operations: withFees(operations, DEFAULT_FEES) }, [signer])), 'commit');
      expect(r.ok).toBe(true);
      return BigInt(r.height);
    };
    const created = await send([{ type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: makeAuthority([alice.publicKey]), active: makeAuthority([alice.publicKey]) }]);
    const paid = await send([{ type: 'transfer', from: FAUCET_ID, to: ALICE_ID, asset: CORE, amount: 5000n }]);
    const before = await rpc.call('validator', { operator: 'op0' });
    const delegated = await send([{ type: 'delegate', delegator: FAUCET_ID, validator: VAL0, amount: 300n * 100_000n }]);
    const paidAgain = await send([{ type: 'transfer', from: FAUCET_ID, to: ALICE_ID, asset: CORE, amount: 700n }]);
    await waitForHeight([node], paidAgain + 1n);
    const at = (h: bigint) => ({ height: h.toString() });

    // A balance, by name and by id, as it was and as it is.
    expect(await rpc.call('balance', { account: 'alice' })).toMatchObject({ amount: '5700' });
    expect(await rpc.call('balance', { account: 'alice', ...at(paid) })).toMatchObject({ amount: '5000', height: paid.toString() });
    expect(await rpc.call('balance', { account: '3.5', ...at(created - 1n) })).toMatchObject({ amount: '0' });
    // Before the account existed its name led nowhere.
    await expect(rpc.call('balance', { account: 'alice', ...at(created - 1n) })).rejects.toMatchObject({ code: -32001 });
    // A height the node does not hold is said to be that, not answered from another.
    await expect(rpc.call('balance', { account: 'alice', height: '99999' })).rejects.toMatchObject({ code: -32001, message: expect.stringMatching(/is not kept/) });
    await expect(rpc.call('object', { id: '3.5', height: '99999' })).rejects.toMatchObject({ code: -32001 });

    // The key and the account: the value is what the proof beside it proves.
    expect((await rpc.call('key', { type: 'account', index: 'byName', key: toHex(key((k) => k.str('alice'))), ...at(created) })).id).toBe('3.5');
    const absent = await rpc.call('key', { type: 'account', index: 'byName', key: toHex(key((k) => k.str('alice'))), prove: true, ...at(created - 1n) });
    expect(absent.id).toBeNull();
    const headerAt = async (h: bigint) => headerFromJson(await rpc.header(h));
    expect(verifyKeyProof((await headerAt(created)).appHash, keyProofFromBytes(fromHex(absent.proof)))).toBeNull();
    const gone = await rpc.call('account', { name: 'alice', prove: true, ...at(created - 1n) });
    expect(gone.account).toBeNull();
    expect(verifyKeyProof((await headerAt(created)).appHash, keyProofFromBytes(fromHex(gone.proof)))).toBeNull();
    const then = await rpc.call('account', { name: 'alice', prove: true, ...at(paid) });
    expect(then.account.id).toBe('3.5');
    expect(then.balances).toMatchObject([{ asset: 'CORE', amount: '5000' }]);
    expect(then.history).toBe('2');
    expect(toHex(verifyKeyProof((await headerAt(paid + 1n)).appHash, keyProofFromBytes(fromHex(then.proof)))!)).toBe(toHex(encode((w) => w.u64(ALICE_ID))));
    const now = await rpc.call('account', { name: 'alice' });
    expect(now.balances).toMatchObject([{ amount: '5700' }]);
    expect(now.history).toBe('3');
    // A name no account can have is absent, and there is nothing to prove it with.
    expect((await rpc.call('account', { name: 'NOT A NAME' })).account).toBeNull();

    // The validator before and after the delegation, and the delegation itself.
    const was = await rpc.call('validator', { operator: 'op0', ...at(delegated - 1n) });
    const is = await rpc.call('validator', { operator: 'op0' });
    expect(was.tokens).toBe(before.tokens);
    expect(BigInt(is.tokens) - BigInt(was.tokens)).toBe(300n * 100_000n);
    expect(was.delegators).toBeNull(); // the index of today cannot count the delegations of then
    expect(is.delegators).toBe(2);
    expect(was.selfBond).toBe(is.selfBond);
    expect(was.operatorName).toBe('op0');
    const none = await rpc.call('delegation', { delegator: 'faucet', validator: 'op0', prove: true, ...at(delegated - 1n) });
    expect(none).toMatchObject({ delegation: null, unbonding: null });
    expect(verifyKeyProof((await headerAt(delegated)).appHash, keyProofFromBytes(fromHex(none.proof)))).toBeNull();
    const some = await rpc.call('delegation', { delegator: 'faucet', validator: 'op0' });
    expect(some.delegation.tokens).toBe((300n * 100_000n).toString());
    expect(some.unbonding).toEqual([]);

    // Every peer has answered a ping by now, and says its clock is this node's: they share one.
    await waitFor(() => [...node.network.peers.values()].every((p) => p.clockOffsetMs !== null), 5000, 'a pong from every peer');
    for (const p of await rpc.call('peers')) expect(Math.abs(p.clockOffsetMs)).toBeLessThan(1000);

    // A batch pays a token for each call: with six to spend, the second batch of five has one call answered.
    const limited = new RpcServer(node, { port: 0, limits: { ratePerSecond: 0.001, burst: 6 } });
    servers.push(limited);
    await limited.start();
    const batch = () =>
      fetch(limited.url, { method: 'POST', body: JSON.stringify(Array.from({ length: 5 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'status' }))) }).then((r) => r.json() as Promise<{ id: number; error?: { code: number } }[]>);
    const first = await batch();
    expect(first.length).toBe(5);
    expect(first.filter((r) => r.error?.code === -32004).length).toBe(0);
    const second = await batch();
    expect(second.map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);
    expect(second.filter((r) => r.error?.code === -32004).length).toBe(4);
  });
});

describe('the transaction index', () => {
  const raw = new Uint8Array([1, 2, 3]);
  const block = (height: bigint, txs: Uint8Array[]) => {
    const header = { chainId: 'r4', version: 1, height, time: height, lastBlockHash: new Uint8Array(32), lastCommitHash: new Uint8Array(32), dataHash: txsRoot(txs), lastResultsHash: new Uint8Array(32), validatorsHash: new Uint8Array(32), nextValidatorsHash: new Uint8Array(32), appHash: new Uint8Array(32), evidenceHash: new Uint8Array(32), proposerAddress: new Uint8Array(32) };
    const b = { header, txs, lastCommit: null, evidence: [] };
    return { b, commit: { height, round: 0, blockHash: blockHash(b), signatures: [null] } };
  };

  it('keeps every block a transaction is in, answers with the one it succeeded in, and loses only the pruned one', () => {
    const store = new MemoryBlockStore();
    const failed = block(5n, [raw]);
    const landed = block(8n, [new Uint8Array([9]), raw]);
    const again = block(9n, [raw]);
    store.saveBlock(failed.b, failed.commit, [{ ok: false, error: 'insufficient balance' }]);
    expect(store.txLocation(txHash(raw))).toMatchObject({ height: 5n, ok: false, error: 'insufficient balance' });
    store.saveBlock(landed.b, landed.commit, [{ ok: true }, { ok: true }]);
    store.saveBlock(again.b, again.commit, [{ ok: false, error: 'duplicate transaction' }]);
    expect(store.txLocations(txHash(raw)).map((l) => [l.height, l.index, l.ok])).toEqual([
      [5n, 0, false],
      [8n, 1, true],
      [9n, 0, false],
    ]);
    // The success, not the newest.
    expect(store.txLocation(txHash(raw))).toMatchObject({ height: 8n, index: 1, ok: true });
    store.deleteBlock(8n);
    expect(store.txLocations(txHash(raw)).map((l) => l.height)).toEqual([5n, 9n]);
    expect(store.txLocation(txHash(raw))).toMatchObject({ height: 9n, ok: false });
    store.deleteBlock(5n);
    store.deleteBlock(9n);
    expect(store.txLocation(txHash(raw))).toBeNull();
    expect(store.txLocation(txHash(new Uint8Array([9])))).toBeNull();
  });

  it('moves an index of the old layout, one entry per hash, when the store is opened, and reads it before that', () => {
    const kv = new MemoryKv();
    const hashes = Array.from({ length: 12_000 }, (_, i) => txHash(encode((w) => w.u32(i))));
    // The old layout: the hash alone as the key, the height in the value.
    kv.write((w) => hashes.forEach((h, i) => w.put(key((k) => k.u8(0x74).fixed(h)), encode((wr) => wr.u64(BigInt(5 + (i % 3))).u32(i).u8(i % 2).string(i % 2 ? '' : 'too early')))));
    const store = new KvBlockStore(kv);
    const oldKeys = () => Array.from(kv.range(Uint8Array.of(0x74), prefixEnd(Uint8Array.of(0x74)))).filter(([k]) => k.length === 33).length;
    expect(oldKeys()).toBe(0);
    expect(store.txLocation(hashes[0]!)).toMatchObject({ height: 5n, index: 0, ok: false, error: 'too early' });
    expect(store.txLocation(hashes[11_999]!)).toMatchObject({ height: 7n, index: 11_999, ok: true });
    // The transaction lands again: both blocks are kept, and pruning one leaves the other.
    const second = block(9n, [raw]);
    kv.write((w) => w.put(key((k) => k.u8(0x74).fixed(txHash(raw)).u64(5n)), encode((wr) => wr.u64(5n).u32(0).u8(0).string('too early'))));
    store.saveBlock(second.b, second.commit, [{ ok: true }]);
    expect(store.txLocations(txHash(raw)).map((l) => [l.height, l.ok])).toEqual([
      [5n, false],
      [9n, true],
    ]);
    store.deleteBlock(9n);
    expect(store.txLocation(txHash(raw))).toMatchObject({ height: 5n, error: 'too early' });
    // Opened again, nothing is left to move and nothing is scanned: the marker says so.
    let ranged = 0;
    new KvBlockStore({ get: (k) => kv.get(k), range: (a, b) => (ranged++, kv.range(a, b)), write: (fn) => kv.write(fn) });
    expect(ranged).toBe(0);
    // A store that cannot be written is read in the old layout as it is.
    const frozen = new MemoryKv();
    frozen.write((w) => w.put(key((k) => k.u8(0x74).fixed(hashes[1]!)), encode((wr) => wr.u64(6n).u32(1).u8(1).string(''))));
    const readOnly = new KvBlockStore({ get: (k) => frozen.get(k), range: (a, b) => frozen.range(a, b), write: () => { throw new Error('read-only'); } });
    expect(readOnly.txLocation(hashes[1]!)).toMatchObject({ height: 6n, index: 1, ok: true });
  });
});

describe('snapshots, evidence, the codec', () => {
  it('refuses a snapshot that leaves a type out, repeats one or names one out of order', () => {
    const db = new ObjectDatabase(CORE_TYPES);
    const root = db.root(0);
    const bytes = db.encodeSnapshot(0n, root);
    expect(new ObjectDatabase(CORE_TYPES).loadSnapshot(bytes).height).toBe(0n);
    // The sections follow a version, a height and an app hash; each empty one is a type, a counter and a count.
    const head = 4 + 8 + 32;
    const section = 2 + 8 + 4;
    const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(head);
    expect(count).toBe(CORE_TYPES.length);
    expect(bytes.length).toBe(head + 4 + count * section);
    const withSections = (sections: Uint8Array[]) => {
      const out = new Uint8Array(head + 4 + sections.length * section);
      out.set(bytes.subarray(0, head));
      new DataView(out.buffer).setUint32(head, sections.length);
      sections.forEach((s, i) => out.set(s, head + 4 + i * section));
      return out;
    };
    const sections = Array.from({ length: count }, (_, i) => bytes.subarray(head + 4 + i * section, head + 4 + (i + 1) * section));
    expect(() => new ObjectDatabase(CORE_TYPES).loadSnapshot(withSections(sections.slice(0, -1)))).toThrow(/of \d+ type sections/);
    expect(() => new ObjectDatabase(CORE_TYPES).loadSnapshot(withSections([...sections.slice(0, -1), sections[0]!]))).toThrow(/snapshot section/);
    expect(() => new ObjectDatabase(CORE_TYPES).loadSnapshot(withSections([sections[1]!, sections[0]!, ...sections.slice(2)]))).toThrow(/snapshot section 0/);
  });

  it('lets go of pending and committed evidence and its inventory once it is too old, and bounds what waits', () => {
    const ev = (height: bigint, validatorIndex = 0): DuplicateVoteEvidence => {
      const vote = (b: number) => ({ type: VoteType.Prevote, height, round: 0, blockHash: new Uint8Array(32).fill(b), validatorIndex, signature: new Uint8Array(4) });
      return { voteA: vote(1), voteB: vote(2) };
    };
    const pool = new EvidencePool();
    expect(pool.add(ev(3n))).toBe(true);
    expect(pool.add(ev(3n))).toBe(false);
    expect(pool.add(ev(4n))).toBe(true);
    pool.markCommitted([ev(3n), ev(5n)]); // the second came in a block and was never pending here
    expect(pool.held).toEqual({ pending: 1, committed: 2, inventory: 3 });
    expect(pool.add(ev(5n))).toBe(false);
    expect(pool.hasHash(evidenceId(ev(5n)))).toBe(true);
    pool.pruneIf((e) => e.voteA.height <= 4n);
    expect(pool.held).toEqual({ pending: 0, committed: 1, inventory: 1 });
    expect(pool.hasHash(evidenceId(ev(3n)))).toBe(false);
    pool.pruneIf(() => true);
    expect(pool.held).toEqual({ pending: 0, committed: 0, inventory: 0 });
    for (let i = 0; i < EvidencePool.MAX_PENDING + 10; i++) pool.add(ev(100n, i));
    expect(pool.size).toBe(EvidencePool.MAX_PENDING);
    expect(pool.held.inventory).toBe(EvidencePool.MAX_PENDING);
  });

  it('refuses a number too large to hold exactly where a 64-bit field is used as one', () => {
    const r = (v: bigint, signed = false) => new Reader(encode((w) => (signed ? w.i64(v) : w.u64(v))));
    expect(r(2n ** 53n - 1n).u53()).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => r(2n ** 53n).u53()).toThrow(/out of range/);
    expect(r(-1n, true).i53()).toBe(-1);
    expect(() => r(-(2n ** 53n), true).i53()).toThrow(/out of range/);
    expect(() => r(2n ** 62n, true).i53()).toThrow(/out of range/);
    // A proposal whose lock round is such a number is not a proposal: it is refused before its block is read.
    expect(() => decodeProposal(new Reader(encode((w) => w.u64(1n).u32(0).i64(2n ** 60n))))).toThrow(/out of range/);
  });
});

describe('the keystore', () => {
  it('removes a key by name, for good, and says so when there is none by that name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crosschain-r4-'));
    try {
      const path = join(dir, 'keystore.json');
      const ks = Keystore.create(path, 'pw');
      ks.add('keep');
      ks.add('drop');
      ks.remove('drop');
      expect(() => ks.remove('drop')).toThrow(/no key named drop/);
      expect(() => ks.remove('never')).toThrow(/no key named never/);
      expect(Keystore.open(path, 'pw').list().map((k) => k.name)).toEqual(['keep']);
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the network and the node', () => {
  it('reads a peer clock that runs ahead from its pong', async () => {
    const hub = new MemoryHub();
    const make = (name: string, seeds: string[], clock?: () => number) =>
      new Network({ chainId: 'clock', nodeKey: keyPairFromSeed(seedFor(`r4/clock/${name}`)), transport: hub.transport(`${name}:1`), listenAddr: `${name}:1`, peerDb: new PeerDb(null, seeds), verifier: new InlineVerifier(), getHeight: () => 0n, log: () => {}, connectIntervalMs: 50, pingIntervalMs: 100, idleTimeoutMs: 5000, ...(clock ? { clock } : {}) });
    const a = make('a', []);
    const b = make('b', ['a:1'], () => Date.now() + 7000);
    await a.start();
    await b.start();
    try {
      const peerOf = (n: Network) => [...n.peers.values()][0];
      await waitFor(() => peerOf(a)?.clockOffsetMs != null && peerOf(b)?.clockOffsetMs != null, 5000, 'a pong each way');
      // b's clock is seven seconds ahead of a's: a sees it ahead, b sees a behind, each within the trip.
      expect(Math.abs(peerOf(a)!.clockOffsetMs! - 7000)).toBeLessThan(500);
      expect(Math.abs(peerOf(b)!.clockOffsetMs! + 7000)).toBeLessThan(500);
      expect(peerOf(a)!.latencyMs).toBeLessThan(500);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it('makes a verifier pool of its own when it is given none, and closes it when it stops', async () => {
    const key = keyPairFromSeed(seedFor('r4/own/val'));
    const node = await Node.create({ name: 'own', genesis: { chainId: 'own', signatureScheme: schemeName(DEFAULT_SCHEME), genesisTime: BigInt(Date.now()) - 1000n, validators: [{ publicKey: key.publicKey, power: 10n, name: 'v' }], appState: new Uint8Array() } as any, dataDir: null, nodeKeySeed: seedFor('r4/own/node'), validatorSeed: seedFor('r4/own/val'), transport: new MemoryHub().transport('own:1'), listenAddr: 'own:1', seeds: [], log: () => {} });
    expect(node.verifier.constructor.name).toBe('WorkerVerifier');
    await node.start();
    await waitFor(() => node.height >= 2n, 15_000, 'blocks signed and checked through the pool');
    await node.stop();
    await expect(node.verifier.verify([{ sig: new Uint8Array(1), msg: new Uint8Array(1), publicKey: key.publicKey, context: new Uint8Array() }])).rejects.toThrow(/closed/);
  });
});
