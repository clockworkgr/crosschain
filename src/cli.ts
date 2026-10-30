/**
 * Command line for running nodes and talking to them over JSON-RPC.
 *
 *   node src/cli.ts init <dir> <validators> [basePort=26656] [--scheme ml-dsa-44|secp256k1]
 *       Writes genesis.json with a funded faucet and one validator per node,
 *       a keystore with the faucet and operator keys, and a directory per
 *       node with its consensus key and config. Prints the keystore passphrase.
 *   node src/cli.ts start <dir>/<nodeN> [--heap <MiB>]
 *       Runs the node under a heap limit (three quarters of memory unless --heap says
 *       otherwise) with collections scheduled after commits; stops cleanly when the
 *       heap nears the limit, with exit code 3.
 *       Runs that node with its RPC on the p2p port plus one.
 *
 * Every other command takes a target: a node directory (its RPC URL and the
 * testnet keystore are found from it) or an RPC URL, with --keystore <path>,
 * --passphrase-file <path> or CHAIN_PASSPHRASE for signing keys.
 *
 *   keys list | add <name> | import <name> <seedHex> | export <name>   (--scheme names the chain's scheme for add and import)
 *   show <target>                       status, validators, accounts
 *   account <target> <name>             an account with balances and a verified name proof
 *   history <target> <account>          what happened to an account
 *   tx <target> <hash>                  where a transaction landed
 *   verify-tx <target> <hash>           the same, verified by the light client
 *   create <target> <name>              the faucet registers a new account; its key goes into the keystore
 *   transfer <target> <from> <to> <amount>
 *   create-validator <nodeDir> <operator> <selfBond>
 *   delegate <target> <from> <operator> <amount>
 *   undelegate <target> <from> <operator> <amount>
 *   unjail <target> <operator>
 *   parameters <target>                 the fee schedule and staking parameters in force
 *   proposals <target>                  open parameter proposals and what each changes
 *   propose <target> <operator> <path=value>...
 *       A validator proposes the live parameters with changes, e.g.
 *       fees.transfer.fee=250 fees.scale=12000 staking.maxValidators=9
 *   signal <target> <operator> <proposalId>
 *   light <target> trust <height> <hash> | light <target> verify [height]
 *   join <dir> <nodeN> <seedAddr> <trustHeight> <trustHash> [basePort]
 *       Writes a node directory that joins by state sync from the trusted header.
 *
 * Amounts are whole tokens; validators are named by their operator account.
 * Operation fees are filled in from the chain's schedule (FEES.md) before signing.
 */
import { spawn } from 'node:child_process';
import { totalmem } from 'node:os';
import { schemeName, schemeTag, type SchemeTag } from './crypto/keys.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { CoreApp } from './app/core/app.ts';
import { makeAuthority } from './app/core/authority.ts';
import { signedTxBytes, withFees } from './app/core/client.ts';
import { appGenesisBytes, authorityJson } from './app/core/genesis.ts';
import type { OperationDraft } from './app/core/tx.ts';
import { AccountType, chainParametersFromJson, feeScheduleFromJson } from './app/core/types.ts';
import { key } from './db/keys.ts';
import { fromHex, toHex } from './crypto/hash.ts';
import { generateSeed, keyPairFromSeed, type KeyPair } from './crypto/keys.ts';
import { WorkerVerifier, InlineVerifier } from './crypto/verifier.ts';
import { idFromString, type ObjectId } from './db/id.ts';
import { keyProofFromBytes } from './db/proof.ts';
import { LightClient } from './light/client.ts';
import { RpcProvider } from './light/rpc-provider.ts';
import { Node } from './node/node.ts';
import { TcpTransport } from './p2p/tcp.ts';
import { RpcClient } from './rpc/client.ts';
import { commitFromJson, headerFromJson, txQueryFromJson } from './rpc/json.ts';
import { encode } from './codec/writer.ts';
import { RpcServer } from './rpc/server.ts';
import { LmdbEnv } from './store/lmdb.ts';
import { headerHash, txHash } from './types/block.ts';
import { genesisToJson, loadGenesisFile, type Genesis } from './types/genesis.ts';
import { makeLogger, type LogLevel } from './util/log.ts';
import { Keystore } from './wallet/keystore.ts';

interface NodeFiles {
  name: string;
  listenAddr: string;
  rpcListen: string;
  seeds: string[];
  nodeKeySeed: string;
  validatorSeed: string | null;
  /** Join from a snapshot instead of replaying: a header the operator trusts. */
  stateSync?: { trustHeight: string; trustHash: string; backfill?: boolean };
  /** Blocks kept behind the latest (all when unset), provable heights, snapshots kept. */
  retain?: { blocks?: number; versions?: number; snapshots?: number };
  snapshotInterval?: number;
}

const UNBONDING_MS = 7 * 24 * 3_600_000;

// ---- argument handling ----

const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith('--')) flags.set(a.slice(2), process.argv[++i] ?? '');
  else positional.push(a);
}
const [cmd, ...args] = positional;

function need(i: number, what: string): string {
  const v = args[i];
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
}

/** A node directory gives an RPC URL and a keystore next to the testnet's genesis; a URL stands alone. */
function target(arg: string): { rpc: RpcClient; keystorePath: string; nodeDir: string | null } {
  if (/^https?:\/\//.test(arg)) {
    return { rpc: new RpcClient(flags.get('rpc') ?? arg), keystorePath: flags.get('keystore') ?? resolve('keystore.json'), nodeDir: null };
  }
  // A node directory still names the keystore and the node even when --rpc points somewhere else.
  const nodeDir = resolve(arg);
  const cfg = JSON.parse(readFileSync(join(nodeDir, 'config.json'), 'utf8')) as NodeFiles;
  const rpcListen = cfg.rpcListen ?? `127.0.0.1:${Number(cfg.listenAddr.split(':')[1]) + 1}`;
  return { rpc: new RpcClient(flags.get('rpc') ?? `http://${rpcListen}`), keystorePath: flags.get('keystore') ?? join(nodeDir, '..', 'keystore.json'), nodeDir };
}

async function passphrase(): Promise<string> {
  if (flags.has('passphrase-file')) return readFileSync(flags.get('passphrase-file')!, 'utf8').trim();
  if (process.env.CHAIN_PASSPHRASE) return process.env.CHAIN_PASSPHRASE;
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdout = process.stdout as NodeJS.WriteStream & { muted?: boolean };
    const write = stdout.write.bind(stdout);
    rl.question('passphrase: ', (answer) => {
      stdout.write = write;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    // Nothing is echoed after the prompt has been written: readline redraws the whole line when it is edited, not just the typed character.
    stdout.write = (() => true) as typeof stdout.write;
  });
}

async function openKeystore(path: string): Promise<Keystore> {
  return Keystore.openOrCreate(path, await passphrase());
}

// ---- init and start ----

function init(dir: string, count: number, basePort: number, scheme: SchemeTag): void {
  mkdirSync(dir, { recursive: true });
  const pass = process.env.CHAIN_PASSPHRASE ?? 'testnet';
  const ks = Keystore.create(join(dir, 'keystore.json'), pass);
  const faucet = ks.add('faucet', undefined, scheme);
  const seeds = Array.from({ length: count }, () => ({ node: generateSeed(scheme), val: generateSeed(scheme) }));
  const operators = seeds.map((_, i) => ks.add(`op${i}`, undefined, scheme));
  const account = (name: string, publicKey: Uint8Array, balance: string) => ({ name, owner: authorityJson([publicKey]), active: authorityJson([publicKey]), balance });
  const genesis: Genesis = {
    chainId: `chain-${toHex(generateSeed()).slice(0, 8)}`,
    signatureScheme: schemeName(scheme),
    genesisTime: BigInt(Date.now()),
    consensus: { maxEvidenceAgeMs: BigInt(UNBONDING_MS), version: 1 },
    appState: appGenesisBytes({
      accounts: [account('faucet', faucet.publicKey, '1000000000000'), ...operators.map((k, i) => account(`op${i}`, k.publicKey, '5000000000'))],
      staking: { unbondingPeriodMs: UNBONDING_MS },
      communityPool: 100_000,
      validators: seeds.map((s, i) => ({ operator: `op${i}`, consensusKey: toHex(keyPairFromSeed(s.val, scheme).publicKey), selfBond: 20_000 })),
    }),
  };
  writeFileSync(join(dir, 'genesis.json'), genesisToJson(genesis));
  const addrs = seeds.map((_, i) => `127.0.0.1:${basePort + 2 * i}`);
  seeds.forEach((s, i) => {
    const nd = join(dir, `node${i}`);
    mkdirSync(nd, { recursive: true });
    const cfg: NodeFiles = {
      name: `node${i}`,
      listenAddr: addrs[i]!,
      rpcListen: `127.0.0.1:${basePort + 2 * i + 1}`,
      seeds: addrs.filter((_, j) => j !== i),
      nodeKeySeed: toHex(s.node),
      validatorSeed: toHex(s.val),
    };
    writeFileSync(join(nd, 'config.json'), JSON.stringify(cfg, null, 2));
  });
  console.log(`wrote ${dir}/genesis.json, keystore.json (passphrase "${pass}") and ${count} node directories; p2p ports ${basePort}.. in steps of two, RPC on each p2p port plus one`);
}

/**
 * The node is run in a child process with the heap limit it needs: V8's default is a few gigabytes
 * whatever the machine has, and a state that outgrows it aborts the process. --expose-gc lets the
 * node schedule collections after commits, and a larger young generation means fewer of the small ones.
 */
function startUnderHeapLimit(): boolean {
  const configured = process.execArgv.some((a) => a.startsWith('--max-old-space-size')) || /max-old-space-size/.test(process.env.NODE_OPTIONS ?? '');
  if (configured || process.env.CROSSCHAIN_CHILD) return false;
  const heapMb = flags.has('heap') ? Number(flags.get('heap')) : Math.floor((totalmem() / 2 ** 20) * 0.75);
  if (!Number.isInteger(heapMb) || heapMb < 256) throw new Error('--heap takes a size in MiB, at least 256');
  console.log(`start: running the node under a ${heapMb} MiB heap limit (--heap <MiB> changes it), collections scheduled after commits`);
  const args = [`--max-old-space-size=${heapMb}`, '--max-semi-space-size=64', '--expose-gc', ...process.execArgv, process.argv[1]!, ...process.argv.slice(2)];
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, CROSSCHAIN_CHILD: '1' } });
  // A signal addressed to this process is passed on; a terminal's interrupt reaches the child by itself as well,
  // and the child's shutdown runs once however many it gets.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return true;
}

async function start(nodeDir: string): Promise<void> {
  if (startUnderHeapLimit()) return;
  const cfg = JSON.parse(readFileSync(join(nodeDir, 'config.json'), 'utf8')) as NodeFiles;
  const genesis = loadGenesisFile(join(nodeDir, '..', 'genesis.json'));
  const verifier = new WorkerVerifier();
  const log = makeLogger(cfg.name, (process.env.LOG as LogLevel | undefined) ?? 'info');
  const env = new LmdbEnv(join(nodeDir, 'data', 'lmdb'));
  const node = await Node.create({
    name: cfg.name,
    genesis,
    dataDir: join(nodeDir, 'data'),
    nodeKeySeed: fromHex(cfg.nodeKeySeed),
    validatorSeed: cfg.validatorSeed ? fromHex(cfg.validatorSeed) : null,
    transport: new TcpTransport(),
    listenAddr: cfg.listenAddr,
    seeds: cfg.seeds,
    env,
    verifier,
    log,
    stateSync: cfg.stateSync ? { trustHeight: BigInt(cfg.stateSync.trustHeight), trustHash: fromHex(cfg.stateSync.trustHash), backfill: cfg.stateSync.backfill } : undefined,
    retain: cfg.retain,
    snapshotInterval: cfg.snapshotInterval,
  });
  const app = node.app as CoreApp;
  await node.start();
  const [host, port] = (cfg.rpcListen ?? `127.0.0.1:${Number(cfg.listenAddr.split(':')[1]) + 1}`).split(':');
  const rpc = new RpcServer(node, { host, port: Number(port), log });
  await rpc.start();

  setInterval(() => {
    const m = node.memoryGuard.stats;
    const gc = node.gcScheduler.stats();
    log('info', 'status', {
      height: node.height,
      peers: node.network.peers.size,
      mempool: node.mempool.size,
      round: node.consensus.round,
      validators: app.dynamic().active.length,
      pool: app.dynamic().communityPool,
      heap: `${Math.round(m.heapUsed / 2 ** 20)}/${Math.round(m.heapLimit / 2 ** 20)} MiB`,
      memory: node.memoryLevel,
      gc: `${gc.collections} pauses, ${gc.totalMs.toFixed(0)} ms, longest ${gc.maxMs.toFixed(1)} ms`,
    });
  }, 5000).unref();

  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    await rpc.stop();
    await node.stop();
    await env.close();
    await verifier.close();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // Past the critical level the next step is V8 aborting the process; stopping cleanly first keeps the stores
  // consistent and tells the supervisor, through the exit code, that the node needs a larger heap.
  node.onMemory((level) => {
    if (level === 'critical') void shutdown(3);
  });
}

// ---- client helpers ----

async function chainInfo(rpc: RpcClient): Promise<{ chainId: string; precision: number; coreAsset: string }> {
  const status = await rpc.status();
  const core = await rpc.call('object', { id: '4.0' });
  return { chainId: status.chainId, precision: core.object.precision, coreAsset: '4.0' };
}

function toUnits(amount: string, precision: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`bad amount ${amount}`);
  const [int, frac = ''] = amount.split('.');
  if (frac.length > precision) throw new Error(`amount ${amount} has more than ${precision} decimals`);
  return BigInt(int!) * 10n ** BigInt(precision) + BigInt((frac + '0'.repeat(precision)).slice(0, precision));
}

function whole(units: string | bigint, precision: number): string {
  const u = BigInt(units);
  const unit = 10n ** BigInt(precision);
  return `${u / unit}.${(u % unit).toString().padStart(precision, '0')}`;
}

async function accountId(rpc: RpcClient, name: string): Promise<ObjectId> {
  const a = await rpc.account(name);
  if (!a.account) throw new Error(`no account ${name}`);
  return idFromString(a.account.id);
}

async function validatorId(rpc: RpcClient, operator: string): Promise<ObjectId> {
  const v = await rpc.call('validator', { operator });
  return idFromString(v.id);
}

/** Price the operations from the live schedule, sign, and wait for inclusion. */
async function send(rpc: RpcClient, operations: OperationDraft[], signer: KeyPair): Promise<void> {
  const { chainId } = await chainInfo(rpc);
  const params = await rpc.parameters();
  const fees = feeScheduleFromJson(params.fees);
  // A minute ahead, or half of what the chain allows when that is less: block time may trail the wall clock a little.
  const maxAhead = BigInt(params.maxTxExpirationMs) / 2n;
  const ahead = maxAhead < 60_000n ? maxAhead : 60_000n;
  const tx = signedTxBytes(chainId, { expiration: BigInt(Date.now()) + ahead, operations: withFees(operations, fees) }, [signer]);
  const r = await rpc.broadcastTx(toHex(tx), 'commit');
  console.log(r.ok ? `included at height ${r.height} (tx ${r.hash.slice(0, 16)}..)` : `failed at height ${r.height}: ${r.error}`);
  if (!r.ok) process.exitCode = 1;
}

/** The scheme the chain behind an RPC fixed in its genesis: what a key made for it must be. */
async function chainScheme(rpc: RpcClient): Promise<SchemeTag> {
  const s = (await rpc.call('status', {})) as { signatureScheme?: string };
  return schemeTag(s.signatureScheme ?? 'ml-dsa-44');
}

async function keyFor(keystorePath: string, name: string): Promise<KeyPair> {
  const ks = await openKeystore(keystorePath);
  return ks.get(name);
}

// ---- commands ----

/** Every leaf of a parameters object as "a.b.c" -> value. */
function leaves(o: unknown, prefix = ''): Map<string, string | number> {
  const out = new Map<string, string | number>();
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) for (const [path, leaf] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(path, leaf);
  else out.set(prefix, o as string | number);
  return out;
}

async function parameters(rpc: RpcClient): Promise<void> {
  const p = await rpc.parameters();
  console.log(`at height ${p.height}, amounts in base units of ${p.coreAsset.symbol} (precision ${p.coreAsset.precision})`);
  for (const [path, v] of leaves({ fees: p.fees, staking: p.staking })) console.log(`  ${path.padEnd(36)} ${v}`);
}

async function proposals(rpc: RpcClient): Promise<void> {
  const p = await rpc.parameters();
  const current = leaves({ fees: p.fees, staking: p.staking });
  const list = await rpc.proposals();
  if (list.length === 0) console.log('no open proposals');
  for (const prop of list) {
    console.log(`proposal ${prop.id} by validator ${prop.proposer}, signals ${prop.signals.join(' ')}, expires ${new Date(Number(prop.expiration)).toISOString()}`);
    let changes = 0;
    for (const [path, v] of leaves(prop.parameters)) {
      if (String(current.get(path)) === String(v)) continue;
      console.log(`  ${path.padEnd(36)} ${current.get(path)} -> ${v}`);
      changes++;
    }
    if (changes === 0) console.log('  no change from the parameters in force');
  }
}

/** The live parameters with "a.b.c=value" overrides applied; a number stays a number, an amount stays a string. */
async function proposedParameters(rpc: RpcClient, overrides: string[]) {
  const p = await rpc.parameters();
  const next = { fees: p.fees, staking: p.staking } as Record<string, unknown>;
  for (const kv of overrides) {
    const eq = kv.indexOf('=');
    if (eq < 0) throw new Error(`expected path=value, got ${kv}`);
    const path = kv.slice(0, eq).split('.');
    let o = next;
    for (const k of path.slice(0, -1)) {
      if (!o[k] || typeof o[k] !== 'object') throw new Error(`no parameter ${kv.slice(0, eq)}`);
      o = o[k] as Record<string, unknown>;
    }
    const leaf = path[path.length - 1]!;
    if (!(leaf in o) || typeof o[leaf] === 'object') throw new Error(`no parameter ${kv.slice(0, eq)}`);
    o[leaf] = typeof o[leaf] === 'number' ? Number(kv.slice(eq + 1)) : kv.slice(eq + 1);
  }
  return chainParametersFromJson(next);
}

async function keys(): Promise<void> {
  const path = flags.get('keystore') ?? resolve('keystore.json');
  const sub = need(0, 'keys subcommand');
  if ((sub === 'list' || sub === 'export') && !existsSync(path)) throw new Error(`no keystore at ${path}`);
  const ks = await openKeystore(path);
  // Keys are made for a chain's scheme: --scheme names it (ML-DSA-44 when absent); the chain refuses a key of the other.
  const scheme = schemeTag(flags.get('scheme') ?? 'ml-dsa-44');
  switch (sub) {
    case 'list':
      for (const k of ks.list()) console.log(`${k.name.padEnd(16)} ${k.scheme.padEnd(10)} ${k.address}`);
      break;
    case 'add': {
      const k = ks.add(need(1, 'name'), undefined, scheme);
      console.log(`added ${args[1]} ${toHex(k.address)}`);
      break;
    }
    case 'import': {
      const k = ks.add(need(1, 'name'), fromHex(need(2, 'seed hex')), scheme);
      console.log(`imported ${args[1]} ${toHex(k.address)}`);
      break;
    }
    case 'export':
      console.log(toHex(ks.seedOf(need(1, 'name'))));
      break;
    default:
      throw new Error(`unknown keys subcommand ${sub}`);
  }
}

async function show(rpc: RpcClient): Promise<void> {
  const status = await rpc.status();
  const { precision } = await chainInfo(rpc);
  const dyn = await rpc.call('object', { id: '2.0' });
  console.log(`height ${status.latestHeight}, ${status.peers} peers, pool ${whole(dyn.object.communityPool, precision)}, bonded ${whole(dyn.object.bonded, precision)}, inflation ${Number(dyn.object.inflationPpb) / 1e7}%`);
  console.log('validators (operator, status, stake, self-bond, power)');
  for (const a of dyn.object.active as { validator: string; power: string }[]) {
    const v = await rpc.call('validator', { id: a.validator });
    console.log(`  ${String(v.operatorName).padEnd(16)} ${String(v.active ? 'active' : v.status).padEnd(11)} ${whole(v.tokens, precision).padStart(18)} ${whole(v.selfBond, precision).padStart(18)} ${a.power}`);
  }
  console.log('accounts');
  for (const a of await rpc.call('accounts', { limit: 50 })) console.log(`  ${String(a.name).padEnd(20)} ${String(a.id).padEnd(8)} ${whole(a.balance, precision)}`);
}

async function account(rpc: RpcClient, name: string, keystorePath: string): Promise<void> {
  const { precision } = await chainInfo(rpc);
  // Ask one height back so the header that commits to the answer already exists, and let the light client judge it.
  const status = await rpc.status();
  const height = BigInt(status.latestHeight) - 1n;
  const a = await rpc.call('account', { name, prove: true, height: height.toString() });
  const proof = keyProofFromBytes(fromHex(a.proof));
  const client = (await lightClient(rpc, keystorePath)) as LightClient & { save(): void };
  const header = headerFromJson(await rpc.header(height + 1n));
  const commit = commitFromJson(await rpc.commit(height + 1n));
  const verdict = await client.verifyKey({ proof, header, commit });
  client.save();
  const verified = 'value' in verdict ? verdict.value : undefined;
  const expected = a.account ? toHex(encode((w) => w.u64(idFromString(a.account.id)))) : null;
  // The proof must be about this name in the account name index at the height asked for, not merely a valid proof of something.
  const about = proof.type === AccountType.id && proof.indexPosition === 0 && proof.height === height && toHex(proof.key) === toHex(key((k) => k.str(name)));
  const ok = about && verified !== undefined && (verified === null ? expected === null : toHex(verified) === expected);
  if (!ok) process.exitCode = 1;
  if (!a.account) {
    console.log(`no account ${name}${ok ? ' (proven absent by the light client)' : ' (absence NOT proven)'}`);
    return;
  }
  console.log(`${a.account.name} ${a.account.id}${ok ? ' (name proof verified by the light client)' : ' (proof NOT verified)'}`);
  for (const b of a.balances) console.log(`  ${String(b.asset).padEnd(8)} ${whole(b.amount, typeof b.precision === 'number' ? b.precision : precision)}`);
  if (a.validator) console.log(`  operates validator ${a.validator}`);
  console.log(`  ${a.history} history entries`);
}

async function history(rpc: RpcClient, name: string): Promise<void> {
  const h = await rpc.call('accountHistory', { account: name, limit: 50, reverse: true });
  const short = (_k: string, v: unknown) => (typeof v === 'string' && /^[0-9a-f]{64,}$/.test(v) ? v.slice(0, 12) + '..' : v);
  for (const e of h.entries) console.log(`  #${e.sequence} h=${e.height} ${e.kind}${e.txHash ? ' tx ' + e.txHash.slice(0, 12) : ''} ${JSON.stringify(e.data, short)}`);
}

async function txInfo(rpc: RpcClient, hash: string): Promise<void> {
  const t = await rpc.tx(hash);
  console.log(`height ${t.height} index ${t.index} ok ${t.ok} ${t.error ? 'error ' + t.error : ''}`);
  if (t.decoded) console.log(JSON.stringify(t.decoded.operations));
}

async function lightClient(rpc: RpcClient, keystorePath: string, trust?: { height: bigint; hash: Uint8Array }): Promise<LightClient> {
  const file = join(dirname(keystorePath), 'light.json');
  const status = await rpc.status();
  let anchor = trust;
  if (!anchor && existsSync(file)) {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { height: string; hash: string };
    anchor = { height: BigInt(j.height), hash: fromHex(j.hash) };
  }
  if (!anchor) {
    // Trust on first use: the latest header, recorded so later runs verify from it.
    const h = BigInt(status.latestHeight);
    anchor = { height: h, hash: headerHash(headerFromJson(await rpc.header(h))) };
    console.log(`trusting height ${h} on first use`);
  }
  const client = await LightClient.trust({ chainId: status.chainId, provider: new RpcProvider(rpc), verifier: new InlineVerifier() }, anchor.height, anchor.hash);
  const save = () => writeFileSync(file, JSON.stringify({ height: client.trusted.header.height.toString(), hash: toHex(headerHash(client.trusted.header)) }));
  save();
  return Object.assign(client, { save });
}

async function verifyTx(rpc: RpcClient, keystorePath: string, hash: string): Promise<void> {
  const t = await rpc.tx(hash, true);
  if (!t.proof) throw new Error('no proof available');
  const q = txQueryFromJson(t.proof);
  if (toHex(txHash(q.txProof.tx)) !== hash.toLowerCase()) throw new Error('the node answered with a proof for a different transaction');
  const client = (await lightClient(rpc, keystorePath)) as LightClient & { save(): void };
  const verdict = await client.verifyTx(q);
  client.save();
  // What is printed is what was proven: the proof's own height, not the height the node claimed alongside it.
  const at = q.txProof.height;
  if (verdict === null) console.log(`included at height ${at}; result not yet committed`);
  else if ('failed' in verdict) {
    console.log(`verification failed: ${verdict.error}`);
    process.exitCode = 1;
  } else console.log(`verified: included at height ${at}, ${verdict.ok ? 'succeeded' : 'failed: ' + verdict.error}`);
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'init':
      init(resolve(args[0] ?? 'testnet'), Number(args[1] ?? 4), Number(args[2] ?? 26656), schemeTag(flags.get('scheme') ?? 'ml-dsa-44'));
      return;
    case 'start':
      await start(resolve(need(0, 'node directory')));
      return;
    case 'keys':
      await keys();
      return;
    case 'join': {
      const dir = resolve(need(0, 'dir'));
      const name = need(1, 'node name');
      const seed = need(2, 'seed address');
      const trustHeight = need(3, 'trust height');
      const trustHash = need(4, 'trust hash');
      const nd = join(dir, name);
      // An existing node keeps its identity and its validator seed; joining never overwrites a configuration.
      if (existsSync(join(nd, 'config.json'))) throw new Error(`${nd}/config.json exists; remove it first if this node is meant to join afresh`);
      mkdirSync(nd, { recursive: true });
      const port = Number(args[5] ?? 26700);
      const cfg: NodeFiles = {
        name,
        listenAddr: `127.0.0.1:${port}`,
        rpcListen: `127.0.0.1:${port + 1}`,
        seeds: [seed],
        nodeKeySeed: toHex(generateSeed()),
        validatorSeed: null,
        stateSync: { trustHeight, trustHash, backfill: true },
      };
      writeFileSync(join(nd, 'config.json'), JSON.stringify(cfg, null, 2), { flag: 'wx' });
      console.log(`wrote ${nd}/config.json; start it with: node src/cli.ts start ${nd}`);
      return;
    }
  }
  const t = target(need(0, 'target'));
  const { rpc, keystorePath } = t;
  switch (cmd) {
    case 'show':
      await show(rpc);
      break;
    case 'account':
      await account(rpc, need(1, 'name'), keystorePath);
      break;
    case 'history':
      await history(rpc, need(1, 'account'));
      break;
    case 'tx':
      await txInfo(rpc, need(1, 'hash'));
      break;
    case 'verify-tx':
      await verifyTx(rpc, keystorePath, need(1, 'hash'));
      break;
    case 'create': {
      const name = need(1, 'name');
      const ks = await openKeystore(keystorePath);
      const key = ks.has(name) ? ks.get(name) : ks.add(name, undefined, await chainScheme(rpc));
      const auth = makeAuthority([key.publicKey]);
      await send(rpc, [{ type: 'accountCreate', registrar: await accountId(rpc, 'faucet'), name, owner: auth, active: auth }], ks.get('faucet'));
      break;
    }
    case 'transfer': {
      const { precision, coreAsset } = await chainInfo(rpc);
      const from = need(1, 'from');
      await send(rpc, [{ type: 'transfer', from: await accountId(rpc, from), to: await accountId(rpc, need(2, 'to')), asset: idFromString(coreAsset), amount: toUnits(need(3, 'amount'), precision) }], await keyFor(keystorePath, from));
      break;
    }
    case 'create-validator': {
      if (!t.nodeDir) throw new Error('create-validator needs a node directory, whose consensus key it registers');
      const cfg = JSON.parse(readFileSync(join(t.nodeDir, 'config.json'), 'utf8')) as NodeFiles;
      if (!cfg.validatorSeed) throw new Error('this node has no validator key');
      const { precision } = await chainInfo(rpc);
      const operator = need(1, 'operator');
      await send(rpc, [{ type: 'validatorCreate', operator: await accountId(rpc, operator), consensusKey: keyPairFromSeed(fromHex(cfg.validatorSeed), await chainScheme(rpc)).publicKey, selfBond: toUnits(need(2, 'self-bond'), precision) }], await keyFor(keystorePath, operator));
      break;
    }
    case 'delegate': {
      const { precision } = await chainInfo(rpc);
      const from = need(1, 'from');
      await send(rpc, [{ type: 'delegate', delegator: await accountId(rpc, from), validator: await validatorId(rpc, need(2, 'operator')), amount: toUnits(need(3, 'amount'), precision) }], await keyFor(keystorePath, from));
      break;
    }
    case 'undelegate': {
      const { precision } = await chainInfo(rpc);
      const from = need(1, 'from');
      const d = await rpc.call('delegation', { delegator: from, validator: need(2, 'operator') });
      if (!d.delegation) throw new Error(`${from} has no delegation to ${args[2]}`);
      const tokens = toUnits(need(3, 'amount'), precision);
      const shares = tokens >= BigInt(d.delegation.tokens) ? BigInt(d.delegation.shares) : (tokens * BigInt(d.delegation.shares)) / BigInt(d.delegation.tokens);
      await send(rpc, [{ type: 'undelegate', delegator: await accountId(rpc, from), validator: idFromString(d.delegation.validator), shares }], await keyFor(keystorePath, from));
      break;
    }
    case 'unjail': {
      const operator = need(1, 'operator');
      await send(rpc, [{ type: 'unjail', operator: await accountId(rpc, operator), validator: await validatorId(rpc, operator) }], await keyFor(keystorePath, operator));
      break;
    }
    case 'parameters':
      await parameters(rpc);
      break;
    case 'proposals':
      await proposals(rpc);
      break;
    case 'propose': {
      const operator = need(1, 'operator');
      const parameters = await proposedParameters(rpc, args.slice(2));
      await send(rpc, [{ type: 'proposalCreate', operator: await accountId(rpc, operator), validator: await validatorId(rpc, operator), parameters }], await keyFor(keystorePath, operator));
      break;
    }
    case 'signal': {
      const operator = need(1, 'operator');
      await send(rpc, [{ type: 'proposalSignal', operator: await accountId(rpc, operator), validator: await validatorId(rpc, operator), proposal: idFromString(need(2, 'proposal id')) }], await keyFor(keystorePath, operator));
      break;
    }
    case 'light': {
      const sub = need(1, 'light subcommand');
      if (sub === 'trust') {
        const client = (await lightClient(rpc, keystorePath, { height: BigInt(need(2, 'height')), hash: fromHex(need(3, 'hash')) })) as LightClient & { save(): void };
        console.log(`trusting height ${client.trusted.header.height}`);
      } else if (sub === 'verify') {
        const client = (await lightClient(rpc, keystorePath)) as LightClient & { save(): void };
        const s = args[2] ? await client.verifyToHeight(BigInt(args[2])) : await client.verifyLatest();
        client.save();
        console.log(`verified height ${s.header.height} ${toHex(headerHash(s.header))}, ${s.validators.size} validators, via ${client.verifiedHeights.length} step(s)`);
      } else throw new Error(`unknown light subcommand ${sub}`);
      break;
    }
    default:
      console.log('usage: see the comment at the top of src/cli.ts');
      process.exit(1);
  }
}

try {
  await main();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
