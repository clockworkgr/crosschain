/**
 * The Tendermint consensus state machine.
 *
 * This follows the pseudocode in "The latest gossip on BFT consensus"
 * (Buchman, Kwon, Milosevic, 2018) almost line for line. Each numbered rule
 * in `evaluateRules` cites the line in that paper. The machine is purely
 * event driven: a proposal arrives, a vote arrives, or a timer fires; after
 * each event every rule is re-evaluated until none fires.
 *
 * Per height the machine goes through rounds. Each round has three steps:
 *
 *   propose    the round's proposer broadcasts a block; everyone else waits
 *              for it (or for a timeout)
 *   prevote    each validator votes for the proposal if it is valid and does
 *              not conflict with a block they are locked on, else for nil
 *   precommit  on seeing +2/3 prevotes for a block (a "polka"), a validator
 *              locks on it and precommits it; on +2/3 prevotes for nil, it
 *              precommits nil
 *
 * +2/3 precommits for a block decide it. Any other outcome, or a timeout,
 * starts the next round with the next proposer.
 *
 * Safety comes from locking: once a validator precommits a block it will
 * only prevote that block in later rounds, unless it sees a polka for a
 * different block in a later round (the proposal's polRound). Liveness
 * comes from the timeouts, which grow with the round number.
 *
 * Signature verification is asynchronous (it runs in worker threads), so
 * the handlers for incoming messages await it and then re-check that the
 * message is still relevant before touching state. All state mutation is
 * synchronous and happens on the main thread.
 */
import { bytesEqual, toHex } from '../crypto/hash.ts';
import { signContext } from '../crypto/keys.ts';
import type { Verifier } from '../crypto/verifier.ts';
import { blockBytes, blockHash, commitHash, evidenceHash, type Block, type Commit, type Header } from '../types/block.ts';
import { txsRoot } from '../types/txproof.ts';
import { makeDuplicateVoteEvidence } from '../types/evidence.ts';
import { zeroSignature } from '../crypto/keys.ts';
import { proposalSignBytes, type Proposal } from '../types/proposal.ts';
import type { ChainState } from '../types/state.ts';
import type { ValidatorSet } from '../types/validator.ts';
import { VoteType, voteSignBytes, voteTypeName, type Vote } from '../types/vote.ts';
import type { Logger } from '../util/log.ts';
import { EvidencePool } from './evidence.ts';
import { DoubleSignError, type PrivValidator } from './privval.ts';
import { bodyMatchesHeader, evidenceAgeOk, validateBlockStructure, verifyBlockSignatures, type BlockTimeLookup, type ValidationLimits } from './validate.ts';
import { HeightVoteSet } from './votes.ts';

export interface ConsensusTimeouts {
  proposeMs: number;
  proposeDeltaMs: number;
  prevoteMs: number;
  prevoteDeltaMs: number;
  precommitMs: number;
  precommitDeltaMs: number;
  /** Pause after a decision before starting the next height, to gather more precommits and pace block production. */
  commitMs: number;
  /** How often a validator re-sends its own current-round votes (and the proposer its proposal) while a round is unresolved. */
  gossipMs: number;
}

export const DEFAULT_TIMEOUTS: ConsensusTimeouts = {
  proposeMs: 3000,
  proposeDeltaMs: 500,
  prevoteMs: 1000,
  prevoteDeltaMs: 500,
  precommitMs: 1000,
  precommitDeltaMs: 500,
  commitMs: 1000,
  gossipMs: 500,
};

export const DEFAULT_LIMITS: ValidationLimits = {
  maxBlockBytes: 4 * 1024 * 1024,
  maxClockDriftMs: 15_000,
  maxEvidenceAgeMs: 7n * 24n * 3_600_000n,
};

export type Step = 'propose' | 'prevote' | 'precommit' | 'commit';
const STEP_ORDER: Record<Step, number> = { propose: 0, prevote: 1, precommit: 2, commit: 3 };

/** Rounds beyond this many ahead of ours are ignored; a round number is otherwise a free CPU budget for a peer. */
export const MAX_ROUND_AHEAD = 1000;
const MAX_EVIDENCE_PER_BLOCK = 16;
const EMPTY_HEADER: Header = {
  chainId: '',
  version: 0,
  height: 0n,
  time: 0n,
  lastBlockHash: new Uint8Array(32),
  lastCommitHash: new Uint8Array(32),
  dataHash: new Uint8Array(32),
  lastResultsHash: new Uint8Array(32),
  validatorsHash: new Uint8Array(32),
  nextValidatorsHash: new Uint8Array(32),
  appHash: new Uint8Array(32),
  evidenceHash: new Uint8Array(32),
  proposerAddress: new Uint8Array(32),
};

export class StaleHeightError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'StaleHeightError';
  }
}

export interface ConsensusDeps {
  chainId: string;
  getState(): ChainState;
  /** Execute and persist a decided block. Throws StaleHeightError if the state has already moved past it. */
  applyBlock(block: Block, commit: Commit): Promise<void>;
  /** A precommit arrived after the decision: store the fuller commit for the height just applied. */
  updateCommit(height: bigint, commit: Commit): void;
  /** Block time of a committed height, for evidence age. */
  blockTimeAt: BlockTimeLookup;
  /** +2/3 precommitted a block this node never received as a proposal: ask peers for it. */
  requestBlock?(height: bigint, hash: Uint8Array): void;
  /** A peer sent something invalid. */
  scorePeer?(peerId: string, points: number, reason: string): void;
  /** Commit for the last committed height, needed to build the next block. */
  getLastCommit(): Commit | null;
  validatorSetAtHeight(h: bigint): ValidatorSet | null;
  reapTxs(maxBytes: number): Uint8Array[];
  privValidator: PrivValidator | null;
  verifier: Verifier;
  evidencePool: EvidencePool;
  broadcastProposal(p: Proposal, exceptPeer: string | null): void;
  broadcastVote(v: Vote, exceptPeer: string | null): void;
  timeouts?: Partial<ConsensusTimeouts>;
  limits?: Partial<ValidationLimits>;
  now?: () => bigint;
  log: Logger;
}

interface RoundProposal {
  proposal: Proposal;
  valid: boolean;
  hash: Uint8Array;
  /** The block came from a peer after +2/3 precommitted it, not from the proposer; never re-gossiped. */
  fetched?: boolean;
}

export class Consensus {
  height = 0n;
  round = 0;
  step: Step = 'propose';
  lockedBlock: Block | null = null;
  lockedRound = -1;
  validBlock: Block | null = null;
  validRound = -1;

  private readonly d: ConsensusDeps;
  private readonly timeouts: ConsensusTimeouts;
  private readonly limitsRef: Partial<ValidationLimits>;
  /** Read on each use: the node adjusts the evidence age when the unbonding period changes. */
  private get limits(): ValidationLimits {
    return { ...DEFAULT_LIMITS, ...this.limitsRef };
  }
  private readonly now: () => bigint;
  private readonly log: Logger;
  private readonly voteCtx: Uint8Array;
  private readonly proposalCtx: Uint8Array;

  private validators!: ValidatorSet;
  private hvs!: HeightVoteSet;
  private proposals = new Map<number, RoundProposal>();
  private proposerCache = new Map<number, Uint8Array>();
  private prevoteTimeoutScheduled = new Set<number>();
  private precommitTimeoutScheduled = new Set<number>();
  private polkaHandled = new Set<number>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Votes for the next height with the key each was verified against, replayed once that height starts. */
  private nextHeightVotes: { vote: Vote; publicKey: Uint8Array }[] = [];
  private nextHeightProposals: Proposal[] = [];
  private decided = false;
  private decidedRound = -1;
  private decidedHash: Uint8Array | null = null;
  private readonly fetchRequested = new Set<string>();
  private running = false;
  private evaluating = false;
  private reevaluate = false;
  private decisionCount = 0;

  constructor(deps: ConsensusDeps) {
    this.d = deps;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
    this.limitsRef = deps.limits ?? {};
    this.now = deps.now ?? (() => BigInt(Date.now()));
    this.log = deps.log;
    this.voteCtx = signContext(deps.chainId, 'vote');
    this.proposalCtx = signContext(deps.chainId, 'proposal');
  }

  get isValidator(): boolean {
    return this.d.privValidator !== null && this.validators?.indexOf(this.d.privValidator.address) >= 0;
  }

  get isDeciding(): boolean {
    return this.decided;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startHeight();
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Called after block sync applied blocks behind consensus's back. */
  restart(): void {
    if (!this.running) return;
    const st = this.d.getState();
    if (st.lastHeight + 1n === this.height) return;
    this.log('info', 'restarting consensus at new height', { height: st.lastHeight + 1n });
    this.startHeight();
  }


  // ------------------------------------------------------------------ heights

  private startHeight(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const st = this.d.getState();
    this.height = st.lastHeight + 1n;
    this.validators = st.validators;
    this.hvs = new HeightVoteSet(this.height, this.validators);
    this.proposals.clear();
    this.proposerCache.clear();
    this.prevoteTimeoutScheduled.clear();
    this.precommitTimeoutScheduled.clear();
    this.polkaHandled.clear();
    this.lockedBlock = null;
    this.lockedRound = -1;
    this.validBlock = null;
    this.validRound = -1;
    this.decided = false;
    this.round = 0;
    // After a restart the guard may already hold a signature for this height; that round cannot be
    // completed by us with fresh content, so resume in the round after it.
    const last = this.d.privValidator?.lastSigned();
    const resumeRound = last && last.height === this.height ? last.round + 1 : 0;

    // Only votes verified with the key that holds that index in this height's set count.
    const votes = this.nextHeightVotes.filter((e) => e.vote.height === this.height && bytesEqual(this.validators.byIndex(e.vote.validatorIndex)?.publicKey ?? null, e.publicKey)).map((e) => e.vote);
    const proposals = this.nextHeightProposals.filter((p) => p.height === this.height);
    this.nextHeightVotes = [];
    this.nextHeightProposals = [];

    this.startRound(resumeRound);
    for (const v of votes) this.addVote(v, null);
    for (const p of proposals) void this.handleProposal(p, null);
  }

  private startRound(r: number): void {
    this.round = r;
    this.step = 'propose';
    const proposer = this.proposerAt(r);
    this.log('debug', 'start round', { h: this.height, r, proposer });
    this.scheduleGossip();
    const pv = this.d.privValidator;
    if (pv && bytesEqual(proposer, pv.address)) {
      this.propose();
    } else {
      this.schedule('propose', this.timeouts.proposeMs + this.timeouts.proposeDeltaMs * r, () => this.onTimeoutPropose(this.height, r));
    }
    this.evaluateRules();
  }

  /** Address of the proposer for round r at the current height. */
  proposerAt(r: number): Uint8Array {
    const cached = this.proposerCache.get(r);
    if (cached) return cached;
    let addr: Uint8Array;
    if (r === 0) {
      addr = this.validators.proposer().address;
    } else {
      const copy = this.validators.copy();
      copy.incrementProposerPriority(r);
      addr = copy.proposer().address;
    }
    this.proposerCache.set(r, addr);
    return addr;
  }

  // ----------------------------------------------------------------- proposing

  private propose(): void {
    const pv = this.d.privValidator!;
    const block = this.validBlock ?? this.createBlock();
    if (!block) {
      this.log('warn', 'cannot build a block (no last commit yet); skipping proposal');
      this.schedule('propose', this.timeouts.proposeMs + this.timeouts.proposeDeltaMs * this.round, () => this.onTimeoutPropose(this.height, this.round));
      return;
    }
    const unsigned = { height: this.height, round: this.round, polRound: this.validRound, block };
    let signature: Uint8Array;
    try {
      signature = pv.signProposal(this.d.chainId, unsigned);
    } catch (e) {
      this.log('error', 'refusing to sign proposal', { err: (e as Error).message });
      return;
    }
    const proposal: Proposal = { ...unsigned, signature };
    this.log('info', 'proposing', { h: this.height, r: this.round, txs: block.txs.length, hash: blockHash(block) });
    this.d.broadcastProposal(proposal, null);
    void this.handleProposal(proposal, null);
  }

  private createBlock(): Block | null {
    const st = this.d.getState();
    const pv = this.d.privValidator!;
    let lastCommit: Commit | null = null;
    if (this.height > 1n) {
      lastCommit = this.d.getLastCommit();
      if (!lastCommit) return null;
    }
    let time = this.now();
    if (time <= st.lastBlockTime) time = st.lastBlockTime + 1n;
    // Evidence a validator would reject as too old must not go into the block, and is dropped for good.
    this.d.evidencePool.pruneIf((ev) => evidenceAgeOk(ev.voteA.height, st.lastHeight + 1n, time, st, this.limits, this.d.blockTimeAt) !== null);
    let evidence = this.d.evidencePool.list(MAX_EVIDENCE_PER_BLOCK);
    // Everything but the transactions is fixed now; measure it and give the transactions what is left.
    let shell: Block = { header: { ...EMPTY_HEADER, chainId: this.d.chainId }, txs: [], lastCommit, evidence };
    // Evidence is picked by count; by bytes it may not fit a small limit. Leave some for the next block.
    while (evidence.length > 0 && blockBytes(shell).length + 1024 > this.limits.maxBlockBytes) {
      evidence = evidence.slice(0, -1);
      shell = { ...shell, evidence };
    }
    const budget = this.limits.maxBlockBytes - blockBytes(shell).length - 1024;
    const txs = budget > 0 ? this.d.reapTxs(budget) : [];
    return {
      header: {
        chainId: this.d.chainId,
        version: st.version,
        height: this.height,
        time,
        lastBlockHash: st.lastBlockHash,
        lastCommitHash: commitHash(lastCommit),
        dataHash: txsRoot(txs),
        lastResultsHash: st.lastResultsHash,
        validatorsHash: st.validators.hash(),
        nextValidatorsHash: st.nextValidators.hash(),
        appHash: st.appHash,
        evidenceHash: evidenceHash(evidence),
        proposerAddress: pv.address,
      },
      txs,
      lastCommit,
      evidence,
    };
  }

  // ------------------------------------------------------- incoming proposals

  async handleProposal(p: Proposal, fromPeer: string | null): Promise<void> {
    if (!this.running) return;
    if (p.height === this.height + 1n) {
      if (this.nextHeightProposals.length < 8) this.nextHeightProposals.push(p);
      return;
    }
    if (p.height !== this.height) return;
    if (this.proposals.has(p.round)) return;
    if (p.polRound < -1 || p.polRound >= p.round) return;
    if (p.block.header.height !== p.height) return;

    if (p.round > this.round + MAX_ROUND_AHEAD) return; // proposer selection costs O(round); do not let a peer choose it
    // The round's proposer signs the proposal; the block inside may be a re-proposal built by an earlier proposer.
    const proposer = this.validators.byAddress(this.proposerAt(p.round))!;
    const sigOk = await this.d.verifier.verifyOne({
      sig: p.signature,
      msg: proposalSignBytes(this.d.chainId, p),
      publicKey: proposer.publicKey,
      context: this.proposalCtx,
    });
    if (!sigOk) {
      this.log('warn', 'proposal with bad signature', { r: p.round });
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'bad proposal signature');
      return;
    }

    // The signature covers the header; a relay can pair it with another body. That is a corrupt message, not
    // the round's proposal: drop it without recording the round, so the real one can still arrive.
    if (!bodyMatchesHeader(p.block)) {
      this.log('warn', 'proposal body does not match its header', { h: p.height, r: p.round });
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'proposal body mismatch');
      return;
    }

    // Validity of the block itself.
    const st = this.d.getState();
    // A block re-proposed with a proof of lock keeps the time its first proposer gave it, and a round that
    // stalled past the drift limit must still be able to decide it (CometBFT checks timeliness only for
    // polRound == -1); the clock check applies to fresh blocks alone.
    let invalid = validateBlockStructure(st, p.block, this.limits, p.polRound === -1 ? this.now() : null, this.d.blockTimeAt);
    if (!invalid) invalid = await verifyBlockSignatures(this.d.chainId, st, p.block, this.d.verifier, this.d.validatorSetAtHeight);

    // State may have moved while we were verifying.
    if (!this.running || p.height !== this.height || this.proposals.has(p.round)) return;

    const hash = blockHash(p.block);
    this.proposals.set(p.round, { proposal: p, valid: invalid === null, hash });
    if (invalid) this.log('warn', 'invalid proposal', { h: p.height, r: p.round, reason: invalid });
    else {
      this.log('debug', 'got proposal', { h: p.height, r: p.round, hash });
      this.d.broadcastProposal(p, fromPeer);
    }
    this.evaluateRules();
  }

  // ----------------------------------------------------------- incoming votes

  async handleVote(v: Vote, fromPeer: string | null): Promise<void> {
    if (!this.running) return;
    let set: ValidatorSet | null;
    if (v.height === this.height) {
      if (this.hvs.has(v)) return;
      set = this.validators;
    } else if (v.height === this.height + 1n) {
      // By the vote's own height: the executor may have applied this height already, and then the
      // state's "next" set is the one after, whose index positions mean other keys.
      set = this.d.validatorSetAtHeight(v.height);
    } else {
      return;
    }
    if (!set) return;
    const val = set.byIndex(v.validatorIndex);
    if (!val) return;
    const ok = await this.d.verifier.verifyOne({
      sig: v.signature,
      msg: voteSignBytes(this.d.chainId, v),
      publicKey: val.publicKey,
      context: this.voteCtx,
    });
    if (!ok) {
      this.log('warn', 'vote with bad signature', { h: v.height, r: v.round, i: v.validatorIndex });
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'bad vote signature');
      return;
    }
    if (!this.running) return;
    if (v.round > this.round + MAX_ROUND_AHEAD) return;
    if (v.height === this.height) this.addVote(v, fromPeer);
    else if (v.height === this.height + 1n && this.nextHeightVotes.length < 4096) this.nextHeightVotes.push({ vote: v, publicKey: val.publicKey });
  }

  /** Add an already-verified vote for the current height. */
  private addVote(v: Vote, fromPeer: string | null): void {
    if (v.height !== this.height) return;
    const { added, conflict } = this.hvs.add(v);
    if (conflict) {
      const ev = makeDuplicateVoteEvidence(conflict, v);
      if (this.d.evidencePool.add(ev)) {
        this.log('warn', 'double sign detected', { h: v.height, r: v.round, type: voteTypeName(v.type), validator: v.validatorIndex });
      }
      return;
    }
    if (!added) return;
    this.log('debug', 'got vote', { h: v.height, r: v.round, type: voteTypeName(v.type), i: v.validatorIndex, block: v.blockHash });
    this.d.broadcastVote(v, fromPeer);
    if (this.decided) {
      // A straggler for the decided block: fold it into the stored commit so the next
      // proposer, and everyone reading that block, credits the signature.
      if (v.type === VoteType.Precommit && v.round === this.decidedRound && this.decidedHash && bytesEqual(v.blockHash, this.decidedHash)) {
        this.d.updateCommit(this.height, this.hvs.precommits(v.round).toCommit(this.decidedHash));
      }
      return;
    }
    this.evaluateRules();
  }

  // ------------------------------------------------------------------- voting

  private signAndAddVote(type: VoteType, hash: Uint8Array | null): void {
    const pv = this.d.privValidator;
    if (!pv) return;
    const idx = this.validators.indexOf(pv.address);
    if (idx < 0) return;
    const unsigned = { type, height: this.height, round: this.round, blockHash: hash, validatorIndex: idx };
    let signature: Uint8Array;
    try {
      signature = pv.signVote(this.d.chainId, unsigned);
    } catch (e) {
      if (e instanceof DoubleSignError) {
        this.log('error', 'double-sign guard refused to sign', { err: e.message });
        return;
      }
      throw e;
    }
    this.log('info', voteTypeName(type), { h: this.height, r: this.round, block: hash });
    this.addVote({ ...unsigned, signature }, null);
  }

  private prevote(hash: Uint8Array | null): void {
    this.signAndAddVote(VoteType.Prevote, hash);
  }

  private precommit(hash: Uint8Array | null): void {
    this.signAndAddVote(VoteType.Precommit, hash);
  }

  // ------------------------------------------------------------------ gossip

  /**
   * Messages are flooded once when first seen. A peer that was not connected
   * at that moment, or was briefly partitioned, would otherwise never get
   * them, and a round can stall for want of a single vote. So while a round
   * is unresolved each validator keeps re-sending its own votes for the
   * round and the proposer keeps re-sending its proposal. Receivers drop
   * duplicates before verifying them, so this costs bandwidth, not CPU.
   */
  private scheduleGossip(): void {
    this.schedule('gossip', this.timeouts.gossipMs, () => {
      if (this.decided) return;
      const pv = this.d.privValidator;
      if (pv) {
        const idx = this.validators.indexOf(pv.address);
        if (idx >= 0) {
          for (const set of [this.hvs.prevotes(this.round), this.hvs.precommits(this.round)]) {
            const v = set.get(idx);
            if (v) this.d.broadcastVote(v, null);
          }
        }
        // The prevotes behind our valid block, for a peer that missed that polka: without them it cannot accept a re-proposal.
        if (this.validRound >= 0 && this.validRound !== this.round) for (const v of this.hvs.prevotes(this.validRound).all()) this.d.broadcastVote(v, null);
        // The round's proposer re-sends the round's proposal, whether it built the block or re-proposed another's.
        const prop = this.proposals.get(this.round);
        if (prop && prop.valid && !prop.fetched && bytesEqual(this.proposerAt(this.round), pv.address)) this.d.broadcastProposal(prop.proposal, null);
      }
      this.scheduleGossip();
    });
  }

  /**
   * A block fetched from a peer because +2/3 precommitted it. It stands in for
   * the proposal it never received: validated like one, then decided by rule 49.
   */
  async handleFetchedBlock(block: Block): Promise<void> {
    if (!this.running || this.decided || block.header.height !== this.height) return;
    const hash = blockHash(block);
    let round = -1;
    for (const rr of this.hvs.roundNumbers()) {
      const q = this.hvs.precommits(rr).quorumValue();
      const stored = this.proposals.get(rr);
      if (q && bytesEqual(q, hash) && !(stored?.valid && bytesEqual(stored.hash, hash))) round = rr;
    }
    if (round < 0) return;
    const st = this.d.getState();
    const invalid = validateBlockStructure(st, block, this.limits, null, this.d.blockTimeAt) ?? (await verifyBlockSignatures(this.d.chainId, st, block, this.d.verifier, this.d.validatorSetAtHeight));
    if (invalid) {
      this.log('warn', 'fetched block is invalid', { h: this.height, err: invalid });
      return;
    }
    const current = this.proposals.get(round);
    if (!this.running || this.decided || block.header.height !== this.height || (current?.valid && bytesEqual(current.hash, hash))) return;
    const proposal: Proposal = { height: this.height, round, polRound: -1, block, signature: zeroSignature(this.d.getState().scheme) };
    this.proposals.set(round, { proposal, valid: true, hash, fetched: true });
    this.evaluateRules();
  }

  /** Everything held for the current height, to hand a newly connected peer. */
  messagesForPeer(): { proposals: Proposal[]; votes: Vote[] } {
    if (!this.running || !this.hvs) return { proposals: [], votes: [] };
    const proposals = [...this.proposals.values()].filter((p) => p.valid && !p.fetched).map((p) => p.proposal);
    return { proposals, votes: this.hvs.allVotes() };
  }

  // ----------------------------------------------------------------- timeouts

  private schedule(key: string, ms: number, fn: () => void): void {
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (this.running) fn();
      }, ms),
    );
  }

  /** Line 57: no proposal arrived in time; prevote nil. */
  private onTimeoutPropose(h: bigint, r: number): void {
    if (h !== this.height || r !== this.round || this.step !== 'propose') return;
    this.log('debug', 'timeout propose', { h, r });
    this.step = 'prevote';
    this.prevote(null);
    this.evaluateRules();
  }

  /** Line 61: +2/3 prevoted but for no single value; precommit nil. */
  private onTimeoutPrevote(h: bigint, r: number): void {
    if (h !== this.height || r !== this.round || this.step !== 'prevote') return;
    this.log('debug', 'timeout prevote', { h, r });
    this.step = 'precommit';
    this.precommit(null);
    this.evaluateRules();
  }

  /** Line 65: +2/3 precommitted but for no single value; next round. */
  private onTimeoutPrecommit(h: bigint, r: number): void {
    if (h !== this.height || r !== this.round || this.decided) return;
    this.log('debug', 'timeout precommit', { h, r });
    this.startRound(r + 1);
  }

  // -------------------------------------------------------------------- rules

  /**
   * Re-run every rule until nothing changes. Guarded against re-entry: a
   * rule that casts a vote feeds that vote back in, which would otherwise
   * nest another evaluation inside this one.
   */
  private evaluateRules(): void {
    if (this.evaluating) {
      this.reevaluate = true;
      return;
    }
    this.evaluating = true;
    try {
      for (let i = 0; i < 64; i++) {
        this.reevaluate = false;
        const fired = this.runRulesOnce();
        if (!fired && !this.reevaluate) break;
      }
    } finally {
      this.evaluating = false;
    }
  }

  private runRulesOnce(): boolean {
    if (!this.running || this.decided) return false;
    const r = this.round;
    const prop = this.proposals.get(r);
    const prevotes = this.hvs.prevotes(r);
    const precommits = this.hvs.precommits(r);

    // Line 55: f+1 validators are in a later round; the network has moved on.
    for (const rr of this.hvs.roundNumbers()) {
      if (rr > r && this.validators.isOneThird(this.hvs.roundPower(rr))) {
        this.log('debug', 'skipping to round', { from: r, to: rr });
        this.startRound(rr);
        return true;
      }
    }

    // Line 22: a fresh proposal while we are in propose.
    if (this.step === 'propose' && prop && prop.proposal.polRound === -1) {
      this.step = 'prevote';
      const unlockedOrSame = this.lockedRound === -1 || (this.lockedBlock !== null && bytesEqual(blockHash(this.lockedBlock), prop.hash));
      this.prevote(prop.valid && unlockedOrSame ? prop.hash : null);
      return true;
    }

    // Line 28: a proposal re-proposing a block that had a polka in an earlier round.
    if (this.step === 'propose' && prop && prop.proposal.polRound >= 0 && prop.proposal.polRound < r) {
      const vr = prop.proposal.polRound;
      if (this.hvs.prevotes(vr).hasQuorumFor(prop.hash)) {
        this.step = 'prevote';
        const canUnlock = this.lockedRound <= vr || (this.lockedBlock !== null && bytesEqual(blockHash(this.lockedBlock), prop.hash));
        this.prevote(prop.valid && canUnlock ? prop.hash : null);
        return true;
      }
    }

    // Line 34: +2/3 prevotes for anything; start the prevote timeout once.
    if (this.step === 'prevote' && prevotes.hasQuorumAny() && !this.prevoteTimeoutScheduled.has(r)) {
      this.prevoteTimeoutScheduled.add(r);
      this.schedule('prevote', this.timeouts.prevoteMs + this.timeouts.prevoteDeltaMs * r, () => this.onTimeoutPrevote(this.height, r));
      return true;
    }

    // Line 36: polka for the proposed block. Lock and precommit it (once per round).
    if (prop && prop.valid && STEP_ORDER[this.step] >= STEP_ORDER.prevote && prevotes.hasQuorumFor(prop.hash) && !this.polkaHandled.has(r)) {
      this.polkaHandled.add(r);
      if (this.step === 'prevote') {
        this.lockedBlock = prop.proposal.block;
        this.lockedRound = r;
        this.step = 'precommit';
        this.precommit(prop.hash);
      }
      this.validBlock = prop.proposal.block;
      this.validRound = r;
      return true;
    }

    // Line 44: polka for nil; precommit nil.
    if (this.step === 'prevote' && prevotes.hasQuorumFor(null)) {
      this.step = 'precommit';
      this.precommit(null);
      return true;
    }

    // Line 47: +2/3 precommits for anything; start the precommit timeout once.
    if (precommits.hasQuorumAny() && !this.precommitTimeoutScheduled.has(r)) {
      this.precommitTimeoutScheduled.add(r);
      this.schedule('precommit', this.timeouts.precommitMs + this.timeouts.precommitDeltaMs * r, () => this.onTimeoutPrecommit(this.height, r));
      return true;
    }

    // Line 49: +2/3 precommits for a block we have, in any round. Decide.
    for (const rr of this.hvs.roundNumbers()) {
      const p = this.proposals.get(rr);
      const q = this.hvs.precommits(rr).quorumValue();
      if (!p || !p.valid || (q && !bytesEqual(p.hash, q))) {
        // +2/3 precommitted a block we never got, or got another proposal for: fetch it rather than fall a height behind.
        if (q && this.d.requestBlock && !this.fetchRequested.has(toHex(q))) {
          this.fetchRequested.add(toHex(q));
          this.log('info', 'precommit quorum for an unseen block; fetching it', { h: this.height, r: rr, hash: q });
          this.d.requestBlock(this.height, q);
        }
        continue;
      }
      if (this.hvs.precommits(rr).hasQuorumFor(p.hash)) {
        void this.decide(rr, p);
        return true;
      }
    }

    return false;
  }

  // ----------------------------------------------------------------- deciding

  private async decide(r: number, p: RoundProposal): Promise<void> {
    this.decided = true;
    this.decidedRound = r;
    this.decidedHash = p.hash;
    this.step = 'commit';
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const commit = this.hvs.precommits(r).toCommit(p.hash);
    const h = this.height;
    this.log('info', 'decided', { h, r, hash: p.hash, txs: p.proposal.block.txs.length });
    try {
      await this.d.applyBlock(p.proposal.block, commit);
    } catch (e) {
      if (e instanceof StaleHeightError) {
        this.log('info', 'block already applied by sync', { h });
      } else {
        this.log('error', 'failed to apply decided block; halting', { h, err: (e as Error).message });
        this.stop();
        return;
      }
    }
    if (!this.running) return;
    // Precommits that arrived while the block was being applied could not be stored then.
    this.d.updateCommit(h, this.hvs.precommits(r).toCommit(p.hash));
    this.decisionCount++;
    this.schedule('commit', this.timeouts.commitMs, () => {
      if (this.running) this.startHeight();
    });
  }

  /** Snapshot for logs and tests. */
  status(): { height: bigint; round: number; step: Step; locked: string | null; valid: string | null; decisions: number } {
    return {
      height: this.height,
      round: this.round,
      step: this.step,
      locked: this.lockedBlock ? toHex(blockHash(this.lockedBlock)).slice(0, 12) : null,
      valid: this.validBlock ? toHex(blockHash(this.validBlock)).slice(0, 12) : null,
      decisions: this.decisionCount,
    };
  }
}
