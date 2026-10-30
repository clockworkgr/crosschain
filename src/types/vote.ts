import type { Reader } from '../codec/reader.ts';
import { Writer, encode } from '../codec/writer.ts';
import { HASH_SIZE, toHex } from '../crypto/hash.ts';
import { decodeSignature } from '../crypto/keys.ts';

export const VoteType = { Prevote: 1, Precommit: 2 } as const;
export type VoteType = (typeof VoteType)[keyof typeof VoteType];

export function voteTypeName(t: VoteType): string {
  return t === VoteType.Prevote ? 'prevote' : 'precommit';
}

/**
 * A vote carries no timestamp: block time is set by the proposer, so there is
 * nothing for votes to say about time. The validator is referenced by index
 * into the validator set of that height.
 */
export interface Vote {
  type: VoteType;
  height: bigint;
  round: number;
  /** null means a vote for "nil": no block this round. */
  blockHash: Uint8Array | null;
  validatorIndex: number;
  signature: Uint8Array;
}

export type UnsignedVote = Omit<Vote, 'signature'>;

/** The bytes a validator signs. Chain id is also in the signing context, but repeating it here costs nothing. */
export function voteSignBytes(chainId: string, v: UnsignedVote): Uint8Array {
  return encode((w) => {
    w.string(chainId);
    w.u8(v.type);
    w.u64(v.height);
    w.u32(v.round);
    w.option(v.blockHash, (w, h) => w.fixed(h));
  });
}

export function encodeVote(w: Writer, v: Vote): void {
  w.u8(v.type);
  w.u64(v.height);
  w.u32(v.round);
  w.option(v.blockHash, (w, h) => w.fixed(h));
  w.u32(v.validatorIndex);
  w.fixed(v.signature);
}

export function decodeVote(r: Reader): Vote {
  const type = r.u8();
  if (type !== VoteType.Prevote && type !== VoteType.Precommit) throw new Error(`bad vote type ${type}`);
  return {
    type,
    height: r.u64(),
    round: r.u32(),
    blockHash: r.option((r) => r.fixed(HASH_SIZE)),
    validatorIndex: r.u32(),
    signature: decodeSignature(r),
  };
}

export function blockHashKey(h: Uint8Array | null): string {
  return h === null ? 'nil' : toHex(h);
}
