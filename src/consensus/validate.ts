/**
 * Block validation shared by consensus (for proposals) and block sync (for
 * downloaded blocks). Structural checks are synchronous; signature checks
 * go through the verifier.
 */
import { bytesEqual } from '../crypto/hash.ts';
import { signContext } from '../crypto/keys.ts';
import type { Verifier } from '../crypto/verifier.ts';
import { blockBytes, blockHash, commitHash, evidenceHash, type Block, type Commit } from '../types/block.ts';
import { txsRoot } from '../types/txproof.ts';
import type { ChainState } from '../types/state.ts';
import type { ValidatorSet } from '../types/validator.ts';
import { VoteType, voteSignBytes } from '../types/vote.ts';
import { verifyDuplicateVoteEvidence } from './evidence.ts';

export interface ValidationLimits {
  maxBlockBytes: number;
  /** How far a proposed block time may be from local time, in ms. */
  maxClockDriftMs: number;
  /** Evidence for an infraction older than this, by block time, is rejected. Equal to the staking unbonding period. */
  maxEvidenceAgeMs: bigint;
}

/** Whether a block's body is the one its header commits to: transactions, evidence and the last commit. A relay can pair a signed header with another body. */
export function bodyMatchesHeader(b: Block): boolean {
  return bytesEqual(txsRoot(b.txs), b.header.dataHash) && bytesEqual(evidenceHash(b.evidence), b.header.evidenceHash) && bytesEqual(commitHash(b.lastCommit), b.header.lastCommitHash);
}

/** Block time of a committed height, or null if unknown. */
export type BlockTimeLookup = (height: bigint) => bigint | null;

/** Is evidence for `infractionHeight` still young enough at a block with time `atMs`? */
export function evidenceAgeOk(infractionHeight: bigint, atHeight: bigint, atMs: bigint, state: ChainState, limits: ValidationLimits, blockTimeAt: BlockTimeLookup): string | null {
  if (infractionHeight > atHeight) return 'evidence from the future';
  const t = infractionHeight === atHeight ? atMs : infractionHeight === state.lastHeight ? state.lastBlockTime : blockTimeAt(infractionHeight);
  if (t === null) return 'evidence for an unknown height';
  if (atMs - t > limits.maxEvidenceAgeMs) return 'evidence too old';
  return null;
}

/** Checks that need no signatures. Returns an error string or null. */
export function validateBlockStructure(state: ChainState, block: Block, limits: ValidationLimits, nowMs: bigint | null, blockTimeAt: BlockTimeLookup): string | null {
  const h = block.header;
  if (h.chainId !== state.chainId) return 'wrong chain id';
  if (h.version !== state.version) return `protocol version ${h.version}, expected ${state.version}`;
  if (h.height !== state.lastHeight + 1n) return `wrong height ${h.height}, expected ${state.lastHeight + 1n}`;
  if (!bytesEqual(h.lastBlockHash, state.lastBlockHash)) return 'wrong lastBlockHash';
  if (!bytesEqual(h.validatorsHash, state.validators.hash())) return 'wrong validatorsHash';
  if (!bytesEqual(h.nextValidatorsHash, state.nextValidators.hash())) return 'wrong nextValidatorsHash';
  if (!bytesEqual(h.appHash, state.appHash)) return 'wrong appHash';
  if (!bytesEqual(h.dataHash, txsRoot(block.txs))) return 'wrong dataHash';
  if (!bytesEqual(h.lastResultsHash, state.lastResultsHash)) return 'wrong lastResultsHash';
  if (!bytesEqual(h.evidenceHash, evidenceHash(block.evidence))) return 'wrong evidenceHash';
  if (!bytesEqual(h.lastCommitHash, commitHash(block.lastCommit))) return 'wrong lastCommitHash';
  if (h.time <= state.lastBlockTime) return 'block time not after last block time';
  if (nowMs !== null) {
    const drift = h.time > nowMs ? h.time - nowMs : nowMs - h.time;
    if (drift > BigInt(limits.maxClockDriftMs)) return `block time drift ${drift}ms exceeds limit`;
  }
  if (!state.validators.byAddress(h.proposerAddress)) return 'proposer not in validator set';
  if (h.height === 1n) {
    if (block.lastCommit !== null) return 'height 1 must have no lastCommit';
  } else {
    const c = block.lastCommit;
    if (c === null) return 'missing lastCommit';
    if (c.height !== state.lastHeight) return 'lastCommit height mismatch';
    if (!bytesEqual(c.blockHash, state.lastBlockHash)) return 'lastCommit is for a different block';
    if (c.signatures.length !== state.lastValidators.size) return 'lastCommit signature count mismatch';
  }
  for (const ev of block.evidence) {
    const age = evidenceAgeOk(ev.voteA.height, h.height, h.time, state, limits, blockTimeAt);
    if (age) return age;
  }
  if (blockBytes(block).length > limits.maxBlockBytes) return 'block too large';
  return null;
}

/**
 * Verify that `commit` finalises `hash` under `valset`: enough power, and
 * every included signature is a valid precommit from the validator at that
 * index. Returns an error string or null.
 */
export async function verifyCommit(
  chainId: string,
  valset: ValidatorSet,
  hash: Uint8Array,
  commit: Commit,
  verifier: Verifier,
): Promise<string | null> {
  if (!bytesEqual(commit.blockHash, hash)) return 'commit is for a different block';
  if (commit.signatures.length !== valset.size) return 'commit signature count mismatch';
  const ctx = signContext(chainId, 'vote');
  const jobs = [];
  let power = 0n;
  for (let i = 0; i < commit.signatures.length; i++) {
    const sig = commit.signatures[i];
    if (sig === null) continue;
    const val = valset.byIndex(i)!;
    power += val.power;
    jobs.push({
      sig,
      msg: voteSignBytes(chainId, { type: VoteType.Precommit, height: commit.height, round: commit.round, blockHash: hash, validatorIndex: i }),
      publicKey: val.publicKey,
      context: ctx,
    });
  }
  if (!valset.isQuorum(power)) return 'commit lacks +2/3 power';
  const results = await verifier.verify(jobs);
  if (results.some((ok) => !ok)) return 'invalid signature in commit';
  return null;
}

/** Verify a block's lastCommit and evidence against the chain state. */
export async function verifyBlockSignatures(
  chainId: string,
  state: ChainState,
  block: Block,
  verifier: Verifier,
  validatorSetAtHeight: (h: bigint) => ValidatorSet | null,
): Promise<string | null> {
  if (block.lastCommit) {
    const err = await verifyCommit(chainId, state.lastValidators, state.lastBlockHash, block.lastCommit, verifier);
    if (err) return `lastCommit: ${err}`;
  }
  for (const ev of block.evidence) {
    const set = validatorSetAtHeight(ev.voteA.height);
    if (!set) return `no validator set for evidence height ${ev.voteA.height}`;
    const err = await verifyDuplicateVoteEvidence(chainId, ev, set, verifier);
    if (err) return `evidence: ${err}`;
  }
  return null;
}

