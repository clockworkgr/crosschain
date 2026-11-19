import type { Reader } from '../codec/reader.ts';
import type { Writer } from '../codec/writer.ts';
import { bytesEqual, compareBytes } from '../crypto/hash.ts';
import { VoteType, decodeVote, encodeVote, sameVoteContent, type Vote } from './vote.ts';

/**
 * The faults punished on evidence in this chain. Each is proven by two votes
 * one validator signed at one height, so anyone holding both signatures can
 * prove it and the proof is self-contained. Downtime is slashed too, by the
 * application, from who signed each block's commit (app/core/staking.ts); it
 * needs no evidence.
 */
export type Evidence = DuplicateVoteEvidence | AmnesiaEvidence;

/** Two different votes of the same type at the same height and round. */
export interface DuplicateVoteEvidence {
  kind: 'duplicateVote';
  voteA: Vote;
  voteB: Vote;
}

/**
 * A lock forgotten. A validator that precommits a block is locked on it for
 * the rest of the height: in a later round it may prevote another block only
 * if that block had +2/3 prevotes in the round of the lock or after it, and
 * its prevote names that round (`polRound`). So a precommit for one block and
 * a prevote for another in a later round, naming a round before the
 * precommit's or none, are a fault whatever else happened: the validator said
 * itself that it knew of nothing that could release it.
 *
 * What this cannot show is a prevote that names a round at or after the lock
 * in which no such majority existed.
 */
export interface AmnesiaEvidence {
  kind: 'amnesia';
  precommit: Vote;
  prevote: Vote;
}

/** Canonical form: the vote with the lower block hash (nil lowest) comes first, then the lower polRound. */
export function makeDuplicateVoteEvidence(a: Vote, b: Vote): DuplicateVoteEvidence {
  return compareVotes(a, b) <= 0 ? { kind: 'duplicateVote', voteA: a, voteB: b } : { kind: 'duplicateVote', voteA: b, voteB: a };
}

function compareVotes(a: Vote, b: Vote): number {
  const byHash = compareHashes(a.blockHash, b.blockHash);
  return byHash !== 0 ? byHash : a.polRound - b.polRound;
}

function compareHashes(a: Uint8Array | null, b: Uint8Array | null): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  return compareBytes(a, b);
}

/**
 * Whether a precommit and a prevote of one validator at one height show a forgotten lock, in either order of
 * arrival. Consensus asks this of every pair it holds; the evidence check asks it of the pair it is given.
 */
export function isAmnesia(precommit: Vote, prevote: Vote): boolean {
  return (
    precommit.type === VoteType.Precommit &&
    prevote.type === VoteType.Prevote &&
    precommit.height === prevote.height &&
    precommit.validatorIndex === prevote.validatorIndex &&
    precommit.blockHash !== null &&
    prevote.blockHash !== null &&
    !bytesEqual(precommit.blockHash, prevote.blockHash) &&
    prevote.round > precommit.round &&
    prevote.polRound < precommit.round
  );
}

/** Structural check only; signatures are verified separately. Returns an error string or null. */
export function checkEvidenceShape(ev: Evidence): string | null {
  if (ev.kind === 'amnesia') {
    const { precommit: c, prevote: p } = ev;
    if (c.type !== VoteType.Precommit || p.type !== VoteType.Prevote) return 'amnesia evidence is a precommit and a prevote';
    if (c.height !== p.height) return 'heights differ';
    if (c.validatorIndex !== p.validatorIndex) return 'validators differ';
    if (c.blockHash === null || p.blockHash === null) return 'a vote for nil forgets no lock';
    if (bytesEqual(c.blockHash, p.blockHash)) return 'votes are for the same block';
    if (p.round <= c.round) return 'the prevote is not after the precommit';
    if (p.polRound >= c.round) return 'the prevote names a proof of lock at or after the precommit';
    return null;
  }
  const { voteA: a, voteB: b } = ev;
  if (a.height !== b.height) return 'heights differ';
  if (a.round !== b.round) return 'rounds differ';
  if (a.type !== b.type) return 'vote types differ';
  if (a.validatorIndex !== b.validatorIndex) return 'validators differ';
  if (sameVoteContent(a, b)) return 'votes are the same';
  if (compareVotes(a, b) > 0) return 'votes not in canonical order';
  return null;
}

/** The two votes, in the order they are written. */
export function evidenceVotes(ev: Evidence): [Vote, Vote] {
  return ev.kind === 'amnesia' ? [ev.precommit, ev.prevote] : [ev.voteA, ev.voteB];
}

/** The height of the fault, whose validator set the votes are checked against and whose time the evidence is aged by. */
export function evidenceHeight(ev: Evidence): bigint {
  return evidenceVotes(ev)[0].height;
}

/** The accused, by index into the set of that height. */
export function evidenceValidator(ev: Evidence): number {
  return evidenceVotes(ev)[0].validatorIndex;
}

/**
 * One key for one offence, so that a second proof of it is not taken in: a double sign is one slot (height, round,
 * type) of one validator, a forgotten lock one height of one validator, whichever of its votes show it.
 */
export function evidenceKey(ev: Evidence): string {
  if (ev.kind === 'amnesia') return `amnesia/${ev.precommit.height}/${ev.precommit.validatorIndex}`;
  const v = ev.voteA;
  return `${v.height}/${v.round}/${v.type}/${v.validatorIndex}`;
}

const TAG = { duplicateVote: 1, amnesia: 2 } as const;

export function encodeEvidence(w: Writer, ev: Evidence): void {
  w.u8(TAG[ev.kind]);
  const [a, b] = evidenceVotes(ev);
  encodeVote(w, a);
  encodeVote(w, b);
}

export function decodeEvidence(r: Reader): Evidence {
  const tag = r.u8();
  if (tag === TAG.duplicateVote) return { kind: 'duplicateVote', voteA: decodeVote(r), voteB: decodeVote(r) };
  if (tag === TAG.amnesia) return { kind: 'amnesia', precommit: decodeVote(r), prevote: decodeVote(r) };
  throw new Error(`unknown evidence kind ${tag}`);
}
