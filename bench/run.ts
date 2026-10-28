/**
 * Runs the benchmarks and prints a summary table.
 *
 *   npm run bench                 # everything, about three minutes
 *   npm run bench -- db app       # only these suites
 *
 * Suites: crypto, codec, db, store, app, network, and genesis (npm run
 * bench:genesis; a large genesis file, minutes). Numbers are for one
 * process on one machine; the network suite runs four validators in that
 * process, so it measures the engine and the application, not the wire.
 */
import { machine, summaryMarkdown } from './harness.ts';

const suites: Record<string, () => Promise<void>> = {
  crypto: async () => (await import('./crypto.bench.ts')).run(),
  codec: async () => (await import('./codec.bench.ts')).run(),
  db: async () => (await import('./db.bench.ts')).run(),
  store: async () => (await import('./store.bench.ts')).run(),
  app: async () => (await import('./app.bench.ts')).run(),
  network: async () => (await import('./network.bench.ts')).run(),
  genesis: async () => (await import('./genesis.bench.ts')).run(),
  scale: async () => (await import('./scale.bench.ts')).run(),
};

/** The genesis and scale suites each build a gigabyte of state and take minutes, so they run only when asked. */
const DEFAULT_SUITES = ['crypto', 'codec', 'db', 'store', 'app', 'network'];

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = wanted.length > 0 ? wanted : DEFAULT_SUITES;
for (const n of names) if (!suites[n]) throw new Error(`unknown suite ${n}; have ${Object.keys(suites).join(', ')}`);

console.log(`crosschain benchmarks on ${machine()}`);
console.log(new Date().toISOString());
const t0 = performance.now();
for (const n of names) await suites[n]!();
console.log(`\n## summary (${((performance.now() - t0) / 1000).toFixed(0)} s)\n`);
console.log(summaryMarkdown());
process.exit(0);
