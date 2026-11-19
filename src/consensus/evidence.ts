import { signContext } from '../crypto/keys.ts';
import type { Verifier } from '../crypto/verifier.ts';
import { checkEvidenceShape, encodeEvidence, evidenceKey, evidenceValidator, evidenceVotes, type Evidence } from '../types/evidence.ts';
import { encode } from '../codec/writer.ts';
import { sha256, toHex } from '../crypto/hash.ts';
import type { ValidatorSet } from '../types/validator.ts';
import { voteSignBytes } from '../types/vote.ts';

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
 * twice can do so at every height and round inside the window.
 */
export class EvidencePool {
  /** The most evidence that waits for a block; a block carries far less, and one piece is enough to punish a validator. */
  static readonly MAX_PENDING = 1000;
  private readonly pending = new Map<string, Evidence>();
  private readonly committed = new Map<string, Evidence>();
  private readonly byHash = new Map<string, Evidence>();
  private readonly listeners: ((ev: Evidence) => void)[] = [];

  add(ev: Evidence): boolean {
    const k = evidenceKey(ev);
    if (this.pending.has(k) || this.committed.has(k)) return false;
    if (this.pending.size >= EvidencePool.MAX_PENDING) return false;
    this.pending.set(k, ev);
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
      this.pending.delete(k);
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
        held.delete(k);
        this.byHash.delete(toHex(evidenceId(ev)));
      }
    }
  }

  get size(): number {
    return this.pending.size;
  }

  /** Everything held, for tests and status: pending, committed and the inventory. */
  get held(): { pending: number; committed: number; inventory: number } {
    return { pending: this.pending.size, committed: this.committed.size, inventory: this.byHash.size };
  }
}

/** Full verification: shape plus both signatures against the validator set of that height. */
export async function verifyEvidence(chainId: string, ev: Evidence, valset: ValidatorSet, verifier: Verifier): Promise<string | null> {
  const shape = checkEvidenceShape(ev);
  if (shape) return shape;
  const val = valset.byIndex(evidenceValidator(ev));
  if (!val) return 'unknown validator index';
  const ctx = signContext(chainId, 'vote');
  const results = await verifier.verify(evidenceVotes(ev).map((v) => ({ sig: v.signature, msg: voteSignBytes(chainId, v), publicKey: val.publicKey, context: ctx })));
  if (results.some((ok) => !ok)) return 'bad signature in evidence';
  return null;
}
