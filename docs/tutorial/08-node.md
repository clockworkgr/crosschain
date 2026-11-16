# 8. The node

A node is the consensus engine, the mempool, the network, block sync, state sync, the block store, one application, and a memory guard with a collection scheduler, wired together in one object. `src/node/node.ts` constructs each piece from the chapters before ([consensus](04-consensus.md), [mempool and executor](05-mempool-executor.md), [p2p](06-p2p.md), [sync](07-sync.md), the [store](10-store.md) and the [application](11-application.md)) and connects them with closures: consensus is given functions to apply a block and to broadcast a vote, block sync is given functions to read state and to restart consensus, and the network is given handlers for every message type. It also decides the gossip policy (what is pushed, what is announced by hash, what is sent to a peer that just connected), sheds load when the heap fills, and exposes the queries the [RPC](12-rpc.md) serves. Validators and full nodes run the same code; a full node has no validator key. `scripts/localnet.ts` and `bench/network.bench.ts` show how to run a whole validator set in one process.

## Concepts

**Validator or full node.** `NodeConfig.validatorSeed` is either a 32-byte seed for the validator key or `null`. With a seed the node builds a `PrivValidator` (the signing guard of the consensus chapter) and votes; without one, consensus runs as an observer that validates proposals and counts votes but signs nothing. Everything else, networking, sync, serving blocks and snapshots, answering queries, is identical. DESIGN.md section 2 lists what the engine owns: "p2p networking, consensus message gossip, mempool, tx gossip, block sync, evidence pool, proposer selection"; the node is where those pieces meet the application through the in-process `Application` interface.

**Wiring by closures.** `Consensus` does not hold a `Node`; it holds a `ConsensusDeps` object of functions: `getState`, `applyBlock`, `broadcastVote`, `requestBlock`, `scorePeer`, and so on. `BlockSync` likewise. The node fills those with arrow functions that reach into its own fields. This keeps the modules free of cycles (consensus does not import the network, the network does not import consensus), makes each testable with fakes (`test/review.test.ts` builds a `BlockSync` on a fake network), and makes the wiring readable in one place: `Node.init`.

**Order of construction.** The network is built first and its request handlers for headers, validator sets and snapshots are installed before anything else, because a node serves those "whether or not we are caught up ourselves". State sync, if configured and the store is empty, runs next, before the application exists, because it writes the application store directly. Then the application, the mempool on it, the executor (which initialises from genesis or replays whatever the application missed), the collection scheduler and the memory guard, consensus, block sync, and finally the gossip handlers.

**Three gossip policies in one node.** Consensus messages are pushed straight through to every peer (`broadcastProposal`, `broadcastVote`), with no inventory round trip; a peer that connects in the middle of a height is handed everything held for that height, plus an announcement of any evidence still waiting for a block. Transactions and evidence use announce and fetch (`inv`, `fetch`, `item`, `itemNotFound`), with a seen-cache on each side so nothing loops. Committed blocks are announced by height in a `status` message after every commit, and pulled through block sync. DESIGN.md section 3 explains the split: inventory for items where a round trip is cheap, push where it would delay a consensus phase.

**Evidence from peers.** A duplicate-vote evidence record arriving by gossip is checked for age and then verified against the validator set of its height before it enters the pool (`acceptEvidence`), and a peer serving malformed or invalid evidence is charged 20 points. RPC-SYNC-PROOFS.md section 4.4: "Evidence becomes an inventory item kind next to transactions: announce by key, fetch, verify against the validator set at its height, add to the pool, pass on."

**Evidence age follows the unbonding period.** A block may carry evidence only for an infraction no older than `maxEvidenceAgeMs` by block time: `evidenceAgeOk` refuses an age greater than the limit and accepts one equal to it (STAKING.md section 2.2). That check is made on blocks, and on evidence arriving by gossip before it is pooled (`acceptEvidence`, below). With staking, that limit must equal the unbonding period, or a validator could be punished after its stake was released, or escape punishment while still bonded. Governance can change the unbonding period, so the limit is not a figure fixed at genesis: the node's `evidenceAge()` reads `stakingParameters().unbondingPeriodMs` from the application each time it is asked, unless the operator set `limits.maxEvidenceAgeMs`, and writes it into the shared `limits` object. It is asked as soon as the executor has opened the application, after every commit, and by the executor whenever it prunes, which is after a block is applied and before the commit listeners run, so the blocks behind a block that changed the period are pruned by the new figure. This works because `Consensus` keeps a reference to that object and merges it with the defaults on every read (its private `limits` getter), rather than copying it once at construction.

**Fetching a block that was never proposed to us.** If a node sees +2/3 precommits for a block hash it never received a proposal for (the proposal was lost, or filtered), consensus asks for the block by height, and a `blockResponse` whose height is the current one is handed to `consensus.handleFetchedBlock`, which validates it like a proposal and decides. RPC-SYNC-PROOFS.md section 4.5 calls this "immediate block fetch"; it replaces falling a height behind and waiting for block sync.

**Storage.** With a `dataDir` the node opens one LMDB environment under `<dataDir>/lmdb` with a `chain` store (blocks, commits, state, validator sets, and the headers a state-synced node keeps below its lowest block) and an `app` store, and keeps the signing guard's state in `<dataDir>/priv_validator_state.bin` and the peer database in `<dataDir>/peers.json`. With `dataDir: null` everything is in memory, which is what the localnet and most tests use (the recovery and restart cases run on temporary directories). A caller may also pass its own `env`, in which case the node does not close it on `stop`.

**Queries for the RPC.** Because execution is deferred (the app hash of the state after block N is in header N+1), a proof about state at height N must be served with header N+1 and its commit. `queryState`, `queryTx` and `queryAccountName` package proofs that way so the light client can check them.

**Memory: a guard and a scheduler.** The state lives in the V8 heap, so the ceiling that matters is the heap limit: past it the process aborts with no chance to stop cleanly, and V8's default is a few gigabytes whatever the machine has. `src/node/memory.ts` answers with two small objects whose header comment is their design:

```ts
 * The state lives in the heap, so the ceiling that matters is V8's heap
 * limit: past it the process aborts with no chance to stop cleanly. The guard
 * samples the heap and, by how full it is, moves through four levels:
 *
 *   ok         nothing
 *   warn       logged, a major collection started; the node pages what its
 *              blocks do not need (the index trees, most of the history window)
 *   pressure   load is shed: the mempool's limit is lowered, costly RPC methods
 *              and new event streams are refused, the signature cache is
 *              dropped; consensus keeps running on whatever is pooled
 *   critical   a clean stop with a reason, so a supervisor restarts the node
 *              with a larger limit instead of finding a dead process
 *
 * Levels are hysteretic: one is left only a step below where it was entered,
 * so a heap hovering at a threshold does not flap.
 *
 * The scheduler moves collections to known moments. Right after a block
 * commits, when the node is idle until the next proposal, it runs a minor
 * collection (the young generation, a few milliseconds) and, when the heap has
 * grown enough since the last one, starts a major collection asynchronously,
 * so V8 rarely has to pick its own moment inside a round. Both need
 * --expose-gc; without it the scheduler does nothing and says so. Every
 * collection V8 runs, scheduled or not, is observed through perf_hooks and
 * counted, so an operator can see the pauses.
```

What is shed and what is not follows from what the node is for. The mempool, the costly RPC methods, new event streams and the signature cache are all memory held on behalf of clients and peers, and all of it can be refused or dropped without the chain noticing. Consensus and block sync are never shed: a validator that stopped voting under pressure would be counted absent and jailed, and a node that stopped following would only fall further behind, so both go on with whatever is pooled. Besides shedding, each level turns the object database's dials ([chapter 9](09-database.md)), the ones STATE-PAGING.md section 7 gives the guard: at `warn` the cache of decoded objects is capped at 100,000 and at `pressure` at 10,000; from `warn` on the secondary indices' B+ trees are dropped and the window of past versions kept in memory is cut to two (the current version and the two before it stay), so that every index read and every proof at an older height goes to LMDB from then on; from `pressure` on the Merkle trees are dropped as well, and every root and every proof goes there with them; and at `ok` the cache is unbounded again and a dropped tier is rebuilt from the store, but only once the heap has room for it. Each dial trades speed for room without refusing anything: with everything dropped the database runs on 57% of the heap it holds resident with a full history window (40 to 50% in an earlier build's run on a state with no history yet) and commits blocks of transfers among random accounts at the rate it has resident or above it (docs/benchmarks.md section 4.13); what goes slower is what reads through the store, scans, name proofs and proofs at past heights. What the guard itself does not do is open a store, which happens before its first sample. Under a heap limit the node tells the application how much room is left under half the heap limit (`Node.OPEN_FILL`), and a stored state whose trees would not fit in it is opened with them left in the store and without its history window in memory (STATE-PAGING.md section 9.1; [chapter 11](11-application.md)). A heap too small even for a state opened that way still aborts at startup, and the fix for that is a larger heap, which the CLI's `start` sets ([chapter 14](14-wallet-cli.md)).

## The code, file by file

### src/node/node.ts

**`NodeConfig`**, field by field:

- `name`: for log lines.
- `genesis`: the `Genesis` document; its `chainId` becomes the node's, and its `signatureScheme` (ML-DSA-44 when absent, [chapter 2](02-crypto.md)) is the scheme the node key and the validator key are derived with, the one every key and signature on the chain must use.
- `dataDir`: a directory, or `null` for memory only.
- `nodeKeySeed`: seed of the p2p identity key.
- `validatorSeed`: seed of the consensus key, or `null` for a full node.
- `transport`, `listenAddr`, `advertiseAddr?`, `seeds?`: passed to the network and the peer database.
- `app?`: an `Application`. Default is `CoreApp` on the node's own store. Must be left out when state syncing, because state sync writes the application store before the application is built.
- `env?`: a `KvEnv`. Default is LMDB under `dataDir`, or `MemoryEnv`.
- `stateSync?`: `{ trustHeight, trustHash, backfill? }`.
- `retain?`: `{ blocks?, versions?, snapshots?, memoryVersions? }`: blocks kept behind the latest (all when unset), the provable version window of the database, snapshots kept (2 by default in the default application, and never fewer than 1: a 0 is raised to 1), and how many of the provable past versions are kept in memory beside the current one (all of them when unset), the store answering for the rest ("Shedding load under memory pressure" below).
- `snapshotInterval?`: export a snapshot every this many blocks (1,000 by default in the default application); 0 disables the export, and snapshots already in the store stay there and are still served.
- `indexTrees?`: `'memory'` or `'store'`, where the application's secondary indices are read from. `'store'`, the default, never builds their B+ trees and reads LMDB: the node commits about a tenth more than it does while it has them and opens with a third less in its heap, a lookup by key costs the same and a page of a scan about twice as much, tens of microseconds. `'memory'` keeps the trees in the heap while they fit, dropped under memory pressure and rebuilt after it, for a node that mostly serves scans ("Shedding load under memory pressure" below).
- `arenaBytes?`: the most bytes the application's arena of encoded objects may take, the rest being read from the store ([chapter 9](09-database.md)); unbounded by default.
- `verifier?`: a `Verifier`, what checks signatures. "Left out, the node makes a pool of worker threads of its own and closes it when it stops: signatures are most of what a block costs, and checked inline they hold the event loop, consensus timers and all. Several nodes in one process should share one pool and pass it here." Tests share one inline verifier; the localnet and benchmarks share one `WorkerVerifier` across all nodes in the process.
- `timeouts?`, `limits?`: consensus timeouts and validation limits, partial overrides. `limits` is `Partial<Omit<ValidationLimits, 'maxBlockBytes'>>`: "The clock drift this node votes within, and for tests the evidence age. The block size is the chain's and comes from the genesis."
- `network?`: the subset `desiredOutbound`, `maxInbound`, `connectIntervalMs`, `pingIntervalMs`, `idleTimeoutMs` of `NetworkConfig`.
- `lagGraceMs?`: block sync's one-block grace.
- `log?`, `logLevel?`: a `Logger`, or a level for `makeLogger(name, level)`.
- `memory?`: the memory guard's thresholds and sampling (`warnAt`, `pressureAt`, `criticalAt`, `hysteresis`, `intervalMs`) and, for tests, a `stats` function that supplies the samples: everything of `MemoryGuardOptions` but the logger and the two callbacks, `onLevel` and `onSample`, which the node provides.
- `gc?`: the collection scheduler's options (`gc`, `majorGrowthBytes`, `majorGrowthFraction`, `observe`, `stats`), everything of `GcSchedulerOptions` but the logger; its own `gc` field set to `null` (`gc: { gc: null }`) turns scheduling off, and set to a function injects a collector in place of the global one `--expose-gc` provides.

**`Node`** fields: `name`, `chainId`, `app`, `store` (a `KvBlockStore` on the env's `chain` store), `env`, `mempool`, `evidencePool`, `requester`, `joinedAt` (the snapshot height when the node state-synced, else `null`), `memoryGuard`, `gcScheduler`, `privValidator`, `nodeKey`, `verifier`, the private `ownVerifier` (the `WorkerVerifier` the node made because it was given none, else `null`), `log`, `executor`, `consensus`, `network`, `blockSync`; private, `shedding` and the `memoryListeners` that `onMemory` collects. The fields marked with `!` are assigned in `init`.

#### `Node.create`

```ts
  static async create(cfg: NodeConfig): Promise<Node> {
    let node: Node;
    try {
      node = new Node(cfg);
    } catch (e) {
      if (!(e instanceof ConstructionFailure)) throw e;
      await e.cleanup();
      throw e.cause;
    }
    try {
      await node.init();
    } catch (e) {
      // A node that could not be set up gives back what it opened (the store, the verifier pool, the claim on its
      // directory), so the caller can try again in this process.
      await node.stop().catch(() => {});
      throw e;
    }
    return node;
  }
```

The constructor is private and synchronous. It sets the logger (`cfg.log`, or `makeLogger(cfg.name, cfg.logLevel ?? 'info')`), the scheme every key of this node is made in, and then the verifier (`cfg.verifier`, or a `WorkerVerifier` of its own, kept in `ownVerifier` so that `stop()` closes it):

```ts
    // One scheme per chain, genesis's, for the node identity and the validator key alike. Before anything is
    // opened: a genesis naming a scheme the code does not know throws here with nothing to give back.
    const scheme = schemeTag(cfg.genesis.signatureScheme ?? 'ml-dsa-44');
    this.nodeKey = keyPairFromSeed(cfg.nodeKeySeed, scheme);
    this.ownVerifier = cfg.verifier ? null : new WorkerVerifier();
    this.verifier = cfg.verifier ?? this.ownVerifier!;
```

`schemeTag` turns the name genesis wrote into the one-byte tag chapter 2 puts in front of every key, and a name it does not know throws here, before anything is opened, the verifier pool included. The same `scheme` derives the validator key below, so the node's p2p identity, its votes and, through the application, every account key and transaction signature on the chain are of one scheme; `nodeKey.scheme` is what the node hands state sync in step 4. Then it creates `dataDir` if given and locks it, opens the environment (`cfg.env`, else `LmdbEnv` under `<dataDir>/lmdb`, else `MemoryEnv`) and remembers whether the node owns it, opens the block store on the `chain` store, creates an empty `EvidencePool`, and builds the `PrivValidator` if there is a validator seed, with a `FileSignStateStore` on disk or a `MemorySignStateStore`:

```ts
      this.privValidator = cfg.validatorSeed
        ? new PrivValidator(
            keyPairFromSeed(cfg.validatorSeed, scheme),
            cfg.dataDir ? new FileSignStateStore(join(cfg.dataDir, 'priv_validator_state.bin')) : new MemorySignStateStore(),
            this.chainId,
          )
        : null;
```

These steps, from creating the directory to building the `PrivValidator`, run inside a `try`. If one of them throws, no node is handed back for the caller to stop, and a constructor cannot wait for a store to close, so the `catch` does not clean up on the spot. It throws a `ConstructionFailure`, which carries the original error as `cause` and an asynchronous `cleanup`:

```ts
/** A constructor's failure, with what releases the resources it had taken by then. */
class ConstructionFailure extends Error {
  override readonly cause: unknown;
  readonly cleanup: () => Promise<void>;
  constructor(cause: unknown, cleanup: () => Promise<void>) {
    super('node construction failed');
    this.cause = cause;
    this.cleanup = cleanup;
  }
}
```

```ts
    } catch (e) {
      // Nothing is handed back to stop, and a constructor cannot wait: the error goes out with what gives back
      // what was opened so far, for create() to wait on. The store is closed under the rule stop() follows (the
      // node's own, or any in a directory it claimed), and the claim on the directory goes last, once it is.
      const ownVerifier = this.ownVerifier;
      const releaseLock = this.releaseLock;
      throw new ConstructionFailure(e, async () => {
        try {
          // Each step on its own: one that throws, even before it returns a promise, does not stop the next.
          try {
            if (env && (!cfg.env || releaseLock)) await env.close();
          } catch {
            // The error the caller is given is the one that failed the construction.
          }
          try {
            await ownVerifier?.close();
          } catch {
            // As above.
          }
        } finally {
          releaseLock?.();
        }
      });
    }
```

`cleanup` closes the environment under the rule `stop()` follows, the node's own or any in a directory the node claimed (`!cfg.env || releaseLock`), then the verifier pool if the node made it, and releases the claim on the directory last, in a `finally`, once the store is closed. A failure of either close is swallowed, so the claim is released whatever happens. `Node.create`, quoted above, catches the `ConstructionFailure`, awaits its `cleanup` and throws `e.cause`: the caller sees the error of the step that failed, and by the time it sees it the store is closed and the claim is gone, so the same process can try the directory again at once. An error that is not a `ConstructionFailure`, such as the unknown scheme name thrown before the `try`, passes through `create` as it is. A failure in `init` takes the other path in `create`: the node exists by then, so `stop()` gives back what it opened.

The lock comes first, before the environment is opened, because "two nodes on one directory would share a signing guard that neither sees the other write": the double-sign guard of chapter 4 is a file, each process caches its last record in memory, and two validators on one directory would each believe it had signed nothing the other had, which is exactly the double signing the guard exists to prevent (and LMDB itself would not refuse the second opener). The command line's `start` passes the node only `dataDir` (`src/cli.ts`, quoted under `scripts/localnet.ts` below) and leaves the store to it, so a second `start` on a directory whose node is running is refused by the lock before it has opened anything there, and the process exits with the `in use` error. A caller that passes an environment of its own beside a `dataDir`, as some tests do, opened it before the node existed; the node still takes the claim before it asks that environment for a store (`this.env.store('chain')`). The module-level `lockDataDir`, with its helper `claimAlive`, is the whole mechanism:

```ts
/** Is the process whose id a claim file holds still running? A file that names no process, or this one, is not a live claim. */
function claimAlive(text: string): number | null {
  const pid = Number(text);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

/**
 * Claim a data directory for this process. The claim is a file linked into place only if none is there, so of two
 * nodes starting at once only one makes it. A live claim refuses, since two nodes on one directory would double sign. A stale one,
 * from a process that no longer runs, is taken over, and only by a process holding a second exclusive file,
 * `LOCK.takeover`: it reads the claim again, and removes it only if it is still stale. Without that, two processes
 * that both found the stale claim could each remove the other's new one and both start. A process killed in the
 * few file operations it holds `LOCK.takeover` for leaves it behind, and that file is never removed
 * automatically: the next start says so and stops.
 */
function lockDataDir(dir: string): () => void {
  // The directory exists by now; its real path is one name for it however it was spelled or linked to.
  const real = realpathSync(dir);
  const path = join(real, 'LOCK');
  const takeover = join(real, 'LOCK.takeover');
  if (heldDirs.has(real)) throw new Error(`data directory ${dir} is in use by this process`);
  // The claim appears with the process id already in it: it is written under another name and linked into place,
  // which fails if a claim is there. A claim created empty and filled afterwards could be read as stale in between.
  const mine = join(real, `LOCK.${process.pid}.${randomBytes(4).toString('hex')}`);
  for (let attempt = 0; ; attempt++) {
    // Every way round the loop counts, so starts that keep finding and clearing stale claims end too.
    if (attempt >= 50) throw new Error(`data directory ${dir}: could not claim it in 50 attempts; ${takeover} may have been left by a process that stopped while taking over a stale claim: check that no node runs on the directory, then remove it`);
    writeFileSync(mine, String(process.pid));
    try {
      linkSync(mine, path);
      unlinkSync(mine);
      break;
    } catch (e) {
      unlinkSync(mine);
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // Released between the two calls: the next attempt creates it.
      continue;
    }
    const pid = claimAlive(text);
    if (pid !== null) throw new Error(`data directory ${dir} is in use by process ${pid}`);
    try {
      writeFileSync(takeover, String(process.pid), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Another process is taking the stale claim over; it is done within a few file operations.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      continue;
    }
    try {
      // Only the holder of the takeover file removes a claim, and only one still stale now that it holds it.
      let still: string | null = null;
      try {
        still = readFileSync(path, 'utf8');
      } catch {
        // Gone: the link is tried again.
      }
      if (still !== null && claimAlive(still) === null) unlinkSync(path);
    } finally {
      unlinkSync(takeover);
    }
  }
  heldDirs.add(real);
  return () => {
    heldDirs.delete(real);
    try {
      // Only this process's own claim is removed, not one that replaced it.
      if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
    } catch {
      // Already gone: nothing to release.
    }
  };
}
```

A `LOCK` file holds the PID of the process that claimed the directory. It is not created empty and then filled: the process writes its PID to a private file, `LOCK.<pid>.<8 hex digits>`, and makes `LOCK` a hard link to it with `linkSync`, which fails with `EEXIST` when a `LOCK` is already there. Linking is therefore the claim, of two processes starting on one directory at once only one makes it, and `LOCK` appears with the PID already in it. Were the file created first and written afterwards, another process could read it in between, find no PID in it, take it for stale and remove it, and both would start. The private file is unlinked straight after the link, whether the link succeeded or not, and the random digits in its name keep it apart from one an earlier process with the same PID left behind. When the link fails because `LOCK` exists, its text is read and `claimAlive` tests the PID in it. `process.kill(pid, 0)` sends no signal; it only asks whether the process exists, throwing `ESRCH` when it does not and `EPERM` when it does but belongs to another user, which is why `EPERM` counts as alive. A file that names no process, or this one, is not a live claim. A live claim is refused. A file that vanished between the link and the read was released by its holder, and the next pass links again.

A claim left by a process that no longer runs is taken over, so a crash needs no manual cleanup, but not by unlinking it on sight. Were it so, two processes that found the same stale claim at the same instant could each unlink what the other had just created, and both would believe they held the directory. The removal therefore belongs to whichever process holds a second file, `LOCK.takeover`, created with the flag `wx`, which fails with `EEXIST` when the file is already there. Holding it, the process reads the claim again and unlinks it only if it is still stale: a claim another process made in the meantime is live and stays. The `finally` removes `LOCK.takeover` whatever happened, and the loop goes round to the link, which this process may win or lose like any other. A process that finds `LOCK.takeover` already there waits 20 ms (`Atomics.wait` on a fresh buffer is a synchronous sleep, and this code runs in a constructor) and starts the pass again; the holder is done within a few file operations.

The passes are counted at the top of the loop, whichever way the one before ended: a claim that vanished, a takeover file in the way, or a stale claim cleared only for another process to link first. The fifty-first throws `could not claim it in 50 attempts; <path>/LOCK.takeover may have been left by a process that stopped while taking over a stale claim: check that no node runs on the directory, then remove it`. The message names the likely cause and not a certain one, since the count covers every way round. That cause is the one case that needs a hand: a process killed in the few file operations for which it holds `LOCK.takeover` leaves the file behind, nothing removes it automatically, and every later start on a directory with a stale claim waits its fifty passes, about a second, and stops with that message until someone removes the file. A process killed between writing its private file and unlinking it leaves a `LOCK.<pid>.<hex>` file behind as well; nothing reads it, so it is harmless and can be deleted. The link is also why the data directory has to be on a filesystem that has hard links.

The in-process `heldDirs` set covers what the PID check cannot: two `Node` objects in one process (the test harness does this on purpose), where the file would name this very process and the PID test would skip it. It holds the directory's real path (`realpathSync`, which the directory exists for by then), so `data`, `data/.` and a symbolic link to `data` are one directory to it, and the `LOCK` file is made under that path. The returned function releases both, removing `LOCK` only if it still holds this process's PID, so that a claim which replaced it is left alone, and `stop()` calls it as its last step, after the network is down, the executor's last writes have finished and the environment is closed, so a second node cannot open the directory while the first is still writing to it. `test/review.test.ts`, `refuses a second node on a data directory that is in use`, builds a one-validator network on a temporary directory, asserts that a second `makeNode(0)` on it rejects with `/in use/`, and that the same call succeeds once the first node has stopped.

Everything asynchronous happens in `init`.

#### `init`, step by step

**1. Limits.**

```ts
    const chain = this.cfg.genesis.consensus;
    const limits = (this.limits = {
      ...DEFAULT_LIMITS,
      ...(chain?.maxEvidenceAgeMs !== undefined ? { maxEvidenceAgeMs: chain.maxEvidenceAgeMs } : {}),
      ...this.cfg.limits,
      // Last, so nothing a node is configured with changes what blocks it holds valid.
      maxBlockBytes: chain?.maxBlockBytes !== undefined ? checkMaxBlockBytes(chain.maxBlockBytes) : DEFAULT_LIMITS.maxBlockBytes,
    });
```

`DEFAULT_LIMITS`, overridden by `genesis.consensus.maxEvidenceAgeMs` if present, overridden by `cfg.limits`, and then `maxBlockBytes`, written last and from the genesis alone: `consensus.maxBlockBytes` checked by `checkMaxBlockBytes` ([chapter 3](03-types.md)), or the default 4 MiB when the genesis names none. `NodeConfig.limits` cannot carry a block size by its type, and one passed all the same is overwritten here. The reason is what the figure is used for. `validateBlockStructure` applies it to a proposal, to a block being committed and to a synced block, so two nodes holding different sizes would disagree about which blocks are valid: a block between the two sizes is committed by one and refused by the other. `maxClockDriftMs` is different and stays a setting of the node: it is applied only to a fresh proposal (`polRound === -1`) when the node decides its prevote, and never to a block being committed or synced, where `nowMs` is null ([chapter 4](04-consensus.md)). It is a rule for what a node votes for, like its clock, and nodes that differ in it still agree on every block. This object is kept in the node's `limits` field and shared by reference with consensus and block sync; `evidenceAge()` writes the evidence age into it as soon as the application is open (step 7), after every commit (step 12) and whenever the executor asks for the age to prune by.

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

The headers handler walks downward from the height asked, taking a stored block's header or, below the lowest block of a node that itself joined by state sync, the header it kept alone, and stops at the first height it holds neither for, so the answer is always a consecutive run; `MAX_HEADERS` (1000) caps it whatever the asker's `count`. These headers go without commits: state sync binds each to the one above it by hash ([chapter 7](07-sync.md)), so a commit per header would be wasted bytes. The snapshot handlers check `this.app instanceof CoreApp` at call time, so a node on the key-value test app, or a node still state syncing (whose `app` is unset), answers with no snapshots rather than crashing. Block requests are served by `BlockSync`, constructed in step 10.

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
        scheme: this.nodeKey.scheme,
        // The same age the node will hold blocks to: the operator's figure, else the unbonding period the imported state holds.
        evidenceAgeMs: (db) => this.cfg.limits?.maxEvidenceAgeMs ?? getGlobal(db).staking.unbondingPeriodMs,
        transaction: (fn) => this.env.transaction(fn),
      });
      if (joined) this.joinedAt = joined.height;
    }
```

The network is started early so peers can be found; `networkStarted` prevents `start()` from starting it twice. `evidenceAgeMs` tells state sync how far below the snapshot to fetch headers ([chapter 7](07-sync.md)): the operator's `limits.maxEvidenceAgeMs` if one was pinned, else the unbonding period held by the imported state, read through `getGlobal(db)` once the database exists, which is the figure the executor will prune by once the application is open (step 7). `scheme` is the node key's, which is genesis's: the validator sets state sync fetches must hold keys of it ([chapter 7](07-sync.md)), or the snapshot is not of the chain this genesis describes, and the chain state it writes records it. `transaction` is `env.transaction`, so the install's writes to the application store and the chain store land as one. A `null` result (no peers, no snapshots) falls through to a normal start from genesis. A thrown error propagates out of `Node.create`, here or at any later step of `init`, and `create` cleans up before it throws it on: the constructor has already claimed the directory, opened the environment and, given no verifier, made a worker pool, the network may be started, and since `create` returns no node the caller has nothing to stop. So `create` calls `stop()` on the node it could not set up, which stops the network if it was started, waits for the executor if there is one, closes the environment and the verifier pool the node owns and releases the claim on the directory; a failure of that `stop()` is swallowed, and the error of `init` is the one thrown. The same process can then call `Node.create` on that directory again.

**5. The application.** `cfg.app` if given; otherwise a `CoreApp` on the env's `app` store. The genesis application state is parsed only if the store is empty (`CoreApp.hasState(kv)`), because a large genesis is streamed from its file once, at first start (DESIGN.md section 7). After state sync the store is not empty, so genesis is not parsed and the app opens at the snapshot height. Three options go to the application beside the retention and snapshot settings. `arenaBytes` is the config's, passed through. `indexTrees` is `false` when the setting is `'store'`, which it is unless the config says `'memory'` (the node reads it through its `indexTrees` getter, `this.cfg.indexTrees ?? 'store'`), and unset otherwise: `false` opens the database with its index trees left in the store, unset lets the application decide by the room. `heapRoom` is computed here, and only when the process runs under a heap limit (`heapLimitFlag()` of `src/node/memory.ts` finds a `--max-old-space-size`, which the CLI's `start` always sets): `Node.OPEN_FILL` (0.5, the share a rebuild is allowed) times the heap limit, less the heap in use now (`heapInUse(memoryStats())`, the old generation's use, as the guard measures it; `src/node/memory.ts` below), never below zero. It tells the application how much heap the trees of a stored state may take when it is opened; a tier estimated to need more is left in the store, and the node starts paged rather than running out of heap before the guard has taken its first sample ([chapter 11](11-application.md)). Without a heap limit the option is left unset and the store is opened whole. Two lines follow the application, whichever way it was made. With `'store'` the node calls `dropIndexTrees()` on the database, which does nothing to the `CoreApp` it has just opened without them and drops the trees of an application handed in through `cfg.app`. And if `retain.memoryVersions` is set and is less than the database's window in memory, the node calls `setHistoryWindow` with it, so the window in memory is shorter than the provable one from the start and never longer than what the store was opened with.

**6. The mempool.** Admission by `checkTx`, re-check after every commit.

```ts
    // Half the block at most, with the four bytes of its length: the block builder gives evidence no more than
    // the other half, so a transaction admitted here fits the next block it is first in line for.
    this.mempool = new Mempool(this.app, { maxTxBytes: Math.min(1024 * 1024, Math.floor(this.limits.maxBlockBytes / 2) - 4) });
```

The largest transaction the pool takes is 1 MiB, or four bytes under half the chain's block size where that is less; the four bytes are the length prefix a transaction is written with in a block, so what is bounded is the room it takes there. The block size bounds a block's transactions and evidence together (the header and the last commit are not counted, [chapter 4](04-consensus.md)), and the block builder drops evidence until it, with the builder's 1 KiB of slack, takes no more than half the limit, so the transactions of every block have at least the other half. A transaction admitted here therefore fits the next block it is first in line for, whatever evidence is waiting. Without the two halves it need not: with a 64 KiB limit a transaction of 32,768 bytes was admitted, thirteen ML-DSA-44 evidence records left it no room, and evidence arriving with every block could have kept it, and everything queued behind it, out for ever. With the default 4 MiB the limit is 1 MiB and the rule changes nothing in practice, since sixteen records are about 79 KiB. The limit is mempool policy, not a rule of validity. A block's validity bounds a transaction only through the block's size, which every node holds alike, so nodes cannot disagree about a block that carries a transaction the pool of one of them would have refused.

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
        // The node's own application keeps its state in the node's environment: a block's writes and its are one transaction.
        transaction: this.cfg.app ? undefined : (fn) => this.env.transaction(fn),
        protectedHeight: () => (this.app instanceof CoreApp ? (this.app.snapshotHeights().at(-1) ?? 0n) : 0n),
        // Read from the application each time: the executor asks after a block is applied, and a block that changed
        // the unbonding period is pruned behind with the new one, not the one in force before it.
        evidenceAgeMs: () => this.evidenceAge(),
      },
      this.cfg.genesis,
    );
    // The evidence age follows the unbonding period the application holds now, not the one genesis had.
    this.evidenceAge();
```

`open` loads the chain state or initialises it from genesis through `app.initChain`, refuses a data directory from another chain, and replays to the application any blocks it has not committed (crash recovery, [executor](05-mempool-executor.md)). `transaction` is the environment's, and it is given only when `cfg.app` is absent: the `CoreApp` the node created in step 5 keeps its state in the `app` store of the node's own environment, so the executor can save a block to the `chain` store and have the application commit to the `app` store inside one transaction, with one flush to the device where there were two ([chapter 5](05-mempool-executor.md)). The executor calls the application's commit inside that transaction, through `commitSync()` when the application has such a method and through `commit()` otherwise. `CoreApp` has only `commit()`, which is not an async function and does its store write before it returns, so a write that fails there throws inside the transaction and aborts the block's, the validator set's and the chain state's writes with the application's: nothing of the block is stored, and a restart finds chain and application at the same height. The `MemoryEnv` of a node without a data directory makes the same promise as LMDB's transaction: a throw out of the callback undoes what every store of the environment took inside it ([chapter 10](10-store.md)), so there too nothing of the block stays when the application's commit throws. An application handed in through `cfg.app` keeps its state wherever its maker put it, which the node cannot see, so the executor is given no transaction and the two commit one after the other, as they always did. `protectedHeight` keeps pruning from deleting the newest snapshot's block, so a snapshot can always be joined and then block-synced from (RPC-SYNC-PROOFS.md section 4.7, "never below the newest snapshot height"). `evidenceAgeMs` is the node's `evidenceAge()`:

```ts
  /** The evidence age in force now: the operator's figure, else the unbonding period the application holds. */
  private evidenceAge(): bigint {
    if (this.app instanceof CoreApp && this.cfg.limits?.maxEvidenceAgeMs === undefined) this.limits.maxEvidenceAgeMs = this.app.stakingParameters().unbondingPeriodMs;
    return this.limits.maxEvidenceAgeMs;
  }
```

It reads the unbonding period from the application each time, writes it into the shared `limits` object and returns it; when the operator pinned `limits.maxEvidenceAgeMs`, or the application is not a `CoreApp`, it returns the limit as it stands. The executor asks when it prunes, which is after a block has been applied and before the commit listeners run, so a block that lengthened the unbonding period is pruned behind with the new age, and pruning keeps the blocks of exactly the evidence window consensus enforces from the next height on. The call after `open` is for a restart: with the application open, its staking parameters say what the unbonding period is at this height, which after a governance change is not what genesis said, and a node that only read it on commit would check evidence against the genesis value from restart until its first commit. What a longer window cannot bring back is what a shorter one already let go: the heights pruned while the period was short are gone, and until a full window of the new length has passed a pruning node refuses evidence that names them, as evidence for an unknown height.

**8. The memory guard and the collection scheduler.**

```ts
    this.gcScheduler = new GcScheduler({ log: this.log, ...this.cfg.gc });
    this.memoryGuard = new MemoryGuard({
      log: this.log,
      ...this.cfg.memory,
      onLevel: (level, stats) => this.onMemoryLevel(level, stats),
      onSample: (level, stats) => {
        if (!(this.app instanceof CoreApp)) return;
        const est = this.rebuildEstimate(this.app.db);
        this.sinceRebuild++;
        if (est.indexTrees === 0 && est.trees === 0 && this.historyHeld === 0) return;
        // While something is dropped or trimmed, the heap of the last few samples, as the levels are taken from it: the
        // old generation's garbage between major collections included.
        this.sinceDrop = level === 'ok' ? this.sinceDrop + 1 : 0;
        this.recentHeap.push(heapInUse(stats));
        if (this.recentHeap.length > Node.REBUILD_WINDOW) this.recentHeap.shift();
        if (level === 'ok') this.rebuildWhatFits(stats);
      },
    });
```

Both take the node's logger and whatever `cfg.gc` and `cfg.memory` override. The guard's level callback is the node's own `onMemoryLevel`, which turns the database's dials and sheds load; its sample callback runs after every sample whatever the level. It counts the sample in `sinceRebuild`, the number of samples since something was last rebuilt or since the node started, which is what the wait before a rebuild is taken from. Then, while a tier of the database is dropped (the node's `rebuildEstimate`, below, says what rebuilding each would cost, zero for a resident one and for index trees the config keeps in the store) or its history window is trimmed (`historyHeld`, below), it counts in `sinceDrop` the samples in a row at `ok` (any other level sets it back to zero), keeps the last `REBUILD_WINDOW` heap figures (`heapInUse` of each sample, the figure the levels are taken from: under an old-generation limit that is the old generation, with whatever garbage it holds between two major collections and without the young generation's) and, at `ok`, asks `rebuildWhatFits` whether anything fits yet. Both are described below with the rest of the shedding. Neither runs yet: the guard's timer and the scheduler's observer start in `start()`. The guard takes one sample in its constructor, so `memoryGuard.stats` reads before `start()`, and the scheduler records the heap in use now as the baseline its first major collection is measured from. The two classes themselves are described after this file.

**9. Consensus.**

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

**10. Block sync.**

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

**11. The gossip handlers.** The fetched-block path first:

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

Passing `peer.id` into `handleProposal` and `handleVote` is what lets consensus skip the source when it re-broadcasts, and charge it for a bad signature. `messagesForPeer` returns every valid proposal (except fetched ones, which carry no real signature) and every vote held for the current height. Evidence still in the pool is announced by `inv` messages of its ids (`evidenceId` from `src/consensus/evidence.ts`), all of it (`list(Infinity)`; a plain `list()` stops at 100, and the proposer asks for `MAX_EVIDENCE_PER_BLOCK`, 16) in slices of 256, the most a `fetch` may name, so the new peer fetches what it lacks; RPC-SYNC-PROOFS.md section 4.4: "A newly connected peer receives every pending evidence key, in `inv` messages of 256, with its catch-up proposals and votes." DESIGN.md section 3 explains the choice: a flooded message is sent once, so a peer that was not connected at that moment never gets it, and one missing vote can stall a round; re-sending and catching up new peers "replaces Tendermint's per-peer state tracking with something far simpler at the cost of some bandwidth."

Inventory gossip for transactions and evidence:

```ts
    this.mempool.on('tx', (hash, _tx, source) => this.network.broadcast({ type: 'inv', kind: InvKind.Tx, hashes: [hash] }, source));
    this.evidencePool.onAdded((ev) => this.network.broadcast({ type: 'inv', kind: InvKind.Evidence, hashes: [evidenceId(ev)] }));
    // What a peer announces and we lack is fetched at most once while a fetch is outstanding, in batches the serving
    // side accepts. Each fetch is remembered with its kind and the peers it was sent to: only their answers are taken.
    // After ten seconds without one the item may be asked of another peer, of four at most, and an entry lives a
    // minute from its first fetch whatever is asked after. The entries are bounded in all and for each peer, so
    // peers that announce and never answer cannot make the node remember without limit. An entry is for one kind
    // and hash, so an announcement of one kind cannot stand in the way of another's, and its times are read from a
    // clock that never goes back, which the order of expiry depends on.
    const outstanding = new Map<string, { first: number; at: number; peers: Set<string> }>();
    const asked = new Map<string, number>();
    const release = (peer: string) => {
      const n = (asked.get(peer) ?? 1) - 1;
      if (n > 0) asked.set(peer, n);
      else asked.delete(peer);
    };
    const drop = (k: string, o: { peers: Set<string> }) => {
      for (const p of o.peers) release(p);
      outstanding.delete(k);
    };
    const wanted = (peer: string, kind: number, hashes: Uint8Array[], have: (h: Uint8Array) => boolean) => {
      const now = performance.now();
      // Entries stay in the order they were made, so the expired ones are the first.
      for (const [k, o] of outstanding) {
        if (now - o.first <= FETCH_LIFETIME_MS) break;
        drop(k, o);
      }
      const out: Uint8Array[] = [];
      let mine = asked.get(peer) ?? 0;
      for (const h of hashes) {
        if (mine >= MAX_OUTSTANDING_PER_PEER) break;
        if (have(h)) continue;
        const k = `${kind}:${toHex(h)}`;
        const o = outstanding.get(k);
        if (o) {
          // A peer already asked is not asked again, and does not push back the moment another may be.
          if (o.peers.has(peer) || now - o.at <= FETCH_RETRY_MS || o.peers.size >= 4) continue;
          o.at = now;
          o.peers.add(peer);
        } else {
          // Full: nothing new is remembered, but a hash further on that has an entry may still be due another peer.
          if (outstanding.size >= MAX_OUTSTANDING) continue;
          outstanding.set(k, { first: now, at: now, peers: new Set([peer]) });
        }
        mine++;
        out.push(h);
      }
      if (mine > 0) asked.set(peer, mine);
      return out;
    };
    /** Whether this peer was asked for this item within the last minute. The item settles the fetch; a peer that lacks it only steps out of it. */
    const answered = (peer: string, kind: number, hash: Uint8Array, found: boolean) => {
      const k = `${kind}:${toHex(hash)}`;
      const o = outstanding.get(k);
      if (!o || !o.peers.has(peer)) return false;
      // An answer that comes after the entry's minute is not one to a fetch still open.
      if (performance.now() - o.first > FETCH_LIFETIME_MS) {
        drop(k, o);
        return false;
      }
      if (found) drop(k, o);
      else {
        o.peers.delete(peer);
        release(peer);
        if (o.peers.size === 0) outstanding.delete(k);
      }
      return true;
    };
    // A peer that left will not answer. Its fetches are forgotten, so what it announces when it is back is asked again.
    this.network.onPeerGone((peer) => {
      if (!asked.has(peer.id)) return;
      for (const [k, o] of outstanding) if (o.peers.delete(peer.id) && o.peers.size === 0) outstanding.delete(k);
      asked.delete(peer.id);
    });
    this.network.on('inv', (peer, m) => {
      // A mempool that would refuse them (full, or its limit lowered under memory pressure) fetches nothing peers announce.
      const want = m.kind === InvKind.Tx ? (!this.mempool.accepting ? [] : wanted(peer.id, m.kind, m.hashes, (h) => this.mempool.seen(h))) : m.kind === InvKind.Evidence ? wanted(peer.id, m.kind, m.hashes, (h) => this.evidencePool.hasHash(h)) : [];
      for (let i = 0; i < want.length; i += 256) peer.send({ type: 'fetch', kind: m.kind, hashes: want.slice(i, i + 256) });
    });
```

A transaction admitted to the mempool is announced to every peer but the one it came from (`source` is `null` for a local submission, so then it goes to all). Evidence is announced to everyone, including the peer that sent it, which costs one `inv` that the sender ignores (it has the hash).

On the receiving side, `wanted` decides what to fetch. The mempool's `seen` cache and the evidence pool's `hasHash` cover what the node already holds or has already rejected, but a hash is only in them once the item has arrived and been checked; between the `fetch` and the `item` the node has nothing, and every peer that announces the same hash in that gap (several do, within milliseconds, for a transaction flooding through the network) would trigger another fetch. The `outstanding` map closes that gap: a hash is fetched at most once while a fetch for it is outstanding. An entry is keyed by the kind and the hash together (`${kind}:${toHex(h)}`), so an announcement of one kind cannot stand in the way of a fetch of the other kind under the same hash. Each entry holds the time of its first fetch (`first`), the time a peer was last asked (`at`) and the ids of the peers asked. Both times come from `performance.now()`, a clock that does not go back when the wall clock is set, which the order of expiry depends on. For ten seconds (`FETCH_RETRY_MS`) after a peer was asked the hash is not fetched again. After that a peer that never answered only delays the fetch rather than blocking it for good: the next `inv` from another peer fetches again, from the peer that announced it, and that peer joins the entry beside the first (four peers at most, after which the hash waits for the entry to go). A peer already in the entry is skipped and `at` is left alone, so a peer that repeats its announcement neither gets a second fetch nor pushes back the moment another peer may be asked.

The map is bounded, in all and for each peer. `MAX_OUTSTANDING`, 20,000, is the most entries it holds: a hash that would need one more is passed over, while a later hash in the same announcement that already has an entry may still be asked of this peer. `asked` counts, for each peer, the entries that peer is in, and `MAX_OUTSTANDING_PER_PEER`, 2,048, is the most it may be in: `wanted` stops reading a peer's announcement at that count, so a peer at its limit is asked nothing more until answers or expiry free places. `release` takes one off a peer's count and `drop` removes an entry and releases every peer in it. When a peer disconnects, the `onPeerGone` listener takes it out of every entry and forgets its count: it will not answer, and what it announces after reconnecting must be asked again, which an entry still naming it would prevent. Without the two limits a peer that announced hashes and never answered could make the node remember as many as it cared to send. An entry lives one minute (`FETCH_LIFETIME_MS`) from its first fetch, whatever was asked after: asking a second peer does not extend it. A `Map` iterates in the order its entries were made and `first` never changes, so the expired entries are the first ones, and the sweep at the top of `wanted` walks from the oldest and stops at the first that has not expired, instead of reading the whole map on every `inv`.

`answered` says whether a peer was asked: it returns true only when there is an entry for that kind and hash, the peer is among those asked and the entry's minute has not passed (an entry found past it is dropped there and the answer refused), and the `item` handler (keyed by `txHash` of the data for a transaction and `sha256` of the data for evidence, which is `evidenceId`) and the `itemNotFound` handler both go through it. An item settles the fetch and removes the entry; a peer that says it lacks the item only steps out of the entry, which goes when no asked peer is left, so the slow answer of the first peer is still taken after a second was asked and said no. The sweep runs whenever `wanted` runs, which is on every evidence `inv` and on every transaction `inv` that arrives while the mempool is accepting. While it is not accepting and no evidence is announced, nothing is swept and nothing is added, so older entries stay in the map until the next call, though `answered` no longer takes an answer for them. Fetches go out in slices of 256 hashes because that is what the serving side accepts (below); an `inv` of a thousand hashes would otherwise produce one `fetch` that the server trims and charges for. While the mempool is not `accepting` (it holds as many transactions as it admits just now, which under memory pressure is a lowered limit, or it is paused; below), announced transactions are not fetched at all: `addTx` would refuse them on arrival, so the fetch, the item and the check would be work for nothing; and since `wanted` is not called, nothing is marked outstanding, so the same hashes are fetched as usual once the pool has room and a peer announces them again. Evidence is fetched regardless: it is small, and a validator under pressure should still see a double sign.

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

Hashes are deduplicated and capped at 256 per fetch; a peer whose fetch needed trimming is charged 5 points ("an oversized or repetitive fetch 5" in the tariff of RPC-SYNC-PROOFS.md section 4.6). Before this, a peer could ask for one 2.5 KB transaction ten thousand times per message and never read the replies. The answers come back through the last two handlers:

```ts
    this.network.on('item', (peer, m) => {
      // An item nobody asked this peer for is dropped unread: a peer cannot push transactions or evidence past the
      // announce-and-fetch round, which is what bounds how much of either it can make this node check.
      if (!answered(peer.id, m.kind, m.kind === InvKind.Tx ? txHash(m.data) : sha256(m.data), true)) return;
      if (m.kind === InvKind.Tx) void this.mempool.addTx(m.data, peer.id);
      else if (m.kind === InvKind.Evidence) void this.acceptEvidence(peer.id, m.data);
    });
    this.network.on('itemNotFound', (peer, m) => void answered(peer.id, m.kind, m.hash, false));
```

An `item` is taken only if its hash was fetched from that peer with that kind, within the minute the entry lives. Then the fetch is settled and the data goes to the mempool (`addTx` with the peer id as source) or to `acceptEvidence`. Any other item, one nobody asked for, one asked only of other peers, one of the other kind, or one whose entry is more than a minute past its first fetch, is dropped without being decoded or checked, and the peer is not charged: the hash is all the node computes for it. Without that rule a peer could send items without announcing them and have every one checked against the application or the validator set; with it a peer can make the node check only what the node asked it for. An `itemNotFound` counts only when it comes from a peer that was asked, and takes only that peer out of the fetch, so a peer cannot clear another peer's outstanding fetch and have the hash fetched again from itself.

**12. After every commit.**

```ts
    this.executor.onCommitted((block) => {
      this.network.broadcast({ type: 'status', height: block.header.height });
      // The idle moment after a commit is where collections are least in the way.
      setImmediate(() => this.gcScheduler.afterCommit());
      this.evidenceAge();
    });
```

The `status` broadcast is how every peer's block sync learns that this node moved. The collection is scheduled through `setImmediate` rather than called: `afterCommit` runs a minor collection synchronously, and deferring it lets the rest of this commit's listeners (the RPC's event push among them) and whatever is already queued on the event loop finish first, so the pause lands in the gap before the next proposal arrives, where the previous version's garbage is fresh and nothing is waiting on the thread. The call to `evidenceAge()` is the evidence-age coupling described in the concepts: it leaves the shared limits at the unbonding period the committed block left, for the validation of the next height, and changes nothing when the operator pinned `maxEvidenceAgeMs` explicitly.

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
| `inv` | `Node.init` | `fetch` the hashes the mempool or evidence pool lacks and no fetch is outstanding for, 256 per message, within the limits on remembered fetches (20,000 in all, 2,048 for one peer); no transaction fetches while the mempool would refuse them (full, at a lowered limit, or paused) |
| `fetch` | `Node.init` | `item` or `itemNotFound` per hash, at most 256, 5 points if trimmed |
| `item` | `Node.init` | taken only if fetched from this peer with this kind within the last minute: settle the fetch, then `mempool.addTx(data, peer.id)` or `acceptEvidence`; otherwise dropped unread |
| `itemNotFound` | `Node.init` | take this peer out of the fetch if it was asked; the entry goes when no asked peer is left |
| `status` | `BlockSync` | record the peer's height, `check` |
| `blockRequest` | `BlockSync` | `blockResponse` from the store |
| `blocksRequest` | `BlockSync` | `blocksResponse`, up to 64 consecutive blocks and about 16 MiB |
| peer connected | `Node.init`, `BlockSync` | send the current height's proposals and votes and `inv`s of all pending evidence, 256 ids each; record the hello height |
| peer gone | `Requester`, `BlockSync` | fail its pending requests; forget its height |

#### The life of a transaction

1. A client calls `submitTx` (or the RPC does). `mempool.addTx(tx, null)` runs `app.checkTx`; on success the mempool stores it and emits `tx` with `source = null`. While the pool holds as many transactions as it admits (fewer than `maxTxs` when the node is short of memory) the call answers `full` instead and nothing else happens.
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
    // Evidence no later block could carry is not pooled: it would hold one of the pending places until the next
    // commit let it go. Measured at the last block's time, which is the earliest the next block's can be. The peer
    // is not marked for it: it may be ahead of this node, or hold history this node has pruned.
    const state = this.executor.state;
    if (evidenceAgeOk(ev.voteA.height, state.lastHeight + 1n, state.lastBlockTime, state, this.limits, (h) => this.executor.blockTimeAt(h))) return;
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

After decoding, and after passing over what the pool already holds, the evidence is held to the rule a block would hold it to, before any signature is verified: `evidenceAgeOk` of [chapter 4](04-consensus.md), asked for the next height at the last block's time, which is the earliest the next block's time can be, against the node's `limits`. Evidence older than `maxEvidenceAgeMs` by then, evidence for a height whose time the node does not hold, and evidence for a height beyond the one being decided are dropped: no later block of this node could carry the first, and pooled it would hold one of the pending places until the prune after the next commit. The peer is not charged for any of the three, since it may be ahead of this node or hold history this node has pruned. Evidence for a height whose validator set is unknown is likewise dropped silently. The pool itself refuses evidence it already holds, pending or committed, and anything more once 1,000 pieces are pending (`EvidencePool.MAX_PENDING`); `add` returns false then and nothing is logged or announced. Adding to the pool triggers `onAdded`, which announces it onward, so evidence created on one node reaches every validator and the next proposer includes it.

#### `onMemory`, `memoryLevel`, `isShedding` and `shed`

The guard reports every level change to `onMemoryLevel`, and the node decides what each level means:

```ts
  /**
   * Called on every change of the memory guard's level; the CLI stops the node on `critical`. A listener added once
   * the guard is sampling is told the level it is at, unless that is `ok`: a node already critical at its first
   * sample would otherwise never be reported, since a level that stays the same fires nothing.
   */
  onMemory(fn: (level: MemoryLevel, stats: MemoryStats) => void): void {
    this.memoryListeners.push(fn);
    if (this.started && this.memoryGuard.level !== 'ok') fn(this.memoryGuard.level, this.memoryGuard.stats);
  }

  get memoryLevel(): MemoryLevel {
    return this.memoryGuard.level;
  }

  /** True while load is shed: the mempool's limit is lowered, costly RPC methods and new streams are refused. */
  get isShedding(): boolean {
    return this.shedding;
  }

  /** The database's hot cache of decoded objects: unbounded while memory is fine, capped as it fills (STATE-PAGING.md section 7). */
  static readonly HOT_OBJECTS = { ok: Infinity, warn: 100_000, pressure: 10_000, critical: 10_000 } as const;

  /**
   * The share of its limit the mempool admits up to at each level. Every pooled transaction holds its bytes, its
   * writes in the pending state and its overlay entries, so the pool's size is a dial like the others; lowered in
   * steps, the node goes on admitting at the rate its blocks take transactions out instead of refusing everything
   * and then everything at once. At `critical` nothing is admitted: the node is about to stop.
   */
  static readonly MEMPOOL_SHARE = { ok: 1, warn: 0.5, pressure: 0.1, critical: 0 } as const;

  private onMemoryLevel(level: MemoryLevel, stats: MemoryStats): void {
    if (level === 'warn' || level === 'pressure') void this.gcScheduler.major();
    this.mempool.setLimit(this.mempool.maxTxs * Node.MEMPOOL_SHARE[level]);
    if (level === 'critical') this.mempool.pause('node out of memory');
    else this.mempool.resume();
    if (this.app instanceof CoreApp) {
      const db = this.app.db;
      db.setHotLimit(Node.HOT_OBJECTS[level]);
      // The second dial, from `warn` on: the index trees are dropped, every index read going to LMDB through the
      // overlay of the block in progress, and the window of past versions is cut to the last few, the store answering
      // for the rest. A loaded node commits more that way than with both in its heap (docs/benchmarks.md section
      // 4.13), so it does not wait for `pressure` to get there. The third, from `pressure` on: the Merkle trees are
      // dropped, every root and proof reading its paths from LMDB (STATE-PAGING.md section 7). Back at `ok` each is
      // rebuilt from LMDB when it fits.
      if (level !== 'ok') {
        db.dropIndexTrees();
        if (level !== 'warn') db.dropTrees();
        // What the window held, for letting it grow back.
        if (db.historyWindow > Node.HISTORY_WHEN_PAGED) {
          this.historyHeld = Math.max(1, this.historyHeld, db.historyEstimate());
          db.setHistoryWindow(Node.HISTORY_WHEN_PAGED);
        }
        this.deferredRebuild = null;
        this.recentHeap = [];
        // How long the node ran since it last had something rebuilt (or since it started) is how long the heap took
        // to fill: nothing is rebuilt until it has stayed at `ok` for as long again.
        this.rebuildAfter = Math.min(Node.REBUILD_WAIT_MAX, Math.max(Node.REBUILD_WINDOW, this.sinceRebuild));
        this.sinceDrop = 0;
      }
    }
    this.shed(level === 'pressure' || level === 'critical');
    for (const fn of this.memoryListeners) fn(level, stats);
  }
```

`warn` and `pressure` each start a major collection (the scheduler runs one at a time, so a request while one is running is dropped); every level sets the mempool's limit to its share of `maxTxs` from `Node.MEMPOOL_SHARE`, and pauses the pool at `critical` and at no other level; every level sets the object database's cache of decoded objects from `Node.HOT_OBJECTS`, through `setHotLimit` ([chapter 9](09-database.md)), on a core application (the key-value test app has no such database); every level but `ok` drops the index trees, `pressure` and `critical` the Merkle trees as well, and then, if the window in memory is still wider than `HISTORY_WHEN_PAGED` versions, the level cuts it to that after noting what it held; each of them also forgets what an earlier rebuild was waiting for, empties the remembered samples, and sets how long the node will wait at `ok` before it rebuilds anything (`rebuildAfter`, below); `pressure` and `critical` shed, `warn` and `ok` stop shedding; and every listener hears the change with the sample that caused it. `onMemory` also tells a listener added after the guard began sampling the level the node is already at, unless that is `ok`, so a node critical at its first sample is still reported. The whole table of dials, as built:

| level | heap in use of limit | cache of decoded objects | index trees | Merkle trees | history window in memory | mempool admits up to | load |
|---|---|---|---|---|---|---|---|
| `ok` | under 70% | unbounded | rebuilt once the node has waited and the estimate fits within half the limit | rebuilt once the estimate fits, after the index trees | let grow back once both tiers are resident and what it held fits | its limit (10,000) | admitted |
| `warn` | 70% | capped at 100,000 | dropped | left as they are | cut to the last 2 versions | half its limit (5,000) | admitted; a major collection started |
| `pressure` | 85% | capped at 10,000 | dropped | dropped | cut to the last 2 versions | a tenth of its limit (1,000) | shed: costly RPC refused, signature cache dropped |
| `critical` | 95% | capped at 10,000 | dropped | dropped | cut to the last 2 versions | nothing: paused | shed; the CLI stops the node |

The cache limit is the first dial: unbounded at `ok`, so a node with memory to spare keeps every object it has decoded and runs at full speed; 100,000 objects at `warn`; 10,000 at `pressure`, and `critical` keeps that. `setHotLimit` evicts the excess at once, and nothing else changes: an evicted object is decoded again from the database's arena of encoded bytes the next time it is read, about a microsecond for an account, so a capped node computes the same roots, only slower (a block of transfers among random accounts takes about twice as long, [benchmarks.md](../benchmarks.md) section 4.10). The second dial, turned from `warn` on, is the index trees together with the history window (below), and the third, from `pressure` on, the Merkle trees. `dropIndexTrees()` lets every type's B+ trees go; lookups and scans then read the index entries the application's commits have been writing to LMDB all along, with the writes of the block in progress laid over them. `dropTrees()` lets the dense trees' chunks and the sparse trees' nodes go; a root then reads the paths it changes from LMDB through a cache of chunks (4,096 of them, enough to hold the dense trees of about two million objects whole) and writes the changed ones back through the change list, and proofs walk the store. Both are cheap to turn (0.3 to 0.6 ms for the trees at 100,000 balances) and both may be turned with the mempool's pending session open, because the database builds the overlays from what is dirty ([chapter 9](09-database.md)). The order follows what each gives back and costs: at 192,000 accounts the index trees give back 181 MiB of heap (130 to 175 in an earlier build's run) and cost a block nothing it notices (a block of transfers between existing balances changes no index key; it still looks up each balance by owner and asset and checks the unique keys of what it writes, from the overlay and the store once the trees are gone, and its finalize gets faster without the B+ tree updates), while the Merkle trees give back 223 MiB (190 to 220 in that run) and cost about a seventh of throughput once dropped, 10.0 against 11.6 blocks a second, which is still no less than the 9.3 of the resident row; they cost more, 7.7 against 9.4, while the chunk cache held 256 chunks, fewer than the trees of this state have (docs/benchmarks.md section 4.13). That is also why the index trees go a level before the Merkle trees. As first built both went at `pressure`, and `warn` only capped the cache. But a loaded node commits more with its index trees in the store than with them in its heap, about a tenth more: a block of transfers changes no index key, and the lookups it does make, two balances by owner and asset for each transfer, are served from the store. The history window goes with them for the heap it holds; how much of it is in memory does not change the rate (below). Under the first rule the node reached that state only when the heap arrived at the pressure line, minutes into a full load. So `warn` pages what a block does not need, without refusing anything, and `pressure` drops what costs a block something and sheds load.

The history window is turned with the index trees, from `warn` on. The database keeps, for `retain.versions` past versions (100 by default), every object value a version overwrote and a record of every tree node it overwrote, which is what proofs and queries at past heights are answered from. Under load that is what still grew with the cache capped and both tiers dropped: a block of scattered transfers adds tens of thousands of records. `setHistoryWindow(HISTORY_WHEN_PAGED)` cuts the window in memory to two past versions, so that the current version and the two before it stay, forgetting the older ones at once ([chapter 9](09-database.md)); two in memory is enough for a proof at the height a client has just read to be made at full speed. Nothing a block does reads a past version, so consensus, execution and admission do not notice. The store is not touched: the application goes on writing each version's history record and deleting only the one that left the configured window ([chapter 11](11-application.md)), so a restart has the whole window back. A proof or a query at a height older than those is not refused either. The database was given the application's store of history records (`historyStore`) and reads such a version from them: it scans the record of every version after the one asked about and takes the first it finds for each entry it needs ([chapter 9](09-database.md), "Past versions from the store"). The answer is the same as from memory; it takes longer, the more so the further back the height, and it keeps nothing, so the cut costs a past read time and the node no memory. `lowestVersion`, and with it the application's `lowestProvableHeight`, does not move when the window is cut. Measured at 192,000 accounts under blocks of 440 to 570 transfers, such a proof takes 0.1 to 0.35 ms per height back, 20 ms at the oldest of a hundred in the published run, against a tenth of a millisecond or less from memory (docs/benchmarks.md section 4.13). The cut is made once: a level that finds the window already no wider than two versions, as `pressure` does after `warn`, leaves it and the note alone. Before the cut the node notes `historyEstimate()`, about the heap the window holds, in `historyHeld` (keeping the larger figure if an earlier one is still held, and at least 1 so that the field also says "trimmed"). The estimate counts the sparse trees' past versions whether those trees are resident or dropped: a dropped tree keeps records of them, and a resident one counts the nodes its retained commits replaced ([chapter 9](09-database.md)), so the note taken at `warn`, with the Merkle trees resident, is of the whole window.

The window in memory is also a setting. `retain.memoryVersions` says how many of the `retain.versions` provable past versions the node keeps in memory beside the current one; unset, it keeps all of them until memory fills. The node applies it when it has made the application (step 5 of `init`), and reads it through the getter `historyInMemory`, `Infinity` when unset, which is also what the window is widened to after the guard has trimmed it (below). The store keeps the whole window either way, and an older height is answered from the history records exactly as it is while the window is cut: 0.1 to 0.35 ms per version back, against a tenth of a millisecond or less from memory. The setting is for a node with a large heap. Such a node never reaches `warn`, so nothing trims its window, and it keeps the whole of it in its heap. What a short window gives such a node was measured with `bench/paging-node.ts`, which takes `BENCH_PAGING_MEMORY_VERSIONS` for it: 514,008 accounts under a heap of 3,126 MiB, twice the resident heap, 120 seconds, two runs each way. With the whole window the node committed 1,335 and 1,402 transfers a second, its heap reached 1,603 and 1,767 MiB at the twenty-second reports and its longest collection pause was 202 and 237 ms; with two versions it committed 1,246 and 1,348, on a heap that reached 1,141 and 1,057 MiB with a longest pause of 127 and 178 ms. So the setting is not shown to change throughput: the two runs of each setting differ from each other by as much as the settings do. It buys about 500 to 700 MiB of heap at that size and shorter pauses, and it costs the proofs at past heights, 13 to 33 ms fifty and a hundred versions back instead of a small fraction of a millisecond (docs/benchmarks.md section 4.13).

Whether the index trees are in memory at all is a setting too, and what the table says of them is a node with `indexTrees: 'memory'`: resident when they fit, dropped from `warn` on, rebuilt after the wait. The default is `'store'`, which makes a node that never builds them: the application is opened without them (step 5 of `init`), every index read goes to LMDB through the overlay of the block in progress, as it does after a drop, and the guard has no index trees to drop or to rebuild, so `status` shows `indexTrees: dropped` from the start, `warn` still caps the cache and cuts the window, and only the Merkle trees and the window are waited for and rebuilt. `'store'` is the one to keep unless the node mostly serves scans. Measured with `bench/paging-node.ts`, which takes `BENCH_PAGING_INDEX_TREES=store` or `=memory` for it, at 191,896 accounts under a heap of 1,488 MiB, 2.5 times the resident heap, for ten minutes: the node with `'store'` opened with 258 MiB of heap in use against 398 MiB with `'memory'`, a third less, and committed 1,508 transfers a second against 1,522, within 1% of each other, which is less than two runs differ by; the `'memory'` run's own stretches show the cost of the trees, 1,342 to 1,437 a second while they were in memory and 1,488 to 1,667 while they were dropped. It reached `warn` once, at 39 s, from the history window and the cache, where the `'memory'` run reached it twice, and had nothing to rebuild but the window (docs/benchmarks.md section 4.13). What `'store'` gives up is index reads from memory, an account by name or a scan. Measured with 200 reads a second of each kind beside the load (`BENCH_PAGING_READS=200`), a lookup by key takes 4 to 7 microseconds at the median with either setting and a page of twenty accounts in name order 31 to 34 microseconds from the store against 17 to 18 from memory, with a longer tail, while the three runs with `'store'` commit 13% more than the three with `'memory'`, 1,559 transfers a second against 1,385 on average; that is why it is the default. Proofs and the Merkle trees are unaffected.

The last dial is the mempool's limit, which is not the database's but is turned by the same level. Every pooled transaction holds its bytes, its signature-cache entry, the objects it touched pinned decoded in the pending session (where the cache cannot evict them) and its overlay entries; the paging benchmark's node held about 330 MiB more live heap with a full mempool than idle (STATE-PAGING.md section 7). So the pool admits up to its whole limit at `ok`, half at `warn`, a tenth at `pressure` and nothing at `critical`. `setLimit` evicts nothing ([chapter 5](05-mempool-executor.md)): what is pooled is still reaped, and transactions are admitted again as soon as blocks have taken the pool below the limit, so a node under pressure admits at the rate its blocks take transactions out. The node first paused the pool at `pressure` instead, which refused everything until `ok` and then admitted everything at once; admission through the fallbacks was always correct (`test/app.test.ts` checks transactions against dropped index trees and dropped Merkle trees), so there was no reason to refuse it entirely. Only at `critical`, when the node is about to stop, is the pool paused, with the reason `node out of memory`, and any level below resumes it.

Back at `ok` the trees are not simply rebuilt. The rule was first written that way and measured: dropping both tiers takes a large state from above the pressure line to well below the ok line in one go, rebuilding them takes the heap straight back over the pressure line, and a node under load dropped, read `ok`, rebuilt and read `pressure` again within a second or two, over and over, a second of rebuilding each time; the paging benchmark's node changed level 30 times in 40 seconds that way and committed 622 transfers a second, against 1,508 with the rule below and 1,634 and 1,771 in two runs of the node as it now stands (STATE-PAGING.md section 7; docs/benchmarks.md section 4.13). So a dropped tier is rebuilt only after a wait and only when it fits, and the history window is let grow back last:

```ts
  /**
   * The share of the heap limit a stored state's trees may fill when it is opened: what a rebuild is allowed
   * (REBUILD_FILL). Opened up to the warn line, a state the size of the heap ran just under `warn` and reached it
   * every ten seconds (docs/benchmarks.md section 4.13).
   */
  static readonly OPEN_FILL = 0.5;
  /** How many past versions stay in memory from `warn` on: enough for a proof at the height a client just read. */
  static readonly HISTORY_WHEN_PAGED = 2;
  /** About the heap the window of past versions held when it was trimmed, 0 while it is whole: what letting it grow back will take. */
  private historyHeld = 0;
  /** What the last deferred rebuild was waiting for, so the log says it once rather than at every sample. */
  private deferredRebuild: string | null = null;
  /** Guard samples since something was last rebuilt (or the node started), and samples in a row at `ok` with something dropped. */
  private sinceRebuild = 0;
  private sinceDrop = 0;
  /** How many samples after the last drop the node waits before it rebuilds anything; set at each drop, REBUILD_WINDOW at least. */
  private rebuildAfter = 0;
  /** The longest that wait gets: ten minutes at the default interval. */
  static readonly REBUILD_WAIT_MAX = 600;
  /** The index trees are left in the store unless the config asks for them in memory. */
  private get indexTrees(): 'memory' | 'store' {
    return this.cfg.indexTrees ?? 'store';
  }
  /** How many past versions the operator wants in memory (`retain.memoryVersions`); all of the window when unset. */
  private get historyInMemory(): number {
    return this.cfg.retain?.memoryVersions ?? Infinity;
  }
  /** Heap used at each guard sample since the last drop, the latest REBUILD_WINDOW of them. */
  private recentHeap: number[] = [];
  /** How many samples after a drop the heap is watched before anything is rebuilt: ten seconds at the default interval. */
  static readonly REBUILD_WINDOW = 10;
  /**
   * The share of the heap limit a rebuild may fill. Well below the warn line: what is rebuilt up to that line leaves
   * the load no room, and a node whose index trees just fitted spent minutes between `warn` and `pressure`, the
   * collector working on a nearly full old generation, committing a fifth less than it did with them dropped.
   */
  static readonly REBUILD_FILL = 0.5;

  /** What rebuilding the dropped tiers would take; index trees kept in the store by choice are not waiting to be rebuilt. */
  private rebuildEstimate(db: CoreApp['db']): { indexTrees: number; trees: number } {
    const est = db.rebuildEstimate();
    return this.indexTrees === 'store' ? { ...est, indexTrees: 0 } : est;
  }

  /**
   * At `ok`, rebuild what was dropped, but only what fits: dropping can take the heap from above the pressure line to
   * below the ok line in one go, and rebuilding all of it then would take it straight back, and the node would drop
   * and rebuild at every sample. One sample is not enough to judge by either: right after a major collection the old
   * generation reads lower than it will once the load has refilled it. And a load that filled the heap once fills
   * it again: trees rebuilt ten seconds after a drop were dropped again a few minutes later, the node committing less
   * while it had them. So nothing is rebuilt until the heap has stayed at `ok` for as long as the node had run before
   * the drop (`rebuildAfter`: REBUILD_WINDOW samples at least, REBUILD_WAIT_MAX at most), and then a tier is rebuilt when its estimated heap
   * (ObjectDatabase.rebuildEstimate) fits within REBUILD_FILL of the limit beside the highest of those samples, the
   * index trees first; otherwise it stays dropped, which the node runs fine on, and the guard asks again at every
   * sample while the level is `ok`.
   */
  private rebuildWhatFits(stats: MemoryStats): void {
    if (!(this.app instanceof CoreApp)) return;
    const db = this.app.db;
    const est = this.rebuildEstimate(db);
    if (est.indexTrees === 0 && est.trees === 0 && this.historyHeld === 0) return;
    if (this.recentHeap.length < Node.REBUILD_WINDOW || this.sinceDrop < this.rebuildAfter) return;
    const peak = Math.max(...this.recentHeap);
    let room = Math.min(Node.REBUILD_FILL, this.memoryGuard.o.warnAt) * stats.heapLimit - peak;
    if (est.indexTrees > 0 && est.indexTrees <= room) {
      db.rebuildIndexTrees();
      this.sinceRebuild = 0;
      room -= est.indexTrees;
      // The samples from before it do not count for the next tier: the heap is larger by that much now.
      this.recentHeap = this.recentHeap.map((h) => h + est.indexTrees);
      this.log('info', 'memory: index trees rebuilt', { estimate: `${Math.round(est.indexTrees / 1048576)} MiB` });
    }
    if (est.trees > 0 && est.trees <= room) {
      db.rebuildTrees();
      this.sinceRebuild = 0;
      room -= est.trees;
      this.recentHeap = this.recentHeap.map((h) => h + est.trees);
      this.log('info', 'memory: Merkle trees rebuilt', { estimate: `${Math.round(est.trees / 1048576)} MiB` });
    }
    const left = this.rebuildEstimate(db);
    // Last, with both tiers back: the window of past versions is let grow again, a root at a time, if what it held fits.
    if (this.historyHeld > 0 && left.indexTrees + left.trees === 0 && this.historyHeld <= room) {
      db.setHistoryWindow(this.historyInMemory);
      this.sinceRebuild = 0;
      this.log('info', 'memory: history window restored', { estimate: `${Math.round(this.historyHeld / 1048576)} MiB`, provableFrom: db.lowestVersion });
      this.historyHeld = 0;
    }
    const needs = left.indexTrees + left.trees + this.historyHeld;
    const waiting = needs > 0 ? `${Math.round(needs / 1048576)} MiB` : null;
    // Said once per drop: what is needed grows with the state, and a line at every MiB of it filled the log.
    if (waiting && this.deferredRebuild === null) this.log('info', 'memory: staying paged until the heap has room to rebuild', { needs: waiting, room: `${Math.round(Math.max(0, room) / 1048576)} MiB` });
    this.deferredRebuild = waiting;
  }
```

`rebuildEstimate` is the node's reading of the database's estimate, and the only place the setting enters the rebuild: with `indexTrees: 'store'`, set or defaulted (the getter `indexTrees` in the excerpt), it reports the index trees as needing nothing, so `onSample` does not count them as dropped, `rebuildWhatFits` neither rebuilds them nor counts them in what it is waiting for, and the Merkle trees and the history window are judged as if the index trees were resident. In the source it stands between `rebuildWhatFits` and that method's comment, as the excerpt shows.

Three things make the decision. The estimate comes from the database: every committed object has one entry in each index of its type and one leaf in each authenticated index's sparse tree, at 210 and 1,000 bytes of heap, which is what dropping them gave back at 192,000 accounts, within a few percent (STATE-PAGING.md section 10 lists the two constants among the defaults); for the sparse trees it also counts what a rebuild allocates and throws away, another 1,000 bytes a leaf, and 500 bytes for each record of a retained version ([chapter 9](09-database.md)). What it is compared with is not one sample. When the rule was written the guard read the whole heap, which right after a major collection was a few hundred MiB lower than a second later, and a rebuild judged on such a sample flapped just the same. The guard now reads the old generation under an old-generation limit, so the young generation's garbage is no longer in the figure, but the old generation's is: what was promoted and has died since the last major collection is counted until the next one, and a sample taken right after a major collection is still the lowest the node will show. So the node keeps the last ten samples (`REBUILD_WINDOW`; `onMemoryLevel` empties them at every drop) and takes the highest of them as the heap it has to live beside. Ten samples, ten seconds at the default interval, were at first also the whole wait before a rebuild, and that was too short. A load that filled the heap once fills it again: in a ten-minute run under a heap 2.5 times the state the index trees were rebuilt four seconds after each drop and dropped again a few minutes later, and the node committed less while it had them. With the wait described next, the same run made one rebuild instead of two: the index trees were dropped at `warn` at 32 s and rebuilt at 61 s, the node having run 32 s and so waited about as long at `ok`; they were dropped again at 211 s, and this time the node had run 150 s since the rebuild, waited as long, to 360 s, found no room (563 MiB needed) and stayed paged to the end. It committed 1,342 to 1,437 transfers a second while the index trees were in memory and 1,488 to 1,667 after the second drop, 1,522 over the ten minutes. So the wait follows how long the heap took to fill. At each level other than `ok`, `onMemoryLevel` sets `rebuildAfter` to `sinceRebuild`, the samples since something was last rebuilt or since the node started, at least `REBUILD_WINDOW` and at most `REBUILD_WAIT_MAX` (600, ten minutes at the default interval), and sets `sinceDrop` to zero. `rebuildWhatFits` returns without deciding anything until `sinceDrop` has reached `rebuildAfter`, that is until the level has been `ok` for that many samples in a row; a sample at any other level starts the count again. Every rebuild, the window's restoring included, sets `sinceRebuild` to zero, so a node that fills its heap two minutes after a rebuild waits two minutes at `ok` after the drop that follows, and one that took an hour waits ten minutes. And the room is what is left within `REBUILD_FILL` of the limit, half of it (or within the warn line, should a configuration put that lower): `Math.min(Node.REBUILD_FILL, warnAt) * heapLimit - peak`. The room was first taken to the warn line, 0.7, so that a rebuilt tier did not land the node at `warn` by construction, and that was measured too once the guard read the old generation: a node rebuilt its index trees whenever they just fitted under the warn line and then spent minutes between `warn` and `pressure`, the collector working on a nearly full old generation, collections taking 7 to 12% of its time against 4 to 5% with the trees dropped, and it committed about a fifth less, 1,050 to 1,280 transfers a second against 1,330 to 1,560. What is rebuilt up to the warn line leaves the load no room; half the limit leaves it a fifth of the heap before `warn`. Opening a stored state is judged against the same half (`OPEN_FILL`, 0.5). It was judged against the warn line at first; at the warn line a node with its index trees in the store opened its Merkle trees into a heap as large as its resident state and then ran 75 MiB under `warn`, visiting it 61 times in ten minutes; at half it opens paged and visits `warn` five times, committing 1,610 transfers a second against 1,478. The index trees go first, being cheaper and given back sooner; a tier that does not fit stays dropped, the node running on the fallbacks at `ok`, and the guard asks again at every sample while the level is `ok`, logging what it is waiting for once per drop (`deferredRebuild` is set by the first line and emptied by `onMemoryLevel` at the next drop, so the line is not repeated while the figure grows with the state; it was first compared with the figure, and a loaded node wrote the line at every MiB). Each tier rebuilt is taken off `room` and added to the remembered samples, so whatever is decided next in the same call counts it. The history window comes last: only when the estimate says nothing is left dropped, and `historyHeld` fits in the room that remains, is `setHistoryWindow(this.historyInMemory)` called (`retain.memoryVersions`, or `Infinity` when it is unset, which the database clamps to its configured retention) and `historyHeld` reset. The window does not come back at once, since what was forgotten is gone: it grows by one version at every root, which is why the log line `memory: history window restored` carries `provableFrom`, the oldest version that can be proven at that moment. Until then `historyHeld` is part of `needs` in the `staying paged` line. In the paging benchmark's node (`bench/paging.bench.ts` with `bench/paging-node.ts`: a single validator in a child process, so that its `--max-old-space-size` of 745 MiB over a 596 MiB resident state is V8's own limit, with its mempool kept two blocks ahead for 40 seconds; docs/benchmarks.md section 4.13) this is what happened: the store was opened with the Merkle trees and the history left in it, on 39 MiB, since they did not fit within half the limit; for the first twenty seconds the level was `ok`, the heap filling from 82 to 490 MiB, and the Merkle trees were not read back, 366 MiB needed for them against 269 MiB of room within half the limit; `warn` at about 21 seconds, at 526 of 745 MiB, cut the window in memory to two versions and capped the cache, and half a second later the heap read 100 MiB, `ok`; the node then ran at `ok` to the end, between 92 and 205 MiB, with the Merkle trees and the index trees in the store, 129 blocks and 72,092 transfers in 40.7 seconds, no visit to `pressure`, and no abort. In a run taken while the index trees and the window still went at `pressure`, that level came at 14.0 s, dropped both tiers and cut the window, and the next sample read 45 MiB; at 17.6 s the index trees were rebuilt and the Merkle trees stayed dropped, 451 MiB needed for them and the window against 185 MiB of room; that run committed 112 blocks and 61,364 transfers, 80 of the blocks with the Merkle trees dropped.

Shedding itself is the last method:

```ts
  private shed(on: boolean): void {
    if (on === this.shedding) return;
    this.shedding = on;
    if (on && this.app instanceof CoreApp) this.app.dropSignatureCache();
    this.log(on ? 'warn' : 'info', on ? 'shedding load: mempool limit lowered, costly requests refused' : 'load shedding over', { mempool: this.mempool.size, limit: this.mempool.currentLimit });
  }
```

`shed` is idempotent, so a guard that moves from `pressure` to `critical` does not drop the signature cache or log twice. Shedding is two things, the mempool's limit having been set by `onMemoryLevel` before `shed` is called (the log line reports it as `limit` beside the pool's size). The core application's signature cache is dropped: `dropSignatureCache` clears the verify cache of [chapter 11](11-application.md), 20,000 bodies at most, and the signatures of the transactions still pooled are then verified again when they reach a block, CPU spent to free heap. And `isShedding` turns true, which the RPC server reads to refuse costly methods and new event streams ([chapter 12](12-rpc.md)). `broadcastTx` is a costly method the server still serves then, since the mempool's lowered limit is what throttles it: at `pressure` a broadcast is admitted when the pool has room under a tenth of its limit and answered with `-32004` when it has not. The `critical` level is reported and nothing more: what to do then is the owner's decision. The CLI's `start` registers an `onMemory` listener that stops the node and exits with code 3 ([chapter 14](14-wallet-cli.md)); a test registers one that records the sequence.

#### `start`, `stop` and the accessors

`start()` starts the network (unless state sync already did), then block sync, then consensus; then it awaits one major collection from the scheduler (`gcScheduler.major()`, which does nothing without `--expose-gc`), because opening a store leaves garbage several times what it keeps and the guard's first sample would otherwise take it for a full heap; then the memory guard's sampling timer (unreferenced, so it never keeps the process alive on its own) and the scheduler's collection observer, and logs the height, the validator address if any, and the node id. The order matters: block sync must be listening for `status` before consensus starts, and consensus must start after the executor has replayed. `stop()` is one line over a private `shutDown()`, quoted with it:

```ts
  private stopping: Promise<void> | null = null;

  /**
   * Stopping twice is stopping once: a second caller waits for the first, and the claim is released when that one
   * is done. `beforeClose` is waited for once the node has stopped working and before its store is closed: whoever
   * still reads the store, an RPC server finishing its requests for one, is given until then. Only the first
   * caller's is used.
   */
  stop(beforeClose?: () => Promise<unknown>): Promise<void> {
    return (this.stopping ??= this.shutDown(beforeClose));
  }

  private async shutDown(beforeClose?: () => Promise<unknown>): Promise<void> {
    // Every step is tried whatever the ones before it did, and the first failure is the one the caller is given.
    let failed = false;
    let failure: unknown;
    const step = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        if (!failed) failure = e;
        failed = true;
      }
    };
    try {
      await step(async () => {
        if (this.started) {
          this.started = false;
          this.memoryGuard.stop();
          this.gcScheduler.stop();
          this.consensus.stop();
          this.blockSync.stop();
        }
        // The network may be up from a state-sync join even if start() was never called.
        if (this.networkStarted) {
          this.networkStarted = false;
          await this.network.stop();
        }
      });
      // A block being applied finishes its writes before the store goes away.
      await step(() => this.executor?.idle());
      await step(() => beforeClose?.());
      // The store the node opened, and also one it was handed for a directory it holds the claim on: the claim
      // says nobody else writes there, so it cannot be given up while that store is open.
      await step(() => (this.ownsEnv || this.releaseLock ? this.env.close() : undefined));
      await step(() => this.ownVerifier?.close());
    } finally {
      // Last: until the store is closed and the writes are done, another node on the directory would be writing
      // beside this one.
      this.releaseLock?.();
      this.releaseLock = null;
    }
    if (failed) throw failure;
  }
```

The first call starts the shutdown and keeps its promise in `stopping`; every later call is handed the same promise, and a `beforeClose` it brings is not used. Two callers stopping at once therefore wait for the one shutdown, and neither returns before the store is closed and the claim released. `shutDown()`, if `start()` ran, stops the guard and the scheduler, then consensus and block sync; then, if the network is up, stops it, which covers a node whose `init` started the network for a state-sync join and that was never started; then awaits `executor.idle()`, the tail of the executor's apply chain, so a block in the middle of its store batch or `app.commit` finishes its writes before the stores go away (`this.executor?.idle()`: a node whose `init` failed before the executor was opened has none); then awaits `beforeClose`, if the first caller passed one. The node has stopped working by then and its store is still open, so whoever still reads the store has until that promise settles: the command line passes the RPC server's stop, and a request still being served is answered from an open store ([chapter 14](14-wallet-cli.md)). `shutDown()` then closes the environment, if the node opened it or holds the claim on a data directory (`this.ownsEnv || this.releaseLock ? this.env.close() : undefined`), and after that the verifier pool if the node made it. Each of the five (stopping consensus, block sync and the network; the wait for the executor; `beforeClose`; the close of the store; the close of the verifier pool) is run through the local `step`, which awaits it inside a `try` of its own: "every step is tried whatever the ones before it did, and the first failure is the one the caller is given". A network that fails to stop therefore does not leave the store open, a `beforeClose` that rejects does not either, and a store that fails to close does not leave the node's verifier threads running. `step` keeps the first failure in `failure` and notes in the flag `failed` that there was one; later failures are dropped. The flag is separate from the value because a promise may reject with anything, `undefined` included, and a test of the value alone would take such a rejection for none. The five steps are inside a `try`, and the data directory lock is released last, in its `finally`: "until the store is closed and the writes are done, another node on the directory would be writing beside this one". Only then, if a step failed, is its failure thrown, so `stop()` rejects with the first failure, whatever value it is, and by the time the caller sees it everything that could be closed is closed and the claim is gone. That is why a store the caller handed in is closed here too when the node claimed a directory for it, as a test or a program that embeds a node may hand one (the command line's `start` leaves the store to the node): "the claim says nobody else writes there, so it cannot be given up while that store is open". Were it left to the caller, the claim would go first and a second node could open the directory while the first one's store was still open. `LmdbEnv.close()` closes once and hands every caller the promise of that one close ([chapter 10](10-store.md)), so the caller closing its store after `stop()` returns is harmless, and one closing it while the node is still closing it waits until it is shut. An environment handed to a node without a data directory, as the tests hand a `MemoryEnv`, stays the caller's. `test/review5-node.test.ts`, `closes a store it was handed for a directory it claimed before giving the claim up`, opens an `LmdbEnv` in a temporary directory, hands it to a node with that `dataDir`, and wraps the environment's `close` to note whether `LOCK` exists when it is first called. It stops the node twice at once (`await Promise.all([node.stop(), node.stop()])`): the file was there at the first close, it is gone once both calls have returned, and closing the environment again afterwards does not throw. `waits for whoever still reads the store before closing it, and releases the claim after`, in the same file, stops a started node with a `beforeClose` that sleeps 50 ms, loads block 1 from the node's store and notes whether `LOCK` exists: the block is read and the file is there, and the file is gone once `stop` has returned. A second node on the directory is then stopped with a `beforeClose` that rejects: `stop` rejects with that error and `LOCK` is gone all the same. A third is stopped with one that rejects with `undefined`: `stop` still rejects, with `undefined`, and `LOCK` is gone; and a fourth node opens on the directory. The wait for the executor matters for a node stopped while syncing: block sync hands the executor one block after another, and closing LMDB under a half-written one would leave the chain store and the application store at different heights, which `open` would then have to repair by replay on the next start. A verifier passed in the config is closed by neither `start` nor `stop`: the caller owns it because it is shared.

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

The default height is `lastHeight - 1`, the latest height whose next header exists. The result carries header `h + 1`, whose `appHash` commits to the proven state, and that header's commit, so a verifier needs nothing from this node that it cannot check. `queryAccountName` is the same shape with a `KeyProof` from `proveAccountName`. `queryTx(hash)` looks the transaction up in the store's index, returns its inclusion proof against its own block's `dataHash` and, once the next block exists and this block's execution results are in the store, its result proof against that header's `lastResultsHash` (RPC-SYNC-PROOFS.md section 2.2). A backfilled block is stored without results ([chapter 7](07-sync.md)), so a transaction in one comes with its inclusion proof and a `null` result proof. Both state queries duck-type the application (`typeof app.proofAt !== 'function'`) so a node on an application without proofs returns `null` instead of throwing.

### src/node/memory.ts

Purpose: the two objects the node wires in step 8, with no dependency on the node. **`MemoryStats`** is one sample: `heapUsed`, `heapLimit` and `heapTotal`, the first and last from `v8.getHeapStatistics`, an optional `heapOld`, the old generation's use, present only when the limit is the old generation's, and `arrayBuffers`, `external` and `rss` from `process.memoryUsage`, the memory outside the heap, where ML-DSA keys, the database's arena and stored bytes live. **`memoryStats()`** takes one, and both the limit it reports and the use that is compared with it need a word:

```ts
/**
 * The --max-old-space-size the process runs under, in MiB, or null when none was given. Node reads NODE_OPTIONS
 * first and its command line after, so a flag on the command line wins, and the last of several wins; V8 takes the
 * flag with dashes or underscores alike. Shared with the CLI's `start`, which must not put a limit of its own over
 * one the operator set.
 */
export function heapLimitFlag(execArgv: readonly string[] = process.execArgv, nodeOptions: string = process.env.NODE_OPTIONS ?? ''): number | null {
  const flags = [...splitNodeOptions(nodeOptions), ...execArgv];
  let mib: number | null = null;
  for (const f of flags) {
    const m = /^--max[-_]old[-_]space[-_]size=(\d+)$/.exec(f);
    // A size of 0 is V8's way of saying none was set: it sizes the heap itself, and the last flag wins.
    if (m) mib = Number(m[1]) || null;
  }
  return mib;
}

/**
 * The old generation's limit in bytes, when the process was started with one (--max-old-space-size, as the CLI does).
 * V8's heap_size_limit adds the young generation's reserve to it (three semi-spaces, 192 MiB with 64 MiB ones), which
 * long-lived objects never fill: the process aborts when the old generation is full, so on a heap of 744 MiB the
 * levels' lines, taken from 936 MiB, would sit past the point of the abort and `pressure` would never come.
 */
function oldGenerationLimit(): number | null {
  const mib = heapLimitFlag();
  return mib === null ? null : mib * 1048576;
}

const OLD_LIMIT = oldGenerationLimit();

/**
 * Bytes in use in every space but the young generation's two. Between two minor collections the young generation
 * holds up to a semi-space of garbage (64 MiB as `start` runs the node) that never reaches the old generation: counted
 * against an old-generation limit, it read as a full heap on a node with a small one, 162 MiB "of 153" a moment
 * before a collection left 42.
 */
function oldGenerationUsed(): number {
  let used = 0;
  for (const s of getHeapSpaceStatistics()) if (s.space_name !== 'new_space' && s.space_name !== 'new_large_object_space') used += s.space_used_size;
  return used;
}

export function memoryStats(): MemoryStats {
  const h = getHeapStatistics();
  const m = process.memoryUsage();
  const heapLimit = OLD_LIMIT !== null ? Math.min(OLD_LIMIT, h.heap_size_limit) : h.heap_size_limit;
  const stats: MemoryStats = { heapUsed: h.used_heap_size, heapLimit, heapTotal: h.total_heap_size, arrayBuffers: m.arrayBuffers, external: m.external, rss: m.rss };
  if (OLD_LIMIT !== null) stats.heapOld = oldGenerationUsed();
  return stats;
}

/** The bytes a sample's level is taken from, against its heapLimit: the old generation's when the limit is its, else the whole heap's. */
export function heapInUse(s: MemoryStats): number {
  return s.heapOld ?? s.heapUsed;
}
```

The figure that matters is the old generation's, because that is where the state lives and where the process aborts. V8's `heap_size_limit` is `--max-old-space-size` plus the young generation's reserve, 192 MiB on the machine measured, which long-lived objects never fill. The guard first took its lines from `heap_size_limit`, and the paging benchmark showed what that meant (STATE-PAGING.md section 7): with the CLI's `--heap 744` the lines were taken from 936 MiB, `pressure` at 85% of that sat past the point of the abort, and a node under load reached `warn` and then died of an out-of-memory error at 19.5 s without ever shedding. So when the process was started with `--max-old-space-size`, on the command line or in `NODE_OPTIONS`, `memoryStats` measures against that (`heapLimitFlag` finds the flag, with `splitNodeOptions` splitting `NODE_OPTIONS` at spaces the way Node does, double quotes grouping; the command line is read after `NODE_OPTIONS`, so it wins, and the CLI's `start` in [chapter 14](14-wallet-cli.md) uses the same function), and `heapLimit` is then the old generation's limit (a node started with `--heap 512` reports 512 MiB, not the 704 `heap_size_limit` would say); without the flag it falls back to `heap_size_limit`, which is all there is. A flag of zero is read as no flag: V8 takes `--max-old-space-size=0` as no limit of its own and sizes the heap itself, so `heapLimitFlag` returns `null` for it and the node measures against `heap_size_limit`. The last flag wins there as everywhere, so a zero after a size cancels the size, and a size after a zero stands.

The use has the same problem from the other side. `used_heap_size` counts every space of the heap, the young generation's among them, and between two minor collections the young generation holds up to a semi-space of garbage, 64 MiB as `start` runs the node (`--max-semi-space-size=64`), that will be collected where it lies and never reach the old generation. Set against an old-generation limit that garbage reads as a full heap on a node with a small one: a benchmark node under a 153 MiB limit logged `critical` at "162/153 MiB", and the next sample, after a collection, read 42 MiB. So under `--max-old-space-size` the sample also carries `heapOld`, the bytes in use in every space `v8.getHeapSpaceStatistics()` lists except `new_space` and `new_large_object_space` (`oldGenerationUsed`), and **`heapInUse(stats)`** is the one place that chooses: `heapOld` when the sample has it, `heapUsed` when it does not, which is a process without the flag or a test's invented sample. The guard's levels and log fields, the scheduler's growth test, the node's `recentHeap` and `heapRoom` (above) and the CLI's status line ([chapter 14](14-wallet-cli.md)) all go through it. `heapUsed` itself is unchanged and still reported: `status` spreads the whole sample ([chapter 12](12-rpc.md)), so under a heap limit it shows both. **`MemoryLevel`** is `'ok' | 'warn' | 'pressure' | 'critical'`.

**`MemoryGuard`** takes `MemoryGuardOptions`: `intervalMs` (1000), the three thresholds as fractions of the limit (`warnAt` 0.7, `pressureAt` 0.85, `criticalAt` 0.95), `hysteresis` (0.05), a `stats` source (`memoryStats` unless a test injects a function), the logger, an `onLevel` callback for every change of level and an `onSample` callback for every sample, with the level it left the guard at. The constructor refuses thresholds that do not rise or exceed 1 and takes a first sample; `start()` takes another at once and then one per interval on an unreferenced timer; `level` and `stats` read the current level and the last sample. `check()` is the whole mechanism:

```ts
  /** Take a sample and move the level; returns the level afterwards. */
  check(): MemoryLevel {
    const s = (this.last = this.o.stats());
    const fraction = heapInUse(s) / s.heapLimit;
    const thresholds = [this.o.warnAt, this.o.pressureAt, this.o.criticalAt];
    let idx = this.levelIndex;
    while (idx < thresholds.length && fraction >= thresholds[idx]!) idx++;
    while (idx > 0 && fraction < thresholds[idx - 1]! - this.o.hysteresis) idx--;
    if (idx !== this.levelIndex) {
      const rising = idx > this.levelIndex;
      this.levelIndex = idx;
      const level = this.level;
      const fields = { level, heap: `${MiB(heapInUse(s))}/${MiB(s.heapLimit)} MiB`, arrayBuffers: `${MiB(s.arrayBuffers)} MiB`, rss: `${MiB(s.rss)} MiB` };
      if (level === 'critical') this.o.log('error', 'memory: heap at the limit; stopping before the process aborts (raise --max-old-space-size or --heap)', fields);
      else if (rising) this.o.log('warn', level === 'pressure' ? 'memory: shedding load' : 'memory: heap filling', fields);
      else this.o.log('info', 'memory: easing', fields);
      this.o.onLevel?.(level, s);
    }
    this.o.onSample?.(this.level, s);
    return this.level;
  }
```

The two `while` loops are the hysteresis. Rising, the level climbs while the fraction is at or above the next threshold, so one sample can cross several levels (10% to 90% is straight to `pressure`); falling, it drops while the fraction is below the threshold of the level it is in, less the hysteresis, so a level entered at 85% is left at 80%, and a heap that hovers at 85% does not log, shed and resume on every sample. A change is logged once, with the heap in use (`heapInUse`, the figure the fraction was taken from) and the limit, the array buffers and the resident set in MiB, at `error` for `critical` (with the remedy in the message), `warn` on the way up and `info` on the way down, and then reported to `onLevel` with the sample; `onSample` hears every sample afterwards, change or not, which is how the node's conditional rebuild keeps asking at `ok`. Nothing else happens here: what a level means is the node's business.

**`GcScheduler`** takes `GcSchedulerOptions`: a `gc` function (the global one `--expose-gc` provides when the option is absent; `null` disables scheduling), a `stats` source, `majorGrowthBytes` (256 MiB) and `majorGrowthFraction` (0.1), `observe` (true) and the logger. `available` says whether anything can be scheduled. `start()` installs a `PerformanceObserver` on `gc` entries that counts every collection V8 runs by kind (minor, major or incremental, from the entry's `detail.kind` flags) with the total, longest and last pause, and logs once, without `--expose-gc`, that collections will run when V8 decides; `stop()` disconnects it; `stats()` returns a copy of the counts as `GcStats`, the object `status` serves ([chapter 12](12-rpc.md)). The two scheduling calls:

```ts
  afterCommit(): void {
    if (!this.gc) return;
    try {
      this.gc({ type: 'minor', execution: 'sync' });
      this.counts.scheduledMinor++;
    } catch (e) {
      this.log('warn', 'gc: minor collection failed', { err: (e as Error).message });
    }
    const s = this.stats_();
    const due = Math.min(this.growthBytes, this.growthFraction * s.heapLimit);
    if (heapInUse(s) - this.heapAtLastMajor >= due) void this.major();
  }

  /** Start a major collection now, without blocking the caller on it; one at a time. */
  async major(): Promise<void> {
    if (!this.gc || this.majorRunning) return;
    this.majorRunning = true;
    try {
      await this.gc({ type: 'major', execution: 'async' });
      this.counts.scheduledMajor++;
    } catch (e) {
      this.log('warn', 'gc: major collection failed', { err: (e as Error).message });
    } finally {
      this.majorRunning = false;
      this.heapAtLastMajor = heapInUse(this.stats_());
    }
  }
```

`afterCommit` runs a minor collection synchronously (the young generation: a few milliseconds, and the block just committed left plenty of short-lived garbage behind) and then, if the heap in use (`heapInUse` again: the old generation under a heap limit, which is what a major collection is for) has grown since the last major collection by the growth step, starts a major one. The step is the smaller of 256 MiB and a tenth of the limit, so a node with a small heap collects proportionally sooner. `major` asks for an asynchronous collection (`execution: 'async'`, so the caller is not blocked on it), runs one at a time, and measures the next growth from the heap as it stands after the collection finished, not from before it, so a collection that freed little does not postpone the next one by what it failed to free. Both count what they scheduled; the observer counts what V8 ran, which includes these and everything V8 decided on its own.

### scripts/localnet.ts

"The quickest way to watch the engine and the application work": N validators in one process on the memory transport, a faucet driving the core application, an RPC on the first node. Run with `node scripts/localnet.ts [validators=4] [seconds=30]`.

The genesis is built in code: a faucet account with a large balance, one operator account per validator, staking parameters, a community pool, and one validator per operator with its consensus key derived from a seed:

```ts
const genesis: Genesis = {
  chainId,
  signatureScheme: schemeName(DEFAULT_SCHEME),
  genesisTime: BigInt(Date.now()),
  appState: appGenesisBytes({
    accounts: [account('faucet', faucet.publicKey, '1000000000000'), ...operators.map((k, i) => account(`op${i}`, k.publicKey, '5000000000'))],
    staking: { minSelfBond: 1000, fixedRewardPerBlock: 1, downtimeWindow: 20, downtimeJailMs: 10_000 },
    communityPool: 10_000,
    validators: operators.map((_, i) => ({ operator: `op${i}`, consensusKey: toHex(keyPairFromSeed(seed(`val${i}`)).publicKey), selfBond: 2000 })),
  }),
};
```

There is no `validators` list at the engine level: the application owns the set (STAKING.md section 2.3). `signatureScheme` is the name of `DEFAULT_SCHEME`, ML-DSA-44 unless `CHAIN_SCHEME` is set in the environment (chapter 2), and every key the script derives with `keyPairFromSeed` follows the same default, so `CHAIN_SCHEME=secp256k1 node scripts/localnet.ts` runs the whole network on secp256k1 keys. Then the nodes:

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
  // The node opens the store itself, after it has claimed the directory: a second start on a directory in use
  // is refused before it has opened anything there.
  const made = await Node.create({
    name: cfg.name,
    genesis,
    dataDir: join(nodeDir, 'data'),
    nodeKeySeed: fromHex(cfg.nodeKeySeed),
    validatorSeed: cfg.validatorSeed ? fromHex(cfg.validatorSeed) : null,
    transport: new TcpTransport(),
    listenAddr: cfg.listenAddr,
    seeds: cfg.seeds,
    verifier,
    log,
    stateSync: cfg.stateSync ? { trustHeight: BigInt(cfg.stateSync.trustHeight), trustHash: fromHex(cfg.stateSync.trustHash), backfill: cfg.stateSync.backfill } : undefined,
    retain: cfg.retain,
    snapshotInterval: cfg.snapshotInterval,
    arenaBytes: arenaMb === null ? undefined : arenaMb * 1048576,
    indexTrees: cfg.indexTrees,
  });
```

The only differences from the localnet are the transport, the storage (only `dataDir` is passed, so the node claims the directory, opens an `LmdbEnv` under it and owns it), the state sync, retention and `indexTrees` options read from `config.json`, the arena's byte limit from the `--arena` flag, and what surrounds the constructor: the CLI runs it in a child process under a heap limit of its choosing (with `--max-semi-space-size=64` and `--expose-gc`), unless the operator has set a heap limit on the command line or in `NODE_OPTIONS`, in which case that limit is kept and the node runs in the process it was started in; it sets up its signal handlers before the constructor, so that a signal that comes while the node is being made is acted on once it is made; it stops the node, and exits with status 1, if the node's `start()` or the RPC server's fails; it reports the guard's level and the collection pauses in its status line, and stops the node with exit code 3 when the guard reports `critical`. The [wallet and CLI](14-wallet-cli.md) chapter covers the rest of that file.

### bench/network.bench.ts

The same pattern used to measure. `makeNet(genesis, validators, verifier, engineOnly)` builds a hub with 1 ms of latency and N validators with the fast timeouts, `lagGraceMs: 500` and `snapshotInterval: 0`, on either `KvStoreApp` (engine only) or the default `CoreApp`. Three measurements:

- Engine only: four validators on empty blocks for 8 seconds; blocks per second with a 50 ms commit timeout. README.md reports 8.9 blocks/s.
- The core application under load: 6,000 pre-signed transfers fed to one node, a batch of up to 200 every 20 ms while fewer than 3,000 are ahead of what is committed (the lead is tested before the batch is added, so it can reach 3,199), until all are in; transfers per second, blocks per second, largest block. README.md: 1,014 transfers/s over seven blocks, the largest a full 4 MiB.
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

The late node is a full node (`validatorSeed: null`) seeded with the validators' addresses. Its app hash is then held against what the validators agreed on. The validators go on committing while the node syncs, so the two are seldom at one height; the bench stops the late node, takes the height its application is at, waits up to 30 seconds for validator 0 to hold the block after that height, and compares the late node's app hash with the `appHash` in that block's header, which is the app hash the validators signed for the height. A difference throws, as does a validator that never produces the block, and agreement, printed as `block sync: app hash agrees with the validators` with the height, shows that replaying the blocks through block sync produced the same state as executing them live. README.md: 3,400 transfers/s for that sync. The bench ends by stopping every node and closing the shared verifier; finding 34 of the review (workers must not keep the process alive while idle, and must while a caller waits) came from exactly this kind of script.

## How it is tested

Most tests that run whole nodes build them through `makeTestnet` in `test/helpers.ts`, which is a compact version of the localnet: one `MemoryHub`, N validators plus optional full nodes, each seeded with every other address, the fast timeouts and network intervals, `lagGraceMs: 500`, the key-value test app by default or an `appFor` factory, and `makeNode(i, overrides)` to create extra or replacement nodes with the same seeds and genesis. The suites that use it are `consensus`, `engine`, `recovery`, `chain`, `light`, `staking-net`, `rpc`, `sync`, `schemes`, `review`, `review2`, `review4`, `review5-net`, `review5-node`, `review5-rpc` and `memory`. Not every case goes through it: the peer-layer cases in `test/network.test.ts`, and some in `review3`, `review4` and `review5-net`, construct `Network` objects directly, and a few node cases in `review3` and `review4` call `Node.create` themselves. The helper asks for `indexTrees: 'memory'` on every node it makes, or `'store'` when the suite runs under `INDEX_TREES=0`, so that dropping and rebuilding the index trees is exercised.

The cases that exercise the node's own wiring:

- `test/consensus.test.ts`, `transactions gossip to every node and land in state`: a transaction submitted to node 0 reaches every node's application, proving the `inv`/`fetch`/`item` path end to end; an invalid one is refused at admission.
- `test/consensus.test.ts`, `a late-joining full node catches up through block sync` and then follows live consensus, proving the `onBlockApplied → consensus.restart()` hand-over.
- `test/consensus.test.ts`, `adds a validator through the application and it starts signing` and `removes a validator and the set shrinks`: a full node is stopped and recreated with a validator key through `makeNode`, the application returns validator updates, and the commit two heights later carries the new validator's signature.
- `test/sync.test.ts`, `gossips evidence from a node that cannot propose, and decides a height from a fetched block`: forged duplicate votes are added to a full node's evidence pool; `onAdded` announces them; every validator's application records the slash at that height, proving `acceptEvidence` and the evidence inventory path. Then proposals are filtered away from validator 3, which keeps deciding through `requestBlock` and the `blockResponse` handler with `blockSync.synced === 0n`.
- `test/sync.test.ts`, `joins from a snapshot, serves queries at once, survives a corrupt chunk, and backfills to genesis`: `Node.create` with `stateSync` and `app: undefined`, `joinedAt` set, queries served at once, then `start()`.
- `test/review.test.ts`, `resumes after a restart that left a signature at the current height, by skipping that round`: a one-validator node on a temporary data directory is stopped, its `priv_validator_state.bin` is overwritten to claim a signed proposal at the next height, and a new `Node` on the same directory must make progress in a later round, proving the on-disk pieces (LMDB chain store, application store, signing guard) are reopened consistently.
- `test/review.test.ts`, `survives an aborted request body on the RPC`: an `RpcServer` on a node stays up after a client disconnects mid-body.
- `test/review.test.ts`, `refuses a second node on a data directory that is in use`: described under the constructor; the lock is released by `stop()` and the directory can be reopened.
- `test/review5-node.test.ts`, seven cases on the data directory. `is one directory however its path is spelled or linked to`: with a node holding `data`, a second `makeNode` on `data/.` and one on a symbolic link to it both reject with `in use by this process`, the `LOCK` file still holds this process's PID, and it is gone after `stop()`. `takes over the claim of a process that is gone and refuses that of one that runs`: a `LOCK` holding the PID of a child process that has exited is taken over, and one holding the parent's PID is refused with that PID named and left as it was. `takes a stale claim over only while holding the takeover file`: with a stale `LOCK` and a `LOCK.takeover` already in the directory, `makeNode` rejects with `LOCK.takeover may have been left by a process that stopped` and the stale `LOCK` is as it was; with `LOCK.takeover` removed the node is made, `LOCK` holds this process's PID and no `LOCK.takeover` is left. `stays claimed until the network is down, and is released after`: a transport whose `close` records whether the `LOCK` file exists sees it there, and it is gone once `stop()` returns. `closes a store it was handed for a directory it claimed before giving the claim up` and `waits for whoever still reads the store before closing it, and releases the claim after`: described under `stop()` above. `is given back, with the store, by a node that fails to open`: an application whose `initChain` throws makes `makeNode` reject with its error, no `LOCK` is left, and the same process opens a node on the directory afterwards.
- `test/review5-node.test.ts`, `reads the evidence age from the application when asked, not at the commit before`: on a core application with an unbonding period of 2,000 ms, the executor's `evidenceAgeMs` returns that period, and three times it as soon as the application's `stakingParameters` report the longer one, with no commit in between.
- `test/review5-node.test.ts`, `does not pool gossiped evidence that is already too old for a block`: with an evidence age of 1,500 ms and consensus stopped so that no commit prunes the pool, `acceptEvidence` leaves the pool empty for a double sign at height 1 once that height is older than the limit and for one two heights above the node's, and pools one at the node's own height.
- `test/review5-node.test.ts`, `takes an item only from the peer it asked for it`: a transaction one node broadcasts as an `item` without announcing it is neither seen by the other's mempool nor committed three heights later, while one submitted and announced the usual way reaches the other node and a block.
- `test/review5-node.test.ts`, `remembers a bounded number of fetches for a peer that announces and never answers`: one node of two announces 3,000 transaction hashes the other has never seen in a single `inv` and counts the hashes it is then asked for in `fetch` messages. The count reaches 2,048, `MAX_OUTSTANDING_PER_PEER`, and is still 2,048 after 300 ms more: the announcement is read in one go, before any `itemNotFound` could free a place.
- `test/review5-node.test.ts`, `takes the block size from the genesis, for every node alike`: a two-validator network whose genesis sets `consensus.maxBlockBytes` to 65,536 (`makeTestnet({ consensus })`), and a third node configured with `limits: { maxBlockBytes: 1024 }` against the type. 200 transactions of about 1 KiB are all admitted, one of half a block and more is `too-large`, and the third node follows the chain: the transactions are committed over more than three blocks, the largest of which, measured as `blockDataBytes` (its transactions and evidence), is over half the limit and not over it. The genesis survives `genesisToJson` and `genesisFromJson` with the figure, and 1,024, 64 MiB, 70,000.5 and the string `'65536'` in its place are each refused with `maxBlockBytes must be a whole number`.
- `test/review5-node.test.ts`, `gives evidence half a block at most, so the largest transaction admitted still fits`: on a one-validator chain whose genesis sets the smallest block size, 65,536, sixteen pieces of evidence are added to the pool and a transaction of 32,764 bytes, `maxTxBytes` on that chain, is `added`. It is committed in a block whose `blockDataBytes` is within the limit and whose evidence alone is within half of it, and all sixteen pieces of evidence are committed over the blocks that follow ([chapter 4](04-consensus.md)).
- `test/review5-node.test.ts`, `bounds a block by what its proposer chose, and a validator set by what a frame holds`: on a one-validator chain with the smallest block size, an empty block passes `validateBlockStructure`, a transaction that fills the limit exactly passes and one byte more is `block too large`; a set of 2,000 validators is made and one of 2,001 throws; and the largest block size with two commits of 2,000 ML-DSA-44 signatures is less than `MAX_FRAME` ([chapter 4](04-consensus.md), [chapter 3](03-types.md)).
- `test/review5-node.test.ts`, `reads a heap flag of zero as no flag`: `heapLimitFlag` returns `null` for a zero on the command line or in `NODE_OPTIONS`, with dashes or underscores, and for a zero that follows a size, and 512 for a size on the command line after a zero in `NODE_OPTIONS`.
- `test/memory.test.ts`, `sheds load, keeps following the chain, and resumes when the heap eases`: on a testnet of the core application, a full node made with `makeNode(2, { indexTrees: 'memory', memory: { stats, intervalMs: 20 }, log })`, which asks for the index trees in memory whatever mode the suite runs in ([chapter 15](15-tests.md)) and collects the log lines, has its guard fed invented samples. At first the database's `hotLimit` is `Infinity`. At 75% of the limit the level is `warn` and nothing is shed: `memory()` reports `indexTrees: 'dropped'`, `trees: 'resident'` and `history: 'trimmed'` with a `historyWindow` of 2, the `hotLimit` is 100,000, `mempool.currentLimit` is half of `maxTxs`, and `block` still answers. At 90% of the limit `isShedding` is true, the `hotLimit` is 10,000 with no more than that cached, `memory().indexTrees` and `memory().trees` are both `dropped`, the database reports `history: 'trimmed'` with a `historyWindow` of 2, `mempool.paused` is false and `mempool.currentLimit` is a tenth of `maxTxs`, `submitTx` answers `full` once the test has set the limit to zero, the RPC answers `broadcastTx` with `-32004` at that limit and with `-32002` once there is room again, refuses `block` and `/events` and reports every tier's mode under `status.memory.database`, the node still advances two heights behind the validators with its trees dropped (a hash that differed from theirs would stop it there), and an object proof at its height is byte for byte the proof a validator with resident trees makes. Then the limit is raised to four times what `rebuildEstimate()` says the cheaper tier would take and the heap set to 40% of it: shedding ends, the `hotLimit` is `Infinity` again and the mempool's limit is `maxTxs` again, but 100 ms later both tiers are still `dropped` and the test's logger has not seen the line `memory: staying paged`: the node is waiting at `ok` for as long as it had run before the drop, a few seconds of 20 ms samples here, and considers nothing yet. Within 30 seconds the line is logged, once, and 200 ms of further samples do not repeat it; both tiers are still `dropped`. The cheaper tier takes 25% of that limit: the room to the warn line is 30% of it, which would hold the tier, and the room to half the limit is 10%, which holds neither, so the test tells the two rules apart. Then the limit is raised again, to four times the two tiers' estimates together, and the heap set to 20% of it: the next samples rebuild them and then restore the history window (`memory().history` is `resident` again), `accountByName` answers on the resident trees, `submitTx` is not refused as `full` (the transaction is refused by the application, not by the limit), and `block` answers. At 99% the `critical` level is reported through `onMemory`, and the sequence seen is `warn`, `pressure`, `ok`, `critical`, the last two each reached by one sample crossing several thresholds. The guard and the scheduler have their own unit cases in the same file ([chapter 15](15-tests.md)).
- `test/memory.test.ts`, `keeps as many past versions in memory as retain.memoryVersions says, proves the older ones from the store, and leaves the index trees there when told to`: a single validator made with `makeNode(0, { retain: { memoryVersions: 3 }, indexTrees: 'store' })` runs to height 8. Its database reports `indexTrees: 'dropped'`, an account is found by name, and the trees are still dropped 300 ms later. Its database reports `history: 'trimmed'` with a `historyWindow` of 3, the application's `lowestProvableHeight` is at least six heights back, and `proofAt` and `rootAt` answer at the height six back, from the store's history records.
- `test/review4.test.ts`, `makes a verifier pool of its own when it is given none, and closes it when it stops`: a one-validator node created without a `verifier` has a `WorkerVerifier`, reaches height 2 with its blocks signed and checked through the pool, and after `stop()` a `verify` on that verifier rejects with `closed`.

## Limitations and ideas

- `requestBlock` asks every peer for a block by height, so each answers with a full block; one reply would do.
- Vote and proposal handling is not rate limited per peer (DESIGN.md section 10).
- State sync only works with the default `CoreApp`; `app` must be left out and `CORE_TYPES` is hardwired.
- The RPC has no authentication (DESIGN.md section 10).
- Evidence items are re-encoded on every fetch.
- The limits on remembered fetches are constants (20,000 entries, 2,048 for one peer, a minute's life, ten seconds before another peer is asked), not configuration. A peer that announces hashes and never answers holds its 2,048 places for a minute at a time, and during that minute nothing more it announces is fetched from it.
- The evidence age follows the unbonding period, but a window that grows cannot bring back what the shorter one let go: blocks and headers pruned under the shorter period are gone, and until a full window of the new length has passed a pruning node refuses evidence naming those heights.
- The data directory's claim is a file, not a lock the operating system holds, because Node's standard library has no such lock; what is listed here follows from that. The lock trusts the PID in the `LOCK` file: a PID recycled by an unrelated process makes a stale claim look live until that process exits. A process killed while it holds `LOCK.takeover`, which it does for a few file operations when it takes over a stale claim, leaves that file behind; it is never removed automatically, and a start that finds it beside a stale claim fails after fifty attempts, about a second, naming the file to remove by hand. A process killed between writing its private `LOCK.<pid>.<hex>` file and unlinking it leaves that file behind too; it is harmless and can be deleted. The claim is made with a hard link, so the data directory must be on a filesystem that has them.
- From `warn` until the history window has grown back, proofs and queries at heights more than two versions behind the current one (and at any time those older than `retain.memoryVersions`, when it is set) are read from the history records in the store, which is slower than from memory: every record after the height asked about is scanned and nothing is cached between reads. Only a restart reads the whole window back into memory at once. The recent transaction ids are still growth no dial sheds.
- The room a stored state is opened into is an estimate made from object counts before anything is built (STATE-PAGING.md section 9.1); a heap too small even for a state opened with both tiers left in the store still aborts at startup. `start()` runs one major collection before the guard's first sample, because opening leaves garbage several times what it keeps and the sample would otherwise read a node that fits as `critical` (measured at a third of the resident heap, docs/benchmarks.md section 4.13).
- The mempool's limit counts transactions, not bytes, and lowering it evicts nothing: a pool already above the lowered limit stays as large as it is until blocks reap it.
- ArrayBuffers (ML-DSA keys, stored bytes, the database's arena) sit outside the V8 heap and outside the guard's fraction; a machine that runs out of physical memory for them meets the operating system's killer, not V8's limit. The guard reports `arrayBuffers` and `rss` beside the heap figures, but acts on the heap alone. The arena can be bounded by hand with `arenaBytes` (the CLI's `--arena`), which no level turns.

Exercises:

1. On `onPeer`, also announce the mempool's pending transactions in `inv` batches, and measure what that costs on a busy chain.
2. Make `requestBlock` pick one peer whose precommit consensus saw (pass the peer id through `handleVote`), with a fallback to the broadcast after a timeout, and compare the traffic with the current broadcast by height.
3. Add a `status()` method to `Node` returning height, catching-up flag (`blockSync.isSyncing`), peer count and consensus step, and use it from the localnet ticker instead of reaching into fields.
4. Run the localnet over TCP: replace `hub.transport(...)` with a `TcpTransport` per node and `127.0.0.1:<port>` addresses, and compare the status lines.
5. Add a per-peer transaction rate limit in the `item` handler, charging points above it.
6. Replace the PID in the `LOCK` file with an advisory file lock that the operating system releases when the process dies. Such a lock needs neither the PID test nor `LOCK.takeover`, so it removes the lock's limitations: a recycled PID can no longer make a stale claim look live, no file is left behind for a hand to remove, and the claim needs neither a private file nor a hard link. Write a test that kills a node without `stop()` and restarts it on the same directory.
7. A past version outside the window in memory is read from the history records in the store (`'h'` keys, [chapter 11](11-application.md)), and nothing is kept between reads. Keep what one such read scanned for the next, bounded in size, and measure a run of proofs at one old height against the uncached reads; compare the bytes of each proof with the one an untrimmed node makes.

## Where to next

[The database](09-database.md) is the object store behind the application: typed objects with dense ids, indices, the Merkle root the app hash comes from, and the proofs the node's queries return.
