/**
 * The large state the genesis and scale suites share: an application genesis
 * of BENCH_GENESIS_MB megabytes (default 1000) written as ordinary JSON with
 * one account per line, and a CoreApp built from it on LMDB in a temporary
 * directory. Accounts take two keys each from a pool of POOL key pairs, so
 * signing on behalf of account i uses `keys[(2 * i + 1) % POOL]`.
 */
import { DEFAULT_SCHEME, schemeName } from '../src/crypto/keys.ts';
import { closeSync, openSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { CoreApp } from '../src/app/core/app.ts';
import { loadAppGenesis } from '../src/app/core/genesis.ts';
import { toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed, type KeyPair } from '../src/crypto/keys.ts';
import type { Verifier } from '../src/crypto/verifier.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
import { genesisToJson, loadGenesisFile, type Genesis } from '../src/types/genesis.ts';
import { fmtMs } from './harness.ts';
import { seed } from './fixtures.ts';

export const MB = Number(process.env.BENCH_GENESIS_MB ?? 1000);
export const POOL = 2000;
export const CHAIN_ID = 'bench-genesis';
export const genesisTime = 1_700_000_000_000n;
export const MiB = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MiB`;
export const accountName = (i: number) => `acct${i.toString().padStart(7, '0')}`;

export function poolKeys(): KeyPair[] {
  return Array.from({ length: POOL }, (_, i) => keyPairFromSeed(seed(`pool/${i}`)));
}

export function dirSize(dir: string): number {
  let total = 0;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    total += f.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

/** Heap, key buffers and RSS after the event loop turns and two collections run (array buffers are swept after a collection). */
export async function memory(): Promise<string> {
  const gc = (globalThis as { gc?: () => void }).gc;
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setTimeout(r, 100));
    gc?.();
  }
  const m = process.memoryUsage();
  return `heap ${MiB(m.heapUsed)}, array buffers (keys, hashes) ${MiB(m.arrayBuffers)}, rss ${MiB(m.rss)}, peak rss ${MiB(process.resourceUsage().maxRSS * 1024)}`;
}

/** Writes the application genesis until it reaches the target size; returns the account count. */
export function writeAppGenesis(file: string, hexKeys: string[], targetBytes: number): number {
  const fd = openSync(file, 'w');
  const header = { coreAsset: { symbol: 'CORE', precision: 5 }, staking: { minSelfBond: 1000, fixedRewardPerBlock: 0, inflationMinBps: 0, inflationMaxBps: 0 }, communityPool: 1000 };
  let text = `${JSON.stringify(header).slice(0, -1)},\n"accounts": [\n`;
  let written = 0;
  let accounts = 0;
  const flush = () => {
    written += Buffer.byteLength(text);
    writeSync(fd, text);
    text = '';
  };
  const authority = (i: number) => `{"threshold":1,"keys":[{"publicKey":"${hexKeys[i % POOL]}","weight":1}]}`;
  while (written + text.length < targetBytes) {
    text += `${accounts > 0 ? ',\n' : ''}{"name":"${accountName(accounts)}","owner":${authority(2 * accounts)},"active":${authority(2 * accounts + 1)},"balance":"1000000000"}`;
    accounts++;
    if (text.length > 4 * 1024 * 1024) flush();
  }
  text += '\n]}\n';
  flush();
  closeSync(fd);
  return accounts;
}

export interface BigState {
  dir: string;
  genesis: Genesis;
  app: CoreApp;
  env: LmdbEnv;
  keys: KeyPair[];
  accounts: number;
  fileBytes: number;
  summary: string;
}

/** Write, parse and build the state in `dir`; one line of timings in `summary`. */
export async function buildBigState(dir: string, verifier: Verifier, log?: (level: string, msg: string, fields?: Record<string, unknown>) => void): Promise<BigState> {
  const keys = poolKeys();
  const file = join(dir, 'app-genesis.json');
  const t0 = performance.now();
  const accounts = writeAppGenesis(file, keys.map((k) => toHex(k.publicKey)), MB * 1024 * 1024);
  const fileBytes = statSync(file).size;
  writeFileSync(join(dir, 'genesis.json'), genesisToJson({ chainId: CHAIN_ID, signatureScheme: schemeName(DEFAULT_SCHEME), genesisTime, appState: new Uint8Array(), appStateFile: 'app-genesis.json' }));
  const genesis = loadGenesisFile(join(dir, 'genesis.json'));
  const t1 = performance.now();
  const appGenesis = await loadAppGenesis(genesis);
  const t2 = performance.now();
  const env = new LmdbEnv(join(dir, 'lmdb'));
  const app = new CoreApp({ genesis, appGenesis, verifier, kv: env.store('app'), snapshotInterval: 0, log: log as never });
  const t3 = performance.now();
  return { dir, genesis, app, env, keys, accounts, fileBytes, summary: `${accounts.toLocaleString('en-US')} accounts: written in ${fmtMs(t1 - t0)}, parsed in ${fmtMs(t2 - t1)}, built in ${fmtMs(t3 - t2)}` };
}
