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
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { writeAtomic } from '../store/files.ts';
import { fromHex, toHex } from '../crypto/hash.ts';
import { DEFAULT_SCHEME, generateSeed, keyPairFromSeed, schemeName, schemeTag, SEED_SIZE, type KeyPair, type SchemeName, type SchemeTag } from '../crypto/keys.ts';

interface SealedKey {
  address: string;
  publicKey: string;
  /** Absent in files written when there was one scheme: ML-DSA-44. */
  scheme?: SchemeName;
  iv: string;
  ciphertext: string;
  tag: string;
}

interface KeystoreFile {
  version: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  keys: Record<string, SealedKey>;
}

export const SCRYPT = { N: 32768, r: 8, p: 1 };

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
    const file: KeystoreFile = { version: 1, kdf: { name: 'scrypt', ...SCRYPT, salt: randomBytes(16).toString('hex') }, keys: {} };
    const ks = new Keystore(path, file, Keystore.derive(passphrase, file.kdf));
    ks.mutate(() => {}, true);
    return ks;
  }

  /** Opens and checks the passphrase against the first key, if any. */
  static open(path: string, passphrase: string): Keystore {
    const file = JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
    if (file.version !== 1 || file.kdf.name !== 'scrypt') throw new Error('unsupported keystore');
    const ks = new Keystore(path, file, Keystore.derive(passphrase, file.kdf));
    const first = Object.keys(file.keys)[0];
    if (first !== undefined) ks.get(first);
    return ks;
  }

  static openOrCreate(path: string, passphrase: string): Keystore {
    return existsSync(path) ? Keystore.open(path, passphrase) : Keystore.create(path, passphrase);
  }

  list(): { name: string; address: string; publicKey: string; scheme: SchemeName }[] {
    return Object.entries(this.file.keys).map(([name, k]) => ({ name, address: k.address, publicKey: k.publicKey, scheme: k.scheme ?? 'ml-dsa-44' }));
  }

  has(name: string): boolean {
    return name in this.file.keys;
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
      if (name in keys) throw new Error(`key ${name} already exists`); // another handle got there first
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
    return keyPairFromSeed(new Uint8Array(seed), schemeTag(k.scheme ?? 'ml-dsa-44'));
  }

  /** The raw seed, for export. */
  seedOf(name: string): Uint8Array {
    return this.get(name).seed;
  }

  remove(name: string): void {
    this.mutate((keys) => {
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

  /** Public keys without unlocking, for genesis writing. */
  publicKeyOf(name: string): Uint8Array {
    const k = this.file.keys[name];
    if (!k) throw new Error(`no key named ${name}`);
    return fromHex(k.publicKey);
  }
}
