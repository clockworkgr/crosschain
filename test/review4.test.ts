/**
 * The items the first review noted and left (REVIEW-2026-10-28.md, "Noted and left as they are"), taken up: state
 * queries that answer as of the height asked for, a batch that pays for each of its calls, a transaction index
 * with every block a transaction is in, proofs that state no count, snapshots with every section, an evidence pool
 * that lets everything go, clock offsets from the ping, exact numbers from the codec and a node that makes its
 * own verifier pool.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson, DEFAULT_FEES } from '../src/app/core/genesis.ts';
import { TYPE } from '../src/app/core/types.ts';
import { decode, Reader } from '../src/codec/reader.ts';
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
import { KvBlockStore, MemoryBlockStore, TX_FANOUT, TX_SEGMENT_BLOCKS } from '../src/store/blockstore.ts';
import { MemoryKv, prefixEnd, StoreReadOnlyError, type KvStore } from '../src/store/kv.ts';
import { blockHash, txHash } from '../src/types/block.ts';
import { evidenceHeight, type DuplicateVoteEvidence } from '../src/types/evidence.ts';
import { genesisState } from '../src/types/state.ts';
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
            staking: { minSelfBond: 100, minDelegation: 1, validatorCreationFee: 1, unbondingPeriodMs: 2000, inflationMinBps: 0, inflationMaxBps: 0 },
            validators: keys.map((k, i) => ({ operator: `op${i}`, consensusKey: toHex(k), selfBond: 200 })),
          }),
        ),
    });
    const node = net.nodes[0]!;
    // The case makes many costly calls in a row; the limits are for the second server below.
    const server = new RpcServer(node, { port: 0, limits: { ratePerSecond: 10_000, burst: 10_000 } });
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
    expect(was.delegators).toBe(1); // the operator's own
    expect(is.delegators).toBe(2);
    expect(was.selfBond).toBe(is.selfBond);
    expect(was.operatorName).toBe('op0');
    const none = await rpc.call('delegation', { delegator: 'faucet', validator: 'op0', prove: true, ...at(delegated - 1n) });
    expect(none).toMatchObject({ delegation: null, unbonding: [] });
    expect(verifyKeyProof((await headerAt(delegated)).appHash, keyProofFromBytes(fromHex(none.proof)))).toBeNull();
    const some = await rpc.call('delegation', { delegator: 'faucet', validator: 'op0' });
    expect(some.delegation.tokens).toBe((300n * 100_000n).toString());
    expect(some.unbonding).toEqual([]);

    // What is removed since is still listed for the height it was there at. A third of the delegation is taken
    // back and waits in the unbonding queue; the rest follows, which removes the delegation; the entries mature and
    // are removed in their turn. The heights in between still show the delegation, its delegator and the queue.
    const shares = BigInt(some.delegation.shares);
    const partly = await send([{ type: 'undelegate', delegator: FAUCET_ID, validator: VAL0, shares: shares / 3n }]);
    const wholly = await send([{ type: 'undelegate', delegator: FAUCET_ID, validator: VAL0, shares: shares - shares / 3n }]);
    const queue = async (h?: bigint) => (await rpc.call('delegation', { delegator: 'faucet', validator: 'op0', ...(h === undefined ? {} : at(h)) })) as { delegation: unknown; unbonding: { tokens: string }[] };
    for (const deadline = Date.now() + 20_000; (await queue()).unbonding.length > 0; await new Promise((r) => setTimeout(r, 100))) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the unbonding entries to mature');
    }
    expect((await queue()).delegation).toBeNull();
    expect((await rpc.call('validator', { operator: 'op0' })).delegators).toBe(1);
    const mid = await queue(partly);
    expect(mid.delegation).not.toBeNull();
    expect(mid.unbonding.length).toBe(1);
    expect((await rpc.call('validator', { operator: 'op0', ...at(partly) })).delegators).toBe(2);
    const late = await queue(wholly);
    expect(late.delegation).toBeNull();
    expect(late.unbonding.length).toBe(2);
    expect(late.unbonding.reduce((sum, u) => sum + BigInt(u.tokens), 0n)).toBe(300n * 100_000n);
    expect((await rpc.call('validator', { operator: 'op0', ...at(wholly) })).delegators).toBe(1);
    expect((await queue(delegated)).unbonding).toEqual([]);

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
    const header = { chainId: 'r4', version: 1, height, time: height, lastBlockHash: new Uint8Array(32), lastCommitHash: new Uint8Array(32), dataHash: txsRoot(txs), lastResultsHash: new Uint8Array(32), validatorsHash: new Uint8Array(32), nextValidatorsHash: new Uint8Array(32), appHash: new Uint8Array(32), evidenceHash: new Uint8Array(32), proposerAddress: new Uint8Array(32), prioritiesHash: new Uint8Array(32) };
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

  it('finds a transaction in whichever segments hold it, with blocks far apart and segments missing between', () => {
    const kv = new MemoryKv();
    const store = new KvBlockStore(kv);
    const other = (n: number) => encode((w) => w.u32(n));
    // The transaction in five blocks over four segments, among blocks that do not carry it, with gaps of many segments.
    const heights = [3n, 31n, 32n, 1000n, 70_000n];
    for (const h of [1n, 2n, 3n, 30n, 31n, 32n, 33n, 64n, 500n, 1000n, 1001n, 69_999n, 70_000n, 90_000n]) {
      const txs = heights.includes(h) ? [other(Number(h)), raw] : [other(Number(h)), other(Number(h) + 1_000_000)];
      const b = block(h, txs);
      store.saveBlock(b.b, b.commit, [{ ok: true }, { ok: false, error: `at ${h}` }]);
    }
    expect(store.txLocations(txHash(raw)).map((l) => [l.height, l.index, l.error])).toEqual(heights.map((h) => [h, 1, `at ${h}`]));
    expect(store.txLocation(txHash(raw))).toMatchObject({ height: 70_000n });
    // One that is in a single block, at either end and in the middle; and hashes that sort before and after every entry.
    for (const h of [1n, 500n, 90_000n]) expect(store.txLocations(txHash(other(Number(h)))).map((l) => l.height)).toEqual([h]);
    expect(store.txLocations(new Uint8Array(32))).toEqual([]);
    expect(store.txLocations(new Uint8Array(32).fill(0xff))).toEqual([]);
    // A lookup reads once or twice per segment held, and once more in each of the eleven levels above, and does
    // not walk the entries: seven segments held these blocks when they were saved.
    let ranged = 0;
    const counting = new KvBlockStore({ get: (k) => kv.get(k), range: (a, b) => (ranged++, kv.range(a, b)), write: (fn) => kv.write(fn) });
    ranged = 0;
    counting.txLocations(txHash(raw));
    expect(ranged).toBeLessThanOrEqual(14 + 11);
    // The entries of a block lie together: every key of the index starts with its block's segment, of 32 blocks
    // under 'x' and of 1,024 or 32,768 under 'y' and level 1 or 2, where the blocks far behind the latest have gone.
    const keys = Array.from(kv.range(Uint8Array.of(0x78), Uint8Array.of(0x79)), ([k]) => k);
    for (const k of keys) expect(new Reader(k.subarray(1, 9)).u64()).toBe(new Reader(k.subarray(41)).u64() / TX_SEGMENT_BLOCKS);
    const above = Array.from(kv.range(Uint8Array.of(0x79), Uint8Array.of(0x7a)), ([k]) => k);
    for (const k of above) expect([1, 2]).toContain(k[1]);
    for (const k of above) expect(new Reader(k.subarray(2, 10)).u64()).toBe(new Reader(k.subarray(42)).u64() / (TX_SEGMENT_BLOCKS * TX_FANOUT ** BigInt(k[1]!)));
    expect(new Set([...keys, ...above].map((k) => toHex(k.subarray(k.length - 40)))).size).toBe(28);
    expect(above.length).toBeGreaterThanOrEqual(22);
    // A key under the index's prefix that is not an entry of it, before an entry or anywhere else, changes no answer.
    kv.write((w) => {
      w.put(key((k) => k.u8(0x78).u64(0n).fixed(txHash(raw))), Uint8Array.of(1));
      w.put(Uint8Array.of(0x78, 0xff), Uint8Array.of(1));
      w.put(key((k) => k.u8(0x78).u64(40n)), Uint8Array.of(1));
    });
    expect(store.txLocations(txHash(raw)).map((l) => l.height)).toEqual(heights);
    expect(store.txLocations(txHash(other(90_000))).map((l) => l.height)).toEqual([90_000n]);
    kv.write((w) => [key((k) => k.u8(0x78).u64(0n).fixed(txHash(raw))), Uint8Array.of(0x78, 0xff), key((k) => k.u8(0x78).u64(40n))].forEach((k) => w.del(k)));
    // Pruning a block takes its entries and no others.
    store.deleteBlock(32n);
    store.deleteBlock(1000n);
    expect(store.txLocations(txHash(raw)).map((l) => l.height)).toEqual([3n, 31n, 70_000n]);
    expect(store.txLocation(txHash(other(1000)))).toBeNull();
    expect(store.txLocation(txHash(other(1001)))).toMatchObject({ height: 1001n });
  });

  it('moves entries into larger segments behind the latest block, and a lookup asks a few segments however long the chain', () => {
    const kv = new MemoryKv();
    const store = new KvBlockStore(kv);
    const one = (h: bigint) => encode((w) => w.u32(Number(h)));
    const save = (to: KvBlockStore, h: bigint, ok = true) => {
      // `raw` is in every 700th block as well as the block's own transaction.
      const b = block(h, h % 700n === 0n ? [one(h), raw] : [one(h)]);
      to.saveBlock(b.b, b.commit, h % 700n === 0n ? [{ ok }, { ok: false, error: `at ${h}` }] : [{ ok }]);
    };
    const count = (level: number) => Array.from(kv.range(level === 0 ? Uint8Array.of(0x78) : Uint8Array.of(0x79, level), level === 0 ? Uint8Array.of(0x79) : Uint8Array.of(0x79, level + 1))).length;
    const segments = (level: number) => new Set(Array.from(kv.range(level === 0 ? Uint8Array.of(0x78) : Uint8Array.of(0x79, level), level === 0 ? Uint8Array.of(0x79) : Uint8Array.of(0x79, level + 1)), ([k]) => toHex(k.subarray(0, level === 0 ? 9 : 10)))).size;
    const TOP = 34_000n;
    // A second store saves the same blocks with every seventh save failing after it has written everything, the
    // step of the move included, and saved again.
    const other = new MemoryKv();
    let writes = 0;
    const stopping = new KvBlockStore({
      get: (k) => other.get(k),
      range: (a, b) => other.range(a, b),
      write: (fn) =>
        other.write((w) => {
          fn(w);
          if (++writes % 7 === 0) throw new Error('stopped');
        }),
    });
    for (let h = 1n; h <= TOP; h++) {
      save(store, h);
      try {
        save(stopping, h);
      } catch {
        save(stopping, h);
      }
      // Before the first 1,024 blocks are all behind the latest, nothing has moved.
      if (h === 1023n) expect([count(0), count(1)]).toEqual([1024, 0]);
    }
    const all = (k: MemoryKv) => Array.from(k.range(Uint8Array.of(0x78), Uint8Array.of(0x7a)), ([a, b]) => `${toHex(a)}=${toHex(b)}`);
    expect(all(other)).toEqual(all(kv));
    // Heights below 32,768 are in the one segment of level 2; the 1,024 after them are in one of level 1, or on
    // their way there; the rest are where they were written. No level holds more than a few dozen segments.
    const entries = Number(TOP) + Math.floor(Number(TOP) / 700);
    expect(count(2)).toBe(32_767 + 46);
    expect(count(0) + count(1) + count(2)).toBeGreaterThanOrEqual(entries);
    expect(count(0) + count(1) + count(2)).toBeLessThan(entries + 600);
    expect(segments(2)).toBe(1);
    expect(segments(1)).toBeLessThanOrEqual(2);
    expect(segments(0)).toBeLessThanOrEqual(40);
    // Every transaction is found where it is, and one that is in 48 blocks in all of them.
    for (let h = 1n; h <= TOP; h += 97n) expect(store.txLocations(txHash(one(h))).map((l) => [l.height, l.index, l.ok])).toEqual([[h, 0, true]]);
    expect(store.txLocations(txHash(raw)).map((l) => [l.height, l.error])).toEqual(Array.from({ length: 48 }, (_, i) => [BigInt(700 * (i + 1)), `at ${700 * (i + 1)}`]));
    let ranged = 0;
    const counting = new KvBlockStore({ get: (k) => kv.get(k), range: (a, b) => (ranged++, kv.range(a, b)), write: (fn) => kv.write(fn) });
    ranged = 0;
    counting.txLocations(txHash(one(20_000n)));
    expect(ranged).toBeLessThanOrEqual(2 * 40 + 2 * 2 + 2 + 9);

    // A block saved again with another result, long after its entry moved up: the answer is the new one at once,
    // and after the blocks that follow the copy above holds it and nothing is left below.
    save(store, 5n, false);
    expect(store.txLocations(txHash(one(5n))).map((l) => [l.height, l.ok])).toEqual([[5n, false]]);
    for (let h = TOP + 1n; h <= TOP + 8n; h++) save(store, h);
    expect(store.txLocations(txHash(one(5n))).map((l) => [l.height, l.ok])).toEqual([[5n, false]]);
    expect(Array.from(kv.range(Uint8Array.of(0x78), key((k) => k.u8(0x78).u64(1n)))).length).toBe(0);
    // A block removed from the middle is not answered with, though its copy is still above.
    store.deleteBlock(1400n);
    expect(store.txLocations(txHash(raw)).length).toBe(47);
    expect(store.txLocation(txHash(one(1400n)))).toBeNull();
    // Pruned to height 33,000: nothing below is answered with, and the blocks that follow drop the segments that
    // lie wholly below it, the one of level 2 among them, and keep the one the lowest height is in.
    store.batch(() => {
      for (let h = 1n; h < 33_000n; h++) store.deleteBlock(h);
      store.setLowestHeight(33_000n);
    });
    expect(store.txLocations(txHash(raw)).map((l) => l.height)).toEqual([33_600n]);
    for (let h = TOP + 9n; h <= TOP + 80n; h++) save(store, h);
    expect(count(2)).toBe(0);
    expect(count(1)).toBe(1024 + 2); // heights 32,768 to 33,791, and `raw` at 32,900 and 33,600
    for (let h = 33_000n; h <= TOP + 80n; h += 53n) expect(store.txLocations(txHash(one(h))).map((l) => l.height)).toEqual([h]);
    expect(store.txLocation(txHash(one(32_999n)))).toBeNull();
  }, 120_000);

  it('keeps a result saved while its entry is on the way up, moves a crowded block and backfilled ones, and asks for no block to answer', () => {
    const one = (h: bigint, i = 0) => encode((w) => w.u32(Number(h)).u32(i));
    const level0 = (kv: MemoryKv) => Array.from(kv.range(Uint8Array.of(0x78), Uint8Array.of(0x79)), ([k]) => new Reader(k.subarray(41)).u64());
    const stateOf = (kv: MemoryKv) => {
      const v = kv.get(Uint8Array.of(0x6d, 0));
      return v ? decode(v, (r) => ({ parent: r.u64(), removing: r.bool(), cursor: r.bytes() })) : null;
    };
    for (const batched of [false, true]) {
      // Blocks of one transaction until the first 1,024 are being removed from the small segments, and not yet block 5's.
      const kv = new MemoryKv();
      const store = new KvBlockStore(kv);
      const save = (h: bigint, ok = true) => {
        const b = block(h, [one(h)]);
        store.saveBlock(b.b, b.commit, [ok ? { ok } : { ok, error: 'later' }]);
      };
      let h = 1n;
      for (; !stateOf(kv)?.removing; h++) save(h);
      expect(level0(kv)).toContain(900n);
      // Block 900 saved again with another result, alone or in one transaction with the next block: the new result
      // is the answer then and after the removal has passed it, when the larger segment holds it.
      if (batched) store.batch(() => (save(900n, false), save(h++)));
      else save(900n, false);
      expect(store.txLocations(txHash(one(900n))).map((l) => [l.height, l.ok, l.error])).toEqual([[900n, false, 'later']]);
      for (const stop = h + 8n; h < stop; h++) save(h);
      expect(level0(kv).filter((x) => x < 1024n)).toEqual([]);
      expect(store.txLocations(txHash(one(900n))).map((l) => [l.height, l.ok, l.error])).toEqual([[900n, false, 'later']]);
      expect(store.txLocations(txHash(one(899n))).map((l) => [l.height, l.ok])).toEqual([[899n, true]]);
    }

    // One block of 5,000 transactions among empty ones: all of them in one of the 32 segments. Thirty blocks after
    // the 1,024th they have moved; a step that took a fixed share from each segment would need over three hundred.
    {
      const kv = new MemoryKv();
      const store = new KvBlockStore(kv);
      for (let h = 1n; h <= 1054n; h++) {
        const txs = h === 10n ? Array.from({ length: 5000 }, (_, i) => one(h, i)) : [];
        const b = block(h, txs);
        store.saveBlock(b.b, b.commit, txs.map(() => ({ ok: true })));
      }
      expect(level0(kv).length).toBe(0);
      expect(Array.from(kv.range(Uint8Array.of(0x79, 1), Uint8Array.of(0x79, 2))).length).toBe(5000);
      expect(store.txLocation(txHash(one(10n, 4999)))).toMatchObject({ height: 10n, index: 4999, ok: true });
      // A lookup asks whether a block is held without reading it.
      let blocksRead = 0;
      const counting = new KvBlockStore({ get: (k) => (k[0] === 0x62 && blocksRead++, kv.get(k)), has: (k) => kv.has(k), range: (a, b) => kv.range(a, b), write: (fn) => kv.write(fn) });
      expect(counting.txLocation(txHash(one(10n, 7)))).toMatchObject({ height: 10n, index: 7 });
      expect(blocksRead).toBe(0);
    }

    // A node that joined at height 3,000 applies a block of one transaction for every 100 blocks of ten that it
    // backfills downward: the backfilled entries move up with the saves that bring them, a thousand to an applied
    // block, where steps made for applied blocks alone would move a quarter of that.
    {
      const kv = new MemoryKv();
      const store = new KvBlockStore(kv);
      const put = (h: bigint, applied: boolean) => {
        const b = block(h, applied ? [one(h)] : Array.from({ length: 10 }, (_, i) => one(h, i)));
        store.saveBlock(b.b, b.commit, applied ? [{ ok: true }] : null);
      };
      store.batch(() => (put(3000n, false), store.setLowestHeight(3000n)));
      let tip = 3000n;
      for (let low = 3000n; low > 1n; ) {
        put(++tip, true);
        const to = low - 100n < 1n ? 1n : low - 100n;
        store.batch(() => {
          for (let x = low - 1n; x >= to; x--) put(x, false);
          store.setLowestHeight(to);
        });
        low = to;
      }
      expect(tip).toBe(3030n);
      // Heights 1,024 to 2,047 have gone up already; the first 1,024 could not before the lowest height was 1, and
      // go with the next few blocks; the 1,024 after them wait for block 3,072.
      expect(level0(kv).filter((x) => x >= 1024n && x < 2048n)).toEqual([]);
      for (let i = 0; i < 45; i++) put(++tip, true);
      expect(level0(kv).filter((x) => x < 2048n)).toEqual([]);
      expect(level0(kv).length).toBe(953 * 10 + 75);
      for (let x = 1n; x <= tip; x += 71n) expect(store.txLocations(txHash(one(x, x > 3000n ? 0 : 3))).map((l) => [l.height, l.index, l.ok])).toEqual([[x, x > 3000n ? 0 : 3, x > 3000n ? true : null]]);
    }
  });

  it('fills the larger segments on a store that never recorded its latest block, and past keys that are not entries', () => {
    const one = (h: bigint) => encode((w) => w.u32(Number(h)));
    const level0 = (kv: MemoryKv) => Array.from(kv.range(Uint8Array.of(0x78), Uint8Array.of(0x79)), ([k]) => k).filter((k) => k.length === 49).map((k) => new Reader(k.subarray(41)).u64());
    const level1 = (kv: MemoryKv) => Array.from(kv.range(Uint8Array.of(0x79, 1), Uint8Array.of(0x79, 2))).length;
    const put = (store: KvBlockStore, h: bigint, applied: boolean) => {
      const b = block(h, [one(h)]);
      store.saveBlock(b.b, b.commit, applied ? [{ ok: true }] : null);
    };
    // A store as the version before the larger segments left it: blocks 2,000 to 2,100 applied, the lowest height
    // 2,000, the chain state saying 2,100, entries under 'x' and no marker of the latest block. Only a backfill
    // follows, no block is applied: the marker is taken from the chain state, and the backfilled blocks move up.
    {
      const kv = new MemoryKv();
      const store = new KvBlockStore(kv);
      store.setLowestHeight(2000n);
      for (let h = 2000n; h <= 2100n; h++) put(store, h, true);
      const state = genesisState({ chainId: 'r4', signatureScheme: schemeName(DEFAULT_SCHEME), genesisTime: 0n, appState: new Uint8Array(), validators: [{ publicKey: faucet.publicKey, power: 1n }] }, new Uint8Array(32));
      store.saveState({ ...state, lastHeight: 2100n });
      kv.write((w) => w.del(Uint8Array.of(0x4d)));
      for (let low = 2000n; low > 1n; low -= 1n) {
        store.batch(() => {
          put(store, low - 1n, false);
          store.setLowestHeight(low - 1n);
        });
      }
      expect(new Reader(kv.get(Uint8Array.of(0x4d))!).u64()).toBe(2100n);
      // Heights 1,024 to 2,047 went up once the lowest height was 1,024, with the 1,024 saves that followed.
      expect(level0(kv).filter((x) => x >= 1024n && x < 2048n)).toEqual([]);
      expect(level1(kv)).toBeGreaterThanOrEqual(1024);
      expect(store.txLocations(txHash(one(1500n))).map((l) => [l.height, l.ok])).toEqual([[1500n, null]]);
      expect(store.txLocations(txHash(one(2050n))).map((l) => [l.height, l.ok])).toEqual([[2050n, true]]);
    }
    // Seventy keys under 'x' that are not entries, before every entry, and seventy more put among the small
    // segments once their removal has begun: the steps remove them as they meet them and go on.
    {
      const kv = new MemoryKv();
      const store = new KvBlockStore(kv);
      const junk = (segment: bigint, i: number) => key((k) => k.u8(0x78).u64(segment).u8(i));
      kv.write((w) => {
        for (let i = 0; i < 70; i++) w.put(junk(0n, i), Uint8Array.of(1));
      });
      let h = 1n;
      for (; h <= 1020n; h++) put(store, h, true);
      const removing = () => {
        const v = kv.get(Uint8Array.of(0x6d, 0));
        return v !== undefined && decode(v, (r) => ({ parent: r.u64(), removing: r.bool(), cursor: r.bytes() })).removing;
      };
      for (; !removing(); h++) put(store, h, true);
      expect(h).toBeLessThan(1035n);
      kv.write((w) => {
        for (let i = 0; i < 70; i++) w.put(junk(20n, i), Uint8Array.of(1));
      });
      for (const stop = h + 12n; h < stop; h++) put(store, h, true);
      expect(Array.from(kv.range(Uint8Array.of(0x78), Uint8Array.of(0x79))).filter(([k]) => k.length !== 49)).toEqual([]);
      expect(level0(kv).filter((x) => x < 1024n)).toEqual([]);
      expect(level1(kv)).toBe(1023);
      for (let x = 1n; x < h; x += 37n) expect(store.txLocations(txHash(one(x))).map((l) => l.height)).toEqual([x]);
    }
  });

  it('moves an index of either older layout into the segments when the store is opened, and reads one it cannot move', () => {
    const kv = new MemoryKv();
    const hashes = Array.from({ length: 12_000 }, (_, i) => txHash(encode((w) => w.u32(i))));
    const value = (height: bigint, i: number) => encode((wr) => wr.u64(height).u32(i).u8(i % 2).string(i % 2 ? '' : 'too early'));
    const older = () => Array.from(kv.range(Uint8Array.of(0x74), prefixEnd(Uint8Array.of(0x74)))).length;
    // The oldest layout has the hash alone as the key; the one after it the hash and the height. Both have the
    // height in the value. Half the entries in each, over heights in many segments, and one hash in two blocks.
    kv.write((w) => {
      hashes.forEach((h, i) => {
        const height = BigInt(5 + (i % 300));
        w.put(i % 2 ? key((k) => k.u8(0x74).fixed(h).u64(height)) : key((k) => k.u8(0x74).fixed(h)), value(height, i));
      });
      w.put(key((k) => k.u8(0x74).fixed(txHash(raw)).u64(5n)), encode((wr) => wr.u64(5n).u32(0).u8(0).string('too early')));
      w.put(key((k) => k.u8(0x74).fixed(txHash(raw)).u64(700n)), encode((wr) => wr.u64(700n).u32(3).u8(1).string('')));
      w.put(Uint8Array.of(0x54), Uint8Array.of(2)); // what a store of the second layout says of itself
    });
    expect(older()).toBe(12_002);
    const store = new KvBlockStore(kv);
    expect(older()).toBe(0);
    expect(Array.from(kv.range(Uint8Array.of(0x78), Uint8Array.of(0x79))).length).toBe(12_002);
    expect(store.txLocation(hashes[0]!)).toMatchObject({ height: 5n, index: 0, ok: false, error: 'too early' });
    expect(store.txLocation(hashes[11_999]!)).toMatchObject({ height: BigInt(5 + (11_999 % 300)), index: 11_999, ok: true });
    for (let i = 0; i < 12_000; i += 37) expect(store.txLocations(hashes[i]!).map((l) => [l.height, l.index])).toEqual([[BigInt(5 + (i % 300)), i]]);
    expect(store.txLocations(txHash(raw)).map((l) => [l.height, l.ok])).toEqual([
      [5n, false],
      [700n, true],
    ]);
    // The transaction lands again: every block is kept, and pruning one leaves the others.
    const second = block(9n, [raw]);
    store.saveBlock(second.b, second.commit, [{ ok: false, error: 'again' }]);
    expect(store.txLocations(txHash(raw)).map((l) => l.height)).toEqual([5n, 9n, 700n]);
    store.deleteBlock(9n);
    expect(store.txLocations(txHash(raw)).map((l) => l.height)).toEqual([5n, 700n]);
    // Opened again, nothing is left to move and nothing is scanned: the marker says so.
    let ranged = 0;
    new KvBlockStore({ get: (k) => kv.get(k), range: (a, b) => (ranged++, kv.range(a, b)), write: (fn) => kv.write(fn) });
    expect(ranged).toBe(0);

    // A move that is cut short goes on from where it stopped the next time. The write that failed is the caller's to
    // see; a reader of the half-moved store finds every entry, moved or not.
    const cut = new MemoryKv();
    cut.write((w) => hashes.forEach((h, i) => w.put(i % 2 ? key((k) => k.u8(0x74).fixed(h).u64(BigInt(5 + (i % 300)))) : key((k) => k.u8(0x74).fixed(h)), value(BigInt(5 + (i % 300)), i))));
    let writes = 0;
    const stopping: KvStore = {
      get: (k) => cut.get(k),
      range: (a, b) => cut.range(a, b),
      write: (fn) => {
        if (++writes === 2) throw new Error('stopped');
        cut.write(fn);
      },
    };
    expect(() => new KvBlockStore(stopping)).toThrow('stopped');
    expect(Array.from(cut.range(Uint8Array.of(0x74), Uint8Array.of(0x75))).length).toBe(7000);
    expect(cut.get(Uint8Array.of(0x54))).toBeUndefined();
    const refusing = (kv: KvStore): KvStore => ({
      get: (k) => kv.get(k),
      range: (a, b) => kv.range(a, b),
      write: () => {
        throw new StoreReadOnlyError();
      },
    });
    const reader = new KvBlockStore(refusing(cut));
    for (let i = 0; i < 12_000; i += 41) expect(reader.txLocations(hashes[i]!).map((l) => [l.height, l.index])).toEqual([[BigInt(5 + (i % 300)), i]]);
    const resumed = new KvBlockStore(cut);
    expect(Array.from(cut.range(Uint8Array.of(0x74), Uint8Array.of(0x75))).length).toBe(0);
    expect(cut.get(Uint8Array.of(0x54))).toEqual(Uint8Array.of(3));
    for (let i = 0; i < 12_000; i += 41) expect(resumed.txLocations(hashes[i]!).map((l) => [l.height, l.index])).toEqual([[BigInt(5 + (i % 300)), i]]);

    // A store that cannot be written is read in the older layouts as it is.
    const frozen = new MemoryKv();
    frozen.write((w) => {
      w.put(key((k) => k.u8(0x74).fixed(hashes[1]!)), encode((wr) => wr.u64(6n).u32(1).u8(1).string('')));
      w.put(key((k) => k.u8(0x74).fixed(hashes[2]!).u64(8n)), encode((wr) => wr.u64(8n).u32(2).u8(0).string('no')));
      w.put(key((k) => k.u8(0x74).fixed(hashes[2]!).u64(9n)), encode((wr) => wr.u64(9n).u32(0).u8(1).string('')));
    });
    const readOnly = new KvBlockStore(refusing(frozen));
    expect(readOnly.txLocation(hashes[1]!)).toMatchObject({ height: 6n, index: 1, ok: true });
    expect(readOnly.txLocations(hashes[2]!).map((l) => [l.height, l.ok])).toEqual([
      [8n, false],
      [9n, true],
    ]);
    expect(readOnly.txLocation(hashes[3]!)).toBeNull();
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
      const vote = (b: number) => ({ type: VoteType.Prevote, height, round: 0, blockHash: new Uint8Array(32).fill(b), polRound: -1, validatorIndex, signature: new Uint8Array(4) });
      return { kind: 'duplicateVote', voteA: vote(1), voteB: vote(2) };
    };
    const pool = new EvidencePool();
    expect(pool.add(ev(3n))).toBe(true);
    expect(pool.add(ev(3n))).toBe(false);
    expect(pool.add(ev(4n))).toBe(true);
    pool.markCommitted([ev(3n), ev(5n)]); // the second came in a block and was never pending here
    expect(pool.held).toEqual({ pending: 1, committed: 2, inventory: 3 });
    expect(pool.add(ev(5n))).toBe(false);
    expect(pool.hasHash(evidenceId(ev(5n)))).toBe(true);
    pool.pruneIf((e) => evidenceHeight(e) <= 4n);
    expect(pool.held).toEqual({ pending: 0, committed: 1, inventory: 1 });
    expect(pool.hasHash(evidenceId(ev(3n)))).toBe(false);
    pool.pruneIf(() => true);
    expect(pool.held).toEqual({ pending: 0, committed: 0, inventory: 0 });
    // A block may carry another pair of votes for the offence that waits here: the pair that waited leaves no entry behind.
    const other = ev(6n);
    other.voteB.blockHash!.fill(3);
    expect(pool.add(ev(6n))).toBe(true);
    pool.markCommitted([other]);
    expect(pool.held).toEqual({ pending: 0, committed: 1, inventory: 1 });
    expect(pool.hasHash(evidenceId(ev(6n)))).toBe(false);
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
  it('removes a key by name, for good, and says so when there is none by that name, as does the command', () => {
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
      // The command: it names what it removed, fails on a name that is not there, and makes no keystore to remove from.
      const cli = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'keys', ...args], { env: { ...process.env, CHAIN_PASSPHRASE: 'pw' }, encoding: 'utf8' });
      const address = Keystore.open(path, 'pw').list()[0]!.address;
      expect(cli('add', 'temp', '--keystore', path).status).toBe(0);
      const removed = cli('remove', 'keep', '--keystore', path);
      expect(removed.status).toBe(0);
      expect(removed.stdout.trim()).toBe(`removed keep ${address}`);
      const missing = cli('remove', 'keep', '--keystore', path);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr + missing.stdout).toMatch(/no key named keep/);
      expect(cli('list', '--keystore', path).stdout).toMatch(/^temp /);
      const nowhere = cli('remove', 'temp', '--keystore', join(dir, 'none.json'));
      expect(nowhere.status).not.toBe(0);
      expect(existsSync(join(dir, 'none.json'))).toBe(false);
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
