# Fees

The fee schedule, modelled on BitShares' `fee_schedule`. Every operation states the
fee it pays; the chain computes what the schedule requires and refuses anything
lower. The schedule is set in genesis and replaced by validator proposals, the same
mechanism that changes the staking parameters.

## 1. Why a schedule, and why the operation states its fee

BitShares prices each operation type on its own, with a few structured cases: a
registration costs more for a "premium" name, an asset costs more for a short
symbol, and variable-size operations pay per kilobyte. A committee changes the
schedule by proposal. Two properties fall out of that design and both are kept here:

- **Prices express policy, not congestion.** There is no fee market; the active
  validators decide what the chain charges and change it by two-thirds agreement.
- **What you sign is what you pay.** Each operation carries its `fee`. If the
  schedule rises between signing and inclusion the transaction fails rather than
  paying more; if it falls, the stated fee is still what is charged (BitShares does
  the same, and it keeps the signed bytes the only thing that matters).

## 2. The schedule

`FeeSchedule` lives in `global.fees` (`src/app/core/types.ts`; the pricing of one operation is `calculateFee` in `src/app/core/tx.ts`). Amounts are base
units of the core asset.

| operation | parameters | fee charged |
|---|---|---|
| transfer | fee | fee |
| accountCreate | basicFee, premiumFee, pricePerKbyte | basicFee for a cheap name, premiumFee otherwise, plus the data fee |
| accountUpdate | fee, pricePerKbyte | fee plus the data fee |
| assetCreate | symbol3, symbol4, longSymbol | by symbol length: 3, 4, or longer |
| assetIssue | fee | fee |
| validatorCreate | fee | fee (the staking `validatorCreationFee` is charged on top, into the pool) |
| validatorUpdate | fee | fee |
| delegate | fee | fee |
| undelegate | fee | fee |
| redelegate | fee | fee |
| unjail | fee | fee |
| proposalCreate | fee | fee |
| proposalSignal | fee | fee |

Then `scale` (10000 = 100%) multiplies the result, so one proposal can move every
price at once. The result is capped at the maximum share supply.

- **Cheap and premium names** follow BitShares' `is_cheap_name`: a name with a
  digit, a dot or a hyphen, or with no vowel at all (a, e, i, o, u, y), is cheap;
  every other name is premium. "alice" is premium, "alice1" and "mrkt" are cheap.
- **Data fee** = `bytes * pricePerKbyte / 1024`, rounded down, over the encoded
  operation body (everything after the fee field). Authorities hold tagged public
  keys of the chain's scheme, 1313 bytes under ML-DSA-44 or 34 under secp256k1, so
  a registration with one key per authority is about 2.7 KB or about 120 bytes, and
  a sixteen-key authority about 21 KB or about 620 bytes; this is the one place size
  matters, and under secp256k1 it hardly does.
- Signatures (2421 bytes each under ML-DSA-44, 65 under secp256k1, tag included) are
  not charged. A per-signature price would need a transaction-level payer, and
  operations are the unit of payment here, as in BitShares. Left for a later revision
  if block space becomes the constraint.

Defaults (`DEFAULT_FEES`, base units; with precision 5 a value of 100 is 0.001 of the
core asset): transfer 100; accountCreate basic 1 000, premium 5 000, 100 per KB;
accountUpdate 100 plus 100 per KB; assetCreate 100 000 / 50 000 / 10 000 for 3, 4
and longer symbols; every other operation 100, validatorCreate 1 000; scale 10 000.

Bounds (`checkFeeSchedule`): every amount at most the maximum share supply; scale
at most 1 000 000 (one hundred times). Zero is allowed everywhere, so a chain can
be free.

## 3. Paying

`applyTransaction` handles each operation in order: compute the required fee from
the schedule in `global`; refuse the transaction if `op.fee` is lower; take `op.fee`
from the fee payer's core balance; run the operation. The total goes to the
community pool after the last operation. A transaction that fails inside a block has
no effect and pays nothing, as before.

The fee payer per operation is unchanged (DESIGN.md section 7): the sender, the
registrar, the account being updated, the issuer, the operator, or the delegator.

Clients fill fees with `withFees(operations, schedule)` (`src/app/core/client.ts`),
the counterpart of BitShares' `set_fee`. The CLI fetches the schedule from the RPC
method `parameters` before every send.

## 4. Changing it

A proposal carries the complete `ChainParameters`: the fee schedule and the staking
parameters together, replaced wholesale on adoption, exactly like BitShares'
`committee_member_update_global_parameters` carries all of `chain_parameters`.
Creating and signalling, the two-thirds threshold of active stake, the lifetime and
the lowest-id-wins rule are those of STAKING.md section 4; only the payload grew.

The adopted schedule applies from the next block. Transactions already in a mempool
that state the old fee fail at inclusion if the price went up, which is the "what
you sign is what you pay" rule doing its job; wallets re-sign.

CLI:

```sh
node src/cli.ts parameters ./testnet/node0                       # the live schedule and staking parameters
node src/cli.ts propose ./testnet/node0 op0 fees.transfer.fee=250 fees.scale=12000
node src/cli.ts proposals ./testnet/node0                        # open proposals and what each changes
node src/cli.ts signal ./testnet/node1 op1 12.0
```

`propose` starts from the live parameters and applies `path=value` overrides, so a
proposal only has to name what changes even though it carries everything.

## 5. Genesis

`appState.fees` is a partial schedule merged over the defaults, amounts in base
units as strings:

```json
"fees": { "scale": 10000, "transfer": { "fee": "100" }, "accountCreate": { "premiumFee": "20000" } }
```

## 6. Encoding

An operation is `tag u8, fee u64, body`. The schedule is `scale u32` followed by the
amounts in the table order above, each u64. `ChainParameters` is the schedule
followed by the staking parameters. The proposal object stores `ChainParameters`.
This changes the transaction format, the global object and the proposal object; the
chain has no deployed network, so there is no migration.

## 7. Tests

`test/fees.test.ts`: fee computation (cheap and premium names, data fee by authority
size, symbol lengths, scale, cap); a transaction stating too little is refused and
one stating more pays what it states; a proposal changing the schedule is adopted
and a transaction signed under the old price fails afterwards while the staking
parameters are untouched; genesis overrides and bounds. The RPC test covers
`parameters` and `proposals`.
