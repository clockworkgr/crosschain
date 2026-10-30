# Documentation

| document | for whom | what |
|---|---|---|
| [running.md](running.md) | operators and users | installing, starting nodes, the command line, configuration, genesis, the JSON-RPC, event streams, joining a chain, running a validator, the light client, operating notes, troubleshooting |
| [benchmarks.md](benchmarks.md) | anyone sizing or tuning a node | how the benchmarks work, every suite with its results and analysis, what bounds what, the defects they found, sizing guidance, further work |
| [tutorial/00-overview.md](tutorial/00-overview.md) | programmers learning how a blockchain is built | a part-by-part reading of the whole codebase in dependency order, fifteen chapters, every exported symbol, with the concepts, their provenance, the tests and exercises |

The design record and the specifications it points to live at the repository root:
[DESIGN.md](../DESIGN.md) (every decision, in order), [STAKING.md](../STAKING.md),
[FEES.md](../FEES.md), [RPC-SYNC-PROOFS.md](../RPC-SYNC-PROOFS.md),
[STATE-PAGING.md](../STATE-PAGING.md), and
[REVIEW-2026-10-28.md](../REVIEW-2026-10-28.md) (an external review and what each finding changed).

## Tutorial chapters

| | chapter | source |
|---|---|---|
| 00 | [Overview](tutorial/00-overview.md) | the map, the life of a transaction and of a height, reading order |
| 01 | [Codec](tutorial/01-codec.md) | `src/codec/` |
| 02 | [Crypto](tutorial/02-crypto.md) | `src/crypto/` |
| 03 | [Types](tutorial/03-types.md) | `src/types/`, `src/util/log.ts` |
| 04 | [Consensus](tutorial/04-consensus.md) | `src/consensus/` |
| 05 | [Mempool and executor](tutorial/05-mempool-executor.md) | `src/mempool.ts`, `src/node/executor.ts`, `src/app/types.ts`, `src/app/kvstore.ts` |
| 06 | [Peer to peer](tutorial/06-p2p.md) | `src/p2p/` |
| 07 | [Sync](tutorial/07-sync.md) | `src/sync/` |
| 08 | [Node](tutorial/08-node.md) | `src/node/node.ts`, `scripts/localnet.ts` |
| 09 | [Object database](tutorial/09-database.md) | `src/db/` |
| 10 | [Store](tutorial/10-store.md) | `src/store/` |
| 11 | [Application](tutorial/11-application.md) | `src/app/core/` |
| 12 | [RPC](tutorial/12-rpc.md) | `src/rpc/` |
| 13 | [Light client](tutorial/13-light-client.md) | `src/light/` |
| 14 | [Wallet and CLI](tutorial/14-wallet-cli.md) | `src/wallet/`, `src/cli.ts` |
| 15 | [Tests](tutorial/15-tests.md) | `test/` |

## Suggested paths

- **Run it first:** running.md sections 1 to 3, then the tutorial overview.
- **Learn consensus:** chapters 01 to 05, then 15 for the network tests.
- **Learn the state model:** chapters 09, 10 and 11, with DESIGN.md sections 6 and 7 beside them.
- **Build on it:** chapter 11's exercises (add an operation end to end), chapter 12 to expose it,
  chapter 15 to test it.
- **Tune it:** benchmarks.md sections 5 to 8.
