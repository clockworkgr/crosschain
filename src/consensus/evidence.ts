import { signContext } from '../crypto/keys.ts';
import type { Verifier } from '../crypto/verifier.ts';
import { checkDuplicateVoteShape, encodeEvidence, evidenceKey, type DuplicateVoteEvidence } from '../types/evidence.ts';
import { encode } from '../codec/writer.ts';
import { sha256, toHex } from '../crypto/hash.ts';

/** The inventory key of one piece of evidence (the header's `evidenceHash` in types/block.ts is the root over a list). */
export function evidenceId(ev: DuplicateVoteEvidence): Uint8Array {
  return sha256(encode((w) => encodeEvidence(w, ev)));
}
import type { ValidatorSet } from '../types/validator.ts';
import { voteSignBytes } from '../types/vote.ts';

/**
 * Evidence waiting to be included in a block. Nodes that saw both votes build
 * it themselves; it is also gossiped by inventory (node.ts) so a proposer that
 * missed the votes still includes it. The inventory hash is the hash of the
 * encoded evidence.
 */
export class EvidencePool {
  private readonly pending = new Map<string, DuplicateVoteEvidence>();
  private readonly committed = new Set<string>();
  private readonly byHash = new Map<string, DuplicateVoteEvidence>();
  private readonly listeners: ((ev: DuplicateVoteEvidence) => void)[] = [];

  add(ev: DuplicateVoteEvidence): boolean {
    const k = evidenceKey(ev);
    if (this.pending.has(k) || this.committed.has(k)) return false;
    this.pending.set(k, ev);
    this.byHash.set(toHex(evidenceId(ev)), ev);
    for (const fn of this.listeners) fn(ev);
    return true;
  }

  onAdded(fn: (ev: DuplicateVoteEvidence) => void): void {
    this.listeners.push(fn);
  }

  getByHash(hash: Uint8Array): DuplicateVoteEvidence | undefined {
    return this.byHash.get(toHex(hash));
  }

  hasHash(hash: Uint8Array): boolean {
    return this.byHash.has(toHex(hash));
  }

  has(ev: DuplicateVoteEvidence): boolean {
    const k = evidenceKey(ev);
    return this.pending.has(k) || this.committed.has(k);
  }

  list(max = 100): DuplicateVoteEvidence[] {
    return [...this.pending.values()].slice(0, max);
  }

  markCommitted(evs: DuplicateVoteEvidence[]): void {
    for (const ev of evs) {
      const k = evidenceKey(ev);
      this.pending.delete(k);
      this.committed.add(k);
    }
  }

  /** Forget pending evidence that no block could carry any more. */
  pruneIf(stale: (ev: DuplicateVoteEvidence) => boolean): void {
    for (const [k, ev] of this.pending) if (stale(ev)) this.pending.delete(k);
  }

  get size(): number {
    return this.pending.size;
  }
}

/** Full verification: shape plus both signatures against the validator set of that height. */
export async function verifyDuplicateVoteEvidence(
  chainId: string,
  ev: DuplicateVoteEvidence,
  valset: ValidatorSet,
  verifier: Verifier,
): Promise<string | null> {
  const shape = checkDuplicateVoteShape(ev);
  if (shape) return shape;
  const val = valset.byIndex(ev.voteA.validatorIndex);
  if (!val) return 'unknown validator index';
  const ctx = signContext(chainId, 'vote');
  const [a, b] = await verifier.verify([
    { sig: ev.voteA.signature, msg: voteSignBytes(chainId, ev.voteA), publicKey: val.publicKey, context: ctx },
    { sig: ev.voteB.signature, msg: voteSignBytes(chainId, ev.voteB), publicKey: val.publicKey, context: ctx },
  ]);
  if (!a || !b) return 'bad signature in evidence';
  return null;
}
