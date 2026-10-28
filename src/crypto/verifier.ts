/**
 * Signature verification is the one CPU-heavy operation in the node, and it
 * sits on the hot path of consensus. On the main thread a block of a thousand
 * transactions would stall the event loop, and with it every consensus timer,
 * for about a second. So verification is the only thing that leaves the main
 * thread. Signing stays on the main thread: it happens once per consensus
 * step and keeping it inline makes the persist-then-broadcast ordering of the
 * double-sign guard trivial.
 */
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import { verify } from './keys.ts';

export interface VerifyJob {
  sig: Uint8Array;
  msg: Uint8Array;
  publicKey: Uint8Array;
  context: Uint8Array;
}

export interface Verifier {
  verify(jobs: VerifyJob[]): Promise<boolean[]>;
  verifyOne(job: VerifyJob): Promise<boolean>;
  close(): Promise<void>;
}

/** Verifies on the calling thread. Used in tests and small simulations. */
export class InlineVerifier implements Verifier {
  async verify(jobs: VerifyJob[]): Promise<boolean[]> {
    return jobs.map((j) => verify(j.sig, j.msg, j.publicKey, j.context));
  }
  async verifyOne(job: VerifyJob): Promise<boolean> {
    return verify(job.sig, job.msg, job.publicKey, job.context);
  }
  async close(): Promise<void> {}
}

interface Pending {
  resolve: (r: boolean[]) => void;
  reject: (e: Error) => void;
}

/** Spreads each batch across a fixed pool of worker threads. */
export class WorkerVerifier implements Verifier {
  private readonly workers: Worker[] = [];
  /** Jobs in flight per worker; a worker holds the event loop open only while it has some. */
  private readonly inflight: number[] = [];
  private readonly pending = new Map<number, Pending & { worker: number }>();
  private nextId = 1;
  private nextWorker = 0;
  private closed = false;

  constructor(size = Math.max(1, cpus().length - 1)) {
    for (let i = 0; i < size; i++) {
      this.workers.push(this.spawn(i));
      this.inflight.push(0);
    }
  }

  private spawn(index: number): Worker {
    const w = new Worker(new URL('./verify-worker.ts', import.meta.url));
    w.on('message', (m: { id: number; results: boolean[] }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      this.settle(p.worker);
      p.resolve(m.results);
    });
    // A worker that dies fails only the jobs it held, and is replaced so the pool keeps its size.
    const failed = (e: Error) => {
      if (this.workers[index] !== w) return;
      for (const [id, p] of this.pending) {
        if (p.worker !== index) continue;
        this.pending.delete(id);
        p.reject(e);
      }
      this.inflight[index] = 0;
      if (!this.closed) this.workers[index] = this.spawn(index);
    };
    w.on('error', failed);
    w.on('exit', (code) => {
      if (!this.closed) failed(new Error(`verification worker exited with code ${code}`));
    });
    // Workers must not keep the process alive on their own, only while a caller waits on them.
    w.unref();
    return w;
  }

  private settle(worker: number): void {
    if (--this.inflight[worker]! === 0) this.workers[worker]!.unref();
  }

  private submit(jobs: VerifyJob[]): Promise<boolean[]> {
    if (this.closed) return Promise.reject(new Error('verifier closed'));
    const id = this.nextId++;
    const worker = this.nextWorker;
    const w = this.workers[worker]!;
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    return new Promise((resolve, reject) => {
      if (this.inflight[worker]!++ === 0) w.ref();
      this.pending.set(id, { resolve, reject, worker });
      w.postMessage({ id, jobs });
    });
  }

  async verify(jobs: VerifyJob[]): Promise<boolean[]> {
    if (jobs.length === 0) return [];
    // Chunk large batches so every worker gets a share.
    const chunk = Math.max(1, Math.ceil(jobs.length / this.workers.length));
    const parts: Promise<boolean[]>[] = [];
    for (let i = 0; i < jobs.length; i += chunk) parts.push(this.submit(jobs.slice(i, i + chunk)));
    return (await Promise.all(parts)).flat();
  }

  async verifyOne(job: VerifyJob): Promise<boolean> {
    return (await this.submit([job]))[0]!;
  }

  async close(): Promise<void> {
    this.closed = true;
    const e = new Error('verifier closed');
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
