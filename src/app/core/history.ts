/**
 * Account history: one entry per operation for every account the operation
 * names, plus virtual entries for what the chain does on its own (rewards,
 * slashes, jailings, matured unbondings). Derived data outside the state
 * root, written by the application's commit next to the objects, read by the
 * RPC. BitShares keeps the same kind of record per account.
 *
 * Only operations of transactions that succeeded are recorded; a failed
 * transaction has no effect and is found through the transaction index.
 *
 * In the store the entries are one log in block order (HistoryLog, below),
 * each entry pointing back at earlier entries of its account, as Graphene
 * keeps them: a block appends to the end of the log, a few pages, where
 * entries keyed by account landed on a page for every account a block named.
 */
import { decode, Reader } from '../../codec/reader.ts';
import { encode, type Writer } from '../../codec/writer.ts';
import { HASH_SIZE } from '../../crypto/hash.ts';
import { instanceOf, type ObjectId } from '../../db/id.ts';
import { key } from '../../db/keys.ts';
import { prefixEnd, type KvStore, type KvWriter } from '../../store/kv.ts';

export const HistoryKind = {
  operation: 0,
  reward: 1,
  slash: 2,
  jail: 3,
  unjail: 4,
  tombstone: 5,
  unbondingMatured: 6,
  redelegationMatured: 7,
  forcedUnbond: 8,
} as const;
export type HistoryKindValue = (typeof HistoryKind)[keyof typeof HistoryKind];

/** Position of a virtual entry: no transaction. */
export const VIRTUAL = 0xffffffff;

export interface HistoryEntry {
  height: bigint;
  /** Transaction position in the block, or VIRTUAL. */
  position: number;
  opIndex: number;
  kind: HistoryKindValue;
  txHash: Uint8Array | null;
  /** The encoded operation, or the encoded virtual operation. */
  data: Uint8Array;
}

export function encodeHistoryEntry(w: Writer, e: HistoryEntry): void {
  w.u64(e.height).u32(e.position).u32(e.opIndex).u8(e.kind).option(e.txHash, (w, h) => w.fixed(h)).bytes(e.data);
}

export function decodeHistoryEntry(r: Reader): HistoryEntry {
  return { height: r.u64(), position: r.u32(), opIndex: r.u32(), kind: r.u8() as HistoryKindValue, txHash: r.option((r) => r.fixed(HASH_SIZE)), data: r.bytes() };
}

export const historyEntryToBytes = (e: HistoryEntry): Uint8Array => encode((w) => encodeHistoryEntry(w, e));
export const historyEntryFromBytes = (b: Uint8Array): HistoryEntry => decode(b, decodeHistoryEntry);

/** Encodings of the virtual operations' data. */
export const virtualData = {
  reward: (validator: ObjectId, amount: bigint, commission: bigint) => encode((w) => w.u64(validator).u64(amount).u64(commission)),
  slash: (validator: ObjectId, amount: bigint, doubleSign: boolean) => encode((w) => w.u64(validator).u64(amount).bool(doubleSign)),
  validator: (validator: ObjectId) => encode((w) => w.u64(validator)),
  matured: (validator: ObjectId, tokens: bigint) => encode((w) => w.u64(validator).u64(tokens)),
  redelegationMatured: (source: ObjectId, destination: ObjectId, tokens: bigint) => encode((w) => w.u64(source).u64(destination).u64(tokens)),
};

/** The fields of a virtual entry's data, by kind. */
export function decodeVirtualData(kind: HistoryKindValue, data: Uint8Array): Record<string, bigint | boolean> {
  return decode(data, (r): Record<string, bigint | boolean> => {
    switch (kind) {
      case HistoryKind.reward:
        return { validator: r.u64(), amount: r.u64(), commission: r.u64() };
      case HistoryKind.slash:
        return { validator: r.u64(), amount: r.u64(), doubleSign: r.bool() };
      case HistoryKind.jail:
      case HistoryKind.unjail:
      case HistoryKind.tombstone:
        return { validator: r.u64() };
      case HistoryKind.unbondingMatured:
      case HistoryKind.forcedUnbond:
        return { validator: r.u64(), tokens: r.u64() };
      case HistoryKind.redelegationMatured:
        return { source: r.u64(), destination: r.u64(), tokens: r.u64() };
      default:
        return {};
    }
  });
}

export const HISTORY_KIND_NAMES: Record<number, string> = Object.fromEntries(Object.entries(HistoryKind).map(([k, v]) => [v, k]));

/** Collects a block's entries; the application writes them at commit. */
export class HistoryRecorder {
  entries: [ObjectId, HistoryEntry][] = [];
  private pending: [ObjectId, HistoryEntry][] = [];
  private height = 0n;
  private txHash: Uint8Array | null = null;
  private opIndex = 0;
  private position = VIRTUAL;

  reset(height: bigint): void {
    this.entries = [];
    this.pending = [];
    this.height = height;
    this.txHash = null;
    this.position = VIRTUAL;
  }

  beginTx(hash: Uint8Array, position: number): void {
    this.pending = [];
    this.txHash = hash;
    this.position = position;
    this.opIndex = 0;
  }

  /** The operation about to run, so virtual entries it causes point at it. */
  beginOp(index: number): void {
    this.opIndex = index;
  }

  /** Keep the transaction's entries if it succeeded. */
  endTx(ok: boolean): void {
    if (ok) this.entries.push(...this.pending);
    this.pending = [];
    this.txHash = null;
    this.position = VIRTUAL;
  }

  op(accounts: ObjectId[], opIndex: number, data: Uint8Array): void {
    const seen = new Set<ObjectId>();
    for (const a of accounts) {
      if (seen.has(a)) continue;
      seen.add(a);
      this.pending.push([a, { height: this.height, position: this.position, opIndex, kind: HistoryKind.operation, txHash: this.txHash, data }]);
    }
  }

  virtual(account: ObjectId, kind: HistoryKindValue, data: Uint8Array): void {
    const entry: [ObjectId, HistoryEntry] = [account, { height: this.height, position: this.position, opIndex: this.txHash ? this.opIndex : 0, kind, txHash: this.txHash, data }];
    // Inside a transaction the entry stands or falls with it.
    if (this.txHash) this.pending.push(entry);
    else this.entries.push(entry);
  }
}

// Keys of the log in the application's store: 'l' entry by its place in the log, 'p' an account's count and newest
// entry, 'L' the log's length and how much of it the stored 'p' entries cover. 'a' and 'q' are the layout before it (entry by account and sequence, count by account).
const logKey = (index: bigint) => key((k) => k.u8(0x6c).u64(index));
const headKey = (account: ObjectId) => key((k) => k.u8(0x70).u64(account));
const LENGTH_KEY = key((k) => k.u8(0x4c));
const OLD_ENTRIES = key((k) => k.u8(0x61));
const OLD_COUNTS = key((k) => k.u8(0x71));
const NONE = 0xffff_ffff_ffff_ffffn;

/** Where an entry's two pointers lead: the places in the log of its account's previous entry and of an older one. */
interface Links {
  prev: bigint;
  skip: bigint;
}

interface Head {
  count: bigint;
  last: bigint;
}

interface LogRecord extends Links {
  account: ObjectId;
  sequence: bigint;
  entry: HistoryEntry;
}

/** The head of a stored entry, read without the entry after it. */
const decodeLinks = (r: Reader): Links & { account: ObjectId; sequence: bigint } => ({ account: r.u64(), sequence: r.u64(), prev: r.u64(), skip: r.u64() });
const decodeRecord = (r: Reader): LogRecord => ({ ...decodeLinks(r), entry: decodeHistoryEntry(r) });

/**
 * The account history as it is stored: one log, appended to in block order, and for each account the number of its
 * entries and the place of its newest.
 *
 * An entry carries its account's sequence number and two pointers into the log. `prev` is the account's entry
 * before it. `skip` is the account's entry whose sequence is this one's with its lowest set bit cleared (entry 12
 * points at 8, 8 at 0, 7 at 6): with it any entry of an account is found from the newest in about log² steps, so a
 * page from the old end of a long history does not walk the whole of it, and reading oldest first from a sequence
 * number, which a layout keyed by account gave for free, still works. Writing an entry finds its `skip` target by
 * the same walk, one read on average.
 *
 * The heads (an account's count and newest entry) are keyed by account, so writing each at the block that changes
 * it would put back the scattered writes the log removes: about half of what the old layout cost, measured. They
 * wait in memory instead, in SLICES slices of the account numbers, and every block with entries writes the waiting
 * heads of one slice, the next in turn: neighbours in the store, a few pages, and each head within SLICES blocks of
 * its change (all of them at once should HEADS_HELD ever wait). The log is their journal: it records how far the
 * stored heads cover it, the place of the oldest change still waiting, and a log opened after a stop reads the
 * entries from there on, which name their account and sequence, to have the waiting heads back.
 */
export class HistoryLog {
  static readonly SLICES = 64;
  static readonly HEADS_HELD = 50_000;
  private readonly kv: KvStore;
  private length: bigint;
  /** Every head changed by the log's first `covered` entries is stored; the heads changed since wait in `slices`. */
  private covered: bigint;
  /** The waiting heads by slice of the account numbers, and per slice the place in the log of its oldest waiting change. */
  private slices: Map<ObjectId, Head>[] = Array.from({ length: HistoryLog.SLICES }, () => new Map());
  private since: bigint[] = new Array<bigint>(HistoryLog.SLICES).fill(0n);
  /** How many account numbers a slice spans: doubled whenever an account beyond the last slice turns up. */
  private width = 1;
  private held = 0;
  /** The slice the next block writes. */
  private turn = 0;

  constructor(kv: KvStore) {
    this.kv = kv;
    const v = kv.get(LENGTH_KEY);
    [this.length, this.covered] = v ? decode(v, (r) => [r.u64(), r.u64()]) : [0n, 0n];
    for (let index = this.covered; index < this.length; index++) {
      const e = decodeLinks(new Reader(this.stored(index)));
      this.wait(e.account, { count: e.sequence + 1n, last: index });
    }
    this.migrate();
  }

  private slice(account: ObjectId): number {
    return Math.min(HistoryLog.SLICES - 1, Math.floor(instanceOf(account) / this.width));
  }

  /** Keep a head, changed by the entry at `head.last`, until its slice's turn. */
  private wait(account: ObjectId, head: Head): void {
    while (instanceOf(account) >= this.width * HistoryLog.SLICES) {
      // Twice the width: slices 2i and 2i + 1 become slice i.
      const merged = Array.from({ length: HistoryLog.SLICES }, () => new Map<ObjectId, Head>());
      const since = new Array<bigint>(HistoryLog.SLICES).fill(0n);
      this.slices.forEach((waiting, i) => {
        if (waiting.size === 0) return;
        const to = i >> 1;
        if (merged[to]!.size === 0 || this.since[i]! < since[to]!) since[to] = this.since[i]!;
        for (const [a, h] of waiting) merged[to]!.set(a, h);
      });
      this.slices = merged;
      this.since = since;
      this.width *= 2;
    }
    const i = this.slice(account);
    const waiting = this.slices[i]!;
    if (waiting.size === 0) this.since[i] = head.last;
    if (!waiting.has(account)) this.held++;
    waiting.set(account, head);
  }

  private store(w: KvWriter, i: number): void {
    const waiting = this.slices[i]!;
    for (const [account, head] of waiting) w.put(headKey(account), encode((wr) => wr.u64(head.count).u64(head.last)));
    this.held -= waiting.size;
    waiting.clear();
  }

  /** How many entries the account has, and the place in the log of its newest. */
  private head(account: ObjectId): Head {
    const waiting = this.slices[this.slice(account)]!.get(account);
    if (waiting) return waiting;
    const v = this.kv.get(headKey(account));
    return v ? decode(v, (r) => ({ count: r.u64(), last: r.u64() })) : { count: 0n, last: NONE };
  }

  total(account: ObjectId): bigint {
    return this.head(account).count;
  }

  /**
   * From an entry of an account at `index` with sequence `sequence`, the place of its entry `target`, an older one
   * or itself: the skip pointer while it does not pass the target, else the previous entry.
   */
  private locate(index: bigint, sequence: bigint, target: bigint, links: (index: bigint) => Links): bigint {
    while (sequence > target) {
      const l = links(index);
      const skipped = sequence & (sequence - 1n);
      if (skipped >= target) {
        index = l.skip;
        sequence = skipped;
      } else {
        index = l.prev;
        sequence -= 1n;
      }
    }
    return index;
  }

  /**
   * How many entries an account had when the block at `height` had been written: its entries are in height order,
   * so the newest one at or below that height is found from the newest as any entry is, by the skip pointer while
   * the entry it leads to is still above the height and by the previous entry otherwise.
   */
  totalAt(account: ObjectId, height: bigint): bigint {
    const head = this.head(account);
    let index = head.last;
    for (let sequence = head.count - 1n; sequence >= 0n; ) {
      const r = decode(this.stored(index), decodeRecord);
      if (r.entry.height <= height) return sequence + 1n;
      if (sequence === 0n) break;
      const skipped = sequence & (sequence - 1n);
      if (skipped < sequence - 1n && decode(this.stored(r.skip), decodeRecord).entry.height > height) {
        index = r.skip;
        sequence = skipped;
      } else {
        index = r.prev;
        sequence -= 1n;
      }
    }
    return 0n;
  }

  private stored(index: bigint): Uint8Array {
    const v = this.kv.get(logKey(index));
    if (!v) throw new Error(`the account history log has no entry ${index}`);
    return v;
  }

  /** Append a block's entries, in the order they were recorded, as part of the write `w`; with `flush`, the waiting heads too. */
  append(w: KvWriter, entries: Iterable<[ObjectId, HistoryEntry]>, flush = false): void {
    // The store may not show this write's own entries yet, so what the block has added so far is kept here.
    const heads = new Map<ObjectId, Head>();
    const added = new Map<bigint, Links>();
    const links = (index: bigint): Links => added.get(index) ?? decodeLinks(new Reader(this.stored(index)));
    const start = this.length;
    for (const [account, entry] of entries) {
      const head = heads.get(account) ?? this.head(account);
      const sequence = head.count;
      const l: Links = { prev: head.last, skip: sequence === 0n ? NONE : this.locate(head.last, sequence - 1n, sequence & (sequence - 1n), links) };
      const index = this.length++;
      added.set(index, l);
      w.put(logKey(index), encode((wr) => (wr.u64(account).u64(sequence).u64(l.prev).u64(l.skip), encodeHistoryEntry(wr, entry))));
      heads.set(account, { count: sequence + 1n, last: index });
    }
    if (this.length === start) return;
    for (const [account, head] of heads) this.wait(account, head);
    if (flush || this.held >= HistoryLog.HEADS_HELD) for (let i = 0; i < HistoryLog.SLICES; i++) this.store(w, i);
    else this.store(w, this.turn);
    this.turn = (this.turn + 1) % HistoryLog.SLICES;
    this.covered = this.length;
    this.slices.forEach((waiting, i) => {
      if (waiting.size > 0 && this.since[i]! < this.covered) this.covered = this.since[i]!;
    });
    w.put(LENGTH_KEY, encode((wr) => wr.u64(this.length).u64(this.covered)));
  }

  /** An account's entries, oldest first from sequence `from`, or newest first, skipping the newest `from`, when reversed. */
  read(account: ObjectId, from: bigint, limit: number, reverse: boolean): { entries: (HistoryEntry & { sequence: bigint })[]; total: bigint } {
    const head = this.head(account);
    const total = head.count;
    const entries: (HistoryEntry & { sequence: bigint })[] = [];
    // The newest sequence wanted; the entries are read from it backwards either way.
    let sequence = reverse ? total - 1n - from : (from + BigInt(limit) < total ? from + BigInt(limit) : total) - 1n;
    const lowest = reverse ? 0n : from;
    if (limit <= 0 || from < 0n || sequence < lowest) return { entries, total };
    let index = this.locate(head.last, total - 1n, sequence, (i) => decodeLinks(new Reader(this.stored(i))));
    for (; sequence >= lowest && entries.length < limit; sequence--) {
      const r = decode(this.stored(index), decodeRecord);
      entries.push({ ...r.entry, sequence });
      index = r.prev;
    }
    if (!reverse) entries.reverse();
    return { entries, total };
  }

  /**
   * A store written before the log keeps its entries by account and sequence: they are appended to the log by height,
   * each account's in their order, and the old keys removed, in one write. Every entry is held in memory for it,
   * once, the first time such a store is opened.
   */
  private migrate(): void {
    const old: { account: ObjectId; sequence: bigint; entry: HistoryEntry }[] = [];
    for (const [k, v] of this.kv.range(OLD_ENTRIES, prefixEnd(OLD_ENTRIES))) old.push({ ...decode(k, (r) => (r.u8(), { account: r.u64(), sequence: r.u64() })), entry: historyEntryFromBytes(v) });
    const counts = Array.from(this.kv.range(OLD_COUNTS, prefixEnd(OLD_COUNTS)), ([k]) => k);
    if (old.length === 0 && counts.length === 0) return;
    const order = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
    old.sort((a, b) => order(a.entry.height, b.entry.height) || order(a.account, b.account) || order(a.sequence, b.sequence));
    this.kv.write((w) => {
      this.append(w, old.map((o): [ObjectId, HistoryEntry] => [o.account, o.entry]), true);
      for (const o of old) w.del(key((k) => k.u8(0x61).u64(o.account).u64(o.sequence)));
      for (const k of counts) w.del(k);
    });
  }
}
