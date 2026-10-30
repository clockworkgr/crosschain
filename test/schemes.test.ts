import { secp256k1 } from '@noble/curves/secp256k1.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreApp } from '../src/app/core/app.ts';
import { makeAuthority } from '../src/app/core/authority.ts';
import { signedTxBytes, withFees } from '../src/app/core/client.ts';
import { appGenesisBytes, authorityJson, DEFAULT_FEES } from '../src/app/core/genesis.ts';
import { TYPE } from '../src/app/core/types.ts';
import { decode } from '../src/codec/reader.ts';
import { encode } from '../src/codec/writer.ts';
import { toHex } from '../src/crypto/hash.ts';
import { decodePublicKey, decodeSignature, generateSeed, isPublicKey, keyPairFromSeed, publicKeySize, Scheme, schemeOf, sign, signContext, signatureSize, verify } from '../src/crypto/keys.ts';
import { objectId } from '../src/db/id.ts';
import { RpcClient } from '../src/rpc/client.ts';
import { RpcServer } from '../src/rpc/server.ts';
import { genesisState } from '../src/types/state.ts';
import { Keystore } from '../src/wallet/keystore.ts';
import { makeTestnet, seedFor, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const FAUCET_ID = objectId(TYPE.account, 0);
const msg = new TextEncoder().encode('a message to sign');

describe('signature schemes', () => {
  it('signs and verifies under each scheme, with tagged keys and signatures that tell them apart', () => {
    const ctx = signContext('chain', 'tx');
    for (const scheme of [Scheme.mlDsa44, Scheme.secp256k1]) {
      const kp = keyPairFromSeed(seedFor(`schemes/${scheme}`), scheme);
      expect(kp.scheme).toBe(scheme);
      expect(kp.publicKey[0]).toBe(scheme);
      expect(kp.publicKey.length).toBe(publicKeySize(scheme));
      const sig = sign(msg, kp.secretKey, ctx);
      expect(sig[0]).toBe(scheme);
      expect(sig.length).toBe(signatureSize(scheme));
      expect(verify(sig, msg, kp.publicKey, ctx)).toBe(true);
      expect(verify(sig, msg, kp.publicKey, signContext('chain', 'vote'))).toBe(false);
      expect(verify(sig, new Uint8Array([...msg, 1]), kp.publicKey, ctx)).toBe(false);
      const tampered = sig.slice();
      tampered[7] ^= 1;
      expect(verify(tampered, msg, kp.publicKey, ctx)).toBe(false);
      // Deterministic: one message, one signature, one hash of anything signed.
      expect(sign(msg, kp.secretKey, ctx)).toEqual(sig);
      // The tag is what a decoder reads the size from.
      const back = decode(encode((w) => w.fixed(kp.publicKey).fixed(sig)), (r) => ({ publicKey: decodePublicKey(r), sig: decodeSignature(r) }));
      expect(back.publicKey).toEqual(kp.publicKey);
      expect(back.sig).toEqual(sig);
      expect(keyPairFromSeed(generateSeed(scheme), scheme).scheme).toBe(scheme);
    }
    // One seed, two schemes: two keys, two addresses, and neither verifies the other's signature.
    const seed = seedFor('schemes/shared');
    const ml = keyPairFromSeed(seed, Scheme.mlDsa44);
    const ec = keyPairFromSeed(seed, Scheme.secp256k1);
    expect(toHex(ml.address)).not.toBe(toHex(ec.address));
    expect(verify(sign(msg, ml.secretKey, ctx), msg, ec.publicKey, ctx)).toBe(false);
    expect(verify(sign(msg, ec.secretKey, ctx), msg, ml.publicKey, ctx)).toBe(false);
    expect(schemeOf(ec.publicKey)).toBe(Scheme.secp256k1);
    expect(isPublicKey(ec.publicKey.subarray(0, 20))).toBe(false);
    expect(() => decode(new Uint8Array([9, 1, 2, 3]), decodePublicKey)).toThrow(/unknown signature scheme 9/);
    expect(() => decode(new Uint8Array([0, 1, 2, 3]), decodeSignature)).toThrow(/unknown signature scheme 0/);
  });

  it('refuses the high-S twin of a secp256k1 signature, so a signed object has one encoding', () => {
    const ctx = signContext('chain', 'tx');
    const kp = keyPairFromSeed(seedFor('schemes/lowS'), Scheme.secp256k1);
    const sig = sign(msg, kp.secretKey, ctx);
    const n = secp256k1.Point.Fn.ORDER;
    const s = BigInt('0x' + toHex(sig.subarray(33)));
    const twin = new Uint8Array(sig);
    twin.set(Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex'), 33);
    expect(verify(sig, msg, kp.publicKey, ctx)).toBe(true);
    expect(verify(twin, msg, kp.publicKey, ctx)).toBe(false);
  });

  it('keeps each key\'s scheme in the keystore, and reads an old file as ML-DSA-44', () => {
    const dir = mkdtempSync(join(tmpdir(), 'schemes-'));
    try {
      const path = join(dir, 'keystore.json');
      const ks = Keystore.create(path, 'pw');
      const ml = ks.add('ml');
      const ec = ks.add('ec', undefined, Scheme.secp256k1);
      const again = Keystore.open(path, 'pw');
      expect(again.get('ml').scheme).toBe(ml.scheme);
      expect(again.get('ec').scheme).toBe(Scheme.secp256k1);
      expect(toHex(again.get('ec').publicKey)).toBe(toHex(ec.publicKey));
      expect(again.list().map((k) => [k.name, k.scheme])).toEqual([
        ['ml', ml.scheme === Scheme.mlDsa44 ? 'ml-dsa-44' : 'secp256k1'],
        ['ec', 'secp256k1'],
      ]);
      // A file from before there were two schemes names none; its keys are ML-DSA-44.
      const file = JSON.parse(readFileSync(path, 'utf8')) as { keys: Record<string, { scheme?: string }> };
      delete file.keys['ml']!.scheme;
      writeFileSync(path, JSON.stringify(file));
      const old = Keystore.open(path, 'pw');
      expect(old.get('ml').scheme).toBe(Scheme.mlDsa44);
      expect(old.list()[0]!.scheme).toBe('ml-dsa-44');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a genesis whose validator keys are not of the scheme it names', () => {
    const ml = keyPairFromSeed(seedFor('schemes/genesis'), Scheme.mlDsa44);
    const ec = keyPairFromSeed(seedFor('schemes/genesis'), Scheme.secp256k1);
    const base = { chainId: 'g', genesisTime: 0n, appState: new Uint8Array() };
    expect(() => genesisState({ ...base, signatureScheme: 'secp256k1', validators: [{ publicKey: ml.publicKey, power: 1n }] }, new Uint8Array(32))).toThrow(/not a secp256k1 key/);
    expect(() => genesisState({ ...base, validators: [{ publicKey: ec.publicKey, power: 1n }] }, new Uint8Array(32))).toThrow(/not a ml-dsa-44 key/);
    expect(genesisState({ ...base, signatureScheme: 'secp256k1', validators: [{ publicKey: ec.publicKey, power: 1n }] }, new Uint8Array(32)).scheme).toBe(Scheme.secp256k1);
    expect(genesisState({ ...base, validators: [{ publicKey: ml.publicKey, power: 1n }] }, new Uint8Array(32)).scheme).toBe(Scheme.mlDsa44);
  });
});

describe('a chain on secp256k1', () => {
  let net: Testnet | null = null;
  let server: RpcServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
    await net?.stop();
    net = null;
  });

  it('runs on secp256k1 keys end to end and refuses keys and signatures of the other scheme', async () => {
    const faucet = keyPairFromSeed(seedFor('schemes/faucet'), Scheme.secp256k1);
    const alice = keyPairFromSeed(seedFor('schemes/alice'), Scheme.secp256k1);
    const stranger = keyPairFromSeed(seedFor('schemes/alice'), Scheme.mlDsa44);
    net = await makeTestnet({
      validators: 4,
      scheme: Scheme.secp256k1,
      appFor: (_i, _d, genesis) => new CoreApp({ genesis, verifier }),
      appState: new TextDecoder().decode(appGenesisBytes({ accounts: [{ name: 'faucet', owner: authorityJson([faucet.publicKey]), active: authorityJson([faucet.publicKey]), balance: '1000000000' }], staking: { inflationMinBps: 0, inflationMaxBps: 0 } })),
    });
    const node = net.nodes[0]!;
    const chainId = net.genesis.chainId;
    await waitForHeight(net.nodes, 3n);
    expect(node.executor.state.scheme).toBe(Scheme.secp256k1);
    expect(node.nodeKey.scheme).toBe(Scheme.secp256k1);
    // Commits are made of 65-byte signatures: a tag and 64 bytes, against 2421 for ML-DSA-44.
    const commit = node.store.loadBlock(2n)!.commit;
    expect(commit.signatures.some((s) => s !== null && s.length === signatureSize(Scheme.secp256k1))).toBe(true);
    server = new RpcServer(node, { port: 0 });
    await server.start();
    const rpc = new RpcClient(server.url);
    expect(((await rpc.call('status', {})) as { signatureScheme: string }).signatureScheme).toBe('secp256k1');

    // A transaction signed with a secp256k1 key lands.
    const exp = () => BigInt(Date.now()) + 60_000n;
    const create = signedTxBytes(chainId, { expiration: exp(), operations: withFees([{ type: 'accountCreate', registrar: FAUCET_ID, name: 'alice', owner: makeAuthority([alice.publicKey]), active: makeAuthority([alice.publicKey]) }], DEFAULT_FEES) }, [faucet]);
    expect((await node.submitTx(create)).status).toBe('added');
    await waitFor(() => node.store.txLocation(new Uint8Array(32)) === null && (node.app as CoreApp).accountByName('alice') !== null, 15_000, 'alice to be created');

    // The same operation with an ML-DSA key in the authority is refused for its scheme, before anything else.
    const wrongKey = signedTxBytes(chainId, { expiration: exp(), operations: withFees([{ type: 'accountCreate', registrar: FAUCET_ID, name: 'bob', owner: makeAuthority([stranger.publicKey]), active: makeAuthority([stranger.publicKey]) }], DEFAULT_FEES) }, [faucet]);
    expect((await node.submitTx(wrongKey)).error).toMatch(/must be a secp256k1 key/);
    // A validator whose consensus key is of the other scheme, likewise.
    const wrongValidator = signedTxBytes(chainId, { expiration: exp(), operations: withFees([{ type: 'validatorCreate', operator: FAUCET_ID, consensusKey: stranger.publicKey, selfBond: 1000n }], DEFAULT_FEES) }, [faucet]);
    expect((await node.submitTx(wrongValidator)).error).toMatch(/consensus key must be a secp256k1 key/);
    // A signature of the other scheme, even under the right address, is refused for its scheme.
    const body = { expiration: exp(), operations: withFees([{ type: 'transfer' as const, from: FAUCET_ID, to: objectId(TYPE.account, 1), asset: objectId(TYPE.asset, 0), amount: 1n }], DEFAULT_FEES) };
    const mlTwin = keyPairFromSeed(seedFor('schemes/faucet'), Scheme.mlDsa44);
    const forged = signedTxBytes(chainId, body, [mlTwin]);
    const { decodeTransaction, encodeTransaction } = await import('../src/app/core/tx.ts');
    const parsed = decodeTransaction(forged);
    const relabelled = encodeTransaction({ ...parsed, signatures: [{ address: faucet.address, signature: parsed.signatures[0]!.signature }] });
    expect((await node.submitTx(relabelled)).error).toMatch(/another scheme/);
  });
});
