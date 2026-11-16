# 12. RPC

The RPC is the node's door for programs that are not peers: wallets, explorers, light clients and the command line. It is JSON-RPC 2.0 over plain HTTP on `node:http`, with a Server-Sent Events stream for pushes, per-address rate limiting and a body limit. It reads what the earlier chapters built: the [node](08-node.md) for height, mempool, peers and transaction queries, the [store](10-store.md) for blocks, commits and validator sets, and the [application](11-application.md) for objects, accounts, proofs and history. It feeds the two chapters after it: the [light client](13-light-client.md) has a provider that speaks to it, and the [wallet and CLI](14-wallet-cli.md) are nothing but RPC clients. Five files make it up: `src/rpc/json.ts` (how chain values look in JSON), `src/rpc/events.ts` (what the node pushes), `src/rpc/methods.ts` (the methods), `src/rpc/server.ts` (HTTP, limits, streams) and `src/rpc/client.ts` (a fetch-based client).

## Concepts

**JSON-RPC 2.0.** A tiny remote-procedure protocol on top of JSON. A request is an object `{ "jsonrpc": "2.0", "id": 1, "method": "status", "params": { ... } }`; the response carries the same `id` and either `result` or `error: { code, message }`. Several requests can be sent as one JSON array (a batch) and get an array of responses back. A request sent without an `id` is a notification: the server carries it out and does not answer it, not even with an error. The specification reserves error codes: `-32700` for unparseable JSON, `-32600` for a malformed request, `-32601` for an unknown method, `-32602` for bad parameters, and leaves `-32000` to `-32099` for the server's own errors. Tendermint and CometBFT expose their nodes the same way (JSON-RPC over HTTP, with methods such as `status`, `block`, `commit`, `validators`, `broadcast_tx_sync`, `broadcast_tx_commit` and `tx`), and the method names here follow theirs. `RPC-SYNC-PROOFS.md` section 3.2 fixes this chain's own codes: `-32001` not found, `-32002` check failed, `-32003` timeout, `-32004` rate limited.

**Why bigints and bytes need explicit JSON forms.** JSON has one number type, and every JavaScript JSON parser turns it into an IEEE double, exact only up to 2^53. Heights, times in milliseconds, token amounts and object ids are 64-bit integers in this chain, so they cannot travel as JSON numbers. JSON also has no byte type. The rule (`RPC-SYNC-PROOFS.md` section 3.2) is: bytes as lowercase hex without a prefix; 64-bit integers as decimal strings; small counters (a round, an index, a precision) as JSON numbers; object ids as `"type.n"`; times as decimal strings of unix milliseconds. Going out, one function (`jsonify`) applies the rule to any value. Coming back is harder, because a string in JSON does not say whether it was a number, an id or bytes, so decoding is written per shape (`headerFromJson`, `commitFromJson`, and so on).

**Proofs travel as hex of the binary encoding.** A proof produced by the [database](09-database.md) or by `src/types/txproof.ts` already has a deterministic binary encoding, and the verifiers decode exactly that. Re-expressing a proof as JSON would mean a second encoder and a second decoder that must agree with the first bit for bit. So the RPC never re-serialises a proof: it sends `toHex(proofToBytes(p))` and a client calls `proofFromBytes(fromHex(s))`. Raw transactions travel the same way. The spec says it in one line: "The RPC never re-serialises a proof."

**Deferred execution and the `height` parameter.** As chapter 11 explained, the state after block N is committed by the app hash in header N+1 (`DESIGN.md` section 6, "Deferred execution caveat"). So a proof about height N must be checked against header N+1. The methods that take a `height` and a `prove` flag serve the proof at that height; it is the caller's job to fetch header N+1 and its commit, and the light client's job to decide whether that header can be trusted.

**Committed versus live views.** The application's database keeps a pending session open while transactions are being checked for the mempool (chapter 11). A query that reads through that session would show state that no block has committed. The review of 2026-10-28 (`REVIEW-2026-10-28.md` finding 19) found several methods doing just that: "RPC queries expose speculative state and label current values with historical heights". The fix was to read objects with `app.db.getCommitted` ("the object as of the last `root()`, looking through every open session"). The index lookups that find an object by name or by owner still go through the live indices, which is why the finding is recorded as "fixed for account, validator and delegation; accounts list still scans live names". That was the state of things until the state queries were given a height of their own: `object`, `key`, `account`, `validator`, `delegation` and `balance` now answer as of one height, the one asked for or the last committed one, and find an object through an authenticated index by reading that index's own tree at the height, not the live index. The live indices remain where the code only needs to know where to look (an account's balance ids, the listings), and the object behind such an id is then read committed or as of the height.

**Token-bucket rate limiting.** Each remote address has a bucket holding at most `burst` tokens, refilled continuously at `ratePerSecond`. A request spends tokens; if the bucket cannot pay, the request is refused. The scheme lets a client burst briefly and then settle to the steady rate, and costs almost nothing to keep (one small object per address, dropped after ten idle minutes). Costly methods (state queries, proofs, history, broadcast) spend `costlyCost` tokens instead of one, and every call of a batch after the first spends one of its own. This is a plain defence against a careless or hostile client on a loopback or proxied endpoint; `DESIGN.md` section 10 lists "The RPC has no authentication; it is meant for loopback or a query node behind a proxy" among the known simplifications.

**Body limits.** A request body is refused in two places: if the declared `Content-Length` is already over the limit, before anything is read; and while reading, if the bytes received exceed it (a client can lie about the length or send chunked encoding). An aborted body used to escape the handler as an unhandled rejection and could take the process down (finding 13); the server now attaches an error handler to every request and catches everything from `handle`.

**Server-Sent Events.** SSE is the simplest push channel HTTP has: the server answers a GET with `Content-Type: text/event-stream` and never closes the response, writing records of the form

```
event: block
id: 42
data: {"height":"42",...}

```

separated by blank lines. Browsers have `EventSource` for it, and any HTTP client can read it as a stream. Two properties matter here. First, each record may carry an `id`; a client that reconnects sends the last id it saw in a `Last-Event-ID` header, and the server can replay what was missed. This chain uses the block height as the id, so replay is a scan of the block store from `Last-Event-ID + 1`. Second, SSE is one-directional and unframed, so filtering is done by query parameters at connection time (`types`, `tx`, `account`). The review found that replay could be asked for the whole archive at once and was neither capped nor charged (finding 25); it is now capped at the last 1000 blocks, charged like a costly call, and stops when the socket's write buffer is over a megabyte. A follow-up (finding 31) found that an unaffordable replay silently opened a stream with a gap in it; now the rate check runs before the headers are written and the stream is refused with 429 instead. Live pushes are guarded the same way: a stream that has more than a megabyte queued unread is ended, because a client that stops reading would otherwise make the server hold every event since, and the resume protocol is what makes dropping it safe.

**Broadcast modes.** Tendermint offers `broadcast_tx_sync` (returns after the mempool's check) and `broadcast_tx_commit` (returns after the transaction is in a block, with its result). The same two modes exist here, named `sync` and `commit`. Commit mode is built on the same internal listener that feeds the event streams: a waiter is registered for the hash before the transaction is submitted, so a block that lands at once cannot be missed.

**CORS.** Every response carries `Access-Control-Allow-Origin: *` and the server answers `OPTIONS` with 204, so a web page served from anywhere can call a node. That is deliberate for a loopback or explorer endpoint and is another reason there is no authentication to leak.

## The code, file by file

The files are presented in dependency order: `json.ts` and `events.ts` import from the chain's other modules but from no other file of `src/rpc`; `methods.ts` uses both; `server.ts` uses all three; `client.ts` stands alone.

### src/rpc/json.ts

Purpose: the one place that decides how chain values appear in JSON and how a few shapes are read back.

**`jsonify(value, key?)`** turns any value into JSON-safe form. Bigints become decimal strings, unless the key they sit under is one of the known id keys, in which case they become `"type.n"`; `Uint8Array` becomes hex; arrays and plain objects are walked recursively, passing the key down so that an array under `signals` renders each element as an id.

```ts
/** Keys whose bigint values are object ids. */
const ID_KEYS = new Set(['id', 'registrar', 'operator', 'delegator', 'validator', 'owner', 'asset', 'issuer', 'source', 'destination', 'proposer', 'coreAsset', 'account', 'signals', 'from', 'to', 'proposal']);

export function jsonify(value: unknown, key?: string): unknown {
  if (typeof value === 'bigint') return key !== undefined && ID_KEYS.has(key) ? idToString(value) : value.toString();
  if (value instanceof Uint8Array) return toHex(value);
  if (Array.isArray(value)) return value.map((v) => jsonify(v, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonify(v, k);
    return out;
  }
  return value;
}
```

Notice that the decision "is this bigint an id?" is made by field name, not by type. An `ObjectId` is a `bigint` at runtime (chapter 9: sixteen bits of type, forty-eight of instance, packed in one u64), so nothing else distinguishes it. The list must therefore name every field of every object type that holds an id; a new object type with an id field under a new name would render as a bare integer until the list is extended. Callers that jsonify a lone id pass the key explicitly, as in `jsonify(a.id, 'id')`. Bytes carry no type either: a public key or a signature travels as the hex of its tagged bytes (chapter 2), the scheme byte first, so an ML-DSA-44 key begins `01` and a secp256k1 key `02`, and `fromHex` on the way back hands the decoders the tag they read the size from.

**`parseId(s)`** requires a string and delegates to `idFromString`, which accepts only `"\d+.\d+"`. **`parseBigint(s, what)`** accepts a JSON number only when it is a safe non-negative integer (at most 2^53 − 1, since anything larger has already been rounded by the JSON parser and the value received is not the value sent), or a string of decimal digits; a negative number, a fraction, a hex string or a sign throws. **`parseHex(s, what)`** requires a string and delegates to `fromHex`; **`parseFixedHex(s, size, what)`** additionally requires exactly `size` bytes. These throw plain `Error`s; `server.ts` maps a plain `Error` thrown by a method to `-32602` (an `RpcError` keeps its code, and a `TxError` becomes `-32001`), so a bad parameter is reported as invalid params without each method having to say so.

**`headerFromJson(j)`** and **`commitFromJson(j)`** rebuild a `Header` and a `Commit` from the JSON `jsonify` produced, and validate the shape as they go: a header must be an object with a string `chainId`, `version` a safe non-negative integer, `height` and `time` through `parseBigint`, and every hash field and the `proposerAddress` exactly 32 bytes through `parseFixedHex`; a commit must carry a `signatures` array, a safe non-negative `round`, a 32-byte `blockHash`, and a `null` signature stays `null`:

```ts
export function headerFromJson(j: any): Header {
  if (!j || typeof j !== 'object' || typeof j.chainId !== 'string') throw new Error('header must be an object with a chainId');
  const version = Number(j.version);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('header version must be a non-negative integer');
  return {
    chainId: j.chainId,
    version,
    height: parseBigint(j.height, 'header height'),
    time: parseBigint(j.time, 'header time'),
    lastBlockHash: parseFixedHex(j.lastBlockHash, HASH_SIZE, 'lastBlockHash'),
    lastCommitHash: parseFixedHex(j.lastCommitHash, HASH_SIZE, 'lastCommitHash'),
    dataHash: parseFixedHex(j.dataHash, HASH_SIZE, 'dataHash'),
    lastResultsHash: parseFixedHex(j.lastResultsHash, HASH_SIZE, 'lastResultsHash'),
    validatorsHash: parseFixedHex(j.validatorsHash, HASH_SIZE, 'validatorsHash'),
    nextValidatorsHash: parseFixedHex(j.nextValidatorsHash, HASH_SIZE, 'nextValidatorsHash'),
    appHash: parseFixedHex(j.appHash, HASH_SIZE, 'appHash'),
    evidenceHash: parseFixedHex(j.evidenceHash, HASH_SIZE, 'evidenceHash'),
    proposerAddress: parseFixedHex(j.proposerAddress, HASH_SIZE, 'proposerAddress'),
  };
}
```

The exact-size rule is not pedantry. A header's hash is computed over its fields written one after another as fixed-width bytes with no length prefixes (chapter 3's `encodeHeader` uses `w.fixed` for every hash). A JSON header whose `appHash` is 31 bytes and whose `evidenceHash` is 33 bytes serialises to exactly the same bytes as the genuine header, so it hashes to the genuine block hash and the commit's signatures verify against it, yet a client that then checked a state proof against that 31-byte "app hash" would be checking it against the wrong value. With every field pinned to 32 bytes, bytes cannot move between fields, and a header that passes the parser is the header the validators signed or not a header at all. What the parser cannot judge, whether the header is the chain's, is still the light client's job, which hashes it and checks the commit.

**`validatorSetToJson(set)`** returns `{ hash, totalPower, proposer, validators: [{ address, publicKey, power }] }`. **`validatorSetFromJson(j)`** rebuilds the set with `ValidatorSet.create` from public keys and powers only:

```ts
/** Membership and powers come back; proposer priorities do not, which the light client never needs. */
export function validatorSetFromJson(j: any): ValidatorSet {
  return ValidatorSet.create((j.validators as any[]).map((v) => ({ publicKey: fromHex(v.publicKey), power: BigInt(v.power) })));
}
```

The light client only needs membership, powers and the hash, and the hash (chapter 3) does not cover priorities. `ValidatorSet.create` sorts, computes addresses and rejects duplicate members and non-positive powers, which is what closes review finding 1 (a duplicated key counted twice in the light client's overlap check) on the JSON path as well as on the binary one.

**`txQueryToJson(q)`** and **`txQueryFromJson(j)`** convert a `TxQueryResult` (from `src/light/verify.ts`): the two proofs as hex of their binary encodings, the two headers and commits as JSON, with `null` for the result leg when the next block does not exist yet.

### src/rpc/events.ts

Purpose: one listener on the executor fans out to two consumers, the event streams and the `broadcastTx` waiters.

**`TxLanded`** is `{ hash, height, index, ok, error }`: where a transaction ended up. **`CommittedEvent`** is what every listener receives: the `block`, its `commit`, the `results` of its transactions, the validator `updates` the application emitted, and the `history` entries written for this block (a list of `[accountId, HistoryEntry]`).

**`RpcEvents`** subscribes in its constructor:

```ts
  constructor(node: Node) {
    this.unsubscribe = node.executor.onCommitted((block, commit, results, updates) => {
      // A commit being announced while this is closed may still reach here once.
      if (this.closed) return;
      const app = node.app as Partial<CoreApp>;
      const history = Array.isArray(app.lastHistory) ? app.lastHistory : [];
      const e: CommittedEvent = { block, commit, results, updates, history };
      for (const fn of this.listeners) fn(e);
      block.txs.forEach((tx, i) => {
        const set = this.waiters.get(toHex(txHash(tx)));
        if (!set) return;
        const r = results[i]!;
        for (const w of set) w({ hash: txHash(tx), height: block.header.height, index: i, ok: r.ok, error: r.error ?? '' });
      });
    });
  }
```

`lastHistory` is a property of `CoreApp` (chapter 11); the cast to `Partial<CoreApp>` lets the engine run with the key-value test application, which has no history, and then the list is empty. The executor's `onCommitted` fires after a block is committed, once per block, in order, and returns a function that takes the listener out of the executor's list again; the constructor keeps it as `unsubscribe`.

**`onCommitted(fn)`** registers a listener and returns an unsubscribe function. **`close()`** ends the object's work, for a server that is stopping:

```ts
  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.listeners.clear();
    for (const set of [...this.waiters.values()]) for (const w of [...set]) w(null);
  }
```

It gives the executor its callback back, lets every listener go, and answers every caller waiting for a transaction with `null`, as a timeout would, so a commit-mode broadcast in flight returns at once instead of holding its connection until its own timer. The `closed` flag covers the one commit that may be going round the executor's listeners while `close()` runs.

**`waitForTx(hash, timeoutMs)`** returns `{ promise, cancel }`, or `null` when `MAX_WAITERS` (1000) waiters are already outstanding across all callers or the events are closed:

```ts
  waitForTx(hash: Uint8Array, timeoutMs: number): { promise: Promise<TxLanded | null>; cancel(): void } | null {
    if (this.closed || this.waiting >= MAX_WAITERS) return null;
    this.waiting++;
    let counted = true;
    const uncount = () => {
      if (counted) this.waiting--;
      counted = false;
    };
    const k = toHex(hash);
    let set = this.waiters.get(k);
    if (!set) this.waiters.set(k, (set = new Set()));
    let resolveFn: (t: TxLanded | null) => void = () => {};
    const cleanup = () => {
      uncount();
      set!.delete(handler);
      if (set!.size === 0) this.waiters.delete(k);
      clearTimeout(timer);
    };
    const handler = (t: TxLanded | null) => {
      cleanup();
      resolveFn(t);
    };
    const timer = setTimeout(() => handler(null), timeoutMs);
    set.add(handler);
```

Four outcomes, all through `handler` and its `cleanup`: the transaction lands, the timer fires (`null`), the caller cancels (`null`), or the events are closed (`null`). Waiters are keyed by hex hash so several callers can wait for the same transaction, and the map entry is removed when the last one leaves, so an abandoned wait leaves nothing behind. The promise's `resolve` is captured in `resolveFn` inside the `new Promise` executor, which runs synchronously, so it is in place before anything can fire. The cap is there because every waiter is a timer, a closure and an open HTTP connection held for up to the timeout: a client that opened commit-mode broadcasts as fast as the rate limit allowed and never read the answers would pile them up without bound. `waiting` counts each waiter exactly once (`counted` makes `uncount` idempotent, since `cleanup` can run from more than one path), and beyond the cap `broadcastTx` tells the caller to fall back to sync mode and poll `tx`, which costs the server nothing between calls.

**`blockEventJson(block, results)`** is the `block` event body: height, hash, time, transaction count, the number that `failed`, app hash and proposer, all in the JSON forms above. The spec calls the `failed` item a "results summary"; here it is one number. The function takes the block and its results and not a `CommittedEvent`, so that a block pushed at its commit and one replayed from the store have the same fields:

```ts
export function blockEventJson(block: Block, results: TxResult[] | null): unknown {
  return {
    height: block.header.height.toString(),
    hash: toHex(blockHash(block)),
    time: block.header.time.toString(),
    txs: block.txs.length,
    failed: results ? results.filter((r) => !r.ok).length : block.txs.length === 0 ? 0 : null,
    appHash: toHex(block.header.appHash),
    proposer: toHex(block.header.proposerAddress),
  };
}
```

`failed` is counted from the results. Without results it is 0 for an empty block and `null` for a block that has transactions: that is a block the node fetched after a state sync and stored without executing, so it holds no results for it (chapter 10's `loadResults` returns null).

### src/rpc/methods.ts

Purpose: the methods, each a function of a parameter object, reading the node and its application. Section 3.3 of `RPC-SYNC-PROOFS.md` is the contract.

**`RpcError`** carries a `code` with the message. The codes are exported constants: `NOT_FOUND = -32001`, `CHECK_FAILED = -32002`, `TIMEOUT = -32003`, `RATE_LIMITED = -32004`, `INVALID_PARAMS = -32602`. **`RpcMethod`** is `{ costly?: boolean; whileShedding?: boolean; fn(params): Promise<unknown> }`; `costly` is what the server reads to charge five tokens instead of one and to refuse the call while the node sheds load, and `whileShedding` exempts a costly method from that refusal (`broadcastTx` alone sets it). One module constant, `MAX_COMMIT_WAIT_MS = 120_000`, bounds how long a commit-mode broadcast may hold a connection open.

Helpers, all private to the module:

- `coreApp(node)` returns `node.app` if it is a `CoreApp`, else throws `NOT_FOUND` with "this node does not run the core application". Every application-level method begins with it; the engine-level ones (`status`, `genesis`, `header`, `block`, `commit`, `validators`, `validatorSet`, `tx`, `broadcastTx`, `mempool`, `peers`, `snapshots`) work with any application.
- `heightParam(node, p, name)` returns `node.height` when the parameter is absent, else `parseBigint`.
- `num(p, name, fallback)` returns the fallback when the parameter is absent and otherwise requires a JSON number that is a safe non-negative integer; `bool(p, name)` is false when absent and otherwise requires a JSON boolean (`prove` and `reverse` go through it); `str(p, name)` requires a string. All three throw `INVALID_PARAMS`:

```ts
function num(p: Record<string, unknown>, name: string, fallback: number): number {
  if (p[name] === undefined) return fallback;
  const n = p[name];
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new RpcError(INVALID_PARAMS, `${name} must be a non-negative integer`);
  return n;
}

function bool(p: Record<string, unknown>, name: string): boolean {
  if (p[name] === undefined) return false;
  if (typeof p[name] !== 'boolean') throw new RpcError(INVALID_PARAMS, `${name} must be true or false`);
  return p[name];
}
```

  The parameters are typed strictly, with no coercion, and `-32602` is what the JSON-RPC specification reserves for exactly this: "invalid method parameter(s)". A server that coerced would accept a call and then silently do something other than what was asked. `prove: "false"` is a non-empty string, so a truthy test would build a proof the caller did not want and charge for it; `limit: "5"` would become `NaN` in a comparison and fall through to whatever the code did with that. Refusing the call with a message naming the parameter costs the client one round trip and makes the mistake visible at the first attempt.
- `typeByName(name)` finds an object type in `CORE_TYPES` by its name (`'account'`, `'validator'`, ...).
- `stateHeight(app, p)` is the height a state query is about: the last committed one unless `height` names another, which must be one the application still holds, from `lowestProvableHeight` to `lastHeight`; outside that it throws `NOT_FOUND` with `the state at height H is not kept (heights A to B are)`.
- `keyAt(app, type, index, k, height)` reads an authenticated unique index at a height and returns `{ id, proof }`; it is shown below.
- `objectAt(app, type, id, height)` is an object as of a height: `getCommitted` at the last height, `getAt` at a past one.
- `accountRef(app, ref, height)` accepts a name or a `"type.n"` id string and returns an id; a name is looked up with `keyAt` in the `byName` index at the height, and one that has no account then, or that no account can have, is `NOT_FOUND`. `validatorRef(app, ref, height)` accepts a validator id, or the validator's operator by account name or account id: a string of the form `"type.n"` whose type is not the account type is returned as the validator id, and anything else, a name or an account id such as `3.4`, is resolved through `accountRef` and then `keyAt` on the `byOperator` index at the height. An account that ran no validator then is `NOT_FOUND` with `<ref> runs no validator`. Both `validator` and the `validator` parameter of `delegation` go through it.
- `balancesAt(app, owner, height)` is an account's balances as of a height. Its comment gives the reasoning: "A balance object is never removed, so the ones the account has now are all it ever had, and each is read as it was then; one created since reads as absent."
- `decodeHistoryEntry(e)` decodes a history entry's `data`: an operation for kind `operation`, otherwise the virtual operation's fields through `decodeVirtualData`.

**`makeMethods(node, events)`** builds the method table. It closes over `stored(height)`, which loads a block and its commit from the store or throws `NOT_FOUND` with `` `no block ${height}` ``.

The complete reference follows. "Costly" means the method spends `costlyCost` (default 5) tokens of the caller's bucket; `RPC-SYNC-PROOFS.md` section 3.1 names them: `block`, `object`, `key`, `account`, `validator`, `delegation`, `balance`, `accountHistory`, `tx`, `broadcastTx`, `accounts` and `proposals`, whether or not a proof is requested. Parameters marked `?` are optional. All heights, amounts and times are decimal strings unless noted; hashes, keys and proofs are hex; ids are `"type.n"`.

| method | parameters | result | errors | costly |
|---|---|---|---|---|
| `status` | none | `{ chainId, version (number), signatureScheme ('ml-dsa-44' or 'secp256k1'), latestHeight, latestHash (hex or null), latestTime, appHash, catchingUp (bool), lowestHeight, joinedAt (string or null), peers (number), validatorAddress (hex or null), memory: { level, shedding (bool), heapUsed, heapLimit, heapTotal, arrayBuffers, external, rss (numbers, bytes), heapOld (bytes; only when the process runs under `--max-old-space-size`, as `start` runs it: the old generation's use, which the level is taken from), database: { arena: { slabs, capacity, used, dead }, arenaLimit (number, or null when unbounded), storedObjects, objects ('resident' or 'capped'), hotObjects, hotLimit (number, or null when unbounded), historyBytes, history ('resident' or 'trimmed'), historyWindow, lowestVersion, indexTrees ('resident', 'dropped' or 'partial'), trees ('resident' or 'dropped'), treeChunks, treeChunkLimit, hotHits, hotMisses, chunkHits, chunkMisses (numbers) } or null }, gc: { available (bool), collections, minor, major, incremental, totalMs, maxMs, lastMs, scheduledMinor, scheduledMajor (numbers) }, rpcVersion: 1 }` | none | no |
| `genesis` | none | the genesis document as `genesisToJson` writes it, with `appStateFile` removed | none | no |
| `header` | `height?` (default latest) | the header: `chainId, version, height, time, lastBlockHash, lastCommitHash, dataHash, lastResultsHash, validatorsHash, nextValidatorsHash, appHash, evidenceHash, proposerAddress`; below a state-synced node's lowest block, a header it keeps alone | `-32001` no block and no header | no |
| `block` | `height?` | `{ header, txs: hex[], lastCommit (or null), evidence, commit }` | `-32001` | yes |
| `commit` | `height?` | `{ height, round (number), blockHash, signatures: (hex or null)[] }` | `-32001` | no |
| `validators` | `height?` | `{ height, hash, totalPower, proposer, validators: [{ address, publicKey, power }] }`, `proposer` being an address or `null`: the set that signs that height, from the executor's `validatorSetAtHeight` ([chapter 5](05-mempool-executor.md)). The proposer is that of the height's first round wherever the set is still held by height, which is every height the node applied, and the one whose snapshot it joined at, while the block is not pruned; for a block backfilled below a state-sync join, or a header kept alone, the set is read by hash, whose proposer is a later height's, so the executor's `hasProposerAt` is false and the method returns `proposer: null` in place of it | `-32001` no set for that height | no |
| `validatorSet` | `hash` | the same shape without `height`, for a set stored by hash | `-32001`; bad hex is `-32602` | no |
| `object` | `id`, `height?`, `prove?` | `{ type (name), height, object (decoded or null), proof? }` | `-32001` not core app, or a height whose state is not kept; `-32602` unknown type or bad id | yes |
| `key` | `type` (name), `index` (name), `key` (hex), `height?`, `prove?` | `{ height, id (or null), proof? }`: the id the key mapped to at `height`, which is what the proof proves | `-32001` a height whose state is not kept; `-32602` unknown type or index, bad hex | yes |
| `account` | `name`, `height?`, `prove?` | `{ height, account (or null), balances: [{ asset (symbol), assetId, precision (number), amount }], validator (id or null), history (count), proof? }`; the last three only when the account exists, and all of it as of `height` | `-32001` a height whose state is not kept; `-32602` name not a string, or `prove` for a name no account can have | yes |
| `validator` | `operator` (an account name or account id) or `id` (a validator id; either parameter takes any of the three), `height?` | `height` and the validator object as of it, plus `status` (`candidate`, `jailed`, `tombstoned`), `active` (bool), `power`, `selfBond` (from the operator's delegation at the height), `delegators` (the number of delegations it had at the height), `operatorName` | `-32001` no such validator or operator, an account that runs no validator, or a height whose state is not kept | yes |
| `delegation` | `delegator`, `validator` (a validator id, or its operator's name or account id), `height?`, `prove?` | `{ height, delegation (the object as of `height` plus `tokens`, or null), unbonding: [the entries pending as of `height`], proof? }` | `-32001` no such validator or account, or a height whose state is not kept | yes |
| `balance` | `account`, `asset?` (default the core asset), `height?` | `{ height, account, asset, amount }`, the amount as of `height`; 0 for an id that had no such balance then | `-32001` no account of that name at the height, or a height whose state is not kept | yes |
| `accountHistory` | `account`, `from?` (the sequence to start at, or with `reverse` how many of the newest entries to skip; default 0), `limit?` (default 20, at most 100), `reverse?` | `{ account, total, entries: [{ sequence, height, position (number or null), opIndex, kind, txHash (or null), data }] }` | `-32001`; `-32602` bad limit | yes |
| `tx` | `hash`, `prove?` | `{ hash, height, index, ok (bool, or null for a block the node stored without executing it), error, tx (hex), decoded (or null), attempts?, proof? }` where `attempts` is `[{ height, index, ok, error }]` for every block still held that carries the transaction, oldest first, present when there is more than one, and `proof` is `txQueryToJson` or null | `-32001` unknown transaction | yes |
| `broadcastTx` | `tx` (hex), `mode?` (`sync` default, or `commit`), `timeoutMs?` (default 30000, capped at 120000) | sync: `{ hash, status }` with status `added` or `seen`; commit: `{ hash, height, index, ok, error }` | `-32002` check failed (`invalid`, `too-large`, `full`, with the application's reason), or seen before but neither pending nor committed; `-32003` timeout; `-32004` too many commit waits outstanding, or the mempool paused, or full at a limit lowered because the node is short of memory (with the mempool's reason); `-32602` bad mode | yes |
| `accounts` | `limit?` (default 50, at most 200; 0 returns an empty page), `after?` (name) | `[{ name, id, balance }]` in name order, resuming just past `after` | none | yes |
| `parameters` | none | `{ height, coreAsset: { id, symbol, precision (number) }, maxTxExpirationMs, fees, staking }` | `-32001` not core app | no |
| `proposals` | none | the open proposals, soonest to expire first, each with its full `parameters` | `-32001` not core app | yes |
| `mempool` | none | `{ count, bytes (number), hashes (first 100) }` | none | no |
| `peers` | none | `[{ id, addr, direction, height, latencyMs, clockOffsetMs (number, or null before the first pong) }]` | none | no |
| `snapshots` | none | `[]`, always | none | no |

Errors that any method can produce: `-32600` for a request whose `id` is not a string, a number or null, `-32601` for an unknown method, `-32602` when `params` is present but not an object or when a parameter has the wrong JSON type, `-32000` with the message `server is stopping` for a request that reaches dispatch once `stop` has been called, and `-32004` when the bucket cannot pay for a costly call or for a call of a batch after the first or, with the message `node under memory pressure`, for any costly call other than `broadcastTx` while the node sheds load; `broadcastTx` is marked `whileShedding` and goes on to the mempool, whose lowered limit or pause answers instead. A method name that is only an inherited property of the table object (`toString`, `constructor`, `__proto__`) is unknown like any other and answered `-32601`: the table is looked up with `Object.hasOwn`. All of these are produced by the server, not by the table. `block` is costly for the reason the code gives in a comment: a full block of transactions is as much work to serve as any query.

Some methods deserve a closer look.

`header` is the one engine-level method that does not go through `stored`:

```ts
    header: {
      fn: async (p) => {
        const h = heightParam(node, p);
        // Below its lowest block a state-synced node may still hold the header alone; a light client walking back needs it.
        const header = node.store.loadBlock(h)?.block.header ?? node.store.loadHeader(h);
        if (!header) throw new RpcError(NOT_FOUND, `no block ${h}`);
        return jsonify(header);
      },
    },
```

A node that joined by state sync holds no blocks below its snapshot height until backfill has fetched them, but it does hold the headers of those heights as far back as evidence may reach (chapter 10's header records, written by state sync in chapter 7), and `header` serves them. That is what lets a light client walk backwards from a trusted header through such a node (chapter 13): each step needs only the header below, not its commit. `block` and `commit` need the block itself and stay `-32001` for those heights.

`status` computes `catchingUp` from the peers' reported heights: true when some peer is more than one block ahead. `lowestHeight` is the oldest block the store still has (retention, chapter 10), and `joinedAt` is the height a state-synced node started from, or null for one that replayed from genesis. `signatureScheme` is the name of the scheme the chain state carries (`schemeName(state.scheme)`), the one genesis fixed: a wallet must know it before it makes a key for the chain, and the CLI's `create` and `create-validator` ask `status` for it (chapter 14). `memory` is the memory guard's last sample with its level and whether the node is shedding load, the sizes in bytes, and under `database` what the core application's object database reports through `memory()` ([chapter 9](09-database.md)): its arena's slab count, the bytes those slabs can hold, the bytes written into them and how many of those are dead, awaiting compaction; `arenaLimit`, the most bytes the slabs may take when the node was started with `--arena` (`Infinity`, so `null`, otherwise), and `storedObjects`, how many committed objects have their bytes only in the store because of it; the mode of each tier the guard can turn down, `objects` (`resident` while the cache of decoded objects is unbounded, `capped` once the guard has bounded it), `indexTrees` (`resident`, `dropped`, or `partial` when only some types' B+ trees are dropped; `dropped` from the start on a node with the default `indexTrees: 'store'`, which never builds them) and `trees` (`resident` or `dropped`, the dense and sparse Merkle trees together); the decoded objects in its hot cache and their limit (`hotLimit` is `Infinity` while unbounded, and JSON writes that as `null`); the bytes of past values the provable window keeps, with `history` (`resident` while the database keeps every past version it records, `trimmed` while the guard has cut the window in memory), `historyWindow` (how many past versions are kept in memory just now) and `lowestVersion` (the oldest version a proof can be asked for, which is what a client sees refused below; a trimmed window does not raise it, the older versions being read from the store's history records, [chapter 9](09-database.md)); the dense tree chunks cached for dropped trees and how many may be; and the hit and miss counts of both caches since the database was made, `hotHits` and `hotMisses` for the decoded objects, `chunkHits` and `chunkMisses` for the chunks, from which an operator reads a hit rate. It is `null` on an application other than the core one. `gc` is the scheduler's counts: whether collections can be scheduled at all (`--expose-gc`), every collection V8 ran since start by kind with the total, longest and last pause in milliseconds, and the minor and major ones the node itself asked for ([chapter 8](08-node.md)); all of them are JSON numbers, none being a 64-bit quantity a double cannot hold. `rpcVersion: 1` lets a client detect the contract.

Every state query takes its height from one helper, so that, as its comment says, "a value and the proof beside it are about the same state":

```ts
function stateHeight(app: CoreApp, p: Record<string, unknown>): bigint {
  if (p.height === undefined) return app.lastHeight;
  const height = parseBigint(p.height, 'height');
  if (height > app.lastHeight || height < app.lowestProvableHeight) throw new RpcError(NOT_FOUND, `the state at height ${height} is not kept (heights ${app.lowestProvableHeight} to ${app.lastHeight} are)`);
  return height;
}
```

`object` reads the object by id as of that height:

```ts
    object: {
      costly: true,
      async fn(p) {
        const app = coreApp(node);
        const id = parseId(p.id);
        const type = CORE_TYPES.find((t) => t.id === typeOf(id));
        if (!type) throw new RpcError(INVALID_PARAMS, 'unknown object type');
        const height = stateHeight(app, p);
        const obj = objectAt(app, type, id, height);
        const out: Record<string, unknown> = { type: type.name, height: height.toString(), object: obj ? jsonify(obj) : null };
        if (bool(p, 'prove')) out.proof = toHex(proofToBytes(app.proofAt(id, height)));
        return out;
      },
    },
```

`objectAt` calls `getCommitted` for the last height and `getAt` for a past one. `getAt` throws a `RangeError` outside the retention window, which the server would report as `-32602`; `stateHeight` has refused such a height before that, with `-32001` and a message naming the heights that are kept. The proof is an `ObjectProof` (chapter 9) about that height, to be checked against header `height + 1`.

`key`, `account`, `validator` and `delegation` find an object through an authenticated unique index, and they read that index at the height too. `keyAt` is how:

```ts
function keyAt(app: CoreApp, type: ObjectType<any>, index: string, k: Uint8Array, height: bigint): { id: ObjectId | null; proof: KeyProof } {
  const proof = app.db.proveKeyAt(type, index, k, Number(height));
  const folded = smtProofRoot(k, proof.proof);
  if (!folded) throw new Error('the index gave a proof that does not fold');
  return { id: folded.value ? decode(folded.value, (r) => r.u64()) : null, proof };
}
```

It makes the key proof first and takes the id from the proof's leaf (`smtProofRoot`, chapter 9), so the id a method returns is the one the proof beside it proves. The live index is not asked: "it holds the writes of the block in progress, and says nothing about a past height." This closes what was left of review finding 19. Before, these methods looked the key up in the live index and returned current objects with a proof of the height asked for, so the two could disagree, and at the latest height an object created by the block in progress could show.

`key` is `keyAt` and nothing else:

```ts
        const height = stateHeight(app, p);
        const { id, proof } = keyAt(app, type, index, k, height);
        const out: Record<string, unknown> = { height: height.toString(), id: id === null ? null : jsonify(id, 'id') };
        if (bool(p, 'prove')) out.proof = toHex(keyProofToBytes(proof));
        return out;
```

`account` finds the account through the `byName` index at the height and reads it with `objectAt`. Its balances come from `balancesAt`: the live `byOwnerAsset` range says which balance objects the account has, and each is read as of the height, one created since reading as absent; each asset is read as of the height for its symbol and precision, and `precision` travels with the amount so a client can format it without a second call. `validator` is the id the `byOperator` index held for the account at the height, and `history` is the number of entries the account had then (`app.accountHistoryTotalAt`, chapter 11: the account's entries are in height order, and the newest at or below the height is found through the skip pointers). With `prove` the result carries the key proof `keyAt` made for the name, not an object proof for the account: either the 8-byte id the name maps to, or that no account has the name (chapter 9, authenticated indices). That is what makes `account` useful for a name that does not exist: the result has `account: null` and a proof of absence. The CLI's `account` command relies on it. A name no account can have (one `key` cannot encode) gives `account: null`, and with `prove` an invalid-params error, `no proof can be made for that name`.

`validator` reads the validator as of the height and decorates it: the status name from `STATUS_NAMES = ['candidate', 'jailed', 'tombstoned']` (indexed by `ValidatorStatus`), whether it was in the active set (the dynamic properties object read as of the height), its power (the active entry's, or `powerOf(tokens, precision)` for a candidate), its operator's self-bond (the delegation the `byDelegatorValidator` index held for the operator at the height, through `tokensForShares`) and the operator's name. One field, `delegators`, the number of delegations the validator had, cannot be answered for a past height from the index of today: `byValidator` is not an authenticated index, so it has no tree to read at a past height, and unlike a balance a delegation does not stay once it is empty. `listAt` answers it:

```ts
/**
 * The objects of a type as of a height that pass a test, in id order, for a type whose objects come and go (a
 * delegation is removed when its last share goes, an unbonding entry when it matures). `now` lists those the index
 * of today holds; the ones changed or removed since the height are looked at as well, which at the latest height
 * are those the block in progress removed, and each is read as it was then.
 */
function listAt<T extends { id: ObjectId }>(app: CoreApp, type: ObjectType<T>, now: Iterable<{ id: ObjectId }>, height: bigint, keep: (o: T) => boolean): T[] {
  const ids = new Set<ObjectId>();
  for (const o of now) ids.add(o.id);
  for (const id of app.db.changedSince(type, Number(height))) ids.add(id);
  return [...ids]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((id) => objectAt(app, type, id, height))
    .filter((o): o is T => o !== null && keep(o));
}
```

The ids come from two places. The index of today gives the objects that exist now; `changedSince` (chapter 9) gives every object of the type that a height after the one asked for created, changed or removed, which includes the ones removed since. Together they are all that can have existed at the height. Each is read with `objectAt`, one that did not exist then reads as null and is dropped, and `keep` drops the ones that belong elsewhere, which is needed because `changedSince` gives the objects of the whole type and not of one validator. At the latest height `changedSince` gives only what the block in progress has removed, which the index no longer lists though the last committed state still holds it, and the cost is the index scan it always was. At a past height it is one read as of the height for each object of the type changed since, and for a height older than the window in memory one history record, read once and decoded, for each height between the one asked for and the window; the heights the window holds cost no record. That cost was not measured. `validator` counts with it:

```ts
        const delegators = listAt(app, DelegationType, app.db.scan(DelegationType, 'byValidator', key((k) => k.id(v.id))), height, (d) => d.validator === v.id).length;
```

`delegation` resolves the delegator and the validator at the height, finds the delegation with `keyAt` on `byDelegatorValidator`, reads it as of the height and values its shares by the validator as of the height; the proof is the one `keyAt` made. `unbonding` is the list of entries pending as of the height, made with `listAt` for the same reason as `delegators`, an unbonding entry being removed when it matures:

```ts
          unbonding: listAt(app, UnbondingType, app.db.range(UnbondingType, 'byDelegatorValidator', key((k) => k.id(delegator).id(validator))), height, (u) => u.delegator === delegator && u.validator === validator).map((u) => jsonify(u)),
```

At the latest height both still follow the rule chapter 11 stated for the application's own queries, that the live index says where to look and what is reported comes from the committed view, so a delegation or an unbonding entry sitting in the pending session is absent from the answer as it is absent from every block.

`balance` resolves the account at the height, so an account named that did not exist then is `NOT_FOUND`, and returns the amount of the one asset from `balancesAt`, 0 when there is no such balance, as there is none for an id that had no account yet.

`tx` finds the transaction's location in the store's index (`txLocation`: height, index, ok, error; the block the transaction succeeded in if there is one, else the newest that carries it), loads the block to return the raw bytes, decodes them for convenience (and returns `decoded: null` rather than failing if the bytes do not decode), and with `prove` calls `node.queryTx`, which builds the inclusion proof against the block's `dataHash` and, once the next block exists, the result proof against the next header's `lastResultsHash`. Finding 18 of the review matters here: a transaction repeated within one block gets one index entry, at the first position where it succeeded, or at its first position when it succeeded at none, and results are stored per block, so the result proof describes what happened at that position. A transaction that failed can be included again in a later block, and the index keeps an entry for each (chapter 10); when `txLocations` has more than one, `tx` adds them as `attempts`, oldest first, each with its height, index, `ok` and error.

`broadcastTx` is the method with the most moving parts:

```ts
    broadcastTx: {
      costly: true,
      // Under memory pressure the mempool's lowered limit is the throttle: a transaction gets in when there is room.
      whileShedding: true,
      async fn(p) {
        const raw = parseHex(p.tx, 'tx');
        const mode = p.mode ?? 'sync';
        if (mode !== 'sync' && mode !== 'commit') throw new RpcError(INVALID_PARAMS, 'mode must be sync or commit');
        const hash = txHash(raw);
        const waiter = mode === 'commit' ? events.waitForTx(hash, Math.min(num(p, 'timeoutMs', 30_000), MAX_COMMIT_WAIT_MS)) : null;
        if (mode === 'commit' && !waiter) throw new RpcError(RATE_LIMITED, 'too many transactions awaiting inclusion; broadcast in sync mode and poll tx');
        try {
          const r = await node.submitTx(raw);
          if (r.status === 'paused') throw new RpcError(RATE_LIMITED, r.error ?? 'node under memory pressure');
          // A pool full because its limit is lowered is the node's doing, not the transaction's: try again later.
          if (r.status === 'full' && node.memoryLevel !== 'ok') throw new RpcError(RATE_LIMITED, r.error ?? 'mempool full');
          if (r.status === 'invalid' || r.status === 'too-large' || r.status === 'full') throw new RpcError(CHECK_FAILED, `${r.status}${r.error ? `: ${r.error}` : ''}`);
          if (!waiter) return { hash: toHex(hash), status: r.status };
          const seen = node.store.txLocation(hash);
          if (seen) return { hash: toHex(hash), height: seen.height.toString(), index: seen.index, ok: seen.ok, error: seen.error };
          // Seen before but neither pending nor committed: it was rejected or dropped, and waiting would not change that.
          if (r.status === 'seen' && !node.mempool.has(hash)) throw new RpcError(CHECK_FAILED, 'seen before and not pending; submit a fresh transaction');
          const done = await waiter.promise;
          if (!done) throw new RpcError(TIMEOUT, 'transaction was not included before the timeout');
          return { hash: toHex(hash), height: done.height.toString(), index: done.index, ok: done.ok, error: done.error };
        } finally {
          waiter?.cancel(); // a no-op once it has fired; otherwise the slot is freed
        }
      },
    },
```

The order is the point. The waiter is registered before `submitTx`, so a transaction that is admitted and committed between the two lines is still caught. `submitTx` is the node's `mempool.addTx` (chapter 5), whose statuses are `added`, `seen` (already in the pool or its cache), `invalid` (checkTx failed, with the application's message), `full`, `too-large` and `paused`. `paused` is the pool at the memory guard's `critical` level, when the node is about to stop (chapter 8), and becomes `-32004` with the mempool's reason. `full` has two meanings, told apart by the guard's level. At `ok` the pool holds its whole limit, and the answer is `-32002` like any other refusal. At any other level the node has lowered the limit because it is short of memory (half at `warn`, a tenth at `pressure`), the pool's `error` says so (`mempool full: its limit is lowered while the node is short of memory`), and the answer is `-32004`: the transaction is fine, and the client should wait and try again as it would for a rate limit rather than rebuild it. The method is marked `whileShedding`, so the server's gate on costly methods (`handle`, below) lets it through at `pressure`, where every other costly method is refused: the lowered limit is what throttles a broadcast then, and a transaction gets in whenever a block has made room. A `seen` transaction in commit mode may already be in a block, which is why the store's index is consulted before waiting: re-broadcasting an included transaction answers at once with where it landed, as the test does. The failure message carries the application's reason, so a wallet that priced a transaction under an old fee schedule sees "states a fee of 100, the schedule requires 250".

Three guards keep commit mode from becoming a way to tie up the node. The timeout the caller asks for is capped at `MAX_COMMIT_WAIT_MS`, two minutes, so a request cannot hold a waiter slot, or wait for inclusion, for an hour. The timer runs from the moment the waiter is registered and bounds only the wait for inclusion: the method still awaits `submitTx` to its end, so a request whose admission check takes longer than the timeout answers when the check returns, not when the timer fires. When `waitForTx` returns null because 1000 waiters are already outstanding, the method answers `-32004` at once with advice to use sync mode and poll `tx`; the transaction is not even submitted, since the caller asked to be told where it landed and the node cannot promise that. And a transaction the mempool reports as `seen` that is neither in the store's index nor still in the pool was rejected or dropped after an earlier submission, so a waiter for it would only ever time out; it is refused with `-32002` immediately instead of after the full timeout. The `finally` cancels the waiter on every exit, including the throws, so a slot is never held by a request that already answered.

`accounts` lists the live `byName` index in name order with keyset pagination and reports each committed account's core balance:

```ts
        const limit = Math.min(num(p, 'limit', 50), 200);
        const after = p.after === undefined ? '' : str(p, 'after');
        const out = [];
        // The listing resumes at the cursor's position in the name index, so a late page costs no more than an early one.
        for (const [, live] of app.db.scanFrom(AccountType, 'byName', after === '' ? new Uint8Array(0) : key((k) => k.str(after)))) {
          if (out.length >= limit) break;
          if (live.name <= after) continue;
          const a = app.db.getCommitted(AccountType, live.id);
          if (a) out.push({ name: a.name, id: jsonify(a.id, 'id'), balance: app.balance(a.id).toString() });
        }
        return out;
```

The cursor is the last name the previous page returned, and `scanFrom` (chapter 9) starts at that key, by descending the index's B+ tree when it is in memory and by a range read of the store when it is not (the default, `indexTrees: 'store'`), so the page after a million names costs the same as the first one; a scan from the beginning that skipped `after` names would make each later page slower than the last, and a client walking the whole index would do quadratic work. The `<= after` test skips the cursor itself (and, when the cursor names an account that no longer exists, lands on its successor), and a `limit` of 0 is honoured as an empty page rather than being read as "use the default". `parameters` is what a wallet reads before pricing: the fee schedule and staking parameters as the application holds them, plus the core asset's id, symbol and precision. `proposals` lists the open parameter proposals by expiration (`FEES.md` section 4; the CLI diffs each against the live parameters). `snapshots` returns an empty list; the spec's method table marks it "reserved: an empty list (snapshot heights are exchanged over p2p, not the RPC)", and chapter 7 shows the p2p messages that carry them.

**One exchange, end to end.** A wallet asking for alice at height 41 with a proof sends this body to `POST /`:

```json
{ "jsonrpc": "2.0", "id": 7, "method": "account", "params": { "name": "alice", "prove": true, "height": "41" } }
```

and gets back, with the hex values shortened here, the shape `jsonify` and the method produce (an `Account` is `{ id, name, owner, active, registrar }`, and an `Authority` is `{ threshold, accounts, keys }`):

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "height": "41",
    "account": {
      "id": "3.1",
      "name": "alice",
      "owner": { "threshold": 1, "accounts": [], "keys": [{ "publicKey": "01a3f1…", "weight": 1 }] },
      "active": { "threshold": 1, "accounts": [], "keys": [{ "publicKey": "01a3f1…", "weight": 1 }] },
      "registrar": "3.0"
    },
    "balances": [{ "asset": "CORE", "assetId": "4.0", "precision": 5, "amount": "1250000" }],
    "validator": null,
    "history": "2",
    "proof": "…"
  }
}
```

Every id is `"type.n"`: `id` and `registrar` are in `ID_KEYS`, `assetId` is produced by `jsonify(b.asset, 'asset')` and the `validator` field by `jsonify(v, 'id')`; the amount and the history count are strings because they are bigints; `threshold`, `weight` and `precision` are numbers because they are numbers in the object; the public key is the hex of its tagged bytes, and its first byte, `01`, says this is an ML-DSA-44 chain. The proof is a `KeyProof` in hex that `keyProofFromBytes` decodes and `verifyKeyProof` checks against header 42's app hash. A refused broadcast comes back in the same envelope with an error instead:

```json
{ "jsonrpc": "2.0", "id": 8, "error": { "code": -32002, "message": "invalid: operation 0 states a fee of 100, the schedule requires 250" } }
```

where the text after the colon is the application's own reason from `checkTx`.

### src/rpc/server.ts

Purpose: parse, limit and dispatch. Nothing about the chain lives here except the event bodies.

**`RpcLimits`** is `{ bodyBytes, ratePerSecond, burst, costlyCost, maxStreams }` and **`DEFAULT_RPC_LIMITS`** sets them to 1 MiB, 50 per second, a burst of 100, 5 for a costly call and 8 streams per address, exactly the table in `RPC-SYNC-PROOFS.md` section 5. Four module constants sit beside them: `EVENT_TYPES`, the set of the four event names a stream may ask for; `BUCKET_IDLE_MS`, ten minutes, after which an idle rate-limit bucket is forgotten "so one-off clients do not accumulate"; **`MAX_REPLAY = 1000n`**, which bounds a reconnecting stream's replay; and **`MAX_STREAM_BACKLOG`**, one MiB, the most an event stream may have queued unread before it is dropped. **`RpcServerOptions`** adds `host` (default `127.0.0.1`), `port` (default 0, an ephemeral port), a `log` and partial `limits`.

Two private shapes: `Bucket { tokens, last }` per remote address, and `Stream { res, types, tx, account, remote }` per open event stream. `CORS` is the header set every response carries, including `Last-Event-ID` among the allowed request headers so a browser can reconnect.

**`RpcServer`**'s constructor builds `RpcEvents` and the method table, creates the HTTP server, and subscribes `push` to committed blocks:

```ts
    this.server = createServer((req, res) => {
      req.on('error', () => res.destroy());
      const done: Promise<void> = this.handle(req, res)
        .catch((e) => {
          this.log('warn', 'rpc request failed', { err: (e as Error).message });
          if (!res.headersSent) res.writeHead(500, CORS);
          res.end();
        })
        .finally(() => this.inFlight.delete(done));
      this.inFlight.add(done);
    });
    this.unsubscribe = this.events.onCommitted((e) => this.push(e));
```

The `.catch` on `handle` is review finding 13: a request whose body errors (the client disconnects mid-upload) rejects the `for await` inside `handle`; without the `.catch` that rejection was unhandled and Node's default is to exit the process. `test/review.test.ts` reproduces it with a raw socket. The promise of each request, `done`, is kept in the set `inFlight` from the moment the request arrives until `handle` has settled, which is when its method has returned and its answer is written, or when the `.catch` has dealt with its failure; the `.finally` then takes it out. `stop` waits for that set, as described next.

**`url`** is `http://host:boundPort`. **`start()`** listens and resolves with the bound port; **`stop(graceMs = 1000)`** undoes the constructor's subscriptions, ends every open stream and closes the server: idle connections are closed at once, and one in the middle of a request is given `graceMs` to finish and is then cut, so a client that sends its body slowly, or never, cannot hold up a node that is stopping. It then waits, one second at most, for the requests still being handled. The command line starts this stop first and has the node wait for it before closing its store (`node.stop(beforeClose)`, [chapter 14](14-wallet-cli.md)), so a request that finishes within the grace reads a store that is still open, and a method that was still running when its connection was cut has returned before the store is closed.

```ts
  async stop(graceMs = 1000): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    this.events.close();
    for (const s of this.streams) s.res.end();
    this.streams.clear();
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeIdleConnections();
    const cut = setTimeout(() => this.server.closeAllConnections(), graceMs);
    await closed;
    clearTimeout(cut);
    // A connection that is closed does not end the method it called: one waiting on the mempool or the verifier
    // would go on to read the node's stores when it resumes. Those are waited for, a second at most, so whoever
    // closes the stores after this does not close them under a request; none is begun once the server is stopping.
    let giveUp!: NodeJS.Timeout;
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise<void>((resolve) => (giveUp = setTimeout(resolve, 1000)))]);
    clearTimeout(giveUp);
  }

  private stopped = false;
  /** Requests being handled, each until its method has returned and its answer is written. */
  private readonly inFlight = new Set<Promise<void>>();
```

`unsubscribe` takes `push` out of the events' listeners, and `events.close()` (above) takes the events' callback out of the executor's list and answers the commit waiters still outstanding with `null`, which their `broadcastTx` calls report as `-32003`. A stopped server is therefore not called for any later block and nothing in the node refers to it, so a program that replaces the server of a running node does not keep the old ones alive or at work.

The last three statements of `stop` are for what closing a connection does not do. Cutting a connection ends the exchange with the client, not the method the request called: a `broadcastTx` waiting on the mempool, or any method waiting on the verifier, resumes later and goes on to read the node's stores. So once the connections are closed `stop` waits for every promise in `inFlight`, each of which settles when its method has returned and its answer is written (to a connection that may be gone, which is harmless). `Promise.allSettled` is raced against a timer of one second, cleared when the race is over, so a method that never returns delays the stop by a second and no more. A method that was waiting when its connection was cut has therefore ended before `stop` returns, and whoever closes the node's stores afterwards, the node itself under the command line, does not close them under it. `stop` also sets `stopped` first, and `one` (below) answers a request that reaches dispatch after that with code `-32000` and the message `server is stopping` and does not call its method: no method is begun once the server is stopping, so the set `stop` waits for does not grow behind it.

**`allow(remote, cost)`** is the token bucket:

```ts
  private allow(remote: string, cost: number): boolean {
    const now = Date.now();
    if (++this.allowCalls % 1000 === 0) for (const [k, b] of this.buckets) if (now - b.last > BUCKET_IDLE_MS) this.buckets.delete(k);
    let b = this.buckets.get(remote);
    if (!b) this.buckets.set(remote, (b = { tokens: this.limits.burst, last: now }));
    b.tokens = Math.min(this.limits.burst, b.tokens + ((now - b.last) / 1000) * this.limits.ratePerSecond);
    b.last = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }
```

A new address starts full. Refill is computed lazily from the elapsed time, capped at `burst`. Every thousandth call (counted in `allowCalls`) sweeps the map and drops buckets that have been idle for `BUCKET_IDLE_MS`; a bucket that comes back later starts full again, which is no gift, since ten idle minutes would have refilled it anyway. One small object per recently active address is the cost.

**`handle(req, res)`** routes by method and path. Every HTTP endpoint:

| endpoint | what it does | status codes |
|---|---|---|
| `OPTIONS *` | CORS preflight | 204 |
| `GET /health` | `{ height, peers, memory }` as JSON (`memory` the guard's level), no rate limit | 200 |
| `GET /events` | opens an SSE stream (below) | 200, 400 unknown event type, 404 unknown account, 429 too many streams or unaffordable replay, 503 while the node sheds load |
| `POST /` | one JSON-RPC request or a batch of 1 to 20 | 200 with the response(s); 204 with no body when nothing is to be answered (a lone notification, or a batch of them); 400 parse error (`-32700`) or bad batch size (`-32600`); 413 body too large; 429 rate limited (`-32004`) |
| anything else | | 404 |

The POST path, in order: charge one token or answer 429; refuse a declared `Content-Length` over the limit with 413 before reading; read the body chunk by chunk, stopping at the limit:

```ts
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > this.limits.bodyBytes) {
        tooBig = true;
        break;
      }
      chunks.push(c as Buffer);
    }
    if (tooBig) {
      res.writeHead(413, CORS).end();
      req.destroy();
      return;
    }
```

then parse, accept an array as a batch, and run the requests one after another with `one`, keeping the responses of those that get one:

```ts
    const responses: unknown[] = [];
    // The HTTP request paid for its first call; each further call of a batch pays for itself, so that a batch
    // costs what its calls would have cost one by one.
    for (const [i, r] of requests.entries()) {
      const answer = await this.one(r, remote, i > 0);
      if (answer !== undefined) responses.push(answer);
    }
    // Notifications alone leave nothing to answer: no content, as JSON-RPC over HTTP has it.
    if (responses.length === 0) {
      res.writeHead(204, CORS).end();
      return;
    }
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify(batch ? responses : responses[0]));
```

`one` returns `undefined` for a notification, a request sent without an `id`, which JSON-RPC 2.0 defines as one the client does not want answered. The method still runs; only the answer is dropped. A lone notification, or a batch made of nothing but notifications, is answered with 204 and an empty body, since a 200 with no JSON would be a parse error for the client; a mixed batch is answered with an array holding only the responses of the members that had an id. A batch is limited to 20 requests. The HTTP request paid one token, which covers the first call; `one` is told to charge each further call a token of its own, so a batch of twenty cheap calls costs twenty tokens, what the calls would have cost one by one, where it used to cost one.

All the limits, in one place:

| limit | default | where enforced |
|---|---|---|
| body size | `bodyBytes` = 1 MiB | declared length, then while reading |
| requests per address | `ratePerSecond` = 50, `burst` = 100 | one token per POST, before the body is read; one more per call of a batch after the first, in `one` |
| costly methods | `costlyCost` = 5 | `costlyCost - 1` more tokens per costly call, alone or in a batch, in `one` |
| batch size | 1 to 20 | after parsing |
| event streams per address | `maxStreams` = 8 | when a stream is opened |
| replay on reconnect | the last `MAX_REPLAY` = 1000 blocks, charged `costlyCost`, stops when `writableLength` > 1 MiB | when a stream is opened |
| event stream backlog | `MAX_STREAM_BACKLOG` = 1 MiB queued unread; the stream is ended | in `send`, before every record |
| commit waiters | `MAX_WAITERS` = 1000 across all callers; `-32004` beyond it | in `waitForTx` and `broadcastTx` |
| memory pressure | the guard's `pressure` level ([chapter 8](08-node.md)); costly methods `-32004` except `broadcastTx`, which is left to the mempool's lowered limit; `/events` 503 | in `one` and `openStream` |
| accountHistory page | 100 | in the method |
| accounts page | 200 | in the method |
| broadcast commit timeout | 30 s (caller may set, capped at `MAX_COMMIT_WAIT_MS` = 120 s) | in the method |

**`one(r, remote, charge)`** handles a single JSON-RPC request:

```ts
  private async one(r: unknown, remote: string, charge: boolean): Promise<unknown> {
    const hasId = !!r && typeof r === 'object' && 'id' in r;
    const rawId = hasId ? (r as { id: unknown }).id : null;
    const id = typeof rawId === 'string' || typeof rawId === 'number' || rawId === null ? rawId : null;
    const reply = (error: { code: number; message: string } | null, result?: unknown) => (error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
    // Something that is not a request is answered as an invalid request under its own id when it has one that can be
    // read (a string, a number or null), and under a null id when it has none or one of another kind.
    if (!r || typeof r !== 'object' || (r as { jsonrpc?: unknown }).jsonrpc !== '2.0' || typeof (r as { method?: unknown }).method !== 'string' || id !== rawId) {
      return reply({ code: -32600, message: 'invalid request' });
    }
    const answer = hasId ? reply : () => undefined;
    const { method, params } = r as { method: string; params?: unknown };
    if (charge && !this.allow(remote, 1)) return answer({ code: RATE_LIMITED, message: 'rate limited' });
    const m = Object.hasOwn(this.methods, method) ? this.methods[method] : undefined;
    if (!m) return answer({ code: -32601, message: `unknown method ${method}` });
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) return answer({ code: INVALID_PARAMS, message: 'params must be an object' });
    if (m.costly && !m.whileShedding && this.node.isShedding) return answer({ code: RATE_LIMITED, message: 'node under memory pressure' });
    if (m.costly && !this.allow(remote, this.limits.costlyCost - 1)) return answer({ code: RATE_LIMITED, message: 'rate limited' });
    if (this.stopped) return answer({ code: -32000, message: 'server is stopping' });
    try {
      return answer(null, await m.fn((params as Record<string, unknown>) ?? {}));
    } catch (e) {
      if (e instanceof RpcError) return answer({ code: e.code, message: e.message });
      if (e instanceof TxError) return answer({ code: NOT_FOUND, message: e.message });
      const msg = (e as Error).message ?? String(e);
      this.log('warn', 'rpc method failed', { method, err: msg });
      return answer({ code: INVALID_PARAMS, message: msg });
    }
  }
```

Eight things to see. The request `id`, when present, must be a string, a number or null, as JSON-RPC 2.0 requires; an object or an array there makes the whole request invalid (`-32600`, answered with `id: null`, the id being read before anything else and one of another type read as null), because the server echoes the id back and should not reflect arbitrary JSON a client chose. A well-formed request with no `id` member at all is a notification: `answer` becomes a function that returns `undefined`, so the method is carried out and nothing is answered, not even an error, whether the method is unknown, the parameters are bad, the bucket cannot pay or the call fails; the specification says a notification's sender "is not interested in any response", and that includes the bad news. The distinction between the two cases is `hasId`: an object that is not a request at all (no `jsonrpc: '2.0'`, no string `method`, an id of the wrong type) is still refused with `-32600` through `reply`, with `id: null` when it has no id or one of the wrong type and with its own id when that is a string, a number or null (`{"jsonrpc":"1.0","id":7,"method":"status"}` is answered with `id: 7`), since the server cannot know whether the sender wanted an answer and the specification asks for one. The method is looked up with `Object.hasOwn`, so only the table's own entries are methods: `toString` or `constructor`, which every object inherits, is answered `-32601` like any other unknown name. Positional parameters (a JSON array) are refused; every method takes a named-parameter object. A costly method is refused outright, with `-32004` and `node under memory pressure`, while the node sheds load (`isShedding`, chapter 8), unless it is marked `whileShedding`, which only `broadcastTx` is: a broadcast goes on to the mempool, where the lowered limit or the pause decides. The costly methods are the ones that serve whole blocks, proofs, listings and history, or hold a commit waiter, all of it memory on the client's behalf, and the check comes before the costly charge, so the refusal costs the caller only the one token the call had already paid, not the further `costlyCost - 1`; cheap methods, `status` among them, keep answering so a client can see why. A costly method is charged `costlyCost - 1` here because the call already paid one: the HTTP request for the first call, and for a further call of a batch the `charge` at the top, which is taken before the method is looked up, so an unknown method in a batch pays too, and a call that cannot pay is answered `-32004` in its place in the batch. The last check before the method runs is `this.stopped`: a request whose body was still arriving, or that was still being parsed, when `stop` was called is answered `-32000`, `server is stopping`, and its method is not begun, since `stop` waits only for what was running and whoever called it may close the stores next; the check comes after the charges, so such a request is still paid for and a notification is still answered with nothing. And the catch clause is the error contract: an `RpcError` keeps its code, an application `TxError` (thrown by state helpers in chapter 11 when something is missing) becomes not-found, and any other exception, including the plain `Error`s from `parseHex` and `parseBigint` and a `RangeError` from the database, becomes invalid params with its message. Those are logged at `warn` because an unexpected exception may be a bug rather than a bad call.

**`openStream(req, res, url, remote)`** is `GET /events`. Query parameters: `types`, a comma-separated subset of `block`, `tx`, `account`, `validatorSet` (default `block`); `tx=<hash>` to restrict `tx` events to one transaction; `account=<name|id>` to choose the account for `account` events (required for any to be sent; a name or an id that no account has is 404). A name outside `EVENT_TYPES` is refused with a plain-text 400 rather than accepted and never matched, so a misspelt `validatorset` fails loudly instead of producing a silent stream:

```ts
    const types = new Set((url.searchParams.get('types') ?? 'block').split(',').map((t) => t.trim()));
    for (const t of types) {
      if (!EVENT_TYPES.has(t)) {
        res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' }).end(`unknown event type ${t}`);
        return;
      }
    }
```

The account must exist, whichever way it is given:

```ts
    if (accountParam) {
      // By id or by name, the account must exist: a stream for one that does not would stay silent for ever.
      const app = this.node.app instanceof CoreApp ? this.node.app : null;
      if (app && /^\d+\.\d+$/.test(accountParam)) {
        try {
          const id = idFromString(accountParam);
          if (app.db.getCommitted(AccountType, id)) account = id;
        } catch {
          // Not an id any object can have.
        }
      } else if (app) account = app.accountByName(accountParam)?.id ?? null;
      if (account === null) {
        res.writeHead(404, CORS).end();
        return;
      }
    }
```

An id is parsed with `idFromString` and read as an account from the committed state, so the id of an object of another type (`4.0`), of an account that does not exist (`3.999999`) and one whose numbers are out of range are all 404, as an unknown name is. On an application other than the core one there are no accounts, and any `account` parameter is 404.

A stream is memory held for the client for as long as it stays open, so none is opened while the node sheds load:

```ts
    // A stream is memory held for the client; none are opened while the node sheds load.
    if (this.node.isShedding) {
      res.writeHead(503, CORS).end();
      return;
    }
```

The 503 is a plain "try again later"; the client retries once `/health` reports `ok` or `warn`, and the streams already open are left alone, since cutting them would only make their clients reconnect and replay. The checks run in this order: streams open from this address (429 at `maxStreams`), load shedding (503), the event types (400), the account (404), and the replay charge:

```ts
    // Replaying the blocks after the one the client last saw costs as much as a
    // costly call. Refuse it up front rather than open a stream with a gap in it.
    const last = String(req.headers['last-event-id'] ?? '');
    const replayFrom = last !== '' && types.has('block') && /^\d+$/.test(last) ? BigInt(last) + 1n : null;
    if (replayFrom !== null && !this.allow(remote, this.limits.costlyCost)) {
      res.writeHead(429, CORS).end();
      return;
    }
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const stream: Stream = { res, types, tx, account, remote };
    this.streams.add(stream);
    req.on('close', () => this.streams.delete(stream));
    if (replayFrom !== null) {
      const oldest = this.node.height - MAX_REPLAY + 1n;
      const start = replayFrom < oldest ? oldest : replayFrom;
      for (let h = start; h <= this.node.height; h++) {
        const stored = this.node.store.loadBlock(h);
        if (!stored || res.writableLength > 1024 * 1024) break;
        this.send(stream, 'block', h, blockEventJson(stored.block, this.node.store.loadResults(h)));
      }
    }
```

Only `block` events are replayed, and only when the stream asks for them: block events are the ones a client can resume from by height, and the store has them; transaction and account events for old blocks are not replayed, which the spec did not ask for. A replayed record is made by the same `blockEventJson` as a live one, from the block and the results the store holds for it, so it has the same fields, `failed` included. A replay covers exactly the last `MAX_REPLAY` blocks at most: `oldest` is `height - MAX_REPLAY + 1`, so a client that was away for longer gets the most recent thousand, `[height - 999, height]`, and must fetch the rest itself. The `: connected` line is an SSE comment, harmless to parsers and useful to a client waiting for the headers. The stream is removed when the socket closes, which is also what frees the per-address slot; the test comments that a cancelled fetch takes a moment to be noticed. A replay for a pruned height stops at the first block the store no longer has.

Event types and their bodies:

| event | id | data |
|---|---|---|
| `block` | height | `{ height, hash, time, txs (number), failed (number, or null for a block with transactions whose results the node does not hold), appHash, proposer }`, the same live and replayed |
| `tx` | height | `{ hash, height, index, ok, error }`, one per transaction in the block, or only the one named by `tx=` |
| `account` | height | `{ account, height, kind, txHash (or null), position (or null), opIndex, data (hex) }`, one per history entry written for the account in this block |
| `validatorSet` | height | `{ height, updates: [{ publicKey, power }] }`, only for blocks whose application emitted updates |

Seen from a terminal, a stream asking for blocks and transactions looks like this (`curl -N` keeps the connection open; hashes shortened):

```
$ curl -N 'http://127.0.0.1:26657/events?types=block,tx'
: connected

event: block
id: 42
data: {"height":"42","hash":"9c1e…","time":"1761600000123","txs":1,"failed":0,"appHash":"5b77…","proposer":"e0a4…"}

event: tx
id: 42
data: {"hash":"31d0…","height":"42","index":0,"ok":true,"error":""}

```

If the connection drops after that, reconnecting with `-H 'Last-Event-ID: 42'` makes the server replay the `block` records for 43 onwards from its store, each with the fields a live one has, before continuing live.

**`send(s, event, id, data)`** writes one SSE record, after checking what the stream still has queued:

```ts
  private send(s: Stream, event: string, id: bigint, data: unknown): void {
    if (!this.streams.has(s)) return;
    // A consumer that stops reading would otherwise hold every event since; it gets cut off and may resume with Last-Event-ID.
    if (s.res.writableLength > MAX_STREAM_BACKLOG) {
      this.streams.delete(s);
      s.res.end();
      return;
    }
    s.res.write(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
  }
```

`res.write` on a socket the client is not reading does not fail; it queues the bytes in the process, and `writableLength` is how much is queued. A stream whose consumer has stopped reading (a suspended laptop, a proxy holding the connection, a client that deliberately never reads) would otherwise make the server keep every event since, for up to `maxStreams` streams per address and as many addresses as care to connect, which is a cheap way to exhaust a node's memory from outside. Ending the stream at one MiB of backlog is safe because SSE has a resume protocol: the client reconnects with `Last-Event-ID` and the replay above fills in the blocks it missed. The `has(s)` check at the top covers the case where a stream was dropped earlier in the same `push` loop.

**`push(e)`** is the fan-out on every committed block:

```ts
  private push(e: CommittedEvent): void {
    const h = e.block.header.height;
    for (const s of this.streams) {
      if (s.types.has('block')) this.send(s, 'block', h, blockEventJson(e.block, e.results));
      if (s.types.has('tx')) {
        e.block.txs.forEach((tx, i) => {
          const hash = toHex(txHash(tx));
          if (s.tx && s.tx !== hash) return;
          const r = e.results[i]!;
          this.send(s, 'tx', h, { hash, height: h.toString(), index: i, ok: r.ok, error: r.error ?? '' });
        });
      }
```

The `account` branch walks the block's history entries and sends those for the stream's account; `data` is sent as the raw encoded entry (hex), not decoded as `accountHistory` decodes it. The `validatorSet` branch sends `jsonify(e.updates)` when there are any. `push` never awaits, so a slow stream cannot stall the executor's listener; what it could once do was grow its socket buffer without bound, which `send` now refuses.

### src/rpc/client.ts

Purpose: the whole protocol in one method, plus typed helpers for the CLI and the light-client provider.

**`RpcClientError`** carries the JSON-RPC `code`. **`RpcClient`** keeps the base `url` (a trailing slash stripped) and a counter for ids.

```ts
  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.url + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    });
    if (res.status === 429) throw new RpcClientError(-32004, 'rate limited');
    if (!res.ok) throw new RpcClientError(-32000, `http ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (j.error) throw new RpcClientError(j.error.code, j.error.message);
    return j.result as T;
  }
```

Every call is one request with an id, never a batch and never a notification; `params` is always an object, matching what the server insists on. An HTTP 429 becomes the rate-limited code whether it came from the request-level check or the stream endpoint; other non-2xx statuses become `-32000` with the status in the message. The typed helpers, `status()`, `header(height)`, `commit(height)`, `validators(height)`, `validatorSet(hash)`, `account(name, prove)`, `broadcastTx(txHex, mode, timeoutMs)`, `tx(hash, prove)`, `parameters()` and `proposals()`, convert bigints to decimal strings and nothing else; results are returned as the parsed JSON (`any`), and the caller uses `headerFromJson` and friends from `json.ts` when it needs typed values. The provider in chapter 13 does exactly that.

The server is started in three places: `src/cli.ts` (`start`, on the node's p2p port plus one), `scripts/localnet.ts` (port 26657) and the tests and benchmarks (`port: 0`).

## How it is tested

`test/rpc.test.ts` starts a four-validator in-memory testnet with the core application and an `RpcServer` on node 0 at an ephemeral port, and talks to it with `RpcClient` over real HTTP.

- "answers status, headers, commits, validator sets, objects and keys with proofs that verify": `status` reports the chain id, a height of at least 2 and three peers; a `header` fetched over JSON hashes to the same value as the block in the node's store, so `jsonify` and `headerFromJson` are inverses on headers; a `commit` has four signature slots; `validators` round-trips through `validatorSetFromJson` to the hash the server reported, and `validatorSet` by that hash gives the same set; an `object` proof for the faucet account at height `h - 1` verifies with `verifyObjectProof` against header `h`'s app hash (the deferred-execution rule, over the wire); `account('faucet', true)` returns `3.0` with a `CORE` balance and a name proof whose verified value is the 8-byte id `0003000000000000`; an unknown account is `null`; `header` for height 999999 is `-32001`; an unknown method is `-32601`; `genesis`, `peers`, `mempool` and `accounts` return what they should.
- "broadcasts in sync and commit mode, finds transactions with proofs, and records history": an `accountCreate` in commit mode comes back with `ok: true` and the right hash; a transfer in sync mode comes back `added`; re-broadcasting the same transfer in commit mode after it landed returns its height at once (the `txLocation` short cut); a transfer signed by the wrong key is `-32002`; `tx(hash, true)` returns `ok`, the decoded operation with `to: '3.1'`, and a proof that `verifyTxQuery` accepts as `{ ok: true, error: '' }` against the sets for its two heights; an unknown hash is `-32001`; `accountHistory` for alice lists two `operation` entries, the second a transfer of `5000`; `balance` is `5000`; `delegation` to a validator id that does not exist is `-32001`.
- "streams events, replays blocks from Last-Event-ID, and enforces the limits" runs with limits of 2 per second, burst 6, 2000-byte bodies and 2 streams: a stream on `/events?types=block,tx` has the SSE content type and delivers a `block` record with an `id` within a block time; a second stream opens and a third is 429; a 5000-byte POST is 413; a reconnect with `Last-Event-ID: 1` replays block 2 (`id: 2`), and an immediate second replay is 429 because replay is charged; a burst of `status` calls then meets `-32004`. The `read` helper throws if the stream has ended instead of spinning, the lesson of finding 31.
- "serves a light client over the RPC": `LightClient.trust` through `RpcProvider` at height 2 verifies to the latest height, verifies a name proof fetched with `account('faucet', true)` against header `height + 1` from the same RPC, and refuses a trust anchor whose hash is wrong. Chapter 13 covers what that proves about the client; for the RPC it proves that `header`, `commit`, `validatorSet` and `status` carry everything a light client needs.
- "reports the parameters in force so a wallet can price its operations, and the open proposals" (in the `json-rpc parameters` group): `parameters` reports the core asset `{ id: '4.0', symbol: 'CORE', precision: 5 }`, the genesis fee overrides (`transfer.fee` 250, `accountCreate.premiumFee` 20000) and the staking parameters, and `chainParametersFromJson` of the result equals the application's own `chainParameters()`; `proposals` is empty; a transaction priced from the served schedule is included while one priced from `DEFAULT_FEES` is refused with "states a fee of 100, the schedule requires 250" (the `-32002` message carries the application's reason).

`test/review.test.ts`, "survives an aborted request body on the RPC": a raw TCP client sends a POST with `Content-Length: 500`, ten bytes of body and then destroys the socket; 100 ms later a normal `status` call still succeeds. This is the regression test for finding 13.

`test/memory.test.ts`, "sheds load, keeps following the chain, and resumes when the heap eases": with the node's memory guard fed a heap at 90% of its limit, `broadcastTx` in sync mode rejects with `-32004` while the mempool is at its lowered limit and with `-32002` once it has room (the application refusing the test's bytes), `block` rejects with `-32004`, `GET /events` is 503, `/health` reports `memory: 'pressure'`, and `status.memory` is `{ level: 'pressure', shedding: true, heapUsed: 900, database: { objects: 'capped', indexTrees: 'dropped', trees: 'dropped' } }`, every tier of the database reporting its degraded mode; before the pressure `status.memory` was `{ level: 'ok', shedding: false }`, and once the heap eases and the trees are rebuilt `block` answers again.

`test/review2.test.ts` adds two cases for this chapter. "holds the RPC to its parameter types, seeks listing cursors, and does not wait for a transaction it has already refused" sends `prove` as a string and `limit` as a string and expects `-32602` for each, lists accounts page by page with `after` and checks the pages join up with nothing repeated and nothing skipped, broadcasts a transaction the mempool refuses and then re-broadcasts it in commit mode, which must answer `-32002` at once rather than wait for the timeout, sends a request whose `id` is an object to get `-32600`, and then the notification cases: a `status` request without an `id` is answered 204 with an empty body, and a batch of a notification, a request with `id: 7` and a notification for an unknown method is answered with an array whose only member carries id 7. "refuses a header whose bytes moved between hash fields, and integers a double cannot hold" is about `json.ts`: a header JSON whose `lastBlockHash` holds the 64 bytes of two hash fields while `lastCommitHash` is empty, so that the concatenation is unchanged, is refused by `headerFromJson`, as is one with a 20-byte `proposerAddress`, and `parseBigint` refuses `2 ** 53` and `-1` as numbers while accepting `7`.

`test/review4.test.ts`, "answers balance, account, key, validator and delegation as of the height asked for, with the proof of that height", runs four validators of the core application with a staking genesis and an `RpcServer` on node 0. It creates an account, pays it 5,000, delegates to `op0` and pays 700 more, each in commit mode so the heights are known, and then asks: `balance` is 5,700 now, 5,000 at the height of the first payment, 0 by id before the account existed and `-32001` by name there, and `-32001` with `is not kept` for height 99,999, as is `object`; `key` gives `3.5` at the creation height and null one height before, with a proof of absence that `verifyKeyProof` accepts against the app hash of the next header, and `account` likewise; `account` at the first payment's height has a balance of 5,000, a history of 2 and a proof that verifies to the account's id, and now 5,700 and 3; a name no account can have gives `account: null`; `validator` one height before the delegation has the tokens it had, one delegator (the operator), the same self-bond and its operator's name, and now 300 tokens more and two delegators; `delegation` there is null with an empty `unbonding` list and a proof of absence, and now holds the tokens with an empty `unbonding` list. The faucet then undelegates a third of its shares and after that the rest, which removes the delegation, and the test waits until the entries have matured (the genesis sets an unbonding period of 2 s) and are removed, so that the latest state has no delegation, no entries and one delegator. The heights in between still answer: at the first undelegation's height the delegation exists with one unbonding entry and the validator has two delegators; at the second's the delegation is null, there are two entries whose tokens sum to the 300 tokens delegated, and the validator has one delegator; at the delegation's height `unbonding` is empty. It then waits for a pong from every peer and requires each `clockOffsetMs` from `peers` to be under a second, and last starts a second server with a burst of 6 refilled at 0.001 a second: a first batch of five `status` calls is answered whole, and of a second, four are answered `-32004` in their places.

`test/review5-rpc.test.ts` has six cases for the server, each on four validators of the core application whose operators are the accounts `3.1` to `3.4` and whose validators are `7.0` to `7.3`. "hears of no commit once it is stopped, and answers those waiting for a transaction" starts a second `RpcServer` on the same node, waits until a commit has reached its `push`, registers a waiter with a timeout of a minute and stops the server: the waiter's promise resolves to null at once, `waiting` is back at 0, a further `waitForTx` returns null, and two more blocks of the node reach `push` no more. "is stopped only once the methods it was running have returned" replaces the `status` entry of the server's method table with a function that sleeps 300 ms, sets a flag and returns an empty object, as a broadcast waits on the mempool; it calls `status` through the client, waits 50 ms and stops the server with `stop(0)`, which cuts the connection at once. When `stop` has returned the flag is set, so the method ran to its end first, and the client's call was rejected, its connection having been cut. "replays a block event as it was pushed, failed count and all, and says when it holds no results to count" reads three live `block` events around a transfer broadcast in commit mode, reconnects with the `Last-Event-ID` before the first of them and requires the three replayed records to equal the three pushed ones; then, with the store's `loadResults` made to return null, a replay gives the block of the transfer as `{ txs: 1, failed: null }` and an empty block with `failed: 0`. "opens an account stream only for an account there is, named or by id": `account=op0` and `account=3.1` are 200, and `nobody`, `3.999`, the validator id `7.0` and two ids whose numbers no id can hold are 404. "knows no method by a name every object inherits, and answers a malformed request under the id it carries": `toString`, `constructor`, `hasOwnProperty` and `__proto__` are each `-32601`; a request without `jsonrpc` and with `id: 7`, and one with a numeric `method` and `id: 'seven'`, are `-32600` under their own ids, and one with no id or with an object for an id is `-32600` under `id: null`. "finds a validator by the account id of its operator, as by the name": `validator` with `operator: 'op0'`, `operator: '3.1'`, `id: '3.1'` and `id: '7.0'` at one height give the same answer; `delegation` with `validator: '3.1'` equals the one with `validator: '7.0'`; the faucet's id `3.0` is `-32001` with `3.0 runs no validator` in both methods, and `7.9` is `-32001` with `no such validator`. The file's other cases belong to chapters 13 and 14.

`test/chain.test.ts` exercises `node.queryState`, `node.queryAccountName` and `node.queryTx`, which are what the `object`, `account` and `tx` methods serve; see chapter 13 for the cases. `test/schemes.test.ts` starts an `RpcServer` on a chain whose genesis names secp256k1 and expects `status` to report `signatureScheme: 'secp256k1'`.

For numbers, `README.md` ("Steady state at that size") reports the RPC on a gigabyte state with 16 clients and an idle chain at 4,300 `account` calls with proof, 5,700 `object` with proof, 6,200 `accountHistory` and 7,100 `status` per second; `broadcastTx` from 16 clients at 1,330 transactions per second over 13 blocks, and 1,220 per second with 8 more clients reading accounts with proofs throughout. The benchmark (`bench/scale.bench.ts`) runs the server with the limits raised out of the way.

## Limitations and ideas

Known simplifications, most of them recorded in `DESIGN.md` section 10 or the review:

- No authentication and open CORS. The server is meant for loopback or behind a proxy that does the gatekeeping.
- `accounts` lists names from the live index (the objects it returns are committed), and `accountHistory` and the listings answer for the latest state only. At a past height `validator` counts delegators and `delegation` lists unbonding entries by reading every object of the type changed since, since both kinds of object are removed and their indices are not authenticated; the cost grows with how far back the height is and was not measured, and neither answer comes with a proof.
- `snapshots` always returns `[]`; snapshot heights are advertised over p2p (chapter 7), not here.
- Only `block` events are replayed on reconnect, and only the last 1000; a client that wants a gapless `tx` or `account` feed, or was away longer, must fetch history for the missed heights itself.
- A stream dropped for its backlog loses the `tx`, `account` and `validatorSet` events between the drop and the reconnect, since those are not replayed.

Exercises:

1. Add a `txSearch` method that returns the transactions of an account between two heights, built on `accountHistory` and `tx`. Decide how to page it and what it should cost.
2. Make `accounts` height-aware: read the names from the `byName` index at a past version. Chapter 9's index history is the starting point; measure what it costs.
3. Implement `snapshots` by asking the node for the heights its snapshot store holds, so a client can learn them without a peer connection, and decide whether `status` should carry them too.
4. Replay `tx` events on reconnect using `store.loadResults(height)`, which `queryTx` already uses, and charge for it by the number of transactions rather than blocks.
5. Make the stream backlog bound part of `RpcLimits` instead of a module constant, and write a test with a client that opens a stream and stops reading: the server must end it once the bound is passed and must not grow its memory meanwhile.
6. Write a WebSocket transport beside SSE that accepts JSON-RPC requests on the same socket as the subscriptions, which is what Tendermint's `/websocket` endpoint does, and compare what the client code looks like.

## Where to next

The [light client](13-light-client.md) is the first consumer of these methods that does not trust the node answering them.
