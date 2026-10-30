import type { Reader } from '../codec/reader.ts';
import { Writer } from '../codec/writer.ts';
import { HASH_SIZE, ZERO_HASH } from '../crypto/hash.ts';
import { isSchemeTag, schemeName, schemeOf, schemeTag, type SchemeTag } from '../crypto/keys.ts';
import { EMPTY } from '../db/merkle.ts';
import { blockHash, type Block } from './block.ts';
import type { Genesis } from './genesis.ts';
import { ValidatorSet, type ValidatorUpdate } from './validator.ts';

/**
 * Everything consensus needs to know about the chain between blocks.
 *
 * Three validator sets are kept because set changes take effect two heights
 * after the block that requested them:
 *   lastValidators  signed block lastHeight
 *   validators      will sign block lastHeight + 1
 *   nextValidators  will sign block lastHeight + 2
 * This keeps the set that commits a block equal to the one named in its
 * header, and gives light clients one header's notice of every change.
 */
export const PROTOCOL_VERSION = 1;

export interface ChainState {
  chainId: string;
  version: number;
  lastHeight: bigint;
  lastBlockHash: Uint8Array;
  lastBlockTime: bigint;
  /** App hash after executing lastHeight. Goes into the header of lastHeight + 1. */
  appHash: Uint8Array;
  /** Results root of lastHeight's transactions. Also goes into the next header. */
  lastResultsHash: Uint8Array;
  lastValidators: ValidatorSet;
  validators: ValidatorSet;
  nextValidators: ValidatorSet;
  /** The signature scheme every validator key must use, from genesis; the application holds the same for accounts and transactions. */
  scheme: SchemeTag;
}

export function genesisState(genesis: Genesis, appHash: Uint8Array, validatorsOverride?: ValidatorUpdate[]): ChainState {
  const entries = validatorsOverride && validatorsOverride.length > 0 ? validatorsOverride : (genesis.validators ?? []);
  if (entries.length === 0) throw new Error('genesis names no validators and the application supplied none');
  const scheme = schemeTag(genesis.signatureScheme ?? 'ml-dsa-44');
  for (const v of entries) if (schemeOf(v.publicKey) !== scheme) throw new Error(`genesis validator key is not a ${schemeName(scheme)} key`);
  const validators = ValidatorSet.create(entries.map((v) => ({ publicKey: v.publicKey, power: v.power })));
  const nextValidators = validators.copy();
  nextValidators.incrementProposerPriority(1);
  return {
    chainId: genesis.chainId,
    version: genesis.consensus?.version ?? PROTOCOL_VERSION,
    lastHeight: 0n,
    lastBlockHash: ZERO_HASH,
    lastBlockTime: genesis.genesisTime,
    appHash,
    lastResultsHash: EMPTY,
    lastValidators: validators.copy(),
    validators,
    nextValidators,
    scheme,
  };
}

/** The state after committing `block`, given the app's response to executing it. */
export function nextState(state: ChainState, block: Block, updates: ValidatorUpdate[], appHash: Uint8Array, resultsHash: Uint8Array): ChainState {
  if (block.header.height !== state.lastHeight + 1n) throw new Error('nextState: height mismatch');
  // The application refuses such a key in checkTx; a set that still carried one would halt here rather than sign with it.
  for (const u of updates) if (schemeOf(u.publicKey) !== state.scheme) throw new Error(`validator update key is not a ${schemeName(state.scheme)} key`);
  const nextNext = state.nextValidators.applyUpdates(updates);
  nextNext.incrementProposerPriority(1);
  return {
    chainId: state.chainId,
    version: state.version,
    lastHeight: block.header.height,
    lastBlockHash: blockHash(block),
    lastBlockTime: block.header.time,
    appHash,
    lastResultsHash: resultsHash,
    lastValidators: state.validators,
    validators: state.nextValidators,
    nextValidators: nextNext,
    scheme: state.scheme,
  };
}

export function encodeState(w: Writer, s: ChainState): void {
  w.string(s.chainId);
  w.u64(s.lastHeight);
  w.fixed(s.lastBlockHash);
  w.u64(s.lastBlockTime);
  w.fixed(s.appHash);
  s.lastValidators.encode(w);
  s.validators.encode(w);
  s.nextValidators.encode(w);
  w.u32(s.version);
  w.fixed(s.lastResultsHash);
  w.u8(s.scheme);
}

export function decodeState(r: Reader): ChainState {
  return {
    chainId: r.string(256),
    lastHeight: r.u64(),
    lastBlockHash: r.fixed(HASH_SIZE),
    lastBlockTime: r.u64(),
    appHash: r.fixed(HASH_SIZE),
    lastValidators: ValidatorSet.decode(r),
    validators: ValidatorSet.decode(r),
    nextValidators: ValidatorSet.decode(r),
    version: r.u32(),
    lastResultsHash: r.fixed(HASH_SIZE),
    scheme: readScheme(r),
  };
}

function readScheme(r: Reader): SchemeTag {
  const tag = r.u8();
  if (!isSchemeTag(tag)) throw new Error(`chain state names unknown signature scheme ${tag}`);
  return tag;
}
