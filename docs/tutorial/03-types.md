# 3. The chain types

This part defines the nouns of the protocol: a validator set and how it picks proposers (`src/types/validator.ts`), a vote (`src/types/vote.ts`), a block with its header and commit (`src/types/block.ts`), double-sign evidence (`src/types/evidence.ts`), a proposal (`src/types/proposal.ts`), the chain state kept between blocks (`src/types/state.ts`), the genesis document (`src/types/genesis.ts`) and transaction inclusion proofs (`src/types/txproof.ts`), plus the small logger in `src/util/log.ts` that every later module takes as a dependency. Each type comes with its binary encoding, its hash where it has one, and the invariants its decoder enforces. The types are built from [the codec](01-codec.md) and [the crypto primitives](02-crypto.md), and borrow the dense Merkle tree from [the database](09-database.md) for transaction proofs. They are consumed by everything above: [consensus](04-consensus.md) votes on them, [the executor](05-mempool-executor.md) advances the chain state, [the store](10-store.md) persists them, [the RPC](12-rpc.md) serves them, and [the light client](13-light-client.md) verifies them.

## Concepts

### Validators, voting power and quorums

A proof-of-stake chain is run by a known set of *validators*, each identified by a public key and carrying a *voting power*, an integer weight. In this chain the power ultimately comes from bonded stake (the staking module in [chapter 11](11-application.md) decides it), but the engine only sees the number. The *validator set* at a height is the list that is allowed to vote on that height's block.

Tendermint tolerates less than one third of the voting power being faulty. The two thresholds that follow from that are expressed in `ValidatorSet`: a *quorum* is strictly more than two thirds of the total power, and the smaller threshold of strictly more than one third is the amount that is guaranteed to include at least one honest validator. The engine needs a quorum of prevotes to lock on a block and a quorum of precommits to commit it; it uses the one-third threshold to notice that the network has moved on to a later round (`src/consensus/consensus.ts`, "Line 55: f+1 validators are in a later round"). `DESIGN.md` section 1 states the consequences: "more than two thirds of the bonded voting power in prevotes for one block is a polka, and more than two thirds in precommits decides it", and "a quorum is strictly more than two thirds, so the chain halts once a third or more of the voting power is offline or partitioned."

### Proposer selection: Tendermint's priority round-robin

At every height and round exactly one validator is the *proposer*, the one allowed to propose a block. Every node must agree who it is without talking to each other, and over time each validator should propose in proportion to its power. Tendermint's answer is the proposer priority algorithm, which the header comment of `src/types/validator.ts` describes:

```ts
 * Proposer selection is Tendermint's "proposer priority" algorithm, a
 * deterministic weighted round-robin. Every validator carries an integer
 * priority. To pick a proposer: add each validator's voting power to its
 * priority, choose the highest, then subtract the total power from the
 * winner. Over time each validator is chosen in proportion to its power, and
 * the order is fully determined by the set itself, so every node agrees
 * without any communication.
```

A worked example with two validators, A with power 1 and B with power 2 (total 3), both starting at priority 0:

| step | add power | highest | subtract total | priorities after |
|---|---|---|---|---|
| 1 | A 1, B 2 | B | B − 3 | A 1, B −1 |
| 2 | A 2, B 1 | A | A − 3 | A −1, B 1 |
| 3 | A 0, B 3 | B | B − 3 | A 0, B 0 |

After three steps the priorities are back at zero and the sequence B, A, B repeats: B proposes two blocks in three, A one, which is the 2:1 ratio of their powers. The unit test does the same with powers 1, 2 and 3 over 600 steps and gets exactly 100, 200 and 300.

Two refinements come from Tendermint (CometBFT's `validator_set.go`). Priorities are *rescaled* before a set is advanced, so that the spread between the highest and lowest is then no more than twice the total power (the increments that follow may widen it again until the next rescale), and *centered* by subtracting their average, rounded toward zero, so that it stays near zero; both keep the integers bounded. A newly added validator starts at a negative priority of about −1.125 times the total power so it cannot propose immediately ahead of validators that have been waiting. The rescale step is not path-independent: advancing a set by one step twice is not the same as advancing it by two steps once. `DESIGN.md` section 1 draws the rule from that: "The proposer for round r is always derived from the height's base set with one increment-by-r call, never incrementally across rounds, because the rescale step is not path independent and nodes that skipped rounds would otherwise disagree."

### Validator set changes take effect two heights later

The application may return validator updates when it executes a block. Following Tendermint, updates returned at height H take effect at H+2 (`DESIGN.md` section 1). The reason is in the header: block H+1 names both the set that signs it (`validatorsHash`) and the set that will sign H+2 (`nextValidatorsHash`). A light client that trusts header H+1 therefore knows in advance which keys to expect on H+2, and the set that commits any block is always the set its own header named. The chain state keeps three sets, last, current and next, to make this bookkeeping explicit.

### Votes, rounds and nil

Tendermint reaches a decision at each height in one or more *rounds*. Each round has a proposer and two voting steps, *prevote* and *precommit*. A vote names a block hash, or *nil* to say "no block this round". A validator that sees a quorum of prevotes for a block becomes *locked* on it; a quorum of precommits for a block decides it. `DESIGN.md` section 1 compresses the paper into two lines: "Locking on a polka gives safety. Round timeouts give liveness under weak synchrony." (A *polka* is Tendermint's word for a quorum of prevotes.)

A vote here carries no timestamp, because block time is set by the proposer rather than derived from votes as CometBFT's BFT time does, and it names its validator by *index* into the set of that height, not by address, which saves 28 bytes per vote and lets vote sets be plain arrays.

### Sign bytes versus wire bytes

Every signed object has two encodings. The *sign bytes* are what the signature covers: the fields that must be fixed by the signer, prefixed with the chain id. The *wire encoding* is what travels and is stored: the same fields plus the signature and any routing information (the validator index). Keeping them separate means the signature can be checked by rebuilding the sign bytes from the decoded object. Tendermint does the same with its `CanonicalVote` and `CanonicalProposal`.

### Blocks, headers, commits and deferred execution

A block is a header, a list of opaque transactions, the *commit* for the previous block (the precommit signatures that finalized it) and a list of evidence. The *block hash* is the hash of the header alone; the header carries a hash of each other part, so it commits to all of them. This is the Tendermint block structure field for field, minus the consensus-parameters hash and minus block parts.

*Deferred execution* means the header of block N does not describe the state after executing block N. It cannot: the block is proposed and voted on before anyone has run its transactions. Instead, `appHash` and `lastResultsHash` in header N describe the state and the transaction results after executing block N−1 (`DESIGN.md` section 2: "Header of block N carries the app hash from executing block N-1"). Cosmos SDK chains and CometBFT work the same way. The practical consequence, repeated throughout the proof code, is that a fact about height N is checked against header N+1.

### Merkle roots over transactions and results

A *Merkle root* is a single hash computed from a list of values by hashing pairs up a binary tree. Its property is that a value's membership can be proved with only the sibling hashes along its path, logarithmically many, rather than the whole list. Header field `dataHash` is the root over the block's transactions; `lastResultsHash` is the root over the previous block's results. What that buys is in `RPC-SYNC-PROOFS.md` section 2: a client holding a verified header can be shown that a transaction was included at a position, and that it succeeded or failed with a given error, without downloading the block. The trees reuse the dense Merkle tree from `src/db/merkle.ts` and its ICS23 leaf shape (ICS23 is the Cosmos IBC proof specification; the hashing conventions are those of the tm2 B+ tree, from the Gno project), so "a proof is a path of siblings and the ICS23 leaf shape" (`src/types/txproof.ts`).

### Evidence

Four faults are punished on evidence. The first is a validator signing two different votes of the same type at the same height and round. Tendermint calls this `DuplicateVoteEvidence`, and it has the pleasant property of being self-contained: the two signed votes are the whole proof. The second is amnesia, voting against a lock: a precommit for one block and, in a later round, a prevote for another that no polka since the precommit justifies. CometBFT dropped its amnesia evidence because two such votes prove nothing by themselves (the polka may exist); here the prevote signs the round of the polka it relies on, so a prevote that names too old a round is a confession, and the pair is as self-contained as a duplicate vote ([chapter 4](04-consensus.md) has the whole argument). The third is a proposer signing two proposals for one round, which is to proposals what the first is to votes. The fourth is the lie the second leaves open: a prevote that names a round in which its block had no polka. Nobody can show that votes do not exist, but the prevotes of that round by +2/3 of the power for something else leave no room for them, and those are the proof. The core application also slashes and jails a validator for downtime ([chapter 11](11-application.md)); that needs no evidence type, because the application counts missed signatures itself from each block's `lastCommitSigners`.

### Proposals

A proposal is the proposer's signed claim "this is the block for height H, round R". Tendermint sends the block separately as gossiped parts; this chain puts the whole block inside the proposal message (`DESIGN.md` section 2: "sends the whole block in one proposal message. Block parts only if blocks grow large"). The `polRound` field is Tendermint's `POLRound`: the round in which the proposer saw a quorum of prevotes for this block, which lets validators locked on an older block unlock safely.

### Chain state and genesis

The *chain state* is what the engine needs to remember between blocks: the last height and hash, the deferred app hash and results root, the three validator sets, and the signature scheme every validator key must use. It is the counterpart of Tendermint's `State` struct and is stored by the block store on every commit. *Genesis* is the hand-written document that starts a chain: chain id, signature scheme, start time, initial validators, engine parameters and the application's own initial state. Like Tendermint's `genesis.json` it is JSON; unlike every other type here it is never hashed, so JSON's non-canonical form does not matter.

## The code, file by file

### src/types/validator.ts

**`interface Validator`**: `address`, `publicKey`, `power: bigint`, `priority: bigint`. **`interface ValidatorUpdate`**: `publicKey` and `power`, where "Power 0 removes the validator." This is the shape the application returns from `finalizeBlock`.

The private constant `PRIORITY_WINDOW = 2n` is Tendermint's `PriorityWindowSizeFactor`, and the private comparator `byPowerThenAddress` defines the canonical order of a set: power descending, then address ascending by `compareBytes`.

**`class ValidatorSet`** holds `validators` (sorted; "Index = position here"), `totalPower`, and a private `proposerIndex`. The constructor is private; sets are made by `create`, `applyUpdates`, `copy` and `decode`. It refuses more than `MAX_VALIDATORS`, 2,000, members (`N validators exceed the limit 2000`). A commit carries one signature for each validator, and a block travels with two commits, the one inside it and its own (in a block-sync response): with 2,000 ML-DSA-44 signatures in each, about 9.2 MiB for the two, and the 16 MiB of transactions and evidence the largest genesis setting allows, a block still fits the 32 MiB network frame ([chapter 6](06-p2p.md)). The core application allows itself half as many (`maxValidators`, at most 1,000). The constructor then sums the powers and throws if the sum exceeds `MAX_TOTAL_POWER`, 2^60: priorities swing by a few multiples of the total and are stored as `i64`, so a larger total could overflow them, and the bound is the same one Tendermint applies. Because every way of building a set passes through the constructor, an application update that would make the set larger than 2,000 or push the total past the limit throws instead of making a block no frame can carry or corrupting proposer selection.

**`static create(entries)`** builds the genesis set. It checks each public key with `isPublicKey` from [chapter 2](02-crypto.md) (a known scheme tag followed by exactly that scheme's key, which for secp256k1 must also be a point on the curve) and each power positive, derives addresses, rejects duplicates through the private `assertUnique` (keyed by hex address), sorts, and then performs one increment so the set has a proposer:

```ts
  static create(entries: { publicKey: Uint8Array; power: bigint }[]): ValidatorSet {
    const vals: Validator[] = entries.map((e) => {
      if (!isPublicKey(e.publicKey)) throw new Error('bad public key');
      if (e.power <= 0n) throw new Error('validator power must be positive');
      return { address: addressOf(e.publicKey), publicKey: e.publicKey, power: e.power, priority: 0n };
    });
    ValidatorSet.assertUnique(vals);
    vals.sort(byPowerThenAddress);
    const set = new ValidatorSet(vals, -1);
    if (vals.length > 0) set.incrementProposerPriority(1);
    return set;
  }
```

An empty set is allowed here (nothing is incremented), but `genesisState` refuses one, and `applyUpdates` refuses a list of updates that would leave none. With no updates at all it returns a copy of the set as it is, an empty one included.

**`size`**, **`byIndex(i)`**, **`indexOf(address)`** and **`byAddress(address)`** are the lookups; the last two are linear scans with `bytesEqual`, fine for sets of tens of validators. **`proposer()`** returns the validator at `proposerIndex` or throws `'validator set has no proposer'`, which happens on a set fresh from `applyUpdates` before its first increment.

**`isQuorum(power)`** and **`isOneThird(power)`** are the two thresholds, written as cross-multiplications so there is no division and no rounding:

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

**`copy()`** copies each validator record (priorities are mutated in place by the increment, so a copy is needed before computing a hypothetical proposer) and keeps the proposer index. The copy is one level deep: the records are new, so a priority changed in one set is not changed in the other, while the `address` and `publicKey` byte arrays, which nothing mutates, are shared.

**`hash()`** is the value the header's `validatorsHash` and `nextValidatorsHash` carry:

```ts
  /** Hash commits to public keys and powers, not priorities: every height with these members names the same set. prioritiesHash() covers the rest. */
  hash(): Uint8Array {
    return sha256(
      encode((w) =>
        w.array(this.validators, (w, v) => {
          w.fixed(v.publicKey);
          w.u64(v.power);
        }),
      ),
    );
  }
```

Because the order is canonical, two sets with the same members and powers hash alike whatever their priorities. The unit test checks that advancing a set three rounds does not change its hash. That is deliberate: the hash names the members, so one stored record by hash serves every height those members sign, and a light client, which only counts signatures, never needs more.

**`prioritiesHash()`** covers what `hash()` leaves out:

```ts
  /**
   * Hash of what hash() leaves out: every validator's priority, in the set's order, and which of them proposes.
   * Priorities come out of the whole history of the set, so a node that did not run that history (one joining
   * from a snapshot) can only be handed them, and checks them against this.
   */
  prioritiesHash(): Uint8Array {
    return sha256(
      encode((w) => {
        w.array(this.validators, (w, v) => w.i64(v.priority));
        w.i64(BigInt(this.proposerIndex));
      }),
    );
  }
```

The priorities are written in the set's order, which `hash()` has already fixed, and the proposer's index after them. Priorities cannot be recomputed from the members: they come out of every increment, rescale and update since genesis, so a node that did not run that history, one joining from a snapshot ([chapter 7](07-sync.md)), has to be handed them. At first nothing a validator signed said what they were. Review finding 8 made that an attack on state sync: a peer supplies genuine keys and powers with altered priorities, and the joiner then expects other proposers than the rest of the chain. The first answer was to check that the sets it was given pick the proposers the chain actually used at two heights, which a careful liar passes. Now the header commits to them, with the function at the end of the file, **`prioritiesHash(validators, nextValidators)`**:

```ts
/**
 * What a header says of proposer priorities: one hash over those of the set that signs its height and those of
 * the set for the next. With the two set hashes beside it, a header then names both sets exactly.
 */
export function prioritiesHash(validators: ValidatorSet, nextValidators: ValidatorSet): Uint8Array {
  return sha256(encode((w) => w.fixed(validators.prioritiesHash()).fixed(nextValidators.prioritiesHash())));
}
```

It is one hash for two sets, beside `validatorsHash` and `nextValidatorsHash`: with those two, a header names the set of its height and the set of the next exactly, priorities and proposer included. The order matters, the two inner hashes being written one after the other. The cost is 32 bytes a header, and two hashes over 8 bytes a validator each time a header is built or checked.

**`incrementProposerPriority(times)`** is Tendermint's `IncrementProposerPriority`. It mutates the set and returns the new proposer:

```ts
  incrementProposerPriority(times: number): Validator {
    if (this.validators.length === 0) throw new Error('empty validator set');
    if (times <= 0) throw new Error('times must be positive');
    this.rescalePriorities(PRIORITY_WINDOW * this.totalPower);
    this.shiftByAveragePriority();
    let proposer: Validator | undefined;
    for (let i = 0; i < times; i++) proposer = this.incrementOnce();
    this.proposerIndex = this.validators.indexOf(proposer!);
    return proposer!;
  }
```

Rescale and shift happen once, then the increment runs `times` times. That ordering is exactly why the doc comment insists "Call once with the number of rounds to advance; never call repeatedly with 1 to get the same effect." Consensus follows the rule in `proposerAt(r)` (`src/consensus/consensus.ts`): for round 0 it takes `this.validators.proposer()`, for round r it copies the set and calls `copy.incrementProposerPriority(r)`. Review finding 6 noted the cost is linear in `r` and that a peer could send `round = 4294967295`; the fix caps how far ahead a message may be before it is ignored.

The private **`incrementOnce`** is the three-line algorithm, with ties broken by lowest address:

```ts
  private incrementOnce(): Validator {
    for (const v of this.validators) v.priority += v.power;
    let best = this.validators[0]!;
    for (const v of this.validators) {
      if (v.priority > best.priority || (v.priority === best.priority && compareBytes(v.address, best.address) < 0)) best = v;
    }
    best.priority -= this.totalPower;
    return best;
  }
```

The private **`rescalePriorities(diffMax)`** finds the spread between the highest and lowest priority and, if it exceeds `diffMax`, divides every priority by `ceil(diff / diffMax)`. BigInt division truncates toward zero, as Go's integer division does in CometBFT. The private **`shiftByAveragePriority`** subtracts the (truncated) average from every priority.

**`applyUpdates(updates)`** returns a new set, leaving this one untouched. It copies the validators into a map by address, then walks the updates: a key that `isPublicKey` rejects or a negative power throws, a duplicate address within the updates throws, power 0 removes (and `'cannot remove unknown validator'` if absent), an existing validator gets its power replaced, and a new one is queued as an addition. Additions then receive the Tendermint starting priority:

```ts
    for (const a of additions) {
      a.priority = -(totalAfterUpdates + totalAfterUpdates / 8n);
      byAddr.set(toHex(a.address), a);
    }
    for (const k of removals) byAddr.delete(k);

    const vals = [...byAddr.values()];
    if (vals.length === 0) throw new Error('updates would empty the validator set');
    vals.sort(byPowerThenAddress);
    const next = new ValidatorSet(vals, -1);
    next.rescalePriorities(PRIORITY_WINDOW * next.totalPower);
    next.shiftByAveragePriority();
    // Proposer is meaningless until the next increment picks one.
    next.proposerIndex = -1;
    return next;
```

`totalAfterUpdates` starts at the old total and grows by every power change and addition, but a removal only queues the address; the removed power is still in the sum when the newcomers' priorities are set, and the map entries are deleted afterwards. So `total + total / 8` is 1.125 times the total power after the updates and *before* the removals, as in CometBFT, whose `verifyUpdates` names the same quantity `tvpAfterUpdatesBeforeRemovals`. When validators leave in the same update the newcomer therefore starts a little further behind than 1.125 times the final total, which is harmless: the aim is only that it cannot propose ahead of validators that have been waiting. The returned set has no proposer; `nextState` calls `incrementProposerPriority(1)` on it immediately. With an empty update list the method is just `copy()`.

**`encode(w)`** writes every validator as `fixed(publicKey)` (the scheme tag is the first of those bytes), `u64(power)`, `i64(priority)`, then `i64(proposerIndex)`. Unlike `hash()`, the stored form includes priorities and the proposer, because the store and state sync must reproduce the exact proposer sequence (`DESIGN.md` section 9: "Validator sets are also stored by the height they sign, priorities included, because a state-synced node must continue consensus with the exact proposer priorities").

**`static decode(r)`** is where review finding 1 was fixed. The original decoder accepted whatever a peer sent; a validator could supply a fabricated set containing its own key twice and have its trusted power counted twice by the light client. The decoder now re-checks everything `create` checks, plus the order and the proposer index, and reads each key through `decodePublicKey`, so a set of either scheme decodes and a stray tag is a `CodecError`:

```ts
  static decode(r: Reader): ValidatorSet {
    const vals = r.array((r) => {
      const publicKey = decodePublicKey(r);
      const power = r.u64();
      const priority = r.i64();
      if (!isPublicKey(publicKey)) throw new Error('bad public key');
      if (power <= 0n) throw new Error('validator power must be positive');
      return { address: addressOf(publicKey), publicKey, power, priority };
    }, MAX_VALIDATORS);
    ValidatorSet.assertUnique(vals);
    for (let i = 1; i < vals.length; i++) if (byPowerThenAddress(vals[i - 1]!, vals[i]!) >= 0) throw new Error('validator set out of order');
    const proposerIndex = r.i53();
    // An empty set has no proposer, and is written with the index create() leaves it: minus one and nothing else.
    if (vals.length === 0 ? proposerIndex !== -1 : proposerIndex < 0 || proposerIndex >= vals.length) throw new Error('validator set proposer index out of range');
    return new ValidatorSet(vals, proposerIndex);
  }
```

The order check uses `>= 0`, so an equal pair (a duplicate) would also be caught here, but `assertUnique` runs first and gives the clearer message. The proposer index must name a member; an empty set has none, and the only index it decodes with is the −1 that `create([])` leaves and `encode` writes, so an empty set has one encoding like every other. The address is recomputed from the key rather than trusted from the wire, which is why the wire format does not carry it.

**`toJSON()`** returns an array of `{ address, power, priority }` with hex and decimal strings, for logs and the RPC.

### src/types/vote.ts

**`VoteType`** is both a value and a type: `{ Prevote: 1, Precommit: 2 } as const` and the union `1 | 2` derived from it. **`voteTypeName(t)`** gives `'prevote'` or `'precommit'` for logs.

**`interface Vote`**:

```ts
export interface Vote {
  type: VoteType;
  height: bigint;
  round: number;
  /** null means a vote for "nil": no block this round. */
  blockHash: Uint8Array | null;
  /** In a prevote for a block, a round below the vote's own, or -1. Always -1 in a prevote for nil and in a precommit. */
  polRound: number;
  validatorIndex: number;
  signature: Uint8Array;
}

export type UnsignedVote = Omit<Vote, 'signature'>;
```

`polRound` is what makes a forgotten lock provable, and the comment above the interface says how: a prevote for a block names the earlier round whose +2/3 prevotes for that block its signer relies on, which is the `polRound` of the proposal it answers (`src/types/proposal.ts`, below), or -1 for a block proposed fresh; a validator prevoting the block it is locked on names the round of its lock when that is the later of the two. A validator that precommitted another block before may sign such a prevote only when the round it names is the round of that precommit or a later one ([chapter 4](04-consensus.md)), so a prevote naming an older round, or none, beside the precommit is a fault that the two votes prove by themselves.

**`voteSignBytes(chainId, v)`** is the signed encoding: chain id, type, height, round, optional block hash, and `polRound` as an i64. The validator index is *not* signed; the signature is bound to the key, so which slot the key sits in is routing information:

```ts
/** The bytes a validator signs. Chain id is also in the signing context, but repeating it here costs nothing. */
export function voteSignBytes(chainId: string, v: UnsignedVote): Uint8Array {
  return encode((w) => {
    w.string(chainId);
    w.u8(v.type);
    w.u64(v.height);
    w.u32(v.round);
    w.option(v.blockHash, (w, h) => w.fixed(h));
    w.i64(BigInt(v.polRound));
  });
}
```

The chain id appears both here and in the signing context from [chapter 2](02-crypto.md); the comment acknowledges the redundancy. `src/consensus/privval.ts` signs these bytes with the `vote` context, and `src/consensus/consensus.ts` and `src/consensus/evidence.ts` rebuild them to verify.

**`checkPolRound(v)`** and **`sameVoteContent(a, b)`** are the two rules about the field:

```ts
/** What a vote may say of a proof of lock. Returns an error string or null. */
export function checkPolRound(v: UnsignedVote): string | null {
  if (!Number.isInteger(v.polRound)) return 'polRound is not a whole number';
  if (v.type === VoteType.Precommit || v.blockHash === null) return v.polRound === -1 ? null : 'only a prevote for a block names a proof-of-lock round';
  return v.polRound >= -1 && v.polRound < v.round ? null : 'polRound must be -1 or a round before the vote\'s own';
}

/** Whether two votes say the same thing; two of one validator, height, round and type that do not are a double sign. */
export function sameVoteContent(a: UnsignedVote, b: UnsignedVote): boolean {
  return bytesEqual(a.blockHash, b.blockHash) && a.polRound === b.polRound;
}
```

Only a prevote for a block has something to name, and it can only name a round before its own; every other vote carries -1, so that there is one encoding of each. Because the round is signed, two prevotes of one validator in one round for the same block that name different rounds are two different statements in one place: `sameVoteContent` is what the vote set and the evidence check use to tell a repeat from a double sign, and it compares the round with the hash.

**`encodeVote(w, v)`** writes type, height, round, optional hash, `i64(polRound)`, `u32(validatorIndex)` and the signature with `fixed`, tag included. **`decodeVote(r)`** reads the same, taking the signature through `decodeSignature` so that its length comes from the tag, rejects a type other than 1 or 2 with `bad vote type N`, where `N` is the byte it read, and throws what `checkPolRound` reports, so a vote that names a round it may not is malformed like any other and never reaches consensus; it does not bound `round` or `validatorIndex`, leaving that to consensus (which ignores votes more than 1000 rounds ahead and checks the index against the set in its vote set).

**`blockHashKey(h)`** turns a nullable hash into a `Map` key, `'nil'` or hex. The vote set in `src/consensus/votes.ts` tallies power per block with it.

### src/types/block.ts

**`interface Header`** has fourteen fields, in encoding order: `chainId`, `version`, `height`, `time` (unix milliseconds set by the proposer), `lastBlockHash`, `lastCommitHash`, `dataHash`, `lastResultsHash`, `validatorsHash`, `nextValidatorsHash`, `appHash`, `evidenceHash`, `proposerAddress`, `prioritiesHash`. The source comment on the interface is the deferred-execution rule: "`appHash` and `lastResultsHash` describe the state and the transaction results after executing the *previous* block, because this block is proposed before anyone has run it."

Each field is checked by `validateBlockStructure` in `src/consensus/validate.ts` against the chain state or the block body, and reading that function is the best way to learn what each one means:

| field | checked against |
|---|---|
| `chainId` | `state.chainId` |
| `version` | `state.version` (`'protocol version N, expected M'`) |
| `height` | `state.lastHeight + 1n` |
| `lastBlockHash` | `state.lastBlockHash` |
| `validatorsHash` | `state.validators.hash()` |
| `nextValidatorsHash` | `state.nextValidators.hash()` |
| `appHash` | `state.appHash` |
| `dataHash` | `txsRoot(block.txs)` |
| `lastResultsHash` | `state.lastResultsHash` |
| `evidenceHash` | `evidenceHash(block.evidence)` |
| `lastCommitHash` | `commitHash(block.lastCommit)` |
| `time` | after `state.lastBlockTime`; for a fresh proposal also within `maxClockDriftMs` of local time (a re-proposal, a fetched block and a synced block are not held to the clock, [chapter 4](04-consensus.md)) |
| `proposerAddress` | present in `state.validators` |
| `prioritiesHash` | `prioritiesHash(state.validators, state.nextValidators)` (`'wrong prioritiesHash'`) |

`version` was added in the proofs round (`RPC-SYNC-PROOFS.md` section 2.1): "validation rejects a header whose version differs from the state's. The first version with this header is 1."

`prioritiesHash` is the hash of the proposer priorities of the two sets the header already names by their members (`src/types/validator.ts`, above). It is the last field written, 32 bytes like the other hashes.

**`interface Commit`** is the set of precommits that finalized a block:

```ts
export interface Commit {
  height: bigint;
  round: number;
  blockHash: Uint8Array;
  signatures: (Uint8Array | null)[];
}
```

`signatures[i]` belongs to validator `i` of that height's set, or is `null` if that validator's precommit was not seen. The doc comment notes "Signatures are not aggregated under either scheme, so this is linear in the validator count": ML-DSA has no aggregation and plain ECDSA offers none either, so the shape is the same under both schemes; only the per-signature cost differs, 2,421 bytes with the tag under ML-DSA-44 and 65 under secp256k1, on top of 48 bytes of fields and one presence byte per slot. Validation checks that the length equals `state.lastValidators.size`. Which validators are `null` matters beyond verification: the executor reports the signers to the application, which uses absence for downtime slashing.

**`interface Block`** is `header`, `txs: Uint8Array[]` (opaque to the engine), `lastCommit: Commit | null` ("null only at height 1") and `evidence: Evidence[]`, any of the four kinds below.

**`encodeHeader`** and **`decodeHeader`** write and read the fourteen fields; the decoder limits `chainId` to 256 bytes and reads every hash as `fixed(HASH_SIZE)` and the proposer as `fixed(ADDRESS_SIZE)`. **`headerHash(h)`** and **`blockHash(b)`**:

```ts
/** The block hash is the header hash. The header commits to everything else. */
export function headerHash(h: Header): Uint8Array {
  return sha256(encode((w) => encodeHeader(w, h)));
}

export function blockHash(b: Block): Uint8Array {
  return headerHash(b.header);
}
```

**`txHash(tx)`** is `sha256(tx)` over the raw transaction bytes, the id the mempool, the transaction index and the RPC all use (`RPC-SYNC-PROOFS.md` section 2.2).

**`encodeCommit`**/**`decodeCommit`** write height, round, block hash and an array of optional signatures, each read back with `decodeSignature`, at most `MAX_VALIDATORS` (2,000), one for each validator a set may hold. **`commitHash(c)`** is `ZERO_HASH` for `null` (height 1) and otherwise the hash of the encoding. **`evidenceHash(evs)`** is `ZERO_HASH` for an empty list and otherwise the hash of the encoded array; it is the header field. The hash of *one* piece of evidence, used to announce it to peers by inventory, is a different function, `evidenceId(ev)` in `src/consensus/evidence.ts`. It was also called `evidenceHash` until review finding 48 renamed it, because two exported functions with one name and two meanings were a trap for readers even though no file imported both.

**`encodeBlock`**/**`decodeBlock`** compose the parts: header, transactions as length-prefixed `bytes`, the optional commit, and at most 1,000 evidence entries. The decoder's own limits are loose; the enforced bound is `limits.maxBlockBytes`, the chain's figure from the genesis (`consensus.maxBlockBytes`, below), on **`blockDataBytes(b)`**, the encoded size of the transactions array plus the evidence array: what the proposer chooses to put in the block. The header is of a fixed shape and the last commit has one signature for each validator, so neither is the proposer's to make smaller, and a limit that counted them could be one a large validator set cannot build an empty block under. Validation measures `blockDataBytes` and the proposer budgets its transactions with it (review finding 15 made the proposer measure before it reaps and cap evidence at 16 per block). **`blockBytes(b)`** is the full encoding, at most `maxBlockBytes` plus the header and the commit.

### src/types/evidence.ts

**`type Evidence`** is a union of the four faults this chain punishes on evidence, told apart by a `kind` field. Three are two things one validator signed at one height (two votes, or two proposals), so anyone holding both signatures can prove them and the proof needs nothing else. The fourth is one vote of the accused and the prevotes of others.

**`interface DuplicateVoteEvidence`** is `{ kind: 'duplicateVote'; voteA: Vote; voteB: Vote }`: two different votes of the same type at the same height and round. **`makeDuplicateVoteEvidence(a, b)`** puts the votes in canonical order, "the vote with the lower block hash (nil lowest) comes first, then the lower polRound", using the private `compareVotes` and `compareHashes`; the latter orders `null` before any array and otherwise defers to `compareBytes`. Canonical order means the same pair of votes always encodes to the same bytes, so two nodes that observed the same double-sign produce identical evidence with an identical hash.

**`interface AmnesiaEvidence`** is `{ kind: 'amnesia'; precommit: Vote; prevote: Vote }`: a lock forgotten. A validator that precommits a block is locked on it for the rest of the height. In a later round it may prevote another block only if that block had +2/3 prevotes in the round of the lock or after it, and its prevote names that round. So a precommit for one block and a prevote for another in a later round, naming a round before the precommit's or none, are a fault whatever else happened: the validator said itself that it knew of nothing that could release it. **`isAmnesia(precommit, prevote)`** is that condition, which consensus asks of every such pair of votes it holds:

```ts
export function isAmnesia(precommit: Vote, prevote: Vote): boolean {
  return (
    precommit.type === VoteType.Precommit &&
    prevote.type === VoteType.Prevote &&
    precommit.height === prevote.height &&
    precommit.validatorIndex === prevote.validatorIndex &&
    precommit.blockHash !== null &&
    prevote.blockHash !== null &&
    !bytesEqual(precommit.blockHash, prevote.blockHash) &&
    prevote.round > precommit.round &&
    prevote.polRound < precommit.round
  );
}
```

Every clause is needed. A vote for nil forgets nothing, since a locked validator may always prevote nil and a precommit for nil takes no lock. The same block is the lock kept. A prevote of the same round was signed before the precommit. And `prevote.polRound < precommit.round` is the fault itself: with a round at or after the precommit's named, the validator claims a release the rules allow, and whether the claim is true is a question two votes cannot answer. Chapter 4 says what is done about a false claim (nobody counts the prevote).

**`interface ProposalHead`** is what a proposer signs of a proposal, without the block: `polRound`, `blockHash` and the `signature`. **`interface DuplicateProposalEvidence`** is `{ kind: 'duplicateProposal'; height; round; validatorIndex; a: ProposalHead; b: ProposalHead }`: two different proposals one validator signed for one height and round, whether for two blocks or for one block on two proof-of-lock rounds. The blocks are not carried, because a proposal's signature is over the block's hash (`proposalSignBytes`, below), so two heads are the whole proof and the evidence is a few kilobytes whatever the blocks held. **`makeDuplicateProposalEvidence(height, round, validatorIndex, x, y)`** orders the heads by block hash and then `polRound`, for the same reason the votes of a double sign are ordered.

**`interface FalseCitationEvidence`** is `{ kind: 'falseCitation'; prevote: Vote; against: Vote[] }`: a prevote for a block that names a round, and prevotes of that round, one a validator and in ascending order of validator index, none of them for the block. With +2/3 of the power behind them (which only `verifyEvidence` can tell, since it takes the validator set), a polka for the block in that round would have needed more than a third of the power to prevote twice in it. So the evidence proves the fault under the assumption everything else in the protocol rests on, that less than a third signs twice; and if more than a third did sign twice to convict an honest validator, each of them is convicted by its own two prevotes. The evidence is also incomplete in the other direction: where a third of the power or more did prevote the block in the round named, or did not prevote at all, a false claim cannot be refuted, only left uncounted (chapter 4). **`speaksAgainst(prevote, other)`** is the test of one such vote: a prevote of the same height, of the round `prevote` names, and not for its block. The accused's own prevote of that round qualifies like any other.

**`checkEvidenceShape(ev)`** is the structural check of every kind, returning an error string or `null`:

```ts
/** Structural check only; signatures, and the power behind a false citation's prevotes, are verified separately. Returns an error string or null. */
export function checkEvidenceShape(ev: Evidence): string | null {
  if (ev.kind === 'duplicateProposal') {
    if (!Number.isInteger(ev.round) || ev.round < 0) return 'bad round';
    for (const h of [ev.a, ev.b]) if (!Number.isInteger(h.polRound) || h.polRound < -1 || h.polRound >= ev.round) return 'polRound must be -1 or a round before the proposal\'s own';
    if (compareHeads(ev.a, ev.b) === 0) return 'proposals are the same';
    if (compareHeads(ev.a, ev.b) > 0) return 'proposals not in canonical order';
    return null;
  }
  if (ev.kind === 'falseCitation') {
    const p = ev.prevote;
    if (p.type !== VoteType.Prevote || p.blockHash === null || p.polRound < 0) return 'a false citation is a prevote for a block that names a round';
    if (ev.against.length === 0) return 'no prevotes against the round named';
    let last = -1;
    for (const v of ev.against) {
      if (v.type !== VoteType.Prevote) return 'only prevotes speak against a round of prevotes';
      if (v.height !== p.height) return 'heights differ';
      if (v.round !== p.polRound) return 'a prevote of another round than the one named';
      if (bytesEqual(v.blockHash, p.blockHash)) return 'a prevote for the block itself';
      if (v.validatorIndex <= last) return 'prevotes not in ascending order of validator';
      last = v.validatorIndex;
    }
    return null;
  }
  if (ev.kind === 'amnesia') {
    const { precommit: c, prevote: p } = ev;
    if (c.type !== VoteType.Precommit || p.type !== VoteType.Prevote) return 'amnesia evidence is a precommit and a prevote';
    if (c.height !== p.height) return 'heights differ';
    if (c.validatorIndex !== p.validatorIndex) return 'validators differ';
    if (c.blockHash === null || p.blockHash === null) return 'a vote for nil forgets no lock';
    if (bytesEqual(c.blockHash, p.blockHash)) return 'votes are for the same block';
    if (p.round <= c.round) return 'the prevote is not after the precommit';
    if (p.polRound >= c.round) return 'the prevote names a proof of lock at or after the precommit';
    return null;
  }
  const { voteA: a, voteB: b } = ev;
  if (a.height !== b.height) return 'heights differ';
  if (a.round !== b.round) return 'rounds differ';
  if (a.type !== b.type) return 'vote types differ';
  if (a.validatorIndex !== b.validatorIndex) return 'validators differ';
  if (sameVoteContent(a, b)) return 'votes are the same';
  if (compareVotes(a, b) > 0) return 'votes not in canonical order';
  return null;
}
```

For a double sign: same height, round, type and validator; different content (a nil vote and a block vote differ, and so do two votes for one block that name different rounds); canonical order. For a forgotten lock: the clauses of `isAmnesia`, each with its own message. For two proposals: a round, each `polRound` one a proposal of that round may carry, different content, canonical order. For a false citation: the accused's vote is a prevote for a block that names a round, and every other vote is a prevote of that height and round, not for the block, with the indices strictly ascending, which also means no validator is counted twice. Signatures are deliberately not checked here, nor is the power behind a false citation's prevotes; `verifyEvidence` in `src/consensus/evidence.ts` runs this check and then verifies every signature against the public key its signer holds in the set of that height, through the `Verifier` from [chapter 2](02-crypto.md). The split keeps this file free of asynchronous code and of the validator set.

**`evidenceVotes(ev)`** gives the votes a piece of evidence carries, the accused's first (none for two proposals), **`evidenceHeight(ev)`** the height of the fault (whose validator set the signatures are checked against and whose time the evidence is aged by) and **`evidenceValidator(ev)`** the accused's index; the rest of the node uses these and never looks inside a kind. **`evidenceKey(ev)`** is one key for one offence:

```ts
export function evidenceKey(ev: Evidence): string {
  switch (ev.kind) {
    case 'amnesia':
      return `amnesia/${ev.precommit.height}/${ev.precommit.validatorIndex}`;
    case 'duplicateProposal':
      return `proposal/${ev.height}/${ev.round}/${ev.validatorIndex}`;
    case 'falseCitation':
      return `citation/${ev.prevote.height}/${ev.prevote.validatorIndex}`;
    case 'duplicateVote':
      return `${ev.voteA.height}/${ev.voteA.round}/${ev.voteA.type}/${ev.voteA.validatorIndex}`;
  }
}
```

The evidence pool keys its maps by it, so one validator can be reported at most once per (height, round, type) for a double sign however many conflicting votes it signed, once per (height, round) for two proposals, and once per height for a forgotten lock or a false citation, whichever of its votes show it. **`encodeEvidence`** writes a tag byte and the body: 1 and 2 for a double sign and a forgotten lock, two votes back to back; 3 for two proposals, the height, round and validator index and then the two heads, each `polRound` as `i64`, the hash and the signature; 4 for a false citation, the prevote and then an array of votes, which **`decodeEvidence`** reads with a limit of `MAX_VALIDATORS`. It refuses any other tag with `unknown evidence kind N`.

### src/types/proposal.ts

**`interface Proposal`** is `height`, `round`, `polRound`, the whole `block`, and `signature`; **`UnsignedProposal`** omits the signature. The doc comment explains both departures from Tendermint:

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

**`proposalSignBytes(chainId, p)`** signs the chain id, height, round, `polRound` as `i64` (it can be −1), and the *block hash* rather than the block:

```ts
export function proposalSignBytes(chainId: string, p: UnsignedProposal): Uint8Array {
  return proposalHeadSignBytes(chainId, p.height, p.round, p.polRound, blockHash(p.block));
}

/** The same bytes from the block's hash alone: what evidence of two proposals is checked against, without the blocks. */
export function proposalHeadSignBytes(chainId: string, height: bigint, round: number, polRound: number, hash: Uint8Array): Uint8Array {
  return encode((w) => {
    w.string(chainId);
    w.u64(height);
    w.u32(round);
    w.i64(BigInt(polRound));
    w.fixed(hash);
  });
}
```

**`proposalHeadSignBytes`** is the same from the hash alone, which is what lets two proposals be proven without their blocks. Signing the hash keeps the sign bytes small and lets a re-proposal of a locked block (review finding 4) be signed by a different proposer without the block changing. **`encodeProposal`**/**`decodeProposal`** carry the block inline and the signature last, read back with `decodeSignature`; the decoder reads `polRound` with `r.i53()` ([chapter 1](01-codec.md)), which refuses a value too large to hold exactly, and does not range-check it further, leaving validation to consensus.

### src/types/state.ts

**`PROTOCOL_VERSION = 1`** is the one version this code runs, and the version a chain has when its genesis names none. A change to what is signed or stored goes into it directly while the chain is unreleased; the field is there so that a later change has a number to take. **`interface ChainState`**:

```ts
export interface ChainState {
  chainId: string;
  version: number;
  lastHeight: bigint;
  lastBlockHash: Uint8Array;
  lastBlockTime: bigint;
  /** App hash after executing lastHeight. Goes into the header of lastHeight + 1. */
  appHash: Uint8Array;
  /** Results root of lastHeight's transactions. Also goes into the next header. */
  lastResultsHash: Uint8Array;
  lastValidators: ValidatorSet;
  validators: ValidatorSet;
  nextValidators: ValidatorSet;
  /** The signature scheme every validator key must use, from genesis; the application holds the same for accounts and transactions. */
  scheme: SchemeTag;
}
```

The file comment lays out the three sets: `lastValidators` signed block `lastHeight`, `validators` will sign `lastHeight + 1`, `nextValidators` will sign `lastHeight + 2`. "This keeps the set that commits a block equal to the one named in its header, and gives light clients one header's notice of every change." `scheme` is the tag of the chain's signature scheme ([chapter 2](02-crypto.md)), copied from genesis; the application keeps the same tag in its global properties for accounts and transactions, so the two halves of a node cannot disagree about it.

**`genesisState(genesis, appHash, validatorsOverride?)`** builds the state before block 1. The validators come from the application's `initChain` if it supplied any, else from genesis; using either source is fine, and a list from neither throws. The scheme comes from `genesis.signatureScheme`, ML-DSA-44 when absent, and every validator key, from whichever side, must be of it:

```ts
export function genesisState(genesis: Genesis, appHash: Uint8Array, validatorsOverride?: ValidatorUpdate[]): ChainState {
  const entries = validatorsOverride && validatorsOverride.length > 0 ? validatorsOverride : (genesis.validators ?? []);
  if (entries.length === 0) throw new Error('genesis names no validators and the application supplied none');
  const scheme = schemeTag(genesis.signatureScheme ?? 'ml-dsa-44');
  for (const v of entries) if (schemeOf(v.publicKey) !== scheme) throw new Error(`genesis validator key is not a ${schemeName(scheme)} key`);
  const version = genesis.consensus?.version ?? PROTOCOL_VERSION;
  if (version !== PROTOCOL_VERSION) throw new Error(`genesis asks for protocol version ${version}; this node runs ${PROTOCOL_VERSION}`);
  const validators = ValidatorSet.create(entries.map((v) => ({ publicKey: v.publicKey, power: v.power })));
  const nextValidators = validators.copy();
  nextValidators.incrementProposerPriority(1);
  return {
    chainId: genesis.chainId,
    version,
    lastHeight: 0n,
    lastBlockHash: ZERO_HASH,
    lastBlockTime: genesis.genesisTime,
    appHash,
    lastResultsHash: EMPTY,
    lastValidators: validators.copy(),
    validators,
    nextValidators,
    scheme,
  };
}
```

The version is checked before any set is built: a genesis asking for one this code does not run fails with `genesis asks for protocol version 2; this node runs 1`, since the node could neither build nor check that chain's headers. `create` already performed one increment, so `validators` has the proposer for height 1; the copy advanced once more has the proposer for height 2. `lastValidators` is a copy of the same set although nothing signed height 0. `lastResultsHash` starts at the Merkle `EMPTY` value, not `ZERO_HASH`: `RPC-SYNC-PROOFS.md` section 2.1 says "Height 1 carries the empty value", and header validation compares it with `txsRoot([])`-style roots, which are `EMPTY`. This is why the file imports from `src/db/merkle.ts`. The scheme check runs before `ValidatorSet.create` sees the keys, so a genesis that names `secp256k1` but lists ML-DSA-44 validators fails with `genesis validator key is not a secp256k1 key` rather than with a message about key sizes, and a secp256k1 key under the default scheme fails the same way with `ml-dsa-44`.

**`nextState(state, block, updates, appHash, resultsHash)`** is the state transition the executor applies after each commit:

```ts
export function nextState(state: ChainState, block: Block, updates: ValidatorUpdate[], appHash: Uint8Array, resultsHash: Uint8Array): ChainState {
  if (block.header.height !== state.lastHeight + 1n) throw new Error('nextState: height mismatch');
  // The applications refuse such a key themselves; an update that still carried one halts here rather than sign with it.
  for (const u of updates) if (schemeOf(u.publicKey) !== state.scheme) throw new Error(`validator update key is not a ${schemeName(state.scheme)} key`);
  const nextNext = state.nextValidators.applyUpdates(updates);
  nextNext.incrementProposerPriority(1);
  return {
    chainId: state.chainId,
    version: state.version,
    lastHeight: block.header.height,
    lastBlockHash: blockHash(block),
    lastBlockTime: block.header.time,
    appHash,
    lastResultsHash: resultsHash,
    lastValidators: state.validators,
    validators: state.nextValidators,
    nextValidators: nextNext,
    scheme: state.scheme,
  };
}
```

The sets shift down one slot and the updates returned by executing block H are applied to the set that will sign H+2, which is the two-height delay from the Concepts section. An update whose key is of the other scheme throws first: both applications already refuse such a key themselves (the core application at admission, [chapter 11](11-application.md), and the toy one in its `parse`, [chapter 5](05-mempool-executor.md)), so one reaching here is a bug, and halting is better than carrying a key of the wrong scheme into a set that every node on the chain takes to be of one scheme. `src/node/executor.ts` calls it as `nextState(this.state, block, res.validatorUpdates, res.appHash, resultsRoot(res.txResults))`.

**`encodeState`**/**`decodeState`** persist the record. The field order is not the interface order: `chainId`, `lastHeight`, `lastBlockHash`, `lastBlockTime`, `appHash`, the three sets, only then `version` and `lastResultsHash`, the two fields the proofs round added, and last the scheme as a single `u8`, which `decodeState` reads back through the private `readScheme`:

```ts
function readScheme(r: Reader): SchemeTag {
  const tag = r.u8();
  if (!isSchemeTag(tag)) throw new Error(`chain state names unknown signature scheme ${tag}`);
  return tag;
}
```

A reader of the store must follow `encodeState`, not the interface. `src/store/blockstore.ts` writes it under a fixed key on every commit and reads it back on start.

### src/types/genesis.ts

The file comment explains why this one type is JSON: "Genesis is hand-edited, so it is JSON. Nothing in it is hashed directly; the chain id is the identity, and the validator set it describes is hashed through ValidatorSet.hash() once loaded."

**`interface GenesisValidator`**: `publicKey`, `power`, optional `name`. **`interface Genesis`**:

```ts
export interface Genesis {
  chainId: string;
  /** The signature scheme every validator key, account key and signature on this chain must use; ML-DSA-44 when absent. */
  signatureScheme?: SchemeName;
  /** Unix milliseconds. Block 1 must be later than this. */
  genesisTime: bigint;
  /** The initial validator set, unless the application supplies one from initChain. */
  validators?: GenesisValidator[];
  /**
   * Engine settings every node of the chain must hold alike: the protocol version, the evidence age (which must
   * agree with the application's rules) and the most bytes the transactions and evidence of a block may encode to,
   * 4 MiB when absent. A block over
   * that size is invalid for everyone, so it is read from here and from nowhere else.
   */
  consensus?: { maxEvidenceAgeMs?: bigint; version?: number; maxBlockBytes?: number };
  /** Opaque to consensus; handed to the application's initChain. Empty when `appStateFile` is set. */
  appState: Uint8Array;
  /** The application genesis in its own file. Relative to the genesis file as written; absolute once loaded. */
  appStateFile?: string;
}
```

`signatureScheme` is the JSON field `"signatureScheme": "ml-dsa-44"` or `"secp256k1"`; absent means ML-DSA-44, so every genesis file written before there were two schemes keeps its meaning. `consensus.maxBlockBytes` is the most bytes the transactions and evidence of a block may encode to (the header and the last commit are not counted), and it is in the genesis because it is a rule of validity: `validateBlockStructure` ([chapter 4](04-consensus.md)) applies it to proposals, to blocks being committed and to synced blocks, so two nodes holding different figures would disagree about which blocks are valid. The node reads it from here and from nowhere else ([chapter 8](08-node.md)). **`MIN_BLOCK_BYTES`** (64 KiB, room for a transaction of some size), **`MAX_BLOCK_BYTES`** (16 MiB, inside one network frame with two commits of the largest validator set beside it) and **`DEFAULT_MAX_BLOCK_BYTES`** (4 MiB, used when the field is absent) bound it, and **`checkMaxBlockBytes(n)`** returns a whole number within those bounds or throws `genesis: consensus.maxBlockBytes must be a whole number from 65536 to 16777216`; a number written as a string is refused too. `appStateFile` is the resolution of review finding 35: an application genesis of a few hundred thousand accounts, each with two 1,313-byte ML-DSA-44 keys, exceeds the 512 MB string limit V8 imposes on `JSON.parse`, so the application state can live in its own file that the application reads as a token stream.

**`genesisToJson(g)`** serializes with `bigint`s as decimal strings and keys as hex, writes `signatureScheme` when the genesis names one and `consensus.maxBlockBytes`, a plain number, when it sets one, omits `appState` when `appStateFile` is set, and otherwise emits `appState` decoded as a UTF-8 string. **`genesisFromJson(s, baseDir = '.')`** parses it back:

```ts
export function genesisFromJson(s: string, baseDir = '.'): Genesis {
  const j = JSON.parse(s);
  if (typeof j.chainId !== 'string' || j.chainId.length === 0) throw new Error('genesis: bad chainId');
  const appStateFile = typeof j.appStateFile === 'string' ? resolve(baseDir, j.appStateFile) : undefined;
  if (j.signatureScheme !== undefined) schemeTag(String(j.signatureScheme)); // a name the code knows, or a clear error
  return {
    chainId: j.chainId,
    ...(j.signatureScheme !== undefined ? { signatureScheme: schemeName(schemeTag(String(j.signatureScheme))) } : {}),
    genesisTime: BigInt(j.genesisTime),
    validators: Array.isArray(j.validators) ? (j.validators as any[]).map((v) => ({ publicKey: fromHex(v.publicKey), power: BigInt(v.power), name: v.name })) : undefined,
    consensus: j.consensus
      ? { maxEvidenceAgeMs: j.consensus.maxEvidenceAgeMs !== undefined ? BigInt(j.consensus.maxEvidenceAgeMs) : undefined, version: j.consensus.version, ...(j.consensus.maxBlockBytes !== undefined ? { maxBlockBytes: checkMaxBlockBytes(j.consensus.maxBlockBytes) } : {}) }
      : undefined,
    appState: appStateFile ? new Uint8Array() : new TextEncoder().encode(typeof j.appState === 'string' ? j.appState : JSON.stringify(j.appState ?? {})),
    ...(appStateFile ? { appStateFile } : {}),
  };
}
```

`appState` may be written as a JSON string or as an inline object; either becomes bytes for the application. Validation is minimal: the chain id must be a non-empty string, `signatureScheme`, when present, must be a name the code knows (`schemeTag` throws `unknown signature scheme "x"; one of ml-dsa-44, secp256k1`), `consensus.maxBlockBytes`, when present, must pass `checkMaxBlockBytes`, `fromHex` rejects malformed keys, and everything else is caught later by `ValidatorSet.create` (a tagged key of a known scheme, positive power), by `genesisState` (every key of the named scheme) or by the application. A bad `genesisTime` makes `BigInt()` throw a `SyntaxError` rather than a descriptive error. **`loadGenesisFile(path)`** reads the file and resolves `appStateFile` against its directory.

The CLI writes `genesis.json` with `genesisToJson` at `init` and loads it at `start`; the RPC's `genesis` method returns the same JSON without `appStateFile`, which is a path on the node's own disk.

### src/types/txproof.ts

This file builds the two Merkle roots in the header and the proofs against them. It imports `DenseMerkleTree`, `EMPTY`, `leafHash` and `rootFromPath` from `src/db/merkle.ts` and the `TxResult` type from `src/app/types.ts`, which makes it the one place where the chain types depend on the application interface (a type-only import).

The private `indexKey(i)` is the leaf key, a big-endian `u32` position. **`txResultBytes(r)`** is the leaf value for a result: `u8(ok)` then `string(error ?? '')`, the shape `RPC-SYNC-PROOFS.md` section 2.1 specifies as `encode(ok: u8, error: string)`. The private `build(values)` makes the tree:

```ts
function build(values: Uint8Array[]): { tree: DenseMerkleTree; root: Uint8Array } {
  const tree = new DenseMerkleTree();
  if (values.length === 0) return { tree, root: EMPTY };
  tree.resize(values.length);
  values.forEach((v, i) => tree.setLeaf(i, leafHash(indexKey(i), v)));
  return { tree, root: tree.root(0) };
}
```

Each leaf is `leafHash(key, value)`, the ICS23 leaf `H(0x00 || varint(len key) || key || varint(32) || H(value))`; the tree is a complete binary tree padded with `EMPTY`, and `root(0)` is its root at version 0 (the version machinery is unused here; a block's tree is built once and discarded). An empty block hashes to `EMPTY`.

**`txsRoot(txs)`** and **`resultsRoot(results)`** are what the proposer puts in `dataHash` (`src/consensus/consensus.ts`), what validation recomputes, and what the executor stores as `lastResultsHash` for the next header.

**`interface TxProof`** is `height`, `index`, `tx` and `siblings`. **`interface ResultProof`** is `height`, `index`, `ok`, `error`, `siblings`. Neither states how many transactions the block has. The file's header comment gives the reason: "the root commits to the tree's height, which the path's length gives, but not to the count, so a proof carrying one would be stating something it does not prove." **`txProofFor(height, txs, index)`** and **`resultProofFor(height, results, index)`** rebuild the tree and take `tree.path(index)`; the node's RPC calls them when a `tx` query asks for proofs.

The private `pathMatches` is the verifier both public functions share:

```ts
function pathMatches(root: Uint8Array, value: Uint8Array, index: number, siblings: Uint8Array[]): boolean {
  // The position must be one the path's length can address: rootFromPath reads only that many bits of it.
  if (!Number.isSafeInteger(index) || index < 0 || siblings.length > 32 || index >= 2 ** siblings.length) return false;
  return bytesEqual(rootFromPath(leafHash(indexKey(index), value), index, siblings), root);
}
```

The path's length is the tree's height (3 siblings for 5 to 8 leaves, 4 for 9 to 16). `rootFromPath` folds the leaf up through the siblings, using the bits of `index` to decide which side the leaf is on at each level, and it reads only as many bits as there are siblings, so the guard requires `index` to be below `2 ** siblings.length`: without it, an index eight too high would fold along the same path as the true one in a tree of height 3. A path of the wrong length cannot reach the root either, because a leaf is hashed apart from an inner node. **`verifyTxProof(dataHash, p)`** checks against "the dataHash of the header at proof.height"; **`verifyResultProof(lastResultsHash, p)`** against "the lastResultsHash of the header at proof.height + 1", the deferred-execution rule once more. `src/light/client.ts` verifies both headers and then both legs, and additionally requires the two proofs to name the same index.

The proofs once carried a `count`, which was bound only through the tree height it implied: a proof for a 7-transaction block verified equally with `count` set to 5, 6 or 8. The field is gone from the interfaces and from the encoding, so a proof says where a transaction is and what it is, and nothing it does not prove.

**`encodeTxProof`**/**`decodeTxProof`** and **`encodeResultProof`**/**`decodeResultProof`** are chained writer calls; the decoders cap siblings at 32. **`txProofToBytes`**, **`txProofFromBytes`**, **`resultProofToBytes`** and **`resultProofFromBytes`** wrap them with `encode` and `decode`, and the RPC sends proofs as hex of exactly these bytes so that "The RPC never re-serialises a proof" (`RPC-SYNC-PROOFS.md` section 3.2).

### src/util/log.ts

Not a chain type, but every module from here up takes a `Logger`. **`type LogLevel = 'debug' | 'info' | 'warn' | 'error'`** and **`type Logger = (level, msg, fields?) => void`**: a logger is a function, not an object, so a module that wants to prefix or filter can wrap it in one line. The private `ORDER` ranks the levels and the private `fmt` renders field values the way the chain's data wants:

```ts
function fmt(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v.subarray(0, 6)).toString('hex') + (v.length > 6 ? '..' : '');
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'object') return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  return String(v);
}
```

A hash prints as its first six bytes, a `bigint` height as a number, a nil block hash as `nil`, and objects as JSON with `bigint`s converted (plain `JSON.stringify` throws on `bigint`).

**`makeLogger(name, minLevel = 'info', out = stderr)`** returns a logger that drops lines below `minLevel` and formats `HH:MM:SS.mmm level [name] msg k=v ...`. Output goes to stderr by default so stdout stays clean for CLI results. **`silentLogger`** is a no-op. `src/node/node.ts` defaults to `makeLogger(cfg.name, cfg.logLevel ?? 'info')`, the CLI reads the `LOG` environment variable (`README.md`: "Set `LOG=debug` to watch every proposal, vote and timeout"), and `test/helpers.ts` uses the same variable to switch a test from `silentLogger` to a real one.

## How it is tested

**`test/units.test.ts`, `describe('validator set')`.** `picks proposers in proportion to voting power` creates a set with powers 1, 2 and 3, advances a copy one step 600 times and asserts the proposer counts are exactly 100, 200 and 300: the round-robin is fair and deterministic. `applies updates, hashes independently of priorities, and survives a codec round-trip` adds a third validator with `applyUpdates` and asserts its priority is negative, removes one with power 0, asserts removing it again throws `/unknown/`, advances a set three rounds and asserts `hash()` is unchanged, then encodes and decodes the advanced set and asserts the proposer and every priority survive.

**`test/review.test.ts`, `rejects decoded validator sets with duplicate members, wrong order or a bad proposer index`** hand-encodes three malformed sets with the codec and asserts `ValidatorSet.decode` throws `/duplicate/`, `/out of order/` and `/proposer index/`. It is the regression for review finding 1. `test/review5-net.test.ts`, `has no proposer when it is empty, and says so in the one way create() does`, decodes the encoding of `ValidatorSet.create([])` and a hand-encoded empty set with index −1, and asserts that the same empty set with index 0, 5 or −2 throws `/proposer index out of range/`. `refuses validator powers whose total a priority could not track` calls `create` with two validators of 2^63 each and expects `/total power/`: the sum is above `MAX_TOTAL_POWER`. `test/review5-node.test.ts`, `bounds a block by what its proposer chose, and a validator set by what a frame holds`, creates a set of `MAX_VALIDATORS` members, expects one more to throw `/2001 validators exceed the limit 2000/`, and checks that `MAX_BLOCK_BYTES` with two commits of 2,000 ML-DSA-44 signatures is less than `MAX_FRAME`; its first half, on `blockDataBytes`, is in [chapter 4](04-consensus.md). `test/review.test.ts`, `keeps per-block results so a repeated transaction proves its real outcome at each position`, builds a block whose `dataHash` is `txsRoot([raw, raw])`, stores it with results `[ok, duplicate failure]`, and asserts a result proof for position 1 verifies and says `ok: false` (review finding 18).

**`test/txproof.test.ts`.** `proves inclusion against the data hash and rejects tampering` uses seven small transactions: the empty root is `EMPTY`; every position's proof verifies, survives a byte round-trip, and fails with a different transaction, a different index, a path one sibling longer or one shorter, an index eight too high (one the path's length cannot address), an index of −1 and a root over six transactions; reversing the list changes the root. `proves results, including failures, against the results hash` does the same for results with every third one failing, and asserts flipping `ok` or appending to `error` breaks the proof.

**`test/engine.test.ts`.** `rejects a block from another protocol version` bumps `header.version` on a real block and asserts `validateBlockStructure` reports `/protocol version/`, and that the node's state version is `PROTOCOL_VERSION`. `refuses a genesis with no validators from either side` calls `genesisState` with no genesis validators and no override, and with an empty override, expecting `/no validators/`. `drops evidence older than the configured age by block time, and keeps young evidence` forges two conflicting prevotes with `voteSignBytes` and `signContext(chainId, 'vote')`, wraps them with `makeDuplicateVoteEvidence`, and checks that stale evidence is discarded and young evidence reaches every application.

**`test/priorities.test.ts`.** `hashes a set by its members and its priorities apart, and commits a header to the priorities` advances a copy of a three-validator set once and finds `hash()` unchanged and `prioritiesHash()` changed, moves one unit of priority between the two validators that are not proposing (same proposer, another hash), marks another validator as proposer over the same priorities (another hash again), reads a set back from its stored form with the same `prioritiesHash()`, and finds the header's hash different for the two sets in the other order; a header comes back from `decodeHeader` and from `headerFromJson` as it went in, with the hash as its last 32 bytes. `starts a chain under the one protocol version, and refuses a block whose header commits to other priorities` calls `genesisState` with no version and with 1 (both 1), and with 2 and 0 (`/protocol version 2; this node runs 1/`), then hands `validateBlockStructure` a block of height 1 whose `prioritiesHash` is that of the two sets in the wrong order, of one set alone, or of a set with the same members and shifted priorities or another proposer: each is `'wrong prioritiesHash'`.

**`test/amnesia.test.ts`.** `signs into a prevote the proof-of-lock round it relies on, and counts two votes that differ in it alone as a double sign` runs `checkPolRound` over every case, shows the sign bytes change with the round, that `decodeVote` refuses a vote naming a round it may not, and that two prevotes for one block naming different rounds are a conflict in a `VoteSet` and valid duplicate-vote evidence, the lower round first. `proves a forgotten lock with a precommit and a later prevote for another block that names no round from the lock on` checks `checkEvidenceShape` and `isAmnesia` on a good pair and on eleven pairs that are no evidence, each with its reason, then the keys, the codec of both kinds (tag bytes 1 and 2, tag 5 refused) and `verifyEvidence` with a vote altered after signing, another signer, another chain id and an index outside the set.

**`test/schemes.test.ts`.** `refuses a genesis whose validator keys are not of the scheme it names` calls `genesisState` with an ML-DSA-44 key under `signatureScheme: 'secp256k1'` and with a secp256k1 key under no scheme at all, expecting `/not a secp256k1 key/` and `/not a ml-dsa-44 key/`, and checks that the matching cases set `state.scheme`. `runs on secp256k1 keys end to end and refuses keys and signatures of the other scheme` runs a four-validator testnet on secp256k1 and reads a stored commit back with 65-byte signatures, which is `signatureSize(Scheme.secp256k1)`.

**`test/recovery.test.ts`, `double-sign evidence is built, included in a block, and handed to the app`** forges two prevotes for different hashes from one validator, feeds them to consensus, and asserts evidence appears in the pool, is included, and reaches every application with the right height. `a validator restarted from disk resumes with its state, key guard and app intact` compares `blockHash` of stored blocks across nodes after a restart.

**`test/sync.test.ts`, `gossips evidence from a node that cannot propose, and decides a height from a fetched block`** adds `makeDuplicateVoteEvidence` on a full node and watches it reach a proposer by inventory.

**`test/store.test.ts`, `block store finds blocks by height and by hash on both backends`** builds `Block` and `Commit` values by hand with `ZERO_HASH` fields and checks `blockHash` lookups on the memory and LMDB stores.

**`test/genesis.test.ts`, `loads a genesis whose application state is in a file, and reaches the same app hash as an inline one`** writes a `genesis.json` with `genesisToJson` naming an `appStateFile`, loads it with `loadGenesisFile`, asserts the path is resolved absolute, `appState` is empty and the JSON contains no `"appState"`, and that an application built from the file reaches the same app hash as one built inline.

`headerHash` and `txHash` are used by `test/chain.test.ts`, `test/light.test.ts`, `test/rpc.test.ts`, `test/sync.test.ts` and `test/staking-net.test.ts` to compare blocks across nodes and to check proofs against the next header. The logger is exercised by every suite through `testLogger` in `test/helpers.ts`.

## Limitations and ideas

Known simplifications:

- `ValidatorSet.hash()` excludes priorities and the proposer index; the header's `prioritiesHash` covers them instead, which costs a state-syncing node one more check and the store nothing.
- A prevote that names a polka which never formed is punishable only when +2/3 of the power prevoted something else in the round named; otherwise it is only never counted ([chapter 4](04-consensus.md)). And that evidence convicts on the assumption that less than a third of the power signs twice, where the other three kinds convict on the accused's signatures alone.
- Votes carry no timestamp, so there is no BFT time; block time is the proposer's word, bounded by validation's clock-drift window.
- Proposals carry whole blocks; there are no block parts, so a block must fit in one p2p frame. The bounds on a block's transactions and evidence (16 MiB) and on a validator set (2,000) are what make it fit.
- `decodeVote` and `decodeProposal` do not range-check `round` or `validatorIndex`; consensus does, after decoding. `decodeVote` does check `polRound` (`checkPolRound`: -1 for a precommit and for a nil prevote, and from -1 to below the vote's round for a prevote for a block); `decodeProposal` refuses only a `polRound` too large to hold exactly and leaves its range to consensus.
- A `TxProof` does not say how many transactions its block has; the root commits to the tree's height and not to the count.
- `genesisFromJson` validates little beyond the chain id, the scheme name and the block size; bad keys and powers surface later with less helpful messages.
- `src/types/state.ts` imports `EMPTY` from the database and `src/types/txproof.ts` imports `TxResult` from the application interface, so the types layer is not quite the bottom of the dependency graph.

Exercises:

1. Write a property test: for random sets of 2 to 20 validators with random powers, advance one step at a time for `1000 * totalPower` steps and assert each validator's share of proposals is within one of `power / totalPower`. Then do it with `incrementProposerPriority(k)` for random `k` and confirm the counts still match while the *sequence* differs.
2. Implement `proposerForRound(set, r)` as a pure function and test it against `Consensus.proposerAt` for rounds 0 to 50.
3. The header's `prioritiesHash` is one hash over two sets, which is why state sync asks one peer for the sets of H+1 and H+2 together. Replace it with two fields, one per set, and work out what that changes in `stateSync`, in the header's size, and in what a peer can be charged for. Then consider the other design: priorities folded into `hash()` itself. What would the store's record by hash and the light client have to do?
4. Add a `timestamp` to `Vote` and `voteSignBytes`, collect the precommit timestamps in a commit, and compute Tendermint's BFT time (the power-weighted median). Decide what the header's `time` should then be.
5. `FalseCitationEvidence` carries a vote for most of the validator set, so with a large set it is large, and it convicts under an assumption. Design the alternative: an accusation with the prevotes of more than a third of the power, a period in which anyone may answer it with the polka itself, and a slash if nobody does. What must validators keep, and for how long, to be able to defend themselves? What does the application have to store?
6. Make the transaction count provable: put it in the header, or into the leaf value, give `TxProof` a `count` that is checked against it, and update `pathMatches` and the tests.
7. Give `genesisFromJson` a schema check with clear messages and a test file of bad documents.
8. Make `makeLogger` emit JSON lines when `out` is not a terminal, keeping `fmt`'s rules for hashes and `bigint`s.

## Where to next

[Chapter 4](04-consensus.md) puts these types to work: the Tendermint state machine, how votes are tallied into quorums, the evidence pool, block validation, and the private validator with its double-sign guard.
