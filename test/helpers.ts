import { DEFAULT_SCHEME, schemeName, type SchemeTag } from '../src/crypto/keys.ts';
import { sha256 } from '../src/crypto/hash.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { InlineVerifier } from '../src/crypto/verifier.ts';
import { join } from 'node:path';
import type { Application } from '../src/app/types.ts';
import { KvStoreApp } from '../src/app/kvstore.ts';
import { Node, type NodeConfig } from '../src/node/node.ts';
import type { ValidationLimits } from '../src/consensus/validate.ts';
import { MemoryHub } from '../src/p2p/memory.ts';
import type { Genesis } from '../src/types/genesis.ts';
import { makeLogger, silentLogger, type LogLevel, type Logger } from '../src/util/log.ts';

export const FAST_TIMEOUTS = {
  proposeMs: 400,
  proposeDeltaMs: 200,
  prevoteMs: 200,
  prevoteDeltaMs: 100,
  precommitMs: 200,
  precommitDeltaMs: 100,
  commitMs: 50,
  gossipMs: 150,
};

export const FAST_NETWORK = { connectIntervalMs: 100, pingIntervalMs: 1000, idleTimeoutMs: 5000, desiredOutbound: 16, maxInbound: 32 };

export function seedFor(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(`seed:${label}`));
}

export function testLogger(name: string): Logger {
  const level = process.env.LOG as LogLevel | undefined;
  return level ? makeLogger(name, level) : silentLogger;
}

export interface TestnetOptions {
  validators: number;
  fullNodes?: number;
  powers?: bigint[];
  chainId?: string;
  dataDirFor?: (i: number) => string | null;
  timeouts?: Partial<typeof FAST_TIMEOUTS>;
  limits?: Partial<ValidationLimits>;
  /** Indices to create but not start. */
  skipStart?: number[];
  /** The chain's signature scheme; CHAIN_SCHEME from the environment, else ML-DSA-44. */
  scheme?: SchemeTag;
  /** Handed to the application; JSON, or a function of the validator public keys in index order. */
  appState?: string | ((validatorKeys: Uint8Array[]) => string);
  /** False leaves the engine's validator list out of genesis, so the application must supply the set. */
  engineValidators?: boolean;
  /** Application per node. Default is the key-value test app. */
  appFor?: (i: number, dataDir: string | null, genesis: Genesis) => Application;
}

export interface Testnet {
  hub: MemoryHub;
  genesis: Genesis;
  nodes: Node[];
  addrOf(i: number): string;
  validatorSeed(i: number): Uint8Array;
  nodeSeed(i: number): Uint8Array;
  makeNode(i: number, overrides?: Partial<NodeConfig>): Promise<Node>;
  stop(): Promise<void>;
}

export const verifier = new InlineVerifier();

export async function makeTestnet(opts: TestnetOptions): Promise<Testnet> {
  const chainId = opts.chainId ?? 'test-chain';
  const hub = new MemoryHub();
  const total = opts.validators + (opts.fullNodes ?? 0);
  const validatorSeed = (i: number) => seedFor(`${chainId}/val/${i}`);
  const nodeSeed = (i: number) => seedFor(`${chainId}/node/${i}`);
  const addrOf = (i: number) => `node${i}:1`;

  const scheme = opts.scheme ?? DEFAULT_SCHEME;
  const validatorKeys = Array.from({ length: opts.validators }, (_, i) => keyPairFromSeed(validatorSeed(i), scheme).publicKey);
  const appState = typeof opts.appState === 'function' ? opts.appState(validatorKeys) : (opts.appState ?? '{}');
  const genesis: Genesis = {
    chainId,
    signatureScheme: schemeName(scheme),
    genesisTime: BigInt(Date.now()) - 1000n,
    validators:
      opts.engineValidators === false
        ? undefined
        : validatorKeys.map((publicKey, i) => ({ publicKey, power: opts.powers?.[i] ?? 10n, name: `val${i}` })),
    appState: new TextEncoder().encode(appState),
  };

  const allAddrs = Array.from({ length: total }, (_, i) => addrOf(i));
  const nodes: Node[] = [];

  const makeNode = async (i: number, overrides: Partial<NodeConfig> = {}): Promise<Node> => {
    const dataDir = opts.dataDirFor?.(i) ?? null;
    const node = await Node.create({
      name: `n${i}`,
      genesis,
      dataDir,
      app: opts.appFor ? opts.appFor(i, dataDir, genesis) : new KvStoreApp(dataDir ? join(dataDir, 'app.json') : null),
      nodeKeySeed: nodeSeed(i),
      validatorSeed: i < opts.validators ? validatorSeed(i) : null,
      transport: hub.transport(addrOf(i)),
      listenAddr: addrOf(i),
      seeds: allAddrs.filter((a) => a !== addrOf(i)),
      verifier,
      timeouts: { ...FAST_TIMEOUTS, ...opts.timeouts },
      limits: opts.limits,
      network: FAST_NETWORK,
      lagGraceMs: 500,
      log: testLogger(`n${i}`),
      ...overrides,
    });
    return node;
  };

  for (let i = 0; i < total; i++) nodes.push(await makeNode(i));
  for (let i = 0; i < total; i++) if (!opts.skipStart?.includes(i)) await nodes[i]!.start();

  return {
    hub,
    genesis,
    nodes,
    addrOf,
    validatorSeed,
    nodeSeed,
    makeNode,
    stop: async () => {
      await Promise.all(nodes.map((n) => n.stop()));
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(cond: () => boolean, timeoutMs: number, what: string | (() => string)): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await sleep(20);
  }
}

export function waitForHeight(nodes: Node[], h: bigint, timeoutMs = 20_000): Promise<void> {
  return waitFor(
    () => nodes.every((n) => n.height >= h),
    timeoutMs,
    () => `height ${h} (now ${nodes.map((n) => n.height).join(',')})`,
  );
}

export function tx(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
