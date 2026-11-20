import type { Reader } from '../codec/reader.ts';
import type { Writer } from '../codec/writer.ts';
import { HASH_SIZE, bytesEqual, compareBytes } from '../crypto/hash.ts';
import { decodeSignature } from '../crypto/keys.ts';
import { MAX_VALIDATORS } from './validator.ts';
import { VoteType, decodeVote, encodeVote, sameVoteContent, type Vote } from './vote.ts';

/**
 * The faults punished on evidence in this chain. Three are proven by two
 * things one validator signed at one height (two votes, or two proposals), so
 * anyone holding both signatures can prove them and the proof is
 * self-contained. The fourth, a prevote that names a majority which never
 * was, is proven by that prevote and the prevotes of others. Downtime is
 * slashed too, by the application, from who signed each block's commit
 * (app/core/staking.ts); it needs no evidence.
 */
export type Evidence = DuplicateVoteEvidence | AmnesiaEvidence | DuplicateProposalEvidence | FalseCitationEvidence;

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
 * in which no such majority existed; that is the fourth kind.
 */
export interface AmnesiaEvidence {
  kind: 'amnesia';
  precommit: Vote;
  prevote: Vote;
}

/** What a proposer signs of a proposal, without the block: the round of the proof of lock, the block's hash, the signature. */
export interface ProposalHead {
  polRound: number;
  blockHash: Uint8Array;
  signature: Uint8Array;
}

/**
 * Two different proposals one validator signed for one height and round: another block, or the same block on
 * another proof-of-lock round. The blocks themselves are not carried; a proposal's signature is over the block's
 * hash (types/proposal.ts).
 */
export interface DuplicateProposalEvidence {
  kind: 'duplicateProposal';
  height: bigint;
  round: number;
  validatorIndex: number;
  a: ProposalHead;
  b: ProposalHead;
}

/**
 * A prevote for a block that names a round in which that block had no +2/3 prevotes. Nobody can show that votes do
 * not exist, but one can show votes that leave no room for them: `against` holds prevotes of the round named, one
 * a validator and none for the block, from more than two thirds of the power. A majority for the block
 * in that round would then have needed more than a third of the power to prevote twice in it. So this is proof of
 * the fault as long as less than a third of the power signs twice, the assumption everything else rests on; and
 * validators that did sign twice to make it are convicted by the two prevotes each.
 *
 * It proves less often than it happens: where a third or more of the power did prevote the block in the round
 * named, or did not prevote at all, the claim cannot be refuted, only left uncounted (consensus/votes.ts).
 */
export interface FalseCitationEvidence {
  kind: 'falseCitation';
  prevote: Vote;
  /** Prevotes of round `prevote.polRound`, in ascending order of validator index. */
  against: Vote[];
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

/** Canonical form: the head with the lower block hash first, then the lower polRound. */
export function makeDuplicateProposalEvidence(height: bigint, round: number, validatorIndex: number, x: ProposalHead, y: ProposalHead): DuplicateProposalEvidence {
  const [a, b] = compareHeads(x, y) <= 0 ? [x, y] : [y, x];
  return { kind: 'duplicateProposal', height, round, validatorIndex, a, b };
}

function compareHeads(a: ProposalHead, b: ProposalHead): number {
  const byHash = compareBytes(a.blockHash, b.blockHash);
  return byHash !== 0 ? byHash : a.polRound - b.polRound;
}

/** Whether `other` is a prevote that speaks against the majority `prevote` names: of the round named, and not for its block. */
export function speaksAgainst(prevote: Vote, other: Vote): boolean {
  return (
    prevote.type === VoteType.Prevote &&
    prevote.blockHash !== null &&
    prevote.polRound >= 0 &&
    other.type === VoteType.Prevote &&
    other.height === prevote.height &&
    other.round === prevote.polRound &&
    !bytesEqual(other.blockHash, prevote.blockHash)
  );
}

/** Structural check only; signatures, and the power behind a false citation's prevotes, are verified separately. Returns an error string or null. */
export function checkEvidenceShape(ev: Evidence): string | null {
  if (ev.kind === 'duplicateProposal') {
    if (!Number.isInteger(ev.round) || ev.round < 0) return 'bad round';
    for (const h of [ev.a, ev.b]) if (!Number.isInteger(h.polRound) || h.polRound < -1 || h.polRound >= ev.round) return 'polRound must be -1 or a round before the proposal\'s own';
    if (compareHeads(ev.a, ev.b) === 0) return 'proposals are the same';
    if (compareHeads(ev.a, ev.b) > 0) return 'proposals not in canonical order';
    return null;
  }
  if (ev.kind === 'falseCitation') {
    const p = ev.prevote;
    if (p.type !== VoteType.Prevote || p.blockHash === null || p.polRound < 0) return 'a false citation is a prevote for a block that names a round';
    if (ev.against.length === 0) return 'no prevotes against the round named';
    let last = -1;
    for (const v of ev.against) {
      if (v.type !== VoteType.Prevote) return 'only prevotes speak against a round of prevotes';
      if (v.height !== p.height) return 'heights differ';
      if (v.round !== p.polRound) return 'a prevote of another round than the one named';
      if (bytesEqual(v.blockHash, p.blockHash)) return 'a prevote for the block itself';
      if (v.validatorIndex <= last) return 'prevotes not in ascending order of validator';
      last = v.validatorIndex;
    }
    return null;
  }
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

/** The votes a piece of evidence carries, the accused's first. A duplicate proposal carries none. */
export function evidenceVotes(ev: Evidence): Vote[] {
  switch (ev.kind) {
    case 'duplicateVote':
      return [ev.voteA, ev.voteB];
    case 'amnesia':
      return [ev.precommit, ev.prevote];
    case 'duplicateProposal':
      return [];
    case 'falseCitation':
      return [ev.prevote, ...ev.against];
  }
}

/** The height of the fault, whose validator set the signatures are checked against and whose time the evidence is aged by. */
export function evidenceHeight(ev: Evidence): bigint {
  return ev.kind === 'duplicateProposal' ? ev.height : evidenceVotes(ev)[0]!.height;
}

/** The accused, by index into the set of that height. */
export function evidenceValidator(ev: Evidence): number {
  return ev.kind === 'duplicateProposal' ? ev.validatorIndex : evidenceVotes(ev)[0]!.validatorIndex;
}

/**
 * One key for one offence, so that a second proof of it is not taken in: a double sign is one slot (height, round,
 * type) of one validator, a double proposal one round of one validator, a forgotten lock or a false citation one
 * height of one validator, whichever of its votes show it.
 */
export function evidenceKey(ev: Evidence): string {
  switch (ev.kind) {
    case 'amnesia':
      return `amnesia/${ev.precommit.height}/${ev.precommit.validatorIndex}`;
    case 'duplicateProposal':
      return `proposal/${ev.height}/${ev.round}/${ev.validatorIndex}`;
    case 'falseCitation':
      return `citation/${ev.prevote.height}/${ev.prevote.validatorIndex}`;
    case 'duplicateVote':
      return `${ev.voteA.height}/${ev.voteA.round}/${ev.voteA.type}/${ev.voteA.validatorIndex}`;
  }
}

const TAG = { duplicateVote: 1, amnesia: 2, duplicateProposal: 3, falseCitation: 4 } as const;

export function encodeHead(w: Writer, h: ProposalHead): void {
  w.i64(BigInt(h.polRound));
  w.fixed(h.blockHash);
  w.fixed(h.signature);
}

export function decodeHead(r: Reader): ProposalHead {
  return { polRound: r.i53(), blockHash: r.fixed(HASH_SIZE), signature: decodeSignature(r) };
}

export function encodeEvidence(w: Writer, ev: Evidence): void {
  w.u8(TAG[ev.kind]);
  switch (ev.kind) {
    case 'duplicateVote':
      encodeVote(w, ev.voteA);
      encodeVote(w, ev.voteB);
      return;
    case 'amnesia':
      encodeVote(w, ev.precommit);
      encodeVote(w, ev.prevote);
      return;
    case 'duplicateProposal':
      w.u64(ev.height);
      w.u32(ev.round);
      w.u32(ev.validatorIndex);
      encodeHead(w, ev.a);
      encodeHead(w, ev.b);
      return;
    case 'falseCitation':
      encodeVote(w, ev.prevote);
      w.array(ev.against, encodeVote);
      return;
  }
}

export function decodeEvidence(r: Reader): Evidence {
  const tag = r.u8();
  if (tag === TAG.duplicateVote) return { kind: 'duplicateVote', voteA: decodeVote(r), voteB: decodeVote(r) };
  if (tag === TAG.amnesia) return { kind: 'amnesia', precommit: decodeVote(r), prevote: decodeVote(r) };
  if (tag === TAG.duplicateProposal) return { kind: 'duplicateProposal', height: r.u64(), round: r.u32(), validatorIndex: r.u32(), a: decodeHead(r), b: decodeHead(r) };
  if (tag === TAG.falseCitation) return { kind: 'falseCitation', prevote: decodeVote(r), against: r.array(decodeVote, MAX_VALIDATORS) };
  throw new Error(`unknown evidence kind ${tag}`);
}
