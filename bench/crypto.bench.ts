/** ML-DSA-44 and sha256: the floor under everything else. */
import { cpus } from 'node:os';
import { sha256 } from '../src/crypto/hash.ts';
import { keyPairFromSeed, sign, signContext, verify } from '../src/crypto/keys.ts';
import { WorkerVerifier } from '../src/crypto/verifier.ts';
import { bench, fact, randomBytes, suite } from './harness.ts';
import { seed } from './fixtures.ts';

export async function run(): Promise<void> {
  suite('crypto');
  const kp = keyPairFromSeed(seed('crypto'));
  const ctx = signContext('bench', 'tx');
  const msg = randomBytes(256);
  const sig = sign(msg, kp.secretKey, ctx);
  fact('public key / signature / secret key', `${kp.publicKey.length} / ${sig.length} / ${kp.secretKey.length} bytes`);
  await bench('keyPairFromSeed', {}, () => keyPairFromSeed(seed('crypto')));
  await bench('sign (256 B message)', {}, () => sign(msg, kp.secretKey, ctx));
  await bench('verify, inline', {}, () => verify(sig, msg, kp.publicKey, ctx));
  const big = randomBytes(2500);
  await bench('sha256 (2.5 KB)', { batch: 200 }, () => {
    for (let i = 0; i < 200; i++) sha256(big);
  });
  const threads = Math.max(1, cpus().length - 1);
  const pool = new WorkerVerifier();
  const jobs = Array.from({ length: 256 }, () => ({ sig, msg, publicKey: kp.publicKey, context: ctx }));
  await bench(`WorkerVerifier.verify, 256 signatures on ${threads} threads`, { batch: 256, maxMs: 4000 }, () => pool.verify(jobs));
  await bench('WorkerVerifier.verifyOne (round trip)', {}, () => pool.verifyOne(jobs[0]!));
  await pool.close();
}
