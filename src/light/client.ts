/**
 * A light client in the Tendermint style. It holds one trusted signed header
 * with the validator sets around it and can move that trust forward:
 *
 *   sequential  the next header's validators must hash to the trusted
 *               header's nextValidatorsHash, and must have signed with +2/3
 *   skipping    any later header is accepted if +2/3 of its own validators
 *               signed it and more than a third (the trust level) of the
 *               validator set the trusted header promised for its next
 *               height is among the signers; otherwise the client bisects,
 *               verifying a header halfway first
 *
 * Trust also has a time limit: the trusted header must be younger than the
 * trusting period, within which validators can still be punished for
 * misbehaving, and a header may not come from the future beyond clock
 * drift. With a trusted header in hand, a state query is checked by
 * verifying the header after the proven height, comparing it with the one
 * the query carries, and checking the proof against its app hash.
 *
 * Heights before the trusted one need no commits: every header names the
 * hash of the one before it, so walking that chain down from the trusted
 * header binds each earlier header to it (backward verification).
 */
import { verifyCommit } from '../consensus/validate.ts';
import { bytesEqual, toHex } from '../crypto/hash.ts';
import type { Verifier } from '../crypto/verifier.ts';
import { verifyKeyProof, verifyObjectProof } from '../db/proof.ts';
import { headerHash, type Commit, type Header } from '../types/block.ts';
import type { ValidatorSet } from '../types/validator.ts';
import type { KeyQueryResult, StateQueryResult, TxQueryResult, TxVerdict } from './verify.ts';
import { verifyResultProof, verifyTxProof } from '../types/txproof.ts';

export interface SignedHeader {
  header: Header;
  commit: Commit;
}

/** Where headers and validator sets come from: a full node, over whatever transport. */
export interface LightProvider {
  latestHeight(): Promise<bigint>;
  signedHeader(height: bigint): Promise<SignedHeader | null>;
  validatorSet(hash: Uint8Array): Promise<ValidatorSet | null>;
  /** A header alone, for walking the hash chain backwards; without it the signed header's is used. */
  header?(height: bigint): Promise<Header | null>;
}

export interface TrustedState extends SignedHeader {
  /** The set that signed this header. */
  validators: ValidatorSet;
  /** The set that signs the next height. */
  nextValidators: ValidatorSet;
}

export interface LightClientOptions {
  chainId: string;
  provider: LightProvider;
  verifier: Verifier;
  trustingPeriodMs?: bigint;
  maxClockDriftMs?: bigint;
  now?: () => bigint;
  /** How far below the trusted height backward verification will walk, one header per step. */
  maxBackwardSteps?: number;
}

const INSUFFICIENT_TRUST = 'insufficient trust';
/** Headers verified backwards are remembered up to this many; the walk starts over from the trusted header beyond it. */
const MAX_BACKWARD_CACHE = 10_000;

export class LightClient {
  private readonly o: Required<LightClientOptions>;
  trusted: TrustedState;
  /** Heights verified, in order, for inspection. */
  readonly verifiedHeights: bigint[] = [];
  /** Headers verified backwards from the trusted one, by height. */
  private readonly backward = new Map<bigint, Header>();

  private constructor(o: Required<LightClientOptions>, trusted: TrustedState) {
    this.o = o;
    this.trusted = trusted;
  }

  /**
   * Start from a height whose header hash the user trusts out of band (or,
   * with no hash, whatever the provider serves, which is trust on first use).
   */
  static async trust(opts: LightClientOptions, height: bigint, expectedHash?: Uint8Array): Promise<LightClient> {
    const o: Required<LightClientOptions> = {
      trustingPeriodMs: 4n * 24n * 3_600_000n,
      maxClockDriftMs: 10_000n,
      now: () => BigInt(Date.now()),
      maxBackwardSteps: 100_000,
      ...opts,
    };
    const client = new LightClient(o, null as unknown as TrustedState);
    const s = await client.fetch(height);
    if (expectedHash && !bytesEqual(headerHash(s.header), expectedHash)) throw new Error(`header ${height} does not have the trusted hash`);
    // An anchor outside the trusting period could be signed by a set that has since unbonded, and one from the future is not a header yet.
    const now = o.now();
    if (now - s.header.time >= o.trustingPeriodMs) throw new Error(`header ${height} is older than the trusting period`);
    if (s.header.time > now + o.maxClockDriftMs) throw new Error(`header ${height} is from the future`);
    const err = await verifyCommit(o.chainId, s.validators, headerHash(s.header), s.commit, o.verifier);
    if (err) throw new Error(`initial header ${height}: ${err}`);
    client.trusted = s;
    return client;
  }

  private async fetch(height: bigint): Promise<TrustedState> {
    const sh = await this.o.provider.signedHeader(height);
    if (!sh) throw new Error(`provider has no header ${height}`);
    if (sh.header.height !== height || sh.commit.height !== height) throw new Error(`provider answered height ${height} with header ${sh.header.height}`);
    if (sh.header.chainId !== this.o.chainId) throw new Error(`header ${height} is for chain ${sh.header.chainId}`);
    const validators = await this.o.provider.validatorSet(sh.header.validatorsHash);
    const nextValidators = await this.o.provider.validatorSet(sh.header.nextValidatorsHash);
    if (!validators || !bytesEqual(validators.hash(), sh.header.validatorsHash)) throw new Error(`provider did not supply the validator set of header ${height}`);
    if (!nextValidators || !bytesEqual(nextValidators.hash(), sh.header.nextValidatorsHash)) throw new Error(`provider did not supply the next validator set of header ${height}`);
    return { ...sh, validators, nextValidators };
  }

  private timeProblem(trusted: TrustedState, candidate: TrustedState): string | null {
    const now = this.o.now();
    if (trusted.header.time + this.o.trustingPeriodMs <= now) return 'trusted header is older than the trusting period';
    if (candidate.header.time > now + this.o.maxClockDriftMs) return 'header is from the future';
    if (candidate.header.time <= trusted.header.time) return 'header time does not advance';
    return null;
  }

  /** The next height: the trusted header named its validator set. */
  private async verifyAdjacent(trusted: TrustedState, c: TrustedState): Promise<string | null> {
    if (!bytesEqual(c.validators.hash(), trusted.header.nextValidatorsHash)) return 'validator set is not the one the trusted header named';
    if (!bytesEqual(c.header.lastBlockHash, headerHash(trusted.header))) return 'header does not extend the trusted one';
    return (await verifyCommit(this.o.chainId, c.validators, headerHash(c.header), c.commit, this.o.verifier)) ?? this.timeProblem(trusted, c);
  }

  /** A later height: its own set signed it, and enough of the set we trust is among the signers. */
  private async verifySkipping(trusted: TrustedState, c: TrustedState): Promise<string | null> {
    const err = await verifyCommit(this.o.chainId, c.validators, headerHash(c.header), c.commit, this.o.verifier);
    if (err) return err;
    const known = trusted.nextValidators;
    let overlap = 0n;
    c.commit.signatures.forEach((sig, i) => {
      if (sig === null) return;
      const v = c.validators.byIndex(i);
      const idx = v ? known.indexOf(v.address) : -1;
      if (idx >= 0) overlap += known.byIndex(idx)!.power;
    });
    if (3n * overlap <= known.totalPower) return INSUFFICIENT_TRUST;
    return this.timeProblem(trusted, c);
  }

  /** Move trust forward to `target`, bisecting where the validator set changed too much to skip. */
  async verifyToHeight(target: bigint): Promise<TrustedState> {
    let cur = this.trusted;
    if (target < cur.header.height) throw new Error(`height ${target} is before the trusted height ${cur.header.height}`);
    while (cur.header.height < target) {
      let pivot = target;
      for (;;) {
        const candidate = await this.fetch(pivot);
        const adjacent = pivot === cur.header.height + 1n;
        const err = adjacent ? await this.verifyAdjacent(cur, candidate) : await this.verifySkipping(cur, candidate);
        if (err === null) {
          cur = candidate;
          this.verifiedHeights.push(pivot);
          break;
        }
        if (err !== INSUFFICIENT_TRUST || adjacent) throw new Error(`header ${pivot}: ${err}`);
        pivot = cur.header.height + (pivot - cur.header.height) / 2n;
      }
    }
    this.trusted = cur;
    return cur;
  }

  async verifyLatest(): Promise<TrustedState> {
    return this.verifyToHeight(await this.o.provider.latestHeight());
  }

  private async headerOnly(height: bigint): Promise<Header | null> {
    if (this.o.provider.header) return this.o.provider.header(height);
    return (await this.o.provider.signedHeader(height))?.header ?? null;
  }

  /**
   * A height at or before the trusted one, reached by walking the hash chain down from the trusted header: each header
   * must hash to what the one above it names as its last block hash. No commit is checked on the way, since the
   * trusted header already stands for the whole chain before it. The headers passed are remembered, so the next
   * walk to a nearby height is short.
   */
  async verifyBackward(target: bigint): Promise<Header> {
    const top = this.trusted.header;
    if (target < 1n) throw new Error(`height ${target} is not a block`);
    if (target > top.height) throw new Error(`height ${target} is after the trusted height ${top.height}`);
    if (top.height - target > BigInt(this.o.maxBackwardSteps)) throw new Error(`height ${target} is more than ${this.o.maxBackwardSteps} headers before the trusted height ${top.height}; trust a header nearer to it first`);
    let cur = top;
    while (cur.height > target) {
      const h = cur.height - 1n;
      const prev = this.backward.get(h) ?? (await this.headerOnly(h));
      if (!prev) throw new Error(`provider has no header ${h}`);
      if (prev.height !== h) throw new Error(`provider answered height ${h} with header ${prev.height}`);
      if (!bytesEqual(headerHash(prev), cur.lastBlockHash)) throw new Error(`header ${h} is not the one header ${cur.height} names`);
      if (this.backward.size >= MAX_BACKWARD_CACHE) this.backward.clear();
      this.backward.set(h, prev);
      cur = prev;
    }
    return cur;
  }

  /** The header the client has verified for a height: trust moves forward for a later one, and walks back for an earlier one. */
  private async verifiedHeader(height: bigint): Promise<Header> {
    if (height === this.trusted.header.height) return this.trusted.header;
    if (height < this.trusted.header.height) return this.verifyBackward(height);
    return (await this.verifyToHeight(height)).header;
  }

  /** Check a node's answer to a state query. Returns a problem, or null. */
  async verifyState(q: StateQueryResult): Promise<string | null> {
    const header = await this.verifiedHeader(q.proof.height + 1n);
    if (!bytesEqual(headerHash(header), headerHash(q.header))) return `header ${q.header.height} is not the verified one (${toHex(headerHash(header)).slice(0, 12)})`;
    return verifyObjectProof(header.appHash, q.proof) ? null : 'proof does not lead to the app hash';
  }

  /** Check a transaction query: inclusion against its header, result against the next. Null means only inclusion is provable yet. */
  async verifyTx(q: TxQueryResult): Promise<TxVerdict> {
    const header = await this.verifiedHeader(q.txProof.height);
    if (!bytesEqual(headerHash(header), headerHash(q.header))) return { failed: true, error: `header ${q.header.height} is not the verified one` };
    if (!verifyTxProof(header.dataHash, q.txProof)) return { failed: true, error: 'transaction is not in the block' };
    if (!q.resultProof || !q.nextHeader) return null;
    const next = await this.verifiedHeader(q.txProof.height + 1n);
    if (!bytesEqual(headerHash(next), headerHash(q.nextHeader))) return { failed: true, error: 'next header is not the verified one' };
    if (q.resultProof.index !== q.txProof.index || !verifyResultProof(next.lastResultsHash, q.resultProof)) return { failed: true, error: 'result is not the one committed' };
    return { ok: q.resultProof.ok, error: q.resultProof.error };
  }

  /** Check a key query. Returns the proven value, null for a proven absence, or an error. */
  async verifyKey(q: KeyQueryResult): Promise<{ value: Uint8Array | null } | { error: string }> {
    const header = await this.verifiedHeader(q.proof.height + 1n);
    if (!bytesEqual(headerHash(header), headerHash(q.header))) return { error: `header ${q.header.height} is not the verified one` };
    const value = verifyKeyProof(header.appHash, q.proof);
    return value === undefined ? { error: 'proof does not lead to the app hash' } : { value };
  }
}
