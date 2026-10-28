# 14. Wallet and CLI

This chapter is where a person meets the chain. `src/wallet/keystore.ts` keeps signing keys encrypted on disk, and `src/cli.ts` is the command line that creates a testnet, runs a node, and otherwise acts as a wallet and query tool over the [RPC](12-rpc.md). The CLI builds transactions with the signing client from the [application](11-application.md) chapter (`src/app/core/client.ts`), prices them from the fee schedule the node reports, signs them with keys from the keystore, and verifies what the node tells it with the [light client](13-light-client.md). Its `start` command is also the only place in the repository that assembles a complete [node](08-node.md) over TCP with LMDB storage and an RPC server. Nothing in the chain depends on these two files; everything a user does goes through them.

## Concepts

**Seeds and deterministic keys.** ML-DSA-44 key generation is deterministic from a 32-byte seed (`keyPairFromSeed` in `src/crypto/keys.ts`, chapter 2): the same seed always yields the same 1,312-byte public key and 2,560-byte secret key, and the address is `sha256(publicKey)`. So a wallet only ever has to store seeds. That is what makes a keystore small and makes "export" a 64-character hex string.

**An encrypted keystore.** The problem is to keep seeds on disk such that the file reveals nothing without a passphrase, and such that a wrong passphrase is detected rather than producing garbage keys. Two primitives do it. *scrypt* is a password-based key derivation function designed to be expensive in memory as well as time, so that guessing passphrases in bulk on specialised hardware is costly; it takes the passphrase, a random salt (so two keystores with the same passphrase derive different keys) and the cost parameters `N`, `r`, `p`, and produces a key of any length, here 32 bytes. *AES-256-GCM* is authenticated encryption: it encrypts with a 12-byte IV (which must never repeat under one key) and produces a 16-byte authentication tag; decryption with the wrong key or a tampered ciphertext fails the tag check instead of returning wrong bytes. The keystore derives one key per file from the passphrase and salt, and seals each seed under it with its own IV. A wrong passphrase derives a wrong key, every tag check fails, and `get` reports "wrong passphrase". This is the same construction as the BitShares `cli_wallet`'s encrypted `wallet.json` and Ethereum's keystore files (scrypt plus AES, with a check on the result), with GCM standing in for a separate MAC. `RPC-SYNC-PROOFS.md` section 3.6 fixes the file format and the parameters, and section 5 lists them: scrypt N 32768, r 8, p 1.

**Atomic writes.** A keystore that is rewritten in place on every `add` can be destroyed by an interruption mid-write; review finding 26 made the point that this loses every key, not just the one being added. The keystore now writes through `writeAtomic` from `src/store/files.ts` (chapter 10): write to a temporary file, `fsync` it, rename over the original, `fsync` the directory. The same helper protects the validator's signing guard.

**Two writers, one file.** Atomic replacement protects against a crash, not against a second writer. A keystore handle that reads the file once and rewrites the whole of it from memory on every change loses whatever another handle, or another process, wrote in between: the last writer wins, and a key added by one `keys add` can vanish under a concurrent one. The usual remedy is a lock file: a writer creates `<path>.lock` exclusively (the `wx` flag fails if it exists), so only one writer at a time gets past that line; it then re-reads the file from disk, applies its one change to what is there, writes atomically, and removes the lock. A lock that an interrupted process left behind would block everyone forever, so one older than a bound is treated as abandoned. The keystore does all of this in one private method, `mutate`, through which every write goes.

**Authorities.** An account's permissions are an `Authority`: a threshold and weighted keys or other accounts (chapter 11). The CLI makes the simplest kind with `makeAuthority([publicKey])`, one key with weight 1 and threshold 1, for both `owner` and `active`. This is BitShares' account model, and it is why "create an account" in this chain is an operation that someone already funded (the faucet) must sign: accounts are objects with names, not addresses that appear when they receive coins.

**How a wallet builds, prices and signs a transaction.** The steps, in the CLI's `send`:

1. Learn the chain id (`status`) so the signature is bound to this chain.
2. Resolve the names the user typed to object ids (`account`, `validator` methods), because operations name accounts and validators by id.
3. Convert whole-token amounts to base units using the core asset's `precision`.
4. Fetch the fee schedule (`parameters`) and state every operation's fee from it with `withFees`. `FEES.md` section 1 explains why an operation carries its own fee: "what you sign is what you pay", the BitShares `set_fee` rule, so that a schedule change cannot silently charge more than the signer agreed to; a transaction priced under an old schedule fails at inclusion instead.
5. Set an expiration a minute ahead, sign the body with the signer's key (`signedTxBytes`, which signs with a domain-separated context and the chain id), and encode.
6. `broadcastTx` in `commit` mode and print where it landed.

**Verifying what the node says.** A wallet that trusts its node completely is a thin client, not a light client. Two CLI commands go further: `account` asks for a name proof and checks it with the light client against a header it verified itself, and `verify-tx` does the same for a transaction's inclusion and result. The anchor is kept in `light.json` next to the keystore and is trust-on-first-use unless the user ran `light trust <height> <hash>` with a hash obtained elsewhere. The anchor need not predate what is being verified: for a height after it the client moves trust forward, and for one before it the client walks the hash chain back from the anchor (chapter 13), so an old transaction verifies from a recent anchor. Review findings 23 and 24 are the two mistakes this guards against: verifying against a header supplied by the same server, and verifying a proof without checking it is for the transaction that was asked about.

**Targets.** Every client command takes a *target*: either a node directory, from which the RPC address (`config.json`'s `rpcListen`, or the p2p port plus one) and the testnet's shared `keystore.json` are found, or an `http://` URL, in which case `--keystore` names the keystore (default `./keystore.json`). `--rpc` replaces the URL and nothing else: a node directory target keeps its keystore and stays a node directory for the commands that need one. The passphrase comes from `--passphrase-file`, the `CHAIN_PASSPHRASE` variable, or a hidden prompt, in that order of preference.

## The code, file by file

### src/wallet/keystore.ts

Purpose: named seeds sealed under one passphrase, in a JSON file a person can inspect.

Two private shapes describe the file. `SealedKey` is `{ address, publicKey, iv, ciphertext, tag }`, all hex; `KeystoreFile` is `{ version: 1, kdf: { name: 'scrypt', N, r, p, salt }, keys: Record<name, SealedKey> }`. Public keys and addresses are stored in the clear on purpose: `publicKeyOf` can read them without the passphrase, which is what `init` would need to write a genesis from a locked keystore. On disk, with the hex shortened, a keystore holding one key looks like this:

```json
{
  "version": 1,
  "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "…" },
  "keys": {
    "faucet": { "address": "…", "publicKey": "…", "iv": "…", "ciphertext": "…", "tag": "…" }
  }
}
```

The sizes follow from the primitives: the salt is 16 random bytes (32 hex digits), the address is a sha256 (64), the public key is ML-DSA-44's 1,312 bytes (2,624), the IV is 12 bytes (24), the ciphertext is the 32-byte seed with no padding since GCM is a stream mode (64), and the tag is 16 bytes (32).

**`SCRYPT`** is the exported parameter set `{ N: 32768, r: 8, p: 1 }`. The derivation:

```ts
private static derive(passphrase: string, kdf: KeystoreFile['kdf']): Buffer {
  return scryptSync(passphrase, Buffer.from(kdf.salt, 'hex'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r });
}
```

`maxmem` is Node's guard against scrypt allocating more than expected; `128 * N * r` bytes is scrypt's requirement and twice that is allowed. The parameters are read from the file, not from the constant, so a keystore written with other costs still opens.

**`Keystore`** has a private constructor holding the `path`, the parsed `file` and the derived `key`. Three ways to get one:

- **`create(path, passphrase)`** refuses an existing path, writes a fresh file with a random 16-byte salt and no keys through `mutate` with `fresh` set, which refuses the path again under the lock in case the file appeared in between, and returns the keystore.
- **`open(path, passphrase)`** parses the file, refuses any version but 1 or any KDF but scrypt, derives the key, and then "checks the passphrase against the first key, if any" by decrypting it. The test is `first !== undefined`, not a truthiness test: whenever a key exists, whatever its name, the check runs. An empty keystore cannot detect a wrong passphrase, which is a consequence of there being no separate passphrase check value in the file. What happens then is worth stating exactly, because it is easy to overstate: the first `add` seals its seed under the key scrypt derives from whatever passphrase was typed. That derivation is deterministic, so the seed is not lost; it opens with the mistyped passphrase and refuses the intended one, and the next `open` with the intended passphrase fails the check against that first key and says "wrong passphrase". (The check happens at `open`; the CLI's `keys` command on an empty keystore relies on the user typing the passphrase correctly.)
- **`openOrCreate(path, passphrase)`** is what the CLI calls: open if the file exists, else create.

**`list()`** returns `{ name, address, publicKey }` for every key, without unlocking anything, and **`has(name)`** checks the name; both reflect the file as this handle last read or wrote it, so a key another handle added since is seen after this handle's next write, or by opening the file again. **`add(name, seed = generateSeed())`**:

```ts
  add(name: string, seed: Uint8Array = generateSeed()): KeyPair {
    if (name === '') throw new Error('a key needs a name');
    if (this.has(name)) throw new Error(`key ${name} already exists`);
    if (seed.length !== SEED_SIZE) throw new Error(`seed must be ${SEED_SIZE} bytes`);
    const pair = keyPairFromSeed(seed);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
    const sealed: SealedKey = { address: toHex(pair.address), publicKey: toHex(pair.publicKey), iv: iv.toString('hex'), ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
    this.mutate((keys) => {
      if (name in keys) throw new Error(`key ${name} already exists`); // another handle got there first
      keys[name] = sealed;
    });
    return pair;
  }
```

A name that is not empty and not taken, a seed of the right size, a fresh IV per seed; the seed is sealed before the lock is taken, so the key generation and the encryption are not done while other writers wait, and the insertion happens under the lock against the keys on disk at that moment. The second `already exists` check is the one that matters between handles: this handle's `has` saw the file as it last read it, and a name another handle added since is only visible under the lock. The empty name is refused for two reasons: `keys add ''` would store a key that no later command can name, and the empty string is the one name that a truthiness test in `open` would have skipped, leaving a keystore whose only key never checked the passphrase. `add` is both "generate" and "import": the CLI's `keys import` passes a seed, `keys add` lets the default generate one.

**`get(name)`** is the inverse and the passphrase check:

```ts
get(name: string): KeyPair {
  const k = this.file.keys[name];
  if (!k) throw new Error(`no key named ${name}`);
  const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(k.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(k.tag, 'hex'));
  let seed: Buffer;
  try {
    seed = Buffer.concat([decipher.update(Buffer.from(k.ciphertext, 'hex')), decipher.final()]);
  } catch {
    throw new Error('wrong passphrase');
  }
  return keyPairFromSeed(new Uint8Array(seed));
}
```

`decipher.final()` is where GCM verifies the tag; any failure is reported as a wrong passphrase, which is also what a corrupted ciphertext looks like. The returned `KeyPair` holds the seed, both keys and the address, regenerated from the seed each time.

**`seedOf(name)`** returns the raw seed for export. **`remove(name)`** deletes the name under the lock (it has no CLI command). **`publicKeyOf(name)`** reads the stored public key without decrypting.

**`mutate(op, fresh = false)`** (private) is the one write path:

```ts
  private mutate(op: (keys: Record<string, SealedKey>) => void, fresh = false): void {
    const lock = this.path + '.lock';
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
        } catch {
          // Gone already, or unreadable: the next attempt tells.
        }
        if (Date.now() > deadline) throw new Error(`${this.path} is locked by another process`);
        sleepSync(LOCK_RETRY_MS);
      }
    }
    try {
      let keys = this.file.keys;
      if (existsSync(this.path)) {
        if (fresh) throw new Error(`${this.path} already exists`);
        const disk = JSON.parse(readFileSync(this.path, 'utf8')) as KeystoreFile;
        if (disk.version !== 1 || disk.kdf.name !== 'scrypt') throw new Error('unsupported keystore');
        // Keys sealed under another salt would not open with this handle's key; the file is not the one it read.
        if (disk.kdf.salt !== this.file.kdf.salt) throw new Error(`${this.path} was recreated with another passphrase; open it again`);
        keys = disk.keys;
      }
      op(keys);
      this.file.keys = keys;
      writeAtomic(this.path, new TextEncoder().encode(JSON.stringify(this.file, null, 2)));
    } finally {
      unlinkSync(lock);
    }
  }
```

Two halves. The first takes the lock: `openSync(lock, 'wx')` creates `<path>.lock` and fails with `EEXIST` if it is already there, in which case the method checks the lock's age, removes it if it is older than `LOCK_STALE_MS` (30 s, "left by a process that died holding it; no write takes nearly as long"), and otherwise sleeps `LOCK_RETRY_MS` (20 ms) and tries again until `LOCK_WAIT_MS` (5 s) has passed, when it gives up with "is locked by another process". The sleep is synchronous (`Atomics.wait` on a throwaway shared buffer), because the keystore's interface is synchronous like the store's, and a wallet command has nothing else to do meanwhile. The second half, under the lock, starts from the keys on disk, not from memory: it re-reads the file, checks it is still a keystore this handle can use (the salt must be the one it derived its key from, or the keys on disk were sealed under another passphrase and merging would produce a file that opens with neither), applies `op` to those keys, adopts them as its own, and writes atomically. With `fresh`, which only `create` passes, an existing file is refused instead of read. The `finally` removes the lock on every exit, including a throw out of `op`, which is how `add`'s second "already exists" leaves no lock behind. Two handles over one file, or two processes, therefore keep each other's keys: each write merges into what is there rather than overwriting it.

The invariants: nothing in the file reveals a seed without the passphrase; the same passphrase and salt always derive the same key; each seed has its own IV; the file on disk is always either the old version or the new one; and a change made through one handle is never undone by another.

### src/cli.ts

Purpose: one file, one process, one command per run. The header comment is the usage text, and `main` is a `switch`. It uses Node's `process.argv` directly and no argument library.

**`NodeFiles`** is the shape of a node directory's `config.json`: `name`, `listenAddr` (p2p), `rpcListen`, `seeds` (the other nodes), `nodeKeySeed`, `validatorSeed` (null for a full node), and the optional `stateSync { trustHeight, trustHash, backfill }`, `retain { blocks, versions, snapshots }` and `snapshotInterval` that chapter 7 and chapter 10 describe. **`UNBONDING_MS`** is seven days, used both for the genesis staking parameters and for the consensus `maxEvidenceAgeMs`.

**Argument handling.** Everything after the script name is split into `flags` (`--name value` pairs) and `positional` words; `cmd` is the first positional and `args` the rest. **`need(i, what)`** returns `args[i]` or throws `` `missing ${what}` ``. **`target(arg)`** turns the first argument into an `RpcClient`, a keystore path and maybe a node directory:

```ts
/** A node directory gives an RPC URL and a keystore next to the testnet's genesis; a URL stands alone. */
function target(arg: string): { rpc: RpcClient; keystorePath: string; nodeDir: string | null } {
  if (/^https?:\/\//.test(arg)) {
    return { rpc: new RpcClient(flags.get('rpc') ?? arg), keystorePath: flags.get('keystore') ?? resolve('keystore.json'), nodeDir: null };
  }
  // A node directory still names the keystore and the node even when --rpc points somewhere else.
  const nodeDir = resolve(arg);
  const cfg = JSON.parse(readFileSync(join(nodeDir, 'config.json'), 'utf8')) as NodeFiles;
  const rpcListen = cfg.rpcListen ?? `127.0.0.1:${Number(cfg.listenAddr.split(':')[1]) + 1}`;
  return { rpc: new RpcClient(flags.get('rpc') ?? `http://${rpcListen}`), keystorePath: flags.get('keystore') ?? join(nodeDir, '..', 'keystore.json'), nodeDir };
}
```

A node directory's keystore is the one `init` wrote one level up, shared by the whole testnet. `--rpc` overrides the URL and only the URL: a node directory target keeps the testnet's keystore and its `nodeDir`, so `create-validator ./testnet/node2 --rpc http://other:26657` still reads node 2's consensus key from its `config.json` and signs with the testnet's operator key while talking to another node. The positional target is still required by `need(0, 'target')`, and a URL target is unaffected by the flag.

**`passphrase()`** reads `--passphrase-file`, then `CHAIN_PASSPHRASE`, then prompts. The prompt hides the echo by replacing `stdout.write` after the prompt text has been written and swallowing everything until the answer arrives; it is a trick, not a terminal mode change, and it is restored in the callback. Everything, not only single-character writes: readline echoes a typed character one at a time, but on an edit (a backspace, a cursor movement) it redraws the whole line, prompt and typed text together, and a filter that let longer writes through would print the passphrase typed so far the first time the user corrected a mistake. **`openKeystore(path)`** is `Keystore.openOrCreate(path, await passphrase())`. The `keys` command guards it: `list` and `export` throw `` `no keystore at ${path}` `` when the file does not exist, so a mistyped `--keystore` cannot quietly create an empty keystore, while `add` and `import` create one on purpose.

**`init(dir, count, basePort)`** writes a testnet:

```ts
const pass = process.env.CHAIN_PASSPHRASE ?? 'testnet';
const ks = Keystore.create(join(dir, 'keystore.json'), pass);
const faucet = ks.add('faucet');
const seeds = Array.from({ length: count }, () => ({ node: generateSeed(), val: generateSeed() }));
const operators = seeds.map((_, i) => ks.add(`op${i}`));
const account = (name: string, publicKey: Uint8Array, balance: string) => ({ name, owner: authorityJson([publicKey]), active: authorityJson([publicKey]), balance });
const genesis: Genesis = {
  chainId: `chain-${toHex(generateSeed()).slice(0, 8)}`,
  genesisTime: BigInt(Date.now()),
  consensus: { maxEvidenceAgeMs: BigInt(UNBONDING_MS), version: 1 },
  appState: appGenesisBytes({
    accounts: [account('faucet', faucet.publicKey, '1000000000000'), ...operators.map((k, i) => account(`op${i}`, k.publicKey, '5000000000'))],
    staking: { unbondingPeriodMs: UNBONDING_MS },
    communityPool: 100_000,
    validators: seeds.map((s, i) => ({ operator: `op${i}`, consensusKey: toHex(keyPairFromSeed(s.val).publicKey), selfBond: 20_000 })),
  }),
};
```

The keystore gets a `faucet` key and one operator key `op0..opN-1`; each node gets a p2p key seed and a consensus key seed, which go into its `config.json` in the clear (node keys are not wallet keys; the validator's consensus seed has to be readable by the node process). The genesis funds the faucet with 10^12 base units, each operator with 5x10^9, and registers each node's consensus key as a validator operated by `opN` with a self-bond of 20,000 whole tokens; the application-owned validator set is chapter 11's territory. Ports: p2p at `basePort + 2i`, RPC at `basePort + 2i + 1`, and each node's `seeds` are all the others. The passphrase is `CHAIN_PASSPHRASE` or the word `testnet`, and the command prints it, as the spec requires.

**`start(nodeDir)`** assembles a node: the config and the genesis one directory up, a `WorkerVerifier` (chapter 2's thread pool), a logger at `LOG` level, an `LmdbEnv` under `data/lmdb`, then `Node.create` with the TCP transport, seeds, state-sync anchor and retention from the config. After `node.start()` it opens an `RpcServer` on `rpcListen`, logs a status line every five seconds (height, peers, mempool size, round, active validators, community pool) and shuts everything down in order on `SIGINT` or `SIGTERM`: RPC, node, LMDB, verifier.

**Client helpers.**

- `chainInfo(rpc)` returns `{ chainId, precision, coreAsset }` from `status` and `object` for id `4.0`. The core asset's id is hard-coded here (asset type 4, instance 0, which genesis creates first) rather than read from `parameters`, which also reports it.
- `toUnits(amount, precision)` turns `"12.5"` into base units. The amount must match `^\d+(\.\d+)?$` (digits, optionally a point and digits: no sign, no exponent, no thousands separator) and may not carry more decimals than the asset's precision; `12.345678` at precision 5 is refused rather than truncated to `12.34567`. A wallet that rounds what the user typed sends an amount the user did not type, and does so silently; refusing costs one retyped number. `whole(units, precision)` prints base units with exactly `precision` decimals.
- `accountId(rpc, name)` and `validatorId(rpc, operator)` resolve names through the `account` and `validator` methods.
- `send(rpc, operations, signer)` is the wallet's core:

```ts
/** Price the operations from the live schedule, sign, and wait for inclusion. */
async function send(rpc: RpcClient, operations: OperationDraft[], signer: KeyPair): Promise<void> {
  const { chainId } = await chainInfo(rpc);
  const params = await rpc.parameters();
  const fees = feeScheduleFromJson(params.fees);
  // A minute ahead, or half of what the chain allows when that is less: block time may trail the wall clock a little.
  const maxAhead = BigInt(params.maxTxExpirationMs) / 2n;
  const ahead = maxAhead < 60_000n ? maxAhead : 60_000n;
  const tx = signedTxBytes(chainId, { expiration: BigInt(Date.now()) + ahead, operations: withFees(operations, fees) }, [signer]);
  const r = await rpc.broadcastTx(toHex(tx), 'commit');
  console.log(r.ok ? `included at height ${r.height} (tx ${r.hash.slice(0, 16)}..)` : `failed at height ${r.height}: ${r.error}`);
  if (!r.ok) process.exitCode = 1;
}
```

An `OperationDraft` is an operation without its `fee`; `withFees` fills it from the schedule with `calculateFee`, which knows that account creation is priced by name (cheap or premium) and by size, that asset symbols are priced by length, and that everything else has a flat fee. One signer, one signature. The expiration is a minute ahead, or half of the chain's `maxTxExpirationMs` when that is shorter: `applyTransaction` refuses an expiration further past block time than the chain allows, so on a chain with a short window a fixed minute would have every transaction the CLI built refused as "too far in the future", and half the window leaves room for block time trailing the wall clock. A transaction refused at check time (`-32002`) surfaces as the `RpcClientError` that `main` prints; one included but failed prints the application's error from the result and sets the exit code to 1, so a script that drives the CLI can tell the two outcomes apart without parsing the text.

- `keyFor(keystorePath, name)` opens the keystore (prompting if needed) and returns the named key.
- `leaves(o)` flattens a nested parameters object to `"fees.transfer.fee" -> value` pairs; `parameters` prints them, `proposals` diffs each proposal's parameters against the live ones, and `proposedParameters(rpc, overrides)` applies `path=value` overrides to the live parameters, keeping a number a number and a string (an amount) a string, and parses the result with `chainParametersFromJson` so a typo in a path is refused before anything is signed.

**`lightClient(rpc, keystorePath, trust?)`** builds the light client the verifying commands share:

```ts
async function lightClient(rpc: RpcClient, keystorePath: string, trust?: { height: bigint; hash: Uint8Array }): Promise<LightClient> {
  const file = join(dirname(keystorePath), 'light.json');
  const status = await rpc.status();
  let anchor = trust;
  if (!anchor && existsSync(file)) {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { height: string; hash: string };
    anchor = { height: BigInt(j.height), hash: fromHex(j.hash) };
  }
  if (!anchor) {
    // Trust on first use: the latest header, recorded so later runs verify from it.
    const h = BigInt(status.latestHeight);
    anchor = { height: h, hash: headerHash(headerFromJson(await rpc.header(h))) };
    console.log(`trusting height ${h} on first use`);
  }
  const client = await LightClient.trust({ chainId: status.chainId, provider: new RpcProvider(rpc), verifier: new InlineVerifier() }, anchor.height, anchor.hash);
  const save = () => writeFileSync(file, JSON.stringify({ height: client.trusted.header.height.toString(), hash: toHex(headerHash(client.trusted.header)) }));
  save();
  return Object.assign(client, { save });
}
```

The anchor is, in order: what the caller passed (`light trust`), what `light.json` holds, or the node's latest header (trust on first use, announced). The client uses the `InlineVerifier` (single-threaded, no worker to keep the process alive; review finding 34 is about the worker variant letting a process exit early). The returned object carries a `save` that callers invoke after verifying forward, so the next run starts from the newest verified header rather than the original anchor.

**`account(rpc, name, keystorePath)`** is the verified lookup:

```ts
  // Ask one height back so the header that commits to the answer already exists, and let the light client judge it.
  const status = await rpc.status();
  const height = BigInt(status.latestHeight) - 1n;
  const a = await rpc.call('account', { name, prove: true, height: height.toString() });
  const proof = keyProofFromBytes(fromHex(a.proof));
  const client = (await lightClient(rpc, keystorePath)) as LightClient & { save(): void };
  const header = headerFromJson(await rpc.header(height + 1n));
  const commit = commitFromJson(await rpc.commit(height + 1n));
  const verdict = await client.verifyKey({ proof, header, commit });
  client.save();
  const verified = 'value' in verdict ? verdict.value : undefined;
  const expected = a.account ? toHex(encode((w) => w.u64(idFromString(a.account.id)))) : null;
  // The proof must be about this name in the account name index at the height asked for, not merely a valid proof of something.
  const about = proof.type === AccountType.id && proof.indexPosition === 0 && proof.height === height && toHex(proof.key) === toHex(key((k) => k.str(name)));
  const ok = about && verified !== undefined && (verified === null ? expected === null : toHex(verified) === expected);
  if (!ok) process.exitCode = 1;
```

It asks for the proof at `latest - 1` because the header that commits to height N is N+1, which exists only once the chain has moved on. Whether the saved anchor is before or after that header does not matter: `verifyKey` moves trust forward to it or walks back to it (chapter 13). The name proof proves what the authenticated name index says: the 8-byte id for the name, or absence. `ok` requires two things. First, `about`: the proof must be about what was asked, a key in the account type's first authenticated index (`byName` is index position 0 of `AccountType`), at the height the CLI named, and for the key encoding of this very name. `verifyKey` can only say that the proof folds to the app hash of a header the client verified; a node could satisfy that with a genuine proof for a different name, for a different index (an asset symbol, say), or for a different height whose header it also serves, and the client would verify each of those honestly. Binding the proof to the name, the index and the height it asked for is what turns "the node proved something" into "the node proved this". Second, the proven value must match the id the node returned (or both must be absent), so a node that returns one account and a proof for another is caught. The printout says "name proof verified by the light client" or "proof NOT verified", and for a missing account "proven absent by the light client" or "absence NOT proven"; either NOT sets the exit code to 1. Balances are printed with each asset's own precision from the response (`b.precision`, falling back to the core asset's), and the operated validator and the history count come from the same response; none of those is covered by the proof, only the name-to-id mapping is.

**`verifyTx(rpc, keystorePath, hash)`** fetches `tx` with `prove: true`, decodes the proof, and first checks that the proof's transaction hashes to the hash that was asked about (finding 24), then hands the query to the light client's `verifyTx` and prints one of the three verdicts: "included ...; result not yet committed" for `null`, "verification failed: ..." for a failure (and the exit code is 1), or "verified: included at height H, succeeded" or "failed: <error>" for a result. The transaction may be older than the anchor in `light.json`: the client walks back from the anchor to the transaction's header and the one after it, so a transaction from last week verifies from an anchor saved yesterday, and nothing requires the user to have trusted a height before it. The height it prints is the proof's own, `q.txProof.height`, not the `height` field the node sent beside it: the proof's height is the one the light client verified the inclusion against, and the node's field is a claim that nothing checked.

**Commands.** `main` handles `init`, `start`, `keys` and `join` first (they take no RPC target), then resolves the target and dispatches the rest. Amounts are whole tokens; validators are named by their operator account.

| command | arguments | what it does | RPC calls |
|---|---|---|---|
| `init` | `<dir> [validators=4] [basePort=26656]` | writes `genesis.json`, `keystore.json` (faucet and `opN` keys, passphrase printed) and `nodeN/config.json` for each validator | none |
| `start` | `<nodeDir>` | runs the node over TCP with LMDB and its RPC on `rpcListen`; `LOG` sets the level | serves them |
| `keys list` | `[--keystore path]` | names and addresses in the keystore; fails if the file does not exist | none |
| `keys add` | `<name>` | generates a seed, seals it, prints the address | none |
| `keys import` | `<name> <seedHex>` | seals a given 32-byte seed | none |
| `keys export` | `<name>` | prints the seed in hex; fails if the file does not exist | none |
| `show` | `<target>` | height, peers, community pool, bonded, inflation; each active validator's operator, status, stake, self-bond and power; the first 50 accounts with balances | `status`, `object 4.0`, `object 2.0`, `validator` per active entry, `accounts` |
| `account` | `<target> <name>` | the account with balances, operated validator and history count, and a name proof checked by the light client | `status`, `object 4.0`, `account (prove, height)`, `header`, `commit`, plus the light client's `status`, `header`, `commit`, `validatorSet` |
| `history` | `<target> <account>` | the newest 50 history entries, decoded, hashes shortened | `accountHistory (limit 50, reverse)` |
| `tx` | `<target> <hash>` | height, index, result, and the decoded operations | `tx` |
| `verify-tx` | `<target> <hash>` | the same, verified by the light client: inclusion and, when committed, the result | `tx (prove)`, then the light client's calls |
| `create` | `<target> <name>` | the faucet registers a new account whose single key is taken from or added to the keystore | `status`, `object 4.0`, `account faucet`, `parameters`, `broadcastTx commit` |
| `transfer` | `<target> <from> <to> <amount>` | a core-asset transfer signed by `from` | `status`, `object 4.0`, `account` x2, `parameters`, `broadcastTx commit` |
| `create-validator` | `<nodeDir> <operator> <selfBond>` | registers the node's consensus key (from its `config.json`) as a validator operated by `operator`; needs a node directory | `status`, `object 4.0`, `account`, `parameters`, `broadcastTx commit` |
| `delegate` | `<target> <from> <operator> <amount>` | delegates `amount` to the operator's validator | `account`, `validator`, `parameters`, `broadcastTx commit`, plus `status` and `object 4.0` |
| `undelegate` | `<target> <from> <operator> <amount>` | converts the amount to shares at the delegation's current rate (all shares if the amount covers the whole delegation) and undelegates | `delegation`, `account`, `parameters`, `broadcastTx commit`, plus `status` and `object 4.0` |
| `unjail` | `<target> <operator>` | the operator asks for its jailed validator back | `account`, `validator`, `parameters`, `broadcastTx commit`, plus `status` and `object 4.0` |
| `parameters` | `<target>` | the fee schedule and staking parameters in force, one leaf per line | `parameters` |
| `proposals` | `<target>` | open proposals, each with its signals, expiry and the leaves it would change | `parameters`, `proposals` |
| `propose` | `<target> <operator> <path=value>...` | the operator's validator proposes the live parameters with the overrides applied (`FEES.md` section 4) | `parameters`, `account`, `validator`, `broadcastTx commit`, plus `status`, `object 4.0`, `parameters` |
| `signal` | `<target> <operator> <proposalId>` | the operator's validator signals support for a proposal | `account`, `validator`, `parameters`, `broadcastTx commit`, plus `status` and `object 4.0` |
| `light trust` | `<target> trust <height> <hash>` | sets the trust anchor and saves it in `light.json` | `status`, `header`, `commit`, `validatorSet` |
| `light verify` | `<target> verify [height]` | verifies forward to a height or to the latest, prints the height, hash, validator count and the number of steps, saves the anchor | `status`, then `header`, `commit`, `validatorSet` per step |
| `join` | `<dir> <nodeN> <seedAddr> <trustHeight> <trustHash> [basePort=26700]` | writes a full node's `config.json` with a state-sync anchor and `backfill: true`; start it with `start` | none |

A few of the commands are worth reading closely. `create` reuses an existing key of that name if the keystore has one, otherwise adds one, and the registrar and signer are both the faucet, so `create` works only where the keystore holds the faucet key. `undelegate` reads the delegation first because the operation takes shares, not tokens:

```ts
const d = await rpc.call('delegation', { delegator: from, validator: need(2, 'operator') });
if (!d.delegation) throw new Error(`${from} has no delegation to ${args[2]}`);
const tokens = toUnits(need(3, 'amount'), precision);
const shares = tokens >= BigInt(d.delegation.tokens) ? BigInt(d.delegation.shares) : (tokens * BigInt(d.delegation.shares)) / BigInt(d.delegation.tokens);
```

Chapter 11's staking rules keep delegations in shares whose value changes with rewards and slashes; the CLI converts at the rate the node reports, which can drift by a block between the read and the inclusion. `propose` takes overrides such as `fees.transfer.fee=250 staking.maxValidators=9`, which `FEES.md` section 4 explains: a proposal carries the complete parameters, so starting from the live ones means only the changes need naming. `join` writes a configuration only; `start` on it runs state sync from the anchor (chapter 7). It reads all five required arguments through `need` before it touches the file system, so a missing trust hash fails with "missing trust hash" and leaves no half-made directory behind, and it refuses to overwrite an existing `config.json`, both by checking first and by writing with the `wx` flag, which fails if the file appeared in between. A node directory's configuration is the node's identity, its node key seed and, for a validator, its validator seed; a `join` that replaced it would silently turn a validator into a full node with a new identity, and nothing would warn the operator until the validator was jailed for not signing.

**A transfer, end to end.** `node src/cli.ts transfer ./testnet/node2 faucet alice 12.5` with `CHAIN_PASSPHRASE` set, on a testnet made by `init` with the default base port:

1. `target('./testnet/node2')` reads `testnet/node2/config.json`; `rpcListen` is `127.0.0.1:26661` (p2p 26660 plus one), and the keystore is `testnet/keystore.json`.
2. `chainInfo`: `status` for the chain id, `object` for `4.0` for the precision (5 by default, so one token is 100,000 base units).
3. `accountId` twice: `account` for `faucet` gives `3.0`, for `alice` gives her id or throws "no account alice".
4. `toUnits('12.5', 5)` is `1250000n`.
5. `keyFor`: the passphrase from the environment, `Keystore.openOrCreate` (scrypt derivation, then `get` of the first key as the passphrase check), then `get('faucet')` (one AES-GCM decryption, one ML-DSA key generation from the seed).
6. `send`: `chainInfo` again, `parameters` for the schedule, `withFees` puts the `transfer.fee` from it on the operation, `signedTxBytes` encodes the body, signs it under the chain's transaction context with the faucet's secret key and appends the 2,420-byte signature; the whole transaction is about 2.5 KiB (`README.md`, "Performance").
7. `broadcastTx` in `commit` mode: the node's `checkTx` admits it, it is gossiped, proposed, committed, and the RPC answers with its height and result, within the 30-second default. The CLI prints `included at height 57 (tx 31d0…)`, or the application's error if it was included but failed.

Seven RPC calls before the broadcast (`status` and `object` twice each, `account` twice, `parameters` once), of which the two `object` and two `account` calls are costly: with the broadcast that is 28 tokens of the default burst of 100.

**Error handling.** `main` is wrapped once: any thrown error prints its message and exits with status 1. An unknown command prints the usage pointer and exits 1. Three commands also set `process.exitCode = 1` on an outcome they report rather than throw: `send` when the transaction was included but failed, `account` when the proof did not verify or was not about what was asked, and `verify-tx` when verification failed. The output is the same as before in those cases; the exit code is for scripts. There is no retry, no partial output on failure, and nothing is written to disk by a client command except `light.json`, the keystore and the lock file the keystore holds while it writes.

## How it is tested

`test/rpc.test.ts`, "seals seeds under a passphrase and refuses the wrong one", is the keystore test: `create` with a passphrase, `add` of a generated key and of a fixed seed, `list` in insertion order, a duplicate name refused with "already exists"; reopening with the right passphrase recovers the same address, the same seed through `seedOf`, and the same public key through `publicKeyOf`; opening with a wrong passphrase throws "wrong passphrase"; and the raw file does not contain the fixed seed's hex, which is the whole point of encrypting. `test/review2.test.ts`, "bounds the peer database and refuses an unnamed key", adds the two edges, on a fresh keystore `add('')` throws "a key needs a name", and once `alice` has been added, `open` with another passphrase throws "wrong passphrase", so a keystore with one key always checks; and then the two-writer case: two handles are opened over the same file, one adds `a` and the other `b`, a third `open` lists `a`, `alice` and `b`, so neither write overwrote the other's; the second handle's `add('a')` is refused with "already exists", since its own write re-read the file and brought `a` into its view; `remove('b')` through the first handle is gone on reopening; and no `.lock` file is left beside the keystore.

The CLI has no automated test. `RPC-SYNC-PROOFS.md` section 6 lists "every CLI command works through the RPC" among the stage-two tests, but `test/` does not exercise `src/cli.ts`; the commands have been run by hand against the TCP testnet `README.md` describes. The pieces the CLI is built from are tested elsewhere: the RPC methods it calls in `test/rpc.test.ts` (chapter 12), `signedTxBytes` and `withFees` throughout `test/chain.test.ts`, `test/fees.test.ts` and `test/rpc.test.ts`, and the light client in `test/light.test.ts` and `test/chain.test.ts` (chapter 13). The `json-rpc parameters` case in `test/rpc.test.ts` is the one closest to the wallet's logic: a transaction priced from the served schedule is included, one priced from the defaults is refused with the schedule's reason, which is exactly what `send` relies on.

## Limitations and ideas

- No CLI test. A test that spawns `node src/cli.ts` against an in-process RPC server, or that refactors `main` into callable functions, would close the gap the spec left.
- `keys add` and `keys import` create the keystore when the path does not exist (`openOrCreate`), and an empty keystore cannot detect a wrong passphrase, so the first `add` after a mistyped passphrase seals its seed under the mistyped passphrase: the seed can be recovered with that passphrase and not with the intended one, and every later `open` with the intended one reports "wrong passphrase".
- `keys export` prints the seed in the clear to stdout; there is no `keys remove` even though `Keystore.remove` exists.
- The core asset (`4.0`) and the dynamic properties (`2.0`) are hard-coded ids in `chainInfo` and `show`; `parameters` already reports the core asset id.
- `account` verifies the name mapping only; balances and the rest are printed unverified. Verifying a balance would need an object proof for the balance object plus the name proof.
- One signer per transaction and only the operations the commands expose: no `accountUpdate`, `assetCreate`, `assetIssue`, `validatorUpdate` or `redelegate`, and no non-core-asset transfers, though the application supports them all.
- The passphrase prompt hides echo by patching `stdout.write`, which works for a plain terminal and not necessarily elsewhere.
- `light.json` is per keystore directory, not per chain: pointing the same keystore at a different chain would fail at `LightClient.trust` with a chain id error, which is the right outcome but an unhelpful message.
- The keystore lock waits five seconds and treats a lock older than thirty as abandoned. Those are generous for a write that takes milliseconds, but a machine suspended with the lock held could have it removed from under it; the atomic write still leaves a whole file either way.

Exercises:

1. Add `keys remove <name>` (the keystore already has `remove`, and it takes the lock like every other write) and `keys show <name>`, which prints a public key through `publicKeyOf` without asking for the passphrase.
2. Add a `redelegate` command: read the delegation, convert tokens to shares as `undelegate` does, and build the `redelegate` operation with `source` and `destination` validators resolved from operator names.
3. Add asset commands: `asset-create <issuer> <symbol> <precision> <maxSupply>` and `issue <issuer> <asset> <to> <amount>`, and extend `transfer` with an optional asset symbol resolved through the `key` method on the asset symbol index.
4. Make `account` verify a balance: fetch `object` with `prove: true` for the balance object found through the account's `balances`, and check it with `client.verifyState`.
5. Add a `watch <target>` command that opens `/events?types=block,tx` and prints each record, reconnecting with `Last-Event-ID` on disconnect.
6. Write the missing CLI test: start an `RpcServer` in the test, run `init` into a temporary directory, and drive `create`, `transfer`, `account` and `verify-tx` through `main` with `process.argv` set, asserting on what they print.

## Where to next

The [tests](15-tests.md) chapter walks through the suite that holds all of this together.
