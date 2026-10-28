/**
 * The application's share of genesis: hand-edited JSON, parsed once into
 * objects. A small one is parsed as a string; one too large for that (a
 * token distribution, a migrated chain: hundreds of megabytes of public
 * keys) lives in its own file and is read as a token stream with stream-json,
 * one account at a time, so memory holds the objects and never the text. Account ids are assigned in listing order, so the first account
 * is 3.0, and it is also the issuer of the core asset. The fee schedule
 * (FEES.md), the expiration window and the staking parameters become the
 * global properties object.
 * Genesis validators name an operator account, a consensus key and a
 * self-bond taken from the operator's balance; the resulting active set is
 * what initChain hands the engine. Balances and fees in the JSON are base
 * units; the community pool, self-bonds and the four staking amounts are
 * whole tokens, converted at parse time.
 */
import { createReadStream, statSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { parser } from 'stream-json';
import Assembler from 'stream-json/assembler.js';
import type { Token } from 'stream-json/parser.js';
import { fromHex, toHex, compareBytes } from '../../crypto/hash.ts';
import type { ObjectDatabase } from '../../db/database.ts';
import { idFromString, objectId } from '../../db/id.ts';
import { PUBLIC_KEY_SIZE } from '../../crypto/keys.ts';
import { checkAuthority, type Authority } from './authority.ts';
import { checkAccountName, checkAssetSymbol } from './names.ts';
import { bootstrapValidators } from './staking.ts';
import type { Genesis } from '../../types/genesis.ts';
import {
  AccountType,
  AssetType,
  BalanceType,
  checkFeeSchedule,
  checkStakingParameters,
  DynamicType,
  feeScheduleFromJson,
  GlobalType,
  MAX_PRECISION,
  MAX_SHARE_SUPPLY,
  STAKING_BIGINT_FIELDS,
  TYPE,
  type FeeOperation,
  type FeeSchedule,
  type StakingParameters,
} from './types.ts';

export interface AuthorityJson {
  threshold: number;
  keys: { publicKey: string; weight: number }[];
  accounts?: { account: string; weight: number }[];
}

export interface AccountJson {
  name: string;
  owner: AuthorityJson;
  active: AuthorityJson;
  balance?: string;
}

export interface GenesisValidatorJson {
  /** Name of a genesis account. */
  operator: string;
  consensusKey: string;
  /** Whole tokens, moved from the operator's balance. */
  selfBond: string | number;
}

/** Staking parameters as written in genesis: whole-token amounts, everything else as in StakingParameters. */
export type StakingParametersJson = Partial<Record<keyof StakingParameters, string | number>>;

/** The fee schedule as written in genesis: any subset, amounts in base units, merged over the defaults. */
export type FeeScheduleJson = { scale?: number } & { [K in FeeOperation]?: Partial<Record<keyof FeeSchedule[K], string | number>> };

export interface AppGenesisJson {
  coreAsset?: { symbol?: string; precision?: number; maxSupply?: string };
  fees?: FeeScheduleJson;
  maxTxExpirationMs?: string;
  accounts?: AccountJson[];
  staking?: StakingParametersJson;
  /** Whole tokens, created at genesis. */
  communityPool?: string | number;
  validators?: GenesisValidatorJson[];
}

export interface AppGenesis {
  coreAsset: { symbol: string; precision: number; maxSupply: bigint };
  fees: FeeSchedule;
  maxTxExpirationMs: bigint;
  accounts: { name: string; owner: Authority; active: Authority; balance: bigint }[];
  staking: StakingParameters;
  communityPool: bigint;
  validators: { operator: string; consensusKey: Uint8Array; selfBond: bigint }[];
}

/** Base units; with the default precision of 5, a value of 100 is 0.001 of the core asset. */
export const DEFAULT_FEES: FeeSchedule = {
  scale: 10_000,
  transfer: { fee: 100n },
  accountCreate: { basicFee: 1000n, premiumFee: 5000n, pricePerKbyte: 100n },
  accountUpdate: { fee: 100n, pricePerKbyte: 100n },
  assetCreate: { symbol3: 100_000n, symbol4: 50_000n, longSymbol: 10_000n },
  assetIssue: { fee: 100n },
  validatorCreate: { fee: 1000n },
  validatorUpdate: { fee: 100n },
  delegate: { fee: 100n },
  undelegate: { fee: 100n },
  redelegate: { fee: 100n },
  unjail: { fee: 100n },
  proposalCreate: { fee: 100n },
  proposalSignal: { fee: 100n },
};
export const DEFAULT_MAX_TX_EXPIRATION_MS = 3_600_000n;

const DAY_MS = 86_400_000;

/** Defaults as agreed in STAKING.md; the four amounts are whole tokens here and converted at parse time. */
export const DEFAULT_STAKING: StakingParametersJson = {
  maxValidators: 21,
  unbondingPeriodMs: 7 * DAY_MS,
  minSelfBond: 10_000,
  minDelegation: 10,
  validatorCreationFee: 1_000,
  commissionBps: 1_000,
  fixedRewardPerBlock: 1,
  proposerBonusBps: 500,
  doubleSignSlashBps: 500,
  downtimeWindow: 1_000,
  downtimeMinSignedBps: 5_000,
  downtimeJailMs: 10 * 60_000,
  downtimeSlashBps: 1,
  maxEntries: 7,
  proposalLifetimeMs: 7 * DAY_MS,
  goalBondedBps: 6_700,
  inflationMinBps: 700,
  inflationMaxBps: 2_000,
  inflationChangeBpsPerYear: 1_300,
};

const WHOLE_TOKEN_PARAMS: (keyof StakingParameters)[] = ['minSelfBond', 'minDelegation', 'validatorCreationFee', 'fixedRewardPerBlock'];

export function parseStakingParameters(j: StakingParametersJson | undefined, precision: number): StakingParameters {
  const unit = 10n ** BigInt(precision);
  const merged = { ...DEFAULT_STAKING, ...(j ?? {}) };
  const out: Record<string, number | bigint> = {};
  for (const [k, v] of Object.entries(merged) as [keyof StakingParameters, string | number][]) {
    if (STAKING_BIGINT_FIELDS.includes(k)) out[k] = BigInt(v) * (WHOLE_TOKEN_PARAMS.includes(k) ? unit : 1n);
    else out[k] = Number(v);
  }
  const p = out as unknown as StakingParameters;
  const problem = checkStakingParameters(p);
  if (problem) throw new Error(`genesis staking parameters: ${problem}`);
  return p;
}

type GenesisAccount = AppGenesis['accounts'][number];

function authorityFromJson(a: AuthorityJson): Authority {
  return {
    threshold: a.threshold,
    accounts: (a.accounts ?? []).map((x) => ({ account: idFromString(x.account), weight: x.weight })),
    keys: a.keys.map((k) => ({ publicKey: fromHex(k.publicKey), weight: k.weight })),
  };
}

function accountFromJson(a: AccountJson): GenesisAccount {
  return { name: a.name, owner: authorityFromJson(a.owner), active: authorityFromJson(a.active), balance: BigInt(a.balance ?? '0') };
}

/** Everything but the accounts, which the two parsers below supply. */
function appGenesisFrom(j: AppGenesisJson, accounts: GenesisAccount[]): AppGenesis {
  const fees = feeScheduleFromJson(j.fees, DEFAULT_FEES);
  const feeProblem = checkFeeSchedule(fees);
  if (feeProblem) throw new Error(`genesis fees: ${feeProblem}`);
  const precision = j.coreAsset?.precision ?? 5;
  const unit = 10n ** BigInt(precision);
  return {
    coreAsset: {
      symbol: j.coreAsset?.symbol ?? 'CORE',
      precision,
      maxSupply: j.coreAsset?.maxSupply !== undefined ? BigInt(j.coreAsset.maxSupply) : MAX_SHARE_SUPPLY,
    },
    fees,
    maxTxExpirationMs: j.maxTxExpirationMs !== undefined ? BigInt(j.maxTxExpirationMs) : DEFAULT_MAX_TX_EXPIRATION_MS,
    accounts,
    staking: parseStakingParameters(j.staking, precision),
    communityPool: BigInt(j.communityPool ?? 0) * unit,
    validators: (j.validators ?? []).map((v) => ({ operator: v.operator, consensusKey: fromHex(v.consensusKey), selfBond: BigInt(v.selfBond) * unit })),
  };
}

/** An inline application genesis, small enough to parse as one string. */
export function parseAppGenesis(appState: Uint8Array): AppGenesis {
  const text = new TextDecoder().decode(appState).trim();
  const j = (text.length > 0 ? JSON.parse(text) : {}) as AppGenesisJson;
  return appGenesisFrom(j, (j.accounts ?? []).map(accountFromJson));
}

/**
 * The same document as a token stream. The top-level `accounts` array is
 * assembled one element at a time and converted on the spot; everything else
 * is assembled into the header. Only the objects survive: a 1 GB file never
 * exists as a string. Unlike the inline parser this rejects an empty input;
 * loadAppGenesis treats an empty file as an empty genesis before coming here.
 */
export async function parseAppGenesisStream(source: Readable): Promise<AppGenesis> {
  const tokens = parser.asStream({ streamValues: false });
  source.on('error', (e) => tokens.destroy(e));
  source.pipe(tokens);
  const header = new Assembler<AppGenesisJson>();
  const accounts: GenesisAccount[] = [];
  let element: Assembler<AccountJson> | null = null;
  let depth = 0; // containers open around the current token, the top-level object included
  let accountsNext = false; // the top-level key "accounts" was just read
  let inAccounts = false;
  for await (const chunk of tokens) {
    const tok = chunk as Token;
    if (inAccounts) {
      if (!element) {
        if (tok.name === 'endArray') {
          inAccounts = false;
          depth--;
          continue;
        }
        if (tok.name !== 'startObject') throw new Error('genesis accounts must be objects');
        element = new Assembler<AccountJson>();
      }
      element.consume(tok);
      if (element.done) {
        accounts.push(accountFromJson(element.current!));
        element = null;
      }
      continue;
    }
    if (accountsNext) {
      accountsNext = false;
      if (tok.name !== 'startArray') throw new Error('genesis accounts must be an array');
      inAccounts = true;
      depth++;
      continue;
    }
    if (tok.name === 'keyValue' && depth === 1 && tok.value === 'accounts') {
      accounts.length = 0; // a repeated key replaces the earlier value, as JSON.parse does
      accountsNext = true;
      continue;
    }
    if (tok.name === 'startObject' || tok.name === 'startArray') depth++;
    else if (tok.name === 'endObject' || tok.name === 'endArray') depth--;
    header.consume(tok);
  }
  if (inAccounts || accountsNext || element || !header.done) throw new Error('application genesis ended early');
  const j = header.current as AppGenesisJson | null;
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('application genesis must be an object');
  return appGenesisFrom(j, accounts);
}

/** The application genesis of a chain: streamed from its file, or parsed from the inline bytes. */
export async function loadAppGenesis(genesis: Genesis): Promise<AppGenesis> {
  if (!genesis.appStateFile) return parseAppGenesis(genesis.appState);
  if (statSync(genesis.appStateFile).size === 0) return appGenesisFrom({}, []);
  return parseAppGenesisStream(createReadStream(genesis.appStateFile));
}



/** A key-only authority in JSON form, canonically ordered. */
export function authorityJson(publicKeys: Uint8Array[], threshold = 1): AuthorityJson {
  return { threshold, keys: [...publicKeys].sort(compareBytes).map((k) => ({ publicKey: toHex(k), weight: 1 })) };
}

/** Serialise for Genesis.appState. */
export function appGenesisBytes(g: AppGenesisJson): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(g, null, 2));
}

/** Create the genesis objects in an empty database. Genesis is trusted configuration, so problems are fatal. */
export function applyGenesis(db: ObjectDatabase, g: AppGenesis, genesisTime: bigint): void {
  const symbolProblem = checkAssetSymbol(g.coreAsset.symbol);
  if (symbolProblem) throw new Error(`genesis core asset: ${symbolProblem}`);
  if (g.coreAsset.precision > MAX_PRECISION) throw new Error('genesis core asset: precision too high');
  if (g.coreAsset.maxSupply < 1n || g.coreAsset.maxSupply > MAX_SHARE_SUPPLY) throw new Error('genesis core asset: bad max supply');

  db.create(GlobalType, (id) => ({ id, coreAsset: objectId(TYPE.asset, 0), fees: g.fees, maxTxExpirationMs: g.maxTxExpirationMs, staking: g.staking }));
  db.create(DynamicType, (id) => ({
    id,
    height: 0n,
    time: genesisTime,
    communityPool: g.communityPool,
    inflationPpb: BigInt(g.staking.inflationMinBps) * 100_000n,
    lastMintTime: genesisTime,
    bonded: 0n,
    active: [],
    expectedSigners: [[], [], []],
  }));

  const accounts = g.accounts.map((a) => {
    const problem = checkAccountName(a.name) ?? checkAuthority(a.owner) ?? checkAuthority(a.active);
    if (problem) throw new Error(`genesis account ${a.name}: ${problem}`);
    return db.create(AccountType, (id) => ({ id, name: a.name, owner: a.owner, active: a.active, registrar: id }));
  });
  // Member accounts may be listed later in genesis, so check them once all exist.
  for (const a of g.accounts) {
    for (const auth of [a.owner, a.active]) {
      for (const m of auth.accounts) if (!db.get(AccountType, m.account)) throw new Error(`genesis account ${a.name}: member account does not exist`);
    }
  }

  const issuer = accounts[0]?.id ?? objectId(TYPE.account, 0);
  const core = db.create(AssetType, (id) => ({ id, symbol: g.coreAsset.symbol, precision: g.coreAsset.precision, issuer, maxSupply: g.coreAsset.maxSupply, currentSupply: 0n }));
  let supply = g.communityPool;
  g.accounts.forEach((a, i) => {
    if (a.balance < 0n) throw new Error(`genesis account ${a.name}: negative balance`);
    if (a.balance === 0n) return;
    db.create(BalanceType, (id) => ({ id, owner: accounts[i]!.id, asset: core.id, amount: a.balance }));
    supply += a.balance;
  });
  if (supply > g.coreAsset.maxSupply) throw new Error('genesis balances and pool exceed the core asset max supply');
  db.modify(AssetType, core.id, (x) => ({ ...x, currentSupply: supply }));

  for (const v of g.validators) {
    if (v.consensusKey.length !== PUBLIC_KEY_SIZE) throw new Error(`genesis validator ${v.operator}: bad consensus key`);
    if (!accounts.some((a) => a.name === v.operator)) throw new Error(`genesis validator ${v.operator}: no such genesis account`);
  }
  bootstrapValidators(db, g.validators.map((v) => ({ operator: accounts.find((a) => a.name === v.operator)!.id, consensusKey: v.consensusKey, selfBond: v.selfBond })));
}
