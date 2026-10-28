/**
 * What a light client checks when a node answers a state query: that the
 * header is the one after the proven height, that the commit on that header
 * is signed by more than two thirds of the validator set the client trusts
 * for it, and that the proof leads to the app hash in the header.
 *
 * Tracking the validator set from header to header (the Tendermint light
 * client's job) is not done here; the caller supplies the set it trusts for
 * the header's height.
 */
import { verifyCommit } from '../consensus/validate.ts';
import type { Verifier } from '../crypto/verifier.ts';
import { verifyKeyProof, verifyObjectProof, type KeyProof, type ObjectProof } from '../db/proof.ts';
import { verifyResultProof, verifyTxProof, type ResultProof, type TxProof } from '../types/txproof.ts';
import { bytesEqual } from '../crypto/hash.ts';
import { headerHash, type Commit, type Header } from '../types/block.ts';
import type { ValidatorSet } from '../types/validator.ts';

export interface StateQueryResult {
  proof: ObjectProof;
  /** Header of block proof.height + 1, whose appHash commits to the proven state. */
  header: Header;
  /** The commit for that header. */
  commit: Commit;
}

export interface KeyQueryResult {
  proof: KeyProof;
  header: Header;
  commit: Commit;
}

/** A transaction's inclusion in its block and, when the next block exists, its result. */
export interface TxQueryResult {
  txProof: TxProof;
  header: Header;
  commit: Commit;
  resultProof: ResultProof | null;
  nextHeader: Header | null;
  nextCommit: Commit | null;
}

export type TxVerdict = { ok: boolean; error: string } | null | { failed: true; error: string };

/**
 * Check a transaction query against validator sets the caller trusts for the
 * two headers. Returns the result proven, null if only inclusion could be
 * checked yet, or a failure.
 */
export async function verifyTxQuery(chainId: string, q: TxQueryResult, validators: ValidatorSet, nextValidators: ValidatorSet | null, verifier: Verifier): Promise<TxVerdict> {
  if (q.header.chainId !== chainId || q.header.height !== q.txProof.height) return { failed: true, error: 'header does not match the proof' };
  const commitError = await verifyCommit(chainId, validators, headerHash(q.header), q.commit, verifier);
  if (commitError) return { failed: true, error: `commit: ${commitError}` };
  if (!verifyTxProof(q.header.dataHash, q.txProof)) return { failed: true, error: 'transaction is not in the block' };
  if (!q.resultProof || !q.nextHeader || !q.nextCommit || !nextValidators) return null;
  if (q.nextHeader.height !== q.header.height + 1n || !bytesEqual(q.nextHeader.lastBlockHash, headerHash(q.header))) return { failed: true, error: 'next header does not follow' };
  const nextError = await verifyCommit(chainId, nextValidators, headerHash(q.nextHeader), q.nextCommit, verifier);
  if (nextError) return { failed: true, error: `next commit: ${nextError}` };
  if (q.resultProof.index !== q.txProof.index || !verifyResultProof(q.nextHeader.lastResultsHash, q.resultProof)) return { failed: true, error: 'result is not the one committed' };
  return { ok: q.resultProof.ok, error: q.resultProof.error };
}

/** The header must follow the proven height and carry a commit the trusted set signed. */
async function verifyHeaderAndCommit(chainId: string, provenHeight: bigint, header: Header, commit: Commit, validators: ValidatorSet, verifier: Verifier): Promise<string | null> {
  if (header.chainId !== chainId) return 'header is for another chain';
  if (header.height !== provenHeight + 1n) return 'header is not the one after the proven height';
  const commitError = await verifyCommit(chainId, validators, headerHash(header), commit, verifier);
  return commitError ? `commit: ${commitError}` : null;
}

/** Returns a problem, or null if the result is verified. */
export async function verifyStateQuery(chainId: string, q: StateQueryResult, validators: ValidatorSet, verifier: Verifier): Promise<string | null> {
  const err = await verifyHeaderAndCommit(chainId, q.proof.height, q.header, q.commit, validators, verifier);
  if (err) return err;
  if (!verifyObjectProof(q.header.appHash, q.proof)) return 'proof does not lead to the app hash';
  return null;
}

/** Returns the proven value (null when the key is proven absent), or an error string. */
export async function verifyKeyQuery(chainId: string, q: KeyQueryResult, validators: ValidatorSet, verifier: Verifier): Promise<{ value: Uint8Array | null } | { error: string }> {
  const err = await verifyHeaderAndCommit(chainId, q.proof.height, q.header, q.commit, validators, verifier);
  if (err) return { error: err };
  const value = verifyKeyProof(q.header.appHash, q.proof);
  if (value === undefined) return { error: 'proof does not lead to the app hash' };
  return { value };
}
