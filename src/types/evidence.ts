import type { Reader } from '../codec/reader.ts';
import { Writer } from '../codec/writer.ts';
import { bytesEqual, compareBytes } from '../crypto/hash.ts';
import { decodeVote, encodeVote, type Vote } from './vote.ts';

/**
 * The one slashable fault in this chain: a validator signing two different
 * votes of the same type at the same height and round. Anyone holding both
 * signatures can prove it, and the proof is self-contained.
 */
export interface DuplicateVoteEvidence {
  voteA: Vote;
  voteB: Vote;
}

/** Canonical form: the vote with the lower block hash (nil lowest) comes first. */
export function makeDuplicateVoteEvidence(a: Vote, b: Vote): DuplicateVoteEvidence {
  const order = compareHashes(a.blockHash, b.blockHash);
  return order <= 0 ? { voteA: a, voteB: b } : { voteA: b, voteB: a };
}

function compareHashes(a: Uint8Array | null, b: Uint8Array | null): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  return compareBytes(a, b);
}

/** Structural check only; signatures are verified separately. Returns an error string or null. */
export function checkDuplicateVoteShape(ev: DuplicateVoteEvidence): string | null {
  const { voteA: a, voteB: b } = ev;
  if (a.height !== b.height) return 'heights differ';
  if (a.round !== b.round) return 'rounds differ';
  if (a.type !== b.type) return 'vote types differ';
  if (a.validatorIndex !== b.validatorIndex) return 'validators differ';
  if (bytesEqual(a.blockHash, b.blockHash)) return 'votes are for the same block';
  if (compareHashes(a.blockHash, b.blockHash) > 0) return 'votes not in canonical order';
  return null;
}

export function evidenceKey(ev: DuplicateVoteEvidence): string {
  const v = ev.voteA;
  return `${v.height}/${v.round}/${v.type}/${v.validatorIndex}`;
}

export function encodeEvidence(w: Writer, ev: DuplicateVoteEvidence): void {
  encodeVote(w, ev.voteA);
  encodeVote(w, ev.voteB);
}

export function decodeEvidence(r: Reader): DuplicateVoteEvidence {
  return { voteA: decodeVote(r), voteB: decodeVote(r) };
}
