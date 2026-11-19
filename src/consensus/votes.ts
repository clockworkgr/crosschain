/**
 * Vote bookkeeping for one height.
 *
 * A VoteSet holds the votes of one type (prevote or precommit) for one
 * round, indexed by validator. It answers the questions the Tendermint rules
 * ask: is there +2/3 for *some* value, is there +2/3 for *this* value, and
 * what is the total power that has voted.
 *
 * It is also where double-signing is caught: a second vote from the same
 * validator that says something else is reported as a conflict.
 *
 * A prevote for a block that names a proof-of-lock round counts for its
 * block only once this node holds, counted the same way, +2/3 prevotes for
 * that block in the round named (HeightVoteSet). The vote is held and counts
 * as a vote cast in the meantime. A prevote that names a majority which never
 * was therefore helps no quorum at an honest node, and a validator that
 * leaves a lock can do so only on a majority that exists or by naming a
 * round before its lock, which its own two votes then prove.
 */
import { bytesEqual } from '../crypto/hash.ts';
import type { Commit } from '../types/block.ts';
import { blockHashKey, sameVoteContent, type Vote, type VoteType } from '../types/vote.ts';
import type { ValidatorSet } from '../types/validator.ts';

export class VoteSet {
  readonly height: bigint;
  readonly round: number;
  readonly type: VoteType;
  private readonly valset: ValidatorSet;
  private readonly votes: (Vote | null)[];
  /** Power behind each value, of the votes that count for it. */
  private readonly powerByBlock = new Map<string, bigint>();
  /** Prevotes held whose proof of lock this node does not hold yet, by validator index. */
  private readonly waiting = new Set<number>();
  private totalVoted = 0n;

  constructor(height: bigint, round: number, type: VoteType, valset: ValidatorSet) {
    this.height = height;
    this.round = round;
    this.type = type;
    this.valset = valset;
    this.votes = new Array(valset.size).fill(null);
  }

  /** `backed` false holds the vote without counting it for its block; `back` counts it later. */
  add(vote: Vote, backed = true): { added: boolean; conflict: Vote | null } {
    if (vote.height !== this.height || vote.round !== this.round || vote.type !== this.type) throw new Error('vote does not belong to this set');
    const val = this.valset.byIndex(vote.validatorIndex);
    if (!val) return { added: false, conflict: null };
    const existing = this.votes[vote.validatorIndex];
    if (existing) {
      // The same vote again is nothing; another vote in the same place is a double sign, whether it differs in the
      // block or only in the proof of lock it names.
      if (sameVoteContent(existing, vote)) return { added: false, conflict: null };
      // Of two votes in one place the one that counts is kept: a validator that signs twice must not be able to
      // leave a node holding only the vote that waits for a majority that will never come.
      if (backed && this.waiting.delete(vote.validatorIndex)) {
        this.votes[vote.validatorIndex] = vote;
        this.count(vote, val.power);
      }
      return { added: false, conflict: existing };
    }
    this.votes[vote.validatorIndex] = vote;
    this.totalVoted += val.power;
    if (backed) this.count(vote, val.power);
    else this.waiting.add(vote.validatorIndex);
    return { added: true, conflict: null };
  }

  private count(vote: Vote, power: bigint): void {
    const k = blockHashKey(vote.blockHash);
    this.powerByBlock.set(k, (this.powerByBlock.get(k) ?? 0n) + power);
  }

  /** The votes held and not counted that name `polRound` for `blockHash`. */
  waitingOn(polRound: number, blockHash: Uint8Array): Vote[] {
    const out: Vote[] = [];
    for (const i of this.waiting) {
      const v = this.votes[i]!;
      if (v.polRound === polRound && bytesEqual(v.blockHash, blockHash)) out.push(v);
    }
    return out;
  }

  /** Count a vote that was waiting: the majority it names is held now. */
  back(validatorIndex: number): void {
    if (!this.waiting.delete(validatorIndex)) return;
    this.count(this.votes[validatorIndex]!, this.valset.byIndex(validatorIndex)!.power);
  }

  has(validatorIndex: number): boolean {
    return this.votes[validatorIndex] != null;
  }

  get(validatorIndex: number): Vote | null {
    return this.votes[validatorIndex] ?? null;
  }

  power(): bigint {
    return this.totalVoted;
  }

  /** +2/3 of validators have voted in this round, for anything. */
  hasQuorumAny(): boolean {
    return this.valset.isQuorum(this.totalVoted);
  }

  hasQuorumFor(blockHash: Uint8Array | null): boolean {
    return this.valset.isQuorum(this.powerByBlock.get(blockHashKey(blockHash)) ?? 0n);
  }

  /** The block hash (or null for nil) with +2/3, or undefined if none. */
  quorumValue(): Uint8Array | null | undefined {
    for (const [k, p] of this.powerByBlock) {
      if (this.valset.isQuorum(p)) {
        if (k === 'nil') return null;
        for (const v of this.votes) if (v && blockHashKey(v.blockHash) === k) return v.blockHash;
      }
    }
    return undefined;
  }

  all(): Vote[] {
    return this.votes.filter((v): v is Vote => v !== null);
  }

  voterIndices(): number[] {
    const out: number[] = [];
    this.votes.forEach((v, i) => {
      if (v) out.push(i);
    });
    return out;
  }

  /** Build a Commit from the precommits for `blockHash`. */
  toCommit(blockHash: Uint8Array): Commit {
    return {
      height: this.height,
      round: this.round,
      blockHash,
      signatures: this.votes.map((v) => (v && v.blockHash && bytesEqual(v.blockHash, blockHash) ? v.signature : null)),
    };
  }
}

interface RoundVotes {
  prevotes: VoteSet;
  precommits: VoteSet;
}

export class HeightVoteSet {
  readonly height: bigint;
  private readonly valset: ValidatorSet;
  private readonly rounds = new Map<number, RoundVotes>();

  constructor(height: bigint, valset: ValidatorSet) {
    this.height = height;
    this.valset = valset;
  }

  private round(r: number): RoundVotes {
    let rv = this.rounds.get(r);
    if (!rv) {
      rv = { prevotes: new VoteSet(this.height, r, 1, this.valset), precommits: new VoteSet(this.height, r, 2, this.valset) };
      this.rounds.set(r, rv);
    }
    return rv;
  }

  prevotes(r: number): VoteSet {
    return this.round(r).prevotes;
  }

  precommits(r: number): VoteSet {
    return this.round(r).precommits;
  }

  set(vote: Vote): VoteSet {
    return vote.type === 1 ? this.prevotes(vote.round) : this.precommits(vote.round);
  }

  /**
   * A prevote that names a proof-of-lock round is counted for its block if the prevotes counted in that round have
   * +2/3 for the block, and waits otherwise. A vote that completes such a majority releases the votes waiting on
   * it, in whatever round they are, and those may complete majorities others wait on.
   */
  add(vote: Vote): { added: boolean; conflict: Vote | null } {
    if (vote.height !== this.height) throw new Error('wrong height');
    const cites = vote.type === 1 && vote.blockHash !== null && vote.polRound >= 0;
    const result = this.set(vote).add(vote, !cites || this.prevotes(vote.polRound).hasQuorumFor(vote.blockHash));
    // Also when the vote was not added: of two votes in one place the counted one is kept, which may have counted this one.
    if (vote.type === 1 && vote.blockHash !== null) this.release(vote.round, vote.blockHash);
    return result;
  }

  private release(round: number, blockHash: Uint8Array): void {
    const completed = [round];
    for (let r = completed.pop(); r !== undefined; r = completed.pop()) {
      if (!this.prevotes(r).hasQuorumFor(blockHash)) continue;
      for (const [later, rv] of this.rounds) {
        if (later <= r) continue;
        const waiting = rv.prevotes.waitingOn(r, blockHash);
        for (const v of waiting) rv.prevotes.back(v.validatorIndex);
        if (waiting.length > 0) completed.push(later);
      }
    }
  }

  has(vote: Vote): boolean {
    const rv = this.rounds.get(vote.round);
    if (!rv) return false;
    const existing = (vote.type === 1 ? rv.prevotes : rv.precommits).get(vote.validatorIndex);
    return existing !== null && sameVoteContent(existing, vote);
  }

  /** Power of validators that have cast any vote in round r. Used to detect that the network has moved on. */
  roundPower(r: number): bigint {
    const rv = this.rounds.get(r);
    if (!rv) return 0n;
    const seen = new Set<number>([...rv.prevotes.voterIndices(), ...rv.precommits.voterIndices()]);
    let p = 0n;
    for (const i of seen) p += this.valset.byIndex(i)!.power;
    return p;
  }

  /** Every vote held for this height, all rounds and both types. */
  allVotes(): Vote[] {
    const out: Vote[] = [];
    for (const rv of this.rounds.values()) out.push(...rv.prevotes.all(), ...rv.precommits.all());
    return out;
  }

  roundNumbers(): number[] {
    return [...this.rounds.keys()].sort((a, b) => a - b);
  }
}
