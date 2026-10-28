# 3. The chain types

This part defines the nouns of the protocol: a validator set and how it picks proposers (`src/types/validator.ts`), a vote (`src/types/vote.ts`), a block with its header and commit (`src/types/block.ts`), double-sign evidence (`src/types/evidence.ts`), a proposal (`src/types/proposal.ts`), the chain state kept between blocks (`src/types/state.ts`), the genesis document (`src/types/genesis.ts`) and transaction inclusion proofs (`src/types/txproof.ts`), plus the small logger in `src/util/log.ts` that every later module takes as a dependency. Each type comes with its binary encoding, its hash where it has one, and the invariants its decoder enforces. The types are built from [the codec](01-codec.md) and [the crypto primitives](02-crypto.md), and borrow the dense Merkle tree from [the database](09-database.md) for transaction proofs. They are consumed by everything above: [consensus](04-consensus.md) votes on them, [the executor](08-node.md) advances the chain state, [the store](10-store.md) persists them, [the RPC](12-rpc.md) serves them, and [the light client](13-light-client.md) verifies them.

## Concepts

### Validators, voting power and quorums

A proof-of-stake chain is run by a known set of *validators*, each identified by a public key and carrying a *voting power*, an integer weight. In this chain the power ultimately comes from bonded stake (the staking module in [chapter 11](11-application.md) decides it), but the engine only sees the number. The *validator set* at a height is the list that is allowed to vote on that height's block.

Tendermint tolerates up to one third of the voting power being faulty. The two thresholds that follow from that are expressed in `ValidatorSet`: a *quorum* is strictly more than two thirds of the total power, and the smaller threshold of strictly more than one third is the amount that is guaranteed to include at least one honest validator. The engine needs a quorum of prevotes to lock on a block and a quorum of precommits to commit it; it uses the one-third threshold to notice that the network has moved on to a later round (`src/consensus/consensus.ts`, "Line 55: f+1 validators are in a later round"). `DESIGN.md` section 1 states the consequences: "Each step needs >2/3 of bonded voting power" and "halts if >1/3 of voting power is offline or partitioned."

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

Two refinements come from Tendermint (CometBFT's `validator_set.go`). Priorities are periodically *rescaled* so the spread between the highest and lowest never exceeds twice the total power, and *centered* so their average is zero; both keep the integers bounded. A newly added validator starts at a negative priority of about −1.125 times the total power so it cannot propose immediately ahead of validators that have been waiting. The rescale step is not path-independent: advancing a set by one step twice is not the same as advancing it by two steps once. `DESIGN.md` section 1 draws the rule from that: "The proposer for round r is always derived from the height's base set with one increment-by-r call, never incrementally across rounds, because the rescale step is not path independent and nodes that skipped rounds would otherwise disagree."

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

A *Merkle root* is a single hash computed from a list of values by hashing pairs up a binary tree. Its property is that a value's membership can be proved with only the sibling hashes along its path, logarithmically many, rather than the whole list. Header field `dataHash` is the root over the block's transactions; `lastResultsHash` is the root over the previous block's results. What that buys is in `RPC-SYNC-PROOFS.md` section 2: a client holding a verified header can be shown that a transaction was included at a position, and that it succeeded or failed with a given error, without downloading the block. The trees reuse the dense Merkle tree from `src/db/merkle.ts` and its ICS23 leaf shape (ICS23 is the Cosmos IBC proof specification; the hashing conventions are those of the tm2 B+ tree, from the Gno project), so a proof is "a path of siblings and the ICS23 leaf shape, with the transaction count fixing the tree's height" (`src/types/txproof.ts`).

### Evidence

The one fault this chain punishes is a validator signing two different votes of the same type at the same height and round (`DESIGN.md` section 1: "Slashable faults: duplicate vote"). Tendermint calls this `DuplicateVoteEvidence`, and it has the pleasant property of being self-contained: the two signed votes are the whole proof. The other Tendermint fault, amnesia (voting against a lock), is deferred.

### Proposals

A proposal is the proposer's signed claim "this is the block for height H, round R". Tendermint sends the block separately as gossiped parts; this chain puts the whole block inside the proposal message (`DESIGN.md` section 2: "sends the whole block in one proposal message. Block parts only if blocks grow large"). The `polRound` field is Tendermint's `POLRound`: the round in which the proposer saw a quorum of prevotes for this block, which lets validators locked on an older block unlock safely.

### Chain state and genesis

The *chain state* is what the engine needs to remember between blocks: the last height and hash, the deferred app hash and results root, and the three validator sets. It is the counterpart of Tendermint's `State` struct and is stored by the block store on every commit. *Genesis* is the hand-written document that starts a chain: chain id, start time, initial validators, engine parameters and the application's own initial state. Like Tendermint's `genesis.json` it is JSON; unlike every other type here it is never hashed, so JSON's non-canonical form does not matter.

## The code, file by file

### src/types/validator.ts

**`interface Validator`**: `address`, `publicKey`, `power: bigint`, `priority: bigint`. **`interface ValidatorUpdate`**: `publicKey` and `power`, where "Power 0 removes the validator." This is the shape the application returns from `finalizeBlock`.

The private constant `PRIORITY_WINDOW = 2n` is Tendermint's `PriorityWindowSizeFactor`, and the private comparator `byPowerThenAddress` defines the canonical order of a set: power descending, then address ascending by `compareBytes`.

**`class ValidatorSet`** holds `validators` (sorted; "Index = position here"), `totalPower`, and a private `proposerIndex`. The constructor is private; sets are made by `create`, `applyUpdates`, `copy` and `decode`. It sums the powers and throws if the sum exceeds `MAX_TOTAL_POWER`, 2^60: priorities swing by a few multiples of the total and are stored as `i64`, so a larger total could overflow them, and the bound is the same one Tendermint applies. Because every way of building a set passes through the constructor, an application update that would push the total past the limit throws instead of corrupting proposer selection.

**`static create(entries)`** builds the genesis set. It checks each public key is `PUBLIC_KEY_SIZE` bytes and each power positive, derives addresses, rejects duplicates through the private `assertUnique` (keyed by hex address), sorts, and then performs one increment so the set has a proposer:

```ts
  static create(entries: { publicKey: Uint8Array; power: bigint }[]): ValidatorSet {
    const vals: Validator[] = entries.map((e) => {
      if (e.publicKey.length !== PUBLIC_KEY_SIZE) throw new Error('bad public key size');
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

An empty set is allowed here (nothing is incremented), but `genesisState` refuses one and `applyUpdates` refuses to produce one.

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

**`copy()`** deep-copies the validators (priorities are mutated in place by the increment, so a copy is needed before computing a hypothetical proposer) and keeps the proposer index.

**`hash()`** is the value the header's `validatorsHash` and `nextValidatorsHash` carry:

```ts
  /** Hash commits to public keys and powers, not priorities (which are derivable). */
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

Because the order is canonical, two sets with the same members and powers hash alike whatever their priorities. The unit test checks that advancing a set three rounds does not change its hash. The flip side is `DESIGN.md` section 10's known simplification: "Proposer priorities are not covered by the validator set hash," which review finding 8 turned into a concrete attack on state sync (a peer supplying genuine keys with altered priorities), mitigated by checking that imported sets pick the proposers the chain actually used.

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

**`applyUpdates(updates)`** returns a new set, leaving this one untouched. It copies the validators into a map by address, then walks the updates: a bad key size or a negative power throws, a duplicate address within the updates throws, power 0 removes (and `'cannot remove unknown validator'` if absent), an existing validator gets its power replaced, and a new one is queued as an addition. Additions then receive the Tendermint starting priority:

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

**`encode(w)`** writes every validator as `fixed(publicKey)`, `u64(power)`, `i64(priority)`, then `i64(proposerIndex)`. Unlike `hash()`, the stored form includes priorities and the proposer, because the store and state sync must reproduce the exact proposer sequence (`DESIGN.md` section 9: "Validator sets are also stored by the height they sign, priorities included, because a state-synced node must continue consensus with the exact proposer priorities").

**`static decode(r)`** is where review finding 1 was fixed. The original decoder accepted whatever a peer sent; a validator could supply a fabricated set containing its own key twice and have its trusted power counted twice by the light client. The decoder now re-checks everything `create` checks, plus the order and the proposer index:

```ts
  static decode(r: Reader): ValidatorSet {
    const vals = r.array((r) => {
      const publicKey = r.fixed(PUBLIC_KEY_SIZE);
      const power = r.u64();
      const priority = r.i64();
      if (power <= 0n) throw new Error('validator power must be positive');
      return { address: addressOf(publicKey), publicKey, power, priority };
    }, 10_000);
    ValidatorSet.assertUnique(vals);
    for (let i = 1; i < vals.length; i++) if (byPowerThenAddress(vals[i - 1]!, vals[i]!) >= 0) throw new Error('validator set out of order');
    const proposerIndex = Number(r.i64());
    if (vals.length > 0 && (proposerIndex < 0 || proposerIndex >= vals.length)) throw new Error('validator set proposer index out of range');
    return new ValidatorSet(vals, proposerIndex);
  }
```

The order check uses `>= 0`, so an equal pair (a duplicate) would also be caught here, but `assertUnique` runs first and gives the clearer message. The address is recomputed from the key rather than trusted from the wire, which is why the wire format does not carry it.

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
  validatorIndex: number;
  signature: Uint8Array;
}

export type UnsignedVote = Omit<Vote, 'signature'>;
```

**`voteSignBytes(chainId, v)`** is the signed encoding: chain id, type, height, round, optional block hash. The validator index is *not* signed; the signature is bound to the key, so which slot the key sits in is routing information:

```ts
/** The bytes a validator signs. Chain id is also in the signing context, but repeating it here costs nothing. */
export function voteSignBytes(chainId: string, v: UnsignedVote): Uint8Array {
  return encode((w) => {
    w.string(chainId);
    w.u8(v.type);
    w.u64(v.height);
    w.u32(v.round);
    w.option(v.blockHash, (w, h) => w.fixed(h));
  });
}
```

The chain id appears both here and in the signing context from [chapter 2](02-crypto.md); the comment acknowledges the redundancy. `src/consensus/privval.ts` signs these bytes with the `vote` context, and `src/consensus/consensus.ts` and `src/consensus/evidence.ts` rebuild them to verify.

**`encodeVote(w, v)`** writes type, height, round, optional hash, `u32(validatorIndex)` and the fixed-size signature. **`decodeVote(r)`** reads the same and rejects a type other than 1 or 2 with `'bad vote type'`; it does not bound `round` or `validatorIndex`, leaving that to consensus (which ignores votes more than 1000 rounds ahead and checks the index against the set in its vote set).

**`blockHashKey(h)`** turns a nullable hash into a `Map` key, `'nil'` or hex. The vote set in `src/consensus/votes.ts` tallies power per block with it.

### src/types/block.ts

**`interface Header`** has thirteen fields, in encoding order: `chainId`, `version`, `height`, `time` (unix milliseconds set by the proposer), `lastBlockHash`, `lastCommitHash`, `dataHash`, `lastResultsHash`, `validatorsHash`, `nextValidatorsHash`, `appHash`, `evidenceHash`, `proposerAddress`. The source comment on the interface is the deferred-execution rule: "`appHash` and `lastResultsHash` describe the state and the transaction results after executing the *previous* block, because this block is proposed before anyone has run it."

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
| `time` | after `state.lastBlockTime`, within `maxClockDriftMs` of local time |
| `proposerAddress` | present in `state.validators` |

`version` was added in the proofs round (`RPC-SYNC-PROOFS.md` section 2.1): "validation rejects a header whose version differs from the state's. The first version with this header is 1."

**`interface Commit`** is the set of precommits that finalized a block:

```ts
export interface Commit {
  height: bigint;
  round: number;
  blockHash: Uint8Array;
  signatures: (Uint8Array | null)[];
}
```

`signatures[i]` belongs to validator `i` of that height's set, or is `null` if that validator's precommit was not seen. The doc comment notes "There is no aggregation with ML-DSA, so this is linear in the validator count." Validation checks that the length equals `state.lastValidators.size`. Which validators are `null` matters beyond verification: the executor reports the signers to the application, which uses absence for downtime slashing.

**`interface Block`** is `header`, `txs: Uint8Array[]` (opaque to the engine), `lastCommit: Commit | null` ("null only at height 1") and `evidence: DuplicateVoteEvidence[]`.

**`encodeHeader`** and **`decodeHeader`** write and read the thirteen fields; the decoder limits `chainId` to 256 bytes and reads every hash as `fixed(HASH_SIZE)` and the proposer as `fixed(ADDRESS_SIZE)`. **`headerHash(h)`** and **`blockHash(b)`**:

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

**`encodeCommit`**/**`decodeCommit`** write height, round, block hash and an array of optional fixed-size signatures, at most 10,000. **`commitHash(c)`** is `ZERO_HASH` for `null` (height 1) and otherwise the hash of the encoding. **`evidenceHash(evs)`** is `ZERO_HASH` for an empty list and otherwise the hash of the encoded array; it is the header field. The hash of *one* piece of evidence, used to announce it to peers by inventory, is a different function, `evidenceId(ev)` in `src/consensus/evidence.ts`. It was also called `evidenceHash` until review finding 48 renamed it, because two exported functions with one name and two meanings were a trap for readers even though no file imported both.

**`encodeBlock`**/**`decodeBlock`** compose the parts: header, transactions as length-prefixed `bytes`, the optional commit, and at most 1,000 evidence entries. The decoder's own limits are loose; the enforced bound is `limits.maxBlockBytes` on **`blockBytes(b)`**, the full encoding, which validation measures and which the proposer uses to budget transactions (review finding 15 made the proposer measure the block without transactions first and cap evidence at 16 per block).

### src/types/evidence.ts

**`interface DuplicateVoteEvidence`** is `{ voteA: Vote; voteB: Vote }`. **`makeDuplicateVoteEvidence(a, b)`** puts the votes in canonical order, "the vote with the lower block hash (nil lowest) comes first", using the private `compareHashes`, which orders `null` before any array and otherwise defers to `compareBytes`. Canonical order means the same pair of votes always encodes to the same bytes, so two nodes that observed the same double-sign produce identical evidence with an identical hash.

**`checkDuplicateVoteShape(ev)`** is the structural check, returning an error string or `null`:

```ts
export function checkDuplicateVoteShape(ev: DuplicateVoteEvidence): string | null {
  const { voteA: a, voteB: b } = ev;
  if (a.height !== b.height) return 'heights differ';
  if (a.round !== b.round) return 'rounds differ';
  if (a.type !== b.type) return 'vote types differ';
  if (a.validatorIndex !== b.validatorIndex) return 'validators differ';
  if (bytesEqual(a.blockHash, b.blockHash)) return 'votes are for the same block';
  if (compareHashes(a.blockHash, b.blockHash) > 0) return 'votes not in canonical order';
  return null;
}
```

Same height, round, type and validator; different block (a nil vote and a block vote count as different); canonical order. Signatures are deliberately not checked here; `verifyDuplicateVoteEvidence` in `src/consensus/evidence.ts` runs this check and then verifies both signatures against the public key at `validatorIndex` in the set of that height, through the `Verifier` from [chapter 2](02-crypto.md). The split keeps this file free of asynchronous code and of the validator set.

**`evidenceKey(ev)`** is `` `${height}/${round}/${type}/${validatorIndex}` `` from `voteA`. The evidence pool keys its pending map by it, so one validator can be reported at most once per (height, round, type) however many conflicting votes it signed. **`encodeEvidence`**/**`decodeEvidence`** are two votes back to back.

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
  return encode((w) => {
    w.string(chainId);
    w.u64(p.height);
    w.u32(p.round);
    w.i64(BigInt(p.polRound));
    w.fixed(blockHash(p.block));
  });
}
```

Signing the hash keeps the sign bytes small and lets a re-proposal of a locked block (review finding 4) be signed by a different proposer without the block changing. **`encodeProposal`**/**`decodeProposal`** carry the block inline; the decoder converts `polRound` with `Number(r.i64())` and does not range-check it, leaving validation to consensus.

### src/types/state.ts

**`PROTOCOL_VERSION = 1`** is the version the chain runs unless genesis says otherwise. **`interface ChainState`**:

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
}
```

The file comment lays out the three sets: `lastValidators` signed block `lastHeight`, `validators` will sign `lastHeight + 1`, `nextValidators` will sign `lastHeight + 2`. "This keeps the set that commits a block equal to the one named in its header, and gives light clients one header's notice of every change."

**`genesisState(genesis, appHash, validatorsOverride?)`** builds the state before block 1. The validators come from the application's `initChain` if it supplied any, else from genesis; neither is an error:

```ts
export function genesisState(genesis: Genesis, appHash: Uint8Array, validatorsOverride?: ValidatorUpdate[]): ChainState {
  const entries = validatorsOverride && validatorsOverride.length > 0 ? validatorsOverride : (genesis.validators ?? []);
  if (entries.length === 0) throw new Error('genesis names no validators and the application supplied none');
  const validators = ValidatorSet.create(entries.map((v) => ({ publicKey: v.publicKey, power: v.power })));
  const nextValidators = validators.copy();
  nextValidators.incrementProposerPriority(1);
  return {
    chainId: genesis.chainId,
    version: genesis.consensus?.version ?? PROTOCOL_VERSION,
    lastHeight: 0n,
    lastBlockHash: ZERO_HASH,
    lastBlockTime: genesis.genesisTime,
    appHash,
    lastResultsHash: EMPTY,
    lastValidators: validators.copy(),
    validators,
    nextValidators,
  };
}
```

`create` already performed one increment, so `validators` has the proposer for height 1; the copy advanced once more has the proposer for height 2. `lastValidators` is a copy of the same set although nothing signed height 0. `lastResultsHash` starts at the Merkle `EMPTY` value, not `ZERO_HASH`: `RPC-SYNC-PROOFS.md` section 2.1 says "Height 1 carries the empty value", and header validation compares it with `txsRoot([])`-style roots, which are `EMPTY`. This is why the file imports from `src/db/merkle.ts`.

**`nextState(state, block, updates, appHash, resultsHash)`** is the state transition the executor applies after each commit:

```ts
export function nextState(state: ChainState, block: Block, updates: ValidatorUpdate[], appHash: Uint8Array, resultsHash: Uint8Array): ChainState {
  if (block.header.height !== state.lastHeight + 1n) throw new Error('nextState: height mismatch');
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
  };
}
```

The sets shift down one slot and the updates returned by executing block H are applied to the set that will sign H+2, which is the two-height delay from the Concepts section. `src/node/executor.ts` calls it as `nextState(this.state, block, res.validatorUpdates, res.appHash, resultsRoot(res.txResults))`.

**`encodeState`**/**`decodeState`** persist the record. The field order is not the interface order: `chainId`, `lastHeight`, `lastBlockHash`, `lastBlockTime`, `appHash`, the three sets, and only then `version` and `lastResultsHash`, the two fields the proofs round added. A reader of the store must follow `encodeState`, not the interface. `src/store/blockstore.ts` writes it under a fixed key on every commit and reads it back on start.

### src/types/genesis.ts

The file comment explains why this one type is JSON: "Genesis is hand-edited, so it is JSON. Nothing in it is hashed directly; the chain id is the identity, and the validator set it describes is hashed through ValidatorSet.hash() once loaded."

**`interface GenesisValidator`**: `publicKey`, `power`, optional `name`. **`interface Genesis`**:

```ts
export interface Genesis {
  chainId: string;
  /** Unix milliseconds. Block 1 must be later than this. */
  genesisTime: bigint;
  /** The initial validator set, unless the application supplies one from initChain. */
  validators?: GenesisValidator[];
  /** Engine settings: the protocol version and limits that must agree with the application's rules. */
  consensus?: { maxEvidenceAgeMs?: bigint; version?: number };
  /** Opaque to consensus; handed to the application's initChain. Empty when `appStateFile` is set. */
  appState: Uint8Array;
  /** The application genesis in its own file. Relative to the genesis file as written; absolute once loaded. */
  appStateFile?: string;
}
```

`appStateFile` is the resolution of review finding 35: an application genesis of a few hundred thousand accounts, each with two 1312-byte keys, exceeds the 512 MB string limit V8 imposes on `JSON.parse`, so the application state can live in its own file that the application reads as a token stream.

**`genesisToJson(g)`** serializes with `bigint`s as decimal strings and keys as hex, omits `appState` when `appStateFile` is set, and otherwise emits `appState` decoded as a UTF-8 string. **`genesisFromJson(s, baseDir = '.')`** parses it back:

```ts
export function genesisFromJson(s: string, baseDir = '.'): Genesis {
  const j = JSON.parse(s);
  if (typeof j.chainId !== 'string' || j.chainId.length === 0) throw new Error('genesis: bad chainId');
  const appStateFile = typeof j.appStateFile === 'string' ? resolve(baseDir, j.appStateFile) : undefined;
  return {
    chainId: j.chainId,
    genesisTime: BigInt(j.genesisTime),
    validators: Array.isArray(j.validators) ? (j.validators as any[]).map((v) => ({ publicKey: fromHex(v.publicKey), power: BigInt(v.power), name: v.name })) : undefined,
    consensus: j.consensus
      ? { maxEvidenceAgeMs: j.consensus.maxEvidenceAgeMs !== undefined ? BigInt(j.consensus.maxEvidenceAgeMs) : undefined, version: j.consensus.version }
      : undefined,
    appState: appStateFile ? new Uint8Array() : new TextEncoder().encode(typeof j.appState === 'string' ? j.appState : JSON.stringify(j.appState ?? {})),
    ...(appStateFile ? { appStateFile } : {}),
  };
}
```

`appState` may be written as a JSON string or as an inline object; either becomes bytes for the application. Validation is minimal: the chain id must be a non-empty string, `fromHex` rejects malformed keys, and everything else is caught later by `ValidatorSet.create` (key size, positive power) or by the application. A bad `genesisTime` makes `BigInt()` throw a `SyntaxError` rather than a descriptive error. **`loadGenesisFile(path)`** reads the file and resolves `appStateFile` against its directory.

The CLI writes `genesis.json` with `genesisToJson` at `init` and loads it at `start`; the RPC's `genesis` method returns the same JSON.

### src/types/txproof.ts

This file builds the two Merkle roots in the header and the proofs against them. It imports `DenseMerkleTree`, `EMPTY`, `heightFor`, `leafHash` and `rootFromPath` from `src/db/merkle.ts` and the `TxResult` type from `src/app/types.ts`, which makes it the one place where the chain types depend on the application interface (a type-only import).

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

**`interface TxProof`** is `height`, `index`, `tx`, `count` ("Transactions in the block; fixes the tree height") and `siblings`. **`interface ResultProof`** is `height`, `index`, `ok`, `error`, `count`, `siblings`. **`txProofFor(height, txs, index)`** and **`resultProofFor(height, results, index)`** rebuild the tree and take `tree.path(index)`; the node's RPC calls them when a `tx` query asks for proofs.

The private `pathMatches` is the verifier both public functions share:

```ts
function pathMatches(root: Uint8Array, value: Uint8Array, index: number, count: number, siblings: Uint8Array[]): boolean {
  if (index >= count || siblings.length !== heightFor(count)) return false;
  return bytesEqual(rootFromPath(leafHash(indexKey(index), value), index, siblings), root);
}
```

`heightFor(count)` is the height of a tree with `count` leaves (3 for 5 to 8 leaves, 4 for 9 to 16), so the proof must carry exactly that many siblings; `rootFromPath` folds the leaf up through them, using the bits of `index` to decide which side the leaf is on at each level. **`verifyTxProof(dataHash, p)`** checks against "the dataHash of the header at proof.height"; **`verifyResultProof(lastResultsHash, p)`** against "the lastResultsHash of the header at proof.height + 1", the deferred-execution rule once more. `src/light/client.ts` verifies both headers and then both legs, and additionally requires the two proofs to name the same index.

One subtlety: `count` is only bound through `heightFor(count)`. A proof for a 7-transaction block verifies equally with `count` set to 5, 6 or 8, since the tree shape is the same; it fails with 16 (the test's case) because the height differs. The root is the authority; `count` should be read as "a count consistent with the tree", not as a proven transaction count.

**`encodeTxProof`**/**`decodeTxProof`** and **`encodeResultProof`**/**`decodeResultProof`** are chained writer calls; the decoders cap siblings at 64. **`txProofToBytes`**, **`txProofFromBytes`**, **`resultProofToBytes`** and **`resultProofFromBytes`** wrap them with `encode` and `decode`, and the RPC sends proofs as hex of exactly these bytes so that "The RPC never re-serialises a proof" (`RPC-SYNC-PROOFS.md` section 3.2).

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

**`test/review.test.ts`, `rejects decoded validator sets with duplicate members, wrong order or a bad proposer index`** hand-encodes three malformed sets with the codec and asserts `ValidatorSet.decode` throws `/duplicate/`, `/out of order/` and `/proposer index/`. It is the regression for review finding 1. `refuses validator powers whose total a priority could not track` calls `create` with two validators of 2^63 each and expects `/total power/`: the sum is above `MAX_TOTAL_POWER`. The same file's `keeps per-block results so a repeated transaction proves its real outcome at each position` builds a block whose `dataHash` is `txsRoot([raw, raw])`, stores it with results `[ok, duplicate failure]`, and asserts a result proof for position 1 verifies and says `ok: false` (review finding 18).

**`test/txproof.test.ts`.** `proves inclusion against the data hash and rejects tampering` uses seven small transactions: the empty root is `EMPTY`; every position's proof verifies, survives a byte round-trip, and fails with a different transaction, a different index, `count: 16` ("a different tree height") and a root over six transactions; reversing the list changes the root. `proves results, including failures, against the results hash` does the same for results with every third one failing, and asserts flipping `ok` or appending to `error` breaks the proof.

**`test/engine.test.ts`.** `rejects a block from another protocol version` bumps `header.version` on a real block and asserts `validateBlockStructure` reports `/protocol version/`, and that the node's state version is `PROTOCOL_VERSION`. `refuses a genesis with no validators from either side` calls `genesisState` with no genesis validators and no override, and with an empty override, expecting `/no validators/`. `drops evidence older than the configured age by block time, and keeps young evidence` forges two conflicting prevotes with `voteSignBytes` and `signContext(chainId, 'vote')`, wraps them with `makeDuplicateVoteEvidence`, and checks that stale evidence is discarded and young evidence reaches every application.

**`test/recovery.test.ts`, `double-sign evidence is built, included in a block, and handed to the app`** forges two prevotes for different hashes from one validator, feeds them to consensus, and asserts evidence appears in the pool, is included, and reaches every application with the right height. `a validator restarted from disk resumes with its state, key guard and app intact` compares `blockHash` of stored blocks across nodes after a restart.

**`test/sync.test.ts`, `gossips evidence from a node that cannot propose, and decides a height from a fetched block`** adds `makeDuplicateVoteEvidence` on a full node and watches it reach a proposer by inventory.

**`test/store.test.ts`, `block store finds blocks by height and by hash on both backends`** builds `Block` and `Commit` values by hand with `ZERO_HASH` fields and checks `blockHash` lookups on the memory and LMDB stores.

**`test/genesis.test.ts`, `loads a genesis whose application state is in a file, and reaches the same app hash as an inline one`** writes a `genesis.json` with `genesisToJson` naming an `appStateFile`, loads it with `loadGenesisFile`, asserts the path is resolved absolute, `appState` is empty and the JSON contains no `"appState"`, and that an application built from the file reaches the same app hash as one built inline.

`headerHash` and `txHash` are used by `test/chain.test.ts`, `test/light.test.ts`, `test/rpc.test.ts`, `test/sync.test.ts` and `test/staking-net.test.ts` to compare blocks across nodes and to check proofs against the next header. The logger is exercised by every suite through `testLogger` in `test/helpers.ts`.

## Limitations and ideas

Known simplifications:

- `ValidatorSet.hash()` excludes priorities and the proposer index (`DESIGN.md` section 10). A state-syncing node checks that the sets it receives pick the proposers the chain actually used, and nothing more; review finding 8 records the residual risk.
- Only duplicate-vote evidence exists. Amnesia evidence is deferred (`DESIGN.md` section 10).
- Votes carry no timestamp, so there is no BFT time; block time is the proposer's word, bounded by validation's clock-drift window.
- Proposals carry whole blocks; there are no block parts, so a block must fit in one p2p frame.
- `decodeVote` and `decodeProposal` do not range-check `round`, `validatorIndex` or `polRound`; consensus does, after decoding.
- A `TxProof`'s `count` is bound only up to the tree height.
- `genesisFromJson` validates little; bad keys and powers surface later with less helpful messages.
- `src/types/state.ts` imports `EMPTY` from the database and `src/types/txproof.ts` imports `TxResult` from the application interface, so the types layer is not quite the bottom of the dependency graph.

Exercises:

1. Write a property test: for random sets of 2 to 20 validators with random powers, advance one step at a time for `1000 * totalPower` steps and assert each validator's share of proposals is within one of `power / totalPower`. Then do it with `incrementProposerPriority(k)` for random `k` and confirm the counts still match while the *sequence* differs.
2. Implement `proposerForRound(set, r)` as a pure function and test it against `Consensus.proposerAt` for rounds 0 to 50.
3. Add a `fullHash()` to `ValidatorSet` that covers priorities and the proposer index, and work out what the light client and state sync would need to change to use it instead of the proposer check.
4. Add a `timestamp` to `Vote` and `voteSignBytes`, collect the precommit timestamps in a commit, and compute Tendermint's BFT time (the power-weighted median). Decide what the header's `time` should then be.
5. Define an amnesia evidence type (a precommit for a block in round R from a validator that had prevoted nil in R while locked), with a canonical form, a shape check and a codec, mirroring `src/types/evidence.ts`.
6. Make `TxProof.count` provable: put the transaction count in the header, or into the leaf value, and update `pathMatches` and the tests.
7. Give `genesisFromJson` a schema check with clear messages and a test file of bad documents.
8. Make `makeLogger` emit JSON lines when `out` is not a terminal, keeping `fmt`'s rules for hashes and `bigint`s.

## Where to next

[Chapter 4](04-consensus.md) puts these types to work: the Tendermint state machine, how votes are tallied into quorums, the evidence pool, block validation, and the private validator with its double-sign guard.
