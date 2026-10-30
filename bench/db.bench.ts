/**
 * The object database on its own: creating and changing objects, the Merkle
 * root per version, lookups through the B+ tree indices, proofs, undo, and
 * the sparse Merkle tree behind authenticated unique indices. At the end, the
 * same lookups and scans with the index trees dropped (STATE-PAGING.md
 * section 4.2): from an in-memory store, and from LMDB as a node reads them;
 * and roots and proofs with the Merkle trees dropped (section 5.2), their
 * chunks and nodes read from LMDB.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAuthority } from '../src/app/core/authority.ts';
import { AccountType, BalanceType, CORE_TYPES, TYPE } from '../src/app/core/types.ts';
import { ObjectDatabase } from '../src/db/database.ts';
import { objectId } from '../src/db/id.ts';
import { key } from '../src/db/keys.ts';
import { keyProofToBytes, proofToBytes, verifyKeyProof, verifyObjectProof } from '../src/db/proof.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
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

  // Accounts: a key of the chain's scheme in each authority (1313 or 34 bytes with its tag), and a name in an authenticated unique index (a sparse Merkle tree).
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

  // The index tier's fallback: the same reads with the B+ trees dropped. Without an application store the database
  // keeps the entries in an in-memory map while dropped; a node reads them from LMDB.
  const lookups = (d: ObjectDatabase) => () => {
    for (let i = 0; i < 1000; i++) d.lookup(BalanceType, 'byOwnerAsset', key((k) => k.id(objectId(TYPE.account, rnd(N))).id(CORE)));
  };
  const scan100 = (d: ObjectDatabase) => () => {
    let n = 0;
    for (const _ of d.scan(BalanceType, 'byAsset', key((k) => k.id(CORE)))) if (++n >= 100) break;
  };
  await bench('drop the index trees', { iterations: 1, warmup: 0 }, () => db.dropIndexTrees());
  await bench('lookup by unique index, trees dropped (in-memory store)', { batch: 1000 }, lookups(db));
  await bench('scan 100 entries of a non-unique index, trees dropped (in-memory store)', { batch: 100 }, scan100(db));
  await bench('modify 1,000 balances + root, trees dropped (in-memory store)', {}, () => {
    for (let i = 0; i < 1000; i++) db.modify(BalanceType, objectId(TYPE.balance, rnd(N)), (b) => ({ ...b, amount: b.amount + 1n }));
    root = db.root();
  });
  await bench('rebuild the index trees (in-memory store)', { iterations: 1, warmup: 0 }, () => db.rebuildIndexTrees());
  // The Merkle trees dropped with no store behind: the database keeps their chunks and nodes in an in-memory map.
  await bench('drop the Merkle trees (into an in-memory store)', { iterations: 1, warmup: 0 }, () => db.dropTrees());
  for (const k of [1000, 10_000]) {
    await bench(`modify ${k.toLocaleString('en-US')} balances + root, Merkle trees dropped (in-memory store)`, {}, () => {
      for (let i = 0; i < k; i++) db.modify(BalanceType, objectId(TYPE.balance, rnd(N)), (b) => ({ ...b, amount: b.amount + 1n }));
      root = db.root();
    });
  }
  await bench('rebuild the Merkle trees (in-memory store)', { iterations: 1, warmup: 0 }, () => db.rebuildTrees());

  // The same state over LMDB, as a restarted node holds it: objects imported as bytes, index entries in the store.
  const dir = mkdtempSync(join(tmpdir(), 'crosschain-dbbench-'));
  const env = new LmdbEnv(dir);
  const kv = env.store('app');
  kv.write((w) => {
    for (const [k, v] of db.indexEntries()) w.put(k, v);
    for (const [k, v] of db.treeEntries()) w.put(k, v);
  });
  const paged = new ObjectDatabase(CORE_TYPES, { retainVersions: 100, indexStore: kv, indexTrees: false });
  for (const [id, bytes] of db.exportObjects()) paged.importObject(id, bytes, true);
  for (const [t, n] of db.counters()) paged.setCounter(t, n);
  paged.loadTrees();
  paged.loadIndexEntries();
  paged.root(db.currentVersion);
  paged.dropChanges();
  await bench('lookup by unique index, trees dropped (LMDB)', { batch: 1000 }, lookups(paged));
  await bench('scan 100 entries of a non-unique index, trees dropped (LMDB)', { batch: 100 }, scan100(paged));
  await bench('rebuild the index trees (from LMDB)', { iterations: 1, warmup: 0 }, () => paged.rebuildIndexTrees());
  await bench('lookup by unique index, trees rebuilt from LMDB', { batch: 1000 }, lookups(paged));

  // Roots over LMDB as a node takes them: every root's changes written before the next, as the application's commit
  // does (untimed here; the app suite's commit row measures it). Resident, the trees only report what they changed;
  // dropped, each root reads the paths it changes from LMDB, the dense chunks through the shared LRU.
  const persist = () => {
    const changes = paged.lastChanges;
    if (!changes) return;
    kv.write((w) => {
      for (const c of [...changes.indices, ...changes.trees]) {
        if (c.value) w.put(c.key, c.value);
        else w.del(c.key);
      }
    });
    paged.dropChanges();
  };
  const modifyRoot = (k: number) => () => {
    for (let i = 0; i < k; i++) paged.modify(BalanceType, objectId(TYPE.balance, rnd(N)), (b) => ({ ...b, amount: b.amount + 1n }));
    paged.root();
  };
  let written = 0;
  const countWritten = () => {
    written += paged.lastChanges?.trees.reduce((n, c) => n + c.key.length + (c.value?.length ?? 0), 0) ?? 0;
    persist();
  };
  for (const k of [1000, 10_000]) {
    persist();
    written = 0;
    const r = await bench(`modify ${k.toLocaleString('en-US')} balances + root, Merkle trees resident (LMDB)`, { before: countWritten }, modifyRoot(k));
    // Each iteration's setup writes the root before it: the warmup's and all but the last measured one.
    fact(`tree chunks a root of ${k.toLocaleString('en-US')} modifications writes`, fmtBytes(written / r.iterations));
  }
  persist();
  await bench('drop the Merkle trees (LMDB)', { iterations: 1, warmup: 0 }, () => paged.dropTrees());
  for (const k of [1000, 10_000]) await bench(`modify ${k.toLocaleString('en-US')} balances + root, Merkle trees dropped (LMDB)`, { before: persist }, modifyRoot(k));
  persist();
  fact('dense chunks cached while dropped', `${paged.memory().treeChunks} of ${paged.memory().treeChunkLimit}`);
  await bench('object proof (current version), Merkle trees dropped (LMDB)', { batch: 100 }, () => {
    for (let i = 0; i < 100; i++) paged.proof(objectId(TYPE.balance, rnd(N)));
  });
  await bench('object proof at a past version, Merkle trees dropped (LMDB)', { batch: 100 }, () => {
    for (let i = 0; i < 100; i++) paged.proofAt(objectId(TYPE.balance, rnd(N)), paged.currentVersion - 1 - rnd(3));
  });
  await bench('name proof, Merkle trees dropped (LMDB)', { batch: 100 }, () => {
    for (let i = 0; i < 100; i++) paged.proveKey(AccountType, 'byName', key((k) => k.str(`acct${rnd(A)}`)));
  });
  await bench('rebuild the Merkle trees (from LMDB)', { iterations: 1, warmup: 0 }, () => paged.rebuildTrees());
  await env.close();
  rmSync(dir, { recursive: true, force: true });
}
