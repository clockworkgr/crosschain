/**
 * The object database, the application and the codec where a failure or an unusual caller used to leave them wrong:
 * a store write that fails under the account history, a block that fails once its session is closed, a delegation
 * to a validator slashed to nothing, an authority no key leads to, reads of the committed state after writes made
 * outside a session, the limits on types and authenticated indices, buffers that stay their owner's, and the
 * validator set of the toy application.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson, type StakingParametersJson } from '../src/app/core/genesis.ts';
import { HistoryKind, HistoryLog, type HistoryEntry } from '../src/app/core/history.ts';
import { delegationOf } from '../src/app/core/staking.ts';
import type { OperationDraft } from '../src/app/core/tx.ts';
import { TYPE, ValidatorType } from '../src/app/core/types.ts';
import { KvStoreApp } from '../src/app/kvstore.ts';
import { Reader } from '../src/codec/reader.ts';
import { Writer } from '../src/codec/writer.ts';
import { toHex } from '../src/crypto/hash.ts';
import { DEFAULT_SCHEME, keyPairFromSeed, schemeName, type KeyPair } from '../src/crypto/keys.ts';
import { InlineVerifier } from '../src/crypto/verifier.ts';
import { ObjectDatabase } from '../src/db/database.ts';
import { objectId, type ObjectId } from '../src/db/id.ts';
import type { ObjectType } from '../src/db/index.ts';
import { MAX_AUTHENTICATED_INDICES, proofFromBytes, proofToBytes, verifyObjectProof } from '../src/db/proof.ts';
import { SparseMerkleTree } from '../src/db/smt.ts';
import { MemoryKv, type KvStore, type KvWriter } from '../src/store/kv.ts';
import type { Genesis } from '../src/types/genesis.ts';
import { MAX_TOTAL_POWER } from '../src/types/validator.ts';
import { seedFor } from './helpers.ts';

const chainId = 'review5-app';
const genesisTime = 1_700_000_000_000n;
const UNIT = 100_000n;
const T = (whole: number | bigint) => BigInt(whole) * UNIT;

const faucet = keyPairFromSeed(seedFor('r5a/faucet'));
const ops = ['a', 'b', 'c'].map((n) => keyPairFromSeed(seedFor(`r5a/op/${n}`)));
const cons = ['a', 'b', 'c'].map((n) => keyPairFromSeed(seedFor(`r5a/cons/${n}`)));
const FAUCET_ID = objectId(TYPE.account, 0);
const OP_ID = (i: number) => objectId(TYPE.account, 1 + i);
const VAL_ID = (i: number) => objectId(TYPE.validator, i);
const CORE = objectId(TYPE.asset, 0);

const PARAMS: StakingParametersJson = {
  maxValidators: 3,
  unbondingPeriodMs: 10_000,
  minSelfBond: 100,
  minDelegation: 1,
  validatorCreationFee: 10,
  commissionBps: 1000,
  fixedRewardPerBlock: 0,
  proposerBonusBps: 500,
  doubleSignSlashBps: 500,
  downtimeWindow: 4,
  downtimeMinSignedBps: 5000,
  downtimeJailMs: 5000,
  downtimeSlashBps: 1,
  maxEntries: 2,
  proposalLifetimeMs: 20_000,
  inflationMinBps: 0,
  inflationMaxBps: 0,
};

function makeGenesis(staking: StakingParametersJson = PARAMS): Genesis {
  const acct = (name: string, k: KeyPair, balance: bigint) => ({ name, owner: authorityJson([k.publicKey]), active: authorityJson([k.publicKey]), balance: balance.toString() });
  return {
    chainId,
    signatureScheme: schemeName(DEFAULT_SCHEME),
    genesisTime,
    appState: appGenesisBytes({
      accounts: [acct('faucet', faucet, T(10_000)), acct('op-a', ops[0]!, T(1000)), acct('op-b', ops[1]!, T(1000)), acct('op-c', ops[2]!, T(1000))],
      staking,
      communityPool: 1000,
      validators: [0, 1].map((i) => ({ operator: `op-${'abc'[i]}`, consensusKey: toHex(cons[i]!.publicKey), selfBond: [200, 100][i]! })),
    }),
  };
}

const makeApp = (opts: { kv?: KvStore; staking?: StakingParametersJson; snapshotInterval?: number; verifier?: InlineVerifier } = {}): CoreApp =>
  new CoreApp({ genesis: makeGenesis(opts.staking), verifier: opts.verifier ?? new InlineVerifier(), retainVersions: 8, kv: opts.kv, snapshotInterval: opts.snapshotInterval ?? 0 });

const request = (app: CoreApp, txs: Uint8Array[], signers: KeyPair[] = [cons[0]!, cons[1]!]) => {
  const height = app.lastHeight + 1n;
  return { height, time: app.dynamic().time + 1000n, txs, proposerAddress: cons[0]!.address, lastCommitSigners: height === 1n ? [] : signers.map((k) => k.address), misbehavior: [] };
};

async function block(app: CoreApp, txs: Uint8Array[] = [], signers?: KeyPair[]) {
  const res = await app.finalizeBlock(request(app, txs, signers));
  await app.commit();
  return res;
}

const tx = (app: CoreApp, operations: OperationDraft[], keys: KeyPair[]) => signedTxBytes(chainId, { expiration: app.dynamic().time + 60_000n, operations: withFees(operations, app.feeSchedule()) }, keys);
const transfer = (app: CoreApp, to: ObjectId, amount: bigint) => tx(app, [{ type: 'transfer', from: FAUCET_ID, to, asset: CORE, amount }], [faucet]);

/** A store whose write number `failAt` (counted from the next one) takes nothing and throws, once. */
class FlakyKv implements KvStore {
  readonly inner = new MemoryKv();
  failAt = 0;
  get = (k: Uint8Array) => this.inner.get(k);
  range = (start: Uint8Array, end: Uint8Array) => this.inner.range(start, end);
  write(fn: (w: KvWriter) => void): void {
    if (this.failAt > 0 && --this.failAt === 0) {
      // The callback runs to its end, as it does in a store whose transaction fails when it commits.
      this.inner.write((w) => {
        fn(w);
        throw new Error('disk full');
      });
    } else this.inner.write(fn);
  }
}

describe('a store write that fails', () => {
  const entry = (height: bigint): HistoryEntry => ({ height, position: 0, opIndex: 0, kind: HistoryKind.operation, txHash: null, data: Uint8Array.of(Number(height)) });

  it('leaves the account history log where the store is, so the entries can be appended again', () => {
    const kv = new FlakyKv();
    const log = new HistoryLog(kv);
    const a = objectId(TYPE.account, 3);
    const b = objectId(TYPE.account, 700); // beyond the first slices: the write that fails also widens them
    kv.write((w) => log.append(w, [[a, entry(1n)]]));
    const second: [ObjectId, HistoryEntry][] = [[a, entry(2n)], [b, entry(2n)], [a, entry(2n)]];
    kv.failAt = 1;
    expect(() => kv.write((w) => log.append(w, second))).toThrow('disk full');
    log.rollback();
    expect(log.total(a)).toBe(1n);
    expect(log.total(b)).toBe(0n);
    kv.write((w) => log.append(w, second));
    kv.write((w) => log.append(w, [[b, entry(3n)]]));
    expect(log.read(a, 0n, 10, false).entries.map((e) => e.height)).toEqual([1n, 2n, 2n]);
    expect(log.read(b, 0n, 10, true).entries.map((e) => e.height)).toEqual([3n, 2n]);
    // A log opened over the store agrees with the one that went through the failure.
    const reopened = new HistoryLog(kv);
    expect(reopened.read(a, 0n, 10, false)).toEqual(log.read(a, 0n, 10, false));
    expect(reopened.read(b, 0n, 10, false)).toEqual(log.read(b, 0n, 10, false));
  });

  it('throws out of commit() where it is called, and the block is written by the next commit() with its history', async () => {
    const kv = new FlakyKv();
    const app = makeApp({ kv });
    const control = makeApp();
    for (const a of [app, control]) await block(a, [transfer(a, OP_ID(0), 5n)]);
    for (const a of [app, control]) await a.finalizeBlock(request(a, [transfer(a, OP_ID(0), 6n), transfer(a, OP_ID(1), 7n)]));
    kv.failAt = 1;
    // Not a rejected promise: a caller with a store transaction open around the call has it aborted.
    expect(() => app.commit()).toThrow('disk full');
    expect(new CoreApp({ genesis: makeGenesis(), verifier: new InlineVerifier(), kv: kv.inner }).lastHeight).toBe(1n);
    await app.commit();
    await control.commit();
    for (const a of [app, control]) await block(a, [transfer(a, OP_ID(1), 8n)]);
    for (const id of [FAUCET_ID, OP_ID(0), OP_ID(1)]) {
      expect(app.accountHistory(id)).toEqual(control.accountHistory(id));
      expect(app.accountHistory(id, 0n, 2, true)).toEqual(control.accountHistory(id, 0n, 2, true));
    }
    expect(app.accountHistory(FAUCET_ID).total).toBe(4n);
    expect(app.lastAppHash).toEqual(control.lastAppHash);
    // What the store holds opens to the same state and the same history.
    const reopened = new CoreApp({ genesis: makeGenesis(), verifier: new InlineVerifier(), kv, retainVersions: 8, snapshotInterval: 0 });
    expect(reopened.lastHeight).toBe(3n);
    expect(reopened.accountHistory(FAUCET_ID)).toEqual(control.accountHistory(FAUCET_ID));
  });

  it('rejects the promise, with the block written, when only the snapshot after it fails', async () => {
    const kv = new FlakyKv();
    const app = makeApp({ kv, snapshotInterval: 1 });
    await app.finalizeBlock(request(app, [transfer(app, OP_ID(0), 5n)]));
    kv.failAt = 2; // the block is the first write, the snapshot the second
    const committed = app.commit();
    await expect(committed).rejects.toThrow('disk full');
    expect(new CoreApp({ genesis: makeGenesis(), verifier: new InlineVerifier(), kv }).lastHeight).toBe(1n);
  });
});

describe('a block that fails after its session is closed', () => {
  it('stops the application until a restart, which has the state of the block before', async () => {
    const kv = new MemoryKv();
    const app = makeApp({ kv });
    await block(app, [transfer(app, OP_ID(0), 5n)]);
    const before = app.balance(OP_ID(0));
    const txs = [transfer(app, OP_ID(0), 6n)];
    const req = request(app, txs);
    vi.spyOn(app.db, 'root').mockImplementationOnce(() => {
      throw new Error('no room for the root');
    });
    await expect(app.finalizeBlock(req)).rejects.toThrow('no room for the root');
    expect(app.lastHeight).toBe(1n);
    // The block's changes are in the database and cannot be undone: applying it again would apply it twice.
    await expect(app.finalizeBlock(req)).rejects.toThrow(/failed while taking the root of block 2.*restart/);
    const check = await app.checkTx(txs[0]!);
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/restart/);
    await app.commit(); // nothing to write
    const restarted = makeApp({ kv });
    expect(restarted.lastHeight).toBe(1n);
    expect(restarted.balance(OP_ID(0))).toBe(before);
    const res = await block(restarted, txs);
    expect(res.txResults[0]!.ok).toBe(true);
    expect(restarted.balance(OP_ID(0))).toBe(before + 6n);
  });

  it('still undoes a block that fails while its session is open, and goes on', async () => {
    const verifier = new InlineVerifier();
    const app = makeApp({ verifier });
    await block(app);
    const req = request(app, [transfer(app, OP_ID(0), 6n)]);
    vi.spyOn(verifier, 'verify').mockRejectedValueOnce(new Error('the pool is gone'));
    await expect(app.finalizeBlock(req)).rejects.toThrow('the pool is gone');
    expect(app.lastHeight).toBe(1n);
    expect((await app.finalizeBlock(req)).txResults[0]!.ok).toBe(true);
    expect(app.lastHeight).toBe(2n);
  });
});

describe('staking and authorities', () => {
  it('refuses a delegation to a validator that has shares and no tokens', async () => {
    const app = makeApp({ staking: { ...PARAMS, downtimeSlashBps: 10_000 } });
    await block(app, [tx(app, [{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID(0), amount: T(50) }], [faucet])]);
    // B misses four blocks in a row with a window of four at 50%, and the slash for it takes everything.
    for (let i = 0; i < 4; i++) await block(app, [], [cons[0]!]);
    const b = app.db.get(ValidatorType, VAL_ID(1))!;
    expect(b.tokens).toBe(0n);
    expect(b.shares).toBeGreaterThan(0n);
    const delegate = tx(app, [{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID(1), amount: T(5) }], [faucet]);
    expect((await app.checkTx(delegate)).error).toMatch(/lost all its tokens/);
    const shares = app.db.get(ValidatorType, VAL_ID(0))!.shares;
    const r = await block(app, [delegate, tx(app, [{ type: 'redelegate', delegator: FAUCET_ID, source: VAL_ID(0), destination: VAL_ID(1), shares: delegationOf(app.db, FAUCET_ID, VAL_ID(0))!.shares / 2n }], [faucet])], [cons[0]!]);
    expect(r.txResults.map((t) => t.ok)).toEqual([false, false]);
    expect(r.txResults[1]!.error).toMatch(/lost all its tokens/);
    expect(app.db.get(ValidatorType, VAL_ID(1))!.tokens).toBe(0n);
    expect(app.db.get(ValidatorType, VAL_ID(0))!.shares).toBe(shares);
  });

  it('refuses an account update whose new authority no key leads to', async () => {
    const app = makeApp();
    await block(app);
    const update = (i: number, owner: bigint[] | null, active: bigint[] | null): Uint8Array =>
      tx(app, [{ type: 'accountUpdate', account: OP_ID(i), owner: owner && makeAuthority([], 1, owner), active: active && makeAuthority([], 1, active) }], [ops[i]!]);
    // Both authorities a reference to the account itself: nothing could ever sign for it again.
    expect((await app.checkTx(update(0, [OP_ID(0)], [OP_ID(0)]))).error).toMatch(/can never be satisfied/);
    expect((await app.checkTx(update(0, null, [OP_ID(0)]))).error).toMatch(/can never be satisfied/);
    const r = await block(app, [update(0, [OP_ID(0)], [OP_ID(0)])]);
    expect(r.txResults[0]!.error).toMatch(/can never be satisfied/);
    // The owner as a reference to the account is satisfied by the key its active authority keeps.
    expect((await block(app, [update(0, [OP_ID(0)], null)])).txResults[0]!.ok).toBe(true);
    // Through member accounts a key is found down to the depth limit and no further: c has a key, b names c, a
    // names b, and the faucet naming a would be three accounts away from it.
    expect((await block(app, [update(1, null, [OP_ID(2)])])).txResults[0]!.ok).toBe(true);
    expect((await block(app, [update(0, null, [OP_ID(1)])])).txResults[0]!.ok).toBe(true);
    const tooDeep = tx(app, [{ type: 'accountUpdate', account: FAUCET_ID, owner: null, active: makeAuthority([], 1, [OP_ID(0)]) }], [faucet]);
    expect((await app.checkTx(tooDeep)).error).toMatch(/can never be satisfied/);
    // Keys of its own that do not reach the threshold, and a member that leads to none.
    const short = tx(app, [{ type: 'accountUpdate', account: FAUCET_ID, owner: null, active: makeAuthority([faucet.publicKey], 2, [OP_ID(0)]) }], [faucet]);
    expect((await app.checkTx(short)).error).toMatch(/can never be satisfied/);
    const enough = tx(app, [{ type: 'accountUpdate', account: FAUCET_ID, owner: null, active: makeAuthority([faucet.publicKey], 2, [OP_ID(2)]) }], [faucet]);
    expect((await app.checkTx(enough)).ok).toBe(true);
    // a is still usable: c's key signs for it through b.
    const viaC = tx(app, [{ type: 'transfer', from: OP_ID(0), to: FAUCET_ID, asset: CORE, amount: 1n }], [ops[2]!]);
    expect((await app.checkTx(viaC)).ok).toBe(true);
  });

  it('refuses an authority that needs more signatures than a transaction carries', async () => {
    const app = makeApp();
    await block(app);
    const many = Array.from({ length: 16 }, (_, i) => keyPairFromSeed(seedFor(`r5a/many/${i}`)).publicKey);
    // Sixteen keys, all needed, is the most one transaction can sign for, and is allowed.
    const sixteen = tx(app, [{ type: 'accountUpdate', account: OP_ID(0), owner: null, active: makeAuthority(many, 16) }], [ops[0]!]);
    expect((await block(app, [sixteen])).txResults[0]!.ok).toBe(true);
    // That account and another with one key, both needed, is seventeen signatures.
    const both = tx(app, [{ type: 'accountUpdate', account: FAUCET_ID, owner: null, active: makeAuthority([], 2, [OP_ID(0), OP_ID(1)]) }], [faucet]);
    expect((await app.checkTx(both)).error).toMatch(/more than the 16 signatures/);
    expect((await block(app, [both])).txResults[0]!.error).toMatch(/more than the 16 signatures/);
    // Either of the two is one signature by the cheaper way, though seventeen keys count toward it.
    const either = tx(app, [{ type: 'accountUpdate', account: FAUCET_ID, owner: null, active: makeAuthority([], 1, [OP_ID(0), OP_ID(1)]) }], [faucet]);
    expect((await block(app, [either])).txResults[0]!.ok).toBe(true);
  });
});

interface Item {
  id: bigint;
  name: string;
  value: bigint;
}

const itemType = (id: number, authenticated: number): ObjectType<Item> => ({
  id,
  name: `item${id}`,
  encode(w, o) {
    w.string(o.name).u64(o.value);
  },
  decode(r, id) {
    return { id, name: r.string(), value: r.u64() };
  },
  indices: Array.from({ length: authenticated }, (_, i): ObjectType<Item>['indices'][number] => ({ name: `by${i}`, unique: true, authenticated: true, key: (o, k) => k.str(`${i}/${o.name}`) })),
});

describe('object database', () => {
  it('answers with the state of the last root after writes made outside a session', () => {
    const ItemType = itemType(7, 1);
    const db = new ObjectDatabase([ItemType]);
    const a = db.create(ItemType, (id) => ({ id, name: 'a', value: 1n })).id;
    const gone = db.create(ItemType, (id) => ({ id, name: 'gone', value: 2n })).id;
    const root = db.root(1);
    db.modify(ItemType, a, (o) => ({ ...o, value: 10n }));
    db.remove(ItemType, gone);
    const b = db.create(ItemType, (id) => ({ id, name: 'b', value: 3n })).id;
    const check = () => {
      expect(db.getCommitted(ItemType, a)!.value).toBe(1n);
      expect(db.getCommitted(ItemType, gone)!.value).toBe(2n);
      expect(db.getCommitted(ItemType, b)).toBeNull();
      expect(db.committedNextInstance(7)).toBe(2);
      expect(db.countAt(7, 1)).toBe(2);
      expect(db.getAt(ItemType, a, 1)!.value).toBe(1n);
      for (const [id, present] of [[a, true], [gone, true], [b, false]] as const) {
        const proof = db.proofAt(id, 1);
        expect(proof.value !== null).toBe(present);
        expect(verifyObjectProof(root, proof)).toBe(true);
      }
    };
    check();
    // The same with a session open over them, and with further writes inside it.
    const s = db.startSession();
    db.modify(ItemType, a, (o) => ({ ...o, value: 11n }));
    check();
    s.undo();
    check();
    expect(db.get(ItemType, a)!.value).toBe(10n);
    const next = db.root(2);
    expect(db.getCommitted(ItemType, a)!.value).toBe(10n);
    expect(db.getCommitted(ItemType, gone)).toBeNull();
    expect(verifyObjectProof(next, db.proofAt(b, 2))).toBe(true);
    expect(verifyObjectProof(root, db.proofAt(a, 1))).toBe(true);
  });

  it('refuses more types than its dropped trees have places for, before any tree is touched', () => {
    const types = (n: number) => Array.from({ length: n }, (_, i) => itemType(i + 1, 0));
    expect(() => new ObjectDatabase(types(512))).toThrow(/at most 511/);
    const db = new ObjectDatabase(types(511), { trees: true });
    db.create(types(1)[0]!, (id) => ({ id, name: 'a', value: 1n }));
    const root = db.root(1);
    db.dropTrees();
    expect(db.treesAreResident).toBe(false);
    db.rebuildTrees();
    db.dropTrees();
    expect(verifyObjectProof(root, db.proof(objectId(1, 0)))).toBe(true);
  });

  it('refuses more authenticated indices on a type than a proof can be decoded with', () => {
    expect(() => new ObjectDatabase([itemType(7, MAX_AUTHENTICATED_INDICES + 1)])).toThrow(/more than 16 authenticated indices/);
    const type = itemType(7, MAX_AUTHENTICATED_INDICES);
    const db = new ObjectDatabase([type]);
    const id = db.create(type, (id) => ({ id, name: 'a', value: 1n })).id;
    const root = db.root(1);
    const proof = proofFromBytes(proofToBytes(db.proof(id)));
    expect(proof.indexRoots.length).toBe(16);
    expect(verifyObjectProof(root, proof)).toBe(true);
  });

  it('keeps its own copy of a value set in a sparse tree', () => {
    for (const dropped of [false, true]) {
      const tree = new SparseMerkleTree();
      const reference = new SparseMerkleTree();
      if (dropped) for (const t of [tree, reference]) t.drop({ get: () => undefined, range: () => [][Symbol.iterator]() });
      const value = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
      tree.set(Uint8Array.of(1), value);
      reference.set(Uint8Array.of(1), value.slice());
      value.fill(0xff);
      expect(tree.get(Uint8Array.of(1))).toEqual(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
      expect(tree.commit(1)).toEqual(reference.commit(1));
    }
  });
});

describe('codec', () => {
  it('reads a copy out of a Buffer as out of a Uint8Array', () => {
    for (const make of [(b: number[]) => Uint8Array.from(b), (b: number[]) => Buffer.from(b)]) {
      const input = make([0, 0, 0, 2, 7, 8, 9, 10]);
      const r = new Reader(input);
      const prefixed = r.bytes();
      const fixed = r.fixed(2);
      r.finish();
      input.fill(0xff);
      expect([...prefixed]).toEqual([7, 8]);
      expect([...fixed]).toEqual([9, 10]);
      expect(fixed.constructor).toBe(Uint8Array);
      expect(fixed.buffer).not.toBe(input.buffer);
    }
  });

  it('grows a writer that was made with no capacity', () => {
    expect(new Writer(0).u8(1).u64(2n).finish()).toEqual(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 2));
    expect(new Writer(0).fixed(new Uint8Array(100)).finish().length).toBe(100);
    expect(new Writer(1).u32(5).finish()).toEqual(Uint8Array.of(0, 0, 0, 5));
  });
});

describe('the toy application and its validator set', () => {
  const alice = keyPairFromSeed(seedFor('r5a/kv/alice'));
  const bob = keyPairFromSeed(seedFor('r5a/kv/bob'));
  const enc = (s: string) => new TextEncoder().encode(s);
  const val = (k: KeyPair, power: bigint | number) => enc(`val:${toHex(k.publicKey)}:${power}`);
  const genesis: Genesis = { chainId: 'kv', signatureScheme: schemeName(DEFAULT_SCHEME), genesisTime: 0n, validators: [{ publicKey: alice.publicKey, power: 10n }], appState: new Uint8Array() };
  const run = (app: KvStoreApp, height: bigint, txs: Uint8Array[]) => app.finalizeBlock({ height, time: height, txs, proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });

  it('fails a transaction whose update the engine could not apply to the set', async () => {
    const app = new KvStoreApp();
    await app.initChain(genesis);
    // Added and removed in one block: the engine never had it, and is told nothing.
    let r = await run(app, 1n, [val(bob, 5), val(bob, 0)]);
    expect(r.txResults.map((t) => t.ok)).toEqual([true, true]);
    expect(r.validatorUpdates).toEqual([]);
    await app.commit();
    // The last validator stays, and the total stays within the engine's limit.
    r = await run(app, 2n, [val(alice, 0), val(bob, MAX_TOTAL_POWER), val(bob, MAX_TOTAL_POWER - 10n), val(alice, 11)]);
    expect(r.txResults.map((t) => t.ok)).toEqual([false, false, true, false]);
    expect(r.txResults[0]!.error).toMatch(/last validator/);
    expect(r.txResults[1]!.error).toMatch(/exceed the limit/);
    expect(r.validatorUpdates).toEqual([{ publicKey: bob.publicKey, power: MAX_TOTAL_POWER - 10n }]);
    await app.commit();
    // With two in the set the first may go, and then the other is the last.
    r = await run(app, 3n, [val(alice, 0), val(bob, 0)]);
    expect(r.txResults.map((t) => t.ok)).toEqual([true, false]);
    expect(r.validatorUpdates).toEqual([{ publicKey: alice.publicKey, power: 0n }]);
  });

  it('has its validator set back from its file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5a-kv-'));
    try {
      const file = join(dir, 'app.json');
      const app = new KvStoreApp(file);
      await app.initChain(genesis);
      await run(app, 1n, [val(bob, 5)]);
      await app.commit();
      const reopened = new KvStoreApp(file);
      const r = await run(reopened, 2n, [val(bob, 0), val(alice, 0)]);
      expect(r.txResults.map((t) => t.ok)).toEqual([true, false]);
      expect(r.validatorUpdates).toEqual([{ publicKey: bob.publicKey, power: 0n }]);
      // A file from before the set was kept has no set to give back, and is refused, not read as an empty one.
      writeFileSync(file, JSON.stringify({ height: '1', entries: [] }));
      expect(() => new KvStoreApp(file)).toThrow(/written before the validator set was kept/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
