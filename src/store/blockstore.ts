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
 * 's' state, 'l' lowest height, 'x' segment, txHash and height (height, position, result), 'T' the layout of
 * that index ('t' holds it in a store written before it was kept in segments),
 * 'r' height (the block's execution results, for result proofs), 'H' height
 * (a header kept without its block, below the lowest block a state-synced
 * node holds, as far back as evidence may reach), 'L' the lowest such height.
 */
import { decode } from '../codec/reader.ts';
import { encode } from '../codec/writer.ts';
import { key, startsWith } from '../db/keys.ts';
import type { TxResult } from '../app/types.ts';
import { compareBytes, HASH_SIZE, toHex } from '../crypto/hash.ts';
import { blockHash, decodeBlock, decodeCommit, decodeHeader, encodeBlock, encodeCommit, encodeHeader, txHash, type Block, type Commit, type Header } from '../types/block.ts';
import { decodeState, encodeState, type ChainState } from '../types/state.ts';
import { ValidatorSet } from '../types/validator.ts';
import { MemoryKv, prefixEnd, StoreReadOnlyError, type KvStore } from './kv.ts';
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
  /**
   * Where a transaction landed: the block it succeeded in if there is one, otherwise the newest block that carries
   * it. A transaction that failed can be included again, so one hash can have several locations.
   */
  txLocation(hash: Uint8Array): TxLocation | null;
  /** Every block still held that carries the transaction, oldest first. */
  txLocations(hash: Uint8Array): TxLocation[];
  /** The execution results of a block applied here, null if it was only stored. */
  loadResults(height: bigint): TxResult[] | null;
  loadState(): ChainState | null;
  saveState(state: ChainState): void;
  loadValidatorSet(hash: Uint8Array): ValidatorSet | null;
  saveValidatorSet(set: ValidatorSet): void;
  /** Remove a set by hash; the caller has found that no header still held and no state names it. */
  deleteValidatorSet(hash: Uint8Array): void;
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
  /** Remove a block with its hash and transaction index entries, its results and the validator set stored for its height. */
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
/**
 * How many blocks share a segment of the transaction index. An index keyed by the hash alone puts every
 * transaction of a block on a page of its own once the index is large, and a block's write grows with the chain
 * (docs/benchmarks.md section 4.13). Keyed by segment first, a block's entries go among those of the few blocks
 * around it, on pages already being written; the price is a lookup, which asks every segment the store holds.
 */
export const TX_SEGMENT_BLOCKS = 32n;
/**
 * One entry per block a transaction is in, under its block's segment. A store written before the segments has its
 * entries under 't', by hash and height or, older still, by hash alone; they are moved once, when the store is
 * next opened (migrateTxIndex), and 'T' records that.
 */
const TX_LAYOUT_KEY = Uint8Array.of(0x54);
const TX_LAYOUT = 3;
const TX_PREFIX = Uint8Array.of(0x78);
const OLD_TX_PREFIX = Uint8Array.of(0x74);
const txKey = (hash: Uint8Array, height: bigint) => key((k) => k.u8(0x78).u64(height / TX_SEGMENT_BLOCKS).fixed(hash).u64(height));
const txPrefix = (segment: bigint, hash: Uint8Array) => key((k) => k.u8(0x78).u64(segment).fixed(hash));
const TX_KEY_SIZE = 1 + 8 + HASH_SIZE + 8;
const MAX_SEGMENT = 0xffff_ffff_ffff_ffffn;
const oldTxPrefix = (hash: Uint8Array) => key((k) => k.u8(0x74).fixed(hash));
const encodeTx = (height: bigint, index: number, r: TxResult | null | undefined) => encode((wr) => wr.u64(height).u32(index).u8(r ? (r.ok ? 1 : 0) : 2).string(r?.error ?? ''));
const decodeTx = (v: Uint8Array): TxLocation =>
  decode(v, (r) => {
    const height = r.u64();
    const index = r.u32();
    const ok = r.u8();
    return { height, index, ok: ok === 2 ? null : ok === 1, error: r.string() };
  });
const resultsKey = (h: bigint) => key((k) => k.u8(0x72).u64(h));
const headerKey = (h: bigint) => key((k) => k.u8(0x48).u64(h));
const LOWEST_HEADER_KEY = key((k) => k.u8(0x4c));

export class KvBlockStore implements BlockStore {
  private readonly kv: KvStore;
  /** The writer of a batch in progress; every save joins it instead of opening its own transaction. */
  private open: KvWriter | null = null;
  /** Whether entries of an older layout still lie under 't': the store was opened read-only, so they could not be moved. */
  private oldTxIndex = false;

  constructor(kv: KvStore) {
    this.kv = kv;
    this.migrateTxIndex();
  }

  /**
   * Move a transaction index of an older layout, under 't', into the segments, a few thousand entries a write; the
   * marker goes in last, so a move that was cut short is taken up again. Either older layout has the height in the
   * entry's value. A store opened read-only is left as it is, and txLocations reads the older entries where they
   * lie; any other failure of a write is the caller's to see, and the store is not opened.
   */
  private migrateTxIndex(): void {
    if (this.kv.get(TX_LAYOUT_KEY)?.[0] === TX_LAYOUT) return;
    this.oldTxIndex = true;
    const end = prefixEnd(OLD_TX_PREFIX);
    try {
      for (;;) {
        // What a pass moved is gone from under 't', so each pass starts at the front of what is left.
        const old: [Uint8Array, Uint8Array][] = [];
        for (const e of this.kv.range(OLD_TX_PREFIX, end)) {
          old.push(e);
          if (old.length === 5000) break;
        }
        this.kv.write((w) => {
          for (const [k, v] of old) {
            w.put(txKey(k.subarray(1, 1 + HASH_SIZE), decodeTx(v).height), v);
            w.del(k);
          }
          if (old.length < 5000) w.put(TX_LAYOUT_KEY, Uint8Array.of(TX_LAYOUT));
        });
        if (old.length < 5000) break;
      }
      this.oldTxIndex = false;
    } catch (e) {
      if (!(e instanceof StoreReadOnlyError)) throw e;
    }
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
        // A transaction repeated in one block is indexed once: at the first position it succeeded at, or at its
        // first position when it succeeded nowhere (or the block was stored without executing it).
        const seen = new Map<string, { hash: Uint8Array; index: number }>();
        block.txs.forEach((tx, i) => {
          const hash = txHash(tx);
          const k = toHex(hash);
          const first = seen.get(k);
          if (!first || (results && !results[first.index]?.ok && results[i]?.ok)) seen.set(k, { hash, index: i });
        });
        for (const { hash, index } of seen.values()) w.put(txKey(hash, h), encodeTx(h, index, results?.[index]));
        if (results) w.put(resultsKey(h), encode((wr) => wr.array(results, (wr, r) => wr.bool(r.ok).string(r.error ?? ''))));
      }
    });
  }

  loadResults(height: bigint): TxResult[] | null {
    const v = this.kv.get(resultsKey(height));
    return v ? decode(v, (r) => r.array((r) => ({ ok: r.bool(), error: r.string() }))) : null;
  }

  txLocations(hash: Uint8Array): TxLocation[] {
    const found: TxLocation[] = [];
    const end = prefixEnd(TX_PREFIX);
    // A read or two per segment held: from where the hash would be in a segment, the first key there is either an
    // entry of the hash, or it names the next segment that has anything, and the segments between are passed over.
    for (let segment = 0n; ; ) {
      const prefix = txPrefix(segment, hash);
      let next: bigint | null = null;
      for (const [k, v] of this.kv.range(prefix, end)) {
        if (k.length !== TX_KEY_SIZE) continue; // not an entry of the index: nothing writes one, and it says nothing of the segments
        if (startsWith(k, prefix)) {
          found.push(decodeTx(v));
          continue;
        }
        const at = decode(k.subarray(1, 9), (r) => r.u64());
        // Past the hash in the segment asked: the next one may have it. A later segment's first key says the same of
        // that segment when it sorts after the hash's entries there; otherwise that segment is asked.
        const there = txPrefix(at, hash);
        next = at === segment || (compareBytes(k, there) > 0 && !startsWith(k, there)) ? at + 1n : at;
        break;
      }
      if (next === null || next > MAX_SEGMENT) break;
      segment = next;
    }
    if (this.oldTxIndex) {
      const prefix = oldTxPrefix(hash);
      for (const [, v] of this.kv.range(prefix, prefixEnd(prefix))) found.push(decodeTx(v));
    }
    return found.sort((a, b) => (a.height < b.height ? -1 : a.height > b.height ? 1 : 0));
  }

  txLocation(hash: Uint8Array): TxLocation | null {
    const all = this.txLocations(hash);
    return all.find((l) => l.ok === true) ?? all[all.length - 1] ?? null;
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
      // The set by height serves a state-sync join at a snapshot height, which needs the block of that height too:
      // without the block the record answers nothing. Sets by hash are the executor's to remove, once no header
      // still held names them.
      w.del(valsetAtKey(height));
      for (const tx of stored.block.txs) w.del(txKey(txHash(tx), height));
    });
  }

  loadValidatorSet(hash: Uint8Array): ValidatorSet | null {
    const v = this.kv.get(valsetKey(hash));
    return v ? decode(v, ValidatorSet.decode) : null;
  }

  saveValidatorSet(set: ValidatorSet): void {
    this.write((w) => w.put(valsetKey(set.hash()), encode((wr) => set.encode(wr))));
  }

  deleteValidatorSet(hash: Uint8Array): void {
    this.write((w) => w.del(valsetKey(hash)));
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
