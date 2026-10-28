/**
 * Inclusion and absence proofs for one object against an app hash. This
 * file has no dependency on the database so a light client can use it alone.
 *
 * The state root is two dense trees deep (merkle.ts): one tree per type over
 * its instances, and one tree over the types. A proof is therefore
 *
 *   leaf(id, value) --typeSiblings--> typeRoot
 *   leaf(type, nextInstance || typeRoot || indexRoots) --topSiblings--> appHash
 *
 * A type's authenticated indices (smt.ts) put their roots into its leaf, so a
 * proof by key is a sparse-tree proof to one of those roots and then the
 * same type leg.
 *
 * Both legs are ICS23 existence proofs under one spec:
 *   LeafOp    prefix 0x00, PrehashKey NO_HASH, PrehashValue SHA256, Length VAR_PROTO
 *   InnerSpec child order [0, 1], child size 32, prefix 0x01, EmptyChild = SHA256(0x02)
 * The object leg's key is the 8-byte id and its value the object's encoding;
 * the type leg's key is the 2-byte type and its value the counter followed
 * by the type root. A verifier that speaks ICS23 could check them with that
 * spec; the one here is a direct implementation of the same rules.
 *
 * Absence comes in two shapes. An instance at or past the type's counter was
 * never created, and the counter is bound into the type leaf, so no path in
 * the type tree is needed. An instance below the counter that was removed
 * has an empty leaf on an ordinary path. (ICS23 would instead prove the two
 * neighbouring leaves; with the empty-subtree rule both forms work.)
 *
 * A proof is about one height: the state after block `height`, which the
 * app hash in header height+1 commits to. Check it against that header and
 * that header's commit.
 */
import type { Reader } from '../codec/reader.ts';
import { decode } from '../codec/reader.ts';
import { encode, type Writer } from '../codec/writer.ts';
import { bytesEqual, HASH_SIZE } from '../crypto/hash.ts';
import { instanceOf, typeOf, type ObjectId } from './id.ts';
import { EMPTY, heightFor, leafHash, rootFromPath } from './merkle.ts';
import { smtProofRoot, type SmtProof } from './smt.ts';

export interface ObjectProof {
  /** The state height this proof describes. */
  height: bigint;
  id: ObjectId;
  /** The object's canonical encoding, or null for an absence proof. */
  value: Uint8Array | null;
  /** The type's instance counter at that height. */
  nextInstance: bigint;
  typeRoot: Uint8Array;
  typeSiblings: Uint8Array[];
  /** Roots of the type's authenticated indices, in definition order. */
  indexRoots: Uint8Array[];
  /** Position of the type among all registered types, and how many there are. */
  typeIndex: number;
  typeCount: number;
  topSiblings: Uint8Array[];
}

/** A proof about one key of one authenticated index: the sparse-tree leg and the type leg. */
export interface KeyProof {
  height: bigint;
  type: number;
  /** Which of the type's authenticated indices, in definition order. */
  indexPosition: number;
  key: Uint8Array;
  proof: SmtProof;
  nextInstance: bigint;
  typeRoot: Uint8Array;
  indexRoots: Uint8Array[];
  typeIndex: number;
  typeCount: number;
  topSiblings: Uint8Array[];
}

export function idKey(id: ObjectId): Uint8Array {
  return encode((w) => w.u64(id));
}

export function typeKey(type: number): Uint8Array {
  return encode((w) => w.u16(type));
}

export function typeValue(nextInstance: bigint, typeRoot: Uint8Array, indexRoots: Uint8Array[]): Uint8Array {
  return encode((w) => w.u64(nextInstance).fixed(typeRoot).array(indexRoots, (w, r) => w.fixed(r)));
}

export function objectLeaf(id: ObjectId, value: Uint8Array): Uint8Array {
  return leafHash(idKey(id), value);
}

export function typeLeaf(type: number, nextInstance: bigint, typeRoot: Uint8Array, indexRoots: Uint8Array[]): Uint8Array {
  return leafHash(typeKey(type), typeValue(nextInstance, typeRoot, indexRoots));
}

/** The type leg: from a type's leaf contents up to the app hash. */
export function typeLegMatches(appHash: Uint8Array, p: { type: number; nextInstance: bigint; typeRoot: Uint8Array; indexRoots: Uint8Array[]; typeIndex: number; typeCount: number; topSiblings: Uint8Array[] }): boolean {
  if (p.typeIndex >= p.typeCount || p.topSiblings.length !== heightFor(p.typeCount)) return false;
  const top = rootFromPath(typeLeaf(p.type, p.nextInstance, p.typeRoot, p.indexRoots), p.typeIndex, p.topSiblings);
  return bytesEqual(top, appHash);
}

/**
 * Check a key proof. Returns the value the key maps to, null if the key is
 * proven absent, or undefined if the proof does not lead to the app hash.
 */
export function verifyKeyProof(appHash: Uint8Array, p: KeyProof): Uint8Array | null | undefined {
  const folded = smtProofRoot(p.key, p.proof);
  if (!folded) return undefined;
  const root = p.indexRoots[p.indexPosition];
  if (!root || !bytesEqual(folded.root, root)) return undefined;
  if (!typeLegMatches(appHash, p)) return undefined;
  return folded.value;
}

export function verifyObjectProof(appHash: Uint8Array, p: ObjectProof): boolean {
  const type = typeOf(p.id);
  const instance = instanceOf(p.id);
  const count = Number(p.nextInstance);
  let typeRoot: Uint8Array;
  if (instance < count) {
    if (p.typeSiblings.length !== heightFor(count)) return false;
    const leaf = p.value === null ? EMPTY : objectLeaf(p.id, p.value);
    typeRoot = rootFromPath(leaf, instance, p.typeSiblings);
    if (!bytesEqual(typeRoot, p.typeRoot)) return false;
  } else {
    // Beyond the counter nothing can exist; the counter itself is what the top tree vouches for.
    if (p.value !== null || p.typeSiblings.length !== 0) return false;
    typeRoot = p.typeRoot;
  }
  return typeLegMatches(appHash, { ...p, type, typeRoot });
}

export function encodeProof(w: Writer, p: ObjectProof): void {
  w.u64(p.height)
    .u64(p.id)
    .option(p.value, (w, v) => w.bytes(v))
    .u64(p.nextInstance)
    .fixed(p.typeRoot)
    .array(p.typeSiblings, (w, s) => w.fixed(s))
    .array(p.indexRoots, (w, s) => w.fixed(s))
    .u32(p.typeIndex)
    .u32(p.typeCount)
    .array(p.topSiblings, (w, s) => w.fixed(s));
}

export function decodeProof(r: Reader): ObjectProof {
  return {
    height: r.u64(),
    id: r.u64(),
    value: r.option((r) => r.bytes()),
    nextInstance: r.u64(),
    typeRoot: r.fixed(HASH_SIZE),
    typeSiblings: r.array((r) => r.fixed(HASH_SIZE), 64),
    indexRoots: r.array((r) => r.fixed(HASH_SIZE), 16),
    typeIndex: r.u32(),
    typeCount: r.u32(),
    topSiblings: r.array((r) => r.fixed(HASH_SIZE), 64),
  };
}

export function proofToBytes(p: ObjectProof): Uint8Array {
  return encode((w) => encodeProof(w, p));
}

export function proofFromBytes(b: Uint8Array): ObjectProof {
  return decode(b, decodeProof);
}

export function encodeKeyProof(w: Writer, p: KeyProof): void {
  w.u64(p.height)
    .u16(p.type)
    .u8(p.indexPosition)
    .bytes(p.key)
    .array(p.proof.siblings, (w, s) => w.fixed(s))
    .option(p.proof.leaf, (w, l) => w.fixed(l.keyHash).bytes(l.value))
    .u64(p.nextInstance)
    .fixed(p.typeRoot)
    .array(p.indexRoots, (w, s) => w.fixed(s))
    .u32(p.typeIndex)
    .u32(p.typeCount)
    .array(p.topSiblings, (w, s) => w.fixed(s));
}

export function decodeKeyProof(r: Reader): KeyProof {
  return {
    height: r.u64(),
    type: r.u16(),
    indexPosition: r.u8(),
    key: r.bytes(4096),
    proof: {
      siblings: r.array((r) => r.fixed(HASH_SIZE), 256),
      leaf: r.option((r) => ({ keyHash: r.fixed(HASH_SIZE), value: r.bytes(4096) })),
    },
    nextInstance: r.u64(),
    typeRoot: r.fixed(HASH_SIZE),
    indexRoots: r.array((r) => r.fixed(HASH_SIZE), 16),
    typeIndex: r.u32(),
    typeCount: r.u32(),
    topSiblings: r.array((r) => r.fixed(HASH_SIZE), 64),
  };
}

export function keyProofToBytes(p: KeyProof): Uint8Array {
  return encode((w) => encodeKeyProof(w, p));
}

export function keyProofFromBytes(b: Uint8Array): KeyProof {
  return decode(b, decodeKeyProof);
}
