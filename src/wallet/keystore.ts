/**
 * An encrypted keystore: named 32-byte seeds, each recorded with the
 * signature scheme its key is derived under, sealed with AES-256-GCM under
 * a key derived from a passphrase with scrypt. One derivation per keystore;
 * each seed has its own IV. The file is JSON so it can be inspected, and
 * nothing in it reveals a seed without the passphrase.
 *
 * Every write takes a lock file beside the keystore and starts from what is
 * on disk at that moment, so two processes (or two handles) over one file
 * keep each other's keys instead of the last writer winning.
 *
 * The file has a version. Version 1 came first, with one scheme and no
 * `scheme` field; a second scheme added the field without changing the
 * number, so in a version 1 file a key without one is ML-DSA-44. Version 2
 * names the scheme of every key, and a key without one is damaged, not
 * assumed. A version 1 file is read as it is and written as version 2 the
 * next time it is changed; reading never writes.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { writeAtomic } from '../store/files.ts';
import { fromHex, toHex } from '../crypto/hash.ts';
import { DEFAULT_SCHEME, generateSeed, keyPairFromSeed, schemeName, schemeTag, SEED_SIZE, type KeyPair, type SchemeName, type SchemeTag } from '../crypto/keys.ts';

interface SealedKey {
  address: string;
  publicKey: string;
  /** Every key of a version 2 file has one. In a version 1 file it may be absent: ML-DSA-44, the one scheme of the time. */
  scheme?: SchemeName;
  iv: string;
  ciphertext: string;
  tag: string;
}

interface KeystoreFile {
  version: 1 | 2;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  /** By name, in an object without a prototype: a key may be called `constructor` or `__proto__` like any other. */
  keys: Record<string, SealedKey>;
}

/** The keys of a file as read, moved into an object that has only them: no name finds what every object inherits. */
function ownKeys(keys: Record<string, SealedKey> | undefined): Record<string, SealedKey> {
  return Object.assign(Object.create(null), keys);
}

export const SCRYPT = { N: 32768, r: 8, p: 1 };

/** The version written. */
export const KEYSTORE_VERSION = 2;

function checkFile(file: KeystoreFile): KeystoreFile {
  if ((file.version !== 1 && file.version !== 2) || file.kdf?.name !== 'scrypt') throw new Error('unsupported keystore');
  file.keys = ownKeys(file.keys);
  return file;
}

const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 5000;
/** A lock older than this was left by a process that died holding it; no write takes nearly as long. */
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class Keystore {
  readonly path: string;
  private readonly file: KeystoreFile;
  private readonly key: Buffer;

  private constructor(path: string, file: KeystoreFile, key: Buffer) {
    this.path = path;
    this.file = file;
    this.key = key;
  }

  private static derive(passphrase: string, kdf: KeystoreFile['kdf']): Buffer {
    return scryptSync(passphrase, Buffer.from(kdf.salt, 'hex'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r });
  }

  static create(path: string, passphrase: string): Keystore {
    if (existsSync(path)) throw new Error(`${path} already exists`);
    const file: KeystoreFile = { version: KEYSTORE_VERSION, kdf: { name: 'scrypt', ...SCRYPT, salt: randomBytes(16).toString('hex') }, keys: ownKeys(undefined) };
    const ks = new Keystore(path, file, Keystore.derive(passphrase, file.kdf));
    ks.mutate(() => {}, true);
    return ks;
  }

  /** Opens and checks the passphrase against the first key, if any. */
  static open(path: string, passphrase: string): Keystore {
    const file = checkFile(JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile);
    const ks = new Keystore(path, file, Keystore.derive(passphrase, file.kdf));
    const first = Object.keys(file.keys)[0];
    if (first !== undefined) ks.get(first);
    return ks;
  }

  static openOrCreate(path: string, passphrase: string): Keystore {
    return existsSync(path) ? Keystore.open(path, passphrase) : Keystore.create(path, passphrase);
  }

  /** The version of the file as this handle last read or wrote it. */
  get version(): number {
    return this.file.version;
  }

  /** The scheme a key was made for: the one it names, or in a version 1 file that names none, ML-DSA-44. */
  private schemeOf(name: string, k: SealedKey): SchemeName {
    if (k.scheme !== undefined) return k.scheme;
    if (this.file.version === 1) return 'ml-dsa-44';
    throw new Error(`key ${name} names no scheme; the keystore entry is damaged`);
  }

  list(): { name: string; address: string; publicKey: string; scheme: SchemeName }[] {
    return Object.entries(this.file.keys).map(([name, k]) => ({ name, address: k.address, publicKey: k.publicKey, scheme: this.schemeOf(name, k) }));
  }

  has(name: string): boolean {
    return Object.hasOwn(this.file.keys, name);
  }

  /** A key of the given scheme (the chain's); the seed is generated when not supplied. */
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

  /** The raw seed, for export. */
  seedOf(name: string): Uint8Array {
    return this.get(name).seed;
  }

  /** Forget a key. Its seed goes with it; the caller has exported it if it is wanted again. */
  remove(name: string): void {
    this.mutate((keys) => {
      if (!Object.hasOwn(keys, name)) throw new Error(`no key named ${name}`);
      delete keys[name];
    });
  }

  /**
   * Change the keys under the file's lock, starting from the keys on disk at
   * that moment (another handle may have written since this one read), then
   * write the file atomically. With `fresh`, the file must not exist yet.
   */
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

  /** Public keys without unlocking, for genesis writing. */
  publicKeyOf(name: string): Uint8Array {
    const k = this.file.keys[name];
    if (!k) throw new Error(`no key named ${name}`);
    return fromHex(k.publicKey);
  }
}
