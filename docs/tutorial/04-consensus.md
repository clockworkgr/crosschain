# 4. Consensus

This chapter covers `src/consensus/`: the Tendermint state machine that turns a stream of proposals, votes and timer events into one agreed block per height, the vote bookkeeping it runs on, the private validator that signs for it and refuses to sign twice, the evidence pool that collects proof of double signing, and the block validation that consensus shares with block sync. It consumes the signing and verification primitives of [crypto](02-crypto.md) and the data shapes of [types](03-types.md) (votes, proposals, blocks, validator sets, chain state). It hands every decided block to the [executor](05-mempool-executor.md), takes transactions from the mempool through the same chapter, sends and receives its messages through the [p2p layer](06-p2p.md), shares `validate.ts` with [sync](07-sync.md), and is wired to all of them by the [node](08-node.md). The [light client](13-light-client.md) reuses `verifyCommit` from this chapter to check a commit without running consensus.

## Concepts

### Replicated state and why agreement is hard

A blockchain is a replicated state machine: every node holds the same state and applies the same ordered list of transactions, so every node ends up with the same state. The hard part is the ordering. Nodes are spread over a network that delays and drops messages, some nodes crash, and some nodes may lie. A consensus protocol is the procedure by which honest nodes still agree on one sequence of blocks.

The failure model matters. A protocol that only tolerates crashes (Paxos, Raft) assumes every node follows the rules. A *Byzantine* fault tolerant (BFT) protocol also tolerates nodes that behave arbitrarily: send different messages to different peers, vote twice, propose invalid blocks, or stay silent at the worst moment. The name comes from Lamport, Shostak and Pease's 1982 paper on the Byzantine generals problem. The classic result is that no deterministic protocol can tolerate a third or more of the participants being Byzantine: with `n` participants you need `n > 3f` to survive `f` faulty ones. Tendermint (Kwon 2014; Buchman, Kwon and Milosevic 2018, "The latest gossip on BFT consensus") is a BFT protocol in the family of PBFT (Castro and Liskov 1999) adapted to a blockchain: it produces one block per height, needs no leader election beyond a deterministic rotation, and gives *instant finality*: a block that is decided is never undone. CometBFT is the production implementation of Tendermint used by Cosmos chains; `DESIGN.md` section 1 states that this chain is a fresh TypeScript implementation of the same algorithm, not a fork.

### Voting power and the two-thirds rule

Validators are not equal. Each has a *voting power* (in this chain, bonded stake in whole tokens; see `STAKING.md`), and every threshold is measured in power, not in heads. Two thresholds appear everywhere, and both live on the validator set in `src/types/validator.ts`:

```ts
  /** Strictly more than two thirds of total power. */
  isQuorum(power: bigint): boolean {
    return power * 3n > this.totalPower * 2n;
  }

  /** Strictly more than one third: enough to prove at least one honest validator is included. */
  isOneThird(power: bigint): boolean {
    return power * 3n > this.totalPower;
  }
```

Written "+2/3" and "+1/3" in the Tendermint literature, where the plus means *strictly more than*. Why two thirds? Assume less than one third of the power is faulty. Then any two sets that each hold more than two thirds of the power overlap in more than one third of it, and that overlap must contain at least one honest validator, because the faulty ones alone cannot fill a third. So if +2/3 voted for block A in some round, no +2/3 can vote for a different block B in that round: an honest validator votes once per round. That overlap argument, applied to prevotes and precommits across rounds, is the whole safety proof. The +1/3 threshold is the dual: a set holding more than a third of the power must contain at least one honest validator, so a message from such a set can be trusted as evidence that "the honest network has moved on".

Both thresholds are computed with integer arithmetic on `bigint`, never with floating point (`DESIGN.md` section 4: no floats in state or anywhere consensus-critical).

### Heights, rounds, steps

Consensus runs one *height* at a time: height `h` decides block `h`. Within a height it runs *rounds* `0, 1, 2, ...`. Each round has one *proposer*, chosen deterministically from the validator set by the weighted round-robin of [chapter 3](03-types.md) (`ValidatorSet.incrementProposerPriority`). If a round fails to decide, the next round has the next proposer and longer timeouts. Each round has three steps:

- **propose**: the proposer broadcasts a block; everyone else waits for it, or for the propose timeout.
- **prevote**: each validator broadcasts a *prevote* for the proposed block if the block is valid and the validator is not locked on a different block, otherwise a prevote for *nil* (a vote for "no block this round").
- **precommit**: on seeing +2/3 prevotes for one block (a *polka*), a validator locks on that block and broadcasts a *precommit* for it; on +2/3 prevotes for nil, or on the prevote timeout, it precommits nil.

+2/3 precommits for one block in one round *decide* that block. Any other outcome ends the round, and the next round starts.

### Locking and the proof-of-lock round

The two-vote structure exists because of a subtle problem: a validator might see +2/3 precommits for block A and decide, while a slower validator misses them, times out, and moves to the next round. The next proposer must not be able to get a different block B decided at the same height. Tendermint prevents this with *locking*: when a validator precommits a block, it records that block's hash as its `lockedHash` with the round as `lockedRound`. In later rounds it prevotes nil for any other block. Since deciding A needed +2/3 precommits, +1/3 of the power (including at least one honest validator) is locked on A, and no polka for B can form.

Locking alone would deadlock if validators were locked on different blocks in different rounds (possible when messages arrive late). The escape is the proposal's `polRound` ("proof of lock round"): a proposer that has seen a polka for a block in an earlier round re-proposes that block and names the round. A validator whose lock is from `polRound` or an earlier round may unlock and prevote the re-proposed block, because the polka proves +2/3 preferred it no earlier than the validator's lock was taken. Its prevote says so: it names the same round in its own signed `polRound` ([chapter 3](03-types.md)). `src/types/proposal.ts` documents the field:

```ts
/**
 * A proposal carries the whole block. Blocks are small enough here that
 * splitting them into gossiped parts, as Tendermint does, is not worth it.
 *
 * `polRound` ("proof of lock round") is the round in which the proposer saw
 * a +2/3 prevote majority for this block, or -1 if it is a fresh block. It
 * lets validators locked on an older block safely unlock.
 */
```

The machine also tracks a `validBlock` and `validRound`: the most recent block that had a polka, whether or not this validator locked on it. The proposer re-proposes `validBlock` rather than building a new one, so a block that already had broad support is tried again instead of being abandoned.

### Timeouts and liveness

Safety never depends on timing: no matter how long messages take, two honest validators never decide different blocks. Liveness (the chain keeps producing blocks) depends on *weak synchrony*: eventually messages arrive within some bound. Each step has a timeout that grows with the round number, so if the network is slower than expected, rounds keep lengthening until one succeeds. The defaults in `src/consensus/consensus.ts`:

```ts
export const DEFAULT_TIMEOUTS: ConsensusTimeouts = {
  proposeMs: 3000,
  proposeDeltaMs: 500,
  prevoteMs: 1000,
  prevoteDeltaMs: 500,
  precommitMs: 1000,
  precommitDeltaMs: 500,
  commitMs: 1000,
  gossipMs: 500,
};
```

Round `r` waits `proposeMs + proposeDeltaMs * r` for a proposal, and likewise for the other two. `commitMs` is not a Tendermint step timeout: it is a pause after a decision, to gather stragglers' precommits and to pace block production. `gossipMs` is this chain's substitute for CometBFT's per-peer vote tracking: every validator re-sends its own current-round votes at that interval while the round is unresolved (`DESIGN.md` section 3).

`DESIGN.md` section 1 states the liveness bound: the chain halts once a third or more of the power is offline or partitioned. It does not fork; it stops, and resumes when enough power returns. `test/consensus.test.ts` checks both halves ("keeps going with one of four validators down", "halts with two of four validators down").

### Instant finality

In a longest-chain protocol (Bitcoin, early Ethereum) a block is "probably final" after enough blocks are built on top. In Tendermint a block with +2/3 precommits is final at once, because the safety argument above says no conflicting block can ever gather +2/3 at that height. The commit, the set of precommit signatures, travels with the next block as `lastCommit` and is what a light client checks. There is no reorganisation logic anywhere in this codebase.

### Why a validator must never sign two different blocks at one height and round

The overlap argument assumed an honest validator votes once per (height, round, vote type). A validator that signs prevotes for A and for B in the same round lets both sides count it, and if enough validators do it, two blocks can be decided at one height: a fork. This is the one fault Tendermint treats as provable misbehaviour, because the two signed votes are the proof. The chain calls it a *duplicate vote*; `src/types/evidence.ts` defines `DuplicateVoteEvidence` as the pair. A proposer that signs two proposals for one round does the same thing one step earlier, splitting the validators between two blocks, and is proven the same way: `DuplicateProposalEvidence` is the two signatures. The staking module moves part of the validator's stake to the community pool and tombstones the validator, which removes it from the set (`STAKING.md` sections 5 and 7).

A validator does not have to be malicious to double sign. The classic way is a crash: the validator signs a prevote for A, crashes before the vote reaches anyone, restarts, forgets, and signs a prevote for B. The private validator in `privval.ts` exists to make that impossible: it writes a record of what it last signed to disk before handing the signature back, and refuses anything at or before that point.

### Why a validator must never forget a lock

The other way to a fork needs no two votes in one place. Suppose A gathers +2/3 precommits in round 0 and some validators decide it, while others miss the precommits and go on to round 1. More than a third of the power is locked on A, so B cannot gather +2/3 prevotes in round 1, unless some of the locked validators prevote B anyway. Each of their votes is alone in its place, a precommit in round 0 and a prevote in round 1, and yet together they are what lets B be decided beside A. The fault is called *amnesia*.

Two things make it provable here. The first is that a prevote for a block says what it relies on: the signed `polRound` of [chapter 3](03-types.md). A validator that precommitted A in round `r` and prevotes B in a later round naming a round before `r`, or none, has said itself that it knew of no polka for B since its lock. Its two votes are `AmnesiaEvidence`, as self-contained as a duplicate vote.

That leaves the validator that names a round at or after its lock in which there was no polka. Its prevote is not counted (the second thing, next), and where the votes allow, it is punished too: if +2/3 of the power prevoted something other than B in the round it names, those prevotes beside its own are `FalseCitationEvidence`. This proof is of another nature than the other three. They convict on the accused's own signatures and nothing else. This one convicts unless more than a third of the power prevoted twice in the round named, which is the assumption the whole protocol makes, and a validator that did so to frame another is convicted itself by the two prevotes. It is also not always available: a liar that names a round in which a third of the power did prevote B, or in which too few prevoted at all, cannot be refuted.

The second closes the way round that: naming a round at or after `r` in which no polka for B ever formed. Two votes cannot show that something did not happen, so nothing is proven against such a prevote. It is made useless instead. A node counts a prevote that names round `vr` towards +2/3 for its block only once the node itself holds +2/3 prevotes, counted the same way, for that block in round `vr` (`src/consensus/votes.ts`, below). A prevote naming a polka that never was waits for ever and helps no quorum at an honest node.

Put together, provided less than two thirds of the power is faulty, so that every +2/3 of precommits includes an honest validator's: let A have +2/3 precommits in round `r` and another block be decided in a later round. An honest validator precommitted that block, so some honest node counted +2/3 prevotes for it; take the first round after `r` in which an honest node counts +2/3 prevotes for a block B other than A. Every prevote it counted names nothing or a round whose polka for B the node holds. A round after `r` it cannot be, since this is the first round after `r` with such a polka. So each names `r`, an earlier round, or nothing. More than a third of the power is in both majorities, and each of those validators either named a round before `r` or none, which with its precommit is amnesia evidence, or named `r` itself, and then round `r` held +2/3 prevotes for A and for B, which more than a third signed twice. A fork therefore always leaves evidence against more than a third of the power, of one kind or the other. (Two blocks decided in the same round are the simpler case: more than a third precommitted both.) Beyond two thirds faulty there is no such promise: validators holding +2/3 can precommit one block in one round and another in the next without a prevote between them, and two precommits in different rounds are something an honest validator may also sign.

As with the duplicate vote, the usual cause is not malice but a restart: a validator precommits A, dies, comes back in the same height knowing nothing of its lock, and prevotes the next proposal. So the lock is part of what the private validator writes before a precommit leaves, and the restarted validator takes it up again.

### Evidence

Evidence is a self-contained proof of misbehaviour. Any node that holds the signatures can build it (consensus does, when a vote set reports a conflict, when a precommit and a later prevote of one validator show a lock forgotten, when the prevotes of a round rule out the polka a later prevote names, and when a second proposal arrives for a round), nodes gossip it by inventory like transactions (`RPC-SYNC-PROOFS.md` section 4.4), proposers include it in blocks, every validator verifies it against the validator set of the height it refers to, and the executor hands it to the application as `misbehavior` (next chapter). Evidence older than the unbonding period is rejected, by block time, so that stake cannot escape a slash by leaving before the proof lands (`STAKING.md` section 2.2).

The two halves of a proof need not arrive in the same height. A validator that signs twice can show one node the second signature when the height is already decided, and a node that dropped everything of a height on leaving it would never hold both. So consensus keeps the votes and the proposals' signatures of the last `PAST_HEIGHTS_KEPT` heights, 16, takes late votes and proposals for them, and passes a late vote on if it is new, so that two votes shown to two nodes still meet at one of them. Nothing kept there can change a decision. The price is paid by a validator that is restarted without the record of what it last signed: it signs again in heights it already signed in, and its peers now hold the first signatures. That was always a double sign; it is now also found. `privval.ts`, below, is what prevents it, and for a validator that lost the record the node adds one thing: it signs nothing from its start until it is level with the peers it has heard ([chapter 8](08-node.md)), which keeps it out of the heights those peers have decided, and not out of the one they are in.

### Message flow

Proposals and votes are pushed directly to every peer with no inventory round trip (`DESIGN.md` section 3). A vote for the current height is dropped before verification when the node already holds it: the same height, round, type and validator index with the same block hash and the same `polRound`. A vote that differs from the held one in its hash or in the round it names goes on to verification, because the pair may be evidence, and the same holds for the next height: a vote for it that is already held, the same round, type, validator index, block hash and `polRound`, is dropped before its signature is verified, and one that says something else is verified and held beside it. Where a node does not send a proposal on (its block is invalid, or the round or the height has no more use for it), it sends the proposal's head, what the proposer signed without the block, if that is the first it holds for the round; a head is taken only as one half of a proof that the proposer signed two. Three mechanisms make up for the fact that a flooded message is sent once: each validator re-sends its own current-round votes every `gossipMs`, the proposer re-sends its proposal, and a newly connected peer is handed every valid proposal held for the current height that came signed, not a block that was fetched, the head held for each round whose proposal is not among those, and the vote held in each place of the vote sets, a prevote still waiting for the majority it names included and the other vote of a double signer not (`messagesForPeer`). Signature verification is asynchronous in worker threads ([chapter 2](02-crypto.md)), so each handler awaits the verifier and re-checks that the message is still relevant before touching state. All state mutation is synchronous on the main thread; there are no locks.

### A worked height

Four validators `v0..v3` of power 10 each, total 40. A quorum is power above 26.67, so any three validators; +1/3 is power above 13.33, so any two. Default timeouts. Call the round-0 proposer of height 7 `P`, computed identically by every node from the validator set.

| time | what happens |
|---|---|
| 0 ms | Every node's `startHeight` reads the chain state, sets `height = 7`, builds a fresh `HeightVoteSet`, and calls `startRound(0)`. `P` calls `propose()`: reaps transactions from the mempool, builds the block with `createBlock`, signs the proposal (guard record written to disk first), broadcasts it and feeds it to its own `handleProposal`. The other three arm the propose timeout for 3000 ms and the gossip timer for 500 ms. |
| ~5 ms | Each validator receives the proposal. `handleProposal` verifies the proposer's signature in a worker, then `validateBlockStructure` (header fields against state, sizes, time) and `verifyBlockSignatures` (the `lastCommit` of block 6 and any evidence). The proposal is stored for round 0 and re-broadcast. `evaluateRules` runs: rule 22 fires because the step is `propose` and `polRound` is -1. Step becomes `prevote`; the validator signs and broadcasts `PREVOTE(7, 0, hash)`. |
| ~20 ms | Each validator holds three or four prevotes for `hash`. Rule 34 (+2/3 prevotes for anything) arms the prevote timeout, 1000 ms. Rule 36 (polka for the proposed block) fires: `lockedHash = hash`, `lockedRound = 0`, step `precommit`, and it signs and broadcasts `PRECOMMIT(7, 0, hash)`, the private validator writing the lock in the same record as the signature; `validBlock` and `validRound` are set too. |
| ~40 ms | Three precommits for `hash` are in. Rule 47 arms the precommit timeout. Rule 49 fires: `decide(0, proposal)`. `decided = true`, step `commit`, all timers cleared, the commit is built from the precommit set (one signature per validator index, null for the missing fourth) and `applyBlock` runs the block through the application and persists it (next chapter). |
| ~60 ms | `applyBlock` resolves. `updateCommit` is called again with the current precommit set, in case precommits arrived while the block was being applied. The commit timer is armed for 1000 ms. |
| ~300 ms | `v3`'s precommit arrives late. `addVote` adds it to the vote set, sees `decided`, and since it is a precommit for the decided round and hash, calls `updateCommit` with a commit now holding four signatures. The executor stores the fuller commit. |
| ~1060 ms | The commit timer fires: `startHeight` for height 8, whose proposer builds `lastCommit` from the stored four-signature commit. |

If `P` is offline, the propose timeout fires at 3000 ms: `onTimeoutPropose` moves to `prevote` and prevotes nil. By ~3020 ms each validator holds three nil prevotes: rule 34 arms the prevote timeout, rule 44 (polka for nil) precommits nil. By ~3040 ms, +2/3 nil precommits: rule 47 arms the precommit timeout, 1000 ms. Nothing else can fire (rule 49 needs a block), so at ~4040 ms `onTimeoutPrecommit` calls `startRound(1)`: a new proposer, and a propose timeout of 3500 ms. Any validator that had already reached round 1 and voted there would have let the others skip ahead through rule 55 as soon as two of them (+1/3) were seen in the later round.

## The code, file by file

The modules in dependency order: `votes.ts` depends only on types and crypto, `privval.ts` on those, the codec and `writeAtomic` from `src/store/files.ts`; `evidence.ts` on types and the verifier; `validate.ts` on `evidence.ts`; `consensus.ts` on all four.

### src/consensus/privval.ts

The private validator is the only component that holds the validator's signing key, and the home of the double-sign guard. The file header states the rule:

```ts
 * Before any vote or proposal is signed, the (height, round, step) is
 * compared against the last one signed. Signing anything at or before that
 * point is refused, with one exception: re-signing byte-identical content,
 * which returns the stored signature. The record is written to durable
 * storage before the signature is handed back, so a crash and restart can
 * never produce a conflicting vote. This is the single most common bug in
 * new consensus implementations and the one that gets validators slashed.
```

`DESIGN.md` section 1 calls this "Non-negotiable", and section 4 explains why signing stays on the main thread while verification goes to workers: signing happens once per consensus step, about 3 ms, and keeping it inline makes the persist-then-broadcast ordering trivial.

**`SignStep`** is `{ Propose: 1, Prevote: 2, Precommit: 3 } as const`. The numbers order the steps within a round. Note that they are not the same values as `VoteType` (`Prevote: 1, Precommit: 2` in `src/types/vote.ts`); `signVote` maps one to the other.

**`LastSigned`** is the persisted record: `height`, `round`, `step`, `signBytes` (the exact bytes that were signed), `signature`, and `lock`. Keeping the bytes lets the guard recognise an identical re-sign and return the stored signature instead of refusing. **`Lock`** is `{ height, round, blockHash }`: the block the validator precommitted, and the round it did so in, the latest such round of the height. It is in the same record as the signature, so it is written by the same atomic write: there is no moment at which the precommit has left and the lock is not on disk.

**`SignStateStore`** is the persistence interface: `load(): LastSigned | null` and `save(s)`, with the comment "Must not return until the record is durable". Two implementations:

- **`MemorySignStateStore`** keeps the record in a field. The node uses it when it has no data directory (tests, in-memory simulations).
- **`FileSignStateStore`** encodes the record with the binary codec ([chapter 1](01-codec.md)) as `u64 height, u32 round, u8 step, bytes signBytes, bytes signature`, then the optional lock as `u64 height, u32 round, fixed blockHash`, and writes it with `writeAtomic` from `src/store/files.ts`: temp file, `fsync`, rename, then `fsync` of the directory. The directory sync was added for finding 16 of `REVIEW-2026-10-28.md`: without it a power loss could roll the rename back and a signature that had already been broadcast would be forgotten. The node puts the file at `<dataDir>/priv_validator_state.bin`.

**`DoubleSignError`** is the refusal. Consensus catches it by class in `signAndAddVote`.

**`PrivValidator`** holds the `KeyPair`, exposes `address` and `publicKey`, and precomputes the two signing contexts (`signContext(chainId, 'vote')` and `'proposal'`, [chapter 2](02-crypto.md)) so that a vote signature can never verify as a proposal signature or as anything on another chain. The constructor loads the last record from the store.

- `lastSigned()` returns `{ height, round, step }` or null. `Consensus.startHeight` uses it to resume after a restart in a round it can still sign.
- `lockAt(height)` returns the lock held for a height, or null: the record's lock, if it is of that height. `Consensus.startHeight` takes it up after a restart.
- `signProposal(chainId, p: UnsignedProposal)` calls the guard with `SignStep.Propose` and `proposalSignBytes`, keeping whatever lock the height has.
- `signVote(chainId, v: UnsignedVote)` is where the lock is taken and kept:

```ts
  signVote(chainId: string, v: UnsignedVote): Uint8Array {
    const bad = checkPolRound(v);
    if (bad) throw new DoubleSignError(`refusing to sign a vote at ${v.height}/${v.round}: ${bad}`);
    const held = this.lockAt(v.height);
    if (v.type === VoteType.Prevote) {
      // Locked: a prevote for a block names a majority from the round of the lock or later, which for another block
      // is what releases the lock and for the locked block is what the lock stands on.
      if (held && v.blockHash !== null && v.polRound < held.round) {
        throw new DoubleSignError(`refusing to prevote a block at ${v.height}/${v.round}: locked in round ${held.round}, and the proof of lock named is from round ${v.polRound}`);
      }
      return this.guardedSign(v.height, v.round, SignStep.Prevote, voteSignBytes(chainId, v), this.voteCtx, held);
    }
    const lock = v.blockHash !== null ? { height: v.height, round: v.round, blockHash: v.blockHash } : held;
    return this.guardedSign(v.height, v.round, SignStep.Precommit, voteSignBytes(chainId, v), this.voteCtx, lock);
  }
```

A vote that `checkPolRound` refuses is not signed at all. A prevote for a block is signed, once there is a lock, only if the round it names is the round of the lock or a later one. For another block that is the rule consensus follows (rule 28, below): only such a majority releases the lock. For the locked block it is the majority the lock was taken on, which consensus names for that reason (`prevote`, below). The check is the same for both on purpose. A lock can move: locked on B in round 1, then on D in round 2, a validator asked to prevote D again on D's old majority of round 0 would, by naming round 0, sign a prevote that stands as amnesia evidence beside its precommit for B. The rule is held here a second time because this is the component that survives a restart and the one a bug in the state machine cannot talk round. A prevote for nil is always open. A precommit for a block moves the lock to its round; a precommit for nil leaves it where it was, as in the paper, where a lock is only ever replaced. A lock of an earlier height is none: `lockAt` compares the height, and the next record written carries `null`.

The guard itself:

```ts
  /** `lock` is the lock as it stands once this is signed; it is written with the signature. */
  private guardedSign(height: bigint, round: number, step: number, signBytes: Uint8Array, ctx: Uint8Array, lock: Lock | null): Uint8Array {
    const last = this.last;
    if (last) {
      const cmp = height !== last.height ? (height < last.height ? -1 : 1) : round !== last.round ? round - last.round : step - last.step;
      if (cmp < 0) throw new DoubleSignError(`refusing to sign ${height}/${round}/${step}: already signed ${last.height}/${last.round}/${last.step}`);
      if (cmp === 0) {
        if (bytesEqual(signBytes, last.signBytes)) return last.signature;
        throw new DoubleSignError(`refusing to sign conflicting content at ${height}/${round}/${step}`);
      }
    }
    const signature = sign(signBytes, this.key.secretKey, ctx);
    const record: LastSigned = { height, round, step, signBytes, signature, lock };
    // Durable before anyone can broadcast it.
    this.store.save(record);
    this.last = record;
    return signature;
  }
```

`cmp` is a lexicographic comparison of (height, round, step). A point earlier in that order is refused; a later height starts again at any round and step, and a later round at any step. Equal means the same (height, round, step): identical bytes return the stored signature (this is how the gossip re-send can call `signVote` again safely, though in practice consensus re-sends the stored `Vote` object and never re-signs), different bytes are refused. Only a strictly later point is signed, and the record is saved before the signature is returned. The invariant: *for any (height, round, step), the validator has signed at most one distinct message, and that fact survives a crash*.

What the record holds of the lock is the hash, not the block. That is enough for every rule a locked validator follows (prevote the locked block or nil; prevote another only on a polka from the lock's round on), and the block itself is offered again by whoever proposes it. CometBFT recovers lock state by replaying a write-ahead log; this chain has no WAL, and the one record does the work for the lock.

Failure modes: a refusal in a vote is logged at `error` level and the vote is simply not cast; a refusal in a proposal is logged and `propose()` returns without arming a timeout. Finding 5 of the review showed that this could deadlock a single-validator chain after a restart; the fix is in `Consensus.startHeight`, which resumes in the round after the one the guard already holds, so the guard is never asked to re-sign a round with fresh content.

`test/units.test.ts`, `describe('private validator')`, "refuses to sign backwards or conflicting content, allows identical re-signs", pins the exact behaviour: same bytes return the same signature; a different block hash, an earlier round, an earlier height, and a prevote after a precommit in the same round all throw `DoubleSignError`; a precommit after a prevote and a later height both succeed. `test/amnesia.test.ts`, "writes the lock with the precommit that takes it, and signs a prevote for another block only on a proof of lock from that round on", walks the lock through a height on a file store: nothing locked by a prevote or a precommit for nil, the lock in the file after a precommit for a block and still there for a new `PrivValidator` on the same file, a prevote for another block refused when it names no round or an older one and signed when it names the lock's round, the locked block itself refused on an older round and signed on the lock's, a lock that moved from one block to another with the prevote that would have been evidence refused, the lock moved by the next precommit for a block, kept under a proposal, and gone with the first signature of the next height.

### src/consensus/votes.ts

Vote bookkeeping for one height. The file answers the three questions the rules ask ("is there +2/3 for some value", "is there +2/3 for this value", "how much power has voted") and is where double signing is caught.

**`VoteSet`** holds the votes of one type (prevote or precommit) for one round, indexed by validator index into the height's validator set. Fields: `height`, `round`, `type`, a private `votes: (Vote | null)[]` sized to the set, `powerByBlock: Map<string, bigint>` keyed by `blockHashKey` (`'nil'` or the hex of the hash, from `src/types/vote.ts`), `waiting`, the indices of prevotes held and not yet counted for their block, and `totalVoted`.

```ts
  /** `backed` false holds the vote without counting it for its block; `back` counts it later. */
  add(vote: Vote, backed = true): { added: boolean; conflict: Vote | null } {
    if (vote.height !== this.height || vote.round !== this.round || vote.type !== this.type) throw new Error('vote does not belong to this set');
    const val = this.valset.byIndex(vote.validatorIndex);
    if (!val) return { added: false, conflict: null };
    const existing = this.votes[vote.validatorIndex];
    if (existing) {
      // The same vote again is nothing; another vote in the same place is a double sign, whether it differs in the
      // block or only in the proof of lock it names.
      if (sameVoteContent(existing, vote)) return { added: false, conflict: null };
      // Of two votes in one place the one that counts is kept: a validator that signs twice must not be able to
      // leave a node holding only the vote that waits for a majority that will never come.
      const replaced = backed && this.waiting.delete(vote.validatorIndex);
      if (replaced) {
        this.votes[vote.validatorIndex] = vote;
        this.count(vote, val.power);
      }
      // The vote not kept is put aside, if none is yet, or if the one put aside is the vote that has just taken the place.
      const aside = this.others.get(vote.validatorIndex);
      if (!aside || (replaced && sameVoteContent(aside, vote))) this.others.set(vote.validatorIndex, replaced ? existing : vote);
      return { added: false, conflict: existing };
    }
    this.votes[vote.validatorIndex] = vote;
    this.totalVoted += val.power;
    if (backed) this.count(vote, val.power);
    else this.waiting.add(vote.validatorIndex);
    return { added: true, conflict: null };
  }
```

The invariant is one vote per validator per set. A second vote that says the same thing (`sameVoteContent`: the same hash and the same `polRound`) is a duplicate (`added: false`, no conflict). A second vote that says anything else is returned as `conflict` together with the existing one, and is not stored, with one exception: if the vote held is waiting uncounted and the new one counts, the new one takes its place, so that a validator signing twice cannot leave a node holding only the vote that waits for a majority which will never come. Either way the caller (`Consensus.addVote`) turns the pair into evidence, and the vote that is not kept is put aside in `others`, the first such vote for each validator (if the vote put aside later takes the place, the one it displaced is put aside instead, so the two stay two); `alternates()` returns them. They count for nothing and are not passed on, but they are signed, and a proof against another validator may rest on one (`refuter`, below). A nil vote and a block vote from the same validator are a conflict, and so are two prevotes for one block that name different rounds. A vote added with `backed` false is held and counts in `totalVoted`, but not in `powerByBlock`: it is a vote cast, and not yet a vote for its block. `waitingOn(polRound, blockHash)` lists such votes and `back(validatorIndex)` counts one. `add` does not verify signatures; the caller does that before calling.

The rest of the class:

- `has(validatorIndex)`, `get(validatorIndex)`: lookup by index.
- `power()`: total power that has voted, for anything.
- `hasQuorumAny()`: `valset.isQuorum(totalVoted)`. Rule 34 and rule 47 use it.
- `hasQuorumFor(blockHash | null)`: +2/3 for one specific value, nil included, among the votes that count for it. Rules 28, 36, 44 and 49.
- `quorumValue()`: the one value with +2/3 (null for nil) or `undefined` if none. Used by `handleFetchedBlock` and the fetch branch of rule 49.
- `all()`, `voterIndices()`: enumeration for gossip and for `roundPower`.
- `toCommit(blockHash)`: builds a `Commit` whose `signatures[i]` is validator `i`'s signature if it precommitted `blockHash`, else null. This is the structure the next block carries as `lastCommit`, and `src/types/block.ts` notes it is linear in the validator count because signatures are not aggregated under either scheme.

**`HeightVoteSet`** is a map from round number to a pair of `VoteSet`s, created lazily by the private `round(r)`:

```ts
  private round(r: number): RoundVotes {
    let rv = this.rounds.get(r);
    if (!rv) {
      rv = { prevotes: new VoteSet(this.height, r, 1, this.valset), precommits: new VoteSet(this.height, r, 2, this.valset) };
      this.rounds.set(r, rv);
    }
    return rv;
  }
```

The literals `1` and `2` are `VoteType.Prevote` and `VoteType.Precommit`; the file imports only the type, not the constant. Methods: `prevotes(r)`, `precommits(r)`, `set(vote)` (picks the set by type), `has(vote)` (true only if the same validator already cast the same vote, hash and `polRound`, in that set; used by `handleVote` to drop duplicates before paying for verification), `allVotes()` (every vote of every round and type, for `messagesForPeer`), `roundNumbers()` (sorted ascending; rule 49 and rule 55 iterate it), `dropRoundsAbove(r)` (forgets the rounds after `r`, when a height that is over is kept; `keepHeight`, below), and:

```ts
  /** Power of validators that have cast any vote in round r. Used to detect that the network has moved on. */
  roundPower(r: number): bigint {
    const rv = this.rounds.get(r);
    if (!rv) return 0n;
    const seen = new Set<number>([...rv.prevotes.voterIndices(), ...rv.precommits.voterIndices()]);
    let p = 0n;
    for (const i of seen) p += this.valset.byIndex(i)!.power;
    return p;
  }
```

`add(vote)` is where the rule of the concepts section lives, the one that makes a prevote naming a polka that never was useless:

```ts
  /**
   * A prevote that names a proof-of-lock round is counted for its block if the prevotes counted in that round have
   * +2/3 for the block, and waits otherwise. A vote that completes such a majority releases the votes waiting on
   * it, in whatever round they are, and those may complete majorities others wait on.
   */
  add(vote: Vote): { added: boolean; conflict: Vote | null } {
    if (vote.height !== this.height) throw new Error('wrong height');
    const cites = vote.type === 1 && vote.blockHash !== null && vote.polRound >= 0;
    const result = this.set(vote).add(vote, !cites || this.prevotes(vote.polRound).hasQuorumFor(vote.blockHash));
    // Also when the vote was not added: of two votes in one place the counted one is kept, which may have counted this one.
    if (vote.type === 1 && vote.blockHash !== null) this.release(vote.round, vote.blockHash);
    return result;
  }

  private release(round: number, blockHash: Uint8Array): void {
    const completed = [round];
    for (let r = completed.pop(); r !== undefined; r = completed.pop()) {
      if (!this.prevotes(r).hasQuorumFor(blockHash)) continue;
      for (const [later, rv] of this.rounds) {
        if (later <= r) continue;
        const waiting = rv.prevotes.waitingOn(r, blockHash);
        for (const v of waiting) rv.prevotes.back(v.validatorIndex);
        if (waiting.length > 0) completed.push(later);
      }
    }
  }
```

A prevote for a block that names round `vr` is handed to its `VoteSet` as backed only if the prevotes counted in round `vr` already have +2/3 for that block. Otherwise it waits there. Votes arrive in any order (a node that joins a round late gets the later round's prevotes before the earlier round's), so every prevote for a block that is added, or released, may be the one that completes a majority others wait on: `release` checks the round it was added to, counts the votes of later rounds that were waiting on exactly that round and block, and then checks each round where it counted something, since those may now have a majority of their own that later rounds name. It ends because a vote is released once and a round names only earlier rounds.

What waits still counts as a vote cast: `hasQuorumAny` and `roundPower` see it, so the timeouts and the skip to a later round behave as before. Only "+2/3 for this block" asks for backed votes, which is what rules 28 and 36 ask. A node that lacks an earlier round's prevotes is brought up by the gossip tick, which sends the prevotes behind a valid block all the way back (`scheduleGossip`, below), and in the meantime it is no worse off than a node that missed the proposal: it decides on the precommits of the others. `test/amnesia.test.ts`, "counts for its block only once the majority it names is held, however the votes arrive", adds the votes of two and three linked rounds latest first and watches the majorities appear with the last vote of the earliest round, and shows that a majority for another block in the round named backs nothing.

A validator that cast both a prevote and a precommit in round `r` is counted once. Rule 55 compares this with `isOneThird`.

A thing to notice: a peer can make the node allocate a `VoteSet` pair for any round number it names in a vote, because `set(vote)` creates the round on first use. `Consensus.handleVote` bounds this with `MAX_ROUND_AHEAD` before the vote reaches `addVote`.

### src/consensus/evidence.ts

**`evidenceId(ev)`** is `sha256` of the codec encoding of one piece of evidence; it is the inventory key the p2p layer announces and fetches by (`src/node/node.ts` maps evidence through it for the `onAdded` broadcast and for the pending list a new peer receives). Its comment separates it from `evidenceHash` in `src/types/block.ts`, "the root over a list", which hashes a block's whole evidence list for the header; `consensus.ts` imports that one.

**`EvidencePool`** holds evidence waiting to be included in a block. Three containers: `pending` (keyed by `evidenceKey` of [chapter 3](03-types.md), so one record per offence), `committed` (the evidence that has been in a block, under the same keys, kept so that it is not taken in a second time), and `byHash` (inventory hash to evidence, for serving fetches). **`EvidencePool.MAX_PENDING`**, 1,000, is the most evidence that waits for a block: "a block carries far less, and one piece is enough to punish a validator." Methods:

- `add(ev): boolean` returns false if the key is already pending or committed, if `MAX_PENDING` pieces already wait (a validator willing to sign twice can do so at every height and round inside the window), if the record encodes to more than `maxRecordBytes`, or if it would take what waits past `MAX_PENDING_BYTES`, 32 MiB; otherwise stores it, indexes it by hash, notifies the `onAdded` listeners and returns true. The node's listener broadcasts an inventory announcement (`src/node/node.ts`).
- `maxRecordBytes` is the most one record may encode to (`evidenceBytes(ev)`, the length of its encoding) and still be taken in. It is `Infinity` until the node sets it to what a block builder gives one piece of evidence: half the chain's block size, less the builder's slack of 1 KiB and the eight bytes of the two array counts ([chapter 8](08-node.md)). Three kinds of evidence are two signatures and far below it. A false citation carries a vote for most of the validator set, about 2.5 KiB each under ML-DSA-44, and with a large set or small blocks it can be more than any proposer would include; a record like that, left waiting, would sit at the head of the list and keep every other record out of every block (`createBlock`, below), and on a node that never proposes it would simply accumulate. So the limit is the pool's, applied on every node and to both ways in. It is a rule for what waits, not for what is valid: a block may carry a larger record if its proposer put one in, and `markCommitted` records it like any other.
- `onAdded(fn)`, `getByHash(hash)`, `hasHash(hash)`, `has(ev)`: lookups the gossip code needs. `size` and `bytes` are the number and the encoded bytes of what waits.
- `list(max = 100)`: pending evidence in insertion order, capped. `createBlock` calls it with `MAX_EVIDENCE_PER_BLOCK`, 16 (from `validate.ts`, below), and the node with `Infinity` to announce everything pending to a newly connected peer.
- `markCommitted(evs)`: the executor calls this after applying a block, moving the evidence from pending to committed so the same infraction is never included twice. What waited for the same offence may be another pair of votes, under another hash, so the inventory entry of the pair that waited is removed. It also records the inventory entry of the committed evidence, so that evidence that came in a block without passing through the pool is served by hash like the rest.
- `pruneIf(stale)`: forgets evidence for which the predicate is true, pending or committed, and its inventory entry:

```ts
  pruneIf(stale: (ev: Evidence) => boolean): void {
    for (const held of [this.pending, this.committed]) {
      for (const [k, ev] of held) {
        if (!stale(ev)) continue;
        if (held === this.pending) this.forget(k);
        held.delete(k);
        this.byHash.delete(toHex(evidenceId(ev)));
      }
    }
  }
```

  `createBlock` uses it with `evidenceAgeOk` so a proposer never includes evidence that validators would reject as too old, and the executor calls it after every commit ([chapter 5](05-mempool-executor.md)), so a node that never proposes lets go of what it holds as well.
- `size`: pending count. Tests read it.
- `held`: `{ pending, committed, inventory }`, the sizes of the three containers, for tests and status.

Invariant: an infraction key is in at most one of `pending` and `committed`. Everything the pool holds is let go once it is too old for any block to carry. Both callers' predicates count evidence whose height they have no block time for as stale: the node prunes blocks and headers only when they are older than the evidence window, so a height whose time is no longer held is a height too old, which on a pruning node is how evidence that has just expired leaves ([chapter 5](05-mempool-executor.md)). Before, only a proposer pruned, and only what was pending, so `committed` and `byHash` grew for ever.

**`verifyEvidence(chainId, ev, valset, verifier)`** is the full check of every kind:

```ts
/**
 * Full verification: shape, then every signature against the validator set of that height, and for a false
 * citation the power behind the prevotes that speak against it, which must be +2/3 of that set.
 */
export async function verifyEvidence(chainId: string, ev: Evidence, valset: ValidatorSet, verifier: Verifier): Promise<string | null> {
  const shape = checkEvidenceShape(ev);
  if (shape) return shape;
  const val = valset.byIndex(evidenceValidator(ev));
  if (!val) return 'unknown validator index';
  let jobs;
  if (ev.kind === 'duplicateProposal') {
    const ctx = signContext(chainId, 'proposal');
    jobs = [ev.a, ev.b].map((h) => ({ sig: h.signature, msg: proposalHeadSignBytes(chainId, ev.height, ev.round, h.polRound, h.blockHash), publicKey: val.publicKey, context: ctx }));
  } else {
    const ctx = signContext(chainId, 'vote');
    jobs = [];
    let against = 0n;
    for (const [i, v] of evidenceVotes(ev).entries()) {
      // Each vote under the key of its own signer: in a false citation only the first is the accused's.
      const signer = valset.byIndex(v.validatorIndex);
      if (!signer) return 'unknown validator index';
      if (i > 0) against += signer.power;
      jobs.push({ sig: v.signature, msg: voteSignBytes(chainId, v), publicKey: signer.publicKey, context: ctx });
    }
    if (ev.kind === 'falseCitation' && !valset.isQuorum(against)) return 'the prevotes against the round named are not +2/3 of the power';
  }
  const results = await verifier.verify(jobs);
  if (results.some((ok) => !ok)) return 'bad signature in evidence';
  return null;
}
```

`checkEvidenceShape` from `src/types/evidence.ts` ([chapter 3](03-types.md)) says whether what is given is one of the four faults at all; then the accused's index must exist in `valset` (the set of the infraction height, not the current one), and every signature is verified in one batch. Two proposals are checked with the proposal context over `proposalHeadSignBytes` of the evidence's height and round and each head's `polRound` and hash, both under the accused's key; whether the accused was the proposer of that round is not asked, since a validator has no business signing two proposals for a round in any case. Votes are checked with the vote context, exactly as given, `polRound` included, each under the key of its own signer, which for a false citation is a different validator for every vote after the first. For that kind the powers of those signers are added up on the way, and less than +2/3 of the set is refused before any signature is verified: `the prevotes against the round named are not +2/3 of the power`. Returns an error string or null. Callers: `verifyBlockSignatures` below, and `Node.acceptEvidence` for gossiped evidence, which first asks `evidenceAgeOk` (below) whether the next block could still carry it, at the last block's time: evidence that is too old, names a height the node has no time for, or lies beyond the height being decided is dropped unverified and unpooled, and the peer is not charged, since it may be ahead of this node or hold history this node has pruned.

The node builds evidence in two ways: locally in `Consensus` (`report`, below), from the votes and proposals it holds for its height and for the heights it keeps, and from peers by inventory. `test/recovery.test.ts`, `test/amnesia.test.ts` and `test/faults.test.ts` exercise the first path and `test/sync.test.ts` the second.

### src/consensus/validate.ts

Block validation shared by consensus (for proposals and fetched blocks) and block sync (for downloaded blocks). Structural checks are synchronous; signature checks go through the verifier.

**`ValidationLimits`**: `maxBlockBytes` (the most bytes a block's transactions and evidence may encode to; a rule of the chain, which the node reads from `genesis.consensus.maxBlockBytes`, 4 MiB when the genesis names none, and which every node must hold alike), `maxClockDriftMs` (15 s: how far a freshly proposed block's time may be from local time; a node's own rule for what it votes for, like its clock, which is not applied to a block being committed or synced, so nodes may differ in it), `maxEvidenceAgeMs` (7 days by default; the node overrides it from `genesis.consensus.maxEvidenceAgeMs` and, with the core application, follows the staking unbonding period, which it reads from the application whenever the age is asked for, unless its own `limits` configuration names an age). **`BlockTimeLookup`** is `(height) => bigint | null`, satisfied by `BlockExecutor.blockTimeAt`.

**`MAX_EVIDENCE_PER_BLOCK`**, 16, is the most evidence a block may carry:

```ts
/**
 * The most evidence a block may carry. A rule of the chain, not of a node: a proposer takes no more from its pool,
 * and a block with more is refused by everyone, so one proposer cannot make every node verify an unbounded list.
 */
export const MAX_EVIDENCE_PER_BLOCK = 16;
```

It is a constant, not one of the limits a node may configure, so every node gives the same answer for the same block.

**`evidenceAgeOk(infractionHeight, atHeight, atMs, state, limits, blockTimeAt)`** implements `STAKING.md` section 2.2: evidence is accepted at a block with time `atMs` if the infraction block's time is at most `maxEvidenceAgeMs` earlier.

```ts
export function evidenceAgeOk(infractionHeight: bigint, atHeight: bigint, atMs: bigint, state: ChainState, limits: ValidationLimits, blockTimeAt: BlockTimeLookup): string | null {
  if (infractionHeight > atHeight) return 'evidence from the future';
  const t = infractionHeight === atHeight ? atMs : infractionHeight === state.lastHeight ? state.lastBlockTime : blockTimeAt(infractionHeight);
  if (t === null) return 'evidence for an unknown height';
  if (atMs - t > limits.maxEvidenceAgeMs) return 'evidence too old';
  return null;
}
```

Evidence for the height being built uses the new block's own time (a double sign in the current height can be included at once); for the last height it uses chain state; anything older reads the stored header, and a height the store has pruned is rejected as unknown. Age is measured by block time rather than block count so that it stays equal to the unbonding period whatever the block interval.

**`validateBlockStructure(state, block, limits, nowMs, blockTimeAt)`** runs every check that needs no signatures, in this order, returning the first failure as a string: chain id; protocol `version` equals the state's (added by `RPC-SYNC-PROOFS.md` section 2.1); height is `lastHeight + 1`; `lastBlockHash`, `validatorsHash`, `nextValidatorsHash`, `prioritiesHash` (the hash of the proposer priorities of the state's two sets, [chapter 3](03-types.md)), `appHash`, `dataHash` (recomputed with `txsRoot`), `lastResultsHash`, `evidenceHash` and `lastCommitHash` all match state or the block body; time is strictly after the last block time; if `nowMs` is not null, time is within `maxClockDriftMs` of it; the `proposerAddress` is in the current validator set; height 1 has no `lastCommit`, every other height has one for `lastHeight`, for `lastBlockHash`, with exactly `lastValidators.size` signature slots; there are at most `MAX_EVIDENCE_PER_BLOCK` evidence items (`'too much evidence'`); every one of them passes `evidenceAgeOk`; and the block's transactions and evidence encode to at most `maxBlockBytes` (`blockDataBytes`, [chapter 3](03-types.md); `'block too large'`). The header and the last commit are not counted: the header has a fixed shape and the commit one signature for each validator, so neither is the proposer's to shrink. An empty block is therefore within the limit whatever the validator set, and a whole block is at most `maxBlockBytes` plus its header and commit.

Two points deserve attention. First, `appHash` and `lastResultsHash` are compared against chain state, which is the result of executing the *previous* block: this is deferred execution (next chapter), and it is why a validator can validate a proposal without running its transactions. Second, the proposer check is only membership. The round's proposer is checked separately by `handleProposal` against the proposal signature, because a re-proposed block carries the address of whoever built it first (review finding 4). Consensus passes `this.now()` as `nowMs` only for a fresh proposal (`polRound === -1`): a block re-proposed with a proof of lock keeps the time its first proposer gave it, and must still be decidable after a round that stalled past the drift limit (review finding 37). Block sync and `handleFetchedBlock` pass `null`, since a block the network has already committed cannot be judged against this node's clock.

**`verifyCommit(chainId, valset, hash, commit, verifier)`** checks that a commit finalises `hash` under `valset`: the commit's `blockHash` matches, the signature array has exactly `valset.size` slots, the power of the non-null slots reaches +2/3 (checked before any signature work, so a commit that cannot possibly pass costs nothing), and every included signature verifies as `PRECOMMIT(height, round, hash)` by the validator at that index. The sign bytes are rebuilt with `voteSignBytes`, so a prevote signature or a signature for another round cannot be passed off as a precommit. The light client, state sync and block sync import this function.

**`verifyBlockSignatures(chainId, state, block, verifier, validatorSetAtHeight)`** verifies `block.lastCommit` with `verifyCommit` against `state.lastValidators` and `state.lastBlockHash`, then every evidence item with `verifyEvidence` against the set of its own height, obtained from the executor.

### src/consensus/consensus.ts

The state machine. Its file header is a good summary and should be read first; the key sentence is that the machine "is purely event driven: a proposal arrives, a vote arrives, or a timer fires; after each event every rule is re-evaluated until none fires", and that each numbered rule in `evaluateRules` cites a line of the Tendermint paper's pseudocode (Algorithm 1 in Buchman, Kwon and Milosevic 2018).

#### Configuration and dependencies

- **`ConsensusTimeouts`** and **`DEFAULT_TIMEOUTS`**: shown above. The tests use `FAST_TIMEOUTS` from `test/helpers.ts` (400/200, 200/100, 200/100, 50, 150 ms).
- **`DEFAULT_LIMITS`**: 4 MiB blocks (`DEFAULT_MAX_BLOCK_BYTES` from `src/types/genesis.ts`, what a chain has when its genesis names no size), 15 s drift, 7 days of evidence age.
- **`Step`** is `'propose' | 'prevote' | 'precommit' | 'commit'`; a private `STEP_ORDER` gives them numbers so rule 36 can test "step at least prevote".
- **`MAX_ROUND_AHEAD`** is 1000. The comment: "Rounds beyond this many ahead of ours are ignored; a round number is otherwise a free CPU budget for a peer." Review finding 6 found that a proposal for round 4294967295 made the node run billions of proposer-priority iterations before even checking the signature, because `proposerAt(r)` costs O(r).
- `MAX_NEXT_HEIGHT_PROPOSALS` (8) and `MAX_NEXT_HEIGHT_PROPOSALS_PER_VALIDATOR` (2), the proposals for the next height held until it starts, "in all and signed by any one validator", are private. `MAX_EVIDENCE_PER_BLOCK` is imported from `validate.ts`.
- **`VOTES_PER_PEER_SECOND`** is 200: the votes of one peer whose signatures a node verifies in a second, "or eight for each validator if that is more"; `MAX_DEFERRED_VOTES_PER_PEER`, 1,024, is the least number of votes over it that may wait for one peer (64 for each validator if that is more, up to `DEFERRED_VOTES_CAP`, 32,768), and `DEFERRED_VOTES_MS`, 250, how long before they are tried again; `VOTE_FLOOD_POINTS`, 10, is what a peer is charged for a second in which a vote of its found no room, and `MAX_REFUSED`, 64, the most evidence that waits for room in the pool.
- **`PAST_HEIGHTS_KEPT`** is 16: the heights that are over whose votes and proposals are kept, "to hold a late vote or proposal against". The private **`PastHeight`** is what is kept of one: `validators`, `votes` (the height's `HeightVoteSet`), `maxRound` (the round it ended in), `proposals` (what each round's proposer signed, a `ProposalHead` by round; the height's `heads`) and `proposedTwice` (the rounds already reported).
- **`StaleHeightError`** is thrown by the executor when a block arrives for a height that has already passed; `decide` treats it as "block sync got there first".
- **`ConsensusDeps`** is everything consensus needs from the node. Reading the fields is reading the node wiring in `src/node/node.ts`: `chainId`; `getState()` is the executor's chain state; `applyBlock` and `updateCommit` go to the executor; `blockTimeAt` reads stored headers for evidence age; `requestBlock` broadcasts a `blockRequest` (the hash argument is accepted but the node sends only the height); `scorePeer` feeds the p2p scoring; `getLastCommit` loads the previous block's commit, needed to build a block; `validatorSetAtHeight` for evidence verification and for votes of the next height; `reapTxs(maxBytes)` is `mempool.reap`; `privValidator` is null on a full node; `verifier`; `evidencePool`; `broadcastProposal` and `broadcastVote` with an `exceptPeer` so a message is not echoed to its sender; the optional `broadcastProposalHead`, which sends what a round's proposer signed without the block (below); the optional `signingHeld()`, which answers why this validator is not to sign for now, or null (the node holds a validator back from its start until it is level with a peer, [chapter 8](08-node.md)); optional `timeouts`, `limits` and `now` (injectable clock); `log`.
- `RoundProposal` (private) is what the machine stores per round: the `proposal`, whether the block was `valid`, its `hash`, and `fetched` for a block obtained through `handleFetchedBlock` rather than from the proposer.

#### State

The public fields are the paper's variables: `height`, `round`, `step`, `lockedHash`/`lockedRound`, `validBlock`/`validRound`. The lock is held by hash: after a restart the block itself may not be at hand, and no rule needs more than its hash. Private state: the two signing contexts, `voteCtx` and `proposalCtx`, built once in the constructor; the height's `validators` and `hvs` (`HeightVoteSet`); `proposals` by round; `proposerCache` by round; three sets that implement the paper's "for the first time" clauses (`prevoteTimeoutScheduled`, `precommitTimeoutScheduled`, `polkaHandled`); `timers` by key; buffers for messages of the next height (`nextHeightVotes`, each entry a `{ vote, publicKey }` pair recording the key the vote verified under, with `nextHeightVoteKeys`, the set of the held votes' keys that says in one lookup whether a vote is already there, and `nextHeightProposals`, each entry a `{ proposal, from, signer }` record of the peer the proposal came from and the address of the validator whose signature on it verified); the decision record (`decided`, `decidedRound`, `decidedHash`); `fetchRequested` (hashes of this height's blocks already asked for); `running`; the re-entrancy pair `evaluating`/`reevaluate`; `decisionCount`.

`limits` is a getter that merges `DEFAULT_LIMITS` with the `limitsRef` object the node passed, on every read. The comment says why: "the node adjusts the evidence age when the unbonding period changes". The node's `evidenceAge()` writes into that same object (`limits.maxEvidenceAgeMs = this.app.stakingParameters().unbondingPeriodMs`, when the application is the core one and the node's configuration names no age of its own) once the executor is open, each time the executor asks for the age after applying a block, and after each commit, and consensus sees the change without a setter.

Two getters: `isValidator` (a key is present and its address is in the current set) and `isDeciding` (`decided`; block sync polls it to avoid applying a block while consensus is in the middle of applying one).

#### Lifecycle: `start`, `stop`, `restart`

`start()` sets `running` and calls `startHeight()`. `stop()` clears `running` and every timer; every handler and timer callback checks `running` first, so a stopped machine ignores late events. `restart()` is called by block sync after it applied blocks behind consensus's back: if consensus is already on the height after the last committed block (`state.lastHeight + 1n === this.height`), nothing happens; otherwise `startHeight()` moves to that height.

#### `startHeight`

```ts
  private startHeight(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const st = this.d.getState();
    if (this.hvs && st.lastHeight + 1n > this.height) this.keepHeight(st.lastHeight + 1n);
    if (this.refused.size > 0) this.reportRefused(st);
    this.height = st.lastHeight + 1n;
    this.validators = st.validators;
    this.hvs = new HeightVoteSet(this.height, this.validators);
    this.proposals.clear();
    this.heads = new Map();
    this.proposedTwice = new Set();
    this.proposerCache.clear();
    this.prevoteTimeoutScheduled.clear();
    this.precommitTimeoutScheduled.clear();
    this.polkaHandled.clear();
    this.fetchRequested.clear(); // the hashes asked for belong to the height that is over
    // The lock of this height, if the validator precommitted a block in it before a restart.
    const lock = this.d.privValidator?.lockAt(this.height) ?? null;
    this.lockedHash = lock ? lock.blockHash : null;
    this.lockedRound = lock ? lock.round : -1;
    this.validBlock = null;
    this.validRound = -1;
    this.decided = false;
    this.round = 0;
    // After a restart the guard may already hold a signature for this height; that round cannot be
    // completed by us with fresh content, so resume in the round after it.
    const last = this.d.privValidator?.lastSigned();
    const resumeRound = last && last.height === this.height ? last.round + 1 : 0;

    // Only votes verified with the key that holds that index in this height's set count.
    const votes = this.nextHeightVotes.filter((e) => e.vote.height === this.height && bytesEqual(this.validators.byIndex(e.vote.validatorIndex)?.publicKey ?? null, e.publicKey)).map((e) => e.vote);
    const proposals = this.nextHeightProposals.filter((e) => e.proposal.height === this.height);
    this.nextHeightVotes = [];
    this.nextHeightVoteKeys.clear();
    this.nextHeightProposals = [];

    this.startRound(resumeRound);
    for (const v of votes) this.addVote(v, null);
    for (const e of proposals) this.proposalUnawaited(e.proposal, e.from);
  }
```

Before anything is reset, the height that is over is kept (`keepHeight`): its vote set, its validator set and what each round's proposer signed go into `past`, a map by height of `PastHeight` records, and heights more than `PAST_HEIGHTS_KEPT` behind the new one leave it.

```ts
  /** Put the height that is over among the kept ones, cut to the round it ended in, and let go of the oldest. */
  private keepHeight(next: bigint): void {
    // The round this node was in, and the round the height was committed in: block sync may have applied a block
    // decided in a later round than this node reached.
    const commit = this.d.getLastCommit();
    const maxRound = Math.max(this.round, this.decided ? this.decidedRound : 0, commit && commit.height === this.height ? commit.round : 0);
    this.hvs.dropRoundsAbove(maxRound);
    for (const r of this.heads.keys()) if (r > maxRound) this.heads.delete(r);
    this.past.set(this.height, { validators: this.validators, votes: this.hvs, maxRound, proposals: this.heads, proposedTwice: this.proposedTwice });
    for (const h of this.past.keys()) if (h + BigInt(PAST_HEIGHTS_KEPT) < next) this.past.delete(h);
  }
```

The round the height ended in bounds what is kept and what is taken in for it later: `dropRoundsAbove` forgets the vote sets of later rounds, which a single validator can create by voting up to `MAX_ROUND_AHEAD` rounds ahead, and `maxRound` refuses late votes for them. That round is the latest of three: the round this node was in, the round it decided in, and the round of the stored commit for the height. The third matters when block sync applied the height: the node may have sat in round 0 holding one validator's vote of round 5 while the rest of the network committed in round 5, and that vote's conflicting twin must still find it. What is kept of the proposals is `heads`, what each round's proposer is known to have signed (below), and the set of rounds already reported for two proposals moves with it. `startHeight` runs this only when the height has moved, which is every time but the first, and also when block sync moved it (`restart`).

Everything per-height is then reset, `fetchRequested` included: the hashes in it are of blocks of the height that is over. The lock is the exception. For a new height `lockAt` answers null and the validator starts unlocked; for the height a restarted process finds itself in, it answers the lock the private validator wrote with the last precommit for a block, and the validator goes on bound by it. `test/amnesia.test.ts`, "takes its lock up again after a restart in the same height, and commits nothing else there", plants a precommit record with a lock on a block nobody holds, restarts a single-validator chain and watches it pass round after round without committing: it promised that block, and the alternative, committing the next proposal, is how a restart turns into a fork. The two buffers for the next height are emptied once their entries for this height are taken out, and `nextHeightVoteKeys` with them. The validator set is the one chain state says signs `lastHeight + 1`. The resume logic is review finding 5: a validator that had signed, say, a proposal at this height before crashing would, on restarting at round 0, build a block with a new timestamp and be refused by its own guard with no timeout armed. Resuming at `last.round + 1` sidesteps the round the guard owns. The regression test in `test/review.test.ts` plants a guard record for height `h+1`, round 0, and checks that the chain continues and that block `h+1` was committed in round 1 or later. Votes and proposals that arrived early for this height are then replayed. A proposal was buffered once its signature verified with the key of the validator its block names (`holdNextHeightProposal`, below) and is replayed through `handleProposal` with the peer it came from (by way of `proposalUnawaited`, below, since nothing here waits for it), which decides what could not be decided on arrival: whether that validator is the proposer of the proposal's round, and whether the block is valid. The votes were verified when buffered, against the set `validatorSetAtHeight` returned for their own height, and each buffer entry keeps the public key the signature verified under; replay accepts a vote only if that same key still holds the vote's index in the set this height actually uses. A vote verified against one set is thus never credited to whichever validator sits at that index in another.

#### `startRound` and `proposerAt`

```ts
  private startRound(r: number): void {
    this.round = r;
    this.step = 'propose';
    const proposer = this.proposerAt(r);
    this.log('debug', 'start round', { h: this.height, r, proposer });
    this.scheduleGossip();
    const pv = this.d.privValidator;
    if (pv && bytesEqual(proposer, pv.address)) {
      this.propose();
    } else {
      this.schedule('propose', this.timeouts.proposeMs + this.timeouts.proposeDeltaMs * r, () => this.onTimeoutPropose(this.height, r));
    }
    this.evaluateRules();
  }
```

This is the paper's `StartRound(round)`: if we are the proposer, propose; otherwise arm the propose timeout. The call to `evaluateRules` at the end matters: a proposal or votes for this round may have arrived before the round started (rule 55 skips rounds for exactly that reason), and they must be acted on at once.

`proposerAt(r)` returns the proposer address for round `r` of the current height, cached per round. For round 0 it is `validators.proposer()`; for round `r > 0` it copies the set and calls `incrementProposerPriority(r)` once with `r`, never `r` times with 1. `DESIGN.md` section 1 explains: the rescale step in the priority algorithm is not path independent, so a node that skipped rounds would otherwise compute a different proposer from one that passed through them all.

#### `propose` and `createBlock`

```ts
  private propose(): void {
    const pv = this.d.privValidator!;
    const held = this.d.signingHeld?.() ?? null;
    if (held) {
      this.log('info', 'not proposing', { h: this.height, r: this.round, why: held });
      this.schedule('propose', this.timeouts.proposeMs + this.timeouts.proposeDeltaMs * this.round, () => this.onTimeoutPropose(this.height, this.round));
      return;
    }
    const block = this.validBlock ?? this.createBlock();
    if (!block) {
      this.log('warn', 'cannot build a block (no last commit yet); skipping proposal');
      this.schedule('propose', this.timeouts.proposeMs + this.timeouts.proposeDeltaMs * this.round, () => this.onTimeoutPropose(this.height, this.round));
      return;
    }
    const unsigned = { height: this.height, round: this.round, polRound: this.validRound, block };
    let signature: Uint8Array;
    try {
      signature = pv.signProposal(this.d.chainId, unsigned);
    } catch (e) {
      this.log('error', 'refusing to sign proposal', { err: (e as Error).message });
      return;
    }
    const proposal: Proposal = { ...unsigned, signature };
    this.log('info', 'proposing', { h: this.height, r: this.round, txs: block.txs.length, hash: blockHash(block) });
    this.d.broadcastProposal(proposal, null);
    this.proposalUnawaited(proposal, null);
  }

  /**
   * Our own proposal and the ones held for this height are handled without being waited for, so nobody else is
   * there to catch a failure. One that comes while stopping is expected: the verifier or the store closed under it.
   */
  private proposalUnawaited(p: Proposal, fromPeer: string | null): void {
    this.handleProposal(p, fromPeer).catch((e: unknown) => {
      this.log(this.running ? 'error' : 'debug', 'handling a proposal failed', { h: p.height, r: p.round, err: e instanceof Error ? e.message : String(e) });
    });
  }
```

Paper lines 14 to 21: if `validValue` is set, propose it with `validRound`; otherwise get a new value and propose with `-1`. The proposal is broadcast and also fed to the proposer's own `handleProposal`, so the proposer treats its block exactly as everyone else does, including verifying its own signature. When no block can be built (no stored last commit yet), the proposer arms the same round-scaled propose timeout `startRound` would have, so the round still ends in a nil prevote instead of hanging. It does the same while signing is held: `signingHeld()` gives a reason, the line `not proposing` is logged with it, and the round goes on as one whose proposer is silent.

Neither `propose` nor `startHeight` waits for `handleProposal`: both are synchronous, and `handleProposal` waits on the verification of the proposal's signature. A proposal that comes from a peer has the node's handler behind it, which takes whatever the call ends with ([chapter 8](08-node.md)). The proposer's own proposal and the ones held for the height have nobody, so `proposalUnawaited` attaches the `catch` itself. Before it did, both calls were `void this.handleProposal(...)`, and a failure there was a rejected promise with no handler, which ends a Node process. A stop is what produced one: a node that made its own verifier pool closes it as the last step of its stop, and a verification that is out at that moment rejects with `verifier closed`. A validator stopped while its own proposal's signature was being verified, or one held for the height that had just begun, could so end its process with that error where an orderly exit was due. The failure is now logged as `handling a proposal failed` with the proposal's height and round, at `debug` when consensus has been stopped, where it is expected, and at `error` while it runs, where `handleProposal` is not expected to throw at all.

`createBlock()` builds a fresh block from chain state. Height 1 has no `lastCommit`; any other height loads it through `getLastCommit`, which returns the *stored* commit, the one `updateCommit` may have filled with late precommits (`STAKING.md` section 2.1: "The proposer of height N+1 builds lastCommit from that fuller stored commit, so every node applies the same signer list, because it is in the block"). Block time is the local clock, pushed to `lastBlockTime + 1` if the clock has not advanced. Evidence is pruned by age, then at most 16 items are taken. Then the size budget:

```ts
    // The limit is on the transactions and the evidence. Evidence is picked by count and may have half the limit:
    // by bytes it may be more under a small one, and the last record is left for the next block until it fits.
    // The transactions get what is left, never less than half, which is the most one transaction may be
    // (the mempool admits none larger), so evidence arriving block after block cannot keep a transaction out.
    // A record that is more than the half on its own would keep every other record waiting behind it; the pool
    // takes none in (EvidencePool.maxRecordBytes, set by the node to what fits here).
    const SLACK = 1024;
    let evidence = this.d.evidencePool.list(MAX_EVIDENCE_PER_BLOCK);
    while (evidence.length > 0 && blockDataBytes({ txs: [], evidence }) + SLACK > Math.floor(this.limits.maxBlockBytes / 2)) evidence = evidence.slice(0, -1);
    const budget = this.limits.maxBlockBytes - blockDataBytes({ txs: [], evidence }) - SLACK;
    const txs = budget > 0 ? this.d.reapTxs(budget) : [];
```

Review finding 15: a fixed 64 KiB reservation did not account for a large commit or many evidence items, so a full mempool plus a hundred evidence records produced blocks that every validator rejected as too large, forever. The first fix measured the block without its transactions (a shell of header, last commit and evidence) and gave the remainder, less 1 KiB of slack, to the mempool. That made the builder exact, but the limit still counted the commit, which grows with the validator set: with 64 KiB blocks and 40 ML-DSA-44 validators the commit alone makes an empty block 65,781 bytes, so every proposal would have been invalid and the chain would have stopped. The limit is now on what the proposer chooses, the transactions and the evidence (`blockDataBytes`, [chapter 3](03-types.md)), and the builder measures the same thing. Evidence is picked by count, not by bytes, and most records carry two signatures, about 5 KiB under ML-DSA-44 (about 230 bytes under secp256k1), while a false citation carries a vote for most of the validator set; with a small `maxBlockBytes` sixteen of them could exceed the limit before a single transaction is added, and `budget > 0` would then only leave the block without transactions, not make it small enough. The `while` loop drops the last record until the evidence plus the slack fits in half the limit, `Math.floor(this.limits.maxBlockBytes / 2)`. The dropped records stay in the pool and go into a later block; nothing is lost, only deferred. The loop always ends with at least one record in the block if any waits, because the pool takes in no record that is more than this half on its own (`maxRecordBytes`, above). The transactions get the limit less the evidence and the slack, which is never less than half the limit, and a block with neither is within the limit whatever the validator set.

Half, and not the whole limit, because of the transaction at the head of the queue. The loop first let evidence have the whole limit less the slack. On a chain with 64 KiB blocks the mempool then admitted a transaction of 32,768 bytes, and thirteen ML-DSA-44 records, about 4.9 KiB each, left it no room. `reapTxs` stops at the first transaction that does not fit ([chapter 5](05-mempool-executor.md)), so as long as evidence arrived with every block that transaction, and everything queued behind it, stayed out. Now evidence takes at most half a block, and the mempool admits no transaction that costs more than the other half: its `maxTxBytes` is half the limit less the four bytes of the transaction's length prefix in the block, and never more than 1 MiB, which is what it comes to at the default limit ([chapter 8](08-node.md)). A transaction the pool admitted therefore fits the next block it is first in line for, whatever evidence is waiting. With the default 4 MiB the rule changes nothing in practice: sixteen ML-DSA-44 records are about 79 KiB, far below 2 MiB. The header then takes `appHash`, `lastResultsHash`, `validatorsHash` and `nextValidatorsHash` from chain state, `dataHash` from `txsRoot(txs)`, `evidenceHash` from the evidence list, and `proposerAddress` from the private validator. Everything a validator checks in `validateBlockStructure` is set here.

#### `handleProposal`

```ts
  async handleProposal(p: Proposal, fromPeer: string | null): Promise<void> {
    if (!this.running) return;
    if (p.height === this.height + 1n) {
      await this.holdNextHeightProposal(p, fromPeer);
      return;
    }
    if (p.height < this.height) {
      await this.handlePastProposal(p, fromPeer);
      return;
    }
    if (p.height !== this.height) return;
    // A proposal for a round that has one is looked at only for what its proposer signed: nothing, if that is known
    // and this says the same, or if the proposer was already reported for signing two.
    const taken = this.proposals.has(p.round);
    const held = this.heads.get(p.round);
    if (taken && held && (this.proposedTwice.has(p.round) || sameProposal(held, p))) return;
    if (p.polRound < -1 || p.polRound >= p.round) return;
    if (p.block.header.height !== p.height) return;

    if (p.round > this.round + MAX_ROUND_AHEAD) return; // proposer selection costs O(round); do not let a peer choose it
    // The round's proposer signs the proposal; the block inside may be a re-proposal built by an earlier proposer.
    const proposer = this.validators.byAddress(this.proposerAt(p.round))!;
    const sigOk = await this.d.verifier.verifyOne({
      sig: p.signature,
      msg: proposalSignBytes(this.d.chainId, p),
      publicKey: proposer.publicKey,
      context: this.proposalCtx,
    });
```

Cheap filters first: a proposal for the next height goes to `holdNextHeightProposal` (below), one for an earlier height to `handlePastProposal` (further below), other heights are dropped, one proposal per round is kept (the first to verify wins), `polRound` must be `-1` or an earlier round, the block's own height must match, and the round must be within `MAX_ROUND_AHEAD`. Then the signature is checked against the *round's* proposer, not the block's `proposerAddress`. Review finding 4 found three honest validators stuck forever because a re-proposal of a polka'd block was rejected for carrying the original builder's address.

A round that has its proposal does not take another, but a second one is no longer dropped unseen. Beside `proposals`, which holds what each round decides on, consensus keeps `heads`: for each round, the `ProposalHead` (`polRound`, block hash, signature) of the first proposal whose signature verified under the round's proposer. If a proposal for a taken round says what the head says (`sameProposal`), which is what the proposer's re-sending and every relay produce, or the proposer was already reported, it is dropped at no cost as before. Otherwise it goes on to the signature check, because with a good signature it is the second half of a proof (`recordHead`, below). The two maps are apart because they can differ: a round may decide on a block that was fetched after +2/3 precommitted it (`handleFetchedBlock`), which replaces the round's entry in `proposals` with a placeholder that carries no signature, while what the proposer signed for the round is still what it signed.

A proposal for the next height arrives when a peer has decided this height a moment before the node has. It cannot be handled yet, since the round's proposer is not known until the height starts, but it is not held unchecked either:

```ts
  /**
   * A proposal for the height after this one waits for that height to start. Only a fresh one (no proof of lock)
   * is held, since its signer is then the proposer its block names, and only once that signature verifies with
   * the key the validator of that address holds in the next height's set: nothing takes a place without a
   * validator's signature, whichever peer relays it, and one validator's proposals may take two. Whether the signer is the proposer of its round is decided when
   * the height starts. A proposal not held is not lost; the round's proposer sends it again while the round lasts.
   */
  private async holdNextHeightProposal(p: Proposal, fromPeer: string | null): Promise<void> {
    if (p.polRound !== -1 || p.round > MAX_ROUND_AHEAD || p.block.header.height !== p.height) return;
    const signer = this.d.validatorSetAtHeight(p.height)?.byAddress(p.block.header.proposerAddress);
    if (!signer) return;
    const room = () =>
      this.nextHeightProposals.length < MAX_NEXT_HEIGHT_PROPOSALS &&
      this.nextHeightProposals.filter((e) => bytesEqual(e.signer, signer.address)).length < MAX_NEXT_HEIGHT_PROPOSALS_PER_VALIDATOR &&
      !this.nextHeightProposals.some((e) => e.proposal.round === p.round && bytesEqual(e.signer, signer.address));
    // Before the signature is verified: a proposal there is no place for must not cost a verification.
    if (!room()) return;
    const ok = await this.d.verifier.verifyOne({ sig: p.signature, msg: proposalSignBytes(this.d.chainId, p), publicKey: signer.publicKey, context: this.proposalCtx });
    if (!ok) {
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'bad proposal signature');
      return;
    }
    // Again: others were verified meanwhile, and the height may have moved on.
    if (!this.running || p.height !== this.height + 1n || !room()) return;
    this.nextHeightProposals.push({ proposal: p, from: fromPeer, signer: signer.address });
  }
```

Four conditions come before any signature work. The proposal must be fresh (`polRound === -1`): the block of a fresh proposal was built by the validator that signs it, so the block's `proposerAddress` names the signer, which a re-proposal's does not. The round must be no more than `MAX_ROUND_AHEAD`, the block must be of the proposal's height, and `validatorSetAtHeight` must hold the next height's set with a validator of that address in it. Then `room()`: fewer than 8 held in all, fewer than 2 signed by this validator, and none by this validator for this round. Only a proposal there is a place for has its signature verified, with the key that validator holds in the next height's set, so a flood of proposals beyond the places costs no verification. A bad signature costs the sender 20 points. After the await `room()` is asked again, since other proposals were verified meanwhile, with `running` and the height, which may have moved on.

So a place is taken only by a proposal that carries the valid signature of a validator of the next height, and the proposals of one validator can take two. The test is on the signer, not on the peer that sent the message: any peer may relay a validator's proposal, and a peer that is no validator cannot fill a place with one of its own making, whatever it sends. Four validators that sign proposals for rounds that will not come can still fill the 8 places and keep the real proposal out. A proposal not held is not lost: the round's proposer sends it again every `gossipMs` while its round lasts, and by then the height has started. What `holdNextHeightProposal` cannot decide is whether the signer is the proposer of that round; `startHeight` replays each held proposal through `handleProposal`, which checks the signature against the round's proposer as it does for any other.

```ts
    if (!sigOk) {
      this.log('warn', 'proposal with bad signature', { r: p.round });
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'bad proposal signature');
      return;
    }

    // Stopped while the signature was verified: the checks below read stored blocks, and the store may be closed.
    if (!this.running) return;
    // Whatever becomes of the proposal, its proposer signed it. The height may have moved on meanwhile, and then
    // it is held against what is kept of that height.
    // What it signed is sent on as well: as the proposal below if the round takes it, and without the block if not.
    const head: ProposalHead = { polRound: p.polRound, blockHash: blockHash(p.block), signature: p.signature };
    const relayHead = this.recordHead(p.height, p.round, head) ? () => this.d.broadcastProposalHead?.(p.height, p.round, head, fromPeer) : () => {};
    if (taken || p.height !== this.height) return relayHead();

    // The signature covers the header; a relay can pair it with another body. That is a corrupt message, not
    // the round's proposal: drop it without recording the round, so the real one can still arrive.
    if (!bodyMatchesHeader(p.block)) {
      this.log('warn', 'proposal body does not match its header', { h: p.height, r: p.round });
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'proposal body mismatch');
      return relayHead();
    }
```

A bad signature costs the sending peer 20 points, the same as a bad vote signature: a proposal is as expensive to verify as a vote and the signer is just as well known, so there is no reason to let a peer send them for free. Then `running` is read again, and `recordHead` is given what the proposal's proposer signed, whatever becomes of the proposal next. It answers whether this is the first held for the round, and if it is, `relayHead` is a function that sends the head to every peer but the one the proposal came from; otherwise it does nothing. Each `return` from here on that does not end in the proposal being sent on whole calls it, so the first thing a node learns a proposer signed for a round always goes to its peers in one form or the other (why is below, under the two proposals). A proposal for a round that had one ends here, as evidence or as nothing; it is never the round's proposal, so its body and its block are not looked at. So does one whose height ended during the verification, which `recordHead` holds against what was kept of that height. The verification is a wait on the worker pool, and the node may have been stopped during it: `stop()` clears the flag and does not wait for a proposal that is being verified, and a node that stops closes its store soon after ([chapter 8](08-node.md)). "The checks below read stored blocks, and the store may be closed": the validity checks ask for the time of an earlier block and for the validator sets of earlier heights, which come from the block store. A proposal whose verification outlasted the stop therefore ends here, having read nothing. The node's handler does not wait for `handleProposal`; it hands the promise to `detached` ([chapter 8](08-node.md)), which takes whatever the call ends with. A proposal that resumes after a stop somewhere this check does not cover, to a closed verifier pool or a closed store, therefore ends as the line `handling a proposal failed` in the log, at `debug`, and nothing more. The two kinds of proposal no handler of the node stands behind, the proposer's own and one held for the height, end with the same line in `proposalUnawaited` (above). Then the body. `proposalSignBytes` covers the proposal's header, and the header commits to the body only through its three roots (`dataHash`, `evidenceHash`, `lastCommitHash`); a relay could keep the signed header and pair it with other transactions, other evidence or a different commit. `bodyMatchesHeader` (in `src/consensus/validate.ts`, re-exported by state sync, which needs the same check on a fetched block) recomputes the three roots and compares. A mismatch is a corrupt message rather than the round's proposal, so it is dropped *without* recording the round: if it were recorded as an invalid proposal, the `proposals.has(p.round)` filter above would then reject the genuine proposal when it arrived, and the whole round would be lost to one bad relay.

After the signature and the body, the block itself:

```ts
    const st = this.d.getState();
    // A block re-proposed with a proof of lock keeps the time its first proposer gave it, and a round that
    // stalled past the drift limit must still be able to decide it (CometBFT checks timeliness only for
    // polRound == -1); the clock check applies to fresh blocks alone.
    let invalid = validateBlockStructure(st, p.block, this.limits, p.polRound === -1 ? this.now() : null, this.d.blockTimeAt);
    if (!invalid) invalid = await verifyBlockSignatures(this.d.chainId, st, p.block, this.d.verifier, this.d.validatorSetAtHeight);
```

`validateBlockStructure` gets the local clock only for a fresh proposal. Review finding 37 describes the failure this prevents: every proposal used to be checked for drift, so after a round that stalled longer than `maxClockDriftMs` the polka'd block could never be re-proposed validly, the validators locked on it prevoted nil for everything else, and the height stalled for good. Then `verifyBlockSignatures` for the `lastCommit` and evidence. Both results are strings or null. Because another await has passed, the handler re-checks `running`, the height, and that no proposal for the round has been stored meanwhile; a node stopped during this second verification ends there, before anything is recorded or sent. Then:

```ts
    // State may have moved while we were verifying.
    if (!this.running) return;
    if (p.height !== this.height || this.proposals.has(p.round)) return relayHead();

    const hash = head.blockHash;
    this.proposals.set(p.round, { proposal: p, valid: invalid === null, hash });
    if (invalid) {
      this.log('warn', 'invalid proposal', { h: p.height, r: p.round, reason: invalid });
      relayHead();
    } else {
      this.log('debug', 'got proposal', { h: p.height, r: p.round, hash });
      this.d.broadcastProposal(p, fromPeer);
    }
    this.evaluateRules();
  }
```

Before the proposal is recorded the round is looked up once more, since two proposals for one round can both be in verification at once and only the first to come out is the round's. If they differ, that was already seen: each went through `recordHead` when its signature verified. An invalid proposal is still recorded (with `valid: false`), because the paper's rules say to prevote nil on an invalid proposal rather than wait for the timeout, and the record stops a second copy from being verified. Only valid proposals are forwarded to peers; of an invalid one the head is, if it is the first held for its round. Contrast the two earlier failures: a bad signature or a body that does not match the header is not the round's proposal at all, so neither is recorded, and the round stays open for the real one.

#### Two proposals for a round

```ts
  /**
   * What the proposer of a round signed, by a signature that verified, for this height or a kept one. The first
   * for a round is what the proposer signed; another that says something else is the second half of the proof
   * that it signed twice. True if this is the first held for its round.
   *
   * A node sends the first on to its peers, as the proposal if its round takes it and as the head alone if not
   * (the block is invalid, the round had a fetched block, the height moved on). So of two nodes that were each
   * sent a different proposal, one next to the other hears what the other holds, and the proof is made there.
   */
  private recordHead(height: bigint, round: number, second: ProposalHead): boolean {
    const kept = height === this.height ? null : this.past.get(height);
    if (height !== this.height && (!kept || round > kept.maxRound)) return false;
    const [heads, reported, validators] = kept ? [kept.proposals, kept.proposedTwice, kept.validators] : [this.heads, this.proposedTwice, this.validators];
    const first = heads.get(round);
    if (!first) {
      heads.set(round, second);
      return true;
    }
    if (reported.has(round) || sameHead(first, second)) return false;
    // Marked once the pool holds the proof or it waits for room there.
    if (this.report(makeDuplicateProposalEvidence(height, round, validators.indexOf(proposerOf(validators, round).address), first, second))) reported.add(round);
    return false;
  }

  /**
   * A proposal's head without its block, sent on by a peer that held it and did not send the proposal. Nothing is
   * decided on it. It is verified only where it can tell something: for a round of this height within reach or a
   * round a kept height reached, and not if it says what is held for the round or the proposer was already reported.
   */
  async handleProposalHead(height: bigint, round: number, head: ProposalHead, fromPeer: string | null): Promise<void> {
    if (!this.running || !this.hvs) return;
    if (head.polRound < -1 || head.polRound >= round) return;
    const kept = height === this.height ? null : this.past.get(height);
    if (height !== this.height && !kept) return;
    if (kept ? round > kept.maxRound : round > this.round + MAX_ROUND_AHEAD) return;
    const first = (kept ? kept.proposals : this.heads).get(round);
    if ((kept ? kept.proposedTwice : this.proposedTwice).has(round) || (first && sameHead(first, head))) return;
    // One signed head is verified once however many peers send it at once, and no more than a fixed number are in
    // verification together: a head over that is dropped, and comes again from whoever holds it when a peer connects.
    const key = `${height}/${round}/${head.polRound}/${toHex(head.blockHash)}/${toHex(sha256(head.signature))}`;
    if (this.verifyingHeads.has(key) || this.verifyingHeads.size >= MAX_HEADS_VERIFYING) return;
    this.verifyingHeads.add(key);
    let ok: boolean;
    try {
      const proposer = kept ? proposerOf(kept.validators, round) : this.validators.byAddress(this.proposerAt(round))!;
      ok = await this.d.verifier.verifyOne({ sig: head.signature, msg: proposalHeadSignBytes(this.d.chainId, height, round, head.polRound, head.blockHash), publicKey: proposer.publicKey, context: this.proposalCtx });
    } finally {
      this.verifyingHeads.delete(key);
    }
    if (!ok) {
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'bad proposal signature');
      return;
    }
    if (this.running && this.recordHead(height, round, head)) this.d.broadcastProposalHead?.(height, round, head, fromPeer);
  }

  /**
   * A proposal for a kept height: nothing to decide any more, but what its proposer signed is one half of a proof
   * if something else is held for the round, and the first half, to send on, if nothing is.
   */
  private async handlePastProposal(p: Proposal, fromPeer: string | null): Promise<void> {
    const kept = this.past.get(p.height);
    const first = kept?.proposals.get(p.round);
    if (!kept || p.round > kept.maxRound || kept.proposedTwice.has(p.round) || (first && sameProposal(first, p))) return;
    if (p.polRound < -1 || p.polRound >= p.round || p.block.header.height !== p.height) return;
    // The proposer of the round in that height's set; the round is one the height reached, so the walk is bounded.
    const ok = await this.d.verifier.verifyOne({ sig: p.signature, msg: proposalSignBytes(this.d.chainId, p), publicKey: proposerOf(kept.validators, p.round).publicKey, context: this.proposalCtx });
    if (!ok) {
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'bad proposal signature');
      return;
    }
    const head: ProposalHead = { polRound: p.polRound, blockHash: blockHash(p.block), signature: p.signature };
    if (this.running && this.recordHead(p.height, p.round, head)) this.d.broadcastProposalHead?.(p.height, p.round, head, fromPeer);
  }

  /**
   * Evidence this node made itself: into the pool, from where it is announced and proposed. True if the pool holds
   * a proof of the offence afterwards, this one or one it had; false if it had no room.
   */
  private report(ev: Evidence): boolean {
    const pool = this.d.evidencePool;
    if (pool.add(ev)) this.log('warn', 'fault detected', { kind: ev.kind, h: evidenceHeight(ev), validator: evidenceValidator(ev) });
    if (pool.has(ev)) return true;
    // No room now. A proof the pool could take when it has room waits here, since the votes that made it are held
    // already and will not be looked at again; one too large for the pool never fits.
    if (evidenceBytes(ev) > pool.maxRecordBytes || this.refused.size >= MAX_REFUSED) return false;
    this.refused.set(evidenceKey(ev), ev);
    return true;
  }

  /** Offer the pool again what it had no room for, and let go of what has grown too old for any block. */
  private reportRefused(st: ChainState): void {
    for (const [k, ev] of this.refused) {
      const old = evidenceAgeOk(evidenceHeight(ev), st.lastHeight + 1n, st.lastBlockTime, st, this.limits, this.d.blockTimeAt) !== null;
      if (old || this.d.evidencePool.add(ev) || this.d.evidencePool.has(ev)) this.refused.delete(k);
    }
  }
```

`recordHead` is given the head of every proposal whose signature verified with the key of its round's proposer: `polRound`, the block's hash and the signature, which is all the proposer signed. The first for a round becomes the round's head, and the answer is true. A later one that says something else (`sameHead`, a function at the end of the file), with the first, is `DuplicateProposalEvidence` against the proposer (`proposerOf`, also there, advances a copy of a set by the round), and once the pool holds the proof, or the proof waits for room there, the round is marked in `proposedTwice`, so that when the round has its proposal a third is not verified at all. If the proof is one the pool will never take, the round is left unmarked. It does not matter what else became of either proposal: the first may have been judged invalid, or dropped because its body did not match its header, and its signature was verified all the same, which is all the evidence needs. A second proposal is not passed on to peers, and the round keeps the proposal it had: the evidence travels by inventory. For a head of a height that is over, the heads, the reported rounds and the validator set are the kept ones, and a round the height never reached is ignored; that is the path of a proposal that was in verification when its height ended.

A proposer that signs two proposals for a round need not show both to anybody. It can send one to each of two nodes, and each node then holds one head and no proof. Where both proposals are valid, flooding brings them together: each node sends the proposal it took to all its peers, and a node that receives the other one beside its own makes the proof. Where one of them is not sent on, they used to stay apart: a proposal with an invalid block is recorded and not forwarded, one whose body does not match its header is dropped, one for a round that already decided on a fetched block is looked at for its signature only, and one whose height ended during verification is no proposal of anything any more. In each of these the node now sends the head. The rule is that a node sends on the first thing it learns a proposer signed for a round, as the proposal if its round takes it and as the head alone if not. Take two nodes that hold different heads for a round, and a path of connections between them that stood while the heads went round: somewhere on it two neighbours hold different heads, each of them sent its own to the other when it first held it (to every peer but the one it had it from, and that peer held it already), and so one of the two has seen both. A peer that connects later is handed the heads of the height its neighbour is in and those of the heights its neighbour kept (`messagesForPeer`, `pastHeads`), so two parts of a network that were apart while a proposer showed each a different proposal, and come together within the 16 heights kept, compare the two halves then: where the peer holds the same head it verifies nothing, where it holds another it makes the proof, and where it holds none it keeps the head and sends it on. What is handed over is the newest heights first and at most 64 heads, the number a node verifies at one time; parts that come together later than 16 heights, or after more rounds than that, hold the halves and do not compare them. The head is a `proposalHead` message, 2,474 bytes under ML-DSA-44 and 118 under secp256k1 ([chapter 6](06-p2p.md)), against a proposal that carries a block.

`handleProposalHead` is what receives one. A head decides nothing: no round takes it as its proposal, no rule runs, and a validator does not prevote on it. It is verified only where it can tell something. The `polRound` must be one a proposal of that round could carry. The height must be the current one or a kept one, and the round within `MAX_ROUND_AHEAD` of the node's own or, for a kept height, one that height reached. If the round's proposer was already reported, or the head says what is held for the round, it is dropped before the signature is looked at, which is the case of every head and every proposal an honest proposer's round produces after the first. Otherwise the signature is verified over `proposalHeadSignBytes`, the bytes a proposal's signature covers, built from the hash instead of the block ([chapter 3](03-types.md)), with the key of the round's proposer; a bad one costs the sender 20 points, as a bad proposal signature does. Before the verification the head is looked up in `verifyingHeads`, by what it says and its signature: the same signed head from several peers at once is verified once, and no more than `MAX_HEADS_VERIFYING`, 64, are in verification together. One over that is dropped without a charge; whoever holds it sends it again to the next peer that connects. A head that verifies goes to `recordHead`, and if it is the first for its round it is sent on to every other peer. A proposal that comes later for that round and says the same becomes the round's proposal in the ordinary way, its signature verified a second time, since the round has no proposal yet; one that says something else is the second half. An honest proposer's round with a valid block sends no head at all: heads are sent only where proposals are not. A proposer that signs many proposals for its round costs each node a verification for the first and for the second, and for whatever else was already in verification when the second came out, up to the 64; from then on the round is marked and nothing more for it is verified. It is marked when the pool took the proof or the proof waits for room (`report`, below). It stays unmarked, and each further proposal or head costs a verification, when the proof is larger than the pool ever takes or the 64 places for waiting proofs are full.

`handlePastProposal` is for a proposal that arrives when its height is already over. It is verified if its round is one the kept height reached, the proposer of that round was not reported, and the head held for the round, if there is one, says something else. With a head held it is the second half of a proof. With none it is the first thing this node learns the proposer signed for that round, and its head is recorded and sent on like any other first, since another node may hold a different one; the block is of no use any more and goes no further. A late head is taken through `handleProposalHead` in the same way.

`report` is where all evidence this node makes itself goes into the pool. The pool refuses a second proof of an offence it holds, so the log line `fault detected`, with the kind, the height and the validator's index, appears once per offence. If the pool has no room (it is bounded in number and in bytes), the proof is kept in `refused`, by offence and at most `MAX_REFUSED`, 64, of them, unless it is larger than the pool takes at all. The votes or proposals that made it are held already and are dropped as duplicates when they come again, so nothing would make the proof a second time. `reportRefused` offers the pool what waits there when each height starts, which is when a block has just taken evidence out of the pool, and lets go of what has grown too old for any block. `report` answers whether the proof is in the pool or waiting for it.

#### `handleVote` and `addVote`

`handleVote(v, fromPeer)` accepts votes for the current height (dropping exact duplicates with `hvs.has` before verification, which is what makes the gossip re-send cost bandwidth rather than CPU), for a kept earlier height (if the round is one that height reached and the vote is not held already; it is verified against the kept set and goes to `addPastVote`, below), and for the next height, where a vote already held is dropped in the same way and the rest are verified against `validatorSetAtHeight(v.height)`, the stored set for the vote's own height. What tells one held vote from another is `nextHeightVoteKey(v)`, a string of the round, the type, the validator index, the block hash in hex (empty for nil) and the `polRound`, kept in the set `nextHeightVoteKeys`: "a peer repeating a valid vote would otherwise have it checked each time and fill the places with copies". A conflicting vote differs in its hash or in the round it names, so it has another key and is verified and held too, and both reach `addVote` when the height starts, where the pair becomes evidence. The obvious shortcut, `getState().nextValidators`, is wrong in a corner: block sync may have applied the current height already while consensus was still on it, and then the state's "next" set is the one *after* the vote's height, whose index positions mean other keys. Asking by the vote's height is right in both cases. The validator is looked up by index; a vote of the current or next height for a round more than `MAX_ROUND_AHEAD` beyond the node's own is dropped here, and one from a peer that has used up its budget for the second is put aside to wait (`withinVoteBudget` and `deferVote`, below), before its signature is verified, since a vote the node will not count must not cost it a verification; the signature is verified with the vote context; a bad signature is logged and costs the sending peer 20 points through `scorePeer` (`RPC-SYNC-PROOFS.md` section 4.6). After the await: `running` again, `MAX_ROUND_AHEAD` again (the height may have moved on while the worker verified, and the round with it), and then either `addVote` or the next-height buffer (at most 4096 entries, each the vote with the public key it verified under, which `startHeight` checks again before replaying it). The key is looked up once more before the vote is pushed, because two votes that say the same thing under different signatures can both be in verification at once (the same signed vote is not: `verifyingVotes` drops a copy of one being verified), and it is added to `nextHeightVoteKeys` with the push.

```ts
  /** Add an already-verified vote for the current height. */
  private addVote(v: Vote, fromPeer: string | null): void {
    if (v.height !== this.height) return;
    const { added, conflict } = this.hvs.add(v);
    if (conflict) {
      this.report(makeDuplicateVoteEvidence(conflict, v));
      // The second vote is as signed as the first, and may complete a proof against another validator.
      for (const ev of faultsShown(this.hvs, this.validators, v)) this.report(ev);
      // The vote set keeps whichever of the two counts for its block, so a majority may have formed.
      if (!this.decided) this.evaluateRules();
      return;
    }
    if (!added) return;
    for (const ev of faultsShown(this.hvs, this.validators, v)) this.report(ev);
    this.log('debug', 'got vote', { h: v.height, r: v.round, type: voteTypeName(v.type), i: v.validatorIndex, block: v.blockHash });
    this.d.broadcastVote(v, fromPeer);
    if (this.decided) {
      // A straggler for the decided block: fold it into the stored commit so the next
      // proposer, and everyone reading that block, credits the signature.
      if (v.type === VoteType.Precommit && v.round === this.decidedRound && this.decidedHash && bytesEqual(v.blockHash, this.decidedHash)) {
        this.d.updateCommit(this.height, this.hvs.precommits(v.round).toCommit(this.decidedHash));
      }
      return;
    }
    this.evaluateRules();
  }
```

Three outcomes. A conflict becomes evidence: `makeDuplicateVoteEvidence` puts the pair in canonical order and `report` hands it to the pool, which deduplicates. The second vote is then held against the other votes like a new one, since it is as signed as the first and may be what completes a proof against another validator (below). The rules run after it, because the vote set may have kept the second vote in place of the first and a majority may have formed. A new vote is first held against the other votes of the height, by `faultsShown`, a function of a height's votes and its validator set that is used for kept heights as well:

```ts
/**
 * What a verified vote proves with the votes held for its height, whichever arrived last. The vote is one just
 * added, or the second of two a validator signed for one place, of which the set holds one: both are signed, so
 * where the held one says nothing against a claim and this one does, this one is taken.
 *
 * A forgotten lock: a precommit for one block and a prevote of the same validator for another in a later round
 * that names no proof of lock from the precommit's round or after.
 *
 * A false citation: a prevote for a block that names a round in which +2/3 of the power prevoted something else.
 * The vote added may be the prevote that names the round, or one of the round named that completes the +2/3.
 */
export function faultsShown(votes: HeightVoteSet, validators: ValidatorSet, v: Vote): Evidence[] {
  const out: Evidence[] = [];
  if (v.blockHash !== null) {
    for (const r of votes.roundNumbers()) {
      const other = v.type === VoteType.Prevote ? votes.precommits(r).get(v.validatorIndex) : votes.prevotes(r).get(v.validatorIndex);
      if (!other) continue;
      const [precommit, prevote] = v.type === VoteType.Prevote ? [other, v] : [v, other];
      // One proof of an offence is enough: the pool keeps one a validator and height.
      if (isAmnesia(precommit, prevote)) {
        out.push({ kind: 'amnesia', precommit, prevote });
        break;
      }
    }
  }
  if (v.type !== VoteType.Prevote) return out;
  const citing: Vote[] = v.blockHash !== null && v.polRound >= 0 ? [v] : [];
  for (const r of votes.roundNumbers()) {
    if (r <= v.round) continue;
    for (const w of votes.prevotes(r).all()) if (speaksAgainst(w, v)) citing.push(w);
  }
  // One proof a validator, the smallest in bytes: a larger one may be more than a pool takes where a smaller is not.
  // A minority can sign such prevotes for every round ahead that a node takes votes for and for any number of
  // blocks, so while looking only the cost of each claim is worked out, once for each round and block named, and
  // the votes of a proof are gathered for the winners alone.
  const rounds = new Map<number, (hash: Uint8Array) => Refutation | null>();
  const best = new Map<number, { prevote: Vote; refutation: Refutation }>();
  for (const prevote of citing) {
    let refute = rounds.get(prevote.polRound);
    if (!refute) rounds.set(prevote.polRound, (refute = refuter(votes.prevotes(prevote.polRound), validators, v)));
    const refutation = refute(prevote.blockHash!);
    const had = best.get(prevote.validatorIndex);
    if (refutation && (!had || refutation.bytes < had.refutation.bytes)) best.set(prevote.validatorIndex, { prevote, refutation });
  }
  for (const { prevote, refutation } of best.values()) out.push({ kind: 'falseCitation', prevote, against: refutation.votes() });
  return out;
}
```

A prevote for a block is paired with the precommit the validator has in each round of the height, a precommit for a block with its prevote in each round (the one the vote set holds in that place: the other prevote of a double signer, kept aside, is not looked at again when a precommit arrives later), and `isAmnesia` ([chapter 3](03-types.md)) says whether the pair shows a lock forgotten. Either vote may be the one that arrives last, which is why the search runs from both. The pool keeps one such piece per validator and height (`evidenceKey`), so a validator that forgot its lock in several rounds is reported once. An honest validator never appears here: its prevote for another block names the round of its lock or a later one, by rule 28 and by its private validator.

The second half is the false citation, and only a prevote can complete one. The prevotes that might be shown false by the new vote are the new vote itself, if it names a round, and every held prevote of a later round that names the new vote's round for another block (`speaksAgainst`). For each, `refuter` (below) gives the cheapest set of prevotes of the round it names that are not for its block and hold +2/3 of the power, if the votes held make one. Votes that wait uncounted are taken like any other: a signed prevote says what its signer prevoted whether or not this node counts it. One proof is made for each accused validator in a call, the one that encodes to the fewest bytes, however many rounds and blocks it named falsely. The same evidence is produced again by each further prevote of that round, and the pool refuses the copies.

```ts
/** The cheapest prevotes that refute a claim, +2/3 of the power not for its block: what they encode to, and the votes, by validator index. */
interface Refutation {
  bytes: number;
  votes(): Vote[];
}

/**
 * For the prevotes held of one round, a function from a block's hash to the cheapest refutation of the claim that
 * the block had +2/3 there, or null if the votes do not make one.
 *
 * A prevote for nil encodes to 32 bytes less than one for a block, and all else in a vote is of one size, so the
 * cheapest set is some number of the heaviest nil prevotes and, with them, as few of the heaviest block prevotes
 * as reach +2/3: one pass over the two lists finds it. Every block the round holds no prevote for is refuted by
 * the same votes, so that answer is worked out once, and the others once for each block the round does hold.
 *
 * A validator that signed two prevotes for the round has prevoted both: the set holds one and keeps the other
 * aside, and `inHand`, the vote being looked at, may be a third. Whichever of them speaks against a claim is
 * taken, nil before a block.
 */
function refuter(round: VoteSet, validators: ValidatorSet, inHand: Vote): (hash: Uint8Array) => Refutation | null {
  const held = round.all();
  const power = (o: Vote) => validators.byIndex(o.validatorIndex)!.power;
  const heaviest = (a: Vote, b: Vote) => (power(a) === power(b) ? a.validatorIndex - b.validatorIndex : power(a) > power(b) ? -1 : 1);
  // The validators with more than one prevote of this round, each with all of them.
  const several = new Map<number, Vote[]>();
  const also = (o: Vote) => {
    const first = round.get(o.validatorIndex);
    if (!first) return;
    const all = several.get(o.validatorIndex) ?? [first];
    if (all.some((x) => sameVoteContent(x, o))) return;
    all.push(o);
    several.set(o.validatorIndex, all);
  };
  for (const o of round.alternates()) also(o);
  if (inHand.type === round.type && inHand.round === round.round) also(inHand);
  const single = several.size === 0 ? held : held.filter((o) => !several.has(o.validatorIndex));
  const nils = single.filter((o) => o.blockHash === null).sort(heaviest);
  const blocks = single.filter((o) => o.blockHash !== null).sort(heaviest);
  const present = new Set<string>();
  for (const o of [...blocks, ...[...several.values()].flat()]) if (o.blockHash) present.add(blockHashKey(o.blockHash));
  const size = (o: Vote) => encode((w) => encodeVote(w, o)).length;
  const nilBytes = size({ ...(held[0] ?? inHand), blockHash: null });
  const blockBytes = nilBytes + HASH_SIZE;

  const cheapest = (hash: Uint8Array | null): Refutation | null => {
    // Of a validator's several prevotes, one that speaks against the claim, nil before a block.
    const speaks = (o: Vote) => hash === null || !bytesEqual(o.blockHash, hash);
    const extra: Vote[] = [];
    for (const all of several.values()) {
      const o = all.find((x) => x.blockHash === null) ?? all.find(speaks);
      if (o) extra.push(o);
    }
    const nil = extra.some((o) => o.blockHash === null) ? [...nils, ...extra.filter((o) => o.blockHash === null)].sort(heaviest) : nils;
    const block = (extra.some((o) => o.blockHash !== null) ? [...blocks, ...extra.filter((o) => o.blockHash !== null)].sort(heaviest) : blocks).filter(speaks);
    // k of the nil prevotes and the fewest block prevotes that reach +2/3 with them, for every k; fewer are needed as k grows.
    let blockPower = 0n;
    let m = 0;
    while (m < block.length) blockPower += power(block[m++]!);
    let nilPower = 0n;
    let found: { k: number; m: number; bytes: number } | null = null;
    for (let k = 0; k <= nil.length; k++) {
      if (k > 0) nilPower += power(nil[k - 1]!);
      if (!validators.isQuorum(nilPower + blockPower)) continue;
      while (m > 0 && validators.isQuorum(nilPower + blockPower - power(block[m - 1]!))) blockPower -= power(block[--m]!);
      const bytes = k * nilBytes + m * blockBytes;
      if (!found || bytes < found.bytes) found = { k, m, bytes };
    }
    if (!found) return null;
    const { k, m: taken, bytes } = found;
    return { bytes, votes: () => [...nil.slice(0, k), ...block.slice(0, taken)].sort((a, b) => a.validatorIndex - b.validatorIndex) };
  };

  let absent: Refutation | null | undefined;
  const byBlock = new Map<string, Refutation | null>();
  return (hash) => {
    const key = blockHashKey(hash);
    // No prevote of the round is for this block: every vote speaks against, as for any other such block.
    if (!present.has(key)) return absent === undefined ? (absent = cheapest(null)) : absent;
    if (!byBlock.has(key)) byBlock.set(key, cheapest(hash));
    return byBlock.get(key)!;
  };
}
```

Three things shape this function. The first is size. A proof holds a vote for much of the validator set, the pool takes no record above its limit, and a validator's different claims are refuted by different votes; so the proof must be the smallest the votes allow, or a claim could go unpunished for want of a few bytes while a smaller proof of it existed. Every vote of a chain encodes to the same size but for the hash, 32 bytes that a prevote for nil does not have. The cheapest refutation is therefore `k` of the heaviest nil prevotes and the fewest of the heaviest block prevotes that reach +2/3 with them, for the best `k`; the loop tries every `k`, and since more nil power never needs more block votes, `m` only moves down and the whole search is one pass over the two sorted lists. Fewest votes is not the same thing: where signatures are small (secp256k1), a few more nil prevotes can cost less than fewer block prevotes.

The second is cost. A minority of validators can sign prevotes for every round ahead that a node takes votes for, each naming the same round for a different made-up block, and all of them are held when that round's prevotes arrive. Every block the round holds no prevote for is refuted by the same votes, so that answer (`absent`) is worked out once and shared; a block the round does hold prevotes for gets its own, and there are at most two such blocks a validator, the one it prevoted and the one its other prevote names if it signed two, and the one of the vote in hand. The votes of a refutation are gathered only when `votes()` is called, which `faultsShown` does for the one winning claim of each accused.

The third is the validator that signed two prevotes for the round. It has prevoted both. The set holds one and keeps the other aside (`alternates`), and the vote in hand may be yet another; `several` gathers them by validator, and for each claim the one that speaks against it is taken, nil before a block: a validator that prevoted the block and then also nil has prevoted nil. Without the vote put aside, a claim that arrives after the double sign would be held against one of the two votes only, and whether it was refuted would depend on the order the votes came in.

An honest validator names only a round in which it counted +2/3 for the block itself (rule 28, or the round of its own lock). That majority and +2/3 against it, held at one node or at two, share more than a third of the power, and every validator in that share signed two prevotes in the round. So an honest validator is proven false here only by more than a third of the power signing twice, each of them convicted by its own two votes.

Then the new vote is forwarded to every peer except its source and the rules run. A new vote after the decision is the "fuller commit" of `STAKING.md` section 2.1: a precommit for the decided block in the decided round is merged into the stored commit so that the slow validator is credited as a signer (block rewards and downtime tracking in the staking module are keyed on `lastCommitSigners`, so being recorded absent for a few hundred milliseconds of latency would be a penalty). `test/engine.test.ts`, "folds a precommit that arrives after the decision into the stored commit", isolates one validator, lets the other three decide, then injects the fourth's precommit and reads the stored commit back with four signatures.

The budget is what keeps one peer from spending the node's signature checks:

```ts
  /** Whether one more vote of this peer may be verified in the current second, and if so, counted. */
  private withinVoteBudget(peerId: string, validators: number): boolean {
    const b = this.voteBudget(peerId);
    if (b.votes >= Math.max(VOTES_PER_PEER_SECOND, 8 * validators)) return false;
    b.votes++;
    return true;
  }

  private voteBudget(peerId: string): { second: bigint; votes: number; charged: boolean } {
    const second = this.now() / 1000n;
    let b = this.voteBudgets.get(peerId);
    if (!b || b.second !== second) {
      // Peers come and go: what is left of other seconds is let go once there is much of it.
      if (this.voteBudgets.size > 4096) for (const [k, x] of this.voteBudgets) if (x.second !== second) this.voteBudgets.delete(k);
      this.voteBudgets.set(peerId, (b = { second, votes: 0, charged: false }));
    }
    return b;
  }

  /**
   * A vote over its peer's budget waits, unverified, and is taken up again shortly: a peer that hands over all the
   * votes of a height at once, as every node does for a peer that has just connected, is slowed and loses none.
   * What waits is bounded for each peer and in all. A vote there is no room for is dropped, and the peer is
   * charged, once for the second.
   */
  private deferVote(v: Vote, peerId: string, validators: number): void {
    const queue = this.deferredVotes.get(peerId) ?? new Map<string, Vote>();
    // The same signed vote again takes no second place; one with another signature is another vote.
    const id = signedVoteKey(v);
    if (queue.has(id)) return;
    const room = Math.min(DEFERRED_VOTES_CAP, Math.max(MAX_DEFERRED_VOTES_PER_PEER, 64 * validators));
    if (queue.size >= room || this.deferredCount >= 2 * room) {
      const b = this.voteBudget(peerId);
      if (!b.charged) {
        b.charged = true;
        this.log('warn', 'peer sends more votes than are verified or kept waiting', { peer: peerId });
        this.d.scorePeer?.(peerId, VOTE_FLOOD_POINTS, 'vote flood');
      }
      return;
    }
    queue.set(id, v);
    this.deferredVotes.set(peerId, queue);
    this.deferredCount++;
    this.deferredTimer ??= setTimeout(() => this.resumeDeferredVotes(), DEFERRED_VOTES_MS);
  }

  /** Hand the votes that waited to `handleVote` again, in the order they came; those still over the budget wait on. */
  private resumeDeferredVotes(): void {
    this.deferredTimer = null;
    if (!this.running) return;
    const waiting = [...this.deferredVotes];
    this.deferredVotes.clear();
    this.deferredCount = 0;
    for (const [peerId, votes] of waiting) {
      for (const v of votes.values()) {
        this.handleVote(v, peerId).catch((e: unknown) => this.log(this.running ? 'error' : 'debug', 'handling a vote failed', { err: e instanceof Error ? e.message : String(e) }));
      }
    }
  }
```

A second is the node's clock in whole seconds, and the budget is `VOTES_PER_PEER_SECOND`, 200, or eight for each validator of the vote's set if that is more. A round is two votes a validator and a peer passes each on once, and a vote already held is dropped before this point at no cost, so in the ordinary run of things a peer stays far below it. The exception is the honest one that matters: a node hands a peer that has just connected every vote it holds of the height (`messagesForPeer`), and after thirty rounds of four validators that is 240 votes at once. If the votes over the budget were dropped, some would not come back: a full node passes a vote on once, and when its signer sends it again the full node holds it already and passes nothing on.

One more thing happens before the budget is asked: a vote whose signature is being verified at this moment is not verified a second time. The same vote arrives from every peer that has it, often within the few milliseconds the first copy spends with the verifier, before `hvs.has` can know it; `verifyingVotes` holds the keys of the votes in verification, and a copy that finds its own there is dropped, since it says nothing the first does not. The key is released when the verification returns, and what follows runs without a pause, so the next copy finds the vote held. If the verification does not return but throws, because a worker exited, the copies were dropped on the strength of a check that never happened; the vote is then put with the ones that wait and tried again, and a line is logged.

So a vote over the budget waits (`deferVote`): it is put, unverified, in its peer's queue, and `resumeDeferredVotes` hands the queues back to `handleVote` every `DEFERRED_VOTES_MS`, 250 ms, in the order the votes came. Those the budget still has no room for wait on; those that have meanwhile arrived another way, or belong to a height that is over and not kept, fall out at the checks before the budget, which cost nothing. A queue holds `MAX_DEFERRED_VOTES_PER_PEER`, 1,024, or 64 for each validator if that is more, and never more than 32,768; all the queues together hold twice one queue's bound. With the second's budget of eight for each validator, a peer whose queue is empty can hand over 36 whole rounds of a height at once with 100 validators and 153 with four, and with 2,000 validators, where the cap is what binds, 12; less when other peers' votes are waiting too. The same signed vote takes one place however often it is sent (`signedVoteKey`: what the vote says, whose it is, and the hash of its signature, so that a copy with another signature is another vote and cannot be kept out by a bad one). Only a vote there is no room to keep waiting is dropped, and then the peer is charged 10 points through `scorePeer`, once for the second, so one that keeps it up is banned ([chapter 6](06-p2p.md)). A vote with no peer behind it, the node's own or one replayed when a height starts, is not counted. The map of budgets is swept of other seconds' entries when it has grown past 4,096, and `stop` empties the queues. `test/faults.test.ts`, "are verified up to a number a second, the rest waiting their turn, and a peer is charged only for what there is no room to keep", sends 240 good votes through one peer within a second: 200 are held at once, the other 40 a moment after the second has passed, and nothing is charged, also when the 40 are sent thirty times over while they wait; 1,300 more in one second, of which 113 find neither budget nor room, cost one charge; and one vote handed in by four peers at once is verified once.

A vote for a kept height takes a shorter way:

```ts
  /**
   * A verified vote for a kept height. It is held against the votes kept, reported if it shows a fault, and passed
   * on if it is new, so that two votes shown to two nodes still meet at one of them.
   */
  private addPastVote(v: Vote, fromPeer: string | null): void {
    const kept = this.past.get(v.height);
    if (!kept || v.round > kept.maxRound) return;
    const { added, conflict } = kept.votes.add(v);
    if (conflict) this.report(makeDuplicateVoteEvidence(conflict, v));
    if (!added && !conflict) return;
    // Also for the second of two votes in one place: it is as signed as the first.
    for (const ev of faultsShown(kept.votes, kept.validators, v)) this.report(ev);
    if (!added) return;
    this.d.broadcastVote(v, fromPeer);
  }
```

It is added to the kept vote set, where a conflict is a double sign as in the current height, held against the other votes with `faultsShown` (the second of two in one place as well), and passed on to the peers if it is new. No rule runs and no commit is touched. Passing it on is what lets the two halves meet: a validator that shows one late vote to one node and a conflicting one to another has each of them relay what it was given, and each then holds both. The relay is bounded, because a kept vote set has one place a validator, type and round, and rounds past the last the height reached are refused.

#### Signing: `signAndAddVote`, `prevote`, `precommit`

```ts
  private signAndAddVote(type: VoteType, hash: Uint8Array | null, polRound = -1): void {
    const pv = this.d.privValidator;
    if (!pv) return;
    const idx = this.validators.indexOf(pv.address);
    if (idx < 0) return;
    const held = this.d.signingHeld?.() ?? null;
    if (held) {
      this.log('debug', 'not voting', { h: this.height, r: this.round, why: held });
      return;
    }
    const unsigned = { type, height: this.height, round: this.round, blockHash: hash, polRound, validatorIndex: idx };
    let signature: Uint8Array;
    try {
      signature = pv.signVote(this.d.chainId, unsigned);
    } catch (e) {
      if (e instanceof DoubleSignError) {
        this.log('error', 'double-sign guard refused to sign', { err: e.message });
        return;
      }
      throw e;
    }
    this.log('info', voteTypeName(type), { h: this.height, r: this.round, block: hash });
    this.addVote({ ...unsigned, signature }, null);
  }

  /**
   * `polRound` is the proposal's, and is named only in a prevote for its block. A prevote for the block this
   * validator is locked on names the round of the lock if that is later: the lock was taken on +2/3 prevotes for the
   * block in that round, so the claim is true, and it is the one that answers for every earlier precommit of the
   * height. Naming the proposal's older round there would read, beside a precommit for another block in between,
   * as a lock forgotten.
   */
  private prevote(hash: Uint8Array | null, polRound = -1): void {
    if (hash === null) return this.signAndAddVote(VoteType.Prevote, null, -1);
    const locked = this.lockedHash !== null && bytesEqual(this.lockedHash, hash);
    this.signAndAddVote(VoteType.Prevote, hash, locked ? Math.max(polRound, this.lockedRound) : polRound);
  }
```

A full node (no key) or a node whose key is not in the current set silently does nothing: it still runs every rule and follows the decision, it just never votes. A validator whose signing is held (`signingHeld()` gives a reason) does the same, with the line `not voting` at `debug`: the step it is in passes without its vote. When the node lets it sign, it calls `signingResumed()`, which begins the round the state machine is in again, unless the height is decided or block sync has already taken the chain past it. Nothing of that round was signed, so the round can be gone through a second time, once what the state machine did in it without a signature is taken back. The lock is set to what the private validator holds for the height, as `startHeight` sets it: on a polka the state machine locks and moves to `precommit` whether or not the precommit was signed, and a lock no precommit stands behind would have the next prevote name the round it is cast in, which the signer refuses. The round is taken out of `polkaHandled`, `prevoteTimeoutScheduled` and `precommitTimeoutScheduled`, since each of those marks something done once, without a vote. Then `startRound(this.round)`: the validator proposes if the round is its own, and `evaluateRules` prevotes by the proposal the round holds and, if the polka is there already, locks and precommits on it, this time with the signature. Without that a validator alone, or one the others wait on, would sit in a step it had passed until somebody else moved the round on, and alone nobody does. The guard's refusal is caught and logged; any other error propagates. A signed vote enters through the same `addVote` as a peer's vote, which broadcasts it (with `fromPeer` null, so to everyone) and re-runs the rules. This is the only place votes are signed; `prevote(hash, polRound)` and `precommit(hash)` are one-line wrappers. `prevote` is given the `polRound` of the proposal it answers. A prevote for nil names nothing; a prevote for the block the validator is locked on names the round of the lock if that is later than the proposal's, since that is the majority the lock stands on and the one that answers for every precommit before it; any other names the proposal's round. The guard's refusals now include a prevote that would leave a lock on too old a round, which the rules never ask for; if a bug ever did, the vote would not be cast. `test/amnesia.test.ts`, "prevotes the block its lock moved to on the round of that lock, when the block comes back on an older majority", drives one `Consensus` through four rounds with the other three validators played by the test: locked on B in round 1, moved to D in round 2, and D proposed in round 3 with `polRound` 0. Its prevote names round 2. With the proposal's round in it the guard refuses and the validator casts no prevote, which is the test failing.

#### Gossip, fetched blocks and catch-up

`scheduleGossip()` arms a timer under the key `'gossip'` that fires every `gossipMs` while the height is undecided, then re-arms itself. `startRound` calls it, which replaces the previous timer; `decide` and `startHeight` clear it.

```ts
  private scheduleGossip(): void {
    this.schedule('gossip', this.timeouts.gossipMs, () => {
      if (this.decided) return;
      const pv = this.d.privValidator;
      if (pv) {
        const idx = this.validators.indexOf(pv.address);
        if (idx >= 0) {
          for (const set of [this.hvs.prevotes(this.round), this.hvs.precommits(this.round)]) {
            const v = set.get(idx);
            if (v) this.d.broadcastVote(v, null);
          }
        }
        // The prevotes behind our valid block, for a peer that missed that polka: without them it cannot accept a
        // re-proposal. And the prevotes behind those: one that names an earlier round counts at a peer only once the
        // peer holds that round's majority too, so the whole line back to the first polka is sent.
        if (this.validBlock && this.validRound >= 0) {
          const valid = blockHash(this.validBlock);
          const rounds = [this.validRound];
          const seen = new Set<number>();
          for (let r = rounds.pop(); r !== undefined; r = rounds.pop()) {
            if (seen.has(r)) continue;
            seen.add(r);
            for (const v of this.hvs.prevotes(r).all()) {
              if (r !== this.round) this.d.broadcastVote(v, null);
              if (v.polRound >= 0 && bytesEqual(v.blockHash, valid)) rounds.push(v.polRound);
            }
          }
        }
        // The round's proposer re-sends the round's proposal, whether it built the block or re-proposed another's.
        const prop = this.proposals.get(this.round);
        if (prop && prop.valid && !prop.fetched && bytesEqual(this.proposerAt(this.round), pv.address)) this.d.broadcastProposal(prop.proposal, null);
      }
      this.scheduleGossip();
    });
  }
```

Each tick re-sends three things, all read back from what the node holds, nothing re-signed. First, this validator's own prevote and precommit for the current round. Second, when there is a valid block, *every* prevote the node holds for `validRound` (unless that is the current round), and then for every round those prevotes name for the valid block, and so on back: those prevotes are the polka that made the block valid, and a peer that missed them cannot accept the block's re-proposal (rule 28 below requires the receiver to hold the polka's prevotes itself), so re-sending only the current round's votes could leave such a peer prevoting nil for a block the rest of the network is about to decide. The walk back is for the counting rule: a prevote that names an earlier round counts at the peer only once the peer holds that round's polka as well, so the whole line of polkas behind the valid block is sent, each round once (`seen`). It is as long as the block's history of re-proposals in this height, which is short. Third, the current round's proposal, if it is valid, not fetched, and this node is `proposerAt(this.round)`. The last condition is keyed on the round's proposer, not on who built the block: a re-proposal of `validBlock` carries the original builder's `proposerAddress` in its header, and the node that must repeat it is the one that signed this round's proposal, which is this round's proposer. `DESIGN.md` section 3 names the trade: it replaces Tendermint's per-peer state tracking "with something far simpler at the cost of some bandwidth". The method's doc comment says why it is safe: "Receivers drop duplicates before verifying them, so this costs bandwidth, not CPU."

`handleFetchedBlock(block)` is `RPC-SYNC-PROOFS.md` section 4.5. When rule 49 sees +2/3 precommits for a hash this node holds no valid proposal for, it asks peers for the block; the node routes a `blockResponse` for the current height here. The method finds the round whose precommits have a quorum for this block's hash and whose stored proposal, if any, is not already a valid proposal for that hash: a round may hold a valid proposal for *another* block while +2/3 precommitted this one (a late proposal, or a relay's), and the fetched block then replaces it. It validates the block as `handleProposal` does for a re-proposal, without the clock-drift check, re-checks its preconditions after the await (including that no valid proposal for this hash appeared meanwhile), and stores it as a proposal with `polRound: -1`, a stand-in signature (`zeroSignature(this.d.getState().scheme)` from [chapter 2](02-crypto.md): the chain scheme's tag followed by zeros of its signature size, never verified) and `fetched: true`. The next `evaluateRules` decides it through rule 49. Fetched proposals are never re-broadcast (`messagesForPeer` and the gossip timer both exclude them), because the stand-in signature would fail at the peer. `test/sync.test.ts`, "gossips evidence from a node that cannot propose, and decides a height from a fetched block", filters every proposal message to validator 3 and checks that it still decides four more heights with `blockSync.synced` staying at zero.

`messagesForPeer()` returns every valid, non-fetched proposal and every vote held for the current height, the heads of the rounds whose proposal is not among those (`heads`), and the heads of the kept heights (`pastHeads`, the newest height first, `MAX_HEADS_VERIFYING` at most); `Node.init` sends them to each newly connected peer.

#### Timeouts

`schedule(key, ms, fn)` replaces any timer under the same key and runs `fn` only if still `running`. The three paper timeouts each check that the height and round they were armed for are still current:

```ts
  /** Line 57: no proposal arrived in time; prevote nil. */
  private onTimeoutPropose(h: bigint, r: number): void {
    if (h !== this.height || r !== this.round || this.step !== 'propose') return;
    this.log('debug', 'timeout propose', { h, r });
    this.step = 'prevote';
    this.prevote(null);
    this.evaluateRules();
  }

  /** Line 61: +2/3 prevoted but for no single value; precommit nil. */
  private onTimeoutPrevote(h: bigint, r: number): void {
    if (h !== this.height || r !== this.round || this.step !== 'prevote') return;
    this.log('debug', 'timeout prevote', { h, r });
    this.step = 'precommit';
    this.precommit(null);
    this.evaluateRules();
  }

  /** Line 65: +2/3 precommitted but for no single value; next round. */
  private onTimeoutPrecommit(h: bigint, r: number): void {
    if (h !== this.height || r !== this.round || this.decided) return;
    this.log('debug', 'timeout precommit', { h, r });
    this.startRound(r + 1);
  }
```

The propose timeout fires only if still in `propose`: a proposal that arrived meanwhile already moved the step. The prevote timeout is armed by rule 34 when +2/3 have prevoted for *anything* and fires only if no polka resolved the step. The precommit timeout is armed by rule 47 and starts the next round unless a decision came first.

#### The rules: `evaluateRules` and `runRulesOnce`

```ts
  private evaluateRules(): void {
    if (this.evaluating) {
      this.reevaluate = true;
      return;
    }
    this.evaluating = true;
    try {
      for (let i = 0; i < 64; i++) {
        this.reevaluate = false;
        const fired = this.runRulesOnce();
        if (!fired && !this.reevaluate) break;
      }
    } finally {
      this.evaluating = false;
    }
  }
```

Every rule that fires may cast a vote, which calls `addVote`, which calls `evaluateRules` again. The re-entrancy guard turns that nested call into a flag, and the outer loop re-runs the rules until a pass fires nothing and nobody asked for another pass; 64 is a safety bound. `runRulesOnce` returns after the first rule that fires, so rules are checked in a fixed order and each pass applies one of them. It returns false at once when not running or already decided. With `r = this.round`, `prop` the round's proposal, `prevotes` and `precommits` the round's sets, the rules are:

**Line 55, skip ahead.** For every round `rr > r` where `isOneThird(roundPower(rr))`: `startRound(rr)`. More than a third of the power is in a later round, so at least one honest validator is, so this node has fallen behind and should jump. Checked first because nothing in a stale round matters.

**Line 22, fresh proposal.**

```ts
    if (this.step === 'propose' && prop && prop.proposal.polRound === -1) {
      this.step = 'prevote';
      const unlockedOrSame = this.lockedRound === -1 || (this.lockedHash !== null && bytesEqual(this.lockedHash, prop.hash));
      this.prevote(prop.valid && unlockedOrSame ? prop.hash : null);
      return true;
    }
```

The paper: on a proposal with `vr = -1` while in `propose`, prevote `id(v)` if `valid(v)` and (`lockedRound = -1` or `lockedValue = v`), else nil; then step `prevote`. An invalid block, or a block different from the one we are locked on, gets a nil prevote. The proposal names no round. For a locked validator voting for another block that would be the plainest amnesia, and the condition is what keeps it from being signed. For the locked block itself, `prevote` puts the round of the lock in the vote: a fresh proposal of the block a validator is locked on happens when a block fetched on +2/3 precommits stands in for the proposal (`handleFetchedBlock` stores it with `polRound` -1), or when a proposer chooses to offer it so.

**Line 28, re-proposal with a proof of lock.**

```ts
    if (this.step === 'propose' && prop && prop.proposal.polRound >= 0 && prop.proposal.polRound < r) {
      const vr = prop.proposal.polRound;
      if (this.hvs.prevotes(vr).hasQuorumFor(prop.hash)) {
        this.step = 'prevote';
        const canUnlock = this.lockedRound <= vr || (this.lockedHash !== null && bytesEqual(this.lockedHash, prop.hash));
        this.prevote(prop.valid && canUnlock ? prop.hash : null, vr);
        return true;
      }
    }
```

The paper: on a proposal with `vr >= 0` and +2/3 prevotes for `id(v)` in round `vr`, while in `propose` and `vr < round`, prevote `id(v)` if `valid(v)` and (`lockedRound <= vr` or `lockedValue = v`), else nil. The node must itself hold the polka's prevotes for round `vr` in `hvs`, counted as `HeightVoteSet.add` counts them; if they have not arrived the rule waits, and the propose timeout may fire first. This is why `messagesForPeer` hands a newly connected peer the votes of every round of the height, and why the gossip timer re-sends the prevotes of `validRound` alongside the current round's votes. The prevote is signed with `polRound = vr`: the validator states which polka it voted on. When it is locked on another block, `canUnlock` has just checked that `vr` is the round of its lock or a later one. When it is locked on this very block, `prevote` names the round of the lock instead of `vr` if the lock is the later of the two. Either way a locked validator's prevote for a block names a round no earlier than its lock, and so no earlier than any precommit it has signed in the height: it can never stand beside one of them as evidence.

**Line 34, prevote timeout.** In `prevote`, when `prevotes.hasQuorumAny()` and the timeout has not been armed for this round: arm it. The `prevoteTimeoutScheduled` set is the paper's "for the first time".

**Line 36, polka for the proposal.**

```ts
    if (prop && prop.valid && STEP_ORDER[this.step] >= STEP_ORDER.prevote && prevotes.hasQuorumFor(prop.hash) && !this.polkaHandled.has(r)) {
      this.polkaHandled.add(r);
      if (this.step === 'prevote') {
        this.lockedHash = prop.hash;
        this.lockedRound = r;
        this.step = 'precommit';
        this.precommit(prop.hash);
      }
      this.validBlock = prop.proposal.block;
      this.validRound = r;
      return true;
    }
```

The paper: on the round's proposal and +2/3 prevotes for `id(v)`, while `valid(v)` and `step >= prevote`, for the first time: if in `prevote`, lock on `v` at this round, precommit `id(v)`, step `precommit`; in any case record `v` as the valid value with this round. The split matters: a validator that has already precommitted nil (after the prevote timeout) and then sees the polka does not re-precommit, but it does update `validBlock`, so if it proposes later it re-proposes this block.

**Line 44, polka for nil.** In `prevote`, `prevotes.hasQuorumFor(null)`: step `precommit`, precommit nil.

**Line 47, precommit timeout.** `precommits.hasQuorumAny()` and not yet armed for this round: arm it. No step condition: the paper has none either.

**Line 49, decide.**

```ts
    for (const rr of this.hvs.roundNumbers()) {
      const p = this.proposals.get(rr);
      const q = this.hvs.precommits(rr).quorumValue();
      if (!p || !p.valid || (q && !bytesEqual(p.hash, q))) {
        // +2/3 precommitted a block we never got, or got another proposal for: fetch it rather than fall a height behind.
        if (q && this.d.requestBlock && !this.fetchRequested.has(toHex(q))) {
          this.fetchRequested.add(toHex(q));
          this.log('info', 'precommit quorum for an unseen block; fetching it', { h: this.height, r: rr, hash: q });
          this.d.requestBlock(this.height, q);
        }
        continue;
      }
      if (this.hvs.precommits(rr).hasQuorumFor(p.hash)) {
        void this.decide(rr, p);
        return true;
      }
    }
```

The paper: on the proposal for round `r'` and +2/3 precommits for `id(v)` in `r'`, while undecided, if `valid(v)` decide `v`. Any round counts, not only the current one, which is why `roundNumbers()` is iterated: a node in round 3 may learn that round 1 decided. A quorum for a hash the node has no valid proposal for, or for which the round's stored proposal is a *different* block, triggers a single `requestBlock` per hash (the `fetchRequested` set, emptied when the next height starts), handled by `handleFetchedBlock` above. The second case matters because one proposal is kept per round: if the first proposal to verify for a round was not the one the network precommitted, the node would otherwise hold a valid proposal, never fetch, and never decide. `quorumValue()` returns null for a nil quorum, and `q &&` skips that case.

#### `decide`

```ts
  private async decide(r: number, p: RoundProposal): Promise<void> {
    this.decided = true;
    this.decidedRound = r;
    this.decidedHash = p.hash;
    this.step = 'commit';
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const commit = this.hvs.precommits(r).toCommit(p.hash);
    const h = this.height;
    this.log('info', 'decided', { h, r, hash: p.hash, txs: p.proposal.block.txs.length });
    try {
      await this.d.applyBlock(p.proposal.block, commit);
    } catch (e) {
      if (e instanceof StaleHeightError) {
        this.log('info', 'block already applied by sync', { h });
      } else {
        this.log('error', 'failed to apply decided block; halting', { h, err: (e as Error).message });
        this.stop();
        return;
      }
    }
    if (!this.running) return;
    // Precommits that arrived while the block was being applied could not be stored then.
    this.d.updateCommit(h, this.hvs.precommits(r).toCommit(p.hash));
    this.decisionCount++;
    this.schedule('commit', this.timeouts.commitMs, () => {
      if (this.running) this.startHeight();
    });
  }
```

The decision is recorded synchronously before the first await, so every later event sees `decided` and the rules stop. The commit is built from the precommits present now; the executor persists block and commit together. A `StaleHeightError` means block sync applied this height first and is harmless. Any other failure to apply a decided block, such as an application error or a storage error, is fatal: consensus stops rather than continue from a state it cannot persist, because voting on height `h+1` on top of an unpersisted `h` is how a validator ends up double signing after a restart. The second `updateCommit` is review finding 21: the executor's `updateCommit` ignores a height that is not yet `lastHeight`, so precommits that arrived during the await were accepted into the vote set but never stored; storing the current set again after the apply fixes that. Then the commit timeout, after which `startHeight` reads the new chain state and begins the next height.

`status()` returns a snapshot (`height`, `round`, `step`, truncated hashes of the locked and valid blocks, `decisions`) "for logs and tests"; `test/sync.test.ts` reads `decisions` to show a validator deciding heights from fetched blocks.

#### The double-sign guard in operation

Signing happens in three places: `propose` (step 1), `prevote` and `precommit` through `signAndAddVote` (steps 2 and 3). Within one round the machine naturally advances propose → prevote → precommit, so the guard's step ordering is never violated in normal operation. A new round is a higher `round`; a new height is a higher `height`. The cases where the guard refuses are therefore all abnormal: a restart (handled by `resumeRound`) or a bug. The file is written before the signature leaves the function so that a process started later on the same key and state file cannot sign against what an earlier one sent. Two processes running on one state file at the same time, the scenario validators fear most, are not something the guard can refuse: it reads the record once, when it is constructed, and never sees what the other process writes. `Node` keeps them apart instead, by claiming the data directory with its `LOCK` file before it loads the guard ([chapter 8](08-node.md)). Rule 55 jumping to a later round, and `startRound(r + 1)` after a precommit timeout, both only increase the round; nothing in the machine ever decreases it within a height.

#### Restart and block sync

Two restart paths exist. A process restart goes through `startHeight` with the guard's `lastSigned` as described. A *consensus* restart while the process runs is `restart()`, called by block sync's `onBlockApplied`: when a node is behind and sync applies blocks, consensus must abandon the height it was on and jump to `lastHeight + 1`. The reverse coordination is `isDeciding`: `src/sync/blocksync.ts` checks it before applying a buffered block and waits 200 ms if consensus is mid-decision, so that the executor is not asked to apply two blocks for the same height from two callers at once (it would refuse the second with `StaleHeightError` anyway; the check avoids the wasted verification).

## How it is tested

The engine tests build several nodes in one process over the in-memory transport (`MemoryHub` in `src/p2p/memory.ts`, which supports partitions, isolation and message filters) with the key-value application and `FAST_TIMEOUTS`; `makeTestnet`, `waitForHeight` and `waitFor` are in `test/helpers.ts`. Run them with `npm test` or `npx vitest run test/consensus.test.ts`.

`test/consensus.test.ts`:

- "four validators commit blocks and agree on them": five heights pass, block 3 has the same hash on every node, and every stored commit for it holds at least three signatures (+2/3 of four).
- "transactions gossip to every node and land in state": a transaction submitted on one node reaches every application; an invalid one is refused at admission (mempool, next chapter).
- "keeps going with one of four validators down": three of four is +2/3; height 4 is reached.
- "halts with two of four validators down": two of four is not; after 3 s the height is still 0. This is the liveness bound of `DESIGN.md` section 1.
- "halts during a partition and resumes without divergence after healing": a 2+2 partition stops progress (at most one in-flight block per side), and after healing all four agree on the block three heights later. This is safety under partition: neither side could decide alone.
- "a late-joining full node catches up through block sync": sync, then `restart()` into live consensus; the late node's block at the hand-over height matches a validator's.
- "adds a validator through the application and it starts signing": a `val:` transaction grows the set; the commit two heights after the set changed has five slots and the newcomer's slot is signed. This exercises the H+2 rule end to end with a validator that joined as a full node.
- "removes a validator and the set shrinks": the mirror image; the commit has three slots.

`test/recovery.test.ts`:

- "a validator restarted from disk resumes with its state, key guard and app intact": node 0 runs with a data directory, is stopped, the others advance three heights, node 0 is rebuilt from disk at the stopped height with its application state, catches up, and within twenty heights its signature appears in a stored commit. The guard file is `priv_validator_state.bin` in that directory.
- "double-sign evidence is built, included in a block, and handed to the app": two conflicting prevotes are forged with validator 3's key and fed to node 0's `handleVote`; the pool holds one item; every application receives the `misbehavior` for that height; the pool is empty afterwards (`markCommitted`).

`test/review4.test.ts`, "lets go of pending and committed evidence and its inventory once it is too old, and bounds what waits": on a pool by itself, evidence for heights 3 and 4 is added (a second `add` of the first returns false) and `markCommitted` is given the evidence for height 3 and one for height 5 that was never pending; `held` is one pending, two committed, three in the inventory, and the height-5 evidence is refused by `add` and served by `hasHash`. `pruneIf` for heights up to 4 leaves one committed and one inventory entry, and `pruneIf(() => true)` leaves nothing. Evidence for height 6 is then added and `markCommitted` is given another pair of votes for the same offence: `held` is nothing pending, one committed and one in the inventory, the pair that waited is no longer served by `hasHash`, and `pruneIf(() => true)` again leaves nothing. Adding `MAX_PENDING + 10` pieces leaves `MAX_PENDING` pending and as many in the inventory.

`test/engine.test.ts`:

- "folds a precommit that arrives after the decision into the stored commit": the fuller-commit path in `addVote` and `updateCommit`, with `commitMs: 1500` so the straggler arrives inside the commit timeout.
- "drops evidence older than the configured age by block time, and keeps young evidence": with `maxEvidenceAgeMs: 3000`, evidence for height 2 is added once height 2 has aged past the limit; within eight heights `pruneIf` has discarded it (the executor's after a commit, or the proposer's before it picks evidence, whichever runs first) and no application was told; evidence for a recent height is included and reaches every application.
- "rejects a block from another protocol version": `validateBlockStructure` returns the version error.
- "refuses a genesis with no validators from either side": `genesisState` throws (chapter 3, cited by `STAKING.md` section 2.3).

`test/amnesia.test.ts` has eight cases on locks. Four are described where their code is: the round a prevote signs and the double sign by round alone (chapter 3), the private validator's lock (`privval.ts` above), the restart that takes the lock up again (`startHeight`), and the counting rule on a `HeightVoteSet` (`votes.ts`). "proves a forgotten lock with a precommit and a later prevote for another block that names no round from the lock on" is the evidence itself (chapter 3). "finds a forgotten lock in the votes it holds, whichever came last, and has every application punish it as one": on four validators, a precommit in round 4 and a prevote for another block in round 6 are signed with one validator's key for the next height and handed to one node, the prevote naming round 2; then the same for another validator at another node, prevote first and naming no round; then a pair whose prevote names round 5, which the rules allow. Every application is told of the first two as `amnesia` at their heights, the blocks hold exactly two pieces of evidence of that kind, and nothing is made of the third. One validator at a time, because votes of more than a third of the power in a later round would take every node there (rule 55). "decides a block proposed again in the next round on prevotes that name the first round, and slashes nobody": a message filter arranges a round 0 that decides nothing and leaves round 1's proposer locked (one validator never gets the proposal, and the proposer-to-be's prevote reaches neither of the other two); round 1 proposes the same block with `polRound` 0, the filter is lifted, the gossip tick passes round 0's polka on, and the block is committed in round 1 with every round-1 prevote for it naming round 0, no evidence anywhere and nobody slashed.

`test/review.test.ts`, "resumes after a restart that left a signature at the current height, by skipping that round": review finding 5, described under `startHeight`. "decides a block re-proposed with a proof of lock after its round stalled past the clock drift limit": review finding 37; four validators with `maxClockDriftMs: 300`, and at two consecutive heights a message filter drops the round-0 proposal on its way to validator 3, every round-0 prevote on its way to validator 2, and every round-1 proposal, so in round 0 validators 0 and 1 see the polka and lock while no one holds three precommits for the block, and round 1 is lost; round 2 or later re-proposes the block with `polRound: 0`, by then older than the drift limit, and the chain must still reach four more heights. The same file's "rejects decoded validator sets with duplicate members, wrong order or a bad proposer index" protects `proposerAt` and the quorum arithmetic from a crafted set (finding 1), and "does a bounded amount of work on a peer status it cannot act on" is the block sync recursion of finding 30, which surfaced as a stack overflow during consensus tests.

`test/units.test.ts`: `describe('private validator')`, "refuses to sign backwards or conflicting content, allows identical re-signs" (the guard, case by case) and `describe('validator set')`, "picks proposers in proportion to voting power" (600 rounds of `incrementProposerPriority` give 100/200/300 proposals to powers 1/2/3).

`test/sync.test.ts`, "gossips evidence from a node that cannot propose, and decides a height from a fetched block": evidence added on a full node reaches every validator's application through inventory gossip, and a validator that never receives a proposal keeps deciding through `handleFetchedBlock`.

`test/review5-net.test.ts`, "drops a vote for a round far ahead before verifying it, holds for the next height only proposals a validator signed, and forgets block requests with the height": two of four validators run, so the height stays at 1. A vote with a zero signature for round `MAX_ROUND_AHEAD + 1` leaves its sender's score at 0, while the same vote for the next round costs its sender 20 points, which shows the first was never verified. A prevote for height 2 signed with validator 0's key is handed in five times and `nextHeightVotes` holds one entry; the same validator's prevote for another block hash makes it two. Proposals for height 2 are then signed with the validators' own keys, for rounds 5 and later so that none stands where a real proposal will. One that names validator 0 as proposer and is signed by validator 1 is not held and costs its sender 20 points; one with a proof of lock and one whose block is of another height are dropped without a verification, their sender's score still 0. Five rounds from validator 0, and round 5 once more through another peer, leave two held; three rounds from each of the other three validators bring the buffer to 8 and no further. A hash planted in `fetchRequested` is gone, and the buffer empty, once the other two validators start and height 2 is reached. The same file's "has no proposer when it is empty, and says so in the one way create() does" is the decoder's rule for an empty set ([chapter 3](03-types.md)). "catches the failure of a proposal nobody waits for", in the same group as the first: on node 0 of a four-validator network of which two are started, `handleProposal` is replaced by a function that rejects with `verifier closed`, `proposalUnawaited` is called with a proposal for height 1, round 0, and 20 ms later the real method is put back. An unhandled rejection fails the run; this one is caught and logged.

`test/review5-node.test.ts`, "refuses a block with more evidence than a block may carry": on a stopped single-validator node, a block built with `MAX_EVIDENCE_PER_BLOCK + 1` pieces of evidence is refused by `validateBlockStructure` as `'too much evidence'` and the same block with 16 passes. "does not pool gossiped evidence that is already too old for a block" covers the age check in `Node.acceptEvidence`. "bounds a block by what its proposer chose, and a validator set by what a frame holds": on a chain whose genesis sets the smallest block size, 65,536, the block after the state passes `validateBlockStructure` empty; with one transaction that brings `blockDataBytes` to exactly the limit it passes, and with one byte more it is `'block too large'`, whatever the header and the commit weigh. The second half is the bound on a validator set ([chapter 3](03-types.md)). "gives evidence half a block at most, so the largest transaction admitted still fits": on a one-validator chain with the same 65,536-byte limit, sixteen pieces of evidence are put in the pool and a transaction of 32,764 bytes, the largest the mempool takes there, is submitted. The transaction is committed in a block whose transactions and evidence are within the limit and whose evidence alone is within half of it, and the evidence the builder left out of that block is committed in the blocks after it, all sixteen pieces in the end.

## Limitations and ideas

Known simplifications, from `DESIGN.md` section 10 and from reading the code:

- Evidence is found in what a node holds: the votes and proposals of its height and of the 16 heights before it, in memory. A node that was restarted, or that joined later, holds nothing of the heights before, and the second half of a proof that arrives after 16 heights is dropped. A late vote for a round the height never reached is dropped too.
- A validator restarted without its sign-state record signs again where it signed before, and is now reported for it within those 16 heights. The record is the defence. The node holds a validator back from its start until it is level with the peers it has heard, which covers the heights those decided while it was away. It is held by what its first peers say, and again when a block reaches it by block sync while a peer that serves blocks is still above ([chapter 8](08-node.md)): one whose first peers are behind themselves is let go early and signs in the height it is in until the first such block, and one that comes back into the height it stopped in, with the others still in it, is level and signs.
- A prevote that names a polka which never formed is punished only where +2/3 of the power prevoted something else in the round named, and on the assumption that less than a third signs twice; elsewhere it is only never counted. That evidence carries a vote for most of the set, and no node takes into its pool one that is larger than half a block less the builder's slack.
- A proposer that sends different proposals for the same round to different peers is reported by a node that holds one and is sent the other, or its head. Two proposals held for the next height, before it starts, are not compared, and neither are their heads sent on then; a head for a height a node is not in and has not kept is dropped; and heads are sent when first held and to a peer that connects during their height or within the 16 heights kept after it, so nodes that meet later than that do not compare what they held.
- A proposal carries the whole block in one message; Tendermint splits large blocks into gossiped parts.
- Vote verification is limited by peer and by second, with one figure for every peer. A peer that relays for many validators and one that relays for few have the same budget; votes over it wait up to a bound and are verified late, and beyond the bound they are dropped: a peer that hands over more rounds of a height at once than the receiver's budget and queue take (36 with 100 validators, 12 with 2,000) loses the rest, and a node left without the votes it needs is caught up by block sync when the height is decided. Proposals are not counted.
- The 8 proposals held for the next height can be filled by four validators signing two each for rounds that will not come; the real proposal then has to wait for the proposer's next gossip tick. A place needs the valid signature of a next-height validator, so a peer that is no validator cannot fill one with a proposal of its own, though any peer may relay a validator's.

Exercises:

1. Persist `lockedRound` and the locked block hash in `LastSigned`, restore them in `startHeight`, and write a test that restarts a validator between a precommit and the decision and checks that it prevotes only its locked block in later rounds.
2. Drive `Consensus` directly in a unit test with an injected `now`, a scripted `ConsensusDeps` and forged votes, and make rule 28 fire: a polka in round 0, a timeout, and a re-proposal with `polRound: 0` that a validator locked in round 0 accepts.
3. A proposal held for the next height is not looked at for what its proposer signed until that height starts, and its head is not sent on before. Record and relay heads for the next height too, and work out what bounds the verifications a peer can then make a node do for rounds that will never come.
4. A node hands a newly connected peer every vote of the height at once, and the peer makes them wait if they are over its budget. Send them paced instead: so many a second, newest round first, stopping when the height ends. What does the receiver's queue then need to hold, and what does a full node that relays for a validator need to do when a vote it passed on was dropped?
5. Drive `Consensus` with an injected `now` that runs ahead of the proposer's clock by more than `maxClockDriftMs`, and show that the same block is refused as a fresh proposal and accepted when re-proposed with a proof of lock; then decide whether a re-proposal should still be bounded by some larger window, and what it would be.
6. Replace the fixed `commitMs` pause with one that ends early once every validator's precommit has arrived, and measure the block rate on the four-validator benchmark.

## Where to next

[Chapter 5, mempool and executor](05-mempool-executor.md): where the transactions in a block come from, and what happens to a block after `decide` hands it to `applyBlock`.
