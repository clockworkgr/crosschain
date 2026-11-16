import type { ObjectDatabase } from '../../db/database.ts';
import { idToString, type ObjectId } from '../../db/id.ts';
import { key } from '../../db/keys.ts';
import { addressOf, isPublicKey, schemeName, schemeOf } from '../../crypto/keys.ts';
import { authoritySatisfied, checkAuthority, collectKeys, minSignatures, type Authority, type AuthorityLookup } from './authority.ts';
import { HistoryKind, virtualData } from './history.ts';
import { checkAccountName, checkAssetSymbol } from './names.ts';
import {
  bond,
  createValidator,
  delegationOf,
  keyEverUsed,
  recordValidatorKey,
  pendingEntries,
  resetSigningInfo,
  selfBondOf,
  tokensForShares,
  unbond,
  validatorByOperator,
  validatorOf,
} from './staking.ts';
import { accountOf, adjustBalance, adjustPool, assetOf, getDynamic, getGlobal, TxError, type EvalContext } from './state.ts';
import { calculateFee, encodeOperation, MAX_SIGNATURES, type Operation, type Transaction } from './tx.ts';
import { encode } from '../../codec/writer.ts';
import {
  AccountType,
  AssetType,
  checkChainParameters,
  DYNAMIC_ID,
  MAX_SIGNALS,
  DynamicType,
  MAX_PRECISION,
  MAX_SHARE_SUPPLY,
  ProposalType,
  RecentTxType,
  RedelegationType,
  UnbondingType,
  ValidatorStatus,
  ValidatorType,
} from './types.ts';

export { accountOf, adjustBalance, assetOf, balanceOf, findBalance, getDynamic, getGlobal, TxError, type EvalContext } from './state.ts';

/** Which accounts' active and owner authorities the operations need. */
export function requiredAuthorities(ops: Operation[]): { active: Set<ObjectId>; owner: Set<ObjectId> } {
  const active = new Set<ObjectId>();
  const owner = new Set<ObjectId>();
  for (const op of ops) {
    switch (op.type) {
      case 'transfer':
        active.add(op.from);
        break;
      case 'accountCreate':
        active.add(op.registrar);
        break;
      case 'accountUpdate':
        (op.owner ? owner : active).add(op.account);
        break;
      case 'assetCreate':
      case 'assetIssue':
        active.add(op.issuer);
        break;
      case 'validatorCreate':
      case 'validatorUpdate':
      case 'unjail':
      case 'proposalCreate':
      case 'proposalSignal':
        active.add(op.operator);
        break;
      case 'delegate':
      case 'undelegate':
      case 'redelegate':
        active.add(op.delegator);
        break;
    }
  }
  return { active, owner };
}

export function feePayerOf(op: Operation): ObjectId {
  switch (op.type) {
    case 'transfer':
      return op.from;
    case 'accountCreate':
      return op.registrar;
    case 'accountUpdate':
      return op.account;
    case 'assetCreate':
    case 'assetIssue':
      return op.issuer;
    case 'validatorCreate':
    case 'validatorUpdate':
    case 'unjail':
    case 'proposalCreate':
    case 'proposalSignal':
      return op.operator;
    case 'delegate':
    case 'undelegate':
    case 'redelegate':
      return op.delegator;
  }
}

function checkAmount(amount: bigint, what: string): void {
  if (amount < 1n || amount > MAX_SHARE_SUPPLY) throw new TxError(`${what} must be between 1 and ${MAX_SHARE_SUPPLY}`);
}

/**
 * A new authority must be well formed, name accounts that exist, and be one that the signatures of one
 * transaction could satisfy as the state stands. Without that an account could be given authorities that lead to
 * no key, such as a reference to itself, or to more keys than a transaction may carry signatures, and nobody
 * could ever change it again. `lookup` reads the member accounts; an update passes one that shows the account as
 * the update leaves it.
 */
function checkNewAuthority(db: ObjectDatabase, auth: Authority, lookup: AuthorityLookup = (id) => db.get(AccountType, id)): void {
  const bad = checkAuthority(auth, getGlobal(db).scheme);
  if (bad) throw new TxError(bad);
  for (const m of auth.accounts) accountOf(db, m.account);
  // The usual authority reaches its threshold with its own keys, at most 16 of them, and no account is read.
  if (auth.keys.reduce((sum, k) => sum + k.weight, 0) >= auth.threshold) return;
  // With every key that counts toward it signing (its own, and those of its member accounts' active authorities
  // to the depth limit), the threshold must be reached.
  const keys = new Map<string, Uint8Array>();
  collectKeys(auth, lookup, keys);
  if (!authoritySatisfied(auth, new Set(keys.keys()), lookup)) throw new TxError('authority can never be satisfied: its member accounts do not lead to keys enough for the threshold');
  // No more keys than a transaction has signatures: all of them can sign at once. Otherwise the cheapest way to
  // the threshold must fit; it is counted without regard to keys two member accounts share, so it errs toward refusal.
  if (keys.size > MAX_SIGNATURES && minSignatures(auth, lookup, MAX_SIGNATURES) > MAX_SIGNATURES) {
    throw new TxError(`authority can never be satisfied: it needs more than the ${MAX_SIGNATURES} signatures a transaction can carry`);
  }
}

export function applyOperation(ctx: EvalContext, op: Operation): void {
  const { db } = ctx;
  switch (op.type) {
    case 'transfer': {
      checkAmount(op.amount, 'amount');
      if (op.from === op.to) throw new TxError('cannot transfer to self');
      accountOf(db, op.from);
      accountOf(db, op.to);
      assetOf(db, op.asset);
      adjustBalance(db, op.from, op.asset, -op.amount);
      adjustBalance(db, op.to, op.asset, op.amount);
      return;
    }
    case 'accountCreate': {
      const bad = checkAccountName(op.name);
      if (bad) throw new TxError(bad);
      accountOf(db, op.registrar);
      if (db.lookup(AccountType, 'byName', key((k) => k.str(op.name)))) throw new TxError(`account name ${op.name} is taken`);
      checkNewAuthority(db, op.owner);
      checkNewAuthority(db, op.active);
      const a = db.create(AccountType, (id) => ({ id, name: op.name, owner: op.owner, active: op.active, registrar: op.registrar }));
      if (ctx.final) ctx.log?.('info', 'account created', { name: a.name, id: idToString(a.id), registrar: idToString(op.registrar) });
      return;
    }
    case 'accountUpdate': {
      if (!op.owner && !op.active) throw new TxError('nothing to update');
      const account = accountOf(db, op.account);
      // An authority may name the account itself, and then it is the account's new active authority that counts.
      const updated = { owner: op.owner ?? account.owner, active: op.active ?? account.active };
      const lookup: AuthorityLookup = (id) => (id === op.account ? updated : db.get(AccountType, id));
      if (op.owner) checkNewAuthority(db, op.owner, lookup);
      if (op.active) checkNewAuthority(db, op.active, lookup);
      db.modify(AccountType, op.account, (a) => ({ ...a, owner: op.owner ?? a.owner, active: op.active ?? a.active }));
      return;
    }
    case 'assetCreate': {
      const bad = checkAssetSymbol(op.symbol);
      if (bad) throw new TxError(bad);
      if (op.precision > MAX_PRECISION) throw new TxError(`precision must be at most ${MAX_PRECISION}`);
      checkAmount(op.maxSupply, 'max supply');
      accountOf(db, op.issuer);
      if (db.lookup(AssetType, 'bySymbol', key((k) => k.str(op.symbol)))) throw new TxError(`asset symbol ${op.symbol} is taken`);
      db.create(AssetType, (id) => ({ id, symbol: op.symbol, precision: op.precision, issuer: op.issuer, maxSupply: op.maxSupply, currentSupply: 0n }));
      return;
    }
    case 'assetIssue': {
      checkAmount(op.amount, 'amount');
      if (op.asset === getGlobal(db).coreAsset) throw new TxError('the core asset is minted by the chain, not issued');
      const asset = assetOf(db, op.asset);
      if (asset.issuer !== op.issuer) throw new TxError(`only the issuer of ${asset.symbol} can issue it`);
      accountOf(db, op.to);
      if (asset.currentSupply + op.amount > asset.maxSupply) throw new TxError(`issuing ${op.amount} would exceed the max supply of ${asset.symbol}`);
      db.modify(AssetType, asset.id, (a) => ({ ...a, currentSupply: a.currentSupply + op.amount }));
      adjustBalance(db, op.to, asset.id, op.amount);
      return;
    }
    default:
      applyStakingOperation(ctx, op);
  }
}

/** The staking operations. Authorities were checked before; here the operator or delegator named must match the objects. */
function applyStakingOperation(ctx: EvalContext, op: Operation): void {
  const { db } = ctx;
  const g = getGlobal(db);
  const p = g.staking;
  const core = g.coreAsset;
  switch (op.type) {
    case 'validatorCreate': {
      accountOf(db, op.operator);
      if (!isPublicKey(op.consensusKey) || schemeOf(op.consensusKey) !== g.scheme) throw new TxError(`consensus key must be a ${schemeName(g.scheme)} key`);
      if (validatorByOperator(db, op.operator)) throw new TxError('account already operates a validator');
      if (keyEverUsed(db, addressOf(op.consensusKey))) throw new TxError('consensus key already in use');
      if (op.selfBond < p.minSelfBond) throw new TxError(`self-bond must be at least ${p.minSelfBond}`);
      adjustBalance(db, op.operator, core, -(op.selfBond + p.validatorCreationFee));
      adjustPool(db, p.validatorCreationFee);
      const v = createValidator(db, op.operator, op.consensusKey, op.selfBond, ctx.height);
      if (ctx.final) ctx.log?.('info', 'validator created', { validator: idToString(v.id), operator: idToString(op.operator) });
      return;
    }
    case 'validatorUpdate': {
      const v = validatorOf(db, op.validator);
      if (v.operator !== op.operator) throw new TxError('not the operator of that validator');
      if (v.status === ValidatorStatus.tombstoned) throw new TxError('validator is tombstoned');
      if (!isPublicKey(op.consensusKey) || schemeOf(op.consensusKey) !== g.scheme) throw new TxError(`consensus key must be a ${schemeName(g.scheme)} key`);
      if (keyEverUsed(db, addressOf(op.consensusKey))) throw new TxError('consensus key already in use');
      db.modify(ValidatorType, v.id, (x) => ({ ...x, consensusKey: op.consensusKey }));
      recordValidatorKey(db, v.id, op.consensusKey);
      return;
    }
    case 'delegate': {
      accountOf(db, op.delegator);
      const v = validatorOf(db, op.validator);
      if (v.status === ValidatorStatus.tombstoned) throw new TxError('validator is tombstoned');
      if (op.amount < p.minDelegation) throw new TxError(`delegation must be at least ${p.minDelegation}`);
      adjustBalance(db, op.delegator, core, -op.amount);
      bond(db, op.delegator, v, op.amount);
      return;
    }
    case 'undelegate': {
      const v = validatorOf(db, op.validator);
      const d = delegationOf(db, op.delegator, v.id);
      if (!d) throw new TxError('no such delegation');
      if (op.shares < 1n || op.shares > d.shares) throw new TxError('shares out of range');
      if (op.delegator === v.operator && v.status !== ValidatorStatus.tombstoned && tokensForShares(v, d.shares - op.shares) < p.minSelfBond) {
        throw new TxError('self-bond would fall below the minimum');
      }
      if (pendingEntries(db, UnbondingType, 'byDelegatorValidator', key((k) => k.id(op.delegator).id(v.id))) >= p.maxEntries) throw new TxError('too many pending unbonding entries');
      const { tokens } = unbond(db, d, v, op.shares);
      if (tokens > 0n) db.create(UnbondingType, (id) => ({ id, delegator: op.delegator, validator: v.id, tokens, creationHeight: ctx.height, completion: ctx.time + p.unbondingPeriodMs }));
      return;
    }
    case 'redelegate': {
      if (op.source === op.destination) throw new TxError('source and destination are the same');
      const src = validatorOf(db, op.source);
      const dst = validatorOf(db, op.destination);
      if (dst.status === ValidatorStatus.tombstoned) throw new TxError('destination is tombstoned');
      const d = delegationOf(db, op.delegator, src.id);
      if (!d) throw new TxError('no such delegation');
      if (op.shares < 1n || op.shares > d.shares) throw new TxError('shares out of range');
      if (pendingEntries(db, RedelegationType, 'byDelegatorDestination', key((k) => k.id(op.delegator).id(src.id))) > 0) throw new TxError('stake still redelegating into the source cannot move again');
      if (pendingEntries(db, RedelegationType, 'byDelegatorSourceDestination', key((k) => k.id(op.delegator).id(src.id).id(dst.id))) >= p.maxEntries) throw new TxError('too many pending redelegations');
      if (op.delegator === src.operator && src.status !== ValidatorStatus.tombstoned && tokensForShares(src, d.shares - op.shares) < p.minSelfBond) {
        throw new TxError('self-bond would fall below the minimum');
      }
      const { tokens } = unbond(db, d, src, op.shares);
      if (tokens < p.minDelegation) throw new TxError(`redelegation must move at least ${p.minDelegation}`);
      bond(db, op.delegator, dst, tokens);
      db.create(RedelegationType, (id) => ({ id, delegator: op.delegator, source: src.id, destination: dst.id, tokens, creationHeight: ctx.height, completion: ctx.time + p.unbondingPeriodMs }));
      return;
    }
    case 'unjail': {
      const v = validatorOf(db, op.validator);
      if (v.operator !== op.operator) throw new TxError('not the operator of that validator');
      if (v.status !== ValidatorStatus.jailed) throw new TxError('validator is not jailed');
      if (ctx.time < v.jailedUntil) throw new TxError('jail period has not passed');
      if (selfBondOf(db, v) < p.minSelfBond) throw new TxError('self-bond below the minimum');
      db.modify(ValidatorType, v.id, (x) => ({ ...x, status: ValidatorStatus.candidate, jailedUntil: 0n }));
      resetSigningInfo(db, v.id, p.downtimeWindow);
      ctx.history?.virtual(v.operator, HistoryKind.unjail, virtualData.validator(v.id));
      return;
    }
    case 'proposalCreate': {
      const v = validatorOf(db, op.validator);
      if (v.operator !== op.operator) throw new TxError('not the operator of that validator');
      if (!getDynamic(db).active.some((a) => a.validator === v.id)) throw new TxError('only active validators propose');
      const problem = checkChainParameters(op.parameters);
      if (problem) throw new TxError(problem);
      db.create(ProposalType, (id) => ({ id, proposer: v.id, parameters: op.parameters, signals: [v.id], created: ctx.time, expiration: ctx.time + p.proposalLifetimeMs }));
      return;
    }
    case 'proposalSignal': {
      const v = validatorOf(db, op.validator);
      if (v.operator !== op.operator) throw new TxError('not the operator of that validator');
      if (!getDynamic(db).active.some((a) => a.validator === v.id)) throw new TxError('only active validators signal');
      const prop = db.get(ProposalType, op.proposal);
      if (!prop) throw new TxError('no such proposal');
      if (prop.signals.includes(v.id)) throw new TxError('already signalled');
      if (prop.signals.length >= MAX_SIGNALS) throw new TxError('proposal has the maximum number of signals');
      db.modify(ProposalType, prop.id, (x) => ({ ...x, signals: [...x.signals, v.id].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }));
      return;
    }
    default:
      throw new TxError(`unknown operation ${(op as Operation).type}`);
  }
}

/** Every account an applied operation concerns, for its history. Called after the operation ran. */
export function accountsNamed(db: ObjectDatabase, op: Operation): ObjectId[] {
  const operatorOf = (validator: ObjectId) => db.get(ValidatorType, validator)?.operator;
  switch (op.type) {
    case 'transfer':
      return [op.from, op.to];
    case 'accountCreate': {
      const created = db.lookup(AccountType, 'byName', key((k) => k.str(op.name)));
      return created ? [op.registrar, created.id] : [op.registrar];
    }
    case 'accountUpdate':
      return [op.account];
    case 'assetCreate':
      return [op.issuer];
    case 'assetIssue':
      return [op.issuer, op.to];
    case 'validatorCreate':
    case 'validatorUpdate':
    case 'unjail':
    case 'proposalCreate':
    case 'proposalSignal':
      return [op.operator];
    case 'delegate':
    case 'undelegate':
      return [op.delegator, operatorOf(op.validator)].filter((a): a is ObjectId => a !== undefined);
    case 'redelegate':
      return [op.delegator, operatorOf(op.source), operatorOf(op.destination)].filter((a): a is ObjectId => a !== undefined);
  }
}

/**
 * Expiration, replay, then each operation: its fee (what it states, if that
 * covers the schedule), then the operation itself. Throws TxError. Run it
 * inside a session.
 */
export function applyTransaction(ctx: EvalContext, tx: Transaction, txId: Uint8Array): void {
  const { db } = ctx;
  const global = getGlobal(db);
  if (tx.operations.length === 0) throw new TxError('transaction has no operations');
  if (tx.expiration <= ctx.time) throw new TxError('transaction expired');
  if (tx.expiration > ctx.time + global.maxTxExpirationMs) throw new TxError('expiration too far in the future');
  if (db.lookup(RecentTxType, 'byTxId', key((k) => k.fixed(txId)))) throw new TxError('duplicate transaction');
  let fees = 0n;
  tx.operations.forEach((op, i) => {
    const required = calculateFee(op, global.fees);
    if (op.fee < required) throw new TxError(`operation ${i} states a fee of ${op.fee}, the schedule requires ${required}`);
    if (op.fee > 0n) {
      adjustBalance(db, feePayerOf(op), global.coreAsset, -op.fee);
      fees += op.fee;
    }
    ctx.history?.beginOp(i);
    applyOperation(ctx, op);
    ctx.history?.op(accountsNamed(db, op), i, encode((w) => encodeOperation(w, op)));
  });
  if (fees > 0n) adjustPool(db, fees);
  db.create(RecentTxType, (id) => ({ id, txId, expiration: tx.expiration }));
}

/** Forget transaction ids whose expiration has passed; an expired transaction cannot be replayed anyway. */
export function pruneExpiredTxs(db: ObjectDatabase, time: bigint): number {
  const gone: ObjectId[] = [];
  for (const t of db.scan(RecentTxType, 'byExpiration', new Uint8Array(0))) {
    if (t.expiration > time) break;
    gone.push(t.id);
  }
  for (const id of gone) db.remove(RecentTxType, id);
  return gone.length;
}
