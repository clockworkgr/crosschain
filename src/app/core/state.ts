/**
 * Small state helpers shared by the evaluators and the staking rules.
 */
import type { ObjectDatabase } from '../../db/database.ts';
import { idToString, type ObjectId } from '../../db/id.ts';
import { key } from '../../db/keys.ts';
import type { Logger } from '../../util/log.ts';
import type { HistoryRecorder } from './history.ts';
import { AccountType, AssetType, BalanceType, DYNAMIC_ID, DynamicType, GLOBAL_ID, GlobalType, type Account, type Asset, type Balance, type DynamicProperties, type GlobalProperties } from './types.ts';

export class TxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxError';
  }
}

export interface EvalContext {
  db: ObjectDatabase;
  /** Block time for a block, last block time for a mempool check. */
  time: bigint;
  /** Height being applied, or the next height for a mempool check. */
  height: bigint;
  /** True when applying a committed block rather than checking for the mempool. */
  final: boolean;
  log?: Logger;
  /** Present when applying a block: receives the accounts each operation touched. */
  history?: HistoryRecorder;
}

export function getGlobal(db: ObjectDatabase): GlobalProperties {
  return db.get(GlobalType, GLOBAL_ID)!;
}

export function getDynamic(db: ObjectDatabase): DynamicProperties {
  return db.get(DynamicType, DYNAMIC_ID)!;
}

export function accountOf(db: ObjectDatabase, id: ObjectId): Account {
  const a = db.get(AccountType, id);
  if (!a) throw new TxError(`account ${idToString(id)} does not exist`);
  return a;
}

export function assetOf(db: ObjectDatabase, id: ObjectId): Asset {
  const a = db.get(AssetType, id);
  if (!a) throw new TxError(`asset ${idToString(id)} does not exist`);
  return a;
}

export function findBalance(db: ObjectDatabase, owner: ObjectId, asset: ObjectId): Balance | null {
  return db.lookup(BalanceType, 'byOwnerAsset', key((k) => k.id(owner).id(asset)));
}

export function balanceOf(db: ObjectDatabase, owner: ObjectId, asset: ObjectId): bigint {
  return findBalance(db, owner, asset)?.amount ?? 0n;
}

/** Add delta (possibly negative) to a balance, creating the balance object on first receipt. */
export function adjustBalance(db: ObjectDatabase, owner: ObjectId, asset: ObjectId, delta: bigint): void {
  const b = findBalance(db, owner, asset);
  const next = (b?.amount ?? 0n) + delta;
  if (next < 0n) throw new TxError(`${accountOf(db, owner).name} has insufficient ${assetOf(db, asset).symbol}`);
  if (b) db.modify(BalanceType, b.id, (x) => ({ ...x, amount: next }));
  else db.create(BalanceType, (id) => ({ id, owner, asset, amount: next }));
}

/** Tokens into or out of the community pool. */
export function adjustPool(db: ObjectDatabase, delta: bigint): void {
  db.modify(DynamicType, DYNAMIC_ID, (d) => {
    if (d.communityPool + delta < 0n) throw new TxError('community pool cannot go negative');
    return { ...d, communityPool: d.communityPool + delta };
  });
}
