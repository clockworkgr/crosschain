/**
 * Shared material: a thousand funded user accounts, a genesis with and
 * without validators, and pre-signed transfers between the users. Signing
 * is the slow part (ML-DSA-44), so each set is made once and kept.
 */
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson, DEFAULT_FEES } from '../src/app/core/genesis.ts';
import { TYPE } from '../src/app/core/types.ts';
import { sha256, toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed, type KeyPair } from '../src/crypto/keys.ts';
import { objectId } from '../src/db/id.ts';
import type { Genesis } from '../src/types/genesis.ts';

export const CHAIN_ID = 'bench';
export const USERS = 1000;
export const UNIT = 100_000n;
export const CORE = objectId(TYPE.asset, 0);
export const FAUCET_ID = objectId(TYPE.account, 0);
export const userId = (i: number) => objectId(TYPE.account, 1 + i);
export const operatorId = (i: number) => objectId(TYPE.account, 1 + USERS + i);

export const seed = (s: string) => sha256(new TextEncoder().encode(`bench/${s}`));
export const faucet = keyPairFromSeed(seed('faucet'));
export const users: KeyPair[] = Array.from({ length: USERS }, (_, i) => keyPairFromSeed(seed(`user/${i}`)));

const account = (name: string, k: KeyPair, balance: bigint) => ({ name, owner: authorityJson([k.publicKey]), active: authorityJson([k.publicKey]), balance: balance.toString() });

/** Faucet, the users, and optionally `validators` operators with genesis validators behind them. */
export function makeGenesis(validators: number, genesisTime: bigint): Genesis {
  const operators = Array.from({ length: validators }, (_, i) => keyPairFromSeed(seed(`op/${i}`)));
  return {
    chainId: CHAIN_ID,
    genesisTime,
    appState: appGenesisBytes({
      accounts: [account('faucet', faucet, 1_000_000n * UNIT), ...users.map((k, i) => account(`user${i}`, k, 10_000n * UNIT)), ...operators.map((k, i) => account(`op${i}`, k, 100_000n * UNIT))],
      staking: { minSelfBond: 1000, fixedRewardPerBlock: 0, inflationMinBps: 0, inflationMaxBps: 0 },
      communityPool: 1000,
      validators: operators.map((_, i) => ({ operator: `op${i}`, consensusKey: toHex(keyPairFromSeed(seed(`val/${i}`)).publicKey), selfBond: 2000 })),
    }),
  };
}

export const validatorSeed = (i: number) => seed(`val/${i}`);
export const nodeSeed = (i: number) => seed(`node/${i}`);

const cache = new Map<string, Uint8Array[]>();

/** `n` signed transfers, user i paying user i+1 a distinct amount, all expiring at `expiration`. */
export function signedTransfers(n: number, expiration: bigint): Uint8Array[] {
  const key = `${n}/${expiration}`;
  const have = cache.get(key);
  if (have) return have;
  const t0 = performance.now();
  const txs: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const from = i % USERS;
    const op = withFees([{ type: 'transfer', from: userId(from), to: userId((from + 1) % USERS), asset: CORE, amount: 1n + BigInt(i) }], DEFAULT_FEES);
    txs.push(signedTxBytes(CHAIN_ID, { expiration, operations: op }, [users[from]!]));
  }
  console.log(`(signed ${n} transfers in ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  cache.set(key, txs);
  return txs;
}
