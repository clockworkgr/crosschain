# 8. The node

A node is the consensus engine, the mempool, the network, block sync, state sync, the block store and one application, wired together in one object. `src/node/node.ts` constructs each piece from the chapters before ([consensus](04-consensus.md), [mempool and executor](05-mempool-executor.md), [p2p](06-p2p.md), [sync](07-sync.md), the [store](10-store.md) and the [application](11-application.md)) and connects them with closures: consensus is given functions to apply a block and to broadcast a vote, block sync is given functions to read state and to restart consensus, and the network is given handlers for every message type. It also decides the gossip policy (what is pushed, what is announced by hash, what is sent to a peer that just connected) and exposes the queries the [RPC](12-rpc.md) serves. Validators and full nodes run the same code; a full node has no validator key. `scripts/localnet.ts` and `bench/network.bench.ts` show how to run a whole validator set in one process.

## Concepts

**Validator or full node.** `NodeConfig.validatorSeed` is either a 32-byte seed for the validator key or `null`. With a seed the node builds a `PrivValidator` (the signing guard of the consensus chapter) and votes; without one, consensus runs as an observer that validates proposals and counts votes but signs nothing. Everything else, networking, sync, serving blocks and snapshots, answering queries, is identical. DESIGN.md section 2 lists what the engine owns: "p2p networking, consensus message gossip, mempool, tx gossip, block sync, evidence pool, proposer selection"; the node is where those pieces meet the application through the in-process `Application` interface.

**Wiring by closures.** `Consensus` does not hold a `Node`; it holds a `ConsensusDeps` object of functions: `getState`, `applyBlock`, `broadcastVote`, `requestBlock`, `scorePeer`, and so on. `BlockSync` likewise. The node fills those with arrow functions that reach into its own fields. This keeps the modules free of cycles (consensus does not import the network, the network does not import consensus), makes each testable with fakes (`test/review.test.ts` builds a `BlockSync` on a fake network), and makes the wiring readable in one place: `Node.init`.

**Order of construction.** The network is built first and its request handlers for headers, validator sets and snapshots are installed before anything else, because a node serves those "whether or not we are caught up ourselves". State sync, if configured and the store is empty, runs next, before the application exists, because it writes the application store directly. Then the application, the mempool on it, the executor (which initialises from genesis or replays whatever the application missed), consensus, block sync, and finally the gossip handlers.

**Three gossip policies in one node.** Consensus messages are pushed straight through to every peer (`broadcastProposal`, `broadcastVote`), with no inventory round trip; a peer that connects in the middle of a height is handed everything held for that height, plus an announcement of any evidence still waiting for a block. Transactions and evidence use announce and fetch (`inv`, `fetch`, `item`, `itemNotFound`), with a seen-cache on each side so nothing loops. Committed blocks are announced by height in a `status` message after every commit, and pulled through block sync. DESIGN.md section 3 explains the split: inventory for items where a round trip is cheap, push where it would delay a consensus phase.

**Evidence from peers.** A duplicate-vote evidence record arriving by gossip is verified against the validator set of its height before it enters the pool (`acceptEvidence`), and a peer serving malformed or invalid evidence is charged 20 points. RPC-SYNC-PROOFS.md section 4.4: "Evidence becomes an inventory item kind next to transactions: announce by key, fetch, verify against the validator set at its height, add to the pool, pass on."

**Evidence age follows the unbonding period.** Evidence is accepted only for infractions younger than `maxEvidenceAgeMs` by block time (STAKING.md section 2.2). With staking, that limit must equal the unbonding period, or a validator could be punished after its stake was released, or escape punishment while still bonded. Finding 22 of REVIEW-2026-10-28.md noted that governance can change the unbonding period while the engine's limit stayed fixed; the node now re-reads `stakingParameters().unbondingPeriodMs` as soon as the executor has opened the application and again after every commit, and writes it into the shared `limits` object. This works because `Consensus` keeps a reference to that object and merges it with the defaults on every read (its private `limits` getter), rather than copying it once at construction.

**Fetching a block that was never proposed to us.** If a node sees +2/3 precommits for a block hash it never received a proposal for (the proposal was lost, or filtered), consensus asks for the block by height, and a `blockResponse` whose height is the current one is handed to `consensus.handleFetchedBlock`, which validates it like a proposal and decides. RPC-SYNC-PROOFS.md section 4.5 calls this "immediate block fetch"; it replaces falling a height behind and waiting for block sync.

**Storage.** With a `dataDir` the node opens one LMDB environment under `<dataDir>/lmdb` with a `chain` store (blocks, commits, state, validator sets, and the headers a state-synced node keeps below its lowest block) and an `app` store, and keeps the signing guard's state in `<dataDir>/priv_validator_state.bin` and the peer database in `<dataDir>/peers.json`. With `dataDir: null` everything is in memory, which is what every test and the localnet use. A caller may also pass its own `env`, in which case the node does not close it on `stop`.

**Queries for the RPC.** Because execution is deferred (the app hash of the state after block N is in header N+1), a proof about state at height N must be served with header N+1 and its commit. `queryState`, `queryTx` and `queryAccountName` package proofs that way so the light client can check them.

## The code, file by file

### src/node/node.ts

**`NodeConfig`**, field by field:

- `name`: for log lines.
- `genesis`: the `Genesis` document; its `chainId` becomes the node's.
- `dataDir`: a directory, or `null` for memory only.
- `nodeKeySeed`: seed of the p2p identity key.
- `validatorSeed`: seed of the consensus key, or `null` for a full node.
- `transport`, `listenAddr`, `advertiseAddr?`, `seeds?`: passed to the network and the peer database.
- `app?`: an `Application`. Default is `CoreApp` on the node's own store. Must be left out when state syncing, because state sync writes the application store before the application is built.
- `env?`: a `KvEnv`. Default is LMDB under `dataDir`, or `MemoryEnv`.
- `stateSync?`: `{ trustHeight, trustHash, backfill? }`.
- `retain?`: `{ blocks?, versions?, snapshots? }`: blocks kept behind the latest (all when unset), the provable version window of the database, snapshots kept.
- `snapshotInterval?`: export a snapshot every this many blocks; 0 disables.
- `verifier?`: a `Verifier`; default `InlineVerifier`. Tests share one inline verifier; the localnet and benchmarks share one `WorkerVerifier` across all nodes in the process.
- `timeouts?`, `limits?`: consensus timeouts and validation limits, partial overrides.
- `network?`: the subset `desiredOutbound`, `maxInbound`, `connectIntervalMs`, `pingIntervalMs`, `idleTimeoutMs` of `NetworkConfig`.
- `lagGraceMs?`: block sync's one-block grace.
- `log?`, `logLevel?`: a `Logger`, or a level for `makeLogger(name, level)`.

**`Node`** fields: `name`, `chainId`, `app`, `store` (a `KvBlockStore` on the env's `chain` store), `env`, `mempool`, `evidencePool`, `requester`, `joinedAt` (the snapshot height when the node state-synced, else `null`), `privValidator`, `nodeKey`, `verifier`, `log`, `executor`, `consensus`, `network`, `blockSync`. The fields marked with `!` are assigned in `init`.

#### `Node.create`

```ts
  static async create(cfg: NodeConfig): Promise<Node> {
    const node = new Node(cfg);
    await node.init();
    return node;
  }
```

The constructor is private and synchronous. It sets the logger (`cfg.log`, or `makeLogger(cfg.name, cfg.logLevel ?? 'info')`), the verifier (default inline), derives the node key from its seed, creates `dataDir` if given and locks it, opens the environment (`cfg.env`, else `LmdbEnv` under `<dataDir>/lmdb`, else `MemoryEnv`) and remembers whether the node owns it, opens the block store on the `chain` store, creates an empty `EvidencePool`, and builds the `PrivValidator` if there is a validator seed, with a `FileSignStateStore` on disk or a `MemorySignStateStore`:

```ts
    this.privValidator = cfg.validatorSeed
      ? new PrivValidator(
          keyPairFromSeed(cfg.validatorSeed),
          cfg.dataDir ? new FileSignStateStore(join(cfg.dataDir, 'priv_validator_state.bin')) : new MemorySignStateStore(),
          this.chainId,
        )
      : null;
```

The lock comes first, before the environment is opened, because "two nodes on one directory would share a signing guard that neither sees the other write": the double-sign guard of chapter 4 is a file, each process caches its last record in memory, and two validators on one directory would each believe it had signed nothing the other had, which is exactly the double signing the guard exists to prevent (and LMDB itself would not refuse the second opener). The module-level `lockDataDir` is the whole mechanism:

```ts
function lockDataDir(dir: string): () => void {
  const path = join(dir, 'LOCK');
  if (heldDirs.has(dir)) throw new Error(`data directory ${dir} is in use by this process`);
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    let alive = false;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    if (alive) throw new Error(`data directory ${dir} is in use by process ${pid}`);
  }
  writeFileSync(path, String(process.pid));
  heldDirs.add(dir);
  return () => {
    heldDirs.delete(dir);
    try {
      unlinkSync(path);
    } catch {
      // Already gone: nothing to release.
    }
  };
}
```

A `LOCK` file holds the PID of the process that claimed the directory. `process.kill(pid, 0)` sends no signal; it only asks whether the process exists, throwing `ESRCH` when it does not and `EPERM` when it does but belongs to another user, which is why `EPERM` counts as alive. A claim left by a process that no longer runs is taken over, so a crash never needs a manual cleanup, while a live claim is refused. The in-process `heldDirs` set covers what the PID check cannot: two `Node` objects in one process (the test harness does this on purpose), where the file would name this very process and the PID test would skip it. The returned function releases both, and `stop()` calls it. `test/review.test.ts`, `refuses a second node on a data directory that is in use`, builds a one-validator network on a temporary directory, asserts that a second `makeNode(0)` on it rejects with `/in use/`, and that the same call succeeds once the first node has stopped.

Everything asynchronous happens in `init`.

#### `init`, step by step

**1. Limits.** `DEFAULT_LIMITS`, overridden by `genesis.consensus.maxEvidenceAgeMs` if present, overridden by `cfg.limits`. This object is shared by reference with consensus, block sync and the executor's pruning, and mutated as soon as the application is open (step 7) and after every commit (step 11).

**2. The network.**

```ts
    this.network = new Network({
      chainId: this.chainId,
      nodeKey: this.nodeKey,
      transport: this.cfg.transport,
      listenAddr: this.cfg.listenAddr,
      advertiseAddr: this.cfg.advertiseAddr,
      peerDb: new PeerDb(this.cfg.dataDir ? join(this.cfg.dataDir, 'peers.json') : null, this.cfg.seeds ?? []),
      verifier: this.verifier,
      getHeight: () => this.executor?.state.lastHeight ?? 0n,
      log: this.log,
      ...this.cfg.network,
    });
    this.requester = new Requester(this.network);
```

`getHeight` is guarded with `?.` because the executor does not exist yet, and during state sync the network runs before it does: a joining node reports height 0 in its hello until the executor opens.

**3. Serving handlers that need no application.** Headers with commits, runs of headers without them, validator sets by hash, validator sets by height, snapshot heights, manifests and chunks:

```ts
    this.network.on('headerRequest', (peer, m) => {
      const stored = this.store.loadBlock(m.height);
      peer.send({ type: 'headerResponse', height: m.height, header: stored?.block.header ?? null, commit: stored?.commit ?? null });
    });
    this.network.on('headersRequest', (peer, m) => {
      // Downward from the height asked: block headers, or headers kept alone, as many consecutive ones as are held.
      const headers: Header[] = [];
      for (let h = m.height; h >= 1n && headers.length < Math.min(m.count, MAX_HEADERS); h--) {
        const header = this.store.loadBlock(h)?.block.header ?? this.store.loadHeader(h);
        if (!header) break;
        headers.push(header);
      }
      peer.send({ type: 'headersResponse', height: m.height, headers });
    });
    this.network.on('validatorSetRequest', (peer, m) => peer.send({ type: 'validatorSetResponse', hash: m.hash, set: this.store.loadValidatorSet(m.hash) }));
    this.network.on('validatorsRequest', (peer, m) => peer.send({ type: 'validatorsResponse', height: m.height, set: this.store.loadValidatorsAt(m.height) }));
    this.network.on('snapshotsRequest', (peer) => peer.send({ type: 'snapshotsResponse', heights: this.app instanceof CoreApp ? this.app.snapshotHeights() : [] }));
    this.network.on('manifestRequest', (peer, m) => peer.send({ type: 'manifestResponse', height: m.height, manifest: this.app instanceof CoreApp ? this.app.manifestBytes(m.height) : null }));
    this.network.on('chunkRequest', (peer, m) => peer.send({ type: 'chunkResponse', height: m.height, objectType: m.objectType, index: m.index, chunk: this.app instanceof CoreApp ? this.app.chunkBytes(m.height, m.objectType, m.index) : null }));
```

The headers handler walks downward from the height asked, taking a stored block's header or, below the lowest block of a node that itself joined by state sync, the header it kept alone, and stops at the first height it holds neither for, so the answer is always a consecutive run; `MAX_HEADERS` (1000) caps it whatever the asker's `count`. These headers go without commits: state sync binds each to the one above it by hash ([chapter 7](07-sync.md)), so a commit per header would be wasted bytes. The snapshot handlers check `this.app instanceof CoreApp` at call time, so a node on the key-value test app, or a node still state syncing (whose `app` is unset), answers with no snapshots rather than crashing. Block requests are served by `BlockSync`, constructed in step 9.

**4. State sync.** Only when configured and the chain store has no state (a fresh data directory):

```ts
    if (this.cfg.stateSync && !this.store.loadState()) {
      if (this.cfg.app) throw new Error('state sync needs the node to construct the application itself');
      await this.network.start();
      this.networkStarted = true;
      const joined = await stateSync({
        chainId: this.chainId,
        network: this.network,
        requester: this.requester,
        verifier: this.verifier,
        chainStore: this.store,
        appKv: this.env.store('app'),
        types: CORE_TYPES,
        retainVersions: this.cfg.retain?.versions,
        log: this.log,
        trustHeight: this.cfg.stateSync.trustHeight,
        trustHash: this.cfg.stateSync.trustHash,
        // The same age the node will hold blocks to: the operator's figure, else the unbonding period the imported state holds.
        evidenceAgeMs: (db) => this.cfg.limits?.maxEvidenceAgeMs ?? getGlobal(db).staking.unbondingPeriodMs,
        transaction: (fn) => this.env.transaction(fn),
      });
      if (joined) this.joinedAt = joined.height;
    }
```

The network is started early so peers can be found; `networkStarted` prevents `start()` from starting it twice. `evidenceAgeMs` tells state sync how far below the snapshot to fetch headers ([chapter 7](07-sync.md)): the operator's `limits.maxEvidenceAgeMs` if one was pinned, else the unbonding period held by the imported state, read through `getGlobal(db)` once the database exists, which is the figure the executor will prune by once the application is open (step 7). `transaction` is `env.transaction`, so the install's writes to the application store and the chain store land as one. A `null` result (no peers, no snapshots) falls through to a normal start from genesis. A thrown error propagates out of `Node.create`.

**5. The application.** `cfg.app` if given; otherwise a `CoreApp` on the env's `app` store. The genesis application state is parsed only if the store is empty (`CoreApp.hasState(kv)`), because a large genesis is streamed from its file once, at first start (DESIGN.md section 7). After state sync the store is not empty, so genesis is not parsed and the app opens at the snapshot height.

**6. The mempool.** `new Mempool(this.app)`: admission by `checkTx`, re-check after every commit.

**7. The executor.**

```ts
    this.executor = await BlockExecutor.open(
      {
        app: this.app,
        store: this.store,
        mempool: this.mempool,
        evidencePool: this.evidencePool,
        log: this.log,
        retainBlocks: this.cfg.retain?.blocks,
        protectedHeight: () => (this.app instanceof CoreApp ? (this.app.snapshotHeights().at(-1) ?? 0n) : 0n),
        evidenceAgeMs: () => limits.maxEvidenceAgeMs,
      },
      this.cfg.genesis,
    );
    // The evidence age follows the unbonding period the application holds now, not the one genesis had.
    if (this.app instanceof CoreApp && this.cfg.limits?.maxEvidenceAgeMs === undefined) limits.maxEvidenceAgeMs = this.app.stakingParameters().unbondingPeriodMs;
```

`open` loads the chain state or initialises it from genesis through `app.initChain`, refuses a data directory from another chain, and replays to the application any blocks it has not committed (crash recovery, [executor](05-mempool-executor.md)). `protectedHeight` keeps pruning from deleting the newest snapshot's block, so a snapshot can always be joined and then block-synced from (RPC-SYNC-PROOFS.md section 4.7, "never below the newest snapshot height"). `evidenceAgeMs` is a function that reads the shared `limits` object, so pruning keeps the blocks of exactly the evidence window consensus is enforcing, however that window changes. The line after `open` is the first of the two evidence-age refreshes: with the application open, its staking parameters say what the unbonding period is *now*, which after a governance change is not what genesis said, and a node that only refreshed on commit would check evidence and prune against the genesis value from restart until its first commit.

**8. Consensus.**

```ts
    this.consensus = new Consensus({
      chainId: this.chainId,
      getState: () => this.executor.state,
      applyBlock: (b, c) => this.executor.applyBlock(b, c),
      updateCommit: (h, c) => this.executor.updateCommit(h, c),
      blockTimeAt: (h) => this.executor.blockTimeAt(h),
      requestBlock: (height) => this.network.broadcast({ type: 'blockRequest', height }),
      scorePeer: (id, points, reason) => this.network.score(id, points, reason),
      getLastCommit: () => this.executor.getLastCommit(),
      validatorSetAtHeight: (h) => this.executor.validatorSetAtHeight(h),
      reapTxs: (max) => this.mempool.reap(max),
      privValidator: this.privValidator,
      verifier: this.verifier,
      evidencePool: this.evidencePool,
      broadcastProposal: (p, except) => this.network.broadcast({ type: 'proposal', proposal: p }, except),
      broadcastVote: (v, except) => this.network.broadcast({ type: 'vote', vote: v }, except),
      timeouts: this.cfg.timeouts,
      limits,
      log: this.log,
    });
```

What is wired to what: state reads and block application go to the executor; `updateCommit` lets consensus store a fuller commit when late precommits arrive during the commit timeout (STAKING.md section 2.1); `blockTimeAt` serves evidence age checks; `requestBlock` broadcasts a `blockRequest` to every peer (the `hash` argument consensus passes is ignored; the response is matched by height, as RPC-SYNC-PROOFS.md section 4.5 puts it: "consensus broadcasts a request for the block by height"); `scorePeer` charges bad signatures; `reapTxs` takes transactions from the mempool when this node proposes; the two broadcasts push consensus messages, skipping the peer the message came from.

**9. Block sync.**

```ts
    this.blockSync = new BlockSync({
      chainId: this.chainId,
      getState: () => this.executor.state,
      applyBlock: (b, c) => this.executor.applyBlock(b, c),
      validatorSetAtHeight: (h) => this.executor.validatorSetAtHeight(h),
      blockTimeAt: (h) => this.executor.blockTimeAt(h),
      store: this.store,
      verifier: this.verifier,
      limits,
      network: this.network,
      requester: this.requester,
      isConsensusDeciding: () => this.consensus.isDeciding,
      onBlockApplied: () => this.consensus.restart(),
      log: this.log,
      lagGraceMs: this.cfg.lagGraceMs,
      backfill: this.cfg.stateSync?.backfill ?? true,
      retainBlocks: this.cfg.retain?.blocks,
      scorePeer: (id, points, reason) => this.network.score(id, points, reason),
    });
```

The same executor and `limits`; `blockTimeAt` is the executor's, so a synced block's evidence is checked for age against a header kept alone as well as against a block; `isConsensusDeciding` and `restart` are the two hooks that keep sync and consensus from colliding (see [sync](07-sync.md)). `backfill` defaults to true, and `stateSync.backfill: false` turns it off; `retainBlocks` is the same setting the executor prunes by, so backfill stops at the retention floor instead of fetching blocks pruning will delete.

**10. The gossip handlers.** The fetched-block path first:

```ts
    // A block fetched for the height consensus is on: it stands in for the proposal.
    this.network.on('blockResponse', (_peer, m) => {
      if (m.block && m.height === this.consensus.height) void this.consensus.handleFetchedBlock(m.block);
    });
```

The `Requester` also subscribes to `blockResponse` for backfill; the two handlers filter by height on one side and by pending request on the other, so they never claim the same response.

Consensus messages are pushed through unchanged, and a new peer is caught up:

```ts
    this.network.on('proposal', (peer, m) => void this.consensus.handleProposal(m.proposal, peer.id));
    this.network.on('vote', (peer, m) => void this.consensus.handleVote(m.vote, peer.id));
    // A peer that just connected missed everything flooded before; catch it up on the current height.
    this.network.onPeer((peer) => {
      const { proposals, votes } = this.consensus.messagesForPeer();
      for (const proposal of proposals) peer.send({ type: 'proposal', proposal });
      for (const vote of votes) peer.send({ type: 'vote', vote });
      // Evidence still waiting for a block is announced too; it was flooded before this peer existed.
      const pending = this.evidencePool.list(Infinity).map(evidenceId);
      for (let i = 0; i < pending.length; i += 256) peer.send({ type: 'inv', kind: InvKind.Evidence, hashes: pending.slice(i, i + 256) });
    });
```

Passing `peer.id` into `handleProposal` and `handleVote` is what lets consensus skip the source when it re-broadcasts, and charge it for a bad signature. `messagesForPeer` returns every valid proposal (except fetched ones, which carry no real signature) and every vote held for the current height. Evidence still in the pool is announced by `inv` messages of its ids (`evidenceId` from `src/consensus/evidence.ts`), all of it (`list(Infinity)`, not the block's worth a plain `list` call hands the proposer) in slices of 256, the most a `fetch` may name, so the new peer fetches what it lacks; RPC-SYNC-PROOFS.md section 4.4: "A newly connected peer receives the pending evidence keys with its catch-up messages." DESIGN.md section 3 explains the choice: a flooded message is sent once, so a peer that was not connected at that moment never gets it, and one missing vote can stall a round; re-sending and catching up new peers "replaces Tendermint's per-peer state tracking with something far simpler at the cost of some bandwidth."

Inventory gossip for transactions and evidence:

```ts
    this.mempool.on('tx', (hash, _tx, source) => this.network.broadcast({ type: 'inv', kind: InvKind.Tx, hashes: [hash] }, source));
    this.evidencePool.onAdded((ev) => this.network.broadcast({ type: 'inv', kind: InvKind.Evidence, hashes: [evidenceId(ev)] }));
    // What a peer announces and we lack is fetched at most once while a fetch is outstanding, in batches the serving side accepts.
    const outstanding = new Map<string, number>();
    const wanted = (hashes: Uint8Array[], have: (h: Uint8Array) => boolean) => {
      const now = Date.now();
      for (const [k, t] of outstanding) if (now - t > 10_000) outstanding.delete(k);
      const out: Uint8Array[] = [];
      for (const h of hashes) {
        const k = toHex(h);
        if (have(h) || outstanding.has(k)) continue;
        outstanding.set(k, now);
        out.push(h);
      }
      return out;
    };
    this.network.on('inv', (peer, m) => {
      const want = m.kind === InvKind.Tx ? wanted(m.hashes, (h) => this.mempool.seen(h)) : m.kind === InvKind.Evidence ? wanted(m.hashes, (h) => this.evidencePool.hasHash(h)) : [];
      for (let i = 0; i < want.length; i += 256) peer.send({ type: 'fetch', kind: m.kind, hashes: want.slice(i, i + 256) });
    });
```

A transaction admitted to the mempool is announced to every peer but the one it came from (`source` is `null` for a local submission, so then it goes to all). Evidence is announced to everyone, including the peer that sent it, which costs one `inv` that the sender ignores (it has the hash).

On the receiving side, `wanted` decides what to fetch. The mempool's `seen` cache and the evidence pool's `hasHash` cover what the node already holds or has already rejected, but a hash is only in them once the item has arrived and been checked; between the `fetch` and the `item` the node has nothing, and every peer that announces the same hash in that gap (several do, within milliseconds, for a transaction flooding through the network) would trigger another fetch. The `outstanding` map closes that gap: a hash is fetched at most once while a fetch for it is outstanding. The entry is removed when the `item` arrives (keyed by `txHash` of the data for a transaction and `sha256` of the data for evidence, which is `evidenceId`) or when the peer answers `itemNotFound`, and expires after 10 s regardless, so a peer that never answers only delays the fetch rather than blocking it for good: the next `inv` after the expiry fetches again. Expired entries are swept on every `inv`, so the map never grows past what was announced in the last ten seconds. Fetches go out in slices of 256 hashes because that is what the serving side accepts (below); an `inv` of a thousand hashes would otherwise produce one `fetch` that the server trims and charges for.

Serving fetches, with the fix for finding 14:

```ts
    this.network.on('fetch', (peer, m) => {
      const hashes = [...new Map(m.hashes.map((h) => [toHex(h), h])).values()].slice(0, 256);
      if (hashes.length < m.hashes.length) this.network.score(peer.id, 5, 'oversized or repetitive fetch');
      for (const h of hashes) {
        if (m.kind === InvKind.Tx) {
          const tx = this.mempool.get(h);
          peer.send(tx ? { type: 'item', kind: InvKind.Tx, data: tx } : { type: 'itemNotFound', kind: InvKind.Tx, hash: h });
        } else if (m.kind === InvKind.Evidence) {
          const ev = this.evidencePool.getByHash(h);
          peer.send(ev ? { type: 'item', kind: InvKind.Evidence, data: encode((w) => encodeEvidence(w, ev)) } : { type: 'itemNotFound', kind: InvKind.Evidence, hash: h });
        }
      }
    });
```

Hashes are deduplicated and capped at 256 per fetch; a peer whose fetch needed trimming is charged 5 points ("unsolicited or duplicate flood 5" in the tariff). Before this, a peer could ask for one 2.5 KB transaction ten thousand times per message and never read the replies. Received items clear their hash from `outstanding` and go to the mempool (`addTx` with the peer id as source) or to `acceptEvidence`; an `itemNotFound` only clears the hash.

**11. After every commit.**

```ts
    this.executor.onCommitted((block) => {
      this.network.broadcast({ type: 'status', height: block.header.height });
      if (this.app instanceof CoreApp && this.cfg.limits?.maxEvidenceAgeMs === undefined) limits.maxEvidenceAgeMs = this.app.stakingParameters().unbondingPeriodMs;
    });
```

The `status` broadcast is how every peer's block sync learns that this node moved; the limits update is the evidence-age coupling described in the concepts, skipped when the operator pinned `maxEvidenceAgeMs` explicitly.

#### Every handler on the network, in one place

Handlers registered by the node and by the two objects it constructs. The network's own control handling (`ping`, `pong`, `status` into `peer.height`, `addrRequest`, `addrResponse`) runs before any of these.

| message | registered by | action |
|---|---|---|
| `headerRequest` | `Node.init` | `headerResponse` from the store |
| `headersRequest` | `Node.init` | `headersResponse`: consecutive headers downward from the height, from blocks or headers kept alone, up to `MAX_HEADERS` |
| `validatorSetRequest` | `Node.init` | `validatorSetResponse` from the by-hash index |
| `validatorsRequest` | `Node.init` | `validatorsResponse` from the by-height index |
| `snapshotsRequest`, `manifestRequest`, `chunkRequest` | `Node.init` | from `CoreApp`; empty or null on any other app |
| `blockResponse` | `Node.init` | `consensus.handleFetchedBlock` when the height is the current one |
| `blockResponse`, `blocksResponse`, `headerResponse`, `headersResponse`, `validatorSetResponse`, `validatorsResponse`, `snapshotsResponse`, `manifestResponse`, `chunkResponse`, `addrResponse` | `Requester` | settle the first matching pending request |
| `proposal` | `Node.init` | `consensus.handleProposal(proposal, peer.id)` |
| `vote` | `Node.init` | `consensus.handleVote(vote, peer.id)` |
| `inv` | `Node.init` | `fetch` the hashes the mempool or evidence pool lacks and no fetch is outstanding for, 256 per message |
| `fetch` | `Node.init` | `item` or `itemNotFound` per hash, at most 256, 5 points if trimmed |
| `item` | `Node.init` | clear `outstanding`; `mempool.addTx(data, peer.id)` or `acceptEvidence` |
| `itemNotFound` | `Node.init` | clear `outstanding` |
| `status` | `BlockSync` | record the peer's height, `check` |
| `blockRequest` | `BlockSync` | `blockResponse` from the store |
| `blocksRequest` | `BlockSync` | `blocksResponse`, up to 64 consecutive blocks |
| peer connected | `Node.init`, `BlockSync` | send the current height's proposals and votes and `inv`s of all pending evidence, 256 ids each; record the hello height |
| peer gone | `Requester`, `BlockSync` | fail its pending requests; forget its height |

#### The life of a transaction

1. A client calls `submitTx` (or the RPC does). `mempool.addTx(tx, null)` runs `app.checkTx`; on success the mempool stores it and emits `tx` with `source = null`.
2. The node broadcasts `inv { Tx, [hash] }` to every peer.
3. A peer's `inv` handler sees a hash its mempool has not seen and it is not already fetching, and sends `fetch`; the node's `fetch` handler answers with `item`; the peer's `item` handler calls `mempool.addTx(data, peerId)`, which checks it again and emits `tx` with the sender as source, so the peer announces it to everyone but the sender. Within a few hops every node holds it.
4. The proposer of the next height calls `reapTxs`, which takes transactions in FIFO order up to the block's byte budget, and pushes the proposal to all peers.
5. The block is decided; `executor.applyBlock` runs `finalizeBlock` and `commit` on the application, stores the block with its results, and calls `mempool.update`, which drops the included transactions and re-checks the rest.
6. `onCommitted` broadcasts `status`. A client can now `queryTx(hash)` for the inclusion proof, and after the next block for the result proof.

#### The life of a block on a node that is behind

1. A peer's `status` says 50; the node is at 40. `BlockSync.check` requests 41 to 48 and 49 to 50 from two peers.
2. Blocks arrive and are buffered; `drain` verifies 41 (structure, commit against `state.validators`, `lastCommit` against `state.lastValidators`, evidence) and calls `executor.applyBlock`, the same function consensus uses.
3. `onBlockApplied` calls `consensus.restart()`, which compares the state's height with its own and, since they differ, starts height 42 afresh (`startHeight`, which first clears every timer).
4. At 50, nothing is missing; the node's own consensus, fed proposals and votes by its peers, decides 51 itself. If a vote set reaches +2/3 precommits for a hash the node never saw proposed, consensus calls `requestBlock`, the node broadcasts `blockRequest { 51 }`, and the first `blockResponse` with that height goes to `handleFetchedBlock`.

#### `acceptEvidence`

```ts
  private async acceptEvidence(peerId: string, data: Uint8Array): Promise<void> {
    let ev;
    try {
      ev = decode(data, decodeEvidence);
    } catch {
      this.network.score(peerId, 20, 'malformed evidence');
      return;
    }
    if (this.evidencePool.has(ev)) return;
    const set = this.executor.validatorSetAtHeight(ev.voteA.height);
    if (!set) return;
    const err = await verifyDuplicateVoteEvidence(this.chainId, ev, set, this.verifier);
    if (err) {
      this.network.score(peerId, 20, `invalid evidence: ${err}`);
      return;
    }
    if (this.evidencePool.add(ev)) this.log('warn', 'evidence received from peer', { h: ev.voteA.height, validator: ev.voteA.validatorIndex });
  }
```

Evidence for a height whose validator set is unknown (pruned, or below the headers a state-synced node fetched for the evidence window) is dropped silently rather than charged, since the peer may be right. Adding to the pool triggers `onAdded`, which announces it onward, so evidence created on one node reaches every validator and the next proposer includes it.

#### `start`, `stop` and the accessors

`start()` starts the network (unless state sync already did), then block sync, then consensus, and logs the height, the validator address if any, and the node id. The order matters: block sync must be listening for `status` before consensus starts, and consensus must start after the executor has replayed. `stop()` releases the data directory lock first, then, if `start()` ran, stops consensus and block sync; then, if the network is up, stops it, which covers a node whose `init` started the network for a state-sync join and that was never started; then awaits `executor.idle()`, the tail of the executor's apply chain, so a block in the middle of its store batch or `app.commit` finishes its writes before the stores go away; and only then closes the environment if the node owns it. The wait matters for a node stopped while syncing: block sync hands the executor one block after another, and closing LMDB under a half-written one would leave the chain store and the application store at different heights, which `open` would then have to repair by replay on the next start. Neither `start` nor `stop` closes the verifier, which the caller owns because it is shared.

`height` is the executor's `lastHeight`; `genesis` returns the config's document; `submitTx(tx)` is `mempool.addTx(tx, null)`, "as an RPC endpoint would".

The three query methods package proofs for a light client:

```ts
  queryState(id: bigint, height?: bigint): StateQueryResult | null {
    const app = this.app as Partial<CoreApp>;
    if (typeof app.proofAt !== 'function' || app.lowestProvableHeight === undefined) return null;
    const h = height ?? this.executor.state.lastHeight - 1n;
    if (h < app.lowestProvableHeight) return null;
    const next = this.store.loadBlock(h + 1n);
    if (!next) return null;
    const proof: ObjectProof = app.proofAt(id, h);
    return { proof, header: next.block.header, commit: next.commit };
  }
```

The default height is `lastHeight - 1`, the latest height whose next header exists. The result carries header `h + 1`, whose `appHash` commits to the proven state, and that header's commit, so a verifier needs nothing from this node that it cannot check. `queryAccountName` is the same shape with a `KeyProof` from `proveAccountName`. `queryTx(hash)` looks the transaction up in the store's index, returns its inclusion proof against its own block's `dataHash` and, once the next block exists, its result proof against that header's `lastResultsHash` (RPC-SYNC-PROOFS.md section 2.2). Both state queries duck-type the application (`typeof app.proofAt !== 'function'`) so a node on an application without proofs returns `null` instead of throwing.

### scripts/localnet.ts

"The quickest way to watch the engine and the application work": N validators in one process on the memory transport, a faucet driving the core application, an RPC on the first node. Run with `node scripts/localnet.ts [validators=4] [seconds=30]`.

The genesis is built in code: a faucet account with a large balance, one operator account per validator, staking parameters, a community pool, and one validator per operator with its consensus key derived from a seed:

```ts
const genesis: Genesis = {
  chainId,
  genesisTime: BigInt(Date.now()),
  appState: appGenesisBytes({
    accounts: [account('faucet', faucet.publicKey, '1000000000000'), ...operators.map((k, i) => account(`op${i}`, k.publicKey, '5000000000'))],
    staking: { minSelfBond: 1000, fixedRewardPerBlock: 1, downtimeWindow: 20, downtimeJailMs: 10_000 },
    communityPool: 10_000,
    validators: operators.map((_, i) => ({ operator: `op${i}`, consensusKey: toHex(keyPairFromSeed(seed(`val${i}`)).publicKey), selfBond: 2000 })),
  }),
};
```

There is no `validators` list at the engine level: the application owns the set (STAKING.md section 2.3). Then the nodes:

```ts
const hub = new MemoryHub();
hub.latencyMs = 5;
const verifier = new WorkerVerifier();
const addrs = Array.from({ length: count }, (_, i) => `v${i}:1`);
const nodes: Node[] = [];
for (let i = 0; i < count; i++) {
  nodes.push(
    await Node.create({
      name: `v${i}`,
      genesis,
      dataDir: null,
      nodeKeySeed: seed(`node${i}`),
      validatorSeed: seed(`val${i}`),
      transport: hub.transport(addrs[i]!),
      listenAddr: addrs[i]!,
      seeds: addrs.filter((a) => a !== addrs[i]),
      verifier,
      timeouts: { proposeMs: 1000, prevoteMs: 500, precommitMs: 500, commitMs: 1000, gossipMs: 300 },
      network: { connectIntervalMs: 200 },
      log: makeLogger(`v${i}`, i === 0 ? 'info' : 'warn'),
    }),
  );
}
for (const n of nodes) await n.start();
```

One hub, 5 ms of latency, one `WorkerVerifier` shared by every node (one worker pool for the whole process), every node seeded with every other address, and only the first node logging at `info` so the output stays readable. After `start`, an `RpcServer` on node 0 opens on `RPC_PORT` or 26657, and the script prints a CLI command to try against it.

Every second a ticker submits one transaction from the faucet to a different node in turn: an `accountCreate` for a new user, a `transfer` to a known user, or a `delegate` to one of the validators, with fees from the application's schedule (`withFees`), and prints a status line: the height of every node, the voting powers in node 0's current set, the mempool size, the account count, the faucet balance, the community pool, and the bonded total. Transactions submitted to any node reach every node through inventory gossip and land in the same block everywhere, which is visible as the heights moving together and the balances agreeing.

At the end, the script takes an object proof for the last user from node 0 and verifies it against node 0's app hash with `verifyObjectProof`, prints the result and the number of sibling hashes, then stops the RPC, every node, and the verifier, and exits.

For comparison, the same constructor on disk and over TCP is in `src/cli.ts` (`start`), which reads a node directory written by `init` or `join`:

```ts
  const env = new LmdbEnv(join(nodeDir, 'data', 'lmdb'));
  const node = await Node.create({
    name: cfg.name,
    genesis,
    dataDir: join(nodeDir, 'data'),
    nodeKeySeed: fromHex(cfg.nodeKeySeed),
    validatorSeed: cfg.validatorSeed ? fromHex(cfg.validatorSeed) : null,
    transport: new TcpTransport(),
    listenAddr: cfg.listenAddr,
    seeds: cfg.seeds,
    env,
    verifier,
    log,
    stateSync: cfg.stateSync ? { trustHeight: BigInt(cfg.stateSync.trustHeight), trustHash: fromHex(cfg.stateSync.trustHash), backfill: cfg.stateSync.backfill } : undefined,
    retain: cfg.retain,
    snapshotInterval: cfg.snapshotInterval,
  });
```

The only differences from the localnet are the transport, the storage (an `LmdbEnv` passed in, so the CLI owns it), and the state sync and retention options read from `config.json`. The [wallet and CLI](14-wallet-cli.md) chapter covers the rest of that file.

### bench/network.bench.ts

The same pattern used to measure. `makeNet(genesis, validators, verifier, engineOnly)` builds a hub with 1 ms of latency and N validators with the fast timeouts, `lagGraceMs: 500` and `snapshotInterval: 0`, on either `KvStoreApp` (engine only) or the default `CoreApp`. Three measurements:

- Engine only: four validators on empty blocks for 8 seconds; blocks per second with a 50 ms commit timeout. README.md reports 9.5 blocks/s.
- The core application under load: 6,000 pre-signed transfers fed to one node, at most 3,000 ahead of what is committed, until all are in; transfers per second, blocks per second, largest block. README.md: 1,100 transfers/s sustained with full 4 MiB blocks.
- Block sync: a fifth node joins afterwards and must reach the validators' height.

```ts
    const target = n0.height;
    const late = await Node.create({
      name: 'late',
      genesis,
      dataDir: null,
      nodeKeySeed: nodeSeed(99),
      validatorSeed: null,
      transport: net.hub.transport('late:1'),
      listenAddr: 'late:1',
      seeds: net.addrs,
      verifier,
      timeouts: TIMEOUTS,
      network: NETWORK,
      lagGraceMs: 100,
      snapshotInterval: 0,
      log: process.env.BENCH_LOG ? makeLogger('late', process.env.BENCH_LOG as LogLevel) : silentLogger,
    });
    const t1 = performance.now();
    await late.start();
    while (late.height < target) await sleep(20);
```

The late node is a full node (`validatorSeed: null`) seeded with the validators' addresses. Its app hash is compared with validator 0's at the same height, which checks that replaying the blocks through block sync produced the same state as executing them live. README.md: 4,600 transfers/s for that sync. The bench ends by stopping every node and closing the shared verifier; finding 34 of the review (workers must not keep the process alive while idle, and must while a caller waits) came from exactly this kind of script.

## How it is tested

Every network test in the repository builds nodes through `makeTestnet` in `test/helpers.ts`, which is a compact version of the localnet: one `MemoryHub`, N validators plus optional full nodes, each seeded with every other address, the fast timeouts and network intervals, `lagGraceMs: 500`, the key-value test app by default or an `appFor` factory, and `makeNode(i, overrides)` to create extra or replacement nodes with the same seeds and genesis. The suites that use it are `consensus`, `engine`, `recovery`, `chain`, `light`, `staking-net`, `rpc`, `sync` and `review`.

The cases that exercise the node's own wiring:

- `test/consensus.test.ts`, `transactions gossip to every node and land in state`: a transaction submitted to node 0 reaches every node's application, proving the `inv`/`fetch`/`item` path end to end; an invalid one is refused at admission.
- `test/consensus.test.ts`, `a late-joining full node catches up through block sync` and then follows live consensus, proving the `onBlockApplied → consensus.restart()` hand-over.
- `test/consensus.test.ts`, `adds a validator through the application and it starts signing` and `removes a validator and the set shrinks`: a full node is stopped and recreated with a validator key through `makeNode`, the application returns validator updates, and the commit two heights later carries the new validator's signature.
- `test/sync.test.ts`, `gossips evidence from a node that cannot propose, and decides a height from a fetched block`: forged duplicate votes are added to a full node's evidence pool; `onAdded` announces them; every validator's application records the slash at that height, proving `acceptEvidence` and the evidence inventory path. Then proposals are filtered away from validator 3, which keeps deciding through `requestBlock` and the `blockResponse` handler with `blockSync.synced === 0n`.
- `test/sync.test.ts`, `joins from a snapshot ...`: `Node.create` with `stateSync` and `app: undefined`, `joinedAt` set, queries served at once, then `start()`.
- `test/review.test.ts`, `resumes after a restart that left a signature at the current height`: a one-validator node on a temporary data directory is stopped, its `priv_validator_state.bin` is overwritten to claim a signed proposal at the next height, and a new `Node` on the same directory must make progress in a later round, proving the on-disk pieces (LMDB chain store, application store, signing guard) are reopened consistently.
- `test/review.test.ts`, `survives an aborted request body on the RPC`: an `RpcServer` on a node stays up after a client disconnects mid-body.
- `test/review.test.ts`, `refuses a second node on a data directory that is in use`: described under the constructor; the lock is released by `stop()` and the directory can be reopened.

## Limitations and ideas

- `requestBlock` asks every peer for a block by height, so each answers with a full block; one reply would do.
- The node's default verifier is the `InlineVerifier`, which runs on the main thread; DESIGN.md section 10 lists this among the simplifications. The CLI, the localnet script and the benchmarks all pass a `WorkerVerifier`.
- Vote and proposal handling is not rate limited per peer (DESIGN.md section 10).
- State sync only works with the default `CoreApp`; `app` must be left out and `CORE_TYPES` is hardwired.
- The RPC has no authentication (DESIGN.md section 10).
- Evidence items are re-encoded on every fetch.
- The data directory lock trusts the PID in the `LOCK` file: a PID recycled by an unrelated process makes a stale claim look live until that process exits.

Exercises:

1. On `onPeer`, also announce the mempool's pending transactions in `inv` batches, and measure what that costs on a busy chain.
2. Make `requestBlock` pick one peer whose precommit consensus saw (pass the peer id through `handleVote`), with a fallback to the broadcast after a timeout, and compare the traffic with the current broadcast by height.
3. Add a `status()` method to `Node` returning height, catching-up flag (`blockSync.isSyncing`), peer count and consensus step, and use it from the localnet ticker instead of reaching into fields.
4. Run the localnet over TCP: replace `hub.transport(...)` with a `TcpTransport` per node and `127.0.0.1:<port>` addresses, and compare the status lines.
5. Add a per-peer transaction rate limit in the `item` handler, charging points above it.
6. Replace the PID in the `LOCK` file with an advisory file lock that the operating system releases when the process dies, and write a test that kills a node without `stop()` and restarts it on the same directory.

## Where to next

[The database](09-database.md) is the object store behind the application: typed objects with dense ids, indices, the Merkle root the app hash comes from, and the proofs the node's queries return.
