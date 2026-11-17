import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp, migrateRecentTxIndex, openObjectDatabase } from '../src/app/core/app.ts';
import { makeAuthority, type Authority } from '../src/app/core/authority.ts';
import { signedTxBytes, signTransaction, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson, DEFAULT_FEES } from '../src/app/core/genesis.ts';
import { calculateFee, encodeTransaction, type Operation, type OperationDraft } from '../src/app/core/tx.ts';
import { AccountType, AssetType, BalanceType, CORE_TYPES, RecentTxType, TYPE } from '../src/app/core/types.ts';
import { chunkFromBytes, exportSnapshot, importSnapshot } from '../src/app/core/snapshot.ts';
import { decode } from '../src/codec/reader.ts';
import { encode } from '../src/codec/writer.ts';
import { keyProofFromBytes } from '../src/db/proof.ts';
import { sha256 } from '../src/crypto/hash.ts';
import { toHex } from '../src/crypto/hash.ts';
import { DEFAULT_SCHEME, keyPairFromSeed, schemeName } from '../src/crypto/keys.ts';
import { InlineVerifier } from '../src/crypto/verifier.ts';
import { objectId } from '../src/db/id.ts';
import { key } from '../src/db/keys.ts';
import { keyProofToBytes, proofToBytes, verifyKeyProof, verifyObjectProof } from '../src/db/proof.ts';
import { MemoryKv, prefixEnd } from '../src/store/kv.ts';
import { entryKey, indexHeader } from '../src/db/indexstore.ts';
import { chunkKey } from '../src/db/merkle.ts';
import { nodeHeader } from '../src/db/smt.ts';
import type { Genesis } from '../src/types/genesis.ts';
import { seedFor } from './helpers.ts';

const chainId = 'app-test';
const genesisTime = 1_700_000_000_000n;
const faucet = keyPairFromSeed(seedFor('faucet'));
const alice = keyPairFromSeed(seedFor('alice'));
const bob = keyPairFromSeed(seedFor('bob'));
const carol = keyPairFromSeed(seedFor('carol'));
const dave = keyPairFromSeed(seedFor('dave'));
const FAUCET_ID = objectId(TYPE.account, 0);
const FAUCET_START = 1_000_000_000n;

const genesis: Genesis = {
  chainId,
  signatureScheme: schemeName(DEFAULT_SCHEME),
  genesisTime,
  validators: [{ publicKey: keyPairFromSeed(seedFor('val')).publicKey, power: 10n }],
  appState: appGenesisBytes({
    accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: FAUCET_START.toString() }],
    staking: { inflationMinBps: 0, inflationMaxBps: 0, fixedRewardPerBlock: 0 },
  }),
};

const blockTime = (h: bigint) => genesisTime + 1000n * h;
const proofBytesAt = (app: CoreApp, id: bigint, h: bigint) => proofToBytes(app.proofAt(id, h));

function makeApp(kv: MemoryKv | null = null): CoreApp {
  return new CoreApp({ genesis, verifier: new InlineVerifier(), kv: kv ?? undefined, retainVersions: 4 });
}

async function block(app: CoreApp, txs: Uint8Array[]) {
  const height = app.lastHeight + 1n;
  const res = await app.finalizeBlock({ height, time: blockTime(height), txs, proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });
  await app.commit();
  return res;
}

const tx = (ops: OperationDraft[], keys = [faucet], expiration = genesisTime + 60_000n) => signedTxBytes(chainId, { expiration, operations: withFees(ops, DEFAULT_FEES) }, keys);
const createOp = (name: string, auth: Authority, registrar = FAUCET_ID, owner = auth): OperationDraft => ({ type: 'accountCreate', registrar, name, owner, active: auth });
const transferOp = (from: bigint, to: bigint, amount: bigint, asset = objectId(TYPE.asset, 0)): OperationDraft => ({ type: 'transfer', from, to, asset, amount });
/** What the default schedule charges: "alice" is a premium name, plus the data fee of a one-key registration. */
const FEES = { transfer: DEFAULT_FEES.transfer.fee, accountCreate: calculateFee(createOp('alice', makeAuthority([alice.publicKey])), DEFAULT_FEES) };

/** An app with alice registered and funded with 5000, at height 2. */
async function withAlice() {
  const app = makeApp();
  await block(app, [tx([createOp('alice', makeAuthority([alice.publicKey]))])]);
  const aliceId = app.accountByName('alice')!.id;
  await block(app, [tx([transferOp(FAUCET_ID, aliceId, 5000n)])]);
  return { app, aliceId };
}

describe('core application', () => {
  it('starts from genesis with the core asset and the faucet', () => {
    const app = makeApp();
    const f = app.accountByName('faucet')!;
    expect(f.id).toBe(FAUCET_ID);
    expect(app.balance(FAUCET_ID)).toBe(FAUCET_START);
    const core = app.db.get(AssetType, app.coreAsset)!;
    expect(core.symbol).toBe('CORE');
    expect(core.currentSupply).toBe(FAUCET_START);
    expect(core.issuer).toBe(FAUCET_ID);
    expect(app.dynamic().height).toBe(0n);
    expect(verifyObjectProof(app.lastAppHash, app.proof(FAUCET_ID))).toBe(true);
    expect(app.accountByName('nobody')).toBeNull();
    expect(app.accountByName('bad\0name')).toBeNull();
  });

  it('creates accounts and transfers, charging flat fees into the fee pool', async () => {
    const app = makeApp();
    const create = tx([createOp('alice', makeAuthority([alice.publicKey]))]);
    expect(await app.checkTx(create)).toEqual({ ok: true });
    const r1 = await block(app, [create]);
    expect(r1.txResults).toEqual([{ ok: true }]);
    const a = app.accountByName('alice')!;
    expect(a.id).toBe(objectId(TYPE.account, 1));
    expect(a.registrar).toBe(FAUCET_ID);
    expect(app.balance(FAUCET_ID)).toBe(FAUCET_START - FEES.accountCreate);

    const r2 = await block(app, [tx([transferOp(FAUCET_ID, a.id, 5000n)])]);
    expect(r2.txResults[0]!.ok).toBe(true);
    expect(app.balance(a.id)).toBe(5000n);
    expect(app.balance(FAUCET_ID)).toBe(FAUCET_START - FEES.accountCreate - 5000n - FEES.transfer);

    const r3 = await block(app, [tx([transferOp(a.id, FAUCET_ID, 100n)], [alice])]);
    expect(r3.txResults[0]!.ok).toBe(true);
    expect(app.balance(a.id)).toBe(5000n - 100n - FEES.transfer);
    expect(app.dynamic().communityPool).toBe(FEES.accountCreate + 2n * FEES.transfer);
    expect(app.dynamic().height).toBe(3n);
    expect(toHex(r3.appHash)).toBe(toHex(app.lastAppHash));
  });

  it('rejects malformed, unsigned, foreign-key and forged signatures', async () => {
    const { app, aliceId } = await withAlice();
    expect((await app.checkTx(new Uint8Array([1, 2, 3]))).error).toMatch(/malformed/);
    expect((await app.checkTx(tx([transferOp(aliceId, FAUCET_ID, 1n)], []))).error).toMatch(/no signatures/);
    expect((await app.checkTx(tx([transferOp(aliceId, FAUCET_ID, 1n)], [bob]))).error).toMatch(/no required authority/);
    expect((await app.checkTx(tx([transferOp(aliceId, FAUCET_ID, 1n)], [faucet]))).error).toMatch(/no required authority/);
    expect((await app.checkTx(tx([transferOp(aliceId, FAUCET_ID, 1n)], [alice, alice]))).error).toMatch(/duplicate signature/);
    const signed = signTransaction(chainId, { expiration: genesisTime + 60_000n, operations: withFees([transferOp(aliceId, FAUCET_ID, 1n)], DEFAULT_FEES) }, [alice]);
    signed.signatures[0]!.signature[10]! ^= 1;
    expect((await app.checkTx(encodeTransaction(signed))).error).toMatch(/invalid signature/);
    expect((await app.checkTx(tx([transferOp(aliceId, FAUCET_ID, 1n)], [alice]))).ok).toBe(true);
    expect((await app.checkTx(tx([transferOp(aliceId, objectId(TYPE.account, 9)!, 1n)], [alice]))).error).toMatch(/does not exist/);
    expect((await app.checkTx(tx([createOp('Alice', makeAuthority([bob.publicKey]))]))).error).toMatch(/account name/);
    expect((await app.checkTx(tx([createOp('alice', makeAuthority([bob.publicKey]))]))).error).toMatch(/taken/);
    expect((await app.checkTx(tx([createOp('bobby', { threshold: 2, accounts: [], keys: [{ publicKey: bob.publicKey, weight: 1 }] })]))).error).toMatch(/never be satisfied/);
  });

  it('honours multisig thresholds, account authorities, and owner versus active', async () => {
    const { app } = await withAlice();
    const aliceId = app.accountByName('alice')!.id;
    const multiActive = makeAuthority([alice.publicKey, bob.publicKey, carol.publicKey], 2);
    const childActive: Authority = { threshold: 1, accounts: [{ account: aliceId, weight: 1 }], keys: [] };
    await block(app, [
      tx([createOp('multi', multiActive, FAUCET_ID, makeAuthority([dave.publicKey]))]),
      tx([createOp('child', childActive, FAUCET_ID, makeAuthority([carol.publicKey]))]),
    ]);
    const multiId = app.accountByName('multi')!.id;
    const childId = app.accountByName('child')!.id;
    await block(app, [tx([transferOp(FAUCET_ID, multiId, 10_000n), transferOp(FAUCET_ID, childId, 10_000n)])]);

    expect((await app.checkTx(tx([transferOp(multiId, FAUCET_ID, 1n)], [alice]))).error).toMatch(/missing active authority of multi/);
    expect((await app.checkTx(tx([transferOp(multiId, FAUCET_ID, 1n)], [alice, carol]))).ok).toBe(true);
    expect((await app.checkTx(tx([transferOp(multiId, FAUCET_ID, 2n)], [dave]))).ok).toBe(true); // owner satisfies active
    // Alice's key satisfies child's active through the account authority; carol's key is child's owner.
    expect((await app.checkTx(tx([transferOp(childId, FAUCET_ID, 1n)], [alice]))).ok).toBe(true);
    expect((await app.checkTx(tx([transferOp(childId, FAUCET_ID, 2n)], [carol]))).ok).toBe(true);
    expect((await app.checkTx(tx([transferOp(childId, FAUCET_ID, 3n)], [bob]))).error).toMatch(/no required authority/);
    // Changing owner needs the owner authority.
    const newOwner: OperationDraft = { type: 'accountUpdate', account: childId, owner: makeAuthority([bob.publicKey]), active: null };
    expect((await app.checkTx(tx([newOwner], [alice]))).error).toMatch(/missing owner authority of child/);
    const r = await block(app, [tx([newOwner], [carol])]);
    expect(r.txResults[0]!.ok).toBe(true);
    expect((await app.checkTx(tx([transferOp(childId, FAUCET_ID, 4n)], [bob]))).ok).toBe(true);
    expect((await app.checkTx(tx([transferOp(childId, FAUCET_ID, 5n)], [carol]))).error).toMatch(/no required authority/);
  });

  it('enforces expiration and refuses replays until the id is forgotten', async () => {
    const { app, aliceId } = await withAlice();
    const now = blockTime(2n);
    expect((await app.checkTx(tx([transferOp(aliceId, FAUCET_ID, 1n)], [alice], now))).error).toMatch(/expired/);
    expect((await app.checkTx(tx([transferOp(aliceId, FAUCET_ID, 1n)], [alice], now + 3_600_001n))).error).toMatch(/too far/);
    const t = tx([transferOp(aliceId, FAUCET_ID, 1n)], [alice], now + 5_000n);
    const r = await block(app, [t, t]);
    expect(r.txResults.map((x) => x.ok)).toEqual([true, false]);
    expect(r.txResults[1]!.error).toMatch(/duplicate/);
    expect((await app.checkTx(t)).error).toMatch(/duplicate/);
    expect(app.db.nextInstance(RecentTxType)).toBe(3);
    // The id expires at +7s. Blocks 4 to 6 keep it; block 7 prunes it. The two ids from setup live for a minute.
    for (let h = 4n; h <= 6n; h++) await block(app, []);
    expect(app.db.range(RecentTxType, 'byExpiration', new Uint8Array(0)).length).toBe(3);
    await block(app, []);
    expect(app.db.range(RecentTxType, 'byExpiration', new Uint8Array(0)).length).toBe(2);
    expect((await app.checkTx(t)).error).toMatch(/expired/);
  });

  it('checks pending transactions in sequence and starts over after each block', async () => {
    const { app, aliceId } = await withAlice();
    const spend = (n: bigint) => tx([transferOp(aliceId, FAUCET_ID, 3000n)], [alice], genesisTime + 60_000n + n);
    const t1 = spend(1n);
    const t2 = spend(2n);
    expect((await app.checkTx(t1)).ok).toBe(true);
    expect((await app.checkTx(t2)).error).toMatch(/insufficient CORE/);
    expect(app.balance(aliceId)).toBe(5000n); // committed view ignores the pending session
    await block(app, []);
    expect((await app.checkTx(t2)).ok).toBe(true);
    const r = await block(app, [t1, t2]);
    expect(r.txResults.map((x) => x.ok)).toEqual([true, false]);
    expect(app.balance(aliceId)).toBe(5000n - 3000n - FEES.transfer);
  });

  it('creates and issues user assets up to the max supply', async () => {
    const { app, aliceId } = await withAlice();
    const create: OperationDraft = { type: 'assetCreate', issuer: aliceId, symbol: 'ALICE', precision: 2, maxSupply: 1000n };
    expect((await app.checkTx(tx([create], [alice]))).error).toMatch(/insufficient CORE/);
    await block(app, [tx([transferOp(FAUCET_ID, aliceId, 20_000n)])]);
    const r = await block(app, [tx([create], [alice])]);
    expect(r.txResults[0]!.ok).toBe(true);
    const asset = app.db.lookup(AssetType, 'bySymbol', key((k) => k.str('ALICE')))!;
    expect(asset.id).toBe(objectId(TYPE.asset, 1));
    const issue = (amount: bigint, to = FAUCET_ID, keys = [alice], issuer = aliceId): Uint8Array => tx([{ type: 'assetIssue', issuer, asset: asset.id, to, amount }], keys);
    expect((await app.checkTx(issue(1n, FAUCET_ID, [faucet], FAUCET_ID))).error).toMatch(/only the issuer/);
    const r2 = await block(app, [issue(600n), issue(500n), issue(400n, aliceId)]);
    expect(r2.txResults.map((x) => x.ok)).toEqual([true, false, true]);
    expect(r2.txResults[1]!.error).toMatch(/exceed the max supply/);
    expect(app.balance(FAUCET_ID, asset.id)).toBe(600n);
    expect(app.balance(aliceId, asset.id)).toBe(400n);
    expect(app.db.get(AssetType, asset.id)!.currentSupply).toBe(1000n);
    const holders = app.db.range(BalanceType, 'byAsset', key((k) => k.id(asset.id))).map((b) => [app.account(b.owner)!.name, b.amount]);
    expect(holders).toEqual([
      ['faucet', 600n],
      ['alice', 400n],
    ]);
  });

  it('proves objects against the app hash', async () => {
    const { app, aliceId } = await withAlice();
    const p = app.proof(aliceId);
    expect(verifyObjectProof(app.lastAppHash, p)).toBe(true);
    const decoded = decode(p.value!, (r) => AccountType.decode(r, p.id));
    expect(decoded.name).toBe('alice');
    expect(verifyObjectProof(app.lastAppHash, app.proof(objectId(TYPE.account, 50)))).toBe(true);
    await block(app, [tx([transferOp(aliceId, FAUCET_ID, 1n)], [alice])]);
    // Alice's account did not change, but the balance and dynamic types did, so the old path through the top tree is stale.
    expect(verifyObjectProof(app.lastAppHash, p)).toBe(false);
    expect(verifyObjectProof(app.lastAppHash, app.proof(aliceId))).toBe(true);
    const bal = app.db.lookup(BalanceType, 'byOwnerAsset', key((k) => k.id(aliceId).id(app.coreAsset)))!;
    expect(verifyObjectProof(app.lastAppHash, app.proof(bal.id))).toBe(true);
  });

  it('proves past heights inside the retention window', async () => {
    const { app, aliceId } = await withAlice();
    const hashes = [app.lastAppHash];
    for (let i = 0; i < 4; i++) {
      await block(app, [tx([transferOp(aliceId, FAUCET_ID, 10n)], [alice], genesisTime + 60_000n + BigInt(i))]);
      hashes.push(app.lastAppHash);
    }
    // Heights 2..6 are provable (window of 4); the balance object differs at each.
    expect(app.lowestProvableHeight).toBe(2n);
    const bal = app.db.lookup(BalanceType, 'byOwnerAsset', key((k) => k.id(aliceId).id(app.coreAsset)))!;
    for (let h = 2n; h <= 6n; h++) {
      const p = app.proofAt(bal.id, h);
      expect(verifyObjectProof(hashes[Number(h - 2n)]!, p)).toBe(true);
      expect(decode(p.value!, (r) => BalanceType.decode(r, p.id)).amount).toBe(5000n - (h - 2n) * (10n + FEES.transfer));
      expect(verifyObjectProof(hashes[Number(h - 2n)]!, app.proofAt(aliceId, h))).toBe(true);
      expect(verifyObjectProof(hashes[Number(h - 2n)]!, app.proofAt(objectId(TYPE.recentTx, 6), h))).toBe(true);
    }
    expect(() => app.proofAt(bal.id, 1n)).toThrow(/not available/);
    expect(verifyObjectProof(hashes[1]!, app.proofAt(bal.id, 4n))).toBe(false);
  });

  it('proves account names present and absent, now and at past heights', async () => {
    const { app, aliceId } = await withAlice();
    const idBytes = (id: bigint) => toHex(encode((w) => w.u64(id)));
    const present = app.proveAccountName('alice');
    expect(toHex(verifyKeyProof(app.lastAppHash, present)!)).toBe(idBytes(aliceId));
    expect(toHex(verifyKeyProof(app.lastAppHash, app.proveAccountName('faucet'))!)).toBe(idBytes(FAUCET_ID));
    expect(verifyKeyProof(app.lastAppHash, app.proveAccountName('bob'))).toBeNull();
    expect(verifyKeyProof(app.lastAppHash, app.proveAccountName('alice.sub'))).toBeNull();
    expect(verifyKeyProof(app.lastAppHash, app.proveAssetSymbol('NOPE'))).toBeNull();
    expect(toHex(verifyKeyProof(app.lastAppHash, app.proveAssetSymbol('CORE'))!)).toBe(idBytes(app.coreAsset));
    // Tampering: a different value or app hash fails. A different key can at most be proven absent, never present.
    const other = verifyKeyProof(app.lastAppHash, { ...present, key: new TextEncoder().encode('alicf\0') });
    expect(other === null || other === undefined).toBe(true);
    expect(verifyKeyProof(app.lastAppHash, { ...present, proof: { ...present.proof, leaf: { ...present.proof.leaf!, value: encode((w) => w.u64(FAUCET_ID)) } } })).toBeUndefined();
    expect(verifyKeyProof(sha256(app.lastAppHash), present)).toBeUndefined();
    // Before alice existed (height 0) the same name is proven absent against that height's hash.
    const h0 = app.proveAccountName('alice', 0n);
    expect(verifyKeyProof(app.lastAppHash, h0)).toBeUndefined();
    const fresh = makeApp();
    expect(verifyKeyProof(fresh.lastAppHash, h0)).toBeNull();
    // An object proof and a key proof at the same height agree on the index roots.
    expect(app.proofAt(aliceId, 2n).indexRoots.map(toHex)).toEqual(present.indexRoots.map(toHex));
    // Proof bytes round-trip.
    expect(toHex(keyProofToBytes(keyProofFromBytes(keyProofToBytes(present))))).toBe(toHex(keyProofToBytes(present)));
  });

  it('restarts from the store with the same app hash and keeps producing the same hashes', async () => {
    const store = new MemoryKv();
    const a = makeApp(store);
    const b = makeApp();
    const txs1 = [tx([createOp('alice', makeAuthority([alice.publicKey]))])];
    await block(a, txs1);
    await block(b, txs1);
    const aliceId = a.accountByName('alice')!.id;
    const txs2 = [tx([transferOp(FAUCET_ID, aliceId, 777n)])];
    await block(a, txs2);
    await block(b, txs2);
    expect(toHex(a.lastAppHash)).toBe(toHex(b.lastAppHash));

    const restarted = makeApp(store);
    expect(await restarted.info()).toEqual({ lastHeight: 2n, lastAppHash: a.lastAppHash });
    expect(restarted.balance(aliceId)).toBe(777n);
    // History came back from the store: heights 0..2 are provable against the hashes the first instance produced.
    expect(restarted.lowestProvableHeight).toBe(0n);
    expect(verifyObjectProof(a.lastAppHash, restarted.proofAt(aliceId, 2n))).toBe(true);
    // Name proofs at past heights come back from the history records and match the originals.
    for (const h of [0n, 1n, 2n]) {
      expect(toHex(keyProofToBytes(restarted.proveAccountName('alice', h)))).toBe(toHex(keyProofToBytes(a.proveAccountName('alice', h))));
      expect(toHex(keyProofToBytes(restarted.proveAccountName('bob', h)))).toBe(toHex(keyProofToBytes(a.proveAccountName('bob', h))));
    }
    expect(toHex(proofBytesAt(restarted, aliceId, 1n))).toBe(toHex(proofBytesAt(a, aliceId, 1n)));
    expect(toHex(proofBytesAt(restarted, objectId(TYPE.account, 1), 0n))).toBe(toHex(proofBytesAt(a, objectId(TYPE.account, 1), 0n)));
    expect(toHex(proofBytesAt(restarted, aliceId, 2n))).toBe(toHex(proofBytesAt(a, aliceId, 2n)));
    const txs3 = [tx([transferOp(aliceId, FAUCET_ID, 7n)], [alice])];
    const r1 = await block(restarted, txs3);
    const r2 = await block(b, txs3);
    expect(r1.txResults).toEqual([{ ok: true }]);
    expect(toHex(r1.appHash)).toBe(toHex(r2.appHash));
    expect((await makeApp(store).info()).lastHeight).toBe(3n);
    expect(store.size).toBeGreaterThan(5);
    // The window slides: after more blocks the oldest heights drop out of memory and out of the store.
    for (let i = 0; i < 4; i++) await block(restarted, []);
    expect(restarted.lowestProvableHeight).toBe(3n);
    expect(() => restarted.proofAt(aliceId, 2n)).toThrow(/not available/);
    const historyKeys = [...store.range(new Uint8Array([0x68]), prefixEnd(new Uint8Array([0x68])))].map(([k]) => Number(k[8]));
    expect(historyKeys).toEqual([4, 5, 6, 7]);
  });

  it('keeps the whole history window in the store while the one in memory is trimmed, so a restart has it back', async () => {
    const store = new MemoryKv();
    const a = makeApp(store);
    const whole = makeApp();
    for (let i = 0; i < 6; i++) {
      const txs = i === 0 ? [tx([createOp('alice', makeAuthority([alice.publicKey]))])] : [tx([transferOp(FAUCET_ID, a.accountByName('alice')!.id, BigInt(i))])];
      await block(a, txs);
      await block(whole, txs);
      if (i === 2) a.db.setHistoryWindow(1);
    }
    const aliceId = a.accountByName('alice')!.id;
    // The window in memory holds one past version; the heights before it are proven from the store's records.
    expect(a.db.memory()).toMatchObject({ history: 'trimmed', historyWindow: 1 });
    expect(a.lowestProvableHeight).toBe(2n);
    expect(whole.lowestProvableHeight).toBe(2n);
    for (let h = 2n; h <= 6n; h++) {
      expect(toHex(proofBytesAt(a, aliceId, h))).toBe(toHex(proofBytesAt(whole, aliceId, h)));
      expect(toHex(keyProofToBytes(a.proveAccountName('alice', h)))).toBe(toHex(keyProofToBytes(whole.proveAccountName('alice', h))));
    }
    expect(() => a.proofAt(aliceId, 1n)).toThrow(/not available/);
    const historyKeys = () => [...store.range(new Uint8Array([0x68]), prefixEnd(new Uint8Array([0x68])))].map(([k]) => Number(k[8]));
    expect(historyKeys()).toEqual([3, 4, 5, 6]);
    // A restart takes the sparse trees' past versions from the records, without replaying an account.
    const opened: Record<string, unknown>[] = [];
    const restarted = new CoreApp({ genesis, verifier: new InlineVerifier(), kv: store, retainVersions: 4, log: (_level, msg, fields) => void (msg === 'loaded application state' && opened.push(fields!)) });
    expect(opened[0]).toMatchObject({ indexVersions: 'records', provableFrom: 2 });
    expect(restarted.lowestProvableHeight).toBe(2n);
    for (let h = 2n; h <= 6n; h++) {
      expect(toHex(proofBytesAt(restarted, aliceId, h))).toBe(toHex(proofBytesAt(whole, aliceId, h)));
      expect(toHex(keyProofToBytes(restarted.proveAccountName('alice', h)))).toBe(toHex(keyProofToBytes(whole.proveAccountName('alice', h))));
    }
    // A store that has lost a record: the heights it stood between and the present are provable, the ones below it are
    // refused rather than answered from what is left, and their records go with the next commit.
    store.write((w) => w.del(Uint8Array.of(0x68, 0, 0, 0, 0, 0, 0, 0, 4)));
    const damaged = makeApp(store);
    expect(damaged.lowestProvableHeight).toBe(4n);
    for (let h = 4n; h <= 6n; h++) expect(toHex(proofBytesAt(damaged, aliceId, h))).toBe(toHex(proofBytesAt(whole, aliceId, h)));
    expect(() => damaged.proofAt(aliceId, 3n)).toThrow(/not available/);
    await block(damaged, []);
    expect(historyKeys()).toEqual([5, 6, 7]);
  });
});

describe('core application: index entries in the store', () => {
  const INDEX = Uint8Array.of(0x69);
  const stored = (kv: MemoryKv) => [...kv.range(INDEX, prefixEnd(INDEX))].map(([k, v]) => `${toHex(k)}=${toHex(v)}`);
  const live = (app: CoreApp) => [...app.db.indexEntries()].map(([k, v]) => `${toHex(k)}=${toHex(v)}`);
  const TREES = [Uint8Array.of(0x6e), Uint8Array.of(0x74)];
  const storedTrees = (kv: MemoryKv) => TREES.flatMap((p) => [...kv.range(p, prefixEnd(p))]).map(([k, v]) => `${toHex(k)}=${toHex(v)}`).sort();
  const liveTrees = (app: CoreApp) => [...app.db.treeEntries()].map(([k, v]) => `${toHex(k)}=${toHex(v)}`).sort();
  /**
   * The store holds exactly the entries the indices hold, and, where the trees are resident, agrees with them entry
   * by entry; and it holds the Merkle trees' chunks and nodes as the database has them.
   */
  const consistent = (app: CoreApp, kv: MemoryKv) => {
    expect(stored(kv)).toEqual(live(app));
    expect(app.db.checkIndexStore()).toEqual([]);
    expect(storedTrees(kv)).toEqual(liveTrees(app));
  };

  it('gives a store that kept recent transactions under two indices the one they have now, and still refuses a replay', async () => {
    const kv = new MemoryKv();
    const app = makeApp(kv);
    await block(app, [tx([createOp('alice', makeAuthority([alice.publicKey]))]), tx([createOp('bob', makeAuthority([bob.publicKey]))])]);
    const aliceId = app.accountByName('alice')!.id;
    const bobId = app.accountByName('bob')!.id;
    await block(app, [tx([transferOp(FAUCET_ID, aliceId, 5000n)]), tx([transferOp(FAUCET_ID, bobId, 5000n)], [faucet], genesisTime + 30_000n)]);
    const paid = tx([transferOp(aliceId, bobId, 10n)], [alice], genesisTime + 45_000n);
    await block(app, [paid]);
    const recent = app.db.range(RecentTxType, 'byExpiration', new Uint8Array(0));
    expect(recent.length).toBe(5);
    // In order of expiration, then of id; and a transaction is found by the pair.
    expect(recent.map((t) => t.expiration)).toEqual([30_000n, 45_000n, 60_000n, 60_000n, 60_000n].map((ms) => genesisTime + ms));
    expect(app.db.lookup(RecentTxType, 'byExpiration', key((k) => k.u64(genesisTime + 45_000n).fixed(recent[1]!.txId)))?.id).toBe(recent[1]!.id);

    // The same store as it was written before: the id alone at position 0, the expiration (and the object's id) at 1.
    const headers = [indexHeader(TYPE.recentTx, 0), indexHeader(TYPE.recentTx, 1)];
    const older = (from: MemoryKv) => {
      const old = new MemoryKv();
      old.write((w) => {
        for (const [k, v] of from.range(new Uint8Array([0]), new Uint8Array([0xff]))) if (toHex(k.subarray(0, 4)) !== toHex(headers[0]!)) w.put(k, v);
        for (const t of recent) {
          w.put(entryKey(headers[0]!, key((k) => k.fixed(t.txId))), encode((wr) => wr.u64(t.id)));
          w.put(entryKey(headers[1]!, key((k) => k.u64(t.expiration).u64(t.id))), new Uint8Array(0));
        }
      });
      return old;
    };
    const old = older(kv);
    expect(stored(old)).not.toEqual(stored(kv));
    const migrated = makeApp(old);
    expect(toHex(migrated.lastAppHash)).toBe(toHex(app.lastAppHash));
    expect(stored(old)).toEqual(stored(kv));
    consistent(migrated, old);
    // The transaction applied before the move is refused after it, and a new one is taken; then they all expire.
    const fresh = tx([transferOp(aliceId, bobId, 11n)], [alice]);
    const res = await block(migrated, [paid, fresh]);
    expect(res.txResults.map((r) => (r.ok ? 'ok' : r.error))).toEqual(['duplicate transaction', 'ok']);
    await migrated.finalizeBlock({ height: migrated.lastHeight + 1n, time: genesisTime + 120_000n, txs: [], proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });
    await migrated.commit();
    expect(migrated.db.range(RecentTxType, 'byExpiration', new Uint8Array(0))).toEqual([]);
    consistent(migrated, old);

    // A move cut short at any of its writes is made again from the start the next time the store is opened.
    for (let stop = 1; stop <= 3; stop++) {
      const cut = older(kv);
      let writes = 0;
      const failing = { get: (k: Uint8Array) => cut.get(k), range: (a: Uint8Array, b: Uint8Array) => cut.range(a, b), write: (fn: Parameters<MemoryKv['write']>[0]) => (++writes === stop ? (() => { throw new Error('stopped'); })() : cut.write(fn)) };
      expect(() => openObjectDatabase(failing, CORE_TYPES)).toThrow('stopped');
      expect(stored(cut)).not.toEqual(stored(kv));
      const again = makeApp(cut);
      expect(stored(cut)).toEqual(stored(kv));
      consistent(again, cut);
    }

    // More records than one write moves, cut short at every write in turn: 12,000 records are nine writes.
    const many = Array.from({ length: 12_000 }, (_, i) => ({ id: objectId(TYPE.recentTx, i), txId: sha256(encode((w) => w.u32(i))), expiration: genesisTime + BigInt(1000 * (i % 50)) }));
    const objectKey = (id: bigint) => key((k) => k.u8(0x6f).u64(id));
    const big = () => {
      const b = new MemoryKv();
      b.write((w) => {
        w.put(objectKey(objectId(TYPE.account, 7)), Uint8Array.of(1)); // other types' objects and entries are not touched
        w.put(objectKey(objectId(TYPE.recentTx + 1, 0)), Uint8Array.of(2));
        w.put(entryKey(indexHeader(TYPE.recentTx + 1, 0), Uint8Array.of(3)), Uint8Array.of(4));
        for (const t of many) {
          w.put(objectKey(t.id), encode((wr) => RecentTxType.encode(wr, t)));
          w.put(entryKey(headers[0]!, key((k) => k.fixed(t.txId))), encode((wr) => wr.u64(t.id)));
          w.put(entryKey(headers[1]!, key((k) => k.u64(t.expiration).u64(t.id))), new Uint8Array(0));
        }
      });
      return b;
    };
    const wanted = [
      ...many.map((t) => `${toHex(entryKey(headers[0]!, key((k) => k.u64(t.expiration).fixed(t.txId))))}=${toHex(encode((wr) => wr.u64(t.id)))}`).sort(),
      `${toHex(entryKey(indexHeader(TYPE.recentTx + 1, 0), Uint8Array.of(3)))}=04`,
    ];
    const objects = (b: MemoryKv) => [...b.range(Uint8Array.of(0x6f), Uint8Array.of(0x70))].map(([k, v]) => `${toHex(k)}=${toHex(v)}`);
    for (let stop = 1; stop <= 10; stop++) {
      const b = big();
      let writes = 0;
      const failing = { get: (k: Uint8Array) => b.get(k), range: (x: Uint8Array, y: Uint8Array) => b.range(x, y), write: (fn: Parameters<MemoryKv['write']>[0]) => (++writes === stop ? (() => { throw new Error('stopped'); })() : b.write(fn)) };
      if (stop <= 9) expect(() => migrateRecentTxIndex(failing)).toThrow('stopped');
      else migrateRecentTxIndex(failing);
      migrateRecentTxIndex(b);
      expect(stored(b)).toEqual(wanted);
      expect(objects(b)).toEqual(objects(big()));
      // And a store already moved is read once and not written.
      writes = 0;
      migrateRecentTxIndex(failing);
      expect(writes).toBe(0);
    }
  });

  it('writes the entries with every commit, reopens from them, and fills in a store that predates them', async () => {
    const kv = new MemoryKv();
    const app = makeApp(kv);
    consistent(app, kv);
    await block(app, [tx([createOp('alice', makeAuthority([alice.publicKey]))]), tx([createOp('bob', makeAuthority([bob.publicKey]))])]);
    const aliceId = app.accountByName('alice')!.id;
    const bobId = app.accountByName('bob')!.id;
    await block(app, [tx([transferOp(FAUCET_ID, aliceId, 5000n)]), tx([transferOp(FAUCET_ID, bobId, 5000n)])]);
    await block(app, [tx([transferOp(aliceId, bobId, 10n)], [alice])]);
    consistent(app, kv);
    // Recent transaction ids expire and their entries go with them.
    for (let i = 0; i < 3; i++) await block(app, []);
    const later = app.lastHeight + 1n;
    await app.finalizeBlock({ height: later, time: genesisTime + 120_000n, txs: [], proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });
    await app.commit();
    expect(app.db.range(RecentTxType, 'byExpiration', new Uint8Array(0))).toEqual([]);
    consistent(app, kv);

    // A restart builds the indices from the entries and comes back with the same hash and the same lookups.
    const reopened = makeApp(kv);
    expect(toHex(reopened.lastAppHash)).toBe(toHex(app.lastAppHash));
    expect(reopened.accountByName('bob')!.id).toBe(bobId);
    expect(reopened.balance(bobId)).toBe(app.balance(bobId));
    consistent(reopened, kv);

    // A store written before the entries were: they are derived from the objects once and written.
    const old = new MemoryKv();
    old.write((w) => {
      for (const [k, v] of kv.range(new Uint8Array([0]), new Uint8Array([0xff]))) if (k[0] !== 0x69) w.put(k, v);
    });
    expect(stored(old)).toEqual([]);
    const migrated = makeApp(old);
    expect(toHex(migrated.lastAppHash)).toBe(toHex(app.lastAppHash));
    expect(stored(old)).toEqual(stored(kv));
    consistent(migrated, old);
  });

  it('runs blocks with the trees dropped and rebuilt on the way, with the hashes of an app that never drops them', async () => {
    const kv = new MemoryKv();
    const paged = makeApp(kv);
    const resident = makeApp();
    const both = async (txs: Uint8Array[]) => {
      const [a, b] = [await block(paged, txs), await block(resident, txs)];
      expect(toHex(a.appHash)).toBe(toHex(b.appHash));
      expect(a.txResults).toEqual(b.txResults);
    };
    paged.db.dropIndexTrees();
    expect(paged.db.memory().indexTrees).toBe('dropped');
    await both([tx([createOp('alice', makeAuthority([alice.publicKey]))])]);
    const aliceId = paged.accountByName('alice')!.id;
    await both([tx([transferOp(FAUCET_ID, aliceId, 5000n)]), tx([createOp('alice', makeAuthority([bob.publicKey]))])]);
    expect(paged.balance(aliceId)).toBe(5000n);
    // Checked against the pending session, as the mempool does, while dropped: a name taken in the store is refused.
    expect((await paged.checkTx(tx([createOp('alice', makeAuthority([carol.publicKey]))]))).error).toMatch(/taken/);
    paged.db.rebuildIndexTrees();
    await both([tx([transferOp(aliceId, FAUCET_ID, 7n)], [alice])]);
    consistent(paged, kv);
    paged.db.dropIndexTrees();
    await both([tx([createOp('carol', makeAuthority([carol.publicKey]))])]);
    expect(stored(kv)).toEqual(live(resident));
  });

  it('writes the entries of a state imported from a snapshot', async () => {
    const { app } = await withAlice();
    const { manifest, chunks } = exportSnapshot(app.db, CORE_TYPES, Number(app.lastHeight), 3);
    const imported = importSnapshot(manifest, chunks.flat().map(chunkFromBytes), CORE_TYPES, { retainVersions: 4 });
    const kv = new MemoryKv();
    CoreApp.writeImportedState(kv, imported, app.lastHeight, app.lastAppHash);
    expect(stored(kv)).toEqual(live(app));
    expect(storedTrees(kv)).toEqual(liveTrees(app));
    const synced = makeApp(kv);
    expect(toHex(synced.lastAppHash)).toBe(toHex(app.lastAppHash));
    consistent(synced, kv);
  });
  it('writes the trees with every commit and restarts from them, with the proofs of the original', async () => {
    const kv = new MemoryKv();
    const app = makeApp(kv);
    const twin = makeApp();
    const both = async (txs: Uint8Array[]) => {
      const [a, b] = [await block(app, txs), await block(twin, txs)];
      expect(toHex(a.appHash)).toBe(toHex(b.appHash));
    };
    consistent(app, kv);
    await both([tx([createOp('alice', makeAuthority([alice.publicKey]))]), tx([createOp('bob', makeAuthority([bob.publicKey]))])]);
    const aliceId = app.accountByName('alice')!.id;
    const bobId = app.accountByName('bob')!.id;
    await both([tx([transferOp(FAUCET_ID, aliceId, 5000n)]), tx([transferOp(FAUCET_ID, bobId, 5000n)])]);
    await both([tx([transferOp(aliceId, bobId, 10n)], [alice]), tx([createOp('carol', makeAuthority([carol.publicKey]))])]);
    consistent(app, kv);
    const proofsOf = (a: CoreApp) => {
      const out: string[] = [];
      for (let h = a.lowestProvableHeight; h <= a.lastHeight; h++) {
        for (const id of [FAUCET_ID, aliceId, bobId, objectId(TYPE.account, 9), objectId(TYPE.balance, 2)]) out.push(toHex(proofBytesAt(a, id, h)));
        for (const name of ['alice', 'carol', 'nobody']) out.push(toHex(keyProofToBytes(a.proveAccountName(name, h))));
      }
      return out;
    };
    // From the chunks and nodes: the same hash and every proof in the window as the instance that wrote them.
    const reopened = makeApp(kv);
    expect(toHex(reopened.lastAppHash)).toBe(toHex(app.lastAppHash));
    expect(proofsOf(reopened)).toEqual(proofsOf(app));
    consistent(reopened, kv);
    // Recomputing from the objects instead comes to the same, and so does taking the trees and hashing every leaf.
    for (const opts of [{ fromTrees: false }, { checkLeaves: true }, { trees: false }]) {
      const opened = openObjectDatabase(kv, CORE_TYPES, { retainVersions: 4, ...opts })!;
      expect(toHex(opened.appHash)).toBe(toHex(app.lastAppHash));
      for (let h = opened.db.lowestVersion; h <= opened.db.currentVersion; h++) expect(toHex(proofToBytes(opened.db.proofAt(aliceId, h)))).toBe(toHex(proofBytesAt(app, aliceId, BigInt(h))));
    }
    // A leaf that does not match its object is caught when the leaves are checked.
    const tampered = new MemoryKv();
    tampered.write((w) => {
      for (const [k, v] of kv.range(new Uint8Array([0]), new Uint8Array([0xff]))) w.put(k, v);
      w.put(key((k) => k.u8(0x6f).u64(aliceId)), kv.get(key((k) => k.u8(0x6f).u64(bobId)))!);
    });
    expect(() => openObjectDatabase(tampered, CORE_TYPES, { retainVersions: 4, checkLeaves: true })).toThrow(/does not hash to its leaf/);
    // Recomputed from the objects, the root gives it away (alice's bytes are bob's, so the name check would too).
    expect(() => openObjectDatabase(tampered, CORE_TYPES, { retainVersions: 4, fromTrees: false, checkIndexEntries: false })).toThrow(/do not hash to the stored app hash/);
    // The reopened app keeps producing the hashes of one that never stopped.
    const txs = [tx([transferOp(bobId, aliceId, 3n)], [bob])];
    const [r1, r2] = [await block(reopened, txs), await block(twin, txs)];
    expect(toHex(r1.appHash)).toBe(toHex(r2.appHash));
    consistent(reopened, kv);

    // A store written before the trees were has none: opening it computes them and writes them once.
    const old = new MemoryKv();
    old.write((w) => {
      for (const [k, v] of kv.range(new Uint8Array([0]), new Uint8Array([0xff]))) if (k[0] !== 0x74 && k[0] !== 0x6e) w.put(k, v);
    });
    expect(storedTrees(old)).toEqual([]);
    const migrated = makeApp(old);
    expect(toHex(migrated.lastAppHash)).toBe(toHex(reopened.lastAppHash));
    expect(storedTrees(old)).toEqual(storedTrees(kv));
    consistent(migrated, old);
  });

  it('runs blocks with the Merkle trees dropped and rebuilt, with the hashes and proofs of an app that keeps them', async () => {
    const kv = new MemoryKv();
    const paged = makeApp(kv);
    const resident = makeApp();
    const both = async (txs: Uint8Array[]) => {
      const [a, b] = [await block(paged, txs), await block(resident, txs)];
      expect(toHex(a.appHash)).toBe(toHex(b.appHash));
      expect(a.txResults).toEqual(b.txResults);
      for (let h = resident.lowestProvableHeight; h <= resident.lastHeight; h++) {
        expect(toHex(proofBytesAt(paged, FAUCET_ID, h))).toBe(toHex(proofBytesAt(resident, FAUCET_ID, h)));
        for (const name of ['alice', 'bob']) expect(toHex(keyProofToBytes(paged.proveAccountName(name, h)))).toBe(toHex(keyProofToBytes(resident.proveAccountName(name, h))));
      }
    };
    paged.db.dropTrees();
    paged.db.dropIndexTrees();
    expect(paged.db.memory()).toMatchObject({ trees: 'dropped', indexTrees: 'dropped' });
    await both([tx([createOp('alice', makeAuthority([alice.publicKey]))])]);
    const aliceId = paged.accountByName('alice')!.id;
    // Checked against the pending session while everything is dropped, as admission would be.
    expect((await paged.checkTx(tx([createOp('alice', makeAuthority([carol.publicKey]))]))).error).toMatch(/taken/);
    expect((await paged.checkTx(tx([transferOp(FAUCET_ID, aliceId, 1n)]))).ok).toBe(true);
    await both([tx([transferOp(FAUCET_ID, aliceId, 5000n)]), tx([createOp('bob', makeAuthority([bob.publicKey]))])]);
    paged.db.rebuildTrees();
    await both([tx([transferOp(aliceId, FAUCET_ID, 7n)], [alice])]);
    consistent(paged, kv);
    // Dropped in the middle of a block's pending writes: the mempool's session is open between blocks.
    expect((await paged.checkTx(tx([createOp('dave', makeAuthority([dave.publicKey]))]))).ok).toBe(true);
    paged.db.dropTrees();
    await both([tx([createOp('carol', makeAuthority([carol.publicKey]))])]);
    expect(storedTrees(kv)).toEqual(liveTrees(resident));
    paged.db.rebuildTrees();
    paged.db.rebuildIndexTrees();
    consistent(paged, kv);
  });
});

describe('core application: a store opened without room for it', () => {
  async function run(reopen: (kv: MemoryKv) => CoreApp) {
    const kv = new MemoryKv();
    const first = makeApp(kv);
    const resident = makeApp();
    const txs1 = [tx([createOp('alice', makeAuthority([alice.publicKey]))]), tx([createOp('bob', makeAuthority([bob.publicKey]))])];
    await block(first, txs1);
    await block(resident, txs1);
    const aliceId = first.accountByName('alice')!.id;
    const txs2 = [tx([transferOp(FAUCET_ID, aliceId, 5000n)])];
    await block(first, txs2);
    await block(resident, txs2);
    const paged = reopen(kv);
    expect(toHex(paged.lastAppHash)).toBe(toHex(resident.lastAppHash));
    const both = async (txs: Uint8Array[]) => {
      const [a, b] = [await block(paged, txs), await block(resident, txs)];
      expect(toHex(a.appHash)).toBe(toHex(b.appHash));
      expect(a.txResults).toEqual(b.txResults);
      for (let h = paged.lowestProvableHeight; h <= paged.lastHeight; h++) {
        expect(toHex(proofBytesAt(paged, aliceId, h))).toBe(toHex(proofBytesAt(resident, aliceId, h)));
        for (const name of ['alice', 'carol']) expect(toHex(keyProofToBytes(paged.proveAccountName(name, h)))).toBe(toHex(keyProofToBytes(resident.proveAccountName(name, h))));
      }
    };
    return { kv, paged, resident, aliceId, both };
  }

  it('opens with the trees left in the store and no history window when the heap has no room, and runs on', async () => {
    const { kv, paged, resident, aliceId, both } = await run((kv) => new CoreApp({ genesis, verifier: new InlineVerifier(), kv, retainVersions: 4, heapRoom: 0 }));
    // What the test setup dropped stays dropped; what it left to the default was decided by the room, which is none.
    expect(paged.db.memory()).toMatchObject({ trees: 'dropped', indexTrees: 'dropped' });
    // No window was read back, so the one in memory starts at the height it opened at; the heights before it are
    // proven from the records left in the store, as they are from the window of the node that read them.
    expect(paged.db.memory()).toMatchObject({ history: 'resident', historyWindow: 4 });
    expect(paged.lowestProvableHeight).toBe(0n);
    expect(resident.lowestProvableHeight).toBe(0n);
    for (let h = 0n; h <= 2n; h++) {
      expect(toHex(proofBytesAt(paged, aliceId, h))).toBe(toHex(proofBytesAt(resident, aliceId, h)));
      expect(toHex(keyProofToBytes(paged.proveAccountName('alice', h)))).toBe(toHex(keyProofToBytes(resident.proveAccountName('alice', h))));
    }
    await both([tx([transferOp(aliceId, FAUCET_ID, 7n)], [alice])]);
    await both([tx([createOp('carol', makeAuthority([carol.publicKey]))])]);
    expect(paged.lowestProvableHeight).toBe(0n);
    expect(paged.balance(aliceId)).toBe(resident.balance(aliceId));
    // The records it did not read are still the store's, and age out of it as they would have.
    const historyKeys = () => [...kv.range(new Uint8Array([0x68]), prefixEnd(new Uint8Array([0x68])))].map(([k]) => Number(k[8]));
    expect(historyKeys()).toEqual([1, 2, 3, 4]);
    await both([]);
    expect(historyKeys()).toEqual([2, 3, 4, 5]);
    // With room, the same store opens whole again, window and all.
    const whole = new CoreApp({ genesis, verifier: new InlineVerifier(), kv, retainVersions: 4, heapRoom: 2 ** 30 });
    expect(whole.lowestProvableHeight).toBe(1n);
    for (let h = 1n; h <= 5n; h++) expect(toHex(proofBytesAt(whole, aliceId, h))).toBe(toHex(proofBytesAt(resident, aliceId, h)));
    // A tier asked for by name is opened as asked, whatever the room.
    const asked = openObjectDatabase(kv, CORE_TYPES, { retainVersions: 4, heapRoom: 0, indexTrees: true, trees: true })!;
    expect(asked.paged).toEqual([]);
    expect(asked.db.memory()).toMatchObject({ trees: 'resident', indexTrees: 'resident' });
  });

  it('leaves the objects in the store when the arena has no room for them, and reads them from there', async () => {
    const { paged, resident, aliceId, both } = await run((kv) => new CoreApp({ genesis, verifier: new InlineVerifier(), kv, retainVersions: 4, arenaBytes: 0 }));
    const stored = paged.db.memory().storedObjects;
    expect(stored).toBeGreaterThan(5);
    expect(paged.db.memory().arena.used).toBe(0);
    expect(paged.lowestProvableHeight).toBe(0n);
    expect(paged.accountByName('bob')?.name).toBe('bob');
    await both([tx([transferOp(aliceId, FAUCET_ID, 7n)], [alice])]);
    await both([tx([createOp('carol', makeAuthority([carol.publicKey]))])]);
    // What the blocks wrote is in the arena again; the rest is still only in the store.
    expect(paged.db.memory().arena.used).toBeGreaterThan(0);
    expect(paged.db.memory().storedObjects).toBeLessThan(stored);
    expect(paged.db.memory().storedObjects).toBeGreaterThan(0);
    expect(paged.balance(aliceId)).toBe(resident.balance(aliceId));
    expect([...paged.db.exportObjects()].map(([id, b]) => `${id}=${toHex(b)}`)).toEqual([...resident.db.exportObjects()].map(([id, b]) => `${id}=${toHex(b)}`));
  });
});

describe('core application: a damaged store is refused at restart', () => {
  /** A copy of a store with one change made to it. */
  const damaged = (kv: MemoryKv, change: (w: { put(k: Uint8Array, v: Uint8Array): void; del(k: Uint8Array): void }) => void) => {
    const copy = new MemoryKv();
    copy.write((w) => {
      for (const [k, v] of kv.range(new Uint8Array([0]), new Uint8Array([0xff]))) w.put(k, v);
    });
    copy.write(change);
    return copy;
  };
  const MODES = [{}, { trees: false }, { indexTrees: false }, { trees: false, indexTrees: false }];
  const objectKey = (id: bigint) => key((k) => k.u8(0x6f).u64(id));

  async function store() {
    const kv = new MemoryKv();
    const app = makeApp(kv);
    await block(app, [tx([createOp('alice', makeAuthority([alice.publicKey]))]), tx([createOp('bob', makeAuthority([bob.publicKey]))])]);
    const aliceId = app.accountByName('alice')!.id;
    const bobId = app.accountByName('bob')!.id;
    await block(app, [tx([transferOp(FAUCET_ID, aliceId, 5000n)]), tx([transferOp(FAUCET_ID, bobId, 5000n)])]);
    for (const opts of MODES) expect(toHex(openObjectDatabase(kv, CORE_TYPES, { retainVersions: 4, ...opts })!.appHash)).toBe(toHex(app.lastAppHash));
    return { kv, app, aliceId, bobId };
  }
  const refused = (kv: MemoryKv, pattern: RegExp, modes: object[] = MODES) => {
    for (const opts of modes) expect(() => openObjectDatabase(kv, CORE_TYPES, { retainVersions: 4, ...opts }), JSON.stringify(opts)).toThrow(pattern);
  };

  it('refuses an object missing while its leaf is still there', async () => {
    const { kv, app } = await store();
    const faucetBalance = app.db.lookup(BalanceType, 'byOwnerAsset', key((k) => k.id(FAUCET_ID).id(app.coreAsset)))!.id;
    // Its index entries go with it, so only the tree still says it exists.
    const gone = damaged(kv, (w) => {
      w.del(objectKey(faucetBalance));
      w.del(entryKey(indexHeader(TYPE.balance, 0), key((k) => k.id(FAUCET_ID).id(app.coreAsset))));
      w.del(entryKey(indexHeader(TYPE.balance, 1), key((k) => k.id(app.coreAsset).id(faucetBalance))));
    });
    refused(gone, /leaves for/);
  });

  it('refuses index entries that are missing, extra or name another object', async () => {
    const { kv, app, aliceId, bobId } = await store();
    const byOwnerAsset = entryKey(indexHeader(TYPE.balance, 0), key((k) => k.id(FAUCET_ID).id(app.coreAsset)));
    const allModes = [...MODES, { fromTrees: false }];
    refused(damaged(kv, (w) => w.del(byOwnerAsset)), /missing/, allModes);
    refused(damaged(kv, (w) => w.put(entryKey(indexHeader(TYPE.account, 0), key((k) => k.str('alice'))), encode((w) => w.u64(bobId)))), /object \d+'s/, allModes);
    refused(damaged(kv, (w) => w.put(entryKey(indexHeader(TYPE.balance, 1), key((k) => k.id(app.coreAsset).id(objectId(TYPE.balance, 99)))), new Uint8Array(0))), /entries for/, allModes);
    refused(damaged(kv, (w) => w.put(byOwnerAsset, encode((w) => w.u64(aliceId).u8(0)))), /malformed/, allModes);
  });

  it('refuses a dense tree node that is not the hash of its children, and a sparse node that does not hash to its parent', async () => {
    const { kv } = await store();
    // Three balances: a tree of height two, whose inner level holds the node over the faucet's and alice's.
    const inner = chunkKey(TYPE.balance, 1, 0);
    const flipped = kv.get(inner)!.slice();
    flipped[0]! ^= 1;
    refused(damaged(kv, (w) => w.put(inner, flipped)), /not the hash of its children/);
    // A leaf of the name tree with its value changed, and an inner node with a child hash changed.
    const nodes = [...kv.range(nodeHeader(TYPE.account, 0), nodeHeader(TYPE.account, 1))];
    const [leafKey, leaf] = nodes.find(([, v]) => v[0] === 1)!;
    const leafChanged = leaf.slice();
    leafChanged[leafChanged.length - 1]! ^= 1;
    refused(damaged(kv, (w) => w.put(leafKey, leafChanged)), /does not hash to what its parent says/);
    const [innerKey, innerNode] = nodes.find(([k, v]) => v[0] === 0 && k[k.length - 1]! > 0)!;
    const innerChanged = innerNode.slice();
    innerChanged[1]! ^= 1;
    refused(damaged(kv, (w) => w.put(innerKey, innerChanged)), /does not hash to what its parent says|missing from the store/);
  });
});
