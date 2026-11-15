# 11. The application

This chapter is about the part of the node that gives the chain its meaning: accounts, assets, balances, fees, and the staking rules that decide who the validators are. The engine from the earlier chapters never looks inside a transaction; it hands bytes to the application through the `Application` interface described in [chapter 05](05-mempool-executor.md) (`initChain`, `checkTx`, `finalizeBlock`, `commit`, `info`) and takes back an app hash, per-transaction results and validator updates. The application owns the object database from [chapter 09](09-database.md), where every account, asset, balance and validator is an object with a numeric id and a place in a Merkle tree, and it writes those objects, with their index entries and the Merkle trees' chunks and nodes, to the key-value store from [chapter 10](10-store.md) at every commit. The JSON-RPC server in [chapter 12](12-rpc.md) reads the application's committed state, proofs, account history and snapshots. All of it lives in `src/app/core/`, twelve files that this chapter walks through one by one.

## Concepts

### The interface the engine calls

Everything in this chapter is reached through five methods, declared in `src/app/types.ts` and documented in [chapter 05](05-mempool-executor.md):

```ts
export interface Application {
  initChain(genesis: Genesis): Promise<InitChainResult>;
  checkTx(tx: Uint8Array, opts?: CheckTxOptions): Promise<CheckTxResult>;
  finalizeBlock(req: FinalizeBlockRequest): Promise<FinalizeBlockResult>;
  /**
   * Persist the block just finalized. An application that keeps its state in the engine's store environment does
   * its writes before its first await, so that they join the transaction the engine saves the block in (executor.ts).
   */
  commit(): Promise<void>;
  info(): Promise<{ lastHeight: bigint; lastAppHash: Uint8Array }>;
}
```

The file's header gives the call order: `initChain` once on a fresh data directory; `checkTx` for every transaction entering the mempool and again for everything still pending after each commit; `finalizeBlock` once per committed block with all its transactions; `commit` immediately after, to persist; `info` on startup so consensus can replay blocks the application missed. `CheckTxOptions` has one field, `admit`, a function the mempool passes so that the application can ask, after its last wait and just before the transaction would go into the pending state, whether the pool still takes it (it may have paused or filled meanwhile); it returns the reason for a refusal, or null. A `finalizeBlock` request carries what the staking rules need to know about the block besides its transactions:

```ts
export interface FinalizeBlockRequest {
  height: bigint;
  time: bigint;
  txs: Uint8Array[];
  proposerAddress: Uint8Array;
  /** Addresses whose precommits were included in this block's lastCommit. For rewards. */
  lastCommitSigners: Uint8Array[];
  misbehavior: Misbehavior[];
}
```

`proposerAddress` and `lastCommitSigners` are consensus addresses (sha256 of a validator's consensus public key), which is why validators are indexed by address. `misbehavior` lists validators the engine has proven to have double signed, each with the height of the infraction. The result is `{ appHash, txResults, validatorUpdates }`: the new state root, one `{ ok, error? }` per transaction, and the changes to the validator set, which the engine applies two heights later.

### Objects instead of a key-value map

Most chains model state as a map from keys to byte strings. This one follows Graphene (the engine behind BitShares) and models state as typed objects. An object has a numeric type (account is 3, asset is 4) and an instance number assigned from a per-type counter, and the pair is its id: `3.0` is the first account, `4.0` the first asset. [Chapter 09](09-database.md) explains how dense instance numbers let the database find each object of a type by a plain array index and hash the type into a complete binary Merkle tree. For this chapter the consequence is that every reference inside the state is an 8-byte id, not a name and not a public key (1,313 bytes with ML-DSA-44, 34 with secp256k1, scheme tag included). A transfer names its two accounts and its asset in 24 bytes.

`src/app/core/types.ts` declares the object types. Graphene distinguishes "protocol" objects, which transactions reference (accounts, assets, balances, validators, delegations), from "implementation" objects that only the chain maintains (the global and dynamic properties, the recent-transaction records, signing records). The split matters for one thing: the static chain parameters sit in one `global` object and the values that change every block in one `dynamic` object, so a block rehashes one small leaf instead of the whole parameter set.

### Accounts with owner and active authorities

An account has a name and two authorities. This is BitShares' design. The **owner** authority can do anything, including replacing itself; the **active** authority can do everything except change the owner. The point of the split is key hygiene: the owner key can stay in cold storage while the active key does the daily work, and if the active key leaks, the owner replaces it without losing the account. An owner signature also satisfies an active requirement, so the owner key is never locked out.

An **authority** is a threshold plus weighted members, where a member is either a public key or another account:

```ts
export interface Authority {
  threshold: number;
  /** Ascending by account id. */
  accounts: AccountAuth[];
  /** Ascending by public key bytes. */
  keys: KeyAuth[];
}
```

It is satisfied when the weights of the keys that signed, plus the weights of the member accounts whose own active authority is satisfied, reach the threshold. A two-of-three multisig is threshold 2 with three keys of weight 1. A corporate account whose active authority lists two other accounts with weight 1 and threshold 1 can be operated by either of them. The recursion through member accounts stops at `MAX_AUTHORITY_DEPTH = 2` so that a cycle of accounts cannot send the check into a loop and so that the cost of checking is bounded.

Members are kept in canonical order (accounts ascending by id, keys ascending by bytes) and must be distinct, so an authority has one encoding and one hash.

### Why names, and why they are restricted

Accounts are named so people can refer to them, and names are unique keys in an authenticated index, so a light client can prove "alice is 3.1" or "nobody is called bob". To make that index trustworthy the alphabet is tiny: lowercase letters, digits and hyphens, in dot-separated segments that start with a letter (`src/app/core/names.ts`). No case folding, no unicode lookalikes, nothing that needs normalising before it goes into an index. Asset symbols are uppercase letters and digits in the same segment shape.

### Assets and balances as objects

An asset is an object: a symbol, a precision (how many decimal places a whole token has), an issuer account, a maximum supply and the current supply. The core asset is created at genesis as `4.0`; it pays fees and is the token that is staked. Any account may create further assets and only the issuer may issue them, up to the maximum.

A balance is one object per (account, asset) pair, created on first receipt and kept at zero rather than removed, so its id stays stable and a proof about it stays meaningful. The `byAsset` index lists the holders of an asset.

The largest amount of any asset is `MAX_SHARE_SUPPLY = 10^15`, Graphene's limit. With every supply below 10^15 and amounts held as u64 (up to about 1.8 × 10^19), no sum of balances can overflow.

### Transactions, signatures by address, and replay protection by expiration

A transaction is an expiration time, a list of operations and a list of signatures (`src/app/core/tx.ts`). The signed message is the body (expiration and operations) and its sha256 is the transaction id.

The chain's signature scheme is fixed by genesis (`signatureScheme`, ML-DSA-44 when absent; [chapter 2](02-crypto.md)), and every key and signature carries that scheme's tag byte in front of its bytes. ML-DSA-44 signatures do not allow recovering the public key from the signature, and its keys are 1,313 bytes, so a signature carries the key's **address** (sha256 of the tagged public key) instead of the key; the rule is the same on a secp256k1 chain, so one transaction format serves both. The node looks the key up in the account the operations require. A signature by any key that no required authority contains is rejected outright, as in BitShares, so a transaction has exactly one valid form and a stranger cannot pad it with signatures. A signature of the other scheme is refused before any verification work, and so is a key of the other scheme wherever one enters the state: a genesis account or validator, `accountCreate`, `accountUpdate`, `validatorCreate`, `validatorUpdate`. The scheme is held in the committed `global` object, so it is in every app hash, and two nodes whose genesis files name different schemes never agree on a root.

Replay protection is the reason the expiration exists. Most chains give every account a nonce that each transaction must increment, which forces a strict order on everything one account does and makes a multi-account transaction awkward (whose nonce?). BitShares instead remembers the ids of transactions that have been applied until their expiration passes, and refuses a transaction whose id is still remembered. Expired transactions cannot be replayed because they are expired. The window is bounded by `global.maxTxExpirationMs` (default one hour) so the set of remembered ids stays small, and it is pruned at the start of every block. Two unrelated transactions from one account never wait for each other.

### Fees and the schedule

BitShares prices each operation type on its own and lets a committee change the prices; there is no fee market. This chain keeps that model (`FEES.md`): `global.fees` is a `FeeSchedule` with a price per operation, a few structured cases (a "premium" account name costs more than a cheap one, a short asset symbol costs more than a long one, variable-size operations pay per kilobyte of encoded body) and a `scale` that multiplies every price at once.

The signer states the fee in every operation. The chain computes what the schedule requires and refuses the operation if the stated fee is lower; otherwise it charges exactly what was stated. The reason is "what you sign is what you pay": if validators raise the schedule between signing and inclusion, the transaction fails rather than paying more, and the signed bytes remain the only thing that matters. Fees are taken from the payer's core balance before the operation runs and go to the community pool.

### The operations, who must sign, and who pays

Every operation names the account whose authority it needs, and that account pays its fee. There is no transaction-level sender: a transaction with three operations from three accounts needs three authorities and charges three payers, which is what lets one transaction carry an atomic exchange between parties. The full table, from `requiredAuthorities` and `feePayerOf` in `src/app/core/evaluate.ts` and the tags in `src/app/core/tx.ts`:

| operation | tag | authority required | fee payer |
|---|---|---|---|
| transfer(from, to, asset, amount) | 0 | active(from) | from |
| accountCreate(registrar, name, owner, active) | 1 | active(registrar) | registrar |
| accountUpdate(account, owner?, active?) | 2 | owner(account) if `owner` is given, else active(account) | account |
| assetCreate(issuer, symbol, precision, maxSupply) | 3 | active(issuer) | issuer |
| assetIssue(issuer, asset, to, amount) | 4 | active(issuer) | issuer |
| validatorCreate(operator, consensusKey, selfBond) | 5 | active(operator) | operator |
| validatorUpdate(operator, validator, consensusKey) | 6 | active(operator) | operator |
| delegate(delegator, validator, amount) | 7 | active(delegator) | delegator |
| undelegate(delegator, validator, shares) | 8 | active(delegator) | delegator |
| redelegate(delegator, source, destination, shares) | 9 | active(delegator) | delegator |
| unjail(operator, validator) | 10 | active(operator) | operator |
| proposalCreate(operator, validator, parameters) | 11 | active(operator) | operator |
| proposalSignal(operator, validator, proposal) | 12 | active(operator) | operator |

"active(x)" is satisfied by x's active authority or by its owner authority. Only `accountUpdate` with a new owner demands the owner authority itself.

### Evaluating a transaction inside an undo session

The database from [chapter 09](09-database.md) has undo sessions: open one, make changes, and either commit them into the enclosing session or undo them. The application evaluates every transaction inside its own session. The evaluator writes to the database as it goes (take the fee, debit the sender, credit the receiver) and throws a `TxError` the moment something is wrong; the session is then undone and the state is exactly as it was. There is no separate "validate" pass that has to predict what "apply" will do.

The same evaluator serves two callers. `checkTx`, the mempool admission check, runs it inside a long-lived **pending** session that holds the effects of every transaction admitted since the last block, so that a second transaction spending the same balance is refused. `finalizeBlock` first undoes the pending session so the block runs on committed state, opens one session for the whole block, applies each transaction inside it and keeps the successful ones, commits the block session before taking the root, and reopens a fresh pending session at the end; the engine's post-commit recheck then refills it. If anything throws while the block session is open, it is undone and the database is as the previous block left it.

### Delegated proof of stake with shares

Staking follows the Cosmos SDK's `x/staking` module. A **validator** object is owned by an operator account and has its own consensus key, the key it signs votes with (of the chain's scheme), which can be rotated. Any account may **delegate** core tokens to a validator; the validator's voting power is the whole-token value of everything delegated to it, including the operator's own self-bond. Validators are the top N candidates by stake (N is `maxValidators`, default 21), recomputed every block; this is the **active set**, and its diff from the previous set is what the application hands the engine as validator updates.

A validator holds `tokens` and `shares`; a delegation holds shares. The exchange rate is `tokens / shares`. When tokens are added by a reward the rate rises and every delegation is worth more; when a slash removes tokens the rate falls and every delegation is worth less. Nothing has to be tracked per delegator: rewards compound automatically and a slash reaches every delegator in one subtraction. Shares are scaled by `SHARE_SCALE = 1000` on first issue so that, at the initial rate, integer division loses at most one base unit per operation, always in the validator's favour. As rewards raise the rate, a share is worth more and the rounding per operation grows with it; a delegation so small that it would be worth no share at all is refused rather than silently absorbed by the other delegators.

**Commission** is one fixed rate for every validator (`commissionBps`, default 10%). It is paid by minting shares into the operator's own delegation, which is an ordinary delegation object, so the operator's cut is expressed in the same currency as everyone else's stake.

### Rewards, the community pool and the mint

Cosmos splits this across `x/distribution` and `x/mint`; here both are small functions in `src/app/core/staking.ts`. The **community pool** in `dynamic` collects fees, slashed tokens and newly minted tokens. Every block it pays `fixedRewardPerBlock` (skipped when the pool holds less): a proposer bonus (`proposerBonusBps`, default 5%) to the block's proposer and the rest pro rata by stake to the validators whose signatures are in the block's `lastCommit`. Nothing is paid at height 1, which has no previous commit.

The **mint** targets a bonded ratio, as in Cosmos: an annual inflation rate moves toward the goal (`goalBondedBps`, default 67%) by `inflationChangeBpsPerYear`, clamped between `inflationMinBps` and `inflationMaxBps`, and the elapsed share of a year of that rate is minted into the pool each block. The rate is stored in parts per billion rather than basis points so a one-second block can move it by a measurable step. The core asset's `maxSupply` caps everything.

### Slashing, jailing and tombstoning

Two infractions are punished (`x/slashing` and `x/evidence` in Cosmos). **Double signing**, two votes for different blocks at the same height and round, is proven by evidence the engine collects (chapter 05's `Misbehavior`). The validator is slashed `doubleSignSlashBps` (default 5%), **tombstoned** (permanently removed, never able to return), and every delegation to it is turned into an unbonding entry so the delegators get their remaining tokens back after the unbonding period. Stake that was already leaving the validator when it misbehaved is slashed too, because that stake was still backing its votes.

**Downtime** is tracked with a signing window: one bit per block in a circular bitmap per validator. When the window is full and the validator signed fewer than `downtimeMinSignedBps` of it (default 50% of 1000 blocks), it is slashed `downtimeSlashBps` (default 0.01%), **jailed** for `downtimeJailMs` (default ten minutes) and removed from the active set. The operator brings it back with an explicit `unjail` once the period has passed and the self-bond is still above the minimum. Slashed tokens go to the community pool, a choice `STAKING.md` flags for revisiting (Cosmos burns them).

### Unbonding and redelegation

Stake does not leave a validator at once. `undelegate` creates an **unbonding** entry that pays out after `unbondingPeriodMs` (default seven days), during which it can still be slashed for a double sign committed while it was backing the validator. The delay is what gives evidence time to arrive, and it is also the ceiling on how long a light client may trust an old validator set. `redelegate` moves stake to another validator immediately but records a **redelegation** entry for the same period, so the source can still slash it; and stake that arrived by a pending redelegation cannot be redelegated again (Cosmos's "no chains" rule), or a delegator could hop ahead of evidence forever. Both queues are capped at `maxEntries` per pair.

### Parameter proposals by validators

Chain parameters, the fee schedule and the staking rules together as `ChainParameters`, change by proposal. An active validator proposes a complete replacement, other active validators signal support, and when the signalling validators hold more than two thirds of the active stake the proposal is adopted at the end of the block. Unsupported proposals expire after `proposalLifetimeMs`. This is BitShares' `committee_member_update_global_parameters` with validators in place of the committee: a proposal carries all of the parameters, so a chain never has half a change.

### Account history with virtual operations

Users want to see what happened to their account, which the state alone does not say (a balance is a number, not a list of transfers). The application records, outside the state root, one history entry per operation for every account the operation names. Things the chain does on its own, a reward, a slash, a jailing, a matured unbonding, produce **virtual** entries with no transaction behind them. BitShares keeps the same kind of record. Entries are collected during `finalizeBlock` and written by `commit` to the end of one log in block order, each entry carrying its account's sequence number and pointing back at earlier entries of the same account.

### State snapshots in chunks with range proofs

A node that joins a chain late can replay every block from genesis or load a snapshot of the state. Every K blocks the application exports its objects type by type in chunks of a fixed instance range, each chunk carrying the sibling hashes that fold its leaves to the type's Merkle root at that height, and a manifest holding every type leaf with its path to the app hash. A joiner that trusts one header after the snapshot height verifies the manifest against that header's app hash and every chunk against the manifest before loading anything. [Chapter 12](12-rpc.md) and the sync chapter describe the transport; this chapter describes the export, the verification and the import.

### The deferred app hash

`finalizeBlock` for height H returns the root of the state after block H. That root does not go into header H, which is already signed by then; it goes into header H+1. Every proof the application makes "at height H" is therefore verified against header H+1's `appHash`, and the same holds for transaction results (`lastResultsHash`). Keep this in mind whenever the code says "verify against height+1".

### Worked example: a transfer from signing to balance change

Alice (`3.1`) sends 5,000 base units of the core asset (`4.0`) to Bob (`3.2`), on a chain with the default fee schedule.

1. A wallet builds the draft `{ type: 'transfer', from: 3.1, to: 3.2, asset: 4.0, amount: 5000n }` and calls `withFees` (`src/app/core/client.ts`), which asks `calculateFee` what the schedule requires: `fees.transfer.fee = 100`, scaled by `scale / 10000 = 1`, so `fee: 100n`.
2. It picks an expiration, say one minute from now, encodes the body (expiration, then the one operation: tag 0, fee, from, to, asset, amount; 32 bytes of operation body), and signs the body with Alice's secret key under the context string `<chainId>/tx`. The signature entry is `{ address: sha256(alicePublicKey), signature }`, 32 + 2,421 bytes under ML-DSA-44 (32 + 65 under secp256k1).
3. A node receives the bytes and `checkTx` decodes them. `requiredAuthorities` says the transfer needs active(3.1). `signingKeys` collects every key in Alice's active and owner authorities by address and finds the one that matches the signature's address; the signature's tag must be the chain's scheme. The signature is verified on the worker pool and cached as "this address signed this body".
4. `applyChecked` checks the threshold: Alice's active authority is threshold 1 with one key of weight 1, and that key signed, so it is satisfied. It opens a session inside the pending session and calls `applyTransaction`.
5. `applyTransaction` checks the expiration is after the last block time and within an hour of it, and that the transaction id is not in `recentTx`. For the one operation it computes the required fee (100), sees the stated fee is not lower, and debits Alice 100 (`adjustBalance`). Then `applyOperation` checks the amount is in range, that Alice and Bob exist and the asset exists, debits Alice 5,000 and credits Bob 5,000. After the loop the 100 goes to the community pool and a `recentTx` object with the transaction id is created.
6. The session is committed into the pending session: the mempool now sees Alice at 5,100 less. The committed view, which queries use, still shows the old balances.
7. When a block containing the transaction is finalized, steps 3 to 5 run again inside the block's own session, this time with `final: true`, so the history recorder gets an entry for Alice and one for Bob; the transaction's session is committed into the block session, and the block session is committed before the root is taken. `commit` writes the two balance objects, the pool and the new `recentTx` to the store, plus the two history entries.

### Worked example: a delegation and the shares it receives

Take a validator holding `tokens = 1,000,000` and `shares = 1,000,000,000` (base units with a share scale of 1000, so the rate is one base unit per thousand shares). Suppose it is paid a reward of 10,000 with a 10% commission:

- `tokens` becomes 1,010,000. The commission is `floor(10,000 × 1000 / 10000) = 1,000`.
- Shares minted to the operator: `floor(1,000 × 1,000,000,000 / (1,010,000 − 1,000)) = 991,080`. `shares` becomes 1,000,991,080.
- The operator's new shares are worth `floor(991,080 × 1,010,000 / 1,000,991,080) = 999`: one base unit below the commission, rounding in the validator's favour. The 1,000,000,000 shares that existed before are now worth 1,009,000, which is the reward minus the commission.

Now a delegator bonds 500,000:

- `sharesForTokens` issues `floor(500,000 × 1,000,991,080 / 1,010,000) = 495,540,138` shares. The validator holds 1,510,000 tokens and 1,496,531,218 shares.
- Those shares are worth `floor(495,540,138 × 1,510,000 / 1,496,531,218) = 499,999`. The delegator lost one base unit to rounding and will never get it back; the validator's other delegators gained it.

### Worked example: a slash and what it does through the exchange rate

The validator above double signs. `doubleSignSlashBps` is 500, so `slash` removes `floor(1,510,000 × 500 / 10000) = 75,500` tokens to the community pool and leaves `shares` alone: 1,434,500 tokens against 1,496,531,218 shares. The delegator's 495,540,138 shares are now worth `floor(495,540,138 × 1,434,500 / 1,496,531,218) = 474,999`, five percent less; the operator's shares went from 1,009,999 worth to 959,500. One subtraction from one field reached both of them. `punishDoubleSign` then tombstones the validator and converts each delegation into an unbonding entry for its current worth.

### Worked example: the fee for a premium account name

Registering `alice` with one key in each authority on an ML-DSA-44 chain: `isCheapName('alice')` is false (no digit, dot or hyphen, and it has vowels), so the base is `premiumFee = 5,000`. The encoded operation body (registrar, name, two authorities each holding a 1,313-byte tagged key) is 2,675 bytes, so the data fee is `floor(2,675 × 100 / 1024) = 261`. With `scale = 10000` the fee is 5,261 base units. The same registration as `alice1` is a cheap name: `1,000 + 261 = 1,261`. A sixteen-key authority adds about 20 KB and so about 1,900 more. On a secp256k1 chain the same body is 117 bytes (two 34-byte keys), the data fee is 11, and the two registrations cost 5,011 and 1,011; sixteen keys add 570 bytes and about 55 more. The name is the one place where size is priced, because authorities are the only variable-size operation payload and keys, under ML-DSA-44, are large.

### Worked example: a proposal reaching two thirds

Three active validators hold 200, 100 and 100 whole tokens; active stake is 400. The operator of the first creates a proposal; it carries that validator's own signal, so support is 200 and `3 × 200 = 600` is not greater than `2 × 400 = 800`. Nothing changes at the end of that block. The second validator signals: support 300, `900 > 800`, adopted at the end of the block in `tallyProposals`, which replaces `global.fees` and `global.staking` wholesale and removes the proposal. In the test suite two validators hold 200 and 100: the proposer alone has exactly two thirds, and the strict inequality means the other must signal.

## The code, file by file

### src/app/core/types.ts

The object types, their encodings and their indices, plus the two parameter structures that a proposal replaces.

**`TYPE`** fixes the numeric type ids. They are part of every object id and every leaf hash, so they can never change:

| name | id | role |
|---|---|---|
| global | 1 | chain parameters (implementation object) |
| dynamic | 2 | per-block state (implementation object) |
| account | 3 | protocol |
| asset | 4 | protocol |
| balance | 5 | protocol |
| recentTx | 6 | replay protection (implementation object) |
| validator | 7 | protocol |
| delegation | 8 | protocol |
| unbonding | 9 | queue |
| redelegation | 10 | queue |
| signingInfo | 11 | downtime record (implementation object) |
| proposal | 12 | protocol |
| validatorKey | 13 | every consensus address a validator ever used |

**`GLOBAL_ID`**, **`DYNAMIC_ID`** and **`CORE_ASSET_ID`** are `1.0`, `2.0` and `4.0`. **`MAX_SHARE_SUPPLY`** is `1_000_000_000_000_000n` and **`MAX_PRECISION`** is 12. **`MAX_DURATION_MS`** is a hundred years in milliseconds, the ceiling on every duration parameter, and **`MAX_SIGNALS`** is 1000, the most validator ids a proposal's signal list can hold.

**`FeeSchedule`** is the per-operation price table after BitShares' `fee_schedule`:

```ts
export interface FeeSchedule {
  scale: number;
  transfer: { fee: bigint };
  accountCreate: { basicFee: bigint; premiumFee: bigint; pricePerKbyte: bigint };
  accountUpdate: { fee: bigint; pricePerKbyte: bigint };
  assetCreate: { symbol3: bigint; symbol4: bigint; longSymbol: bigint };
  assetIssue: { fee: bigint };
  validatorCreate: { fee: bigint };
  validatorUpdate: { fee: bigint };
  delegate: { fee: bigint };
  undelegate: { fee: bigint };
  redelegate: { fee: bigint };
  unjail: { fee: bigint };
  proposalCreate: { fee: bigint };
  proposalSignal: { fee: bigint };
}
```

**`FeeOperation`** is the key type without `scale`. **`FEE_FIELDS`** lists the sections and their fields in encoding order; every function below walks it, so adding an operation to the schedule is one line here. **`FEE_SCALE_ONE`** is 10,000 (100%) and **`MAX_FEE_SCALE`** 1,000,000 (one hundred times the written amounts).

- **`encodeFeeSchedule(w, f)`** / **`decodeFeeSchedule(r)`**: `scale` as u32 then every amount as u64 in `FEE_FIELDS` order.
- **`checkFeeSchedule(f)`** returns a problem string or null: the scale must be an integer from 0 to `MAX_FEE_SCALE`, every amount a bigint from 0 to `MAX_SHARE_SUPPLY`. Zero is fine everywhere: a chain may be free.
- **`feeScheduleFromJson(j, base = null)`** builds a schedule from JSON with amounts as strings or numbers. With a `base`, missing values come from it, which is how genesis overrides the defaults; without one every value is required and a missing one throws `fees: <op>.<field> missing`.

**`StakingParameters`** holds the staking rules (`STAKING.md` section 4). Amounts are base units, rates basis points, times milliseconds: `maxValidators`, `unbondingPeriodMs`, `minSelfBond`, `minDelegation`, `validatorCreationFee`, `commissionBps`, `fixedRewardPerBlock`, `proposerBonusBps`, `doubleSignSlashBps`, `downtimeWindow`, `downtimeMinSignedBps`, `downtimeJailMs`, `downtimeSlashBps`, `maxEntries`, `proposalLifetimeMs`, `goalBondedBps`, `inflationMinBps`, `inflationMaxBps`, `inflationChangeBpsPerYear`.

- **`encodeStakingParameters`** / **`decodeStakingParameters`**: the fields in declaration order, u32 for counts and basis points, u64 for amounts and times.
- **`checkStakingParameters(p)`**: `maxValidators` 1 to 1000; the three durations `unbondingPeriodMs`, `downtimeJailMs` and `proposalLifetimeMs` from 1 to `MAX_DURATION_MS`; the four amounts `minSelfBond`, `minDelegation`, `validatorCreationFee` and `fixedRewardPerBlock` from 0 to `MAX_SHARE_SUPPLY`, with `minSelfBond` and `minDelegation` at least 1; every basis-point field 0 to 10,000; `downtimeWindow` 1 to 100,000 blocks; `maxEntries` 1 to 100; `inflationMinBps <= inflationMaxBps`. Every bound has a reason in the arithmetic that uses the field. A duration is added to a block time (`time + unbondingPeriodMs`, `time + downtimeJailMs`, `time + proposalLifetimeMs`) and the sum is stored as a u64, so a duration near 2^64 would make a completion time that cannot be encoded and a block that cannot be hashed; a hundred years is more than any chain needs and leaves the sum far from the edge. An amount above the share supply could never be met by any balance, so a `minSelfBond` of that size would be a proposal that empties the validator set by stealth. And a `minSelfBond` of zero would let an operator undelegate its whole self-bond while its validator stays a candidate, which is exactly what the self-bond floor in `undelegate` exists to prevent, so the minimum is at least one base unit.
- **`STAKING_FIELDS`** and **`STAKING_BIGINT_FIELDS`** name the fields in order and the seven held as bigint, for the JSON converters.
- **`stakingParametersFromJson(j)`** takes base units with every field required, as the RPC reports them (the genesis parser in `genesis.ts` is the one that takes whole tokens and defaults).

**`ChainParameters`** is `{ fees, staking }`, everything a proposal replaces at once. **`encodeChainParameters`**, **`decodeChainParameters`**, **`checkChainParameters`** (fees first, then staking) and **`chainParametersFromJson`** compose the two.

**`GlobalProperties`** (`global`, `1.0`): `coreAsset` (the asset fees are paid in and that is staked), `fees`, `maxTxExpirationMs`, `staking`, and `scheme`, the chain's signature scheme as a tag, set from the engine genesis by `applyGenesis`: every account key, consensus key and transaction signature must be of it, and because it sits in a committed object it is in every app hash. Its codec writes the tag last and refuses one it does not know:

```ts
export const GlobalType: ObjectType<GlobalProperties> = {
  id: TYPE.global,
  name: 'global',
  encode(w, o) {
    w.u64(o.coreAsset);
    encodeFeeSchedule(w, o.fees);
    w.u64(o.maxTxExpirationMs);
    encodeStakingParameters(w, o.staking);
    w.u8(o.scheme);
  },
  decode(r, id) {
    const g = { id, coreAsset: r.u64(), fees: decodeFeeSchedule(r), maxTxExpirationMs: r.u64(), staking: decodeStakingParameters(r) };
    const scheme = r.u8();
    if (!isSchemeTag(scheme)) throw new Error(`unknown signature scheme ${scheme}`);
    return { ...g, scheme };
  },
  indices: [],
};
```

A store or a snapshot whose `global` object names a tag the code does not know is refused here rather than read as some default.

**`ActiveValidator`** is `{ validator, publicKey, power }`, one member of the set last handed to the engine.

**`DynamicProperties`** (`dynamic`, `2.0`):

```ts
export interface DynamicProperties {
  id: ObjectId;
  height: bigint;
  /** Time of the last block, unix milliseconds. */
  time: bigint;
  /** Fees, mint and slashes collected; pays the block reward. */
  communityPool: bigint;
  /** Current annual inflation, parts per billion, so one block can move it by a measurable step. */
  inflationPpb: bigint;
  lastMintTime: bigint;
  /** Tokens behind candidate and jailed validators. */
  bonded: bigint;
  /** The set computed at the end of the last block; the engine applies it two heights later. */
  active: ActiveValidator[];
  /**
   * Consensus addresses of the three most recently computed sets, newest first.
   * The oldest is the set that signed the previous block's commit.
   */
  expectedSigners: Uint8Array[][];
}
```

`expectedSigners` deserves a note. The set computed at the end of block H takes effect at H+2, so the validators who signed block H's commit (which arrives as `lastCommitSigners` in block H+1) are the set computed at the end of H−2. The application keeps a three-deep ring of address lists so the downtime tracker can ask "who was supposed to sign?" without consulting the engine.

**`ValidatorStatus`** is `{ candidate: 0, jailed: 1, tombstoned: 2 }`; **`ValidatorStatusValue`** its value type.

**`Validator`**: `operator` (account id), `consensusKey` (tagged, of the chain's scheme), `tokens`, `shares`, `status`, `jailedUntil` (ms), `createdHeight`.

**`Delegation`**: `delegator`, `validator`, `shares`.

**`Unbonding`**: `delegator`, `validator`, `tokens`, `creationHeight`, `completion` (ms).

**`Redelegation`**: `delegator`, `source`, `destination`, `tokens` ("Tokens moved, the base for a later slash by the source"), `creationHeight`, `completion`.

**`SigningInfo`**: `validator`, `bitmap` (one bit per block in a circular window), `cursor`, `missed`, `tracked` ("Blocks observed so far, up to the window size").

**`ValidatorKey`**: `address`, `validator`. "Every consensus address a validator has ever used, so evidence against a rotated key still finds it." This type was added after review finding 9 (`REVIEW-2026-10-28.md`): before it, rotating the key let a validator escape evidence for its old one.

**`Proposal`**: `proposer` (validator id), `parameters: ChainParameters`, `signals` (validator ids, ascending), `created`, `expiration`.

**`Account`**: `name`, `owner`, `active`, `registrar`. **`Asset`**: `symbol`, `precision`, `issuer`, `maxSupply`, `currentSupply`. **`Balance`**: `owner`, `asset`, `amount`. **`RecentTx`**: `txId`, `expiration`.

The `ObjectType` constants give each type its encoding and indices. An index is a function from the object to a byte key (chapter 09's `KeyWriter`); `unique` indices map a key to one id, and `authenticated` unique indices also keep a sparse Merkle tree so a key's presence or absence is provable. Every index, by type:

| type | index | unique | authenticated | key |
|---|---|---|---|---|
| `AccountType` | byName | yes | yes | `str(name)` |
| `AssetType` | bySymbol | yes | yes | `str(symbol)` |
| `BalanceType` | byOwnerAsset | yes | no | `id(owner).id(asset)` |
| `BalanceType` | byAsset | no | no | `id(asset)` |
| `RecentTxType` | byTxId | yes | no | `fixed(txId)` |
| `RecentTxType` | byExpiration | no | no | `u64(expiration)` |
| `ValidatorType` | byOperator | yes | yes | `id(operator)` |
| `ValidatorType` | byConsensusAddress | yes | yes | `fixed(addressOf(consensusKey))` |
| `ValidatorType` | byPower | no | no | `u64(MAX_U64 - tokens)` |
| `DelegationType` | byDelegatorValidator | yes | yes | `id(delegator).id(validator)` |
| `DelegationType` | byValidator | no | no | `id(validator)` |
| `UnbondingType` | byCompletion | no | no | `u64(completion)` |
| `UnbondingType` | byDelegatorValidator | no | no | `id(delegator).id(validator)` |
| `UnbondingType` | byValidator | no | no | `id(validator)` |
| `RedelegationType` | byCompletion | no | no | `u64(completion)` |
| `RedelegationType` | byDelegatorSourceDestination | no | no | `id(delegator).id(source).id(destination)` |
| `RedelegationType` | byDelegatorDestination | no | no | `id(delegator).id(destination)` |
| `RedelegationType` | bySource | no | no | `id(source)` |
| `SigningInfoType` | byValidator | yes | no | `id(validator)` |
| `ProposalType` | byExpiration | no | no | `u64(expiration)` |
| `ValidatorKeyType` | byAddress | yes | no | `fixed(address)` |
| `GlobalType`, `DynamicType` | none | | | |

The `byPower` key is the trick that makes "top N by stake" a prefix scan:

```ts
  indices: [
    { name: 'byOperator', unique: true, authenticated: true, key: (v, k) => k.id(v.operator) },
    { name: 'byConsensusAddress', unique: true, authenticated: true, key: (v, k) => k.fixed(addressOf(v.consensusKey)) },
    // Ascending key order is descending stake; ties fall back to the id the index appends.
    { name: 'byPower', unique: false, key: (v, k) => k.u64(MAX_U64 - v.tokens) },
  ],
```

Keys are big-endian, so `2^64 − 1 − tokens` sorts the richest validator first, and the database appends the object id to non-unique keys, so ties resolve by creation order.

Every type's canonical encoding, which is what gets hashed into the state root and written to the store. The id is never written; the object's position in its type implies it:

| type | fields in order |
|---|---|
| global | u64 coreAsset, FeeSchedule, u64 maxTxExpirationMs, StakingParameters, u8 scheme |
| dynamic | u64 height, u64 time, u64 communityPool, u64 inflationPpb, u64 lastMintTime, u64 bonded, array of (u64 validator, tagged publicKey, u64 power), array of arrays of 32-byte addresses |
| account | string name, Authority owner, Authority active, u64 registrar |
| asset | string symbol, u8 precision, u64 issuer, u64 maxSupply, u64 currentSupply |
| balance | u64 owner, u64 asset, u64 amount |
| recentTx | 32-byte txId, u64 expiration |
| validator | u64 operator, tagged consensusKey, u64 tokens, u64 shares, u8 status, u64 jailedUntil, u64 createdHeight |
| delegation | u64 delegator, u64 validator, u64 shares |
| unbonding | u64 delegator, u64 validator, u64 tokens, u64 creationHeight, u64 completion |
| redelegation | u64 delegator, u64 source, u64 destination, u64 tokens, u64 creationHeight, u64 completion |
| signingInfo | u64 validator, bytes bitmap, u32 cursor, u32 missed, u32 tracked |
| proposal | u64 proposer, ChainParameters, array of u64 signals, u64 created, u64 expiration |
| validatorKey | 32-byte address, u64 validator |

An Authority is `u32 threshold, array of (u64 account, u32 weight), array of (tagged key, u32 weight)`; a FeeSchedule is `u32 scale` followed by the amounts of `FEE_FIELDS` as u64; the StakingParameters are their nineteen fields in declaration order. A tagged key is 1,313 bytes under ML-DSA-44 and 34 under secp256k1, so an account with one key in each authority encodes to 2,675 bytes on the first kind of chain and 117 on the second; under ML-DSA-44 the state is dominated by keys, which is why the README's gigabyte genesis of 193,536 accounts needs about 1.1 GB of memory at rest.

Encoding details worth knowing:

- Every public key in the state (the active set in `DynamicType`, the consensus key in `ValidatorType`, the keys of an `Authority`) is written as its tagged bytes with `fixed` and read back with `decodePublicKey` (chapter 2), which takes the size from the tag, so one codec serves both schemes; an unknown tag is a decode error.
- `DynamicType.decode` bounds `active` at 1000 entries (the `maxValidators` ceiling) and `expectedSigners` at three sets of 1000.
- `ValidatorType.decode` throws `bad validator status N` for a status above 2, so a corrupt store cannot produce a validator in an impossible state.
- `SigningInfoType.decode` bounds the bitmap at 16,384 bytes, enough for the 100,000-block window limit.
- `ProposalType.decode` bounds `signals` at `MAX_SIGNALS` (1000), and the evaluator refuses a signal that would exceed it, so no proposal is ever written that its own decoder would refuse.
- Strings are bounded by `MAX_ACCOUNT_NAME` and `MAX_ASSET_SYMBOL` from `names.ts`.

**`CORE_TYPES`** is the list handed to the database constructor, in the order that fixes each type's position in the top tree: global, dynamic, account, asset, balance, recentTx, validator, delegation, unbonding, redelegation, signingInfo, proposal, validatorKey. Changing the order changes every app hash.

### src/app/core/names.ts

The rules for human-readable unique keys. **`MIN_ACCOUNT_NAME`** 3, **`MAX_ACCOUNT_NAME`** 63, **`MIN_ASSET_SYMBOL`** 3, **`MAX_ASSET_SYMBOL`** 16.

**`checkAccountName(name)`** returns a problem or null:

```ts
export function checkAccountName(name: string): string | null {
  if (name.length < MIN_ACCOUNT_NAME || name.length > MAX_ACCOUNT_NAME) return `account name must be ${MIN_ACCOUNT_NAME} to ${MAX_ACCOUNT_NAME} characters`;
  for (const seg of name.split('.')) {
    if (!/^[a-z][a-z0-9-]*$/.test(seg)) return 'account name segments must start with a letter and use only a-z, 0-9 and -';
    if (seg.endsWith('-')) return 'account name segments cannot end with -';
  }
  return null;
}
```

Note that an empty segment (`a..b`, or a trailing dot) fails the regex because it needs at least one letter. `Alice` fails on the uppercase letter, which is what the test `rejects ... 'Alice'` checks.

**`checkAssetSymbol(symbol)`**: 3 to 16 characters matching `/^[A-Z][A-Z0-9]*(\.[A-Z][A-Z0-9]*)*$/`.

**`isCheapName(name)`** is BitShares' `is_cheap_name`: a name with a digit, a dot or a hyphen, or with no vowel at all (`aeiouy`), is cheap; every other name is premium. `alice` and `bob` and `xyz` are premium; `alice1`, `al-ice`, `a.b` and `mrkt` are cheap.

### src/app/core/authority.ts

Authorities and the two functions that check them. **`KeyAuth`** is `{ publicKey, weight }`, **`AccountAuth`** is `{ account, weight }`, **`Authority`** is `{ threshold, accounts, keys }` with both member lists in ascending canonical order. **`MAX_AUTHORITY_MEMBERS`** is 16 per list and **`MAX_AUTHORITY_DEPTH`** 2.

**`encodeAuthority(w, a)`** writes the threshold as u32, then the accounts as (u64 id, u32 weight) and the keys as (the tagged key as fixed bytes, u32 weight). **`decodeAuthority(r)`** reads the same with both arrays bounded at 16, each key through `decodePublicKey`, so a key of either scheme decodes and an unknown tag is a `CodecError`.

**`checkAuthority(a, scheme?)`** returns a problem or null. It refuses a threshold below 1, an authority with no members, more than 16 members in a list, a weight below 1, a key whose tag is unknown or whose length is not its scheme's (`bad public key`), when a scheme is given, a key of another scheme (`key must be a secp256k1 key`, or `ml-dsa-44`), members out of order or repeated (`account members must be ascending and distinct`, `key members must be ascending and distinct`), and an authority whose total weight is below its threshold (`authority can never be satisfied`). That last check is what stops an account from locking itself out by mistake. The key loop:

```ts
  for (let i = 0; i < a.keys.length; i++) {
    const k = a.keys[i]!;
    if (k.weight < 1) return 'member weight must be at least 1';
    if (!isPublicKey(k.publicKey)) return 'bad public key';
    if (scheme !== undefined && schemeOf(k.publicKey) !== scheme) return `key must be a ${schemeName(scheme)} key`;
    if (i > 0 && compareBytes(a.keys[i - 1]!.publicKey, k.publicKey) >= 0) return 'key members must be ascending and distinct';
    total += k.weight;
  }
```

Genesis accounts and the evaluator's `accountCreate` and `accountUpdate` always pass the chain's scheme; the parameter is optional so the function stays usable where no chain is in view.

**`makeAuthority(publicKeys, threshold = 1, accounts = [])`** builds a canonical authority with every member at weight 1, sorting both lists. The tests and the CLI use it.

**`AuthorityLookup`** is `(account) => { active, owner } | null`, the application's way of giving these pure functions access to other accounts without passing the database.

**`collectKeys(auth, lookup, into, depth = 0)`** gathers every key that could count toward an authority, by address hex, walking member accounts' active authorities to the depth limit. `app.ts` uses it to find the public key behind a signature's address.

**`authoritySatisfied(auth, signed, lookup, depth = 0)`** is the threshold check:

```ts
export function authoritySatisfied(auth: Authority, signed: ReadonlySet<string>, lookup: AuthorityLookup, depth = 0): boolean {
  let weight = 0;
  for (const k of auth.keys) if (signed.has(toHex(addressOf(k.publicKey)))) weight += k.weight;
  if (weight >= auth.threshold) return true;
  if (depth >= MAX_AUTHORITY_DEPTH) return false;
  for (const m of auth.accounts) {
    const acct = lookup(m.account);
    if (acct && authoritySatisfied(acct.active, signed, lookup, depth + 1)) {
      weight += m.weight;
      if (weight >= auth.threshold) return true;
    }
  }
  return false;
}
```

Keys first, accounts only if the keys fall short, and a member account counts through its active authority, never its owner. `signed` is the set of addresses whose signatures verified; the function never touches a signature itself.

### src/app/core/tx.ts

The transaction format. **`Operation`** is a tagged union of thirteen operation types, every one carrying `fee: bigint`:

```ts
export type Operation =
  | { type: 'transfer'; fee: bigint; from: bigint; to: bigint; asset: bigint; amount: bigint }
  | { type: 'accountCreate'; fee: bigint; registrar: bigint; name: string; owner: Authority; active: Authority }
  | { type: 'accountUpdate'; fee: bigint; account: bigint; owner: Authority | null; active: Authority | null }
  | { type: 'assetCreate'; fee: bigint; issuer: bigint; symbol: string; precision: number; maxSupply: bigint }
  | { type: 'assetIssue'; fee: bigint; issuer: bigint; asset: bigint; to: bigint; amount: bigint }
  | { type: 'validatorCreate'; fee: bigint; operator: bigint; consensusKey: Uint8Array; selfBond: bigint }
  | { type: 'validatorUpdate'; fee: bigint; operator: bigint; validator: bigint; consensusKey: Uint8Array }
  | { type: 'delegate'; fee: bigint; delegator: bigint; validator: bigint; amount: bigint }
  | { type: 'undelegate'; fee: bigint; delegator: bigint; validator: bigint; shares: bigint }
  | { type: 'redelegate'; fee: bigint; delegator: bigint; source: bigint; destination: bigint; shares: bigint }
  | { type: 'unjail'; fee: bigint; operator: bigint; validator: bigint }
  | { type: 'proposalCreate'; fee: bigint; operator: bigint; validator: bigint; parameters: ChainParameters }
  | { type: 'proposalSignal'; fee: bigint; operator: bigint; validator: bigint; proposal: bigint };
```

Two things to notice. `undelegate` and `redelegate` name an amount of **shares**, not tokens, because shares are what a delegation owns and their token value changes every block. `validatorUpdate`, `unjail`, `proposalCreate` and `proposalSignal` name both the operator and the validator, and the evaluator checks that they match; naming the operator is what lets `requiredAuthorities` decide whose signature is needed before any state is read.

**`OperationType`** is the union of the `type` strings and **`OperationDraft`** is an operation without its fee, what a wallet builds before pricing it. **`TxSignature`** is `{ address, signature }` where the address is sha256 of the public key. **`UnsignedTransaction`** is `{ expiration, operations }` and **`Transaction`** adds `signatures`. **`MAX_OPERATIONS`** is 64 and **`MAX_SIGNATURES`** 16.

The wire tags (`OP_TAG`) are 0 to 12 in the order of the union, and an operation encodes as `tag u8, fee u64, body`:

- **`encodeOperationBody(w, op)`** writes the fields after the tag and the fee. This is the function the data fee measures.
- **`encodeOperation(w, op)`** writes tag, fee, body. **`decodeOperation(r)`** reads them back and throws `unknown operation tag N` for anything above 12.
- **`calculateFee(op, fees)`** is `FEES.md` section 2 in code:

```ts
export function calculateFee(op: OperationDraft, fees: FeeSchedule): bigint {
  let base: bigint;
  switch (op.type) {
    case 'accountCreate':
      base = (isCheapName(op.name) ? fees.accountCreate.basicFee : fees.accountCreate.premiumFee) + dataFee(op, fees.accountCreate.pricePerKbyte);
      break;
    case 'accountUpdate':
      base = fees.accountUpdate.fee + dataFee(op, fees.accountUpdate.pricePerKbyte);
      break;
    case 'assetCreate':
      base = op.symbol.length === 3 ? fees.assetCreate.symbol3 : op.symbol.length === 4 ? fees.assetCreate.symbol4 : fees.assetCreate.longSymbol;
      break;
    default:
      base = fees[op.type].fee;
  }
  const scaled = (base * BigInt(fees.scale)) / BigInt(FEE_SCALE_ONE);
  return scaled > MAX_SHARE_SUPPLY ? MAX_SHARE_SUPPLY : scaled;
}
```

The private `dataFee` is BitShares' `calculate_data_fee`: `bytes × pricePerKbyte / 1024`, rounded down, over the encoded body. Signatures are not priced; `FEES.md` explains that a per-signature price would need a transaction-level payer, and operations are the unit of payment.

- **`encodeTxBody(w, tx)`** writes the expiration and the operations. **`txBodyBytes(tx)`** returns those bytes: they are what is signed. **`txIdOf(tx)`** is their sha256.
- **`encodeTransaction(tx)`** appends the signatures (32-byte address, then the tagged signature: 2,421 bytes under ML-DSA-44, 65 under secp256k1). **`decodeTransaction(bytes)`** is strict: at most 64 operations and 16 signatures, each signature read through `decodeSignature` (the tag says how many bytes follow, and an unknown tag is a decode error), the consensus keys of `validatorCreate` and `validatorUpdate` through `decodePublicKey`, and the reader rejects trailing bytes, so a transaction has one encoding.

Note the difference between the transaction id (hash of the body, used for replay protection) and the transaction hash the engine indexes (`txHash` in `src/types/block.ts`, sha256 of the raw bytes including signatures). History entries carry the latter.

The wire layout of a whole transaction, using the codec from the earlier chapters (an array is a u32 count followed by its elements):

| part | bytes |
|---|---|
| expiration | u64, 8 |
| operation count | u32, 4 |
| each operation | u8 tag, u64 fee, then the body |
| signature count | u32, 4 |
| each signature | 32-byte address, tagged signature (1 + 2420 bytes under ML-DSA-44, 1 + 64 under secp256k1) |

A transfer body is 32 bytes (four u64 fields), so a signed transfer is 8 + 4 + 1 + 8 + 32 + 4 + 32 + 2421 = 2,510 bytes on an ML-DSA-44 chain, the "signed transfer 2.5 KiB" of the README's table, and about 1,670 of them fit in the default 4 MiB block; on a secp256k1 chain the same transfer is 154 bytes and about 27,000 fit. Verifying the one signature costs most of a millisecond of CPU under either scheme (chapter 2 has the figures), which is why the README says signatures set every limit: the engine and the database never come close to theirs at this transaction size.

### src/app/core/client.ts

What a wallet does, with no state access. **`withFees(operations, fees)`** fills in the fee of each draft from `calculateFee`, BitShares' `set_fee`. **`signTransaction(chainId, tx, keys)`** signs the body once per key under the context `signContext(chainId, 'tx')` and attaches `{ address, signature }` entries:

```ts
export function signTransaction(chainId: string, tx: UnsignedTransaction, keys: KeyPair[]): Transaction {
  const body = txBodyBytes(tx);
  const ctx = signContext(chainId, 'tx');
  return { ...tx, signatures: keys.map((k) => ({ address: k.address, signature: sign(body, k.secretKey, ctx) })) };
}
```

The context string binds a signature to one chain and one purpose, so a transaction signature can never be mistaken for a vote. **`signedTxBytes(chainId, tx, keys)`** builds, signs and encodes in one call; **`expiresIn(fromMs, ms)`** is a convenience for picking an expiration.

### src/app/core/state.ts

Small helpers shared by the evaluators and the staking rules.

**`TxError`** is the exception class for "this transaction is invalid"; the application turns it into a `{ ok: false, error }` result and undoes the session. Anything else thrown is a bug and propagates.

**`EvalContext`** is what every evaluator receives:

```ts
export interface EvalContext {
  db: ObjectDatabase;
  /** Block time for a block, last block time for a mempool check. */
  time: bigint;
  /** Height being applied, or the next height for a mempool check. */
  height: bigint;
  /** True when applying a committed block rather than checking for the mempool. */
  final: boolean;
  log?: Logger;
  /** Present when applying a block: receives the accounts each operation touched. */
  history?: HistoryRecorder;
}
```

- **`getGlobal(db)`** and **`getDynamic(db)`** fetch `1.0` and `2.0`; both always exist after genesis.
- **`accountOf(db, id)`** and **`assetOf(db, id)`** fetch or throw `account 3.9 does not exist` / `asset 4.9 does not exist`.
- **`findBalance(db, owner, asset)`** looks up the balance object through `byOwnerAsset`; **`balanceOf`** returns its amount or `0n`.
- **`adjustBalance(db, owner, asset, delta)`** adds a possibly negative delta, creating the balance object on first receipt, and throws `alice has insufficient CORE` when the result would be negative. Every token movement in the application goes through it.
- **`adjustPool(db, delta)`** moves tokens into or out of `dynamic.communityPool` and throws `community pool cannot go negative`.

### src/app/core/evaluate.ts

The state transition rules: which authorities an operation needs, who pays, and what each operation does. The file re-exports the `state.ts` helpers so `app.ts` has one import.

**`requiredAuthorities(ops)`** returns `{ active, owner }`, two sets of account ids, read from the operations alone:

```ts
      case 'transfer':
        active.add(op.from);
        break;
      case 'accountCreate':
        active.add(op.registrar);
        break;
      case 'accountUpdate':
        (op.owner ? owner : active).add(op.account);
        break;
```

and so on: the issuer for asset operations, the operator for validator, unjail and proposal operations, the delegator for delegate, undelegate and redelegate. `accountUpdate` needs the owner authority only when it changes the owner; changing just the active authority is an active-level action, as in BitShares.

**`feePayerOf(op)`** names the account charged for an operation: the same account whose authority the operation requires. There is no transaction-level payer.

**`applyOperation(ctx, op)`** is the big switch for the account and asset operations; the staking cases fall through to the private `applyStakingOperation`. Private helpers: `checkAmount(amount, what)` throws `${what} must be between 1 and 1000000000000000`; `checkNewAuthority(db, auth)` runs `checkAuthority` with the chain's scheme from `getGlobal(db).scheme` and requires every member account to exist.

The transfer case shows the shape of all of them, checks first, then writes:

```ts
    case 'transfer': {
      checkAmount(op.amount, 'amount');
      if (op.from === op.to) throw new TxError('cannot transfer to self');
      accountOf(db, op.from);
      accountOf(db, op.to);
      assetOf(db, op.asset);
      adjustBalance(db, op.from, op.asset, -op.amount);
      adjustBalance(db, op.to, op.asset, op.amount);
      return;
    }
```

The rules per operation, with every `TxError` the evaluator can raise:

| operation | checks and effects | errors |
|---|---|---|
| transfer | amount in range, not to self, both accounts and the asset exist; debit then credit | `amount must be between 1 and ...`, `cannot transfer to self`, `account X does not exist`, `asset X does not exist`, `<name> has insufficient <SYMBOL>` |
| accountCreate | valid name, registrar exists, name free, both authorities well formed with existing members; creates the account with `registrar` set; logs `account created` in a block | name problems from `checkAccountName`, `account name X is taken`, authority problems from `checkAuthority`, member `account X does not exist` |
| accountUpdate | at least one authority given, account exists, new authorities well formed; replaces the given ones | `nothing to update`, authority problems |
| assetCreate | valid symbol, precision at most 12, max supply in range, issuer exists, symbol free; creates the asset with `currentSupply: 0n` | symbol problems, `precision must be at most 12`, `max supply must be between ...`, `asset symbol X is taken` |
| assetIssue | amount in range, not the core asset, issuer owns the asset, recipient exists, supply cap; raises `currentSupply` and credits | `the core asset is minted by the chain, not issued`, `only the issuer of X can issue it`, `issuing N would exceed the max supply of X` |
| validatorCreate | operator exists, consensus key well formed and of the chain's scheme, operator has no validator, key never used, self-bond at least `minSelfBond`; debits self-bond plus `validatorCreationFee`, pays the creation fee into the pool, creates the validator; logs `validator created` | `consensus key must be a <scheme> key`, `account already operates a validator`, `consensus key already in use`, `self-bond must be at least N`, `delegation would overflow the validator` |
| validatorUpdate | validator exists, operator matches, not tombstoned, consensus key well formed and of the chain's scheme, key never used; replaces the key and records it | `validator X does not exist`, `not the operator of that validator`, `validator is tombstoned`, `consensus key must be a <scheme> key`, `consensus key already in use` |
| delegate | delegator exists, validator exists and is not tombstoned (jailed is fine), amount at least `minDelegation`; debits and bonds | `validator is tombstoned`, `delegation must be at least N`, insufficient balance, `delegation is worth no shares at this exchange rate`, overflow |
| undelegate | delegation exists, shares in range, the operator's self-bond stays at or above `minSelfBond`, fewer than `maxEntries` pending; unbonds and creates an unbonding entry maturing at `time + unbondingPeriodMs` | `no such delegation`, `shares out of range`, `self-bond would fall below the minimum`, `too many pending unbonding entries` |
| redelegate | distinct validators, destination not tombstoned, delegation exists, shares in range, no pending redelegation into the source for this delegator, fewer than `maxEntries` for the triple, self-bond floor, moved tokens at least `minDelegation`; unbonds from the source, bonds to the destination, records the entry | `source and destination are the same`, `destination is tombstoned`, `no such delegation`, `shares out of range`, `stake still redelegating into the source cannot move again`, `too many pending redelegations`, `self-bond would fall below the minimum`, `redelegation must move at least N` |
| unjail | operator matches, status jailed, jail period passed, self-bond at least the minimum; status back to candidate, signing window reset, virtual history entry | `not the operator of that validator`, `validator is not jailed`, `jail period has not passed`, `self-bond below the minimum` |
| proposalCreate | operator matches, validator in the active set, parameters pass `checkChainParameters`; creates the proposal with the proposer's own signal and `expiration = time + proposalLifetimeMs` | `not the operator of that validator`, `only active validators propose`, parameter problems |
| proposalSignal | operator matches, validator active, proposal exists, not already signalled, fewer than `MAX_SIGNALS` signals so far; appends the id and keeps `signals` sorted | `not the operator of that validator`, `only active validators signal`, `no such proposal`, `already signalled`, `proposal has the maximum number of signals` |

The `assetIssue` refusal of the core asset came from review finding 27: without it the genesis issuer could create stake out of thin air and break the supply invariant that the staking tests check. The consensus-key check of the two validator operations is one line, the same in both:

```ts
      if (!isPublicKey(op.consensusKey) || schemeOf(op.consensusKey) !== g.scheme) throw new TxError(`consensus key must be a ${schemeName(g.scheme)} key`);
```

`isPublicKey` wants a known tag followed by exactly that scheme's key, and for secp256k1 a key that is a point on the curve ([chapter 2](02-crypto.md)), and `g.scheme` is the chain's from `global`; the engine would refuse a validator update of the other scheme anyway (`nextState` in chapter 3), but refusing it here keeps such a key out of the mempool and out of the state. The undelegate self-bond check reads:

```ts
      if (op.delegator === v.operator && v.status !== ValidatorStatus.tombstoned && tokensForShares(v, d.shares - op.shares) < p.minSelfBond) {
        throw new TxError('self-bond would fall below the minimum');
      }
```

An operator cannot walk away from a running validator and leave its delegators with a validator below the minimum; it has to unbond everything only after the validator is tombstoned (and in that case `punishDoubleSign` has already removed every delegation, so the `tombstoned` branch is in practice never reached).

The redelegation "no chains" check uses the `byDelegatorDestination` index with the source as the destination key: "is there a pending redelegation by this delegator **into** the validator I am now leaving?"

The signal cap looks redundant at first: only active validators may signal, each signals once, and the active set holds at most 1000. But a signal stays in the list after its validator leaves the set, and a proposal lives for `proposalLifetimeMs`, so over a long lifetime with a changing set the list can grow past the number of validators that exist at any one moment. `ProposalType.decode` reads at most `MAX_SIGNALS` ids, so a 1001st signal would create an object the node could decode neither from its store on restart nor from a snapshot. The check in the evaluator keeps the state within what its own encoding can carry.

**`accountsNamed(db, op)`** lists every account an operation concerns, for history, and is called after the operation ran so that `accountCreate` can look up the new account's id by name. Delegate, undelegate and redelegate name the delegator and the validators' operators, so an operator's history shows who delegated to it.

**`applyTransaction(ctx, tx, txId)`** is the top of the evaluation:

```ts
export function applyTransaction(ctx: EvalContext, tx: Transaction, txId: Uint8Array): void {
  const { db } = ctx;
  const global = getGlobal(db);
  if (tx.operations.length === 0) throw new TxError('transaction has no operations');
  if (tx.expiration <= ctx.time) throw new TxError('transaction expired');
  if (tx.expiration > ctx.time + global.maxTxExpirationMs) throw new TxError('expiration too far in the future');
  if (db.lookup(RecentTxType, 'byTxId', key((k) => k.fixed(txId)))) throw new TxError('duplicate transaction');
  let fees = 0n;
  tx.operations.forEach((op, i) => {
    const required = calculateFee(op, global.fees);
    if (op.fee < required) throw new TxError(`operation ${i} states a fee of ${op.fee}, the schedule requires ${required}`);
    if (op.fee > 0n) {
      adjustBalance(db, feePayerOf(op), global.coreAsset, -op.fee);
      fees += op.fee;
    }
    ctx.history?.beginOp(i);
    applyOperation(ctx, op);
    ctx.history?.op(accountsNamed(db, op), i, encode((w) => encodeOperation(w, op)));
  });
  if (fees > 0n) adjustPool(db, fees);
  db.create(RecentTxType, (id) => ({ id, txId, expiration: tx.expiration }));
}
```

Expiration, replay, then per operation: fee check, fee debit, a note to the history recorder of which operation is about to run (so a virtual entry the operation raises, such as an `unjail`, points at it), the operation, the history entry. The fees go to the pool after the last operation and the id is remembered. Everything happens inside the caller's session, so a throw anywhere leaves nothing behind; a failed transaction in a block pays no fee (`DESIGN.md` section 7 notes this is rare, since proposers only include transactions that passed the mempool, and will be revisited if there is ever a fee market).

**`pruneExpiredTxs(db, time)`** scans `recentTx` by expiration from the start, collects every entry with `expiration <= time`, removes them and returns the count. The scan stops at the first entry still alive, so the cost is proportional to what is pruned.

### src/app/core/history.ts

Account history entries, the recorder that collects them during a block, and the log they are stored in.

**`HistoryKind`** names the entry kinds: `operation` 0, `reward` 1, `slash` 2, `jail` 3, `unjail` 4, `tombstone` 5, `unbondingMatured` 6, `redelegationMatured` 7, `forcedUnbond` 8. **`VIRTUAL`** (`0xffffffff`) is the transaction position of an entry with no transaction.

**`HistoryEntry`**:

```ts
export interface HistoryEntry {
  height: bigint;
  /** Transaction position in the block, or VIRTUAL. */
  position: number;
  opIndex: number;
  kind: HistoryKindValue;
  txHash: Uint8Array | null;
  /** The encoded operation, or the encoded virtual operation. */
  data: Uint8Array;
}
```

**`encodeHistoryEntry`** / **`decodeHistoryEntry`** and the byte helpers **`historyEntryToBytes`** / **`historyEntryFromBytes`** give it a store encoding. **`virtualData`** holds the encoders of the virtual operations' payloads: `reward(validator, amount, commission)`, `slash(validator, amount, doubleSign)`, `validator(validator)` (used for jail, unjail and tombstone), `matured(validator, tokens)` (used for `unbondingMatured` and `forcedUnbond`), `redelegationMatured(source, destination, tokens)`. **`decodeVirtualData(kind, data)`** reverses them into a record for the RPC, and **`HISTORY_KIND_NAMES`** maps the numbers back to names.

**`HistoryRecorder`** is the per-block collector:

```ts
  beginTx(hash: Uint8Array, position: number): void {
    this.pending = [];
    this.txHash = hash;
    this.position = position;
    this.opIndex = 0;
  }

  /** The operation about to run, so virtual entries it causes point at it. */
  beginOp(index: number): void {
    this.opIndex = index;
  }

  /** Keep the transaction's entries if it succeeded. */
  endTx(ok: boolean): void {
    if (ok) this.entries.push(...this.pending);
    this.pending = [];
    this.txHash = null;
    this.position = VIRTUAL;
  }

  op(accounts: ObjectId[], opIndex: number, data: Uint8Array): void {
    const seen = new Set<ObjectId>();
    for (const a of accounts) {
      if (seen.has(a)) continue;
      seen.add(a);
      this.pending.push([a, { height: this.height, position: this.position, opIndex, kind: HistoryKind.operation, txHash: this.txHash, data }]);
    }
  }

  virtual(account: ObjectId, kind: HistoryKindValue, data: Uint8Array): void {
    const entry: [ObjectId, HistoryEntry] = [account, { height: this.height, position: this.position, opIndex: this.txHash ? this.opIndex : 0, kind, txHash: this.txHash, data }];
    // Inside a transaction the entry stands or falls with it.
    if (this.txHash) this.pending.push(entry);
    else this.entries.push(entry);
  }
```

`reset(height)` starts a block; `beginTx(hash, position)` and `endTx(ok)` bracket a transaction so that a failed transaction's entries, including a virtual `unjail` it produced before failing, are dropped (review finding 28). `beginOp(index)` is called by `applyTransaction` before each operation, so a virtual entry raised inside a transaction carries the transaction's position and the index of the operation that caused it; an `unjail` in the third operation is recorded against operation 2, not operation 0 (review finding 42). Outside a transaction, during `beginBlock`, there is no transaction hash, `opIndex` is 0 and virtual entries go straight to `entries`.

The application writes `entries` at commit; they are derived data outside the state root, and a node that state-synced has history only from its snapshot height.

**`HistoryLog`** is how the entries are stored. The obvious layout gives every entry a key made of its account and its sequence number, so that an account's history is one range of the store, and the store was first written that way. Its cost is in the writes. A block of transfers names accounts all over the state, so its entries landed all over the key space, one store page dirtied for every account the block named, and that was most of what made the application's commit grow over a long run. A log has the opposite shape: every entry takes the next place in one sequence shared by all accounts, so a block's entries are consecutive keys at the end of the log and a block writes a few pages however many accounts it names. Graphene keeps its account history the same way. What a log has to give back is the reading, because an account's entries are now scattered through it. So each entry carries its account, its sequence number within the account, and two pointers to earlier entries of the same account.

```ts
// Keys of the log in the application's store: 'l' entry by its place in the log, 'p' an account's count and newest
// entry, 'L' the log's length and how much of it the stored 'p' entries cover. 'a' and 'q' are the layout before it (entry by account and sequence, count by account).
const logKey = (index: bigint) => key((k) => k.u8(0x6c).u64(index));
const headKey = (account: ObjectId) => key((k) => k.u8(0x70).u64(account));
const LENGTH_KEY = key((k) => k.u8(0x4c));
const OLD_ENTRIES = key((k) => k.u8(0x61));
const OLD_COUNTS = key((k) => k.u8(0x71));
const NONE = 0xffff_ffff_ffff_ffffn;

/** Where an entry's two pointers lead: the places in the log of its account's previous entry and of an older one. */
interface Links {
  prev: bigint;
  skip: bigint;
}

interface Head {
  count: bigint;
  last: bigint;
}

interface LogRecord extends Links {
  account: ObjectId;
  sequence: bigint;
  entry: HistoryEntry;
}
```

`'l'` and a u64 hold one entry at its place in the log; the u64 is big-endian, so the store's order is the log's order. `'p'` and an account hold that account's head (`Head`): how many entries it has and the place of its newest. `'L'` holds the log's length, which is the place the next entry will take, and a second number explained with the heads below. A stored entry is 32 bytes of account, sequence, `prev` and `skip`, then the `HistoryEntry` as encoded above; `decodeLinks` reads the 32 bytes alone and `decodeRecord` the whole. `NONE` is a pointer with nothing to point at.

`prev` is the place of the account's entry before this one. Following it from the head reads the newest entries at one store read each, which is all a wallet showing recent activity needs. With `prev` alone the old end of a long history would be expensive: the first entry of an account with 5,000 would be 5,000 reads away. `skip` is the place of the account's entry whose sequence number is this one's with its lowest set bit cleared: entry 12 (binary 1100) points at 8 (1000), 8 at 0, and 7 (111) at 6 (110). Entry 0 has neither pointer. The walk that uses them is `locate`:

```ts
  /**
   * From an entry of an account at `index` with sequence `sequence`, the place of its entry `target`, an older one
   * or itself: the skip pointer while it does not pass the target, else the previous entry.
   */
  private locate(index: bigint, sequence: bigint, target: bigint, links: (index: bigint) => Links): bigint {
    while (sequence > target) {
      const l = links(index);
      const skipped = sequence & (sequence - 1n);
      if (skipped >= target) {
        index = l.skip;
        sequence = skipped;
      } else {
        index = l.prev;
        sequence -= 1n;
      }
    }
    return index;
  }
```

From an entry at `index` whose sequence is `sequence`, it returns the place of the same account's entry `target`. `sequence & (sequence - 1n)` clears the lowest set bit, so `skipped` is where the skip pointer leads; the walk takes it when that does not pass the target, and steps to the previous entry otherwise. From entry 13 to entry 5: 13 (1101) skips to 12, 12 skips to 8, 8 would skip to 0 and pass 5, so it steps to 7, 7 skips to 6, 6 would skip to 4, so it steps to 5. Five reads where `prev` alone takes eight, and the difference grows with the length: any entry of an account is found from its newest in about log² steps. The caller passes `links`, the function that reads an entry's two pointers, because `append` has to look at entries the store does not show yet.

```ts
export class HistoryLog {
  static readonly SLICES = 64;
  static readonly HEADS_HELD = 50_000;
  private readonly kv: KvStore;
  private length: bigint;
  /** Every head changed by the log's first `covered` entries is stored; the heads changed since wait in `slices`. */
  private covered: bigint;
  /** The waiting heads by slice of the account numbers, and per slice the place in the log of its oldest waiting change. */
  private slices: Map<ObjectId, Head>[] = Array.from({ length: HistoryLog.SLICES }, () => new Map());
  private since: bigint[] = new Array<bigint>(HistoryLog.SLICES).fill(0n);
  /** How many account numbers a slice spans: doubled whenever an account beyond the last slice turns up. */
  private width = 1;
  private held = 0;
  /** The slice the next block writes. */
  private turn = 0;

  constructor(kv: KvStore) {
    this.kv = kv;
    const v = kv.get(LENGTH_KEY);
    [this.length, this.covered] = v ? decode(v, (r) => [r.u64(), r.u64()]) : [0n, 0n];
    for (let index = this.covered; index < this.length; index++) {
      const e = decodeLinks(new Reader(this.stored(index)));
      this.wait(e.account, { count: e.sequence + 1n, last: index });
    }
    this.migrate();
  }
```

The heads are the one part still keyed by account, so writing each at the block that changes it would put the scattered writes back; the class comment gives it as about half of what the old layout cost. They wait in memory instead. The first version of the log kept them in one map and wrote all of them together every 64 blocks, which kept the ordinary block cheap and made the 64th carry the whole batch, its commit visibly longer than the others. The waiting heads are now divided, and each block writes a part. Measured at 192,000 accounts with blocks of 500 transfers (docs/benchmarks.md section 4.13), a block then writes about 760 to 1,000 heads and its commit takes 15.1 ms at the first fifty blocks and 19.4 ms at blocks 351 to 400, at the median, against 13.4 and 17.0 ms when the heads were written together. The work is the same in total, the means of the two overlapping; what is gone is the one block in fifty that took about 100 ms longer.

The account numbers are cut into `SLICES` slices, 64 of them, each a run of `width` consecutive account numbers. `slices[i]` is the map of the heads waiting in slice i, `held` is how many wait in all, and `turn` is the slice the next block will write. Every block that has entries writes the waiting heads of one slice and moves `turn` on by one, so after 64 such blocks every slice has had its turn and a head is in the store within 64 blocks of its change. A slice's heads are neighbours in the store, because `'p'` keys sort by account number, so the block's head writes land on a few pages, as its entries do. And a head changed five times while it waits is written once.

What makes waiting safe is the log itself. Every entry names its account and its sequence, so the heads can be read back out of the entries, provided the log knows where to start. That is `covered`, the second number under `'L'`: every head changed by the log's first `covered` entries is in the store. `since[i]` is the place in the log of the oldest change waiting in slice i, and `covered` is the smallest `since` over the slices that have something waiting, or the log's length when nothing waits (`append`, below). The constructor reads the entries from `covered` to the end in order and gives each one's head to `wait`: "count is this sequence plus one, newest is this place". A later entry of the same account overwrites an earlier one, and the waiting heads are as they were when the node stopped. Some of the entries read again belong to heads that were already stored, in slices whose turn came after the oldest waiting change; reading them does no harm, since what they give is what the store already says or something newer. The log is the heads' journal. The constructor ends with `migrate()`, described last.

```ts
  private slice(account: ObjectId): number {
    return Math.min(HistoryLog.SLICES - 1, Math.floor(instanceOf(account) / this.width));
  }

  /** Keep a head, changed by the entry at `head.last`, until its slice's turn. */
  private wait(account: ObjectId, head: Head): void {
    while (instanceOf(account) >= this.width * HistoryLog.SLICES) {
      // Twice the width: slices 2i and 2i + 1 become slice i.
      const merged = Array.from({ length: HistoryLog.SLICES }, () => new Map<ObjectId, Head>());
      const since = new Array<bigint>(HistoryLog.SLICES).fill(0n);
      this.slices.forEach((waiting, i) => {
        if (waiting.size === 0) return;
        const to = i >> 1;
        if (merged[to]!.size === 0 || this.since[i]! < since[to]!) since[to] = this.since[i]!;
        for (const [a, h] of waiting) merged[to]!.set(a, h);
      });
      this.slices = merged;
      this.since = since;
      this.width *= 2;
    }
    const i = this.slice(account);
    const waiting = this.slices[i]!;
    if (waiting.size === 0) this.since[i] = head.last;
    if (!waiting.has(account)) this.held++;
    waiting.set(account, head);
  }

  private store(w: KvWriter, i: number): void {
    const waiting = this.slices[i]!;
    for (const [account, head] of waiting) w.put(headKey(account), encode((wr) => wr.u64(head.count).u64(head.last)));
    this.held -= waiting.size;
    waiting.clear();
  }
```

`slice(account)` is the account's instance number divided by `width`, and anything past the end goes to the last slice. `width` starts at 1, so at first slice i is account i alone. That cannot stay: the range of account numbers is not known when the log is made, and it grows. So `wait` first checks whether the account lies beyond the last slice, at `width * SLICES` or more, and while it does, doubles the width. Doubling merges neighbours: slices 2i and 2i + 1 become slice i (`i >> 1`), their maps poured together, and the merged slice's `since` is the smaller of the two, taken only from slices that had something waiting. The upper half of the slices is then empty and takes the new accounts. With 6,400 accounts the width settles at 128 (64 slices of 128 cover 8,192), which is why the test below expects a block's head writes to span fewer than 128 account numbers. After that `wait` puts the head in its slice. If the slice was empty this head is its oldest waiting change, so `since[i]` is set to `head.last`, the place of the entry that changed it; `held` goes up only for an account that was not already waiting.

`store(w, i)` puts every head of slice i into the write `w`, 16 bytes each under `'p'` and the account, takes them off `held` and empties the slice. It does not touch `since[i]`: an empty slice's `since` is not looked at, and the next head to wait there sets it.

```ts
  /** How many entries the account has, and the place in the log of its newest. */
  private head(account: ObjectId): Head {
    const waiting = this.slices[this.slice(account)]!.get(account);
    if (waiting) return waiting;
    const v = this.kv.get(headKey(account));
    return v ? decode(v, (r) => ({ count: r.u64(), last: r.u64() })) : { count: 0n, last: NONE };
  }
```

`head(account)` looks in the account's slice first and then in the store, and an account with neither has a count of 0 and `NONE` for its newest.

**`append(w, entries)`** adds a block's entries as part of the store write `w` that the application's `persist` has open:

```ts
  /** Append a block's entries, in the order they were recorded, as part of the write `w`; with `flush`, the waiting heads too. */
  append(w: KvWriter, entries: Iterable<[ObjectId, HistoryEntry]>, flush = false): void {
    // The store may not show this write's own entries yet, so what the block has added so far is kept here.
    const heads = new Map<ObjectId, Head>();
    const added = new Map<bigint, Links>();
    const links = (index: bigint): Links => added.get(index) ?? decodeLinks(new Reader(this.stored(index)));
    const start = this.length;
    for (const [account, entry] of entries) {
      const head = heads.get(account) ?? this.head(account);
      const sequence = head.count;
      const l: Links = { prev: head.last, skip: sequence === 0n ? NONE : this.locate(head.last, sequence - 1n, sequence & (sequence - 1n), links) };
      const index = this.length++;
      added.set(index, l);
      w.put(logKey(index), encode((wr) => (wr.u64(account).u64(sequence).u64(l.prev).u64(l.skip), encodeHistoryEntry(wr, entry))));
      heads.set(account, { count: sequence + 1n, last: index });
    }
    if (this.length === start) return;
    for (const [account, head] of heads) this.wait(account, head);
    if (flush || this.held >= HistoryLog.HEADS_HELD) for (let i = 0; i < HistoryLog.SLICES; i++) this.store(w, i);
    else this.store(w, this.turn);
    this.turn = (this.turn + 1) % HistoryLog.SLICES;
    this.covered = this.length;
    this.slices.forEach((waiting, i) => {
      if (waiting.size > 0 && this.since[i]! < this.covered) this.covered = this.since[i]!;
    });
    w.put(LENGTH_KEY, encode((wr) => wr.u64(this.length).u64(this.covered)));
  }
```

For each entry the account's head comes from `heads` if the block has already written for that account, and from `head(account)` otherwise. The sequence number is the count, `prev` is the head's newest place, and `skip` is found by `locate`, starting at the previous entry (sequence less one) and looking for the sequence with the lowest bit cleared. For an odd sequence that target is the previous entry itself and nothing is read; the class comment puts the average at one read. The entry takes the place `this.length++` and the head moves on. Two maps exist because the store may not show the write's own puts until the write completes: `heads` holds the heads as this block has moved them, and `added` the pointers of the entries this block has added, which `links` consults before the store. A block with no entries writes nothing and does not use up a turn. Otherwise the block's heads go to `wait`, each into its slice, and then one slice is stored: the one whose turn it is, which need not hold any of this block's accounts. Two cases store all 64 at once. One is `flush`, which only `migrate` passes. The other is `HEADS_HELD`: should 50,000 heads ever wait, the block writes them all rather than let the memory and the journal grow. `turn` then moves to the next slice, wrapping after the last.

`covered` is worked out afresh at every block. It starts at the log's length, which is right when nothing waits, and is lowered to the smallest `since` among the slices that still hold heads. Take three blocks with a width of 1. Block one changes the heads of accounts 0 and 5 with entries 0 and 1; slice 0 is stored, slice 5 waits with `since` 1, and `covered` is 1. Block two changes account 9 with entry 2; slice 1 is stored, which is empty, and `covered` stays 1, the oldest waiting change being still account 5's. A stop now loses nothing: the log opened next reads entries 1 and 2 and has the heads of accounts 5 and 9 waiting again. The sixth block with entries has slice 5's turn: account 5's head is stored, and `covered` moves up to 2, where account 9 still waits, its slice's turn being the tenth block's. `'L'` is written with both numbers at every block. So a block writes its entries, consecutive at the end of the log, the waiting heads of one stretch of the account numbers, and one small value.

**`read(account, from, limit, reverse)`** is what `accountHistory` returns, and **`total(account)`** is the count from the head:

```ts
  /** An account's entries, oldest first from sequence `from`, or newest first, skipping the newest `from`, when reversed. */
  read(account: ObjectId, from: bigint, limit: number, reverse: boolean): { entries: (HistoryEntry & { sequence: bigint })[]; total: bigint } {
    const head = this.head(account);
    const total = head.count;
    const entries: (HistoryEntry & { sequence: bigint })[] = [];
    // The newest sequence wanted; the entries are read from it backwards either way.
    let sequence = reverse ? total - 1n - from : (from + BigInt(limit) < total ? from + BigInt(limit) : total) - 1n;
    const lowest = reverse ? 0n : from;
    if (limit <= 0 || from < 0n || sequence < lowest) return { entries, total };
    let index = this.locate(head.last, total - 1n, sequence, (i) => decodeLinks(new Reader(this.stored(i))));
    for (; sequence >= lowest && entries.length < limit; sequence--) {
      const r = decode(this.stored(index), decodeRecord);
      entries.push({ ...r.entry, sequence });
      index = r.prev;
    }
    if (!reverse) entries.reverse();
    return { entries, total };
  }
```

Both directions are read the same way: work out the newest sequence wanted, `locate` it from the head, then follow `prev` down. Newest first, the newest wanted is `total − 1 − from` and the walk may go down to 0. Oldest first, the page is the sequences from `from` to `from + limit − 1`, or to the newest if the account has fewer, and it stops at `from`; the entries come out newest first and are reversed at the end. With ten entries, `from` 2 and a limit of 3: the newest wanted is 4, `locate` goes from 9 to 4 (9 skips to 8, 8 would skip to 0 and pass, so 7, 7 skips to 6, 6 skips to 4), entries 4, 3 and 2 are read, and the result is 2, 3, 4. A limit of zero or less, a negative `from`, or a `from` past the end gives no entries and the total. Each entry is returned with its `sequence`, which a client passes back as `from` to page on.

**`migrate()`** (private) is for a store written with the earlier layout, `'a'`, account and sequence for an entry and `'q'` and account for a count. The first time such a store is opened every old entry is read, the list is sorted by height, then account, then sequence, appended to the log through `append` with `flush` set, so the heads are stored with it and not left waiting, and the old keys are deleted, all in one write. Each account's entries keep their order, so they keep their sequence numbers. Every entry is held in memory for it, once; the next open finds no old keys and returns.

### src/app/core/staking.ts

The staking rules of `STAKING.md`. The file's header states the invariant that makes the rest simple: "A validator holds `tokens` and `shares`; a delegation owns shares. The rate tokens/shares rises with rewards and falls with slashes, so every delegator's value moves together and nothing is tracked per delegator." And a warning: `beginBlock` and `endBlock` do not open a session, because a block is final; a throw there is a bug, not a bad transaction.

Constants: **`SHARE_SCALE`** = 1000n (lowered from 10^6 after review finding 7, when valid delegations overflowed the u64 share field), `BPS` = 10,000, `PPB_PER_BPS` = 100,000, `YEAR_MS` = 365 days.

Lookups:

- **`validatorOf(db, id)`** fetches or throws `validator X does not exist`.
- **`validatorByAddress(db, address)`** finds a validator by its current consensus address through `byConsensusAddress`, falling back to the `validatorKey` records so that evidence against a rotated key still finds its validator.
- **`keyEverUsed(db, address)`** asks the `validatorKey` index; a consensus key may serve one validator, ever. **`recordValidatorKey(db, validator, consensusKey)`** adds a record.
- **`validatorByOperator`**, **`delegationOf(db, delegator, validator)`**, **`signingInfoOf`** are index lookups.
- **`precisionOf(db)`** reads the core asset's precision; **`powerOf(tokens, precision)`** is `tokens / 10^precision`, voting power in whole tokens.

Shares:

```ts
export function tokensForShares(v: Validator, shares: bigint): bigint {
  return v.shares === 0n ? 0n : (shares * v.tokens) / v.shares;
}

export function sharesForTokens(v: Validator, tokens: bigint): bigint {
  return v.shares === 0n || v.tokens === 0n ? tokens * SHARE_SCALE : (tokens * v.shares) / v.tokens;
}
```

- **`selfBondOf(db, v)`** is what the operator's own delegation is worth.
- **`bond(db, delegator, v, tokens)`** issues shares, refuses a delegation that would be worth no share at all (`delegation is worth no shares at this exchange rate`) and one that would push either field past u64 (`delegation would overflow the validator`), raises the validator's `tokens` and `shares`, and creates or grows the delegation. The caller has already taken the tokens from somewhere. The zero-share refusal matters once rewards have raised the rate well above the initial one: `sharesForTokens` rounds down, so a small enough delegation computes to zero shares, and without the check the tokens would still be added to the validator, where the existing delegators own all of them, while the delegator receives a delegation object that owns nothing and can never be undelegated. Refusing it keeps every token behind a validator owned by some delegation.
- **`unbond(db, d, v, shares)`** releases `tokensForShares` tokens, lowers both fields, removes an emptied delegation, and returns `{ tokens, validator }`.
- **`reward(db, v, amount, commissionBps)`** adds the amount to `tokens` and mints the commission as shares to the operator, returning whether it paid:

```ts
export function reward(db: ObjectDatabase, v: Validator, amount: bigint, commissionBps: number): boolean {
  if (amount <= 0n) return false;
  // Shares outstanding over no tokens (a full slash) have no exchange rate to mint commission at; the pool keeps the reward.
  if (v.tokens === 0n && v.shares > 0n) return false;
  const commission = (amount * BigInt(commissionBps)) / BPS;
  let updated = db.modify(ValidatorType, v.id, (x) => ({ ...x, tokens: x.tokens + amount }));
  // With no shares outstanding the operator is the only party; everything is its commission.
  let minted = updated.shares === 0n ? amount * SHARE_SCALE : (commission * updated.shares) / (updated.tokens - commission);
  if (updated.shares + minted > MAX_U64) minted = 0n; // the operator forgoes commission rather than break the block
  if (minted === 0n) return true;
  updated = db.modify(ValidatorType, v.id, (x) => ({ ...x, shares: x.shares + minted }));
  const d = delegationOf(db, v.operator, v.id);
  if (d) db.modify(DelegationType, d.id, (x) => ({ ...x, shares: x.shares + minted }));
  else db.create(DelegationType, (id) => ({ id, delegator: v.operator, validator: v.id, shares: minted }));
  return true;
}
```

The formula `c × shares / (tokens − c)` is `STAKING.md` section 5: after adding the reward, mint enough shares that the operator owns exactly the commission's worth at the new rate, so every other delegator's value rose by its share of `amount − commission`. The one case it cannot handle is a validator with shares outstanding over zero tokens, which is what repeated slashing leaves behind: there is no exchange rate, so there is no "commission's worth" to mint, and adding the reward would hand the whole amount to delegations that were already worth nothing. The function declines instead, and `payRewards` reads the return value so the pool keeps what was not paid.

- **`slash(db, v, bps)`** cuts `tokens` by the fraction, leaves `shares` alone, and pays the cut into the community pool.
- **`resetSigningInfo(db, validator, window)`** zeroes a validator's window (creating the record if needed); the private `freshSigningInfo` and `windowBytes` size the bitmap at `ceil(window / 8)` bytes.
- **`createValidator(db, operator, consensusKey, selfBond, height)`** creates the validator object at zero, records the key, creates the signing record, and bonds the self-bond.
- **`pendingEntries(db, type, index, prefix)`** counts queue entries under an index prefix, for the `maxEntries` caps.

The set:

```ts
export function computeActiveSet(db: ObjectDatabase, params: StakingParameters, precision: number): ActiveValidator[] {
  const out: ActiveValidator[] = [];
  for (const v of db.scan(ValidatorType, 'byPower', new Uint8Array(0))) {
    if (out.length >= params.maxValidators) break;
    const power = powerOf(v.tokens, precision);
    if (power < 1n) break; // the index is descending by stake
    if (v.status !== ValidatorStatus.candidate) continue;
    if (selfBondOf(db, v) < params.minSelfBond) continue;
    out.push({ validator: v.id, publicKey: v.consensusKey, power });
  }
  return out;
}
```

Top N candidates by stake with power at least one and the self-bond met. A validator whose self-bond has been slashed below the minimum drops out unslashed, as `STAKING.md` section 4 says, and comes back when the operator tops up.

- **`diffActiveSets(prev, next)`** produces the engine's `ValidatorUpdate[]`, keyed by consensus key: new or changed members with their power, departed members with power 0. A rotated key is a removal and an addition.
- **`totalBonded(db)`** sums the tokens of every non-tombstoned validator (candidates and jailed).
- **`bootstrapValidators(db, list)`** is genesis: it checks each listed validator (minimum self-bond, operator without a validator, unused key) with `Error`, not `TxError`, since genesis is trusted configuration, moves each self-bond from the operator's balance into a new validator at height 0, computes the first active set and seeds `dynamic.active`, all three `expectedSigners` slots and `bonded`.

The block steps, all private except the two entry points:

- `matureQueues(db, time, core, history)` pays every unbonding entry with `completion <= time` back to its delegator and removes it, recording `unbondingMatured`; then removes matured redelegation entries, recording `redelegationMatured`. Both scans walk `byCompletion` and stop at the first future entry. It is the last step of `beginBlock`, for a reason given below.
- `expireProposals(db, time)` removes proposals past their expiration.
- `mint(db, params, time)` is the Cosmos-style mint:

```ts
function mint(db: ObjectDatabase, params: StakingParameters, time: bigint): void {
  const d = getDynamic(db);
  const dt = time - d.lastMintTime;
  if (dt <= 0n) return;
  const g = getGlobal(db);
  const core = assetOf(db, g.coreAsset);
  const supply = core.currentSupply;
  const bondedBps = supply > 0n ? (d.bonded * BPS) / supply : 0n;
  const step = (BigInt(params.inflationChangeBpsPerYear) * PPB_PER_BPS * dt) / YEAR_MS;
  let rate = bondedBps < BigInt(params.goalBondedBps) ? d.inflationPpb + step : d.inflationPpb - step;
  const min = BigInt(params.inflationMinBps) * PPB_PER_BPS;
  const max = BigInt(params.inflationMaxBps) * PPB_PER_BPS;
  if (rate < min) rate = min;
  if (rate > max) rate = max;
  let minted = (supply * rate * dt) / (1_000_000_000n * YEAR_MS);
  if (minted > core.maxSupply - supply) minted = core.maxSupply - supply;
  if (minted > 0n) db.modify(AssetType, core.id, (x) => ({ ...x, currentSupply: x.currentSupply + minted }));
  db.modify(DynamicType, DYNAMIC_ID, (x) => ({ ...x, communityPool: x.communityPool + minted, inflationPpb: rate, lastMintTime: time }));
}
```

The rate moves first, then the new rate mints the elapsed fraction of a year; `bonded` is the figure `endBlock` computed at the previous height. The mint is the only way the core supply ever grows.

- `payRewards(db, req, params, history)` pays `fixedRewardPerBlock` from the pool if it holds that much: the proposer's bonus first, then the rest split among the validators behind `req.lastCommitSigners` pro rata to their `tokens` as they stand now (`STAKING.md`: "the signer share of a block reward is computed on the stake before the proposer bonus"; the code reads the signers' tokens before paying anyone). Tombstoned validators and validators with no tokens are skipped among the signers, and a payment that `reward` declines (a validator whose tokens are gone but whose shares are not) is not counted as paid, so the pool keeps it; rounding dust stays in the pool too; each payment that went through produces a `reward` virtual entry for the operator. Nothing is paid at height 1.
- `trackDowntime(db, req, params, log, history)` advances the window of every validator in `expectedSigners[2]`, the set that was supposed to sign the previous commit:

```ts
    const bitmap = info.bitmap.slice();
    const byte = info.cursor >> 3;
    const mask = 1 << (info.cursor & 7);
    const wasMissed = (bitmap[byte]! & mask) !== 0;
    const missedNow = !signed.has(toHex(address));
    if (missedNow) bitmap[byte]! |= mask;
    else bitmap[byte]! &= ~mask;
    const missed = info.missed + (missedNow ? 1 : 0) - (wasMissed ? 1 : 0);
    const tracked = Math.min(info.tracked + 1, window);
    const cursor = (info.cursor + 1) % window;
    if (tracked >= window && BigInt(window - missed) < minSigned) {
```

The bit at the cursor is overwritten and `missed` adjusted by what was there before, so the count is always the number of set bits in the window. Only once the window is full (`tracked >= window`) and the signed count falls below `ceil(window × downtimeMinSignedBps / 10000)` does the validator get slashed by `downtimeSlashBps`, jailed until `req.time + downtimeJailMs`, and its window reset; `slash` and `jail` virtual entries are recorded and a warning logged. A window whose byte length does not match the current parameter (after a proposal changed `downtimeWindow`) is reset before use. Jailed and tombstoned validators are skipped.

- **`punishDoubleSign(db, v, height, time, params, history = null)`** handles evidence:

```ts
  const bps = params.doubleSignSlashBps;
  let current = slash(db, v, bps);
  history?.virtual(v.operator, HistoryKind.slash, virtualData.slash(v.id, v.tokens - current.tokens, true));
  history?.virtual(v.operator, HistoryKind.tombstone, virtualData.validator(v.id));
  // Stake unbonded at height c still signs at c+1, so entries from the height before the infraction are liable too.
  for (const u of db.range(UnbondingType, 'byValidator', key((k) => k.id(v.id)))) {
    if (u.creationHeight < height - 1n) continue;
    const cut = (u.tokens * BigInt(bps)) / BPS;
    if (cut === 0n) continue;
    adjustPool(db, cut);
    db.modify(UnbondingType, u.id, (x) => ({ ...x, tokens: x.tokens - cut }));
  }
```

Slash the validator; slash every unbonding entry and every redelegation entry created at or after `height − 1` (review finding 10: stake unbonded at H still had voting power at H+1 because set changes take two heights); for a redelegation the cut is taken out of the destination delegation at the destination's rate, as Cosmos does; tombstone; convert every remaining delegation into an unbonding entry at its current worth (`forcedUnbond` entries); send any rounding dust to the pool; zero the validator; delete its signing record. The validator is empty from here on, and `delegate` to it is refused forever.

- **`beginBlock(db, req, log, history = null)`** runs the steps in order: expire proposals, mint, pay rewards, track downtime, `punishDoubleSign` for every `req.misbehavior` entry whose validator is not already tombstoned (a second report of the same infraction is ignored), and only then `matureQueues`. The queues come last so that stake whose liability ends in this very block is still there to be punished: an unbonding entry completes at a time, evidence arrives in a block, and the block that carries evidence against a validator can be the block whose time matures an entry that was backing it. Maturing first would pay that entry out in full a few lines before `punishDoubleSign` went looking for it; maturing last, the entry is slashed and then released. The staking test "punishes stake whose unbonding matures in the very block that carries the evidence" pins the order.
- `tallyProposals(db, log)` sums the `tokens` of each proposal's signalling validators that are currently active and adopts when `3 × support > 2 × activeStake`. If several adopt in one block, the lowest id wins; all adopted proposals are removed. Adoption replaces `global.fees` and `global.staking` wholesale, with three qualifications. First, parameters under which `computeActiveSet` would return nothing (a `minSelfBond` nobody meets, say) are not adopted at all: the proposals are removed and a warning logged, because a chain with no validator cannot produce the block in which anyone could fix it. Second, if the new `unbondingPeriodMs` is longer than the old, every pending unbonding and redelegation entry has its completion pushed out by the difference: the period exists to give evidence time to arrive, and stake already on its way out under the shorter period would otherwise escape evidence that the longer period was voted in to catch. Third, if `downtimeWindow` changed, every signing record is reset to the new size, since `trackDowntime` only resets a record whose byte length differs and a window of the same byte length would keep its stale bits and cursor.
- **`endBlock(db, log)`** tallies proposals, recomputes the active set with the (possibly new) parameters, diffs it against `dynamic.active`, and rotates `expectedSigners`:

```ts
export function endBlock(db: ObjectDatabase, log: Logger): ValidatorUpdate[] {
  tallyProposals(db, log);
  const params = getGlobal(db).staking;
  const d = getDynamic(db);
  const next = computeActiveSet(db, params, precisionOf(db));
  const updates = diffActiveSets(d.active, next);
  const addrs = next.map((a) => addressOf(a.publicKey));
  db.modify(DynamicType, DYNAMIC_ID, (x) => ({
    ...x,
    active: next,
    expectedSigners: [addrs, x.expectedSigners[0] ?? addrs, x.expectedSigners[1] ?? addrs],
    bonded: totalBonded(db),
  }));
  return updates;
}
```

The returned updates are what `finalizeBlock` hands the engine, which applies them at H+2 (`STAKING.md` section 9: a validator jailed at H still appears in the commits of H+1 and H+2, and its signatures still earn the signer share for those blocks).

The two-height delay is easy to lose track of, so here is the timeline, writing S(H) for the set `endBlock` computes at the end of block H:

| moment | validators of the block | who signed its `lastCommit` | `expectedSigners` after `endBlock` |
|---|---|---|---|
| block H | S(H−2) | validators of H−1, that is S(H−3) | [S(H), S(H−1), S(H−2)] |
| block H+1 | S(H−1) | validators of H, that is S(H−2) | [S(H+1), S(H), S(H−1)] |
| block H+2 | S(H) | validators of H+1, that is S(H−1) | [S(H+2), S(H+1), S(H)] |

When `beginBlock` runs for block H+1 it sees `expectedSigners` as left by the end of block H, `[S(H), S(H−1), S(H−2)]`, and the previous commit was signed by S(H−2), so `trackDowntime` reads slot 2. Genesis seeds all three slots with the first set, since there is no earlier history. The same delay explains two details in `payRewards`: the proposer is looked up by the address in the block, which after a key rotation is still the old key until the rotation lands, and a validator removed from the set since is simply absent from `lastCommitSigners` and skipped.

The defaults, as `DEFAULT_STAKING` in `genesis.ts` writes them and `parseStakingParameters` converts them (the four amounts are whole tokens in genesis, base units in state):

| parameter | default | in state with precision 5 |
|---|---|---|
| maxValidators | 21 | 21 |
| unbondingPeriodMs | 7 days | 604,800,000 |
| minSelfBond | 10,000 tokens | 1,000,000,000 |
| minDelegation | 10 tokens | 1,000,000 |
| validatorCreationFee | 1,000 tokens | 100,000,000 |
| commissionBps | 1,000 (10%) | 1,000 |
| fixedRewardPerBlock | 1 token | 100,000 |
| proposerBonusBps | 500 (5%) | 500 |
| doubleSignSlashBps | 500 (5%) | 500 |
| downtimeWindow | 1,000 blocks | 1,000 |
| downtimeMinSignedBps | 5,000 (50%) | 5,000 |
| downtimeJailMs | 10 minutes | 600,000 |
| downtimeSlashBps | 1 (0.01%) | 1 |
| maxEntries | 7 | 7 |
| proposalLifetimeMs | 7 days | 604,800,000 |
| goalBondedBps | 6,700 (67%) | 6,700 |
| inflationMinBps | 700 (7%) | 700 |
| inflationMaxBps | 2,000 (20%) | 2,000 |
| inflationChangeBpsPerYear | 1,300 (13%) | 1,300 |

The tests shrink several of these (a window of four blocks, ten-second unbonding) so a scenario fits in a handful of blocks; the rules do not care about the magnitudes.

The invariants of `STAKING.md` section 11, and what in this file keeps each one:

- **Supply.** `currentSupply = sum(balances) + sum(validator.tokens) + sum(unbonding.tokens) + communityPool` at every height. Every movement is a transfer between those four places: `adjustBalance` and `bond`/`unbond` move between balances and validators, `matureQueues` between unbonding entries and balances, `slash` and the fee path between validators or balances and the pool, `punishDoubleSign` between validators, entries and the pool. `mint` is the only increase, and it raises `currentSupply` and the pool together. The staking tests check this sum after every scenario, and the `assetIssue` refusal of the core asset exists to keep it true.
- **Per validator.** `shares > 0` iff `tokens > 0`, and delegation shares sum to `shares`. `bond` and `unbond` change both the validator and the delegation by the same share count; `reward` mints the commission shares into the operator's delegation and `punishDoubleSign` zeroes both fields after removing every delegation.
- **`dynamic.bonded`** equals the tokens of every candidate and jailed validator: recomputed by `totalBonded` in `endBlock` and `bootstrapValidators`.
- **Active set.** At most `maxValidators`, all candidates with power at least 1 and the self-bond met, no higher-power candidate excluded: `computeActiveSet` walks `byPower` in order and stops at the first validator below one whole token.
- **Pending entries** per pair never exceed `maxEntries` except for the forced conversions of a tombstone, which ignore the cap on purpose.
- **A proof by consensus address at height H names the validator whose stake, as computed at H, the engine applies at H+2.** The app hash of H sits in header H+1, so that is the header the proof is checked against, but the set in header H+1's `validatorsHash` is S(H−1), computed a block earlier, and its `nextValidatorsHash` is the set for H+2. A delegation or a key rotation in block H is already in the proven object and in S(H), and not yet in any set that signs H+1; what the proof describes is the stake and key the chain will enforce two heights on.

### src/app/core/genesis.ts

The application's share of genesis: hand-edited JSON, parsed once into objects. The header explains the two parsers: a small genesis is parsed as a string; one too large for that ("a token distribution, a migrated chain: hundreds of megabytes of public keys") lives in its own file and is read as a token stream with `stream-json`, one account at a time, so memory holds the objects and never the text (review finding 35: V8 refuses strings over 512 MB).

JSON shapes: **`AuthorityJson`** (`threshold`, `keys` as hex public keys with weights, optional `accounts` as `"3.0"`-style id strings), **`AccountJson`** (`name`, `owner`, `active`, optional `balance` as a string of base units), **`GenesisValidatorJson`** (`operator` by account name, `consensusKey` hex, `selfBond` in whole tokens), **`StakingParametersJson`** (any subset, the four amount fields in whole tokens), **`FeeScheduleJson`** (any subset, base units), and **`AppGenesisJson`**:

```ts
export interface AppGenesisJson {
  coreAsset?: { symbol?: string; precision?: number; maxSupply?: string };
  fees?: FeeScheduleJson;
  maxTxExpirationMs?: string;
  accounts?: AccountJson[];
  staking?: StakingParametersJson;
  /** Whole tokens, created at genesis. */
  communityPool?: string | number;
  validators?: GenesisValidatorJson[];
}
```

A small genesis looks like this (public keys are 2,624 hex characters each, elided here):

```json
{
  "coreAsset": { "symbol": "CORE", "precision": 5 },
  "fees": { "scale": 10000, "accountCreate": { "premiumFee": "20000" } },
  "staking": { "maxValidators": 4, "minSelfBond": 100 },
  "communityPool": 1000,
  "accounts": [
    { "name": "faucet", "owner": { "threshold": 1, "keys": [{ "publicKey": "<hex>", "weight": 1 }] }, "active": { "threshold": 1, "keys": [{ "publicKey": "<hex>", "weight": 1 }] }, "balance": "100000000000" },
    { "name": "op0", "owner": { "threshold": 1, "keys": [{ "publicKey": "<hex>", "weight": 1 }] }, "active": { "threshold": 1, "keys": [{ "publicKey": "<hex>", "weight": 1 }] }, "balance": "100000000" }
  ],
  "validators": [{ "operator": "op0", "consensusKey": "<hex>", "selfBond": 200 }]
}
```

Everything is optional except that a validator must name an account that exists; an empty document is a chain with a core asset and no accounts. `faucet` becomes `3.0` and issues the core asset; `op0` becomes `3.1` and operates validator `7.0`, with 200 whole tokens (20,000,000 base units) moved from its balance into the validator at genesis.

**`AppGenesis`** is the parsed form with bigints, authorities and byte keys. Be careful with units: account balances and fee amounts are base units; `communityPool`, each validator's `selfBond`, and the staking amounts `minSelfBond`, `minDelegation`, `validatorCreationFee` and `fixedRewardPerBlock` are whole tokens multiplied by `10^precision` at parse time. The file's header states the rule: "Balances and fees in the JSON are base units; the community pool, self-bonds and the four staking amounts are whole tokens, converted at parse time."

**`DEFAULT_FEES`** is `FEES.md`'s default schedule: transfer 100; accountCreate basic 1,000, premium 5,000, 100 per KB; accountUpdate 100 plus 100 per KB; assetCreate 100,000 / 50,000 / 10,000 by symbol length; validatorCreate 1,000; everything else 100; scale 10,000. **`DEFAULT_MAX_TX_EXPIRATION_MS`** is one hour. **`DEFAULT_STAKING`** is `STAKING.md` section 4: 21 validators, seven-day unbonding, self-bond 10,000, delegation 10, creation fee 1,000, commission 10%, reward 1 per block, proposer bonus 5%, double-sign slash 5%, window 1,000 at 50%, ten-minute jail, downtime slash 0.01%, seven entries, seven-day proposals, 67% bonded goal, inflation 7% to 20% moving 13% a year.

- **`parseStakingParameters(j, precision)`** merges the JSON over the defaults, converts the whole-token fields, and validates with `checkStakingParameters`, throwing `genesis staking parameters: ...`.
- `authorityFromJson` and `accountFromJson` (private) convert one account.
- `appGenesisFrom(j, accounts)` (private) builds everything but the accounts: the fee schedule over `DEFAULT_FEES` (validated), the core asset (default symbol `CORE`, precision 5, max supply `MAX_SHARE_SUPPLY`), the expiration window, the staking parameters, the pool and the validators.
- **`parseAppGenesis(appState)`** decodes the bytes, treats an empty document as `{}`, and parses it in one go.
- **`parseAppGenesisStream(source)`** consumes a `Readable` through `stream-json`'s parser with `streamValues: false`. It tracks the nesting depth, and when it sees the top-level key `accounts` followed by `startArray` it assembles each element with its own `Assembler`, converts it on the spot and drops the text; every other token goes to a header assembler. It rejects a non-array `accounts`, a non-object element, a document that ends early and a top-level value that is not an object. A repeated top-level `accounts` key empties the list collected so far, so the last one wins, which is what `JSON.parse` does for the inline parser; the two parsers must agree on every document or a genesis would hash differently depending on its size. Unlike the inline parser it rejects empty input, which is why the next function special-cases it.
- **`loadAppGenesis(genesis)`** chooses: no `appStateFile` means parse `appState` inline; an empty file is an empty genesis; otherwise stream the file.
- **`authorityJson(publicKeys, threshold = 1)`** and **`appGenesisBytes(g)`** build genesis documents, for `init` and the tests.
- **`applyGenesis(db, g, genesisTime, scheme)`** creates the objects in an empty database; `scheme` is the tag of the engine genesis's `signatureScheme`, which `CoreApp` passes. "Genesis is trusted configuration, so problems are fatal": it throws `Error`, never `TxError`. In order: validate the core asset; create `global` (with the scheme) and `dynamic` (height 0, time `genesisTime`, the pool, inflation at the minimum rate, `bonded: 0n`, empty sets); create every account in listing order, each with `registrar: id` (genesis accounts register themselves), checking names and authorities, the latter against the chain's scheme; then check that every member account exists, after all are created, since a member may be listed later; create the core asset as `4.0` with the first account as issuer; refuse a negative balance (`BigInt('-5')` parses without complaint, and a negative amount would both break the supply sum and fail to encode as a u64 at the first root), create a balance for every account with a positive balance and set `currentSupply` to the sum of balances and the pool, refusing anything above the max supply; check that each validator's consensus key is a well-formed key of the chain's scheme (`genesis validator X: consensus key must be a <scheme> key`) and that its operator is a genesis account; and hand the validators to `bootstrapValidators`.

```ts
  const accounts = g.accounts.map((a) => {
    const problem = checkAccountName(a.name) ?? checkAuthority(a.owner, scheme) ?? checkAuthority(a.active, scheme);
    if (problem) throw new Error(`genesis account ${a.name}: ${problem}`);
    return db.create(AccountType, (id) => ({ id, name: a.name, owner: a.owner, active: a.active, registrar: id }));
  });
```

Because ids are assigned in listing order, the first account is always `3.0`; test suites rely on that for their faucet.

### src/app/core/snapshot.ts

State snapshots for syncing from a height instead of from genesis. The header gives the contract: "A joiner that trusts the header after the snapshot height can therefore verify the manifest against that header's app hash and every chunk against the manifest, before loading anything. Nothing here needs the serving node's live state."

To see where these functions are called from, here is the joining sequence of `RPC-SYNC-PROOFS.md` section 4.2, which the sync module implements on top of this file: a node with an empty data directory and a trust anchor (a height and a header hash) runs the light client from the anchor; collects manifests from peers and picks the highest height offered by at least two of them; verifies header H+1 with the light client; verifies the manifest against that header's app hash (`verifyManifest`); fetches chunks from several peers in parallel, verifying each by its manifest hash and its range proof (`verifyChunk`); loads them into a fresh database (`importSnapshot`), which checks the root and the index roots; fetches the headers below H as far back as evidence may reach, each bound to the one above it by its hash, so that a block carrying evidence of a double sign before the join can still be checked; and finally writes the application store (`CoreApp.writeImportedState`), the validator sets, block H and the chain state in one environment-wide transaction (`KvEnv.transaction`, chapter 10), so a crash leaves either a complete join or nothing, and hands over to block sync from H+1. The serving side is `takeSnapshot`, `snapshotHeights`, `manifestBytes` and `chunkBytes` in `app.ts`.

**`SNAPSHOT_FORMAT`** is 1. **`SnapshotTypeInfo`** is one type's leaf and chunk list:

```ts
export interface SnapshotTypeInfo {
  type: number;
  nextInstance: bigint;
  typeRoot: Uint8Array;
  indexRoots: Uint8Array[];
  typeIndex: number;
  typeCount: number;
  topSiblings: Uint8Array[];
  chunkHashes: Uint8Array[];
}
```

**`SnapshotManifest`** is `{ format, height, appHash, chunkObjects, types }`. **`SnapshotChunk`** is `{ height, type, index, from, to, objects, siblings }` where `objects` are the present instances in `[from, to)` with their encodings and `siblings` the range proof. **`encodeManifest`** / **`decodeManifest`** and **`encodeChunk`** / **`decodeChunk`**, with the byte helpers **`manifestToBytes`**, **`manifestFromBytes`**, **`chunkToBytes`**, **`chunkFromBytes`**, give both a wire form; the decoders bound index roots at 16, top siblings at 64, chunk hashes at a million and chunk siblings at 128.

**`exportSnapshot(db, types, height, chunkObjects)`** walks `db.typeOrder`, asks the database for each type's leaf at that height (`typeLeafProofAt`), and for every range of `chunkObjects` instances collects the encodings of the objects present at that height and attaches `rangeProofAt(type, from, to, height)`. The encodings come from `bytesAt`, straight from the database's arena or its history of past values, so nothing is decoded and encoded again:

```ts
      for (let i = from; i < to; i++) {
        // The bytes as of the height, straight from the arena or the history: no decode and re-encode.
        const bytes = db.bytesAt(objectId(type, i), height);
        if (bytes) objects.push([i, bytes]);
      }
```

Each chunk's sha256 goes into the manifest. The height must be inside the database's retention window, which it always is right after commit.

**`verifyManifest(appHash, m, types?)`** checks the format, that the manifest's app hash equals the trusted header's, that every type leaf folds to it (`typeLegMatches`), and that each type lists exactly `ceil(nextInstance / chunkObjects)` chunks. With the registered `types` given, it also requires the manifest to name every one of them exactly once, in id order, each with the right `typeIndex` and `typeCount`. The leaf checks alone cannot catch an omission: a manifest that leaves a type out folds just as well, since each remaining leaf's path to the app hash is genuine, and the joiner would only discover the gap after fetching every chunk, when `importSnapshot` computed a root with an empty type leaf and found it did not match.

**`verifyChunk(m, raw)`** decodes the bytes (a decode failure is `malformed chunk: ...`), checks the chunk belongs to this snapshot, hashes the raw bytes against the manifest, checks the range matches the index, then rebuilds the leaves:

```ts
  const leaves: Uint8Array[] = [];
  let next = 0;
  for (let i = chunk.from; i < chunk.to; i++) {
    const entry = chunk.objects[next];
    if (entry && entry[0] === i) {
      leaves.push(objectLeaf(objectId(chunk.type, i), entry[1]));
      next++;
    } else leaves.push(EMPTY);
  }
  if (next !== chunk.objects.length) return { error: 'chunk objects out of order or outside the range' };
  const root = rootFromRange(leaves, chunk.from, count, chunk.siblings);
  if (!root || !bytesEqual(root, info.typeRoot)) return { error: 'chunk does not fold to the type root' };
```

Absent instances (removed objects) are `EMPTY` leaves, so the dense tree's shape is reproduced exactly and the siblings fold the range to the type root.

**`importSnapshot(m, chunks, types, opts = {})`** builds a fresh `ObjectDatabase`, imports every object, sets the counters, computes `root(height)` and compares it with the manifest's app hash, then checks that the rebuilt index roots of every type match the manifest (the authenticated indices are rebuilt from the objects, so a mismatch means the chunks and the leaf disagree). **`chunkCount(m)`** sums the chunk lists.

### src/app/core/app.ts

The application itself: sessions, the signature cache, blocks, persistence, snapshots and queries. Its header states the concurrency rule the whole file rests on: "Signature verification is the only asynchronous step, because it goes to the worker pool. Everything that touches the database is synchronous and happens after any await, so the undo sessions nest cleanly even though checkTx calls overlap each other and a finalizeBlock."

**`CoreAppOptions`**: `genesis` (the engine's `Genesis`), optional `appGenesis` (already parsed, required when it lives in a file), `verifier` (the worker pool or the inline one), optional `kv` (default an in-memory store), `retainVersions`, `indexTrees` and `trees` (start the database with its secondary indices' B+ trees, or its Merkle trees, dropped and reading the store, STATE-PAGING.md sections 4 and 5; both default to resident, and the test setup turns them off for a whole run), `arenaBytes` (the most bytes the database's arena of encoded objects may take, the rest being read from the store, STATE-PAGING.md section 3.4; unbounded by default), `heapRoom` (the bytes of heap the index trees, the Merkle trees and the history window may take when a store is opened: a tier estimated to need more is left dropped and the history window is then not read back, so a state too large for the heap opens paged instead of running out while it loads; unset, every tier is opened as `indexTrees` and `trees` say), `snapshotInterval` (default 1000; 0 disables), `snapshotsKept` (default 2), `snapshotChunkObjects` (default 2000), `log`.

The store's key layout, from the constants at the top of the file:

```ts
// Key layout of the app store: 'm' meta, 'o' id, 'c' type, 'h' version, 'l' 'p' 'L' the account history's log (history.ts),
// 'i' index entry (db/indexstore.ts), 't' dense tree chunk (db/merkle.ts), 'n' sparse tree node (db/smt.ts).
const META_KEY = key((k) => k.u8(0x6d));
const OBJECT_PREFIX = key((k) => k.u8(0x6f));
const INDEX_PREFIX_KEY = Uint8Array.of(INDEX_PREFIX);
const CHUNK_PREFIX_KEY = Uint8Array.of(CHUNK_PREFIX);
```

| prefix | key | value |
|---|---|---|
| `m` | meta | height u64, app hash |
| `o` | object id u64 | the object's encoding |
| `c` | type u16 | next instance counter |
| `h` | version u64 | the database history record for that version |
| `l` | place in the log u64 | an account history entry: account u64, sequence u64, `prev` u64, `skip` u64, then the entry |
| `p` | account u64 | the account's head: its count of history entries u64 and the place of its newest u64 |
| `L` | none | the log's length u64 and how many of its entries the stored heads cover u64 |
| `i` | type u16, index position u8, key bytes (and the id u64 for a non-unique index) | the id u64 for a unique index, empty for a non-unique one |
| `t` | tree u16 (a type id, or 0 for the tree over the types), level u8, chunk u48 | a dense Merkle tree chunk: up to 1,024 hashes, trailing empties cut off |
| `n` | type u16, index position u8, path bits packed, depth u8 | a sparse Merkle tree node: `0x00` and two child hashes, or `0x01`, a key hash and the 8-byte id |
| `s` | height u64 | a snapshot manifest |
| `k` | height u64, type u16, chunk u32 | a snapshot chunk |

The three history prefixes are written and read by `HistoryLog` in `src/app/core/history.ts` (above); `'a'` and `'q'`, the layout before the log, are found only in a store that has not been opened since, and are moved into the log when it is. The three prefixes `'i'`, `'t'` and `'n'` are the database's own, defined in `src/db/indexstore.ts`, `src/db/merkle.ts` and `src/db/smt.ts` and explained in [chapter 09](09-database.md); the application only writes what the database's change list says and lends the database the store to read them back from. They are what makes the store hold every tier of the state, not only the objects: a restart no longer rebuilds the indices by decoding every object or the trees by hashing them, and the memory guard can drop either tier and let the database fall back on these keys ([chapter 8](08-node.md)). `'t'` rather than `'c'` for the chunks because `'c'` is the counters, and a chunk key of type T's tree would otherwise have had T's counter key as a prefix.

**`OpenedDatabase`** is what reopening returns: the database, the stored height and app hash, `staleHistory` (history versions in the store that fell outside the window), timing figures for the startup log (the object count, the milliseconds of the import, of the trees and root, and of the history, and `indexVersions`, how the sparse trees' past versions came back: `'records'`, `'replay'` or `'none'`), and `paged`, the names of what was left out because `heapRoom` had no room for it (`indexTrees`, `trees`, `history`; empty when everything was opened). **`OpenOptions`** says how to open it:

```ts
/** How to open a store: the database's options, and how the trees come back. */
export interface OpenOptions {
  retainVersions?: number;
  indexTrees?: boolean;
  trees?: boolean;
  /** As CoreAppOptions.arenaBytes: objects beyond it are left in the store instead of being loaded. */
  arenaBytes?: number;
  /** As CoreAppOptions.heapRoom: a tier that does not fit is opened dropped, and the history window with it. */
  heapRoom?: number;
  /**
   * Take the Merkle trees from their chunks and nodes in the store (the default) instead of hashing every object and
   * inserting every index key again. Either way the root must equal the stored app hash; a store written before the
   * trees were has none, and computes them.
   */
  fromTrees?: boolean;
  /**
   * With the trees from the store, check them before use (the default): every stored node against its children,
   * every object against its leaf, and every non-empty leaf against an object. The root then still proves that the
   * objects are the ones the app hash commits to, as it did when the trees were computed from them. Off, a restart is
   * faster and a corrupt object or tree node goes unnoticed until something reads it.
   */
  checkLeaves?: boolean;
  /**
   * With the index entries from the store, check them against the objects (the default): each object decoded for its
   * keys, every key stored and naming it, and no entry over. The app hash does not cover an unauthenticated index, so
   * this is the only thing that catches a damaged entry before a lookup goes to the wrong object. Off, a restart
   * decodes no object at all.
   */
  checkIndexEntries?: boolean;
}
```

**`openObjectDatabase(kv, types, opts = {})`** loads a database from a store written by `CoreApp`, or returns null if the store is empty:

```ts
  // With a figure for the heap's room, a tier estimated not to fit is opened dropped rather than built and then
  // dropped by the memory guard, which would be too late: the index trees first, then the Merkle trees with what is left.
  let { indexTrees, trees } = opts;
  const paged: string[] = [];
  if (opts.heapRoom !== undefined) {
    const counter = (type: number) => {
      const c = kv.get(counterKey(type));
      return c ? Number(decode(c, (r) => r.u64())) : 0;
    };
    const est = estimateTiers(types, counter);
    let room = opts.heapRoom;
    if (indexTrees === undefined && est.indexTrees > room) (indexTrees = false), paged.push('indexTrees');
    else if (indexTrees !== false) room -= est.indexTrees;
    if (trees === undefined && est.trees > room) (trees = false), paged.push('trees');
  }
  const db = new ObjectDatabase(types, { retainVersions, indexStore: kv, indexTrees, trees, objectStore: (id) => kv.get(objectKey(id)), arenaBytes: opts.arenaBytes, historyStore: (version) => kv.get(historyKey(version)) });
  // A store written before the index entries were (STATE-PAGING.md phase two) has none: the objects are decoded for
  // their keys as they always were, and the entries written once below. An empty prefix in a store that has objects
  // means exactly that, because every write of objects carries their entries in the same transaction. The same holds
  // for the trees' chunks and nodes (phase four).
  const has = (prefix: Uint8Array) => {
    const probe = kv.range(prefix, prefixEnd(prefix));
    const found = !probe.next().done;
    probe.return?.(undefined); // close the cursor rather than leave it to the collector
    return found;
  };
  const indexed = has(INDEX_PREFIX_KEY);
  const treesStored = indexed && has(CHUNK_PREFIX_KEY);
  const t0 = performance.now();
  let objects = 0;
  for (const [k, v] of kv.range(OBJECT_PREFIX, prefixEnd(OBJECT_PREFIX))) {
    db.importObject(decode(k, (r) => (r.u8(), r.u64())), v, indexed);
    objects++;
  }
  for (const t of types) {
    const c = kv.get(counterKey(t.id));
    if (c) db.setCounter(t.id, Number(decode(c, (r) => r.u64())));
  }
  const t1 = performance.now();
  // The trees come from their chunks and nodes: no object is hashed and no index key inserted into a sparse tree,
  // which was most of a restart (STATE-PAGING.md 5.3). Recomputing them gives the same root, only slower.
  if (treesStored) {
    if (opts.fromTrees ?? true) db.loadTrees(opts.checkLeaves ?? true);
    else db.assumeStoredTrees();
  }
  // The indices come from their entries rather than from inserting every key, and are checked against the objects.
  if (indexed && objects > 0) db.loadIndexEntries(opts.checkIndexEntries ?? true);
  const appHash = db.root(Number(meta.height));
  if (!bytesEqual(appHash, meta.appHash)) throw new Error('stored objects do not hash to the stored app hash');
  const missing = [...(indexed ? [] : db.lastChanges!.indices), ...(treesStored ? [] : db.lastChanges!.trees)];
  if (missing.length > 0) kv.write((w) => missing.forEach((c) => (c.value ? w.put(c.key, c.value) : w.del(c.key))));
  // That root's change list may hold the encoded bytes of every object; the store already has them.
  db.dropChanges();
```

The first lines decide what to open. The guard of [chapter 8](08-node.md) can drop a tier that is resident, but it samples once a second, and a tier too large for the heap has taken the process past its limit before the first sample; so when the caller says how much heap there is (`heapRoom`, which the node computes as 0.7 of the heap limit less the heap in use), the decision is made here, before anything is built. `estimateTiers` ([chapter 09](09-database.md)) turns the type counters in the store, an upper bound on the objects of each type, into the heap each tier would take resident, with the figures the guard's rebuild estimate uses. If the index trees do not fit the room they are opened dropped and named in `paged`; otherwise their estimate is taken off the room, unless the caller asked for them to be left out (`indexTrees: false`, which is what a node passes unless it is configured with `indexTrees: 'memory'`, `'store'` being its default, [chapter 8](08-node.md)): trees that will not be built take no room from the Merkle trees. Then the Merkle trees are opened dropped if they do not fit what is left. A tier the caller named, `indexTrees` or `trees` given as an option, is not decided here: it is opened as asked, whatever the room, which is how the test setup's `INDEX_TREES=0` and a test that wants a tier resident both keep their meaning.

The database is given the store itself as `indexStore`, the read-only view it falls back on when its trees are dropped, whichever tiers were decided or asked to start dropped, two things for the arena, `objectStore`, a function that reads one object's bytes from the `'o'` keys, and `arenaBytes`, and `historyStore`, a function that reads one version's encoded history record from the `'h'` keys, from which the database answers for a past version its window in memory does not hold ([chapter 09](09-database.md), "Past versions from the store"). With a limit, `importObject` leaves the objects that do not fit it in the store instead of copying them into the arena, and the `dropChanges()` at the end shrinks the arena to the limit ([chapter 09](09-database.md)); without one every object is loaded as before. Two probes then decide how the rest of the store is read, each one cursor positioned on a prefix and closed again: a store written by these phases has index entries under `'i'` and chunks under `'t'` (the sparse nodes always come with the chunks), and an empty prefix in a store that holds objects can only mean the store predates them, because every commit writes the objects and their entries in one transaction. With `indexed`, every `o` entry is imported as bytes with no decode at all (`importObject(id, bytes, true)`, [chapter 09](09-database.md)); without it each object is decoded once for its index keys, as a restart always did. The counters follow. Then the trees, three ways: by default `loadTrees(true)` takes every dense tree's chunks and every sparse tree's nodes from the store, so the first root hashes no object and inserts no key, and still hashes every imported object against its leaf (`checkLeaves`), which is what keeps the property the old path had, that a corrupt object store fails at startup and not when something reads the object; `checkLeaves: false` skips that and saves about an eighth of the restart; and `fromTrees: false` calls `assumeStoredTrees()` instead, which only tells the database that the trees it is about to compute from the objects are already in the store, so the first root reports no chunks, the old path kept for comparison and for a store without trees. With `indexed`, `loadIndexEntries()` fills the B+ trees, and the sparse trees unless their nodes were just loaded, from the `'i'` prefix in key order, and by default checks the entries against the objects (`checkIndexEntries`): the app hash covers only the authenticated indices, so nothing else would catch a damaged entry before a lookup went to the wrong object. Then the root at the stored height, which must equal the stored app hash, and the one-time upgrade: a store from before phase two or four has that root's change list holding every index entry or every chunk and node, which are written in one transaction, so the store is complete from then on. Finally the change list is dropped (review finding 36: otherwise a second copy of every object sat in memory). The history follows:

```ts
  const t2 = performance.now();
  const staleHistory: number[] = [];
  // Reading the window back puts every tree node and object the last hundred blocks overwrote into the heap, which
  // under a scattered load is more than the trees themselves: a store opened with a tier left out for want of room
  // starts with an empty window instead, which fills again as blocks are applied. The records stay in the store until
  // they age out, and the database reads a past version from them there (ObjectDatabase.past), so the heights stay
  // provable.
  const withHistory = paged.length === 0;
  if (!withHistory) paged.push('history');
  const oldest = db.currentVersion - (retainVersions ?? 100);
  const found = new Map<number, Uint8Array | null>();
  for (const [k, v] of kv.range(HISTORY_PREFIX, prefixEnd(HISTORY_PREFIX))) {
    const version = Number(decode(k, (r) => (r.u8(), r.u64())));
    if (version > oldest && version <= db.currentVersion) found.set(version, withHistory ? v : null);
    else staleHistory.push(version);
  }
  // The records serve the heights from the lowest one that has every record up to the current height: one missing
  // in between (a damaged store) would make every height below it read what the missing record overwrote as it is
  // now, so the heights below it are not provable and their records go.
  let from = db.currentVersion + 1;
  while (found.has(from - 1)) from--;
  for (const version of found.keys()) if (version < from) staleHistory.push(version);
  for (let version = from; version <= db.currentVersion; version++) {
    if (withHistory) db.loadHistory(version, decode(found.get(version)!, decodeHistory));
    else db.noteStoredHistory(version);
  }
  found.clear();
  const restored = withHistory ? db.restoreIndexVersions() : 'none';
  const timing = { objects, importMs: Math.round(t1 - t0), rootMs: Math.round(t2 - t1), historyMs: Math.round(performance.now() - t2), indexVersions: restored };
```

The history keys are read in one pass. A record outside the retention window is reported as stale, for the next commit to delete; one inside it is noted in `found`, with its bytes if the window is to be read back. Then the records that will be used are chosen: `from` starts above the current version and moves down while the record below it is there, so it stops at the lowest version that has every record from itself up to the current height. Normally that is the whole window. In a store that has lost a record (a damaged store) it is the version above the gap, and the records found below the gap join `staleHistory`. They could not be used: a record says what its version overwrote, so a height below the gap, read without the missing record, would see whatever that record overwrote as it is now. The heights below the gap are therefore not provable (`lowestProvableHeight` rises to the gap, the version just below `from`), a proof there is refused as `not available` rather than answered wrongly, and the records go with the next commit. The database makes the same refusal on its own if a record goes missing while it runs ([chapter 09](09-database.md), `past()`).

The records from `from` up are then loaded in ascending order with `loadHistory`, and `restoreIndexVersions()` gives the authenticated indices their past versions so that name proofs at past heights work again. It takes them from the sparse tree nodes the records carry, each older version built from what the commit after it overwrote, and returns `'records'`; if a record in the window was written before those nodes were kept, or does not hold a node a version needs, it replays every key from the object history as a restart always did and returns `'replay'`; with no past version to restore it returns `'none'` ([chapter 09](09-database.md), step 7). The answer goes into the timing object as `indexVersions`, beside `historyMs`, the time all of this took, and so into the line `loaded application state`.

Unless a tier was left out: then the window is not read back either, and `history` joins the names in `paged`. Reading the window back puts every tree node and object the window's blocks overwrote into the heap, which under a scattered load is more than the trees that were just judged not to fit. The database then starts with an empty window in memory, which fills again one block at a time, and `indexVersions` is `'none'`. The earlier heights stay provable all the same. The pass over the keys still runs, because the records outside the window must still be found and reported as stale and a gap must still be found, and for each record from `from` up it calls `noteStoredHistory(version)` instead of `loadHistory`: the record is not decoded (its bytes are not even kept in `found`), the database only learns that the store holds it, and lowers the oldest version its history store can answer for to the one before it. `lowestVersion` is then what it would have been had the window been read, and a proof at a height before the one the store was opened at is read from the records where they lie, slower than from memory and at no cost in memory. The records stay in the store untouched and age out of it as they would have, so the same store opened later with room has its whole window back in memory. The store is never trusted blindly: a corrupted object makes the root differ, or fails the leaf check, and the node refuses to start; `test/app.test.ts` overwrites alice's object with bob's bytes and expects `does not hash to its leaf` from the default path and `do not hash to the stored app hash` from the recomputing one. What the three paths cost on the same store, 191,896 accounts under secp256k1 (STATE-PAGING.md 5.3): the trees from the store with the leaf check 5.18 s, without it 4.56 s, the trees computed from the objects 8.46 s; the restart as a whole went from 8.41 s before phase four to 5.2 s, and what was left was mostly the history, 3.5 s of it, since rebuilding the sparse trees' past versions replayed every account. That measurement predates `restoreIndexVersions`. With the past versions taken from the records the same restart is 2.91 s: 0.31 s reading the store, 2.59 s for the indices, the trees and the root with every check, and 2 ms for the history. Without the leaf check it is 1.46 s, with the trees computed from the objects 5.41 s, and the heap after the restart is 381 MiB where it was 572.

**`CoreApp`** implements `Application`. Its fields: `chainId`, the public `db`, the store, the verifier, the signing `context`, the logger, `height`, `appHash`, `lastTime`, the `pending` session, the `sigCache` (transaction id hex to address hex to the set of hashes of every signature by that signer over that body that verified) with `sigCacheSignatures`, the number of hashes it holds, `toPersist` (what the next `commit` writes), `staleHistory`, the `recorder`, the three snapshot settings and `lastHistory` (what the last commit wrote, for the RPC's event streams).

**The genesis and reopen paths** are the constructor:

```ts
    const stored = openObjectDatabase(this.kv, CORE_TYPES, { retainVersions: opts.retainVersions, indexTrees: opts.indexTrees, trees: opts.trees, arenaBytes: opts.arenaBytes, heapRoom: opts.heapRoom });
    if (stored) {
      this.db = stored.db;
      // The state holds the scheme genesis fixed, and the node derives its keys from the genesis it was given: the two
      // must name the same one.
      const scheme = getGlobal(this.db).scheme;
      if (scheme !== schemeTag(opts.genesis.signatureScheme ?? 'ml-dsa-44')) throw new Error(`the application state is for a ${schemeName(scheme)} chain, genesis names ${opts.genesis.signatureScheme ?? 'ml-dsa-44'}`);
      this.height = stored.height;
      this.appHash = stored.appHash;
      this.staleHistory = stored.staleHistory;
      this.log('info', 'loaded application state', { height: this.height, appHash: this.appHash, provableFrom: this.db.lowestVersion, ...stored.timing, ...(stored.paged.length > 0 ? { paged: stored.paged.join(', ') } : {}) });
    } else {
      if (opts.genesis.appStateFile && !opts.appGenesis) throw new Error('the application genesis is in a file; parse it with loadAppGenesis first');
      const t0 = performance.now();
      const g = opts.appGenesis ?? parseAppGenesis(opts.genesis.appState);
      const t1 = performance.now();
      this.db = new ObjectDatabase(CORE_TYPES, { retainVersions: opts.retainVersions, indexStore: this.kv, indexTrees: opts.indexTrees, trees: opts.trees, objectStore: (id) => this.kv.get(objectKey(id)), arenaBytes: opts.arenaBytes, historyStore: (version) => this.kv.get(historyKey(version)) });
      applyGenesis(this.db, g, opts.genesis.genesisTime, schemeTag(opts.genesis.signatureScheme ?? 'ml-dsa-44'));
      const t2 = performance.now();
      this.appHash = this.db.root(0);
      const t3 = performance.now();
      this.persist({ changes: this.db.lastChanges!, meta: { height: 0n, appHash: this.appHash }, history: [] });
      this.log('info', 'applied genesis', { accounts: g.accounts.length, parseMs: Math.round(t1 - t0), applyMs: Math.round(t2 - t1), rootMs: Math.round(t3 - t2), persistMs: Math.round(performance.now() - t3) });
    }
    this.lastTime = getDynamic(this.db).time;
    this.pending = this.db.startSession();
```

A store with state wins over genesis, so genesis is parsed only once in a node's life; **`CoreApp.hasState(kv)`** lets the node skip parsing it at all. On both paths the database is given the store as its `indexStore`, its `objectStore` and its `historyStore`, the two tier options and the arena's limit, so a database built from genesis can drop its trees, bound its arena and read a past version from the store's history records as well as one reopened from the store; `heapRoom` matters only to the reopen path, a genesis being built resident. A reopened state must be for the scheme genesis names, or the constructor throws. When something was left out for want of room, the `loaded application state` line says so: `paged` lists the names, for example `indexTrees, trees, history`, and is absent when the store was opened whole. Genesis is applied, hashed as version 0 and persisted immediately; that first root's change list holds every index entry and every chunk and node besides every object (576,000 entries, about 600,000 sparse nodes and 25 MiB of chunks for 191,896 accounts, STATE-PAGING.md 4.4 and 5.3), so the genesis write is where the store grows from 34.6 to 213 MiB at that size. The scheme handed to `applyGenesis` is the engine genesis's `signatureScheme`, ML-DSA-44 when absent, turned into its tag by `schemeTag`; from then on the application reads it from the committed `global` object (`chainScheme`, below) and never from the genesis document again, so a reopened store carries its own scheme. Either way the constructor ends by opening the pending session. The README reports a one-gigabyte genesis (193,536 accounts with two keys each) parsing as a token stream in 6.4 s and building its objects, first root and LMDB write in 8.1 s, and a restart from LMDB at that size in 11.8 s, most of it decoding objects and rebuilding index history; those figures predate the index entries and the trees in the store, which took the restart of the 191,896-account secp256k1 state from 8.4 s to 5.2 s (STATE-PAGING.md 5.3, quoted under `openObjectDatabase` above).

**`initChain(_genesis)`** refuses to run on an application that already has blocks and returns the genesis app hash with the active set as validator updates; when the set is non-empty, the engine uses it in place of its own genesis list (`STAKING.md` section 2.3).

**`checkTx(bytes, opts)`**:

```ts
  async checkTx(bytes: Uint8Array, opts: CheckTxOptions = {}): Promise<CheckTxResult> {
    const d = this.decode(bytes);
    if ('error' in d) return { ok: false, error: d.error };
    while (this.applying) await this.applying;
    const signed = await this.verifySignatures(d.tx, d.txId);
    if (typeof signed === 'string') return { ok: false, error: signed };
    // A block may have started while the pool verified; its state must be the one checked against.
    while (this.applying) await this.applying;
    // Nor is a transaction the mempool would now refuse applied: its writes would stay in the pending state, and
    // the transactions checked after it would be checked against them.
    const refused = opts.admit?.() ?? null;
    if (refused !== null) return { ok: false, error: refused };
    const r = this.applyChecked(d.tx, d.txId, signed, this.lastTime, this.height + 1n, this.pending !== null, false);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
```

Decode (a failure is `malformed transaction: ...`), wait for any block in progress, verify the signatures, wait again in case a block began during the await, ask the caller's `admit` whether it still takes the transaction (the mempool passes one, [chapter 05](05-mempool-executor.md); a refusal returns its reason and leaves nothing in the pending state), then evaluate against the pending session with the last block time and the next height, keeping the result in the pending session. What `verifySignatures` returns is either an error string or the set of addresses that validly signed, and that set is handed to `applyChecked`. `applying` is the promise that serialises checks behind a block; review finding 3 explains why a check must not resolve keys against a state that a block is about to change.

The concurrency story in full. Node is single-threaded, so two `checkTx` calls and a `finalizeBlock` interleave only at `await` points, and the only awaits in this file are the two calls into the verifier. Everything between an await and the next one is one synchronous run that opens a session, evaluates and closes it, so sessions always close innermost first, which the database insists on. The one hazard is a check whose signature verification was in flight when a block began: its candidate keys were resolved against the pre-block state. The second `while (this.applying)` makes it wait, and `applyChecked` then re-reads the authorities and checks the thresholds against the state after the block, in the fresh pending session. The set of signers it verified stays valid, and so does the cache entry it produced, since a signature over a body is a fact about bytes. The README measures `checkTx` at 6,700 transfers per second through the worker pool, essentially the pool's verification rate.

**`finalizeBlock(req)`** is the block procedure of `DESIGN.md` section 7 and `STAKING.md` section 7, in this order:

1. Set `applying` so that checks wait.
2. `closePending()`: undo the pending session, so the block runs on committed state. Then open `blockSession`, one undo session that brackets everything the block does until its root is taken.
3. `pruneExpiredTxs(this.db, req.time)`.
4. `recorder.reset(req.height)` and `beginBlock(...)` with the recorder: proposals, mint, rewards, downtime, evidence, then the queues (begin block).
5. Decode every transaction.
6. `prewarmSignatures(decoded)`: one batch to the worker pool for every signature that the cache does not already vouch for (batch signature pre-verification).
7. For each transaction in order: a decode error is its result; otherwise `verifySignatures` resolves the signers' keys against the state as it stands after the transactions before it, `recorder.beginTx`, `applyChecked(..., signed, ..., keep: true, final: true)` with the signers that pass returned, `recorder.endTx(r.ok)`, and the result is pushed (per-transaction key resolution and evaluation).
8. `endBlock(this.db, this.log)`: tally proposals, compute the set, the validator updates (end block).
9. Write `height` and `time` into `dynamic`, then `blockSession.commit()`: the block's changes become the live state and no session is open.
10. `this.db.root(Number(req.height))`: the app hash for this height (root). The root requires every session closed, which the commit in step 9 guaranteed.
11. Record `height`, `lastTime`, and `toPersist` (the change list, the meta, the history entries); open a fresh pending session; return `{ appHash, txResults, validatorUpdates }`.
12. If anything threw while `blockSession` was still open, undo it and open a fresh pending session before rethrowing. In `finally`, clear `applying` and release the waiting checks.

The block session exists for the failure in step 12. `beginBlock` and `endBlock` open no session of their own, because a block is final and a throw inside them is a bug, not a bad transaction. But two awaits sit in the middle of the procedure, and the verifier behind them can fail for reasons outside the application, such as a worker that died while the pool held this block's signatures. Without the session, a throw there would leave the database holding the begin-block effects and the first few transactions of a block that was never finished, with nothing able to undo them; the engine's retry, or a restart replaying the same block, would then apply it on top of that half, and the node would compute an app hash no other node computes. Inside the session, the undo in step 12 puts the database back exactly as the previous block left it, and the retry starts clean. The review test "rolls a block back when verification fails half way, and applies it cleanly on a retry" does exactly that with a verifier that fails once.

```ts
      await this.prewarmSignatures(decoded);
      const txResults: TxResult[] = [];
      for (let i = 0; i < req.txs.length; i++) {
        const d = decoded[i]!;
        if ('error' in d) {
          txResults.push({ ok: false, error: d.error });
          continue;
        }
        // Keys are resolved against the state as it stands after the transactions before this one, on every node alike.
        const signed = await this.verifySignatures(d.tx, d.txId);
        if (typeof signed === 'string') {
          txResults.push({ ok: false, error: signed });
          continue;
        }
        this.recorder.beginTx(txHash(req.txs[i]!), i);
        const r = this.applyChecked(d.tx, d.txId, signed, req.time, req.height, true, true);
        this.recorder.endTx(r.ok);
        txResults.push(r);
      }
      const validatorUpdates = endBlock(this.db, this.log);
```

Why two signature passes? Review finding 3 showed that resolving every key before any transaction executes lets a node that saw T1 (install a new key) and T2 (spend with it) in its mempool accept T2 while a cold node rejects it: different roots for the same block. So keys are resolved per transaction. Review finding 32 then showed that doing the crypto inside that loop fed the worker pool one job at a time, so a cold block ran at single-thread speed. The split is sound because a cache entry says only "this address signed this body", which no state change can invalidate; the per-transaction pass still decides whether that address is allowed to sign. The README puts the warm path (signatures verified at admission) at 26,000 transfers per second, a full block of 1,500 in 57 ms, and the cold path (block sync, or a node that missed the gossip) at 6,300 per second with 11 verification threads.

**`commit()`** persists `toPersist` if there is one, publishes `lastHistory`, and takes a snapshot when the height is a multiple of `snapshotInterval`. The README measures a commit after a 500-transfer block at 3.1 to 3.9 ms to memory and 9.6 ms to LMDB (2.6 and 8.8 before the index entries and tree chunks were written with the objects). The method is `async` because the interface says so, and it awaits nothing: `persist` and `takeSnapshot` are both synchronous writes to `this.kv`. That is what the comment on `Application.commit` asks of an application that keeps its state in the engine's store environment. The executor of a node that created this application calls `commit()` inside the environment transaction in which it has just saved the block ([chapter 5](05-mempool-executor.md)), and everything written before the first `await` joins that transaction, so the block, the chain state, the application's state and a snapshot taken at that height land together, with one flush to the device. A `CoreApp` constructed by a caller on a store of its own and handed to the node is called outside any such transaction, and its `kv.write` then commits by itself, after the chain store's.

`persist(p)` (private) is the application's one store write per block:

```ts
    this.kv.write((w) => {
      this.historyLog.append(w, p.history);
      for (const c of p.changes.objects) {
        if (c.bytes) w.put(objectKey(c.id), c.bytes);
        else w.del(objectKey(c.id));
      }
      // Removals first in the list, so a key that changed hands within the block ends with its new owner.
      for (const c of p.changes.indices) {
        if (c.value) w.put(c.key, c.value);
        else w.del(c.key);
      }
      for (const c of p.changes.trees) {
        if (c.value) w.put(c.key, c.value);
        else w.del(c.key);
      }
      for (const [type, next] of p.changes.counters) w.put(counterKey(type), encode((wr) => wr.u64(BigInt(next))));
      if (p.changes.history) w.put(historyKey(p.changes.version), encode((wr) => encodeHistory(wr, p.changes.history!)));
      // History that no longer serves any provable height: the version that just left the window, and leftovers found at startup.
      // The store's window is the full one even while the memory guard has trimmed the one in memory, so a restart has it back.
      if (this.db.lastStaleVersion > 0) w.del(historyKey(this.db.lastStaleVersion));
      for (const v of this.staleHistory) w.del(historyKey(v));
      this.staleHistory = [];
      w.put(META_KEY, encode((wr) => wr.u64(p.meta.height).fixed(p.meta.appHash)));
    });
    this.db.dropChanges();
```

The block's history entries appended to the log (`HistoryLog.append`, above, which also writes the log's length and the waiting heads of one slice of the account numbers), the changed objects (a null encoding is a removal), the index entries the block added and removed (`Changes.indices`, removals before additions, so a unique key that passed from one object to another inside the block ends with its new owner when the list is applied in order; a transfer, which changes amounts and no key, adds none), the dense tree chunks and sparse tree nodes the root changed (`Changes.trees`, a null value deleting a chunk that emptied or a node that collapsed), the moved counters, the version's history record, deletion of the record that just left the window, and the meta last, all in one write. The record deleted is the one for `db.lastStaleVersion`, the current version less the configured retention, and not for `db.lowestVersion`: `lowestVersion` says what the database can answer for, `lastStaleVersion` what the store may forget, and the second is counted from the retention alone. From the memory guard's `warn` level on the node trims the window in memory to two versions ([chapter 8](08-node.md)); in a database with no history store `lowestVersion` then jumps up to the trimmed edge, and deleting by it would leave the records between the two edges in the store forever while no longer keeping the window the store is supposed to hold. Counted from the retention, the store keeps the whole configured window whatever the memory guard does, each root's record still being written in full. That window of records is what a restart reads back, and what the database reads a past version from while its window in memory is trimmed: every record from the oldest provable version on must be there, since a missing one is taken to mean that no root was computed at that version ([chapter 09](09-database.md)). Then the change list is dropped, which is also the word to the database that the store now holds what the root reported: until then it lays the list over the store for whatever index or tree is dropped, so a query between `finalizeBlock` and `commit` never sees an index older than the objects ([chapter 09](09-database.md)). The extra writes are not a mode; a node that never pages pays them anyway so that the fallback exists the moment it is needed, and they are measured (STATE-PAGING.md 4.4 and 5.3): a 500-transfer block writes about a thousand index entries, and `commit to LMDB` went from a mean of 8.95 to 9.63 ms, 7%; the chunks cost nothing measurable for a block whose writes are local, and a fifth more (45.7 to 55.1 ms) for a block of 2,400 transfers scattered over 192,000 accounts, which rewrites nearly every chunk of the trees it touches, about 12 MiB. A crash between `finalizeBlock` and `commit` leaves the store at the previous height and the engine replays the block on restart, which is why `info()` reports the stored height.

Snapshots: **`takeSnapshot()`** exports the committed state at the current height and writes it in one store transaction:

```ts
  takeSnapshot(): void {
    const { manifest, chunks } = exportSnapshot(this.db, CORE_TYPES, Number(this.height), this.snapshotChunkObjects);
    const stale = this.snapshotHeights().filter((h) => h !== this.height).slice(0, -(this.snapshotsKept - 1) || undefined);
    this.kv.write((w) => {
      w.put(manifestKey(this.height), manifestToBytes(manifest));
      chunks.forEach((perType, t) => perType.forEach((bytes, i) => w.put(chunkKey(this.height, manifest.types[t]!.type, i), bytes)));
      for (const h of stale) {
        w.del(manifestKey(h));
        for (const [k] of this.kv.range(chunkPrefix(h), prefixEnd(chunkPrefix(h)))) w.del(k);
      }
    });
    this.log('info', 'snapshot written', { height: this.height, chunks: chunks.reduce((s, c) => s + c.length, 0) });
  }
```

The `stale` expression keeps the newest `snapshotsKept − 1` earlier heights and deletes the rest; with the default of two, every snapshot but the previous one goes. (`-(1) || undefined` is `-1`, so `slice(0, -1)` drops the last element; with `snapshotsKept` of 1 it is `-0 || undefined`, so every earlier height is stale.) **`snapshotHeights()`**, **`manifestBytes(height)`** and **`chunkBytes(height, type, index)`** serve them to peers. **`CoreApp.writeImportedState(kv, db, height, appHash)`** is the other end: it writes a database loaded from a snapshot into an empty store, as a commit would have, every object from `exportObjects()`, every index entry from `indexEntries()` and every chunk and node from `treeEntries()`, then the counters and the meta, refusing a store that already has state; state sync calls it inside the environment-wide transaction that also writes the chain store, so the two stores never disagree about whether the join happened, and the node that opens the store afterwards reads its indices and trees from it like any other (1.84 s to write and 1.59 s to open the gigabyte state, against 1.09 and 5.72 before the trees were written, STATE-PAGING.md 5.3). The README measures a snapshot export of a gigabyte state at 3.5 s and a complete state-sync import of 201 chunks (504 MiB) at 37 s end to end.

**`info()`** returns the committed height and app hash.

History: **`accountHistory(account, from = 0n, limit = 100, reverse = false)`** returns `{ entries, total }`:

```ts
  /** An account's history, oldest first from `from`, or newest first when reversed. */
  accountHistory(account: ObjectId, from = 0n, limit = 100, reverse = false): { entries: (HistoryEntry & { sequence: bigint })[]; total: bigint } {
    return this.historyLog.read(account, from, limit, reverse);
  }
```

The application keeps one `HistoryLog` over its store (`historyLog`, made in the constructor before the database is opened, which is also when a store with the earlier layout is moved into the log) and the method is its `read`: oldest first from sequence `from`, or with `reverse` newest first, `from` then counting entries back from the newest, which is what a wallet showing recent activity wants. `total` is the account's count and every entry carries its `sequence`. A reader decodes an `operation` entry's `data` with `decodeOperation` and a virtual entry's with `decodeVirtualData`, as the RPC and the network test do. The newest twenty entries of an account are read at about a million a second on the gigabyte state (1,023,000, docs/benchmarks.md section 4.8; 930,000 to 991,000 with the earlier layout, the entries keyed by account), most accounts of that state having no entries.

Queries: `lastHeight`, `lastAppHash`, `lowestProvableHeight` (the oldest height a proof can be made for), `coreAsset`, **`stakingParameters()`**, **`global()`**, **`feeSchedule()`**, **`chainParameters()`**, **`dynamic()`**, **`accountByName(name)`** (a name that cannot be an index key, one with a zero byte, returns null rather than throwing), **`account(id)`**, **`balance(owner, asset = core)`**. What "committed" means here needs stating precisely, because two views are in play. `global()`, `dynamic()`, `account(id)`, `accountByName` and `balance` return objects read through `db.getCommitted`, which looks through every open session back to the last `root()`, so a transfer sitting in the pending session is invisible and the test `checks pending transactions in sequence` asserts exactly that. The indices, though, are live: `accountByName` finds the id through the live `byName` index and `balance` through the live `byOwnerAsset` index, and only then reads the object behind that id committed. The difference shows for an object the pending session created: the live index finds it, `getCommitted` says it did not exist at the last root, and the query answers null, which is the right answer. `coreAsset` and `stakingParameters()` read the live `global` object, which only a block ever modifies, so outside `finalizeBlock` the live and committed values are one and the same. The RPC in [chapter 12](12-rpc.md) follows the same rule for everything it derives from these objects: a validator's self-bond and delegator count, a delegation's unbonding entries and an account's balances are assembled from committed objects, with the live indices used only to find which ids to read. Proofs: **`proof(id)`** against the current app hash, **`proofAt(id, height)`** for a past height inside the window ("Verify it against header height+1"), **`proveAccountName(name, height)`**, **`proveAssetSymbol(symbol, height)`**, **`proveValidatorAddress(address, height)`** and **`proveDelegation(delegator, validator, height)`** over the four authenticated indices; a key proof proves the 8-byte id the key maps to, or its absence.

The private internals:

- `decode(bytes)` wraps `decodeTransaction` and computes the id.
- `lookupAuthorities` is the `AuthorityLookup` over the live database.
- `closePending()` undoes and clears the pending session.
- `signingKeys(tx)` gathers the candidate keys of every required account's active and owner authorities with `collectKeys`, or returns the error `account X does not exist`.
- `cacheVerified(txKey, address, sigHash)`, `isVerified(txKey, address, sigHash)` and `trimCache` maintain `sigCache`, a map from transaction id to a map from signer address to a **set** of signature hashes. `cacheVerified` adds to the set, which holds at most `SIG_CACHE_VARIANTS = 4` hashes, the oldest making way for a fifth; `isVerified` asks whether a particular signature's hash is in the set; `trimCache` drops the oldest transactions while the cache holds more than `SIG_CACHE_MAX = 20,000` bodies or more than `SIG_CACHE_SIGNATURES = 40,000` signature hashes across them, so the bound is on memory and not only on bodies:

```ts
  private cacheVerified(txKey: string, address: string, sigHash: string): void {
    let verified = this.sigCache.get(txKey);
    if (!verified) {
      verified = new Map();
      this.sigCache.set(txKey, verified);
    }
    // A set, never a replacement: two valid signatures by one key over one body can be in flight at once
    // (signing is randomised), and a later one should not cost the earlier its cache entry. Past a few the oldest
    // goes; a transaction in flight holds its own verified signers, so that costs at most a second verification.
    let hashes = verified.get(address);
    if (!hashes) verified.set(address, (hashes = new Set()));
    if (hashes.has(sigHash)) return;
    if (hashes.size >= SIG_CACHE_VARIANTS) hashes.delete(hashes.values().next().value!);
    else this.sigCacheSignatures++;
    hashes.add(sigHash);
    this.trimCache();
  }

  private isVerified(txKey: string, address: string, sigHash: string): boolean {
    return this.sigCache.get(txKey)?.get(address)?.has(sigHash) ?? false;
  }
```

  Why a set per (body, key) rather than one hash: ML-DSA signing is randomised by default (the "hedged" variant), so one key produces a different valid signature over the same body every time it signs. Two copies of one transaction with different signature bytes can be in the system at once, one gossiped from a peer and one re-signed by a wallet that retried, and both are valid. With a single slot per signer, verifying the second copy overwrote the record of the first, and a `checkTx` for the first copy that was between its verification and its evaluation then found its own signature "unverified". A set keeps the signatures that verified, so one copy does not cost the other its entry, and the entry still says only "this key signed this body with these exact bytes". The set is capped because a key can make any number of valid signatures over one body, each of which verifies once and is then refused in execution without paying a fee; without a cap one body would hold them all. Losing an entry costs nothing but a second verification: a transaction between its verification and its evaluation carries its own set of verified signers and does not go back to the cache.
- `chainScheme` (a getter) reads the scheme genesis fixed from the committed global properties:

```ts
  /** The scheme genesis fixed; part of the committed global properties, so two nodes with other genesis files never agree on a root. */
  private get chainScheme(): SchemeTag {
    return getGlobal(this.db).scheme;
  }
```

- `prewarmSignatures(decoded)` builds one job per uncached signature whose address is among the candidates and whose tag is the chain's scheme, and caches every success. A signer whose key is not in a required authority yet (it may be added by an earlier transaction of the same block) is skipped here and handled by the per-transaction pass, and so is a signature of another scheme, which that pass refuses:

```ts
      for (const s of d.tx.signatures) {
        const address = toHex(s.address);
        const publicKey = candidates.get(address);
        if (!publicKey || schemeOf(s.signature) !== this.chainScheme) continue;
        const sigHash = toHex(sha256(s.signature));
        if (this.isVerified(txKey, address, sigHash)) continue;
        jobs.push({ sig: s.signature, msg: body, publicKey, context: this.context });
        owners.push({ txKey, address, sigHash });
      }
```

- `verifySignatures(tx, txId)` returns an error string, or the set of addresses that validly signed, which is the caller's to apply the transaction with (what the cache says by then does not matter, since load shedding can clear it and trimming shrink it while this awaits the pool):

```ts
    for (const s of tx.signatures) {
      const address = toHex(s.address);
      if (seen.has(address)) return 'duplicate signature';
      seen.add(address);
      const publicKey = candidates.get(address);
      if (!publicKey) return 'signature by a key that no required authority contains';
      if (schemeOf(s.signature) !== this.chainScheme) return 'signature of another scheme than the chain uses';
      // A cache hit is only for the exact signature bytes seen before.
      const sigHash = toHex(sha256(s.signature));
      if (this.isVerified(txKey, address, sigHash)) {
        signed.add(address);
        continue;
      }
      jobs.push({ sig: s.signature, msg: body, publicKey, context: this.context });
      jobKeys.push([address, sigHash]);
    }
    if (jobs.length > 0) {
      const results = await this.verifier.verify(jobs);
      if (results.some((ok) => !ok)) return 'invalid signature';
      for (const [address, sigHash] of jobKeys) {
        signed.add(address);
        this.cacheVerified(txKey, address, sigHash);
      }
    }
    return signed;
```

A transaction with no signatures is `transaction has no signatures`. A signature tagged with another scheme than the chain's is refused as `signature of another scheme than the chain uses` before any job is built: chapter 2's `verify` would fail it anyway, since the key and the signature would disagree on their tags, but the refusal names the reason and costs no verification work. The cache binds the hash of the signature bytes (review finding 2): before that, a node that had verified a transaction once accepted the same body with a zeroed signature in a block, and nodes that had not split from it. The review test "accepts both valid signatures a key can make over one body, whichever was seen first" signs one body twice with one key, verifies both copies, and checks that each still evaluates after the other.

- `applyChecked(tx, txId, signed, time, height, keep, final)` is synchronous on purpose. `signed` is what `verifySignatures` returned for this transaction. It first requires that set to hold one address per signature (`unverified signature` otherwise; `verifySignatures` has just run on every path and returns only when every signature verified, and since the set travels with the call, nothing that happens to the cache in between, a second copy verified, a trim, a drop under load, can make this transaction look unverified), then checks thresholds against current state, with the same set as the signers: each owner-required account's owner authority, and each active-required account's active or owner authority (`missing owner authority of X`, `missing active authority of X`). Then:

```ts
    const session = this.db.startSession();
    try {
      applyTransaction({ db: this.db, time, height, final, log: this.log, history: final ? this.recorder : undefined }, tx, txId);
    } catch (e) {
      session.undo();
      if (e instanceof TxError || e instanceof DbError) return { ok: false, error: e.message };
      throw e;
    }
    if (keep) session.commit();
    else session.undo();
    return { ok: true };
```

A `TxError` or `DbError` becomes a result; anything else is a bug and propagates. With `keep` false (a check while no pending session exists) even a successful evaluation is undone.

For completeness, every error `app.ts` produces on its own, before the evaluator's `TxError`s listed under `evaluate.ts`, in the order the checks run:

| error | raised by | meaning |
|---|---|---|
| `malformed transaction: ...` | `decode` | the bytes do not decode as a transaction (bad tag, too many operations or signatures, trailing bytes) |
| `transaction has no signatures` | `verifySignatures` | nothing to verify |
| `account X does not exist` | `signingKeys` | an account the operations require is unknown, so no key can be resolved |
| `duplicate signature` | `verifySignatures` | two signatures carry the same address |
| `signature by a key that no required authority contains` | `verifySignatures` | the address is not among the candidate keys of the required accounts, to depth 2 |
| `signature of another scheme than the chain uses` | `verifySignatures` | the signature's tag is not the scheme genesis fixed (`global.scheme`) |
| `invalid signature` | `verifySignatures` | the worker pool rejected at least one signature |
| `unverified signature` | `applyChecked` | the set of verified signers does not cover every signature; a guard rather than an expected outcome, since `verifySignatures` runs first on every path and hands over the set only when every signature verified |
| `missing owner authority of X` | `applyChecked` | the signers do not reach X's owner threshold |
| `missing active authority of X` | `applyChecked` | the signers reach neither X's active nor its owner threshold |

A failed `checkTx` leaves nothing behind in the pending session, and a failed transaction in a block leaves nothing in the state, no history entries and no fee, but it does occupy its position in the block and gets a result that the engine hashes into the next header's `lastResultsHash`, so its failure is provable.

## How it is tested

`test/app.test.ts` walks the account and asset layer one block at a time on an in-memory store with an inline verifier and a retention window of four:

- `starts from genesis with the core asset and the faucet`: the first account is `3.0`, the core asset is `CORE` with the genesis balance as its supply and the faucet as issuer, `dynamic.height` is 0, an object proof of the faucet verifies against the genesis app hash, and `accountByName` returns null for an unknown or unkeyable name.
- `creates accounts and transfers, charging flat fees into the fee pool`: `checkTx` admits a registration, a block applies it, the new account is `3.1` with the faucet as registrar, every fee leaves the payer and lands in `communityPool`, and the result's app hash is the application's.
- `rejects malformed, unsigned, foreign-key and forged signatures`: the exact error for garbage bytes, no signatures, a key outside the authority, a duplicate signature, a flipped signature bit, a missing account, a bad name, a taken name and an unsatisfiable authority.
- `honours multisig thresholds, account authorities, and owner versus active`: a two-of-three active authority refuses one key and accepts two, the owner key satisfies an active requirement, a member account's key satisfies a child account's active authority, changing the owner needs the owner key, and the old owner is locked out afterwards.
- `enforces expiration and refuses replays until the id is forgotten`: an expired or too-distant expiration is refused, the same transaction twice in a block succeeds once with `duplicate transaction` for the second, the id is refused in `checkTx`, and the `recentTx` object disappears at the block whose time passes its expiration, after which the transaction is simply `expired`.
- `checks pending transactions in sequence and starts over after each block`: two spends of the same balance are admitted and refused in order, the committed balance ignores the pending session, an empty block resets the pending session, and a block containing both applies one.
- `creates and issues user assets up to the max supply`: an asset `ALICE` is `4.1`, only its issuer can issue, issuing past the max supply fails while the issues around it succeed, and `byAsset` lists the holders.
- `proves objects against the app hash`, `proves past heights inside the retention window`, `proves account names present and absent, now and at past heights`: object and key proofs verify against the right hash, fail against the wrong one, and a name is proven absent at height 0 and present later.
- `restarts from the store with the same app hash and keeps producing the same hashes`: two applications on the same blocks agree; one reopened from the store reports the stored height and hash, has every past height provable with byte-identical proofs, continues to the same hash as the other, and the history window slides in both memory and store.
- `keeps the whole history window in the store while the one in memory is trimmed, so a restart has it back`: two applications with a retention of four run the same six blocks, and one has `db.setHistoryWindow(1)` called after its third. At height 6 its window in memory holds one past version, yet it proves from height 2 like the other, its object proofs and name proofs at heights 2 to 6 byte for byte those of the application that was never trimmed: the heights below 5 are read from the history records in its store, which holds those of versions 3 to 6, the full window. A proof at height 1 throws `not available` on both. An application restarted from that store logs `indexVersions: 'records'` in its `loaded application state` line and proves from height 2 as well, with the same proofs, from the window it read back. Then the record of version 4 is deleted from the store: an application opened on it proves from height 4, gives the same proofs at heights 4 to 6, refuses height 3 as `not available`, and after its next block the store holds the records of versions 5, 6 and 7 only.

A second group, `core application: index entries in the store`, is the application's side of STATE-PAGING.md phases two to four. Its `consistent(app, kv)` check is applied after every commit: the store's `'i'` entries equal `db.indexEntries()` and `checkIndexStore()` finds nothing to report, and the store's `'t'` and `'n'` entries equal `db.treeEntries()`.

- `writes the entries with every commit, reopens from them, and fills in a store that predates them`: the store is consistent after genesis, after three blocks of registrations, payments and a transfer, and after the recent transaction ids expire and take their entries with them; an application reopened from the store has the same hash, finds bob and his balance, and is consistent; and a copy of the store with every `'i'` key left out, as a store written before phase two would be, is opened, derives the entries from the objects once and writes them, so that it then holds exactly the entries of the original.
- `runs blocks with the trees dropped and rebuilt on the way, with the hashes of an app that never drops them`: with `dropIndexTrees()` turned, blocks run on the paged application and on a resident twin give the same app hash and the same results, a taken name is refused in a block and, against the pending session as admission checks it, in `checkTx`; after `rebuildIndexTrees()` and a further drop the store still equals the resident twin's indices.
- `writes the entries of a state imported from a snapshot`: a snapshot exported in chunks of three objects, imported, and written with `writeImportedState` leaves a store whose entries and trees equal the original application's, and an application opened on it has the original's hash.
- `writes the trees with every commit and restarts from them, with the proofs of the original`: after three blocks the reopened application has the same hash and, at every height in the window, the same object proofs and name proofs as the one that wrote the store; the three reopen paths (`fromTrees: false`, `checkLeaves: true`, `trees: false`) give the same hash and proofs; a store in which alice's object was overwritten with bob's bytes is refused by the leaf check with `does not hash to its leaf` and by the recomputing path with `do not hash to the stored app hash`; the reopened application keeps producing the twin's hashes; and a copy of the store without its `'t'` and `'n'` keys computes the trees on opening and writes them once.
- `runs blocks with the Merkle trees dropped and rebuilt, with the hashes and proofs of an app that keeps them`: with both tiers dropped, blocks match a resident twin in hash, results and, at every height in the window, the faucet's object proof and the name proofs of alice and bob; `checkTx` refuses a taken name and admits a transfer while everything is dropped; the trees are rebuilt, a `checkTx` leaves pending writes in the mempool's session and the trees are dropped in the middle of them, another block matches, and after both tiers are rebuilt the store is consistent.

A third group, `core application: a store opened without room for it`, is the open path's two limits. Each case runs two blocks on an application over a store and on a resident twin, reopens the store in its own way, and from then on applies every block to both and compares the app hash, the results and, at every height the reopened one can prove, alice's object proof and the name proofs of alice and carol.

- `opens with the trees left in the store and no history window when the heap has no room, and runs on`: reopened with `heapRoom: 0`, the database reports both tiers `dropped`; the window in memory starts at height 2, where the store was opened, but `lowestProvableHeight` is 0 like the twin's, and alice's object proof and name proof at heights 0 to 2 are byte for byte the twin's, read from the history records left in the store. Two blocks (a signed transfer, a registration) match the twin, proofs at every provable height included, and the lowest provable height stays 0. The store still holds the history records 1 to 4 that were not read, and after one more block 2 to 5: they age out as they would have. The same store opened with a `heapRoom` of 2^30 proves from height 1 again, heights 1 to 5 matching the twin. And `openObjectDatabase` with `heapRoom: 0` but `indexTrees: true, trees: true` returns an empty `paged` and both tiers resident: a tier asked for by name is opened as asked.
- `leaves the objects in the store when the arena has no room for them, and reads them from there`: reopened with `arenaBytes: 0`, the database counts more than five objects as stored and the arena holds no bytes, yet the whole history window was read (provable from height 0) and `accountByName('bob')` answers. After the two blocks the arena holds bytes again and fewer objects are stored, though some still are: what the blocks wrote went back into the arena. Alice's balance and the export of every object equal the twin's.

`test/fees.test.ts` covers `FEES.md`:

- `prices operations the BitShares way`: `isCheapName` cases, the data fee for one-key and sixteen-key authorities, the three symbol lengths, scale and its cap, and that the fee is part of the signed bytes.
- `refuses an operation stating less than the schedule, and charges exactly what is stated`: 99 is refused with the exact message, 100 is admitted, 1,000 and 250 are charged in full into the pool, a failed transaction pays nothing, and a free chain (`scale: 0`) moves nothing.
- `changes the schedule by validator proposal ...`: a proposal doubling the scale and raising the transfer fee is adopted on the second signal, the staking parameters are untouched, a transaction signed under the old price fails with `states a fee of 100, the schedule requires 500` rather than paying more, and a schedule with a bad scale is refused up front.
- `takes a partial schedule in genesis over the defaults and refuses a bad one`: partial overrides merge over `DEFAULT_FEES`, a bad scale or a negative fee throws, a schedule without a base requires every field, and the genesis values reach the application.

`test/staking.test.ts` walks `STAKING.md` with a supply invariant (`currentSupply = balances + validator tokens + unbonding + pool`) checked after every scenario:

- `bootstraps validators from genesis and hands the engine the set`: `initChain` returns the two genesis validators at their whole-token powers, shares are `tokens × SHARE_SCALE`, the operator's delegation holds them all, the self-bond left the operator's balance, `bonded` is the sum, and a validator is provable by consensus address.
- `pays the block reward ...`: nothing at height 1; then 10 tokens split as a 5% proposer bonus plus a 200:100 pro-rata share, dust staying in the pool, the operator's delegation growing by the commission's worth, the exchange rate rising, and both whole-token powers reported as updates.
- `delegates, undelegates through the queue, enforces the entry cap, and releases on maturity`: a delegation is worth within two base units of what was bonded, raises power, is provable; two unbonding entries are allowed and the third refused; nothing matures a second early and everything is back at ten seconds.
- `redelegates with the no-chain rule and the self-bond floor`: a redelegation moves value immediately, cannot be moved again while pending, can after maturity, and an operator cannot undelegate below `minSelfBond`.
- `creates validators with the fee and minimums, ranks the top N, and rotates keys`: a self-bond below the minimum and a reused key are refused; a new validator pays the creation fee and the operation fee into the pool (`pool + T(10) + 1000n`, with no reward going out) and enters the set at power 150; a fourth with less stake pushes the smallest out when N is 3; a key rotation is reported as a removal and an addition at the same power.
- `jails a validator that misses half the window ...`: four missed blocks in a window of four jail the validator with a 0.01% slash and remove it from the set; unjail is refused before the period and while the self-bond is below the minimum; delegating to a jailed validator is allowed; after a top-up the unjail succeeds and the validator is back.
- `tombstones a double signer, slashes its stake and later leavers, and unbonds everyone`: the validator ends at zero tokens and shares with no delegations, the unbonding entry created after the infraction is slashed 5%, every delegation became an unbonding entry, the pool received the slash, delegating to it is refused, a second report is ignored, and the entries pay out after the period.
- `mints toward the bonded goal and never past the max supply`: the rate starts at the minimum, climbs by exactly the hourly step, mints exactly the formula's amount into the pool, and a genesis at the max supply mints nothing.
- `adopts a parameter proposal at two thirds of active stake and expires the rest`: the proposer's own signal is exactly two thirds and does not adopt, a repeated signal is refused, the second signal adopts and the fees are untouched, a new `minDelegation` is enforced, an unsupported proposal expires, and only the operator may propose for a validator.
- `punishes stake whose unbonding matures in the very block that carries the evidence`: an unbonding entry whose completion time is the time of the block carrying the double-sign evidence is slashed before it is paid out, which is what the order of `beginBlock` guarantees.
- `adopts parameters with care: pending unbondings follow a longer period, signing windows restart, and no proposal may empty the set`: the three qualifications of `tallyProposals`, each observed from the outside.
- `caps the signals a proposal can hold at what its encoding can carry`: the `MAX_SIGNALS` refusal.

`test/review.test.ts` holds regressions for the review findings that touch this part: a cached verification does not vouch for different signature bytes and a cold node agrees with the warm one (finding 2); keys are resolved per transaction so a key installed by T1 is usable by T2 in the same block, and the reverse order fails identically on both nodes (finding 3); the core asset cannot be issued (finding 27); a delegation worth no shares is refused, one that would overflow the validator is refused, and a reward that cannot mint commission is declined (finding 7 and the exchange-rate cases above); both valid signatures a key can make over one body are accepted, whichever was seen first; a block whose verification fails half way is rolled back and applies cleanly on a retry; staking parameters are bounded so every derived timestamp and amount stays representable; a double sign reported against a rotated key is still punished and a key is never reused (finding 9); an unbonding entry created the height before the infraction is slashed (finding 10); a virtual `unjail` entry is dropped when its transaction fails (finding 28).

`test/genesis.test.ts`: the inline and the streaming parser produce identical results, key order, a missing `accounts` and a repeated `accounts` key (the last one wins in both) do not matter, malformed streams fail with the expected messages, a negative balance is refused; a genesis in a file reaches the same app hash as an inline one, neither a fresh nor a reopened database keeps the encoded change list (finding 36), constructing without the parsed genesis throws, an empty file is an empty genesis and a missing file is an error.

`test/chain.test.ts` runs the application on a live four-validator network with a full node: a registration gossips to every node, a forged transaction never enters a mempool, a payment reaches every node, a proof from one node verifies against the app hash in the next header on every node, state and name queries verify through `verifyStateQuery`, `verifyKeyQuery` and a light client, a transaction is proven included and successful, and account history on every node shows the faucet's two operations and alice's two receipts, newest first when reversed.

`test/history.test.ts` tests `HistoryLog` on its own over a `MemoryKv`. `pages an account oldest first and newest first, whatever the other accounts wrote between its entries`: forty blocks of thirteen entries over five accounts, one of them in most entries, are appended, and every account is read from eight starting points with five limits in both directions and compared with a model kept in arrays, by the log that wrote them and by a second one opened on the same store; an account with no entries has a total of 0, and a log opened later goes on from where the first stopped. `reaches the old end of a long history in a few dozen reads, and appends a block with a few pages of writes`: 5,000 entries of one account in fifty blocks are written with fewer than three store reads an entry, two entries from any of seven starting sequences are read in fewer than a hundred, and the `'l'` keys are exactly 0 to 4,999 in order. `writes the heads a slice of the accounts at a time, and has the waiting ones back after a stop`: the store is wrapped so that every put of a `'p'` key is noted, and 200 blocks of 300 entries are appended over 6,400 accounts taken from all over the range in no order. The head writes of any one block span fewer than 128 account numbers, one slice once the width has doubled to 128. At every 37th block and at the last, a second log opened on the store reports every account's count as the test counted it, and reads account 0 in full. Over the run fewer than half as many heads are written as were changed, since a head changed several times while it waits is written once, and no block writes as many as 300. At the end `'L'` holds a length of 60,000 and a `covered` no more than 64 blocks of entries, 19,200, behind it. `moves a store written before the log into it the first time it is opened`: a store filled with `'a'` and `'q'` keys reads through the log with the same sequences, heights and positions, holds no `'a'` or `'q'` key afterwards, has its log in height order, and a second open moves nothing and appends after the moved entries.

`test/schemes.test.ts` runs the application on the second scheme: a four-validator chain whose genesis names secp256k1 creates an account with a secp256k1 key and refuses an ML-DSA key in an authority (`must be a secp256k1 key`), an ML-DSA consensus key (`consensus key must be a secp256k1 key`) and an ML-DSA signature relabelled with a secp256k1 address (`another scheme`); the rest of the suite runs on whichever scheme `CHAIN_SCHEME` names (chapter 15).

`test/staking-net.test.ts` runs an application-owned validator set on a live network: the engine starts on the set `initChain` built, a delegation raises a validator's power two heights later on every node, a stopped validator is jailed within the window and the chain continues on three, it restarts, catches up, is unjailed by its operator and the set is four again, and a light client that trusted height 2 follows the whole sequence and proves which account stands behind an operator name.

## Limitations and ideas

Known simplifications, from `DESIGN.md` section 10 and the code:

- A transaction that fails inside a block pays no fee. Proposers only include transactions that passed their mempool, so this is rare, but a schedule change between admission and inclusion makes it happen (the fee test shows it).
- Non-unique indices (balances by owner, transactions by expiry, validators by power) are not in the state root; only the five authenticated unique indices are provable.
- A delegator who redelegates away from a validator and then undelegates from the destination escapes a later slash of the source, as in Cosmos (review finding 11, accepted).
- Slashed tokens go to the community pool rather than being burned.
- Commission is one rate for every validator; there is no per-validator commission.
- Rewards are recorded in history per validator per block, not per delegator; a delegator's share is implicit in the exchange rate.
- A state-synced node has account history only from its snapshot height.
- The account history log is never pruned, and a store written with the earlier layout is moved into it in one write with every entry held in memory. After a stop the log's last entries, from the oldest change whose head was still waiting, up to about 64 blocks of them, are read again when the store is opened, to have the heads back that were not yet written.
- The decision to open a store paged rests on an estimate from the type counters and fixed per-entry figures; it is not checked against what the tiers then take. A store opened without its history window proves the heights before the one it opened at from the records in the store, slower than from memory, until the window has filled again or the store is opened with room. A record written by a build from before the records carried the sparse tree nodes cannot serve an object proof or a name proof that way, and such a height is refused as `not available` until those records have aged out.
- Signatures are not priced, so a transaction with sixteen signatures costs the same as one with one.
- The streaming genesis parser handles a large `accounts` array; a large `validators` array would still be assembled in memory.

Exercises:

1. **Add an operation end to end.** Add `assetTransferOwnership(issuer, asset, newIssuer)`: a tag in `OP_TAG`, encode and decode cases in `tx.ts`, a section in `FeeSchedule` and `FEE_FIELDS` with a default in `DEFAULT_FEES`, the authority and payer in `requiredAuthorities` and `feePayerOf`, the rule in `applyOperation`, the accounts in `accountsNamed`, and a test. Notice how many places a new operation touches, and which of them would be caught by the type checker if you forgot one.
2. **Per-validator commission.** Add a `commissionBps` field to `Validator`, set it in `validatorCreate` and change it in `validatorUpdate` with a cap from the parameters, and use it in `payRewards`. Decide what the history entry for a reward should carry.
3. **Burn instead of pool.** Make `slash` burn tokens by lowering `currentSupply` and adjust the supply invariant in `test/staking.test.ts`. Check the mint still behaves.
4. **Memo field.** Add an optional memo to `transfer`, bounded in length, priced per kilobyte like `accountUpdate`. Where should the data fee be computed so that a wallet and the chain agree?
5. **Per-delegator reward history.** Record a virtual `reward` entry for every delegator of a paid validator with its share, and measure what it does to `finalizeBlock` time with a validator that has a thousand delegators.
6. **A fee market experiment.** Let a transaction state a priority fee above the schedule and have the proposer order its block by it. What changes in `applyTransaction`, and what in the mempool?
7. **Provable balances.** Make `byOwnerAsset` authenticated so a light client can prove a balance by (owner, asset) rather than by balance id, and measure the root cost per block with the database benchmark.
8. **Stream the validators too.** Extend `parseAppGenesisStream` to assemble `validators` one element at a time, and write a test with a genesis whose validator list is larger than its account list.

## Where to next

[Chapter 12](12-rpc.md) puts a JSON-RPC server in front of this application: methods, proofs, account history, event streams and the client the CLI uses.
