/**
 * The RPC server, the command line, the keystore and the light client at their edges: a server that is stopped lets
 * go of the node, a replayed block event is the live one, an event stream and a validator query know an account id
 * from any other id, names that every object inherits are names like any other, the command line says what is
 * wrong, and trust that has run out is refused when a header is verified.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson, DEFAULT_FEES } from '../src/app/core/genesis.ts';
import { TYPE } from '../src/app/core/types.ts';
import { toHex } from '../src/crypto/hash.ts';
import { DEFAULT_SCHEME, keyPairFromSeed, schemeName } from '../src/crypto/keys.ts';
import { objectId } from '../src/db/id.ts';
import { LightClient } from '../src/light/client.ts';
import { NodeProvider } from '../src/light/provider.ts';
import { RpcClient } from '../src/rpc/client.ts';
import { RpcServer } from '../src/rpc/server.ts';
import { headerHash, txHash } from '../src/types/block.ts';
import { Keystore } from '../src/wallet/keystore.ts';
import { makeTestnet, sleep, seedFor, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const faucet = keyPairFromSeed(seedFor('r5/faucet'));
const operators = [0, 1, 2, 3].map((i) => keyPairFromSeed(seedFor(`r5/op/${i}`)));
const FAUCET_ID = objectId(TYPE.account, 0);
const OP0_ID = objectId(TYPE.account, 1);
const CORE = objectId(TYPE.asset, 0);
const LIMITS = { ratePerSecond: 10_000, burst: 10_000, maxStreams: 100 };

/** The events of a stream, read until `enough` says so; the stream is then closed. */
async function readEvents(res: Response, enough: (events: { event: string; id: string; data: any }[]) => boolean): Promise<{ event: string; id: string; data: any }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const parse = () =>
    text
      .split('\n\n')
      .slice(0, -1)
      .filter((chunk) => chunk.startsWith('event: '))
      .map((chunk) => {
        const [event, id, data] = chunk.split('\n');
        return { event: event!.slice(7), id: id!.slice(4), data: JSON.parse(data!.slice(6)) };
      });
  try {
    while (!enough(parse())) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      text += decoder.decode(value, { stream: true });
    }
    return parse();
  } finally {
    await reader.cancel();
  }
}

describe('the rpc server', () => {
  let net: Testnet | null = null;
  const servers: RpcServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
    await net?.stop();
    net = null;
  });

  /** Four validators run by the accounts op0 to op3 (3.1 to 3.4), which are validators 7.0 to 7.3. */
  async function up() {
    net = await makeTestnet({
      validators: 4,
      engineValidators: false,
      appFor: (_i, _dataDir, genesis) => new CoreApp({ genesis, verifier }),
      appState: (keys) =>
        new TextDecoder().decode(
          appGenesisBytes({
            accounts: [
              { name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '100000000000' },
              ...operators.map((k, i) => ({ name: `op${i}`, owner: authorityJson([k.publicKey]), active: authorityJson([k.publicKey]), balance: '100000000' })),
            ],
            staking: { minSelfBond: 100, minDelegation: 1, validatorCreationFee: 1, unbondingPeriodMs: 2000, inflationMinBps: 0, inflationMaxBps: 0 },
            validators: keys.map((k, i) => ({ operator: `op${i}`, consensusKey: toHex(k), selfBond: 200 })),
          }),
        ),
    });
    const node = net.nodes[0]!;
    const server = new RpcServer(node, { port: 0, limits: LIMITS });
    servers.push(server);
    await server.start();
    await waitForHeight(net.nodes, 3n);
    return { node, server, rpc: new RpcClient(server.url), chainId: net.genesis.chainId };
  }

  it('hears of no commit once it is stopped, and answers those waiting for a transaction', async () => {
    const { node } = await up();
    const replaced = new RpcServer(node, { port: 0 });
    await replaced.start();
    const inner = replaced as unknown as { push(e: unknown): void; events: { waiting: number; waitForTx(hash: Uint8Array, ms: number): { promise: Promise<unknown> } | null } };
    let pushed = 0;
    const push = inner.push.bind(replaced);
    inner.push = (e) => {
      pushed++;
      push(e);
    };
    await waitFor(() => pushed > 0, 15_000, 'a commit passed to the server');
    const waiter = inner.events.waitForTx(new Uint8Array(32), 60_000)!;
    expect(inner.events.waiting).toBe(1);
    await replaced.stop();
    // The wait ends at once rather than at its timeout, and no new one is taken.
    expect(await waiter.promise).toBeNull();
    expect(inner.events.waiting).toBe(0);
    expect(inner.events.waitForTx(new Uint8Array(32), 60_000)).toBeNull();
    const seen = pushed;
    await waitForHeight([node], node.height + 2n);
    expect(pushed).toBe(seen);
  });

  it('is stopped only once the methods it was running have returned', async () => {
    const { server, rpc } = await up();
    // A method that is waiting when the server stops, as a broadcast waits on the mempool: its connection is cut
    // at once, and it still runs to its end before stop() returns, so the stores are not closed under it.
    let finished = false;
    (server as unknown as { methods: Record<string, { fn: (p: unknown) => Promise<unknown> }> }).methods.status!.fn = async () => {
      await sleep(300);
      finished = true;
      return {};
    };
    const call = rpc.status().catch(() => null);
    await sleep(50);
    await server.stop(0);
    expect(finished).toBe(true);
    expect(await call).toBeNull();
  });

  it('is not listening after a stop that overtook its start', async () => {
    const { node } = await up();
    const late = new RpcServer(node, { port: 0 });
    const starting = late.start();
    await late.stop();
    await starting;
    expect((late as unknown as { server: { listening: boolean } }).server.listening).toBe(false);
  });

  it('replays a block event as it was pushed, failed count and all, and says when it holds no results to count', async () => {
    const { node, server, rpc, chainId } = await up();
    const live = fetch(server.url + '/events?types=block').then((res) => readEvents(res, (ev) => ev.length >= 3));
    const transfer = signedTxBytes(chainId, { expiration: BigInt(Date.now()) + 60_000n, operations: withFees([{ type: 'transfer', from: FAUCET_ID, to: OP0_ID, asset: CORE, amount: 5n }], DEFAULT_FEES) }, [faucet]);
    const landed = await rpc.broadcastTx(toHex(transfer), 'commit');
    expect(landed.ok).toBe(true);
    const pushed = await live;
    expect(pushed[0]!.data.failed).toBe(0);
    const from = BigInt(pushed[0]!.id) - 1n;
    const replay = async () => readEvents(await fetch(server.url + '/events?types=block', { headers: { 'Last-Event-ID': from.toString() } }), (ev) => ev.length >= 3);
    expect((await replay()).slice(0, 3)).toEqual(pushed.slice(0, 3));

    // A block fetched after a state sync was never executed here: its results are not in the store.
    await waitForHeight([node], BigInt(landed.height) + 1n);
    const loadResults = node.store.loadResults.bind(node.store);
    node.store.loadResults = () => null;
    try {
      const upTo = BigInt(landed.height) + 1n;
      const res = await fetch(server.url + '/events?types=block', { headers: { 'Last-Event-ID': (BigInt(landed.height) - 1n).toString() } });
      const blocks = await readEvents(res, (ev) => ev.some((e) => BigInt(e.id) >= upTo));
      const withTx = blocks.find((e) => e.id === landed.height)!;
      expect(withTx.data).toMatchObject({ txs: 1, failed: null });
      const empty = blocks.find((e) => e.data.txs === 0)!;
      expect(empty.data.failed).toBe(0);
    } finally {
      node.store.loadResults = loadResults;
    }
  });

  it('opens an account stream only for an account there is, named or by id', async () => {
    const { server } = await up();
    const status = async (account: string) => {
      const res = await fetch(`${server.url}/events?types=account&account=${account}`);
      await res.body?.cancel();
      return res.status;
    };
    expect(await status('op0')).toBe(200);
    expect(await status('3.1')).toBe(200);
    expect(await status('nobody')).toBe(404);
    expect(await status('3.999')).toBe(404);
    // A validator's id is not an account's, and neither is a number no id can hold.
    expect(await status('7.0')).toBe(404);
    expect(await status('3.999999999999999999999')).toBe(404);
    expect(await status('99999999.1')).toBe(404);
  });

  it('knows no method by a name every object inherits, and answers a malformed request under the id it carries', async () => {
    const { server, rpc } = await up();
    for (const method of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) await expect(rpc.call(method)).rejects.toMatchObject({ code: -32601 });
    const post = async (body: unknown) => (await fetch(server.url + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    expect(await post({ id: 7, method: 'status' })).toMatchObject({ id: 7, error: { code: -32600 } });
    expect(await post({ jsonrpc: '2.0', id: 'seven', method: 12 })).toMatchObject({ id: 'seven', error: { code: -32600 } });
    // No id, or one that is neither a string, a number nor null: there is none to answer under.
    expect(await post({ method: 'status' })).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await post({ jsonrpc: '2.0', id: { a: 1 }, method: 'status' })).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('finds a validator by the account id of its operator, as by the name', async () => {
    const { rpc } = await up();
    const byName = await rpc.call('validator', { operator: 'op0' });
    expect(byName.id).toBe('7.0');
    expect(await rpc.call('validator', { operator: '3.1', height: byName.height })).toEqual(byName);
    expect(await rpc.call('validator', { id: '3.1', height: byName.height })).toEqual(byName);
    expect(await rpc.call('validator', { id: '7.0', height: byName.height })).toEqual(byName);
    const own = await rpc.call('delegation', { delegator: 'op0', validator: '3.1' });
    expect(own.delegation).toMatchObject({ delegator: '3.1', validator: '7.0' });
    expect(own).toEqual(await rpc.call('delegation', { delegator: 'op0', validator: '7.0', height: own.height }));
    // An account that runs no validator is said to run none; an id of neither kind is no validator.
    await expect(rpc.call('validator', { operator: '3.0' })).rejects.toMatchObject({ code: -32001, message: expect.stringMatching(/3\.0 runs no validator/) });
    await expect(rpc.call('delegation', { delegator: 'op0', validator: '3.0' })).rejects.toMatchObject({ code: -32001, message: expect.stringMatching(/runs no validator/) });
    await expect(rpc.call('validator', { id: '7.9' })).rejects.toMatchObject({ code: -32001, message: 'no such validator' });
  });
});

describe('the keystore', () => {
  it('keeps a key under a name every object inherits, and has none by such a name until one is added', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crosschain-r5-'));
    try {
      const path = join(dir, 'keystore.json');
      const ks = Keystore.create(path, 'pw');
      const names = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
      for (const name of names) {
        expect(ks.has(name)).toBe(false);
        expect(() => ks.get(name)).toThrow(`no key named ${name}`);
        expect(() => ks.publicKeyOf(name)).toThrow(`no key named ${name}`);
        expect(() => ks.remove(name)).toThrow(`no key named ${name}`);
      }
      const added = names.map((name) => ks.add(name));
      expect(() => ks.add('constructor')).toThrow(/already exists/);
      // What was written is read back, by this handle and by another.
      const reopened = Keystore.open(path, 'pw');
      for (const k of [ks, reopened]) {
        expect(k.list().map((e) => e.name)).toEqual(names);
        names.forEach((name, i) => {
          expect(k.has(name)).toBe(true);
          expect(toHex(k.get(name).publicKey)).toBe(toHex(added[i]!.publicKey));
          expect(toHex(k.publicKeyOf(name))).toBe(toHex(added[i]!.publicKey));
        });
      }
      reopened.remove('__proto__');
      reopened.remove('toString');
      const last = Keystore.open(path, 'pw');
      expect(last.list().map((e) => e.name)).toEqual(['constructor', 'hasOwnProperty']);
      expect(last.has('toString')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the command line', () => {
  let net: Testnet | null = null;
  let server: RpcServer | null = null;
  let dir: string | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
    await net?.stop();
    net = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  // The node answers from this process, so the command runs beside it, not in its place.
  const cli = (...args: string[]) =>
    new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), ...args]);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (status) => resolve({ status, out }));
    });

  it('writes the block size it was given into the genesis, and runs a node that stops on a signal with its directory released', async () => {
    dir = mkdtempSync(join(tmpdir(), 'r5-cli-'));
    const chain = join(dir, 'chain');
    const port = 42_000 + (process.pid % 1000) * 2;
    // A size no node would take is refused before anything is written.
    const refused = await cli('init', chain, '1', String(port), '--max-block-bytes', '100');
    expect(refused.status).toBe(1);
    expect(refused.out).toMatch(/maxBlockBytes must be a whole number from 65536 to 16777216/);
    expect(existsSync(chain)).toBe(false);
    expect((await cli('init', chain, '1', String(port), '--scheme', schemeName(DEFAULT_SCHEME), '--max-block-bytes', '131072')).status).toBe(0);
    expect(JSON.parse(readFileSync(join(chain, 'genesis.json'), 'utf8')).consensus.maxBlockBytes).toBe(131072);

    // The node as an operator runs it: under the wrapper that sets its heap, until an interrupt.
    const nodeDir = join(chain, 'node0');
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'start', nodeDir, '--heap', '512'], { env: { ...process.env, CROSSCHAIN_CHILD: '' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((resolve) => child.on('close', (status) => resolve(status)));
    try {
      // The status line comes every five seconds: the node is up, serving, and has committed by then.
      await waitFor(() => /\binfo\b.*\bstatus\b.*height=/.test(out), 30_000, () => `a status line; the node said:\n${out}`);
      expect(existsSync(join(nodeDir, 'data', 'LOCK'))).toBe(true);
      const second = await cli('start', nodeDir, '--heap', '512');
      expect(second.status).toBe(1);
      expect(second.out).toMatch(/in use by process/);
      child.kill('SIGINT');
      expect(await exited).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
    expect(existsSync(join(nodeDir, 'data', 'LOCK'))).toBe(false);
    expect(out).not.toMatch(/stopping failed|start failed|the store is closed|Unhandled|Error:/);
  });

  it('points at the usage for a command it does not know, with or without a target after it', async () => {
    for (const args of [[], ['frobnicate'], ['frobnicate', 'http://127.0.0.1:1'], ['frobnicate', '/no/such/directory']]) {
      const r = await cli(...args);
      expect(r.status).toBe(1);
      expect(r.out.trim()).toBe('usage: see the comment at the top of src/cli.ts');
    }
    // A command it knows still asks for the target it lacks.
    expect((await cli('show')).out.trim()).toBe('missing target');
  });

  it('prints whole amounts of an asset without decimals, keeps the chain with its light client anchor, and says when a node holds no results', async () => {
    net = await makeTestnet({
      validators: 4,
      chainId: 'r5-cli',
      appFor: (_i, _d, genesis) => new CoreApp({ genesis, verifier }),
      appState: new TextDecoder().decode(appGenesisBytes({ coreAsset: { precision: 0 }, accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '1000000000' }], staking: { inflationMinBps: 0, inflationMaxBps: 0 } })),
    });
    const node = net.nodes[0]!;
    server = new RpcServer(node, { port: 0, limits: LIMITS });
    await server.start();
    await waitForHeight(net.nodes, 2n);
    const rpc = new RpcClient(server.url);
    dir = mkdtempSync(join(tmpdir(), 'crosschain-r5-cli-'));
    const keystore = ['--keystore', join(dir, 'keystore.json')];
    const anchorFile = join(dir, 'light.json');

    const shown = await cli('show', server.url);
    expect(shown.status).toBe(0);
    expect(shown.out).toMatch(/^ {2}faucet +3\.0 +1000000000$/m);
    expect(shown.out).toMatch(/ pool \d+, bonded \d+, /);

    const transfer = signedTxBytes('r5-cli', { expiration: BigInt(Date.now()) + 60_000n, operations: withFees([{ type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: makeAuthority([faucet.publicKey]), active: makeAuthority([faucet.publicKey]) }], DEFAULT_FEES) }, [faucet]);
    const landed = await rpc.broadcastTx(toHex(transfer), 'commit');
    await waitForHeight([node], BigInt(landed.height) + 1n);
    const hash = toHex(txHash(transfer));
    const verified = await cli('verify-tx', server.url, hash, ...keystore);
    expect(verified.out).toContain(`verified: included at height ${landed.height}, ${landed.ok ? 'succeeded' : 'failed'}`);
    expect(verified.status).toBe(0);

    // The block is held and the one after it too, but not what its transactions came to.
    const loadResults = node.store.loadResults.bind(node.store);
    node.store.loadResults = () => null;
    try {
      const unknown = await cli('verify-tx', server.url, hash, ...keystore);
      expect(unknown.out.trim().split('\n').pop()).toBe(`included at height ${landed.height}; this node does not hold the results of that block`);
      expect(unknown.status).toBe(0);
    } finally {
      node.store.loadResults = loadResults;
    }

    // The anchor names its chain. Against a node of another chain it is refused for that, by name.
    const anchor = JSON.parse(readFileSync(anchorFile, 'utf8'));
    expect(anchor.chainId).toBe('r5-cli');
    writeFileSync(anchorFile, JSON.stringify({ ...anchor, chainId: 'another-chain' }));
    const refused = await cli('light', server.url, 'verify', ...keystore);
    expect(refused.status).toBe(1);
    expect(refused.out).toMatch(/light\.json holds a trusted header of chain another-chain, and this node is on chain r5-cli/);
    expect(JSON.parse(readFileSync(anchorFile, 'utf8')).chainId).toBe('another-chain');
    // An anchor written before the chain was kept with it is taken, and written back with the chain.
    writeFileSync(anchorFile, JSON.stringify({ height: anchor.height, hash: anchor.hash }));
    const taken = await cli('light', server.url, 'verify', ...keystore);
    expect(taken.out).toMatch(/^verified height \d+ /);
    expect(taken.status).toBe(0);
    expect(JSON.parse(readFileSync(anchorFile, 'utf8')).chainId).toBe('r5-cli');
  });
});

describe('the light client', () => {
  let net: Testnet | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
  });

  it('verifies no header from a trusted one that has reached the trusting period, the next one or a later one', async () => {
    net = await makeTestnet({ validators: 4 });
    const node = net.nodes[0]!;
    await waitForHeight(net.nodes, 6n);
    const period = 60_000n;
    let now = BigInt(Date.now());
    const client = await LightClient.trust({ chainId: net.genesis.chainId, provider: new NodeProvider(node), verifier, trustingPeriodMs: period, now: () => now }, 2n, headerHash(node.store.loadBlock(2n)!.block.header));
    await client.verifyToHeight(3n);
    // The clock reaches the end of the period of the header trusted now: it was a good anchor, and is one no more.
    now = client.trusted.header.time + period;
    await expect(client.verifyToHeight(4n)).rejects.toThrow('header 4: trusted header is older than the trusting period');
    await expect(client.verifyToHeight(6n)).rejects.toThrow('header 6: trusted header is older than the trusting period');
    await expect(client.verifyLatest()).rejects.toThrow(/older than the trusting period/);
    expect(client.trusted.header.height).toBe(3n);
    expect(client.verifiedHeights).toEqual([3n]);
    // A millisecond earlier the same headers verify, and trust moves on with them.
    now -= 1n;
    await client.verifyToHeight(4n);
    expect((await client.verifyToHeight(6n)).header.height).toBe(6n);
  });
});
