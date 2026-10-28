/**
 * The mempool holds transactions that passed the application's checkTx and
 * are waiting to be included in a block. Consensus treats them as opaque
 * bytes. Order is first in, first out.
 *
 * Validity depends on state (balances, nonces), so after every commit each
 * remaining transaction is re-checked and anything that no longer passes is
 * evicted. Without this the proposer would fill blocks with dead
 * transactions.
 *
 * A bounded cache of recently seen hashes stops the same transaction from
 * being checked, and gossiped, over and over.
 */
import { EventEmitter } from 'node:events';
import { toHex } from './crypto/hash.ts';
import type { Application } from './app/types.ts';
import { txHash } from './types/block.ts';

export interface MempoolOptions {
  maxTxs: number;
  maxTxBytes: number;
  cacheSize: number;
}

const DEFAULTS: MempoolOptions = { maxTxs: 10_000, maxTxBytes: 1024 * 1024, cacheSize: 100_000 };

export type AddTxStatus = 'added' | 'seen' | 'invalid' | 'full' | 'too-large';

export interface AddTxResult {
  status: AddTxStatus;
  hash: Uint8Array;
  error?: string;
}

export class Mempool extends EventEmitter<{ tx: [hash: Uint8Array, tx: Uint8Array, source: string | null] }> {
  private readonly app: Application;
  private readonly opts: MempoolOptions;
  /** Insertion order is FIFO order. */
  private readonly txs = new Map<string, Uint8Array>();
  private readonly cache = new Set<string>();
  private readonly cacheOrder: string[] = [];

  constructor(app: Application, opts: Partial<MempoolOptions> = {}) {
    super();
    this.app = app;
    this.opts = { ...DEFAULTS, ...opts };
  }

  get size(): number {
    return this.txs.size;
  }

  has(hash: Uint8Array): boolean {
    return this.txs.has(toHex(hash));
  }

  /** True if we have it or have recently seen it; such hashes need not be fetched. */
  seen(hash: Uint8Array): boolean {
    return this.cache.has(toHex(hash));
  }

  get(hash: Uint8Array): Uint8Array | undefined {
    return this.txs.get(toHex(hash));
  }

  private remember(key: string): void {
    if (this.cache.has(key)) return;
    this.cache.add(key);
    this.cacheOrder.push(key);
    while (this.cacheOrder.length > this.opts.cacheSize) this.cache.delete(this.cacheOrder.shift()!);
  }

  async addTx(tx: Uint8Array, source: string | null = null): Promise<AddTxResult> {
    const hash = txHash(tx);
    const key = toHex(hash);
    if (tx.length > this.opts.maxTxBytes) return { status: 'too-large', hash };
    if (this.cache.has(key)) return { status: 'seen', hash };
    if (this.txs.size >= this.opts.maxTxs) return { status: 'full', hash };
    // Mark before the await so a concurrent duplicate is not checked twice.
    this.remember(key);
    let res: Awaited<ReturnType<Application['checkTx']>>;
    try {
      res = await this.app.checkTx(tx);
    } catch (e) {
      this.cache.delete(key); // nothing was decided about it; the next submission checks again
      throw e;
    }
    if (!res.ok) return { status: 'invalid', hash, error: res.error };
    if (this.txs.size >= this.opts.maxTxs) {
      this.cache.delete(key); // the pool filled while we checked; let the sender try again rather than hear "seen"
      return { status: 'full', hash };
    }
    this.txs.set(key, tx);
    this.emit('tx', hash, tx, source);
    return { status: 'added', hash };
  }

  /** Take transactions in FIFO order up to a byte budget. They stay in the pool until committed. */
  reap(maxBytes: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    let used = 0;
    for (const tx of this.txs.values()) {
      const cost = tx.length + 4;
      if (used + cost > maxBytes) break;
      out.push(tx);
      used += cost;
    }
    return out;
  }

  /** Called after a block commits: drop what was included, re-check what remains. */
  async update(committed: Uint8Array[]): Promise<void> {
    for (const tx of committed) this.txs.delete(toHex(txHash(tx)));
    for (const [key, tx] of [...this.txs]) {
      const res = await this.app.checkTx(tx);
      if (!res.ok) this.txs.delete(key);
    }
  }

  /** Current pool contents in FIFO order; for tests and status. */
  list(): Uint8Array[] {
    return [...this.txs.values()];
  }
}
