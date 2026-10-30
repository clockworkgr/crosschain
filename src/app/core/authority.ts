/**
 * Authorities, BitShares style. An authority is a threshold plus weighted
 * members, where a member is either a public key or another account. It is
 * satisfied when the weights of the signing keys, plus the weights of the
 * member accounts whose own active authority is satisfied, reach the
 * threshold. Recursion through accounts stops at MAX_AUTHORITY_DEPTH.
 *
 * Every account has two: owner, which can change anything including itself,
 * and active, which can do everything except change owner. An owner
 * signature also satisfies an active requirement.
 *
 * Signatures are identified by the key's address (sha256 of the public key)
 * because ML-DSA signatures do not allow key recovery (and both schemes are
 * treated alike), and because an ML-DSA key is 1313 bytes and lives in the
 * account object rather than in every transaction.
 */
import type { Reader } from '../../codec/reader.ts';
import type { Writer } from '../../codec/writer.ts';
import { compareBytes, toHex } from '../../crypto/hash.ts';
import { addressOf, decodePublicKey, isPublicKey, schemeName, schemeOf, type SchemeTag } from '../../crypto/keys.ts';

export interface KeyAuth {
  publicKey: Uint8Array;
  weight: number;
}

export interface AccountAuth {
  account: bigint;
  weight: number;
}

export interface Authority {
  threshold: number;
  /** Ascending by account id. */
  accounts: AccountAuth[];
  /** Ascending by public key bytes. */
  keys: KeyAuth[];
}

export const MAX_AUTHORITY_MEMBERS = 16;
export const MAX_AUTHORITY_DEPTH = 2;

export function encodeAuthority(w: Writer, a: Authority): void {
  w.u32(a.threshold)
    .array(a.accounts, (w, x) => w.u64(x.account).u32(x.weight))
    .array(a.keys, (w, k) => w.fixed(k.publicKey).u32(k.weight));
}

export function decodeAuthority(r: Reader): Authority {
  return {
    threshold: r.u32(),
    accounts: r.array((r) => ({ account: r.u64(), weight: r.u32() }), MAX_AUTHORITY_MEMBERS),
    keys: r.array((r) => ({ publicKey: decodePublicKey(r), weight: r.u32() }), MAX_AUTHORITY_MEMBERS),
  };
}

/** Returns a problem, or null if the authority is well formed and satisfiable. With a scheme, every key must be of it. */
export function checkAuthority(a: Authority, scheme?: SchemeTag): string | null {
  if (a.threshold < 1) return 'threshold must be at least 1';
  if (a.accounts.length + a.keys.length === 0) return 'authority has no members';
  if (a.accounts.length > MAX_AUTHORITY_MEMBERS || a.keys.length > MAX_AUTHORITY_MEMBERS) return 'too many authority members';
  let total = 0;
  for (let i = 0; i < a.accounts.length; i++) {
    const x = a.accounts[i]!;
    if (x.weight < 1) return 'member weight must be at least 1';
    if (i > 0 && a.accounts[i - 1]!.account >= x.account) return 'account members must be ascending and distinct';
    total += x.weight;
  }
  for (let i = 0; i < a.keys.length; i++) {
    const k = a.keys[i]!;
    if (k.weight < 1) return 'member weight must be at least 1';
    if (!isPublicKey(k.publicKey)) return 'bad public key';
    if (scheme !== undefined && schemeOf(k.publicKey) !== scheme) return `key must be a ${schemeName(scheme)} key`;
    if (i > 0 && compareBytes(a.keys[i - 1]!.publicKey, k.publicKey) >= 0) return 'key members must be ascending and distinct';
    total += k.weight;
  }
  if (total < a.threshold) return 'authority can never be satisfied';
  return null;
}

/** Build a canonical authority from keys (and optionally accounts), each with weight 1. */
export function makeAuthority(publicKeys: Uint8Array[], threshold = 1, accounts: bigint[] = []): Authority {
  return {
    threshold,
    accounts: [...accounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((account) => ({ account, weight: 1 })),
    keys: [...publicKeys].sort(compareBytes).map((publicKey) => ({ publicKey, weight: 1 })),
  };
}

export type AuthorityLookup = (account: bigint) => { active: Authority; owner: Authority } | null;

/** Every key that could count toward `auth`, by address hex, walking member accounts to the depth limit. */
export function collectKeys(auth: Authority, lookup: AuthorityLookup, into: Map<string, Uint8Array>, depth = 0): void {
  for (const k of auth.keys) into.set(toHex(addressOf(k.publicKey)), k.publicKey);
  if (depth >= MAX_AUTHORITY_DEPTH) return;
  for (const m of auth.accounts) {
    const acct = lookup(m.account);
    if (acct) collectKeys(acct.active, lookup, into, depth + 1);
  }
}

/** Do the signing addresses reach the threshold? */
export function authoritySatisfied(auth: Authority, signed: ReadonlySet<string>, lookup: AuthorityLookup, depth = 0): boolean {
  let weight = 0;
  for (const k of auth.keys) if (signed.has(toHex(addressOf(k.publicKey)))) weight += k.weight;
  if (weight >= auth.threshold) return true;
  if (depth >= MAX_AUTHORITY_DEPTH) return false;
  for (const m of auth.accounts) {
    const acct = lookup(m.account);
    if (acct && authoritySatisfied(acct.active, signed, lookup, depth + 1)) {
      weight += m.weight;
      if (weight >= auth.threshold) return true;
    }
  }
  return false;
}
