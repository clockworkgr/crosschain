import { describe, expect, it } from 'vitest';
import { sha256, toHex } from '../src/crypto/hash.ts';
import { ObjectDatabase, type UndoSession } from '../src/db/database.ts';
import { MemoryKv } from '../src/store/kv.ts';
import { instanceOf, objectId } from '../src/db/id.ts';
import { DbError, type ObjectType } from '../src/db/index.ts';
import { key } from '../src/db/keys.ts';
import { BPlusTree } from '../src/db/bptree.ts';
import { DenseMerkleTree, EMPTY, heightFor, innerHash, rootFromPath } from '../src/db/merkle.ts';
import { encodeKeyProof, proofFromBytes, proofToBytes, verifyKeyProof, verifyObjectProof } from '../src/db/proof.ts';
import { encode } from '../src/codec/writer.ts';
import { SparseMerkleTree, smtProofRoot } from '../src/db/smt.ts';

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

/** Write a root's index changes and objects to a store, as the application's commit does, and tell the database. */
function persistIndex(db: ObjectDatabase, kv: MemoryKv): void {
  const changes = db.lastChanges;
  if (!changes) return;
  kv.write((w) => {
    for (const c of changes.indices) {
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
