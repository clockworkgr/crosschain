import type { Reader } from '../codec/reader.ts';
import { Writer, encode } from '../codec/writer.ts';
import { HASH_SIZE, ZERO_HASH, sha256 } from '../crypto/hash.ts';
import { ADDRESS_SIZE, decodeSignature } from '../crypto/keys.ts';
import { decodeEvidence, encodeEvidence, type Evidence } from './evidence.ts';
import { MAX_VALIDATORS } from './validator.ts';

/**
 * Block header. Execution is deferred by one block: `appHash` and
 * `lastResultsHash` describe the state and the transaction results after
 * executing the *previous* block, because this block is proposed before
 * anyone has run it.
 */
export interface Header {
  chainId: string;
  /** Protocol version; validation rejects a header whose version differs from the chain's. */
  version: number;
  height: bigint;
  /** Unix milliseconds, set by the proposer. */
  time: bigint;
  lastBlockHash: Uint8Array;
  lastCommitHash: Uint8Array;
  /** Merkle root over the transactions (types/txproof.ts). */
  dataHash: Uint8Array;
  /** Merkle root over the results of executing block height-1. */
  lastResultsHash: Uint8Array;
  /** Hash of the validator set that must sign this block. */
  validatorsHash: Uint8Array;
  /** Hash of the validator set for the next height. Lets light clients follow set changes. */
  nextValidatorsHash: Uint8Array;
  /** App state hash after executing block height-1. */
  appHash: Uint8Array;
  evidenceHash: Uint8Array;
  proposerAddress: Uint8Array;
  /** Hash of the proposer priorities of this height's set and the next height's (types/validator.ts): with the two set hashes, the header names both sets exactly. */
  prioritiesHash: Uint8Array;
}

/**
 * The precommit signatures that finalised a block. `signatures[i]` belongs
 * to validator i of that height's set, or is null if that validator's
 * precommit was not seen. Signatures are not aggregated under either scheme,
 * so this is linear in the validator count.
 */
export interface Commit {
  height: bigint;
  round: number;
  blockHash: Uint8Array;
  signatures: (Uint8Array | null)[];
}

export interface Block {
  header: Header;
  txs: Uint8Array[];
  /** Commit for the previous block. null only at height 1. */
  lastCommit: Commit | null;
  evidence: Evidence[];
}

export function encodeHeader(w: Writer, h: Header): void {
  w.string(h.chainId);
  w.u32(h.version);
  w.u64(h.height);
  w.u64(h.time);
  w.fixed(h.lastBlockHash);
  w.fixed(h.lastCommitHash);
  w.fixed(h.dataHash);
  w.fixed(h.lastResultsHash);
  w.fixed(h.validatorsHash);
  w.fixed(h.nextValidatorsHash);
  w.fixed(h.appHash);
  w.fixed(h.evidenceHash);
  w.fixed(h.proposerAddress);
  w.fixed(h.prioritiesHash);
}

export function decodeHeader(r: Reader): Header {
  return {
    chainId: r.string(256),
    version: r.u32(),
    height: r.u64(),
    time: r.u64(),
    lastBlockHash: r.fixed(HASH_SIZE),
    lastCommitHash: r.fixed(HASH_SIZE),
    dataHash: r.fixed(HASH_SIZE),
    lastResultsHash: r.fixed(HASH_SIZE),
    validatorsHash: r.fixed(HASH_SIZE),
    nextValidatorsHash: r.fixed(HASH_SIZE),
    appHash: r.fixed(HASH_SIZE),
    evidenceHash: r.fixed(HASH_SIZE),
    proposerAddress: r.fixed(ADDRESS_SIZE),
    prioritiesHash: r.fixed(HASH_SIZE),
  };
}

/** The block hash is the header hash. The header commits to everything else. */
export function headerHash(h: Header): Uint8Array {
  return sha256(encode((w) => encodeHeader(w, h)));
}

export function blockHash(b: Block): Uint8Array {
  return headerHash(b.header);
}

export function txHash(tx: Uint8Array): Uint8Array {
  return sha256(tx);
}


export function encodeCommit(w: Writer, c: Commit): void {
  w.u64(c.height);
  w.u32(c.round);
  w.fixed(c.blockHash);
  w.array(c.signatures, (w, s) => w.option(s, (w, s) => w.fixed(s)));
}

export function decodeCommit(r: Reader): Commit {
  return {
    height: r.u64(),
    round: r.u32(),
    blockHash: r.fixed(HASH_SIZE),
    signatures: r.array((r) => r.option(decodeSignature), MAX_VALIDATORS),
  };
}

export function commitHash(c: Commit | null): Uint8Array {
  if (c === null) return ZERO_HASH;
  return sha256(encode((w) => encodeCommit(w, c)));
}

export function evidenceHash(evs: Evidence[]): Uint8Array {
  if (evs.length === 0) return ZERO_HASH;
  return sha256(encode((w) => w.array(evs, encodeEvidence)));
}

export function encodeBlock(w: Writer, b: Block): void {
  encodeHeader(w, b.header);
  w.array(b.txs, (w, tx) => w.bytes(tx));
  w.option(b.lastCommit, encodeCommit);
  w.array(b.evidence, encodeEvidence);
}

export function decodeBlock(r: Reader): Block {
  return {
    header: decodeHeader(r),
    txs: r.array((r) => r.bytes()),
    lastCommit: r.option(decodeCommit),
    evidence: r.array(decodeEvidence, 1000),
  };
}

/**
 * The bytes of what a proposer chooses to put in a block: its transactions and its evidence, as the block encodes
 * them. The chain's block size limit is on this. The header is of a fixed shape and the last commit has one
 * signature for each validator, so neither is the proposer's to make smaller, and a limit that counted them
 * could be one a large validator set cannot build an empty block under.
 */
export function blockDataBytes(b: Pick<Block, 'txs' | 'evidence'>): number {
  return encode((w) => {
    w.array(b.txs, (w, tx) => w.bytes(tx));
    w.array(b.evidence, encodeEvidence);
  }).length;
}

export function blockBytes(b: Block): Uint8Array {
  return encode((w) => encodeBlock(w, b));
}
