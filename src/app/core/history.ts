/**
 * Account history: one entry per operation for every account the operation
 * names, plus virtual entries for what the chain does on its own (rewards,
 * slashes, jailings, matured unbondings). Derived data outside the state
 * root, written by the application's commit next to the objects, read by the
 * RPC. BitShares keeps the same kind of record per account.
 *
 * Only operations of transactions that succeeded are recorded; a failed
 * transaction has no effect and is found through the transaction index.
 */
import { decode, type Reader } from '../../codec/reader.ts';
import { encode, type Writer } from '../../codec/writer.ts';
import { HASH_SIZE } from '../../crypto/hash.ts';
import type { ObjectId } from '../../db/id.ts';

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
