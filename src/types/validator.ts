/**
 * Validator set and proposer selection.
 *
 * Proposer selection is Tendermint's "proposer priority" algorithm, a
 * deterministic weighted round-robin. Every validator carries an integer
 * priority. To pick a proposer: add each validator's voting power to its
 * priority, choose the highest, then subtract the total power from the
 * winner. Over time each validator is chosen in proportion to its power, and
 * the order is fully determined by the set itself, so every node agrees
 * without any communication.
 *
 * Proposer for round r at a height is computed from the height's base set by
 * applying the increment r times in a single call. It is never computed
 * incrementally across rounds, so all nodes get the same answer regardless
 * of which rounds they personally passed through.
 */
import type { Reader } from '../codec/reader.ts';
import { Writer, encode } from '../codec/writer.ts';
import { compareBytes, bytesEqual, sha256, toHex } from '../crypto/hash.ts';
import { addressOf, decodePublicKey, isPublicKey } from '../crypto/keys.ts';

export interface Validator {
  address: Uint8Array;
  publicKey: Uint8Array;
  power: bigint;
  priority: bigint;
}

/** Power 0 removes the validator. */
export interface ValidatorUpdate {
  publicKey: Uint8Array;
  power: bigint;
}

/** Priorities are kept within [-PRIORITY_WINDOW * total, +PRIORITY_WINDOW * total]. */
const PRIORITY_WINDOW = 2n;

function byPowerThenAddress(a: Validator, b: Validator): number {
  if (a.power !== b.power) return a.power > b.power ? -1 : 1;
  return compareBytes(a.address, b.address);
}

/** The most voting power a set may hold in all, so priorities (which swing by a few totals) stay within an i64, as in Tendermint. */
export const MAX_TOTAL_POWER = 2n ** 60n;

export class ValidatorSet {
  /** Sorted by power descending, then address ascending. Index = position here. */
  readonly validators: Validator[];
  readonly totalPower: bigint;
  private proposerIndex: number;

  private constructor(validators: Validator[], proposerIndex: number) {
    this.validators = validators;
    this.totalPower = validators.reduce((s, v) => s + v.power, 0n);
    if (this.totalPower > MAX_TOTAL_POWER) throw new Error(`total power ${this.totalPower} exceeds the limit ${MAX_TOTAL_POWER}`);
    this.proposerIndex = proposerIndex;
  }

  /** Build a fresh set (genesis). Priorities start at zero, then one increment picks the first proposer. */
  static create(entries: { publicKey: Uint8Array; power: bigint }[]): ValidatorSet {
    const vals: Validator[] = entries.map((e) => {
      if (!isPublicKey(e.publicKey)) throw new Error('bad public key');
      if (e.power <= 0n) throw new Error('validator power must be positive');
      return { address: addressOf(e.publicKey), publicKey: e.publicKey, power: e.power, priority: 0n };
    });
    ValidatorSet.assertUnique(vals);
    vals.sort(byPowerThenAddress);
    const set = new ValidatorSet(vals, -1);
    if (vals.length > 0) set.incrementProposerPriority(1);
    return set;
  }

  private static assertUnique(vals: Validator[]): void {
    const seen = new Set<string>();
    for (const v of vals) {
      const k = toHex(v.address);
      if (seen.has(k)) throw new Error('duplicate validator');
      seen.add(k);
    }
  }

  get size(): number {
    return this.validators.length;
  }

  byIndex(i: number): Validator | undefined {
    return this.validators[i];
  }

  indexOf(address: Uint8Array): number {
    return this.validators.findIndex((v) => bytesEqual(v.address, address));
  }

  byAddress(address: Uint8Array): Validator | undefined {
    return this.validators.find((v) => bytesEqual(v.address, address));
  }

  proposer(): Validator {
    const p = this.validators[this.proposerIndex];
    if (!p) throw new Error('validator set has no proposer');
    return p;
  }

  /** Strictly more than two thirds of total power. */
  isQuorum(power: bigint): boolean {
    return power * 3n > this.totalPower * 2n;
  }

  /** Strictly more than one third: enough to prove at least one honest validator is included. */
  isOneThird(power: bigint): boolean {
    return power * 3n > this.totalPower;
  }

  copy(): ValidatorSet {
    return new ValidatorSet(
      this.validators.map((v) => ({ ...v })),
      this.proposerIndex,
    );
  }

  /** Hash commits to public keys and powers, not priorities (which are derivable). */
  hash(): Uint8Array {
    return sha256(
      encode((w) =>
        w.array(this.validators, (w, v) => {
          w.fixed(v.publicKey);
          w.u64(v.power);
        }),
      ),
    );
  }

  /**
   * Tendermint's IncrementProposerPriority. Mutates this set. Call once with
   * the number of rounds to advance; never call repeatedly with 1 to get the
   * same effect, because the rescale step is not path independent.
   */
  incrementProposerPriority(times: number): Validator {
    if (this.validators.length === 0) throw new Error('empty validator set');
    if (times <= 0) throw new Error('times must be positive');
    this.rescalePriorities(PRIORITY_WINDOW * this.totalPower);
    this.shiftByAveragePriority();
    let proposer: Validator | undefined;
    for (let i = 0; i < times; i++) proposer = this.incrementOnce();
    this.proposerIndex = this.validators.indexOf(proposer!);
    return proposer!;
  }

  private incrementOnce(): Validator {
    for (const v of this.validators) v.priority += v.power;
    let best = this.validators[0]!;
    for (const v of this.validators) {
      if (v.priority > best.priority || (v.priority === best.priority && compareBytes(v.address, best.address) < 0)) best = v;
    }
    best.priority -= this.totalPower;
    return best;
  }

  /** Keep max(priority) - min(priority) <= diffMax by integer division. */
  private rescalePriorities(diffMax: bigint): void {
    if (diffMax <= 0n) return;
    let max = this.validators[0]!.priority;
    let min = max;
    for (const v of this.validators) {
      if (v.priority > max) max = v.priority;
      if (v.priority < min) min = v.priority;
    }
    const diff = max - min;
    if (diff > diffMax) {
      const ratio = (diff + diffMax - 1n) / diffMax;
      for (const v of this.validators) v.priority /= ratio;
    }
  }

  private shiftByAveragePriority(): void {
    const sum = this.validators.reduce((s, v) => s + v.priority, 0n);
    const avg = sum / BigInt(this.validators.length);
    for (const v of this.validators) v.priority -= avg;
  }

  /**
   * Apply validator updates and return a new set. New validators enter with a
   * negative priority of about -1.125 x total power so they cannot immediately
   * jump ahead of validators that have been waiting their turn.
   */
  applyUpdates(updates: ValidatorUpdate[]): ValidatorSet {
    if (updates.length === 0) return this.copy();
    const byAddr = new Map<string, Validator>();
    for (const v of this.validators) byAddr.set(toHex(v.address), { ...v });

    const seen = new Set<string>();
    const additions: Validator[] = [];
    const removals: string[] = [];
    let totalAfterUpdates = this.totalPower;

    for (const u of updates) {
      if (!isPublicKey(u.publicKey)) throw new Error('bad public key in update');
      if (u.power < 0n) throw new Error('negative power in update');
      const addr = addressOf(u.publicKey);
      const k = toHex(addr);
      if (seen.has(k)) throw new Error('duplicate validator in updates');
      seen.add(k);
      const existing = byAddr.get(k);
      if (u.power === 0n) {
        if (!existing) throw new Error('cannot remove unknown validator');
        removals.push(k);
        continue;
      }
      if (existing) {
        totalAfterUpdates += u.power - existing.power;
        existing.power = u.power;
      } else {
        totalAfterUpdates += u.power;
        additions.push({ address: addr, publicKey: u.publicKey, power: u.power, priority: 0n });
      }
    }

    for (const a of additions) {
      a.priority = -(totalAfterUpdates + totalAfterUpdates / 8n);
      byAddr.set(toHex(a.address), a);
    }
    for (const k of removals) byAddr.delete(k);

    const vals = [...byAddr.values()];
    if (vals.length === 0) throw new Error('updates would empty the validator set');
    vals.sort(byPowerThenAddress);
    const next = new ValidatorSet(vals, -1);
    next.rescalePriorities(PRIORITY_WINDOW * next.totalPower);
    next.shiftByAveragePriority();
    // Proposer is meaningless until the next increment picks one.
    next.proposerIndex = -1;
    return next;
  }

  encode(w: Writer): void {
    w.array(this.validators, (w, v) => {
      w.fixed(v.publicKey);
      w.u64(v.power);
      w.i64(v.priority);
    });
    w.i64(BigInt(this.proposerIndex));
  }

  /** Decoding checks what create() checks, plus the order and the proposer index: sets arrive from peers too. */
  static decode(r: Reader): ValidatorSet {
    const vals = r.array((r) => {
      const publicKey = decodePublicKey(r);
      const power = r.u64();
      const priority = r.i64();
      if (power <= 0n) throw new Error('validator power must be positive');
      return { address: addressOf(publicKey), publicKey, power, priority };
    }, 10_000);
    ValidatorSet.assertUnique(vals);
    for (let i = 1; i < vals.length; i++) if (byPowerThenAddress(vals[i - 1]!, vals[i]!) >= 0) throw new Error('validator set out of order');
    const proposerIndex = Number(r.i64());
    if (vals.length > 0 && (proposerIndex < 0 || proposerIndex >= vals.length)) throw new Error('validator set proposer index out of range');
    return new ValidatorSet(vals, proposerIndex);
  }

  toJSON(): unknown {
    return this.validators.map((v) => ({ address: toHex(v.address), power: v.power.toString(), priority: v.priority.toString() }));
  }
}
