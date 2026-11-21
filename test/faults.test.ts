/**
 * Faults found beyond two votes in one place of the height a node is in: a proposer that signs two proposals for a
 * round, a prevote that names a majority the votes held rule out, and either half of any evidence arriving once
 * its height is over.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { KvStoreApp } from '../src/app/kvstore.ts';
import { Reader } from '../src/codec/reader.ts';
import { encode } from '../src/codec/writer.ts';
import { Consensus, MAX_DEFERRED_VOTES_PER_PEER, PAST_HEIGHTS_KEPT, VOTES_PER_PEER_SECOND, faultsShown } from '../src/consensus/consensus.ts';
import { EvidencePool, evidenceBytes, verifyEvidence } from '../src/consensus/evidence.ts';
import { MemorySignStateStore, PrivValidator } from '../src/consensus/privval.ts';
import { HeightVoteSet } from '../src/consensus/votes.ts';
import { toHex } from '../src/crypto/hash.ts';
import { DEFAULT_SCHEME, keyPairFromSeed, schemeName, sign, signContext, zeroSignature, type KeyPair } from '../src/crypto/keys.ts';
import type { Verifier } from '../src/crypto/verifier.ts';
import { blockHash, commitHash, evidenceHash, type Block, type Commit } from '../src/types/block.ts';
import { checkEvidenceShape, decodeEvidence, encodeEvidence, evidenceHeight, evidenceKey, evidenceValidator, makeDuplicateProposalEvidence, type DuplicateProposalEvidence, type Evidence, type FalseCitationEvidence, type ProposalHead } from '../src/types/evidence.ts';
import { proposalHeadSignBytes, proposalSignBytes, type Proposal } from '../src/types/proposal.ts';
import { genesisState } from '../src/types/state.ts';
import { txsRoot } from '../src/types/txproof.ts';
import { ValidatorSet, prioritiesHash } from '../src/types/validator.ts';
import { VoteType, voteSignBytes, type UnsignedVote, type Vote } from '../src/types/vote.ts';
import { makeTestnet, seedFor, sleep, verifier, waitFor, waitForHeight, type Testnet } from './helpers.ts';

const CHAIN = 'faults';
const block = (fill: number) => new Uint8Array(32).fill(fill);
const keys = [0, 1, 2, 3].map((i) => keyPairFromSeed(seedFor(`faults/val/${i}`)));

function signedVote(v: UnsignedVote, by: KeyPair, chainId = CHAIN): Vote {
  return { ...v, signature: sign(voteSignBytes(chainId, v), by.secretKey, signContext(chainId, 'vote')) };
}
function head(by: KeyPair, height: bigint, round: number, polRound: number, hash: Uint8Array, chainId = CHAIN): ProposalHead {
  return { polRound, blockHash: hash, signature: sign(proposalHeadSignBytes(chainId, height, round, polRound, hash), by.secretKey, signContext(chainId, 'proposal')) };
}
function signedProposal(by: KeyPair, height: bigint, round: number, polRound: number, b: Block, chainId = CHAIN): Proposal {
  const unsigned = { height, round, polRound, block: b };
  return { ...unsigned, signature: sign(proposalSignBytes(chainId, unsigned), by.secretKey, signContext(chainId, 'proposal')) };
}

/** Four validators of equal power, and a prevote of the one at an index of the set. */
const equal = ValidatorSet.create(keys.map((k) => ({ publicKey: k.publicKey, power: 1n })));
const keyAt = (set: ValidatorSet, i: number) => keys.find((k) => toHex(k.address) === toHex(set.byIndex(i)!.address))!;
const pre = (i: number, round: number, hash: Uint8Array | null, polRound = -1, set = equal) => signedVote({ type: VoteType.Prevote, height: 7n, round, blockHash: hash, polRound, validatorIndex: i }, keyAt(set, i));

/**
 * One validator's state machine at height 1 with the three others played by the test, as in amnesia.test.ts: the
 * validator has power 1 beside three of power 10, and no timeout is short enough to fire.
 */
function machine(verify: Verifier = verifier) {
  const mine = keys[0]!;
  let synced: Commit | null = null;
  const clock = { now: BigInt(Date.now()) };
  const scored: { peer: string; points: number; reason: string }[] = [];
  const hold: { why: string | null } = { why: null };
  const pv = new PrivValidator(mine, new MemorySignStateStore(), CHAIN);
  const sent: { proposals: Proposal[]; heads: { height: bigint; round: number; head: ProposalHead; except: string | null }[] } = { proposals: [], heads: [] };
  const state = genesisState({ chainId: CHAIN, genesisTime: 1n, signatureScheme: schemeName(DEFAULT_SCHEME), validators: keys.map((k, i) => ({ publicKey: k.publicKey, power: i === 0 ? 1n : 10n })), appState: new Uint8Array(0) }, new Uint8Array(32));
  const set = state.validators;
  const pool = new EvidencePool();
  const never = 600_000;
  const consensus = new Consensus({
    chainId: CHAIN,
    // Once a commit for height 1 is given, the chain is at height 1 and block sync is what brought it there.
    getState: () => (synced ? { ...state, lastHeight: 1n } : state),
    applyBlock: async () => {},
    updateCommit: () => {},
    blockTimeAt: () => null,
    getLastCommit: () => synced,
    validatorSetAtHeight: () => set,
    reapTxs: () => [],
    privValidator: pv,
    signingHeld: () => hold.why,
    verifier: verify,
    evidencePool: pool,
    broadcastProposal: (p) => void sent.proposals.push(p),
    broadcastVote: () => {},
    broadcastProposalHead: (height, round, head, except) => void sent.heads.push({ height, round, head, except }),
    timeouts: { proposeMs: never, prevoteMs: never, precommitMs: never, commitMs: never, gossipMs: never },
    scorePeer: (peer, points, reason) => void scored.push({ peer, points, reason }),
    now: () => clock.now,
    log: () => {},
  });
  const proposerOf = (round: number) => keys.find((k) => toHex(k.address) === toHex(consensus.proposerAt(round)))!;
  const make = (round: number, time: bigint): Block => ({
    header: {
      chainId: CHAIN, version: state.version, height: 1n, time, lastBlockHash: state.lastBlockHash, lastCommitHash: commitHash(null), dataHash: txsRoot([]), lastResultsHash: state.lastResultsHash,
      validatorsHash: set.hash(), nextValidatorsHash: state.nextValidators.hash(), appHash: state.appHash, evidenceHash: evidenceHash([]), proposerAddress: proposerOf(round).address, prioritiesHash: prioritiesHash(set, state.nextValidators),
    },
    txs: [], lastCommit: null, evidence: [],
  });
  const propose = (round: number, b: Block, polRound: number, by = proposerOf(round)) => consensus.handleProposal(signedProposal(by, 1n, round, polRound, b), 'peer');
  const vote = (by: KeyPair, type: VoteType, round: number, hash: Uint8Array | null, polRound = -1) =>
    consensus.handleVote(signedVote({ type, height: 1n, round, blockHash: hash, polRound, validatorIndex: set.indexOf(by.address) }, by), 'peer');
  /** Height 1 was committed in `round` and applied behind consensus's back, as block sync does. */
  const sync = (round: number, hash: Uint8Array) => {
    synced = { height: 1n, round, blockHash: hash, signatures: [] };
    consensus.restart();
  };
  return { consensus, set, pool, proposerOf, make, propose, vote, sync, clock, scored, sent, hold, pv, me: set.indexOf(mine.address) };
}

describe('two proposals for one round', () => {
  it('are evidence against their signer by the two signatures alone, whatever the blocks were', async () => {
    const set = ValidatorSet.create([{ publicKey: keys[0]!.publicKey, power: 1n }]);
    const a = head(keys[0]!, 7n, 3, -1, block(1));
    const b = head(keys[0]!, 7n, 3, -1, block(2));
    const ev = makeDuplicateProposalEvidence(7n, 3, 0, b, a);
    expect(ev).toEqual({ kind: 'duplicateProposal', height: 7n, round: 3, validatorIndex: 0, a, b }); // the lower hash first
    expect(checkEvidenceShape(ev)).toBeNull();
    expect(await verifyEvidence(CHAIN, ev, set, verifier)).toBeNull();
    // The same block on another proof-of-lock round is another proposal, the lower round first.
    const c = head(keys[0]!, 7n, 3, 1, block(1));
    const again = makeDuplicateProposalEvidence(7n, 3, 0, c, a);
    expect([again.a, again.b]).toEqual([a, c]);
    expect(await verifyEvidence(CHAIN, again, set, verifier)).toBeNull();

    const not: [DuplicateProposalEvidence, RegExp][] = [
      [{ ...ev, b: a }, /the same/],
      [{ ...ev, a: b, b: a }, /canonical order/],
      [{ ...ev, b: { ...b, polRound: 3 } }, /before the proposal's own/],
      [{ ...ev, a: { ...a, polRound: -2 } }, /before the proposal's own/],
      [{ ...ev, round: -1 }, /bad round/],
    ];
    for (const [e, why] of not) expect(checkEvidenceShape(e)).toMatch(why);
    // The signatures are over height, round, proof-of-lock round and hash, with the proposal context, by the accused.
    expect(await verifyEvidence(CHAIN, { ...ev, round: 4 }, set, verifier)).toMatch(/bad signature/);
    expect(await verifyEvidence(CHAIN, { ...ev, height: 8n }, set, verifier)).toMatch(/bad signature/);
    expect(await verifyEvidence(CHAIN, { ...ev, b: { ...b, polRound: 0 } }, set, verifier)).toMatch(/bad signature/);
    expect(await verifyEvidence(CHAIN, { ...ev, b: head(keys[1]!, 7n, 3, -1, block(2)) }, set, verifier)).toMatch(/bad signature/);
    expect(await verifyEvidence('another-chain', ev, set, verifier)).toMatch(/bad signature/);
    expect(await verifyEvidence(CHAIN, { ...ev, validatorIndex: 1 }, set, verifier)).toMatch(/unknown validator/);
    // Two votes signed for the same height, round and hash are not two proposals: the signing context differs.
    const asVote = (hash: Uint8Array): ProposalHead => ({ polRound: -1, blockHash: hash, signature: sign(proposalHeadSignBytes(CHAIN, 7n, 3, -1, hash), keys[0]!.secretKey, signContext(CHAIN, 'vote')) });
    expect(await verifyEvidence(CHAIN, makeDuplicateProposalEvidence(7n, 3, 0, asVote(block(1)), asVote(block(2))), set, verifier)).toMatch(/bad signature/);

    expect(evidenceKey(ev)).toBe('proposal/7/3/0');
    expect(evidenceHeight(ev)).toBe(7n);
    expect(evidenceValidator(ev)).toBe(0);
    const bytes = encode((w) => encodeEvidence(w, ev));
    expect(bytes[0]).toBe(3);
    expect(decodeEvidence(new Reader(bytes))).toEqual(ev);
  });

  it('are reported by a node that is given both in the round, once, and not for the same proposal twice', async () => {
    const m = machine();
    try {
      m.consensus.start();
      const now = BigInt(Date.now());
      const [D, E, F] = [m.make(0, now), m.make(0, now + 1n), m.make(0, now + 2n)];
      await m.propose(0, D, -1);
      await m.propose(0, D, -1);
      expect(m.pool.list()).toEqual([]);
      // Signed by another validator than the round's proposer it is no proposal at all.
      await m.propose(0, E, -1, m.proposerOf(1));
      expect(m.pool.list()).toEqual([]);
      await m.propose(0, E, -1);
      const [ev] = m.pool.list() as DuplicateProposalEvidence[];
      expect(m.pool.list().length).toBe(1);
      expect(ev).toMatchObject({ kind: 'duplicateProposal', height: 1n, round: 0, validatorIndex: m.set.indexOf(m.proposerOf(0).address) });
      expect([ev!.a.blockHash, ev!.b.blockHash].map(toHex).sort()).toEqual([blockHash(D), blockHash(E)].map(toHex).sort());
      expect(await verifyEvidence(CHAIN, ev!, m.set, verifier)).toBeNull();
      // A third is the same offence, and the round keeps the proposal it had: the validator prevoted D.
      await m.propose(0, F, -1);
      expect(m.pool.list().length).toBe(1);
      expect(m.consensus.status().step).toBe('prevote');
      // A pool with no room does not take the proof, and the round is not marked as reported: when there is room
      // and the second proposal comes again, it is taken.
      const [G, H] = [m.make(1, now + 3n), m.make(1, now + 4n)];
      m.pool.maxRecordBytes = 0;
      await m.propose(1, G, -1);
      await m.propose(1, H, -1);
      expect(m.pool.list().length).toBe(1);
      m.pool.maxRecordBytes = Infinity;
      await m.propose(1, H, -1);
      expect(m.pool.list().map(evidenceKey).sort()).toEqual([evidenceKey(ev!), `proposal/1/1/${m.set.indexOf(m.proposerOf(1).address)}`].sort());
      // The same block proposed on two proof-of-lock rounds in a later round, both arriving at once.
      await Promise.all([m.propose(2, D, 0), m.propose(2, D, 1)]);
      const second = m.pool.list().find((e) => e.kind === 'duplicateProposal' && e.round === 2) as DuplicateProposalEvidence;
      expect([second.a.polRound, second.b.polRound]).toEqual([0, 1]);
      expect(await verifyEvidence(CHAIN, second, m.set, verifier)).toBeNull();
    } finally {
      m.consensus.stop();
    }
  });

  it('are found by a node that has one and is sent what was signed of the other, which a node sends on where it does not send the proposal', async () => {
    const m = machine();
    try {
      m.consensus.start();
      const now = BigInt(Date.now());
      const headOf = (round: number, b: Block, polRound = -1, by = m.proposerOf(round)) => head(by, 1n, round, polRound, blockHash(b));
      const [D, E] = [m.make(0, now), m.make(0, now + 1n)];
      // A proposal the round takes is sent on whole, and nothing beside it.
      await m.propose(0, D, -1);
      expect(m.sent.proposals.map((p) => toHex(blockHash(p.block)))).toEqual([toHex(blockHash(D))]);
      expect(m.sent.heads).toEqual([]);
      // What a neighbour holds for the round, if it is the same, costs nothing and tells nothing.
      await m.consensus.handleProposalHead(1n, 0, headOf(0, D), 'peer');
      expect(m.pool.list()).toEqual([]);
      // Signed by another than the round's proposer, or of a round it could not name, it is nothing.
      await m.consensus.handleProposalHead(1n, 0, headOf(0, E, -1, m.proposerOf(1)), 'liar');
      expect(m.scored).toEqual([{ peer: 'liar', points: 20, reason: 'bad proposal signature' }]);
      await m.consensus.handleProposalHead(1n, 0, headOf(0, E, 0), 'peer');
      await m.consensus.handleProposalHead(9n, 0, head(m.proposerOf(0), 9n, 0, -1, blockHash(E)), 'peer');
      expect(m.pool.list()).toEqual([]);
      expect(m.scored.length).toBe(1);
      // The other proposal's head is the second half of the proof, and is not sent further: the evidence is.
      await m.consensus.handleProposalHead(1n, 0, headOf(0, E), 'peer');
      const [ev] = m.pool.list() as DuplicateProposalEvidence[];
      expect(ev).toMatchObject({ kind: 'duplicateProposal', height: 1n, round: 0 });
      expect([ev!.a.blockHash, ev!.b.blockHash].map(toHex).sort()).toEqual([blockHash(D), blockHash(E)].map(toHex).sort());
      expect(await verifyEvidence(CHAIN, ev!, m.set, verifier)).toBeNull();
      expect(m.sent.heads).toEqual([]);

      // A proposal whose block is invalid is not sent on, and the round does not prevote it; what its proposer
      // signed is sent on, to every peer but the one it came from.
      const good = m.make(1, now + 2n);
      const bad: Block = { ...good, header: { ...good.header, appHash: block(9) } };
      await m.propose(1, bad, -1);
      expect(m.sent.proposals.length).toBe(1);
      expect(m.sent.heads).toEqual([{ height: 1n, round: 1, head: headOf(1, bad), except: 'peer' }]);
      await m.propose(1, bad, -1);
      expect(m.sent.heads.length).toBe(1);
      // A neighbour that was sent the valid one learns of the two from that.
      await m.consensus.handleProposalHead(1n, 1, headOf(1, good), 'peer');
      expect(m.pool.list().map(evidenceKey).sort()).toEqual([evidenceKey(ev!), `proposal/1/1/${m.set.indexOf(m.proposerOf(1).address)}`].sort());

      // The first thing heard of a round may be a head: it is kept and sent on, and the proposal that comes after
      // and says something else is the second.
      const [G, H] = [m.make(2, now + 3n), m.make(2, now + 4n)];
      await m.consensus.handleProposalHead(1n, 2, headOf(2, G), 'peer');
      expect(m.sent.heads.slice(1)).toEqual([{ height: 1n, round: 2, head: headOf(2, G), except: 'peer' }]);
      await m.consensus.handleProposalHead(1n, 2, headOf(2, G), 'other');
      expect(m.sent.heads.length).toBe(2);
      await m.propose(2, H, -1);
      expect(m.pool.list().length).toBe(3);
      // The round had no proposal yet and H is a valid one, so H is what the round goes on with and what is sent on.
      expect(m.sent.proposals.map((p) => p.round)).toEqual([0, 2]);
      // And the proposal that says the same is the round's, sent on whole.
      const J = m.make(3, now + 5n);
      await m.consensus.handleProposalHead(1n, 3, headOf(3, J), 'peer');
      await m.propose(3, J, -1);
      expect(m.sent.proposals.map((p) => p.round)).toEqual([0, 2, 3]);
      expect(m.pool.list().length).toBe(3);

      // A peer that connects now is handed the proposals the rounds took and, for a round that took none, the head.
      const forPeer = m.consensus.messagesForPeer();
      expect(forPeer.proposals.map((p) => p.round)).toEqual([0, 2, 3]);
      expect(forPeer.heads).toEqual([{ round: 1, head: headOf(1, bad) }]);

      // Once the height is over, a head is still held against what was kept of it.
      m.sync(4, blockHash(J));
      const K = m.make(3, now + 6n);
      await m.consensus.handleProposalHead(1n, 3, headOf(3, K), 'peer');
      expect(m.pool.list().length).toBe(4);
      await m.consensus.handleProposalHead(1n, 5, headOf(5, K), 'peer'); // a round the height never reached
      await m.propose(5, m.make(5, now + 7n), -1);
      expect(m.pool.list().length).toBe(4);
      expect(m.sent.heads.length).toBe(3);
      // A whole proposal that comes late for a round of it that holds nothing: its head is kept and sent on, and the
      // head of another is then the second.
      const [P, Q] = [m.make(4, now + 8n), m.make(4, now + 9n)];
      await m.propose(4, P, -1);
      expect(m.sent.heads.slice(3)).toEqual([{ height: 1n, round: 4, head: headOf(4, P), except: 'peer' }]);
      expect(m.sent.proposals.length).toBe(3);
      await m.consensus.handleProposalHead(1n, 4, headOf(4, Q), 'peer');
      expect(m.pool.list().length).toBe(5);

      // A peer that connects after the height is handed what its proposers signed, as this node holds it. One that
      // was apart from this node during the height and was sent another proposal for a round makes the proof of that.
      const past = m.consensus.messagesForPeer().pastHeads;
      expect(past.map((h) => [h.height, h.round])).toEqual([0, 1, 2, 3, 4].map((r) => [1n, r]));
      expect(past[0]!.head).toEqual(headOf(0, D));
      const o = machine();
      try {
        o.consensus.start();
        await o.propose(0, E, -1);
        o.sync(0, blockHash(E));
        expect(o.consensus.messagesForPeer().pastHeads).toEqual([{ height: 1n, round: 0, head: headOf(0, E) }]);
        for (const h of past) await o.consensus.handleProposalHead(h.height, h.round, h.head, 'peer');
        expect(o.pool.list().map(evidenceKey)).toEqual([evidenceKey(ev!)]);
        // The rounds above the one its height ended in tell it nothing, and it sends none of them on.
        expect(o.sent.heads).toEqual([]);
      } finally {
        o.consensus.stop();
      }
    } finally {
      m.consensus.stop();
    }

    // One head sent by many peers at once is verified once.
    let verified = 0;
    const counting: Verifier = { verify: (jobs) => verifier.verify(jobs), close: () => verifier.close(), verifyOne: (job) => (verified++, verifier.verifyOne(job)) };
    const n = machine(counting);
    try {
      n.consensus.start();
      const h = head(n.proposerOf(0), 1n, 0, -1, blockHash(n.make(0, BigInt(Date.now()))));
      await Promise.all(['a', 'b', 'c'].map((peer) => n.consensus.handleProposalHead(1n, 0, h, peer)));
      expect(verified).toBe(1);
      expect(n.sent.heads.length).toBe(1);
    } finally {
      n.consensus.stop();
    }
  });

  it('are found when the second comes out of verification after the height is over, and when the round decided on a block fetched without a signature', async () => {
    // A verifier that holds back one verification until it is let go.
    let hold = false;
    let release: () => void = () => {};
    const gated: Verifier = { verify: (jobs) => verifier.verify(jobs), close: () => verifier.close(), verifyOne: async (job) => {
      if (hold) {
        hold = false;
        await new Promise<void>((r) => (release = r));
      }
      return verifier.verifyOne(job);
    } };
    const m = machine(gated);
    try {
      m.consensus.start();
      const now = BigInt(Date.now());
      const [D, E] = [m.make(0, now), m.make(0, now + 1n)];
      await m.propose(0, D, -1);
      // E is in verification when block sync takes the node to height 2; it is held against what was kept of height 1.
      hold = true;
      const second = m.propose(0, E, -1);
      m.sync(0, blockHash(D));
      expect(m.consensus.height).toBe(2n);
      expect(m.pool.list()).toEqual([]);
      release();
      await second;
      expect(m.pool.list().map((e) => [e.kind, evidenceHeight(e)])).toEqual([['duplicateProposal', 1n]]);
    } finally {
      m.consensus.stop();
    }

    // The round holds the proposer's proposal D, but +2/3 precommit another block E, which is fetched and decided.
    // What the proposer signed is still D: its signed proposal of E, when it comes, is the second.
    const n = machine();
    try {
      n.consensus.start();
      const now = BigInt(Date.now());
      const [D, E] = [n.make(0, now), n.make(0, now + 1n)];
      await n.propose(0, D, -1);
      for (const r of [0, 1, 2]) await n.vote(n.proposerOf(r), VoteType.Precommit, 0, blockHash(E));
      await n.consensus.handleFetchedBlock(E);
      expect(n.consensus.isDeciding).toBe(true);
      expect(n.pool.list()).toEqual([]);
      await n.propose(0, E, -1);
      expect(n.pool.list().map((e) => e.kind)).toEqual(['duplicateProposal']);
      expect(await verifyEvidence(CHAIN, n.pool.list()[0]!, n.set, verifier)).toBeNull();
    } finally {
      n.consensus.stop();
    }
  });
});

describe('a prevote on a majority that never was', () => {
  const X = block(1);
  const Y = block(2);

  it('is proven by the prevotes of the round it names, when +2/3 of the power prevoted something else there', async () => {
    const liar = pre(3, 5, X, 2);
    const ev: FalseCitationEvidence = { kind: 'falseCitation', prevote: liar, against: [pre(0, 2, Y), pre(1, 2, null), pre(2, 2, Y)] };
    expect(checkEvidenceShape(ev)).toBeNull();
    expect(await verifyEvidence(CHAIN, ev, equal, verifier)).toBeNull();
    // The accused's own prevote of that round speaks against it like any other.
    expect(await verifyEvidence(CHAIN, { ...ev, against: [pre(1, 2, null), pre(2, 2, Y), pre(3, 2, Y)] }, equal, verifier)).toBeNull();
    // Two of four are not +2/3: a third of the power could still have prevoted the block, with the accused's.
    expect(await verifyEvidence(CHAIN, { ...ev, against: ev.against.slice(0, 2) }, equal, verifier)).toMatch(/not \+2\/3/);

    const not: [FalseCitationEvidence, RegExp][] = [
      [{ ...ev, prevote: pre(3, 5, X) }, /names a round/],
      [{ ...ev, prevote: pre(3, 5, null) }, /names a round/],
      [{ ...ev, prevote: signedVote({ type: VoteType.Precommit, height: 7n, round: 5, blockHash: X, polRound: -1, validatorIndex: 3 }, keyAt(equal, 3)) }, /names a round/],
      [{ ...ev, against: [] }, /no prevotes against/],
      [{ ...ev, against: [pre(0, 2, Y), pre(1, 2, X), pre(2, 2, Y)] }, /for the block itself/],
      [{ ...ev, against: [pre(0, 2, Y), pre(1, 3, Y), pre(2, 2, Y)] }, /another round/],
      [{ ...ev, against: [pre(1, 2, null), pre(0, 2, Y), pre(2, 2, Y)] }, /ascending order/],
      [{ ...ev, against: [pre(0, 2, Y), pre(0, 2, null), pre(2, 2, Y)] }, /ascending order/], // one validator counted twice
      [{ ...ev, against: [pre(0, 2, Y), pre(1, 2, null), signedVote({ type: VoteType.Precommit, height: 7n, round: 2, blockHash: Y, polRound: -1, validatorIndex: 2 }, keyAt(equal, 2))] }, /only prevotes/],
      [{ ...ev, against: [pre(0, 2, Y), pre(1, 2, null), signedVote({ type: VoteType.Prevote, height: 8n, round: 2, blockHash: Y, polRound: -1, validatorIndex: 2 }, keyAt(equal, 2))] }, /heights differ/],
    ];
    for (const [e, why] of not) expect(checkEvidenceShape(e)).toMatch(why);
    // Every vote under the key of its own signer.
    expect(await verifyEvidence(CHAIN, { ...ev, against: [ev.against[0]!, { ...ev.against[1]!, signature: ev.against[0]!.signature }, ev.against[2]!] }, equal, verifier)).toMatch(/bad signature/);
    expect(await verifyEvidence(CHAIN, { ...ev, prevote: { ...liar, polRound: 2, round: 6 } }, equal, verifier)).toMatch(/bad signature/);
    expect(await verifyEvidence(CHAIN, ev, ValidatorSet.create(keys.slice(0, 3).map((k) => ({ publicKey: k.publicKey, power: 1n }))), verifier)).toMatch(/unknown validator|bad signature/);
    // Power, not heads: three light validators beside a heavy one are not +2/3.
    const heavy = ValidatorSet.create(keys.map((k, i) => ({ publicKey: k.publicKey, power: toHex(k.address) === toHex(equal.byIndex(3)!.address) ? 10n : 1n + 0n * BigInt(i) })));
    const h = (k: KeyPair, round: number, hash: Uint8Array | null, polRound = -1) => signedVote({ type: VoteType.Prevote, height: 7n, round, blockHash: hash, polRound, validatorIndex: heavy.indexOf(k.address) }, k);
    const [big, ...light] = [keyAt(equal, 3), keyAt(equal, 0), keyAt(equal, 1), keyAt(equal, 2)];
    const byIndex = (vs: Vote[]) => vs.sort((p, q) => p.validatorIndex - q.validatorIndex);
    expect(await verifyEvidence(CHAIN, { kind: 'falseCitation', prevote: h(light[0]!, 5, X, 2), against: byIndex(light.map((k) => h(k, 2, Y))) }, heavy, verifier)).toMatch(/not \+2\/3/);
    expect(await verifyEvidence(CHAIN, { kind: 'falseCitation', prevote: h(light[0]!, 5, X, 2), against: byIndex([h(big!, 2, Y), h(light[1]!, 2, Y)]) }, heavy, verifier)).toBeNull();

    expect(evidenceKey(ev)).toBe('citation/7/3');
    expect(evidenceHeight(ev)).toBe(7n);
    expect(evidenceValidator(ev)).toBe(3);
    const bytes = encode((w) => encodeEvidence(w, ev));
    expect(bytes[0]).toBe(4);
    expect(decodeEvidence(new Reader(bytes))).toEqual(ev);
  });

  it('is found in the votes held whichever comes last, with no more prevotes than make the +2/3', () => {
    const found = (votes: Vote[]) => {
      const hvs = new HeightVoteSet(7n, equal);
      // As the pool takes them: the first proof of an offence, and no second.
      const out = new Map<string, Evidence>();
      for (const v of votes) if (hvs.add(v).added) for (const ev of faultsShown(hvs, equal, v)) if (!out.has(evidenceKey(ev))) out.set(evidenceKey(ev), ev);
      return [...out.values()];
    };
    const liar = pre(3, 5, X, 2);
    const others = [pre(0, 2, Y), pre(1, 2, null), pre(2, 2, Y), pre(3, 2, Y)];
    // The prevote last: three of the four prevotes of round 2 are taken, in index order.
    expect(found([...others, liar])).toEqual([{ kind: 'falseCitation', prevote: liar, against: others.slice(0, 3) }]);
    // The prevote first: nothing with two against, the evidence with the third, nothing more with the fourth.
    expect(found([liar, others[2]!, others[0]!])).toEqual([]);
    expect(found([liar, others[2]!, others[0]!, others[3]!, others[1]!])).toEqual([{ kind: 'falseCitation', prevote: liar, against: [others[0]!, others[2]!, others[3]!] }]);
    // A round in which a third prevoted the block cannot be shown false, and a round named truly is not.
    expect(found([liar, pre(0, 2, Y), pre(1, 2, X), pre(2, 2, Y), pre(3, 2, X)])).toEqual([]);
    expect(found([pre(0, 2, X), pre(1, 2, X), pre(2, 2, X), pre(3, 2, Y), pre(3, 5, X, 2), pre(0, 5, X, 2)])).toEqual([]);
    // Prevotes of another round than the one named say nothing, nor do precommits.
    expect(found([liar, pre(0, 3, Y), pre(1, 3, Y), pre(2, 3, Y)])).toEqual([]);
    // Seven validators. Four prevote nil in round 1, B prevotes X there naming a round it has nothing for, and A
    // names round 1 for X in round 2. B then signs nil for round 1 as well: whichever of B's two votes the set
    // keeps, the second is a double sign by B and the fifth prevote against A's claim.
    const seven = [0, 1, 2, 3, 4, 5, 6].map((i) => keyPairFromSeed(seedFor(`faults/seven/${i}`)));
    const set7 = ValidatorSet.create(seven.map((k) => ({ publicKey: k.publicKey, power: 1n })));
    const p7 = (i: number, round: number, hash: Uint8Array | null, polRound = -1) => signedVote({ type: VoteType.Prevote, height: 7n, round, blockHash: hash, polRound, validatorIndex: i }, seven.find((k) => toHex(k.address) === toHex(set7.byIndex(i)!.address))!);
    for (const first of [p7(4, 1, X, 0), p7(4, 1, X)]) {
      const hvs = new HeightVoteSet(7n, set7);
      const claim = p7(5, 2, X, 1);
      for (const v of [p7(0, 1, null), p7(1, 1, null), p7(2, 1, null), p7(3, 1, null), first, claim]) {
        hvs.add(v);
        expect(faultsShown(hvs, set7, v)).toEqual([]);
      }
      const twice = p7(4, 1, null);
      expect(hvs.add(twice)).toMatchObject({ added: false, conflict: first });
      const [ev] = faultsShown(hvs, set7, twice) as FalseCitationEvidence[];
      expect(ev).toEqual({ kind: 'falseCitation', prevote: claim, against: [p7(0, 1, null), p7(1, 1, null), p7(2, 1, null), p7(3, 1, null), twice] });
    }
    // The same when the claim comes last: the set kept one of the fifth's two votes and put the other aside, and
    // the claim is held against both.
    for (const pair of [[p7(4, 1, X), p7(4, 1, null)], [p7(4, 1, null), p7(4, 1, X)]]) {
      const hvs = new HeightVoteSet(7n, set7);
      for (const v of [p7(0, 1, null), p7(1, 1, null), p7(2, 1, null), p7(3, 1, null), ...pair]) hvs.add(v);
      expect(hvs.prevotes(1).alternates()).toEqual([pair[1]]);
      const claim = p7(5, 2, X, 1);
      hvs.add(claim);
      const [ev] = faultsShown(hvs, set7, claim) as FalseCitationEvidence[];
      expect(ev!.against.map((o) => [o.validatorIndex, o.blockHash])).toEqual([0, 1, 2, 3, 4].map((i) => [i, null]));
    }
    // The fifth signs X and Y for round 1, both naming round 0 and both waiting; Y is put aside. Round 0 then gets
    // its majority for Y, and Y, sent again, takes the place: X is what is put aside now, and still speaks against
    // a later claim for Y.
    {
      const hvs = new HeightVoteSet(7n, set7);
      const [x, y] = [p7(4, 1, X, 0), p7(4, 1, Y, 0)];
      for (const v of [p7(0, 1, null), p7(1, 1, null), p7(2, 1, null), p7(3, 1, null), x, y]) hvs.add(v);
      for (const i of [0, 1, 2, 3, 5]) hvs.add(p7(i, 0, Y));
      expect(hvs.add(y)).toMatchObject({ added: false, conflict: x });
      expect([hvs.prevotes(1).get(4), hvs.prevotes(1).alternates()]).toEqual([y, [x]]);
      const claim = p7(5, 2, Y, 1);
      hvs.add(claim);
      const [ev] = faultsShown(hvs, set7, claim) as FalseCitationEvidence[];
      expect(ev!.against.map((o) => o.validatorIndex)).toEqual([0, 1, 2, 3, 4]);
      expect(ev!.against[4]).toEqual(x);
    }
    // A validator that names the round falsely in many later rounds is proven once by the prevote that completes
    // the +2/3, not once for each of them.
    const many = new HeightVoteSet(7n, equal);
    for (let r = 3; r < 40; r++) many.add(pre(3, r, X, 2));
    for (const v of others.slice(0, 2)) many.add(v);
    many.add(others[2]!);
    expect(faultsShown(many, equal, others[2]!).map((e) => [e.kind, evidenceValidator(e)])).toEqual([['falseCitation', 3]]);
    // Of two claims by one validator the smaller proof is made, and each proof takes the heaviest votes first.
    // Powers 5, 4, 2, 1 and 1 of 13. In round 2 the 4 prevotes Y and the rest Z. The accused, one of the 1s, names
    // round 2 for Y (refuted by 5, 2, 1 and 1: four votes) and then for X (refuted by 5 and 4: two votes).
    const five = [0, 1, 2, 3, 4].map((i) => keyPairFromSeed(seedFor(`faults/five/${i}`)));
    const powers = [5n, 4n, 2n, 1n, 1n];
    const set5 = ValidatorSet.create(five.map((k, i) => ({ publicKey: k.publicKey, power: powers[i]! })));
    const p5 = (i: number, round: number, hash: Uint8Array | null, polRound = -1) => signedVote({ type: VoteType.Prevote, height: 7n, round, blockHash: hash, polRound, validatorIndex: set5.indexOf(five[i]!.address) }, five[i]!);
    const uneven = new HeightVoteSet(7n, set5);
    const [forY, forX] = [p5(4, 3, Y, 2), p5(4, 4, X, 2)];
    const Z = block(3);
    const last = p5(0, 2, Z);
    for (const v of [forY, forX, p5(1, 2, Y), p5(2, 2, Z), p5(3, 2, Z), p5(4, 2, Z), last]) uneven.add(v);
    const [smallest, ...rest] = faultsShown(uneven, set5, last) as FalseCitationEvidence[];
    expect(rest).toEqual([]);
    expect(smallest!.prevote).toEqual(forX);
    expect(smallest!.against.map((o) => set5.byIndex(o.validatorIndex)!.power).sort()).toEqual([4n, 5n]);
    expect(checkEvidenceShape(smallest!)).toBeNull();
    // A prevote for nil is 32 bytes less than one for a block, so it is taken first among equals: three for Y and
    // one for nil against a claim for X are proven with the nil and two of the three.
    const withNil = [pre(0, 2, Y), pre(1, 2, Y), pre(2, 2, Y), pre(3, 2, null)];
    const [cheap] = found([...withNil, liar]) as FalseCitationEvidence[];
    expect(cheap!.against).toEqual([withNil[0], withNil[1], withNil[3]]);
    // Many claims for many blocks by one validator cost one look at the round, not one each.
    const wide = new HeightVoteSet(7n, equal);
    for (let r = 3; r < 120; r++) wide.add(pre(3, r, block(r), 2));
    for (const v of withNil.slice(0, 2)) wide.add(v);
    wide.add(withNil[2]!);
    const started = performance.now();
    expect(faultsShown(wide, equal, withNil[2]!).length).toBe(1);
    expect(performance.now() - started).toBeLessThan(500);
    // Two validators naming the same round falsely are two pieces of evidence, from one completing prevote.
    const second = pre(2, 4, X, 2);
    expect(found([liar, second, others[0]!, others[1]!, others[2]!]).map((e) => (e as FalseCitationEvidence).prevote)).toEqual([second, liar]);
  });

  it('is reported by a node from a prevote held for a later round and the prevotes of the round it is in', async () => {
    const m = machine();
    try {
      m.consensus.start();
      const D = m.make(0, BigInt(Date.now()));
      const [p0, p1, p2] = [m.proposerOf(0), m.proposerOf(1), m.proposerOf(2)];
      expect(new Set([p0, p1, p2, keys[0]]).size).toBe(4);
      // One validator prevotes some block in round 2 on a majority it dates to round 0: a third of the power, less
      // than takes the node to that round.
      await m.vote(p2, VoteType.Prevote, 2, block(9), 0);
      expect(m.consensus.round).toBe(0);
      // Round 0 goes as it does: D is proposed, and the node and two others prevote it. With the third prevote
      // +2/3 of the power has said something else than block 9 in round 0.
      await m.propose(0, D, -1);
      await m.vote(p0, VoteType.Prevote, 0, blockHash(D));
      expect(m.pool.list()).toEqual([]);
      await m.vote(p1, VoteType.Prevote, 0, blockHash(D));
      const [ev] = m.pool.list() as FalseCitationEvidence[];
      expect(m.pool.list().length).toBe(1);
      expect(ev!.kind).toBe('falseCitation');
      expect(ev!.prevote).toMatchObject({ round: 2, polRound: 0, blockHash: block(9), validatorIndex: m.set.indexOf(p2.address) });
      expect(ev!.against.map((v) => v.validatorIndex)).toEqual([m.me, m.set.indexOf(p0.address), m.set.indexOf(p1.address)].sort((a, b) => a - b));
      expect(await verifyEvidence(CHAIN, ev!, m.set, verifier)).toBeNull();
    } finally {
      m.consensus.stop();
    }

    // The prevote that completes the +2/3 is the second of two its validator signed for the round: the node holds
    // the first, and reports both the double sign and the false citation the second proves.
    const n = machine();
    try {
      n.consensus.start();
      const D = n.make(0, BigInt(Date.now()));
      const [p0, p1, p2] = [n.proposerOf(0), n.proposerOf(1), n.proposerOf(2)];
      await n.vote(p2, VoteType.Prevote, 2, block(9), 0);
      await n.vote(p1, VoteType.Prevote, 0, block(9));
      await n.propose(0, D, -1);
      await n.vote(p0, VoteType.Prevote, 0, blockHash(D));
      expect(n.pool.list()).toEqual([]);
      await n.vote(p1, VoteType.Prevote, 0, blockHash(D));
      expect(n.pool.list().map((e) => [e.kind, evidenceValidator(e)]).sort()).toEqual([['duplicateVote', n.set.indexOf(p1.address)], ['falseCitation', n.set.indexOf(p2.address)]].sort());
      for (const e of n.pool.list()) expect(await verifyEvidence(CHAIN, e, n.set, verifier)).toBeNull();
    } finally {
      n.consensus.stop();
    }
  });
});

describe('a validator whose signing is held', () => {
  it('goes through the round without a vote, and when it may sign takes its part in the round as it stands, a polka included', async () => {
    const m = machine();
    try {
      m.hold.why = 'held by the test';
      m.consensus.start();
      const D = m.make(0, BigInt(Date.now()));
      await m.propose(0, D, -1);
      for (const r of [0, 1, 2]) await m.vote(m.proposerOf(r), VoteType.Prevote, 0, blockHash(D));
      // The state machine saw the proposal and the polka and is where a validator that precommitted would be.
      expect(m.consensus.status().step).toBe('precommit');
      expect(m.pv.lastSigned()).toBeNull();
      expect(m.consensus.messagesForPeer().votes.filter((v) => v.validatorIndex === m.me)).toEqual([]);

      m.hold.why = null;
      m.consensus.signingResumed();
      // It prevoted the block on no earlier majority, and precommitted it on the polka it held: the lock is the
      // one the precommit wrote.
      const mine = m.consensus.messagesForPeer().votes.filter((v) => v.validatorIndex === m.me);
      expect(mine.map((v) => [v.type, v.round, v.polRound, toHex(v.blockHash!)])).toEqual([
        [VoteType.Prevote, 0, -1, toHex(blockHash(D))],
        [VoteType.Precommit, 0, -1, toHex(blockHash(D))],
      ]);
      expect(m.pv.lockAt(1n)).toMatchObject({ round: 0 });
      expect(m.consensus.lockedRound).toBe(0);
      expect(m.consensus.status().step).toBe('precommit');
    } finally {
      m.consensus.stop();
    }
  });
});

describe('votes from one peer', () => {
  it('are verified up to a number a second, the rest waiting their turn, and a peer is charged only for what there is no room to keep', async () => {
    const m = machine();
    try {
      m.consensus.start();
      const who = m.proposerOf(1);
      const index = m.set.indexOf(who.address);
      // One validator's precommits for 240 rounds ahead, all good votes, all through one peer within one second: what
      // a peer that has just connected is handed of a height that has gone through many rounds.
      const votes = Array.from({ length: 240 }, (_, r) => signedVote({ type: VoteType.Precommit, height: 1n, round: r, blockHash: null, polRound: -1, validatorIndex: index }, who));
      for (const v of votes) await m.consensus.handleVote(v, 'relay');
      const held = () => m.consensus.messagesForPeer().votes.filter((v) => v.validatorIndex === index).length;
      expect(VOTES_PER_PEER_SECOND).toBe(200);
      expect(held()).toBe(200);
      expect(m.scored).toEqual([]);
      // Another peer has a budget of its own, and a vote with no peer behind it (the node's own, or one replayed) has none.
      await m.consensus.handleVote(votes[200]!, 'other');
      await m.consensus.handleVote(votes[201]!, null);
      expect(held()).toBe(202);
      // A vote already held costs no verification and none of the budget.
      for (const v of votes.slice(0, 200)) await m.consensus.handleVote(v, 'other');
      await m.consensus.handleVote(votes[202]!, 'other');
      expect(held()).toBe(203);
      // The same votes sent again and again while they wait take no further places: thirty times the forty would
      // otherwise be more than may wait.
      for (let i = 0; i < 30; i++) for (const v of votes.slice(200)) await m.consensus.handleVote(v, 'relay');
      expect(m.scored).toEqual([]);
      // The forty that were over the budget waited, and are taken once the second has passed: none is lost.
      await sleep(600);
      expect(held()).toBe(203);
      m.clock.now += 1000n;
      await waitFor(() => held() === 240, 5000, () => `the votes that waited (${held()} held)`);
      expect(m.scored).toEqual([]);

      // A peer that sends more than can wait: 160 more use up this second's budget, the next 1,024 wait, and the
      // rest are dropped, for which it is charged once. None of these was verified to find that out.
      const junk = Array.from({ length: 1300 }, (_, i) => ({ type: VoteType.Prevote, height: 1n, round: 300 + (i >> 1), blockHash: i % 2 ? block(1) : null, polRound: -1, validatorIndex: index, signature: zeroSignature(DEFAULT_SCHEME) }));
      expect(MAX_DEFERRED_VOTES_PER_PEER).toBe(1024);
      await Promise.all(junk.map((v) => m.consensus.handleVote(v, 'relay')));
      expect(m.scored.filter((x) => x.reason === 'vote flood')).toEqual([{ peer: 'relay', points: 10, reason: 'vote flood' }]);
    } finally {
      m.consensus.stop();
    }

    // One signed vote arriving from several peers at once is verified once, and a vote that differs only in its
    // signature is another vote.
    let verified = 0;
    let failing = 0;
    const counting: Verifier = { verify: (jobs) => verifier.verify(jobs), close: () => verifier.close(), verifyOne: async (job) => {
      verified++;
      await sleep(20);
      if (failing-- > 0) throw new Error('worker exited');
      return verifier.verifyOne(job);
    } };
    const n = machine(counting);
    try {
      n.consensus.start();
      const who = n.proposerOf(1);
      const vote = signedVote({ type: VoteType.Precommit, height: 1n, round: 0, blockHash: null, polRound: -1, validatorIndex: n.set.indexOf(who.address) }, who);
      await Promise.all(['a', 'b', 'c', 'd'].map((peer) => n.consensus.handleVote(vote, peer)));
      expect(verified).toBe(1);
      expect(n.consensus.messagesForPeer().votes).toContainEqual(vote);
      const other = { ...vote, round: 1, signature: zeroSignature(DEFAULT_SCHEME) };
      const good = signedVote({ type: VoteType.Precommit, height: 1n, round: 1, blockHash: null, polRound: -1, validatorIndex: vote.validatorIndex }, who);
      await Promise.all([n.consensus.handleVote(other, 'a'), n.consensus.handleVote(good, 'b')]);
      expect(verified).toBe(3);
      expect(n.consensus.messagesForPeer().votes).toContainEqual(good);
      // A verifier that fails (a worker that died) loses no vote: the copies were dropped on the strength of the
      // one in verification, so that one waits and is tried again.
      failing = 1;
      const third = signedVote({ type: VoteType.Precommit, height: 1n, round: 2, blockHash: null, polRound: -1, validatorIndex: vote.validatorIndex }, who);
      await Promise.all(['a', 'b'].map((peer) => n.consensus.handleVote(third, peer)));
      expect(n.consensus.messagesForPeer().votes).not.toContainEqual(third);
      await waitFor(() => n.consensus.messagesForPeer().votes.some((v) => v.round === 2), 5000, 'the vote whose verification failed to be tried again');
    } finally {
      n.consensus.stop();
    }
  });
});

describe('a height that is over', () => {
  it('offers the pool again, when the next height starts, the evidence it had no room for', async () => {
    const m = machine();
    try {
      m.consensus.start();
      const who = m.proposerOf(1);
      // The pool takes nothing while two precommits in one place arrive; the votes are held, and will not be looked at again.
      const add = m.pool.add.bind(m.pool);
      m.pool.add = () => false;
      await m.vote(who, VoteType.Precommit, 0, block(1));
      await m.vote(who, VoteType.Precommit, 0, block(2));
      await m.vote(who, VoteType.Precommit, 0, block(2));
      expect(m.pool.list()).toEqual([]);
      m.pool.add = add;
      m.sync(0, block(1));
      expect(m.pool.list().map(evidenceKey)).toEqual([`1/0/${VoteType.Precommit}/${m.set.indexOf(who.address)}`]);
    } finally {
      m.consensus.stop();
    }
  });

  let net: Testnet | null = null;
  afterEach(async () => {
    await net?.stop();
    net = null;
  });

  it('keeps the rounds up to the one the height was committed in, when block sync and not this node decided it', async () => {
    const m = machine();
    try {
      m.consensus.start();
      const who = m.proposerOf(1);
      // The node is in round 0 and holds one validator's precommit of round 5; the height is then committed in
      // round 5 elsewhere and applied by block sync.
      await m.vote(who, VoteType.Precommit, 5, block(1));
      await m.vote(who, VoteType.Precommit, 7, block(1));
      expect(m.consensus.round).toBe(0);
      m.sync(5, block(1));
      // The other precommit that validator signed for round 5 arrives: two in one place. Round 7 was not kept.
      await m.vote(who, VoteType.Precommit, 5, block(2));
      expect(m.pool.list().map(evidenceKey)).toEqual([`1/5/${VoteType.Precommit}/${m.set.indexOf(who.address)}`]);
      await m.vote(who, VoteType.Precommit, 7, block(2));
      expect(m.pool.list().length).toBe(1);
    } finally {
      m.consensus.stop();
    }
  });

  it('takes no evidence into the pool that is larger than a block gives it, or beyond the bytes that may wait', () => {
    const small = makeDuplicateProposalEvidence(7n, 3, 0, head(keys[0]!, 7n, 3, -1, block(1)), head(keys[0]!, 7n, 3, -1, block(2)));
    const large: FalseCitationEvidence = { kind: 'falseCitation', prevote: pre(3, 5, block(1), 2), against: [pre(0, 2, null), pre(1, 2, null), pre(2, 2, null)] };
    expect(evidenceBytes(large)).toBeGreaterThan(evidenceBytes(small));
    const pool = new EvidencePool();
    pool.maxRecordBytes = evidenceBytes(small);
    expect(pool.add(large)).toBe(false);
    expect(pool.add(small)).toBe(true);
    expect([pool.size, pool.bytes]).toEqual([1, evidenceBytes(small)]);
    // One that came in a block is remembered whatever its size, and what waited for the same offence goes, with its bytes.
    pool.markCommitted([large, small]);
    expect([pool.size, pool.bytes, pool.has(large), pool.has(small)]).toEqual([0, 0, true, true]);
    expect(pool.add(small)).toBe(false);
    // Pruning takes the bytes of what waited with it.
    const other = makeDuplicateProposalEvidence(8n, 0, 0, head(keys[0]!, 8n, 0, -1, block(1)), head(keys[0]!, 8n, 0, -1, block(2)));
    pool.add(other);
    expect(pool.bytes).toBe(evidenceBytes(other));
    pool.pruneIf((e) => evidenceHeight(e) === 8n);
    expect([pool.size, pool.bytes]).toEqual([0, 0]);
    expect(EvidencePool.MAX_PENDING_BYTES).toBe(32 * 1024 * 1024);
  });

  it('is still held against a late vote, a late proposal and a prevote that named one of its rounds, and every application punishes what they show', async () => {
    net = await makeTestnet({ validators: 4 });
    const chainId = net.genesis.chainId;
    const apps = net.nodes.map((n) => n.app as KvStoreApp);
    const keyOf = (i: number) => keyPairFromSeed(net!.validatorSeed(i));
    const address = (i: number) => keyOf(i).address;
    const setAt = (h: bigint) => net!.nodes[0]!.executor.validatorSetAtHeight(h)!;
    const punished = (app: KvStoreApp, i: number, height: bigint) => app.slashed.filter((s) => s.height === height && toHex(s.address) === toHex(address(i)));
    await waitForHeight(net.nodes, 5n);

    // A height decided in round 0, a few heights back, at every node.
    let late = 0n;
    for (let h = 2n; h <= 4n && late === 0n; h++) if (net.nodes.every((n) => n.store.loadBlock(h)!.commit.round === 0)) late = h;
    expect(late).not.toBe(0n);
    const lateVote = (i: number, type: VoteType, round: number, fill: number) => signedVote({ type, height: late, round, blockHash: block(fill), polRound: -1, validatorIndex: setAt(late).indexOf(address(i)) }, keyOf(i), chainId);

    // Validator 3 signed another prevote in round 0 of that height, and shows it to one node only now. Whether the
    // node holds validator 3's own prevote of the round or not, the two given here are two in one place.
    await net.nodes[0]!.consensus.handleVote(lateVote(3, VoteType.Prevote, 0, 7), null);
    await net.nodes[0]!.consensus.handleVote(lateVote(3, VoteType.Prevote, 0, 8), null);
    await waitFor(() => apps.every((a) => punished(a, 3, late).length === 1), 30_000, 'the late double sign to reach every application');
    expect(apps.every((a) => punished(a, 3, late)[0]!.kind === 'duplicateVote')).toBe(true);

    // The proposer of that height signed a second proposal for round 0, with another time in the header.
    const stored = net.nodes[0]!.store.loadBlock(late)!.block;
    const proposer = [0, 1, 2, 3].find((i) => toHex(address(i)) === toHex(stored.header.proposerAddress))!;
    const other: Block = { ...stored, header: { ...stored.header, time: stored.header.time + 1n } };
    for (const n of net.nodes) await n.consensus.handleProposal(signedProposal(keyOf(proposer), late, 0, -1, other, chainId), null);
    // The stored proposal again is no second proposal, and one signed by another validator is none at all.
    await net.nodes[0]!.consensus.handleProposal(signedProposal(keyOf(proposer), late, 0, -1, stored, chainId), null);
    await waitFor(() => apps.every((a) => a.slashed.some((s) => s.kind === 'duplicateProposal')), 30_000, 'the two proposals to reach every application');
    for (const a of apps) expect(a.slashed.filter((s) => s.kind === 'duplicateProposal').map((s) => [s.height, toHex(s.address)])).toEqual([[late, toHex(address(proposer))]]);

    // Votes of a round the height never reached are not taken in, two in one place or not.
    const accused = [0, 1, 2].find((i) => i !== proposer)!;
    await net.nodes[1]!.consensus.handleVote(lateVote(accused, VoteType.Precommit, 5, 7), null);
    await net.nodes[1]!.consensus.handleVote(lateVote(accused, VoteType.Precommit, 5, 8), null);

    // A prevote for the next height, round 1, naming round 0 for a block nobody will propose. It is held until the
    // height starts; round 0 then has +2/3 prevotes for the block that is proposed.
    const cited = net.nodes[2]!.consensus.height + 1n;
    await net.nodes[2]!.consensus.handleVote(signedVote({ type: VoteType.Prevote, height: cited, round: 1, blockHash: block(9), polRound: 0, validatorIndex: setAt(cited).indexOf(address(accused)) }, keyOf(accused), chainId), null);
    await waitFor(() => apps.every((a) => punished(a, accused, cited).length === 1), 30_000, 'the false citation to reach every application');
    expect(apps.every((a) => punished(a, accused, cited)[0]!.kind === 'falseCitation')).toBe(true);

    // The blocks carried one piece of evidence of each kind, and nothing came of the votes of round 5.
    const carried: Evidence[] = [];
    for (let h = 1n; h <= net.nodes[0]!.height; h++) carried.push(...net.nodes[0]!.store.loadBlock(h)!.block.evidence);
    expect(carried.map((e) => e.kind).sort()).toEqual(['duplicateProposal', 'duplicateVote', 'falseCitation']);
    expect(apps.every((a) => a.slashed.length === 3)).toBe(true);

    // Past the heights kept, two votes in one place are no longer looked at.
    await waitForHeight(net.nodes, late + BigInt(PAST_HEIGHTS_KEPT) + 3n, 60_000);
    const old = [0, 1, 2, 3].find((i) => i !== proposer && i !== accused && i !== 3)!;
    await net.nodes[0]!.consensus.handleVote(lateVote(old, VoteType.Prevote, 0, 7), null);
    await net.nodes[0]!.consensus.handleVote(lateVote(old, VoteType.Prevote, 0, 8), null);
    await sleep(1000);
    expect(apps.every((a) => a.slashed.length === 3)).toBe(true);
    expect(net.nodes[0]!.evidencePool.held.pending).toBe(0);
  });
});
