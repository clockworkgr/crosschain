/**
 * A deliberately trivial application used to exercise the engine.
 *
 * Transactions are utf-8 strings:
 *   "key=value"                 set a key
 *   "val:<hex public key>:<n>"  set a validator's power to n (0 removes)
 *
 * It keeps a committed map and a working copy. finalizeBlock mutates the
 * working copy; commit promotes it. The app hash is a hash over the sorted
 * entries, so every node that applied the same blocks reports the same hash.
 */
import { readFileSync, existsSync } from 'node:fs';
import { writeAtomic } from '../store/files.ts';
import { encode } from '../codec/writer.ts';
import { fromHex, sha256 , toHex } from '../crypto/hash.ts';
import { PUBLIC_KEY_SIZE } from '../crypto/keys.ts';
import type { Genesis } from '../types/genesis.ts';
import type { ValidatorUpdate } from '../types/validator.ts';
import type { Application, CheckTxResult, FinalizeBlockRequest, FinalizeBlockResult, InitChainResult } from './types.ts';

interface Snapshot {
  height: string;
  entries: [string, string][];
}

export class KvStoreApp implements Application {
  private committed = new Map<string, string>();
  private working = new Map<string, string>();
  private lastHeight = 0n;
  private lastAppHash = sha256(new Uint8Array());
  private pendingUpdates: ValidatorUpdate[] = [];
  /** The set as the application knows it, public key hex to power, so an update can be checked before it is handed over. */
  private validators = new Map<string, bigint>();
  private readonly file: string | null;
  /** Misbehaviour seen, for tests and demos. */
  readonly slashed: { address: Uint8Array; height: bigint }[] = [];

  constructor(file: string | null = null) {
    this.file = file;
    if (file && existsSync(file)) {
      const snap = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
      this.lastHeight = BigInt(snap.height);
      this.committed = new Map(snap.entries);
      this.lastAppHash = this.hashOf(this.committed);
    }
  }

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

  private parse(tx: Uint8Array): { kind: 'set'; key: string; value: string } | { kind: 'val'; update: ValidatorUpdate } | { kind: 'bad'; error: string } {
    let s: string;
    try {
      s = new TextDecoder('utf-8', { fatal: true }).decode(tx);
    } catch {
      return { kind: 'bad', error: 'not utf-8' };
    }
    if (s.startsWith('val:')) {
      const parts = s.split(':');
      if (parts.length !== 3) return { kind: 'bad', error: 'val tx needs val:<pubkey>:<power>' };
      let publicKey: Uint8Array;
      try {
        publicKey = fromHex(parts[1]!);
      } catch {
        return { kind: 'bad', error: 'bad public key hex' };
      }
      if (publicKey.length !== PUBLIC_KEY_SIZE) return { kind: 'bad', error: 'bad public key size' };
      if (!/^\d+$/.test(parts[2]!)) return { kind: 'bad', error: 'bad power' };
      return { kind: 'val', update: { publicKey, power: BigInt(parts[2]!) } };
    }
    const eq = s.indexOf('=');
    if (eq <= 0) return { kind: 'bad', error: 'expected key=value' };
    return { kind: 'set', key: s.slice(0, eq), value: s.slice(eq + 1) };
  }

  async initChain(genesis: Genesis): Promise<InitChainResult> {
    const text = new TextDecoder().decode(genesis.appState).trim();
    if (text.length > 0) {
      const obj = JSON.parse(text) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) this.committed.set(k, String(v));
    }
    this.lastAppHash = this.hashOf(this.committed);
    for (const v of genesis.validators ?? []) this.validators.set(toHex(v.publicKey), v.power);
    this.persist();
    return { appHash: this.lastAppHash };
  }

  async checkTx(tx: Uint8Array): Promise<CheckTxResult> {
    const p = this.parse(tx);
    return p.kind === 'bad' ? { ok: false, error: p.error } : { ok: true };
  }

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

  async commit(): Promise<void> {
    for (const u of this.pendingUpdates) {
      if (u.power === 0n) this.validators.delete(toHex(u.publicKey));
      else this.validators.set(toHex(u.publicKey), u.power);
    }
    this.committed = this.working;
    this.lastAppHash = this.hashOf(this.committed);
    this.persist();
  }

  async info(): Promise<{ lastHeight: bigint; lastAppHash: Uint8Array }> {
    return { lastHeight: this.lastHeight, lastAppHash: this.lastAppHash };
  }

  get(key: string): string | undefined {
    return this.committed.get(key);
  }

  private persist(): void {
    if (!this.file) return;
    const snap: Snapshot = { height: this.lastHeight.toString(), entries: [...this.committed.entries()] };
    writeAtomic(this.file, new TextEncoder().encode(JSON.stringify(snap)));
  }
}
