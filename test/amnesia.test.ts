/**
 * The lock a precommit takes, and the evidence of one forgotten: the proof-of-lock round a prevote signs, the
 * private validator's durable lock and what it refuses to sign with it, the two kinds of evidence, a validator
 * restarted in the height it locked in, and a forgotten lock found from votes and punished by the application.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KvStoreApp } from '../src/app/kvstore.ts';
import { Reader } from '../src/codec/reader.ts';
import { encode } from '../src/codec/writer.ts';
import { verifyEvidence } from '../src/consensus/evidence.ts';
import { DoubleSignError, FileSignStateStore, MemorySignStateStore, PrivValidator, SignStep } from '../src/consensus/privval.ts';
import { HeightVoteSet, VoteSet } from '../src/consensus/votes.ts';
import { toHex } from '../src/crypto/hash.ts';
import { DEFAULT_SCHEME, keyPairFromSeed, sign, signContext, zeroSignature, type KeyPair } from '../src/crypto/keys.ts';
import { checkEvidenceShape, decodeEvidence, encodeEvidence, evidenceHeight, evidenceKey, evidenceValidator, isAmnesia, makeDuplicateVoteEvidence, type AmnesiaEvidence, type Evidence } from '../src/types/evidence.ts';
import { decodeMessage } from '../src/p2p/messages.ts';
import { blockHash } from '../src/types/block.ts';
import { ValidatorSet } from '../src/types/validator.ts';
import { VoteType, checkPolRound, decodeVote, encodeVote, voteSignBytes, type UnsignedVote, type Vote } from '../src/types/vote.ts';
import { makeTestnet, seedFor, sleep, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const CHAIN = 'amnesia';
const key = keyPairFromSeed(seedFor('amnesia/val'));
const other = keyPairFromSeed(seedFor('amnesia/other'));
const block = (fill: number) => new Uint8Array(32).fill(fill);

function signed(v: UnsignedVote, by: KeyPair = key, chainId = CHAIN): Vote {
  return { ...v, signature: sign(voteSignBytes(chainId, v), by.secretKey, signContext(chainId, 'vote')) };
}
const precommit = (round: number, hash: Uint8Array | null, validatorIndex = 0, height = 7n) => signed({ type: VoteType.Precommit, height, round, blockHash: hash, polRound: -1, validatorIndex });
const prevote = (round: number, hash: Uint8Array | null, polRound = -1, validatorIndex = 0, height = 7n) => signed({ type: VoteType.Prevote, height, round, blockHash: hash, polRound, validatorIndex });

describe('a forgotten lock', () => {
  let net: Testnet | null = null;
  let tmp: string | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('signs into a prevote the proof-of-lock round it relies on, and counts two votes that differ in it alone as a double sign', async () => {
    const base: UnsignedVote = { type: VoteType.Prevote, height: 7n, round: 3, blockHash: block(1), polRound: -1, validatorIndex: 0 };
    // Only a prevote for a block names a round, and one before its own.
    expect(checkPolRound(base)).toBeNull();
    expect(checkPolRound({ ...base, polRound: 0 })).toBeNull();
    expect(checkPolRound({ ...base, polRound: 2 })).toBeNull();
    expect(checkPolRound({ ...base, polRound: 3 })).toMatch(/before the vote's own/);
    expect(checkPolRound({ ...base, polRound: -2 })).toMatch(/before the vote's own/);
    expect(checkPolRound({ ...base, polRound: 0.5 })).toMatch(/whole number/);
    expect(checkPolRound({ ...base, blockHash: null, polRound: 1 })).toMatch(/only a prevote for a block/);
    expect(checkPolRound({ ...base, type: VoteType.Precommit, polRound: 1 })).toMatch(/only a prevote for a block/);
    expect(checkPolRound({ ...base, type: VoteType.Precommit })).toBeNull();
    // The round is signed: the same vote naming another is other bytes, and a signature for one is none for the other.
    expect(voteSignBytes(CHAIN, { ...base, polRound: 1 })).not.toEqual(voteSignBytes(CHAIN, base));
    const set = ValidatorSet.create([{ publicKey: key.publicKey, power: 1n }]);
    const a = signed(base);
    const b = signed({ ...base, polRound: 1 });
    // A vote comes back from its encoding with the round, and one that names a round it may not is not decoded.
    expect(decodeVote(new Reader(encode((w) => encodeVote(w, b))))).toEqual(b);
    expect(() => decodeVote(new Reader(encode((w) => encodeVote(w, { ...b, polRound: 3 }))))).toThrow(/before the vote's own/);
    expect(() => decodeVote(new Reader(encode((w) => encodeVote(w, { ...precommit(0, block(1)), polRound: 0 }))))).toThrow(/only a prevote/);

    // In a vote set the second is a conflict with the first, not the first again.
    const votes = new VoteSet(7n, 3, VoteType.Prevote, set);
    expect(votes.add(a)).toEqual({ added: true, conflict: null });
    expect(votes.add(a)).toEqual({ added: false, conflict: null });
    expect(votes.add(b)).toEqual({ added: false, conflict: a });
    const twice = makeDuplicateVoteEvidence(b, a);
    expect(twice).toEqual({ kind: 'duplicateVote', voteA: a, voteB: b }); // the lower round first
    expect(checkEvidenceShape(twice)).toBeNull();
    expect(checkEvidenceShape({ ...twice, voteA: b, voteB: a })).toMatch(/canonical order/);
    expect(checkEvidenceShape({ ...twice, voteB: a })).toMatch(/the same/);
    expect(await verifyEvidence(CHAIN, twice, set, verifier)).toBeNull();
    // A signature made for the vote naming one round does not carry over to the other.
    expect(await verifyEvidence(CHAIN, { ...twice, voteB: { ...b, signature: a.signature } }, set, verifier)).toMatch(/bad signature/);
  });

  it('writes the lock with the precommit that takes it, and signs a prevote for another block only on a proof of lock from that round on', () => {
    tmp = mkdtempSync(join(tmpdir(), 'lock-'));
    const path = join(tmp, 'priv_validator_state.bin');
    const vote = (type: VoteType, round: number, hash: Uint8Array | null, polRound = -1, height = 7n): UnsignedVote => ({ type, height, round, blockHash: hash, polRound, validatorIndex: 0 });
    let pv = new PrivValidator(key, new FileSignStateStore(path), CHAIN);
    expect(pv.lockAt(7n)).toBeNull();
    pv.signVote(CHAIN, vote(VoteType.Prevote, 0, block(1)));
    expect(pv.lockAt(7n)).toBeNull(); // a prevote locks nothing
    pv.signVote(CHAIN, vote(VoteType.Precommit, 0, null));
    expect(pv.lockAt(7n)).toBeNull(); // nor does a precommit for nil
    pv.signVote(CHAIN, vote(VoteType.Prevote, 1, block(1)));
    pv.signVote(CHAIN, vote(VoteType.Precommit, 1, block(1)));
    expect(pv.lockAt(7n)).toEqual({ height: 7n, round: 1, blockHash: block(1) });
    expect(pv.lockAt(8n)).toBeNull();

    // The process dies; the lock is in the file the precommit's signature is in.
    expect(new FileSignStateStore(path).load()).toMatchObject({ height: 7n, round: 1, step: SignStep.Precommit, lock: { height: 7n, round: 1, blockHash: block(1) } });
    pv = new PrivValidator(key, new FileSignStateStore(path), CHAIN);
    expect(pv.lockAt(7n)).toEqual({ height: 7n, round: 1, blockHash: block(1) });

    // Another block, fresh or on a majority from before the lock: refused, and refusing signs nothing.
    expect(() => pv.signVote(CHAIN, vote(VoteType.Prevote, 2, block(2)))).toThrow(DoubleSignError);
    expect(() => pv.signVote(CHAIN, vote(VoteType.Prevote, 2, block(2), 0))).toThrow(/locked in round 1/);
    expect(pv.lastSigned()).toEqual({ height: 7n, round: 1, step: SignStep.Precommit });
    // A vote that names a round it may not is not signed either.
    expect(() => pv.signVote(CHAIN, vote(VoteType.Prevote, 2, block(2), 2))).toThrow(/before the vote's own/);
    // Nil is always open, and a precommit for nil keeps the lock. The locked block is prevoted on the majority the
    // lock stands on, not on an older one: the lock may have moved, and an older round would not answer for that.
    pv.signVote(CHAIN, vote(VoteType.Prevote, 2, null));
    pv.signVote(CHAIN, vote(VoteType.Precommit, 2, null));
    expect(() => pv.signVote(CHAIN, vote(VoteType.Prevote, 3, block(1), 0))).toThrow(/locked in round 1/);
    expect(() => pv.signVote(CHAIN, vote(VoteType.Prevote, 3, block(1)))).toThrow(/locked in round 1/);
    pv.signVote(CHAIN, vote(VoteType.Prevote, 3, block(1), 1));
    expect(pv.lockAt(7n)).toMatchObject({ round: 1 });
    // A majority for the other block in the round of the lock or a later one releases it, and a precommit for that block moves the lock.
    pv.signVote(CHAIN, vote(VoteType.Prevote, 4, block(2), 1));
    pv.signVote(CHAIN, vote(VoteType.Precommit, 4, block(2)));
    expect(pv.lockAt(7n)).toEqual({ height: 7n, round: 4, blockHash: block(2) });
    expect(() => pv.signVote(CHAIN, vote(VoteType.Prevote, 5, block(1), 3))).toThrow(/locked in round 4/);
    // A proposal is signed with the lock kept, and the next height starts with none.
    pv.signProposal(CHAIN, { height: 7n, round: 6, polRound: -1, block: { header: { chainId: CHAIN, version: 1, height: 7n, time: 1n, lastBlockHash: block(0), lastCommitHash: block(0), dataHash: block(0), lastResultsHash: block(0), validatorsHash: block(0), nextValidatorsHash: block(0), appHash: block(0), evidenceHash: block(0), proposerAddress: block(0), prioritiesHash: block(0) }, txs: [], lastCommit: null, evidence: [] } });
    expect(new FileSignStateStore(path).load()!.lock).toEqual({ height: 7n, round: 4, blockHash: block(2) });
    pv.signVote(CHAIN, vote(VoteType.Prevote, 0, block(3), -1, 8n));
    expect(pv.lockAt(8n)).toBeNull();
    expect(new FileSignStateStore(path).load()!.lock).toBeNull();

    // A lock that moved and came back. Locked on block 1 in round 1, then on block 2 in round 2 (a majority seen after
    // prevoting nil), then block 2 is proposed again with the old majority of round 0 behind it. Naming round 0, or
    // nothing, beside the precommit of round 1 would be the evidence of a forgotten lock; naming round 2 is not.
    const moved = new PrivValidator(other, new MemorySignStateStore(), CHAIN);
    const sign = (v: UnsignedVote): Vote => ({ ...v, signature: moved.signVote(CHAIN, v) });
    const first = sign(vote(VoteType.Precommit, 1, block(1)));
    sign(vote(VoteType.Prevote, 2, null));
    const second = sign(vote(VoteType.Precommit, 2, block(2)));
    expect(isAmnesia(first, { ...vote(VoteType.Prevote, 3, block(2), 0), signature: new Uint8Array(0) })).toBe(true);
    expect(() => sign(vote(VoteType.Prevote, 3, block(2), 0))).toThrow(/locked in round 2/);
    expect(() => sign(vote(VoteType.Prevote, 3, block(2)))).toThrow(/locked in round 2/);
    const again = sign(vote(VoteType.Prevote, 3, block(2), 2));
    expect(isAmnesia(first, again)).toBe(false);
    expect(isAmnesia(second, again)).toBe(false);

    // A guard in memory keeps the same rule.
    const mem = new PrivValidator(key, new MemorySignStateStore(), CHAIN);
    mem.signVote(CHAIN, vote(VoteType.Precommit, 0, block(1)));
    expect(() => mem.signVote(CHAIN, vote(VoteType.Prevote, 1, block(2)))).toThrow(DoubleSignError);
  });

  it('proves a forgotten lock with a precommit and a later prevote for another block that names no round from the lock on', async () => {
    const set = ValidatorSet.create([{ publicKey: key.publicKey, power: 1n }]);
    const ev = (c: Vote, p: Vote): AmnesiaEvidence => ({ kind: 'amnesia', precommit: c, prevote: p });
    const good = ev(precommit(2, block(1)), prevote(5, block(2), 1));
    expect(checkEvidenceShape(good)).toBeNull();
    expect(isAmnesia(good.precommit, good.prevote)).toBe(true);
    expect(checkEvidenceShape(ev(precommit(2, block(1)), prevote(3, block(2))))).toBeNull(); // a fresh proposal, no round named

    // What a validator may do after a precommit is no evidence, nor is anything a precommit and a prevote do not show.
    const not: [Evidence, RegExp][] = [
      [ev(precommit(2, block(1)), prevote(5, block(2), 2)), /at or after the precommit/], // a majority in the round of the lock
      [ev(precommit(2, block(1)), prevote(5, block(2), 4)), /at or after the precommit/], // or a later one
      [ev(precommit(2, block(1)), prevote(5, block(1), 0)), /same block/],
      [ev(precommit(2, block(1)), prevote(5, null)), /nil forgets no lock/],
      [ev(precommit(2, null), prevote(5, block(2))), /nil forgets no lock/],
      [ev(precommit(2, block(1)), prevote(2, block(2))), /not after the precommit/], // the prevote of the same round came first
      [ev(precommit(2, block(1)), prevote(1, block(2))), /not after the precommit/],
      [ev(precommit(2, block(1)), prevote(5, block(2), 1, 0, 8n)), /heights differ/],
      [ev(precommit(2, block(1)), prevote(5, block(2), 1, 1)), /validators differ/],
      [ev(prevote(2, block(1)), prevote(5, block(2), 1)), /a precommit and a prevote/],
      [ev(precommit(2, block(1)), precommit(5, block(2))), /a precommit and a prevote/],
    ];
    for (const [e, why] of not) {
      expect(checkEvidenceShape(e)).toMatch(why);
      const [c, p] = [(e as AmnesiaEvidence).precommit, (e as AmnesiaEvidence).prevote];
      expect(isAmnesia(c, p)).toBe(false);
    }

    // One offence a validator and height, whichever votes show it; a double sign is keyed by its round and type.
    expect(evidenceKey(good)).toBe('amnesia/7/0');
    expect(evidenceKey(ev(precommit(0, block(3)), prevote(1, block(4))))).toBe(evidenceKey(good));
    expect(evidenceKey(makeDuplicateVoteEvidence(prevote(5, block(1)), prevote(5, block(2))))).toBe('7/5/1/0');
    expect(evidenceHeight(good)).toBe(7n);
    expect(evidenceValidator(good)).toBe(0);

    // Both kinds come back from their encoding as they went, and a kind nobody knows is refused.
    const twice = makeDuplicateVoteEvidence(prevote(5, block(2)), prevote(5, block(1)));
    for (const e of [good, twice]) expect(decodeEvidence(new Reader(encode((w) => encodeEvidence(w, e))))).toEqual(e);
    const bytes = encode((w) => encodeEvidence(w, good));
    expect(bytes[0]).toBe(2);
    expect(encode((w) => encodeEvidence(w, twice))[0]).toBe(1);
    expect(() => decodeEvidence(new Reader(new Uint8Array([3, ...bytes.subarray(1)])))).toThrow(/unknown evidence kind 3/);

    // Both signatures are the accused's, over the votes as given.
    expect(await verifyEvidence(CHAIN, good, set, verifier)).toBeNull();
    expect(await verifyEvidence(CHAIN, ev(good.precommit, { ...good.prevote, polRound: 0 }), set, verifier)).toMatch(/bad signature/);
    expect(await verifyEvidence(CHAIN, ev(good.precommit, signed({ ...good.prevote }, other)), set, verifier)).toMatch(/bad signature/);
    expect(await verifyEvidence('another-chain', good, set, verifier)).toMatch(/bad signature/);
    expect(await verifyEvidence(CHAIN, ev(precommit(2, block(1), 4), prevote(5, block(2), 1, 4)), set, verifier)).toMatch(/unknown validator/);
    expect(await verifyEvidence(CHAIN, not[0]![0], set, verifier)).toMatch(/at or after the precommit/);
  });

  it('takes its lock up again after a restart in the same height, and commits nothing else there', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'relock-'));
    net = await makeTestnet({ validators: 1, dataDirFor: () => tmp });
    const node = net.nodes[0]!;
    await waitForHeight([node], 3n);
    const h = node.height;
    await node.stop();
    // The node had precommitted a block of the next height in round 0 when it died; the block itself is gone with it.
    const locked = block(9);
    const store = new FileSignStateStore(join(tmp, 'priv_validator_state.bin'));
    store.save({ height: h + 1n, round: 0, step: SignStep.Precommit, signBytes: new Uint8Array([1]), signature: zeroSignature(DEFAULT_SCHEME), lock: { height: h + 1n, round: 0, blockHash: locked } });
    const restarted = await net.makeNode(0);
    net.nodes[0] = restarted;
    await restarted.start();
    expect(restarted.consensus.lockedRound).toBe(0);
    expect(restarted.consensus.lockedHash).toEqual(locked);
    expect(restarted.consensus.status().locked).toBe(toHex(locked).slice(0, 12));
    // The only validator proposes fresh blocks round after round and prevotes none of them: it promised the one it
    // precommitted. Without the lock it would commit the first of them, beside whatever its precommit helped decide.
    await waitFor(() => restarted.consensus.round >= 3, 20_000, () => `rounds to pass (${restarted.consensus.round})`);
    expect(restarted.height).toBe(h);
    expect(restarted.store.loadBlock(h + 1n)).toBeNull();
    expect(restarted.consensus.lockedRound).toBe(0);
  });

  it('finds a forgotten lock in the votes it holds, whichever came last, and has every application punish it as one', async () => {
    net = await makeTestnet({ validators: 4 });
    const chainId = net.genesis.chainId;
    await waitForHeight(net.nodes, 2n);
    const apps = net.nodes.map((n) => n.app as KvStoreApp);
    const forge = (victim: number, height: bigint, unsigned: Omit<UnsignedVote, 'height' | 'validatorIndex'>): Vote => {
      const k = keyPairFromSeed(net!.validatorSeed(victim));
      const set = net!.nodes[0]!.executor.validatorSetAtHeight(height)!;
      return signed({ ...unsigned, height, validatorIndex: set.indexOf(k.address) }, k, chainId);
    };
    // Votes for the next height are held until it starts, so they are all there whatever the height does meanwhile.
    // One validator at a time: votes of more than a third of the power in a later round would take every node there.
    const give = async (node: number, votes: (height: bigint) => Vote[]) => {
      const height = net!.nodes[node]!.consensus.height + 1n;
      for (const v of votes(height)) await net!.nodes[node]!.consensus.handleVote(v, null);
      await waitForHeight(net!.nodes, height + 1n);
      return height;
    };
    const c = (round: number, fill: number) => ({ type: VoteType.Precommit, round, blockHash: block(fill), polRound: -1 });
    const p = (round: number, fill: number, polRound: number) => ({ type: VoteType.Prevote, round, blockHash: block(fill), polRound });

    // Validator 3 precommitted one block in round 4 and prevoted another in round 6 on a majority it dates to round 2.
    const first = await give(0, (h) => [forge(3, h, c(4, 1)), forge(3, h, p(6, 2, 2))]);
    // Validator 2 the same, heard of by another node in the other order, with no round named at all.
    const second = await give(1, (h) => [forge(2, h, p(6, 2, -1)), forge(2, h, c(4, 1))]);
    // Validator 1 did what the rules allow: its prevote names a majority in the round after its precommit.
    const third = await give(2, (h) => [forge(1, h, c(4, 1)), forge(1, h, p(6, 2, 5))]);

    const address = (i: number) => keyPairFromSeed(net!.validatorSeed(i)).address;
    const punished = (app: KvStoreApp, i: number, height: bigint) => app.slashed.filter((m) => m.height === height && toHex(m.address) === toHex(address(i)));
    await waitFor(() => apps.every((a) => punished(a, 3, first).length === 1 && punished(a, 2, second).length === 1), 30_000, 'both forgotten locks to reach every application');
    for (const a of apps) {
      expect(punished(a, 3, first)[0]!.kind).toBe('amnesia');
      expect(punished(a, 2, second)[0]!.kind).toBe('amnesia');
    }
    // The blocks that carried them hold the two votes each, as evidence of that kind.
    const carried: Evidence[] = [];
    for (let h = 1n; h <= net.nodes[0]!.height; h++) carried.push(...net.nodes[0]!.store.loadBlock(h)!.block.evidence);
    expect(carried.map((e) => e.kind).sort()).toEqual(['amnesia', 'amnesia']);
    expect(carried.map(evidenceKey).sort()).toEqual([`amnesia/${second}/${net.nodes[0]!.executor.validatorSetAtHeight(second)!.indexOf(address(2))}`, `amnesia/${first}/${net.nodes[0]!.executor.validatorSetAtHeight(first)!.indexOf(address(3))}`].sort());
    // Nothing was made of validator 1's votes, then or a few blocks on.
    await sleep(1500);
    expect(apps.every((a) => punished(a, 1, third).length === 0)).toBe(true);
    expect(apps.every((a) => a.slashed.length === 2)).toBe(true);
  });
});

describe('a prevote that names a proof of lock', () => {
  let net: Testnet | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
  });

  it('counts for its block only once the majority it names is held, however the votes arrive', () => {
    const keys = [0, 1, 2, 3].map((i) => keyPairFromSeed(seedFor(`amnesia/set/${i}`)));
    const set = ValidatorSet.create(keys.map((k) => ({ publicKey: k.publicKey, power: 1n })));
    const by = (i: number) => keys.find((k) => toHex(k.address) === toHex(set.byIndex(i)!.address))!;
    const pre = (i: number, round: number, hash: Uint8Array | null, polRound = -1) => signed({ type: VoteType.Prevote, height: 7n, round, blockHash: hash, polRound, validatorIndex: i }, by(i));
    const X = block(1);
    const Y = block(2);

    // Three of four prevote X in round 3 on a majority of round 1 this node has not seen: votes cast, none for X yet.
    let hvs = new HeightVoteSet(7n, set);
    for (const i of [0, 1, 2]) expect(hvs.add(pre(i, 3, X, 1))).toEqual({ added: true, conflict: null });
    expect(hvs.prevotes(3).hasQuorumAny()).toBe(true);
    expect(hvs.prevotes(3).hasQuorumFor(X)).toBe(false);
    expect(hvs.prevotes(3).quorumValue()).toBeUndefined();
    expect(hvs.roundPower(3)).toBe(3n);
    expect(hvs.prevotes(3).all().length).toBe(3);
    // Round 1's prevotes arrive: two are no majority, the third is, and round 3 has its own at once.
    hvs.add(pre(0, 1, X));
    hvs.add(pre(1, 1, X));
    expect(hvs.prevotes(3).hasQuorumFor(X)).toBe(false);
    hvs.add(pre(3, 1, X));
    expect(hvs.prevotes(1).hasQuorumFor(X)).toBe(true);
    expect(hvs.prevotes(3).hasQuorumFor(X)).toBe(true);
    expect(hvs.prevotes(3).quorumValue()).toEqual(X);
    // A vote naming a majority already held counts as it comes, and the same vote twice is still one.
    expect(hvs.add(pre(3, 3, X, 1))).toEqual({ added: true, conflict: null });
    expect(hvs.add(pre(3, 3, X, 1))).toEqual({ added: false, conflict: null });
    expect(hvs.has(pre(3, 3, X, 1))).toBe(true);
    expect(hvs.has(pre(3, 3, X, 0))).toBe(false);

    // A line of them, latest first: round 5 on round 3, round 3 on round 1. The last vote of round 1 counts them all.
    hvs = new HeightVoteSet(7n, set);
    for (const i of [0, 1, 2]) hvs.add(pre(i, 5, X, 3));
    for (const i of [1, 2, 3]) hvs.add(pre(i, 3, X, 1));
    for (const i of [0, 1]) hvs.add(pre(i, 1, X));
    expect([1, 3, 5].map((r) => hvs.prevotes(r).hasQuorumFor(X))).toEqual([false, false, false]);
    hvs.add(pre(2, 1, X));
    expect([1, 3, 5].map((r) => hvs.prevotes(r).hasQuorumFor(X))).toEqual([true, true, true]);

    // A majority for another block in the round named backs nothing, nor does a majority in another round.
    hvs = new HeightVoteSet(7n, set);
    for (const i of [0, 1, 2]) hvs.add(pre(i, 1, Y));
    for (const i of [0, 1, 2]) hvs.add(pre(i, 2, X));
    for (const i of [0, 1, 2]) hvs.add(pre(i, 4, X, 1));
    expect(hvs.prevotes(1).hasQuorumFor(Y)).toBe(true);
    expect(hvs.prevotes(2).hasQuorumFor(X)).toBe(true);
    expect(hvs.prevotes(4).hasQuorumFor(X)).toBe(false);
    // Votes that name nothing wait for nothing: a fresh block, nil, and every precommit.
    for (const i of [0, 1, 2]) hvs.add(pre(i, 6, null));
    expect(hvs.prevotes(6).hasQuorumFor(null)).toBe(true);
    for (const i of [0, 1, 2]) hvs.add(signed({ type: VoteType.Precommit, height: 7n, round: 4, blockHash: X, polRound: -1, validatorIndex: i }, by(i)));
    expect(hvs.precommits(4).hasQuorumFor(X)).toBe(true);
    // One validator's vote waiting and another's counted for the same block: the round has what is counted.
    hvs = new HeightVoteSet(7n, set);
    for (const i of [0, 1]) hvs.add(pre(i, 2, X));
    hvs.add(pre(2, 2, X, 0));
    expect(hvs.prevotes(2).hasQuorumFor(X)).toBe(false);
    for (const i of [0, 1, 3]) hvs.add(pre(i, 0, X));
    expect(hvs.prevotes(2).hasQuorumFor(X)).toBe(true);

    // A validator that signs twice cannot leave a node with only the vote that waits: of the two, the one that
    // counts is kept, and it is still reported as a conflict.
    hvs = new HeightVoteSet(7n, set);
    for (const i of [0, 1]) hvs.add(pre(i, 2, X));
    const waits = pre(2, 2, X, 1); // names a majority of round 1 that never was
    hvs.add(waits);
    expect(hvs.add(pre(2, 2, X))).toEqual({ added: false, conflict: waits });
    expect(hvs.prevotes(2).hasQuorumFor(X)).toBe(true);
    expect(hvs.prevotes(2).get(2)!.polRound).toBe(-1);
    // The other way round the counted vote stays, and a second waiting one changes nothing.
    hvs = new HeightVoteSet(7n, set);
    for (const i of [0, 1, 2]) hvs.add(pre(i, 2, X));
    expect(hvs.add(pre(2, 2, X, 1)).conflict).not.toBeNull();
    expect(hvs.prevotes(2).hasQuorumFor(X)).toBe(true);
  });

  it('decides a block proposed again in the next round on prevotes that name the first round, and slashes nobody', async () => {
    net = await makeTestnet({ validators: 4 });
    await waitForHeight(net.nodes, 2n);
    const height = net.nodes.reduce((m, n) => (n.height > m ? n.height : m), 0n) + 3n;
    await waitFor(() => net!.nodes[0]!.executor.validatorSetAtHeight(height) !== null, 20_000, 'the set of the height to be known');
    const set = net.nodes[0]!.executor.validatorSetAtHeight(height)!;
    const nodeOf = (address: Uint8Array) => [0, 1, 2, 3].find((i) => toHex(keyPairFromSeed(net!.validatorSeed(i)).address) === toHex(address))!;
    const first = nodeOf(set.proposer().address);
    const later = set.copy();
    const second = nodeOf(later.incrementProposerPriority(1).address);
    const [deaf, fourth] = [0, 1, 2, 3].filter((i) => i !== first && i !== second);
    // Round 0 of one height, arranged so that it decides nothing and leaves one validator locked. One validator never
    // gets the proposal and prevotes nil. The three others prevote the block, but the prevote of round 1's proposer
    // reaches neither of the other two: they see two for the block and one for nil, and precommit nil. Round 1's
    // proposer sees all three, locks and precommits the block, alone. In round 1 it proposes the block again with
    // polRound 0, everything is delivered, and the prevotes for it name round 0.
    let arranged = true;
    const named: number[] = [];
    net.hub.messageFilter = (_from, to, frame) => {
      const m = decodeMessage(frame);
      if (m.type === 'vote' && m.vote.height === height && m.vote.type === VoteType.Prevote && m.vote.round === 1 && m.vote.blockHash) named.push(m.vote.polRound);
      if (!arranged) return true;
      if (m.type === 'proposal' && m.proposal.height === height && m.proposal.round === 0) return to !== net!.addrOf(deaf!);
      if (m.type === 'vote' && m.vote.height === height && m.vote.round === 0 && m.vote.type === VoteType.Prevote && m.vote.validatorIndex === set.indexOf(keyPairFromSeed(net!.validatorSeed(second)).address)) {
        return to !== net!.addrOf(first) && to !== net!.addrOf(fourth!);
      }
      return true;
    };
    await waitFor(() => net!.nodes.some((n) => n.consensus.height === height && n.consensus.round >= 1), 30_000, 'round 1 of the arranged height');
    expect(net.nodes[second]!.consensus.lockedRound).toBe(0);
    arranged = false;
    await waitForHeight(net.nodes, height + 2n, 30_000);
    const stored = net.nodes[0]!.store.loadBlock(height)!;
    expect(stored.commit.round).toBe(1);
    // The block of round 1 is the block of round 0: its header names the first proposer, whoever proposed it again.
    expect(toHex(stored.block.header.proposerAddress)).toBe(toHex(set.proposer().address));
    // Every prevote for it in round 1 named round 0, and counted because round 0's majority had been passed on.
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((r) => r === 0)).toBe(true);
    for (const node of net.nodes) {
      expect(toHex(blockHash(node.store.loadBlock(height)!.block))).toBe(toHex(blockHash(stored.block)));
      expect(node.evidencePool.held).toEqual({ pending: 0, committed: 0, inventory: 0 });
      expect((node.app as KvStoreApp).slashed.length).toBe(0);
    }
  });
});
