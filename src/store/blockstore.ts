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
 * 's' state, 'l' lowest height, 'x' segment, txHash and height (height, position, result), 'y' level, segment,
 * txHash and height (the same entries once moved into larger segments), 'm' level (where that move stands),
 * 'M' the highest block saved with results (what the move stays behind),
 * 'T' the layout of
 * that index ('t' holds it in a store written before it was kept in segments),
 * 'r' height (the block's execution results, for result proofs), 'H' height
 * (a header kept without its block, below the lowest block a state-synced
 * node holds, as far back as evidence may reach), 'L' the lowest such height.
 */
import { decode } from '../codec/reader.ts';
import { encode } from '../codec/writer.ts';
import { key, startsWith } from '../db/keys.ts';
import type { TxResult } from '../app/types.ts';
import { bytesEqual, compareBytes, HASH_SIZE, toHex } from '../crypto/hash.ts';
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
 * around it, on pages already being written; the price is a lookup, which asks every segment that holds
 * something, and the larger segments below (TX_FANOUT) keep those few.
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
const MAX_SEGMENT = 0xffff_ffff_ffff_ffffn;
/**
 * Behind the segments of 32 blocks come larger ones, so that a lookup does not grow with the chain. A segment of
 * level L holds 32 of level L - 1, level 0 being the segments blocks are written to: 32 blocks, 1,024, 32,768 and
 * so on. Once the 32 are all behind the latest block their entries are copied into the one above, in the order of
 * its keys and a few blocks' worth with each block saved, and then removed (mergeTxLevel). A lookup asks each
 * level, and in each only the segments that hold something, of which a level keeps a few dozen. Level 0 is under
 * 'x', level L under 'y' and the level's number; the rest of the key is the same.
 */
export const TX_FANOUT = 32n;
/** The last level: its segments are 32^12 blocks, and sixteen of them hold every height there is. */
const TX_TOP_LEVEL = 11;
const txSpan = (level: number) => TX_SEGMENT_BLOCKS * TX_FANOUT ** BigInt(level);
const txLevelHead = (level: number) => (level === 0 ? TX_PREFIX : Uint8Array.of(0x79, level));
/** Where a segment of a level starts, or the level's end for a segment past the last a u64 names. */
const txSegment = (level: number, segment: bigint) => (segment > MAX_SEGMENT ? prefixEnd(txLevelHead(level)) : key((k) => k.fixed(txLevelHead(level)).u64(segment)));
/** The highest block saved with its results, which is the latest the node applied: the larger segments fill behind it. */
const TX_TIP_KEY = Uint8Array.of(0x4d);
/** What follows the segment in a key: the hash and the height. */
const TX_SUFFIX = HASH_SIZE + 8;
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
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
        // What lies far enough behind the latest block applied here moves up a level. Each entry is copied and
        // later removed, so a step that handles three times what the block added keeps pace with the blocks,
        // those a backfill stores included, and spreads the work over most of them.
        const applied = this.kv.get(TX_TIP_KEY);
        // A store written before the marker was kept has none: its chain state knows the latest block.
        const before = applied ? decode(applied, (r) => r.u64()) : (this.loadState()?.lastHeight ?? 0n);
        const tip = results && h > before ? h : before;
        if (tip > 0n && (!applied || tip > before)) w.put(TX_TIP_KEY, encode((wr) => wr.u64(tip)));
        const lowest = this.lowestHeight();
        for (let level = 0; level < TX_TOP_LEVEL; level++) this.mergeTxLevel(w, level, tip, lowest, Math.max(512, 3 * seen.size));
      }
    });
  }

  loadResults(height: bigint): TxResult[] | null {
    const v = this.kv.get(resultsKey(height));
    return v ? decode(v, (r) => r.array((r) => ({ ok: r.bool(), error: r.string() }))) : null;
  }

  txLocations(hash: Uint8Array): TxLocation[] {
    // One location a height. A level-0 entry is the block's own; one in a larger segment is a copy, which outlives
    // a block that was removed until its whole segment is dropped, and yields to an entry further down.
    const found = new Map<bigint, TxLocation>();
    for (const l of this.txLocationsAt(0, hash)) found.set(l.height, l);
    for (let level = 1; level <= TX_TOP_LEVEL; level++) {
      for (const l of this.txLocationsAt(level, hash)) if (!found.has(l.height) && this.holds(blockKey(l.height))) found.set(l.height, l);
    }
    if (this.oldTxIndex) {
      const prefix = oldTxPrefix(hash);
      for (const [, v] of this.kv.range(prefix, prefixEnd(prefix))) {
        const l = decodeTx(v);
        if (!found.has(l.height)) found.set(l.height, l);
      }
    }
    return [...found.values()].sort((a, b) => (a.height < b.height ? -1 : a.height > b.height ? 1 : 0));
  }

  private holds(k: Uint8Array): boolean {
    return this.kv.has ? this.kv.has(k) : this.kv.get(k) !== undefined;
  }

  /** The hash's entries in the segments of one level. */
  private txLocationsAt(level: number, hash: Uint8Array): TxLocation[] {
    const found: TxLocation[] = [];
    const head = txLevelHead(level);
    const end = prefixEnd(head);
    // A read or two per segment that holds something: from where the hash would be in a segment, the first key
    // there is either an entry of the hash, or it names the next segment that has anything, and the segments
    // between are passed over.
    for (let segment = 0n; ; ) {
      const prefix = concat(txSegment(level, segment), hash);
      let next: bigint | null = null;
      for (const [k, v] of this.kv.range(prefix, end)) {
        if (k.length !== head.length + 8 + TX_SUFFIX) continue; // not an entry of the index: nothing writes one, and it says nothing of the segments
        if (startsWith(k, prefix)) {
          found.push(decodeTx(v));
          continue;
        }
        const at = decode(k.subarray(head.length, head.length + 8), (r) => r.u64());
        // Past the hash in the segment asked: the next one may have it. A later segment's first key says the same of
        // that segment when it sorts after the hash's entries there; otherwise that segment is asked.
        const there = concat(txSegment(level, at), hash);
        next = at === segment || (compareBytes(k, there) > 0 && !startsWith(k, there)) ? at + 1n : at;
        break;
      }
      if (next === null || next > MAX_SEGMENT) break;
      segment = next;
    }
    return found;
  }

  /**
   * One step of moving a level's entries into the segments above it, made with each block saved. The first segment
   * of the level that holds anything names the larger segment to fill. That one is filled only once the blocks it
   * covers are all behind the latest and none is below the lowest held, and the levels further down have nothing
   * left for it. Its 32 segments are first copied into it, a step taking the entries that come next in the order
   * of hash and height whichever of the 32 they are in, so that the segment above is written in the order of its
   * keys; then they are emptied front to back, an entry the segment above holds being removed and one it does
   * not hold, or holds with another value, being written there first. Where the work stands is kept under 'm' and
   * the level, written with the entries it speaks of. Entries of the level above in segments wholly below the
   * lowest height are removed here too; they are copies of blocks that were pruned.
   */
  private mergeTxLevel(w: KvWriter, level: number, tip: bigint, lowest: bigint, budget: number): void {
    const head = txLevelHead(level);
    const end = prefixEnd(head);
    const size = head.length + 8 + TX_SUFFIX;
    const span = txSpan(level + 1);
    const pruned: Uint8Array[] = [];
    for (const [k] of this.kv.range(txLevelHead(level + 1), txSegment(level + 1, lowest / span))) {
      pruned.push(k);
      if (pruned.length === budget) break;
    }
    for (const k of pruned) w.del(k);
    const stateKey = Uint8Array.of(0x6d, level);
    const stored = this.kv.get(stateKey);
    let state = stored ? decode(stored, (r) => ({ parent: r.u64(), removing: r.bool(), cursor: r.bytes() })) : null;
    const save = (st: NonNullable<typeof state>) => w.put(stateKey, encode((wr) => wr.u64(st.parent).bool(st.removing).bytes(st.cursor)));
    if (state && lowest > (state.parent === 0n ? 1n : state.parent * span)) {
      // Pruning reached the segment being filled: what is left of it below goes with its blocks.
      w.del(stateKey);
      state = null;
    }
    // A key under the index's prefixes that is not an entry of it is removed where a step meets one, 64 in a step
    // at most: nothing writes one, and left where it is it would be met again by every step.
    let strays = 0;
    const stray = (k: Uint8Array): boolean => {
      w.del(k);
      return ++strays === 64;
    };
    if (!state) {
      let parent: bigint | null = null;
      for (let from: Uint8Array = head, tries = 0; tries < 4 && parent === null; tries++) {
        let first: Uint8Array | null = null;
        for (const [k] of this.kv.range(from, end)) {
          if (k.length === size) first = k;
          if (first || stray(k)) break;
        }
        if (!first) return;
        const p = decode(first.subarray(head.length, head.length + 8), (r) => r.u64()) / TX_FANOUT;
        if ((p + 1n) * span > tip) return; // not all behind the latest block, and no later one is
        if (lowest <= (p === 0n ? 1n : p * span)) parent = p;
        else from = txSegment(level, (p + 1n) * TX_FANOUT); // partly pruned, or not yet backfilled: left as it is
      }
      if (parent === null) return;
      for (let l = 0; l < level; l++) {
        for (const [k] of this.kv.range(txSegment(l, (parent * span) / txSpan(l)), txSegment(l, ((parent + 1n) * span) / txSpan(l)))) {
          if (k.length === txLevelHead(l).length + 8 + TX_SUFFIX || stray(k)) return; // more is on its way up
        }
      }
      state = { parent, removing: false, cursor: new Uint8Array(0) };
    }
    const target = txSegment(level + 1, state.parent);
    const first = state.parent * TX_FANOUT;
    if (state.removing) {
      const rows: [Uint8Array, Uint8Array][] = [];
      for (const e of this.kv.range(txSegment(level, first), txSegment(level, first + TX_FANOUT))) {
        if (e[0].length === size) rows.push(e);
        else if (stray(e[0])) break;
        if (rows.length === budget) break;
      }
      for (const [k, v] of rows) {
        // Not above, or not with this value: it reached its segment after the copy had passed its place.
        const above = concat(target, k.subarray(head.length + 8));
        if (!bytesEqual(this.kv.get(above) ?? null, v)) w.put(above, v);
        w.del(k);
      }
      if (rows.length < budget && strays < 64) w.del(stateKey);
      return;
    }
    // The entries that come next after the cursor, whichever of the 32 they are in: the first of each is held, the
    // smallest is taken and the one after it in its segment takes its place.
    const cursors: Iterator<[Uint8Array, Uint8Array]>[] = [];
    const next = (it: Iterator<[Uint8Array, Uint8Array]>): [Uint8Array, Uint8Array] | null => {
      for (;;) {
        const step = it.next();
        if (step.done) return null;
        if (step.value[0].length === size) return step.value;
        if (strays >= 64 || stray(step.value[0])) return null;
      }
    };
    // Held in descending order of what follows the segment, so the smallest is the last.
    const held: { suffix: Uint8Array; value: Uint8Array; from: number }[] = [];
    const hold = (e: [Uint8Array, Uint8Array] | null, from: number): void => {
      if (!e) return;
      const suffix = e[0].subarray(head.length + 8);
      let lo = 0;
      for (let hi = held.length; lo < hi; ) {
        const mid = (lo + hi) >> 1;
        if (compareBytes(held[mid]!.suffix, suffix) > 0) lo = mid + 1;
        else hi = mid;
      }
      held.splice(lo, 0, { suffix, value: e[1], from });
    };
    const taken: { suffix: Uint8Array; value: Uint8Array }[] = [];
    try {
      for (let c = first; c < first + TX_FANOUT; c++) {
        const from = state.cursor.length ? concat(concat(txSegment(level, c), state.cursor), Uint8Array.of(0)) : txSegment(level, c);
        cursors.push(this.kv.range(from, txSegment(level, c + 1n))[Symbol.iterator]());
        hold(next(cursors[cursors.length - 1]!), cursors.length - 1);
      }
      while (taken.length < budget && held.length > 0) {
        const least = held.pop()!;
        taken.push(least);
        hold(next(cursors[least.from]!), least.from);
      }
    } finally {
      for (const it of cursors) it.return?.();
    }
    for (const e of taken) w.put(concat(target, e.suffix), e.value);
    // Nothing after the cursor: the copy is done. Unless the step stopped at keys that are not entries, in which
    // case there may be more behind them, and the next step, which no longer meets them, will say.
    if (taken.length > 0) save({ parent: state.parent, removing: false, cursor: taken[taken.length - 1]!.suffix });
    else if (strays < 64) save({ parent: state.parent, removing: true, cursor: new Uint8Array(0) });
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
