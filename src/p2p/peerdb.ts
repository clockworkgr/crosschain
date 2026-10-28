/**
 * Known peer addresses with connection history, persisted as JSON (nothing
 * in it is hashed). Modelled on Graphene's potential_peer_db: the connect
 * loop draws candidates from here, preferring addresses that have worked
 * before and backing off exponentially from ones that have not.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface PeerRecord {
  addr: string;
  lastSeen: number;
  lastAttempt: number;
  failures: number;
  successes: number;
  /** Not dialled again before this time, after misbehaviour. */
  bannedUntil?: number;
  bans?: number;
}

const MAX_BACKOFF_MS = 60_000;

/** Addresses kept at most; a peer advertising endless addresses fills nothing beyond this. */
export const MAX_RECORDS = 4096;

export class PeerDb {
  private readonly records = new Map<string, PeerRecord>();
  private readonly file: string | null;

  constructor(file: string | null = null, seeds: string[] = []) {
    this.file = file;
    if (file && existsSync(file)) {
      for (const r of JSON.parse(readFileSync(file, 'utf8')) as PeerRecord[]) this.records.set(r.addr, r);
    }
    this.addAll(seeds);
  }

  static isValidAddr(addr: string): boolean {
    return /^[^\s:]+:\d{1,5}$/.test(addr) || /^\[[0-9a-fA-F:]+\]:\d{1,5}$/.test(addr);
  }

  add(addr: string): boolean {
    if (!PeerDb.isValidAddr(addr) || this.records.has(addr)) return false;
    if (this.records.size >= MAX_RECORDS) return false; // gossip cannot grow the database without bound
    this.records.set(addr, { addr, lastSeen: 0, lastAttempt: 0, failures: 0, successes: 0 });
    return true;
  }

  addAll(addrs: string[]): void {
    for (const a of addrs) this.add(a);
  }

  all(): PeerRecord[] {
    return [...this.records.values()];
  }

  get size(): number {
    return this.records.size;
  }

  markAttempt(addr: string): void {
    const r = this.records.get(addr);
    if (r) r.lastAttempt = Date.now();
  }

  markSuccess(addr: string): void {
    const r = this.records.get(addr);
    if (!r) return;
    r.successes++;
    r.failures = 0;
    r.lastSeen = Date.now();
    this.save();
  }

  markFailure(addr: string): void {
    const r = this.records.get(addr);
    if (!r) return;
    r.failures++;
    this.save();
  }

  /** Addresses worth dialing now, best first. */
  /** Ban an address for a while; each repeat doubles the time. */
  ban(addr: string, baseMs: number, now = Date.now()): number {
    const r = this.records.get(addr) ?? this.records.set(addr, { addr, lastSeen: 0, lastAttempt: 0, failures: 0, successes: 0 }).get(addr)!;
    r.bans = (r.bans ?? 0) + 1;
    r.bannedUntil = now + baseMs * 2 ** (r.bans - 1);
    this.save();
    return r.bannedUntil;
  }

  isBanned(addr: string, now = Date.now()): boolean {
    const r = this.records.get(addr);
    return r?.bannedUntil !== undefined && r.bannedUntil > now;
  }

  candidates(exclude: Set<string>, now = Date.now()): string[] {
    return this.all()
      .filter((r) => !exclude.has(r.addr))
      .filter((r) => now - r.lastAttempt >= Math.min(MAX_BACKOFF_MS, 1000 * 2 ** r.failures))
      .filter((r) => r.bannedUntil === undefined || r.bannedUntil <= now)
      .sort((a, b) => a.failures - b.failures || a.lastAttempt - b.lastAttempt)
      .map((r) => r.addr);
  }

  /** Addresses to share with others: ones that have worked, most recently seen first. */
  sample(n: number, exclude: Set<string>): string[] {
    return this.all()
      .filter((r) => !exclude.has(r.addr) && r.successes > 0)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, n)
      .map((r) => r.addr);
  }

  save(): void {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.all()));
  }
}
