# 11. The application

This chapter is about the part of the node that gives the chain its meaning: accounts, assets, balances, fees, and the staking rules that decide who the validators are. The engine from the earlier chapters never looks inside a transaction; it hands bytes to the application through the `Application` interface described in [chapter 05](05-mempool-executor.md) (`initChain`, `checkTx`, `finalizeBlock`, `commit`, `info`) and takes back an app hash, per-transaction results and validator updates. The application owns the object database from [chapter 09](09-database.md), where every account, asset, balance and validator is an object with a numeric id and a place in a Merkle tree, and it writes those objects to the key-value store from [chapter 10](10-store.md) at every commit. The JSON-RPC server in [chapter 12](12-rpc.md) reads the application's committed state, proofs, account history and snapshots. All of it lives in `src/app/core/`, twelve files that this chapter walks through one by one.

## Concepts

### The interface the engine calls

Everything in this chapter is reached through five methods, declared in `src/app/types.ts` and documented in [chapter 05](05-mempool-executor.md):

```ts
export interface Application {
  initChain(genesis: Genesis): Promise<InitChainResult>;
  checkTx(tx: Uint8Array): Promise<CheckTxResult>;
  finalizeBlock(req: FinalizeBlockRequest): Promise<FinalizeBlockResult>;
  commit(): Promise<void>;
  info(): Promise<{ lastHeight: bigint; lastAppHash: Uint8Array }>;
}
```

The file's header gives the call order: `initChain` once on a fresh data directory; `checkTx` for every transaction entering the mempool and again for everything still pending after each commit; `finalizeBlock` once per committed block with all its transactions; `commit` immediately after, to persist; `info` on startup so consensus can replay blocks the application missed. A `finalizeBlock` request carries what the staking rules need to know about the block besides its transactions:

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

Most chains model state as a map from keys to byte strings. This one follows Graphene (the engine behind BitShares) and models state as typed objects. An object has a numeric type (account is 3, asset is 4) and an instance number assigned from a per-type counter, and the pair is its id: `3.0` is the first account, `4.0` the first asset. [Chapter 09](09-database.md) explains how dense instance numbers let the database keep each type in a plain array and hash it into a complete binary Merkle tree. For this chapter the consequence is that every reference inside the state is an 8-byte id, not a name and not a public key (1,313 bytes with ML-DSA-44, 34 with secp256k1, scheme tag included). A transfer names its two accounts and its asset in 24 bytes.

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

Users want to see what happened to their account, which the state alone does not say (a balance is a number, not a list of transfers). The application records, outside the state root, one history entry per operation for every account the operation names. Things the chain does on its own, a reward, a slash, a jailing, a matured unbonding, produce **virtual** entries with no transaction behind them. BitShares keeps the same kind of record. Entries are collected during `finalizeBlock` and written by `commit`, keyed by account and a per-account sequence number.

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

`isPublicKey` wants a known tag followed by exactly that scheme's key, and `g.scheme` is the chain's from `global`; the engine would refuse a validator update of the other scheme anyway (`nextState` in chapter 3), but refusing it here keeps such a key out of the mempool and out of the state. The undelegate self-bond check reads:

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

Account history entries and the recorder that collects them during a block.

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

**`exportSnapshot(db, types, height, chunkObjects)`** walks `db.typeOrder`, asks the database for each type's leaf at that height (`typeLeafProofAt`), and for every range of `chunkObjects` instances collects the objects present at that height (`getAt`), encodes them, and attaches `rangeProofAt(type, from, to, height)`. Each chunk's sha256 goes into the manifest. The height must be inside the database's retention window, which it always is right after commit.

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

**`CoreAppOptions`**: `genesis` (the engine's `Genesis`), optional `appGenesis` (already parsed, required when it lives in a file), `verifier` (the worker pool or the inline one), optional `kv` (default an in-memory store), `retainVersions`, `snapshotInterval` (default 1000; 0 disables), `snapshotsKept` (default 2), `snapshotChunkObjects` (default 2000), `log`.

The store's key layout, from the constants at the top of the file:

| prefix | key | value |
|---|---|---|
| `m` | meta | height u64, app hash |
| `o` | object id u64 | the object's encoding |
| `c` | type u16 | next instance counter |
| `h` | version u64 | the database history record for that version |
| `a` | account u64, sequence u64 | a history entry |
| `q` | account u64 | the account's next history sequence |
| `s` | height u64 | a snapshot manifest |
| `k` | height u64, type u16, chunk u32 | a snapshot chunk |

**`OpenedDatabase`** is what reopening returns: the database, the stored height and app hash, `staleHistory` (history versions in the store that fell outside the window) and timing figures for the startup log.

**`openObjectDatabase(kv, types, retainVersions?)`** loads a database from a store written by `CoreApp`, or returns null if the store is empty:

```ts
  for (const [k, v] of kv.range(OBJECT_PREFIX, prefixEnd(OBJECT_PREFIX))) {
    db.importObject(decode(k, (r) => (r.u8(), r.u64())), v);
    objects++;
  }
  for (const t of types) {
    const c = kv.get(counterKey(t.id));
    if (c) db.setCounter(t.id, Number(decode(c, (r) => r.u64())));
  }
  const t1 = performance.now();
  const appHash = db.root(Number(meta.height));
  if (!bytesEqual(appHash, meta.appHash)) throw new Error('stored objects do not hash to the stored app hash');
  // That root produced a change list holding the encoded bytes of every object; the store already has them.
  db.dropChanges();
  const t2 = performance.now();
  const staleHistory: number[] = [];
  for (const [k, v] of kv.range(HISTORY_PREFIX, prefixEnd(HISTORY_PREFIX))) {
    const version = Number(decode(k, (r) => (r.u8(), r.u64())));
    if (version > db.currentVersion - (retainVersions ?? 100) && version <= db.currentVersion) db.loadHistory(version, decode(v, decodeHistory));
    else staleHistory.push(version);
  }
  db.rebuildIndexVersions();
```

It imports every `o` entry, sets the counters, recomputes the root at the stored height and refuses to start if it differs, drops the change list that the root produced (review finding 36: otherwise a second copy of every object sat in memory), loads the history records inside the retention window (the rest are reported as stale for the next commit to delete), and rebuilds the index versions so proofs at past heights work again. The store is never trusted blindly: a corrupted object makes the root differ and the node refuses to start.

**`CoreApp`** implements `Application`. Its fields: `chainId`, the public `db`, the store, the verifier, the signing `context`, the logger, `height`, `appHash`, `lastTime`, the `pending` session, the `sigCache` (transaction id hex to address hex to the set of hashes of every signature by that signer over that body that verified), `toPersist` (what the next `commit` writes), `staleHistory`, the `recorder`, the three snapshot settings and `lastHistory` (what the last commit wrote, for the RPC's event streams).

**The genesis and reopen paths** are the constructor:

```ts
    const stored = openObjectDatabase(this.kv, CORE_TYPES, opts.retainVersions);
    if (stored) {
      this.db = stored.db;
      this.height = stored.height;
      this.appHash = stored.appHash;
      this.staleHistory = stored.staleHistory;
      this.log('info', 'loaded application state', { height: this.height, appHash: this.appHash, provableFrom: this.db.lowestVersion, ...stored.timing });
    } else {
      if (opts.genesis.appStateFile && !opts.appGenesis) throw new Error('the application genesis is in a file; parse it with loadAppGenesis first');
      const t0 = performance.now();
      const g = opts.appGenesis ?? parseAppGenesis(opts.genesis.appState);
      const t1 = performance.now();
      this.db = new ObjectDatabase(CORE_TYPES, { retainVersions: opts.retainVersions });
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

A store with state wins over genesis, so genesis is parsed only once in a node's life; **`CoreApp.hasState(kv)`** lets the node skip parsing it at all. Genesis is applied, hashed as version 0 and persisted immediately. The scheme handed to `applyGenesis` is the engine genesis's `signatureScheme`, ML-DSA-44 when absent, turned into its tag by `schemeTag`; from then on the application reads it from the committed `global` object (`chainScheme`, below) and never from the genesis document again, so a reopened store carries its own scheme. Either way the constructor ends by opening the pending session. The README reports a one-gigabyte genesis (193,536 accounts with two keys each) parsing as a token stream in 6.4 s and building its objects, first root and LMDB write in 8.1 s, and a restart from LMDB at that size in 11.8 s, most of it decoding objects and rebuilding index history.

**`initChain(_genesis)`** refuses to run on an application that already has blocks and returns the genesis app hash with the active set as validator updates; when the set is non-empty, the engine uses it in place of its own genesis list (`STAKING.md` section 2.3).

**`checkTx(bytes)`**:

```ts
  async checkTx(bytes: Uint8Array): Promise<CheckTxResult> {
    const d = this.decode(bytes);
    if ('error' in d) return { ok: false, error: d.error };
    while (this.applying) await this.applying;
    const sigError = await this.verifySignatures(d.tx, d.txId);
    if (sigError) return { ok: false, error: sigError };
    // A block may have started while the pool verified; its state must be the one checked against.
    while (this.applying) await this.applying;
    const r = this.applyChecked(d.tx, d.txId, this.lastTime, this.height + 1n, this.pending !== null, false);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
```

Decode (a failure is `malformed transaction: ...`), wait for any block in progress, verify the signatures, wait again in case a block began during the await, then evaluate against the pending session with the last block time and the next height, keeping the result in the pending session. `applying` is the promise that serialises checks behind a block; review finding 3 explains why a check must not resolve keys against a state that a block is about to change.

The concurrency story in full. Node is single-threaded, so two `checkTx` calls and a `finalizeBlock` interleave only at `await` points, and the only awaits in this file are the two calls into the verifier. Everything between an await and the next one is one synchronous run that opens a session, evaluates and closes it, so sessions always close innermost first, which the database insists on. The one hazard is a check whose signature verification was in flight when a block began: its candidate keys were resolved against the pre-block state. The second `while (this.applying)` makes it wait, and `applyChecked` then re-reads the authorities and checks the thresholds against the state after the block, in the fresh pending session. The signature cache entry it produced stays valid, since a signature over a body is a fact about bytes. The README measures `checkTx` at 6,700 transfers per second through the worker pool, essentially the pool's verification rate.

**`finalizeBlock(req)`** is the block procedure of `DESIGN.md` section 7 and `STAKING.md` section 7, in this order:

1. Set `applying` so that checks wait.
2. `closePending()`: undo the pending session, so the block runs on committed state. Then open `blockSession`, one undo session that brackets everything the block does until its root is taken.
3. `pruneExpiredTxs(this.db, req.time)`.
4. `recorder.reset(req.height)` and `beginBlock(...)` with the recorder: proposals, mint, rewards, downtime, evidence, then the queues (begin block).
5. Decode every transaction.
6. `prewarmSignatures(decoded)`: one batch to the worker pool for every signature that the cache does not already vouch for (batch signature pre-verification).
7. For each transaction in order: a decode error is its result; otherwise `verifySignatures` resolves the signers' keys against the state as it stands after the transactions before it, `recorder.beginTx`, `applyChecked(..., keep: true, final: true)`, `recorder.endTx(r.ok)`, and the result is pushed (per-transaction key resolution and evaluation).
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
        const sigError = await this.verifySignatures(d.tx, d.txId);
        if (sigError) {
          txResults.push({ ok: false, error: sigError });
          continue;
        }
        this.recorder.beginTx(txHash(req.txs[i]!), i);
        const r = this.applyChecked(d.tx, d.txId, req.time, req.height, true, true);
        this.recorder.endTx(r.ok);
        txResults.push(r);
      }
      const validatorUpdates = endBlock(this.db, this.log);
```

Why two signature passes? Review finding 3 showed that resolving every key before any transaction executes lets a node that saw T1 (install a new key) and T2 (spend with it) in its mempool accept T2 while a cold node rejects it: different roots for the same block. So keys are resolved per transaction. Review finding 32 then showed that doing the crypto inside that loop fed the worker pool one job at a time, so a cold block ran at single-thread speed. The split is sound because a cache entry says only "this address signed this body", which no state change can invalidate; the per-transaction pass still decides whether that address is allowed to sign. The README puts the warm path (signatures verified at admission) at 26,000 transfers per second, a full block of 1,500 in 57 ms, and the cold path (block sync, or a node that missed the gossip) at 6,300 per second with 11 verification threads.

**`commit()`** persists `toPersist` if there is one, publishes `lastHistory`, and takes a snapshot when the height is a multiple of `snapshotInterval`. The README measures a commit after a 500-transfer block at 2.6 ms to memory and 8.8 ms to LMDB.

`persist(p)` (private) is the one store transaction per block:

```ts
    this.kv.write((w) => {
      const next = new Map<ObjectId, bigint>();
      for (const [account, entry] of p.history) {
        const seq = next.get(account) ?? this.nextSequence(account);
        w.put(accountHistoryKey(account, seq), historyEntryToBytes(entry));
        next.set(account, seq + 1n);
      }
      for (const [account, seq] of next) w.put(sequenceKey(account), encode((wr) => wr.u64(seq)));
      for (const c of p.changes.objects) {
        if (c.bytes) w.put(objectKey(c.id), c.bytes);
        else w.del(objectKey(c.id));
      }
      for (const [type, next] of p.changes.counters) w.put(counterKey(type), encode((wr) => wr.u64(BigInt(next))));
      if (p.changes.history) w.put(historyKey(p.changes.version), encode((wr) => encodeHistory(wr, p.changes.history!)));
      // History that no longer serves any provable height: the version that just left the window, and leftovers found at startup.
      if (this.db.lowestVersion > 0) w.del(historyKey(this.db.lowestVersion));
      for (const v of this.staleHistory) w.del(historyKey(v));
      this.staleHistory = [];
      w.put(META_KEY, encode((wr) => wr.u64(p.meta.height).fixed(p.meta.appHash)));
    });
    this.db.dropChanges();
```

History entries with their per-account sequence numbers, the changed objects (a null encoding is a removal), the moved counters, the version's history record, deletion of the record that just left the window, and the meta last, all in one write. Then the change list is dropped. A crash between `finalizeBlock` and `commit` leaves the store at the previous height and the engine replays the block on restart, which is why `info()` reports the stored height.

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

The `stale` expression keeps the newest `snapshotsKept − 1` earlier heights and deletes the rest; with the default of two, every snapshot but the previous one goes. (`-(1) || undefined` is `-1`, so `slice(0, -1)` drops the last element; with `snapshotsKept` of 1 it is `-0 || undefined`, so every earlier height is stale.) **`snapshotHeights()`**, **`manifestBytes(height)`** and **`chunkBytes(height, type, index)`** serve them to peers. **`CoreApp.writeImportedState(kv, db, height, appHash)`** is the other end: it writes a database loaded from a snapshot into an empty store, as a commit would have, refusing a store that already has state; state sync calls it inside the environment-wide transaction that also writes the chain store, so the two stores never disagree about whether the join happened. The README measures a snapshot export of a gigabyte state at 3.5 s and a complete state-sync import of 201 chunks (504 MiB) at 37 s end to end.

**`info()`** returns the committed height and app hash.

History: **`accountHistory(account, from = 0n, limit = 100, reverse = false)`** returns `{ entries, total }`:

```ts
  accountHistory(account: ObjectId, from = 0n, limit = 100, reverse = false): { entries: (HistoryEntry & { sequence: bigint })[]; total: bigint } {
    const total = this.nextSequence(account);
    const entries: (HistoryEntry & { sequence: bigint })[] = [];
    if (reverse) {
      for (let seq = total - 1n - from; seq >= 0n && entries.length < limit; seq--) {
        const v = this.kv.get(accountHistoryKey(account, seq));
        if (v) entries.push({ ...historyEntryFromBytes(v), sequence: seq });
      }
    } else {
      for (const [k, v] of this.kv.range(accountHistoryKey(account, from), accountHistoryKey(account, total))) {
        if (entries.length >= limit) break;
        entries.push({ ...historyEntryFromBytes(v), sequence: decode(k, (r) => (r.u8(), r.u64(), r.u64())) });
      }
    }
    return { entries, total };
  }
```

Oldest first is a range read from `from`; newest first walks sequence numbers down from `total − 1 − from`, which is what a wallet showing recent activity wants. A reader decodes an `operation` entry's `data` with `decodeOperation` and a virtual entry's with `decodeVirtualData`, as the RPC and the network test do. The README measures the newest twenty entries of an account at 930,000 reads per second on the gigabyte state. `nextSequence` (private) reads the `q` entry.

Queries: `lastHeight`, `lastAppHash`, `lowestProvableHeight` (the oldest height a proof can be made for), `coreAsset`, **`stakingParameters()`**, **`global()`**, **`feeSchedule()`**, **`chainParameters()`**, **`dynamic()`**, **`accountByName(name)`** (a name that cannot be an index key, one with a zero byte, returns null rather than throwing), **`account(id)`**, **`balance(owner, asset = core)`**. What "committed" means here needs stating precisely, because two views are in play. `global()`, `dynamic()`, `account(id)`, `accountByName` and `balance` return objects read through `db.getCommitted`, which looks through every open session back to the last `root()`, so a transfer sitting in the pending session is invisible and the test `checks pending transactions in sequence` asserts exactly that. The indices, though, are live: `accountByName` finds the id through the live `byName` index and `balance` through the live `byOwnerAsset` index, and only then reads the object behind that id committed. The difference shows for an object the pending session created: the live index finds it, `getCommitted` says it did not exist at the last root, and the query answers null, which is the right answer. `coreAsset` and `stakingParameters()` read the live `global` object, which only a block ever modifies, so outside `finalizeBlock` the live and committed values are one and the same. The RPC in [chapter 12](12-rpc.md) follows the same rule for everything it derives from these objects: a validator's self-bond and delegator count, a delegation's unbonding entries and an account's balances are assembled from committed objects, with the live indices used only to find which ids to read. Proofs: **`proof(id)`** against the current app hash, **`proofAt(id, height)`** for a past height inside the window ("Verify it against header height+1"), **`proveAccountName(name, height)`**, **`proveAssetSymbol(symbol, height)`**, **`proveValidatorAddress(address, height)`** and **`proveDelegation(delegator, validator, height)`** over the four authenticated indices; a key proof proves the 8-byte id the key maps to, or its absence.

The private internals:

- `decode(bytes)` wraps `decodeTransaction` and computes the id.
- `lookupAuthorities` is the `AuthorityLookup` over the live database.
- `closePending()` undoes and clears the pending session.
- `signingKeys(tx)` gathers the candidate keys of every required account's active and owner authorities with `collectKeys`, or returns the error `account X does not exist`.
- `cacheVerified(txKey, address, sigHash)`, `isVerified(txKey, address, sigHash)` and `trimCache` maintain `sigCache`, a map from transaction id to a map from signer address to a **set** of signature hashes. `cacheVerified` adds to the set and never replaces it; `isVerified` asks whether a particular signature's hash is in the set; `trimCache` drops the oldest transaction once the cache holds more than `SIG_CACHE_MAX = 20,000`:

```ts
  private cacheVerified(txKey: string, address: string, sigHash: string): void {
    let verified = this.sigCache.get(txKey);
    if (!verified) {
      verified = new Map();
      this.sigCache.set(txKey, verified);
      this.trimCache();
    }
    // A set, never a replacement: two valid signatures by one key over one body can be in flight at once
    // (signing is randomised), and a later verification must not make an earlier one look unverified.
    let hashes = verified.get(address);
    if (!hashes) verified.set(address, (hashes = new Set()));
    hashes.add(sigHash);
  }

  private isVerified(txKey: string, address: string, sigHash: string): boolean {
    return this.sigCache.get(txKey)?.get(address)?.has(sigHash) ?? false;
  }
```

  Why a set per (body, key) rather than one hash: ML-DSA signing is randomised by default (the "hedged" variant), so one key produces a different valid signature over the same body every time it signs. Two copies of one transaction with different signature bytes can be in the system at once, one gossiped from a peer and one re-signed by a wallet that retried, and both are valid. With a single slot per signer, verifying the second copy overwrote the record of the first, and a `checkTx` for the first copy that was between its verification and its evaluation then found its own signature "unverified". A set keeps every signature that verified, so neither copy can make the other look bad, and the entry still says only "this key signed this body with these exact bytes".
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

- `verifySignatures(tx, txId)` returns an error string or null:

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
      if (this.isVerified(txKey, address, sigHash)) continue;
      jobs.push({ sig: s.signature, msg: body, publicKey, context: this.context });
      jobKeys.push([address, sigHash]);
    }
    if (jobs.length > 0) {
      const results = await this.verifier.verify(jobs);
      if (results.some((ok) => !ok)) return 'invalid signature';
      for (const [address, sigHash] of jobKeys) this.cacheVerified(txKey, address, sigHash);
    }
```

A transaction with no signatures is `transaction has no signatures`. A signature tagged with another scheme than the chain's is refused as `signature of another scheme than the chain uses` before any job is built: chapter 2's `verify` would fail it anyway, since the key and the signature would disagree on their tags, but the refusal names the reason and costs no verification work. The cache binds the hash of the signature bytes (review finding 2): before that, a node that had verified a transaction once accepted the same body with a zeroed signature in a block, and nodes that had not split from it. The review test "accepts both valid signatures a key can make over one body, whichever was seen first" signs one body twice with one key, verifies both copies, and checks that each still evaluates after the other.

- `applyChecked(tx, txId, time, height, keep, final)` is synchronous on purpose. It first requires every signature to be in the cache (`unverified signature` otherwise; `verifySignatures` has just run on every path, and because the cache keeps every verified signature of a signer rather than the latest one, a second copy of the transaction verified in between cannot make this one look unverified), then checks thresholds against current state: each owner-required account's owner authority, and each active-required account's active or owner authority (`missing owner authority of X`, `missing active authority of X`). Then:

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
| `unverified signature` | `applyChecked` | a signature is not in the cache; a guard rather than an expected outcome, since `verifySignatures` runs first on every path and the cache keeps every verified signature, so only an eviction of the entry (20,000 other transactions between verification and evaluation) could trigger it |
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
