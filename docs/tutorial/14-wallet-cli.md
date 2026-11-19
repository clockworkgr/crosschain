# 14. Wallet and CLI

This chapter is where a person meets the chain. `src/wallet/keystore.ts` keeps signing keys encrypted on disk, and `src/cli.ts` is the command line that creates a testnet, runs a node, and otherwise acts as a wallet and query tool over the [RPC](12-rpc.md). The CLI builds transactions with the signing client from the [application](11-application.md) chapter (`src/app/core/client.ts`), prices them from the fee schedule the node reports, signs them with keys from the keystore, and verifies what the node tells it with the [light client](13-light-client.md). Its `start` command is also the only place in the repository that assembles a complete [node](08-node.md) over TCP with LMDB storage and an RPC server, under a heap limit it sets itself. Nothing in the chain depends on these two files; everything a user does goes through them.

## Concepts

**Seeds and deterministic keys.** Key generation is deterministic from a 32-byte seed under both of the chain's signature schemes (`keyPairFromSeed(seed, scheme)` in `src/crypto/keys.ts`, chapter 2): the same seed and scheme always yield the same public key (1,313 bytes with ML-DSA-44, 34 with secp256k1, the scheme tag included) and secret key (2,561 or 33 bytes; for secp256k1 the seed is the secret key itself), and the address is `sha256(publicKey)`, so one seed has a different address under each scheme. So a wallet only ever has to store seeds, and which scheme each was made for. That is what makes a keystore small and makes "export" a 64-character hex string.

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

**Verifying what the node says.** A wallet that trusts its node completely is a thin client, not a light client. Two CLI commands go further: `account` asks for a name proof and checks it with the light client against a header it verified itself, and `verify-tx` does the same for a transaction's inclusion and result. The anchor is kept in `light.json` next to the keystore, with the id of the chain it belongs to, and is trust-on-first-use unless the user ran `light trust <height> <hash>` with a hash obtained elsewhere. The anchor need not predate what is being verified: for a height after it the client moves trust forward, and for one before it the client walks the hash chain back from the anchor (chapter 13), so an old transaction verifies from a recent anchor. Review findings 23 and 24 are the two mistakes this guards against: verifying against a header supplied by the same server, and verifying a proof without checking it is for the transaction that was asked about.

**Targets.** Every client command takes a *target*: either a node directory, from which the RPC address (`config.json`'s `rpcListen`, or the p2p port plus one) and the testnet's shared `keystore.json` are found, or an `http://` URL, in which case `--keystore` names the keystore (default `./keystore.json`). `--rpc` replaces the URL and nothing else: a node directory target keeps its keystore and stays a node directory for the commands that need one. The passphrase comes from `--passphrase-file`, the `CHAIN_PASSPHRASE` variable, or a hidden prompt, in that order of preference.

## The code, file by file

### src/wallet/keystore.ts

Purpose: named seeds sealed under one passphrase, in a JSON file a person can inspect.

Two private shapes describe the file. `SealedKey` is `{ address, publicKey, scheme?, iv, ciphertext, tag }`, all hex but the scheme, which is the name of the scheme the seed was made for; `KeystoreFile` is `{ version: 1 | 2, kdf: { name: 'scrypt', N, r, p, salt }, keys: Record<name, SealedKey> }`. The file has a version. Version 1 came first, with one scheme and no `scheme` field; the second scheme added the field without changing the number, so in a version 1 file a key without one is ML-DSA-44. Version 2, which is what is written now (`KEYSTORE_VERSION = 2`), names the scheme of every key, and a key without one is damaged, not assumed. A version 1 file is read as it is and written as version 2 the next time it is changed; reading never writes. In memory `keys` is an object without a prototype, and names are looked up in it with `Object.hasOwn`:

```ts
/** The keys of a file as read, moved into an object that has only them: no name finds what every object inherits. */
function ownKeys(keys: Record<string, SealedKey> | undefined): Record<string, SealedKey> {
  return Object.assign(Object.create(null), keys);
}
```

`create` starts from `ownKeys(undefined)` and `checkFile`, through which every file read passes, replaces the parsed `keys` with `ownKeys` of it. A key may therefore be called `constructor`, `toString` or `__proto__` like any other: an empty keystore has no key by such a name, `add` stores one under it, and `get`, `publicKeyOf` and `remove` find exactly what was added. The file is the same JSON either way. Public keys and addresses are stored in the clear on purpose: `publicKeyOf` can read them without the passphrase, which is what `init` would need to write a genesis from a locked keystore. On disk, with the hex shortened, a keystore holding one key looks like this:

```json
{
  "version": 2,
  "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "…" },
  "keys": {
    "faucet": { "address": "…", "publicKey": "…", "scheme": "ml-dsa-44", "iv": "…", "ciphertext": "…", "tag": "…" }
  }
}
```

The sizes follow from the primitives: the salt is 16 random bytes (32 hex digits), the address is a sha256 (64), the public key is the tagged key, 1,313 bytes for ML-DSA-44 (2,626) or 34 for secp256k1 (68), the IV is 12 bytes (24), the ciphertext is the 32-byte seed with no padding since GCM is a stream mode (64), and the tag is 16 bytes (32).

**`SCRYPT`** is the exported parameter set `{ N: 32768, r: 8, p: 1 }`. The derivation:

```ts
  private static derive(passphrase: string, kdf: KeystoreFile['kdf']): Buffer {
    return scryptSync(passphrase, Buffer.from(kdf.salt, 'hex'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r });
  }
```

`maxmem` is Node's guard against scrypt allocating more than expected; `128 * N * r` bytes is scrypt's requirement and twice that is allowed. The parameters are read from the file, not from the constant, so a keystore written with other costs still opens.

**`Keystore`** has a private constructor holding the `path`, the parsed `file` and the derived `key`. Three ways to get one:

- **`create(path, passphrase)`** refuses an existing path, writes a fresh file with a random 16-byte salt and no keys through `mutate` with `fresh` set, which refuses the path again under the lock in case the file appeared in between, and returns the keystore.
- **`open(path, passphrase)`** parses the file, refuses any version but 1 or 2 or any KDF but scrypt (`checkFile`, which throws `unsupported keystore`), derives the key, and then "checks the passphrase against the first key, if any" by decrypting it. The test is `first !== undefined`, not a truthiness test: whenever a key exists, whatever its name, the check runs. An empty keystore cannot detect a wrong passphrase, which is a consequence of there being no separate passphrase check value in the file. What happens then is worth stating exactly, because it is easy to overstate: the first `add` seals its seed under the key scrypt derives from whatever passphrase was typed. That derivation is deterministic, so the seed is not lost; it opens with the mistyped passphrase and refuses the intended one, and the next `open` with the intended passphrase fails the check against that first key and says "wrong passphrase". (The check happens at `open`; the CLI's `keys` command on an empty keystore relies on the user typing the passphrase correctly.)
- **`openOrCreate(path, passphrase)`** is what the CLI calls: open if the file exists, else create.

**`version`** is the version of the file as this handle last read or wrote it: 1 for a version 1 file that has only been read, 2 after any write. **`list()`** returns `{ name, address, publicKey, scheme }` for every key, without unlocking anything (the scheme through `schemeOf`, below: `'ml-dsa-44'` for a record of a version 1 file that names no scheme, and a throw for such a record in a version 2 file), and **`has(name)`** checks the name with `Object.hasOwn`, so only a key that was added counts; both reflect the file as this handle last read or wrote it, so a key another handle added since is seen after this handle's next write, or by opening the file again. **`add(name, seed?, scheme = DEFAULT_SCHEME)`**:

```ts
  add(name: string, seed?: Uint8Array, scheme: SchemeTag = DEFAULT_SCHEME): KeyPair {
    if (name === '') throw new Error('a key needs a name');
    if (this.has(name)) throw new Error(`key ${name} already exists`);
    seed ??= generateSeed(scheme);
    if (seed.length !== SEED_SIZE) throw new Error(`seed must be ${SEED_SIZE} bytes`);
    const pair = keyPairFromSeed(seed, scheme);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
    const sealed: SealedKey = { address: toHex(pair.address), publicKey: toHex(pair.publicKey), scheme: schemeName(scheme), iv: iv.toString('hex'), ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
    this.mutate((keys) => {
      if (Object.hasOwn(keys, name)) throw new Error(`key ${name} already exists`); // another handle got there first
      keys[name] = sealed;
    });
    return pair;
  }
```

A name that is not empty and not taken, a seed of the right size (generated for the scheme when none is given: `generateSeed(scheme)` skips the few 32-byte values that are not secp256k1 keys), the key pair derived in that scheme, a fresh IV per seed; the seed is sealed before the lock is taken, so the key generation and the encryption are not done while other writers wait, and the insertion happens under the lock against the keys on disk at that moment. The second `already exists` check is the one that matters between handles: this handle's `has` saw the file as it last read it, and a name another handle added since is only visible under the lock. The empty name is refused for two reasons: a key under it would list as a blank and could be named only by another empty argument, and the empty string is the one name that a truthiness test in `open` would have skipped, leaving a keystore whose only key never checked the passphrase. The command line never gets this far with one, since `need` refuses an empty argument as missing (below), so the check here is for the callers that are not the command line. `add` is both "generate" and "import": the CLI's `keys import` passes a seed, `keys add` lets the default generate one, and both pass the scheme `--scheme` names. The record keeps that scheme's name beside the public key, so `get` can derive the same key again. `DEFAULT_SCHEME` is ML-DSA-44 unless an entry point set another, as the tests do from `CHAIN_SCHEME` ([chapter 2](02-crypto.md)); the CLI never relies on the default and always passes a scheme.

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
    // The cipher vouches for the seed but not for the scheme beside it: a record whose scheme was changed or lost
    // would derive another key under the same name, while list() and publicKeyOf() still give the recorded one.
    const pair = keyPairFromSeed(new Uint8Array(seed), schemeTag(this.schemeOf(name, k)));
    if (toHex(pair.publicKey) !== k.publicKey.toLowerCase() || toHex(pair.address) !== k.address.toLowerCase()) {
      throw new Error(`key ${name} does not derive the public key and address recorded for it; the keystore entry is damaged`);
    }
    return pair;
  }
```

`decipher.final()` is where GCM verifies the tag; any failure is reported as a wrong passphrase, which is also what a corrupted ciphertext looks like. The returned `KeyPair` holds the seed, both keys and the address, regenerated from the seed each time in the scheme the record names, and checked against the public key and address the record holds: the cipher vouches for the seed but not for the scheme written beside it, so a record whose scheme was changed would otherwise give another key under the same name, and `get` refuses it as damaged instead. Which scheme a record is of is `schemeOf`'s to say:

```ts
  /** The scheme a key was made for: the one it names, or in a version 1 file that names none, ML-DSA-44. */
  private schemeOf(name: string, k: SealedKey): SchemeName {
    if (k.scheme !== undefined) return k.scheme;
    if (this.file.version === 1) return 'ml-dsa-44';
    throw new Error(`key ${name} names no scheme; the keystore entry is damaged`);
  }
```

A record without a scheme in a version 1 file is from a keystore written when there was one scheme, and is read as ML-DSA-44, so an old file keeps every key it had. In a version 2 file every record was written with its scheme, so one without it has lost it, and `get` and `list` throw `key <name> names no scheme; the keystore entry is damaged` where they used to assume ML-DSA-44. `test/schemes.test.ts` deletes the field from a record of each version and checks both.

**`seedOf(name)`** returns the raw seed for export. **`remove(name)`** deletes the name under the lock and throws `no key named <name>` when there is none by that name; the seed goes with the entry, so the caller has exported it if it is wanted again. `keys remove` is its command. **`publicKeyOf(name)`** reads the stored public key without decrypting.

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
        const disk = checkFile(JSON.parse(readFileSync(this.path, 'utf8')) as KeystoreFile);
        // Keys sealed under another salt would not open with this handle's key; the file is not the one it read.
        if (disk.kdf.salt !== this.file.kdf.salt) throw new Error(`${this.path} was recreated with another passphrase; open it again`);
        keys = disk.keys;
        // A version 1 file is written as version 2: what it left unsaid about a key's scheme is said.
        if (disk.version === 1) for (const k of Object.values(keys)) k.scheme ??= 'ml-dsa-44';
      } else if (this.file.version === 1) {
        // The file is gone and this handle's keys are all there is: they were read as version 1, and are written as 2.
        for (const k of Object.values(keys)) k.scheme ??= 'ml-dsa-44';
      }
      op(keys);
      this.file.keys = keys;
      this.file.version = KEYSTORE_VERSION;
      writeAtomic(this.path, new TextEncoder().encode(JSON.stringify(this.file, null, 2)));
    } finally {
      unlinkSync(lock);
    }
  }
```

Two halves. The first takes the lock: `openSync(lock, 'wx')` creates `<path>.lock` and fails with `EEXIST` if it is already there, in which case the method checks the lock's age, removes it if it is older than `LOCK_STALE_MS` (30 s, "left by a process that died holding it; no write takes nearly as long"), and otherwise sleeps `LOCK_RETRY_MS` (20 ms) and tries again until `LOCK_WAIT_MS` (5 s) has passed, when it gives up with "is locked by another process". The sleep is synchronous (`Atomics.wait` on a throwaway shared buffer), because the keystore's interface is synchronous like the store's, and a wallet command has nothing else to do meanwhile. The second half, under the lock, starts from the keys on disk, not from memory: it re-reads the file, checks it is still a keystore this handle can use (the salt must be the one it derived its key from, or the keys on disk were sealed under another passphrase and merging would produce a file that opens with neither), applies `op` to those keys, adopts them as its own, and writes atomically. The re-read goes through `checkFile` as `open` does, so a file of a version other than 1 or 2 is refused here too. If the file on disk is version 1, every key in it that names no scheme is given `ml-dsa-44` before `op` runs, and the file is written with `version` set to `KEYSTORE_VERSION`: the first `add` or `remove` on a version 1 keystore writes it as version 2, and nothing short of a write does. If the file has gone since the handle read it, the handle's own keys are all there is to write; a handle that read a version 1 file fills in `ml-dsa-44` for each of its keys that names no scheme in the same way, so the version 2 file it writes names the scheme of every key. With `fresh`, which only `create` passes, an existing file is refused instead of read. The `finally` removes the lock on every exit, including a throw out of `op`, which is how `add`'s second "already exists" leaves no lock behind. Two handles over one file, or two processes, therefore keep each other's keys: each write merges into what is there rather than overwriting it.

The invariants: nothing in the file reveals a seed without the passphrase; the same passphrase and salt always derive the same key; each seed has its own IV; the file on disk is always either the old version or the new one; and a change made through one handle is never undone by another.

### src/cli.ts

Purpose: one file, one process, one command per run. The header comment is the usage text, and `main` is a `switch`. It uses Node's `process.argv` directly and no argument library.

**`NodeFiles`** is the shape of a node directory's `config.json`: `name`, `listenAddr` (p2p), `rpcListen`, `seeds` (the other nodes), `nodeKeySeed`, `validatorSeed` (null for a full node), and the optional `stateSync { trustHeight, trustHash, backfill }`, `retain { blocks, versions, snapshots, memoryVersions }`, `indexTrees` and `snapshotInterval` that chapter 7 and chapter 10 describe (`memoryVersions`, how many of the provable versions stay in memory, and `indexTrees`, `'store'` (the default) or `'memory'`, whether the application's secondary indices are read from LMDB or kept as trees in the heap, are in [chapter 8](08-node.md)). **`UNBONDING_MS`** is seven days, used both for the genesis staking parameters and for the consensus `maxEvidenceAgeMs`.

**Argument handling.** Everything after the script name is split into `flags` (`--name value` pairs) and `positional` words; `cmd` is the first positional and `args` the rest. **`need(i, what)`** returns `args[i]` or throws `` `missing ${what}` ``, for an argument that is absent and for one that is the empty string alike, so `keys add ''` is `missing name` and no command is handed an empty name, amount or address. **`target(arg)`** turns the first argument into an `RpcClient`, a keystore path and maybe a node directory:

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

A node directory's keystore is the one `init` wrote one level up, shared by the whole testnet. `--rpc` overrides the URL and only the URL: a node directory target keeps the testnet's keystore and its `nodeDir`, so `create-validator ./testnet/node2 --rpc http://other:26657` still reads node 2's consensus key from its `config.json` and signs with the testnet's operator key while talking to another node. The positional target is still required by `need(0, 'target')`. With a URL target the flag replaces that URL as well, so the positional URL then only stands for "no node directory", with the keystore in the working directory.

**`passphrase()`** reads `--passphrase-file`, then `CHAIN_PASSPHRASE`, then prompts. The prompt hides the echo by replacing `stdout.write` after the prompt text has been written and swallowing everything until the answer arrives; it is a trick, not a terminal mode change, and it is restored in the callback. Everything, not only single-character writes: readline echoes a typed character one at a time, but on an edit (a backspace, a cursor movement) it redraws the whole line, prompt and typed text together, and a filter that let longer writes through would print the passphrase typed so far the first time the user corrected a mistake. **`openKeystore(path)`** is `Keystore.openOrCreate(path, await passphrase())`. The `keys` command guards it: `list`, `export` and `remove` throw `` `no keystore at ${path}` `` when the file does not exist, so a mistyped `--keystore` cannot quietly create an empty keystore, while `add` and `import` create one on purpose.

**`init(dir, count, basePort, scheme, maxBlockBytes)`** writes a testnet:

```ts
  const pass = process.env.CHAIN_PASSPHRASE ?? 'testnet';
  const ks = Keystore.create(join(dir, 'keystore.json'), pass);
  const faucet = ks.add('faucet', undefined, scheme);
  const seeds = Array.from({ length: count }, () => ({ node: generateSeed(scheme), val: generateSeed(scheme) }));
  const operators = seeds.map((_, i) => ks.add(`op${i}`, undefined, scheme));
  const account = (name: string, publicKey: Uint8Array, balance: string) => ({ name, owner: authorityJson([publicKey]), active: authorityJson([publicKey]), balance });
  const genesis: Genesis = {
    chainId: `chain-${toHex(generateSeed()).slice(0, 8)}`,
    signatureScheme: schemeName(scheme),
    genesisTime: BigInt(Date.now()),
    consensus: { maxEvidenceAgeMs: BigInt(UNBONDING_MS), version: PROTOCOL_VERSION, ...(maxBlockBytes !== null ? { maxBlockBytes } : {}) },
    appState: appGenesisBytes({
      accounts: [account('faucet', faucet.publicKey, '1000000000000'), ...operators.map((k, i) => account(`op${i}`, k.publicKey, '5000000000'))],
      staking: { unbondingPeriodMs: UNBONDING_MS },
      communityPool: 100_000,
      validators: seeds.map((s, i) => ({ operator: `op${i}`, consensusKey: toHex(keyPairFromSeed(s.val, scheme).publicKey), selfBond: 20_000 })),
    }),
  };
```

The genesis names the protocol version outright, `PROTOCOL_VERSION` ([chapter 3](03-types.md)), so the file says which protocol its chain runs even to later code with another default. `scheme` is what `--scheme ml-dsa-44|secp256k1` named on the command line, ML-DSA-44 when absent (`main` turns the name into a tag with `schemeTag`, which refuses a name it does not know). It is written into the genesis as `signatureScheme` and every key the testnet starts with is made for it: the faucet and operator keys in the keystore, each node's p2p key seed and consensus key seed. The keystore gets a `faucet` key and one operator key `op0..opN-1`; each node gets a p2p key seed and a consensus key seed, which go into its `config.json` in the clear (node keys are not wallet keys; the validator's consensus seed has to be readable by the node process). The node derives both keys from those seeds with the genesis scheme when it starts (chapter 8), which is why the seeds alone are enough. The genesis funds the faucet with 10^12 base units, each operator with 5x10^9, and registers each node's consensus key as a validator operated by `opN` with a self-bond of 20,000 whole tokens; the application-owned validator set is chapter 11's territory. Ports: p2p at `basePort + 2i`, RPC at `basePort + 2i + 1`, and each node's `seeds` are all the others. The passphrase is `CHAIN_PASSPHRASE` or the word `testnet`, and the command prints it, as the spec requires.

`maxBlockBytes` is what `--max-block-bytes <n>` gave, or null without the flag. A number becomes `consensus.maxBlockBytes` of the genesis, the chain's limit on the transactions and evidence of a block ([chapter 3](03-types.md)); with null the spread adds nothing, the genesis has no such field and every node uses the default, 4,194,304. `main` passes the flag's value through `checkMaxBlockBytes` in the arguments of the call, so the check runs before `init` does: "The limit is checked before anything is written: a genesis the nodes would refuse is not made." A value that is not a whole number from 65,536 to 16,777,216 throws `genesis: consensus.maxBlockBytes must be a whole number from 65536 to 16777216`, the message a node gives for such a genesis, and the command exits 1 having made no directory. The flag is the way to set the block size of a testnet; before it the field had to be written into `genesis.json` by hand after `init`.

**`startUnderHeapLimit()`** runs first. The state lives in the V8 heap, whose default limit is a few gigabytes whatever the machine has, and a state that outgrows it aborts the process; the node's memory guard ([chapter 8](08-node.md)) can only act below the limit, and can only schedule collections when `--expose-gc` is on. So `start` runs itself again as a child process with the flags it needs:

```ts
function startUnderHeapLimit(): boolean {
  // A limit the operator set, on the command line or in NODE_OPTIONS and in any spelling V8 takes, is left alone: the
  // child's own flag would override it.
  if (heapLimitFlag() !== null || process.env.CROSSCHAIN_CHILD) return false;
  const heapMb = flags.has('heap') ? Number(flags.get('heap')) : Math.floor((totalmem() / 2 ** 20) * 0.75);
  if (!Number.isInteger(heapMb) || heapMb < 256) throw new Error('--heap takes a size in MiB, at least 256');
  console.log(`start: running the node under a ${heapMb} MiB heap limit (--heap <MiB> changes it), collections scheduled after commits`);
  // The limit goes after the arguments this process was started with: the last such flag wins, and one of 0 (no limit) among them must not undo it.
  const args = [...process.execArgv, `--max-old-space-size=${heapMb}`, '--max-semi-space-size=64', '--expose-gc', process.argv[1]!, ...process.argv.slice(2)];
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, CROSSCHAIN_CHILD: '1' } });
  // A signal addressed to this process is passed on; a terminal's interrupt reaches the child by itself as well,
  // and the child's shutdown runs once however many it gets.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return true;
}
```

The heap limit is three quarters of physical memory (`os.totalmem`) unless `--heap <MiB>` names another, and a figure that is not a whole number of at least 256 is refused before anything starts. The child gets whatever flags the parent itself ran with, then `--max-old-space-size` for the limit (after them, because V8 takes the last such flag and a `--max-old-space-size=0` among the parent's, which `heapLimitFlag` reads as no flag, would otherwise undo it), `--max-semi-space-size=64` for a larger young generation (fewer minor collections, each of which pauses the thread), `--expose-gc` so the scheduler can ask for collections after commits, then the script and its arguments, with `CROSSCHAIN_CHILD` in its environment so that it does not wrap itself again. The other escape is a `--max-old-space-size` already in `node`'s own arguments or in `NODE_OPTIONS`, found by `heapLimitFlag` from `src/node/memory.ts` ([chapter 8](08-node.md)), the same function the memory guard reads its limit with, so the flag is recognised with dashes or underscores as V8 takes it: the operator chose a limit, and the wrapper steps aside (then `--expose-gc` is the operator's to add; without it the scheduler logs once that collections run when V8 decides). The parent's only jobs afterwards are to pass `SIGINT` and `SIGTERM` to the child (a terminal's interrupt reaches both processes anyway, and the child's `shutdown` runs once however many signals it gets) and to exit with the child's code, or 1 when a signal killed it. The printed line is all an operator sees of this.

**`start(nodeDir)`** first reads its other flag:

```ts
  const arenaMb = flags.has('arena') ? Number(flags.get('arena')) : null;
  if (arenaMb !== null && !(Number.isInteger(arenaMb) && arenaMb >= 16)) throw new Error('--arena takes a size in MiB, at least 16');
```

`--arena <MiB>` bounds the object database's arena, the slabs of encoded objects ([chapter 9](09-database.md)). It is a flag and not something the memory guard decides because the slabs are `ArrayBuffer`s outside the V8 heap, which is all the guard measures: `--heap` bounds the heap, `--arena` the largest thing beside it. Sixteen MiB is the least because the slab being filled, 16 MiB at most, is never released. The check comes before the wrapper, so a bad figure is refused in the parent, and the flag reaches the child with the rest of the arguments. Without it the arena holds every object, as before.

`start` then returns at once in the parent (`if (startUnderHeapLimit()) return`) and otherwise assembles a node: the config and the genesis one directory up, a `WorkerVerifier` (chapter 2's thread pool), a logger at `LOG` level, then `Node.create` with the data directory (the node claims it and then opens its `LmdbEnv` under `data/lmdb`, so a second `start` on a directory in use is refused before it has opened anything there; [chapter 8](08-node.md)), the TCP transport, seeds, state-sync anchor, retention and `indexTrees` from the config, and `arenaBytes` (the flag times 2^20, or undefined). The signal handlers and the shutdown function (below) are set up before `Node.create`, so a signal that comes while the node is being made is acted on once it is made, and the memory listener is registered before the node is started, so a heap already critical at the guard's first sample is acted on too. Because the child always runs under `--max-old-space-size`, the node also tells the application how much heap there is to open the stored state into, and a state whose trees do not fit is opened paged ([chapter 8](08-node.md), [chapter 11](11-application.md)); the line `loaded application state` then ends with `paged=` and what was left in the store. After the node's `start()`, unless the node is already stopping, it opens an `RpcServer` on `rpcListen` and logs a status line every five seconds (`made` is the node `Node.create` returned):

```ts
  status = setInterval(() => {
    const m = made.memoryGuard.stats;
    const gc = made.gcScheduler.stats();
    log('info', 'status', {
      height: made.height,
      peers: made.network.peers.size,
      mempool: made.mempool.size,
      round: made.consensus.round,
      validators: app.dynamic().active.length,
      pool: app.dynamic().communityPool,
      heap: `${Math.round(heapInUse(m) / 2 ** 20)}/${Math.round(m.heapLimit / 2 ** 20)} MiB`,
      memory: made.memoryLevel,
      gc: `${gc.collections} pauses, ${gc.totalMs.toFixed(0)} ms, longest ${gc.maxMs.toFixed(1)} ms`,
    });
  }, 5000);
  status.unref();
```

Height, peers, mempool size, round, active validators and the community pool as before, then the guard's last sample as `heap=<used>/<limit> MiB`, the guard's level as `memory=`, and the collections V8 has run since start with their total and longest pause as `gc=`. Both heap figures are the old generation's, the ones the guard takes its levels from ([chapter 8](08-node.md)): the limit is the `--max-old-space-size` the child runs under, so `--heap 512` shows as 512 and not as the 704 V8's own `heap_size_limit` would say with the young generation's reserve added, and the use is `heapInUse(m)`, the sample's `heapOld`, which leaves out the garbage the young generation holds between two minor collections. On a one-node testnet under `--heap 512` the line read `heap=17/512 MiB memory=ok gc=5 pauses, 1 ms, longest 0.2 ms` after five blocks: one scheduled minor collection per commit. The interval is kept in `status`, a variable declared beside the shutdown function's other state, and is unreferenced, so it does not keep the process alive. Shutdown is one function with an exit code:

```ts
  // A signal that comes while the node is being made (a large genesis read, a state-sync join) is acted on once
  // it is made, so the store is closed and the claim released as on any stop. If making it takes more than five
  // seconds longer the process ends as it is: the store is safe against that, and the claim it leaves is one of
  // a process that is gone, which the next start takes over.
  let node: Node | null = null;
  let rpc: RpcServer | null = null;
  let stopping = false;
  let giveUp: NodeJS.Timeout | undefined;
  let status: NodeJS.Timeout | undefined;
  // Consensus and block sync stop at once, and the block being applied finishes its writes, while the RPC server
  // stops beside them; a request still running then has a second (none at `critical`) before its connection is cut,
  // so no client can keep a node that must stop running.
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    clearInterval(status); // it reads the application, whose store is about to close
    if (!node) {
      giveUp = setTimeout(() => process.exit(code), 5000).unref();
      return; // start() goes on to stop the node when it has one
    }
    try {
      // The store is closed by the node, once the RPC server has let go of it, and the claim released after.
      const rpcStopped = rpc?.stop(code === 3 ? 0 : 1000);
      await node.stop(async () => void (await rpcStopped));
      await verifier.close();
    } catch (e) {
      log('error', 'stopping failed', { err: e instanceof Error ? e.message : String(e) });
      code ||= 1;
    }
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
```

`shutdown` first clears the status interval, if it has been set: the line reads the application (`app.dynamic()`), "whose store is about to close", and a tick that came after the close would be answered with `StoreClosedError` inside a timer, where nothing catches it, and end the process with that error in place of the exit code the shutdown was given. A shutdown that begins before the interval is set has nothing to clear, and `start` returns without setting it when it sees `stopping` after the node's `start()` or after the RPC server's. One test runs this path: `test/review5-rpc.test.ts`, "writes the block size it was given into the genesis, and runs a node that stops on a signal with its directory released", starts a node with `start` in a child process, waits for a status line, sends `SIGINT` and expects exit code 0 with no `the store is closed` in the output ("How it is tested", below). It shows that a node that has run past a status tick stops by signal with the code the shutdown gave it; it does not make a tick fall during the shutdown, so it would not by itself fail if the interval were left running, and no test forces that. `SIGINT` and `SIGTERM` then start the RPC server's stop at once (the server gives a request still running one second before it cuts the connection, and none at `critical`, so a slow client cannot keep a node that must stop running; `rpc` is null until the server exists, and `rpcStopped` is then undefined) and pass its promise to `node.stop` as `beforeClose`. The node stops consensus, block sync and the network and lets the block being applied finish its writes while the server stops beside it (work of consensus or block sync that is waiting on a verification or on a peer at that moment is not waited for; it ends when it resumes, [chapter 8](08-node.md)); it then waits for the server, and only after that closes LMDB and gives up its claim on the data directory ([chapter 8](08-node.md)). The server's stop waits, one second at most, for the methods it was running to return ([chapter 12](12-rpc.md)), so a request still being served reads a store that is still open, and one whose connection was cut and that ends within the second is not left running over a store that is being closed. A method that takes longer is not cancelled: the server's stop returns without it and the node closes the store. When the method resumes and touches the store it is answered with `StoreClosedError`, `the store is closed` ([chapter 10](10-store.md)), which its handler turns into an error answer on a connection already cut, and the process exits as soon as the verifier is closed whether or not the method has got that far. The node's stop likewise first waits for a `start()` still on its way, so a signal that comes while `made.start()` is being awaited below stops a node that goes no further in starting ([chapter 8](08-node.md)). The environment is the node's own, so nothing here closes it. Then the verifier is closed and the process exits 0; the `stopping` flag makes a second signal harmless, and two do arrive under the wrapper, the terminal's and the one the parent passes on. If the node's stop or the verifier's close fails, the error is logged as `stopping failed` and the exit status is 1, unless it was already another: a node stopped at `critical` whose stop fails still exits 3. The node tries every step of its shutdown whatever the earlier ones did and releases the claim last, so a failure reported here has not left the store open where it could be closed, nor the directory claimed ([chapter 8](08-node.md)).

The handlers and `shutdown` are set up before `Node.create`, because making a node can take a while (a large genesis to read, a state-sync join) and a signal may come meanwhile. `node` is still null then, and `shutdown` does not stop anything: it sets `stopping`, arms an unreferenced timer of five seconds and returns. What follows `Node.create` does the rest:

```ts
  node = made;
  const app = made.app as CoreApp;
  if (stopping) {
    // Asked to stop while the node was being made: it is made now, and is stopped in its own time.
    clearTimeout(giveUp);
    stopping = false;
    return shutdown();
  }
  // Past the critical level the next step is V8 aborting the process; stopping cleanly first keeps the stores
  // consistent and tells the supervisor, through the exit code, that the node needs a larger heap. Registered before
  // the node starts, so a heap already critical at the first sample is acted on too.
  made.onMemory((level) => {
    if (level === 'critical') void shutdown(3);
  });
  try {
    await made.start();
    if (stopping) return;
    const [host, port] = (cfg.rpcListen ?? `127.0.0.1:${Number(cfg.listenAddr.split(':')[1]) + 1}`).split(':');
    rpc = new RpcServer(made, { host, port: Number(port), log });
    await rpc.start();
    if (stopping) return; // the shutdown that began meanwhile has the server to stop, and no status line follows it
  } catch (e) {
    // A node that is up and cannot go on (its RPC address is taken, for one) is stopped like any other, so the
    // store is closed and the claim released before the error ends the process.
    log('error', 'start failed', { err: e instanceof Error ? e.message : String(e) });
    rpc = null;
    return shutdown(1);
  }
```

When `Node.create` returns and `stopping` is set, the timer is cancelled, the flag is cleared and `shutdown()` is called again, this time with a node to stop: the node, which was never started, closes its store and releases the claim as on any stop, in its own time, and the process exits 0. The timer bounds only the making: if the node has not been made five seconds after the signal, the process exits as it is. The store is safe against a process that ends in the middle of its work, and the `LOCK` such an exit leaves names a process that is gone, which the next start takes over ([chapter 8](08-node.md)). A failure of `Node.create` itself is not caught here: the node has given back what it opened, the claim included, before `create` rejects, and the error goes to `main`, which prints it and exits 1.

`made.start()` and the RPC server's start are inside a `try`. If either fails, the usual case being an RPC address another process is listening on, the node is up and holds its directory, so the error may not simply end the process: it is logged as `start failed` with its message, `rpc` is set back to null (a server that did not start is not to be stopped) and `shutdown(1)` stops the node like any other, so the store is closed and the claim released before the process exits with status 1. `if (stopping) return` after `made.start()` is for a shutdown that began while the node was starting, a heap already `critical` at the first sample or a signal: no RPC server is opened for a node that is stopping. The same line after `rpc.start()` is for one that began while the server was starting: that shutdown holds the server and stops it, and `start` goes no further, so no status interval is set behind it. The guard's `critical` level, 95% of the heap limit, takes the same path with exit code 3: the alternative is V8 aborting the process at the limit with the stores wherever the last write left them, and a distinct code lets a supervisor tell "restart me with a larger `--heap`" from a crash. The guard has already logged the reason and the remedy by then (`memory: heap at the limit; stopping before the process aborts (raise --max-old-space-size or --heap)`), and the node has already shed what it could at the `pressure` level; what remains is a state that does not fit, which no amount of shedding changes.

**Client helpers.**

- `chainInfo(rpc)` returns `{ chainId, precision, coreAsset }` from `status` and `object` for id `4.0`. The core asset's id is hard-coded here (asset type 4, instance 0, which genesis creates first) rather than read from `parameters`, which also reports it.
- `toUnits(amount, precision)` turns `"12.5"` into base units. The amount must match `^\d+(\.\d+)?$` (digits, optionally a point and digits: no sign, no exponent, no thousands separator) and may not carry more decimals than the asset's precision; `12.345678` at precision 5 is refused rather than truncated to `12.34567`. A wallet that rounds what the user typed sends an amount the user did not type, and does so silently; refusing costs one retyped number. `whole(units, precision)` prints base units with a point and `precision` decimals; an asset of precision 0 has no fraction, and its amounts are printed as the bare number, `12` for 12 units.
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

An `OperationDraft` is an operation without its `fee`; `withFees` fills it from the schedule with `calculateFee`, which knows that account creation is priced by name (cheap or premium) and by size, that an account update pays a flat fee plus a price by size, that asset symbols are priced by length, and that everything else has a flat fee. One signer, one signature. The expiration is a minute ahead, or half of the chain's `maxTxExpirationMs` when that is shorter: `applyTransaction` refuses an expiration further past block time than the chain allows, so on a chain with a short window a fixed minute would have every transaction the CLI built refused as "too far in the future", and half the window leaves room for block time trailing the wall clock. A transaction refused at check time (`-32002`) surfaces as the `RpcClientError` that `main` prints; one included but failed prints the application's error from the result and sets the exit code to 1, so a script that drives the CLI can tell the two outcomes apart without parsing the text.

- `chainScheme(rpc)` asks `status` for the chain's `signatureScheme` (ML-DSA-44 if the node reports none) and returns its tag: what a key made for that chain must be. `create` passes it to `ks.add` when the keystore has no key of that name yet, and `create-validator` derives the node's consensus key from its seed with it.
- `keyFor(keystorePath, name)` opens the keystore (prompting if needed) and returns the named key.
- `leaves(o)` flattens a nested parameters object to `"fees.transfer.fee" -> value` pairs; `parameters` prints them, `proposals` diffs each proposal's parameters against the live ones, and `proposedParameters(rpc, overrides)` applies `path=value` overrides to the live parameters, keeping a number a number and a string (an amount) a string, and parses the result with `chainParametersFromJson` so a typo in a path is refused before anything is signed. Each segment of a path must be a parameter of its own (`Object.hasOwn`), so `fees.constructor=1` is refused with `no parameter fees.constructor` like any other name the parameters do not have.

**`lightClient(rpc, keystorePath, trust?)`** builds the light client the verifying commands share:

```ts
async function lightClient(rpc: RpcClient, keystorePath: string, trust?: { height: bigint; hash: Uint8Array }): Promise<LightClient> {
  const file = join(dirname(keystorePath), 'light.json');
  const status = await rpc.status();
  let anchor = trust;
  if (!anchor && existsSync(file)) {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { chainId?: string; height: string; hash: string };
    // The anchor is a header of one chain. A file written before the chain id was kept names none and is taken as it is.
    if (j.chainId !== undefined && j.chainId !== status.chainId) {
      throw new Error(`${file} holds a trusted header of chain ${j.chainId}, and this node is on chain ${status.chainId}; use the keystore directory of that chain, or set a new anchor with: light <target> trust <height> <hash>`);
    }
    anchor = { height: BigInt(j.height), hash: fromHex(j.hash) };
  }
  if (!anchor) {
    // Trust on first use: the latest header, recorded so later runs verify from it.
    const h = BigInt(status.latestHeight);
    anchor = { height: h, hash: headerHash(headerFromJson(await rpc.header(h))) };
    console.log(`trusting height ${h} on first use`);
  }
  const client = await LightClient.trust({ chainId: status.chainId, provider: new RpcProvider(rpc), verifier: new InlineVerifier() }, anchor.height, anchor.hash);
  const save = () => writeFileSync(file, JSON.stringify({ chainId: status.chainId, height: client.trusted.header.height.toString(), hash: toHex(headerHash(client.trusted.header)) }));
  save();
  return Object.assign(client, { save });
}
```

The anchor is, in order: what the caller passed (`light trust`), what `light.json` holds, or the node's latest header (trust on first use, announced). `light.json` is `{ chainId, height, hash }`: the anchor is a header of one chain, and the file says which. When the node's `status` reports another chain id the command stops there, with exit status 1 and a message that names both chains and the two ways out, `<path>/light.json holds a trusted header of chain X, and this node is on chain Y; use the keystore directory of that chain, or set a new anchor with: light <target> trust <height> <hash>`, and the file is left as it was. A file without a `chainId`, written before the field was kept, is accepted and written back with the chain id of the node it verified against. `light trust` passes its own anchor, so the file is not read and is overwritten with the new anchor and the node's chain id. The client uses the `InlineVerifier` (single-threaded, no worker to keep the process alive; review finding 34 is about the worker variant letting a process exit early). The returned object carries a `save` that callers invoke after verifying forward, so the next run starts from the newest verified header rather than the original anchor.

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

It asks for the proof at `latest - 1` because the header that commits to height N is N+1, which exists only once the chain has moved on. The `account` method answers as of the height it is asked for (chapter 12), so the balances, the validator and the history count the command prints are those of that same height, one block behind the latest, and the id it compares with the proven value was read from the proof's own leaf. Whether the saved anchor is before or after that header does not matter: `verifyKey` moves trust forward to it or walks back to it (chapter 13). The name proof proves what the authenticated name index says: the 8-byte id for the name, or absence. `ok` requires two things. First, `about`: the proof must be about what was asked, a key in the account type's first authenticated index (`byName` is index position 0 of `AccountType`), at the height the CLI named, and for the key encoding of this very name. `verifyKey` can only say that the proof folds to the app hash of a header the client verified; a node could satisfy that with a genuine proof for a different name, for a different index (an asset symbol, say), or for a different height whose header it also serves, and the client would verify each of those honestly. Binding the proof to the name, the index and the height it asked for is what turns "the node proved something" into "the node proved this". Second, the proven value must match the id the node returned (or both must be absent), so a node that returns one account and a proof for another is caught. The printout says "name proof verified by the light client" or "proof NOT verified", and for a missing account "proven absent by the light client" or "absence NOT proven"; either NOT sets the exit code to 1. Balances are printed with each asset's own precision from the response (`b.precision`, falling back to the core asset's), and the operated validator and the history count come from the same response; none of those is covered by the proof, only the name-to-id mapping is.

**`verifyTx(rpc, keystorePath, hash)`** fetches `tx` with `prove: true`, decodes the proof, and first checks that the proof's transaction hashes to the hash that was asked about (finding 24), then hands the query to the light client's `verifyTx` and prints one of the three verdicts: for `null`, where only inclusion was proven, `included at height H; result not yet committed` or `included at height H; this node does not hold the results of that block`; "verification failed: ..." for a failure (and the exit code is 1); or "verified: included at height H, succeeded" or "failed: <error>" for a result. The two `null` messages are told apart by the next header. A node sends no result proof either because the block after the transaction's does not exist yet, and then it sends no next header and the result is not yet committed, or because it holds that block but not the results of the transaction's own, having fetched it after a state sync without executing it; then the next header is there and waiting will not change the answer, so the message says what is missing:

```ts
  if (verdict === null) console.log(`included at height ${at}; ${q.nextHeader ? 'this node does not hold the results of that block' : 'result not yet committed'}`);
```

Both exit with status 0, since what was printed was proven. The transaction may be older than the anchor in `light.json`: the client walks back from the anchor to the transaction's header and the one after it, so a transaction from last week verifies from an anchor saved yesterday, and nothing requires the user to have trusted a height before it. The height it prints is the proof's own, `q.txProof.height`, not the `height` field the node sent beside it: the proof's height is the one the light client verified the inclusion against, and the node's field is a claim that nothing checked.

**Commands.** `main` handles `init`, `start`, `keys` and `join` first (they take no RPC target), then checks that the command is one of those that take a target (`TARGET_COMMANDS`), resolves the target and dispatches the rest. Amounts are whole tokens; validators are named by their operator account.

| command | arguments | what it does | RPC calls |
|---|---|---|---|
| `init` | `[dir=testnet] [validators=4] [basePort=26656] [--scheme ml-dsa-44\|secp256k1] [--max-block-bytes <n>]` | writes `genesis.json` naming the scheme, and the block size when `--max-block-bytes` gives one (65,536 to 16,777,216, checked before anything is written), `keystore.json` (faucet and `opN` keys made for it, passphrase printed) and `nodeN/config.json` for each validator | none |
| `start` | `<nodeDir> [--heap <MiB>] [--arena <MiB>]` | runs the node, in a child process under a heap limit of three quarters of memory or the given size, over TCP with LMDB and its RPC on `rpcListen`; `--arena` bounds the encoded objects kept in memory outside the heap (at least 16 MiB; all of them by default), the rest read from the store; `LOG` sets the level; exits 3 when the heap nears the limit | serves them |
| `keys list` | `[--keystore path]` | one line per key: name, scheme and address; fails if the file does not exist | none |
| `keys add` | `<name> [--scheme s]` | generates a seed for the scheme (ML-DSA-44 when absent), seals it, prints the address | none |
| `keys import` | `<name> <seedHex> [--scheme s]` | seals a given 32-byte seed as a key of the scheme (ML-DSA-44 when absent) | none |
| `keys export` | `<name>` | prints the seed in hex; fails if the file does not exist | none |
| `keys remove` | `<name>` | removes the key and prints `removed <name> <address>`; fails if the file does not exist or holds no key of that name | none |
| `show` | `<target>` | height, peers, community pool, bonded, inflation; each active validator's operator, status, stake, self-bond and power; the first 50 accounts with balances | `status`, `object 4.0`, `object 2.0`, `validator` per active entry, `accounts` |
| `account` | `<target> <name>` | the account with balances, operated validator and history count, and a name proof checked by the light client | `status`, `object 4.0`, `account (prove, height)`, `header`, `commit`, plus the light client's `status`, `header`, `commit`, `validatorSet` |
| `history` | `<target> <account>` | the newest 50 history entries, decoded, hashes shortened | `accountHistory (limit 50, reverse)` |
| `tx` | `<target> <hash>` | height, index, result, and the decoded operations | `tx` |
| `verify-tx` | `<target> <hash>` | the same, verified by the light client: inclusion and, when committed and the node holds it, the result | `tx (prove)`, then the light client's calls |
| `create` | `<target> <name>` | the faucet registers a new account whose single key is taken from the keystore or added to it in the chain's scheme | `status` (for the scheme, when the key is new), `status`, `object 4.0`, `account faucet`, `parameters`, `broadcastTx commit` |
| `transfer` | `<target> <from> <to> <amount>` | a core-asset transfer signed by `from` | `status` x2, `object 4.0` x2 (the command and `send` each ask for the chain's id and precision), `account` x2, `parameters`, `broadcastTx commit` |
| `create-validator` | `<nodeDir> <operator> <selfBond>` | registers the node's consensus key (derived from the seed in its `config.json` with the chain's scheme) as a validator operated by `operator`; needs a node directory | `status`, `object 4.0`, `account`, `status` (for the scheme), then `send`'s `status`, `object 4.0`, `parameters`, `broadcastTx commit` |
| `delegate` | `<target> <from> <operator> <amount>` | delegates `amount` to the operator's validator | `account`, `validator`, `parameters`, `broadcastTx commit`, plus `status` and `object 4.0` twice each |
| `undelegate` | `<target> <from> <operator> <amount>` | converts the amount to shares at the delegation's current rate (all shares if the amount covers the whole delegation) and undelegates | `delegation`, `account`, `parameters`, `broadcastTx commit`, plus `status` and `object 4.0` twice each |
| `unjail` | `<target> <operator>` | the operator asks for its jailed validator back | `account`, `validator`, `parameters`, `broadcastTx commit`, plus `status` and `object 4.0` |
| `parameters` | `<target>` | the fee schedule and staking parameters in force, one leaf per line | `parameters` |
| `proposals` | `<target>` | open proposals, each with its signals, expiry and the leaves it would change | `parameters`, `proposals` |
| `propose` | `<target> <operator> <path=value>...` | the operator's validator proposes the live parameters with the overrides applied (`FEES.md` section 4) | `parameters`, `account`, `validator`, `broadcastTx commit`, plus `status`, `object 4.0`, `parameters` |
| `signal` | `<target> <operator> <proposalId>` | the operator's validator signals support for a proposal | `account`, `validator`, `parameters`, `broadcastTx commit`, plus `status` and `object 4.0` |
| `light trust` | `<target> trust <height> <hash>` | sets the trust anchor and saves it in `light.json` | `status`, `header`, `commit`, `validatorSet` |
| `light verify` | `<target> verify [height]` | verifies forward to a height or to the latest, prints the height, hash, validator count and the number of steps, saves the anchor | `status`, then `header`, `commit`, `validatorSet` per step |
| `join` | `<dir> <nodeN> <seedAddr> <trustHeight> <trustHash> [basePort=26700]` | writes a full node's `config.json` with a state-sync anchor and `backfill: true`; start it with `start` | none |

A few of the commands are worth reading closely. `keys add` and `keys import` make a key for whatever `--scheme` names, ML-DSA-44 when absent, since there is no chain in view; the chain refuses a key of the other scheme when a transaction names it (chapter 11), not before. `keys remove` needs the keystore to exist, as `list` and `export` do, and the passphrase; it reads the key's address with `ks.get(name)` before it calls `ks.remove(name)`, and prints `removed <name> <address>`:

```ts
    case 'remove': {
      // The seed is gone with the entry: only an export made beforehand brings the key back.
      const name = need(1, 'name');
      const address = toHex(ks.get(name).address);
      ks.remove(name);
      console.log(`removed ${name} ${address}`);
      break;
    }
```

`create` reuses an existing key of that name if the keystore has one, otherwise adds one made for the scheme `status` reports (`ks.add(name, undefined, await chainScheme(rpc))`), and the registrar and signer are both the faucet, so `create` works only where the keystore holds the faucet key. `undelegate` reads the delegation first because the operation takes shares, not tokens:

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
5. `keyFor`: the passphrase from the environment, `Keystore.openOrCreate` (scrypt derivation, then `get` of the first key as the passphrase check), then `get('faucet')` (one AES-GCM decryption, one key generation from the seed in the scheme the record names, ML-DSA-44 on this testnet).
6. `send`: `chainInfo` again, `parameters` for the schedule, `withFees` puts the `transfer.fee` from it on the operation, `signedTxBytes` encodes the body, signs it under the chain's transaction context with the faucet's secret key and appends the signature, 2,421 bytes under ML-DSA-44; the whole transaction is about 2.5 KiB (`README.md`, "Performance"). On a testnet made with `--scheme secp256k1` the signature is 65 bytes and the transaction about 150.
7. `broadcastTx` in `commit` mode: the node's `checkTx` admits it, it is gossiped, proposed, committed, and the RPC answers with its height and result, within the 30-second default. The CLI prints `included at height 57 (tx 31d0…)`, or the application's error if it was included but failed.

Seven RPC calls before the broadcast (`status` and `object` twice each, `account` twice, `parameters` once), of which the two `object` and two `account` calls are costly: with the broadcast that is 28 tokens of the default burst of 100.

**Error handling.** `main` is wrapped once: any thrown error prints its message and exits with status 1. No command, or one `main` does not know, prints `usage: see the comment at the top of src/cli.ts` and exits 1, whatever follows it:

```ts
  // Told apart before the target is read, so that a mistyped command gets the usage and not a complaint about its target.
  if (cmd === undefined || !TARGET_COMMANDS.has(cmd)) {
    console.log('usage: see the comment at the top of src/cli.ts');
    process.exit(1);
  }
  const t = target(need(0, 'target'));
```

`TARGET_COMMANDS` is the set of the second `switch`'s cases, and the check comes before the target is resolved, so a mistyped command is answered with the usage pointer whether nothing, a URL or a directory that does not exist comes after it. A command that is known and has no target says `missing target`, and one whose target is neither a URL nor a node directory fails with the error of reading that directory's `config.json`, each with exit status 1. Three commands also set `process.exitCode = 1` on an outcome they report rather than throw: `send` when the transaction was included but failed, `account` when the proof did not verify or was not about what was asked, and `verify-tx` when verification failed. The output is the same as before in those cases; the exit code is for scripts. `start` has one more code: 3 when the memory guard reached `critical` and the node was stopped cleanly for it, which the wrapper passes through, so a supervisor can restart with a larger `--heap` rather than treat it as a crash. There is no retry, and output is not held back until a command has finished: `show` prints its first line before the validator and account calls that can still fail, and the first use of the light client prints `trusting height H on first use` before the anchor is verified, so a failed command can leave such lines above its error. Nothing is written to disk by a client command except `light.json`, the keystore and the lock file the keystore holds while it writes.

## How it is tested

`test/rpc.test.ts`, "seals seeds under a passphrase and refuses the wrong one", is the keystore test: `create` with a passphrase, `add` of a generated key and of a fixed seed, `list` in insertion order, a duplicate name refused with "already exists"; reopening with the right passphrase recovers the same address, the same seed through `seedOf`, and the same public key through `publicKeyOf`; opening with a wrong passphrase throws "wrong passphrase"; and the raw file does not contain the fixed seed's hex, which is the whole point of encrypting. The file is then rewritten with `version: 3`: `open` throws "unsupported keystore", and so does `add` on the handle opened before, which leaves the file without the new key and without a lock. `test/schemes.test.ts`, "keeps each key's scheme in the keystore, reads a version 1 file as ML-DSA-44 and writes it as version 2", covers the versions: a new keystore is version 2; the same file set to version 1 with the `scheme` field deleted from a key opens with `version` 1 and reads that key as ML-DSA-44, and is left unchanged by the reading; an `add` through that handle writes version 2 with every key's scheme named; and a version 2 file with the field deleted from a key throws "names no scheme" from `get` and `list` for that key while the other key still opens. `test/review3.test.ts`, "fails to open rather than give another key under the same name", changes or removes a record's scheme and expects the damage reported, by either of the two messages. `test/review2.test.ts`, "bounds the peer database and refuses an unnamed key", adds the two edges, on a fresh keystore `add('')` throws "a key needs a name", and once `alice` has been added, `open` with another passphrase throws "wrong passphrase", so a keystore with one key always checks; and then the two-writer case: two handles are opened over the same file, one adds `a` and the other `b`, a third `open` lists `a`, `alice` and `b`, so neither write overwrote the other's; the second handle's `add('a')` is refused with "already exists", since its own write re-read the file and brought `a` into its view; `remove('b')` through the first handle is gone on reopening; and no `.lock` file is left beside the keystore.

`test/review4.test.ts`, "removes a key by name, for good, and says so when there is none by that name, as does the command": a keystore with `keep` and `drop` has `drop` removed; removing it again, or a name that never existed, throws `no key named ...`; a handle opened afresh lists `keep` alone, and no lock file is left. The case then runs the command itself in a child process with `CHAIN_PASSPHRASE` set: `keys add temp` exits 0, `keys remove keep` exits 0 and prints `removed keep` and the address, a second one exits non-zero with `no key named keep`, `keys list` shows the key added meanwhile, and `keys remove` against a path with no keystore exits non-zero without creating one.

`test/review5-rpc.test.ts` has four cases for this chapter. "keeps a key under a name every object inherits, and has none by such a name until one is added" takes the names `constructor`, `toString`, `__proto__` and `hasOwnProperty`: in a new keystore `has` is false and `get`, `publicKeyOf` and `remove` throw `no key named ...` for each; each is then added, a second `add('constructor')` is refused with `already exists`, the handle and one opened afresh list the four names in order and give back the public keys that were added, and after two are removed through the second handle a third lists the other two. "writes the block size it was given into the genesis, and runs a node that stops on a signal with its directory released" runs `init` and `start` in child processes. `init` for one validator with `--max-block-bytes 100` exits 1 with `maxBlockBytes must be a whole number from 65536 to 16777216` and leaves no directory; with `--max-block-bytes 131072` and the suite's scheme it exits 0 and the `genesis.json` it wrote has `consensus.maxBlockBytes` of 131072. `start` is then run on `node0` with `--heap 512` and `CROSSCHAIN_CHILD` emptied, so under the heap wrapper as an operator runs it. Once the node has logged a status line, which comes after five seconds, the `LOCK` file is in its data directory and a second `start` on the same directory exits 1 with `in use by process`. The node is sent `SIGINT`: it exits 0, the `LOCK` file is gone, and its output has no `stopping failed`, `start failed`, `the store is closed`, `Unhandled` or `Error:`. This is the suite's test of the command line's shutdown; it stops a node that has passed a status tick and does not make a tick fall while the node is stopping. "points at the usage for a command it does not know, with or without a target after it" runs `src/cli.ts` in a child process with no arguments, with `frobnicate` alone, with a URL after it and with a directory that does not exist after it: each exits 1 and prints the usage line and nothing else, and `show` without a target prints `missing target`. "prints whole amounts of an asset without decimals, keeps the chain with its light client anchor, and says when a node holds no results" runs commands against an `RpcServer` in the test's own process, on a four-validator chain `r5-cli` whose core asset has precision 0. `show` exits 0 and prints the faucet's balance as `1000000000` and the pool and bonded figures as bare numbers. After an `accountCreate` broadcast in commit mode, `verify-tx` prints `verified: included at height H, succeeded`; with the node's `loadResults` made to return null its last line is `included at height H; this node does not hold the results of that block`, still with exit status 0. The `light.json` those runs wrote names `r5-cli`. Rewritten to name `another-chain`, it makes `light verify` exit 1 with `light.json holds a trusted header of chain another-chain, and this node is on chain r5-cli` and stays as it was; rewritten without a `chainId`, it is accepted, `light verify` prints `verified height ...`, and the file names `r5-cli` again.

Those and the `keys` commands above are the commands of the CLI whose work an automated test checks: `init` and `start`, `keys add`, `keys remove` and `keys list`, `show`, `verify-tx` and `light verify`. One more case runs the file: `test/review3.test.ts`, "set by the operator in any spelling keeps `start` from putting its own over it", runs `start` on a directory that does not exist with a `--max-old-space-size` in `NODE_OPTIONS`, in each spelling, and expects no `running the node under` line and an error naming `config.json`, so the wrapper stepped aside and the command ran in place. The commands that sign and broadcast (`create`, `transfer`, `create-validator`, `delegate`, `undelegate`, `unjail`, `propose`, `signal`) and `account`, `history`, `tx`, `parameters`, `proposals` and `light trust` are not driven by a test; those have been run by hand against the TCP testnet `README.md` describes. The pieces the CLI is built from are tested elsewhere: the RPC methods it calls in `test/rpc.test.ts` (chapter 12), `signedTxBytes` and `withFees` throughout `test/chain.test.ts`, `test/fees.test.ts` and `test/rpc.test.ts`, and the light client in `test/light.test.ts` and `test/chain.test.ts` (chapter 13). The `json-rpc parameters` case in `test/rpc.test.ts` is the one closest to the wallet's logic: a transaction priced from the served schedule is included, one priced from the defaults is refused with the schedule's reason, which is exactly what `send` relies on.

## Limitations and ideas

- Of the commands that talk to a node, tests run `show`, `verify-tx` and `light verify` against an in-process RPC server. The commands that sign and broadcast, and `account`, `history`, `tx`, `parameters`, `proposals` and `light trust`, have no test.
- `keys add` and `keys import` create the keystore when the path does not exist (`openOrCreate`), and an empty keystore cannot detect a wrong passphrase, so the first `add` after a mistyped passphrase seals its seed under the mistyped passphrase: the seed can be recovered with that passphrase and not with the intended one, and every later `open` with the intended one reports "wrong passphrase".
- `keys export` prints the seed in the clear to stdout. `keys remove` asks for no confirmation, and a removed key comes back only from an export made beforehand.
- `keys add` and `keys import` take the scheme from `--scheme` and never from a chain, so a key made for the wrong scheme is only refused when a transaction names it; `create` is the one command that asks the chain first. `keys export` prints the seed alone, and importing it elsewhere needs the same `--scheme` to get the same address.
- The core asset (`4.0`) and the dynamic properties (`2.0`) are hard-coded ids in `chainInfo` and `show`; `parameters` already reports the core asset id.
- `account` verifies the name mapping only; balances and the rest are printed unverified. Verifying a balance would need an object proof for the balance object plus the name proof.
- One signer per transaction and only the operations the commands expose: no `accountUpdate`, `assetCreate`, `assetIssue`, `validatorUpdate` or `redelegate`, and no non-core-asset transfers, though the application supports them all.
- The passphrase prompt hides echo by patching `stdout.write`, which works for a plain terminal and not necessarily elsewhere.
- `light.json` is per keystore directory, not per chain: one keystore directory holds the anchor of one chain, and pointing it at a node of another chain is refused with a message naming both. A `light.json` that names no chain is taken as belonging to whichever chain the node is on; if it does not, the failure is `LightClient.trust`'s, `header H does not have the trusted hash`, or that the provider has no header H.
- The keystore lock waits five seconds and treats a lock older than thirty as abandoned. Those are generous for a write that takes milliseconds, but a machine suspended with the lock held could have it removed from under it; the atomic write still leaves a whole file either way.
- `start` always wraps itself unless `--max-old-space-size` is already set or `CROSSCHAIN_CHILD` is in the environment; there is no flag to run in place, and a `--heap` below 256 MiB is refused rather than clamped. `--arena` is a fixed figure for the life of the process: nothing adjusts it to the memory the machine has left.

Exercises:

1. Add `keys show <name>`, which prints a public key through `publicKeyOf` without asking for the passphrase.
2. Add a `redelegate` command: read the delegation, convert tokens to shares as `undelegate` does, and build the `redelegate` operation with `source` and `destination` validators resolved from operator names.
3. Add asset commands: `asset-create <issuer> <symbol> <precision> <maxSupply>` and `issue <issuer> <asset> <to> <amount>`, and extend `transfer` with an optional asset symbol resolved through the `key` method on the asset symbol index.
4. Make `account` verify a balance. The `account` method's `balances` carry `asset`, `assetId`, `precision` and `amount` but not the balance object's id, so first add that id to each entry in `src/rpc/methods.ts`. Then fetch `object` with `prove: true` for that id at the height the account was read at, check the proof with `client.verifyState`, and check that the proven object's owner, asset and amount are the ones the account answer gave.
5. Add a `watch <target>` command that opens `/events?types=block,tx` and prints each record, reconnecting with `Last-Event-ID` on disconnect.
6. Extend the CLI test to the commands that sign: start an `RpcServer` in the test, run `init` into a temporary directory, and drive `create`, `transfer` and `account` in child processes as `test/review5-rpc.test.ts` drives `show` and `verify-tx`, asserting on what they print.

## Where to next

The [tests](15-tests.md) chapter walks through the suite that holds all of this together.
