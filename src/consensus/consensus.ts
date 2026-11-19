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
 * different block in the round of its lock or a later one (the proposal's
 * polRound, which its prevote then names). The lock is kept by hash and
 * written by the private validator with the precommit, so a restart in the
 * same height takes it up again. A validator whose votes show a lock
 * forgotten is reported like one that signed twice, and so is one that
 * prevotes on a majority the votes held rule out, and a proposer that signs
 * two proposals for a round (types/evidence.ts). The votes and proposals of
 * the last heights are kept for that, since the second half of such a pair
 * may come when the height is over.
 * Liveness comes from the timeouts, which grow with the round number.
 *
 * Signature verification is asynchronous (it runs in worker threads), so
 * the handlers for incoming messages await it and then re-check that the
 * message is still relevant before touching state. All state mutation is
 * synchronous and happens on the main thread.
 */
import { encode } from '../codec/writer.ts';
import { HASH_SIZE, bytesEqual, sha256, toHex } from '../crypto/hash.ts';
import { signContext } from '../crypto/keys.ts';
import type { Verifier } from '../crypto/verifier.ts';
import { blockDataBytes, blockHash, commitHash, evidenceHash, type Block, type Commit, type Header } from '../types/block.ts';
import { txsRoot } from '../types/txproof.ts';
import { evidenceHeight, evidenceKey, evidenceValidator, isAmnesia, makeDuplicateProposalEvidence, makeDuplicateVoteEvidence, speaksAgainst, type Evidence, type ProposalHead } from '../types/evidence.ts';
import { zeroSignature } from '../crypto/keys.ts';
import { proposalSignBytes, type Proposal } from '../types/proposal.ts';
import type { ChainState } from '../types/state.ts';
import { prioritiesHash, type Validator, type ValidatorSet } from '../types/validator.ts';
import { VoteType, blockHashKey, encodeVote, sameVoteContent, voteSignBytes, voteTypeName, type Vote } from '../types/vote.ts';
import type { Logger } from '../util/log.ts';
import { EvidencePool, evidenceBytes } from './evidence.ts';
import { DoubleSignError, type PrivValidator } from './privval.ts';
import { DEFAULT_MAX_BLOCK_BYTES } from '../types/genesis.ts';
import { MAX_EVIDENCE_PER_BLOCK, bodyMatchesHeader, evidenceAgeOk, validateBlockStructure, verifyBlockSignatures, type BlockTimeLookup, type ValidationLimits } from './validate.ts';
import { HeightVoteSet, type VoteSet } from './votes.ts';

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
  maxBlockBytes: DEFAULT_MAX_BLOCK_BYTES,
  maxClockDriftMs: 15_000,
  maxEvidenceAgeMs: 7n * 24n * 3_600_000n,
};

export type Step = 'propose' | 'prevote' | 'precommit' | 'commit';
const STEP_ORDER: Record<Step, number> = { propose: 0, prevote: 1, precommit: 2, commit: 3 };

/** Rounds beyond this many ahead of ours are ignored; a round number is otherwise a free CPU budget for a peer. */
export const MAX_ROUND_AHEAD = 1000;
/** Proposals for the next height held until it starts, in all and signed by any one validator. */
const MAX_NEXT_HEIGHT_PROPOSALS = 8;
const MAX_NEXT_HEIGHT_PROPOSALS_PER_VALIDATOR = 2;

/**
 * Heights that are over whose votes and proposals are kept, to hold a late vote or proposal against: a validator
 * that signs twice, or forgets a lock, may show one node the second signature only once the height is decided.
 */
export const PAST_HEIGHTS_KEPT = 16;

/**
 * Votes of one peer whose signatures a node verifies in a second: this many, or eight for each validator if that
 * is more. A round is two votes a validator, and a peer passes each on once, so a peer that follows the protocol
 * stays far below, except when it hands a newly connected peer all the votes of a height at once. Votes over the
 * budget therefore wait, and only what there is no room to keep waiting is dropped.
 */
export const VOTES_PER_PEER_SECOND = 200;
/**
 * Votes over the budget that wait to be verified, of one peer: this many, or 64 for each validator if that is more
 * (what a peer holds of a height that has gone through 32 rounds), and never more than the cap. Of all peers
 * together, twice that.
 */
export const MAX_DEFERRED_VOTES_PER_PEER = 1024;
const DEFERRED_VOTES_CAP = 32_768;
/** How long votes wait before they are tried again. */
const DEFERRED_VOTES_MS = 250;
/** What a peer is charged for each second in which a vote of its was dropped for want of room. */
const VOTE_FLOOD_POINTS = 10;

/** The most evidence that waits for room in the pool. */
const MAX_REFUSED = 64;

/** What is kept of a height that is over. Nothing in it moves consensus; it is there to find evidence in. */
interface PastHeight {
  validators: ValidatorSet;
  votes: HeightVoteSet;
  /** The round the height ended in. Later rounds are not kept and nothing is taken in for them. */
  maxRound: number;
  /** What each round's proposer signed, by round. */
  proposals: Map<number, ProposalHead>;
  /** Rounds whose proposer was already reported for two proposals. */
  proposedTwice: Set<number>;
}

/** What tells one held vote for the next height from another: a conflicting vote differs in its block hash or in the round it names, and is held too. */
const nextHeightVoteKey = (v: Vote): string => `${v.round}:${v.type}:${v.validatorIndex}:${v.blockHash ? toHex(v.blockHash) : ''}:${v.polRound}`;

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
  /** The block this validator precommitted last, by hash: after a restart the block itself may not be at hand. */
  lockedHash: Uint8Array | null = null;
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
  /**
   * What the proposer of each round of this height signed: the first proposal whose signature verified. Apart from
   * `proposals`, which holds what the round decides on and may be a block fetched without a signature.
   */
  private heads = new Map<number, ProposalHead>();
  /** Rounds of this height whose proposer was already reported for two proposals. */
  private proposedTwice = new Set<number>();
  private readonly past = new Map<bigint, PastHeight>();
  /** Evidence this node made that the pool had no room for, by offence, offered again as each height starts. */
  private readonly refused = new Map<string, Evidence>();
  /** For each peer, the second it is in and the votes of it verified in that second. */
  private readonly voteBudgets = new Map<string, { second: bigint; votes: number; charged: boolean }>();
  /** Votes over their peer's budget, by peer, waiting to be verified. */
  private readonly deferredVotes = new Map<string, Map<string, Vote>>();
  /** The signed votes whose signatures are being verified now: a copy that arrives meanwhile waits for nothing and costs nothing. */
  private readonly verifyingVotes = new Set<string>();
  private deferredCount = 0;
  private deferredTimer: NodeJS.Timeout | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  /** Votes for the next height with the key each was verified against, replayed once that height starts. */
  private nextHeightVotes: { vote: Vote; publicKey: Uint8Array }[] = [];
  private readonly nextHeightVoteKeys = new Set<string>();
  /** Proposals for the next height, each signed by the validator of the next set its block names, replayed once that height starts. */
  private nextHeightProposals: { proposal: Proposal; from: string | null; signer: Uint8Array }[] = [];
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
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredTimer = null;
    this.deferredVotes.clear();
    this.deferredCount = 0;
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
    if (this.hvs && st.lastHeight + 1n > this.height) this.keepHeight(st.lastHeight + 1n);
    if (this.refused.size > 0) this.reportRefused(st);
    this.height = st.lastHeight + 1n;
    this.validators = st.validators;
    this.hvs = new HeightVoteSet(this.height, this.validators);
    this.proposals.clear();
    this.heads = new Map();
    this.proposedTwice = new Set();
    this.proposerCache.clear();
    this.prevoteTimeoutScheduled.clear();
    this.precommitTimeoutScheduled.clear();
    this.polkaHandled.clear();
    this.fetchRequested.clear(); // the hashes asked for belong to the height that is over
    // The lock of this height, if the validator precommitted a block in it before a restart.
    const lock = this.d.privValidator?.lockAt(this.height) ?? null;
    this.lockedHash = lock ? lock.blockHash : null;
    this.lockedRound = lock ? lock.round : -1;
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
    const proposals = this.nextHeightProposals.filter((e) => e.proposal.height === this.height);
    this.nextHeightVotes = [];
    this.nextHeightVoteKeys.clear();
    this.nextHeightProposals = [];

    this.startRound(resumeRound);
    for (const v of votes) this.addVote(v, null);
    for (const e of proposals) this.proposalUnawaited(e.proposal, e.from);
  }

  /** Put the height that is over among the kept ones, cut to the round it ended in, and let go of the oldest. */
  private keepHeight(next: bigint): void {
    // The round this node was in, and the round the height was committed in: block sync may have applied a block
    // decided in a later round than this node reached.
    const commit = this.d.getLastCommit();
    const maxRound = Math.max(this.round, this.decided ? this.decidedRound : 0, commit && commit.height === this.height ? commit.round : 0);
    this.hvs.dropRoundsAbove(maxRound);
    for (const r of this.heads.keys()) if (r > maxRound) this.heads.delete(r);
    this.past.set(this.height, { validators: this.validators, votes: this.hvs, maxRound, proposals: this.heads, proposedTwice: this.proposedTwice });
    for (const h of this.past.keys()) if (h + BigInt(PAST_HEIGHTS_KEPT) < next) this.past.delete(h);
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
    this.proposalUnawaited(proposal, null);
  }

  /**
   * Our own proposal and the ones held for this height are handled without being waited for, so nobody else is
   * there to catch a failure. One that comes while stopping is expected: the verifier or the store closed under it.
   */
  private proposalUnawaited(p: Proposal, fromPeer: string | null): void {
    this.handleProposal(p, fromPeer).catch((e: unknown) => {
      this.log(this.running ? 'error' : 'debug', 'handling a proposal failed', { h: p.height, r: p.round, err: e instanceof Error ? e.message : String(e) });
    });
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
    this.d.evidencePool.pruneIf((ev) => evidenceAgeOk(evidenceHeight(ev), st.lastHeight + 1n, time, st, this.limits, this.d.blockTimeAt) !== null);
    // The limit is on the transactions and the evidence. Evidence is picked by count and may have half the limit:
    // by bytes it may be more under a small one, and the last record is left for the next block until it fits.
    // The transactions get what is left, never less than half, which is the most one transaction may be
    // (the mempool admits none larger), so evidence arriving block after block cannot keep a transaction out.
    // A record that is more than the half on its own would keep every other record waiting behind it; the pool
    // takes none in (EvidencePool.maxRecordBytes, set by the node to what fits here).
    const SLACK = 1024;
    let evidence = this.d.evidencePool.list(MAX_EVIDENCE_PER_BLOCK);
    while (evidence.length > 0 && blockDataBytes({ txs: [], evidence }) + SLACK > Math.floor(this.limits.maxBlockBytes / 2)) evidence = evidence.slice(0, -1);
    const budget = this.limits.maxBlockBytes - blockDataBytes({ txs: [], evidence }) - SLACK;
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
        prioritiesHash: prioritiesHash(st.validators, st.nextValidators),
      },
      txs,
      lastCommit,
      evidence,
    };
  }

  // ------------------------------------------------------- incoming proposals

  /**
   * A proposal for the height after this one waits for that height to start. Only a fresh one (no proof of lock)
   * is held, since its signer is then the proposer its block names, and only once that signature verifies with
   * the key the validator of that address holds in the next height's set: nothing takes a place without a
   * validator's signature, whichever peer relays it, and one validator's proposals may take two. Whether the signer is the proposer of its round is decided when
   * the height starts. A proposal not held is not lost; the round's proposer sends it again while the round lasts.
   */
  private async holdNextHeightProposal(p: Proposal, fromPeer: string | null): Promise<void> {
    if (p.polRound !== -1 || p.round > MAX_ROUND_AHEAD || p.block.header.height !== p.height) return;
    const signer = this.d.validatorSetAtHeight(p.height)?.byAddress(p.block.header.proposerAddress);
    if (!signer) return;
    const room = () =>
      this.nextHeightProposals.length < MAX_NEXT_HEIGHT_PROPOSALS &&
      this.nextHeightProposals.filter((e) => bytesEqual(e.signer, signer.address)).length < MAX_NEXT_HEIGHT_PROPOSALS_PER_VALIDATOR &&
      !this.nextHeightProposals.some((e) => e.proposal.round === p.round && bytesEqual(e.signer, signer.address));
    // Before the signature is verified: a proposal there is no place for must not cost a verification.
    if (!room()) return;
    const ok = await this.d.verifier.verifyOne({ sig: p.signature, msg: proposalSignBytes(this.d.chainId, p), publicKey: signer.publicKey, context: this.proposalCtx });
    if (!ok) {
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'bad proposal signature');
      return;
    }
    // Again: others were verified meanwhile, and the height may have moved on.
    if (!this.running || p.height !== this.height + 1n || !room()) return;
    this.nextHeightProposals.push({ proposal: p, from: fromPeer, signer: signer.address });
  }

  async handleProposal(p: Proposal, fromPeer: string | null): Promise<void> {
    if (!this.running) return;
    if (p.height === this.height + 1n) {
      await this.holdNextHeightProposal(p, fromPeer);
      return;
    }
    if (p.height < this.height) {
      await this.handlePastProposal(p, fromPeer);
      return;
    }
    if (p.height !== this.height) return;
    // A proposal for a round that has one is looked at only for what its proposer signed: nothing, if that is known
    // and this says the same, or if the proposer was already reported for signing two.
    const taken = this.proposals.has(p.round);
    const head = this.heads.get(p.round);
    if (taken && head && (this.proposedTwice.has(p.round) || sameProposal(head, p))) return;
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

    // Stopped while the signature was verified: the checks below read stored blocks, and the store may be closed.
    if (!this.running) return;
    // Whatever becomes of the proposal, its proposer signed it. The height may have moved on meanwhile, and then
    // it is held against what is kept of that height.
    this.signedProposal(p);
    if (taken || p.height !== this.height) return;

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

  /**
   * A proposal whose signature verified under the proposer of its round, of this height or a kept one. The first
   * for a round is what the proposer signed; another that says something else is the second half of the proof
   * that it signed twice.
   */
  private signedProposal(p: Proposal): void {
    const kept = p.height === this.height ? null : this.past.get(p.height);
    if (p.height !== this.height && (!kept || p.round > kept.maxRound)) return;
    const [heads, reported, validators] = kept ? [kept.proposals, kept.proposedTwice, kept.validators] : [this.heads, this.proposedTwice, this.validators];
    const second = { polRound: p.polRound, blockHash: blockHash(p.block), signature: p.signature };
    const first = heads.get(p.round);
    if (!first) {
      heads.set(p.round, second);
      return;
    }
    if (reported.has(p.round) || sameProposal(first, p)) return;
    // Marked once the pool holds the proof or it waits for room there.
    if (this.report(makeDuplicateProposalEvidence(p.height, p.round, validators.indexOf(proposerOf(validators, p.round).address), first, second))) reported.add(p.round);
  }

  /** A proposal for a kept height: nothing to decide any more, but beside the one its proposer is known to have signed it may show two. */
  private async handlePastProposal(p: Proposal, fromPeer: string | null): Promise<void> {
    const kept = this.past.get(p.height);
    const first = kept?.proposals.get(p.round);
    if (!kept || !first || kept.proposedTwice.has(p.round) || sameProposal(first, p)) return;
    if (p.polRound < -1 || p.polRound >= p.round || p.block.header.height !== p.height) return;
    // The proposer of the round in that height's set; the round is one the height reached, so the walk is bounded.
    const ok = await this.d.verifier.verifyOne({ sig: p.signature, msg: proposalSignBytes(this.d.chainId, p), publicKey: proposerOf(kept.validators, p.round).publicKey, context: this.proposalCtx });
    if (!ok) {
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'bad proposal signature');
      return;
    }
    if (this.running) this.signedProposal(p);
  }

  /**
   * Evidence this node made itself: into the pool, from where it is announced and proposed. True if the pool holds
   * a proof of the offence afterwards, this one or one it had; false if it had no room.
   */
  private report(ev: Evidence): boolean {
    const pool = this.d.evidencePool;
    if (pool.add(ev)) this.log('warn', 'fault detected', { kind: ev.kind, h: evidenceHeight(ev), validator: evidenceValidator(ev) });
    if (pool.has(ev)) return true;
    // No room now. A proof the pool could take when it has room waits here, since the votes that made it are held
    // already and will not be looked at again; one too large for the pool never fits.
    if (evidenceBytes(ev) > pool.maxRecordBytes || this.refused.size >= MAX_REFUSED) return false;
    this.refused.set(evidenceKey(ev), ev);
    return true;
  }

  /** Offer the pool again what it had no room for, and let go of what has grown too old for any block. */
  private reportRefused(st: ChainState): void {
    for (const [k, ev] of this.refused) {
      const old = evidenceAgeOk(evidenceHeight(ev), st.lastHeight + 1n, st.lastBlockTime, st, this.limits, this.d.blockTimeAt) !== null;
      if (old || this.d.evidencePool.add(ev) || this.d.evidencePool.has(ev)) this.refused.delete(k);
    }
  }

  // ----------------------------------------------------------- incoming votes

  async handleVote(v: Vote, fromPeer: string | null): Promise<void> {
    if (!this.running) return;
    let set: ValidatorSet | null;
    if (v.height === this.height) {
      if (this.hvs.has(v)) return;
      set = this.validators;
    } else if (v.height === this.height + 1n) {
      // One already held is not verified and held again: a peer repeating a valid vote would otherwise have it
      // checked each time and fill the places with copies.
      if (this.nextHeightVoteKeys.has(nextHeightVoteKey(v))) return;
      // By the vote's own height: the executor may have applied this height already, and then the
      // state's "next" set is the one after, whose index positions mean other keys.
      set = this.d.validatorSetAtHeight(v.height);
    } else {
      // A height that is over and still kept: the vote decides nothing, but it may be the second half of evidence.
      const kept = this.past.get(v.height);
      if (!kept || v.round > kept.maxRound || kept.votes.has(v)) return;
      set = kept.validators;
    }
    if (!set) return;
    const val = set.byIndex(v.validatorIndex);
    if (!val) return;
    // Before the signature is verified: a vote this node will not count must not cost it a verification.
    if (v.height >= this.height && v.round > this.round + MAX_ROUND_AHEAD) return;
    // The same signed vote from several peers at once is verified once: the copies say nothing the first does not.
    const id = signedVoteKey(v);
    if (this.verifyingVotes.has(id)) return;
    if (fromPeer !== null && !this.withinVoteBudget(fromPeer, set.size)) return this.deferVote(v, fromPeer, set.size);
    this.verifyingVotes.add(id);
    let ok: boolean;
    try {
      ok = await this.d.verifier.verifyOne({
        sig: v.signature,
        msg: voteSignBytes(this.d.chainId, v),
        publicKey: val.publicKey,
        context: this.voteCtx,
      });
    } catch (e) {
      // The verifier failed, not the vote (a worker that exited, say). Copies that came meanwhile were dropped on
      // the strength of this one, so it is not let go: it waits with the votes over the budget and is tried again.
      this.verifyingVotes.delete(id);
      if (!this.running) return;
      this.log('warn', 'verifying a vote failed; it will be tried again', { err: e instanceof Error ? e.message : String(e) });
      if (fromPeer !== null) this.deferVote(v, fromPeer, set.size);
      return;
    }
    // What follows runs without a pause, so a copy that comes after this finds the vote held, or refused as this one was.
    this.verifyingVotes.delete(id);
    if (!ok) {
      this.log('warn', 'vote with bad signature', { h: v.height, r: v.round, i: v.validatorIndex });
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'bad vote signature');
      return;
    }
    if (!this.running) return;
    if (v.height < this.height) return this.addPastVote(v, fromPeer);
    if (v.round > this.round + MAX_ROUND_AHEAD) return; // again: the height may have moved on, and the round with it
    if (v.height === this.height) this.addVote(v, fromPeer);
    else if (v.height === this.height + 1n && this.nextHeightVotes.length < 4096 && !this.nextHeightVoteKeys.has(nextHeightVoteKey(v))) {
      this.nextHeightVoteKeys.add(nextHeightVoteKey(v));
      this.nextHeightVotes.push({ vote: v, publicKey: val.publicKey });
    }
  }

  /** Whether one more vote of this peer may be verified in the current second, and if so, counted. */
  private withinVoteBudget(peerId: string, validators: number): boolean {
    const b = this.voteBudget(peerId);
    if (b.votes >= Math.max(VOTES_PER_PEER_SECOND, 8 * validators)) return false;
    b.votes++;
    return true;
  }

  private voteBudget(peerId: string): { second: bigint; votes: number; charged: boolean } {
    const second = this.now() / 1000n;
    let b = this.voteBudgets.get(peerId);
    if (!b || b.second !== second) {
      // Peers come and go: what is left of other seconds is let go once there is much of it.
      if (this.voteBudgets.size > 4096) for (const [k, x] of this.voteBudgets) if (x.second !== second) this.voteBudgets.delete(k);
      this.voteBudgets.set(peerId, (b = { second, votes: 0, charged: false }));
    }
    return b;
  }

  /**
   * A vote over its peer's budget waits, unverified, and is taken up again shortly: a peer that hands over all the
   * votes of a height at once, as every node does for a peer that has just connected, is slowed and loses none.
   * What waits is bounded for each peer and in all. A vote there is no room for is dropped, and the peer is
   * charged, once for the second.
   */
  private deferVote(v: Vote, peerId: string, validators: number): void {
    const queue = this.deferredVotes.get(peerId) ?? new Map<string, Vote>();
    // The same signed vote again takes no second place; one with another signature is another vote.
    const id = signedVoteKey(v);
    if (queue.has(id)) return;
    const room = Math.min(DEFERRED_VOTES_CAP, Math.max(MAX_DEFERRED_VOTES_PER_PEER, 64 * validators));
    if (queue.size >= room || this.deferredCount >= 2 * room) {
      const b = this.voteBudget(peerId);
      if (!b.charged) {
        b.charged = true;
        this.log('warn', 'peer sends more votes than are verified or kept waiting', { peer: peerId });
        this.d.scorePeer?.(peerId, VOTE_FLOOD_POINTS, 'vote flood');
      }
      return;
    }
    queue.set(id, v);
    this.deferredVotes.set(peerId, queue);
    this.deferredCount++;
    this.deferredTimer ??= setTimeout(() => this.resumeDeferredVotes(), DEFERRED_VOTES_MS);
  }

  /** Hand the votes that waited to `handleVote` again, in the order they came; those still over the budget wait on. */
  private resumeDeferredVotes(): void {
    this.deferredTimer = null;
    if (!this.running) return;
    const waiting = [...this.deferredVotes];
    this.deferredVotes.clear();
    this.deferredCount = 0;
    for (const [peerId, votes] of waiting) {
      for (const v of votes.values()) {
        this.handleVote(v, peerId).catch((e: unknown) => this.log(this.running ? 'error' : 'debug', 'handling a vote failed', { err: e instanceof Error ? e.message : String(e) }));
      }
    }
  }

  /** Add an already-verified vote for the current height. */
  private addVote(v: Vote, fromPeer: string | null): void {
    if (v.height !== this.height) return;
    const { added, conflict } = this.hvs.add(v);
    if (conflict) {
      this.report(makeDuplicateVoteEvidence(conflict, v));
      // The second vote is as signed as the first, and may complete a proof against another validator.
      for (const ev of faultsShown(this.hvs, this.validators, v)) this.report(ev);
      // The vote set keeps whichever of the two counts for its block, so a majority may have formed.
      if (!this.decided) this.evaluateRules();
      return;
    }
    if (!added) return;
    for (const ev of faultsShown(this.hvs, this.validators, v)) this.report(ev);
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

  /**
   * A verified vote for a kept height. It is held against the votes kept, reported if it shows a fault, and passed
   * on if it is new, so that two votes shown to two nodes still meet at one of them.
   */
  private addPastVote(v: Vote, fromPeer: string | null): void {
    const kept = this.past.get(v.height);
    if (!kept || v.round > kept.maxRound) return;
    const { added, conflict } = kept.votes.add(v);
    if (conflict) this.report(makeDuplicateVoteEvidence(conflict, v));
    if (!added && !conflict) return;
    // Also for the second of two votes in one place: it is as signed as the first.
    for (const ev of faultsShown(kept.votes, kept.validators, v)) this.report(ev);
    if (!added) return;
    this.d.broadcastVote(v, fromPeer);
  }

  // ------------------------------------------------------------------- voting

  private signAndAddVote(type: VoteType, hash: Uint8Array | null, polRound = -1): void {
    const pv = this.d.privValidator;
    if (!pv) return;
    const idx = this.validators.indexOf(pv.address);
    if (idx < 0) return;
    const unsigned = { type, height: this.height, round: this.round, blockHash: hash, polRound, validatorIndex: idx };
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

  /**
   * `polRound` is the proposal's, and is named only in a prevote for its block. A prevote for the block this
   * validator is locked on names the round of the lock if that is later: the lock was taken on +2/3 prevotes for the
   * block in that round, so the claim is true, and it is the one that answers for every earlier precommit of the
   * height. Naming the proposal's older round there would read, beside a precommit for another block in between,
   * as a lock forgotten.
   */
  private prevote(hash: Uint8Array | null, polRound = -1): void {
    if (hash === null) return this.signAndAddVote(VoteType.Prevote, null, -1);
    const locked = this.lockedHash !== null && bytesEqual(this.lockedHash, hash);
    this.signAndAddVote(VoteType.Prevote, hash, locked ? Math.max(polRound, this.lockedRound) : polRound);
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
        // The prevotes behind our valid block, for a peer that missed that polka: without them it cannot accept a
        // re-proposal. And the prevotes behind those: one that names an earlier round counts at a peer only once the
        // peer holds that round's majority too, so the whole line back to the first polka is sent.
        if (this.validBlock && this.validRound >= 0) {
          const valid = blockHash(this.validBlock);
          const rounds = [this.validRound];
          const seen = new Set<number>();
          for (let r = rounds.pop(); r !== undefined; r = rounds.pop()) {
            if (seen.has(r)) continue;
            seen.add(r);
            for (const v of this.hvs.prevotes(r).all()) {
              if (r !== this.round) this.d.broadcastVote(v, null);
              if (v.polRound >= 0 && bytesEqual(v.blockHash, valid)) rounds.push(v.polRound);
            }
          }
        }
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
      const unlockedOrSame = this.lockedRound === -1 || (this.lockedHash !== null && bytesEqual(this.lockedHash, prop.hash));
      this.prevote(prop.valid && unlockedOrSame ? prop.hash : null);
      return true;
    }

    // Line 28: a proposal re-proposing a block that had a polka in an earlier round.
    if (this.step === 'propose' && prop && prop.proposal.polRound >= 0 && prop.proposal.polRound < r) {
      const vr = prop.proposal.polRound;
      if (this.hvs.prevotes(vr).hasQuorumFor(prop.hash)) {
        this.step = 'prevote';
        const canUnlock = this.lockedRound <= vr || (this.lockedHash !== null && bytesEqual(this.lockedHash, prop.hash));
        this.prevote(prop.valid && canUnlock ? prop.hash : null, vr);
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
        this.lockedHash = prop.hash;
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
      locked: this.lockedHash ? toHex(this.lockedHash).slice(0, 12) : null,
      valid: this.validBlock ? toHex(blockHash(this.validBlock)).slice(0, 12) : null,
      decisions: this.decisionCount,
    };
  }
}

/** What tells one signed vote from every other: what it says, whose it is, and the signature, by its hash. */
function signedVoteKey(v: Vote): string {
  return `${v.height}/${v.round}/${v.type}/${v.validatorIndex}/${blockHashKey(v.blockHash)}/${v.polRound}/${toHex(sha256(v.signature))}`;
}

/** Whether a proposal says what its proposer is known to have signed for the round: the same block on the same proof-of-lock round. */
function sameProposal(head: ProposalHead, p: Proposal): boolean {
  return head.polRound === p.polRound && bytesEqual(head.blockHash, blockHash(p.block));
}

/** The proposer of round `r` in a height's validator set as the height began. Costs O(r). */
function proposerOf(validators: ValidatorSet, r: number): Validator {
  if (r === 0) return validators.proposer();
  const copy = validators.copy();
  copy.incrementProposerPriority(r);
  return copy.proposer();
}

/**
 * What a verified vote proves with the votes held for its height, whichever arrived last. The vote is one just
 * added, or the second of two a validator signed for one place, of which the set holds one: both are signed, so
 * where the held one says nothing against a claim and this one does, this one is taken.
 *
 * A forgotten lock: a precommit for one block and a prevote of the same validator for another in a later round
 * that names no proof of lock from the precommit's round or after.
 *
 * A false citation: a prevote for a block that names a round in which +2/3 of the power prevoted something else.
 * The vote added may be the prevote that names the round, or one of the round named that completes the +2/3.
 */
export function faultsShown(votes: HeightVoteSet, validators: ValidatorSet, v: Vote): Evidence[] {
  const out: Evidence[] = [];
  if (v.blockHash !== null) {
    for (const r of votes.roundNumbers()) {
      const other = v.type === VoteType.Prevote ? votes.precommits(r).get(v.validatorIndex) : votes.prevotes(r).get(v.validatorIndex);
      if (!other) continue;
      const [precommit, prevote] = v.type === VoteType.Prevote ? [other, v] : [v, other];
      // One proof of an offence is enough: the pool keeps one a validator and height.
      if (isAmnesia(precommit, prevote)) {
        out.push({ kind: 'amnesia', precommit, prevote });
        break;
      }
    }
  }
  if (v.type !== VoteType.Prevote) return out;
  const citing: Vote[] = v.blockHash !== null && v.polRound >= 0 ? [v] : [];
  for (const r of votes.roundNumbers()) {
    if (r <= v.round) continue;
    for (const w of votes.prevotes(r).all()) if (speaksAgainst(w, v)) citing.push(w);
  }
  // One proof a validator, the smallest in bytes: a larger one may be more than a pool takes where a smaller is not.
  // A minority can sign such prevotes for every round ahead that a node takes votes for and for any number of
  // blocks, so while looking only the cost of each claim is worked out, once for each round and block named, and
  // the votes of a proof are gathered for the winners alone.
  const rounds = new Map<number, (hash: Uint8Array) => Refutation | null>();
  const best = new Map<number, { prevote: Vote; refutation: Refutation }>();
  for (const prevote of citing) {
    let refute = rounds.get(prevote.polRound);
    if (!refute) rounds.set(prevote.polRound, (refute = refuter(votes.prevotes(prevote.polRound), validators, v)));
    const refutation = refute(prevote.blockHash!);
    const had = best.get(prevote.validatorIndex);
    if (refutation && (!had || refutation.bytes < had.refutation.bytes)) best.set(prevote.validatorIndex, { prevote, refutation });
  }
  for (const { prevote, refutation } of best.values()) out.push({ kind: 'falseCitation', prevote, against: refutation.votes() });
  return out;
}

/** The cheapest prevotes that refute a claim, +2/3 of the power not for its block: what they encode to, and the votes, by validator index. */
interface Refutation {
  bytes: number;
  votes(): Vote[];
}

/**
 * For the prevotes held of one round, a function from a block's hash to the cheapest refutation of the claim that
 * the block had +2/3 there, or null if the votes do not make one.
 *
 * A prevote for nil encodes to 32 bytes less than one for a block, and all else in a vote is of one size, so the
 * cheapest set is some number of the heaviest nil prevotes and, with them, as few of the heaviest block prevotes
 * as reach +2/3: one pass over the two lists finds it. Every block the round holds no prevote for is refuted by
 * the same votes, so that answer is worked out once, and the others once for each block the round does hold.
 *
 * A validator that signed two prevotes for the round has prevoted both: the set holds one and keeps the other
 * aside, and `inHand`, the vote being looked at, may be a third. Whichever of them speaks against a claim is
 * taken, nil before a block.
 */
function refuter(round: VoteSet, validators: ValidatorSet, inHand: Vote): (hash: Uint8Array) => Refutation | null {
  const held = round.all();
  const power = (o: Vote) => validators.byIndex(o.validatorIndex)!.power;
  const heaviest = (a: Vote, b: Vote) => (power(a) === power(b) ? a.validatorIndex - b.validatorIndex : power(a) > power(b) ? -1 : 1);
  // The validators with more than one prevote of this round, each with all of them.
  const several = new Map<number, Vote[]>();
  const also = (o: Vote) => {
    const first = round.get(o.validatorIndex);
    if (!first) return;
    const all = several.get(o.validatorIndex) ?? [first];
    if (all.some((x) => sameVoteContent(x, o))) return;
    all.push(o);
    several.set(o.validatorIndex, all);
  };
  for (const o of round.alternates()) also(o);
  if (inHand.type === round.type && inHand.round === round.round) also(inHand);
  const single = several.size === 0 ? held : held.filter((o) => !several.has(o.validatorIndex));
  const nils = single.filter((o) => o.blockHash === null).sort(heaviest);
  const blocks = single.filter((o) => o.blockHash !== null).sort(heaviest);
  const present = new Set<string>();
  for (const o of [...blocks, ...[...several.values()].flat()]) if (o.blockHash) present.add(blockHashKey(o.blockHash));
  const size = (o: Vote) => encode((w) => encodeVote(w, o)).length;
  const nilBytes = size({ ...(held[0] ?? inHand), blockHash: null });
  const blockBytes = nilBytes + HASH_SIZE;

  const cheapest = (hash: Uint8Array | null): Refutation | null => {
    // Of a validator's several prevotes, one that speaks against the claim, nil before a block.
    const speaks = (o: Vote) => hash === null || !bytesEqual(o.blockHash, hash);
    const extra: Vote[] = [];
    for (const all of several.values()) {
      const o = all.find((x) => x.blockHash === null) ?? all.find(speaks);
      if (o) extra.push(o);
    }
    const nil = extra.some((o) => o.blockHash === null) ? [...nils, ...extra.filter((o) => o.blockHash === null)].sort(heaviest) : nils;
    const block = (extra.some((o) => o.blockHash !== null) ? [...blocks, ...extra.filter((o) => o.blockHash !== null)].sort(heaviest) : blocks).filter(speaks);
    // k of the nil prevotes and the fewest block prevotes that reach +2/3 with them, for every k; fewer are needed as k grows.
    let blockPower = 0n;
    let m = 0;
    while (m < block.length) blockPower += power(block[m++]!);
    let nilPower = 0n;
    let found: { k: number; m: number; bytes: number } | null = null;
    for (let k = 0; k <= nil.length; k++) {
      if (k > 0) nilPower += power(nil[k - 1]!);
      if (!validators.isQuorum(nilPower + blockPower)) continue;
      while (m > 0 && validators.isQuorum(nilPower + blockPower - power(block[m - 1]!))) blockPower -= power(block[--m]!);
      const bytes = k * nilBytes + m * blockBytes;
      if (!found || bytes < found.bytes) found = { k, m, bytes };
    }
    if (!found) return null;
    const { k, m: taken, bytes } = found;
    return { bytes, votes: () => [...nil.slice(0, k), ...block.slice(0, taken)].sort((a, b) => a.validatorIndex - b.validatorIndex) };
  };

  let absent: Refutation | null | undefined;
  const byBlock = new Map<string, Refutation | null>();
  return (hash) => {
    const key = blockHashKey(hash);
    // No prevote of the round is for this block: every vote speaks against, as for any other such block.
    if (!present.has(key)) return absent === undefined ? (absent = cheapest(null)) : absent;
    if (!byBlock.has(key)) byBlock.set(key, cheapest(hash));
    return byBlock.get(key)!;
  };
}
