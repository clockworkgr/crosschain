/**
 * Transaction inclusion and result proofs. A block's dataHash is the root of
 * a dense Merkle tree over its transactions, keyed by position; the next
 * header's lastResultsHash is the same over each transaction's result. Both
 * reuse the state tree's hashing (db/merkle.ts), so a proof is a path of
 * siblings and the ICS23 leaf shape. A proof says where a transaction is and
 * what it is, and nothing about how many transactions the block has: the
 * root commits to the tree's height, which the path's length gives, but not
 * to the count, so a proof carrying one would be stating something it does
 * not prove. A leaf is hashed apart from an inner node, so a path of another
 * length cannot lead to the same root.
 */
import { decode, type Reader } from '../codec/reader.ts';
import { encode, type Writer } from '../codec/writer.ts';
import { bytesEqual, HASH_SIZE } from '../crypto/hash.ts';
import { DenseMerkleTree, EMPTY, leafHash, rootFromPath } from '../db/merkle.ts';
import type { TxResult } from '../app/types.ts';

function indexKey(i: number): Uint8Array {
  return encode((w) => w.u32(i));
}

export function txResultBytes(r: TxResult): Uint8Array {
  return encode((w) => w.u8(r.ok ? 1 : 0).string(r.error ?? ''));
}

function build(values: Uint8Array[]): { tree: DenseMerkleTree; root: Uint8Array } {
  const tree = new DenseMerkleTree();
  if (values.length === 0) return { tree, root: EMPTY };
  tree.resize(values.length);
  values.forEach((v, i) => tree.setLeaf(i, leafHash(indexKey(i), v)));
  return { tree, root: tree.root(0) };
}

export function txsRoot(txs: Uint8Array[]): Uint8Array {
  return build(txs).root;
}

export function resultsRoot(results: TxResult[]): Uint8Array {
  return build(results.map(txResultBytes)).root;
}

export interface TxProof {
  height: bigint;
  index: number;
  tx: Uint8Array;
  siblings: Uint8Array[];
}

export interface ResultProof {
  height: bigint;
  index: number;
  ok: boolean;
  error: string;
  siblings: Uint8Array[];
}

export function txProofFor(height: bigint, txs: Uint8Array[], index: number): TxProof {
  const { tree } = build(txs);
  return { height, index, tx: txs[index]!, siblings: tree.path(index) };
}

export function resultProofFor(height: bigint, results: TxResult[], index: number): ResultProof {
  const { tree } = build(results.map(txResultBytes));
  const r = results[index]!;
  return { height, index, ok: r.ok, error: r.error ?? '', siblings: tree.path(index) };
}

function pathMatches(root: Uint8Array, value: Uint8Array, index: number, siblings: Uint8Array[]): boolean {
  // The position must be one the path's length can address: rootFromPath reads only that many bits of it.
  if (!Number.isSafeInteger(index) || index < 0 || siblings.length > 32 || index >= 2 ** siblings.length) return false;
  return bytesEqual(rootFromPath(leafHash(indexKey(index), value), index, siblings), root);
}

/** Check against the dataHash of the header at proof.height. */
export function verifyTxProof(dataHash: Uint8Array, p: TxProof): boolean {
  return pathMatches(dataHash, p.tx, p.index, p.siblings);
}

/** Check against the lastResultsHash of the header at proof.height + 1. */
export function verifyResultProof(lastResultsHash: Uint8Array, p: ResultProof): boolean {
  return pathMatches(lastResultsHash, txResultBytes({ ok: p.ok, error: p.error }), p.index, p.siblings);
}

export function encodeTxProof(w: Writer, p: TxProof): void {
  w.u64(p.height).u32(p.index).bytes(p.tx).array(p.siblings, (w, s) => w.fixed(s));
}

export function decodeTxProof(r: Reader): TxProof {
  return { height: r.u64(), index: r.u32(), tx: r.bytes(), siblings: r.array((r) => r.fixed(HASH_SIZE), 32) };
}

export function encodeResultProof(w: Writer, p: ResultProof): void {
  w.u64(p.height).u32(p.index).bool(p.ok).string(p.error).array(p.siblings, (w, s) => w.fixed(s));
}

export function decodeResultProof(r: Reader): ResultProof {
  return { height: r.u64(), index: r.u32(), ok: r.bool(), error: r.string(), siblings: r.array((r) => r.fixed(HASH_SIZE), 32) };
}

export const txProofToBytes = (p: TxProof): Uint8Array => encode((w) => encodeTxProof(w, p));
export const txProofFromBytes = (b: Uint8Array): TxProof => decode(b, decodeTxProof);
export const resultProofToBytes = (p: ResultProof): Uint8Array => encode((w) => encodeResultProof(w, p));
export const resultProofFromBytes = (b: Uint8Array): ResultProof => decode(b, decodeResultProof);
