/**
 * A large genesis, BENCH_GENESIS_MB of JSON (default 1000): writing it, parsing
 * it as a token stream, building the object database and the first root,
 * writing everything to LMDB, what that costs in memory and on disk, how
 * reads perform at that size, one block of transfers, a snapshot, and a
 * restart from the store. Not part of the default run: `npm run bench:genesis`
 * (which also runs the scale suite). Set BENCH_KEEP=1 to leave the files
 * behind for inspection.
 */
import { DEFAULT_SCHEME, schemeName } from '../src/crypto/keys.ts';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreApp } from '../src/app/core/app.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { loadAppGenesis, type AppGenesis } from '../src/app/core/genesis.ts';
import { TYPE } from '../src/app/core/types.ts';
import { toHex } from '../src/crypto/hash.ts';
import { WorkerVerifier } from '../src/crypto/verifier.ts';
import { objectId } from '../src/db/id.ts';
import { keyProofToBytes, proofToBytes, verifyKeyProof, verifyObjectProof } from '../src/db/proof.ts';
import { LmdbEnv } from '../src/store/lmdb.ts';
import { genesisToJson, loadGenesisFile, type Genesis } from '../src/types/genesis.ts';
import { bench, fact, fmtBytes, fmtMs, suite } from './harness.ts';
import { accountName, CHAIN_ID, dirSize, genesisTime, MB, memory, POOL, poolKeys, writeAppGenesis } from './bigstate.ts';

export async function run(): Promise<void> {
  suite(`genesis (${MB} MB)`);
  const dir = mkdtempSync(join(tmpdir(), 'crosschain-genesis-'));
  const verifier = new WorkerVerifier();
  try {
    let t = performance.now();
    const keys = poolKeys();
    fact(`${POOL} key pairs for the pool`, fmtMs(performance.now() - t));

    const file = join(dir, 'app-genesis.json');
    t = performance.now();
    const accounts = writeAppGenesis(file, keys.map((k) => toHex(k.publicKey)), MB * 1024 * 1024);
    const size = statSync(file).size;
    fact('application genesis written', `${fmtBytes(size)}, ${accounts.toLocaleString('en-US')} accounts with two keys each, in ${fmtMs(performance.now() - t)}`);
    const genesis: Genesis = { chainId: CHAIN_ID, signatureScheme: schemeName(DEFAULT_SCHEME), genesisTime, appState: new Uint8Array(), appStateFile: 'app-genesis.json' };
    writeFileSync(join(dir, 'genesis.json'), genesisToJson(genesis));
    const loaded = loadGenesisFile(join(dir, 'genesis.json'));

    // Parse as a token stream.
    fact('memory before', await memory());
    t = performance.now();
    let appGenesis: AppGenesis | null = await loadAppGenesis(loaded);
    const parseMs = performance.now() - t;
    fact('parse as a token stream (stream-json)', `${fmtMs(parseMs)}, ${(size / 1024 / 1024 / (parseMs / 1000)).toFixed(0)} MiB/s, ${appGenesis.accounts.length.toLocaleString('en-US')} accounts`);
    fact('memory after parsing', await memory());

    // Build the database and write it out.
    const env = new LmdbEnv(join(dir, 'lmdb'));
    const timings: Record<string, unknown> = {};
    const log = (_level: string, msg: string, fields?: Record<string, unknown>) => {
      if (msg === 'applied genesis' || msg === 'loaded application state') Object.assign(timings, fields);
    };
    t = performance.now();
    let app = new CoreApp({ genesis: loaded, appGenesis, verifier, kv: env.store('app'), snapshotInterval: 0, log });
    fact('build: objects and indices, first root, write to LMDB', `${fmtMs(performance.now() - t)} (apply ${timings.applyMs} ms, root ${timings.rootMs} ms, persist ${timings.persistMs} ms)`);
    fact('memory after building', await memory());
    fact('LMDB on disk', fmtBytes(dirSize(join(dir, 'lmdb'))));
    fact('app hash', toHex(app.lastAppHash).slice(0, 16) + '..');

    // Reads at this size.
    const N = appGenesis.accounts.length;
    const rnd = () => Math.floor(Math.random() * N);
    await bench('account by id', { batch: 1000 }, () => {
      for (let i = 0; i < 1000; i++) app.account(objectId(TYPE.account, rnd()));
    });
    await bench('account by name (B+ tree index)', { batch: 1000 }, () => {
      for (let i = 0; i < 1000; i++) app.accountByName(accountName(rnd()));
    });
    await bench('balance (owner, asset) lookup', { batch: 1000 }, () => {
      for (let i = 0; i < 1000; i++) app.balance(objectId(TYPE.account, rnd()));
    });
    const op = app.proof(objectId(TYPE.account, 7));
    const kp = app.proveAccountName(accountName(7));
    fact('proof sizes at this scale', `object ${fmtBytes(proofToBytes(op).length)} (${op.typeSiblings.length + op.topSiblings.length} siblings), name ${fmtBytes(keyProofToBytes(kp).length)}`);
    await bench('object proof + verify', { batch: 100 }, () => {
      for (let i = 0; i < 100; i++) if (!verifyObjectProof(app.lastAppHash, app.proof(objectId(TYPE.account, rnd())))) throw new Error('bad proof');
    });
    await bench('name proof (SMT) + verify', { batch: 100 }, () => {
      for (let i = 0; i < 100; i++) if (verifyKeyProof(app.lastAppHash, app.proveAccountName(accountName(rnd()))) === undefined) throw new Error('bad proof');
    });

    // One block of transfers between these accounts, then a commit to LMDB.
    const txs: Uint8Array[] = [];
    t = performance.now();
    for (let i = 0; i < 500; i++) {
      const ops = withFees([{ type: 'transfer', from: objectId(TYPE.account, i), to: objectId(TYPE.account, i + 1), asset: app.coreAsset, amount: 1n + BigInt(i) }], app.feeSchedule());
      txs.push(signedTxBytes(CHAIN_ID, { expiration: genesisTime + 60_000n, operations: ops }, [keys[(2 * i + 1) % POOL]!]));
    }
    fact('500 transfers signed with the pool keys', fmtMs(performance.now() - t));
    t = performance.now();
    let next = 0;
    await Promise.all(Array.from({ length: 32 }, async () => {
      while (next < txs.length) {
        const r = await app.checkTx(txs[next++]!);
        if (!r.ok) throw new Error(r.error);
      }
    }));
    fact('checkTx of the 500', fmtMs(performance.now() - t));
    t = performance.now();
    const r = await app.finalizeBlock({ height: 1n, time: genesisTime + 1000n, txs, proposerAddress: new Uint8Array(32), lastCommitSigners: [], misbehavior: [] });
    if (r.txResults.some((x) => !x.ok)) throw new Error('a transfer failed');
    const finalizeMs = performance.now() - t;
    t = performance.now();
    await app.commit();
    fact('block of 500 transfers at this size', `finalize ${fmtMs(finalizeMs)}, commit to LMDB ${fmtMs(performance.now() - t)}`);

    t = performance.now();
    app.takeSnapshot();
    fact('state snapshot for state sync', `${fmtMs(performance.now() - t)}; LMDB now ${fmtBytes(dirSize(join(dir, 'lmdb')))}`);
    fact('memory at the end of the session', await memory());

    // Restart: everything comes back from the store, the genesis file is not read. Let go of the
    // parsed genesis and the first application first, as a restarted process would never have had them.
    await env.close();
    appGenesis = null;
    app = null as unknown as CoreApp;
    fact('memory with nothing loaded (after releasing the session)', await memory());
    const env2 = new LmdbEnv(join(dir, 'lmdb'));
    t = performance.now();
    app = new CoreApp({ genesis: loaded, verifier, kv: env2.store('app'), snapshotInterval: 0, log });
    fact('restart from LMDB', `${fmtMs(performance.now() - t)} (read and decode ${timings.objects} objects ${timings.importMs} ms, indices and root ${timings.rootMs} ms, history ${timings.historyMs} ms), height ${app.lastHeight}`);
    fact('memory after restart', await memory());
    await env2.close();
  } finally {
    await verifier.close();
    if (process.env.BENCH_KEEP) console.log(`kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}
