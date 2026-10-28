import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { DEFAULT_FEES } from '../src/app/core/genesis.ts';
import { appGenesisBytes, authorityJson } from '../src/app/core/genesis.ts';
import { validatorByOperator } from '../src/app/core/staking.ts';
import { TYPE, ValidatorStatus } from '../src/app/core/types.ts';
import { toHex } from '../src/crypto/hash.ts';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { objectId } from '../src/db/id.ts';
import { LightClient } from '../src/light/client.ts';
import { NodeProvider } from '../src/light/provider.ts';
import { headerHash } from '../src/types/block.ts';
import { makeTestnet, seedFor, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const faucet = keyPairFromSeed(seedFor('snet/faucet'));
const operators = [0, 1, 2, 3].map((i) => keyPairFromSeed(seedFor(`snet/op/${i}`)));
const FAUCET_ID = objectId(TYPE.account, 0);
const OP_ID = (i: number) => objectId(TYPE.account, 1 + i);
const VAL_ID = (i: number) => objectId(TYPE.validator, i);

describe('staking on a live network', () => {
  let net: Testnet | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
  });

  it('owns the validator set: delegation raises power, a stopped validator is jailed, and it returns after unjail', async () => {
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
            staking: { minSelfBond: 100, minDelegation: 1, validatorCreationFee: 1, fixedRewardPerBlock: 1, downtimeWindow: 8, downtimeMinSignedBps: 5000, downtimeJailMs: 2000, unbondingPeriodMs: 5000, inflationMinBps: 0, inflationMaxBps: 0 },
            communityPool: 1000,
            validators: keys.map((k, i) => ({ operator: `op${i}`, consensusKey: toHex(k), selfBond: 200 })),
          }),
        ),
    });
    const chainId = net.genesis.chainId;
    const apps = net.nodes.map((n) => n.app as CoreApp);
    const node = net.nodes[0]!;
    await waitForHeight(net.nodes, 3n);
    // The engine runs on the set the application built at genesis.
    expect(node.executor.state.validators.size).toBe(4);
    for (const v of node.executor.state.validators.validators) expect(v.power).toBeGreaterThanOrEqual(200n);
    const expiration = () => BigInt(Date.now()) + 60_000n;

    // Delegation: 300 whole tokens to validator 0 raise its power to 500 (plus rewards) two heights after the block.
    const delegate = signedTxBytes(chainId, { expiration: expiration(), operations: withFees([{ type: 'delegate', delegator: FAUCET_ID, validator: VAL_ID(0), amount: 300n * 100_000n }], DEFAULT_FEES) }, [faucet]);
    expect((await node.submitTx(delegate)).status).toBe('added');
    const power0 = () => node.executor.state.validators.byAddress(keyPairFromSeed(net!.validatorSeed(0)).address)?.power ?? 0n;
    await waitFor(() => power0() >= 500n, 20_000, () => `validator 0 at power 500 (now ${power0()})`);
    await waitFor(() => apps.every((a) => (a.dynamic().active.find((x) => x.validator === VAL_ID(0))?.power ?? 0n) >= 500n), 10_000, 'every app to hold the new set');

    // Validator 3 goes dark: within the window it is jailed and leaves the set; the chain keeps going on three.
    await net.nodes[3]!.stop();
    const status3 = () => validatorByOperator(apps[0]!.db, OP_ID(3))!.status;
    await waitFor(() => status3() === ValidatorStatus.jailed, 40_000, () => `validator 3 jailed (status ${status3()})`);
    await waitFor(() => node.executor.state.validators.size === 3, 20_000, () => `set of three (now ${node.executor.state.validators.size})`);
    const jailedAt = node.height;
    await waitForHeight(net.nodes.slice(0, 3), jailedAt + 3n);

    // It comes back: restart, catch up by block sync, operator unjails after the period, set grows to four again.
    const back = await net.makeNode(3, { validatorSeed: net.validatorSeed(3) });
    net.nodes[3] = back;
    await back.start();
    await waitFor(() => back.height >= node.height - 1n, 30_000, () => `node 3 to catch up (${back.height} vs ${node.height})`);
    await waitFor(() => BigInt(Date.now()) > validatorByOperator(apps[0]!.db, OP_ID(3))!.jailedUntil + 1000n, 10_000, 'jail period to pass');
    const unjail = signedTxBytes(chainId, { expiration: expiration(), operations: withFees([{ type: 'unjail', operator: OP_ID(3), validator: VAL_ID(3) }], DEFAULT_FEES) }, [operators[3]!]);
    expect((await node.submitTx(unjail)).status).toBe('added');
    await waitFor(() => node.executor.state.validators.size === 4, 30_000, () => `set of four again (now ${node.executor.state.validators.size})`);

    // Two more heights, so the latest header is signed by the set of four, then a light client that trusted height 2 follows all of this.
    await waitForHeight(net.nodes.slice(0, 3), node.height + 2n);
    const trusted = headerHash(node.store.loadBlock(2n)!.block.header);
    const client = await LightClient.trust({ chainId, provider: new NodeProvider(node), verifier }, 2n, trusted);
    const latest = await client.verifyLatest();
    expect(latest.validators.size).toBe(4);
    expect(latest.header.height).toBeGreaterThan(jailedAt);
    // And proves who stands behind a consensus key in that set.
    const q = node.queryAccountName('op3')!;
    expect('value' in (await client.verifyKey(q))).toBe(true);
  });
});
