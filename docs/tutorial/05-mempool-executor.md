# 5. Mempool and executor

This chapter covers the two pieces that sit between [consensus](04-consensus.md) and the application: the mempool (`src/mempool.ts`), where transactions wait to be put into a block, and the block executor (`src/node/executor.ts`), the only component that advances chain state. It also covers the interface the application implements (`src/app/types.ts`) and the small key-value application the engine tests run against (`src/app/kvstore.ts`). The mempool is fed by the [RPC](12-rpc.md) and by [p2p](06-p2p.md) transaction gossip, and feeds consensus through `reapTxs`. The executor is fed decided blocks by consensus and downloaded blocks by [sync](07-sync.md), persists through the [block store](10-store.md), and drives the real application of [chapter 11](11-application.md) through the interface defined here. The [node](08-node.md) constructs both and wires their callbacks.

## Concepts

### Transactions are opaque to the engine

A transaction is a byte string. The consensus engine never parses it; it hashes it (`txHash` in `src/types/block.ts` is `sha256(tx)`), checks its size, asks the application whether it is acceptable, stores it, gossips it, and eventually puts it in a block. What the bytes mean, whether a signature inside them is valid, whether an account has the balance it spends: all of that belongs to the application. `DESIGN.md` section 2 states the split: "Txs are opaque bytes to consensus."

### What a mempool is and why admission is checked

The *mempool* (memory pool) is the set of transactions a node has received but that are not yet in a block. Every node has its own; they are similar but not identical, because gossip takes time. When a validator becomes proposer it fills a block from its mempool.

Admission is checked for three reasons. The first is spam: a node that stored and forwarded every byte string anyone sent it would be a free amplifier for garbage. The second is dead transactions: a transaction that can never execute (bad signature, insufficient balance, wrong nonce) would still take block space, and since this chain charges no fee for a failed transaction (`DESIGN.md` section 10), it would be free to fill blocks with them. The third is gossip loops: nodes forward what they accept, so the same transaction would circulate forever unless each node remembered what it had seen. The application's `checkTx` answers the first two; a bounded *seen cache* of hashes answers the third. This is the CometBFT model: `CheckTx` at admission, a cache of recent hashes, and a *recheck* of everything still pending after each block, because validity depends on state and state just changed.

Ordering is first in, first out. CometBFT's default mempool is also FIFO; fee-priority ordering is an optional feature there and not implemented here.

### The consensus / application split (ABCI)

Cosmos separates the consensus engine from the application through ABCI, the Application Blockchain Interface. The engine handles networking, consensus, mempool admission and block storage; the application handles the transaction format, state and state transitions, and tells the engine who the validators are. In Cosmos the two are separate processes talking over a socket; here they are one process and the interface is a TypeScript interface, `Application` in `src/app/types.ts`. The method names follow ABCI 2.0: `InitChain`, `CheckTx`, `FinalizeBlock`, `Commit`, `Info`. ABCI's `PrepareProposal`, `ProcessProposal` and vote extensions are not implemented: the engine builds blocks itself and the application sees a block only once it is decided.

### Deferred execution

The header of block `N` carries `appHash`, the hash of application state, and `lastResultsHash`, the Merkle root of transaction results. Both describe the state *after executing block N-1*, not block N. `src/types/block.ts` says why:

```ts
/**
 * Block header. Execution is deferred by one block: `appHash` and
 * `lastResultsHash` describe the state and the transaction results after
 * executing the *previous* block, because this block is proposed before
 * anyone has run it.
 */
```

The proposer assembles a block from the mempool and chain state and broadcasts it at once; nobody runs its transactions until it is decided. A validator checks the header's `appHash` against the chain state it already holds (chapter 4, `validateBlockStructure`). The cost is that a proof of a transaction's *result* needs the next header (`RPC-SYNC-PROOFS.md` section 2.1); the benefit is that proposing and validating are cheap and the application runs each block exactly once. This is the Tendermint model; Cosmos SDK chains work the same way.

### Validator set changes take effect at H+2

When the application returns validator updates from `finalizeBlock` for block `H`, they take effect at height `H+2`. Chain state therefore carries three sets, documented in `src/types/state.ts`:

```ts
 * Three validator sets are kept because set changes take effect two heights
 * after the block that requested them:
 *   lastValidators  signed block lastHeight
 *   validators      will sign block lastHeight + 1
 *   nextValidators  will sign block lastHeight + 2
 * This keeps the set that commits a block equal to the one named in its
 * header, and gives light clients one header's notice of every change.
```

The header of block `H+1` names `validatorsHash` (the set that signs it) and `nextValidatorsHash` (the set that signs `H+2`), so a light client sees every change one header before it happens, and the set that signs a block is always the one its own header names. The executor's `nextState` call is where the shift happens.

### The app hash and determinism

Every node runs the same blocks through the same application and must produce the same `appHash`, or the next proposal fails validation on the nodes that disagree and the chain halts. So the application must be deterministic: no wall clock, no randomness, no iteration order that depends on memory layout, integer arithmetic only. The key-value application sorts its entries before hashing for exactly this reason. The executor checks the hash on replay after a crash and refuses to start if it differs.

### Crash recovery

A node can die at any instruction. What has to hold on restart: no block is applied twice, no decided block is lost, and application state and chain state describe the same height. The executor's file header gives the persistence order:

```ts
 * Persistence order matters for crash recovery:
 *   1. app.finalizeBlock      (in memory, gives app hash and validator updates)
 *   2. save block, commit, new chain state   (fsync)
 *   3. app.commit             (app persists)
 * If the process dies between 2 and 3 the app is one block behind the chain
 * state on restart. `open` detects this through app.info() and replays the
 * missing blocks, checking that the app hash comes out the same.
```

Dying before step 2 loses nothing: the block was decided by the network and will be fetched by block sync, and the validator's own votes are protected by the signing guard of chapter 4. Dying between 2 and 3 is the case `replayToApp` handles. Dying after 3 is a clean state. `DESIGN.md` section 2 calls this the "crash recovery handshake" and section 4 confirms the order. The application's `info()` is the handshake: it reports the height and hash it last committed.

### Retention

A node need not keep every block. `RPC-SYNC-PROOFS.md` section 4.7 defines `retain.blocks`: after each commit, blocks below `lastHeight - blocks` are deleted, never below the newest snapshot height, so a node that joined by state sync and a node that serves snapshots both keep what they must, and never a block whose time is still within the evidence window of the last block, so evidence for it can still be checked against the validator set and time of its height. A node that joined by state sync holds something lighter below its lowest block: the headers of the heights the evidence window could still name, fetched at the join ([chapter 7](07-sync.md)) and kept without their blocks. They serve the same two lookups, the set a header names and its time, and they go the same way, once the window has moved past them. The executor's `prune` implements both, as `pruneBlocks` and `pruneHeaders`.

### One commit, end to end

Block 9 with three transactions is decided. `Consensus.decide` calls `applyBlock(block, commit)`. The executor queues it behind any apply in flight, then: checks the height is `lastHeight + 1`; builds a `FinalizeBlockRequest` with the three transactions, the proposer's address, the addresses of every validator whose signature is in block 9's `lastCommit` (the signers of block 8), and any evidence translated to `{ address, height }`; calls `app.finalizeBlock`, which returns the new app hash, three results and zero or more validator updates; computes the new chain state with `nextState` (height 9, block 9's hash and time, the app hash, the results root, the three sets shifted); saves, in one store transaction, the block with its commit and results, the new `nextValidators` set by hash and by height 11, and the state; calls `app.commit`; swaps in the new state; prunes; marks the evidence committed; logs; removes the three transactions from the mempool and rechecks the rest; and calls the committed listeners, which in the node broadcast a `status` message with the new height and refresh the evidence age from the staking parameters. Consensus then stores a fuller commit if more precommits came in, waits `commitMs`, and starts height 10 with the chain state the executor just published.

## The code, file by file

Dependency order: `src/app/types.ts` has no dependencies beyond types; `src/app/kvstore.ts` implements it; `src/mempool.ts` depends on the interface; `src/node/executor.ts` depends on all three plus the store and consensus's `StaleHeightError`.

### src/app/types.ts

The file header gives the call order and should be kept in mind when reading the executor:

```ts
 * Call order during normal operation:
 *   initChain       once, on a fresh data directory
 *   checkTx         for every transaction entering the mempool, and again
 *                   for everything still pending after each commit
 *   finalizeBlock   once per committed block, with all its transactions
 *   commit          immediately after, to persist
 *   info            on startup, so consensus can replay blocks the app missed
```

Every exported symbol:

- **`CheckTxResult`**: `{ ok: boolean; error?: string }`. The mempool stores the transaction only if `ok`, and returns `error` to the submitter.
- **`TxResult`**: the same shape, one per transaction in a block. The executor hashes these into the results root (`resultsRoot` in `src/types/txproof.ts`, which encodes each as `u8 ok, string error`) and stores them with the block so the RPC can serve result proofs.
- **`Misbehavior`**: `{ address: Uint8Array; height: bigint }`, "A validator proven to have double-signed, for the app to slash." The executor resolves evidence to this form so the application never parses votes.
- **`FinalizeBlockRequest`**: `height`, `time` (the proposer's block time, the application's only clock), `txs`, `proposerAddress`, `lastCommitSigners` ("Addresses whose precommits were included in this block's lastCommit. For rewards.") and `misbehavior`. Compare ABCI's `RequestFinalizeBlock`, which carries the same information as `decided_last_commit` and `misbehavior`.
- **`FinalizeBlockResult`**: `appHash`, `txResults` (same length and order as `txs`), `validatorUpdates` (`ValidatorUpdate` from chapter 3: public key and power, power 0 removes).
- **`InitChainResult`**: `appHash` and optional `validators`; "If non-empty, replaces the genesis validator set." This is `STAKING.md` section 2.3: the core application derives the set from its own genesis (operators, consensus keys, self-bonds), and the engine's `Genesis.validators` is optional.
- **`Application`**: the five methods, all async. `info()` returns `{ lastHeight, lastAppHash }`.

Compare with the sketch in `DESIGN.md` section 2, where `initChain` returned a `ValidatorSet` and `finalizeBlock` took the whole `Block`. The implemented interface hands the application a request it can consume without knowing the block format, and lets `initChain` decline to supply validators.

### src/app/kvstore.ts

`KvStoreApp` is "a deliberately trivial application used to exercise the engine". Its transaction grammar is UTF-8 text: `key=value` sets a key; `val:<hex public key>:<n>` sets a validator's power to `n`, with 0 removing it. It keeps two maps, `committed` and `working`, a `lastHeight`, a `lastAppHash`, a `validators` map (public key to power) of the set as the application knows it, seeded from the genesis list in `initChain` and updated on every `commit`, the `pendingUpdates` of the block in progress, an optional JSON snapshot `file`, and a public `slashed` list of every `Misbehavior` it was given, which the evidence tests read.

The app hash:

```ts
  private hashOf(m: Map<string, string>): Uint8Array {
    const entries = [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return sha256(
      encode((w) =>
        w.array(entries, (w, [k, v]) => {
          w.string(k);
          w.string(v);
        }),
      ),
    );
  }
```

Sorted entries through the deterministic codec, then `sha256`: every node that applied the same blocks reports the same hash, whatever order the keys were inserted in. The initial hash is `sha256` of nothing.

`parse(tx)` decodes with `TextDecoder('utf-8', { fatal: true })` so invalid UTF-8 is an error rather than replacement characters, then recognises the two forms and validates the public key with `isPublicKey` (a known scheme tag followed by exactly that scheme's key, [chapter 2](02-crypto.md)) and that the power is decimal digits. `checkTx` is `parse` and nothing more: it is stateless, so the post-commit recheck can never evict anything for this application. `initChain` loads `genesis.appState` as a JSON object of string keys into `committed`, persists, and returns the app hash with no validators (the engine uses the genesis list). `finalizeBlock`:

```ts
  async finalizeBlock(req: FinalizeBlockRequest): Promise<FinalizeBlockResult> {
    this.working = new Map(this.committed);
    for (const m of req.misbehavior) this.slashed.push(m);
    // One update per key per block (the last wins), and a removal only of a validator the set has.
    const updates = new Map<string, ValidatorUpdate>();
    const txResults = req.txs.map((tx) => {
      const p = this.parse(tx);
      if (p.kind === 'bad') return { ok: false, error: p.error };
      if (p.kind === 'set') {
        this.working.set(p.key, p.value);
        return { ok: true };
      }
      const k = toHex(p.update.publicKey);
      const known = this.validators.has(k) || (updates.get(k)?.power ?? 0n) > 0n;
      if (p.update.power === 0n && !known) return { ok: false, error: 'unknown validator' };
      updates.set(k, p.update);
      return { ok: true };
    });
    this.pendingUpdates = [...updates.values()];
    this.working.set('__height', req.height.toString());
    this.lastHeight = req.height;
    return { appHash: this.hashOf(this.working), txResults, validatorUpdates: this.pendingUpdates };
  }
```

Even a toy application has to respect what `applyUpdates` in chapter 3 demands of the update list, or the executor throws while applying a decided block and consensus halts. Two `val:` transactions for one key in a block would be a duplicate address in the updates, so they are coalesced in a map and the last one wins; and a removal (`power 0`) of a validator the set does not hold would be `'cannot remove unknown validator'`, so it is refused as a failed transaction instead, where "known" means in the application's `validators` map or added by an earlier transaction of the same block. A transaction is the right place for that refusal: it is the sender's mistake, and a failed result is what a mistake costs.

The working copy starts as a copy of the committed map, so a block's effects are invisible until `commit()` promotes `working` to `committed`, applies the pending updates to the `validators` map, recomputes the hash and persists. Writing `__height` means the app hash changes every block even when the block is empty, which gives the tests a hash that moves. `lastHeight` is set in `finalizeBlock`, before `commit`, so `info()` between the two would report the new height with the old hash; the executor only calls `info()` at startup, after a restart, when the two are consistent again because `persist()` runs in `commit`. `persist()` writes `{ height, entries }` as JSON through `writeAtomic` from `src/store/files.ts` (temp file, fsync, rename), so a crash mid-write leaves the old snapshot rather than a torn one. This is the toy; the core application of chapter 11 persists through LMDB. `get(key)` reads the committed map and is what the tests use to observe that a transaction landed.

### src/mempool.ts

**`MempoolOptions`**: `maxTxs` (10 000), `maxTxBytes` (1 MiB), `cacheSize` (100 000 hashes). **`AddTxStatus`** is `'added' | 'seen' | 'invalid' | 'full' | 'too-large' | 'paused'` and **`AddTxResult`** carries the status, the hash, and the application's error for `invalid` or, for `paused`, the reason the pool is not admitting. The RPC's `broadcast` methods and `Node.submitTx` return this result to the client.

**`Mempool`** extends `EventEmitter` with one typed event, `tx: [hash, tx, source]`, emitted on every admission; `Node.init` listens and broadcasts an inventory announcement to every peer except `source`, the peer the transaction came from. State: `txs`, a `Map` from hex hash to bytes whose insertion order is the FIFO order; `cache`, a `Set` of hex hashes; `cacheOrder`, the array that lets the cache evict its oldest entry; `pausedReason`, null while the pool admits and otherwise the reason it does not.

- `size`: pending count.
- `has(hash)`: in the pool.
- `seen(hash)`: in the cache, which includes everything in the pool and everything recently rejected or committed; the node's inventory handler fetches only hashes that are not seen.
- `get(hash)`: the bytes, for serving a peer's fetch.
- `remember(key)` (private): add to the cache and evict from the front past `cacheSize`.

Admission can be suspended as a whole. The node pauses the pool while it sheds load under memory pressure ([chapter 8](08-node.md)) and resumes it when the heap eases; what is pooled stays, is still reaped by the proposer and still rechecked after each commit, so a validator keeps producing blocks from what it already holds, and only new admissions are refused:

```ts
  /** While paused nothing new is admitted (the node is shedding load); what is pooled stays and is still reaped. */
  get paused(): boolean {
    return this.pausedReason !== null;
  }

  pause(reason: string): void {
    this.pausedReason = reason;
  }

  resume(): void {
    this.pausedReason = null;
  }
```

```ts
  async addTx(tx: Uint8Array, source: string | null = null): Promise<AddTxResult> {
    const hash = txHash(tx);
    const key = toHex(hash);
    if (this.pausedReason !== null) return { status: 'paused', hash, error: this.pausedReason };
    if (tx.length > this.opts.maxTxBytes) return { status: 'too-large', hash };
    if (this.cache.has(key)) return { status: 'seen', hash };
    if (this.txs.size >= this.opts.maxTxs) return { status: 'full', hash };
    // Mark before the await so a concurrent duplicate is not checked twice.
    this.remember(key);
    let res: Awaited<ReturnType<Application['checkTx']>>;
    try {
      res = await this.app.checkTx(tx);
    } catch (e) {
      this.cache.delete(key); // nothing was decided about it; the next submission checks again
      throw e;
    }
    if (!res.ok) return { status: 'invalid', hash, error: res.error };
    if (this.txs.size >= this.opts.maxTxs) {
      this.cache.delete(key); // the pool filled while we checked; let the sender try again rather than hear "seen"
      return { status: 'full', hash };
    }
    this.txs.set(key, tx);
    this.emit('tx', hash, tx, source);
    return { status: 'added', hash };
  }
```

Order of the checks: paused first, before anything else, so a pool that is not admitting does no work at all and leaves no trace in the cache, and the reason travels back in `error` (the RPC turns it into `-32004`, [chapter 12](12-rpc.md)); then size (cheapest, and a huge transaction must not even be hashed into the cache), seen, full, then the application. The hash is cached *before* the await so that a second copy arriving while `checkTx` runs is answered `seen` rather than checked again; that also means an `invalid` transaction stays in the cache and is not re-checked when a peer announces it again. A `checkTx` that *throws* (the verifier pool closed underneath it, say) decided nothing, so the `catch` removes the hash from the cache before rethrowing; otherwise the transaction would be `seen` on this node for as long as the cache remembered it without ever having been judged, and a client resubmitting a perfectly good transaction would be told it was already known. The second `full` check, after the await, covers the pool filling while this transaction was being checked; because the hash was already cached, that refusal deletes it again, so a resubmission hears `full` (and `added` once there is room) rather than `seen` (review finding 38).

```ts
  /** Take transactions in FIFO order up to a byte budget. They stay in the pool until committed. */
  reap(maxBytes: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    let used = 0;
    for (const tx of this.txs.values()) {
      const cost = tx.length + 4;
      if (used + cost > maxBytes) break;
      out.push(tx);
      used += cost;
    }
    return out;
  }
```

`Consensus.createBlock` calls this with the byte budget left after the block's fixed parts. The `+ 4` is the codec's length prefix per `bytes` element; the array's own count prefix fits in the 1 KiB slack consensus subtracts. Reaping does not remove: the proposal may fail, and the transactions must still be there for the next proposer. The loop breaks at the first transaction that does not fit rather than skipping it, which keeps strict FIFO at the cost of a partially filled block when a large transaction is at the head.

```ts
  /** Called after a block commits: drop what was included, re-check what remains. */
  async update(committed: Uint8Array[]): Promise<void> {
    for (const tx of committed) this.txs.delete(toHex(txHash(tx)));
    for (const [key, tx] of [...this.txs]) {
      const res = await this.app.checkTx(tx);
      if (!res.ok) this.txs.delete(key);
    }
  }
```

The executor calls this with the block's transactions after `app.commit`. Committed transactions leave the pool but stay in the seen cache, so a re-gossiped copy is ignored. The recheck is one `checkTx` per remaining transaction, sequential, on the commit path; the executor awaits it before notifying its listeners. `DESIGN.md` section 2: "Without this the proposer would fill blocks with dead transactions." `list()` returns the contents in FIFO order for tests and status.

There is no expiry by time or height in the mempool itself; a transaction that stays valid forever stays pending forever. The core application gives transactions an expiration and `checkTx` rejects expired ones, so the recheck evicts them (chapter 11).

### src/node/executor.ts

**`ExecutorDeps`**: `app`, `store` (a `BlockStore`, chapter 10), `mempool`, `evidencePool`, `log`, optional `retainBlocks` ("Keep only this many blocks behind the latest; undefined keeps all"), `protectedHeight` ("A height that pruning must not pass (the newest snapshot)") and `evidenceAgeMs` (how old evidence may be; pruning keeps every block the window can still name and drops the headers kept alone once it has passed them). The node supplies the core application's newest snapshot height and `() => limits.maxEvidenceAgeMs`, the same limit consensus reads.

**`BlockExecutor`** has a public `state: ChainState`, the chain's view between blocks, read by consensus (`getState`) and the node (`height`). The constructor is private; instances come from `open`.

```ts
  static async open(deps: ExecutorDeps, genesis: Genesis): Promise<BlockExecutor> {
    let state = deps.store.loadState();
    if (!state) {
      const init = await deps.app.initChain(genesis);
      state = genesisState(genesis, init.appHash, init.validators);
      deps.store.saveValidatorSet(state.validators);
      deps.store.saveValidatorSet(state.nextValidators);
      deps.store.saveValidatorsAt(1n, state.validators);
      deps.store.saveValidatorsAt(2n, state.nextValidators);
      deps.store.saveState(state);
      deps.log('info', 'initialised from genesis', { chainId: state.chainId, validators: state.validators.size });
    } else if (state.chainId !== genesis.chainId) {
      throw new Error(`data directory is for chain ${state.chainId}, genesis is for ${genesis.chainId}`);
    }
    const exec = new BlockExecutor(deps, state);
    await exec.replayToApp();
    return exec;
  }
```

A fresh data directory runs `initChain` and builds genesis state (chapter 3's `genesisState`, which takes the application's validators if it supplied any). Validator sets are saved twice: by hash, because headers name sets by hash and evidence verification looks them up that way, and by the height they sign *with their proposer priorities*, because a node joining by state sync must continue consensus with the exact priorities (`RPC-SYNC-PROOFS.md`, settled during implementation). An existing directory for another chain is refused. Then `replayToApp` reconciles the application.

- `onCommitted(fn)`: register a listener for `(block, commit, results, updates)`; the node (`src/node/node.ts`) and the RPC event streams (`src/rpc/events.ts`) hang off this.
- `getLastCommit()`: the stored commit of `lastHeight`, or null at genesis. Consensus builds the next block's `lastCommit` from it; because `updateCommit` rewrites the stored commit, this is where late precommits reach the next block.
- `headerAt(h)`: the header of a height, from the stored block, or from the header record a state-synced node keeps below its lowest block (`loadHeader`, [chapter 10](10-store.md)). Null when the node holds neither.
- `validatorSetAtHeight(h)`: "The set that signs (or signed) height h": `validators` for `lastHeight + 1`, `nextValidators` for `lastHeight + 2`, `lastValidators` for `lastHeight`, and for anything older the `validatorsHash` of `headerAt(h)` resolved through the store. Returns null for a height whose header is gone. Consensus uses it for evidence; the node for gossiped evidence; the tests to find a validator's index at a past height.

```ts
  /** The header of a height: from the stored block, or kept alone below the lowest block a state-synced node holds. */
  headerAt(h: bigint): Header | null {
    return this.d.store.loadBlock(h)?.block.header ?? this.d.store.loadHeader(h);
  }

  /** The set that signs (or signed) height h. */
  validatorSetAtHeight(h: bigint): ValidatorSet | null {
    const s = this.state;
    if (h === s.lastHeight + 1n) return s.validators;
    if (h === s.lastHeight + 2n) return s.nextValidators;
    if (h === s.lastHeight) return s.lastValidators;
    const header = this.headerAt(h);
    if (!header) return null;
    return this.d.store.loadValidatorSet(header.validatorsHash);
  }
```

Both lookups go through `headerAt`, so a node that joined from a snapshot answers for the heights below its join for as long as it holds their headers, which is what lets it apply a block carrying evidence of a double sign from before the join.

```ts
  applyBlock(block: Block, commit: Commit): Promise<void> {
    const run = this.chain.then(() => this.doApply(block, commit));
    this.chain = run.catch(() => {});
    return run;
  }

  /** Resolves once every block handed to applyBlock so far has finished, so a store can be closed safely. */
  idle(): Promise<void> {
    return this.chain.then(() => undefined);
  }
```

Consensus and block sync both call this, possibly for the same height. The promise chain serialises every apply; the caller gets the real promise (and its rejection), while the chain itself swallows failures so one bad block does not block every later apply. `doApply` begins with the height check that produces `StaleHeightError` for the loser. `idle()` is the tail of that chain as a promise: it settles once every block handed over so far has finished, which is what `Node.stop` awaits before closing the stores, so a block half way through its store batch or `app.commit` is never cut off by the environment closing under it.

```ts
  updateCommit(height: bigint, commit: Commit): void {
    if (height !== this.state.lastHeight) return;
    const stored = this.d.store.loadBlock(height);
    if (!stored || !bytesEqual(stored.commit.blockHash, commit.blockHash)) return;
    const count = (c: Commit) => c.signatures.filter((s) => s !== null).length;
    if (count(commit) <= count(stored.commit)) return;
    this.d.store.saveBlock(stored.block, commit);
    this.d.log('debug', 'commit updated with late precommits', { h: height, signatures: count(commit) });
  }
```

Only the last applied height, only for the same block hash, only if the new commit has more signatures. `saveBlock` is called without results, which the store treats as "leave the results and transaction index alone" (`results !== undefined` in `src/store/blockstore.ts`). The height check is why consensus calls this once more after `applyBlock` resolves (chapter 4, review finding 21).

`blockTimeAt(height)`: `lastBlockTime` for the last height, else the time of `headerAt(height)`, else null. This is the `BlockTimeLookup` for evidence age, for consensus and for block sync alike.

`buildRequest(block)` (private) turns a block into a `FinalizeBlockRequest`: `lastCommitSigners` are the addresses at the non-null indices of `block.lastCommit.signatures` in the set that signed `h - 1` (`STAKING.md` section 9 notes that the application simply skips a signer removed since); `misbehavior` resolves each evidence item's `validatorIndex` through the set of its height:

```ts
    const misbehavior: Misbehavior[] = [];
    for (const ev of block.evidence) {
      // Every node must hand the application the same offender, so a set this node cannot find is a halt with a
      // reason, never a silent omission that would leave it computing a different state from everyone else.
      const set = this.validatorSetAtHeight(ev.voteA.height);
      if (!set) throw new Error(`block ${h} carries evidence for height ${ev.voteA.height}, whose validator set this node does not hold; its history does not reach that far`);
      const val = set.byIndex(ev.voteA.validatorIndex);
      if (!val) throw new Error(`block ${h} carries evidence naming validator ${ev.voteA.validatorIndex}, outside the set of height ${ev.voteA.height}`);
      misbehavior.push({ address: val.address, height: ev.voteA.height });
    }
```

Evidence this node cannot place, because it holds neither the block nor the header of that height, or because the index is outside the set, is a thrown error, not a skipped entry. An earlier version skipped it, which looks forgiving and is the opposite: every other node resolves that evidence and hands its application a slash, so a node that quietly handed over one offender fewer would compute a different app hash from the same block, and the next block's `appHash` would then be refused as if the node had a bug, with nothing in the log to say why. A decided block is valid by definition, so evidence in it that this node cannot check means this node's history is too short, which is a condition to stop on with a reason rather than diverge on in silence. With the header walk of chapter 7 a state-synced node holds every header the evidence window can name, so in normal operation the case does not arise.

```ts
  private async doApply(block: Block, commit: Commit): Promise<void> {
    const h = block.header.height;
    if (h !== this.state.lastHeight + 1n) throw new StaleHeightError(`block ${h} but state is at ${this.state.lastHeight}`);

    const res = await this.d.app.finalizeBlock(this.buildRequest(block));
    const failed = res.txResults.filter((r) => !r.ok).length;
    const newState = nextState(this.state, block, res.validatorUpdates, res.appHash, resultsRoot(res.txResults));

    // Block, commit, results, the next set and the new state land together or not at all.
    this.d.store.batch(() => {
      this.d.store.saveBlock(block, commit, res.txResults);
      this.d.store.saveValidatorSet(newState.nextValidators);
      this.d.store.saveValidatorsAt(h + 2n, newState.nextValidators);
      this.d.store.saveState(newState);
    });
    await this.d.app.commit();

    this.state = newState;
    this.prune();
    this.d.evidencePool.markCommitted(block.evidence);
    this.d.log('info', 'committed', {
      h,
      hash: blockHash(block),
      txs: block.txs.length,
      failed,
      evidence: block.evidence.length,
      appHash: res.appHash,
      valUpdates: res.validatorUpdates.length,
    });
    await this.d.mempool.update(block.txs);
    for (const fn of this.committedListeners) fn(block, commit, res.txResults, res.validatorUpdates);
  }
```

This is the persistence order from the file header. `nextState` (chapter 3) applies the updates to `nextValidators` to get the set for `h + 2`, increments its proposer priority once, and shifts the three sets down: the block's validators become `lastValidators`, `nextValidators` becomes `validators`. The new `h + 2` set is saved by hash and by height. the end of the batch is the moment the chain officially advances; `app.commit()` follows; `this.state` is replaced only after both, so a caller that reads `state` during the apply still sees the old height (block sync relies on this: it reads `getState().lastHeight` to decide what block to apply next). Then pruning, evidence bookkeeping, the mempool update, and the listeners. The executor does not check `res.appHash` against anything here; the check is social, by every other validator at the next proposal, and local, on replay.

The four saves run inside `store.batch`, one store transaction: `KvBlockStore.batch` opens a single `kv.write` and every save called inside it joins that writer instead of opening its own ([chapter 10](10-store.md) documents the method). This is what `DESIGN.md` section 4 promises ("save block + commit + new chain state (one transaction)") and what review finding 39 restored: before it, a crash between four separate writes could leave a block and its transaction index entries without the state that goes with them.

```ts
  private prune(): void {
    const age = this.d.evidenceAgeMs?.();
    // The time before which evidence can no longer name a height, as of the latest block.
    const oldest = age === undefined ? null : this.state.lastBlockTime - age;
    this.pruneBlocks(oldest);
    this.pruneHeaders(oldest);
  }

  /** Drop blocks older than the retention window, never past the newest snapshot nor into the evidence window. */
  private pruneBlocks(oldest: bigint | null): void {
    const keep = this.d.retainBlocks;
    if (keep === undefined) return;
    let floor = this.state.lastHeight - BigInt(keep);
    const protect = this.d.protectedHeight?.() ?? 0n;
    if (protect > 0n && protect < floor) floor = protect;
    const lowest = this.d.store.lowestHeight();
    if (floor <= lowest) return;
    if (oldest !== null) {
      // Walk down from the proposed floor until the block below it is older than evidence may be.
      while (floor > lowest && (this.d.store.loadBlock(floor - 1n)?.block.header.time ?? 0n) >= oldest) floor--;
      if (floor <= lowest) return;
    }
    for (let h = lowest; h < floor; h++) this.d.store.deleteBlock(h);
    this.d.store.setLowestHeight(floor);
    this.d.log('debug', 'pruned blocks', { below: floor });
  }

  /** Headers kept alone below the lowest block serve evidence checks; once older than evidence may be, they go too. */
  private pruneHeaders(oldest: bigint | null): void {
    if (oldest === null) return;
    const lowest = this.d.store.lowestHeaderHeight();
    if (lowest === null) return;
    const top = this.d.store.lowestHeight();
    let h = lowest;
    // A record that is missing (the block backfill replaced it) is passed over like one that has aged out.
    while (h < top && (this.d.store.loadHeader(h)?.time ?? oldest - 1n) < oldest) this.d.store.deleteHeader(h++);
    if (h === lowest) return;
    this.d.store.setLowestHeaderHeight(h < top ? h : null);
    this.d.log('debug', 'pruned headers', { below: h });
  }
```

`prune` computes `oldest`, the block time before which evidence can no longer name a height (`lastBlockTime - evidenceAgeMs`, or null when no age is configured), and hands it to the two halves. In `pruneBlocks` the floor is `lastHeight - retainBlocks`, lowered to the newest snapshot height if that is older, and then lowered again, one block at a time, while the block just below it is younger than `oldest`. `deleteBlock` removes the block, its commit, its results and its transaction index entries (`RPC-SYNC-PROOFS.md` section 4.7). Validator sets by hash are never pruned. `pruneHeaders` is guarded by the age alone, not by `retainBlocks`: it walks up from the lowest header record towards the lowest block, deleting each record older than `oldest`, passes over a record that is already missing (block sync's backfill deletes the record of every height it fills in), and then moves the marker to the first record it kept, or clears it when none is left below the lowest block. A pruned height makes `validatorSetAtHeight` and `blockTimeAt` return null, so evidence for it is rejected as "evidence for an unknown height" (chapter 4). That is exactly why the evidence window is kept: evidence is accepted for as long as `maxEvidenceAgeMs` (the unbonding period, once the application has set it) says it may be, and checking it needs the validator set and the block time of the height it names, both of which come from the stored block or header. A node that pruned inside the window would refuse valid evidence that every other node accepts, and would then reject the block that carries it. So `retain.blocks` is a floor only outside the evidence window; with the default seven-day age a short test chain never prunes at all, which is why `test/sync.test.ts`'s pruning node passes `limits: { maxEvidenceAgeMs: 0n }`, and why `test/review2.test.ts`, "keeps blocks the evidence window may still name, whatever the retention setting", gives a node `retain: { blocks: 2 }` and expects `lowestHeight()` to stay at 1.

```ts
  /** Crash recovery: the app may be behind the chain state. */
  private async replayToApp(): Promise<void> {
    const info = await this.d.app.info();
    if (info.lastHeight > this.state.lastHeight) {
      throw new Error(`app is at height ${info.lastHeight}, ahead of chain state ${this.state.lastHeight}; data is inconsistent`);
    }
    if (info.lastHeight === this.state.lastHeight) {
      if (!bytesEqual(info.lastAppHash, this.state.appHash)) throw new Error('app hash does not match chain state');
      return;
    }
    for (let h = info.lastHeight + 1n; h <= this.state.lastHeight; h++) {
      const stored = this.d.store.loadBlock(h);
      if (!stored) throw new Error(`missing block ${h} needed for replay`);
      const res = await this.d.app.finalizeBlock(this.buildRequest(stored.block));
      const expected = h === this.state.lastHeight ? this.state.appHash : this.d.store.loadBlock(h + 1n)!.block.header.appHash;
      if (!bytesEqual(res.appHash, expected)) {
        throw new Error(`replay of block ${h} produced app hash ${toHex(res.appHash)}, expected ${toHex(expected)}`);
      }
      await this.d.app.commit();
      this.d.log('info', 'replayed block to app', { h });
    }
  }
```

Three cases. The application ahead of the chain is impossible under the persistence order and means the data directory was tampered with or mixed: refuse. Equal heights must have equal hashes: refuse otherwise, because a node whose application disagrees with its own chain state would vote for blocks nobody else accepts. Behind: replay each missing block from the store through `finalizeBlock` and `commit`, checking each resulting app hash against the value the chain committed to (the next header's `appHash`, or chain state for the last one). Under the normal persistence order the gap is at most one block; the loop handles any gap the store can serve. The mempool and evidence pool are not touched during replay: both start empty at process start.

## How it is tested

`test/units.test.ts`, "mempool dedupes, rejects invalid, reaps FIFO, and drops committed transactions": with `maxTxBytes: 64` and the key-value application, `a=1` is `added`, a second `a=1` is `seen`, `bad` (no `=`) is `invalid`, 100 zero bytes are `too-large`, `b=2` is `added`; `reap` with a large budget returns `[a=1, b=2]` in order and with a budget of 8 bytes returns one (`a=1` costs 3 + 4 = 7; adding `b=2` would exceed 8); `update([a=1])` leaves one.

`test/consensus.test.ts`:

- "transactions gossip to every node and land in state": `submitTx` returns `added`, every node's `KvStoreApp.get('hello')` becomes `'world'`, and `no-equals-sign` is `invalid`. This covers admission, the `tx` event into inventory gossip, reaping, `finalizeBlock` and `commit` on every node.
- "adds a validator through the application and it starts signing" and "removes a validator and the set shrinks": `val:` transactions produce validator updates that `nextState` applies, visible in `executor.state.validators.size` and in the commit signature count two heights later. These are the H+2 tests.
- "a late-joining full node catches up through block sync": block sync drives `applyBlock` for a node that was never in consensus; `StaleHeightError` protects the hand-over to live consensus.

`test/recovery.test.ts`, "a validator restarted from disk resumes with its state, key guard and app intact": after a stop and a rebuild from the same data directory, `height` equals the stopped height and the application still holds the key written before the stop; `open` found the store's state and `replayToApp` found the application at the same height. "double-sign evidence is built, included in a block, and handed to the app" checks `buildRequest`'s `misbehavior` translation: every `KvStoreApp.slashed` entry carries the victim's address and the infraction height, and `markCommitted` empties the pool.

`test/engine.test.ts`:

- "folds a precommit that arrives after the decision into the stored commit": `updateCommit` replaces the stored commit and `getLastCommit` serves the fuller one.
- "rejects a block from another protocol version": incidentally asserts that `header.lastResultsHash` is 32 bytes, the results root the executor computes.
- "refuses a genesis with no validators from either side": `genesisState` with neither an engine list nor application validators throws, the path `open` would take on a bad genesis.

`test/sync.test.ts`, "catches up a node that missed many blocks by batched requests across peers, and prunes behind a retention window": a node with `retain: { blocks: 10 }` and `limits: { maxEvidenceAgeMs: 0n }` (so the evidence window keeps nothing) ends with `store.lowestHeight() >= height - 10`, the block below the lowest absent and the lowest present. This is `pruneBlocks`. "fetches at a join only the headers evidence may still name, and lets them go as the window moves on": a node joined by state sync with `limits: { maxEvidenceAgeMs: 1500n }` holds only header records within that window of its join height, and once the chain's time has moved a window past the join, `lowestHeaderHeight()` is null and the record below the join is gone. This is `pruneHeaders`.

`test/chain.test.ts` (the core application on a live network): "A transaction signed by the wrong key never enters the mempool" shows `checkTx` doing real work; `submitTx` of a forged transfer returns `invalid`.

`test/review.test.ts`, "keeps per-block results so a repeated transaction proves its real outcome at each position": the `results` array the executor passes to `saveBlock` is stored per block, and a transaction repeated within a block owns its index entry at its first position (review finding 18). "does not remember a transaction it refused because the pool filled while checking it": with `maxTxs: 1` and a `checkTx` held open by a gate, two transactions are admitted concurrently; the first is `added`, the second `full`, resubmitting the second is `full` again rather than `seen`, and after `update` removes the first it is `added` (finding 38). "saves everything a height needs to the block store in one transaction": a counting `MemoryKv` sees one `write` for a `batch` of three saves and a second for a save outside it (finding 39; `doApply` is the batch's caller). "checks a transaction again after a check that threw, instead of calling it seen": an application whose first `checkTx` throws makes `addTx` reject, and the same bytes submitted again are checked and `added` rather than answered `seen`.

`test/memory.test.ts`, "sheds load, keeps following the chain, and resumes when the heap eases": a node whose memory guard is fed a heap at 90% of its limit has `mempool.paused` true and `submitTx` answering `paused`; at 50% the pool is resumed and the same transaction is `added`. The pause is the node's doing (chapter 8); the pool only honours it.

## Limitations and ideas

- FIFO only: no fee priority, no per-sender ordering, no replacement of a pending transaction by a better-paid one. A large transaction at the head of the queue that does not fit the remaining budget stops the reap.
- No expiry in the mempool itself; eviction depends on the application's `checkTx` saying no after a commit.
- The post-commit recheck is sequential and runs inside `doApply`, so a 10 000-transaction pool adds 10 000 `checkTx` calls to the commit path before the listeners (and the `status` broadcast) run.
- No `PrepareProposal` or `ProcessProposal`: the application cannot reorder, drop or veto transactions in a proposal; it sees them when decided and can only mark them failed.
- Validator sets by hash are kept forever; pruning covers blocks, results, the transaction index and the headers kept alone below the lowest block.
- The pool is bounded by count, not bytes: 10 000 transactions of up to 1 MiB each is the ceiling, and under memory pressure the node pauses admission rather than trimming what is pooled.

Exercises:

1. Add a `maxAge` in blocks to `Mempool`: record the height at admission, and in `update` drop transactions older than the limit before rechecking. Write a unit test with a stateless application that proves age alone evicts.
2. Make `reap` skip, rather than stop at, a transaction that does not fit, and measure block fill on the four-validator benchmark with mixed transaction sizes.
3. Move the recheck off the commit path: run `update`'s recheck after the listeners, or in batches between blocks, and show with a timer that `applyBlock` resolves sooner.
4. Make `prune` also drop validator sets stored by hash that no retained header names, and prove with a test that `validatorSetAtHeight` still answers for every retained height and that evidence for a pruned one is refused.
5. Write a crash test: an `Application` wrapper whose `commit()` throws once; restart the executor on the same store and assert that `replayToApp` replays exactly one block and that the app hash check passes. Then corrupt the stored block and assert it refuses.
6. Implement a `ProcessProposal`-style hook: add an optional `checkBlock(req)` to `Application`, call it from `Consensus.handleProposal` before marking a proposal valid, and have the key-value application reject blocks containing a transaction it would fail.

## Where to next

[Chapter 6, p2p](06-p2p.md): the transport, handshake and gossip that carry the proposals, votes, transaction and evidence announcements this chapter and the last one produce.
