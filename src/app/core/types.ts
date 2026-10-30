/**
 * The object types of the core application. Each has a fixed numeric type
 * id (part of every object id and every leaf hash), a canonical encoding,
 * and its secondary indices.
 *
 * Graphene splits "protocol" objects, which transactions reference, from
 * "implementation" objects, which only the chain itself maintains. Here the
 * global and dynamic properties, and the recent-transaction records, play
 * the implementation role; accounts, assets and balances are the protocol.
 * Static chain parameters sit in `global` and the values that change every
 * block in `dynamic`, so a block rehashes one small leaf rather than the
 * parameters as well.
 *
 * Staking (STAKING.md) adds validators, delegations, the unbonding and
 * redelegation queues, per-validator signing records, and parameter
 * proposals, which replace the fee schedule (FEES.md) and the staking rules
 * together. A validator's stake is `tokens` against `shares`: delegations
 * own shares, rewards raise tokens, slashes lower them, so every delegator's
 * value moves with the exchange rate and nothing is tracked per delegator.
 */
import type { Reader } from '../../codec/reader.ts';
import type { Writer } from '../../codec/writer.ts';
import { HASH_SIZE } from '../../crypto/hash.ts';
import { addressOf, decodePublicKey, isSchemeTag, type SchemeTag } from '../../crypto/keys.ts';
import { objectId, type ObjectId } from '../../db/id.ts';
import type { ObjectType } from '../../db/index.ts';
import { decodeAuthority, encodeAuthority, type Authority } from './authority.ts';
import { MAX_ACCOUNT_NAME, MAX_ASSET_SYMBOL } from './names.ts';

export const TYPE = {
  global: 1,
  dynamic: 2,
  account: 3,
  asset: 4,
  balance: 5,
  recentTx: 6,
  validator: 7,
  delegation: 8,
  unbonding: 9,
  redelegation: 10,
  signingInfo: 11,
  proposal: 12,
  validatorKey: 13,
} as const;

const MAX_U64 = (1n << 64n) - 1n;

export const GLOBAL_ID: ObjectId = objectId(TYPE.global, 0);
export const DYNAMIC_ID: ObjectId = objectId(TYPE.dynamic, 0);
export const CORE_ASSET_ID: ObjectId = objectId(TYPE.asset, 0);

/** Largest amount of any asset, as in Graphene. Sums of balances can never overflow a u64. */
export const MAX_SHARE_SUPPLY = 1_000_000_000_000_000n;
export const MAX_PRECISION = 12;

/**
 * Per-operation fee parameters, after BitShares' fee_schedule (FEES.md).
 * Amounts are base units of the core asset; `scale` multiplies every fee,
 * 10000 being 100%.
 */
export interface FeeSchedule {
  scale: number;
  transfer: { fee: bigint };
  accountCreate: { basicFee: bigint; premiumFee: bigint; pricePerKbyte: bigint };
  accountUpdate: { fee: bigint; pricePerKbyte: bigint };
  assetCreate: { symbol3: bigint; symbol4: bigint; longSymbol: bigint };
  assetIssue: { fee: bigint };
  validatorCreate: { fee: bigint };
  validatorUpdate: { fee: bigint };
  delegate: { fee: bigint };
  undelegate: { fee: bigint };
  redelegate: { fee: bigint };
  unjail: { fee: bigint };
  proposalCreate: { fee: bigint };
  proposalSignal: { fee: bigint };
}

export type FeeOperation = Exclude<keyof FeeSchedule, 'scale'>;

/** The schedule's amounts in encoding order. */
export const FEE_FIELDS: [FeeOperation, string[]][] = [
  ['transfer', ['fee']],
  ['accountCreate', ['basicFee', 'premiumFee', 'pricePerKbyte']],
  ['accountUpdate', ['fee', 'pricePerKbyte']],
  ['assetCreate', ['symbol3', 'symbol4', 'longSymbol']],
  ['assetIssue', ['fee']],
  ['validatorCreate', ['fee']],
  ['validatorUpdate', ['fee']],
  ['delegate', ['fee']],
  ['undelegate', ['fee']],
  ['redelegate', ['fee']],
  ['unjail', ['fee']],
  ['proposalCreate', ['fee']],
  ['proposalSignal', ['fee']],
];

/** The scale that leaves the amounts as written. */
export const FEE_SCALE_ONE = 10_000;
/** One hundred times the written amounts, at most. */
export const MAX_FEE_SCALE = 1_000_000;

function feeAmounts(f: FeeSchedule, op: FeeOperation): Record<string, bigint> {
  return f[op] as unknown as Record<string, bigint>;
}

export function encodeFeeSchedule(w: Writer, f: FeeSchedule): void {
  w.u32(f.scale);
  for (const [op, fields] of FEE_FIELDS) for (const k of fields) w.u64(feeAmounts(f, op)[k]!);
}

export function decodeFeeSchedule(r: Reader): FeeSchedule {
  const f = { scale: r.u32() } as FeeSchedule;
  for (const [op, fields] of FEE_FIELDS) {
    const amounts: Record<string, bigint> = {};
    for (const k of fields) amounts[k] = r.u64();
    (f as unknown as Record<string, unknown>)[op] = amounts;
  }
  return f;
}

/** Returns a problem, or null if the schedule is usable. Zero is fine everywhere: a chain may be free. */
export function checkFeeSchedule(f: FeeSchedule): string | null {
  if (!Number.isInteger(f.scale) || f.scale < 0 || f.scale > MAX_FEE_SCALE) return `fee scale must be 0 to ${MAX_FEE_SCALE}`;
  for (const [op, fields] of FEE_FIELDS) {
    for (const k of fields) {
      const v = feeAmounts(f, op)[k];
      if (typeof v !== 'bigint' || v < 0n || v > MAX_SHARE_SUPPLY) return `fee ${op}.${k} must be 0 to ${MAX_SHARE_SUPPLY}`;
    }
  }
  return null;
}

/**
 * A schedule from JSON, amounts as strings or numbers. With `base`, missing
 * values come from it, which is how genesis overrides the defaults; without
 * it every value is required.
 */
export function feeScheduleFromJson(j: unknown, base: FeeSchedule | null = null): FeeSchedule {
  const o = (j ?? {}) as Record<string, unknown>;
  const scale = o.scale ?? base?.scale;
  if (scale === undefined) throw new Error('fees: scale missing');
  const f = { scale: Number(scale) } as FeeSchedule;
  for (const [op, fields] of FEE_FIELDS) {
    const section = o[op] as Record<string, unknown> | undefined;
    const amounts: Record<string, bigint> = {};
    for (const k of fields) {
      const v = section?.[k] ?? (base ? feeAmounts(base, op)[k] : undefined);
      if (v === undefined) throw new Error(`fees: ${op}.${k} missing`);
      amounts[k] = BigInt(v as string | number | bigint);
    }
    (f as unknown as Record<string, unknown>)[op] = amounts;
  }
  return f;
}

/** Staking rules, replaced wholesale by an adopted proposal. Amounts in base units, rates in basis points, times in ms. */
export interface StakingParameters {
  maxValidators: number;
  unbondingPeriodMs: bigint;
  minSelfBond: bigint;
  minDelegation: bigint;
  validatorCreationFee: bigint;
  commissionBps: number;
  fixedRewardPerBlock: bigint;
  proposerBonusBps: number;
  doubleSignSlashBps: number;
  downtimeWindow: number;
  downtimeMinSignedBps: number;
  downtimeJailMs: bigint;
  downtimeSlashBps: number;
  maxEntries: number;
  proposalLifetimeMs: bigint;
  goalBondedBps: number;
  inflationMinBps: number;
  inflationMaxBps: number;
  inflationChangeBpsPerYear: number;
}

export function encodeStakingParameters(w: Writer, p: StakingParameters): void {
  w.u32(p.maxValidators)
    .u64(p.unbondingPeriodMs)
    .u64(p.minSelfBond)
    .u64(p.minDelegation)
    .u64(p.validatorCreationFee)
    .u32(p.commissionBps)
    .u64(p.fixedRewardPerBlock)
    .u32(p.proposerBonusBps)
    .u32(p.doubleSignSlashBps)
    .u32(p.downtimeWindow)
    .u32(p.downtimeMinSignedBps)
    .u64(p.downtimeJailMs)
    .u32(p.downtimeSlashBps)
    .u32(p.maxEntries)
    .u64(p.proposalLifetimeMs)
    .u32(p.goalBondedBps)
    .u32(p.inflationMinBps)
    .u32(p.inflationMaxBps)
    .u32(p.inflationChangeBpsPerYear);
}

export function decodeStakingParameters(r: Reader): StakingParameters {
  return {
    maxValidators: r.u32(),
    unbondingPeriodMs: r.u64(),
    minSelfBond: r.u64(),
    minDelegation: r.u64(),
    validatorCreationFee: r.u64(),
    commissionBps: r.u32(),
    fixedRewardPerBlock: r.u64(),
    proposerBonusBps: r.u32(),
    doubleSignSlashBps: r.u32(),
    downtimeWindow: r.u32(),
    downtimeMinSignedBps: r.u32(),
    downtimeJailMs: r.u64(),
    downtimeSlashBps: r.u32(),
    maxEntries: r.u32(),
    proposalLifetimeMs: r.u64(),
    goalBondedBps: r.u32(),
    inflationMinBps: r.u32(),
    inflationMaxBps: r.u32(),
    inflationChangeBpsPerYear: r.u32(),
  };
}

/** Returns a problem, or null if the parameters are usable. */
/** A hundred years: the longest duration any parameter may hold, so `time + duration` stays a u64. */
export const MAX_DURATION_MS = 100n * 365n * 24n * 3_600_000n;
/** Signals a proposal can hold; the codec reads at most this many. */
export const MAX_SIGNALS = 1000;

export function checkStakingParameters(p: StakingParameters): string | null {
  if (p.maxValidators < 1 || p.maxValidators > 1000) return 'maxValidators must be 1 to 1000';
  for (const [name, v] of [
    ['unbondingPeriodMs', p.unbondingPeriodMs],
    ['downtimeJailMs', p.downtimeJailMs],
    ['proposalLifetimeMs', p.proposalLifetimeMs],
  ] as [string, bigint][]) {
    if (v < 1n || v > MAX_DURATION_MS) return `${name} must be 1 to ${MAX_DURATION_MS} ms`;
  }
  for (const [name, v] of [
    ['minSelfBond', p.minSelfBond],
    ['minDelegation', p.minDelegation],
    ['validatorCreationFee', p.validatorCreationFee],
    ['fixedRewardPerBlock', p.fixedRewardPerBlock],
  ] as [string, bigint][]) {
    if (v < 0n || v > MAX_SHARE_SUPPLY) return `${name} must be 0 to ${MAX_SHARE_SUPPLY}`;
  }
  if (p.minSelfBond < 1n) return 'minSelfBond must be positive';
  if (p.minDelegation < 1n) return 'minDelegation must be positive';
  for (const [name, v] of [
    ['commissionBps', p.commissionBps],
    ['proposerBonusBps', p.proposerBonusBps],
    ['doubleSignSlashBps', p.doubleSignSlashBps],
    ['downtimeMinSignedBps', p.downtimeMinSignedBps],
    ['downtimeSlashBps', p.downtimeSlashBps],
    ['goalBondedBps', p.goalBondedBps],
    ['inflationMinBps', p.inflationMinBps],
    ['inflationMaxBps', p.inflationMaxBps],
    ['inflationChangeBpsPerYear', p.inflationChangeBpsPerYear],
  ] as [string, number][]) {
    if (v < 0 || v > 10_000) return `${name} must be 0 to 10000 basis points`;
  }
  if (p.downtimeWindow < 1 || p.downtimeWindow > 100_000) return 'downtimeWindow must be 1 to 100000 blocks';
  if (p.maxEntries < 1 || p.maxEntries > 100) return 'maxEntries must be 1 to 100';
  if (p.inflationMinBps > p.inflationMaxBps) return 'inflationMinBps exceeds inflationMaxBps';
  return null;
}

/** The staking parameters in encoding order, and the ones held as bigint. */
export const STAKING_FIELDS: (keyof StakingParameters)[] = [
  'maxValidators',
  'unbondingPeriodMs',
  'minSelfBond',
  'minDelegation',
  'validatorCreationFee',
  'commissionBps',
  'fixedRewardPerBlock',
  'proposerBonusBps',
  'doubleSignSlashBps',
  'downtimeWindow',
  'downtimeMinSignedBps',
  'downtimeJailMs',
  'downtimeSlashBps',
  'maxEntries',
  'proposalLifetimeMs',
  'goalBondedBps',
  'inflationMinBps',
  'inflationMaxBps',
  'inflationChangeBpsPerYear',
];
export const STAKING_BIGINT_FIELDS: (keyof StakingParameters)[] = ['unbondingPeriodMs', 'minSelfBond', 'minDelegation', 'validatorCreationFee', 'fixedRewardPerBlock', 'downtimeJailMs', 'proposalLifetimeMs'];

/** Staking parameters from JSON in base units, as the RPC reports them. Every field is required. */
export function stakingParametersFromJson(j: unknown): StakingParameters {
  const o = (j ?? {}) as Record<string, unknown>;
  const out: Record<string, number | bigint> = {};
  for (const k of STAKING_FIELDS) {
    if (o[k] === undefined) throw new Error(`staking: ${k} missing`);
    out[k] = STAKING_BIGINT_FIELDS.includes(k) ? BigInt(o[k] as string | number) : Number(o[k]);
  }
  return out as unknown as StakingParameters;
}

/**
 * Everything a proposal replaces at once: the fee schedule and the staking
 * rules, the way a BitShares committee proposal carries all of chain_parameters.
 */
export interface ChainParameters {
  fees: FeeSchedule;
  staking: StakingParameters;
}

export function encodeChainParameters(w: Writer, p: ChainParameters): void {
  encodeFeeSchedule(w, p.fees);
  encodeStakingParameters(w, p.staking);
}

export function decodeChainParameters(r: Reader): ChainParameters {
  return { fees: decodeFeeSchedule(r), staking: decodeStakingParameters(r) };
}

export function checkChainParameters(p: ChainParameters): string | null {
  return checkFeeSchedule(p.fees) ?? checkStakingParameters(p.staking);
}

export function chainParametersFromJson(j: unknown): ChainParameters {
  const o = (j ?? {}) as Record<string, unknown>;
  return { fees: feeScheduleFromJson(o.fees), staking: stakingParametersFromJson(o.staking) };
}

export interface GlobalProperties {
  id: ObjectId;
  /** The asset fees are paid in, and the one that is staked. */
  coreAsset: ObjectId;
  fees: FeeSchedule;
  maxTxExpirationMs: bigint;
  staking: StakingParameters;
  /** The chain's signature scheme (genesis): every account key, consensus key and transaction signature must be of it. */
  scheme: SchemeTag;
}

/** One member of the validator set the application last handed to the engine. */
export interface ActiveValidator {
  validator: ObjectId;
  publicKey: Uint8Array;
  power: bigint;
}

export interface DynamicProperties {
  id: ObjectId;
  height: bigint;
  /** Time of the last block, unix milliseconds. */
  time: bigint;
  /** Fees, mint and slashes collected; pays the block reward. */
  communityPool: bigint;
  /** Current annual inflation, parts per billion, so one block can move it by a measurable step. */
  inflationPpb: bigint;
  lastMintTime: bigint;
  /** Tokens behind candidate and jailed validators. */
  bonded: bigint;
  /** The set computed at the end of the last block; the engine applies it two heights later. */
  active: ActiveValidator[];
  /**
   * Consensus addresses of the three most recently computed sets, newest first.
   * The oldest is the set that signed the previous block's commit.
   */
  expectedSigners: Uint8Array[][];
}

export const ValidatorStatus = { candidate: 0, jailed: 1, tombstoned: 2 } as const;
export type ValidatorStatusValue = (typeof ValidatorStatus)[keyof typeof ValidatorStatus];

export interface Validator {
  id: ObjectId;
  operator: ObjectId;
  consensusKey: Uint8Array;
  tokens: bigint;
  shares: bigint;
  status: ValidatorStatusValue;
  jailedUntil: bigint;
  createdHeight: bigint;
}

export interface Delegation {
  id: ObjectId;
  delegator: ObjectId;
  validator: ObjectId;
  shares: bigint;
}

export interface Unbonding {
  id: ObjectId;
  delegator: ObjectId;
  validator: ObjectId;
  tokens: bigint;
  creationHeight: bigint;
  completion: bigint;
}

export interface Redelegation {
  id: ObjectId;
  delegator: ObjectId;
  source: ObjectId;
  destination: ObjectId;
  /** Tokens moved, the base for a later slash by the source. */
  tokens: bigint;
  creationHeight: bigint;
  completion: bigint;
}

/** A validator's recent signing record: one bit per block in a circular window. */
export interface SigningInfo {
  id: ObjectId;
  validator: ObjectId;
  bitmap: Uint8Array;
  cursor: number;
  missed: number;
  /** Blocks observed so far, up to the window size. */
  tracked: number;
}

/** Every consensus address a validator has ever used, so evidence against a rotated key still finds it. */
export interface ValidatorKey {
  id: ObjectId;
  address: Uint8Array;
  validator: ObjectId;
}

export interface Proposal {
  id: ObjectId;
  proposer: ObjectId;
  parameters: ChainParameters;
  /** Validator ids that signalled, ascending. */
  signals: ObjectId[];
  created: bigint;
  expiration: bigint;
}

export interface Account {
  id: ObjectId;
  name: string;
  owner: Authority;
  active: Authority;
  registrar: ObjectId;
}

export interface Asset {
  id: ObjectId;
  symbol: string;
  precision: number;
  issuer: ObjectId;
  maxSupply: bigint;
  currentSupply: bigint;
}

export interface Balance {
  id: ObjectId;
  owner: ObjectId;
  asset: ObjectId;
  amount: bigint;
}

/** A transaction id kept until its expiration passes, so the same transaction cannot be applied twice. */
export interface RecentTx {
  id: ObjectId;
  txId: Uint8Array;
  expiration: bigint;
}

export const GlobalType: ObjectType<GlobalProperties> = {
  id: TYPE.global,
  name: 'global',
  encode(w, o) {
    w.u64(o.coreAsset);
    encodeFeeSchedule(w, o.fees);
    w.u64(o.maxTxExpirationMs);
    encodeStakingParameters(w, o.staking);
    w.u8(o.scheme);
  },
  decode(r, id) {
    const g = { id, coreAsset: r.u64(), fees: decodeFeeSchedule(r), maxTxExpirationMs: r.u64(), staking: decodeStakingParameters(r) };
    const scheme = r.u8();
    if (!isSchemeTag(scheme)) throw new Error(`unknown signature scheme ${scheme}`);
    return { ...g, scheme };
  },
  indices: [],
};

export const DynamicType: ObjectType<DynamicProperties> = {
  id: TYPE.dynamic,
  name: 'dynamic',
  encode(w, o) {
    w.u64(o.height).u64(o.time).u64(o.communityPool).u64(o.inflationPpb).u64(o.lastMintTime).u64(o.bonded);
    w.array(o.active, (w, a) => w.u64(a.validator).fixed(a.publicKey).u64(a.power));
    w.array(o.expectedSigners, (w, set) => w.array(set, (w, a) => w.fixed(a)));
  },
  decode(r, id) {
    return {
      id,
      height: r.u64(),
      time: r.u64(),
      communityPool: r.u64(),
      inflationPpb: r.u64(),
      lastMintTime: r.u64(),
      bonded: r.u64(),
      active: r.array((r) => ({ validator: r.u64(), publicKey: decodePublicKey(r), power: r.u64() }), 1000),
      expectedSigners: r.array((r) => r.array((r) => r.fixed(HASH_SIZE), 1000), 3),
    };
  },
  indices: [],
};

export const ValidatorType: ObjectType<Validator> = {
  id: TYPE.validator,
  name: 'validator',
  encode(w, o) {
    w.u64(o.operator).fixed(o.consensusKey).u64(o.tokens).u64(o.shares).u8(o.status).u64(o.jailedUntil).u64(o.createdHeight);
  },
  decode(r, id) {
    const operator = r.u64();
    const consensusKey = decodePublicKey(r);
    const tokens = r.u64();
    const shares = r.u64();
    const status = r.u8();
    if (status > ValidatorStatus.tombstoned) throw new Error(`bad validator status ${status}`);
    return { id, operator, consensusKey, tokens, shares, status: status as ValidatorStatusValue, jailedUntil: r.u64(), createdHeight: r.u64() };
  },
  indices: [
    { name: 'byOperator', unique: true, authenticated: true, key: (v, k) => k.id(v.operator) },
    { name: 'byConsensusAddress', unique: true, authenticated: true, key: (v, k) => k.fixed(addressOf(v.consensusKey)) },
    // Ascending key order is descending stake; ties fall back to the id the index appends.
    { name: 'byPower', unique: false, key: (v, k) => k.u64(MAX_U64 - v.tokens) },
  ],
};

export const DelegationType: ObjectType<Delegation> = {
  id: TYPE.delegation,
  name: 'delegation',
  encode(w, o) {
    w.u64(o.delegator).u64(o.validator).u64(o.shares);
  },
  decode(r, id) {
    return { id, delegator: r.u64(), validator: r.u64(), shares: r.u64() };
  },
  indices: [
    { name: 'byDelegatorValidator', unique: true, authenticated: true, key: (d, k) => k.id(d.delegator).id(d.validator) },
    { name: 'byValidator', unique: false, key: (d, k) => k.id(d.validator) },
  ],
};

export const UnbondingType: ObjectType<Unbonding> = {
  id: TYPE.unbonding,
  name: 'unbonding',
  encode(w, o) {
    w.u64(o.delegator).u64(o.validator).u64(o.tokens).u64(o.creationHeight).u64(o.completion);
  },
  decode(r, id) {
    return { id, delegator: r.u64(), validator: r.u64(), tokens: r.u64(), creationHeight: r.u64(), completion: r.u64() };
  },
  indices: [
    { name: 'byCompletion', unique: false, key: (u, k) => k.u64(u.completion) },
    { name: 'byDelegatorValidator', unique: false, key: (u, k) => k.id(u.delegator).id(u.validator) },
    { name: 'byValidator', unique: false, key: (u, k) => k.id(u.validator) },
  ],
};

export const RedelegationType: ObjectType<Redelegation> = {
  id: TYPE.redelegation,
  name: 'redelegation',
  encode(w, o) {
    w.u64(o.delegator).u64(o.source).u64(o.destination).u64(o.tokens).u64(o.creationHeight).u64(o.completion);
  },
  decode(r, id) {
    return { id, delegator: r.u64(), source: r.u64(), destination: r.u64(), tokens: r.u64(), creationHeight: r.u64(), completion: r.u64() };
  },
  indices: [
    { name: 'byCompletion', unique: false, key: (x, k) => k.u64(x.completion) },
    { name: 'byDelegatorSourceDestination', unique: false, key: (x, k) => k.id(x.delegator).id(x.source).id(x.destination) },
    { name: 'byDelegatorDestination', unique: false, key: (x, k) => k.id(x.delegator).id(x.destination) },
    { name: 'bySource', unique: false, key: (x, k) => k.id(x.source) },
  ],
};

export const SigningInfoType: ObjectType<SigningInfo> = {
  id: TYPE.signingInfo,
  name: 'signingInfo',
  encode(w, o) {
    w.u64(o.validator).bytes(o.bitmap).u32(o.cursor).u32(o.missed).u32(o.tracked);
  },
  decode(r, id) {
    return { id, validator: r.u64(), bitmap: r.bytes(16_384), cursor: r.u32(), missed: r.u32(), tracked: r.u32() };
  },
  indices: [{ name: 'byValidator', unique: true, key: (s, k) => k.id(s.validator) }],
};

export const ProposalType: ObjectType<Proposal> = {
  id: TYPE.proposal,
  name: 'proposal',
  encode(w, o) {
    w.u64(o.proposer);
    encodeChainParameters(w, o.parameters);
    w.array(o.signals, (w, s) => w.u64(s)).u64(o.created).u64(o.expiration);
  },
  decode(r, id) {
    return { id, proposer: r.u64(), parameters: decodeChainParameters(r), signals: r.array((r) => r.u64(), MAX_SIGNALS), created: r.u64(), expiration: r.u64() };
  },
  indices: [{ name: 'byExpiration', unique: false, key: (p, k) => k.u64(p.expiration) }],
};

export const AccountType: ObjectType<Account> = {
  id: TYPE.account,
  name: 'account',
  encode(w, o) {
    w.string(o.name);
    encodeAuthority(w, o.owner);
    encodeAuthority(w, o.active);
    w.u64(o.registrar);
  },
  decode(r, id) {
    return { id, name: r.string(MAX_ACCOUNT_NAME), owner: decodeAuthority(r), active: decodeAuthority(r), registrar: r.u64() };
  },
  indices: [{ name: 'byName', unique: true, authenticated: true, key: (a, k) => k.str(a.name) }],
};

export const AssetType: ObjectType<Asset> = {
  id: TYPE.asset,
  name: 'asset',
  encode(w, o) {
    w.string(o.symbol).u8(o.precision).u64(o.issuer).u64(o.maxSupply).u64(o.currentSupply);
  },
  decode(r, id) {
    return { id, symbol: r.string(MAX_ASSET_SYMBOL), precision: r.u8(), issuer: r.u64(), maxSupply: r.u64(), currentSupply: r.u64() };
  },
  indices: [{ name: 'bySymbol', unique: true, authenticated: true, key: (a, k) => k.str(a.symbol) }],
};

export const BalanceType: ObjectType<Balance> = {
  id: TYPE.balance,
  name: 'balance',
  encode(w, o) {
    w.u64(o.owner).u64(o.asset).u64(o.amount);
  },
  decode(r, id) {
    return { id, owner: r.u64(), asset: r.u64(), amount: r.u64() };
  },
  indices: [
    { name: 'byOwnerAsset', unique: true, key: (b, k) => k.id(b.owner).id(b.asset) },
    { name: 'byAsset', unique: false, key: (b, k) => k.id(b.asset) },
  ],
};

export const RecentTxType: ObjectType<RecentTx> = {
  id: TYPE.recentTx,
  name: 'recentTx',
  encode(w, o) {
    w.fixed(o.txId).u64(o.expiration);
  },
  decode(r, id) {
    return { id, txId: r.fixed(HASH_SIZE), expiration: r.u64() };
  },
  indices: [
    { name: 'byTxId', unique: true, key: (t, k) => k.fixed(t.txId) },
    { name: 'byExpiration', unique: false, key: (t, k) => k.u64(t.expiration) },
  ],
};

export const ValidatorKeyType: ObjectType<ValidatorKey> = {
  id: TYPE.validatorKey,
  name: 'validatorKey',
  encode(w, o) {
    w.fixed(o.address).u64(o.validator);
  },
  decode(r, id) {
    return { id, address: r.fixed(HASH_SIZE), validator: r.u64() };
  },
  indices: [{ name: 'byAddress', unique: true, key: (k, w) => w.fixed(k.address) }],
};

export const CORE_TYPES: ObjectType<any>[] = [
  GlobalType,
  DynamicType,
  AccountType,
  AssetType,
  BalanceType,
  RecentTxType,
  ValidatorType,
  DelegationType,
  UnbondingType,
  RedelegationType,
  SigningInfoType,
  ProposalType,
  ValidatorKeyType,
];
