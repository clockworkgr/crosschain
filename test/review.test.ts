/** Regressions for the findings of the 2026-10-28 review (REVIEW-2026-10-28.md). */
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, signTransaction, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson } from '../src/app/core/genesis.ts';
import { HistoryKind } from '../src/app/core/history.ts';
import { encodeTransaction, txBodyBytes, type Operation, type OperationDraft } from '../src/app/core/tx.ts';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { checkStakingParameters, CORE_TYPES, DelegationType, MAX_DURATION_MS, MAX_SHARE_SUPPLY, ProposalType, TYPE, UnbondingType, ValidatorStatus, ValidatorType } from '../src/app/core/types.ts';
import { decode } from '../src/codec/reader.ts';
import { encode } from '../src/codec/writer.ts';
import { FileSignStateStore, SignStep } from '../src/consensus/privval.ts';
import { toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed, sign, signContext, SIGNATURE_SIZE } from '../src/crypto/keys.ts';
import { InlineVerifier, WorkerVerifier, type VerifyJob } from '../src/crypto/verifier.ts';
import { KvStoreApp } from '../src/app/kvstore.ts';
import { bond, reward } from '../src/app/core/staking.ts';
import type { KvEnv } from '../src/store/kv.ts';
import { Mempool } from '../src/mempool.ts';
import type { Application } from '../src/app/types.ts';
import { MemoryKv, type KvWriter } from '../src/store/kv.ts';
import { decodeMessage } from '../src/p2p/messages.ts';
import { VoteType } from '../src/types/vote.ts';
import { LightClient } from '../src/light/client.ts';
import { NodeProvider } from '../src/light/provider.ts';
import { ObjectDatabase } from '../src/db/database.ts';
import { objectId } from '../src/db/id.ts';
import { verifyObjectProof } from '../src/db/proof.ts';
import { key } from '../src/db/keys.ts';
import type { ObjectType } from '../src/db/index.ts';
import { SparseMerkleTree } from '../src/db/smt.ts';
import { BlockSync } from '../src/sync/blocksync.ts';
import { DEFAULT_LIMITS } from '../src/consensus/consensus.ts';
import type { Network } from '../src/p2p/network.ts';
import type { Requester } from '../src/p2p/request.ts';
import type { ChainState } from '../src/types/state.ts';
import { RpcClient } from '../src/rpc/client.ts';
import { RpcServer } from '../src/rpc/server.ts';
import type { Genesis } from '../src/types/genesis.ts';
import { ValidatorSet } from '../src/types/validator.ts';
import { KvBlockStore, MemoryBlockStore } from '../src/store/blockstore.ts';
import { blockHash, headerHash, txHash } from '../src/types/block.ts';
import { resultProofFor, resultsRoot, txsRoot, verifyResultProof } from '../src/types/txproof.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestnet, seedFor, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const chainId = 'review-test';
const genesisTime = 1_700_000_000_000n;
const UNIT = 100_000n;
const T = (n: number | bigint) => BigInt(n) * UNIT;
const faucet = keyPairFromSeed(seedFor('rv/faucet'));
const alice = keyPairFromSeed(seedFor('rv/alice'));
const bob = keyPairFromSeed(seedFor('rv/bob'));
const op = keyPairFromSeed(seedFor('rv/op'));
const consA = keyPairFromSeed(seedFor('rv/consA'));
const consB = keyPairFromSeed(seedFor('rv/consB'));
const FAUCET_ID = objectId(TYPE.account, 0);
const OP_ID = objectId(TYPE.account, 1);
const VAL_ID = objectId(TYPE.validator, 0);
const CORE = objectId(TYPE.asset, 0);

function genesis(): Genesis {
  const acct = (name: string, k: typeof faucet, balance: bigint) => ({ name, owner: authorityJson([k.publicKey]), active: authorityJson([k.publicKey]), balance: balance.toString() });
  return {
    chainId,
    genesisTime,
    validators: [{ publicKey: keyPairFromSeed(seedFor('rv/val')).publicKey, power: 10n }],
    appState: appGenesisBytes({
      accounts: [acct('faucet', faucet, T(10_000)), acct('opa', op, T(1000))],
      staking: { minSelfBond: 100, minDelegation: 1, validatorCreationFee: 10, fixedRewardPerBlock: 0, doubleSignSlashBps: 500, unbondingPeriodMs: 10_000, inflationMinBps: 0, inflationMaxBps: 0, downtimeWindow: 4, downtimeJailMs: 1000 },
      communityPool: 100,
      validators: [{ operator: 'opa', consensusKey: toHex(consA.publicKey), selfBond: 200 }],
    }),
  };
}

const makeApp = () => new CoreApp({ genesis: genesis(), verifier: new InlineVerifier(), retainVersions: 8 });

async function block(app: CoreApp, txs: Uint8Array[] = [], misbehavior: { address: Uint8Array; height: bigint }[] = [], dt = 1000n) {
  const height = app.lastHeight + 1n;
  const res = await app.finalizeBlock({ height, time: app.dynamic().time + dt, txs, proposerAddress: consA.address, lastCommitSigners: height === 1n ? [] : [consA.address], misbehavior });
  await app.commit();
  return res;
}

const tx = (app: CoreApp, operations: OperationDraft[], keys = [faucet]) => signedTxBytes(chainId, { expiration: app.dynamic().time + 60_000n, operations: withFees(operations, app.feeSchedule()) }, keys);

describe('review regressions', () => {
  it('rejects decoded validator sets with duplicate members, wrong order or a bad proposer index', () => {
    const set = ValidatorSet.create([
      { publicKey: alice.publicKey, power: 10n },
      { publicKey: bob.publicKey, power: 10n },
    ]);
    const bytes = encode((w) => set.encode(w));
    expect(decode(bytes, ValidatorSet.decode).size).toBe(2);
    const dup = encode((w) => w.array([set.validators[0]!, set.validators[0]!], (w, v) => w.fixed(v.publicKey).u64(v.power).i64(v.priority)).i64(0n));
    expect(() => decode(dup, ValidatorSet.decode)).toThrow(/duplicate/);
    const reversed = encode((w) => w.array([set.validators[1]!, set.validators[0]!], (w, v) => w.fixed(v.publicKey).u64(v.power).i64(v.priority)).i64(0n));
    expect(() => decode(reversed, ValidatorSet.decode)).toThrow(/out of order/);
    const badIndex = encode((w) => w.array(set.validators, (w, v) => w.fixed(v.publicKey).u64(v.power).i64(v.priority)).i64(5n));
    expect(() => decode(badIndex, ValidatorSet.decode)).toThrow(/proposer index/);
  });

  it('does not let a cached verification vouch for different signature bytes', async () => {
    const app = makeApp();
    await block(app);
    const create = tx(app, [{ type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: makeAuthority([alice.publicKey]), active: makeAuthority([alice.publicKey]) }]);
    expect((await app.checkTx(create)).ok).toBe(true); // primes the cache
    const signed = signTransaction(chainId, { expiration: app.dynamic().time + 60_000n, operations: withFees([{ type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: makeAuthority([alice.publicKey]), active: makeAuthority([alice.publicKey]) }], app.feeSchedule()) }, [faucet]);
    const corrupted = encodeTransaction({ ...signed, signatures: [{ address: signed.signatures[0]!.address, signature: new Uint8Array(SIGNATURE_SIZE) }] });
    const r = await block(app, [corrupted]);
    expect(r.txResults[0]!.ok).toBe(false);
    expect(r.txResults[0]!.error).toMatch(/invalid signature/);
    expect(app.accountByName('alice')).toBeNull();
    // The cold node that never checked anything agrees exactly.
    const cold = makeApp();
    await block(cold);
    const r2 = await block(cold, [corrupted]);
    expect(r2.txResults[0]!.error).toBe(r.txResults[0]!.error);
    expect(toHex(cold.lastAppHash)).toBe(toHex(app.lastAppHash));
  });

  it('resolves keys per transaction as the block executes, so a warm and a cold node agree', async () => {
    const warm = makeApp();
    const cold = makeApp();
    for (const a of [warm, cold]) {
      await block(a);
      await block(a, [tx(a, [{ type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: makeAuthority([alice.publicKey]), active: makeAuthority([alice.publicKey]) }])]);
      await block(a, [tx(a, [{ type: 'transfer', from: FAUCET_ID, to: objectId(TYPE.account, 2), asset: CORE, amount: T(10) }])]);
    }
    const aliceId = objectId(TYPE.account, 2);
    // T1 hands alice's account to bob's key; T2 is a spend signed by bob. Only the order inside the block makes T2 valid.
    const t1 = tx(warm, [{ type: 'accountUpdate', account: aliceId, owner: null, active: makeAuthority([bob.publicKey]) }], [alice]);
    const t2 = signedTxBytes(chainId, { expiration: warm.dynamic().time + 60_000n + 1n, operations: withFees([{ type: 'transfer', from: aliceId, to: FAUCET_ID, asset: CORE, amount: T(1) }], warm.feeSchedule()) }, [bob]);
    expect((await warm.checkTx(t1)).ok).toBe(true);
    expect((await warm.checkTx(t2)).ok).toBe(true); // checked against the pending state, where bob already holds the key
    const rw = await block(warm, [t1, t2]);
    const rc = await block(cold, [t1, t2]);
    expect(rw.txResults.map((r) => r.ok)).toEqual([true, true]);
    expect(rc.txResults.map((r) => r.ok)).toEqual([true, true]);
    expect(toHex(cold.lastAppHash)).toBe(toHex(warm.lastAppHash));
    // Out of order, both reject the spend the same way.
    const warm2 = makeApp();
    const cold2 = makeApp();
    for (const a of [warm2, cold2]) {
      await block(a);
      await block(a, [tx(a, [{ type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: makeAuthority([alice.publicKey]), active: makeAuthority([alice.publicKey]) }])]);
      await block(a, [tx(a, [{ type: 'transfer', from: FAUCET_ID, to: aliceId, asset: CORE, amount: T(10) }])]);
    }
    const r3 = await block(warm2, [t2, t1]);
    const r4 = await block(cold2, [t2, t1]);
    expect(r3.txResults.map((r) => r.ok)).toEqual([false, true]);
    expect(r4.txResults.map((r) => r.error)).toEqual(r3.txResults.map((r) => r.error));
    expect(toHex(cold2.lastAppHash)).toBe(toHex(warm2.lastAppHash));
  });

  it('refuses issuing the core asset', async () => {
    const app = makeApp();
    await block(app);
    const issue = tx(app, [{ type: 'assetIssue', issuer: FAUCET_ID, asset: CORE, to: FAUCET_ID, amount: T(1) }]);
    expect((await app.checkTx(issue)).error).toMatch(/minted by the chain/);
  });

  it('refuses a delegation worth no shares, one that would overflow the validator, and declines a reward it cannot mint commission on', () => {
    const db = new ObjectDatabase(CORE_TYPES);
    const v = (operator: number, consensusKey: Uint8Array, tokens: bigint, shares: bigint) =>
      db.create(ValidatorType, (id) => ({ id, operator: objectId(TYPE.account, operator), consensusKey, tokens, shares, status: ValidatorStatus.candidate, jailedUntil: 0n, createdHeight: 0n }));
    // Rewards drove the exchange rate so high that 100,000 base units buy no whole share.
    const steep = v(0, consA.publicKey, 1_000_000_001n, 1000n);
    expect(() => bond(db, objectId(TYPE.account, 0), steep, 100_000n)).toThrow(/no shares/);
    const full = v(1, bob.publicKey, 1000n, 2n ** 64n - 1n);
    expect(() => bond(db, objectId(TYPE.account, 1), full, 1000n)).toThrow(/overflow/);
    // Slashed to nothing with shares outstanding: there is no rate to mint commission at, so the pool keeps the reward.
    const emptied = v(2, alice.publicKey, 0n, 1000n);
    expect(reward(db, emptied, 100n, 10_000)).toBe(false);
  });

  it('accepts both valid signatures a key can make over one body, whichever was seen first', async () => {
    // Signing is randomised, so two signatures over one body differ; the cache keeps every verified one.
    const app = makeApp();
    await block(app);
    const body = { expiration: app.dynamic().time + 60_000n, operations: withFees([{ type: 'transfer' as const, from: FAUCET_ID, to: objectId(TYPE.account, 1), asset: CORE, amount: T(1) }], app.feeSchedule()) };
    const a = encodeTransaction(signTransaction(chainId, body, [faucet]));
    // This chain's signer is deterministic; a hedged signer (FIPS 204's default) yields other valid bytes.
    const hedged = ml_dsa44.sign(txBodyBytes(body), faucet.secretKey, { context: signContext(chainId, 'tx'), extraEntropy: crypto.getRandomValues(new Uint8Array(32)) });
    const b = encodeTransaction({ ...body, signatures: [{ address: faucet.address, signature: hedged }] });
    expect(toHex(a)).not.toBe(toHex(b));
    expect((await app.checkTx(b)).ok).toBe(true); // the mempool saw B
    const r = await app.finalizeBlock({ height: app.lastHeight + 1n, time: app.dynamic().time + 1000n, txs: [a, b], proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });
    await app.commit();
    // The block carries A first: it is valid, and B is then the same transaction again.
    expect(r.txResults.map((t) => (t.ok ? 'ok' : t.error))).toEqual(['ok', 'duplicate transaction']);
  });

  it('rolls a block back when verification fails half way, and applies it cleanly on a retry', async () => {
    let fail = true;
    const verifier = {
      verify: async (jobs: VerifyJob[]) => {
        if (fail) throw new Error('verifier closed');
        return jobs.map(() => true);
      },
      verifyOne: async () => true,
      close: async () => {},
    };
    const flaky = new CoreApp({ genesis: genesis(), verifier, retainVersions: 8 });
    const clean = makeApp();
    for (const a of [flaky, clean]) await block(a);
    const t = tx(clean, [{ type: 'transfer', from: FAUCET_ID, to: objectId(TYPE.account, 1), asset: CORE, amount: T(1) }]);
    const req = (a: CoreApp) => ({ height: a.lastHeight + 1n, time: a.dynamic().time + 1000n, txs: [t], proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });
    await expect(flaky.finalizeBlock(req(flaky))).rejects.toThrow(/verifier closed/);
    expect(flaky.lastHeight).toBe(1n);
    fail = false;
    const rf = await flaky.finalizeBlock(req(flaky));
    await flaky.commit();
    const rc = await clean.finalizeBlock(req(clean));
    await clean.commit();
    expect(rf.txResults[0]!.ok && rc.txResults[0]!.ok).toBe(true);
    expect(toHex(flaky.lastAppHash)).toBe(toHex(clean.lastAppHash));
  });

  it('bounds staking parameters so every derived timestamp and amount stays representable', () => {
    const base = makeApp().stakingParameters();
    expect(checkStakingParameters(base)).toBeNull();
    expect(checkStakingParameters({ ...base, unbondingPeriodMs: 2n ** 64n - 1n })).toMatch(/unbondingPeriodMs/);
    expect(checkStakingParameters({ ...base, downtimeJailMs: MAX_DURATION_MS + 1n })).toMatch(/downtimeJailMs/);
    expect(checkStakingParameters({ ...base, minSelfBond: 0n })).toMatch(/minSelfBond/);
    expect(checkStakingParameters({ ...base, fixedRewardPerBlock: MAX_SHARE_SUPPLY + 1n })).toMatch(/fixedRewardPerBlock/);
  });

  it('refuses validator powers whose total a priority could not track', () => {
    expect(() => ValidatorSet.create([{ publicKey: alice.publicKey, power: 2n ** 63n }, { publicKey: bob.publicKey, power: 2n ** 63n }])).toThrow(/total power/);
  });

  it('encodes only well-formed strings', () => {
    expect(() => encode((w) => w.string('\uD800'))).toThrow(/well-formed/);
    expect(decode(encode((w) => w.string('ok \u{1F600}')), (r) => r.string())).toBe('ok \u{1F600}');
  });

  it('checks a transaction again after a check that threw, instead of calling it seen', async () => {
    let calls = 0;
    const app = {
      checkTx: async () => {
        if (++calls === 1) throw new Error('verifier closed');
        return { ok: true };
      },
    } as unknown as Application;
    const pool = new Mempool(app);
    await expect(pool.addTx(new Uint8Array([7]))).rejects.toThrow(/verifier closed/);
    expect((await pool.addTx(new Uint8Array([7]))).status).toBe('added');
  });

  it('has the test application refuse a validator update the engine could not apply, and fold repeated ones', async () => {
    const app = new KvStoreApp();
    await app.initChain({ chainId: 'kv', genesisTime: 0n, validators: [{ publicKey: alice.publicKey, power: 10n }], appState: new Uint8Array() });
    const enc = (s: string) => new TextEncoder().encode(s);
    const r = await app.finalizeBlock({ height: 1n, time: 1n, txs: [enc(`val:${toHex(bob.publicKey)}:0`), enc(`val:${toHex(bob.publicKey)}:5`), enc(`val:${toHex(bob.publicKey)}:7`)], proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });
    expect(r.txResults.map((t) => t.ok)).toEqual([false, true, true]);
    expect(r.validatorUpdates).toEqual([{ publicKey: bob.publicKey, power: 7n }]);
  });

  it('still punishes a double sign reported against a rotated key, and never reuses a key', async () => {
    const app = makeApp();
    await block(app);
    const infraction = app.lastHeight;
    const r = await block(app, [tx(app, [{ type: 'validatorUpdate', operator: OP_ID, validator: VAL_ID, consensusKey: consB.publicKey }], [op])]);
    expect(r.txResults[0]!.ok).toBe(true);
    expect((await app.checkTx(tx(app, [{ type: 'validatorUpdate', operator: OP_ID, validator: VAL_ID, consensusKey: consA.publicKey }], [op]))).error).toMatch(/already in use/);
    await block(app, [], [{ address: consA.address, height: infraction }]);
    expect(app.db.get(ValidatorType, VAL_ID)!.status).toBe(ValidatorStatus.tombstoned);
  });

  it('slashes stake that was unbonding during the two-height delay', async () => {
    const app = makeApp();
    await block(app);
    await block(app, [tx(app, [{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID, amount: T(100) }])]);
    const d = app.db.range(UnbondingType, 'byCompletion', new Uint8Array(0));
    expect(d.length).toBe(0);
    const delegation = app.db.lookup(DelegationType, 'byDelegatorValidator', key((k) => k.id(FAUCET_ID).id(VAL_ID)))!;
    const undelegateHeight = app.lastHeight + 1n;
    await block(app, [tx(app, [{ type: 'undelegate', delegator: FAUCET_ID, validator: VAL_ID, shares: delegation.shares }])]);
    const entry = app.db.range(UnbondingType, 'byCompletion', new Uint8Array(0))[0]!;
    expect(entry.creationHeight).toBe(undelegateHeight);
    // The infraction is one height after the undelegation: that stake was still signing.
    await block(app, [], [{ address: consA.address, height: undelegateHeight + 1n }]);
    const after = app.db.get(UnbondingType, entry.id)!;
    expect(after.tokens).toBe(entry.tokens - (entry.tokens * 500n) / 10_000n);
  });

  it('drops a virtual history entry when the transaction it belongs to fails', async () => {
    const app = makeApp();
    await block(app);
    for (let i = 0; i < 4; i++) await app.finalizeBlock({ height: app.lastHeight + 1n, time: app.dynamic().time + 1000n, txs: [], proposerAddress: consA.address, lastCommitSigners: [], misbehavior: [] }).then(() => app.commit());
    expect(app.db.get(ValidatorType, VAL_ID)!.status).toBe(ValidatorStatus.jailed);
    await block(app, [], [], 2000n);
    // unjail followed by an operation that fails: the whole transaction is void, the unjail entry too.
    const bad = tx(app, [{ type: 'unjail', operator: OP_ID, validator: VAL_ID }, { type: 'transfer', from: OP_ID, to: FAUCET_ID, asset: CORE, amount: T(1_000_000) }], [op]);
    const r = await block(app, [bad]);
    expect(r.txResults[0]!.ok).toBe(false);
    expect(app.db.get(ValidatorType, VAL_ID)!.status).toBe(ValidatorStatus.jailed);
    expect(app.accountHistory(OP_ID).entries.some((e) => e.kind === HistoryKind.unjail)).toBe(false);
  });

  it('rebuilds index history correctly when two objects swap keys in one version', () => {
    interface Item {
      id: bigint;
      name: string;
    }
    const ItemType: ObjectType<Item> = {
      id: 7,
      name: 'item',
      encode: (w, o) => void w.string(o.name),
      decode: (r, id) => ({ id, name: r.string() }),
      indices: [{ name: 'byName', unique: true, authenticated: true, key: (o, k) => k.str(o.name) }],
    };
    const db = new ObjectDatabase([ItemType], { retainVersions: 4 });
    const a = db.create(ItemType, (id) => ({ id, name: 'a' }));
    const b = db.create(ItemType, (id) => ({ id, name: 'b' }));
    db.root(0);
    db.modify(ItemType, a.id, (o) => ({ ...o, name: 'tmp' }));
    db.modify(ItemType, b.id, (o) => ({ ...o, name: 'a' }));
    db.modify(ItemType, a.id, (o) => ({ ...o, name: 'b' }));
    const root = db.root(1);
    const fresh = new ObjectDatabase([ItemType], { retainVersions: 4 });
    for (const [id, bytes] of db.exportObjects()) fresh.importObject(id, bytes);
    for (const [t, n] of db.counters()) fresh.setCounter(t, n);
    expect(toHex(fresh.root(1))).toBe(toHex(root));
    fresh.loadHistory(1, db.lastChanges!.history!);
    expect(() => fresh.rebuildIndexVersions()).not.toThrow();
  });

  it('prunes sparse tree versions even with a zero retention window', () => {
    const t = new SparseMerkleTree(0);
    for (let i = 0; i < 5; i++) {
      t.set(new Uint8Array([i]), new Uint8Array([i]));
      t.commit(i);
    }
    expect(() => t.rootAt(3)).toThrow(/not available/);
    expect(t.rootAt(4)).toBeDefined();
  });

  it('keeps per-block results so a repeated transaction proves its real outcome at each position', () => {
    const store = new MemoryBlockStore();
    const raw = new Uint8Array([1, 2, 3]);
    const header = { chainId, version: 1, height: 5n, time: 1n, lastBlockHash: new Uint8Array(32), lastCommitHash: new Uint8Array(32), dataHash: txsRoot([raw, raw]), lastResultsHash: new Uint8Array(32), validatorsHash: new Uint8Array(32), nextValidatorsHash: new Uint8Array(32), appHash: new Uint8Array(32), evidenceHash: new Uint8Array(32), proposerAddress: new Uint8Array(32) };
    const b = { header, txs: [raw, raw], lastCommit: null, evidence: [] };
    const results = [{ ok: true }, { ok: false, error: 'duplicate transaction' }];
    store.saveBlock(b, { height: 5n, round: 0, blockHash: blockHash(b), signatures: [null] }, results);
    expect(store.txLocation(txHash(raw))).toMatchObject({ height: 5n, index: 0, ok: true });
    expect(store.loadResults(5n)).toEqual([{ ok: true, error: '' }, { ok: false, error: 'duplicate transaction' }]);
    const root = resultsRoot(store.loadResults(5n)!);
    expect(verifyResultProof(root, resultProofFor(5n, store.loadResults(5n)!, 1))).toBe(true);
    expect(resultProofFor(5n, store.loadResults(5n)!, 1).ok).toBe(false);
  });

  it('does a bounded amount of work on a peer status it cannot act on', () => {
    // A peer reports a higher height but nobody can serve the blocks. The sync
    // used to re-check after every drain, and an empty drain re-checked at once:
    // synchronous recursion until the stack overflowed, on every status message.
    const handlers = new Map<string, (peer: { id: string }, m: { height: bigint }) => void>();
    const network = { on: (type: string, fn: (peer: { id: string }, m: { height: bigint }) => void) => handlers.set(type, fn), onPeer: () => {}, onPeerGone: () => {}, peers: new Map() } as unknown as Network;
    let stateReads = 0;
    const sync = new BlockSync({
      chainId,
      getState: () => {
        stateReads++;
        return { lastHeight: 0n } as ChainState;
      },
      applyBlock: async () => {},
      validatorSetAtHeight: () => null,
      blockTimeAt: () => null,
      store: new MemoryBlockStore(),
      verifier,
      limits: DEFAULT_LIMITS,
      network,
      requester: {} as Requester,
      isConsensusDeciding: () => false,
      onBlockApplied: () => {},
      log: () => {},
      lagGraceMs: 0,
    });
    sync.start();
    handlers.get('status')!({ id: 'peer' }, { height: 10n });
    expect(stateReads).toBeLessThan(10);
    sync.stop();
  });

  it('decodes a string to exactly what was encoded, byte-order mark included, and refuses malformed UTF-8', () => {
    const s = '\uFEFFname';
    expect(decode(encode((w) => w.string(s)), (r) => r.string())).toBe(s);
    expect(() => decode(encode((w) => w.bytes(new Uint8Array([0xff, 0xfe]))), (r) => r.string())).toThrow();
  });

  it('does not remember a transaction it refused because the pool filled while checking it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const app = {
      checkTx: async () => {
        await gate;
        return { ok: true };
      },
    } as unknown as Application;
    const pool = new Mempool(app, { maxTxs: 1 });
    const a = pool.addTx(new Uint8Array([1]));
    const b = pool.addTx(new Uint8Array([2]));
    release();
    expect((await a).status).toBe('added');
    expect((await b).status).toBe('full');
    // Resubmitting the refused one hears full again, not seen; once there is room it gets in.
    expect((await pool.addTx(new Uint8Array([2]))).status).toBe('full');
    await pool.update([new Uint8Array([1])]);
    expect((await pool.addTx(new Uint8Array([2]))).status).toBe('added');
  });

  it('saves everything a height needs to the block store in one transaction', () => {
    class Counting extends MemoryKv {
      writes = 0;
      override write(fn: (w: KvWriter) => void): void {
        this.writes++;
        super.write(fn);
      }
    }
    const kv = new Counting();
    const store = new KvBlockStore(kv);
    const set = ValidatorSet.create([{ publicKey: alice.publicKey, power: 10n }]);
    store.batch(() => {
      store.saveValidatorSet(set);
      store.saveValidatorsAt(3n, set);
      store.setLowestHeight(1n);
    });
    expect(kv.writes).toBe(1);
    expect(store.loadValidatorsAt(3n)?.size).toBe(1);
    store.setLowestHeight(2n);
    expect(kv.writes).toBe(2);
  });

  it('proves a past height for an object type nothing changed in the window, after a restart', async () => {
    const kv = new MemoryKv();
    const app = new CoreApp({ genesis: genesis(), verifier: new InlineVerifier(), retainVersions: 8, kv });
    await block(app);
    for (let i = 0; i < 3; i++) await block(app, [tx(app, [{ type: 'transfer', from: FAUCET_ID, to: objectId(TYPE.account, 1), asset: CORE, amount: T(1) }])]);
    const reopened = new CoreApp({ genesis: genesis(), verifier: new InlineVerifier(), retainVersions: 8, kv });
    expect(reopened.lastHeight).toBe(4n);
    // Balances changed in every retained version; accounts in none. Both must be provable at a past height.
    for (const id of [objectId(TYPE.balance, 0), FAUCET_ID]) {
      const proof = reopened.proofAt(id, 2n);
      expect(verifyObjectProof(reopened.db.rootAt(2), proof)).toBe(true);
    }
  });

  it('replaces a verification worker that dies, failing only the jobs it held', async () => {
    const pool = new WorkerVerifier(1);
    const msg = new Uint8Array(32);
    const context = signContext(chainId, 'tx');
    const job = { sig: sign(msg, faucet.secretKey, context), msg, publicKey: faucet.publicKey, context };
    const pending = Array.from({ length: 300 }, () => pool.verifyOne(job));
    const workers = (pool as unknown as { workers: { terminate(): Promise<number> }[] }).workers;
    await workers[0]!.terminate();
    const settled = await Promise.allSettled(pending);
    expect(settled.some((s) => s.status === 'rejected' && /exited/.test((s.reason as Error).message))).toBe(true);
    expect(await pool.verifyOne(job)).toBe(true); // the replacement in the same slot
    await pool.close();
  });

  it('settles pending verifications when the worker pool closes', async () => {
    const pool = new WorkerVerifier(1);
    const msg = new Uint8Array(32);
    const context = signContext(chainId, 'tx');
    const job = { sig: sign(msg, faucet.secretKey, context), msg, publicKey: faucet.publicKey, context };
    const pending = pool.verify(Array.from({ length: 500 }, () => job));
    const rejected = expect(pending).rejects.toThrow(/verifier closed/); // attached before close, so the rejection is never unhandled
    await pool.close();
    await rejected;
  });
});

describe('review regressions on a network', () => {
  let net: Testnet | null = null;
  let tmp: string | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('resumes after a restart that left a signature at the current height, by skipping that round', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'resume-'));
    net = await makeTestnet({ validators: 1, dataDirFor: () => tmp });
    const node = net.nodes[0]!;
    await waitForHeight([node], 3n);
    const h = node.height;
    await node.stop();
    // Pretend the node had already signed a proposal for the next height before dying.
    const store = new FileSignStateStore(join(tmp, 'priv_validator_state.bin'));
    store.save({ height: h + 1n, round: 0, step: SignStep.Propose, signBytes: new Uint8Array([1]), signature: new Uint8Array(SIGNATURE_SIZE) });
    const restarted = await net.makeNode(0);
    net.nodes[0] = restarted;
    await restarted.start();
    await waitFor(() => restarted.height >= h + 2n, 20_000, () => `progress after restart (${restarted.height}, round ${restarted.consensus.round})`);
    expect(restarted.store.loadBlock(h + 1n)!.commit.round).toBeGreaterThanOrEqual(1);
  });

  it('survives an aborted request body on the RPC', async () => {
    net = await makeTestnet({ validators: 4, appFor: (_i, _d, g) => new CoreApp({ genesis: g, verifier }) });
    const server = new RpcServer(net.nodes[0]!, { port: 0 });
    const port = await server.start();
    try {
      await new Promise<void>((resolve) => {
        const s = createConnection({ host: '127.0.0.1', port }, () => {
          s.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"jsonrpc"');
          setTimeout(() => s.destroy(), 50);
        });
        s.on('close', () => resolve());
      });
      await new Promise((r) => setTimeout(r, 100));
      const rpc = new RpcClient(server.url);
      expect((await rpc.status()).chainId).toBe(net.genesis.chainId);
    } finally {
      await server.stop();
    }
  });

  it('decides a block re-proposed with a proof of lock after its round stalled past the clock drift limit', async () => {
    const n = await makeTestnet({ validators: 4, limits: { maxClockDriftMs: 300 } });
    net = n;
    await waitForHeight(n.nodes, 2n);
    // Round 0 at each of two consecutive heights: node 3 never sees the proposal (it prevotes and precommits nil),
    // and node 2 sees no round-0 prevote at all (it cannot reach a polka and precommits nil). Nodes 0 and 1 see
    // the polka, lock and precommit; no node holds three precommits for the block, and the round ends on three
    // precommits of any kind. Round 1 is lost entirely, so the block is re-proposed with polRound 0 in round 2 or
    // later, a second or more after it was built: beyond the drift limit of a fresh proposal. Checked against the
    // clock it would be refused everywhere, and with two validators locked on it no other block can gather a polka.
    const targets = new Set([n.nodes[0]!.height + 2n, n.nodes[0]!.height + 3n]);
    n.hub.messageFilter = (_from, to, frame) => {
      const m = decodeMessage(frame);
      if (m.type === 'proposal' && targets.has(m.proposal.height) && m.proposal.round === 0 && to === n.addrOf(3)) return false;
      // Votes are flooded, so node 2 must be cut off from every round-0 prevote, not only from those sent by nodes 0 and 1.
      if (m.type === 'vote' && targets.has(m.vote.height) && m.vote.round === 0 && m.vote.type === VoteType.Prevote && to === n.addrOf(2)) return false;
      if (m.type === 'proposal' && targets.has(m.proposal.height) && m.proposal.round === 1) return false;
      return true;
    };
    await waitForHeight(n.nodes, n.nodes[0]!.height + 4n, 30_000);
  });

  it('persists a decided height to the chain store in one transaction', async () => {
    class Recording extends MemoryKv {
      readonly batches: Set<number>[] = [];
      override write(fn: (w: KvWriter) => void): void {
        const prefixes = new Set<number>();
        super.write((w) =>
          fn({
            put: (k, v) => {
              prefixes.add(k[0]!);
              w.put(k, v);
            },
            del: (k) => w.del(k),
          }),
        );
        this.batches.push(prefixes);
      }
    }
    const chain = new Recording();
    const env: KvEnv = { store: (name) => (name === 'chain' ? chain : new MemoryKv()), transaction: (fn) => fn(), close: async () => {} };
    const n = await makeTestnet({ validators: 1, skipStart: [0] });
    net = n;
    const node = await n.makeNode(0, { env });
    await node.start();
    try {
      await waitFor(() => node.height >= 3n, 10_000, 'three blocks');
      // One transaction holds the block ('b'), the set by height ('V') and the chain state ('s') together.
      const together = chain.batches.filter((p) => p.has(0x62) && p.has(0x56) && p.has(0x73)).length;
      expect(together).toBeGreaterThanOrEqual(3);
      expect(chain.batches.some((p) => p.has(0x62) && !p.has(0x73) && !p.has(0x56))).toBe(false);
    } finally {
      await node.stop();
    }
  });

  it('refuses a second node on a data directory that is in use', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lock-'));
    const n = await makeTestnet({ validators: 1, dataDirFor: () => tmp });
    net = n;
    await expect(n.makeNode(0)).rejects.toThrow(/in use/);
    await n.stop();
    net = null;
    const again = await n.makeNode(0);
    await again.stop();
  });

  it('refuses a light client anchor older than the trusting period', async () => {
    const n = await makeTestnet({ validators: 2 });
    net = n;
    await waitForHeight(n.nodes, 3n);
    const hash = headerHash(n.nodes[0]!.store.loadBlock(2n)!.block.header);
    const opts = { chainId: n.genesis.chainId, provider: new NodeProvider(n.nodes[1]!), verifier };
    await expect(LightClient.trust({ ...opts, trustingPeriodMs: 1n }, 2n, hash)).rejects.toThrow(/trusting period/);
    expect((await LightClient.trust(opts, 2n, hash)).trusted.header.height).toBe(2n);
  });
});
