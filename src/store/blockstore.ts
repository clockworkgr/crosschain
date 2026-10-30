/**
 * Persistence for committed blocks, their commits, chain state, and
 * validator sets by hash, on a key-value store.
 *
 * Validator sets are stored by hash rather than by height because they
 * rarely change and each one can be large (1.3 KB per validator with
 * ML-DSA-44 keys). A block header names its set by hash, so the set that signed any
 * past height can be found in two lookups. That is what evidence
 * verification needs. Blocks are also indexed by hash for queries.
 *
 * Key layout: 'b' height, 'h' blockHash, 'v' validatorSetHash, 'V' height
 * (the set that signs it, with its proposer priorities, for state sync),
 * 's' state, 'l' lowest height, 't' txHash (height, position, result),
 * 'r' height (the block's execution results, for result proofs), 'H' height
 * (a header kept without its block, below the lowest block a state-synced
 * node holds, as far back as evidence may reach), 'L' the lowest such height.
 */
import { decode } from '../codec/reader.ts';
import { encode } from '../codec/writer.ts';
import { key } from '../db/keys.ts';
import type { TxResult } from '../app/types.ts';
import { toHex } from '../crypto/hash.ts';
import { blockHash, decodeBlock, decodeCommit, decodeHeader, encodeBlock, encodeCommit, encodeHeader, txHash, type Block, type Commit, type Header } from '../types/block.ts';
import { decodeState, encodeState, type ChainState } from '../types/state.ts';
import { ValidatorSet } from '../types/validator.ts';
import { MemoryKv, type KvStore } from './kv.ts';
import type { KvWriter } from './kv.ts';

/** Where a transaction landed. `ok` is null for a block stored without executing it. */
export interface TxLocation {
  height: bigint;
  index: number;
  ok: boolean | null;
  error: string;
}

export interface BlockStore {
  loadBlock(height: bigint): { block: Block; commit: Commit } | null;
  /**
   * With results, the block's transactions are indexed by hash with their
   * outcome; with null they are indexed as not executed here (backfill); left
   * out, the index is not touched (a commit update).
   */
  saveBlock(block: Block, commit: Commit, results?: TxResult[] | null): void;
  heightOf(hash: Uint8Array): bigint | null;
  txLocation(hash: Uint8Array): TxLocation | null;
  /** The execution results of a block applied here, null if it was only stored. */
  loadResults(height: bigint): TxResult[] | null;
  loadState(): ChainState | null;
  saveState(state: ChainState): void;
  loadValidatorSet(hash: Uint8Array): ValidatorSet | null;
  saveValidatorSet(set: ValidatorSet): void;
  /** The exact set, priorities included, that signs a height. */
  loadValidatorsAt(height: bigint): ValidatorSet | null;
  saveValidatorsAt(height: bigint, set: ValidatorSet): void;
  /** The oldest height held contiguously up to the latest; 1 unless the node state-synced or pruned. */
  lowestHeight(): bigint;
  setLowestHeight(height: bigint): void;
  /**
   * A header kept without its block: history below the lowest block, fetched
   * at a state-sync join as far back as evidence may reach, so the validator
   * set and the time of any height evidence can name are known. Records are
   * contiguous from the lowest header height up to the lowest block.
   */
  loadHeader(height: bigint): Header | null;
  saveHeader(header: Header): void;
  deleteHeader(height: bigint): void;
  /** The lowest height with a header record; null when there is none. */
  lowestHeaderHeight(): bigint | null;
  setLowestHeaderHeight(height: bigint | null): void;
  /** Remove a block with its hash and transaction index entries. */
  deleteBlock(height: bigint): void;
  /** Run several saves as one store transaction, so a crash leaves all or none of them. */
  batch(fn: () => void): void;
}

const STATE_KEY = key((k) => k.u8(0x73));
const LOWEST_KEY = key((k) => k.u8(0x6c));
const blockKey = (h: bigint) => key((k) => k.u8(0x62).u64(h));
const hashKey = (hash: Uint8Array) => key((k) => k.u8(0x68).fixed(hash));
const valsetKey = (hash: Uint8Array) => key((k) => k.u8(0x76).fixed(hash));
const valsetAtKey = (height: bigint) => key((k) => k.u8(0x56).u64(height));
const txKey = (hash: Uint8Array) => key((k) => k.u8(0x74).fixed(hash));
const resultsKey = (h: bigint) => key((k) => k.u8(0x72).u64(h));
const headerKey = (h: bigint) => key((k) => k.u8(0x48).u64(h));
const LOWEST_HEADER_KEY = key((k) => k.u8(0x4c));

export class KvBlockStore implements BlockStore {
  private readonly kv: KvStore;
  /** The writer of a batch in progress; every save joins it instead of opening its own transaction. */
  private open: KvWriter | null = null;

  constructor(kv: KvStore) {
    this.kv = kv;
  }

  batch(fn: () => void): void {
    if (this.open) {
      fn();
      return;
    }
    this.kv.write((w) => {
      this.open = w;
      try {
        fn();
      } finally {
        this.open = null;
      }
    });
  }

  private write(fn: (w: KvWriter) => void): void {
    if (this.open) fn(this.open);
    else this.kv.write(fn);
  }

  loadBlock(height: bigint): { block: Block; commit: Commit } | null {
    const b = this.kv.get(blockKey(height));
    return b ? decode(b, (r) => ({ block: decodeBlock(r), commit: decodeCommit(r) })) : null;
  }

  saveBlock(block: Block, commit: Commit, results?: TxResult[] | null): void {
    const h = block.header.height;
    this.write((w) => {
      w.put(
        blockKey(h),
        encode((wr) => {
          encodeBlock(wr, block);
          encodeCommit(wr, commit);
        }),
      );
      w.put(hashKey(blockHash(block)), encode((wr) => wr.u64(h)));
      if (results !== undefined) {
        // A transaction repeated in one block can only have succeeded once, at its first position.
        const seen = new Set<string>();
        block.txs.forEach((tx, i) => {
          const hash = txHash(tx);
          const k = toHex(hash);
          if (seen.has(k)) return;
          seen.add(k);
          const r = results?.[i];
          w.put(txKey(hash), encode((wr) => wr.u64(h).u32(i).u8(r ? (r.ok ? 1 : 0) : 2).string(r?.error ?? '')));
        });
        if (results) w.put(resultsKey(h), encode((wr) => wr.array(results, (wr, r) => wr.bool(r.ok).string(r.error ?? ''))));
      }
    });
  }

  loadResults(height: bigint): TxResult[] | null {
    const v = this.kv.get(resultsKey(height));
    return v ? decode(v, (r) => r.array((r) => ({ ok: r.bool(), error: r.string() }))) : null;
  }

  txLocation(hash: Uint8Array): TxLocation | null {
    const v = this.kv.get(txKey(hash));
    if (!v) return null;
    return decode(v, (r) => {
      const height = r.u64();
      const index = r.u32();
      const ok = r.u8();
      return { height, index, ok: ok === 2 ? null : ok === 1, error: r.string() };
    });
  }

  heightOf(hash: Uint8Array): bigint | null {
    const v = this.kv.get(hashKey(hash));
    return v ? decode(v, (r) => r.u64()) : null;
  }

  loadState(): ChainState | null {
    const s = this.kv.get(STATE_KEY);
    return s ? decode(s, decodeState) : null;
  }

  saveState(state: ChainState): void {
    this.write((w) => w.put(STATE_KEY, encode((wr) => encodeState(wr, state))));
  }

  lowestHeight(): bigint {
    const v = this.kv.get(LOWEST_KEY);
    return v ? decode(v, (r) => r.u64()) : 1n;
  }

  setLowestHeight(height: bigint): void {
    this.write((w) => w.put(LOWEST_KEY, encode((wr) => wr.u64(height))));
  }

  loadHeader(height: bigint): Header | null {
    const v = this.kv.get(headerKey(height));
    return v ? decode(v, decodeHeader) : null;
  }

  saveHeader(header: Header): void {
    this.write((w) => w.put(headerKey(header.height), encode((wr) => encodeHeader(wr, header))));
  }

  deleteHeader(height: bigint): void {
    this.write((w) => w.del(headerKey(height)));
  }

  lowestHeaderHeight(): bigint | null {
    const v = this.kv.get(LOWEST_HEADER_KEY);
    return v ? decode(v, (r) => r.u64()) : null;
  }

  setLowestHeaderHeight(height: bigint | null): void {
    this.write((w) => (height === null ? w.del(LOWEST_HEADER_KEY) : w.put(LOWEST_HEADER_KEY, encode((wr) => wr.u64(height)))));
  }

  deleteBlock(height: bigint): void {
    const stored = this.loadBlock(height);
    if (!stored) return;
    this.write((w) => {
      w.del(blockKey(height));
      w.del(hashKey(blockHash(stored.block)));
      w.del(resultsKey(height));
      for (const tx of stored.block.txs) w.del(txKey(txHash(tx)));
    });
  }

  loadValidatorSet(hash: Uint8Array): ValidatorSet | null {
    const v = this.kv.get(valsetKey(hash));
    return v ? decode(v, ValidatorSet.decode) : null;
  }

  saveValidatorSet(set: ValidatorSet): void {
    this.write((w) => w.put(valsetKey(set.hash()), encode((wr) => set.encode(wr))));
  }

  loadValidatorsAt(height: bigint): ValidatorSet | null {
    const v = this.kv.get(valsetAtKey(height));
    return v ? decode(v, ValidatorSet.decode) : null;
  }

  saveValidatorsAt(height: bigint, set: ValidatorSet): void {
    this.write((w) => w.put(valsetAtKey(height), encode((wr) => set.encode(wr))));
  }
}

export class MemoryBlockStore extends KvBlockStore {
  constructor() {
    super(new MemoryKv());
  }
}
