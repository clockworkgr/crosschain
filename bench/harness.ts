/**
 * A small benchmark harness: time a function until a time budget or an
 * iteration count runs out, report ops/sec and the mean, median and p99 of
 * an iteration, and keep every result for a summary table at the end.
 * Nothing clever: `performance.now()` around the call, warmup iterations
 * dropped, and an optional untimed `before` hook for per-iteration setup.
 */
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';

export interface BenchResult {
  suite: string;
  name: string;
  /** Work units per iteration; ops/sec is batch * iterations / time. */
  batch: number;
  iterations: number;
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  opsPerSec: number;
  note?: string;
}

export interface BenchOptions {
  batch?: number;
  /** Untimed iterations before measuring. Default 1. */
  warmup?: number;
  /** Stop after this many measured iterations... */
  iterations?: number;
  /** ...or after this much time, whichever comes first. Default 2000 ms. */
  maxMs?: number;
  /** Always run at least this many measured iterations. Default 3. */
  minIterations?: number;
  /** Untimed setup before every iteration, including warmup. */
  before?: () => unknown | Promise<unknown>;
  note?: string;
}

export interface Fact {
  suite: string;
  name: string;
  value: string;
}

const results: BenchResult[] = [];
const facts: Fact[] = [];
let currentSuite = '';

export function suite(name: string): void {
  currentSuite = name;
  console.log(`\n## ${name}\n`);
}

export function fmtOps(n: number): string {
  if (n >= 1000) return Math.round(n).toLocaleString('en-US');
  if (n >= 100) return n.toFixed(0);
  return n.toFixed(1);
}

export function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 100) return `${ms.toFixed(0)} ms`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  if (ms >= 1) return `${ms.toFixed(2)} ms`;
  return `${(ms * 1000).toFixed(0)} µs`;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function print(r: BenchResult): void {
  const per = r.batch > 1 ? `  (${fmtMs(r.meanMs)} per ${r.batch})` : '';
  console.log(`${r.name.padEnd(58)} ${fmtOps(r.opsPerSec).padStart(12)} ops/s   mean ${fmtMs(r.meanMs).padStart(9)}  p50 ${fmtMs(r.p50Ms).padStart(9)}  p99 ${fmtMs(r.p99Ms).padStart(9)}${per}${r.note ? `   ${r.note}` : ''}`);
}

export async function bench(name: string, opts: BenchOptions, fn: () => unknown | Promise<unknown>): Promise<BenchResult> {
  const batch = opts.batch ?? 1;
  const warmup = opts.warmup ?? 1;
  const maxMs = opts.maxMs ?? 2000;
  const maxIter = opts.iterations ?? Infinity;
  const minIter = Math.min(opts.minIterations ?? 3, maxIter);
  for (let i = 0; i < warmup; i++) {
    await opts.before?.();
    await fn();
  }
  const samples: number[] = [];
  const start = performance.now();
  while (samples.length < maxIter && (samples.length < minIter || performance.now() - start < maxMs)) {
    await opts.before?.();
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const total = samples.reduce((a, b) => a + b, 0);
  const r: BenchResult = {
    suite: currentSuite,
    name,
    batch,
    iterations: samples.length,
    meanMs: total / samples.length,
    p50Ms: pct(samples, 0.5),
    p99Ms: pct(samples, 0.99),
    opsPerSec: (batch * samples.length) / (total / 1000),
    note: opts.note,
  };
  results.push(r);
  print(r);
  return r;
}

/** A measured number that is not a rate: a size, a count, a heap figure. */
export function fact(name: string, value: string): void {
  facts.push({ suite: currentSuite, name, value });
  console.log(`${name.padEnd(58)} ${value}`);
}

/** Heap in use after a collection, in MiB (run node with --expose-gc for a stable figure). */
export function heapMiB(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

export function machine(): string {
  const cpu = cpus()[0]?.model ?? 'unknown cpu';
  return `${cpu}, ${cpus().length} cores, ${Math.round(totalmem() / 1024 / 1024 / 1024)} GB, node ${process.version}, ${platform()} ${release()}`;
}

/** Every result as one markdown table, for pasting into the README. */
export function summaryMarkdown(): string {
  const lines = ['| suite | benchmark | ops/s | mean | p50 | p99 |', '|---|---|---:|---:|---:|---:|'];
  for (const r of results) lines.push(`| ${r.suite} | ${r.name}${r.note ? ` (${r.note})` : ''} | ${fmtOps(r.opsPerSec)} | ${fmtMs(r.meanMs)} | ${fmtMs(r.p50Ms)} | ${fmtMs(r.p99Ms)} |`);
  if (facts.length > 0) {
    lines.push('', '| suite | measurement | value |', '|---|---|---:|');
    for (const f of facts) lines.push(`| ${f.suite} | ${f.name} | ${f.value} |`);
  }
  return lines.join('\n');
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
