/**
 * What the RPC pushes: one listener on the executor fans out to event
 * streams and to callers waiting for a transaction to land.
 */
import type { CoreApp } from '../app/core/app.ts';
import type { TxResult } from '../app/types.ts';
import { toHex } from '../crypto/hash.ts';
import type { Node } from '../node/node.ts';
import { blockHash, txHash, type Block, type Commit } from '../types/block.ts';
import type { ValidatorUpdate } from '../types/validator.ts';
import type { HistoryEntry } from '../app/core/history.ts';
import type { ObjectId } from '../db/id.ts';

export interface TxLanded {
  hash: Uint8Array;
  height: bigint;
  index: number;
  ok: boolean;
  error: string;
}

export interface CommittedEvent {
  block: Block;
  commit: Commit;
  results: TxResult[];
  updates: ValidatorUpdate[];
  history: [ObjectId, HistoryEntry][];
}

/** Commit waiters held at once; beyond this, callers poll instead. */
const MAX_WAITERS = 1000;

export class RpcEvents {
  private readonly listeners = new Set<(e: CommittedEvent) => void>();
  private readonly waiters = new Map<string, Set<(t: TxLanded) => void>>();

  constructor(node: Node) {
    node.executor.onCommitted((block, commit, results, updates) => {
      const app = node.app as Partial<CoreApp>;
      const history = Array.isArray(app.lastHistory) ? app.lastHistory : [];
      const e: CommittedEvent = { block, commit, results, updates, history };
      for (const fn of this.listeners) fn(e);
      block.txs.forEach((tx, i) => {
        const set = this.waiters.get(toHex(txHash(tx)));
        if (!set) return;
        const r = results[i]!;
        for (const w of set) w({ hash: txHash(tx), height: block.header.height, index: i, ok: r.ok, error: r.error ?? '' });
      });
    });
  }

  onCommitted(fn: (e: CommittedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolves with where the transaction landed, or null on timeout. */
  /** Waiters outstanding across all callers. */
  waiting = 0;

  /** Null when too many waits are already outstanding; the caller then tells its client to poll. */
  waitForTx(hash: Uint8Array, timeoutMs: number): { promise: Promise<TxLanded | null>; cancel(): void } | null {
    if (this.waiting >= MAX_WAITERS) return null;
    this.waiting++;
    let counted = true;
    const uncount = () => {
      if (counted) this.waiting--;
      counted = false;
    };
    const k = toHex(hash);
    let set = this.waiters.get(k);
    if (!set) this.waiters.set(k, (set = new Set()));
    let resolveFn: (t: TxLanded | null) => void = () => {};
    const cleanup = () => {
      uncount();
      set!.delete(handler);
      if (set!.size === 0) this.waiters.delete(k);
      clearTimeout(timer);
    };
    const handler = (t: TxLanded) => {
      cleanup();
      resolveFn(t);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolveFn(null);
    }, timeoutMs);
    set.add(handler);
    return {
      promise: new Promise((resolve) => {
        resolveFn = resolve;
      }),
      cancel: () => {
        cleanup();
        resolveFn(null);
      },
    };
  }
}

export function blockEventJson(e: CommittedEvent): unknown {
  return {
    height: e.block.header.height.toString(),
    hash: toHex(blockHash(e.block)),
    time: e.block.header.time.toString(),
    txs: e.block.txs.length,
    failed: e.results.filter((r) => !r.ok).length,
    appHash: toHex(e.block.header.appHash),
    proposer: toHex(e.block.header.proposerAddress),
  };
}
