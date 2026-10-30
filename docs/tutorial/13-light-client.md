# 13. Light client

A light client verifies what a full node tells it without running the chain itself. It holds one header it trusts, moves that trust forward header by header or in jumps, walks backwards from it along the hash chain for earlier heights, and then checks any answer a node gives (an object, a name, a transaction and its result) against a header it has verified. The code sits on the building blocks of earlier chapters: headers, commits and validator sets from [types](03-types.md), `verifyCommit` from [consensus](04-consensus.md), the object and key proof verifiers from the [database](09-database.md) and the transaction proof verifiers from `src/types/txproof.ts`. It is fed by two providers, one reading a [node](08-node.md) in the same process and one speaking to the [RPC](12-rpc.md), and it feeds two consumers: state sync in [sync](07-sync.md), which runs `LightClient.trust` from an operator's anchor before importing a snapshot, and the [CLI](14-wallet-cli.md), whose `account`, `verify-tx` and `light` commands all go through it. Four files: `src/light/verify.ts` (the query shapes and standalone checks), `src/light/client.ts` (the client), `src/light/provider.ts` and `src/light/rpc-provider.ts` (the two providers).

## Concepts

**What a light client is.** A full node downloads every block, executes every transaction and keeps the whole state. A light client keeps headers only, and only as many as it needs, and relies on two facts: a header commits to everything in its block and in the state (through `dataHash`, `appHash`, `lastResultsHash`, `validatorsHash`, `nextValidatorsHash`), and a header signed by more than two thirds of the validators' voting power is final (chapter 4). So if the client can convince itself that a header is genuine, it can check any claim about the chain by checking a Merkle proof against that header. The idea goes back to Bitcoin's "simplified payment verification" (headers plus Merkle branches); in a proof-of-stake chain the hard part moves from "which chain has the most work" to "who are the validators right now", because signatures are only meaningful if you know whose they are. The Tendermint light client (the `light` package in CometBFT) is the design followed here, and `DESIGN.md` section 6 describes it in a paragraph: hold one trusted signed header with the validator sets around it, obtained from a height and hash trusted out of band, and move trust forward the Tendermint way.

**The trust anchor.** Nothing inside the chain can tell a brand-new client which validators are genuine; an attacker who once held keys can produce a plausible history. So the client starts from a height and header hash that the user got out of band (from a friend, a website, a block explorer, a config file) and checks that the provider's header at that height hashes to it and carries a valid commit. With no hash at all it accepts whatever the provider serves, which is trust on first use: good enough against a provider that turns bad later, useless against one that was bad from the start. The CLI does exactly this and records the anchor in `light.json`.

**Validator sets by hash and the H+2 pipeline.** A header names two sets: `validatorsHash` is the set that signs this header, and `nextValidatorsHash` is the set that signs the next one (chapter 3 and chapter 4 explain why updates take effect with a delay). The [store](10-store.md) keeps every set that was ever named, by hash, so a provider can answer "give me the set with this hash" for any header it serves. The client therefore holds a `TrustedState`: a signed header plus `validators` (who signed it) and `nextValidators` (who the header promises will sign the next one).

**Sequential verification.** To go from height H to H+1 there is no uncertainty: the trusted header at H already told us who signs H+1. The client checks that the candidate's set hashes to `trusted.nextValidatorsHash`, that its `lastBlockHash` is the trusted header's hash (so it extends the chain the client knows), and that its commit is signed by more than two thirds of that set.

**Skipping verification and bisection.** Going one header at a time costs a header, a commit and up to two validator sets per height, each commit carrying one signature per validator, 2,421 bytes on an ML-DSA-44 chain (65 on a secp256k1 one); a client that is a week behind would download the week. Tendermint's skipping rule lets the client jump: a header at any later height is accepted if (a) more than two thirds of *its own* validator set signed it, which is just a valid commit, and (b) the validators that signed it include more than a third of the voting power of the set the client already trusts for the next height. Why a third: the fault assumption of Tendermint is that less than a third of the trusted set is faulty, so more than a third of trusted power on a header means at least one honest validator signed it, and honest validators sign only the real chain. When condition (b) fails because the set changed too much, the client does not give up; it tries a header halfway between the trusted height and the target, which has a set closer to the one it trusts, and repeats. That is bisection. Each successful step moves the trusted state forward, so the next attempt measures overlap against a newer set. The test in `test/light.test.ts` arranges a validator set that changes so much that one jump is impossible and watches the client take more than one step.

**The trusting period.** Signatures from a validator set are only worth something while that set can be punished. A validator that has unbonded (chapter 11's staking rules) has no stake left to slash, so once the unbonding period has passed its old key could sign a fabricated header for free; this is the "long-range attack". The light client therefore refuses to extend trust from a header older than a `trustingPeriodMs`, which must be shorter than the chain's unbonding period, so that any header it accepts is signed by validators who could still be slashed if the signature turns out to be a lie. Two more time checks come with it: a header may not be from the future beyond a clock-drift allowance, and header times must increase. The anchor itself is held to the same rules: `trust` refuses a header that is as old as the period or older, and one that is from the future. Review finding 22 notes the coupling: the engine's evidence age now follows the unbonding period after every commit, while "the light client's trusting period remains the client's choice", and `DESIGN.md` section 10 lists that as a known simplification. The default is four days; the testnet's unbonding period is seven.

**Verified queries and why the next header.** Execution is deferred (chapter 4, chapter 11): the state after block N is committed by the `appHash` in header N+1, and the results of block N's transactions by `lastResultsHash` in header N+1. So a node answering "here is account 3.1 at height N, with a proof" must also hand over header N+1, and the client must check the proof against header N+1's app hash. But the header the node hands over is itself unverified. The client's rule is: verify header N+1 yourself (moving trust forward if needed), then compare its hash with the header the node sent, then check the proof. A node that fabricates a state tree can produce a matching proof and a matching header, but it cannot produce a commit on that header from the real validators, and the client's own copy of header N+1 came with such a commit. Review finding 23 is the cautionary tale: the CLI once verified a name proof against an app hash supplied by the same RPC it was asking, with no anchor, and would print "verified" for invented state.

**Backward verification.** Moving trust forward needs commits, because nothing in the trusted header says who signs the future. Going backwards needs none. Every header carries `lastBlockHash`, the hash of the header before it, so a trusted header at H names header H-1 by hash, which names H-2, and so on down to genesis: a signed header is a commitment to the whole chain before it. To reach height H-k the client fetches header H-1, checks that it hashes to the trusted header's `lastBlockHash`, then does the same for H-2 against H-1, one header per step, with no commit and no validator set at any of them. What this proves is exactly what forward verification proves about a header: that it is the header at that height of the chain the trusted header belongs to. What it does not need to prove is that the signers of those heights could still be slashed, because the trusted header's own signers vouch for them. The walk is sequential (there is no skipping rule for hashes), so a height far below the anchor costs that many headers; `maxBackwardSteps` bounds it, and the headers passed are remembered so the next walk to a nearby height is short. The CLI relies on this: its saved anchor moves forward with every run, and `verify-tx` for an old transaction walks back from it.

**Three kinds of proof.** An *object proof* (`ObjectProof`, chapter 9) shows that an id holds a given encoding, or nothing, at a height, through its type's dense tree and the top tree to the app hash. A *key proof* (`KeyProof`) shows what an authenticated index says about a key: the account name index maps a name to an 8-byte id or proves no account has it. A *transaction proof* (`TxProof`) shows a transaction's position in its block under `dataHash`, and a *result proof* (`ResultProof`) shows its `ok` and `error` under the next header's `lastResultsHash` (`RPC-SYNC-PROOFS.md` section 2.2). The light client has one method per kind: `verifyState`, `verifyKey`, `verifyTx`.

**Duplicate validators.** The overlap computation walks the commit's signature slots and adds the trusted power of each signer. If a validator set could contain the same key twice, one trusted key could count twice; review finding 1 reproduced exactly that with a fabricated future set. The fix lives in `ValidatorSet` (chapter 3): both the binary decoder and `create` reject duplicates, so every set the client ever holds has unique members.

## The code, file by file

`verify.ts` comes first because `client.ts` imports its types; then the client; then the two providers, which implement the client's `LightProvider` interface.

### src/light/verify.ts

Purpose: the shapes of the three query answers and standalone verifiers that take the validator sets as arguments. The file comment is precise about the division of labour: "Tracking the validator set from header to header (the Tendermint light client's job) is not done here; the caller supplies the set it trusts for the header's height."

**`StateQueryResult`** is `{ proof: ObjectProof, header, commit }` where the comment on `header` says it all: "Header of block proof.height + 1, whose appHash commits to the proven state." **`KeyQueryResult`** is the same with a `KeyProof`. **`TxQueryResult`** carries the transaction leg (`txProof`, `header`, `commit`) and the result leg (`resultProof`, `nextHeader`, `nextCommit`), the latter three `null` until the next block exists. These are what `node.queryState`, `node.queryAccountName` and `node.queryTx` build (chapter 8) and what the RPC's `object`, `account` and `tx` methods serve in pieces.

**`TxVerdict`** is a three-way answer:

```ts
export type TxVerdict = { ok: boolean; error: string } | null | { failed: true; error: string };
```

An object with `ok` is a verified result; `null` means inclusion was verified but no result is provable yet; `failed: true` means something did not check out. Callers must distinguish the first and the third by the `failed` key, which is what the CLI does with `'failed' in verdict`.

**`verifyTxQuery(chainId, q, validators, nextValidators, verifier)`** checks everything about a transaction query given the sets the caller trusts for its two headers:

```ts
export async function verifyTxQuery(chainId: string, q: TxQueryResult, validators: ValidatorSet, nextValidators: ValidatorSet | null, verifier: Verifier): Promise<TxVerdict> {
  if (q.header.chainId !== chainId || q.header.height !== q.txProof.height) return { failed: true, error: 'header does not match the proof' };
  const commitError = await verifyCommit(chainId, validators, headerHash(q.header), q.commit, verifier);
  if (commitError) return { failed: true, error: `commit: ${commitError}` };
  if (!verifyTxProof(q.header.dataHash, q.txProof)) return { failed: true, error: 'transaction is not in the block' };
  if (!q.resultProof || !q.nextHeader || !q.nextCommit || !nextValidators) return null;
  if (q.nextHeader.height !== q.header.height + 1n || !bytesEqual(q.nextHeader.lastBlockHash, headerHash(q.header))) return { failed: true, error: 'next header does not follow' };
  const nextError = await verifyCommit(chainId, nextValidators, headerHash(q.nextHeader), q.nextCommit, verifier);
  if (nextError) return { failed: true, error: `next commit: ${nextError}` };
  if (q.resultProof.index !== q.txProof.index || !verifyResultProof(q.nextHeader.lastResultsHash, q.resultProof)) return { failed: true, error: 'result is not the one committed' };
  return { ok: q.resultProof.ok, error: q.resultProof.error };
}
```

Read the checks in order: the header is for this chain and this height; its commit is signed by the trusted set (`verifyCommit` from chapter 4 checks the block hash, the signature count against the set size, the +2/3 quorum and every signature through the `Verifier`, whose `verify` reads the scheme from the tag each key and signature carries, so the client needs no setting for it); the transaction is under `dataHash`; then, if the result leg is present, the next header really follows (height and `lastBlockHash`), its commit is signed by the next set, and the result proof is for the same index and folds to `lastResultsHash`. The index check matters: a block can contain the same bytes twice, and a result proof for the other position would otherwise pass.

**`verifyHeaderAndCommit`** (not exported) is the shared head of the two state verifiers: chain id, `header.height === provenHeight + 1n`, and a valid commit by the given set. **`verifyStateQuery(chainId, q, validators, verifier)`** returns a problem string or `null`, adding `verifyObjectProof(q.header.appHash, q.proof)`. **`verifyKeyQuery(...)`** returns `{ value }` or `{ error }`, where `verifyKeyProof` returns the proven value, `null` for a proven absence, or `undefined` when the proof does not fold to the app hash; the function turns `undefined` into an error and keeps `null` as a legitimate answer. A reader should notice that absence is a positive result here: "no account named bob" is something the chain can prove.

These functions exist so that code which already knows the validator sets (the chain test, which reads them from the executor; a node doing state sync) can verify without a client, and so that the client's own methods stay short.

### src/light/client.ts

Purpose: hold a trusted state and move it forward safely; verify queries against it.

**`SignedHeader`** is `{ header, commit }`. **`LightProvider`** is the interface both providers implement:

```ts
/** Where headers and validator sets come from: a full node, over whatever transport. */
export interface LightProvider {
  latestHeight(): Promise<bigint>;
  signedHeader(height: bigint): Promise<SignedHeader | null>;
  validatorSet(hash: Uint8Array): Promise<ValidatorSet | null>;
  /** A header alone, for walking the hash chain backwards; without it the signed header's is used. */
  header?(height: bigint): Promise<Header | null>;
}
```

Three required calls, all answerable from a block store that keeps sets by hash, and an optional fourth: `header` returns a header without its commit, which is all a backward step needs, and lets a provider serve heights for which it holds no block, as a state-synced node does below its snapshot (chapter 10's header records). A provider without it still works; the client takes the header out of `signedHeader` instead. **`TrustedState`** extends `SignedHeader` with `validators` ("The set that signed this header") and `nextValidators` ("The set that signs the next height"). **`LightClientOptions`** takes the `chainId`, a `provider`, a `verifier` (chapter 2's inline or worker verifier), and optional `trustingPeriodMs`, `maxClockDriftMs`, a `now` function, the last for tests, and `maxBackwardSteps`, how far below the trusted height backward verification will walk. `INSUFFICIENT_TRUST` is the one error string the bisection loop treats as "try a nearer height" rather than "fail"; `MAX_BACKWARD_CACHE` (10,000) is how many headers verified backwards the client remembers before starting over.

**`LightClient`** has a private constructor; instances come from the static `trust`:

```ts
  static async trust(opts: LightClientOptions, height: bigint, expectedHash?: Uint8Array): Promise<LightClient> {
    const o: Required<LightClientOptions> = {
      trustingPeriodMs: 4n * 24n * 3_600_000n,
      maxClockDriftMs: 10_000n,
      now: () => BigInt(Date.now()),
      maxBackwardSteps: 100_000,
      ...opts,
    };
    const client = new LightClient(o, null as unknown as TrustedState);
    const s = await client.fetch(height);
    if (expectedHash && !bytesEqual(headerHash(s.header), expectedHash)) throw new Error(`header ${height} does not have the trusted hash`);
    // An anchor outside the trusting period could be signed by a set that has since unbonded, and one from the future is not a header yet.
    const now = o.now();
    if (now - s.header.time >= o.trustingPeriodMs) throw new Error(`header ${height} is older than the trusting period`);
    if (s.header.time > now + o.maxClockDriftMs) throw new Error(`header ${height} is from the future`);
    const err = await verifyCommit(o.chainId, s.validators, headerHash(s.header), s.commit, o.verifier);
    if (err) throw new Error(`initial header ${height}: ${err}`);
    client.trusted = s;
    return client;
  }
```

Defaults: a four-day trusting period, ten seconds of clock drift and 100,000 backward steps. The anchor is checked four times: its hash against what the user supplied (when supplied), its age against the trusting period, its time against the clock, and its commit against the set the header names for itself. The age check is `>=`, the same comparison `timeProblem` makes for every later step, so an anchor that is exactly one trusting period old is already too old; there is no instant at which `trust` accepts a header that the next verification would refuse. The time checks come before the commit check because they are cheap and because they decide whether the commit means anything: a set that has since unbonded could have signed the anchor for free, which is the long-range attack from the Concepts section, and `REVIEW-2026-10-28.md` finding 43 records that `trust` once skipped the age check, so a stale anchor was accepted until the first verification step. A header dated beyond the client's clock plus the drift allowance is not a header the chain has produced yet; `timeProblem` refuses such a header at every step, and an anchor is only the first step. The commit check catches a provider that serves a header with a commit that does not fit it; it cannot catch a provider that fabricated both header and commit with keys it controls, which is what the hash is for.

The client exposes `trusted` (mutable, the current `TrustedState`) and `verifiedHeights`, a list of every height it accepted moving forward, in order, "for inspection"; the tests use it to see bisection happen. A private `backward` map holds the headers verified backwards, by height.

**`fetch(height)`** (private) asks the provider for the signed header and both validator sets, checks that the header and its commit are for the height that was asked, and checks that each set hashes to what the header names:

```ts
  private async fetch(height: bigint): Promise<TrustedState> {
    const sh = await this.o.provider.signedHeader(height);
    if (!sh) throw new Error(`provider has no header ${height}`);
    if (sh.header.height !== height || sh.commit.height !== height) throw new Error(`provider answered height ${height} with header ${sh.header.height}`);
    if (sh.header.chainId !== this.o.chainId) throw new Error(`header ${height} is for chain ${sh.header.chainId}`);
    const validators = await this.o.provider.validatorSet(sh.header.validatorsHash);
    const nextValidators = await this.o.provider.validatorSet(sh.header.nextValidatorsHash);
    if (!validators || !bytesEqual(validators.hash(), sh.header.validatorsHash)) throw new Error(`provider did not supply the validator set of header ${height}`);
    if (!nextValidators || !bytesEqual(nextValidators.hash(), sh.header.nextValidatorsHash)) throw new Error(`provider did not supply the next validator set of header ${height}`);
    return { ...sh, validators, nextValidators };
  }
```

The hash check is what binds a set to a header: a provider can send any set it likes, but only the real one hashes to the value in the header, and the header is about to be checked against a commit. The height check binds the header to the request, and it matters because every other check would pass without it. A provider that answers "height 4" with the chain's genuine header 5 and its genuine commit offers nothing a commit check can object to; the signatures are real. What goes wrong is everything the client does with the header afterwards: `verifyToHeight` would record the pivot it asked for while holding a header of another height, so the loop's bookkeeping drifts from the headers it holds, and `verifyState` would compare a query's "header N+1" against what it believes is its own verified N+1, letting the provider pair a proof labelled height N with the app hash of some other height and have the client vouch for state at a height it never checked. Pinning `header.height` and `commit.height` to the height asked for closes that: a header the client holds under a height is a header of that height. Every error from `fetch` is a thrown `Error`; the client makes no attempt to try another provider.

**`timeProblem(trusted, candidate)`** applies the three time rules, in the order trusting period, future, monotonic:

```ts
private timeProblem(trusted: TrustedState, candidate: TrustedState): string | null {
  const now = this.o.now();
  if (trusted.header.time + this.o.trustingPeriodMs <= now) return 'trusted header is older than the trusting period';
  if (candidate.header.time > now + this.o.maxClockDriftMs) return 'header is from the future';
  if (candidate.header.time <= trusted.header.time) return 'header time does not advance';
  return null;
}
```

**`verifyAdjacent(trusted, c)`** is sequential verification:

```ts
/** The next height: the trusted header named its validator set. */
private async verifyAdjacent(trusted: TrustedState, c: TrustedState): Promise<string | null> {
  if (!bytesEqual(c.validators.hash(), trusted.header.nextValidatorsHash)) return 'validator set is not the one the trusted header named';
  if (!bytesEqual(c.header.lastBlockHash, headerHash(trusted.header))) return 'header does not extend the trusted one';
  return (await verifyCommit(this.o.chainId, c.validators, headerHash(c.header), c.commit, this.o.verifier)) ?? this.timeProblem(trusted, c);
}
```

**`verifySkipping(trusted, c)`** is the jump:

```ts
/** A later height: its own set signed it, and enough of the set we trust is among the signers. */
private async verifySkipping(trusted: TrustedState, c: TrustedState): Promise<string | null> {
  const err = await verifyCommit(this.o.chainId, c.validators, headerHash(c.header), c.commit, this.o.verifier);
  if (err) return err;
  const known = trusted.nextValidators;
  let overlap = 0n;
  c.commit.signatures.forEach((sig, i) => {
    if (sig === null) return;
    const v = c.validators.byIndex(i);
    const idx = v ? known.indexOf(v.address) : -1;
    if (idx >= 0) overlap += known.byIndex(idx)!.power;
  });
  if (3n * overlap <= known.totalPower) return INSUFFICIENT_TRUST;
  return this.timeProblem(trusted, c);
}
```

Two details. The set compared against is `trusted.nextValidators`, not `trusted.validators`: the trusted header promised that set for the height after it, so it is the most recent set the client can vouch for. And the power added is the signer's power *in the trusted set* (`known.byIndex(idx)!.power`), not in the candidate's; a validator whose power grew in the meantime does not get to vouch with power nobody trusted yet. The quorum arithmetic mirrors `ValidatorSet.isOneThird`: strictly more than a third. The order of checks (commit first, overlap second, time last) means a header with an invalid commit is reported as such, and `INSUFFICIENT_TRUST` is only returned for a header that is genuinely signed by its own set.

**`verifyToHeight(target)`** drives both:

```ts
/** Move trust forward to `target`, bisecting where the validator set changed too much to skip. */
async verifyToHeight(target: bigint): Promise<TrustedState> {
  let cur = this.trusted;
  if (target < cur.header.height) throw new Error(`height ${target} is before the trusted height ${cur.header.height}`);
  while (cur.header.height < target) {
    let pivot = target;
    for (;;) {
      const candidate = await this.fetch(pivot);
      const adjacent = pivot === cur.header.height + 1n;
      const err = adjacent ? await this.verifyAdjacent(cur, candidate) : await this.verifySkipping(cur, candidate);
      if (err === null) {
        cur = candidate;
        this.verifiedHeights.push(pivot);
        break;
      }
      if (err !== INSUFFICIENT_TRUST || adjacent) throw new Error(`header ${pivot}: ${err}`);
      pivot = cur.header.height + (pivot - cur.header.height) / 2n;
    }
  }
  this.trusted = cur;
  return cur;
}
```

The outer loop advances `cur` until it reaches the target; the inner loop tries the target, then halves the distance on `INSUFFICIENT_TRUST` until something verifies. Halving always terminates because the distance shrinks to 1, at which point the adjacent rule applies and either succeeds or throws. The client's `trusted` is only replaced at the end, but `cur` and `verifiedHeights` advance step by step, so an exception midway leaves `trusted` where it was while `verifiedHeights` records the steps that did succeed. A target equal to the trusted height returns at once. A target before the trusted height is refused here: moving trust is forward only, and an earlier height is `verifyBackward`'s job, below.

A trace makes the loop concrete. Suppose the client trusts height 2, whose `nextValidators` are four validators of power 10, and is asked for height 40, by which time a fifth validator of power 100 has joined and the original four have left (the situation `test/light.test.ts` constructs, with heights made up here):

1. `pivot = 40`. `fetch(40)`: header, commit and both sets. `verifySkipping`: the commit is valid for 40's own set, but of the four trusted validators none signed, so `overlap = 0` and `3n * 0n <= 40n` returns `INSUFFICIENT_TRUST`. Not adjacent, so `pivot = 2 + (40 - 2) / 2n = 21`.
2. `fetch(21)`: say the fifth validator has joined but nobody has left, so the set is five with total power 140. The four trusted validators signed: `overlap = 40` against `known.totalPower = 40` (the *trusted* set's total), `3n * 40n > 40n`, accepted. `cur` becomes 21, `verifiedHeights = [21]`.
3. Back to the outer loop with `pivot = 40` again. Now `known` is 21's `nextValidators` (the five). At 40 the fifth validator signed with power 100 of a trusted total of 140: `3n * 100n > 140n`, accepted. `cur` becomes 40, `verifiedHeights = [21, 40]`, and `trusted` is set.

Had step 2 also failed, the pivot would have gone to `2 + 19n / 2n = 11`, then 6, 4, 3, and at 3 the adjacent rule would decide. Each fetched height costs the provider four calls, so this run made three fetches and twelve calls; the sequential alternative from 2 to 40 would have made thirty-eight fetches.

**`verifyLatest()`** is `verifyToHeight(await provider.latestHeight())`.

**`verifyBackward(target)`** is the walk down the hash chain:

```ts
  private async headerOnly(height: bigint): Promise<Header | null> {
    if (this.o.provider.header) return this.o.provider.header(height);
    return (await this.o.provider.signedHeader(height))?.header ?? null;
  }

  /**
   * A height at or before the trusted one, reached by walking the hash chain down from the trusted header: each header
   * must hash to what the one above it names as its last block hash. No commit is checked on the way, since the
   * trusted header already stands for the whole chain before it. The headers passed are remembered, so the next
   * walk to a nearby height is short.
   */
  async verifyBackward(target: bigint): Promise<Header> {
    const top = this.trusted.header;
    if (target < 1n) throw new Error(`height ${target} is not a block`);
    if (target > top.height) throw new Error(`height ${target} is after the trusted height ${top.height}`);
    if (top.height - target > BigInt(this.o.maxBackwardSteps)) throw new Error(`height ${target} is more than ${this.o.maxBackwardSteps} headers before the trusted height ${top.height}; trust a header nearer to it first`);
    let cur = top;
    while (cur.height > target) {
      const h = cur.height - 1n;
      const prev = this.backward.get(h) ?? (await this.headerOnly(h));
      if (!prev) throw new Error(`provider has no header ${h}`);
      if (prev.height !== h) throw new Error(`provider answered height ${h} with header ${prev.height}`);
      if (!bytesEqual(headerHash(prev), cur.lastBlockHash)) throw new Error(`header ${h} is not the one header ${cur.height} names`);
      if (this.backward.size >= MAX_BACKWARD_CACHE) this.backward.clear();
      this.backward.set(h, prev);
      cur = prev;
    }
    return cur;
  }
```

Three refusals up front: height 0 is not a block, a height after the trusted one is forward verification's business, and a height more than `maxBackwardSteps` below it is refused with advice to trust a nearer header first, since the walk is one provider call per height and a client asked for height 10 from an anchor at ten million would otherwise make ten million of them. Then the loop, from the trusted header down. Each step takes the header below from the cache or the provider (`headerOnly` prefers the provider's `header` call and falls back to the signed header's), pins it to the height asked for, exactly as `fetch` does and for the same reason, and checks the one thing that matters: its hash is the `lastBlockHash` of the header above it. That check is the whole proof. A header that passes it is the header the chain's next header named, and that next header was either the trusted one or passed the same check against its own successor, so the chain of hashes runs unbroken from the target up to a header whose commit the client verified. No commit is fetched and no validator set is needed, which is why a state-synced node that holds only headers below its snapshot can serve the walk. Every header passed is cached by height, so verifying a transaction at H-50 and then one at H-49 costs fifty calls and then none; the cache is simply cleared when it reaches `MAX_BACKWARD_CACHE` entries, after which the next walk starts over from the trusted header. The trusted state itself never moves: backward verification returns a `Header`, not a `TrustedState`, because nothing about the validator sets at that height was checked and nothing needs to be.

**`verifiedHeader(height)`** (private) is the dispatcher the three query methods call:

```ts
  /** The header the client has verified for a height: trust moves forward for a later one, and walks back for an earlier one. */
  private async verifiedHeader(height: bigint): Promise<Header> {
    if (height === this.trusted.header.height) return this.trusted.header;
    if (height < this.trusted.header.height) return this.verifyBackward(height);
    return (await this.verifyToHeight(height)).header;
  }
```

The trusted header for its own height; a walk back for an earlier one; forward verification, which moves the trusted state, for a later one. A query method never needs to know which way the client went.

**`verifyState(q)`** and **`verifyKey(q)`** apply the next-header rule:

```ts
/** Check a node's answer to a state query. Returns a problem, or null. */
async verifyState(q: StateQueryResult): Promise<string | null> {
  const header = await this.verifiedHeader(q.proof.height + 1n);
  if (!bytesEqual(headerHash(header), headerHash(q.header))) return `header ${q.header.height} is not the verified one (${toHex(headerHash(header)).slice(0, 12)})`;
  return verifyObjectProof(header.appHash, q.proof) ? null : 'proof does not lead to the app hash';
}
```

`verifiedHeader(q.proof.height + 1n)` is the whole point: the client fetches and verifies header N+1 through its own provider and trust chain, and only then compares it with the one in the query. The proof is checked against *the client's* header's `appHash`, which is the same bytes once the hashes match, but the direction of trust is the right way round. Notice that `q.commit` is not used by the client: it has its own verified copy. The commit field is there for the standalone `verifyStateQuery`, which has no provider. `verifyKey` is identical with `verifyKeyProof` and returns `{ value }` (with `null` for absence) or `{ error }`.

**`verifyTx(q)`** does the two legs:

```ts
/** Check a transaction query: inclusion against its header, result against the next. Null means only inclusion is provable yet. */
async verifyTx(q: TxQueryResult): Promise<TxVerdict> {
  const header = await this.verifiedHeader(q.txProof.height);
  if (!bytesEqual(headerHash(header), headerHash(q.header))) return { failed: true, error: `header ${q.header.height} is not the verified one` };
  if (!verifyTxProof(header.dataHash, q.txProof)) return { failed: true, error: 'transaction is not in the block' };
  if (!q.resultProof || !q.nextHeader) return null;
  const next = await this.verifiedHeader(q.txProof.height + 1n);
  if (!bytesEqual(headerHash(next), headerHash(q.nextHeader))) return { failed: true, error: 'next header is not the verified one' };
  if (q.resultProof.index !== q.txProof.index || !verifyResultProof(next.lastResultsHash, q.resultProof)) return { failed: true, error: 'result is not the one committed' };
  return { ok: q.resultProof.ok, error: q.resultProof.error };
}
```

Inclusion is checked against header H (where the transaction's bytes are under `dataHash`), the result against header H+1. Unlike `verifyTxQuery`, there is no explicit "next header follows" check, because the two headers come from `verifiedHeader`, and whichever way it went for each, they are both on the client's own chain: a header reached forward extends it, and one reached backward hashes into it. A long-lived client that has verified to the tip can still verify an old transaction, since `verifiedHeader(H)` for an H below the trusted height is a backward walk, and so can a client whose anchor is after the transaction: nothing below the anchor is out of reach, only bounded by `maxBackwardSteps`. The CLI constructs a fresh client from its saved anchor on every run, and the anchor it saves is the newest header the previous run verified, so each run starts where the last one ended and walks back for anything older. The anchor is held to `trust`'s own rules: one at or beyond the trusting period, or one dated in the future beyond the drift allowance, is refused on reload rather than silently accepted, so a `light.json` left over from a long absence makes the next run fail with a clear message instead of extending trust from a header that could by now have been signed for free.

### src/light/provider.ts

Purpose: a provider for a node in the same process, "what an RPC client would do over the wire, without the wire".

**`NodeProvider`** implements the calls directly on the node: `latestHeight` is `node.height`, `signedHeader` is `store.loadBlock(height)` reshaped to `{ header, commit }` or `null`, `header` is the stored block's header or, failing that, `store.loadHeader(height)`, a header the node keeps without its block (chapter 10), and `validatorSet` is `store.loadValidatorSet(hash)`. The file comment explains why the store can answer every lookup: "Every validator set a header can name was saved by hash when it became the next set." The tests use it to run a light client against a node without an RPC server, and `src/sync/statesync.ts` uses a provider of its own over p2p requests with the same interface.

### src/light/rpc-provider.ts

Purpose: the same calls over JSON-RPC, using the client from chapter 12.

```ts
export class RpcProvider implements LightProvider {
  private readonly rpc: RpcClient;

  constructor(rpc: RpcClient) {
    this.rpc = rpc;
  }

  async latestHeight(): Promise<bigint> {
    return BigInt((await this.rpc.status()).latestHeight);
  }

  async signedHeader(height: bigint): Promise<SignedHeader | null> {
    try {
      const [h, c] = await Promise.all([this.rpc.header(height), this.rpc.commit(height)]);
      return { header: headerFromJson(h), commit: commitFromJson(c) };
    } catch (e) {
      if ((e as { code?: number }).code === -32001) return null;
      throw e;
    }
  }

  async header(height: bigint): Promise<Header | null> {
    try {
      return headerFromJson(await this.rpc.header(height));
    } catch (e) {
      if ((e as { code?: number }).code === -32001) return null;
      throw e;
    }
  }
```

In `signedHeader`, `header` and `commit` are fetched in parallel and decoded with the shape-specific decoders from `src/rpc/json.ts`; the provider's own `header` fetches the header alone, through the RPC method that serves a header kept without its block as well (chapter 12); `validatorSet` calls the `validatorSet` method by hex hash and rebuilds the set with `validatorSetFromJson`. In all three, the RPC's not-found code (`-32001`) becomes `null`, which the client turns into "provider has no header"; any other error (network, rate limit, parse) propagates. A set that comes back from JSON is rebuilt with `ValidatorSet.create`, which recomputes addresses from the public keys and rejects duplicates, so the hash the client then compares against the header is computed from what was actually received, not copied from the response. The provider makes four RPC calls per fetched height going forward (status aside) and one per header going backward, and caches nothing itself; a bisection that touches many heights pays for each, while the backward walk is cached in the client.

## How it is tested

`test/light.test.ts`, "follows a validator set that changes beyond the trust level by bisecting", runs the engine with the key-value test application on four validators of power 10 and one full node. A fifth node restarts with a validator key and is voted in with power 100; then the first three validators are removed, leaving two. A client trusting height 2 (the original four) verifies to the tip and ends with a set of two. The assertions: `verifiedHeights` has more than one entry, so one jump was not enough (whoever trusts the genesis set sees only a quarter of its power among the final signers); the heights are strictly increasing and end at the target; sequential verification to `target + 1` and `verifyLatest` both work from there. A "liar" provider that serves the real header for `target + 2` with its `appHash` zeroed, next to the real commit with its `blockHash` rewritten to the forged header's hash, is rejected with an error matching commit, signature or power: the commit now names the forged block, so the only thing left to catch it is that the signatures were made over the genuine hash, and `verifyCommit` catches exactly that. With `trustingPeriodMs: 1n`, `LightClient.trust` itself rejects the anchor with "trusting period", before any verification step.

`test/chain.test.ts`, "gossips signed transactions, agrees on state, and proves it against the next header", runs the core application on four validators and a full node, creates alice and pays her, and then: a `queryState` for alice at height `h` carries header `h + 1`; `verifyStateQuery` with the set for `h + 1` returns `null`; the same query with `value: null` (claiming absence) fails with a proof error; with header and commit of height `h` instead of `h + 1` it fails with a height error; a query for an earlier height verifies against its own next header, and the default latest query too; `verifyKeyQuery` on `queryAccountName('alice')` yields the 8-byte id and on `'bob'` yields `{ value: null }`, a proven absence. A `LightClient` trusting height 2 through the full node's `NodeProvider` verifies the state query (`verifyState` returns `null` and the trusted height moves to `h + 1`), verifies the key query, and rejects a query whose header has a zeroed `appHash` with "not the verified one"; a wrong trust hash is refused. For transactions, `queryTx` of the transfer has a result proof; `verifyTxQuery` accepts it as `{ ok: true, error: '' }` and rejects it with the transaction bytes swapped for another transaction's; a fresh client's `verifyTx` returns the same verified result.

`test/rpc.test.ts`, "serves a light client over the RPC", does the trust-and-verify sequence through `RpcProvider` against a live `RpcServer`: `verifyLatest` reaches the height `status` reports, a name proof fetched with `account('faucet', true)` verifies with header `height + 1` and commit from the same RPC, and a wrong anchor hash is refused. "broadcasts in sync and commit mode, finds transactions with proofs, and records history" runs `verifyTxQuery` on a proof that travelled as JSON through `txQueryFromJson`.

`test/staking-net.test.ts`, "owns the validator set: delegation raises power, a stopped validator is jailed, and it returns after unjail", ends with a light client that trusted height 2 following the whole sequence (a validator jailed for downtime and unjailed) to a latest header signed by the set of four, and verifying a `queryAccountName('op3')` key proof against it.

`test/review.test.ts`, "rejects decoded validator sets with duplicate members, wrong order or a bad proposer index", is the regression for finding 1, the forged-overlap attack on `verifySkipping`. "refuses a light client anchor older than the trusting period" is the regression for finding 43: on a two-validator chain at height 3, `trust` at height 2 with `trustingPeriodMs: 1n` rejects with "trusting period", and the same anchor with the default period is accepted at height 2.

`test/review2.test.ts`, "binds a served header to the height asked for and refuses an anchor from the future": on a four-validator chain, a client trusts height 2 through an honest `NodeProvider`, then has its provider swapped for one whose `signedHeader(h)` answers with the genuine header `h + 1`; `verifyToHeight(4)` must fail with "answered height 4 with header 5", since the commit on that header is perfectly valid and only the height check can tell it was not the header asked for. Then two anchor refusals: with a `now` sixty seconds before the anchor's own time, `trust` rejects it as "from the future", and with a ten-second trusting period and a `now` exactly ten seconds after the anchor's time, it rejects it as outside the "trusting period", one period old being already too old. Then backward verification: a client anchored at height 4 walks back to 2 with `verifyBackward` and gets the header whose hash the honest anchor at 2 had; height 0 is refused as "not a block" and height 5 as "after the trusted height"; a provider whose `header` answers height 3 with the real header's `appHash` zeroed is caught with "header 3 is not the one header 4 names", since the altered header no longer hashes to what header 4 names; and a client with `maxBackwardSteps: 1` refuses the two-step walk with "more than 1 headers before".

`test/sync.test.ts` exercises the client at both ends of a join. "joins from a snapshot" runs `LightClient.trust` indirectly: a node joining from a snapshot runs the light client from its anchor to the snapshot height over p2p before importing (chapter 7). "applies evidence for a height before its join" ends with a client anchored at the joiner's tip, through a `NodeProvider` on the joiner, verifying with `verifyState` a query for the faucet at height 3 answered by validator 0: the joiner holds no block below its snapshot, only the headers state sync fetched, and the walk back to header 4 goes through those records.

## Limitations and ideas

- One provider, no witnesses. The Tendermint light client cross-checks a header against several providers and reports a conflicting header as evidence (the "detector"); this client trusts whichever provider it was given and throws on the first problem. Nothing here produces or submits evidence.
- No persistence in the library. The client is in-memory; the CLI saves `{ height, hash }` in `light.json` and rebuilds a client from it each run, re-verifying the anchor's commit every time.
- The trusting period is a constant the caller chooses (`DESIGN.md` section 10); nothing ties it to the chain's unbonding period.
- Backward verification is sequential: one header per step, with no skipping rule, so a query about height 100 from a client trusting height 100,100 fetches ten thousand headers, and one further back than `maxBackwardSteps` is refused. The cache is cleared outright when full, not trimmed.
- Every forward `fetch` costs four provider calls and nothing is cached; a bisection over a long range re-fetches validator sets that have not changed.
- `verifyState` and `verifyKey` ignore `q.commit`; it is carried for the standalone verifiers only.
- Fault assumption: a set in which more than a third of trusted power is dishonest can fool skipping verification, as in Tendermint. That is the price of jumping.

Exercises:

1. Add a second provider as a witness: after a successful `verifyToHeight`, fetch the same height from the witness and compare hashes. Decide what to do when they differ.
2. Persist the trusted state in the client (a `store` option with `load` and `save`), and make the CLI use it instead of `light.json`.
3. Read the chain's `unbondingPeriodMs` from the RPC's `parameters` method and refuse a trusting period that is not shorter.
4. Cache validator sets by hash inside `RpcProvider` and count how many RPC calls the bisection test saves.
5. Backward verification walks one header per step. Work out what a provider would have to serve, and what the client would check, to let it reach H-k from H in fewer than k steps without fetching any commit; then decide whether the chain would need a new header field for it.
6. Build evidence: when a provider serves a header at a verified height whose hash differs from the trusted one, collect both commits and look at `src/types/evidence.ts` to see what the chain would need to punish the signers.

## Where to next

The [wallet and CLI](14-wallet-cli.md) put the RPC client, the keystore and this light client together into commands a person can run.
