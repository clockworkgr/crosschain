/**
 * The transaction format. A transaction is a list of operations with an
 * expiration time and a list of signatures, as in BitShares. The signed
 * message is the body (expiration and operations) and its hash is the
 * transaction id. The id is remembered until the expiration passes, which is
 * the replay protection; there are no account nonces, so unrelated
 * transactions from one account never have to wait for each other.
 *
 * Every operation states the fee it pays, in base units of the core asset,
 * and the chain refuses it if the schedule (FEES.md) asks for more. A signer
 * therefore never pays more than it signed for, whatever the validators do
 * to the schedule in between. `calculateFee` is the schedule applied to one
 * operation; wallets use it to fill the field in.
 *
 * Accounts and assets are referenced by object id. A transfer is therefore
 * about 50 bytes plus one 2420-byte signature; the 1312-byte public key is
 * looked up in the sender's account.
 */
import { decode, type Reader } from '../../codec/reader.ts';
import { encode, type Writer } from '../../codec/writer.ts';
import { HASH_SIZE, sha256 } from '../../crypto/hash.ts';
import { SIGNATURE_SIZE } from '../../crypto/keys.ts';
import { PUBLIC_KEY_SIZE } from '../../crypto/keys.ts';
import { decodeAuthority, encodeAuthority, type Authority } from './authority.ts';
import { isCheapName, MAX_ACCOUNT_NAME, MAX_ASSET_SYMBOL } from './names.ts';
import { decodeChainParameters, encodeChainParameters, FEE_SCALE_ONE, MAX_SHARE_SUPPLY, type ChainParameters, type FeeSchedule } from './types.ts';

export type Operation =
  | { type: 'transfer'; fee: bigint; from: bigint; to: bigint; asset: bigint; amount: bigint }
  | { type: 'accountCreate'; fee: bigint; registrar: bigint; name: string; owner: Authority; active: Authority }
  | { type: 'accountUpdate'; fee: bigint; account: bigint; owner: Authority | null; active: Authority | null }
  | { type: 'assetCreate'; fee: bigint; issuer: bigint; symbol: string; precision: number; maxSupply: bigint }
  | { type: 'assetIssue'; fee: bigint; issuer: bigint; asset: bigint; to: bigint; amount: bigint }
  | { type: 'validatorCreate'; fee: bigint; operator: bigint; consensusKey: Uint8Array; selfBond: bigint }
  | { type: 'validatorUpdate'; fee: bigint; operator: bigint; validator: bigint; consensusKey: Uint8Array }
  | { type: 'delegate'; fee: bigint; delegator: bigint; validator: bigint; amount: bigint }
  | { type: 'undelegate'; fee: bigint; delegator: bigint; validator: bigint; shares: bigint }
  | { type: 'redelegate'; fee: bigint; delegator: bigint; source: bigint; destination: bigint; shares: bigint }
  | { type: 'unjail'; fee: bigint; operator: bigint; validator: bigint }
  | { type: 'proposalCreate'; fee: bigint; operator: bigint; validator: bigint; parameters: ChainParameters }
  | { type: 'proposalSignal'; fee: bigint; operator: bigint; validator: bigint; proposal: bigint };

export type OperationType = Operation['type'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An operation before its fee is filled in; what a wallet builds. */
export type OperationDraft = DistributiveOmit<Operation, 'fee'>;

export interface TxSignature {
  /** sha256 of the signing public key. */
  address: Uint8Array;
  signature: Uint8Array;
}

export interface UnsignedTransaction {
  /** Unix milliseconds. Must be after the current block time and within the chain's maximum window. */
  expiration: bigint;
  operations: Operation[];
}

export interface Transaction extends UnsignedTransaction {
  signatures: TxSignature[];
}

export const MAX_OPERATIONS = 64;
export const MAX_SIGNATURES = 16;

const OP_TAG: Record<OperationType, number> = {
  transfer: 0,
  accountCreate: 1,
  accountUpdate: 2,
  assetCreate: 3,
  assetIssue: 4,
  validatorCreate: 5,
  validatorUpdate: 6,
  delegate: 7,
  undelegate: 8,
  redelegate: 9,
  unjail: 10,
  proposalCreate: 11,
  proposalSignal: 12,
};

/** The fields after the tag and the fee. */
export function encodeOperationBody(w: Writer, op: OperationDraft): void {
  switch (op.type) {
    case 'transfer':
      w.u64(op.from).u64(op.to).u64(op.asset).u64(op.amount);
      break;
    case 'accountCreate':
      w.u64(op.registrar).string(op.name);
      encodeAuthority(w, op.owner);
      encodeAuthority(w, op.active);
      break;
    case 'accountUpdate':
      w.u64(op.account).option(op.owner, encodeAuthority).option(op.active, encodeAuthority);
      break;
    case 'assetCreate':
      w.u64(op.issuer).string(op.symbol).u8(op.precision).u64(op.maxSupply);
      break;
    case 'assetIssue':
      w.u64(op.issuer).u64(op.asset).u64(op.to).u64(op.amount);
      break;
    case 'validatorCreate':
      w.u64(op.operator).fixed(op.consensusKey).u64(op.selfBond);
      break;
    case 'validatorUpdate':
      w.u64(op.operator).u64(op.validator).fixed(op.consensusKey);
      break;
    case 'delegate':
      w.u64(op.delegator).u64(op.validator).u64(op.amount);
      break;
    case 'undelegate':
      w.u64(op.delegator).u64(op.validator).u64(op.shares);
      break;
    case 'redelegate':
      w.u64(op.delegator).u64(op.source).u64(op.destination).u64(op.shares);
      break;
    case 'unjail':
      w.u64(op.operator).u64(op.validator);
      break;
    case 'proposalCreate':
      w.u64(op.operator).u64(op.validator);
      encodeChainParameters(w, op.parameters);
      break;
    case 'proposalSignal':
      w.u64(op.operator).u64(op.validator).u64(op.proposal);
      break;
  }
}

export function encodeOperation(w: Writer, op: Operation): void {
  w.u8(OP_TAG[op.type]).u64(op.fee);
  encodeOperationBody(w, op);
}

export function decodeOperation(r: Reader): Operation {
  const tag = r.u8();
  const fee = r.u64();
  switch (tag) {
    case 0:
      return { type: 'transfer', fee, from: r.u64(), to: r.u64(), asset: r.u64(), amount: r.u64() };
    case 1:
      return { type: 'accountCreate', fee, registrar: r.u64(), name: r.string(MAX_ACCOUNT_NAME), owner: decodeAuthority(r), active: decodeAuthority(r) };
    case 2:
      return { type: 'accountUpdate', fee, account: r.u64(), owner: r.option(decodeAuthority), active: r.option(decodeAuthority) };
    case 3:
      return { type: 'assetCreate', fee, issuer: r.u64(), symbol: r.string(MAX_ASSET_SYMBOL), precision: r.u8(), maxSupply: r.u64() };
    case 4:
      return { type: 'assetIssue', fee, issuer: r.u64(), asset: r.u64(), to: r.u64(), amount: r.u64() };
    case 5:
      return { type: 'validatorCreate', fee, operator: r.u64(), consensusKey: r.fixed(PUBLIC_KEY_SIZE), selfBond: r.u64() };
    case 6:
      return { type: 'validatorUpdate', fee, operator: r.u64(), validator: r.u64(), consensusKey: r.fixed(PUBLIC_KEY_SIZE) };
    case 7:
      return { type: 'delegate', fee, delegator: r.u64(), validator: r.u64(), amount: r.u64() };
    case 8:
      return { type: 'undelegate', fee, delegator: r.u64(), validator: r.u64(), shares: r.u64() };
    case 9:
      return { type: 'redelegate', fee, delegator: r.u64(), source: r.u64(), destination: r.u64(), shares: r.u64() };
    case 10:
      return { type: 'unjail', fee, operator: r.u64(), validator: r.u64() };
    case 11:
      return { type: 'proposalCreate', fee, operator: r.u64(), validator: r.u64(), parameters: decodeChainParameters(r) };
    case 12:
      return { type: 'proposalSignal', fee, operator: r.u64(), validator: r.u64(), proposal: r.u64() };
    default:
      throw new Error(`unknown operation tag ${tag}`);
  }
}

/** BitShares' calculate_data_fee: a price per kilobyte applied to the operation body, rounded down. */
function dataFee(op: OperationDraft, pricePerKbyte: bigint): bigint {
  return (BigInt(encode((w) => encodeOperationBody(w, op)).length) * pricePerKbyte) / 1024n;
}

/** The fee the schedule requires for one operation (FEES.md section 2). */
export function calculateFee(op: OperationDraft, fees: FeeSchedule): bigint {
  let base: bigint;
  switch (op.type) {
    case 'accountCreate':
      base = (isCheapName(op.name) ? fees.accountCreate.basicFee : fees.accountCreate.premiumFee) + dataFee(op, fees.accountCreate.pricePerKbyte);
      break;
    case 'accountUpdate':
      base = fees.accountUpdate.fee + dataFee(op, fees.accountUpdate.pricePerKbyte);
      break;
    case 'assetCreate':
      base = op.symbol.length === 3 ? fees.assetCreate.symbol3 : op.symbol.length === 4 ? fees.assetCreate.symbol4 : fees.assetCreate.longSymbol;
      break;
    default:
      base = fees[op.type].fee;
  }
  const scaled = (base * BigInt(fees.scale)) / BigInt(FEE_SCALE_ONE);
  return scaled > MAX_SHARE_SUPPLY ? MAX_SHARE_SUPPLY : scaled;
}

export function encodeTxBody(w: Writer, tx: UnsignedTransaction): void {
  w.u64(tx.expiration).array(tx.operations, encodeOperation);
}

/** The bytes that are signed. */
export function txBodyBytes(tx: UnsignedTransaction): Uint8Array {
  return encode((w) => encodeTxBody(w, tx));
}

export function txIdOf(tx: UnsignedTransaction): Uint8Array {
  return sha256(txBodyBytes(tx));
}

export function encodeTransaction(tx: Transaction): Uint8Array {
  return encode((w) => {
    encodeTxBody(w, tx);
    w.array(tx.signatures, (w, s) => w.fixed(s.address).fixed(s.signature));
  });
}

export function decodeTransaction(bytes: Uint8Array): Transaction {
  return decode(bytes, (r) => ({
    expiration: r.u64(),
    operations: r.array(decodeOperation, MAX_OPERATIONS),
    signatures: r.array((r) => ({ address: r.fixed(HASH_SIZE), signature: r.fixed(SIGNATURE_SIZE) }), MAX_SIGNATURES),
  }));
}
