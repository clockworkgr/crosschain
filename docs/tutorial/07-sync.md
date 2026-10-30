# 7. Block sync and state sync

This part brings a node that is behind up to date. Block sync (`src/sync/blocksync.ts`) fetches committed blocks from peers, verifies each one's commit against the validator set the node already knows, and runs it through the executor in order; it also serves blocks to others, and fills in older blocks behind a node that joined from a snapshot. State sync (`src/sync/statesync.ts`) lets a new node skip replaying history: from a header the operator trusts, it verifies forward with the light client, downloads a snapshot of the application state in verified chunks, rebuilds the chain state at that height, fetches the headers below it that evidence may still name, and hands over to block sync. Both sit on the [p2p layer](06-p2p.md) (peers, messages, the `Requester`), use the block validation functions of the [consensus](04-consensus.md) chapter, write through the [block store](10-store.md), and, for state sync, use the snapshot format of the [application](11-application.md) and the [light client](13-light-client.md). The [node](08-node.md) constructs and wires both.

## Concepts

**Why consensus gossip cannot catch a node up.** A node that was off for an hour has missed thousands of heights. Consensus messages for those heights are gone: validators keep votes for the current height only, and nobody re-sends a vote for a height that is already decided. What does survive is the result: every committed block with its *commit*, the set of +2/3 precommit signatures that decided it, is in every full node's store. So a lagging node asks peers for blocks and commits and replays them. The file comment of `src/sync/blocksync.ts` puts it in one line: "Consensus gossip cannot do that: nobody keeps votes for old heights." CometBFT has the same split, a "blocksync" (formerly "fast sync") reactor separate from the consensus reactor; DESIGN.md section 2 lists "Block sync: lagging nodes fetch committed blocks + commits from peers and replay through the app. Separate from consensus gossip."

**No fork-point search.** Chains with probabilistic finality (Bitcoin, BitShares with its DPoS schedule) must first find where the local chain and the peer's chain diverge; Graphene exchanges a "synopsis" of block ids for that. Here finality is instant and there are no forks, so a node at height H simply asks for H+1 onward. DESIGN.md section 3: "Block sync: no fork-point synopsis. Lagging node requests blocks from height H+1. Both sides learn the other's height from the hello."

**Verifying a commit against the set you know.** A block from a peer is untrusted bytes. What makes it trustworthy is its commit: precommit signatures from more than two thirds of the voting power of the validator set that was responsible for that height. The node knows that set without trusting the peer, because validator set changes take effect two heights after the block that requested them (the H+2 rule, [consensus](04-consensus.md)): chain state at height H holds `validators`, the set that signs H+1, and `nextValidators`, the set that signs H+2. So for the block at H+1, `verifyCommit(chainId, state.validators, blockHash(block), commit, verifier)` checks that every signature present verifies over the precommit sign bytes (chain id, vote type, height, round, block hash, validator index) and that the signers' power is a quorum of that set. Then the block's own content is checked as consensus would check a proposal (`validateBlockStructure`) and its `lastCommit` and evidence signatures are verified (`verifyBlockSignatures`). After applying the block the node has the state for H+1, including the set that signs H+2, and the chain of trust extends one step. A peer that served a block failing any of these checks is charged 50 points (RPC-SYNC-PROOFS.md section 4.6, "bad block during sync 50").

**Windows, batches, several peers.** Asking for one block at a time, waiting, applying, asking again, would be bounded by the round trip. Instead a *window* of heights ahead of the applied height is kept requested, in runs of a few consecutive heights, from several peers at once; responses land in a buffer and are applied in order. RPC-SYNC-PROOFS.md section 4.3: "A window of 32 heights ahead of the applied height is kept requested, at most 8 heights per request, spread across up to 4 peers that report having them. Responses land in a buffer and are applied in order; a request that times out or returns a bad block is re-issued to another peer; the first peer's height is forgotten, and a bad block costs it points, while a mere timeout does not."

**Lag grace.** A node is normally "behind" for a few hundred milliseconds after every block: the others have decided height H+1 and announced it in `status` while this node is still finalizing. Starting a block request every time would waste bandwidth and race consensus. So a lag of exactly one block is tolerated for a grace period (`lagGraceMs`, default 3 s) before sync starts; a lag of two or more starts it at once.

**Sharing the executor with consensus.** Block sync and consensus both call `applyBlock`. Two rules keep them from stepping on each other: sync waits while consensus is in the middle of deciding (`isConsensusDeciding`), and if consensus applies a height first, the executor throws `StaleHeightError` for sync's copy, which sync ignores. After each synced block, sync calls `onBlockApplied`, which the node wires to `consensus.restart()` so the state machine moves to the new height.

**Backfill.** A node that joined from a snapshot at height H holds blocks from H upward. The blocks before H are not needed to follow the chain, but queries about old transactions and evidence about old heights need them, and an archive node wants all of them. So, whenever nothing is missing ahead, block sync fetches the block *below* the lowest one it holds, one at a time at low priority, and checks it against the hash chain it already has: the held block's `lastBlockHash` must equal the fetched block's hash, the body must match the header, and the commit must carry the signatures of the validator set the header names. Finding 17 of REVIEW-2026-10-28.md added the body and commit checks: before it, a peer could serve a genuine header with replaced transactions. Backfilled blocks are stored without execution results, so their transactions are indexed as "not executed here" (DESIGN.md section 10). On a node that joined by state sync, each backfilled block also replaces the header the join had kept alone for that height.

**Headers for the evidence window.** A block after the snapshot height may carry evidence of a double sign at any height within the evidence age (`maxEvidenceAgeMs`, the unbonding period). Applying it takes the validator set of that height, named by its header, and the time of that height, which every other node reads from its own blocks. A node that joined at H has no blocks below H, and a node that could not apply such a block would fall out of step with the chain at once. So, before the join is written, state sync fetches the headers below H back to the first one older than the evidence age, in batches of up to `MAX_HEADERS` (1000) per request, and keeps them without their blocks. No commit is needed for them: header H is already verified, and each header names the hash of the one before it, so a header is bound to the chain by its hash alone. Their validator sets are fetched by hash when the store lacks them. The executor's `headerAt` serves either a block's header or one of these records, so `validatorSetAtHeight` and `blockTimeAt` answer below the join ([chapter 5](05-mempool-executor.md)); backfill replaces each record with its block, and the executor's `pruneHeaders` drops the rest once the window has moved past them. The light client's backward verification ([chapter 13](13-light-client.md)) walks the same records, so a client anchored after the join can still verify a proof from before it.

**State sync and the trusted header.** Replaying a long chain is slow (every signature of every transaction must be verified again). Cosmos SDK nodes instead download a *snapshot* of application state and verify it against a header; this chain does the same. A snapshot (RPC-SYNC-PROOFS.md section 4.1) is the application's object database at a height H, exported per object type in chunks of objects, each chunk with a range proof that folds its leaves to the type root, plus a manifest listing the chunk hashes and the type leaves with their paths to the app hash. Nothing in a snapshot proves itself: the chain of trust must start from a header whose hash the operator obtained out of band (from a block explorer, a friend, a published checkpoint). That is the "trust anchor" of RPC-SYNC-PROOFS.md: `stateSync: { trustHeight, trustHash }`. From it the light client verifies forward to header H+1, whose `appHash` commits to the state after H (execution is deferred by one block, DESIGN.md section 2); the manifest must fold to that app hash; every chunk must hash as the manifest says and fold to its type root; the rebuilt database must produce the same root. Cosmos state sync has the same shape: a trust height and hash, snapshot discovery from peers, chunk verification, then block sync from the snapshot height.

**Which snapshot.** Peers offer snapshot heights. The joiner picks the highest height offered by at least two peers (a height one peer lists several times counts once for it), so that chunks can be spread across sources and a single lying peer can be out-voted, falling back to the highest offered by one. A peer that serves a chunk that fails verification is charged 50 points, marked bad for the rest of the chunk phase, and its job is retried elsewhere; a peer whose manifest does not fold to the verified app hash is charged 50 and the next source is asked; a peer whose block at H does not match its header or whose commit does not verify is charged 50 and the next source is asked.

**Rebuilding chain state, priorities included.** Block sync and consensus need more than the application state: the chain state at H (last block hash and time, app hash, results hash) and the three validator sets around it. The sets are fetched *by height* (`validatorsRequest`), because the by-hash copies do not carry proposer priorities and a state-synced validator must continue consensus with the exact priorities the others have (RPC-SYNC-PROOFS.md, "validator sets are stored by the height they sign with their proposer priorities so a joiner continues consensus exactly"). The priorities are not covered by the set hash, which finding 8 of the review flagged: a peer could serve genuine keys with altered priorities. The mitigation is to check that the sets given for H and H+1 pick, at some round from 0 up to the round each commit was decided in, the proposers the headers name; a block decided in round 2 may have been built and first proposed in round 0, and its header keeps that proposer's name. DESIGN.md section 10 records the residual: "a peer could still craft priorities that pass that check and diverge later." The three sets must also hold keys of the signature scheme the node's genesis names ([chapter 2](02-crypto.md)): every key the chain ever admitted was of that scheme, so a set of another kind is another chain's, and the chain state written at the join records the scheme as `genesisState` would have.

**The messages sync uses.** All are defined in `src/p2p/messages.ts` and matched through the `Requester` by the fields listed; every response echoes enough of its request to be matched without a correlation id.

| request | response | asked by | served by | matched on |
|---|---|---|---|---|
| `status` (no request; broadcast after every commit) | | every node | | `BlockSync.onPeerStatus` records the peer's height |
| `blocksRequest { from, count }` | `blocksResponse { from, blocks }` | block sync, ahead | `BlockSync.serveBlocks`, up to 64 consecutive stored blocks | `from` |
| `blockRequest { height }` | `blockResponse { height, block?, commit? }` | backfill; state sync for block H; consensus for an unseen block | `BlockSync.serveBlock` | `height` |
| `headerRequest { height }` | `headerResponse { height, header?, commit? }` | the light provider inside state sync | the node | `height` |
| `headersRequest { height, count }` | `headersResponse { height, headers }` | state sync, for the headers below H that evidence may still name | the node, downward from `height`: block headers or headers kept alone, up to `MAX_HEADERS` | `height`, then each header's height, chain id and hash |
| `validatorSetRequest { hash }` | `validatorSetResponse { hash, set? }` | the light provider; backfill when the store lacks a set | the node, from the by-hash index | `hash`, then `set.hash()` is checked |
| `validatorsRequest { height }` | `validatorsResponse { height, set? }` | state sync, for the sets at H, H+1, H+2 with priorities | the node, from the by-height index | `height`, then `set.hash()` is checked against the header |
| `snapshotsRequest` | `snapshotsResponse { heights }` | state sync, every peer | nodes on the core app | any |
| `manifestRequest { height }` | `manifestResponse { height, manifest? }` | state sync, each source in turn | nodes with that snapshot | `height` |
| `chunkRequest { height, objectType, index }` | `chunkResponse { height, objectType, index, chunk? }` | state sync workers | nodes with that snapshot | all three fields, then the chunk's own type and index |

Serving side handlers for headers, sets and snapshots live in `src/node/node.ts`; the two block handlers live in `BlockSync` itself so that a node serves blocks whether or not it is caught up.

## The code, file by file

### src/sync/blocksync.ts

**`BlockSyncDeps`**: everything the sync needs, as functions and objects rather than a reference to the node, so it can be tested alone (`test/review.test.ts` does, with a fake network).

- `chainId`, `verifier`, `limits` (the `ValidationLimits` consensus uses), `log`.
- `getState()`: the current `ChainState`; read fresh on every decision because consensus moves it.
- `applyBlock(block, commit)`: the executor's apply; may throw `StaleHeightError`.
- `validatorSetAtHeight(h)`: for evidence inside blocks.
- `blockTimeAt(h)`: the time of a committed height, from its block or from a header kept alone; `validateBlockStructure` checks evidence age against it.
- `store`: the `BlockStore`, to serve blocks and to backfill.
- `network`, `requester`.
- `isConsensusDeciding()`: true while consensus is applying a block it decided.
- `onBlockApplied()`: called after each synced block.
- `scorePeer?(peerId, points, reason)`: optional, wired to `Network.score`.
- `requestTimeoutMs?` (5000), `lagGraceMs?` (3000), `window?` (32), `perRequest?` (8), `maxPeers?` (4), `backfill?` (false unless set; the node sets it true by default).

`MAX_SERVED = 64` caps how many blocks one `blocksResponse` carries, matching the decoder's limit of 64 entries in `src/p2p/messages.ts`, and `MAX_SERVED_BYTES = 16 MiB` caps their encoded size: sixty-four blocks at the 4 MiB default block limit would be a 256 MiB frame, far past what the transport accepts, so a count cap alone is not a size cap.

**`BlockSync`** state: `peerHeights` (last known height per peer id), `buffer` (fetched blocks by height with the id of the peer that served them), `requested` (heights with a request in flight), `busyPeers` (peers with a request in flight), `noOldBlocks` (peers that answered a backfill request with nothing), flags `applying`, `backfilling`, `running`, the grace bookkeeping `behindSince` and `graceTimer`, the backfill `retryTimer`, and two public counters `synced` and `backfilled` used by tests and status.

The constructor subscribes:

```ts
  constructor(deps: BlockSyncDeps) {
    this.d = deps;
    deps.network.on('status', (peer, m) => this.onPeerStatus(peer.id, m.height));
    deps.network.on('blockRequest', (peer, m) => this.serveBlock(peer, m.height));
    deps.network.on('blocksRequest', (peer, m) => this.serveBlocks(peer, m.from, m.count));
    deps.network.onPeer((peer) => this.onPeerStatus(peer.id, peer.height));
    deps.network.onPeerGone((peer) => {
      this.peerHeights.delete(peer.id);
      this.busyPeers.delete(peer.id);
      this.check();
    });
  }
```

A new peer's height comes from its hello (`peer.height` at `onPeer`); later heights come from `status` messages, which every node broadcasts after each commit. Serving is registered here too, so a node serves blocks whether or not it is itself caught up.

Public methods: `start()` sets `running` and runs `check()`; `stop()` clears the flag, the grace timer and the backfill retry timer; `isSyncing` is true while anything is buffered or requested; `bestPeerHeight()` is the maximum over `peerHeights`.

#### The decision: `check`

```ts
  private check(): void {
    if (!this.running) return;
    const ours = this.d.getState().lastHeight;
    const best = this.bestPeerHeight();
    if (best <= ours) {
      this.behindSince = null;
      void this.backfill();
      return;
    }
    if (best === ours + 1n && this.buffer.size === 0) {
      const grace = this.d.lagGraceMs ?? 3000;
      const now = Date.now();
      if (this.behindSince === null) this.behindSince = now;
      if (now - this.behindSince < grace) {
        this.later(grace - (now - this.behindSince));
        return;
      }
    }
    this.request();
    void this.drain();
  }
```

`check` is the one entry point, called on every status, every peer change, every completed request, every applied block and every grace timer. Nothing to do: reset the grace clock and try a backfill step. One behind with nothing buffered: start or continue the grace period, and schedule a re-check for when it expires (`later` keeps a single timer). Otherwise issue requests and drain the buffer.

#### Issuing requests: `request`

```ts
  private request(): void {
    const ours = this.d.getState().lastHeight;
    const best = this.bestPeerHeight();
    const window = BigInt(this.d.window ?? 32);
    const perRequest = this.d.perRequest ?? 8;
    const maxPeers = this.d.maxPeers ?? 4;
    const target = best < ours + window ? best : ours + window;
    const missing: bigint[] = [];
    for (let h = ours + 1n; h <= target; h++) if (!this.buffer.has(h) && !this.requested.has(h)) missing.push(h);
    while (missing.length > 0 && this.busyPeers.size < maxPeers) {
      const from = missing[0]!;
      let count = 1;
      while (count < perRequest && count < missing.length && missing[count] === from + BigInt(count)) count++;
      const to = from + BigInt(count - 1);
      let chosen: Peer | null = null;
      for (const [id, h] of this.peerHeights) {
        if (h < to || this.busyPeers.has(id)) continue;
        const p = this.d.network.peers.get(id);
        if (p && (!chosen || h > this.peerHeights.get(chosen.id)!)) chosen = p;
      }
      if (!chosen) break;
      missing.splice(0, count);
      void this.fetchRun(chosen, from, count);
    }
  }
```

The target is the lesser of the best peer height and `ours + window`. Heights neither buffered nor in flight are collected; the first run of up to `perRequest` consecutive missing heights is cut off the front; the peer with the greatest known height that has all of them and is not busy is chosen; and `fetchRun` is started without awaiting. The loop continues until the missing list is empty, `maxPeers` peers are busy, or no peer can serve the next run. Choosing the highest peer first is a cheap heuristic for "most likely to have everything".

#### One request: `fetchRun`

```ts
  private async fetchRun(peer: Peer, from: bigint, count: number): Promise<void> {
    this.busyPeers.add(peer.id);
    for (let i = 0; i < count; i++) this.requested.add(from + BigInt(i));
    this.d.log('debug', 'requesting blocks', { from, count, peer: peer.id.slice(0, 8) });
    try {
      const m = await this.d.requester.request(peer, { type: 'blocksRequest', from, count }, 'blocksResponse', (m) => m.from === from, this.d.requestTimeoutMs ?? 5000);
      let got = 0;
      m.blocks.forEach((b, i) => {
        const h = from + BigInt(i);
        if (b.block.header.height !== h || !bytesEqual(b.commit.blockHash, blockHash(b.block))) return;
        this.buffer.set(h, { block: b.block, commit: b.commit, peerId: peer.id });
        got++;
      });
      if (got === 0) this.peerHeights.set(peer.id, from - 1n); // it does not have them after all
    } catch (e) {
      this.d.log('warn', 'block request failed', { from, count, peer: peer.id.slice(0, 8), err: (e as Error).message });
      this.peerHeights.delete(peer.id);
    } finally {
      for (let i = 0; i < count; i++) this.requested.delete(from + BigInt(i));
      this.busyPeers.delete(peer.id);
    }
    this.check();
  }
```

The response is matched on `from`. Each returned block is accepted into the buffer only if its header height is the expected one and its commit names its hash, a cheap structural filter; the real verification happens when the block is applied. A peer that returned nothing usable has its height lowered to `from - 1`, so it will not be asked for these heights again until its next `status` says otherwise. A timeout or disconnect forgets the peer's height entirely (it comes back with its next status). Either way the heights are released from `requested`, the peer from `busyPeers`, and `check` runs again, which re-issues the missing heights to another peer. RPC-SYNC-PROOFS.md section 4.3 states the policy: "the first peer's height is forgotten, and a bad block costs it points, while a mere timeout does not."

#### Applying in order: `drain`

```ts
  private async drain(): Promise<void> {
    if (this.applying || !this.running) return;
    this.applying = true;
    let progressed = false;
    try {
      for (;;) {
        const ours = this.d.getState().lastHeight;
        // Consensus may have decided heights we were still holding; they are not needed any more.
        for (const h of this.buffer.keys()) if (h <= ours) this.buffer.delete(h);
        const next = this.buffer.get(ours + 1n);
        if (!next) break;
        if (this.d.isConsensusDeciding()) {
          this.later(200);
          break;
        }
        this.buffer.delete(ours + 1n);
        progressed = true;
        let err: string | null;
        try {
          err = await this.verify(this.d.getState(), next.block, next.commit);
        } catch (e) {
          // Not the peer's fault: the verifier went away under us (shutdown). Stop quietly.
          this.d.log('debug', 'block verification aborted', { h: ours + 1n, err: (e as Error).message });
          this.stop();
          return;
        }
        if (err) {
          this.d.log('warn', 'bad block from peer', { h: ours + 1n, from: next.peerId.slice(0, 8), err });
          this.d.scorePeer?.(next.peerId, 50, 'bad block in sync');
          this.peerHeights.delete(next.peerId);
          continue;
        }
        try {
          await this.d.applyBlock(next.block, next.commit);
          this.synced++;
          this.d.onBlockApplied();
        } catch (e) {
          if (!(e instanceof StaleHeightError)) {
            this.d.log('error', 'failed to apply synced block', { h: ours + 1n, err: (e as Error).message });
            this.stop();
            return;
          }
        }
      }
    } finally {
      this.applying = false;
    }
    // Re-check only after a block left the buffer. check() calls drain() again, and
    // with nothing to apply that would recurse without ever reaching an await.
    if (this.running && progressed) this.check();
  }
```

`applying` makes the loop single-entry. Each iteration first discards every buffered block at or below the applied height: consensus may have decided heights that were still sitting in the buffer, and a response can carry heights the node applied while the request was in flight, so without the sweep those entries would stay in the `Map` until a restart, each holding a block's bytes. Then it takes the block for `ours + 1` out of the buffer, unless consensus is mid-decision, in which case it waits 200 ms. A bad block is dropped, its source charged 50 points and forgotten, and the loop continues: the height is now neither buffered nor requested, so the next `check` asks someone else. A verifier exception is treated as shutdown, not as a peer fault. `StaleHeightError` from `applyBlock` means consensus applied that height while sync was verifying it; the block is simply dropped and the loop reads the new state. Any other apply failure stops sync, because the executor is in an unknown condition.

The closing comment records finding 30 of the review. Before the fix, `drain` always called `check`, and `check` always called `drain`; with an empty buffer that recursion never reached an `await`, so a single `status` message from a peer whose blocks nobody could serve overflowed the stack. Now `check` is re-entered only if a block was consumed. `test/review.test.ts` (`does a bounded amount of work on a peer status it cannot act on`) counts calls to `getState` after one unanswerable status: fewer than 10, against 7492 before.

#### A sync session, end to end

Take a node at height 100 with four peers at 145, the defaults (window 32, 8 per request, 4 peers), and no grace, since the lag is more than one.

1. A `status { height: 145 }` arrives (or a peer connects with that height in its hello). `onPeerStatus` records it and calls `check`. `best = 145 > ours = 100`, lag is 45, so `request()` runs.
2. `request` sets `target = min(145, 100 + 32) = 132` and lists the missing heights 101 to 132. It cuts the run 101 to 108 and chooses the peer with the greatest height that is not busy: with four equal peers, the first in `peerHeights` order. `fetchRun` starts for 101 to 108 and marks that peer busy. The loop continues: 109 to 116 to the second peer, 117 to 124 to the third, 125 to 132 to the fourth. Now four peers are busy and the loop stops. `drain` finds nothing at 101 and returns.
3. Each `blocksResponse` lands in `fetchRun`, which buffers its eight blocks, frees the heights and the peer, and calls `check`. Suppose the second peer's response (109 to 116) arrives first. `request` finds 101 to 108 still in `requested`, nothing missing below 133, and `target` still 132, so it issues nothing; `drain` finds no block at 101 and returns at once without re-checking (this is the finding 30 rule).
4. The first peer's response arrives. `check` → `drain` applies 101: `verify` (structure, then the commit against `state.validators`, then `lastCommit` and evidence), `applyBlock`, `synced++`, `onBlockApplied` (consensus restarts at 102). The loop continues through 116, since 109 to 116 are buffered; at 117 the buffer is empty and the loop breaks. `progressed` is true, so `check` runs: `ours = 116`, `target = min(145, 148) = 145`, missing is 133 to 145 (117 to 132 are buffered or requested), and two peers are free, so 133 to 140 and 141 to 145 are requested.
5. This repeats until `ours = 145`. Then `best <= ours`: `behindSince` is cleared and `backfill` is tried, which returns at once because the lowest held height is 1.
6. Meanwhile the validators have committed 146 and broadcast `status { height: 146 }`. The node is one behind with an empty buffer, so the grace clock starts. Either consensus, restarted at 146, decides it from the votes validators keep re-sending while the round is unresolved (DESIGN.md section 3), and the grace is cleared on the next `check` when `best <= ours`; or the others have already moved on, the grace expires after 3 s, and block sync fetches 146.

A peer that answers 101 to 108 with a block whose commit does not verify is caught in step 4: the block is dropped, the peer charged 50 points and forgotten, and the next `check` re-requests 101 from another peer, because 101 is now neither buffered nor requested.

#### Verification: `verify`

```ts
  private async verify(state: ChainState, block: Block, commit: Commit): Promise<string | null> {
    // Clock drift is not checked on historical blocks.
    const structural = validateBlockStructure(state, block, this.d.limits, null, this.d.blockTimeAt);
    if (structural) return structural;
    const commitErr = await verifyCommit(this.d.chainId, state.validators, blockHash(block), commit, this.d.verifier);
    if (commitErr) return `commit: ${commitErr}`;
    return verifyBlockSignatures(this.d.chainId, state, block, this.d.verifier, this.d.validatorSetAtHeight);
  }
```

Three layers, in cost order. `validateBlockStructure` is the same check consensus applies to a proposal (height, chain id, version, hashes against state, size, evidence age by block time) with `nowMs = null`, because a block from last week is legitimately old. The block time lookup it is given is the executor's `blockTimeAt`, which answers from a header kept alone as well as from a block. Before that, `verify` read the stored block itself, so a node that had joined by state sync refused every synced block carrying evidence for a height below its join as `evidence for an unknown height`, charged the honest peer that served it 50 points, and went on to the next peer and the next ban. `verifyCommit` is the trust step described above, against `state.validators`. `verifyBlockSignatures` checks the block's `lastCommit` against `state.lastValidators` and `state.lastBlockHash`, and every piece of evidence against the set of its height. All signature work goes through the `Verifier`, so on a node with the worker pool a commit's signatures are verified in one batch off the main thread.

#### Serving

`serveBlock` answers a `blockRequest` with the stored block and commit or nulls. `serveBlocks` answers a `blocksRequest` with consecutive stored blocks from `from`, stopping at the first missing height or at `MAX_SERVED`, so a pruned or still-syncing node answers with what it has and the requester lowers its view of that peer accordingly.

#### Backfill

```ts
  private async backfill(): Promise<void> {
    if (!this.d.backfill || this.backfilling || !this.running) return;
    const lowest = this.d.store.lowestHeight();
    if (lowest <= this.backfillFloor()) return;
    let peer: Peer | null = null;
    for (const p of this.d.network.peers.values()) if (!this.noOldBlocks.has(p.id)) peer = p;
    if (!peer) {
      // Everyone connected has declined once; a peer that was itself still syncing may have the block later.
      if (this.noOldBlocks.size > 0 && !this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.noOldBlocks.clear();
          void this.backfill();
        }, 30_000);
        this.retryTimer.unref?.();
      }
      return;
    }
    this.backfilling = true;
    const height = lowest - 1n;
```

Runs only when `check` found nothing missing ahead, one block per step, down to `backfillFloor()`, picking any peer that has not already said it lacks old blocks.

```ts
  /** The lowest height worth fetching back to: genesis, or the edge of the retention window. */
  private backfillFloor(): bigint {
    if (this.d.retainBlocks === undefined) return 1n;
    const floor = this.d.getState().lastHeight - BigInt(this.d.retainBlocks);
    return floor > 1n ? floor : 1n;
  }
```

The floor is genesis for a node that keeps everything, and the edge of the retention window for one that prunes: a node with `retain.blocks` would otherwise fetch a block below the window only for the executor's `prune` to delete it at the next commit, and the two would chase each other for as long as the node ran. When every connected peer has declined once, a single 30-second timer clears `noOldBlocks` and tries again, because a peer that was itself still syncing may hold the block by then (REVIEW-2026-10-28.md finding 46); the timer is unref'd so it never keeps a process alive on its own, and `stop()` clears it. The response is checked in four ways before anything is written:

```ts
      const above = this.d.store.loadBlock(lowest)!;
      const hash = blockHash(m.block);
      if (m.block.header.height !== height || !bytesEqual(above.block.header.lastBlockHash, hash) || !bytesEqual(m.commit.blockHash, hash) || m.commit.height !== height || !bodyMatchesHeader(m.block)) {
        this.d.scorePeer?.(peer.id, 50, 'backfilled block off the hash chain');
        this.noOldBlocks.add(peer.id);
        return;
      }
```

The height must be the one asked for; the block's hash must be the `lastBlockHash` of the block above it (the hash chain); the commit must be for this block and height; and the body must match the header (`bodyMatchesHeader`, from `src/consensus/validate.ts`: transactions, evidence and last commit each hash to the header's field). Then the commit's signatures are checked against the set the header names by `validatorsHash`, loaded from the store or fetched by `validatorSetRequest` and saved for next time:

```ts
      const commitErr = await verifyCommit(this.d.chainId, set, hash, m.commit, this.d.verifier);
      if (commitErr) {
        this.d.scorePeer?.(peer.id, 50, `backfilled commit: ${commitErr}`);
        this.noOldBlocks.add(peer.id);
        return;
      }
      this.d.store.saveBlock(m.block, m.commit, null);
      this.d.store.setLowestHeight(height);
      // The header kept alone for this height (a state-sync join fetched it) is now redundant; when it was the
      // highest one left, none remain.
      this.d.store.deleteHeader(height);
      if ((this.d.store.lowestHeaderHeight() ?? -1n) >= height) this.d.store.setLowestHeaderHeight(null);
      this.backfilled++;
      if (height === 1n) this.d.log('info', 'backfill reached genesis');
```

`saveBlock(..., null)` indexes the transactions as not executed here (`ok: null` in `TxLocation`). Then the header record of that height, if the join kept one, is deleted: the block carries its header now. Header records are contiguous from the marker up to the lowest block and backfill fills from the top down, so when the marker stood at or above this height the record just deleted was the last one, and the marker is cleared. The next step is scheduled from the `finally` clause, whatever happened: a saved block, a decline, a block off the chain or a request failure (timeout, disconnect, logged at debug level) all lead there, and if the lowest held height is still above the floor the next `backfill` runs on `setImmediate`, so backfill yields to everything else between blocks. Scheduling from `finally` rather than after a successful save is what keeps a decline from stalling the whole process: an early `return` on `noOldBlocks.add` used to end the chain of steps, and backfill then waited for the next `check` to notice, which only happens when a `status` arrives. A peer that answered "no" stays in `noOldBlocks` until the retry timer above clears the set, so a pruned peer is left alone for half a minute at a time and then simply declines again, while a peer that was still syncing gets asked once more.

### src/sync/statesync.ts

Two helpers and one long function. The first helper is not defined here at all: `bodyMatchesHeader` lives in `src/consensus/validate.ts`, because consensus applies the same check to every proposal, and `statesync.ts` re-exports it for block sync's backfill and its own use.

**`bodyMatchesHeader(block)`**: the three body commitments in a header, checked at once.

```ts
export function bodyMatchesHeader(b: Block): boolean {
  return bytesEqual(txsRoot(b.txs), b.header.dataHash) && bytesEqual(evidenceHash(b.evidence), b.header.evidenceHash) && bytesEqual(commitHash(b.lastCommit), b.header.lastCommitHash);
}
```

**`proposerForRound(set, round)`**: the address a validator set with these priorities would pick at a round, computed as consensus does it, one `incrementProposerPriority(round)` on a copy from the base set (DESIGN.md section 1 explains why it must be one call, not round-by-round increments). Used for the priority check.

A detail of the file: the `import type` lines for `ChainState`, `ValidatorSet` and `Logger` appear after `proposerForRound`, at lines 41 to 43. ES module imports are hoisted, so it is legal, but it is unusual placement.

**`StateSyncOptions`**: `chainId`, `network`, `requester`, `verifier`, `chainStore` (the `BlockStore`), `appKv` (the application's key-value store, which must be empty), `types` (the object types of the application, `CORE_TYPES` from the node), `retainVersions?`, `log`, `trustHeight`, `trustHash`, `scheme` (the chain's signature scheme from genesis, as a `SchemeTag`; the node passes its node key's, which it derived with that scheme), `evidenceAgeMs` (a function of the imported database: how old evidence may be, which is the unbonding period the state holds unless the operator fixed one; the node passes `cfg.limits?.maxEvidenceAgeMs ?? getGlobal(db).staking.unbondingPeriodMs`), `transaction?` (runs the install's writes as one transaction; the node passes `env.transaction`), `peerWaitMs?` (30,000), `requestTimeoutMs?` (10,000), `parallel?` (4).

**`stateSync(o)`** returns `{ height }` when the node joined at a snapshot height, or `null` when no peer could be found or none offers a snapshot, in which case the caller replays from genesis. Any other problem throws, since a half-imported state must not be used. The steps:

1. **Wait for peers.** Poll every 200 ms until at least one peer exists or `peerWaitMs` passes (then `null`). Then wait up to 3 s more for a second peer, "so snapshots can be cross-checked and chunks spread".

2. **A light provider over the peers.** The light client needs headers with commits and validator sets by hash; here they come from peers:

```ts
  const provider: LightProvider = {
    latestHeight: async () => peers().reduce((m, p) => (p.height > m ? p.height : m), 0n),
    signedHeader: (height) =>
      ask<SignedHeader>(
        peers().filter((p) => p.height >= height),
        async (p) => {
          const m = await o.requester.request(p, { type: 'headerRequest', height }, 'headerResponse', (m) => m.height === height, timeout);
          return m.header && m.commit ? { header: m.header, commit: m.commit } : null;
        },
      ),
    validatorSet: (hash) =>
      ask<ValidatorSet>(peers(), async (p) => {
        const m = await o.requester.request(p, { type: 'validatorSetRequest', hash }, 'validatorSetResponse', (m) => bytesEqual(m.hash, hash), timeout);
        return m.set;
      }),
  };
```

`ask` tries candidates in turn and returns the first non-null answer, logging failures at debug level. The provider does not verify anything; the light client does.

3. **Trust the anchor.** `LightClient.trust(..., trustHeight, trustHash)` fetches header `trustHeight`, refuses it if its hash is not `trustHash`, fetches the sets it names, and verifies its commit against its own set. From here on the light client's rules apply (sequential verification where sets are adjacent, skipping with a one-third overlap otherwise, bisection when overlap is insufficient; see [the light client](13-light-client.md)).

4. **Choose a snapshot.** Every peer is asked `snapshotsRequest`; a failure counts as an empty offer, and each peer's list is passed through a `Set` first, so a height a peer repeats counts once for that peer (otherwise one peer listing a height twice would pass the "two peers" test on its own). Heights are tallied by how many peers offer them:

```ts
  const tally = new Map<bigint, string[]>();
  for (const [id, heights] of offers) for (const h of heights) tally.set(h, [...(tally.get(h) ?? []), id]);
  const heights = [...tally.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const chosen = heights.find((h) => tally.get(h)!.length >= 2) ?? heights[0];
  if (chosen === undefined) {
    o.log('warn', 'state sync: no peer offers a snapshot; replaying from genesis');
    return null;
  }
```

`sources()` from here on is the peers that offered the chosen height H and are still connected.

5. **Verify to H+1.** `client.verifyToHeight(H + 1n)` moves trust from the anchor to the header after the snapshot. Its `appHash` is the root the state after H must have. The joiner logs `state sync: joining` with the height, app hash and number of sources.

6. **The manifest.** Each source is asked `manifestRequest(H)` until one yields a manifest that passes `verifyManifest(next.appHash, candidate)`: same format, same app hash, and every type leaf folds to it through its top-tree path, with chunk counts consistent with the object counts. A manifest that fails costs its source 50 points, and the next source is asked; a request that fails or a manifest whose bytes do not decode is only logged at debug level. The chunk phase's `bad` set is not touched here, so a source that served a bad manifest is still asked for chunks, each of which is verified on its own. No valid manifest from any source is fatal.

7. **Chunks in parallel.** One job per (type, chunk index). Up to `parallel` workers (but no more than there are sources) share the job list:

```ts
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs.shift();
      if (!job) return;
      const candidates = sources().filter((p) => !bad.has(p.id));
      if (candidates.length === 0) throw new Error('state sync: every snapshot peer failed');
      const p = candidates[turn++ % candidates.length]!;
      try {
        const m = await o.requester.request(p, { type: 'chunkRequest', height: H, objectType: job.type, index: job.index }, 'chunkResponse', (m) => m.height === H && m.objectType === job.type && m.index === job.index, timeout);
        if (!m.chunk) throw new Error('peer has no such chunk');
        const r = verifyChunk(manifest!, m.chunk);
        if (!('error' in r) && (r.chunk.type !== job.type || r.chunk.index !== job.index)) {
          o.network.score(p.id, 50, 'snapshot chunk for the wrong request');
          bad.add(p.id);
          jobs.push(job);
          continue;
        }
        if ('error' in r) {
          o.network.score(p.id, 50, `bad snapshot chunk: ${r.error}`);
          bad.add(p.id);
          jobs.push(job);
          continue;
        }
        chunks.push(r.chunk);
      } catch (e) {
        // A timeout is not proof of a bad peer; give it a few before giving up on it.
        const n = (failures.get(p.id) ?? 0) + 1;
        failures.set(p.id, n);
        o.log('debug', 'chunk request failed', { peer: p.id.slice(0, 8), attempt: n, err: (e as Error).message });
        if (n >= 3) bad.add(p.id);
        jobs.push(job);
      }
    }
  };
```

Sources are used round-robin. `verifyChunk` (in `src/app/core/snapshot.ts`) decodes the chunk, checks it belongs to this snapshot, checks `sha256(raw)` against the manifest's hash for that index, checks the object range matches the index, and folds the leaves with the chunk's sibling hashes to the type root. The extra check that the chunk's embedded `type` and `index` are the ones requested is finding 20 of the review: a peer could answer a request for chunk 0 with a perfectly valid chunk 1 wrapped in a response labelled chunk 0, which would have been counted as done and imported twice. A corrupt or mismatched chunk marks its source bad at once and costs it 50 points. A failed request (a timeout, a disconnect, or a peer that has no such chunk) is only counted in `failures`, and the source is dropped on its third, because, as the comment says, a timeout is not proof of a bad peer (REVIEW-2026-10-28.md finding 45: with two sources, one slow reply used to abort the join). Either way the job goes back on the list. When every source is bad the join fails. After the workers finish the chunk count must equal `chunkCount(manifest)`.

8. **Import.** `importSnapshot(manifest, chunks, o.types, { retainVersions })` builds a fresh `ObjectDatabase`, imports every object, sets the counters, computes the root for height H and throws unless it equals the manifest's app hash, then rebuilds the authenticated indices and compares their roots with the manifest's. At this point the application state is proven to be the state header H+1 commits to.

9. **Chain state at H.** Header H is fetched through the provider and must be the one `next.lastBlockHash` names. The three sets are fetched by height and checked by hash; then block H and its commit are fetched together, and the commit is verified inside the per-source loop:

```ts
  const setsAt = async (height: bigint, expectedHash: Uint8Array): Promise<ValidatorSet> => {
    const set = await ask<ValidatorSet>(sources(), async (p) => {
      const m = await o.requester.request(p, { type: 'validatorsRequest', height }, 'validatorsResponse', (m) => m.height === height, timeout);
      return m.set && bytesEqual(m.set.hash(), expectedHash) ? m.set : null;
    });
    if (!set) throw new Error(`state sync: no validator set for height ${height}`);
    return set;
  };
  const lastValidators = await setsAt(H, atH.header.validatorsHash);
  const validators = await setsAt(H + 1n, next.validatorsHash);
  const nextValidators = await setsAt(H + 2n, next.nextValidatorsHash);
  for (const set of [lastValidators, validators, nextValidators]) {
    for (const v of set.validators) if (schemeOf(v.publicKey) !== o.scheme) throw new Error(`state sync: a validator key is not a ${schemeName(o.scheme)} key; this is not the chain genesis describes`);
  }
  // The block and its commit come from one peer; a commit that does not verify marks that peer and the next one is asked.
  const block = await ask(sources(), async (p) => {
    const m = await o.requester.request(p, { type: 'blockRequest', height: H }, 'blockResponse', (m) => m.height === H, timeout);
    if (!m.block || !m.commit || !bytesEqual(headerHash(m.block.header), headerHash(atH.header))) return null;
    if (!bodyMatchesHeader(m.block) || !bytesEqual(m.commit.blockHash, headerHash(m.block.header))) {
      o.network.score(p.id, 50, 'state sync: block does not match its header');
      return null;
    }
    const commitError = await verifyCommit(o.chainId, lastValidators, headerHash(atH.header), m.commit, o.verifier);
    if (commitError) {
      o.network.score(p.id, 50, `state sync: commit of block ${H}: ${commitError}`);
      return null;
    }
    return { block: m.block, commit: m.commit };
  });
  if (!block) throw new Error(`state sync: no peer served block ${H} with a valid commit`);
  // Priorities are not covered by the set hash; at least the proposers the chain actually used must agree with them.
  // A block decided in round r may have been first proposed in an earlier round (a re-proposal keeps that proposer's name).
  for (const [set, header, commit] of [[lastValidators, atH.header, block.commit], [validators, next, verified.commit]] as [ValidatorSet, Header, Commit][]) {
    let named = false;
    for (let r = 0; r <= commit.round && !named; r++) named = bytesEqual(proposerForRound(set, r), header.proposerAddress);
    if (!named) throw new Error(`state sync: validator set for height ${header.height} names a proposer the chain did not use`);
  }
```

The hash check binds keys and powers to the headers the light client verified. The scheme check after it is the one place state sync looks inside a key: `schemeOf` reads the tag byte every key carries (chapter 2), and a member of another scheme than the node's genesis names means these sets, and the chain they belong to, are not the one the operator configured, so the join stops before anything is written rather than install a state the node could never sign for. The block and its commit come from one peer, and the commit is verified against `lastValidators` before that peer's answer is accepted (finding 17); a block whose body does not match its header, or whose commit names another hash or does not verify, costs that peer 50 points and `ask` moves to the next source, rather than failing the whole join on the first peer's bad answer. Only when no source serves a good pair does the step throw. The proposer check is the mitigation for finding 8 described in the concepts, with one subtlety: a block decided in round `r` may have been *built* in an earlier round and re-proposed with a proof of lock, and a re-proposal keeps the `proposerAddress` of the validator that first built it (chapter 4). So the header's proposer must be the one the set picks for *some* round from 0 to `commit.round`, not necessarily for the decided round itself. The stored block is then as trustworthy as a synced one.

10. **Headers below H.** The evidence window is `oldest = time(H) - evidenceAgeMs(db)`, the age read from the imported state now that it exists. The walk starts at H−1 expecting the hash `header(H).lastBlockHash` and moves down one header at a time:

```ts
  const oldest = atH.header.time - o.evidenceAgeMs(db);
  let expectedHash = atH.header.lastBlockHash;
  let height = H - 1n;
  let lowestHeader: bigint | null = null;
  let fetched = 0;
  outer: while (height >= 1n) {
    const have = o.chainStore.loadHeader(height);
    if (have && bytesEqual(headerHash(have), expectedHash)) {
      if (have.time < oldest) break;
      lowestHeader = height;
      expectedHash = have.lastBlockHash;
      height--;
      continue;
    }
```

A header record already in the store whose hash is the expected one is reused without a request, so a join that was interrupted during this phase, or that failed later, resumes from what the earlier attempt stored. Otherwise each source in turn is asked `headersRequest { height, count: MAX_HEADERS }`, and the answer is checked header by header:

```ts
      for (const hd of m.headers) {
        if (hd.height !== height || hd.chainId !== o.chainId || !bytesEqual(headerHash(hd), expectedHash)) break;
        if (hd.time < oldest) {
          done = true;
          break;
        }
        batch.push(hd);
        expectedHash = hd.lastBlockHash;
        height--;
      }
      if (batch.length === 0 && !done) {
        o.network.score(p.id, 50, `state sync: headers below ${top} are off the chain`);
        continue;
      }
      // A set a header names that the store lacks is fetched by hash, as the block backfill does.
      for (const hd of batch) {
        if (o.chainStore.loadValidatorSet(hd.validatorsHash)) continue;
        const set = await provider.validatorSet(hd.validatorsHash);
        if (!set || !bytesEqual(set.hash(), hd.validatorsHash)) throw new Error(`state sync: no peer serves the validator set of height ${hd.height}`);
        o.chainStore.saveValidatorSet(set);
      }
      o.chainStore.batch(() => {
        for (const hd of batch) o.chainStore.saveHeader(hd);
      });
```

Every header must carry the expected height, the chain id and the expected hash, and the hash expected next is its own `lastBlockHash`: the batch is bound to header H link by link, which is why no commit is needed below H. A header older than `oldest` ends the walk and is not stored; a header that breaks the chain ends the batch, and a peer whose very first header is off the chain is charged 50 points and the next source is asked. For every stored header whose `validatorsHash` the store lacks, the set is fetched by hash through the light provider, checked against that hash, and saved, as backfill does for blocks. Each batch is written as it arrives, in one store batch, so a join that fails after this point leaves records the next attempt reuses. When no source serves a batch the walk still needs, the join fails with `state sync: no peer serves the headers below N that evidence may still name`, and a restart tries again. At the end the span is logged as `state sync: headers for the evidence window { from, to: H-1, fetched }`. On a short test chain the walk reaches genesis; on a real chain it stops a week of headers down, at the unbonding period.

11. **Install.** `CoreApp.writeImportedState(appKv, db, H, next.appHash)` writes every object, the counters, and the height and app hash into the empty application store, exactly as the application's own commit would have. The `ChainState` is assembled (version, height H, block hash and time from header H, app hash and results hash from header H+1, the three sets, and the scheme). Then everything lands at once:

```ts
  const install = () => {
    CoreApp.writeImportedState(o.appKv, db, H, next.appHash);
    for (const [h, s] of [[H, lastValidators], [H + 1n, validators], [H + 2n, nextValidators]] as [bigint, ValidatorSet][]) {
      o.chainStore.saveValidatorSet(s);
      o.chainStore.saveValidatorsAt(h, s);
    }
    o.chainStore.saveBlock(block.block, block.commit, null);
    o.chainStore.setLowestHeight(H);
    if (lowestHeader !== null) {
      const known = o.chainStore.lowestHeaderHeight();
      o.chainStore.setLowestHeaderHeight(known !== null && known < lowestHeader ? known : lowestHeader);
    }
    o.chainStore.saveState(state);
  };
  if (o.transaction) o.transaction(install);
  else install();
```

The sets are saved both by hash and by height for H, H+1 and H+2; block H is saved without results; the lowest height is set to H; the lowest header height is set to the walk's lowest, or left at an existing marker if an earlier attempt had stored records further down; the state is saved last. The whole function runs inside `o.transaction`, which the node wires to `KvEnv.transaction` ([chapter 10](10-store.md)): on LMDB every store write inside it becomes a child of one environment-wide transaction, so the application store and the chain store land together or not at all, and a throw out of the function aborts the lot. In memory each write lands on its own, which is fine, since there is no crash to recover from. The function returns `{ height: H }` and the node's executor opens on a store that already has state at H, so the application's `info()` handshake finds its store at H as well. Block sync then starts asking for H+1, and backfill starts asking for H−1.

#### What can go wrong, and what happens

| condition | outcome |
|---|---|
| no peer within `peerWaitMs` | `null`: the node replays from genesis |
| the header at `trustHeight` does not hash to `trustHash`, or its commit fails | `LightClient.trust` throws; the join fails |
| no peer offers a snapshot | `null`: replay from genesis |
| the light client cannot reach H+1 (set changed too much to skip and bisection fails, trusting period expired) | throws |
| a manifest does not fold to header H+1's app hash | source charged 50; next source tried; none left: throws |
| a manifest request fails or its bytes do not decode | logged; next source tried |
| a chunk hash, range or range proof is wrong, or the chunk answers a different request | source charged 50 and marked bad; job retried elsewhere |
| a chunk request times out, the source disconnects, or it has no such chunk | counted against the source, which is dropped (not charged) on its third failure; job retried |
| every source marked bad | throws `every snapshot peer failed` |
| fewer chunks than the manifest lists | throws `chunk count mismatch` |
| imported objects do not hash to the app hash, or index roots differ | `importSnapshot` throws |
| header H is not the one header H+1's `lastBlockHash` names | throws |
| a set by height does not hash to the header's `validatorsHash` | tried on every source; none: throws |
| a fetched set holds a key of another scheme than the node's genesis names | throws `a validator key is not a <scheme> key; this is not the chain genesis describes` |
| a source's block H has another header, a body that does not match it, or a commit that names another hash or does not verify | source charged 50 (not for a missing or wrong-header block); next source tried; none: throws `no peer served block H with a valid commit` |
| no round from 0 to the commit's round makes a set pick the proposer the header names | throws |
| a source's headers below a height are not the chain's (wrong height, chain id or hash from the first one on) | source charged 50; next source tried |
| no source serves a batch of headers the evidence window still needs | throws `no peer serves the headers below N that evidence may still name`; the batches already stored are reused by the next attempt |
| no peer serves the validator set a fetched header names, or serves one with another hash | throws |
| the application store is not empty | `writeImportedState` throws inside the transaction, so nothing of the install lands |

Every `throw` in `stateSync` before the header walk happens before any write, so a join that fails on any check up to there leaves both stores exactly as they were; a `null` is a normal start. The header walk is the one phase that writes before the install, and what it writes, header records and validator sets by hash, is verified against the chain and harmless on its own: a join that fails after it leaves them behind for the next attempt to reuse. The install itself is one transaction. Before it was, the application store was written first, in one `kv.write`, and the chain store then received the sets, the block, the lowest height and finally the state in separate writes; a crash inside that tail left the application store full and the chain store without a state, so the next start ran state sync again, got as far as `writeImportedState`, threw `the application store is not empty`, and the data directory had to be cleared by hand. Now a crash at any point leaves either a complete join or nothing, and restarting the node simply joins again.

## How it is tested

`test/sync.test.ts` builds four-validator testnets on the core application through `makeTestnet` from `test/helpers.ts`.

- `joins from a snapshot, serves queries at once, survives a corrupt chunk, and backfills to genesis`. Only the first two validators take snapshots (every 6 blocks, 2 objects per chunk), so a joiner has exactly two sources. Three accounts are created so the account type spans two chunks. The test first checks the primitives: the manifest at 12 verifies against header 13's `appHash` and not against another field, and a chunk with one object swapped fails `verifyChunk` with `hash differs`. Then validator 1's `chunkBytes` is monkey-patched to corrupt every chunk it serves. A fifth node is created with `stateSync: { trustHeight: 2n, trustHash, backfill: true }` and no app (the node must build the core app itself). Assertions: `joinedAt` and `height` are 12; the store's lowest height is 12; below it the store holds header records back to genesis (`lowestHeaderHeight()` is 1, and header 7 hashes the same as validator 0's block 7); the app is at 12; `lowestProvableHeight` is 12 and a proof at 11 throws `not available`; the accounts are there; the liar's score on the joiner is above 40. After `start()`, the joiner follows the chain (height within one of validator 0 and above 14), serves a state query whose header is at `height`, backfills to lowest height 1 with `backfilled === 11n`, has the same block 1 as the validators, holds no header record any more (`lowestHeaderHeight()` is null and `loadHeader(7n)` is null, the backfilled blocks having replaced them), and indexes a backfilled transaction with `ok: null`.
- `applies evidence for a height before its join, from the headers it fetched for the evidence window`. A joiner is created at a snapshot of height 6 or later with `backfill: false`, so what it knows of the heights below its join is exactly what state sync fetched: `loadBlock(3n)` is null, `lowestHeaderHeight()` is 1, header 3 equals validator 0's, and `executor.blockTimeAt(3n)` is that block's time. Then validator 3's key is used to forge two prevotes for height 3 with different block hashes; the evidence enters validator 0's pool, is gossiped, and lands in a block after the join. The joiner must apply that block and the one after it (whose header fixes the state the slash produced), which it can only do by resolving the evidence through the header of height 3. Finally a light client anchored at the joiner's tip verifies a state proof at height 3 served by validator 0, by walking back through the joiner's header records ([chapter 13](13-light-client.md)).
- `fetches at a join only the headers evidence may still name, and lets them go as the window moves on`. The joiner is given `limits: { maxEvidenceAgeMs: 1500n }`. Every header record it holds has a time within 1.5 s of the join height's block time, and the block below its lowest record (or below the join, when it holds none) is older than that. After `start()`, once the chain's time has moved a window past the join, `lowestHeaderHeight()` becomes null and the record for `joinedAt - 1` is gone: the executor's `pruneHeaders`.
- `catches up a node that missed many blocks by batched requests across peers, and prunes behind a retention window`. A full node is created but not started; the validators reach height 45; the late node starts and must reach 44 with `synced >= 40`, which can only happen through windowed requests. A sixth node with `retain: { blocks: 10 }` and `limits: { maxEvidenceAgeMs: 0n }` (so the evidence window, which otherwise keeps every block of a short test chain, holds nothing back) syncs past 50 and its store's lowest height must track `height - 10`, with the block below it gone and the lowest one present (pruning is in the executor, but this is where it is exercised against a synced chain).
- `gossips evidence from a node that cannot propose, and decides a height from a fetched block`. The second half concerns the block fetch path that complements sync: the hub's `messageFilter` drops every `proposal` destined for validator 3; it must keep deciding heights (four more) with `blockSync.synced === 0n`, proving the blocks came through consensus's `blockRequest` and `handleFetchedBlock`, not through block sync.

`test/consensus.test.ts`, `a late-joining full node catches up through block sync`: a full node started at height 5 reaches it with `synced >= 3`, then follows live consensus for three more heights and holds the same block hash as validator 0 at the height where it switched, which proves the hand-over from sync to consensus does not fork the node's view.

`test/review.test.ts`, `does a bounded amount of work on a peer status it cannot act on`: the recursion regression described under `drain`.

`bench/network.bench.ts` measures a fifth node catching up by block sync on blocks full of signed transfers and checks its app hash against the validators'. README.md reports 4,600 transfers/s for that sync on an Apple M4 Pro, against 6,300 transfers/s for cold `finalizeBlock` alone, so sync runs close to the speed of block execution.

## Limitations and ideas

- Backfill fetches one block per round trip, and a peer that declined is not asked again for thirty seconds. A node joining a long chain backfills slowly.
- State sync is tied to the core application: `CORE_TYPES` and `CoreApp.writeImportedState` are used directly, and `NodeConfig.app` must be left out.
- The whole snapshot is held in memory as chunks before import. README.md: "plan for about three times the state in memory during the join."
- A state-synced node has no account history before H (DESIGN.md section 10), holds headers rather than blocks below H until backfill fills them in, and backfilled blocks carry no results.
- Proposer priorities remain only partly checked (DESIGN.md section 10).
- Synced blocks are verified one at a time; the buffer could be verified ahead of application.

Exercises:

1. Score a peer whose block request timed out, run a test with one silent peer, and decide whether the specification's choice (forget its height, charge nothing) was the right one.
2. Verify buffered blocks ahead of application: run `verify` for the next few buffered heights concurrently and apply in order.
3. Backfill in runs with `blocksRequest` instead of one `blockRequest` per step, keeping the hash-chain check from the top down.
4. Clear a peer's `noOldBlocks` entry as soon as it announces a higher `status`, instead of waiting for the thirty-second retry.
5. Make the chunk failure threshold and the backfill retry delay configurable, and test both with the memory hub's `messageFilter` dropping replies.
6. Make state sync generic: define an interface with `types`, `writeImportedState` and `hasState` on `Application`, and remove the `CoreApp` imports from `src/sync/statesync.ts` and the `instanceof CoreApp` checks in `src/node/node.ts`.

## Where to next

[The node](08-node.md) constructs the network, both syncs, the executor, the mempool and consensus, and wires them to each other.
