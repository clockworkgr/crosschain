/**
 * How chain values appear in JSON: bytes as lowercase hex, 64-bit integers as
 * decimal strings, object ids as "type.n", and proofs or raw transactions as
 * hex of the chain's own binary encoding so that the existing verifiers decode
 * them unchanged. Decoding back is explicit per shape, since JSON alone does
 * not say which strings were numbers.
 */
import { fromHex, toHex } from '../crypto/hash.ts';
import { idFromString, idToString } from '../db/id.ts';
import type { Commit, Header } from '../types/block.ts';
import { ValidatorSet } from '../types/validator.ts';
import type { TxQueryResult } from '../light/verify.ts';
import { resultProofFromBytes, resultProofToBytes, txProofFromBytes, txProofToBytes } from '../types/txproof.ts';

/** Keys whose bigint values are object ids. */
const ID_KEYS = new Set(['id', 'registrar', 'operator', 'delegator', 'validator', 'owner', 'asset', 'issuer', 'source', 'destination', 'proposer', 'coreAsset', 'account', 'signals', 'from', 'to', 'proposal']);

export function jsonify(value: unknown, key?: string): unknown {
  if (typeof value === 'bigint') return key !== undefined && ID_KEYS.has(key) ? idToString(value) : value.toString();
  if (value instanceof Uint8Array) return toHex(value);
  if (Array.isArray(value)) return value.map((v) => jsonify(v, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonify(v, k);
    return out;
  }
  return value;
}

export function parseId(s: unknown): bigint {
  if (typeof s !== 'string') throw new Error('object id must be a string "type.n"');
  return idFromString(s);
}

export function parseBigint(s: unknown, what = 'value'): bigint {
  if (typeof s === 'number') {
    if (!Number.isSafeInteger(s) || s < 0) throw new Error(`${what} must be a non-negative integer or a decimal string`);
    return BigInt(s);
  }
  if (typeof s !== 'string' || !/^\d+$/.test(s)) throw new Error(`${what} must be a decimal string`);
  return BigInt(s);
}

/** Hex of exactly `size` bytes: a hash or address field a header commits to must be whole, or bytes could move between fields. */
export function parseFixedHex(s: unknown, size: number, what: string): Uint8Array {
  const b = parseHex(s, what);
  if (b.length !== size) throw new Error(`${what} must be ${size} bytes`);
  return b;
}

export function parseHex(s: unknown, what = 'bytes'): Uint8Array {
  if (typeof s !== 'string') throw new Error(`${what} must be hex`);
  return fromHex(s);
}

export function headerFromJson(j: any): Header {
  if (!j || typeof j !== 'object' || typeof j.chainId !== 'string') throw new Error('header must be an object with a chainId');
  const version = Number(j.version);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('header version must be a non-negative integer');
  return {
    chainId: j.chainId,
    version,
    height: parseBigint(j.height, 'header height'),
    time: parseBigint(j.time, 'header time'),
    lastBlockHash: parseFixedHex(j.lastBlockHash, HASH_SIZE, 'lastBlockHash'),
    lastCommitHash: parseFixedHex(j.lastCommitHash, HASH_SIZE, 'lastCommitHash'),
    dataHash: parseFixedHex(j.dataHash, HASH_SIZE, 'dataHash'),
    lastResultsHash: parseFixedHex(j.lastResultsHash, HASH_SIZE, 'lastResultsHash'),
    validatorsHash: parseFixedHex(j.validatorsHash, HASH_SIZE, 'validatorsHash'),
    nextValidatorsHash: parseFixedHex(j.nextValidatorsHash, HASH_SIZE, 'nextValidatorsHash'),
    appHash: parseFixedHex(j.appHash, HASH_SIZE, 'appHash'),
    evidenceHash: parseFixedHex(j.evidenceHash, HASH_SIZE, 'evidenceHash'),
    proposerAddress: parseFixedHex(j.proposerAddress, HASH_SIZE, 'proposerAddress'),
  };
}

export function commitFromJson(j: any): Commit {
  if (!j || typeof j !== 'object' || !Array.isArray(j.signatures)) throw new Error('commit must be an object with signatures');
  const round = Number(j.round);
  if (!Number.isSafeInteger(round) || round < 0) throw new Error('commit round must be a non-negative integer');
  return {
    height: parseBigint(j.height, 'commit height'),
    round,
    blockHash: parseFixedHex(j.blockHash, HASH_SIZE, 'commit blockHash'),
    signatures: (j.signatures as unknown[]).map((s) => (s === null ? null : parseHex(s, 'signature'))),
  };
}

/** Headers commit to SHA-256 hashes, and an address is the hash of a public key. */
const HASH_SIZE = 32;

export function validatorSetToJson(set: ValidatorSet): unknown {
  return {
    hash: toHex(set.hash()),
    totalPower: set.totalPower.toString(),
    proposer: toHex(set.proposer().address),
    validators: set.validators.map((v) => ({ address: toHex(v.address), publicKey: toHex(v.publicKey), power: v.power.toString() })),
  };
}

/** Membership and powers come back; proposer priorities do not, which the light client never needs. */
export function validatorSetFromJson(j: any): ValidatorSet {
  return ValidatorSet.create((j.validators as any[]).map((v) => ({ publicKey: fromHex(v.publicKey), power: BigInt(v.power) })));
}

export function txQueryToJson(q: TxQueryResult): unknown {
  return {
    txProof: toHex(txProofToBytes(q.txProof)),
    header: jsonify(q.header),
    commit: jsonify(q.commit),
    resultProof: q.resultProof ? toHex(resultProofToBytes(q.resultProof)) : null,
    nextHeader: q.nextHeader ? jsonify(q.nextHeader) : null,
    nextCommit: q.nextCommit ? jsonify(q.nextCommit) : null,
  };
}

export function txQueryFromJson(j: any): TxQueryResult {
  return {
    txProof: txProofFromBytes(fromHex(j.txProof)),
    header: headerFromJson(j.header),
    commit: commitFromJson(j.commit),
    resultProof: j.resultProof ? resultProofFromBytes(fromHex(j.resultProof)) : null,
    nextHeader: j.nextHeader ? headerFromJson(j.nextHeader) : null,
    nextCommit: j.nextCommit ? commitFromJson(j.nextCommit) : null,
  };
}
