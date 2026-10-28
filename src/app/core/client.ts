/**
 * What a wallet does: build a transaction and sign it with one or more keys.
 * Used by the tests, the local network script and the CLI. Nothing here
 * touches state; the signer only needs the chain id, the object ids it
 * wants to reference, and the fee schedule to price its operations.
 */
import { signContext, sign, type KeyPair } from '../../crypto/keys.ts';
import { calculateFee, encodeTransaction, txBodyBytes, type Operation, type OperationDraft, type Transaction, type UnsignedTransaction } from './tx.ts';
import type { FeeSchedule } from './types.ts';

/** BitShares' set_fee: state exactly what the schedule requires for each operation. */
export function withFees(operations: OperationDraft[], fees: FeeSchedule): Operation[] {
  return operations.map((op) => ({ ...op, fee: calculateFee(op, fees) }) as Operation);
}

export function signTransaction(chainId: string, tx: UnsignedTransaction, keys: KeyPair[]): Transaction {
  const body = txBodyBytes(tx);
  const ctx = signContext(chainId, 'tx');
  return { ...tx, signatures: keys.map((k) => ({ address: k.address, signature: sign(body, k.secretKey, ctx) })) };
}

/** Build, sign and encode in one go. */
export function signedTxBytes(chainId: string, tx: UnsignedTransaction, keys: KeyPair[]): Uint8Array {
  return encodeTransaction(signTransaction(chainId, tx, keys));
}

export function expiresIn(fromMs: bigint, ms: number): bigint {
  return fromMs + BigInt(ms);
}
