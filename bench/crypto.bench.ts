/** The two signature schemes and sha256: the floor under everything else. */
import { cpus } from 'node:os';
import { sha256 } from '../src/crypto/hash.ts';
import { keyPairFromSeed, Scheme, schemeName, sign, signContext, verify, type SchemeTag } from '../src/crypto/keys.ts';
import { WorkerVerifier } from '../src/crypto/verifier.ts';
import { bench, fact, randomBytes, suite } from './harness.ts';
import { seed } from './fixtures.ts';

export async function run(): Promise<void> {
  suite('crypto');
  const ctx = signContext('bench', 'tx');
  const msg = randomBytes(256);
  const threads = Math.max(1, cpus().length - 1);
  const pool = new WorkerVerifier();
  for (const scheme of [Scheme.mlDsa44, Scheme.secp256k1] as SchemeTag[]) {
    const name = schemeName(scheme);
    const kp = keyPairFromSeed(seed('crypto'), scheme);
    const sig = sign(msg, kp.secretKey, ctx);
    fact(`${name}: public key / signature / secret key (tag included)`, `${kp.publicKey.length} / ${sig.length} / ${kp.secretKey.length} bytes`);
    await bench(`${name}: keyPairFromSeed`, {}, () => keyPairFromSeed(seed('crypto'), scheme));
    await bench(`${name}: sign (256 B message)`, {}, () => sign(msg, kp.secretKey, ctx));
    await bench(`${name}: verify, inline`, {}, () => verify(sig, msg, kp.publicKey, ctx));
    const jobs = Array.from({ length: 256 }, () => ({ sig, msg, publicKey: kp.publicKey, context: ctx }));
    await bench(`${name}: WorkerVerifier.verify, 256 signatures on ${threads} threads`, { batch: 256, maxMs: 4000 }, () => pool.verify(jobs));
    await bench(`${name}: WorkerVerifier.verifyOne (round trip)`, {}, () => pool.verifyOne(jobs[0]!));
  }
  const big = randomBytes(2500);
  await bench('sha256 (2.5 KB)', { batch: 200 }, () => {
    for (let i = 0; i < 200; i++) sha256(big);
  });
  await pool.close();
}
