import type { Reader } from '../codec/reader.ts';
import { Writer, encode } from '../codec/writer.ts';
import { HASH_SIZE, bytesEqual, toHex } from '../crypto/hash.ts';
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
 *
 * A prevote for a block also says why its signer may vote for it: `polRound`
 * is the earlier round whose +2/3 prevotes for that block it relies on (the
 * proposal's polRound), or -1 for a block proposed fresh. A validator that has
 * precommitted a block is locked on it, and may prevote another only on the
 * strength of such a majority in the round it locked or a later one. Because
 * the claim is signed, a prevote that names too old a round, beside the
 * precommit it forgot, proves the fault (types/evidence.ts).
 */
export interface Vote {
  type: VoteType;
  height: bigint;
  round: number;
  /** null means a vote for "nil": no block this round. */
  blockHash: Uint8Array | null;
  /** In a prevote for a block, a round below the vote's own, or -1. Always -1 in a prevote for nil and in a precommit. */
  polRound: number;
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
    w.i64(BigInt(v.polRound));
  });
}

/** What a vote may say of a proof of lock. Returns an error string or null. */
export function checkPolRound(v: UnsignedVote): string | null {
  if (!Number.isInteger(v.polRound)) return 'polRound is not a whole number';
  if (v.type === VoteType.Precommit || v.blockHash === null) return v.polRound === -1 ? null : 'only a prevote for a block names a proof-of-lock round';
  return v.polRound >= -1 && v.polRound < v.round ? null : 'polRound must be -1 or a round before the vote\'s own';
}

/** Whether two votes say the same thing; two of one validator, height, round and type that do not are a double sign. */
export function sameVoteContent(a: UnsignedVote, b: UnsignedVote): boolean {
  return bytesEqual(a.blockHash, b.blockHash) && a.polRound === b.polRound;
}

export function encodeVote(w: Writer, v: Vote): void {
  w.u8(v.type);
  w.u64(v.height);
  w.u32(v.round);
  w.option(v.blockHash, (w, h) => w.fixed(h));
  w.i64(BigInt(v.polRound));
  w.u32(v.validatorIndex);
  w.fixed(v.signature);
}

export function decodeVote(r: Reader): Vote {
  const type = r.u8();
  if (type !== VoteType.Prevote && type !== VoteType.Precommit) throw new Error(`bad vote type ${type}`);
  const vote = {
    type,
    height: r.u64(),
    round: r.u32(),
    blockHash: r.option((r) => r.fixed(HASH_SIZE)),
    polRound: r.i53(),
    validatorIndex: r.u32(),
    signature: decodeSignature(r),
  };
  const bad = checkPolRound(vote);
  if (bad) throw new Error(bad);
  return vote;
}

export function blockHashKey(h: Uint8Array | null): string {
  return h === null ? 'nil' : toHex(h);
}
