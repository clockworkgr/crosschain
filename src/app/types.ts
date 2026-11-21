/**
 * The boundary between consensus and the application, in the spirit of
 * Cosmos's ABCI but as an in-process interface. Consensus never looks inside
 * a transaction; the application never sees a vote.
 *
 * Call order during normal operation:
 *   initChain       once, on a fresh data directory
 *   checkTx         for every transaction entering the mempool, and again
 *                   for everything still pending after each commit
 *   finalizeBlock   once per committed block, with all its transactions
 *   commit          immediately after, to persist
 *   info            on startup, so consensus can replay blocks the app missed
 */
import type { Genesis } from '../types/genesis.ts';
import type { ValidatorUpdate } from '../types/validator.ts';

export interface CheckTxOptions {
  /**
   * Asked after the check's last wait, just before the transaction would go into the pending state: why the caller no
   * longer takes it (the mempool paused or filled while it was checked), or null. A refusal leaves nothing behind.
   */
  admit?: () => string | null;
}

export interface CheckTxResult {
  ok: boolean;
  error?: string;
}

export interface TxResult {
  ok: boolean;
  error?: string;
}

/**
 * A validator proven at fault by evidence in the block, for the app to slash: two votes in one place, two
 * proposals for one round, a lock forgotten, or a prevote on a majority that never was.
 */
export interface Misbehavior {
  kind: 'duplicateVote' | 'amnesia' | 'duplicateProposal' | 'falseCitation';
  address: Uint8Array;
  height: bigint;
}

export interface FinalizeBlockRequest {
  height: bigint;
  time: bigint;
  txs: Uint8Array[];
  proposerAddress: Uint8Array;
  /** Addresses whose precommits were included in this block's lastCommit. For rewards. */
  lastCommitSigners: Uint8Array[];
  misbehavior: Misbehavior[];
}

export interface FinalizeBlockResult {
  appHash: Uint8Array;
  txResults: TxResult[];
  validatorUpdates: ValidatorUpdate[];
}

export interface InitChainResult {
  appHash: Uint8Array;
  /** If non-empty, replaces the genesis validator set. */
  validators?: ValidatorUpdate[];
}

export interface Application {
  initChain(genesis: Genesis): Promise<InitChainResult>;
  checkTx(tx: Uint8Array, opts?: CheckTxOptions): Promise<CheckTxResult>;
  /**
   * Undo what checkTx applied since the last block, for an application that keeps a pending state. The mempool
   * calls it after a commit when it has put transactions out, and then checks again what it still holds.
   */
  resetPending?(): void;
  finalizeBlock(req: FinalizeBlockRequest): Promise<FinalizeBlockResult>;
  /**
   * Persist the block just finalized. An application that keeps its state in the engine's store environment does
   * its writes before its first await, so that they join the transaction the engine saves the block in (executor.ts).
   */
  commit(): Promise<void>;
  info(): Promise<{ lastHeight: bigint; lastAppHash: Uint8Array }>;
}
