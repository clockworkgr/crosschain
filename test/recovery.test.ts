import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KvStoreApp } from '../src/app/kvstore.ts';
import { toHex } from '../src/crypto/hash.ts';
import { sign, signContext, keyPairFromSeed } from '../src/crypto/keys.ts';
import { blockHash } from '../src/types/block.ts';
import { VoteType, voteSignBytes, type Vote } from '../src/types/vote.ts';
import { makeTestnet, tx, waitFor, waitForHeight, type Testnet } from './helpers.ts';

let net: Testnet | null = null;
let tmp: string | null = null;
afterEach(async () => {
  await net?.stop();
  net = null;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('persistence and recovery', () => {
  it('a validator restarted from disk resumes with its state, key guard and app intact', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'crosschain-'));
    const dir = tmp;
    net = await makeTestnet({ validators: 4, dataDirFor: (i) => (i === 0 ? join(dir, 'n0') : null) });
    await waitForHeight(net.nodes, 2n);
    await net.nodes[0]!.submitTx(tx('persist=yes'));
    await waitFor(() => (net!.nodes[0]!.app as KvStoreApp).get('persist') === 'yes', 15_000, 'tx applied');
    const stoppedAt = net.nodes[0]!.height;
    await net.nodes[0]!.stop();

    // The rest keep going without it.
    await waitForHeight(net.nodes.slice(1), stoppedAt + 3n);

    const restarted = await net.makeNode(0, { dataDir: join(dir, 'n0') });
    net.nodes[0] = restarted;
    expect(restarted.height).toBe(stoppedAt);
    expect((restarted.app as KvStoreApp).get('persist')).toBe('yes');
    await restarted.start();
    await waitFor(() => restarted.height >= stoppedAt + 5n, 20_000, () => `restarted node to catch up (at ${restarted.height})`);
    // It must now be signing again: within a few blocks a commit carries its signature.
    const h = restarted.height;
    const idx = net.nodes[1]!.executor.state.validators.indexOf(restarted.privValidator!.address);
    const signedAt = (): bigint | null => {
      for (let x = h; x <= net!.nodes[1]!.height; x++) {
        const stored = net!.nodes[1]!.store.loadBlock(x);
        if (stored && stored.commit.signatures[idx] !== null) return x;
      }
      return null;
    };
    await waitFor(() => signedAt() !== null, 15_000, () => `restarted validator to sign (restarted at ${h}, now ${net!.nodes[1]!.height})`);
    expect(signedAt()! - h).toBeLessThan(20n);
    expect(toHex(blockHash(restarted.store.loadBlock(h)!.block))).toBe(toHex(blockHash(net.nodes[1]!.store.loadBlock(h)!.block)));
  });

  it('double-sign evidence is built, included in a block, and handed to the app', async () => {
    net = await makeTestnet({ validators: 4 });
    await waitForHeight(net.nodes, 2n);
    const victim = keyPairFromSeed(net.validatorSeed(3));
    const observer = net.nodes[0]!;
    const height = observer.consensus.height;
    const set = observer.executor.state.validators;
    const idx = set.indexOf(victim.address);
    const ctx = signContext(net.genesis.chainId, 'vote');
    const forge = (hash: Uint8Array): Vote => {
      const unsigned = { type: VoteType.Prevote, height, round: 0, blockHash: hash, validatorIndex: idx };
      return { ...unsigned, signature: sign(voteSignBytes(net!.genesis.chainId, unsigned), victim.secretKey, ctx) };
    };
    const a = forge(new Uint8Array(32).fill(1));
    const b = forge(new Uint8Array(32).fill(2));
    await observer.consensus.handleVote(a, 'forged');
    await observer.consensus.handleVote(b, 'forged');
    expect(observer.evidencePool.size).toBe(1);

    await waitFor(
      () => net!.nodes.every((n) => (n.app as KvStoreApp).slashed.some((m) => toHex(m.address) === toHex(victim.address))),
      20_000,
      'evidence to reach every app',
    );
    const m = (net.nodes[2]!.app as KvStoreApp).slashed[0]!;
    expect(m.height).toBe(height);
    expect(observer.evidencePool.size).toBe(0);
  });
});
