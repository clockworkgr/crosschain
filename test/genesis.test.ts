/** Genesis loading: the inline parser and the token-stream parser agree, and an application genesis can live in its own file. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { appGenesisBytes, authorityJson, loadAppGenesis, parseAppGenesis, parseAppGenesisStream, type AppGenesisJson } from '../src/app/core/genesis.ts';
import { toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { InlineVerifier } from '../src/crypto/verifier.ts';
import { MemoryKv } from '../src/store/kv.ts';
import { genesisToJson, loadGenesisFile } from '../src/types/genesis.ts';
import { seedFor } from './helpers.ts';

const keys = ['a', 'b', 'c'].map((n) => keyPairFromSeed(seedFor(`gen/${n}`)));
const verifier = new InlineVerifier();
const doc: AppGenesisJson = {
  coreAsset: { symbol: 'TEST', precision: 3 },
  fees: { transfer: { fee: '7' }, scale: 20_000 },
  staking: { maxValidators: 5, minSelfBond: 10 },
  communityPool: 12,
  accounts: [
    { name: 'faucet', owner: authorityJson([keys[0]!.publicKey]), active: authorityJson([keys[0]!.publicKey]), balance: '1000000' },
    { name: 'alice', owner: authorityJson([keys[1]!.publicKey]), active: { threshold: 1, keys: [], accounts: [{ account: '3.0', weight: 1 }] }, balance: '500000' },
  ],
  validators: [{ operator: 'alice', consensusKey: toHex(keys[2]!.publicKey), selfBond: 100 }],
};
const stream = (text: string | Uint8Array) => parseAppGenesisStream(Readable.from([Buffer.from(text)]));

describe('genesis loading', () => {
  it('parses the same document as one string and as a token stream', async () => {
    const bytes = appGenesisBytes(doc);
    const inline = parseAppGenesis(bytes);
    const streamed = await stream(bytes);
    expect(streamed).toEqual(inline);
    expect(streamed.accounts.length).toBe(2);
    expect(streamed.accounts[1]!.active.accounts[0]!.account).toBe(3n * 2n ** 48n);
    expect(streamed.fees.transfer.fee).toBe(7n);
    expect(streamed.fees.scale).toBe(20_000);
    expect(streamed.coreAsset.precision).toBe(3);
    expect(streamed.staking.maxValidators).toBe(5);
    expect(streamed.communityPool).toBe(12_000n);
    // Key order does not matter, nor does a document without accounts.
    const { accounts, ...rest } = doc;
    expect(await stream(JSON.stringify({ accounts, ...rest }))).toEqual(inline);
    expect((await stream('{}')).accounts).toEqual([]);
    await expect(stream('')).rejects.toThrow();
    await expect(stream('{"accounts": 5}')).rejects.toThrow(/must be an array/);
    await expect(stream('{"accounts": [1]}')).rejects.toThrow(/must be objects/);
    await expect(stream('{"accounts": [')).rejects.toThrow(/ended early|expected/);
    await expect(stream('{"a": 1')).rejects.toThrow(/ended early|expected/);
    await expect(stream('[1, 2]')).rejects.toThrow(/must be an object/);
    // A repeated top-level key replaces the earlier value on both paths, as JSON.parse does.
    const dup = `{"accounts":[${JSON.stringify(doc.accounts![0])}],"accounts":[]}`;
    expect((await stream(dup)).accounts).toEqual(parseAppGenesis(new TextEncoder().encode(dup)).accounts);
    expect((await stream(dup)).accounts.length).toBe(0);
    // A negative balance is an error, not a zero.
    expect(() => new CoreApp({ genesis: { chainId: 'g', genesisTime: 1n, appState: appGenesisBytes({ ...doc, accounts: [{ ...doc.accounts![0]!, balance: '-1' }] }) }, verifier })).toThrow(/negative balance/);
  });

  it('loads a genesis whose application state is in a file, and reaches the same app hash as an inline one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crosschain-genesis-'));
    try {
      writeFileSync(join(dir, 'state.json'), appGenesisBytes(doc));
      writeFileSync(join(dir, 'genesis.json'), genesisToJson({ chainId: 'g', genesisTime: 1n, appState: new Uint8Array(), appStateFile: 'state.json' }));
      const g = loadGenesisFile(join(dir, 'genesis.json'));
      expect(g.appStateFile).toBe(join(dir, 'state.json'));
      expect(g.appState.length).toBe(0);
      expect(genesisToJson(g)).not.toContain('"appState"');
      const fromFile = new CoreApp({ genesis: g, appGenesis: await loadAppGenesis(g), verifier });
      const inline = new CoreApp({ genesis: { chainId: 'g', genesisTime: 1n, appState: appGenesisBytes(doc) }, verifier });
      expect(toHex(fromFile.lastAppHash)).toBe(toHex(inline.lastAppHash));
      expect(fromFile.accountByName('alice')?.id).toBe(inline.accountByName('alice')?.id);
      // Neither a fresh database nor a reopened one keeps the encoded bytes of every object around.
      expect(fromFile.db.lastChanges).toBeNull();
      const kv = new MemoryKv();
      new CoreApp({ genesis: g, appGenesis: await loadAppGenesis(g), verifier, kv });
      const reopened = new CoreApp({ genesis: g, verifier, kv });
      expect(toHex(reopened.lastAppHash)).toBe(toHex(inline.lastAppHash));
      expect(reopened.db.lastChanges).toBeNull();
      // Without the parsed genesis there is nothing to build from.
      expect(() => new CoreApp({ genesis: g, verifier })).toThrow(/loadAppGenesis/);
      // An empty file is an empty genesis; a missing file is an error, not a hang.
      writeFileSync(join(dir, 'empty.json'), '');
      expect((await loadAppGenesis({ ...g, appStateFile: join(dir, 'empty.json') })).accounts).toEqual([]);
      await expect(loadAppGenesis({ ...g, appStateFile: join(dir, 'nope.json') })).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
