/**
 * Staking rules (STAKING.md): validators, delegations with an exchange rate,
 * the unbonding and redelegation queues, rewards from the community pool, the
 * bonded-ratio mint, downtime and double-sign slashing, parameter proposals,
 * and the active set handed to the engine.
 *
 * A validator holds `tokens` and `shares`; a delegation owns shares. The rate
 * tokens/shares rises with rewards and falls with slashes, so every delegator's
 * value moves together and nothing is tracked per delegator. Shares are scaled
 * so integer division loses at most one base unit, in the validator's favour.
 *
 * beginBlock runs before a block's transactions and endBlock after. Neither
 * opens a session, because a block is final; a throw here is a bug, not a
 * bad transaction.
 */
import { toHex } from '../../crypto/hash.ts';
import { addressOf } from '../../crypto/keys.ts';
import type { ObjectDatabase } from '../../db/database.ts';
import { idToString, type ObjectId } from '../../db/id.ts';
import { key } from '../../db/keys.ts';
import type { ValidatorUpdate } from '../../types/validator.ts';
import type { Logger } from '../../util/log.ts';
import type { FinalizeBlockRequest } from '../types.ts';
import { HistoryKind, virtualData, type HistoryRecorder } from './history.ts';
import { accountOf, adjustBalance, adjustPool, assetOf, getDynamic, getGlobal, TxError } from './state.ts';
import {
  AssetType,
  DelegationType,
  DYNAMIC_ID,
  DynamicType,
  GLOBAL_ID,
  GlobalType,
  ProposalType,
  RedelegationType,
  SigningInfoType,
  UnbondingType,
  ValidatorKeyType,
  ValidatorStatus,
  ValidatorType,
  type ActiveValidator,
  type Delegation,
  type Proposal,
  type SigningInfo,
  type StakingParameters,
  type Validator,
} from './types.ts';

export const SHARE_SCALE = 1000n;
const BPS = 10_000n;
const MAX_U64 = (1n << 64n) - 1n;
const PPB_PER_BPS = 100_000n;
const YEAR_MS = 365n * 24n * 3_600_000n;

// ---- lookups ----

export function validatorOf(db: ObjectDatabase, id: ObjectId): Validator {
  const v = db.get(ValidatorType, id);
  if (!v) throw new TxError(`validator ${idToString(id)} does not exist`);
  return v;
}

/** By the current consensus key, or by any key the validator used before. */
export function validatorByAddress(db: ObjectDatabase, address: Uint8Array): Validator | null {
  const current = db.lookup(ValidatorType, 'byConsensusAddress', key((k) => k.fixed(address)));
  if (current) return current;
  const record = db.lookup(ValidatorKeyType, 'byAddress', key((k) => k.fixed(address)));
  return record ? db.get(ValidatorType, record.validator) : null;
}

/** A consensus key may serve one validator, ever. */
export function keyEverUsed(db: ObjectDatabase, address: Uint8Array): boolean {
  return db.lookup(ValidatorKeyType, 'byAddress', key((k) => k.fixed(address))) !== null;
}

export function recordValidatorKey(db: ObjectDatabase, validator: ObjectId, consensusKey: Uint8Array): void {
  const address = addressOf(consensusKey);
  db.create(ValidatorKeyType, (id) => ({ id, address, validator }));
}

export function validatorByOperator(db: ObjectDatabase, operator: ObjectId): Validator | null {
  return db.lookup(ValidatorType, 'byOperator', key((k) => k.id(operator)));
}

export function delegationOf(db: ObjectDatabase, delegator: ObjectId, validator: ObjectId): Delegation | null {
  return db.lookup(DelegationType, 'byDelegatorValidator', key((k) => k.id(delegator).id(validator)));
}

export function signingInfoOf(db: ObjectDatabase, validator: ObjectId): SigningInfo | null {
  return db.lookup(SigningInfoType, 'byValidator', key((k) => k.id(validator)));
}

export function precisionOf(db: ObjectDatabase): number {
  return assetOf(db, getGlobal(db).coreAsset).precision;
}

/** Voting power: whole tokens. */
export function powerOf(tokens: bigint, precision: number): bigint {
  return tokens / 10n ** BigInt(precision);
}

// ---- shares ----

export function tokensForShares(v: Validator, shares: bigint): bigint {
  return v.shares === 0n ? 0n : (shares * v.tokens) / v.shares;
}

export function sharesForTokens(v: Validator, tokens: bigint): bigint {
  return v.shares === 0n || v.tokens === 0n ? tokens * SHARE_SCALE : (tokens * v.shares) / v.tokens;
}

/** What the operator's own delegation is worth. */
export function selfBondOf(db: ObjectDatabase, v: Validator): bigint {
  return tokensForShares(v, delegationOf(db, v.operator, v.id)?.shares ?? 0n);
}

/** Put tokens behind a validator for a delegator. The caller has already taken them from somewhere. */
export function bond(db: ObjectDatabase, delegator: ObjectId, v: Validator, tokens: bigint): Validator {
  const shares = sharesForTokens(v, tokens);
  if (shares === 0n) throw new TxError('delegation is worth no shares at this exchange rate');
  if (v.shares + shares > MAX_U64 || v.tokens + tokens > MAX_U64) throw new TxError('delegation would overflow the validator');
  const updated = db.modify(ValidatorType, v.id, (x) => ({ ...x, tokens: x.tokens + tokens, shares: x.shares + shares }));
  const d = delegationOf(db, delegator, v.id);
  if (d) db.modify(DelegationType, d.id, (x) => ({ ...x, shares: x.shares + shares }));
  else db.create(DelegationType, (id) => ({ id, delegator, validator: v.id, shares }));
  return updated;
}

/** Take shares out of a delegation; returns the tokens they were worth. An emptied delegation is removed. */
export function unbond(db: ObjectDatabase, d: Delegation, v: Validator, shares: bigint): { tokens: bigint; validator: Validator } {
  const tokens = tokensForShares(v, shares);
  const validator = db.modify(ValidatorType, v.id, (x) => ({ ...x, tokens: x.tokens - tokens, shares: x.shares - shares }));
  if (d.shares === shares) db.remove(DelegationType, d.id);
  else db.modify(DelegationType, d.id, (x) => ({ ...x, shares: x.shares - shares }));
  return { tokens, validator };
}

/** Pay a validator: tokens rise for everyone, and the commission is minted as shares to the operator. */
/** Pay a validator: tokens rise for everyone, and the commission is minted as shares to the operator. Returns false if it could not be paid. */
export function reward(db: ObjectDatabase, v: Validator, amount: bigint, commissionBps: number): boolean {
  if (amount <= 0n) return false;
  // Shares outstanding over no tokens (a full slash) have no exchange rate to mint commission at; the pool keeps the reward.
  if (v.tokens === 0n && v.shares > 0n) return false;
  const commission = (amount * BigInt(commissionBps)) / BPS;
  let updated = db.modify(ValidatorType, v.id, (x) => ({ ...x, tokens: x.tokens + amount }));
  // With no shares outstanding the operator is the only party; everything is its commission.
  let minted = updated.shares === 0n ? amount * SHARE_SCALE : (commission * updated.shares) / (updated.tokens - commission);
  if (updated.shares + minted > MAX_U64) minted = 0n; // the operator forgoes commission rather than break the block
  if (minted === 0n) return true;
  updated = db.modify(ValidatorType, v.id, (x) => ({ ...x, shares: x.shares + minted }));
  const d = delegationOf(db, v.operator, v.id);
  if (d) db.modify(DelegationType, d.id, (x) => ({ ...x, shares: x.shares + minted }));
  else db.create(DelegationType, (id) => ({ id, delegator: v.operator, validator: v.id, shares: minted }));
  return true;
}

/** Cut a validator's tokens by a fraction; the tokens go to the community pool. */
export function slash(db: ObjectDatabase, v: Validator, bps: number): Validator {
  const amount = (v.tokens * BigInt(bps)) / BPS;
  if (amount === 0n) return v;
  adjustPool(db, amount);
  return db.modify(ValidatorType, v.id, (x) => ({ ...x, tokens: x.tokens - amount }));
}

function windowBytes(window: number): number {
  return Math.ceil(window / 8);
}

function freshSigningInfo(validator: ObjectId, window: number): Omit<SigningInfo, 'id'> {
  return { validator, bitmap: new Uint8Array(windowBytes(window)), cursor: 0, missed: 0, tracked: 0 };
}

export function resetSigningInfo(db: ObjectDatabase, validator: ObjectId, window: number): void {
  const info = signingInfoOf(db, validator);
  if (info) db.modify(SigningInfoType, info.id, (x) => ({ ...x, ...freshSigningInfo(validator, window) }));
  else db.create(SigningInfoType, (id) => ({ id, ...freshSigningInfo(validator, window) }));
}

export function createValidator(db: ObjectDatabase, operator: ObjectId, consensusKey: Uint8Array, selfBond: bigint, height: bigint): Validator {
  const v = db.create(ValidatorType, (id) => ({ id, operator, consensusKey, tokens: 0n, shares: 0n, status: ValidatorStatus.candidate, jailedUntil: 0n, createdHeight: height }));
  recordValidatorKey(db, v.id, consensusKey);
  resetSigningInfo(db, v.id, getGlobal(db).staking.downtimeWindow);
  return bond(db, operator, v, selfBond);
}

/** How many pending entries a delegator has under an index prefix. */
export function pendingEntries(db: ObjectDatabase, type: typeof UnbondingType | typeof RedelegationType, index: string, prefix: Uint8Array): number {
  let n = 0;
  for (const _ of db.scan(type as typeof UnbondingType, index, prefix)) n++;
  return n;
}

// ---- the set ----

/** Top N candidates by stake with power of at least one and the self-bond met. */
export function computeActiveSet(db: ObjectDatabase, params: StakingParameters, precision: number): ActiveValidator[] {
  const out: ActiveValidator[] = [];
  for (const v of db.scan(ValidatorType, 'byPower', new Uint8Array(0))) {
    if (out.length >= params.maxValidators) break;
    const power = powerOf(v.tokens, precision);
    if (power < 1n) break; // the index is descending by stake
    if (v.status !== ValidatorStatus.candidate) continue;
    if (selfBondOf(db, v) < params.minSelfBond) continue;
    out.push({ validator: v.id, publicKey: v.consensusKey, power });
  }
  return out;
}

/** The updates that turn `prev` into `next`, keyed by consensus key; a rotated key is a removal and an addition. */
export function diffActiveSets(prev: ActiveValidator[], next: ActiveValidator[]): ValidatorUpdate[] {
  const updates: ValidatorUpdate[] = [];
  const prevByKey = new Map(prev.map((a) => [toHex(a.publicKey), a]));
  const nextKeys = new Set(next.map((a) => toHex(a.publicKey)));
  for (const a of next) {
    const p = prevByKey.get(toHex(a.publicKey));
    if (!p || p.power !== a.power) updates.push({ publicKey: a.publicKey, power: a.power });
  }
  for (const p of prev) if (!nextKeys.has(toHex(p.publicKey))) updates.push({ publicKey: p.publicKey, power: 0n });
  return updates;
}

export function totalBonded(db: ObjectDatabase): bigint {
  let sum = 0n;
  for (const v of db.scan(ValidatorType, 'byPower', new Uint8Array(0))) if (v.status !== ValidatorStatus.tombstoned) sum += v.tokens;
  return sum;
}

/** Genesis: create the listed validators from their operators' balances and compute the first set. */
export function bootstrapValidators(db: ObjectDatabase, list: { operator: ObjectId; consensusKey: Uint8Array; selfBond: bigint }[]): void {
  const g = getGlobal(db);
  for (const v of list) {
    const name = accountOf(db, v.operator).name;
    if (v.selfBond < g.staking.minSelfBond) throw new Error(`genesis validator ${name}: self-bond below the minimum`);
    if (validatorByOperator(db, v.operator)) throw new Error(`genesis validator ${name}: account already operates a validator`);
    if (keyEverUsed(db, addressOf(v.consensusKey))) throw new Error(`genesis validator ${name}: consensus key already used`);
    adjustBalance(db, v.operator, g.coreAsset, -v.selfBond);
    createValidator(db, v.operator, v.consensusKey, v.selfBond, 0n);
  }
  const active = computeActiveSet(db, g.staking, precisionOf(db));
  const addrs = active.map((a) => addressOf(a.publicKey));
  db.modify(DynamicType, DYNAMIC_ID, (d) => ({ ...d, active, expectedSigners: [addrs, addrs, addrs], bonded: totalBonded(db) }));
}

// ---- block steps ----

function matureQueues(db: ObjectDatabase, time: bigint, core: ObjectId, history: HistoryRecorder | null): void {
  const due = [];
  for (const u of db.scan(UnbondingType, 'byCompletion', new Uint8Array(0))) {
    if (u.completion > time) break;
    due.push(u);
  }
  for (const u of due) {
    adjustBalance(db, u.delegator, core, u.tokens);
    db.remove(UnbondingType, u.id);
    history?.virtual(u.delegator, HistoryKind.unbondingMatured, virtualData.matured(u.validator, u.tokens));
  }
  const done = [];
  for (const r of db.scan(RedelegationType, 'byCompletion', new Uint8Array(0))) {
    if (r.completion > time) break;
    done.push(r);
  }
  for (const r of done) {
    db.remove(RedelegationType, r.id);
    history?.virtual(r.delegator, HistoryKind.redelegationMatured, virtualData.redelegationMatured(r.source, r.destination, r.tokens));
  }
}

function expireProposals(db: ObjectDatabase, time: bigint): void {
  const gone = [];
  for (const p of db.scan(ProposalType, 'byExpiration', new Uint8Array(0))) {
    if (p.expiration > time) break;
    gone.push(p.id);
  }
  for (const id of gone) db.remove(ProposalType, id);
}

/** Move the inflation rate toward the goal and mint the elapsed share of a year into the pool. */
function mint(db: ObjectDatabase, params: StakingParameters, time: bigint): void {
  const d = getDynamic(db);
  const dt = time - d.lastMintTime;
  if (dt <= 0n) return;
  const g = getGlobal(db);
  const core = assetOf(db, g.coreAsset);
  const supply = core.currentSupply;
  const bondedBps = supply > 0n ? (d.bonded * BPS) / supply : 0n;
  const step = (BigInt(params.inflationChangeBpsPerYear) * PPB_PER_BPS * dt) / YEAR_MS;
  let rate = bondedBps < BigInt(params.goalBondedBps) ? d.inflationPpb + step : d.inflationPpb - step;
  const min = BigInt(params.inflationMinBps) * PPB_PER_BPS;
  const max = BigInt(params.inflationMaxBps) * PPB_PER_BPS;
  if (rate < min) rate = min;
  if (rate > max) rate = max;
  let minted = (supply * rate * dt) / (1_000_000_000n * YEAR_MS);
  if (minted > core.maxSupply - supply) minted = core.maxSupply - supply;
  if (minted > 0n) db.modify(AssetType, core.id, (x) => ({ ...x, currentSupply: x.currentSupply + minted }));
  db.modify(DynamicType, DYNAMIC_ID, (x) => ({ ...x, communityPool: x.communityPool + minted, inflationPpb: rate, lastMintTime: time }));
}

/** The fixed reward: a bonus to the proposer, the rest by stake to the signers of the previous commit. */
function payRewards(db: ObjectDatabase, req: FinalizeBlockRequest, params: StakingParameters, history: HistoryRecorder | null): void {
  if (req.height <= 1n) return;
  const d = getDynamic(db);
  const total = params.fixedRewardPerBlock;
  if (total <= 0n || d.communityPool < total) return;
  let paid = 0n;
  const pay = (id: ObjectId, amount: bigint) => {
    const v = db.get(ValidatorType, id);
    if (!v || v.status === ValidatorStatus.tombstoned || amount <= 0n) return;
    if (!reward(db, v, amount, params.commissionBps)) return;
    paid += amount;
    history?.virtual(v.operator, HistoryKind.reward, virtualData.reward(v.id, amount, (amount * BigInt(params.commissionBps)) / BPS));
  };
  const bonus = (total * BigInt(params.proposerBonusBps)) / BPS;
  const signers = req.lastCommitSigners.map((a) => validatorByAddress(db, a)).filter((v): v is Validator => v !== null && v.status !== ValidatorStatus.tombstoned && v.tokens > 0n);
  const stake = signers.reduce((s, v) => s + v.tokens, 0n);
  const proposer = validatorByAddress(db, req.proposerAddress);
  if (proposer) pay(proposer.id, bonus);
  const rest = total - bonus;
  for (const v of signers) pay(v.id, (rest * v.tokens) / stake);
  // Rounding dust stays in the pool.
  adjustPool(db, -paid);
}

/** Advance each expected signer's window by one block and jail the ones below the threshold. */
function trackDowntime(db: ObjectDatabase, req: FinalizeBlockRequest, params: StakingParameters, log: Logger, history: HistoryRecorder | null): void {
  if (req.height <= 1n) return;
  const d = getDynamic(db);
  const expected = d.expectedSigners[2] ?? [];
  const signed = new Set(req.lastCommitSigners.map(toHex));
  const window = params.downtimeWindow;
  const minSigned = (BigInt(window) * BigInt(params.downtimeMinSignedBps) + BPS - 1n) / BPS;
  for (const address of expected) {
    const v = validatorByAddress(db, address);
    if (!v || v.status !== ValidatorStatus.candidate) continue;
    let info = signingInfoOf(db, v.id);
    if (!info || info.bitmap.length !== windowBytes(window)) {
      resetSigningInfo(db, v.id, window);
      info = signingInfoOf(db, v.id)!;
    }
    const bitmap = info.bitmap.slice();
    const byte = info.cursor >> 3;
    const mask = 1 << (info.cursor & 7);
    const wasMissed = (bitmap[byte]! & mask) !== 0;
    const missedNow = !signed.has(toHex(address));
    if (missedNow) bitmap[byte]! |= mask;
    else bitmap[byte]! &= ~mask;
    const missed = info.missed + (missedNow ? 1 : 0) - (wasMissed ? 1 : 0);
    const tracked = Math.min(info.tracked + 1, window);
    const cursor = (info.cursor + 1) % window;
    if (tracked >= window && BigInt(window - missed) < minSigned) {
      const before = v.tokens;
      const slashed = slash(db, v, params.downtimeSlashBps);
      db.modify(ValidatorType, v.id, (x) => ({ ...x, status: ValidatorStatus.jailed, jailedUntil: req.time + params.downtimeJailMs }));
      resetSigningInfo(db, v.id, window);
      history?.virtual(v.operator, HistoryKind.slash, virtualData.slash(v.id, before - slashed.tokens, false));
      history?.virtual(v.operator, HistoryKind.jail, virtualData.validator(v.id));
      log('warn', 'validator jailed for downtime', { validator: idToString(v.id), missed, window });
    } else {
      db.modify(SigningInfoType, info.id, (x) => ({ ...x, bitmap, cursor, missed, tracked }));
    }
  }
}

/** A double sign at `height`: slash, slash what left afterwards, tombstone, and send every delegator into unbonding. */
export function punishDoubleSign(db: ObjectDatabase, v: Validator, height: bigint, time: bigint, params: StakingParameters, history: HistoryRecorder | null = null): void {
  const bps = params.doubleSignSlashBps;
  let current = slash(db, v, bps);
  history?.virtual(v.operator, HistoryKind.slash, virtualData.slash(v.id, v.tokens - current.tokens, true));
  history?.virtual(v.operator, HistoryKind.tombstone, virtualData.validator(v.id));
  // Stake unbonded at height c still signs at c+1, so entries from the height before the infraction are liable too.
  for (const u of db.range(UnbondingType, 'byValidator', key((k) => k.id(v.id)))) {
    if (u.creationHeight < height - 1n) continue;
    const cut = (u.tokens * BigInt(bps)) / BPS;
    if (cut === 0n) continue;
    adjustPool(db, cut);
    db.modify(UnbondingType, u.id, (x) => ({ ...x, tokens: x.tokens - cut }));
  }
  for (const r of db.range(RedelegationType, 'bySource', key((k) => k.id(v.id)))) {
    if (r.creationHeight < height - 1n) continue;
    const cut = (r.tokens * BigInt(bps)) / BPS;
    const dst = db.get(ValidatorType, r.destination);
    const d = dst ? delegationOf(db, r.delegator, dst.id) : null;
    if (cut === 0n || !dst || dst.status === ValidatorStatus.tombstoned || !d) continue;
    const shares = sharesForTokens(dst, cut) < d.shares ? sharesForTokens(dst, cut) : d.shares;
    const { tokens } = unbond(db, d, dst, shares);
    adjustPool(db, tokens);
    db.modify(RedelegationType, r.id, (x) => ({ ...x, tokens: x.tokens - cut }));
  }
  current = db.modify(ValidatorType, v.id, (x) => ({ ...x, status: ValidatorStatus.tombstoned, jailedUntil: 0n }));
  // Every delegation becomes an unbonding entry; rounding dust goes to the pool; the validator is empty from here on.
  let owed = 0n;
  for (const d of db.range(DelegationType, 'byValidator', key((k) => k.id(v.id)))) {
    const tokens = tokensForShares(current, d.shares);
    db.remove(DelegationType, d.id);
    if (tokens > 0n) {
      owed += tokens;
      db.create(UnbondingType, (id) => ({ id, delegator: d.delegator, validator: v.id, tokens, creationHeight: height, completion: time + params.unbondingPeriodMs }));
      history?.virtual(d.delegator, HistoryKind.forcedUnbond, virtualData.matured(v.id, tokens));
    }
  }
  if (current.tokens > owed) adjustPool(db, current.tokens - owed);
  db.modify(ValidatorType, v.id, (x) => ({ ...x, tokens: 0n, shares: 0n }));
  const info = signingInfoOf(db, v.id);
  if (info) db.remove(SigningInfoType, info.id);
}

/** Everything that happens before a block's transactions. */
export function beginBlock(db: ObjectDatabase, req: FinalizeBlockRequest, log: Logger, history: HistoryRecorder | null = null): void {
  const g = getGlobal(db);
  const params = g.staking;
  expireProposals(db, req.time);
  mint(db, params, req.time);
  payRewards(db, req, params, history);
  trackDowntime(db, req, params, log, history);
  for (const m of req.misbehavior) {
    const v = validatorByAddress(db, m.address);
    if (!v || v.status === ValidatorStatus.tombstoned) continue;
    punishDoubleSign(db, v, m.height, req.time, params, history);
    log('warn', 'validator tombstoned for double signing', { validator: idToString(v.id), height: m.height });
  }
  // Last, so that stake whose liability ends in this very block is still there to be punished.
  matureQueues(db, req.time, g.coreAsset, history);
}

function tallyProposals(db: ObjectDatabase, log: Logger): void {
  const d = getDynamic(db);
  const activeIds = new Set(d.active.map((a) => a.validator));
  let activeStake = 0n;
  for (const id of activeIds) activeStake += db.get(ValidatorType, id)?.tokens ?? 0n;
  const adopted: Proposal[] = [];
  for (const p of db.scan(ProposalType, 'byExpiration', new Uint8Array(0))) {
    let support = 0n;
    for (const id of p.signals) if (activeIds.has(id)) support += db.get(ValidatorType, id)?.tokens ?? 0n;
    if (3n * support > 2n * activeStake) adopted.push(p);
  }
  if (adopted.length === 0) return;
  adopted.sort((a, b) => (a.id < b.id ? -1 : 1));
  const { fees, staking } = adopted[0]!.parameters;
  const old = getGlobal(db).staking;
  // Parameters that would leave the chain without a validator are not adopted; the proposal just lapses.
  if (computeActiveSet(db, staking, precisionOf(db)).length === 0) {
    for (const p of adopted) db.remove(ProposalType, p.id);
    log('warn', 'proposal would leave no active validator; not adopted', { proposal: idToString(adopted[0]!.id) });
    return;
  }
  db.modify(GlobalType, GLOBAL_ID, (g) => ({ ...g, fees, staking }));
  for (const p of adopted) db.remove(ProposalType, p.id);
  // A longer unbonding period reaches stake already on its way out: evidence may now arrive later than its old completion.
  if (staking.unbondingPeriodMs > old.unbondingPeriodMs) {
    const delta = staking.unbondingPeriodMs - old.unbondingPeriodMs;
    for (const u of db.range(UnbondingType, 'byCompletion', new Uint8Array(0))) db.modify(UnbondingType, u.id, (x) => ({ ...x, completion: x.completion + delta }));
    for (const r of db.range(RedelegationType, 'byCompletion', new Uint8Array(0))) db.modify(RedelegationType, r.id, (x) => ({ ...x, completion: x.completion + delta }));
  }
  // A new window size starts every signing record afresh; a window of the same byte length would otherwise keep stale bits.
  if (staking.downtimeWindow !== old.downtimeWindow) {
    for (const v of db.range(ValidatorType, 'byPower', new Uint8Array(0))) if (signingInfoOf(db, v.id)) resetSigningInfo(db, v.id, staking.downtimeWindow);
  }
  log('info', 'chain parameters changed by proposal', { proposal: idToString(adopted[0]!.id) });
}

/** After the transactions: adopt proposals, recompute the set, and report the updates for the engine. */
export function endBlock(db: ObjectDatabase, log: Logger): ValidatorUpdate[] {
  tallyProposals(db, log);
  const params = getGlobal(db).staking;
  const d = getDynamic(db);
  const next = computeActiveSet(db, params, precisionOf(db));
  const updates = diffActiveSets(d.active, next);
  const addrs = next.map((a) => addressOf(a.publicKey));
  db.modify(DynamicType, DYNAMIC_ID, (x) => ({
    ...x,
    active: next,
    expectedSigners: [addrs, x.expectedSigners[0] ?? addrs, x.expectedSigners[1] ?? addrs],
    bonded: totalBonded(db),
  }));
  return updates;
}
