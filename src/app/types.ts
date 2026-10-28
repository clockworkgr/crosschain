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

export interface CheckTxResult {
  ok: boolean;
  error?: string;
}

export interface TxResult {
  ok: boolean;
  error?: string;
}

/** A validator proven to have double-signed, for the app to slash. */
export interface Misbehavior {
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
  checkTx(tx: Uint8Array): Promise<CheckTxResult>;
  finalizeBlock(req: FinalizeBlockRequest): Promise<FinalizeBlockResult>;
  commit(): Promise<void>;
  info(): Promise<{ lastHeight: bigint; lastAppHash: Uint8Array }>;
}
