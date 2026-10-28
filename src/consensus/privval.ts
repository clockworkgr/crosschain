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
 */
import { existsSync, readFileSync } from 'node:fs';
import { decode } from '../codec/reader.ts';
import { encode } from '../codec/writer.ts';
import { bytesEqual } from '../crypto/hash.ts';
import { sign, signContext, type KeyPair } from '../crypto/keys.ts';
import { writeAtomic } from '../store/files.ts';
import { proposalSignBytes, type UnsignedProposal } from '../types/proposal.ts';
import { VoteType, voteSignBytes, type UnsignedVote } from '../types/vote.ts';

export const SignStep = { Propose: 1, Prevote: 2, Precommit: 3 } as const;

export interface LastSigned {
  height: bigint;
  round: number;
  step: number;
  signBytes: Uint8Array;
  signature: Uint8Array;
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

  signVote(chainId: string, v: UnsignedVote): Uint8Array {
    const step = v.type === VoteType.Prevote ? SignStep.Prevote : SignStep.Precommit;
    return this.guardedSign(v.height, v.round, step, voteSignBytes(chainId, v), this.voteCtx);
  }

  signProposal(chainId: string, p: UnsignedProposal): Uint8Array {
    return this.guardedSign(p.height, p.round, SignStep.Propose, proposalSignBytes(chainId, p), this.proposalCtx);
  }

  private guardedSign(height: bigint, round: number, step: number, signBytes: Uint8Array, ctx: Uint8Array): Uint8Array {
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
    const record: LastSigned = { height, round, step, signBytes, signature };
    // Durable before anyone can broadcast it.
    this.store.save(record);
    this.last = record;
    return signature;
  }
}
