/**
 * The object database on its own: creating and changing objects, the Merkle
 * root per version, lookups through the B+ tree indices, proofs, undo, and
 * the sparse Merkle tree behind authenticated unique indices.
 */
import { makeAuthority } from '../src/app/core/authority.ts';
import { AccountType, BalanceType, CORE_TYPES, TYPE } from '../src/app/core/types.ts';
import { ObjectDatabase } from '../src/db/database.ts';
import { objectId } from '../src/db/id.ts';
import { key } from '../src/db/keys.ts';
import { keyProofToBytes, proofToBytes, verifyKeyProof, verifyObjectProof } from '../src/db/proof.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { bench, fact, fmtBytes, heapMiB, suite } from './harness.ts';
import { seed } from './fixtures.ts';

const CORE = objectId(TYPE.asset, 0);

export async function run(): Promise<void> {
  suite('db');
  const db = new ObjectDatabase(CORE_TYPES, { retainVersions: 100 });
  const N = 100_000;
  const heap0 = heapMiB();
  await bench(`create ${N.toLocaleString('en-US')} balance objects`, { batch: N, iterations: 1, warmup: 0 }, () => {
    for (let i = 0; i < N; i++) db.create(BalanceType, (id) => ({ id, owner: objectId(TYPE.account, i), asset: CORE, amount: BigInt(i) }));
  });
  await bench(`first root over ${N.toLocaleString('en-US')} objects`, { iterations: 1, warmup: 0 }, () => db.root(0));
  fact('heap for 100k balances with trees', `${(heapMiB() - heap0).toFixed(0)} MiB`);
  let root = db.rootAt(db.currentVersion);
  const rnd = (n: number) => Math.floor(Math.random() * n);
  for (const k of [100, 1000, 10_000]) {
    await bench(`modify ${k.toLocaleString('en-US')} balances + root (one block's state change)`, {}, () => {
      for (let i = 0; i < k; i++) {
        const id = objectId(TYPE.balance, rnd(N));
        db.modify(BalanceType, id, (b) => ({ ...b, amount: b.amount + 1n }));
      }
      root = db.root();
    });
  }
  await bench('get by id', { batch: 1000 }, () => {
    for (let i = 0; i < 1000; i++) db.get(BalanceType, objectId(TYPE.balance, rnd(N)));
  });
  await bench('lookup by unique index (byOwnerAsset)', { batch: 1000 }, () => {
    for (let i = 0; i < 1000; i++) db.lookup(BalanceType, 'byOwnerAsset', key((k) => k.id(objectId(TYPE.account, rnd(N))).id(CORE)));
  });
  await bench('scan 100 entries of a non-unique index (byAsset)', { batch: 100 }, () => {
    let n = 0;
    for (const _ of db.scan(BalanceType, 'byAsset', key((k) => k.id(CORE)))) if (++n >= 100) break;
  });
  const proof = db.proof(objectId(TYPE.balance, 7));
  fact('object proof', `${fmtBytes(proofToBytes(proof).length)}, ${proof.typeSiblings.length + proof.topSiblings.length} sibling hashes`);
  await bench('object proof (current version)', { batch: 100 }, () => {
    for (let i = 0; i < 100; i++) db.proof(objectId(TYPE.balance, rnd(N)));
  });
  await bench('object proof at a past version', { batch: 100 }, () => {
    for (let i = 0; i < 100; i++) db.proofAt(objectId(TYPE.balance, rnd(N)), db.currentVersion - 1 - rnd(3));
  });
  await bench('verifyObjectProof', { batch: 100 }, () => {
    for (let i = 0; i < 100; i++) verifyObjectProof(root, proof);
  });
  await bench('session: modify 1,000 then undo', {}, () => {
    const s = db.startSession();
    for (let i = 0; i < 1000; i++) db.modify(BalanceType, objectId(TYPE.balance, rnd(N)), (b) => ({ ...b, amount: b.amount + 1n }));
    db.undoSession(s);
  });

  // Accounts: a 1312-byte key in each authority, and a name in an authenticated unique index (a sparse Merkle tree).
  const auth = makeAuthority([keyPairFromSeed(seed('db')).publicKey]);
  const A = 20_000;
  await bench(`create ${A.toLocaleString('en-US')} accounts (name index is an SMT) + root`, { iterations: 1, warmup: 0 }, () => {
    for (let i = 0; i < A; i++) db.create(AccountType, (id) => ({ id, name: `acct${i}`, owner: auth, active: auth, registrar: id }));
    root = db.root();
  });
  let next = A;
  await bench('create 1,000 accounts + root (1,000 SMT inserts)', {}, () => {
    for (let i = 0; i < 1000; i++) db.create(AccountType, (id) => ({ id, name: `acct${next++}`, owner: auth, active: auth, registrar: id }));
    root = db.root();
  });
  const kp = db.proveKey(AccountType, 'byName', key((k) => k.str('acct7')));
  fact('name proof (SMT + type leg)', `${fmtBytes(keyProofToBytes(kp).length)}`);
  await bench('name proof', { batch: 100 }, () => {
    for (let i = 0; i < 100; i++) db.proveKey(AccountType, 'byName', key((k) => k.str(`acct${rnd(A)}`)));
  });
  await bench('verifyKeyProof', { batch: 100 }, () => {
    for (let i = 0; i < 100; i++) verifyKeyProof(root, kp);
  });
  fact(`heap after ${db.currentVersion + 1} versions created (the last 100 retained)`, `${heapMiB().toFixed(0)} MiB`);
}
