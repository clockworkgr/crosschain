/**
 * The private validator: the only component that holds the validator's
 * signing key, and the home of the double-sign guard.
 *
 * Before any vote or proposal is signed, the (height, round, step) is
 * compared against the last one signed. Signing anything at or before that
 * point is refused, with one exception: re-signing byte-identical content,
 * which returns the stored signature. The record is written to durable
 * storage before the signature is handed back, so a crash and restart can
 * never produce a conflicting vote. This is the single most common bug in
 * new consensus implementations and the one that gets validators slashed.
 *
 * The record also holds the validator's lock. A precommit for a block locks
 * the validator on it for the rest of the height, and the lock is written in
 * the same record as that precommit's signature, so it is durable before the
 * precommit can leave. A prevote for a block is then signed only if it names
 * a proof of lock from the round of the lock or a later one: for another
 * block that is the majority that releases the lock, and for the locked block
 * it is the majority the lock was taken on. A prevote that names an older
 * round or none could stand as evidence beside an earlier precommit of the
 * height, for the lock may have moved since. Consensus keeps the same rule, and reads the lock back from here after a restart; a
 * process that forgot its lock would otherwise prevote whatever was proposed
 * next, which is the fault amnesia evidence punishes (types/evidence.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { decode } from '../codec/reader.ts';
import { encode } from '../codec/writer.ts';
import { HASH_SIZE, bytesEqual } from '../crypto/hash.ts';
import { sign, signContext, type KeyPair } from '../crypto/keys.ts';
import { writeAtomic } from '../store/files.ts';
import { proposalSignBytes, type UnsignedProposal } from '../types/proposal.ts';
import { VoteType, checkPolRound, voteSignBytes, type UnsignedVote } from '../types/vote.ts';

export const SignStep = { Propose: 1, Prevote: 2, Precommit: 3 } as const;

/** The block a validator precommitted, and the round it did so in: the latest such round of the height. */
export interface Lock {
  height: bigint;
  round: number;
  blockHash: Uint8Array;
}

export interface LastSigned {
  height: bigint;
  round: number;
  step: number;
  signBytes: Uint8Array;
  signature: Uint8Array;
  lock: Lock | null;
}

export interface SignStateStore {
  load(): LastSigned | null;
  /** Must not return until the record is durable. */
  save(s: LastSigned): void;
}

export class MemorySignStateStore implements SignStateStore {
  private s: LastSigned | null = null;
  load() {
    return this.s;
  }
  save(s: LastSigned) {
    this.s = s;
  }
}

export class FileSignStateStore implements SignStateStore {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  load(): LastSigned | null {
    if (!existsSync(this.path)) return null;
    return decode(new Uint8Array(readFileSync(this.path)), (r) => ({
      height: r.u64(),
      round: r.u32(),
      step: r.u8(),
      signBytes: r.bytes(),
      signature: r.bytes(),
      lock: r.option((r) => ({ height: r.u64(), round: r.u32(), blockHash: r.fixed(HASH_SIZE) })),
    }));
  }
  save(s: LastSigned): void {
    writeAtomic(
      this.path,
      encode((w) => {
        w.u64(s.height);
        w.u32(s.round);
        w.u8(s.step);
        w.bytes(s.signBytes);
        w.bytes(s.signature);
        w.option(s.lock, (w, l) => w.u64(l.height).u32(l.round).fixed(l.blockHash));
      }),
    );
  }
}

export class DoubleSignError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DoubleSignError';
  }
}

export class PrivValidator {
  readonly address: Uint8Array;
  readonly publicKey: Uint8Array;
  private readonly key: KeyPair;
  private readonly store: SignStateStore;
  private readonly voteCtx: Uint8Array;
  private readonly proposalCtx: Uint8Array;
  private last: LastSigned | null;

  constructor(key: KeyPair, store: SignStateStore, chainId: string) {
    this.key = key;
    this.address = key.address;
    this.publicKey = key.publicKey;
    this.store = store;
    this.voteCtx = signContext(chainId, 'vote');
    this.proposalCtx = signContext(chainId, 'proposal');
    this.last = store.load();
  }

  /** Where the guard stands, so consensus can resume after a restart in a round it can still sign. */
  lastSigned(): { height: bigint; round: number; step: number } | null {
    return this.last ? { height: this.last.height, round: this.last.round, step: this.last.step } : null;
  }

  /** The lock held for a height, for consensus to take up after a restart. */
  lockAt(height: bigint): Lock | null {
    const lock = this.last?.lock;
    return lock && lock.height === height ? lock : null;
  }

  signVote(chainId: string, v: UnsignedVote): Uint8Array {
    const bad = checkPolRound(v);
    if (bad) throw new DoubleSignError(`refusing to sign a vote at ${v.height}/${v.round}: ${bad}`);
    const held = this.lockAt(v.height);
    if (v.type === VoteType.Prevote) {
      // Locked: a prevote for a block names a majority from the round of the lock or later, which for another block
      // is what releases the lock and for the locked block is what the lock stands on.
      if (held && v.blockHash !== null && v.polRound < held.round) {
        throw new DoubleSignError(`refusing to prevote a block at ${v.height}/${v.round}: locked in round ${held.round}, and the proof of lock named is from round ${v.polRound}`);
      }
      return this.guardedSign(v.height, v.round, SignStep.Prevote, voteSignBytes(chainId, v), this.voteCtx, held);
    }
    const lock = v.blockHash !== null ? { height: v.height, round: v.round, blockHash: v.blockHash } : held;
    return this.guardedSign(v.height, v.round, SignStep.Precommit, voteSignBytes(chainId, v), this.voteCtx, lock);
  }

  signProposal(chainId: string, p: UnsignedProposal): Uint8Array {
    return this.guardedSign(p.height, p.round, SignStep.Propose, proposalSignBytes(chainId, p), this.proposalCtx, this.lockAt(p.height));
  }

  /** `lock` is the lock as it stands once this is signed; it is written with the signature. */
  private guardedSign(height: bigint, round: number, step: number, signBytes: Uint8Array, ctx: Uint8Array, lock: Lock | null): Uint8Array {
    const last = this.last;
    if (last) {
      const cmp = height !== last.height ? (height < last.height ? -1 : 1) : round !== last.round ? round - last.round : step - last.step;
      if (cmp < 0) throw new DoubleSignError(`refusing to sign ${height}/${round}/${step}: already signed ${last.height}/${last.round}/${last.step}`);
      if (cmp === 0) {
        if (bytesEqual(signBytes, last.signBytes)) return last.signature;
        throw new DoubleSignError(`refusing to sign conflicting content at ${height}/${round}/${step}`);
      }
    }
    const signature = sign(signBytes, this.key.secretKey, ctx);
    const record: LastSigned = { height, round, step, signBytes, signature, lock };
    // Durable before anyone can broadcast it.
    this.store.save(record);
    this.last = record;
    return signature;
  }
}
