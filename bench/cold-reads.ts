/**
 * What an index read costs when the store is not in memory: `node bench/cold-reads.ts <dir> <accounts> [reads]`
 * opens the application store the paging suite built in <dir> read-only, without a node (a node reads the whole
 * store when it opens, which would warm it), and reads it as a node with `indexTrees: 'store'` reads its indices:
 * an account by name (one index entry), the account's object by the id found, and a page of twenty index entries
 * in name order from a random name. Each read is timed on its own and reported in groups, first to last: the first
 * reads find nothing in the operating system's page cache, the later ones find the upper pages of the tree there.
 *
 * Run it after the store's volume has been remounted, so that none of the store is cached; the paging suite does
 * both between building the store and starting its node when BENCH_PAGING_BEFORE_NODE is that command.
 */
import { join } from 'node:path';
import { AccountType, TYPE } from '../src/app/core/types.ts';
import { decode } from '../src/codec/reader.ts';
import { typeOf } from '../src/db/id.ts';
import { entryKey, indexHeader } from '../src/db/indexstore.ts';
import { key } from '../src/db/keys.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
import { prefixEnd } from '../src/store/kv.ts';
import { accountName } from './bigstate.ts';

const [dir, accountsArg, readsArg] = process.argv.slice(2);
const N = Number(accountsArg);
const READS = Number(readsArg ?? 3000);
const GROUP = 500;
const env = new LmdbEnv(join(dir!, 'lmdb'), { readOnly: true });
const kv = env.store('app');
const byName = indexHeader(AccountType.id, AccountType.indices.findIndex((i) => i.name === 'byName'));
const nameKey = (i: number) => entryKey(byName, key((k) => k.str(accountName(i))));
const objectKey = (id: bigint) => key((k) => k.u8(0x6f).u64(id));
const end = prefixEnd(byName);
const rnd = () => Math.floor(Math.random() * N);
const times: Record<'name' | 'object' | 'page', number[]> = { name: [], object: [], page: [] };
const timed = <T>(kind: keyof typeof times, fn: () => T): T => {
  const t = performance.now();
  const out = fn();
  times[kind].push(performance.now() - t);
  return out;
};
for (let i = 0; i < READS; i++) {
  const id = timed('name', () => kv.get(nameKey(rnd())));
  if (!id) throw new Error('no account by that name: is the account count right?');
  if (typeOf(decode(id, (r) => r.u64())) !== TYPE.account) throw new Error('the name index gave something that is not an account');
  if (!timed('object', () => kv.get(objectKey(decode(id, (r) => r.u64()))))) throw new Error('the account is not in the store');
  timed('page', () => {
    let n = 0;
    for (const _ of kv.range(nameKey(rnd()), end)) if (++n === 20) break;
  });
}
const us = (v: number) => Math.round(v * 1000);
const spread = (ms: number[]) => {
  const sorted = ms.slice().sort((a, b) => a - b);
  return `mean ${us(ms.reduce((a, b) => a + b, 0) / ms.length)}, median ${us(sorted[sorted.length >> 1]!)}, 99th percentile ${us(sorted[Math.floor(sorted.length * 0.99)]!)}, longest ${us(sorted[sorted.length - 1]!)}`;
};
console.log(`${N} accounts, ${READS} reads of each kind, microseconds`);
for (let from = 0; from < READS; from += GROUP) {
  for (const kind of ['name', 'object', 'page'] as const) console.log(`reads ${from + 1} to ${Math.min(READS, from + GROUP)}, ${kind}: ${spread(times[kind].slice(from, from + GROUP))}`);
}
await env.close();
