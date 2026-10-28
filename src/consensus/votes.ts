/**
 * Vote bookkeeping for one height.
 *
 * A VoteSet holds the votes of one type (prevote or precommit) for one
 * round, indexed by validator. It answers the questions the Tendermint rules
 * ask: is there +2/3 for *some* value, is there +2/3 for *this* value, and
 * what is the total power that has voted.
 *
 * It is also where double-signing is caught: a second vote from the same
 * validator for a different block is reported as a conflict.
 */
import { bytesEqual } from '../crypto/hash.ts';
import type { Commit } from '../types/block.ts';
import { blockHashKey, type Vote, type VoteType } from '../types/vote.ts';
import type { ValidatorSet } from '../types/validator.ts';

export class VoteSet {
  readonly height: bigint;
  readonly round: number;
  readonly type: VoteType;
  private readonly valset: ValidatorSet;
  private readonly votes: (Vote | null)[];
  private readonly powerByBlock = new Map<string, bigint>();
  private totalVoted = 0n;

  constructor(height: bigint, round: number, type: VoteType, valset: ValidatorSet) {
    this.height = height;
    this.round = round;
    this.type = type;
    this.valset = valset;
    this.votes = new Array(valset.size).fill(null);
  }

  add(vote: Vote): { added: boolean; conflict: Vote | null } {
    if (vote.height !== this.height || vote.round !== this.round || vote.type !== this.type) throw new Error('vote does not belong to this set');
    const val = this.valset.byIndex(vote.validatorIndex);
    if (!val) return { added: false, conflict: null };
    const existing = this.votes[vote.validatorIndex];
    if (existing) {
      if (bytesEqual(existing.blockHash, vote.blockHash)) return { added: false, conflict: null };
      return { added: false, conflict: existing };
    }
    this.votes[vote.validatorIndex] = vote;
    const k = blockHashKey(vote.blockHash);
    this.powerByBlock.set(k, (this.powerByBlock.get(k) ?? 0n) + val.power);
    this.totalVoted += val.power;
    return { added: true, conflict: null };
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

  add(vote: Vote): { added: boolean; conflict: Vote | null } {
    if (vote.height !== this.height) throw new Error('wrong height');
    return this.set(vote).add(vote);
  }

  has(vote: Vote): boolean {
    const rv = this.rounds.get(vote.round);
    if (!rv) return false;
    const existing = (vote.type === 1 ? rv.prevotes : rv.precommits).get(vote.validatorIndex);
    return existing !== null && bytesEqual(existing.blockHash, vote.blockHash);
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
