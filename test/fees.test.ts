/** The fee schedule (FEES.md): pricing, payment, genesis, and change by validator proposal. */
import { describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson, DEFAULT_FEES, parseAppGenesis, type FeeScheduleJson, type StakingParametersJson } from '../src/app/core/genesis.ts';
import { isCheapName } from '../src/app/core/names.ts';
import { calculateFee, decodeTransaction, encodeOperationBody, encodeTransaction, type Operation, type OperationDraft } from '../src/app/core/tx.ts';
import { checkFeeSchedule, feeScheduleFromJson, MAX_SHARE_SUPPLY, ProposalType, TYPE, type ChainParameters } from '../src/app/core/types.ts';
import { encode } from '../src/codec/writer.ts';
import { toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed, type KeyPair } from '../src/crypto/keys.ts';
import { InlineVerifier } from '../src/crypto/verifier.ts';
import { objectId } from '../src/db/id.ts';
import type { Genesis } from '../src/types/genesis.ts';
import { seedFor } from './helpers.ts';

const chainId = 'fees-test';
const genesisTime = 1_700_000_000_000n;
const UNIT = 100_000n; // precision 5
const T = (whole: number | bigint) => BigInt(whole) * UNIT;

const faucet = keyPairFromSeed(seedFor('fees/faucet'));
const alice = keyPairFromSeed(seedFor('fees/alice'));
const ops = ['a', 'b'].map((n) => keyPairFromSeed(seedFor(`fees/op/${n}`)));
const cons = ['a', 'b'].map((n) => keyPairFromSeed(seedFor(`fees/cons/${n}`)));
const FAUCET_ID = objectId(TYPE.account, 0);
const OP_ID = (i: number) => objectId(TYPE.account, 1 + i);
const VAL_ID = (i: number) => objectId(TYPE.validator, i);
const CORE = objectId(TYPE.asset, 0);

const STAKING: StakingParametersJson = { maxValidators: 3, unbondingPeriodMs: 10_000, minSelfBond: 100, minDelegation: 1, validatorCreationFee: 10, fixedRewardPerBlock: 0, inflationMinBps: 0, inflationMaxBps: 0, proposalLifetimeMs: 20_000 };

/** Two genesis validators: op-a with 200 of the 300 bonded, op-b with 100, so adoption needs both. */
function genesisWith(fees?: FeeScheduleJson): Genesis {
  const acct = (name: string, k: KeyPair, balance: bigint) => ({ name, owner: authorityJson([k.publicKey]), active: authorityJson([k.publicKey]), balance: balance.toString() });
  return {
    chainId,
    genesisTime,
    appState: appGenesisBytes({
      accounts: [acct('faucet', faucet, T(10_000)), acct('op-a', ops[0]!, T(1000)), acct('op-b', ops[1]!, T(1000))],
      staking: STAKING,
      fees,
      communityPool: 1000,
      validators: [
        { operator: 'op-a', consensusKey: toHex(cons[0]!.publicKey), selfBond: 200 },
        { operator: 'op-b', consensusKey: toHex(cons[1]!.publicKey), selfBond: 100 },
      ],
    }),
  };
}

function makeApp(genesis = genesisWith()): CoreApp {
  return new CoreApp({ genesis, verifier: new InlineVerifier(), retainVersions: 8 });
}

async function block(app: CoreApp, txs: Uint8Array[] = []) {
  const height = app.lastHeight + 1n;
  const res = await app.finalizeBlock({
    height,
    time: app.dynamic().time + 1000n,
    txs,
    proposerAddress: cons[0]!.address,
    lastCommitSigners: height === 1n ? [] : cons.map((k) => k.address),
    misbehavior: [],
  });
  await app.commit();
  return res;
}

/** Operations priced from the schedule in force, as a wallet would. */
const tx = (app: CoreApp, operations: OperationDraft[], keys: KeyPair[] = [faucet]) => signedTxBytes(chainId, { expiration: app.dynamic().time + 60_000n, operations: withFees(operations, app.feeSchedule()) }, keys);
/** Operations with the fees exactly as given. */
const rawTx = (app: CoreApp, operations: Operation[], keys: KeyPair[] = [faucet]) => signedTxBytes(chainId, { expiration: app.dynamic().time + 60_000n, operations }, keys);
const transfer = (amount: bigint, to = OP_ID(0)): OperationDraft => ({ type: 'transfer', from: FAUCET_ID, to, asset: CORE, amount });
const bodyBytes = (op: OperationDraft) => BigInt(encode((w) => encodeOperationBody(w, op)).length);

describe('fee schedule', () => {
  it('prices operations the BitShares way: premium names, data per kilobyte, symbol length, scale', async () => {
    // Names: a digit, a dot, a hyphen, or no vowel (y counts) makes a name cheap.
    expect(isCheapName('alice')).toBe(false);
    expect(isCheapName('bob')).toBe(false);
    expect(isCheapName('alice1')).toBe(true);
    expect(isCheapName('al-ice')).toBe(true);
    expect(isCheapName('a.b')).toBe(true);
    expect(isCheapName('mrkt')).toBe(true);
    expect(isCheapName('xyz')).toBe(false);

    expect(calculateFee(transfer(1n), DEFAULT_FEES)).toBe(100n);
    const oneKey = makeAuthority([alice.publicKey]);
    const premium: OperationDraft = { type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: oneKey, active: oneKey };
    const cheap: OperationDraft = { ...premium, name: 'alice1' };
    const dataFee = (op: OperationDraft) => (bodyBytes(op) * DEFAULT_FEES.accountCreate.pricePerKbyte) / 1024n;
    expect(bodyBytes(premium)).toBeGreaterThan(2n * 1312n); // two ML-DSA keys
    expect(calculateFee(premium, DEFAULT_FEES)).toBe(DEFAULT_FEES.accountCreate.premiumFee + dataFee(premium));
    expect(calculateFee(cheap, DEFAULT_FEES)).toBe(DEFAULT_FEES.accountCreate.basicFee + dataFee(cheap));
    // More keys, more bytes, more fee.
    const sixteen = makeAuthority(Array.from({ length: 16 }, (_, i) => keyPairFromSeed(seedFor(`fees/k/${i}`)).publicKey));
    const big: OperationDraft = { ...premium, owner: sixteen, active: sixteen };
    expect(calculateFee(big, DEFAULT_FEES) - calculateFee(premium, DEFAULT_FEES)).toBeGreaterThan((30n * 1312n * 100n) / 1024n);
    const update: OperationDraft = { type: 'accountUpdate', account: FAUCET_ID, owner: null, active: sixteen };
    expect(calculateFee(update, DEFAULT_FEES)).toBe(DEFAULT_FEES.accountUpdate.fee + (bodyBytes(update) * DEFAULT_FEES.accountUpdate.pricePerKbyte) / 1024n);

    const asset = (symbol: string): OperationDraft => ({ type: 'assetCreate', issuer: FAUCET_ID, symbol, precision: 2, maxSupply: 1000n });
    expect(calculateFee(asset('ABC'), DEFAULT_FEES)).toBe(100_000n);
    expect(calculateFee(asset('ABCD'), DEFAULT_FEES)).toBe(50_000n);
    expect(calculateFee(asset('ABCDEF'), DEFAULT_FEES)).toBe(10_000n);

    // Scale moves everything at once; the result is capped at the maximum share supply.
    expect(calculateFee(transfer(1n), { ...DEFAULT_FEES, scale: 25_000 })).toBe(250n);
    expect(calculateFee(asset('ABC'), { ...DEFAULT_FEES, scale: 0 })).toBe(0n);
    expect(calculateFee(transfer(1n), { ...DEFAULT_FEES, scale: 20_000, transfer: { fee: MAX_SHARE_SUPPLY } })).toBe(MAX_SHARE_SUPPLY);

    // The fee is part of the signed bytes.
    const [op] = withFees([transfer(5n)], DEFAULT_FEES);
    const decoded = decodeTransaction(rawTx(makeApp(), [{ ...op!, fee: 777n }]));
    expect(decoded.operations[0]!.fee).toBe(777n);
    // And the signature binds it: a fee changed after signing is an invalid signature, not a different price.
    const app = makeApp();
    await block(app);
    const signed = decodeTransaction(rawTx(app, withFees([transfer(1n)], app.feeSchedule())));
    const tampered = encodeTransaction({ ...signed, operations: [{ ...signed.operations[0]!, fee: signed.operations[0]!.fee + 1n }] });
    expect((await app.checkTx(tampered)).error).toMatch(/invalid signature/);
  });

  it('refuses an operation stating less than the schedule, and charges exactly what is stated', async () => {
    const app = makeApp();
    await block(app);
    const start = app.balance(FAUCET_ID);
    const pool = app.dynamic().communityPool;
    const priced = withFees([transfer(T(1))], app.feeSchedule())[0] as Operation & { type: 'transfer' };
    expect((await app.checkTx(rawTx(app, [{ ...priced, fee: 99n }]))).error).toMatch(/operation 0 states a fee of 99, the schedule requires 100/);
    expect(await app.checkTx(rawTx(app, [{ ...priced, fee: 100n }]))).toEqual({ ok: true });
    // Paying more is allowed and the stated amount is what moves (BitShares charges op.fee in full).
    const r = await block(app, [rawTx(app, [{ ...priced, fee: 100n }]), rawTx(app, [{ ...priced, fee: 1000n }, { ...priced, fee: 250n }])]);
    expect(r.txResults.map((t) => t.ok)).toEqual([true, true]);
    expect(app.balance(FAUCET_ID)).toBe(start - 3n * T(1) - 100n - 1000n - 250n);
    expect(app.dynamic().communityPool).toBe(pool + 100n + 1000n + 250n);
    // A transaction that fails pays nothing, fee or not.
    const bad = rawTx(app, [{ ...priced, fee: 1000n, to: FAUCET_ID }]);
    const r2 = await block(app, [bad]);
    expect(r2.txResults[0]!.ok).toBe(false);
    expect(app.balance(FAUCET_ID)).toBe(start - 3n * T(1) - 100n - 1000n - 250n);
    // Zero is a valid price: a free chain charges nothing and moves nothing to the pool.
    const free = makeApp(genesisWith({ scale: 0 }));
    await block(free);
    const before = free.balance(FAUCET_ID);
    const r3 = await block(free, [tx(free, [transfer(T(1))])]);
    expect(r3.txResults[0]!.ok).toBe(true);
    expect(free.balance(FAUCET_ID)).toBe(before - T(1));
    expect(decodeTransaction(tx(free, [transfer(T(1))])).operations[0]!.fee).toBe(0n);
  });

  it('changes the schedule by validator proposal, and a transaction priced under the old schedule fails rather than paying more', async () => {
    const app = makeApp();
    await block(app);
    const current = app.chainParameters();
    const proposed: ChainParameters = { ...current, fees: { ...current.fees, scale: 20_000, transfer: { fee: 250n } } };
    const signedBefore = tx(app, [transfer(T(1))]); // states 100, the price in force now
    // op-a proposes: 200 of 300 bonded is two thirds exactly, not more. op-b's signal adopts it.
    const r = await block(app, [tx(app, [{ type: 'proposalCreate', operator: OP_ID(0), validator: VAL_ID(0), parameters: proposed }], [ops[0]!])]);
    expect(r.txResults[0]!.ok).toBe(true);
    expect(app.feeSchedule().transfer.fee).toBe(100n);
    const prop = app.db.range(ProposalType, 'byExpiration', new Uint8Array(0))[0]!;
    expect(prop.parameters.fees.scale).toBe(20_000);
    const r2 = await block(app, [tx(app, [{ type: 'proposalSignal', operator: OP_ID(1), validator: VAL_ID(1), proposal: prop.id }], [ops[1]!])]);
    expect(r2.txResults[0]!.ok).toBe(true);
    expect(app.feeSchedule()).toEqual(proposed.fees);
    expect(app.stakingParameters()).toEqual(current.staking);
    expect(app.db.range(ProposalType, 'byExpiration', new Uint8Array(0)).length).toBe(0);
    // A transfer now costs 250 * 2 = 500. What was signed under the old price is refused, not surcharged.
    expect((await app.checkTx(signedBefore)).error).toMatch(/states a fee of 100, the schedule requires 500/);
    const balance = app.balance(FAUCET_ID);
    const r3 = await block(app, [signedBefore, tx(app, [transfer(T(1))])]);
    expect(r3.txResults.map((t) => t.ok)).toEqual([false, true]);
    expect(app.balance(FAUCET_ID)).toBe(balance - T(1) - 500n);
    // A proposal with an unusable schedule is refused up front.
    const tooBig: ChainParameters = { ...current, fees: { ...current.fees, scale: 2_000_000 } };
    expect((await app.checkTx(tx(app, [{ type: 'proposalCreate', operator: OP_ID(0), validator: VAL_ID(0), parameters: tooBig }], [ops[0]!]))).error).toMatch(/fee scale must be 0 to 1000000/);
  });

  it('takes a partial schedule in genesis over the defaults and refuses a bad one', () => {
    const g = parseAppGenesis(appGenesisBytes({ fees: { scale: 20_000, transfer: { fee: '7' }, accountCreate: { premiumFee: 9 } } }));
    expect(g.fees.scale).toBe(20_000);
    expect(g.fees.transfer.fee).toBe(7n);
    expect(g.fees.accountCreate).toEqual({ basicFee: 1000n, premiumFee: 9n, pricePerKbyte: 100n });
    expect(g.fees.delegate).toEqual(DEFAULT_FEES.delegate);
    expect(checkFeeSchedule(DEFAULT_FEES)).toBeNull();
    expect(() => parseAppGenesis(appGenesisBytes({ fees: { scale: 2_000_000 } }))).toThrow(/fee scale/);
    expect(() => parseAppGenesis(appGenesisBytes({ fees: { transfer: { fee: '-1' } } }))).toThrow(/transfer\.fee/);
    expect(() => feeScheduleFromJson({ scale: 10_000, transfer: { fee: '1' } })).toThrow(/accountCreate\.basicFee missing/);
    // The genesis values survive into the application.
    const app = makeApp(genesisWith({ transfer: { fee: '7' } }));
    expect(app.feeSchedule().transfer.fee).toBe(7n);
    expect(decodeTransaction(tx(app, [transfer(T(1))])).operations[0]!.fee).toBe(7n);
  });
});
