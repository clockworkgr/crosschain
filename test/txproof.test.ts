import { describe, expect, it } from 'vitest';
import { EMPTY } from '../src/db/merkle.ts';
import { toHex } from '../src/crypto/hash.ts';
import { resultProofFor, resultProofFromBytes, resultProofToBytes, resultsRoot, txProofFor, txProofFromBytes, txProofToBytes, txsRoot, verifyResultProof, verifyTxProof } from '../src/types/txproof.ts';

describe('transaction proofs', () => {
  const txs = Array.from({ length: 7 }, (_, i) => new Uint8Array([i, i + 1, i + 2]));
  const results = txs.map((_, i) => ({ ok: i % 3 !== 2, error: i % 3 === 2 ? `failed ${i}` : undefined }));

  it('proves inclusion against the data hash and rejects tampering', () => {
    expect(toHex(txsRoot([]))).toBe(toHex(EMPTY));
    const root = txsRoot(txs);
    for (let i = 0; i < txs.length; i++) {
      const p = txProofFor(7n, txs, i);
      expect(verifyTxProof(root, p)).toBe(true);
      expect(verifyTxProof(root, txProofFromBytes(txProofToBytes(p)))).toBe(true);
      expect(verifyTxProof(root, { ...p, tx: new Uint8Array([9]) })).toBe(false);
      expect(verifyTxProof(root, { ...p, index: (i + 1) % txs.length })).toBe(false);
      expect(verifyTxProof(root, { ...p, count: 16 })).toBe(false); // a different tree height
      expect(verifyTxProof(txsRoot(txs.slice(0, 6)), p)).toBe(false);
    }
    expect(toHex(txsRoot(txs))).not.toBe(toHex(txsRoot([...txs].reverse())));
  });

  it('proves results, including failures, against the results hash', () => {
    const root = resultsRoot(results);
    expect(toHex(resultsRoot([]))).toBe(toHex(EMPTY));
    for (let i = 0; i < results.length; i++) {
      const p = resultProofFor(7n, results, i);
      expect(p.ok).toBe(results[i]!.ok);
      expect(verifyResultProof(root, p)).toBe(true);
      expect(verifyResultProof(root, resultProofFromBytes(resultProofToBytes(p)))).toBe(true);
      expect(verifyResultProof(root, { ...p, ok: !p.ok })).toBe(false);
      expect(verifyResultProof(root, { ...p, error: p.error + 'x' })).toBe(false);
    }
  });
});
