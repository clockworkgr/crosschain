import { describe, expect, it } from 'vitest';
import { decode, CodecError } from '../src/codec/reader.ts';
import { encode } from '../src/codec/writer.ts';
import { bytesEqual, sha256, toHex } from '../src/crypto/hash.ts';
import { addressOf, keyPairFromSeed, sign, signContext, verify } from '../src/crypto/keys.ts';
import { WorkerVerifier } from '../src/crypto/verifier.ts';
import { DoubleSignError, MemorySignStateStore, PrivValidator } from '../src/consensus/privval.ts';
import { KvStoreApp } from '../src/app/kvstore.ts';
import { Mempool } from '../src/mempool.ts';
import { decodeMessage, encodeMessage, type Message } from '../src/p2p/messages.ts';
import { ValidatorSet } from '../src/types/validator.ts';
import { VoteType } from '../src/types/vote.ts';
import { seedFor, tx } from './helpers.ts';

describe('codec', () => {
  it('round-trips every primitive', () => {
    const bytes = encode((w) => {
      w.u8(255).bool(true).u32(0xdeadbeef).u64(2n ** 64n - 1n).i64(-5n).bytes(new Uint8Array([1, 2, 3])).string('héllo');
      w.option(null, (w, v: number) => w.u8(v)).option(7, (w, v) => w.u8(v));
      w.array([1n, 2n], (w, x) => w.u64(x));
    });
    const out = decode(bytes, (r) => ({
      a: r.u8(),
      b: r.bool(),
      c: r.u32(),
      d: r.u64(),
      e: r.i64(),
      f: r.bytes(),
      g: r.string(),
      h: r.option((r) => r.u8()),
      i: r.option((r) => r.u8()),
      j: r.array((r) => r.u64()),
    }));
    expect(out).toEqual({ a: 255, b: true, c: 0xdeadbeef, d: 2n ** 64n - 1n, e: -5n, f: new Uint8Array([1, 2, 3]), g: 'héllo', h: null, i: 7, j: [1n, 2n] });
  });

  it('rejects truncated input, trailing bytes, and hostile lengths', () => {
    expect(() => decode(new Uint8Array([0, 0]), (r) => r.u32())).toThrow(CodecError);
    expect(() => decode(new Uint8Array([1, 2]), (r) => r.u8())).toThrow(/trailing/);
    expect(() => decode(new Uint8Array([0xff, 0xff, 0xff, 0xff]), (r) => r.bytes())).toThrow(CodecError);
    expect(() => decode(new Uint8Array([0xff, 0xff, 0xff, 0xff]), (r) => r.array((r) => r.u8()))).toThrow(CodecError);
  });

  it('round-trips p2p messages', () => {
    const msgs: Message[] = [
      { type: 'addrRequest' },
      { type: 'addrResponse', addrs: ['a:1', 'b:2'] },
      { type: 'status', height: 99n },
      { type: 'inv', kind: 1, hashes: [sha256(new Uint8Array([1]))] },
      { type: 'reject', code: 3, reason: 'nope' },
    ];
    for (const m of msgs) expect(decodeMessage(encodeMessage(m))).toEqual(m);
  });
});

describe('keys and signatures', () => {
  const kp = keyPairFromSeed(seedFor('k'));
  const msg = new TextEncoder().encode('msg');

  it('signs deterministically and binds the context', () => {
    const ctx = signContext('c', 'tx');
    const s1 = sign(msg, kp.secretKey, ctx);
    const s2 = sign(msg, kp.secretKey, ctx);
    expect(bytesEqual(s1, s2)).toBe(true);
    expect(verify(s1, msg, kp.publicKey, ctx)).toBe(true);
    expect(verify(s1, msg, kp.publicKey, signContext('c', 'vote'))).toBe(false);
    expect(verify(s1, msg, kp.publicKey, signContext('other', 'tx'))).toBe(false);
    expect(verify(s1, new Uint8Array([0]), kp.publicKey, ctx)).toBe(false);
  });

  it('derives the same key from the same seed and addresses are hashes', () => {
    expect(toHex(keyPairFromSeed(seedFor('k')).publicKey)).toBe(toHex(kp.publicKey));
    expect(toHex(addressOf(kp.publicKey))).toBe(toHex(sha256(kp.publicKey)));
  });

  it('verifies in worker threads', async () => {
    const pool = new WorkerVerifier(2);
    try {
      const ctx = signContext('c', 'tx');
      const jobs = Array.from({ length: 5 }, (_, i) => ({ sig: sign(msg, kp.secretKey, ctx), msg, publicKey: kp.publicKey, context: ctx }));
      jobs[2]!.sig = new Uint8Array(jobs[2]!.sig).fill(0, 0, 8);
      expect(await pool.verify(jobs)).toEqual([true, true, false, true, true]);
    } finally {
      await pool.close();
    }
  });
});

describe('validator set', () => {
  const keys = [0, 1, 2].map((i) => keyPairFromSeed(seedFor(`v${i}`)));

  it('picks proposers in proportion to voting power', () => {
    const set = ValidatorSet.create([
      { publicKey: keys[0]!.publicKey, power: 1n },
      { publicKey: keys[1]!.publicKey, power: 2n },
      { publicKey: keys[2]!.publicKey, power: 3n },
    ]);
    const counts = new Map<string, number>();
    let s = set;
    for (let i = 0; i < 600; i++) {
      const p = toHex(s.proposer().address);
      counts.set(p, (counts.get(p) ?? 0) + 1);
      s = s.copy();
      s.incrementProposerPriority(1);
    }
    expect(counts.get(toHex(keys[0]!.address))).toBe(100);
    expect(counts.get(toHex(keys[1]!.address))).toBe(200);
    expect(counts.get(toHex(keys[2]!.address))).toBe(300);
  });

  it('applies updates, hashes independently of priorities, and survives a codec round-trip', () => {
    const set = ValidatorSet.create([
      { publicKey: keys[0]!.publicKey, power: 5n },
      { publicKey: keys[1]!.publicKey, power: 5n },
    ]);
    const grown = set.applyUpdates([{ publicKey: keys[2]!.publicKey, power: 5n }]);
    expect(grown.size).toBe(3);
    expect(grown.byAddress(keys[2]!.address)!.priority).toBeLessThan(0n);
    const shrunk = grown.applyUpdates([{ publicKey: keys[0]!.publicKey, power: 0n }]);
    expect(shrunk.size).toBe(2);
    expect(() => shrunk.applyUpdates([{ publicKey: keys[0]!.publicKey, power: 0n }])).toThrow(/unknown/);
    const bumped = set.copy();
    bumped.incrementProposerPriority(3);
    expect(toHex(bumped.hash())).toBe(toHex(set.hash()));
    const back = decode(encode((w) => bumped.encode(w)), ValidatorSet.decode);
    expect(toHex(back.proposer().address)).toBe(toHex(bumped.proposer().address));
    expect(back.validators.map((v) => v.priority)).toEqual(bumped.validators.map((v) => v.priority));
  });
});

describe('private validator', () => {
  it('refuses to sign backwards or conflicting content, allows identical re-signs', () => {
    const pv = new PrivValidator(keyPairFromSeed(seedFor('pv')), new MemorySignStateStore(), 'c');
    const base = { type: VoteType.Prevote, height: 5n, round: 1, blockHash: null, validatorIndex: 0 };
    const sig = pv.signVote('c', base);
    expect(bytesEqual(pv.signVote('c', base), sig)).toBe(true);
    expect(() => pv.signVote('c', { ...base, blockHash: new Uint8Array(32) })).toThrow(DoubleSignError);
    expect(() => pv.signVote('c', { ...base, round: 0 })).toThrow(DoubleSignError);
    expect(() => pv.signVote('c', { ...base, height: 4n })).toThrow(DoubleSignError);
    expect(() => pv.signVote('c', { ...base, type: VoteType.Precommit })).not.toThrow();
    expect(() => pv.signVote('c', { ...base, type: VoteType.Prevote })).toThrow(DoubleSignError);
    expect(() => pv.signVote('c', { ...base, height: 6n, round: 0 })).not.toThrow();
  });
});

describe('mempool', () => {
  it('dedupes, rejects invalid, reaps FIFO, and drops committed transactions', async () => {
    const mp = new Mempool(new KvStoreApp(), { maxTxBytes: 64 });
    expect((await mp.addTx(tx('a=1'))).status).toBe('added');
    expect((await mp.addTx(tx('a=1'))).status).toBe('seen');
    expect((await mp.addTx(tx('bad'))).status).toBe('invalid');
    expect((await mp.addTx(new Uint8Array(100))).status).toBe('too-large');
    expect((await mp.addTx(tx('b=2'))).status).toBe('added');
    expect(mp.reap(1_000_000).map((t) => new TextDecoder().decode(t))).toEqual(['a=1', 'b=2']);
    expect(mp.reap(8).length).toBe(1);
    await mp.update([tx('a=1')]);
    expect(mp.size).toBe(1);
  });
});
