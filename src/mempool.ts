/**
 * The mempool holds transactions that passed the application's checkTx and
 * are waiting to be included in a block. Consensus treats them as opaque
 * bytes. Order is first in, first out.
 *
 * Validity depends on state (balances, the block time a transaction expires
 * against, the recent transaction ids), so after every commit each remaining
 * transaction is re-checked and anything that no longer passes is evicted.
 * Without this the proposer would fill blocks with dead transactions.
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
  /** The most bytes of transactions the pool holds. The count alone would let ten thousand of the largest in. */
  maxBytes: number;
  maxTxBytes: number;
  cacheSize: number;
}

const DEFAULTS: MempoolOptions = { maxTxs: 10_000, maxBytes: 64 * 1024 * 1024, maxTxBytes: 1024 * 1024, cacheSize: 100_000 };

export type AddTxStatus = 'added' | 'seen' | 'invalid' | 'full' | 'too-large' | 'paused';

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
  /** The hashes seen lately, each with the place in the ring that stands for it. */
  private readonly cache = new Map<string, number>();
  /** The hashes in the cache in the order they came, as a ring once it is full: the oldest is at cacheHead. */
  private readonly cacheOrder: string[] = [];
  private cacheHead = 0;
  /**
   * Checks the application has admitted and applied to its pending state that are not in the pool yet. Each holds
   * a place, so two checks running at once cannot both be admitted to the last one.
   */
  private reserved = 0;
  /** The bytes of the pooled transactions, and of those that hold a place while they are checked. */
  private pooledBytes = 0;
  private reservedBytes = 0;
  private pausedReason: string | null = null;
  /** How many transactions the pool admits up to just now: maxTxs, or less while the node is short of memory. */
  private limit: number;
  /** How many bytes it admits up to just now: the same share of maxBytes as the limit is of maxTxs. */
  private byteLimit: number;

  constructor(app: Application, opts: Partial<MempoolOptions> = {}) {
    super();
    this.app = app;
    this.opts = { ...DEFAULTS, ...opts };
    this.limit = this.opts.maxTxs;
    this.byteLimit = this.opts.maxBytes;
  }

  /** The most bytes the pool may hold, whatever it admits up to just now. */
  get maxBytes(): number {
    return this.opts.maxBytes;
  }

  /** How many bytes of transactions the pool admits up to just now. */
  get currentByteLimit(): number {
    return this.byteLimit;
  }

  /** The bytes of the transactions in the pool. */
  get bytes(): number {
    return this.pooledBytes;
  }

  /** The most the pool may hold, whatever it admits up to just now. */
  get maxTxs(): number {
    return this.opts.maxTxs;
  }

  /** How many transactions the pool admits up to just now. */
  get currentLimit(): number {
    return this.limit;
  }

  /**
   * Admit up to this many transactions from now on (never more than maxTxs), and the same share of maxBytes. The
   * memory guard lowers it as the heap fills, since every pooled transaction holds its bytes and its writes in the
   * pending state. Lowering it takes nothing out at once: what the pool holds above the new limits leaves at the
   * next commit, the newest first (update), where the pending state is rebuilt without it.
   */
  setLimit(limit: number): void {
    this.limit = Math.max(0, Math.min(this.opts.maxTxs, Math.floor(limit)));
    this.byteLimit = this.opts.maxTxs === 0 ? 0 : Math.floor((this.opts.maxBytes * this.limit) / this.opts.maxTxs);
  }

  /** Whether there is a place and the bytes for a transaction of this length, beside what is pooled and what holds a place. */
  private room(length: number): boolean {
    return this.txs.size + this.reserved < this.limit && this.pooledBytes + this.reservedBytes + length <= this.byteLimit;
  }

  /** Whether a transaction arriving now could be admitted: not paused, and room under the limits for one byte at least. */
  get accepting(): boolean {
    return this.pausedReason === null && this.room(1);
  }

  private get fullReason(): string {
    return this.limit < this.opts.maxTxs ? 'mempool full: its limit is lowered while the node is short of memory' : 'mempool full';
  }

  get size(): number {
    return this.txs.size;
  }

  /** While paused nothing new is admitted (the node is shedding load); what is pooled stays and is still reaped. */
  get paused(): boolean {
    return this.pausedReason !== null;
  }

  pause(reason: string): void {
    this.pausedReason = reason;
  }

  resume(): void {
    this.pausedReason = null;
  }

  has(hash: Uint8Array): boolean {
    return this.txs.has(toHex(hash));
  }

  /** True if we have it or have recently seen it; such hashes need not be fetched. */
  seen(hash: Uint8Array): boolean {
    return this.known(toHex(hash));
  }

  /** The pool is asked as well as the cache: the cache may have let go of a transaction that is still pooled. */
  private known(key: string): boolean {
    return this.cache.has(key) || this.txs.has(key);
  }

  get(hash: Uint8Array): Uint8Array | undefined {
    return this.txs.get(toHex(hash));
  }

  private remember(key: string): void {
    if (this.cache.has(key) || this.opts.cacheSize === 0) return;
    if (this.cacheOrder.length < this.opts.cacheSize) {
      this.cache.set(key, this.cacheOrder.push(key) - 1);
      return;
    }
    // Full: the newest takes the oldest's place. Shifting an array of this size for every transaction instead cost
    // a node under load a twelfth of its time (docs/benchmarks.md section 4.13).
    const place = this.cacheHead;
    // The hash at this place leaves the cache only if this is still its place. One that was forgotten and came
    // again stands further on, and the place it left behind must not take it out early.
    const oldest = this.cacheOrder[place]!;
    if (this.cache.get(oldest) === place) this.cache.delete(oldest);
    this.cacheOrder[place] = key;
    this.cache.set(key, place);
    this.cacheHead = (place + 1) % this.opts.cacheSize;
  }

  /**
   * Forget a hash nothing was decided about, so its next submission is checked again. Its place in the ring stays
   * behind unused until the ring comes round to it.
   */
  private forget(key: string): void {
    this.cache.delete(key);
  }

  async addTx(tx: Uint8Array, source: string | null = null): Promise<AddTxResult> {
    // Before the hash: a transaction refused for its size costs nothing in proportion to it. Its hash is worked
    // out only if the caller reads it.
    if (tx.length > this.opts.maxTxBytes) {
      return {
        status: 'too-large',
        get hash() {
          return txHash(tx);
        },
      };
    }
    const hash = txHash(tx);
    const key = toHex(hash);
    if (this.pausedReason !== null) return { status: 'paused', hash, error: this.pausedReason };
    if (this.known(key)) return { status: 'seen', hash };
    if (!this.room(tx.length)) return { status: 'full', hash, error: this.fullReason };
    // Mark before the await so a concurrent duplicate is not checked twice.
    this.remember(key);
    // The application asks this again after its last wait, so a transaction refused here is not applied to its
    // pending state either. One it admits holds a place in the pool from that moment: the pool's size rises only
    // once the check has returned, and without the place a second check could be admitted to the same last one,
    // applied to the pending state and then refused as full with its writes left there.
    let holdsPlace = false;
    let refused: 'paused' | 'full' | null = null;
    const admit = () => {
      if (this.pausedReason !== null) {
        refused = 'paused';
        return this.pausedReason;
      }
      if (holdsPlace) return null;
      if (!this.room(tx.length)) {
        refused = 'full';
        return this.fullReason;
      }
      holdsPlace = true;
      this.reserved++;
      this.reservedBytes += tx.length;
      return null;
    };
    const release = () => {
      if (holdsPlace) {
        this.reserved--;
        this.reservedBytes -= tx.length;
      }
      holdsPlace = false;
    };
    try {
      let res: Awaited<ReturnType<Application['checkTx']>>;
      try {
        res = await this.app.checkTx(tx, { admit });
      } catch (e) {
        this.forget(key); // nothing was decided about it; the next submission checks again
        throw e;
      }
      // Load shedding may have begun while it was checked: it is refused as one arriving now would be, neither
      // pooled nor gossiped, and forgotten, so it is checked again once the node admits again.
      if (this.pausedReason !== null || refused === 'paused') {
        this.forget(key);
        return { status: 'paused', hash, error: this.pausedReason ?? 'paused while the transaction was checked' };
      }
      // A check that holds a place has room whatever came since. One that holds none (the application did not
      // ask, or refused the transaction before asking) is measured against the pool and the places others hold.
      if (refused === 'full' || (!holdsPlace && !this.room(tx.length))) {
        this.forget(key); // the pool filled while we checked; let the sender try again rather than hear "seen"
        return { status: 'full', hash, error: this.fullReason };
      }
      if (!res.ok) return { status: 'invalid', hash, error: res.error };
      release(); // the place it held becomes its place in the pool
      // Checked twice at once (the cache had let go of it, or holds nothing): it is pooled once and counted once.
      if (this.txs.has(key)) return { status: 'seen', hash };
      this.txs.set(key, tx);
      this.pooledBytes += tx.length;
      this.emit('tx', hash, tx, source);
      return { status: 'added', hash };
    } finally {
      release();
    }
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

  private drop(key: string): void {
    const tx = this.txs.get(key);
    if (tx === undefined) return;
    this.txs.delete(key);
    this.pooledBytes -= tx.length;
  }

  /**
   * Called after a block commits: drop what was included, put out what the limits no longer have room for, re-check
   * what remains.
   *
   * The pool is above its limits only after they were lowered. This is the one moment a transaction can leave
   * without a trace: the application undid its pending state for the block (and is asked to once more here, for
   * what was checked since), and the re-check below rebuilds it from what is still pooled. The oldest stay, as they are the next a block takes; the ones put out are forgotten, so
   * they are checked again when they come again. Returns how many were put out.
   */
  async update(committed: Uint8Array[]): Promise<number> {
    for (const tx of committed) this.drop(toHex(txHash(tx)));
    let evicted = 0;
    if (this.txs.size > this.limit || this.pooledBytes > this.byteLimit) {
      let count = 0;
      let bytes = 0;
      let over = false;
      for (const [key, tx] of [...this.txs]) {
        over ||= count + 1 > this.limit || bytes + tx.length > this.byteLimit;
        if (!over) {
          count++;
          bytes += tx.length;
          continue;
        }
        this.drop(key);
        this.forget(key);
        evicted++;
      }
      // A transaction checked after the block was finalized and before this ran was applied to the new pending
      // state. If one of those was put out its writes are still there, so the application begins that state again,
      // and the re-check below applies what is left.
      if (evicted > 0) this.app.resetPending?.();
    }
    for (const [key, tx] of [...this.txs]) {
      const res = await this.app.checkTx(tx);
      if (!res.ok) this.drop(key);
    }
    return evicted;
  }

  /** Current pool contents in FIFO order; for tests and status. */
  list(): Uint8Array[] {
    return [...this.txs.values()];
  }
}
