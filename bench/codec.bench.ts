/** Encoding, decoding and hashing of transactions. */
import { DEFAULT_SCHEME, schemeName } from '../src/crypto/keys.ts';
import { DEFAULT_LIMITS } from '../src/consensus/consensus.ts';
import { decodeTransaction, encodeTransaction } from '../src/app/core/tx.ts';
import { txHash } from '../src/types/block.ts';
import { txsRoot } from '../src/types/txproof.ts';
import { bench, fact, fmtBytes, suite } from './harness.ts';
import { signedTransfers } from './fixtures.ts';

export async function run(): Promise<void> {
  suite('codec');
  const txs = signedTransfers(500, 1_700_000_060_000n);
  const bytes = txs[0]!;
  const tx = decodeTransaction(bytes);
  fact('signed transfer', `${fmtBytes(bytes.length)} (one ${schemeName(DEFAULT_SCHEME)} signature)`);
  fact('transfers per block at the default limit, less the 1 KiB the builder leaves', `${Math.floor((DEFAULT_LIMITS.maxBlockBytes - 1024) / (bytes.length + 4))} (${fmtBytes(DEFAULT_LIMITS.maxBlockBytes)} of transactions and evidence; the header and the commit are not counted)`);
  await bench('encodeTransaction', { batch: 100 }, () => {
    for (let i = 0; i < 100; i++) encodeTransaction(tx);
  });
  await bench('decodeTransaction', { batch: 100 }, () => {
    for (let i = 0; i < 100; i++) decodeTransaction(bytes);
  });
  await bench('txHash', { batch: 100 }, () => {
    for (let i = 0; i < 100; i++) txHash(bytes);
  });
  await bench('txsRoot over 500 transactions', {}, () => txsRoot(txs));
}
