import { describe, expect, it } from 'vitest';
import { sha256, toHex } from '../src/crypto/hash.ts';
import { ObjectDatabase, type UndoSession } from '../src/db/database.ts';
import { MemoryKv } from '../src/store/kv.ts';
import { instanceOf, objectId } from '../src/db/id.ts';
import { DbError, type ObjectType } from '../src/db/index.ts';
import { key } from '../src/db/keys.ts';
import { BPlusTree } from '../src/db/bptree.ts';
import { ChunkCache, DenseMerkleTree, EMPTY, heightFor, innerHash, rootFromPath, type StoreChange } from '../src/db/merkle.ts';
import { encodeKeyProof, keyProofToBytes, proofFromBytes, proofToBytes, verifyKeyProof, verifyObjectProof } from '../src/db/proof.ts';
import { encode } from '../src/codec/writer.ts';
import { nodeHeader, SparseMerkleTree, smtProofRoot, type SmtProof } from '../src/db/smt.ts';

interface Item {
  id: bigint;
  name: string;
  group: number;
  value: bigint;
}

const ItemType: ObjectType<Item> = {
  id: 7,
  name: 'item',
  encode(w, o) {
    w.string(o.name).u32(o.group).u64(o.value);
  },
  decode(r, id) {
    return { id, name: r.string(), group: r.u32(), value: r.u64() };
  },
  indices: [
    { name: 'byName', unique: true, authenticated: true, key: (o, k) => k.str(o.name) },
    { name: 'byGroup', unique: false, key: (o, k) => k.u32(o.group) },
  ],
};

interface Counter {
  id: bigint;
  n: bigint;
}

const CounterType: ObjectType<Counter> = {
  id: 3,
  name: 'counter',
  encode(w, o) {
    w.u64(o.n);
  },
  decode(r, id) {
    return { id, n: r.u64() };
  },
  indices: [],
};

const fresh = () => new ObjectDatabase([ItemType, CounterType]);
const mk = (db: ObjectDatabase, name: string, group: number, value = 0n) => db.create(ItemType, (id) => ({ id, name, group, value }));
const byName = (db: ObjectDatabase, name: string) => db.lookup(ItemType, 'byName', key((k) => k.str(name)));
const inGroup = (db: ObjectDatabase, g: number) => db.range(ItemType, 'byGroup', key((k) => k.u32(g))).map((o) => o.name);

describe('object database: arena and hot cache', () => {
  it('serves reads from the arena once decoded objects are evicted, and never evicts what is dirty', () => {
    const db = new ObjectDatabase([ItemType, CounterType], { hotObjects: 2 });
    const ids = ['a', 'b', 'c', 'd', 'e'].map((n, i) => mk(db, n, i).id);
    // Five dirty objects pinned in a cache of two: the budget is exceeded, not enforced, until the root.
    expect(db.memory().hotObjects).toBe(5);
    db.root();
    // The root wrote them to the arena and unpinned them; the cache keeps the budget.
    expect(db.memory().hotObjects).toBeLessThanOrEqual(2);
    expect(db.memory().arena.used).toBeGreaterThan(0);
    for (const [i, id] of ids.entries()) expect(db.get(ItemType, id)?.name).toBe('abcde'[i]);
    expect(Object.isFrozen(db.get(ItemType, ids[0]!))).toBe(true);
    expect(byName(db, 'c')?.id).toBe(ids[2]);
    expect(db.memory().hotObjects).toBeLessThanOrEqual(2);
    // A removal is a tombstone until the root: unreadable at once, the arena bytes gone after.
    db.remove(ItemType, ids[1]!);
    expect(db.get(ItemType, ids[1]!)).toBeNull();
    expect(byName(db, 'b')).toBeNull();
    expect([...db.exportObjects()].map(([id]) => id)).toEqual(ids.filter((id) => id !== ids[1]));
    db.root();
    expect(db.get(ItemType, ids[1]!)).toBeNull();
    expect([...db.exportObjects()].length).toBe(4);
    // Dirty objects never leave the cache whatever the budget; a modify keeps the latest value readable.
    db.setHotLimit(0);
    db.modify(ItemType, ids[0]!, (o) => ({ ...o, value: 7n }));
    expect(db.get(ItemType, ids[0]!)?.value).toBe(7n);
    expect(db.memory().hotObjects).toBe(1);
    db.root();
    expect(db.memory().hotObjects).toBe(0);
    expect(db.get(ItemType, ids[0]!)?.value).toBe(7n);
  });

  it('keeps history as bytes, agrees between getAt and bytesAt, and exports after churn what it holds', () => {
    const db = new ObjectDatabase([ItemType, CounterType], { hotObjects: 1, retainVersions: 10 });
    const id = mk(db, 'x', 1, 1n).id;
    db.root(1);
    for (let v = 2; v <= 6; v++) {
      db.modify(ItemType, id, (o) => ({ ...o, value: BigInt(v) }));
      mk(db, `churn${v}`, v);
      db.root(v);
    }
    for (let v = 1; v <= 6; v++) {
      expect(db.getAt(ItemType, id, v)?.value).toBe(BigInt(v));
      expect(db.bytesAt(id, v)).toEqual(encode((w) => ItemType.encode(w, db.getAt(ItemType, id, v)!)));
    }
    expect(db.memory().historyBytes).toBeGreaterThan(0);
    const exported = [...db.exportObjects()];
    expect(exported.length).toBe(6);
    for (const [eid, bytes] of exported) expect(bytes).toEqual(encode((w) => ItemType.encode(w, db.get(ItemType, eid)!)));
    // Compaction after churn has not changed a single byte of what is read back.
    const stats = db.memory().arena;
    expect(stats.used).toBeGreaterThan(0);
    expect(db.get(ItemType, id)?.value).toBe(6n);
    // The window closes behind: version 1 falls out after ten more roots and its bytes are released.
    for (let v = 7; v <= 16; v++) db.root(v);
    expect(() => db.getAt(ItemType, id, 1)).toThrow(RangeError);
  });

  it('computes the same roots whatever the cache budget', () => {
    const run = (hotObjects: number) => {
      const db = new ObjectDatabase([ItemType, CounterType], { hotObjects });
      const roots: string[] = [];
      for (let v = 1; v <= 5; v++) {
        for (let i = 0; i < 20; i++) mk(db, `v${v}-${i}`, i % 3, BigInt(i));
        if (v > 1) {
          db.modify(ItemType, objectId(7, 3 * v), (o) => ({ ...o, value: 99n }));
          db.remove(ItemType, objectId(7, 3 * v + 1));
        }
        roots.push(toHex(db.root(v)));
      }
      return roots;
    };
    expect(run(0)).toEqual(run(1_000_000));
  });
});

/** A small deterministic generator, so a failing sequence can be replayed. */
function prng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

/** Write a root's index and tree changes to a store, as the application's commit does, and tell the database. */
function persistIndex(db: ObjectDatabase, kv: MemoryKv): void {
  const changes = db.lastChanges;
  if (!changes) return;
  kv.write((w) => {
    for (const c of [...changes.indices, ...changes.trees]) {
      if (c.value) w.put(c.key, c.value);
      else w.del(c.key);
    }
  });
  db.dropChanges();
}

const storeEntries = (kv: MemoryKv) => [...kv.range(Uint8Array.of(0x69), Uint8Array.of(0x6a))].map(([k, v]) => `${toHex(k)}=${toHex(v)}`);
const viewEntries = (db: ObjectDatabase) => [...db.indexEntries()].map(([k, v]) => `${toHex(k)}=${toHex(v)}`);

const NAMES = Array.from({ length: 12 }, (_, i) => `n${i}`);
/** Everything the indices let a caller observe: every name's lookup, every group's scan, full scans, a cursor from the middle. */
function observe(db: ObjectDatabase): string {
  const out: string[] = [];
  for (const n of [...NAMES, 'spare']) out.push(`${n}:${byName(db, n)?.id ?? '-'}`);
  for (let g = 0; g < 4; g++) out.push(`g${g}:${inGroup(db, g).join(',')}`);
  out.push([...db.scan(ItemType, 'byName', new Uint8Array(0))].map((o) => `${o.name}=${o.id}`).join(','));
  out.push([...db.scanFrom(ItemType, 'byGroup', key((k) => k.u32(2)))].map(([k, o]) => `${toHex(k)}>${o.id}`).join(','));
  out.push([...db.scanFrom(ItemType, 'byName', key((k) => k.str('n5')))].map(([, o]) => o.name).join(','));
  return out.join(' ');
}

/**
 * Play one random sequence of creates, renames (a unique key changing hands), regroupings, removals, nested sessions
 * committed or undone, and roots on a database with resident trees and on one that drops and rebuilds its trees at
 * random moments (sessions open or not). After every step both must show the same indices; every root, the same hash.
 */
function playTwins(seed: number, steps: number, store: 'own' | 'injected'): void {
  const r = prng(seed);
  const a = new ObjectDatabase([ItemType, CounterType], { indexTrees: true });
  const kv = new MemoryKv();
  const b = new ObjectDatabase([ItemType, CounterType], { indexTrees: false, ...(store === 'injected' ? { indexStore: kv } : {}) });
  const sessions: [UndoSession, UndoSession][] = [];
  let version = 0;
  let unwritten = false;
  const both = (f: (db: ObjectDatabase) => void) => {
    let ea: unknown = null;
    let eb: unknown = null;
    try {
      f(a);
    } catch (e) {
      ea = e;
    }
    try {
      f(b);
    } catch (e) {
      eb = e;
    }
    expect(eb === null ? null : String(eb), `step outcome, seed ${seed}`).toBe(ea === null ? null : String(ea));
  };
  const live = () => [...a.exportObjects()].filter(([id]) => (id >> 48n) === 7n).map(([id]) => id);
  const log: string[] = [];
  for (let step = 0; step < steps; step++) {
    const op = r(20);
    log.push(`${op}:${sessions.length}:${b.memory().indexTrees}:${unwritten}`);
    const ids = live();
    const pick = () => ids[r(ids.length)]!;
    if (op < 5) {
      const name = NAMES[r(NAMES.length)]!;
      const group = r(4);
      both((db) => mk(db, name, group));
    } else if (op < 8 && ids.length > 0) {
      const id = pick();
      const name = NAMES[r(NAMES.length)]!;
      both((db) => db.modify(ItemType, id, (o) => ({ ...o, name })));
    } else if (op < 10 && ids.length > 1) {
      // A key handed from one object to another inside one block: x gives up its name, y takes it.
      const x = pick();
      const y = pick();
      if (x !== y) {
        const name = a.get(ItemType, x)!.name;
        both((db) => db.modify(ItemType, x, (o) => ({ ...o, name: 'spare' })));
        both((db) => db.modify(ItemType, y, (o) => ({ ...o, name })));
        both((db) => db.modify(ItemType, x, (o) => ({ ...o, name: `${name}x` })));
      }
    } else if (op < 12 && ids.length > 0) {
      const id = pick();
      const group = r(4);
      both((db) => db.modify(ItemType, id, (o) => ({ ...o, group })));
    } else if (op < 13 && ids.length > 0) {
      const id = pick();
      both((db) => db.remove(ItemType, id));
    } else if (op < 15 && sessions.length < 3) {
      sessions.push([a.startSession(), b.startSession()]);
    } else if (op < 17 && sessions.length > 0) {
      const [sa, sb] = sessions.pop()!;
      if (r(2) === 0) {
        sa.undo();
        sb.undo();
      } else {
        sa.commit();
        sb.commit();
      }
    } else if (op < 18) {
      // The dial: drop or rebuild in the middle of whatever is going on.
      if (b.memory().indexTrees === 'resident') b.dropIndexTrees();
      else b.rebuildIndexTrees();
    } else if (sessions.length === 0) {
      version++;
      // The application writes each root before it takes the next, sometimes at once, sometimes some steps later:
      // reads in between must see the root's own changes.
      if (unwritten) persistIndex(b, kv);
      expect(toHex(b.root(version)), `root ${version}, seed ${seed}`).toBe(toHex(a.root(version)));
      unwritten = store === 'injected';
      if (unwritten && r(2) === 0) {
        persistIndex(b, kv);
        unwritten = false;
        expect(storeEntries(kv), `store at ${version}, seed ${seed}`).toEqual(viewEntries(a));
      }
    }
    expect(observe(b), `step ${step}, seed ${seed} ${log.slice(-12).join(' ')}`).toBe(observe(a));
  }
}

describe('object database: index entries and dropped index trees', () => {
  it('reports every index entry a root adds and removes, so a store written from them equals the trees', () => {
    const kv = new MemoryKv();
    const db = new ObjectDatabase([ItemType, CounterType], { indexStore: kv, indexTrees: true });
    const a = mk(db, 'alice', 1);
    const b = mk(db, 'bob', 1);
    mk(db, 'carol', 2);
    db.root(1);
    // The first root writes every entry: three names, three group keys (with the id appended).
    expect(db.lastChanges!.indices.length).toBe(6);
    persistIndex(db, kv);
    expect(storeEntries(kv)).toEqual(viewEntries(db));
    expect(db.checkIndexStore()).toEqual([]);
    // A unique key changing hands in one block: alice gives up her name and bob takes it; removals come first.
    db.modify(ItemType, a.id, (o) => ({ ...o, name: 'ann' }));
    db.modify(ItemType, b.id, (o) => ({ ...o, name: 'alice', group: 3 }));
    db.root(2);
    const changes = db.lastChanges!.indices;
    const firstAdd = changes.findIndex((c) => c.value !== null);
    expect(changes.slice(firstAdd).every((c) => c.value !== null)).toBe(true);
    expect(changes.length).toBe(6); // alice, bob and bob's group key out; ann, alice (bob's now) and the new group key in
    persistIndex(db, kv);
    expect(storeEntries(kv)).toEqual(viewEntries(db));
    expect(db.checkIndexStore()).toEqual([]);
    // A value-only change touches no index entry; an object created and removed before a root, none either.
    db.modify(ItemType, a.id, (o) => ({ ...o, value: 5n }));
    const gone = mk(db, 'ephemeral', 0);
    db.remove(ItemType, gone.id);
    db.root(3);
    expect(db.lastChanges!.indices).toEqual([]);
    // The check notices a store that lost an entry or holds one too many.
    const k0 = kv.range(Uint8Array.of(0x69), Uint8Array.of(0x6a)).next().value![0];
    kv.write((w) => w.del(k0));
    expect(db.checkIndexStore().length).toBeGreaterThan(0);
  });

  it('answers lookups and merged scans from the store and the overlay while the trees are dropped', () => {
    const kv = new MemoryKv();
    const db = new ObjectDatabase([ItemType, CounterType], { indexStore: kv, indexTrees: true });
    const a = mk(db, 'a', 1);
    const b = mk(db, 'b', 1);
    const c = mk(db, 'c', 2);
    db.root(1);
    persistIndex(db, kv);
    db.dropIndexTrees();
    expect(db.memory().indexTrees).toBe('dropped');
    expect(byName(db, 'b')?.id).toBe(b.id);
    expect(inGroup(db, 1)).toEqual(['a', 'b']);
    // A pending insert appears in order, a pending removal is skipped.
    const d = mk(db, 'bb', 1);
    db.remove(ItemType, a.id);
    expect(inGroup(db, 1)).toEqual(['b', 'bb']);
    expect([...db.scan(ItemType, 'byName', new Uint8Array(0))].map((o) => o.name)).toEqual(['b', 'bb', 'c']);
    expect(byName(db, 'a')).toBeNull();
    // A key removed and taken again by another object yields the new owner, in the scan as in the lookup.
    db.modify(ItemType, c.id, (o) => ({ ...o, name: 'a' }));
    expect(byName(db, 'a')?.id).toBe(c.id);
    expect(byName(db, 'c')).toBeNull();
    expect([...db.scan(ItemType, 'byName', new Uint8Array(0))].map((o) => `${o.name}${instanceOf(o.id)}`)).toEqual(['a2', 'b1', 'bb3']);
    // Uniqueness is checked against the overlay and the store alike.
    expect(() => mk(db, 'b', 0)).toThrow(DbError);
    expect(() => mk(db, 'a', 0)).toThrow(DbError);
    expect(mk(db, 'c', 0).name).toBe('c'); // released by the rename above
    // An object created and removed before the root leaves nothing behind.
    const e = mk(db, 'e', 2);
    db.remove(ItemType, e.id);
    expect(byName(db, 'e')).toBeNull();
    expect(inGroup(db, 2)).toEqual(['a']);
    // Undo of a session while dropped puts the overlay back as it was.
    const before = observe(db);
    const s = db.startSession();
    db.modify(ItemType, b.id, (o) => ({ ...o, name: 'z', group: 3 }));
    db.remove(ItemType, d.id);
    mk(db, 'b', 0);
    expect(byName(db, 'b')?.name).toBe('b');
    expect(inGroup(db, 3)).toEqual(['z']);
    s.undo();
    expect(observe(db)).toBe(before);
    // Between the root and the store's write, the dropped indices read the root's own changes.
    db.root(2);
    expect(byName(db, 'a')?.id).toBe(c.id);
    expect(inGroup(db, 1)).toEqual(['b', 'bb']);
    persistIndex(db, kv);
    expect(byName(db, 'a')?.id).toBe(c.id);
    expect(storeEntries(kv)).toEqual(viewEntries(db));
    db.rebuildIndexTrees();
    expect(db.memory().indexTrees).toBe('resident');
    expect(db.checkIndexStore()).toEqual([]);
    expect(observe(db)).toBe(before);
    expect(d.id).toBe(objectId(7, 3));
  });

  it('drops and rebuilds with the same roots and lookups as resident trees, under random writes and sessions', () => {
    for (let seed = 1; seed <= 12; seed++) playTwins(seed, 400, seed % 2 === 0 ? 'own' : 'injected');
  });

  it('round-trips a drop and a rebuild in the middle of a block without changing a root or a lookup', () => {
    const run = (dial: boolean) => {
      const db = new ObjectDatabase([ItemType, CounterType]);
      const roots: string[] = [];
      const seen: string[] = [];
      for (let v = 1; v <= 6; v++) {
        for (let i = 0; i < 10; i++) mk(db, `v${v}-${i}`, i % 3);
        if (dial) db.dropIndexTrees(ItemType);
        if (v > 1) {
          db.modify(ItemType, objectId(7, 3 * v), (o) => ({ ...o, name: `moved${v}`, group: 3 }));
          db.remove(ItemType, objectId(7, 3 * v + 1));
        }
        seen.push(observe(db));
        if (dial && v % 2 === 0) db.rebuildIndexTrees(ItemType);
        roots.push(toHex(db.root(v)));
        seen.push(observe(db), viewEntries(db).join());
      }
      return { roots, seen };
    };
    expect(run(true)).toEqual(run(false));
  });
});

/** Apply one root's tree changes (or any change list) to a store. */
function writeChanges(kv: MemoryKv, changes: StoreChange[]): void {
  kv.write((w) => {
    for (const c of changes) {
      if (c.value) w.put(c.key, c.value);
      else w.del(c.key);
    }
  });
}

/** The store's dense chunks and sparse nodes, and a database's trees as it says a store should hold them, both sorted. */
const storedTrees = (kv: MemoryKv) => [...kv.range(Uint8Array.of(0x6e), Uint8Array.of(0x6f)), ...kv.range(Uint8Array.of(0x74), Uint8Array.of(0x75))].map(([k, v]) => `${toHex(k)}=${toHex(v)}`).sort();
const treeView = (db: ObjectDatabase) => [...db.treeEntries()].map(([k, v]) => `${toHex(k)}=${toHex(v)}`).sort();

/** Everything a version can be asked to prove: its root, every item and the counter object, names present and absent, ranges, type leaves. */
function proofsAt(db: ObjectDatabase, v: number, names: string[]): string {
  const out = [toHex(db.rootAt(v))];
  const count = db.countAt(ItemType.id, v);
  for (let i = 0; i <= count + 1; i++) out.push(toHex(proofToBytes(db.proofAt(objectId(ItemType.id, i), v))));
  out.push(toHex(proofToBytes(db.proofAt(objectId(CounterType.id, 0), v))));
  for (const name of names) out.push(toHex(keyProofToBytes(db.proveKeyAt(ItemType, 'byName', key((k) => k.str(name)), v))));
  for (const [from, to] of [[0, count], [0, 1], [count >> 1, count], [1, 7], [count - 2, count]] as const) if (from >= 0 && from < to && to <= count) out.push(db.rangeProofAt(ItemType.id, from, to, v).map(toHex).join(','));
  for (const t of [ItemType.id, CounterType.id]) {
    const l = db.typeLeafProofAt(t, v);
    out.push(`${l.nextInstance}:${toHex(l.typeRoot)}:${l.indexRoots.map(toHex).join(',')}:${l.topSiblings.map(toHex).join(',')}`);
  }
  return out.join(' ');
}

describe('object database: trees on disk and dropped trees', () => {
  it('reports the chunks and nodes each root changes, so a store written from them holds the trees', () => {
    const kv = new MemoryKv();
    const db = new ObjectDatabase([ItemType, CounterType], { indexStore: kv });
    for (let i = 0; i < 1500; i++) mk(db, `n${i}`, i % 5); // more than a chunk of leaves
    db.root(1);
    const first = db.lastChanges!.trees;
    // The first root writes every chunk of the item tree and the tree over the types, and every node of the name tree:
    // a leaf per name and at least one inner node fewer.
    expect(first.filter((c) => c.key[0] === 0x74).length).toBeGreaterThan(3);
    expect(first.filter((c) => c.key[0] === 0x6e).length).toBeGreaterThanOrEqual(1500 * 2 - 1);
    persistIndex(db, kv);
    expect(storedTrees(kv)).toEqual(treeView(db));
    // A value change rewrites the leaf's path in the item tree and the type leaf, and no sparse node.
    db.modify(ItemType, objectId(7, 3), (o) => ({ ...o, value: 9n }));
    db.root(2);
    expect(db.lastChanges!.trees.some((c) => c.key[0] === 0x6e)).toBe(false);
    expect(db.lastChanges!.trees.every((c) => c.value !== null)).toBe(true);
    persistIndex(db, kv);
    expect(storedTrees(kv)).toEqual(treeView(db));
    // Removing the whole second chunk of leaves deletes its chunk; renames move and collapse sparse nodes.
    for (let i = 1024; i < 1500; i++) db.remove(ItemType, objectId(7, i));
    db.modify(ItemType, objectId(7, 5), (o) => ({ ...o, name: 'renamed' }));
    db.root(3);
    expect(db.lastChanges!.trees.some((c) => c.key[0] === 0x74 && c.value === null)).toBe(true);
    expect(db.lastChanges!.trees.some((c) => c.key[0] === 0x6e && c.value === null)).toBe(true);
    persistIndex(db, kv);
    expect(storedTrees(kv)).toEqual(treeView(db));
    // A database with no store and its trees resident reports none.
    const quiet = new ObjectDatabase([ItemType, CounterType], { trees: true });
    mk(quiet, 'a', 1);
    quiet.root(1);
    expect(quiet.lastChanges!.trees).toEqual([]);
  });

  it('gives the same roots, object proofs, key proofs and range proofs with the trees dropped, at every version in the window, through undo and compaction', () => {
    const r = prng(5);
    // Long names make objects of 3 KB, so a few versions of rewrites leave slabs mostly dead and the arena compacts.
    const long = (n: string) => `${n}-${'x'.repeat(3000)}`;
    const a = new ObjectDatabase([ItemType, CounterType], { retainVersions: 4 });
    const kv = new MemoryKv();
    const b = new ObjectDatabase([ItemType, CounterType], { retainVersions: 4, indexStore: kv, treeChunks: 3 });
    const both = (f: (db: ObjectDatabase) => void) => {
      f(a);
      f(b);
    };
    const names: string[] = [long('nobody')];
    const items = () => [...a.exportObjects()].filter(([id]) => id >> 48n === 7n).map(([id]) => id);
    let compacted = false;
    let delayed = false;
    for (let v = 0; v < 26; v++) {
      if (delayed) persistIndex(b, kv);
      for (let i = 0; i < 4; i++) {
        const name = long(`v${v}-${i}`);
        names.push(name);
        both((db) => mk(db, name, i % 3, BigInt(v)));
      }
      const ids = items();
      for (let i = 0; i < 12; i++) {
        const id = ids[r(ids.length)]!;
        const rename = r(4) === 0 ? long(`r${v}-${i}`) : null;
        if (rename) names.push(rename);
        both((db) => db.modify(ItemType, id, (o) => ({ ...o, value: o.value + 1n, name: rename ?? o.name })));
      }
      if (v % 2 === 1) {
        const id = ids[r(ids.length)]!;
        both((db) => db.remove(ItemType, id));
      }
      if (v === 6) both((db) => db.create(CounterType, (id) => ({ id, n: 1n })));
      if (v > 6) both((db) => db.modify(CounterType, objectId(3, 0), (o) => ({ ...o, n: o.n + 1n })));
      // A session that renames, creates and removes, undone or kept; the dial turns inside it.
      const sa = a.startSession();
      const sb = b.startSession();
      const pick = items();
      const victim = pick[r(pick.length)]!;
      const renamed = pick[r(pick.length)]!;
      const taken = a.get(ItemType, renamed)!.name;
      both((db) => db.remove(ItemType, victim));
      if (renamed !== victim) both((db) => db.modify(ItemType, renamed, (o) => ({ ...o, name: long(`s${v}`) })));
      both((db) => mk(db, renamed !== victim ? taken : long(`t${v}`), 2));
      if (v % 6 === 1) b.dropTrees();
      if (v % 6 === 4) b.rebuildTrees();
      if (v % 3 === 0) {
        sa.undo();
        sb.undo();
      } else {
        names.push(long(`s${v}`), long(`t${v}`));
        sa.commit();
        sb.commit();
      }
      if (v === 20) b.dropTrees();
      const dead = b.memory().arena.dead;
      expect(toHex(b.root(v)), `root ${v}`).toBe(toHex(a.root(v)));
      if (b.memory().arena.dead < dead) compacted = true; // a slab more than half dead was copied out and released
      // Sometimes the store is written only before the next block: proofs in between read the root's own changes.
      delayed = v % 4 === 2;
      if (!delayed) {
        persistIndex(b, kv);
        expect(storedTrees(kv)).toEqual(treeView(a));
      }
      const probe = [...names.slice(-12), names[0]!, long('v0-1')];
      for (let old = a.lowestVersion; old <= v; old++) expect(proofsAt(b, old, probe), `version ${old} at ${v}`).toBe(proofsAt(a, old, probe));
      expect(b.memory().treeChunks).toBeLessThanOrEqual(3);
    }
    expect(compacted).toBe(true);
    expect(b.memory().trees).toBe('dropped');
    // The chunk cache was both used and too small to hold everything: some reads hit it, some went to the store.
    expect(b.memory().chunkHits).toBeGreaterThan(0);
    expect(b.memory().chunkMisses).toBeGreaterThan(0);
    b.rebuildTrees();
    for (let old = a.lowestVersion; old <= a.currentVersion; old++) expect(proofsAt(b, old, names.slice(-20))).toBe(proofsAt(a, old, names.slice(-20)));
  });

  it('runs on trees dropped from the start, with or without a store behind', () => {
    const run = (opts: { trees: boolean; store: boolean }) => {
      const kv = new MemoryKv();
      const db = new ObjectDatabase([ItemType, CounterType], { retainVersions: 3, trees: opts.trees, ...(opts.store ? { indexStore: kv } : {}) });
      const seen: string[] = [];
      for (let v = 0; v < 6; v++) {
        for (let i = 0; i < 300; i++) mk(db, `v${v}-${i}`, i % 4, BigInt(i));
        if (v > 0) for (let i = 0; i < 50; i++) db.remove(ItemType, objectId(7, 300 * (v - 1) + 2 * i));
        seen.push(toHex(db.root(v)));
        if (opts.store) persistIndex(db, kv);
        seen.push(proofsAt(db, Math.max(0, v - 2), ['v0-1', 'v0-2', `v${v}-7`]));
      }
      // What rebuilding would take comes from the objects, not from what was resident when the trees went: a leaf of
      // the name tree per live item (1,800 created, 250 removed).
      expect(db.rebuildEstimate().trees).toBe(opts.trees ? 0 : 1550 * 1000);
      return seen;
    };
    const resident = run({ trees: true, store: false });
    expect(run({ trees: false, store: false })).toEqual(resident);
    expect(run({ trees: false, store: true })).toEqual(resident);
  });
});

describe('object database', () => {
  it('assigns dense ids and serves unique and range lookups', () => {
    const db = fresh();
    const a = mk(db, 'alice', 1);
    const b = mk(db, 'bob', 1);
    const c = mk(db, 'carol', 2);
    expect(a.id).toBe(objectId(7, 0));
    expect(instanceOf(c.id)).toBe(2);
    expect(byName(db, 'bob')?.id).toBe(b.id);
    expect(byName(db, 'bo')).toBeNull();
    expect(inGroup(db, 1)).toEqual(['alice', 'bob']);
    expect(inGroup(db, 2)).toEqual(['carol']);
    expect(() => mk(db, 'alice', 3)).toThrow(DbError);
    db.modify(ItemType, b.id, (o) => ({ ...o, group: 2 }));
    expect(inGroup(db, 1)).toEqual(['alice']);
    expect(inGroup(db, 2)).toEqual(['bob', 'carol']);
    db.remove(ItemType, a.id);
    expect(db.get(ItemType, a.id)).toBeNull();
    expect(byName(db, 'alice')).toBeNull();
    expect(db.nextInstance(ItemType)).toBe(3);
    expect(mk(db, 'alice', 1).id).toBe(objectId(7, 3));
  });

  it('undoes and commits nested sessions', () => {
    const db = fresh();
    const a = mk(db, 'alice', 1, 10n);
    const outer = db.startSession();
    db.modify(ItemType, a.id, (o) => ({ ...o, value: 20n }));
    const b = mk(db, 'bob', 1);
    const inner = db.startSession();
    db.remove(ItemType, a.id);
    const c = mk(db, 'carol', 1);
    db.modify(ItemType, b.id, (o) => ({ ...o, value: 5n }));
    inner.undo();
    expect(db.get(ItemType, a.id)?.value).toBe(20n);
    expect(db.get(ItemType, c.id)).toBeNull();
    expect(db.get(ItemType, b.id)?.value).toBe(0n);
    expect(db.nextInstance(ItemType)).toBe(2);
    // The committed view looks through the open session.
    expect(db.getCommitted(ItemType, a.id)?.value).toBe(10n);
    expect(db.getCommitted(ItemType, b.id)).toBeNull();
    expect(db.committedNextInstance(ItemType.id)).toBe(1);
    const inner2 = db.startSession();
    db.remove(ItemType, a.id);
    inner2.commit();
    expect(db.get(ItemType, a.id)).toBeNull();
    outer.undo();
    expect(db.get(ItemType, a.id)?.value).toBe(10n);
    expect(db.get(ItemType, b.id)).toBeNull();
    expect(db.nextInstance(ItemType)).toBe(1);
    expect(byName(db, 'bob')).toBeNull();
    expect(mk(db, 'bob', 2).id).toBe(objectId(7, 1));
  });

  it('undo restores unique keys that were swapped around', () => {
    const db = fresh();
    const a = mk(db, 'a', 1);
    const b = mk(db, 'b', 1);
    const s = db.startSession();
    db.modify(ItemType, a.id, (o) => ({ ...o, name: 'tmp' }));
    db.modify(ItemType, b.id, (o) => ({ ...o, name: 'a' }));
    db.modify(ItemType, a.id, (o) => ({ ...o, name: 'b' }));
    expect(byName(db, 'a')?.id).toBe(b.id);
    s.undo();
    expect(byName(db, 'a')?.id).toBe(a.id);
    expect(byName(db, 'b')?.id).toBe(b.id);
  });

  it('refuses out-of-order session closes and a root with sessions open', () => {
    const db = fresh();
    const s1 = db.startSession();
    const s2 = db.startSession();
    expect(() => s1.undo()).toThrow(DbError);
    expect(() => db.root()).toThrow(DbError);
    s2.commit();
    s1.commit();
    db.root();
  });

  it('roots change with every write and prove inclusion and absence', () => {
    const db = fresh();
    const items = Array.from({ length: 5 }, (_, i) => mk(db, `item${i}`, i % 2, BigInt(i)));
    const r1 = db.root();
    for (const it of items) {
      const p = db.proof(it.id);
      expect(p.value).not.toBeNull();
      expect(verifyObjectProof(r1, p)).toBe(true);
      expect(verifyObjectProof(r1, { ...p, value: new Uint8Array([...p.value!, 1]) })).toBe(false);
      expect(verifyObjectProof(r1, { ...p, id: objectId(7, 99) })).toBe(false);
      expect(verifyObjectProof(sha256(r1), p)).toBe(false);
    }
    // Beyond the counter: no path, the counter in the type leaf is the proof.
    const beyond = db.proof(objectId(7, 5));
    expect(beyond.value).toBeNull();
    expect(beyond.typeSiblings).toEqual([]);
    expect(verifyObjectProof(r1, beyond)).toBe(true);
    expect(verifyObjectProof(r1, { ...beyond, nextInstance: 6n })).toBe(false);
    // A type with no objects.
    expect(verifyObjectProof(r1, db.proof(objectId(3, 0)))).toBe(true);
    // Proofs survive the codec.
    expect(verifyObjectProof(r1, proofFromBytes(proofToBytes(db.proof(items[0]!.id))))).toBe(true);

    db.modify(ItemType, items[2]!.id, (o) => ({ ...o, value: 99n }));
    const r2 = db.root();
    expect(toHex(r2)).not.toBe(toHex(r1));
    expect(verifyObjectProof(r2, db.proof(items[2]!.id))).toBe(true);
    expect(verifyObjectProof(r1, db.proof(items[2]!.id))).toBe(false);

    // Removed: an empty leaf on an ordinary path.
    db.remove(ItemType, items[1]!.id);
    const r3 = db.root();
    const gone = db.proof(items[1]!.id);
    expect(gone.value).toBeNull();
    expect(gone.typeSiblings.length).toBe(heightFor(5));
    expect(verifyObjectProof(r3, gone)).toBe(true);
    expect(verifyObjectProof(r3, { ...gone, value: new Uint8Array([1]) })).toBe(false);
    expect(verifyObjectProof(r3, db.proof(items[4]!.id))).toBe(true);
  });

  it('keeps proofs valid as the tree grows across powers of two, and matches a from-scratch build', () => {
    const db = fresh();
    const ids: bigint[] = [];
    for (let n = 1; n <= 40; n++) {
      ids.push(mk(db, `i${n}`, 0).id);
      if (n % 3 === 0) {
        const r = db.root();
        for (const id of ids) expect(verifyObjectProof(r, db.proof(id))).toBe(true);
      }
    }
    const r = db.root();
    const db2 = fresh();
    for (let n = 1; n <= 40; n++) mk(db2, `i${n}`, 0);
    expect(toHex(db2.root())).toBe(toHex(r));
  });

  it('proofs describe committed state while a session is open', () => {
    const db = fresh();
    const a = mk(db, 'alice', 1, 1n);
    const r = db.root();
    const s = db.startSession();
    db.modify(ItemType, a.id, (o) => ({ ...o, value: 2n }));
    mk(db, 'bob', 1);
    expect(verifyObjectProof(r, db.proof(a.id))).toBe(true);
    const absent = db.proof(objectId(7, 1));
    expect(absent.value).toBeNull();
    expect(verifyObjectProof(r, absent)).toBe(true);
    s.undo();
  });

  it('snapshots round-trip with the same root and rebuilt indices', () => {
    const db = fresh();
    for (let i = 0; i < 10; i++) mk(db, `n${i}`, i % 3, BigInt(i));
    db.remove(ItemType, objectId(7, 4));
    db.create(CounterType, (id) => ({ id, n: 7n }));
    const r = db.root();
    const bytes = db.encodeSnapshot(12n, r);
    const db2 = fresh();
    expect(db2.loadSnapshot(bytes).height).toBe(12n);
    expect(toHex(db2.root())).toBe(toHex(r));
    expect(db2.get(ItemType, objectId(7, 4))).toBeNull();
    expect(db2.nextInstance(ItemType)).toBe(10);
    expect(byName(db2, 'n7')?.value).toBe(7n);
    expect(inGroup(db2, 1)).toEqual(['n1', 'n7']);
    expect(verifyObjectProof(r, db2.proof(objectId(7, 9)))).toBe(true);
    expect(toHex(db2.encodeSnapshot(12n, r))).toBe(toHex(bytes));
  });
});

describe('dense merkle tree', () => {
  it('matches a naive computation and proves every leaf at every size', () => {
    const leaves = Array.from({ length: 11 }, (_, i) => sha256(new Uint8Array([i])));
    const naive = (ls: Uint8Array[]): Uint8Array => {
      let level = ls;
      for (let k = 0; k < heightFor(ls.length); k++) {
        void k;
        const next: Uint8Array[] = [];
        for (let j = 0; j < level.length; j += 2) next.push(innerHash(level[j]!, level[j + 1] ?? EMPTY));
        level = next;
      }
      return level[0]!;
    };
    const t = new DenseMerkleTree();
    for (let n = 1; n <= leaves.length; n++) {
      t.resize(n);
      t.setLeaf(n - 1, leaves[n - 1]!);
      expect(toHex(t.root())).toBe(toHex(naive(leaves.slice(0, n))));
      for (let i = 0; i < n; i++) expect(toHex(rootFromPath(leaves[i]!, i, t.path(i)))).toBe(toHex(t.root()));
    }
  });
});

describe('dense merkle tree: chunks and versions', () => {
  const leaf = (i: number) => sha256(new Uint8Array([i & 0xff, i >> 8]));

  it('releases chunks whose nodes are all empty, and hashes holes like a fresh tree', () => {
    const t = new DenseMerkleTree();
    t.resize(4096);
    for (let i = 0; i < 4096; i++) t.setLeaf(i, leaf(i));
    t.root();
    expect(t.chunkCount).toBe(17); // 4 + 2 + 1 at levels 0..2, one at each of levels 3..12
    for (let i = 0; i < 2048; i++) t.setLeaf(i, EMPTY);
    const r = t.root();
    expect(t.chunkCount).toBe(14);
    const fresh = new DenseMerkleTree();
    fresh.resize(4096);
    for (let i = 2048; i < 4096; i++) fresh.setLeaf(i, leaf(i));
    expect(toHex(fresh.root())).toBe(toHex(r));
    expect(toHex(rootFromPath(leaf(3000), 3000, t.path(3000)))).toBe(toHex(r));
    expect(toHex(rootFromPath(EMPTY, 100, t.path(100)))).toBe(toHex(r));
    for (let i = 2048; i < 4096; i++) t.setLeaf(i, EMPTY);
    expect(toHex(t.root())).toBe(toHex(EMPTY));
    expect(t.chunkCount).toBe(0);
  });

  it('serves paths at past versions inside the window and forgets older ones', () => {
    const t = new DenseMerkleTree(3);
    const roots: Uint8Array[] = [];
    const leavesAt: Uint8Array[][] = [];
    let live: Uint8Array[] = [];
    for (let v = 0; v < 10; v++) {
      // Each version grows the tree a little and rewrites a few leaves.
      t.resize(5 + 3 * v);
      live = live.slice();
      for (let i = 0; i < 5 + 3 * v; i++) {
        if (i % (v + 2) === 0 || i >= live.length) {
          live[i] = leaf(100 * v + i);
          t.setLeaf(i, live[i]!);
        }
      }
      roots.push(t.root(v));
      leavesAt.push(live.slice());
      expect(t.lowestVersion).toBe(Math.max(0, v - 3));
      for (let old = t.lowestVersion; old <= v; old++) {
        expect(toHex(t.rootAt(old))).toBe(toHex(roots[old]!));
        const ls = leavesAt[old]!;
        for (let i = 0; i < ls.length; i++) expect(toHex(rootFromPath(ls[i]!, i, t.pathAt(i, old)))).toBe(toHex(roots[old]!));
        expect(() => t.pathAt(ls.length, old)).toThrow(/beyond size/);
      }
      if (v >= 4) expect(() => t.pathAt(0, v - 4)).toThrow(/not available/);
    }
  });
});

describe('dense merkle tree: dropped', () => {
  const leaf = (i: number, v: number) => sha256(new Uint8Array([i & 0xff, i >> 8, v]));

  it('reads its chunks through a bounded cache and computes the same roots and paths as a resident tree', () => {
    const kv = new MemoryKv();
    const cache = new ChunkCache(2);
    const a = new DenseMerkleTree(3, 5);
    const b = new DenseMerkleTree(3, 5);
    b.reporting = true;
    const r = prng(9);
    const roots: Uint8Array[] = [];
    for (let v = 0; v < 14; v++) {
      // Growing across chunk boundaries and powers of two, rewriting leaves, emptying some and a whole chunk.
      const size = 600 + 250 * v;
      a.resize(size);
      b.resize(size);
      for (let n = 0; n < 40; n++) {
        const i = r(size);
        const h = n % 7 === 0 ? EMPTY : leaf(i, v);
        a.setLeaf(i, h);
        b.setLeaf(i, h);
      }
      if (v === 9) for (let i = 1024; i < 2048; i++) for (const t of [a, b]) t.setLeaf(i, EMPTY);
      roots.push(a.root(v));
      expect(toHex(b.root(v)), `root ${v}`).toBe(toHex(roots[v]!));
      writeChanges(kv, b.takeChunks());
      b.release();
      if (v === 3 || v === 10) b.drop(kv, cache);
      if (v === 7) b.rebuild();
      expect(cache.size).toBeLessThanOrEqual(2);
      for (let old = a.lowestVersion; old <= v; old++) {
        expect(toHex(b.rootAt(old))).toBe(toHex(a.rootAt(old)));
        const n = a.sizeAt(old);
        for (const i of [0, 1, 1023, 1024, n - 1, r(n)]) if (i < n) expect(b.pathAt(i, old).map(toHex)).toEqual(a.pathAt(i, old).map(toHex));
        expect(b.rangeProofAt(n >> 2, n - 3, old).map(toHex)).toEqual(a.rangeProofAt(n >> 2, n - 3, old).map(toHex));
      }
      const chunks = (t: DenseMerkleTree) => [...t.entries()].map(([k, x]) => `${toHex(k)}=${toHex(x)}`).sort();
      expect(chunks(b)).toEqual(chunks(a));
    }
    expect(b.resident).toBe(false);
  });
});

describe('object database: versions', () => {
  it('reproduces at a later version the proofs it made at the time', () => {
    const db = new ObjectDatabase([ItemType, CounterType], { retainVersions: 5 });
    const roots: Uint8Array[] = [];
    const made = new Map<string, Uint8Array>(); // `${v}/${id}` to the proof bytes made at version v
    const ids: bigint[] = [];
    for (let v = 0; v < 12; v++) {
      const s = db.startSession();
      ids.push(mk(db, `n${v}`, v % 3, BigInt(v)).id);
      if (v > 0) db.modify(ItemType, ids[v - 1]!, (o) => ({ ...o, value: o.value + 100n }));
      if (v % 4 === 3) db.remove(ItemType, ids[v - 3]!);
      if (v === 6) db.create(CounterType, (id) => ({ id, n: 1n }));
      s.commit();
      roots.push(db.root(v));
      for (let i = 0; i <= v + 1; i++) {
        const id = objectId(7, i);
        const p = db.proof(id);
        expect(verifyObjectProof(roots[v]!, p)).toBe(true);
        made.set(`${v}/${i}`, proofToBytes(p));
      }
      made.set(`${v}/c`, proofToBytes(db.proof(objectId(3, 0))));
      // Everything inside the window still proves exactly as it did.
      for (let old = db.lowestVersion; old <= v; old++) {
        for (let i = 0; i <= old + 1; i++) {
          const p = db.proofAt(objectId(7, i), old);
          expect(toHex(proofToBytes(p))).toBe(toHex(made.get(`${old}/${i}`)!));
          expect(verifyObjectProof(roots[old]!, p)).toBe(true);
        }
        expect(toHex(proofToBytes(db.proofAt(objectId(3, 0), old)))).toBe(toHex(made.get(`${old}/c`)!));
      }
      if (v >= 6) expect(() => db.proofAt(ids[0]!, v - 6)).toThrow(/not available/);
    }
    // Historical reads look through an open session too.
    const s = db.startSession();
    db.modify(ItemType, ids[11]!, (o) => ({ ...o, value: 0n }));
    expect(db.getAt(ItemType, ids[11]!, 11)?.value).toBe(11n);
    expect(db.getAt(ItemType, ids[10]!, 10)?.value).toBe(10n);
    expect(db.getAt(ItemType, ids[10]!, 11)?.value).toBe(110n);
    s.undo();
  });

  it('reports what each root changed, for a persistent store', () => {
    const db = fresh();
    const a = mk(db, 'a', 1);
    mk(db, 'b', 1);
    db.root(0);
    expect(db.lastChanges!.objects.map((c) => [c.id, c.bytes !== null])).toEqual([
      [a.id, true],
      [objectId(7, 1), true],
    ]);
    expect(db.lastChanges!.counters.get(7)).toBe(2);
    const s = db.startSession();
    db.modify(ItemType, a.id, (o) => ({ ...o, value: 5n }));
    const c = mk(db, 'c', 2);
    db.remove(ItemType, c.id);
    const inner = db.startSession();
    db.modify(ItemType, objectId(7, 1), (o) => ({ ...o, value: 1n }));
    inner.undo();
    s.commit();
    db.root(1);
    const changes = db.lastChanges!;
    // b was undone back to its committed object, c never existed at a root: neither is reported.
    expect(changes.objects.map((c) => [c.id, c.bytes !== null])).toEqual([[a.id, true]]);
    expect(changes.counters.get(7)).toBe(3);
  });
});

describe('b+ tree', () => {
  const keyOf = (n: number) => new Uint8Array([n >> 16, (n >> 8) & 0xff, n & 0xff]);
  const hex = (b: Uint8Array) => toHex(b);

  it('agrees with a reference map under random inserts, overwrites and deletes', () => {
    const t = new BPlusTree<number>();
    const ref = new Map<string, number>();
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let round = 0; round < 60_000; round++) {
      const k = keyOf(rnd() % 20_000);
      const op = rnd() % 3;
      if (op < 2) {
        t.set(k, round);
        ref.set(hex(k), round);
      } else {
        expect(t.delete(k)).toBe(ref.delete(hex(k)));
      }
      if (round % 5000 === 0) {
        expect(t.size).toBe(ref.size);
        const sorted = [...ref.keys()].sort();
        expect([...t.scan(new Uint8Array(0))].map(([k]) => hex(k))).toEqual(sorted);
      }
    }
    expect(t.size).toBe(ref.size);
    for (const [k, v] of ref) expect(t.get(new Uint8Array(Buffer.from(k, 'hex')))).toBe(v);
    expect(t.get(keyOf(30_000))).toBeUndefined();
    for (const [k] of ref) t.delete(new Uint8Array(Buffer.from(k, 'hex')));
    expect(t.size).toBe(0);
    expect([...t.scan(new Uint8Array(0))]).toEqual([]);
  });

  it('scans prefixes and ranges in order after sequential inserts', () => {
    const t = new BPlusTree<string>();
    for (let i = 0; i < 5000; i++) t.set(keyOf(i), `v${i}`);
    const under = [...t.scan(new Uint8Array([0, 3]))];
    expect(under.length).toBe(256);
    expect(under[0]![1]).toBe('v768');
    expect(under[255]![1]).toBe('v1023');
    const from = [...t.entriesFrom(keyOf(4990))];
    expect(from.map(([, v]) => v)).toEqual(Array.from({ length: 10 }, (_, i) => `v${4990 + i}`));
    expect([...t.scan(new Uint8Array([9]))]).toEqual([]);
    for (let i = 0; i < 5000; i += 2) t.delete(keyOf(i));
    expect([...t.scan(new Uint8Array([0, 0]))].map(([, v]) => v).slice(0, 3)).toEqual(['v1', 'v3', 'v5']);
    expect(t.size).toBe(2500);
  });
});

describe('sparse merkle tree', () => {
  const k = (s: string) => new TextEncoder().encode(s);
  const v = (n: number) => new Uint8Array([n]);

  it('has one shape per key set whatever the history, and proves presence and absence', () => {
    const t = new SparseMerkleTree();
    const ref = new Map<string, number>();
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 3000; i++) {
      const name = `k${rnd() % 400}`;
      if (rnd() % 3 === 0) {
        t.delete(k(name));
        ref.delete(name);
      } else {
        const n = rnd() % 200;
        t.set(k(name), v(n));
        ref.set(name, n);
      }
    }
    const fresh = new SparseMerkleTree();
    for (const [name, n] of [...ref].sort()) fresh.set(k(name), v(n));
    expect(toHex(fresh.rootHash())).toBe(toHex(t.rootHash()));
    t.commit(1);
    const root = t.rootHash();
    for (const [name, n] of ref) {
      expect(t.get(k(name))).toEqual(v(n));
      const folded = smtProofRoot(k(name), t.prove(k(name)))!;
      expect(toHex(folded.root)).toBe(toHex(root));
      expect(folded.value).toEqual(v(n));
    }
    for (const name of ['k400', 'nope', '']) {
      expect(t.get(k(name))).toBeUndefined();
      const p = t.prove(k(name));
      const folded = smtProofRoot(k(name), p)!;
      expect(toHex(folded.root)).toBe(toHex(root));
      expect(folded.value).toBeNull();
      // Claiming the other leaf's value for this key must not fold to the root.
      if (p.leaf) expect(toHex(smtProofRoot(k(name), { ...p, leaf: { keyHash: sha256(k(name)), value: p.leaf.value } })!.root)).not.toBe(toHex(root));
    }
    for (const name of ref.keys()) t.delete(k(name));
    expect(toHex(t.rootHash())).toBe(toHex(EMPTY));
    // Version 1 still holds the full tree, so a proof made against it folds to that root, not the empty live one.
    expect(toHex(smtProofRoot(k('x'), t.prove(k('x')))!.root)).toBe(toHex(root));
  });

  it('keeps past versions inside the window', () => {
    const t = new SparseMerkleTree(2);
    const roots: Uint8Array[] = [];
    for (let i = 0; i < 6; i++) {
      t.set(k(`a${i}`), v(i));
      if (i > 1) t.delete(k(`a${i - 2}`));
      roots.push(t.commit(i));
    }
    for (let i = 3; i <= 5; i++) {
      expect(toHex(t.rootAt(i))).toBe(toHex(roots[i]!));
      const p = t.proveAt(k(`a${i}`), i);
      expect(smtProofRoot(k(`a${i}`), p)!.value).toEqual(v(i));
      expect(smtProofRoot(k(`a${i - 2}`), t.proveAt(k(`a${i - 2}`), i))!.value).toBeNull();
    }
    expect(() => t.rootAt(2)).toThrow(/not available/);
  });
});

describe('sparse merkle tree: dropped', () => {
  const k = (n: number) => new TextEncoder().encode(`key${n}`);
  const header = nodeHeader(9, 0);
  const proofHex = (p: SmtProof) => `${p.siblings.map(toHex).join(',')}|${p.leaf ? `${toHex(p.leaf.keyHash)}=${toHex(p.leaf.value)}` : '-'}`;

  it('gives the roots and proofs of a resident tree, writing back only the nodes it changed', () => {
    const kv = new MemoryKv();
    const a = new SparseMerkleTree(3, header);
    const b = new SparseMerkleTree(3, header);
    const r = prng(21);
    for (let v = 0; v < 40; v++) {
      // A small key space, so leaves split and collapse often.
      for (let i = 0; i < 25; i++) {
        const n = r(120);
        if (r(3) === 0) {
          a.delete(k(n));
          b.delete(k(n));
        } else {
          const value = new Uint8Array([r(256), v]);
          a.set(k(n), value);
          b.set(k(n), value);
        }
      }
      // Dropped between commits, and in the middle of writes (they become pending), rebuilt in between.
      if (v === 3 || v === 22) b.drop(kv);
      if (v === 12 || v === 30) b.rebuild();
      for (let n = 0; n < 120; n += 7) expect(b.get(k(n))).toEqual(a.get(k(n)));
      if (v === 17) {
        b.drop(kv);
        a.set(k(500), new Uint8Array([1]));
        b.set(k(500), new Uint8Array([1]));
      }
      a.commit(v);
      expect(toHex(b.commit(v, true)), `root ${v}`).toBe(toHex(a.rootHash()));
      writeChanges(kv, b.takeNodes());
      const nodes = [...kv.range(header, Uint8Array.of(0x6e, 0, 9, 1))].map(([x, y]) => `${toHex(x)}=${toHex(y)}`).sort();
      expect(nodes).toEqual([...a.entries()].map(([x, y]) => `${toHex(x)}=${toHex(y)}`).sort());
      expect(b.lowestVersion).toBe(a.lowestVersion);
      for (let old = a.lowestVersion; old <= v; old++) {
        expect(toHex(b.rootAt(old))).toBe(toHex(a.rootAt(old)));
        for (let n = 0; n < 130; n += 5) expect(proofHex(b.proveAt(k(n), old)), `key ${n} at ${old}`).toBe(proofHex(a.proveAt(k(n), old)));
      }
    }
  });
});

describe('object database: key proofs', () => {
  it('proves index keys and rebuilds index versions from history', () => {
    const db = new ObjectDatabase([ItemType, CounterType], { retainVersions: 4 });
    const roots: Uint8Array[] = [];
    const made: Uint8Array[][] = [];
    for (let v = 0; v < 8; v++) {
      mk(db, `n${v}`, 0);
      if (v >= 2) db.modify(ItemType, objectId(7, v - 2), (o) => ({ ...o, name: `r${v - 2}` }));
      if (v >= 4) db.remove(ItemType, objectId(7, v - 4));
      roots.push(db.root(v));
      made.push([`n${v}`, `r${v - 2}`, `n${v - 2}`, `gone${v}`].map((name) => keyProofBytes(db, name)));
      const present = verifyKeyProof(roots[v]!, db.proveKey(ItemType, 'byName', key((k) => k.str(`n${v}`))));
      expect(present && toHex(present)).toBe(toHex(encode((w) => w.u64(objectId(7, v)))));
      expect(verifyKeyProof(roots[v]!, db.proveKey(ItemType, 'byName', key((k) => k.str(`gone${v}`))))).toBeNull();
      if (v >= 2) expect(verifyKeyProof(roots[v]!, db.proveKey(ItemType, 'byName', key((k) => k.str(`n${v - 2}`))))).toBeNull();
    }
    // Replay the persisted history into a fresh database, as a restart does, and compare every proof in the window.
    const fresh = new ObjectDatabase([ItemType, CounterType], { retainVersions: 4 });
    for (const [id, bytes] of db.exportObjects()) fresh.importObject(id, bytes);
    for (const [t, n] of db.counters()) fresh.setCounter(t, n);
    expect(toHex(fresh.root(7))).toBe(toHex(roots[7]!));
    const records = histories; // filled below
    for (const [v, rec] of records) fresh.loadHistory(v, rec);
    fresh.rebuildIndexVersions();
    for (let v = fresh.lowestVersion; v <= 7; v++) {
      const names = [`n${v}`, `r${v - 2}`, `n${v - 2}`, `gone${v}`];
      names.forEach((name, i) => expect(toHex(keyProofBytesAt(fresh, name, v))).toBe(toHex(made[v]![i]!)));
      expect(toHex(proofToBytes(fresh.proofAt(objectId(7, v), v)))).toBe(toHex(proofToBytes(db.proofAt(objectId(7, v), v))));
    }
  });
});

const histories: [number, import('../src/db/database.ts').HistoryRecord][] = [];
function keyProofBytes(db: ObjectDatabase, name: string): Uint8Array {
  const rec = db.lastChanges!;
  if (rec.history && !histories.some(([v]) => v === rec.version)) histories.push([rec.version, rec.history]);
  return keyProofBytesAt(db, name, db.currentVersion);
}
function keyProofBytesAt(db: ObjectDatabase, name: string, v: number): Uint8Array {
  return encode((w) => encodeKeyProof(w, db.proveKeyAt(ItemType, 'byName', key((k) => k.str(name)), v)));
}
