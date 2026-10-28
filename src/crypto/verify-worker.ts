/**
 * Worker thread body for the verification pool. Receives batches of
 * signature checks and answers with an array of booleans.
 */
import { parentPort } from 'node:worker_threads';
import { verify } from './keys.ts';
import type { VerifyJob } from './verifier.ts';

interface Request {
  id: number;
  jobs: VerifyJob[];
}

parentPort!.on('message', (req: Request) => {
  const results = req.jobs.map((j) => verify(j.sig, j.msg, j.publicKey, j.context));
  parentPort!.postMessage({ id: req.id, results });
});
