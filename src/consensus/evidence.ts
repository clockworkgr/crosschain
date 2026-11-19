import { signContext } from '../crypto/keys.ts';
import type { Verifier } from '../crypto/verifier.ts';
import { checkEvidenceShape, encodeEvidence, evidenceKey, evidenceValidator, evidenceVotes, type Evidence } from '../types/evidence.ts';
import { encode } from '../codec/writer.ts';
import { sha256, toHex } from '../crypto/hash.ts';
import { proposalHeadSignBytes } from '../types/proposal.ts';
import type { ValidatorSet } from '../types/validator.ts';
import { voteSignBytes } from '../types/vote.ts';

/** What one piece of evidence encodes to. */
export function evidenceBytes(ev: Evidence): number {
  return encode((w) => encodeEvidence(w, ev)).length;
}

/** The inventory key of one piece of evidence (the header's `evidenceHash` in types/block.ts is the root over a list). */
export function evidenceId(ev: Evidence): Uint8Array {
  return sha256(encode((w) => encodeEvidence(w, ev)));
}

/**
 * Evidence waiting to be included in a block. Nodes that saw both votes build
 * it themselves; it is also gossiped by inventory (node.ts) so a proposer that
 * missed the votes still includes it. The inventory hash is the hash of the
 * encoded evidence.
 *
 * Everything the pool holds is let go when it is too old for any block to
 * carry (pruneIf): what is pending, what was committed (kept until then so
 * that it is not taken in a second time) and the inventory of both. What is
 * pending is bounded in number as well, since a validator willing to sign
 * twice can do so at every height and round inside the window, and in bytes:
 * a record larger than a block builder would give evidence (`maxRecordBytes`,
 * which the node sets from the chain's block size) is not taken in, on any
 * node, and all that waits may come to `MAX_PENDING_BYTES`. Most records are
 * two signatures; a false citation carries a vote for most of the set.
 */
export class EvidencePool {
  /** The most evidence that waits for a block; a block carries far less, and one piece is enough to punish a validator. */
  static readonly MAX_PENDING = 1000;
  /** The most bytes of evidence that wait for a block. */
  static readonly MAX_PENDING_BYTES = 32 * 1024 * 1024;
  /** The most one record may encode to and still wait here; more would fit no block a proposer builds. */
  maxRecordBytes = Infinity;
  private pendingBytes = 0;
  private readonly sizes = new Map<string, number>();
  private readonly pending = new Map<string, Evidence>();
  private readonly committed = new Map<string, Evidence>();
  private readonly byHash = new Map<string, Evidence>();
  private readonly listeners: ((ev: Evidence) => void)[] = [];

  add(ev: Evidence): boolean {
    const k = evidenceKey(ev);
    if (this.pending.has(k) || this.committed.has(k)) return false;
    if (this.pending.size >= EvidencePool.MAX_PENDING) return false;
    const size = evidenceBytes(ev);
    if (size > this.maxRecordBytes || this.pendingBytes + size > EvidencePool.MAX_PENDING_BYTES) return false;
    this.pending.set(k, ev);
    this.sizes.set(k, size);
    this.pendingBytes += size;
    this.byHash.set(toHex(evidenceId(ev)), ev);
    for (const fn of this.listeners) fn(ev);
    return true;
  }

  onAdded(fn: (ev: Evidence) => void): void {
    this.listeners.push(fn);
  }

  getByHash(hash: Uint8Array): Evidence | undefined {
    return this.byHash.get(toHex(hash));
  }

  hasHash(hash: Uint8Array): boolean {
    return this.byHash.has(toHex(hash));
  }

  has(ev: Evidence): boolean {
    const k = evidenceKey(ev);
    return this.pending.has(k) || this.committed.has(k);
  }

  list(max = 100): Evidence[] {
    return [...this.pending.values()].slice(0, max);
  }

  markCommitted(evs: Evidence[]): void {
    for (const ev of evs) {
      const k = evidenceKey(ev);
      // What waited for the same offence may be another pair of votes, under another hash: its inventory entry goes too.
      const waiting = this.pending.get(k);
      if (waiting) this.byHash.delete(toHex(evidenceId(waiting)));
      this.forget(k);
      this.committed.set(k, ev);
      // Evidence that came in a block without passing through the pool is served by hash like the rest.
      this.byHash.set(toHex(evidenceId(ev)), ev);
    }
  }

  /** Forget evidence that no block could carry any more, pending or committed, and its inventory entry. */
  pruneIf(stale: (ev: Evidence) => boolean): void {
    for (const held of [this.pending, this.committed]) {
      for (const [k, ev] of held) {
        if (!stale(ev)) continue;
        if (held === this.pending) this.forget(k);
        held.delete(k);
        this.byHash.delete(toHex(evidenceId(ev)));
      }
    }
  }

  /** Take a record out of what waits, with its bytes. */
  private forget(k: string): void {
    if (!this.pending.delete(k)) return;
    this.pendingBytes -= this.sizes.get(k) ?? 0;
    this.sizes.delete(k);
  }

  get size(): number {
    return this.pending.size;
  }

  /** The bytes of what waits. */
  get bytes(): number {
    return this.pendingBytes;
  }

  /** Everything held, for tests and status: pending, committed and the inventory. */
  get held(): { pending: number; committed: number; inventory: number } {
    return { pending: this.pending.size, committed: this.committed.size, inventory: this.byHash.size };
  }
}

/**
 * Full verification: shape, then every signature against the validator set of that height, and for a false
 * citation the power behind the prevotes that speak against it, which must be +2/3 of that set.
 */
export async function verifyEvidence(chainId: string, ev: Evidence, valset: ValidatorSet, verifier: Verifier): Promise<string | null> {
  const shape = checkEvidenceShape(ev);
  if (shape) return shape;
  const val = valset.byIndex(evidenceValidator(ev));
  if (!val) return 'unknown validator index';
  let jobs;
  if (ev.kind === 'duplicateProposal') {
    const ctx = signContext(chainId, 'proposal');
    jobs = [ev.a, ev.b].map((h) => ({ sig: h.signature, msg: proposalHeadSignBytes(chainId, ev.height, ev.round, h.polRound, h.blockHash), publicKey: val.publicKey, context: ctx }));
  } else {
    const ctx = signContext(chainId, 'vote');
    jobs = [];
    let against = 0n;
    for (const [i, v] of evidenceVotes(ev).entries()) {
      // Each vote under the key of its own signer: in a false citation only the first is the accused's.
      const signer = valset.byIndex(v.validatorIndex);
      if (!signer) return 'unknown validator index';
      if (i > 0) against += signer.power;
      jobs.push({ sig: v.signature, msg: voteSignBytes(chainId, v), publicKey: signer.publicKey, context: ctx });
    }
    if (ev.kind === 'falseCitation' && !valset.isQuorum(against)) return 'the prevotes against the round named are not +2/3 of the power';
  }
  const results = await verifier.verify(jobs);
  if (results.some((ok) => !ok)) return 'bad signature in evidence';
  return null;
}
