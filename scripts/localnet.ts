/**
 * Runs a whole validator set inside one process on the in-memory transport,
 * drives the core application from a faucet account, and prints heights and
 * balances. The quickest way to watch the engine and the application work.
 *
 *   node scripts/localnet.ts [validators=4] [seconds=30]
 */
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson } from '../src/app/core/genesis.ts';
import { TYPE } from '../src/app/core/types.ts';
import { sha256, toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed, type KeyPair } from '../src/crypto/keys.ts';
import { WorkerVerifier } from '../src/crypto/verifier.ts';
import { idToString, objectId } from '../src/db/id.ts';
import { verifyObjectProof } from '../src/db/proof.ts';
import { Node } from '../src/node/node.ts';
import { MemoryHub } from '../src/p2p/memory.ts';
import type { Genesis } from '../src/types/genesis.ts';
import { makeLogger } from '../src/util/log.ts';
import { RpcServer } from '../src/rpc/server.ts';

const count = Number(process.argv[2] ?? 4);
const seconds = Number(process.argv[3] ?? 30);
const chainId = 'localnet';
const seed = (s: string) => sha256(new TextEncoder().encode(s));
const faucet = keyPairFromSeed(seed('faucet'));
const FAUCET_ID = objectId(TYPE.account, 0);

const operators = Array.from({ length: count }, (_, i) => keyPairFromSeed(seed(`op${i}`)));
const account = (name: string, publicKey: Uint8Array, balance: string) => ({ name, owner: authorityJson([publicKey]), active: authorityJson([publicKey]), balance });
const genesis: Genesis = {
  chainId,
  genesisTime: BigInt(Date.now()),
  appState: appGenesisBytes({
    accounts: [account('faucet', faucet.publicKey, '1000000000000'), ...operators.map((k, i) => account(`op${i}`, k.publicKey, '5000000000'))],
    staking: { minSelfBond: 1000, fixedRewardPerBlock: 1, downtimeWindow: 20, downtimeJailMs: 10_000 },
    communityPool: 10_000,
    validators: operators.map((_, i) => ({ operator: `op${i}`, consensusKey: toHex(keyPairFromSeed(seed(`val${i}`)).publicKey), selfBond: 2000 })),
  }),
};

const hub = new MemoryHub();
hub.latencyMs = 5;
const verifier = new WorkerVerifier();
const addrs = Array.from({ length: count }, (_, i) => `v${i}:1`);
const nodes: Node[] = [];
for (let i = 0; i < count; i++) {
  nodes.push(
    await Node.create({
      name: `v${i}`,
      genesis,
      dataDir: null,
      nodeKeySeed: seed(`node${i}`),
      validatorSeed: seed(`val${i}`),
      transport: hub.transport(addrs[i]!),
      listenAddr: addrs[i]!,
      seeds: addrs.filter((a) => a !== addrs[i]),
      verifier,
      timeouts: { proposeMs: 1000, prevoteMs: 500, precommitMs: 500, commitMs: 1000, gossipMs: 300 },
      network: { connectIntervalMs: 200 },
      log: makeLogger(`v${i}`, i === 0 ? 'info' : 'warn'),
    }),
  );
}
for (const n of nodes) await n.start();
const app0 = nodes[0]!.app as CoreApp;
const rpc = new RpcServer(nodes[0]!, { port: Number(process.env.RPC_PORT ?? 26657), log: makeLogger('rpc', 'info') });
await rpc.start();
console.log(`rpc on ${rpc.url}  (try: node src/cli.ts show ${rpc.url})`);

// Every second the faucet registers an account, pays one, or delegates to a validator in turn.
const users: { name: string; key: KeyPair }[] = [];
let tick = 0;
const ticker = setInterval(() => {
  const target = nodes[tick % count]!;
  const expiration = BigInt(Date.now()) + 60_000n;
  if (tick % 3 === 0) {
    const name = `user${users.length}`;
    const key = keyPairFromSeed(seed(name));
    users.push({ name, key });
    const owner = makeAuthority([key.publicKey]);
    void target.submitTx(signedTxBytes(chainId, { expiration, operations: withFees([{ type: 'accountCreate', registrar: FAUCET_ID, name, owner, active: owner }], app0.feeSchedule()) }, [faucet]));
  } else if (tick % 3 === 1) {
    const known = users.map((u) => app0.accountByName(u.name)).filter((a) => a !== null);
    if (known.length > 0) {
      const to = known[tick % known.length]!;
      void target.submitTx(signedTxBytes(chainId, { expiration, operations: withFees([{ type: 'transfer', from: FAUCET_ID, to: to.id, asset: app0.coreAsset, amount: 1000n }], app0.feeSchedule()) }, [faucet]));
    }
  } else {
    const validator = objectId(TYPE.validator, tick % count);
    void target.submitTx(signedTxBytes(chainId, { expiration, operations: withFees([{ type: 'delegate', delegator: FAUCET_ID, validator, amount: 500n * 100_000n }], app0.feeSchedule()) }, [faucet]));
  }
  tick++;
  const heights = nodes.map((n) => n.height.toString()).join(' ');
  const powers = nodes[0]!.executor.state.validators.validators.map((v) => v.power.toString()).join(' ');
  const accounts = app0.db.committedNextInstance(TYPE.account);
  console.log(`heights [${heights}]  powers [${powers}]  mempool ${nodes[0]!.mempool.size}  accounts ${accounts}  faucet ${app0.balance(FAUCET_ID)}  pool ${app0.dynamic().communityPool}  bonded ${app0.dynamic().bonded}`);
}, 1000);

setTimeout(async () => {
  clearInterval(ticker);
  const h = app0.lastHeight;
  const last = users.map((u) => app0.accountByName(u.name)).filter((a) => a !== null).at(-1);
  if (last) {
    const p = app0.proof(last.id);
    const ok = verifyObjectProof(app0.lastAppHash, p);
    console.log(`\nproof of ${last.name} (${idToString(last.id)}, balance ${app0.balance(last.id)}) against the app hash at height ${h}: ${ok ? 'valid' : 'INVALID'}, ${p.typeSiblings.length + p.topSiblings.length} sibling hashes`);
  }
  await rpc.stop();
  for (const n of nodes) await n.stop();
  await verifier.close();
  process.exit(0);
}, seconds * 1000);
