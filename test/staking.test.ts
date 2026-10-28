import { describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson, type StakingParametersJson } from '../src/app/core/genesis.ts';
import { delegationOf, SHARE_SCALE, signingInfoOf, tokensForShares, validatorByOperator } from '../src/app/core/staking.ts';
import type { OperationDraft } from '../src/app/core/tx.ts';
import { AssetType, BalanceType, DelegationType, DynamicType, GlobalType as GlobalTypeRef, ProposalType, RedelegationType, TYPE, UnbondingType, ValidatorStatus, ValidatorType, type ChainParameters, type StakingParameters } from '../src/app/core/types.ts';
import { encode } from '../src/codec/writer.ts';
import { toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed, type KeyPair } from '../src/crypto/keys.ts';
import { InlineVerifier } from '../src/crypto/verifier.ts';
import { objectId } from '../src/db/id.ts';
import { verifyKeyProof } from '../src/db/proof.ts';
import type { Genesis } from '../src/types/genesis.ts';
import { seedFor } from './helpers.ts';

const chainId = 'staking-test';
const genesisTime = 1_700_000_000_000n;
const UNIT = 100_000n; // precision 5
const T = (whole: number | bigint) => BigInt(whole) * UNIT;

const faucet = keyPairFromSeed(seedFor('st/faucet'));
const ops = ['a', 'b', 'c'].map((n) => keyPairFromSeed(seedFor(`st/op/${n}`)));
const cons = ['a', 'b', 'c'].map((n) => keyPairFromSeed(seedFor(`st/cons/${n}`)));
const FAUCET_ID = objectId(TYPE.account, 0);
const OP_ID = (i: number) => objectId(TYPE.account, 1 + i);
const VAL_ID = (i: number) => objectId(TYPE.validator, i);
const CORE = objectId(TYPE.asset, 0);

const PARAMS: StakingParametersJson = {
  maxValidators: 3,
  unbondingPeriodMs: 10_000,
  minSelfBond: 100,
  minDelegation: 1,
  validatorCreationFee: 10,
  commissionBps: 1000,
  fixedRewardPerBlock: 0,
  proposerBonusBps: 500,
  doubleSignSlashBps: 500,
  downtimeWindow: 4,
  downtimeMinSignedBps: 5000,
  downtimeJailMs: 5000,
  downtimeSlashBps: 1,
  maxEntries: 2,
  proposalLifetimeMs: 20_000,
  inflationMinBps: 0,
  inflationMaxBps: 0,
};

function makeGenesis(staking: StakingParametersJson = PARAMS, validators = [0, 1], selfBonds = [200, 100]): Genesis {
  const acct = (name: string, k: KeyPair, balance: bigint) => ({ name, owner: authorityJson([k.publicKey]), active: authorityJson([k.publicKey]), balance: balance.toString() });
  return {
    chainId,
    genesisTime,
    appState: appGenesisBytes({
      accounts: [acct('faucet', faucet, T(10_000)), acct('op-a', ops[0]!, T(1000)), acct('op-b', ops[1]!, T(1000)), acct('op-c', ops[2]!, T(1000))],
      staking,
      communityPool: 1000,
      validators: validators.map((i, n) => ({ operator: `op-${'abc'[i]}`, consensusKey: toHex(cons[i]!.publicKey), selfBond: selfBonds[n]! })),
    }),
  };
}

function makeApp(genesis = makeGenesis()): CoreApp {
  return new CoreApp({ genesis, verifier: new InlineVerifier(), retainVersions: 8 });
}

interface BlockOpts {
  proposer?: KeyPair;
  signers?: KeyPair[];
  misbehavior?: { address: Uint8Array; height: bigint }[];
  dt?: bigint;
}

async function block(app: CoreApp, txs: Uint8Array[] = [], o: BlockOpts = {}) {
  const height = app.lastHeight + 1n;
  const time = app.dynamic().time + (o.dt ?? 1000n);
  const res = await app.finalizeBlock({
    height,
    time,
    txs,
    proposerAddress: (o.proposer ?? cons[0]!).address,
    lastCommitSigners: height === 1n ? [] : (o.signers ?? [cons[0]!, cons[1]!]).map((k) => k.address),
    misbehavior: o.misbehavior ?? [],
  });
  await app.commit();
  return res;
}

const tx = (app: CoreApp, operations: OperationDraft[], keys: KeyPair[]) => signedTxBytes(chainId, { expiration: app.dynamic().time + 60_000n, operations: withFees(operations, app.feeSchedule()) }, keys);
const val = (app: CoreApp, i: number) => app.db.get(ValidatorType, VAL_ID(i))!;

/** currentSupply = balances + validator tokens + unbonding + pool, at every height. */
function checkSupply(app: CoreApp): void {
  const db = app.db;
  let sum = 0n;
  for (const b of db.range(BalanceType, 'byAsset', encode((w) => w.u64(CORE)))) sum += b.amount;
  for (const v of db.scan(ValidatorType, 'byPower', new Uint8Array(0))) sum += v.tokens;
  for (const u of db.scan(UnbondingType, 'byCompletion', new Uint8Array(0))) sum += u.tokens;
  sum += db.get(DynamicType, objectId(TYPE.dynamic, 0))!.communityPool; // live view, like the sums above
  expect(sum).toBe(db.get(AssetType, CORE)!.currentSupply);
}

describe('staking', () => {
  it('bootstraps validators from genesis and hands the engine the set', async () => {
    const app = makeApp();
    const init = await app.initChain(makeGenesis());
    expect(init.validators!.map((v) => [toHex(v.publicKey).slice(0, 8), v.power])).toEqual([
      [toHex(cons[0]!.publicKey).slice(0, 8), 200n],
      [toHex(cons[1]!.publicKey).slice(0, 8), 100n],
    ]);
    const a = val(app, 0);
    expect(a.operator).toBe(OP_ID(0));
    expect(a.tokens).toBe(T(200));
    expect(a.shares).toBe(T(200) * SHARE_SCALE);
    expect(delegationOf(app.db, OP_ID(0), a.id)!.shares).toBe(a.shares);
    expect(app.balance(OP_ID(0))).toBe(T(800));
    expect(app.dynamic().communityPool).toBe(T(1000));
    expect(app.dynamic().bonded).toBe(T(300));
    expect(validatorByOperator(app.db, OP_ID(2))).toBeNull();
    checkSupply(app);
    expect(toHex(verifyKeyProof(app.lastAppHash, app.proveValidatorAddress(cons[0]!.address))!)).toBe(toHex(encode((w) => w.u64(VAL_ID(0)))));
    expect(verifyKeyProof(app.lastAppHash, app.proveValidatorAddress(cons[2]!.address))).toBeNull();
  });

  it('pays the block reward from the pool with a proposer bonus, by stake, with commission minted to operators', async () => {
    const app = makeApp(makeGenesis({ ...PARAMS, fixedRewardPerBlock: 10 }));
    await block(app); // height 1: nothing to pay
    expect(app.dynamic().communityPool).toBe(T(1000));
    const before = [val(app, 0), val(app, 1)];
    const r = await block(app, [], { proposer: cons[0]!, signers: [cons[0]!, cons[1]!] });
    // 10 tokens: 0.5 to the proposer (A), 9.5 split 200:100.
    const a = val(app, 0);
    const b = val(app, 1);
    const bonus = T(10) / 20n;
    const rest = T(10) - bonus;
    expect(a.tokens - before[0]!.tokens).toBe(bonus + (rest * T(200)) / T(300));
    expect(b.tokens - before[1]!.tokens).toBe((rest * T(100)) / T(300));
    const paid = a.tokens - before[0]!.tokens + (b.tokens - before[1]!.tokens);
    expect(app.dynamic().communityPool).toBe(T(1000) - paid); // dust stayed
    // The operator's delegation grew by the commission's worth of shares; the exchange rate rose.
    const opShares = delegationOf(app.db, OP_ID(0), a.id)!.shares;
    expect(opShares).toBeGreaterThan(before[0]!.shares);
    const opValue = tokensForShares(a, opShares);
    expect(opValue - T(200)).toBeGreaterThanOrEqual((a.tokens - before[0]!.tokens) / 10n - 1n);
    expect(tokensForShares(a, SHARE_SCALE * UNIT)).toBeGreaterThan(UNIT); // one token's worth of shares is now worth more than a token
    // Whole-token powers moved (A to 206, B to 103), so the engine gets both as updates.
    expect(r.validatorUpdates.map((u) => u.power)).toEqual([206n, 103n]);
    checkSupply(app);
  });

  it('delegates, undelegates through the queue, enforces the entry cap, and releases on maturity', async () => {
    const app = makeApp();
    await block(app);
    const delegate = tx(app, [{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID(0), amount: T(50) }], [faucet]);
    const r = await block(app, [delegate]);
    expect(r.txResults[0]!.ok).toBe(true);
    const d = delegationOf(app.db, FAUCET_ID, VAL_ID(0))!;
    expect(tokensForShares(val(app, 0), d.shares)).toBeLessThanOrEqual(T(50));
    expect(tokensForShares(val(app, 0), d.shares)).toBeGreaterThan(T(50) - 2n);
    expect(r.validatorUpdates.map((u) => u.power)).toEqual([250n]); // A moved from 200 to 250 whole tokens
    expect(app.balance(FAUCET_ID)).toBe(T(10_000) - T(50) - 100n);
    expect(toHex(verifyKeyProof(app.lastAppHash, app.proveDelegation(FAUCET_ID, VAL_ID(0)))!)).toBe(toHex(encode((w) => w.u64(d.id))));

    const half = d.shares / 2n;
    const undelegate = (n: bigint) => tx(app, [{ type: 'undelegate', delegator: FAUCET_ID, validator: VAL_ID(0), shares: n }], [faucet]);
    const r2 = await block(app, [undelegate(half), undelegate(half / 2n), undelegate(half / 4n)]);
    expect(r2.txResults.map((x) => x.ok)).toEqual([true, true, false]);
    expect(r2.txResults[2]!.error).toMatch(/pending unbonding/);
    const entries = app.db.range(UnbondingType, 'byCompletion', new Uint8Array(0));
    expect(entries.length).toBe(2);
    expect(entries[0]!.completion).toBe(app.dynamic().time + 10_000n);
    const balanceBefore = app.balance(FAUCET_ID);
    checkSupply(app);
    // Nine seconds later nothing matured; at ten the tokens are back.
    await block(app, [], { dt: 9000n });
    expect(app.balance(FAUCET_ID)).toBe(balanceBefore);
    await block(app, [], { dt: 1000n });
    expect(app.db.range(UnbondingType, 'byCompletion', new Uint8Array(0)).length).toBe(0);
    expect(app.balance(FAUCET_ID)).toBe(balanceBefore + entries[0]!.tokens + entries[1]!.tokens);
    checkSupply(app);
  });

  it('redelegates with the no-chain rule and the self-bond floor', async () => {
    const app = makeApp();
    await block(app);
    await block(app, [tx(app, [{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID(0), amount: T(60) }], [faucet])]);
    const d = delegationOf(app.db, FAUCET_ID, VAL_ID(0))!;
    const r = await block(app, [tx(app, [{ type: 'redelegate', delegator: FAUCET_ID, source: VAL_ID(0), destination: VAL_ID(1), shares: d.shares / 2n }], [faucet])]);
    expect(r.txResults[0]!.ok).toBe(true);
    expect(app.db.range(RedelegationType, 'byCompletion', new Uint8Array(0)).length).toBe(1);
    expect(tokensForShares(val(app, 1), delegationOf(app.db, FAUCET_ID, VAL_ID(1))!.shares)).toBeGreaterThan(T(29));
    // Moving it again out of B while the entry is pending is refused; after maturity it is allowed.
    const again = () => tx(app, [{ type: 'redelegate', delegator: FAUCET_ID, source: VAL_ID(1), destination: VAL_ID(0), shares: delegationOf(app.db, FAUCET_ID, VAL_ID(1))!.shares }], [faucet]);
    expect((await app.checkTx(again())).error).toMatch(/still redelegating/);
    await block(app, [], { dt: 10_000n });
    expect(app.db.range(RedelegationType, 'byCompletion', new Uint8Array(0)).length).toBe(0);
    expect((await app.checkTx(again())).ok).toBe(true);
    // The operator cannot move its self-bond below the minimum.
    const self = delegationOf(app.db, OP_ID(1), VAL_ID(1))!;
    expect((await app.checkTx(tx(app, [{ type: 'undelegate', delegator: OP_ID(1), validator: VAL_ID(1), shares: self.shares / 2n }], [ops[1]!]))).error).toMatch(/self-bond/);
    checkSupply(app);
  });

  it('creates validators with the fee and minimums, ranks the top N, and rotates keys', async () => {
    const app = makeApp();
    await block(app);
    const create = (bond: bigint, key: KeyPair = cons[2]!) => tx(app, [{ type: 'validatorCreate', operator: OP_ID(2), consensusKey: key.publicKey, selfBond: bond }], [ops[2]!]);
    expect((await app.checkTx(create(T(99)))).error).toMatch(/self-bond must be at least/);
    expect((await app.checkTx(create(T(100), cons[0]!))).error).toMatch(/consensus key already in use/);
    const pool = app.dynamic().communityPool;
    const r = await block(app, [create(T(150))]);
    expect(r.txResults[0]!.ok).toBe(true);
    expect(app.dynamic().communityPool).toBe(pool + T(10) + 1000n); // the creation fee and the operation fee come in; no reward goes out
    expect(app.balance(OP_ID(2))).toBe(T(1000) - T(150) - T(10) - 1000n);
    expect(r.validatorUpdates.map((u) => [toHex(u.publicKey).slice(0, 8), u.power])).toEqual([[toHex(cons[2]!.publicKey).slice(0, 8), 150n]]);
    expect(app.dynamic().active.map((a) => a.power)).toEqual([200n, 150n, 100n]);
    // A fourth candidate with less stake stays out when N is 3; one with more pushes the smallest out.
    const extraOp = keyPairFromSeed(seedFor('st/op/d'));
    const extraCons = keyPairFromSeed(seedFor('st/cons/d'));
    await block(app, [tx(app, [{ type: 'accountCreate', registrar: FAUCET_ID, name: 'op-d', owner: makeAuthority([extraOp.publicKey]), active: makeAuthority([extraOp.publicKey]) }], [faucet])]);
    const opD = app.accountByName('op-d')!.id;
    await block(app, [tx(app, [{ type: 'transfer', from: FAUCET_ID, to: opD, asset: CORE, amount: T(1000) }], [faucet])]);
    const r2 = await block(app, [tx(app, [{ type: 'validatorCreate', operator: opD, consensusKey: extraCons.publicKey, selfBond: T(120) }], [extraOp])]);
    expect(r2.txResults[0]!.ok).toBe(true);
    expect(r2.validatorUpdates.map((u) => u.power)).toEqual([120n, 0n]); // D in at 120, B (100) out
    expect(app.dynamic().active.map((a) => a.validator)).toEqual([VAL_ID(0), VAL_ID(2), objectId(TYPE.validator, 3)]);
    // Key rotation: the old key leaves, the new one enters at the same power.
    const fresh = keyPairFromSeed(seedFor('st/cons/a2'));
    const r3 = await block(app, [tx(app, [{ type: 'validatorUpdate', operator: OP_ID(0), validator: VAL_ID(0), consensusKey: fresh.publicKey }], [ops[0]!])]);
    expect(r3.txResults[0]!.ok).toBe(true);
    expect(r3.validatorUpdates.map((u) => [toHex(u.publicKey).slice(0, 8), u.power])).toEqual([
      [toHex(fresh.publicKey).slice(0, 8), 200n],
      [toHex(cons[0]!.publicKey).slice(0, 8), 0n],
    ]);
    checkSupply(app);
  });

  it('jails a validator that misses half the window, slashes it a little, and lets it unjail after the period', async () => {
    const app = makeApp();
    await block(app);
    const tokensBefore = val(app, 1).tokens;
    // B misses four blocks in a row with a window of four at 50%.
    for (let i = 0; i < 3; i++) await block(app, [], { signers: [cons[0]!] });
    expect(val(app, 1).status).toBe(ValidatorStatus.candidate);
    const r = await block(app, [], { signers: [cons[0]!] });
    const b = val(app, 1);
    expect(b.status).toBe(ValidatorStatus.jailed);
    expect(b.jailedUntil).toBe(app.dynamic().time + 5000n);
    expect(b.tokens).toBe(tokensBefore - tokensBefore / 10_000n); // slashed 0.01%
    expect(r.validatorUpdates.map((u) => u.power)).toEqual([0n]);
    expect(app.dynamic().active.length).toBe(1);
    const unjail = () => tx(app, [{ type: 'unjail', operator: OP_ID(1), validator: VAL_ID(1) }], [ops[1]!]);
    expect((await app.checkTx(unjail())).error).toMatch(/jail period/);
    // The slash took the self-bond just under the minimum, so unjailing needs a top-up first;
    // delegating to a jailed validator is allowed, by anyone.
    expect((await app.checkTx(tx(app, [{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID(1), amount: T(5) }], [faucet]))).ok).toBe(true);
    await block(app, [], { dt: 5000n, signers: [cons[0]!] });
    expect((await app.checkTx(unjail())).error).toMatch(/self-bond below/);
    await block(app, [tx(app, [{ type: 'delegate', delegator: OP_ID(1), validator: VAL_ID(1), amount: T(1) }], [ops[1]!])], { signers: [cons[0]!] });
    const r2 = await block(app, [unjail()], { signers: [cons[0]!] });
    expect(r2.txResults[0]!.ok).toBe(true);
    expect(val(app, 1).status).toBe(ValidatorStatus.candidate);
    expect(r2.validatorUpdates.map((u) => u.power)).toEqual([100n]); // 100.99 whole tokens
    checkSupply(app);
  });

  it('tombstones a double signer, slashes its stake and later leavers, and unbonds everyone', async () => {
    const app = makeApp();
    await block(app);
    await block(app, [tx(app, [{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID(0), amount: T(100) }], [faucet])]);
    // The faucet starts unbonding after the infraction height: that entry is slashed too.
    const infraction = app.lastHeight;
    const d = delegationOf(app.db, FAUCET_ID, VAL_ID(0))!;
    await block(app, [tx(app, [{ type: 'undelegate', delegator: FAUCET_ID, validator: VAL_ID(0), shares: d.shares / 2n }], [faucet])]);
    const entryBefore = app.db.range(UnbondingType, 'byCompletion', new Uint8Array(0))[0]!;
    const a = val(app, 0);
    const pool = app.dynamic().communityPool;
    const r = await block(app, [], { misbehavior: [{ address: cons[0]!.address, height: infraction }] });
    const after = val(app, 0);
    expect(after.status).toBe(ValidatorStatus.tombstoned);
    expect(after.tokens).toBe(0n);
    expect(after.shares).toBe(0n);
    expect(app.db.range(DelegationType, 'byValidator', encode((w) => w.u64(VAL_ID(0)))).length).toBe(0);
    const entries = app.db.range(UnbondingType, 'byValidator', encode((w) => w.u64(VAL_ID(0))));
    expect(entries.length).toBe(3); // the earlier entry plus one per delegation (operator and faucet)
    const slashedEntry = entries.find((e) => e.id === entryBefore.id)!;
    expect(slashedEntry.tokens).toBe(entryBefore.tokens - (entryBefore.tokens * 500n) / 10_000n);
    const forced = entries.filter((e) => e.id !== entryBefore.id).reduce((s, e) => s + e.tokens, 0n);
    expect(forced).toBeLessThanOrEqual(a.tokens - (a.tokens * 500n) / 10_000n);
    expect(app.dynamic().communityPool).toBeGreaterThanOrEqual(pool + (a.tokens * 500n) / 10_000n - T(10));
    expect(r.validatorUpdates.map((u) => u.power)).toEqual([0n]);
    expect((await app.checkTx(tx(app, [{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID(0), amount: T(5) }], [faucet]))).error).toMatch(/tombstoned/);
    // A second report is ignored; after the unbonding period everyone is paid out.
    await block(app, [], { misbehavior: [{ address: cons[0]!.address, height: infraction }], signers: [cons[1]!], proposer: cons[1]! });
    const opBalance = app.balance(OP_ID(0));
    await block(app, [], { dt: 10_000n, signers: [cons[1]!], proposer: cons[1]! });
    expect(app.db.range(UnbondingType, 'byCompletion', new Uint8Array(0)).length).toBe(0);
    expect(app.balance(OP_ID(0))).toBeGreaterThan(opBalance);
    checkSupply(app);
  });

  it('mints toward the bonded goal and never past the max supply', async () => {
    const app = makeApp(makeGenesis({ ...PARAMS, inflationMinBps: 700, inflationMaxBps: 2000, fixedRewardPerBlock: 0 }));
    const supply0 = app.db.get(AssetType, CORE)!.currentSupply;
    const rate0 = app.dynamic().inflationPpb;
    expect(rate0).toBe(700n * 100_000n);
    await block(app, [], { dt: 3_600_000n }); // an hour: supply * 7% / (365*24)
    const d = app.dynamic();
    const supply1 = app.db.get(AssetType, CORE)!.currentSupply;
    // Bonded ratio is tiny, so the rate climbs first (13% a year is about 0.0015% an hour) and the new rate mints.
    expect(d.inflationPpb - rate0).toBe((1300n * 100_000n * 3_600_000n) / (365n * 24n * 3_600_000n));
    expect(supply1 - supply0).toBe((supply0 * d.inflationPpb * 3_600_000n) / (1_000_000_000n * 365n * 24n * 3_600_000n));
    expect(d.communityPool).toBe(T(1000) + (supply1 - supply0));
    checkSupply(app);
    // Cap: a genesis at the max supply mints nothing.
    const capped = makeApp({ ...makeGenesis({ ...PARAMS, inflationMinBps: 700, inflationMaxBps: 2000, fixedRewardPerBlock: 0 }), appState: appGenesisBytes({ ...JSON.parse(new TextDecoder().decode(makeGenesis().appState)), coreAsset: { maxSupply: (T(10_000) + T(3000) + T(1000)).toString() }, staking: { ...PARAMS, inflationMinBps: 700, inflationMaxBps: 2000, fixedRewardPerBlock: 0 } }) });
    const s0 = capped.db.get(AssetType, CORE)!.currentSupply;
    await block(capped, [], { dt: 3_600_000n });
    expect(capped.db.get(AssetType, CORE)!.currentSupply).toBe(s0);
  });

  it('adopts a parameter proposal at two thirds of active stake and expires the rest', async () => {
    const app = makeApp();
    await block(app);
    const current = app.chainParameters();
    const proposed: ChainParameters = { ...current, staking: { ...current.staking, maxValidators: 2, minDelegation: T(3) } };
    const propose = tx(app, [{ type: 'proposalCreate', operator: OP_ID(0), validator: VAL_ID(0), parameters: proposed }], [ops[0]!]);
    const r = await block(app, [propose]);
    expect(r.txResults[0]!.ok).toBe(true);
    const prop = app.db.range(ProposalType, 'byExpiration', new Uint8Array(0))[0]!;
    expect(prop.signals).toEqual([VAL_ID(0)]);
    // A alone holds 200 of 300: exactly two thirds, not more. Nothing happens until B signals.
    await block(app);
    expect((app.db.get(GlobalTypeRef, objectId(TYPE.global, 0)) as any).staking.maxValidators).toBe(3);
    expect((await app.checkTx(tx(app, [{ type: 'proposalSignal', operator: OP_ID(0), validator: VAL_ID(0), proposal: prop.id }], [ops[0]!]))).error).toMatch(/already signalled/);
    const r2 = await block(app, [tx(app, [{ type: 'proposalSignal', operator: OP_ID(1), validator: VAL_ID(1), proposal: prop.id }], [ops[1]!])]);
    expect(r2.txResults[0]!.ok).toBe(true);
    const adopted = app.chainParameters();
    expect(adopted.staking.maxValidators).toBe(2);
    expect(adopted.staking.minDelegation).toBe(T(3));
    expect(adopted.fees).toEqual(current.fees);
    expect(app.db.range(ProposalType, 'byExpiration', new Uint8Array(0)).length).toBe(0);
    expect((await app.checkTx(tx(app, [{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID(0), amount: T(2) }], [faucet]))).error).toMatch(/at least/);
    // An unsupported proposal expires after its lifetime.
    await block(app, [tx(app, [{ type: 'proposalCreate', operator: OP_ID(1), validator: VAL_ID(1), parameters: { ...adopted, staking: { ...adopted.staking, maxValidators: 9 } } }], [ops[1]!])]);
    expect(app.db.range(ProposalType, 'byExpiration', new Uint8Array(0)).length).toBe(1);
    await block(app, [], { dt: 20_000n });
    expect(app.db.range(ProposalType, 'byExpiration', new Uint8Array(0)).length).toBe(0);
    expect((await app.checkTx(tx(app, [{ type: 'proposalCreate', operator: OP_ID(2), validator: VAL_ID(0), parameters: adopted }], [ops[2]!]))).error).toMatch(/not the operator/);
    checkSupply(app);
  });

  it('punishes stake whose unbonding matures in the very block that carries the evidence', async () => {
    const app = makeApp();
    await block(app);
    await block(app, [tx(app, [{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID(0), amount: T(100) }], [faucet])]);
    const d = delegationOf(app.db, FAUCET_ID, VAL_ID(0))!;
    const h = app.lastHeight + 1n;
    await block(app, [tx(app, [{ type: 'undelegate', delegator: FAUCET_ID, validator: VAL_ID(0), shares: d.shares }], [faucet])]);
    const entry = app.db.range(UnbondingType, 'byCompletion', new Uint8Array(0))[0]!;
    const before = app.balance(FAUCET_ID);
    // The block that matures the entry also carries evidence of a double sign one height after the undelegation.
    await block(app, [], { dt: 10_000n, misbehavior: [{ address: cons[0]!.address, height: h + 1n }] });
    expect(app.db.get(UnbondingType, entry.id)).toBeNull();
    expect(app.balance(FAUCET_ID)).toBe(before + entry.tokens - (entry.tokens * 500n) / 10_000n);
    checkSupply(app);
  });

  it('adopts parameters with care: pending unbondings follow a longer period, signing windows restart, and no proposal may empty the set', async () => {
    const app = makeApp();
    await block(app);
    await block(app, [tx(app, [{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID(0), amount: T(10) }], [faucet])]);
    const d = delegationOf(app.db, FAUCET_ID, VAL_ID(0))!;
    await block(app, [tx(app, [{ type: 'undelegate', delegator: FAUCET_ID, validator: VAL_ID(0), shares: d.shares }], [faucet])]);
    const entry = app.db.range(UnbondingType, 'byCompletion', new Uint8Array(0))[0]!;
    const propose = (staking: Partial<StakingParameters>, who: number) => {
      const current = app.chainParameters();
      return tx(app, [{ type: 'proposalCreate', operator: OP_ID(who), validator: VAL_ID(who), parameters: { ...current, staking: { ...current.staking, ...staking } } }], [ops[who]!]);
    };
    const signal = (who: number, proposal: bigint) => tx(app, [{ type: 'proposalSignal', operator: OP_ID(who), validator: VAL_ID(who), proposal }], [ops[who]!]);
    // Twice the unbonding period, and a smaller downtime window of the same byte length.
    await block(app, [propose({ unbondingPeriodMs: 20_000n, downtimeWindow: 3 }, 0)]);
    const p1 = app.db.range(ProposalType, 'byExpiration', new Uint8Array(0))[0]!;
    await block(app, [signal(1, p1.id)]);
    expect(app.stakingParameters().unbondingPeriodMs).toBe(20_000n);
    expect(app.db.get(UnbondingType, entry.id)!.completion).toBe(entry.completion + 10_000n);
    for (const i of [0, 1]) expect(signingInfoOf(app.db, VAL_ID(i))!.tracked).toBe(0);
    // A minimum self-bond above every bond would leave no validator: the proposal lapses instead.
    await block(app, [propose({ minSelfBond: T(201) }, 0)]);
    const p2 = app.db.range(ProposalType, 'byExpiration', new Uint8Array(0))[0]!;
    await block(app, [signal(1, p2.id)]);
    expect(app.stakingParameters().minSelfBond).toBe(T(100));
    expect(app.db.range(ProposalType, 'byExpiration', new Uint8Array(0)).length).toBe(0);
    expect(app.dynamic().active.length).toBe(2);
    checkSupply(app);
  });

  it('caps the signals a proposal can hold at what its encoding can carry', async () => {
    const app = makeApp();
    await block(app);
    await block(app, [tx(app, [{ type: 'proposalCreate', operator: OP_ID(0), validator: VAL_ID(0), parameters: app.chainParameters() }], [ops[0]!])]);
    const p = app.db.range(ProposalType, 'byExpiration', new Uint8Array(0))[0]!;
    // As if a thousand validators of a larger chain had already signalled.
    app.db.modify(ProposalType, p.id, (x) => ({ ...x, signals: Array.from({ length: 1000 }, (_, i) => objectId(TYPE.validator, 100 + i)) }));
    expect((await app.checkTx(tx(app, [{ type: 'proposalSignal', operator: OP_ID(1), validator: VAL_ID(1), proposal: p.id }], [ops[1]!]))).error).toMatch(/maximum number of signals/);
  });
});
