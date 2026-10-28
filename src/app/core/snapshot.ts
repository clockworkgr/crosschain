/**
 * State snapshots for syncing a node from a height instead of from genesis.
 *
 * Every K blocks the application exports its objects by type in chunks of a
 * fixed instance range, each chunk carrying the range proof that folds its
 * leaves to the type root at that height, and a manifest holding every type
 * leaf with its path to the app hash. A joiner that trusts the header after
 * the snapshot height can therefore verify the manifest against that
 * header's app hash and every chunk against the manifest, before loading
 * anything. Nothing here needs the serving node's live state.
 */
import { decode, type Reader } from '../../codec/reader.ts';
import { encode, type Writer } from '../../codec/writer.ts';
import { bytesEqual, HASH_SIZE, sha256 } from '../../crypto/hash.ts';
import { ObjectDatabase, type DatabaseOptions } from '../../db/database.ts';
import { objectId } from '../../db/id.ts';
import type { ObjectType } from '../../db/index.ts';
import { EMPTY, rootFromRange } from '../../db/merkle.ts';
import { objectLeaf, typeLegMatches } from '../../db/proof.ts';

export const SNAPSHOT_FORMAT = 1;

export interface SnapshotTypeInfo {
  type: number;
  nextInstance: bigint;
  typeRoot: Uint8Array;
  indexRoots: Uint8Array[];
  typeIndex: number;
  typeCount: number;
  topSiblings: Uint8Array[];
  chunkHashes: Uint8Array[];
}

export interface SnapshotManifest {
  format: number;
  height: bigint;
  appHash: Uint8Array;
  chunkObjects: number;
  types: SnapshotTypeInfo[];
}

export interface SnapshotChunk {
  height: bigint;
  type: number;
  index: number;
  from: number;
  to: number;
  /** Present instances in [from, to), ascending, with their encodings. */
  objects: [number, Uint8Array][];
  siblings: Uint8Array[];
}

export function encodeManifest(w: Writer, m: SnapshotManifest): void {
  w.u32(m.format).u64(m.height).fixed(m.appHash).u32(m.chunkObjects);
  w.array(m.types, (w, t) => {
    w.u16(t.type).u64(t.nextInstance).fixed(t.typeRoot).array(t.indexRoots, (w, r) => w.fixed(r)).u32(t.typeIndex).u32(t.typeCount);
    w.array(t.topSiblings, (w, s) => w.fixed(s)).array(t.chunkHashes, (w, h) => w.fixed(h));
  });
}

export function decodeManifest(r: Reader): SnapshotManifest {
  return {
    format: r.u32(),
    height: r.u64(),
    appHash: r.fixed(HASH_SIZE),
    chunkObjects: r.u32(),
    types: r.array((r) => ({
      type: r.u16(),
      nextInstance: r.u64(),
      typeRoot: r.fixed(HASH_SIZE),
      indexRoots: r.array((r) => r.fixed(HASH_SIZE), 16),
      typeIndex: r.u32(),
      typeCount: r.u32(),
      topSiblings: r.array((r) => r.fixed(HASH_SIZE), 64),
      chunkHashes: r.array((r) => r.fixed(HASH_SIZE), 1_000_000),
    })),
  };
}

export function encodeChunk(w: Writer, c: SnapshotChunk): void {
  w.u64(c.height).u16(c.type).u32(c.index).u64(BigInt(c.from)).u64(BigInt(c.to));
  w.array(c.objects, (w, [i, b]) => w.u64(BigInt(i)).bytes(b)).array(c.siblings, (w, s) => w.fixed(s));
}

export function decodeChunk(r: Reader): SnapshotChunk {
  return {
    height: r.u64(),
    type: r.u16(),
    index: r.u32(),
    from: Number(r.u64()),
    to: Number(r.u64()),
    objects: r.array((r) => [Number(r.u64()), r.bytes()] as [number, Uint8Array]),
    siblings: r.array((r) => r.fixed(HASH_SIZE), 128),
  };
}

export const manifestToBytes = (m: SnapshotManifest): Uint8Array => encode((w) => encodeManifest(w, m));
export const manifestFromBytes = (b: Uint8Array): SnapshotManifest => decode(b, decodeManifest);
export const chunkToBytes = (c: SnapshotChunk): Uint8Array => encode((w) => encodeChunk(w, c));
export const chunkFromBytes = (b: Uint8Array): SnapshotChunk => decode(b, decodeChunk);

/** Export the state as of `height`, which must be inside the database's window (usually the current version). */
export function exportSnapshot(db: ObjectDatabase, types: ObjectType<any>[], height: number, chunkObjects: number): { manifest: SnapshotManifest; chunks: Uint8Array[][] } {
  const byId = new Map(types.map((t) => [t.id, t]));
  const infos: SnapshotTypeInfo[] = [];
  const chunks: Uint8Array[][] = [];
  for (const type of db.typeOrder) {
    const leaf = db.typeLeafProofAt(type, height);
    const count = Number(leaf.nextInstance);
    const t = byId.get(type)!;
    const encodedChunks: Uint8Array[] = [];
    const hashes: Uint8Array[] = [];
    for (let from = 0, index = 0; from < count; from += chunkObjects, index++) {
      const to = Math.min(from + chunkObjects, count);
      const objects: [number, Uint8Array][] = [];
      for (let i = from; i < to; i++) {
        const obj = db.getAt(t, objectId(type, i), height);
        if (obj) objects.push([i, encode((w) => t.encode(w, obj))]);
      }
      const bytes = chunkToBytes({ height: BigInt(height), type, index, from, to, objects, siblings: db.rangeProofAt(type, from, to, height) });
      encodedChunks.push(bytes);
      hashes.push(sha256(bytes));
    }
    infos.push({ type, nextInstance: leaf.nextInstance, typeRoot: leaf.typeRoot, indexRoots: leaf.indexRoots, typeIndex: leaf.typeIndex, typeCount: leaf.typeCount, topSiblings: leaf.topSiblings, chunkHashes: hashes });
    chunks.push(encodedChunks);
  }
  const appHash = db.rootAt(height);
  return { manifest: { format: SNAPSHOT_FORMAT, height: BigInt(height), appHash, chunkObjects, types: infos }, chunks };
}

/**
 * Every type leaf must fold to the app hash the trusted header carries, and with `types` given, the
 * manifest must name every registered type exactly once in id order: a manifest with a type left out
 * folds just as well, and would only fail after every chunk has been fetched.
 */
export function verifyManifest(appHash: Uint8Array, m: SnapshotManifest, types?: ObjectType<any>[]): string | null {
  if (m.format !== SNAPSHOT_FORMAT) return `snapshot format ${m.format}`;
  if (!bytesEqual(m.appHash, appHash)) return 'manifest app hash differs from the header';
  if (m.chunkObjects < 1) return 'bad chunk size';
  if (types) {
    const order = [...types].map((t) => t.id).sort((a, b) => a - b);
    if (m.types.length !== order.length) return `manifest names ${m.types.length} types, the application has ${order.length}`;
    for (let i = 0; i < order.length; i++) {
      const t = m.types[i]!;
      if (t.type !== order[i] || t.typeIndex !== i || t.typeCount !== order.length) return `manifest type ${t.type} out of place`;
    }
  }
  for (const t of m.types) {
    if (!typeLegMatches(appHash, t)) return `type ${t.type} leaf does not fold to the app hash`;
    const expectedChunks = Math.ceil(Number(t.nextInstance) / m.chunkObjects);
    if (t.chunkHashes.length !== expectedChunks) return `type ${t.type} chunk count mismatch`;
  }
  return null;
}

/** A chunk's bytes must hash as the manifest says and its leaves must fold to the type root. */
export function verifyChunk(m: SnapshotManifest, raw: Uint8Array): { chunk: SnapshotChunk } | { error: string } {
  let chunk: SnapshotChunk;
  try {
    chunk = chunkFromBytes(raw);
  } catch (e) {
    return { error: `malformed chunk: ${(e as Error).message}` };
  }
  const info = m.types.find((t) => t.type === chunk.type);
  if (!info || chunk.height !== m.height) return { error: 'chunk is not from this snapshot' };
  const expected = info.chunkHashes[chunk.index];
  if (!expected || !bytesEqual(sha256(raw), expected)) return { error: 'chunk hash differs from the manifest' };
  const count = Number(info.nextInstance);
  if (chunk.from !== chunk.index * m.chunkObjects || chunk.to !== Math.min(chunk.from + m.chunkObjects, count)) return { error: 'chunk range does not match its index' };
  const leaves: Uint8Array[] = [];
  let next = 0;
  for (let i = chunk.from; i < chunk.to; i++) {
    const entry = chunk.objects[next];
    if (entry && entry[0] === i) {
      leaves.push(objectLeaf(objectId(chunk.type, i), entry[1]));
      next++;
    } else leaves.push(EMPTY);
  }
  if (next !== chunk.objects.length) return { error: 'chunk objects out of order or outside the range' };
  const root = rootFromRange(leaves, chunk.from, count, chunk.siblings);
  if (!root || !bytesEqual(root, info.typeRoot)) return { error: 'chunk does not fold to the type root' };
  return { chunk };
}

/** Load verified chunks into a fresh database and check the root and the index roots. */
export function importSnapshot(m: SnapshotManifest, chunks: SnapshotChunk[], types: ObjectType<any>[], opts: DatabaseOptions = {}): ObjectDatabase {
  const db = new ObjectDatabase(types, opts);
  for (const c of chunks) for (const [i, bytes] of c.objects) db.importObject(objectId(c.type, i), bytes);
  for (const t of m.types) db.setCounter(t.type, Number(t.nextInstance));
  const root = db.root(Number(m.height));
  if (!bytesEqual(root, m.appHash)) throw new Error('imported objects do not hash to the snapshot app hash');
  for (const t of m.types) {
    const leaf = db.typeLeafProofAt(t.type, Number(m.height));
    if (leaf.indexRoots.length !== t.indexRoots.length || leaf.indexRoots.some((r, i) => !bytesEqual(r, t.indexRoots[i]!))) throw new Error(`type ${t.type}: rebuilt index roots differ from the snapshot`);
  }
  return db;
}

export function chunkCount(m: SnapshotManifest): number {
  return m.types.reduce((s, t) => s + t.chunkHashes.length, 0);
}
