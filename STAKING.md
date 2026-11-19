# Staking specification

Status: implemented (`src/app/core/staking.ts`, operations in `evaluate.ts`, types in
`types.ts`, tests in `test/staking.test.ts` and `test/staking-net.test.ts`). Decisions
were taken in conversation on 2026-10-28; the rationale for each sits next to it.
`DESIGN.md` sections 1 to 8 describe the engine, the object database and the core
application this builds on. Two details settled during implementation: inflation is
stored in parts per billion so a one-second block can move it, and the signer share
of a block reward is computed on the stake before the proposer bonus is paid.

## 1. Summary of decisions

| topic | decision |
|---|---|
| stake model | delegated: any account bonds core tokens to a validator; power = own bond + delegations |
| identity | a `validator` object owned by an operator account, with its own consensus key of the chain's signature scheme, rotatable |
| active set | top N candidates by bonded stake, N a parameter (21), recomputed every block |
| reward source | a community pool fed by fees and a bonded-ratio-targeting mint; the pool pays a fixed reward per block |
| reward split | proposer bonus 5%, remainder to the signers of the previous commit pro rata to their token stake in base units (consensus power is whole tokens, rounded down) |
| delegator accounting | shares with an exchange rate; rewards auto-compound; commission paid as minted shares to the operator |
| commission | one fixed rate for all validators, a parameter (10%) |
| unbonding | 7 days by block time, automatic release, still slashable; redelegation allowed with Cosmos rules |
| double sign | slash 5%, tombstone, slash unbonding and redelegation entries created after the infraction, auto-unbond delegators |
| two proposals | duplicate-proposal evidence (two different proposals signed for one height and round): punished as a double sign, at the same rate |
| forgotten lock | amnesia evidence (a precommit for one block and a later prevote for another naming no polka since): punished as a double sign, at a rate of its own (5%) |
| false citation | a prevote naming a round in which +2/3 of the power prevoted something else: punished as a forgotten lock, at the same rate |
| downtime | engine commits made fuller first; then window 1000 blocks, jail when under 50% signed, 10 minutes, slash 0.01%, explicit unjail |
| minimums | self-bond 10 000, delegation 10, validator creation fee 1 000 into the pool (whole tokens) |
| power | bonded tokens in whole units (stake divided by 10^precision) |
| evidence age | engine accepts evidence as old as the unbonding period, by block time |
| mint | Cosmos-style annual inflation moving toward a 67% bonded goal, bounded 7% to 20%, applied per block by elapsed time |
| genesis | validators declared in the app genesis as operator, consensus key, self-bond; engine list derived |
| parameters | changed by proposals: the full chain parameters (fee schedule per FEES.md plus this set), proposed and signalled by active validators, strictly more than two thirds of the active validators' token stake, 7-day life |
| provable keys | validator by consensus address, validator by operator, delegation by (delegator, validator) |
| staging | engine changes first, then staking in one pass |

## 2. Engine changes (first stage)

These are independent of staking and testable on their own.

### 2.1 Fuller commits

Today the commit stored with a block holds the precommits present at the moment of
decision. Precommits that arrive during the commit timeout are dropped, so an honest
validator that was slow by a few hundred milliseconds is recorded as absent. With
rewards and downtime keyed on signatures, that is a penalty for latency.

Change: during the commit timeout the consensus state machine keeps accepting
precommits for the decided height and round and merges them into the stored commit
before the next height starts. The proposer of height N+1 builds `lastCommit` from
that fuller stored commit, so every node applies the same signer list, because it is
in the block. Block validation of `lastCommit` is unchanged: signatures must verify
and reach +2/3; nodes do not compare it with their own view.

### 2.2 Evidence age by time

`ValidationLimits.maxEvidenceAge` (blocks) becomes `maxEvidenceAgeMs`. Evidence for an
infraction at height h is accepted when `blockTime(current) - blockTime(h) <=
maxEvidenceAgeMs`, reading the header of h from the store (a block's, or one a
state-synced node keeps alone, RPC-SYNC-PROOFS.md section 4.2); evidence for a height
the store has no header for is rejected. The evidence pool prunes by the same rule.
Genesis carries the value under `consensus.maxEvidenceAgeMs`; it must equal the
staking unbonding period, and `init` writes both from one number.

### 2.3 The application owns the validator set

`Genesis.validators` becomes optional. When it is absent, `initChain` must return a
non-empty validator set, and `genesisState` builds the sets from it. The key-value
test application keeps using the genesis list so the engine tests do not change.

## 3. Objects

Types 1 to 6 exist (global, dynamic, account, asset, balance, recentTx). Staking adds
the following. Amounts are in base units of the core asset. `tokens` and `shares` are
u64 like every other amount; shares are scaled so rounding is negligible (section 5).

| type | id | fields | indices |
|---|---|---|---|
| validator | 7 | operator (account id), consensusKey (tagged: 1313 B under ML-DSA-44, 34 B under secp256k1), tokens, shares, status (candidate, jailed, tombstoned), jailedUntil (ms), createdHeight | byOperator (unique, authenticated), byConsensusAddress (unique, authenticated; key = sha256(consensusKey)), byPower (non-unique; key = 2^64-1 - tokens, so an ascending scan is descending power) |
| delegation | 8 | delegator (account id), validator (validator id), shares | byDelegatorValidator (unique, authenticated), byValidator (non-unique) |
| unbonding | 9 | delegator, validator, tokens, creationHeight, completion (ms) | byCompletion (non-unique), byDelegatorValidator (non-unique), byValidator (non-unique) |
| redelegation | 10 | delegator, source, destination, tokens (initial), creationHeight, completion (ms) | byCompletion (non-unique), byDelegatorSourceDestination (non-unique), byDelegatorDestination (non-unique), bySource (non-unique) |
| signingInfo | 11 | validator, bitmap (downtimeWindow bits, circular), cursor, missed, tracked (blocks observed so far) | byValidator (unique) |
| proposal | 12 | proposer (validator id), parameters (fee schedule and the full staking set, section 4), signals (validator ids, sorted, at most 1 000), created (ms), expiration (ms) | byExpiration (non-unique) |
| validatorKey | 13 | address (sha256 of a consensus key), validator | byAddress (unique) |

A `validatorKey` record is written for every consensus key a validator has ever held,
at creation and at each rotation, and is never removed. It is what keeps a key from
serving a second validator, and what finds the validator behind an address it has
rotated away from (a proposer, a signer, or evidence).

`global` gains `staking: StakingParameters`. The evidence age is not a field of
`global`: the engine takes it from `consensus.maxEvidenceAgeMs` in the genesis file,
and a node running this application then follows `staking.unbondingPeriodMs`
(section 8).

`dynamic` gains:

- `communityPool` (replaces `feePool`): tokens held by the chain.
- `inflationPpb`: the current annual inflation rate in parts per billion, so that one block's
  elapsed time moves it by a measurable step.
- `lastMintTime`: block time of the last mint.
- `active`: the current active set as `{ validator, publicKey, power }[]`, at most N
  entries, in the order handed to the engine; the diff against the newly computed set
  is what `finalizeBlock` returns as validator updates.
- `expectedSigners`: the consensus addresses of the three most recently computed sets,
  newest first; the oldest is the set that signed the previous block's commit
  (section 7, step 5).
- `bonded`: total tokens behind candidate and jailed validators (excluding unbonding),
  summed again over the validators at the end of every block.

The operator's own stake is an ordinary `delegation` object; commission shares are
minted into it. A validator exists only with its operator's delegation present:
`minSelfBond` is at least 1, undelegation and redelegation refuse to take the
operator below it, and only a tombstone empties the delegation.

## 4. Parameters

`StakingParameters`, held in `global`, set at genesis, replaced wholesale by an
adopted proposal together with the fee schedule (a proposal carries
`ChainParameters = { fees, staking }`, see FEES.md section 4). Defaults, with amounts in whole tokens converted to base units at
genesis:

| parameter | default | note |
|---|---|---|
| maxValidators | 21 | active set size; a commit costs `48 + N + S × signatureSize` bytes for N slots and S signatures, the signature 2421 B under ML-DSA-44 or 65 B under secp256k1, tag included |
| unbondingPeriodMs | 604 800 000 (7 d) | also the evidence age; a light client's trusting period must stay below it, which is the client's own setting (nothing checks it against the chain) |
| minSelfBond | 10 000 | operator's own delegation; below it the validator leaves the active set, unslashed |
| minDelegation | 10 | floor on any delegate or redelegate amount |
| validatorCreationFee | 1 000 | paid into the community pool on `validatorCreate`, on top of the flat operation fee |
| commissionBps | 1 000 (10%) | one rate for everyone |
| fixedRewardPerBlock | 1 | paid from the pool; skipped when the pool holds less |
| proposerBonusBps | 500 (5%) | of the block reward |
| doubleSignSlashBps | 500 (5%) | two votes in one place, or two proposals for one round |
| amnesiaSlashBps | 500 (5%) | the slash for a lock forgotten, and for a prevote on a majority that never was; the rest of the punishment is a double sign's |
| downtimeWindow | 1 000 | blocks |
| downtimeMinSignedBps | 5 000 (50%) | jailed when signed blocks in the window fall below this |
| downtimeJailMs | 600 000 (10 min) | |
| downtimeSlashBps | 1 (0.01%) | |
| maxEntries | 7 | pending unbonding entries per (delegator, validator), and redelegation entries per (delegator, source, destination) |
| proposalLifetimeMs | 604 800 000 (7 d) | |
| goalBondedBps | 6 700 (67%) | |
| inflationMinBps | 700 (7%) | annual |
| inflationMaxBps | 2 000 (20%) | annual |
| inflationChangeBpsPerYear | 1 300 (13%) | how fast the rate moves toward the goal |

Derived, not parameters: power divisor = 10^precision of the core asset; the light
client's default trusting period is 4 days, chosen below the unbonding period.

Bounds (`checkStakingParameters`, applied to the genesis parameters and to every
proposal): `maxValidators` 1 to 1 000; `downtimeWindow` 1 to 100 000 blocks;
`maxEntries` 1 to 100; every rate in basis points 0 to 10 000, with
`inflationMinBps <= inflationMaxBps`; `unbondingPeriodMs`, `downtimeJailMs` and
`proposalLifetimeMs` from 1 ms to 100 years; `validatorCreationFee` and
`fixedRewardPerBlock` 0 to the maximum share supply (10^15), `minSelfBond` and
`minDelegation` 1 to the same.

## 5. Shares arithmetic

A validator holds `tokens` and `shares`. A delegation holds shares. The exchange rate
is `tokens / shares`. Shares are scaled by `SHARE_SCALE = 1000` on first issue (lowered from
10^6 so that the largest bond stays within a u64, review finding 7) so that
integer division loses at most one share's worth per operation, in the validator's
favour: under a thousandth of a base unit at the opening rate, and still under one
base unit until rewards have raised the rate past one base unit per share. A
delegation worth no shares at the current rate is refused rather than rounded to
nothing.

- Delegate `t` tokens: a validator with shares outstanding and no tokens (a full
  slash) takes no delegation (`validator has lost all its tokens to slashing and takes
  no delegation`), since its shares are worth nothing and there is no rate to price new
  ones at; the same holds for a redelegation into it. If `shares == 0` issue
  `t * SHARE_SCALE` shares; otherwise issue `floor(t * shares / tokens)`, refusing the operation if that
  is zero (`delegation is worth no shares at this exchange rate`) or if tokens or
  shares would pass a u64. Add `t` to tokens and the issued amount to shares and to
  the delegation.
- Unbond `s` shares: release `floor(s * tokens / shares)` tokens; subtract both. A
  delegation whose shares reach zero is removed, unless it is the operator's, which
  may only reach zero when the validator is tombstoned.
- Reward `r` to a validator with commission `c = floor(r * commissionBps / 10000)`:
  add `r` to tokens, then mint `x = floor(c * shares / (tokens - c))` shares into the
  operator's delegation (tokens here is the value after adding r). Beside what its
  delegation already held, the operator then owns `c` tokens' worth at the new rate less
  what the floor drops, under one share's worth, and the other delegators' value rose by
  their share of `r - c` and of that remainder. With no shares outstanding the whole
  reward is minted to the operator at `SHARE_SCALE`. If the minted shares would take
  `shares` past a u64, none are minted: the reward stays in tokens for every delegator
  and the operator forgoes the commission. A validator with shares outstanding but no tokens (a
  full slash) has no rate to mint commission at and is skipped; its share stays in
  the pool.
- Slash by fraction `f` (bps): tokens -= floor(tokens * f / 10000); shares unchanged,
  so every delegation loses the same fraction. Slashed tokens go to the community
  pool (a choice to revisit; Cosmos burns them).

Invariant per validator: `shares > 0` iff `tokens > 0`, except after a slash of the
whole stake (a slash rate of 10 000 bps), which leaves shares over no tokens; sum of
delegation shares equals `shares`.

## 6. Operations

New operation tags continue after assetIssue (4).

| operation | fields | authority | fee payer | rules |
|---|---|---|---|---|
| validatorCreate | operator, consensusKey, selfBond | active(operator) | operator | consensusKey a key of the chain's scheme (`consensus key must be a <scheme> key`); operator has no validator; the key never used by any validator, keys rotated away from and tombstoned validators included (`consensus key already in use`); selfBond >= minSelfBond; pays validatorCreationFee into the pool; creates validator, its validatorKey record, the signingInfo and the operator's delegation |
| validatorUpdate | operator, validator, consensusKey | active(operator) | operator | operator must be the validator's; key rotation to a key of the chain's scheme (the other is refused as on create); new key never used before, as on create; takes effect through the set computation at the end of the block (so at H+2 in the engine); not allowed when tombstoned |
| delegate | delegator, validator, amount | active(delegator) | delegator | amount >= minDelegation; validator not tombstoned (jailed allowed) and not one with shares and no tokens; moves amount from the delegator's core balance into the validator |
| undelegate | delegator, validator, shares | active(delegator) | delegator | 1 <= shares <= owned; the operator's delegation may not go below minSelfBond unless the validator is tombstoned; fewer than maxEntries pending; creates an unbonding entry maturing at time + unbondingPeriodMs (none if the shares are worth no tokens) |
| redelegate | delegator, source, destination, shares | active(delegator) | delegator | source != destination; destination not tombstoned and not one with shares and no tokens; 1 <= shares <= owned; the delegator must have no still-pending redelegation into source (no chains); fewer than maxEntries pending for the triple; the operator's delegation at source may not go below minSelfBond unless source is tombstoned; the tokens moved >= minDelegation; unbonds from source and delegates the tokens to destination immediately; creates a redelegation entry maturing at time + unbondingPeriodMs that stays slashable by source |
| unjail | operator, validator | active(operator) | operator | operator must be the validator's; status jailed; time >= jailedUntil; operator's delegation >= minSelfBond; status becomes candidate, signing window reset |
| proposalCreate | operator, validator, parameters (fees + staking) | active(operator) | operator | operator must be the validator's; validator active; creates a proposal with the proposer's signal; the fee schedule and the full staking set must pass validation (bounds, min <= max) |
| proposalSignal | operator, validator, proposal | active(operator) | operator | operator must be the validator's; validator active; not already signalled; at most 1 000 signals on a proposal; signals cannot be withdrawn |

Fees for the new operations are entries of the fee schedule in `global` (FEES.md;
default 100 each, validatorCreate 1 000).

## 7. Block procedure

`finalizeBlock` undoes pending and opens a block session; the steps before the
transactions run in it first, then the uncached signatures are verified in one batch,
then the transactions and the steps after them. If anything throws before the block
session is committed, the session is undone, which leaves the database as the previous
block left it. The session is committed before the root is computed, so a failure while
computing the root can undo nothing: the block's changes are in memory although the
height and the app hash have not advanced. The application then refuses every further
block and every check, naming the block and the cause, and writes nothing; the store
has the state of the block before, which a restart of the node reads back.
Staking adds the steps before and after the transactions.

Before transactions, in this order:

1. Prune expired transaction ids (existing).
2. Expire proposals with `expiration <= time`.
3. Mint. With `dt = time - lastMintTime`, where `lastMintTime` starts at the genesis
   time (so block 1 mints for the time elapsed since genesis) and nothing happens
   when `dt` is zero: the inflation
   rate moves toward the goal by `inflationChangeBpsPerYear * dt / year`, in the
   direction of `goalBondedBps - bondedRatioBps` (down when the two are equal),
   clamped to the bounds; then
   `minted = floor(currentSupply * inflationPpb * dt / (10^9 * year))`, clamped so
   `currentSupply` never exceeds the asset's max supply. Minted tokens go to the
   pool; `lastMintTime = time`. Bonded ratio = `dynamic.bonded / currentSupply`.
4. Rewards for the previous commit. If the pool holds at least
   `fixedRewardPerBlock`, that amount is shared out and what is actually paid leaves
   the pool: the proposer's validator (by
   `proposerAddress`, through byConsensusAddress or the record of keys it used
   before) receives `floor(reward * proposerBonusBps / 10000)`; the remainder is
   split among the validators whose consensus addresses are in `lastCommitSigners`,
   pro rata to their `tokens` as they stood before the bonus was paid (base units,
   not whole-token power), rounding dust staying in the pool. Tombstoned validators
   and validators with no tokens are skipped, and a bonus or share that cannot be
   paid stays in the pool. Each validator's share goes through the reward rule of
   section 5. Nothing is paid at height 1.
5. Downtime. For every validator expected to have signed the previous commit (the set
   for height H-1, computed at the end of block H-3 when this block is H, kept in
   `dynamic.expectedSigners`): advance its signing window one
   bit (signed or missed, from `lastCommitSigners`), maintaining `missed`. When the
   window is full and `signed < downtimeWindow * downtimeMinSignedBps / 10000`: slash
   by downtimeSlashBps, set status jailed and `jailedUntil = time + downtimeJailMs`,
   reset the window. Jailed and tombstoned validators are not tracked, and nothing
   is tracked at height 1.
6. Misbehavior. For each `{ kind, address, height }`: find the validator by consensus
   address; if not tombstoned: slash `tokens` by doubleSignSlashBps when the
   kind is `duplicateVote` or `duplicateProposal`, by amnesiaSlashBps when it is
   `amnesia` or `falseCitation`; slash every
   unbonding entry and every redelegation entry from this validator whose
   `creationHeight >= height - 1` by the same fraction (the two-height delay before an update
   lands, review finding 10; for redelegations, the slash is
   taken from the destination delegation's shares at the destination's rate, and
   if that delegation runs out or the destination has no tokens, the rest from the delegator's unbonding entries at the
   destination with `creationHeight >=` the redelegation's, in index order, so that
   undelegating at the destination does not escape it); set status tombstoned; convert every delegation into an unbonding
   entry maturing at `time + unbondingPeriodMs` (one per delegation, ignoring
   maxEntries); the validator keeps `tokens = 0`, `shares = 0`, and its signing
   record is removed.
7. Mature queues, last, so that stake whose liability ends in this very block is
   still there to be slashed by the evidence the block carries: every unbonding
   entry with `completion <= time` pays its tokens to the delegator's core balance
   and is removed; every matured redelegation entry is removed. Order of processing
   is the index order (completion, then id).

Then the transactions, each in its own session as today.

After transactions:

8. Tally proposals: for each open proposal, sum the `tokens` of signalling validators
   that are currently active; if `3 * sum > 2 * activeTokens`, adopt: `global.fees`
   and `global.staking` become the proposal's parameters, the proposal is removed. If
   several adopt in one block, the one with the lowest id wins and the rest are
   removed too. Parameters under which the active set would be empty are not
   adopted; the proposals lapse. When the unbonding period grows, every pending
   unbonding and redelegation entry's completion moves out by the difference, so
   stake on its way out stays liable for as long as evidence may arrive; when the
   downtime window changes, every signing record starts afresh.
9. Compute the active set: scan byPower; take validators with status candidate, power
   >= 1 and the operator's delegation worth >= minSelfBond, in index order, up to
   maxValidators. Power = `floor(tokens / 10^precision)`. Diff against
   `dynamic.active`: removed validators get power 0, new and changed ones their power,
   keyed by consensus key. Store the new set in `dynamic.active`. These are the
   validator updates returned to the engine, which applies them at H+2.
10. Update `dynamic` (the new set's addresses at the head of `expectedSigners`, the
    bonded total summed again, then height and time) and compute the root.

`checkTx` runs none of the block steps; it evaluates transactions against the
pending session as before.

## 8. Genesis

The engine's `validators` list is dropped from the genesis files `init` writes. The app
genesis gains:

```json
{
  "staking": { "...parameters, whole-token amounts..." },
  "communityPool": "1000000",
  "validators": [
    { "operator": "val0", "consensusKey": "<hex>", "selfBond": "20000" }
  ]
}
```

`applyGenesis` checks that each consensus key is of the chain's scheme (`genesis
validator <operator>: consensus key must be a <scheme> key`), creates the validator
objects, moves each self-bond from the operator
account's balance into the validator (issuing shares at `SHARE_SCALE`), creates the
pool as supply of the core asset beside the account balances (together they may not
exceed its max supply), sets `inflationPpb` to `inflationMinBps` expressed in parts
per billion, computes the active set, and `initChain` returns it. A self-bond below
`minSelfBond`, an operator that is not a genesis account or already has a validator,
and a consensus key listed twice are refused. `init` writes the engine's
`consensus.maxEvidenceAgeMs` and `unbondingPeriodMs` from one number. A running node
then takes the evidence age from the `unbondingPeriodMs` in `global` each time it is
asked for: at start, when the executor prunes after applying a block, and after every
commit. So an adopted proposal moves it, and the block that lengthens the period is
already pruned behind with the longer one; a limit set in the node's own
configuration takes precedence. What a node pruned under the shorter period is gone:
until a full new period has passed, a node that prunes blocks refuses evidence for
the heights it no longer holds.

## 9. Interplay with the engine's timing

- Set changes take effect two heights after the block that computes them: the set
  computed at the end of block H signs from H+2. A validator jailed or tombstoned at
  height H still appears in the commits for H and H+1, which blocks H+1 and H+2 carry
  and pay rewards for. A jailed one's signatures still earn the signer share in those
  two blocks; a tombstoned one earns nothing, since rewards skip tombstoned validators.
  Harmless.
- The proposer of height H is looked up by consensus address; after a key rotation the
  engine's set still holds the old address until the update lands, and the
  `validatorKey` record of that address leads to the validator.
- `lastCommitSigners` at height H are addresses from the set at H-1; a validator
  jailed since is no longer tracked for downtime, and one tombstoned since is
  skipped altogether.

## 10. Proofs and queries

Authenticated unique indices: validator byOperator, validator byConsensusAddress,
delegation byDelegatorValidator, in addition to account byName and asset bySymbol.
The light client can therefore prove which validator stands behind a consensus
address that is a validator's current one, and prove the existence or absence of a
delegation. The value proven is the validator's id; the operator and the bonded
amount are in the validator object, which takes an object proof of its own. A key
that was rotated away is not covered: byConsensusAddress holds only the current
address, so for the two heights the engine's set still signs with the old key the
proof for that address is one of absence, and the `validatorKey` record that leads
from an old address to its validator has no authenticated index.

The application makes the proofs with `CoreApp.proveValidatorAddress(address, height)`
and `CoreApp.proveDelegation(delegator, validator, height)`. Over RPC, `validator`
(by `operator` or `id`) and `delegation` (by `delegator` and `validator`) answer as
of a `height`, `delegation` returns the proof with `prove`, and `key` looks up and
proves a key of any authenticated index, a validator by consensus address among them.

CLI additions: `create-validator <nodeDir> <operator> <selfBond>` (uses the node's own
validator key from its `config.json` and the operator's key in the keystore),
`delegate <target> <from> <operator> <amount>`, `undelegate <target> <from> <operator>
<amount>` (the amount is converted to shares at the current rate), `unjail <target>
<operator>`, and `show <target>` (pool, bonded total, inflation, and the active set
with status, stake, self-bond and power). Amounts are whole tokens and a validator
is named by its operator account. `parameters`, `proposals`, `propose` and `signal`
are in FEES.md section 4. There is no CLI command for `redelegate` or for listing
an account's delegations.

Localnet (`scripts/localnet.ts`): four genesis validators by default with equal
self-bonds, a short downtime window and jail period, and a faucet that every second
registers an account, pays one, or delegates 500 tokens to a validator in turn.

## 11. Invariants to test

- Supply: `currentSupply = sum(balances) + sum(validator.tokens) + sum(unbonding.tokens) + communityPool` at every height; the mint is the only increase and nothing is burned.
- Per validator: `shares > 0` iff `tokens > 0`, except after a slash of the whole stake, which leaves shares over no tokens (section 5); delegation shares sum to `shares`, the operator's delegation exists unless tombstoned.
- `dynamic.bonded = sum(validator.tokens over candidates and jailed)`.
- Active set: at most maxValidators, all candidates with power >= 1 and self-bond met, no higher-power candidate excluded.
- Pending entries per pair never exceed maxEntries except forced tombstone conversions.
- A proof by consensus address at height H names the validator whose stake at H set its power in `dynamic.active` at H, the set the engine applies at H+2 (header H+1's `nextValidatorsHash`); the set that signs H+1 was computed at H-1.

## 12. Test plan

Engine: a slow validator's precommit arriving during the commit timeout appears in
the stored commit and in the next block's lastCommit on every node; evidence older
than the configured age by time is rejected, younger accepted; a chain whose genesis
has no validator list starts from the app's set.

Application, one block at a time: create validator and genesis set; delegate and
exchange rate after rewards; commission minting; undelegate with queue maturity and
the entry cap; redelegate with the no-chain rule and source slashing; downtime jail,
unjail with cooldown and self-bond check; double-sign slash, the forgotten-lock slash at its own rate, tombstone, forced
unbonding and the post-infraction entry slash; mint rate movement and the supply cap;
proposal lifecycle; set computation and diff; the supply invariant at the end of
each of these scenarios; a delegation to a validator slashed of its whole stake is
refused (`test/review5-app.test.ts`). No test runs the invariants after a randomized sequence of operations.

Network (`test/staking-net.test.ts`): a four-validator network where delegation
raises a validator's power, a stopped validator is jailed within the window and
returns after unjail, and the light client follows the set through all of it. A
double sign is tested against the application one block at a time, and its evidence
on a network by the recovery test, not on a staking network.
