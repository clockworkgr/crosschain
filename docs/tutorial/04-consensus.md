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

The two-vote structure exists because of a subtle problem: a validator might see +2/3 precommits for block A and decide, while a slower validator misses them, times out, and moves to the next round. The next proposer must not be able to get a different block B decided at the same height. Tendermint prevents this with *locking*: when a validator precommits a block, it records that block as its `lockedBlock` with the round as `lockedRound`. In later rounds it prevotes nil for any other block. Since deciding A needed +2/3 precommits, +1/3 of the power (including at least one honest validator) is locked on A, and no polka for B can form.

Locking alone would deadlock if validators were locked on different blocks in different rounds (possible when messages arrive late). The escape is the proposal's `polRound` ("proof of lock round"): a proposer that has seen a polka for a block in an earlier round re-proposes that block and names the round. A validator locked on something older than `polRound` may unlock and prevote the re-proposed block, because the polka proves +2/3 preferred it after the validator's lock was taken. `src/types/proposal.ts` documents the field:

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

`DESIGN.md` section 1 states the liveness bound: the chain halts if more than a third of the power is offline or partitioned. It does not fork; it stops, and resumes when enough power returns. `test/consensus.test.ts` checks both halves ("keeps going with one of four validators down", "halts with two of four validators down").

### Instant finality

In a longest-chain protocol (Bitcoin, early Ethereum) a block is "probably final" after enough blocks are built on top. In Tendermint a block with +2/3 precommits is final at once, because the safety argument above says no conflicting block can ever gather +2/3 at that height. The commit, the set of precommit signatures, travels with the next block as `lastCommit` and is what a light client checks. There is no reorganisation logic anywhere in this codebase.

### Why a validator must never sign two different blocks at one height and round

The overlap argument assumed an honest validator votes once per (height, round, vote type). A validator that signs prevotes for A and for B in the same round lets both sides count it, and if enough validators do it, two blocks can be decided at one height: a fork. This is the one fault Tendermint treats as provable misbehaviour, because the two signed votes are the proof. The chain calls it a *duplicate vote*; `src/types/evidence.ts` defines `DuplicateVoteEvidence` as the pair. `DESIGN.md` section 1 lists it as the slashable fault (the staking module burns part of the validator's stake and removes it, `STAKING.md` section 7) and marks the other Tendermint evidence type, *amnesia* (breaking a lock), as deferred.

A validator does not have to be malicious to double sign. The classic way is a crash: the validator signs a prevote for A, crashes before the vote reaches anyone, restarts, forgets, and signs a prevote for B. The private validator in `privval.ts` exists to make that impossible: it writes a record of what it last signed to disk before handing the signature back, and refuses anything at or before that point.

### Evidence

Evidence is a self-contained proof of misbehaviour. Any node that holds both conflicting votes can build it (`addVote` does, when the vote set reports a conflict), nodes gossip it by inventory like transactions (`RPC-SYNC-PROOFS.md` section 4.4), proposers include it in blocks, every validator verifies it against the validator set of the height it refers to, and the executor hands it to the application as `misbehavior` (next chapter). Evidence older than the unbonding period is rejected, by block time, so that stake cannot escape a slash by leaving before the proof lands (`STAKING.md` section 2.2).

### Message flow

Proposals and votes are pushed directly to every peer with no inventory round trip, deduplicated by (height, round, validator, type) before verification (`DESIGN.md` section 3). Three mechanisms make up for the fact that a flooded message is sent once: each validator re-sends its own current-round votes every `gossipMs`, the proposer re-sends its proposal, and a newly connected peer is handed every proposal and vote held for the current height (`messagesForPeer`). Signature verification is asynchronous in worker threads ([chapter 2](02-crypto.md)), so each handler awaits the verifier and re-checks that the message is still relevant before touching state. All state mutation is synchronous on the main thread; there are no locks.

### A worked height

Four validators `v0..v3` of power 10 each, total 40. A quorum is power above 26.67, so any three validators; +1/3 is power above 13.33, so any two. Default timeouts. Call the round-0 proposer of height 7 `P`, computed identically by every node from the validator set.

| time | what happens |
|---|---|
| 0 ms | Every node's `startHeight` reads the chain state, sets `height = 7`, builds a fresh `HeightVoteSet`, and calls `startRound(0)`. `P` calls `propose()`: reaps transactions from the mempool, builds the block with `createBlock`, signs the proposal (guard record written to disk first), broadcasts it and feeds it to its own `handleProposal`. The other three arm the propose timeout for 3000 ms and the gossip timer for 500 ms. |
| ~5 ms | Each validator receives the proposal. `handleProposal` verifies the proposer's signature in a worker, then `validateBlockStructure` (header fields against state, sizes, time) and `verifyBlockSignatures` (the `lastCommit` of block 6 and any evidence). The proposal is stored for round 0 and re-broadcast. `evaluateRules` runs: rule 22 fires because the step is `propose` and `polRound` is -1. Step becomes `prevote`; the validator signs and broadcasts `PREVOTE(7, 0, hash)`. |
| ~20 ms | Each validator holds three or four prevotes for `hash`. Rule 34 (+2/3 prevotes for anything) arms the prevote timeout, 1000 ms. Rule 36 (polka for the proposed block) fires: `lockedBlock = block`, `lockedRound = 0`, step `precommit`, and it signs and broadcasts `PRECOMMIT(7, 0, hash)`; `validBlock` and `validRound` are set too. |
| ~40 ms | Three precommits for `hash` are in. Rule 47 arms the precommit timeout. Rule 49 fires: `decide(0, proposal)`. `decided = true`, step `commit`, all timers cleared, the commit is built from the precommit set (one signature per validator index, null for the missing fourth) and `applyBlock` runs the block through the application and persists it (next chapter). |
| ~60 ms | `applyBlock` resolves. `updateCommit` is called again with the current precommit set, in case precommits arrived while the block was being applied. The commit timer is armed for 1000 ms. |
| ~300 ms | `v3`'s precommit arrives late. `addVote` adds it to the vote set, sees `decided`, and since it is a precommit for the decided round and hash, calls `updateCommit` with a commit now holding four signatures. The executor stores the fuller commit. |
| ~1060 ms | The commit timer fires: `startHeight` for height 8, whose proposer builds `lastCommit` from the stored four-signature commit. |

If `P` is offline, the propose timeout fires at 3000 ms: `onTimeoutPropose` moves to `prevote` and prevotes nil. By ~3020 ms each validator holds three nil prevotes: rule 34 arms the prevote timeout, rule 44 (polka for nil) precommits nil. By ~3040 ms, +2/3 nil precommits: rule 47 arms the precommit timeout, 1000 ms. Nothing else can fire (rule 49 needs a block), so at ~4040 ms `onTimeoutPrecommit` calls `startRound(1)`: a new proposer, and a propose timeout of 3500 ms. Any validator that had already reached round 1 and voted there would have let the others skip ahead through rule 55 as soon as two of them (+1/3) were seen in the later round.

## The code, file by file

The modules in dependency order: `privval.ts` and `votes.ts` depend only on types and crypto; `evidence.ts` on types and the verifier; `validate.ts` on `evidence.ts`; `consensus.ts` on all four.

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

`DESIGN.md` section 1 calls this "non-negotiable", and section 4 explains why signing stays on the main thread while verification goes to workers: signing happens once per consensus step, about 2 ms, and keeping it inline makes the persist-then-broadcast ordering trivial.

**`SignStep`** is `{ Propose: 1, Prevote: 2, Precommit: 3 } as const`. The numbers order the steps within a round. Note that they are not the same values as `VoteType` (`Prevote: 1, Precommit: 2` in `src/types/vote.ts`); `signVote` maps one to the other.

**`LastSigned`** is the persisted record: `height`, `round`, `step`, `signBytes` (the exact bytes that were signed) and `signature`. Keeping the bytes lets the guard recognise an identical re-sign and return the stored signature instead of refusing.

**`SignStateStore`** is the persistence interface: `load(): LastSigned | null` and `save(s)`, with the comment "Must not return until the record is durable". Two implementations:

- **`MemorySignStateStore`** keeps the record in a field. The node uses it when it has no data directory (tests, in-memory simulations).
- **`FileSignStateStore`** encodes the record with the binary codec ([chapter 1](01-codec.md)) as `u64 height, u32 round, u8 step, bytes signBytes, bytes signature` and writes it with `writeAtomic` from `src/store/files.ts`: temp file, `fsync`, rename, then `fsync` of the directory. The directory sync was added for finding 16 of `REVIEW-2026-10-28.md`: without it a power loss could roll the rename back and a signature that had already been broadcast would be forgotten. The node puts the file at `<dataDir>/priv_validator_state.bin`.

**`DoubleSignError`** is the refusal. Consensus catches it by class in `signAndAddVote`.

**`PrivValidator`** holds the `KeyPair`, exposes `address` and `publicKey`, and precomputes the two signing contexts (`signContext(chainId, 'vote')` and `'proposal'`, [chapter 2](02-crypto.md)) so that a vote signature can never verify as a proposal signature or as anything on another chain. The constructor loads the last record from the store.

- `lastSigned()` returns `{ height, round, step }` or null. `Consensus.startHeight` uses it to resume after a restart in a round it can still sign.
- `signVote(chainId, v: UnsignedVote)` maps the vote type to a `SignStep` and calls the guard with `voteSignBytes(chainId, v)`.
- `signProposal(chainId, p: UnsignedProposal)` does the same with `SignStep.Propose` and `proposalSignBytes`.

The guard itself:

```ts
  private guardedSign(height: bigint, round: number, step: number, signBytes: Uint8Array, ctx: Uint8Array): Uint8Array {
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
    const record: LastSigned = { height, round, step, signBytes, signature };
    // Durable before anyone can broadcast it.
    this.store.save(record);
    this.last = record;
    return signature;
  }
```

`cmp` is a lexicographic comparison of (height, round, step). Going backwards in any component is refused. Equal means the same (height, round, step): identical bytes return the stored signature (this is how the gossip re-send can call `signVote` again safely, though in practice consensus re-sends the stored `Vote` object and never re-signs), different bytes are refused. Only a strictly later point is signed, and the record is saved before the signature is returned. The invariant: *for any (height, round, step), the validator has signed at most one distinct message, and that fact survives a crash*.

What it does not record: the locked block. `DESIGN.md` section 10 lists this among the known simplifications: "A validator restarted in the middle of a height forgets its lock: the sign state keeps what was signed, not the locked block", so `lockedBlock` and `lockedRound` are reset in `startHeight` and a restarted validator may prevote a different block in a later round than the one it precommitted. The guard prevents a *duplicate vote* at the same round; it does not prevent *amnesia*, which the same section lists as undetected. CometBFT recovers lock state by replaying a write-ahead log; this chain has no WAL.

Failure modes: a refusal in a vote is logged at `error` level and the vote is simply not cast; a refusal in a proposal is logged and `propose()` returns without arming a timeout. Finding 5 of the review showed that this could deadlock a single-validator chain after a restart; the fix is in `Consensus.startHeight`, which resumes in the round after the one the guard already holds, so the guard is never asked to re-sign a round with fresh content.

`test/units.test.ts`, "private validator refuses to sign backwards or conflicting content, allows identical re-signs", pins the exact behaviour: same bytes return the same signature; a different block hash, an earlier round, an earlier height, and a prevote after a precommit in the same round all throw `DoubleSignError`; a precommit after a prevote and a later height both succeed.

### src/consensus/votes.ts

Vote bookkeeping for one height. The file answers the three questions the rules ask ("is there +2/3 for some value", "is there +2/3 for this value", "how much power has voted") and is where double signing is caught.

**`VoteSet`** holds the votes of one type (prevote or precommit) for one round, indexed by validator index into the height's validator set. Fields: `height`, `round`, `type`, a private `votes: (Vote | null)[]` sized to the set, `powerByBlock: Map<string, bigint>` keyed by `blockHashKey` (`'nil'` or the hex of the hash, from `src/types/vote.ts`) and `totalVoted`.

```ts
  add(vote: Vote): { added: boolean; conflict: Vote | null } {
    if (vote.height !== this.height || vote.round !== this.round || vote.type !== this.type) throw new Error('vote does not belong to this set');
    const val = this.valset.byIndex(vote.validatorIndex);
    if (!val) return { added: false, conflict: null };
    const existing = this.votes[vote.validatorIndex];
    if (existing) {
      if (bytesEqual(existing.blockHash, vote.blockHash)) return { added: false, conflict: null };
      return { added: false, conflict: existing };
    }
    this.votes[vote.validatorIndex] = vote;
    const k = blockHashKey(vote.blockHash);
    this.powerByBlock.set(k, (this.powerByBlock.get(k) ?? 0n) + val.power);
    this.totalVoted += val.power;
    return { added: true, conflict: null };
  }
```

The invariant is one vote per validator per set. A second vote for the same hash is a duplicate (`added: false`, no conflict). A second vote for a different hash is *not stored* and is returned as `conflict` together with the existing one: the caller (`Consensus.addVote`) turns the pair into evidence. Note that `bytesEqual` from `src/crypto/hash.ts` must treat `null` (nil) correctly for this to work; a nil vote and a block vote from the same validator are a conflict. `add` does not verify signatures; the caller does that before calling.

The rest of the class:

- `has(validatorIndex)`, `get(validatorIndex)`: lookup by index.
- `power()`: total power that has voted, for anything.
- `hasQuorumAny()`: `valset.isQuorum(totalVoted)`. Rule 34 and rule 47 use it.
- `hasQuorumFor(blockHash | null)`: +2/3 for one specific value, nil included. Rules 28, 36, 44 and 49.
- `quorumValue()`: the one value with +2/3 (null for nil) or `undefined` if none. Used by `handleFetchedBlock` and the fetch branch of rule 49.
- `all()`, `voterIndices()`: enumeration for gossip and for `roundPower`.
- `toCommit(blockHash)`: builds a `Commit` whose `signatures[i]` is validator `i`'s signature if it precommitted `blockHash`, else null. This is the structure the next block carries as `lastCommit`, and `src/types/block.ts` notes it is linear in the validator count because ML-DSA has no signature aggregation.

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

The literals `1` and `2` are `VoteType.Prevote` and `VoteType.Precommit`; the file imports only the type, not the constant. Methods: `prevotes(r)`, `precommits(r)`, `set(vote)` (picks the set by type), `add(vote)` (throws on the wrong height, delegates to the set), `has(vote)` (true only if the same validator already voted the same hash in that set; used by `handleVote` to drop duplicates before paying for verification), `allVotes()` (every vote of every round and type, for `messagesForPeer`), `roundNumbers()` (sorted ascending; rule 49 and rule 55 iterate it), and:

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

A validator that cast both a prevote and a precommit in round `r` is counted once. Rule 55 compares this with `isOneThird`.

A thing to notice: a peer can make the node allocate a `VoteSet` pair for any round number it names in a vote, because `set(vote)` creates the round on first use. `Consensus.handleVote` bounds this with `MAX_ROUND_AHEAD` before the vote reaches `addVote`.

### src/consensus/evidence.ts

**`evidenceId(ev)`** is `sha256` of the codec encoding of one piece of evidence; it is the inventory key the p2p layer announces and fetches by (`src/node/node.ts` maps evidence through it for the `onAdded` broadcast and for the pending list a new peer receives). Its comment separates it from `evidenceHash` in `src/types/block.ts`, "the root over a list", which hashes a block's whole evidence list for the header; `consensus.ts` imports that one. Notice that the file defines this function between two groups of imports, which is legal but unusual.

**`EvidencePool`** holds evidence waiting to be included in a block. Three containers: `pending` (keyed by `evidenceKey`, which is `height/round/type/validatorIndex`, so one record per infraction slot), `committed` (keys that have been in a block), and `byHash` (inventory hash to evidence, for serving fetches). Methods:

- `add(ev): boolean` returns false if the key is already pending or committed; otherwise stores it, indexes it by hash, notifies the `onAdded` listeners and returns true. The node's listener broadcasts an inventory announcement (`src/node/node.ts`).
- `onAdded(fn)`, `getByHash(hash)`, `hasHash(hash)`, `has(ev)`: lookups the gossip code needs.
- `list(max = 100)`: pending evidence in insertion order, capped. `createBlock` calls it with `MAX_EVIDENCE_PER_BLOCK`, 16.
- `markCommitted(evs)`: the executor calls this after applying a block, moving keys from pending to committed so the same infraction is never included twice.
- `pruneIf(stale)`: drops pending evidence for which the predicate is true. `createBlock` uses it with `evidenceAgeOk` so a proposer never includes evidence that validators would reject as too old, and the pool does not keep it forever.
- `size`: pending count. Tests read it.

Invariant: an infraction key is in at most one of `pending` and `committed`. Note that `byHash` is never pruned, and `committed` only grows; both are bounded in practice by how rarely validators double sign.

**`verifyDuplicateVoteEvidence(chainId, ev, valset, verifier)`** is the full check: `checkDuplicateVoteShape` from `src/types/evidence.ts` (same height, round, type and validator; different hashes; canonical order with the lower hash first, nil lowest), then the validator at `voteA.validatorIndex` must exist in `valset` (the set of the infraction height, not the current one), then both signatures are verified in one batch with the vote context. Returns an error string or null. Callers: `verifyBlockSignatures` below, and `Node.acceptEvidence` for gossiped evidence.

The node builds evidence in two ways: locally in `Consensus.addVote` when `VoteSet.add` reports a conflict, and from peers by inventory. `test/recovery.test.ts` exercises the first path and `test/sync.test.ts` the second.

### src/consensus/validate.ts

Block validation shared by consensus (for proposals and fetched blocks) and block sync (for downloaded blocks). Structural checks are synchronous; signature checks go through the verifier.

**`ValidationLimits`**: `maxBlockBytes` (default 4 MiB), `maxClockDriftMs` (15 s: how far a proposed block time may be from local time), `maxEvidenceAgeMs` (7 days by default; the node overrides it from `genesis.consensus.maxEvidenceAgeMs` and, with the core application, follows the staking unbonding period after every commit). **`BlockTimeLookup`** is `(height) => bigint | null`, satisfied by `BlockExecutor.blockTimeAt`.

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

**`validateBlockStructure(state, block, limits, nowMs, blockTimeAt)`** runs every check that needs no signatures, in this order, returning the first failure as a string: chain id; protocol `version` equals the state's (added by `RPC-SYNC-PROOFS.md` section 2.1); height is `lastHeight + 1`; `lastBlockHash`, `validatorsHash`, `nextValidatorsHash`, `appHash`, `dataHash` (recomputed with `txsRoot`), `lastResultsHash`, `evidenceHash` and `lastCommitHash` all match state or the block body; time is strictly after the last block time; if `nowMs` is not null, time is within `maxClockDriftMs` of it; the `proposerAddress` is in the current validator set; height 1 has no `lastCommit`, every other height has one for `lastHeight`, for `lastBlockHash`, with exactly `lastValidators.size` signature slots; every evidence item passes `evidenceAgeOk`; and the encoded block is at most `maxBlockBytes`.

Two points deserve attention. First, `appHash` and `lastResultsHash` are compared against chain state, which is the result of executing the *previous* block: this is deferred execution (next chapter), and it is why a validator can validate a proposal without running its transactions. Second, the proposer check is only membership. The round's proposer is checked separately by `handleProposal` against the proposal signature, because a re-proposed block carries the address of whoever built it first (review finding 4). Consensus passes `this.now()` as `nowMs` only for a fresh proposal (`polRound === -1`): a block re-proposed with a proof of lock keeps the time its first proposer gave it, and must still be decidable after a round that stalled past the drift limit (review finding 37). Block sync and `handleFetchedBlock` pass `null`, since a block the network has already committed cannot be judged against this node's clock.

**`verifyCommit(chainId, valset, hash, commit, verifier)`** checks that a commit finalises `hash` under `valset`: the commit's `blockHash` matches, the signature array has exactly `valset.size` slots, the power of the non-null slots reaches +2/3 (checked before any signature work, so a commit that cannot possibly pass costs nothing), and every included signature verifies as `PRECOMMIT(height, round, hash)` by the validator at that index. The sign bytes are rebuilt with `voteSignBytes`, so a prevote signature or a signature for another round cannot be passed off as a precommit. The light client and state sync import this function.

**`verifyBlockSignatures(chainId, state, block, verifier, validatorSetAtHeight)`** verifies `block.lastCommit` with `verifyCommit` against `state.lastValidators` and `state.lastBlockHash`, then every evidence item with `verifyDuplicateVoteEvidence` against the set of its own height, obtained from the executor.

### src/consensus/consensus.ts

The state machine. Its file header is a good summary and should be read first; the key sentence is that the machine "is purely event driven: a proposal arrives, a vote arrives, or a timer fires; after each event every rule is re-evaluated until none fires", and that each numbered rule in `evaluateRules` cites a line of the Tendermint paper's pseudocode (Algorithm 1 in Buchman, Kwon and Milosevic 2018).

#### Configuration and dependencies

- **`ConsensusTimeouts`** and **`DEFAULT_TIMEOUTS`**: shown above. The tests use `FAST_TIMEOUTS` from `test/helpers.ts` (400/200, 200/100, 200/100, 50, 150 ms).
- **`DEFAULT_LIMITS`**: 4 MiB blocks, 15 s drift, 7 days of evidence age.
- **`Step`** is `'propose' | 'prevote' | 'precommit' | 'commit'`; a private `STEP_ORDER` gives them numbers so rule 36 can test "step at least prevote".
- **`MAX_ROUND_AHEAD`** is 1000. The comment: "Rounds beyond this many ahead of ours are ignored; a round number is otherwise a free CPU budget for a peer." Review finding 6 found that a proposal for round 4294967295 made the node run billions of proposer-priority iterations before even checking the signature, because `proposerAt(r)` costs O(r).
- `MAX_EVIDENCE_PER_BLOCK` (16) and `EMPTY_HEADER` (a header of zero hashes, used to measure a block's fixed overhead) are private.
- **`StaleHeightError`** is thrown by the executor when a block arrives for a height that has already passed; `decide` treats it as "block sync got there first".
- **`ConsensusDeps`** is everything consensus needs from the node. Reading the fields is reading the node wiring in `src/node/node.ts`: `getState()` is the executor's chain state; `applyBlock` and `updateCommit` go to the executor; `blockTimeAt` reads stored headers for evidence age; `requestBlock` broadcasts a `blockRequest` (the hash argument is accepted but the node sends only the height); `scorePeer` feeds the p2p scoring; `getLastCommit` loads the previous block's commit, needed to build a block; `validatorSetAtHeight` for evidence verification and for votes of the next height; `reapTxs(maxBytes)` is `mempool.reap`; `privValidator` is null on a full node; `verifier`; `evidencePool`; `broadcastProposal` and `broadcastVote` with an `exceptPeer` so a message is not echoed to its sender; optional `timeouts`, `limits` and `now` (injectable clock); `log`.
- `RoundProposal` (private) is what the machine stores per round: the `proposal`, whether the block was `valid`, its `hash`, and `fetched` for a block obtained through `handleFetchedBlock` rather than from the proposer.

#### State

The public fields are the paper's variables: `height`, `round`, `step`, `lockedBlock`/`lockedRound`, `validBlock`/`validRound`. Private state: the height's `validators` and `hvs` (`HeightVoteSet`); `proposals` by round; `proposerCache` by round; three sets that implement the paper's "for the first time" clauses (`prevoteTimeoutScheduled`, `precommitTimeoutScheduled`, `polkaHandled`); `timers` by key; buffers for messages of the next height (`nextHeightVotes`, each entry a `{ vote, publicKey }` pair recording the key the vote verified under, and `nextHeightProposals`); the decision record (`decided`, `decidedRound`, `decidedHash`); `fetchRequested` (hashes already asked for); `running`; the re-entrancy pair `evaluating`/`reevaluate`; `decisionCount`.

`limits` is a getter that merges `DEFAULT_LIMITS` with the `limitsRef` object the node passed, on every read. The comment says why: "the node adjusts the evidence age when the unbonding period changes". `Node.init` mutates that same object after each commit (`limits.maxEvidenceAgeMs = this.app.stakingParameters().unbondingPeriodMs`), and consensus sees the change without a setter.

Two getters: `isValidator` (a key is present and its address is in the current set) and `isDeciding` (`decided`; block sync polls it to avoid applying a block while consensus is in the middle of applying one).

#### Lifecycle: `start`, `stop`, `restart`

`start()` sets `running` and calls `startHeight()`. `stop()` clears `running` and every timer; every handler and timer callback checks `running` first, so a stopped machine ignores late events. `restart()` is called by block sync after it applied blocks behind consensus's back: if the chain state is already at the height consensus is on, nothing happens; otherwise `startHeight()` moves to the new height.

#### `startHeight`

```ts
  private startHeight(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const st = this.d.getState();
    this.height = st.lastHeight + 1n;
    this.validators = st.validators;
    this.hvs = new HeightVoteSet(this.height, this.validators);
    this.proposals.clear();
    this.proposerCache.clear();
    this.prevoteTimeoutScheduled.clear();
    this.precommitTimeoutScheduled.clear();
    this.polkaHandled.clear();
    this.lockedBlock = null;
    this.lockedRound = -1;
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
    const proposals = this.nextHeightProposals.filter((p) => p.height === this.height);
    this.nextHeightVotes = [];
    this.nextHeightProposals = [];

    this.startRound(resumeRound);
    for (const v of votes) this.addVote(v, null);
    for (const p of proposals) void this.handleProposal(p, null);
  }
```

Everything per-height is reset; the validator set is the one chain state says signs `lastHeight + 1`. The resume logic is review finding 5: a validator that had signed, say, a proposal at this height before crashing would, on restarting at round 0, build a block with a new timestamp and be refused by its own guard with no timeout armed. Resuming at `last.round + 1` sidesteps the round the guard owns. The regression test in `test/review.test.ts` plants a guard record for height `h+1`, round 0, and checks that the chain continues and that block `h+1` was committed in round 1 or later. Votes and proposals that arrived early for this height are then replayed. The votes were verified when buffered, against the set `validatorSetAtHeight` returned for their own height, and each buffer entry keeps the public key the signature verified under; replay accepts a vote only if that same key still holds the vote's index in the set this height actually uses. A vote verified against one set is thus never credited to whichever validator sits at that index in another.

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
    void this.handleProposal(proposal, null);
  }
```

Paper lines 14 to 21: if `validValue` is set, propose it with `validRound`; otherwise get a new value and propose with `-1`. The proposal is broadcast and also fed to the proposer's own `handleProposal`, so the proposer treats its block exactly as everyone else does, including verifying its own signature. When no block can be built (no stored last commit yet), the proposer arms the same round-scaled propose timeout `startRound` would have, so the round still ends in a nil prevote instead of hanging.

`createBlock()` builds a fresh block from chain state. Height 1 has no `lastCommit`; any other height loads it through `getLastCommit`, which returns the *stored* commit, the one `updateCommit` may have filled with late precommits (`STAKING.md` section 2.1: "The proposer of height N+1 builds lastCommit from that fuller stored commit, so every node applies the same signer list, because it is in the block"). Block time is the local clock, pushed to `lastBlockTime + 1` if the clock has not advanced. Evidence is pruned by age, then at most 16 items are taken. Then the size budget:

```ts
    // Everything but the transactions is fixed now; measure it and give the transactions what is left.
    let shell: Block = { header: { ...EMPTY_HEADER, chainId: this.d.chainId }, txs: [], lastCommit, evidence };
    // Evidence is picked by count; by bytes it may not fit a small limit. Leave some for the next block.
    while (evidence.length > 0 && blockBytes(shell).length + 1024 > this.limits.maxBlockBytes) {
      evidence = evidence.slice(0, -1);
      shell = { ...shell, evidence };
    }
    const budget = this.limits.maxBlockBytes - blockBytes(shell).length - 1024;
    const txs = budget > 0 ? this.d.reapTxs(budget) : [];
```

Review finding 15: a fixed 64 KiB reservation did not account for a large commit or many evidence items, so a full mempool plus a hundred evidence records produced blocks that every validator rejected as too large, forever. Measuring the block without transactions and giving the remainder (less 1 KiB of slack) to the mempool makes the limit exact. Evidence is picked by count, not by bytes, and each record carries two signed votes, about 5 KiB; with a small `maxBlockBytes` sixteen of them could exceed the limit before a single transaction is added, and `budget > 0` would then only make the block empty, not small enough. The `while` loop drops the last record until the shell plus the slack fits. The dropped records stay in the pool and go into a later block; nothing is lost, only deferred. The header then takes `appHash`, `lastResultsHash`, `validatorsHash` and `nextValidatorsHash` from chain state, `dataHash` from `txsRoot(txs)`, `evidenceHash` from the evidence list, and `proposerAddress` from the private validator. Everything a validator checks in `validateBlockStructure` is set here.

#### `handleProposal`

```ts
  async handleProposal(p: Proposal, fromPeer: string | null): Promise<void> {
    if (!this.running) return;
    if (p.height === this.height + 1n) {
      if (this.nextHeightProposals.length < 8) this.nextHeightProposals.push(p);
      return;
    }
    if (p.height !== this.height) return;
    if (this.proposals.has(p.round)) return;
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

Cheap filters first: a proposal for the next height is buffered (at most 8), other heights are dropped, one proposal per round is kept (the first to verify wins), `polRound` must be `-1` or an earlier round, the block's own height must match, and the round must be within `MAX_ROUND_AHEAD`. Then the signature is checked against the *round's* proposer, not the block's `proposerAddress`. Review finding 4 found three honest validators stuck forever because a re-proposal of a polka'd block was rejected for carrying the original builder's address.

```ts
    if (!sigOk) {
      this.log('warn', 'proposal with bad signature', { r: p.round });
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'bad proposal signature');
      return;
    }

    // The signature covers the header; a relay can pair it with another body. That is a corrupt message, not
    // the round's proposal: drop it without recording the round, so the real one can still arrive.
    if (!bodyMatchesHeader(p.block)) {
      this.log('warn', 'proposal body does not match its header', { h: p.height, r: p.round });
      if (fromPeer) this.d.scorePeer?.(fromPeer, 20, 'proposal body mismatch');
      return;
    }
```

A bad signature costs the sending peer 20 points, the same as a bad vote signature: a proposal is as expensive to verify as a vote and the signer is just as well known, so there is no reason to let a peer send them for free. Then the body. `proposalSignBytes` covers the proposal's header, and the header commits to the body only through its three roots (`dataHash`, `evidenceHash`, `lastCommitHash`); a relay could keep the signed header and pair it with other transactions, other evidence or a different commit. `bodyMatchesHeader` (in `src/consensus/validate.ts`, re-exported by state sync, which needs the same check on a fetched block) recomputes the three roots and compares. A mismatch is a corrupt message rather than the round's proposal, so it is dropped *without* recording the round: if it were recorded as an invalid proposal, the `proposals.has(p.round)` filter above would then reject the genuine proposal when it arrived, and the whole round would be lost to one bad relay.

After the signature and the body, the block itself:

```ts
    const st = this.d.getState();
    // A block re-proposed with a proof of lock keeps the time its first proposer gave it, and a round that
    // stalled past the drift limit must still be able to decide it (CometBFT checks timeliness only for
    // polRound == -1); the clock check applies to fresh blocks alone.
    let invalid = validateBlockStructure(st, p.block, this.limits, p.polRound === -1 ? this.now() : null, this.d.blockTimeAt);
    if (!invalid) invalid = await verifyBlockSignatures(this.d.chainId, st, p.block, this.d.verifier, this.d.validatorSetAtHeight);
```

`validateBlockStructure` gets the local clock only for a fresh proposal. Review finding 37 describes the failure this prevents: every proposal used to be checked for drift, so after a round that stalled longer than `maxClockDriftMs` the polka'd block could never be re-proposed validly, the validators locked on it prevoted nil for everything else, and the height stalled for good. Then `verifyBlockSignatures` for the `lastCommit` and evidence. Both results are strings or null. Because two awaits have passed, the handler re-checks `running`, the height, and that no proposal for the round has been stored meanwhile. Then:

```ts
    const hash = blockHash(p.block);
    this.proposals.set(p.round, { proposal: p, valid: invalid === null, hash });
    if (invalid) this.log('warn', 'invalid proposal', { h: p.height, r: p.round, reason: invalid });
    else {
      this.log('debug', 'got proposal', { h: p.height, r: p.round, hash });
      this.d.broadcastProposal(p, fromPeer);
    }
    this.evaluateRules();
  }
```

An invalid proposal is still recorded (with `valid: false`), because the paper's rules say to prevote nil on an invalid proposal rather than wait for the timeout, and the record stops a second copy from being verified. Only valid proposals are forwarded to peers. Contrast the two earlier failures: a bad signature or a body that does not match the header is not the round's proposal at all, so neither is recorded, and the round stays open for the real one.

#### `handleVote` and `addVote`

`handleVote(v, fromPeer)` accepts votes for the current height (dropping exact duplicates with `hvs.has` before verification, which is what makes the gossip re-send cost bandwidth rather than CPU) and for the next height, verified against `validatorSetAtHeight(v.height)`, the stored set for the vote's own height. The obvious shortcut, `getState().nextValidators`, is wrong in a corner: block sync may have applied the current height already while consensus was still on it, and then the state's "next" set is the one *after* the vote's height, whose index positions mean other keys. Asking by the vote's height is right in both cases. The validator is looked up by index; the signature is verified with the vote context; a bad signature is logged and costs the sending peer 20 points through `scorePeer` (`RPC-SYNC-PROOFS.md` section 4.6). After the await: `running` again, `MAX_ROUND_AHEAD`, and then either `addVote` or the next-height buffer (at most 4096 entries, each the vote with the public key it verified under, which `startHeight` checks again before replaying it).

```ts
  /** Add an already-verified vote for the current height. */
  private addVote(v: Vote, fromPeer: string | null): void {
    if (v.height !== this.height) return;
    const { added, conflict } = this.hvs.add(v);
    if (conflict) {
      const ev = makeDuplicateVoteEvidence(conflict, v);
      if (this.d.evidencePool.add(ev)) {
        this.log('warn', 'double sign detected', { h: v.height, r: v.round, type: voteTypeName(v.type), validator: v.validatorIndex });
      }
      return;
    }
    if (!added) return;
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

Three outcomes. A conflict becomes evidence: `makeDuplicateVoteEvidence` puts the pair in canonical order and the pool deduplicates. A new vote is forwarded to every peer except its source and the rules run. A new vote after the decision is the "fuller commit" of `STAKING.md` section 2.1: a precommit for the decided block in the decided round is merged into the stored commit so that the slow validator is credited as a signer (block rewards and downtime tracking in the staking module are keyed on `lastCommitSigners`, so being recorded absent for a few hundred milliseconds of latency would be a penalty). `test/engine.test.ts`, "folds a precommit that arrives after the decision into the stored commit", isolates one validator, lets the other three decide, then injects the fourth's precommit and reads the stored commit back with four signatures.

#### Signing: `signAndAddVote`, `prevote`, `precommit`

```ts
  private signAndAddVote(type: VoteType, hash: Uint8Array | null): void {
    const pv = this.d.privValidator;
    if (!pv) return;
    const idx = this.validators.indexOf(pv.address);
    if (idx < 0) return;
    const unsigned = { type, height: this.height, round: this.round, blockHash: hash, validatorIndex: idx };
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
```

A full node (no key) or a node whose key is not in the current set silently does nothing: it still runs every rule and follows the decision, it just never votes. The guard's refusal is caught and logged; any other error propagates. A signed vote enters through the same `addVote` as a peer's vote, which broadcasts it (with `fromPeer` null, so to everyone) and re-runs the rules. This is the only place votes are signed; `prevote(hash)` and `precommit(hash)` are one-line wrappers.

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
        // The prevotes behind our valid block, for a peer that missed that polka: without them it cannot accept a re-proposal.
        if (this.validRound >= 0 && this.validRound !== this.round) for (const v of this.hvs.prevotes(this.validRound).all()) this.d.broadcastVote(v, null);
        // The round's proposer re-sends the round's proposal, whether it built the block or re-proposed another's.
        const prop = this.proposals.get(this.round);
        if (prop && prop.valid && !prop.fetched && bytesEqual(this.proposerAt(this.round), pv.address)) this.d.broadcastProposal(prop.proposal, null);
      }
      this.scheduleGossip();
    });
  }
```

Each tick re-sends three things, all read back from what the node holds, nothing re-signed. First, this validator's own prevote and precommit for the current round. Second, when `validRound` is set and is not the current round, *every* prevote the node holds for `validRound`: those prevotes are the polka that made the block valid, and a peer that missed them cannot accept the block's re-proposal (rule 28 below requires the receiver to hold the polka's prevotes itself), so re-sending only the current round's votes could leave such a peer prevoting nil for a block the rest of the network is about to decide. Third, the current round's proposal, if it is valid, not fetched, and this node is `proposerAt(this.round)`. The last condition is keyed on the round's proposer, not on who built the block: a re-proposal of `validBlock` carries the original builder's `proposerAddress` in its header, and the node that must repeat it is the one that signed this round's proposal, which is this round's proposer. The doc comment explains the trade: it replaces Tendermint's per-peer state tracking "with something far simpler at the cost of some bandwidth", and it is safe because receivers drop duplicates before verifying.

`handleFetchedBlock(block)` is `RPC-SYNC-PROOFS.md` section 4.5. When rule 49 sees +2/3 precommits for a hash this node holds no valid proposal for, it asks peers for the block; the node routes a `blockResponse` for the current height here. The method finds the round whose precommits have a quorum for this block's hash and whose stored proposal, if any, is not already a valid proposal for that hash: a round may hold a valid proposal for *another* block while +2/3 precommitted this one (a late proposal, or a relay's), and the fetched block then replaces it. It validates the block as `handleProposal` does for a re-proposal, without the clock-drift check, re-checks its preconditions after the await (including that no valid proposal for this hash appeared meanwhile), and stores it as a proposal with `polRound: -1`, a zero signature and `fetched: true`. The next `evaluateRules` decides it through rule 49. Fetched proposals are never re-broadcast (`messagesForPeer` and the gossip timer both exclude them), because the zero signature would fail at the peer. `test/sync.test.ts`, "gossips evidence from a node that cannot propose, and decides a height from a fetched block", filters every proposal message to validator 3 and checks that it still decides four more heights with `blockSync.synced` staying at zero.

`messagesForPeer()` returns every valid, non-fetched proposal and every vote held for the current height; `Node.init` sends them to each newly connected peer.

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
      const unlockedOrSame = this.lockedRound === -1 || (this.lockedBlock !== null && bytesEqual(blockHash(this.lockedBlock), prop.hash));
      this.prevote(prop.valid && unlockedOrSame ? prop.hash : null);
      return true;
    }
```

The paper: on a proposal with `vr = -1` while in `propose`, prevote `id(v)` if `valid(v)` and (`lockedRound = -1` or `lockedValue = v`), else nil; then step `prevote`. An invalid block, or a block different from the one we are locked on, gets a nil prevote.

**Line 28, re-proposal with a proof of lock.**

```ts
    if (this.step === 'propose' && prop && prop.proposal.polRound >= 0 && prop.proposal.polRound < r) {
      const vr = prop.proposal.polRound;
      if (this.hvs.prevotes(vr).hasQuorumFor(prop.hash)) {
        this.step = 'prevote';
        const canUnlock = this.lockedRound <= vr || (this.lockedBlock !== null && bytesEqual(blockHash(this.lockedBlock), prop.hash));
        this.prevote(prop.valid && canUnlock ? prop.hash : null);
        return true;
      }
    }
```

The paper: on a proposal with `vr >= 0` and +2/3 prevotes for `id(v)` in round `vr`, while in `propose` and `vr < round`, prevote `id(v)` if `valid(v)` and (`lockedRound <= vr` or `lockedValue = v`), else nil. The node must itself hold the polka's prevotes for round `vr` in `hvs`; if they have not arrived the rule waits, and the propose timeout may fire first. This is why `messagesForPeer` hands a newly connected peer the votes of every round of the height, and why the gossip timer re-sends the prevotes of `validRound` alongside the current round's votes.

**Line 34, prevote timeout.** In `prevote`, when `prevotes.hasQuorumAny()` and the timeout has not been armed for this round: arm it. The `prevoteTimeoutScheduled` set is the paper's "for the first time".

**Line 36, polka for the proposal.**

```ts
    if (prop && prop.valid && STEP_ORDER[this.step] >= STEP_ORDER.prevote && prevotes.hasQuorumFor(prop.hash) && !this.polkaHandled.has(r)) {
      this.polkaHandled.add(r);
      if (this.step === 'prevote') {
        this.lockedBlock = prop.proposal.block;
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

The paper: on the proposal for round `r'` and +2/3 precommits for `id(v)` in `r'`, while undecided, if `valid(v)` decide `v`. Any round counts, not only the current one, which is why `roundNumbers()` is iterated: a node in round 3 may learn that round 1 decided. A quorum for a hash the node has no valid proposal for, or for which the round's stored proposal is a *different* block, triggers a single `requestBlock` per hash (the `fetchRequested` set), handled by `handleFetchedBlock` above. The second case matters because one proposal is kept per round: if the first proposal to verify for a round was not the one the network precommitted, the node would otherwise hold a valid proposal, never fetch, and never decide. `quorumValue()` returns null for a nil quorum, and `q &&` skips that case.

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

Signing happens in three places: `propose` (step 1), `prevote` and `precommit` through `signAndAddVote` (steps 2 and 3). Within one round the machine naturally advances propose → prevote → precommit, so the guard's step ordering is never violated in normal operation. A new round is a higher `round`; a new height is a higher `height`. The cases where the guard refuses are therefore all abnormal: a restart (handled by `resumeRound`), a bug, or a second process using the same key and the same state file, which is the scenario validators fear most and the reason the file is written before the signature leaves the function. Rule 55 jumping to a later round, and `startRound(r + 1)` after a precommit timeout, both only increase the round; nothing in the machine ever decreases it within a height.

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

`test/engine.test.ts`:

- "folds a precommit that arrives after the decision into the stored commit": the fuller-commit path in `addVote` and `updateCommit`, with `commitMs: 1500` so the straggler arrives inside the commit timeout.
- "drops evidence older than the configured age by block time, and keeps young evidence": with `maxEvidenceAgeMs: 3000`, evidence for height 2 is added once height 2 has aged past the limit; within eight heights the proposer's `pruneIf` has discarded it and no application was told; evidence for a recent height is included and reaches every application.
- "rejects a block from another protocol version": `validateBlockStructure` returns the version error.
- "refuses a genesis with no validators from either side": `genesisState` throws (chapter 3, cited by `STAKING.md` section 2.3).

`test/review.test.ts`, "resumes after a restart that left a signature at the current height, by skipping that round": review finding 5, described under `startHeight`. "decides a block re-proposed with a proof of lock after its round stalled past the clock drift limit": review finding 37; four validators with `maxClockDriftMs: 300`, and at two consecutive heights a message filter drops the round-0 proposal on its way to validator 3 and validator 2's round-0 precommit, so round 0 has a polka but no decision; round 1 re-proposes the block with `polRound: 0`, by then older than the drift limit, and the chain must still reach four more heights. The same file's "rejects decoded validator sets with duplicate members, wrong order or a bad proposer index" protects `proposerAt` and the quorum arithmetic from a crafted set (finding 1), and "does a bounded amount of work on a peer status it cannot act on" is the block sync recursion of finding 30, which surfaced as a stack overflow during consensus tests.

`test/units.test.ts`: "private validator refuses to sign backwards or conflicting content, allows identical re-signs" (the guard, case by case) and "validator set picks proposers in proportion to voting power" (600 rounds of `incrementProposerPriority` give 100/200/300 proposals to powers 1/2/3).

`test/sync.test.ts`, "gossips evidence from a node that cannot propose, and decides a height from a fetched block": evidence added on a full node reaches every validator's application through inventory gossip, and a validator that never receives a proposal keeps deciding through `handleFetchedBlock`.

## Limitations and ideas

Known simplifications, from `DESIGN.md` section 10 and from reading the code:

- Only duplicate votes are evidence. Amnesia (prevoting a block in a later round after precommitting a different one without a proof of lock) is not detected, and `DESIGN.md` section 10 records that a validator restarted in the middle of a height forgets its lock, because the sign state keeps what was signed, not the locked block.
- A proposer that sends different proposals for the same round to different peers is not reported; each node keeps the first that verifies.
- A proposal carries the whole block in one message; Tendermint splits large blocks into gossiped parts.
- Vote verification is not rate limited per peer; a peer can make a node verify up to `MAX_ROUND_AHEAD` rounds of votes per validator.
- Proposer priorities are not covered by the validator set hash; see the state sync discussion in `DESIGN.md` section 10.

Exercises:

1. Persist `lockedRound` and the locked block hash in `LastSigned`, restore them in `startHeight`, and write a test that restarts a validator between a precommit and the decision and checks that it prevotes only its locked block in later rounds.
2. Drive `Consensus` directly in a unit test with an injected `now`, a scripted `ConsensusDeps` and forged votes, and make rule 28 fire: a polka in round 0, a timeout, and a re-proposal with `polRound: 0` that a validator locked in round 0 accepts.
3. Add proposal equivocation evidence: two proposals signed by the same proposer for the same height and round with different block hashes. Define the type in `src/types/evidence.ts`, detect it in `handleProposal`, and decide how the application should slash it.
4. Rate limit vote verification per peer: count verifications per peer per second in `handleVote` and call `scorePeer` past a threshold. Measure the effect with a peer that floods votes for 1000 future rounds.
5. Drive `Consensus` with an injected `now` that runs ahead of the proposer's clock by more than `maxClockDriftMs`, and show that the same block is refused as a fresh proposal and accepted when re-proposed with a proof of lock; then decide whether a re-proposal should still be bounded by some larger window, and what it would be.
6. Replace the fixed `commitMs` pause with one that ends early once every validator's precommit has arrived, and measure the block rate on the four-validator benchmark.

## Where to next

[Chapter 5, mempool and executor](05-mempool-executor.md): where the transactions in a block come from, and what happens to a block after `decide` hands it to `applyBlock`.
