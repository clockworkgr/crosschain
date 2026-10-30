import { schemeName, schemeTag, type SchemeName } from '../crypto/keys.ts';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fromHex, toHex } from '../crypto/hash.ts';

/**
 * Genesis is hand-edited, so it is JSON. Nothing in it is hashed directly;
 * the chain id is the identity, and the validator set it describes is hashed
 * through ValidatorSet.hash() once loaded.
 *
 * The application's share can be inline (`appState`) or, when it is too
 * large to hold as one string, in a file of its own (`appStateFile`) that the
 * application reads as a stream.
 */
export interface GenesisValidator {
  publicKey: Uint8Array;
  power: bigint;
  name?: string;
}

export interface Genesis {
  chainId: string;
  /** The signature scheme every validator key, account key and signature on this chain must use; ML-DSA-44 when absent. */
  signatureScheme?: SchemeName;
  /** Unix milliseconds. Block 1 must be later than this. */
  genesisTime: bigint;
  /** The initial validator set, unless the application supplies one from initChain. */
  validators?: GenesisValidator[];
  /** Engine settings: the protocol version and limits that must agree with the application's rules. */
  consensus?: { maxEvidenceAgeMs?: bigint; version?: number };
  /** Opaque to consensus; handed to the application's initChain. Empty when `appStateFile` is set. */
  appState: Uint8Array;
  /** The application genesis in its own file. Relative to the genesis file as written; absolute once loaded. */
  appStateFile?: string;
}

export function genesisToJson(g: Genesis): string {
  return JSON.stringify(
    {
      chainId: g.chainId,
      signatureScheme: g.signatureScheme,
      genesisTime: g.genesisTime.toString(),
      validators: g.validators?.map((v) => ({ publicKey: toHex(v.publicKey), power: v.power.toString(), name: v.name })),
      consensus: g.consensus ? { maxEvidenceAgeMs: g.consensus.maxEvidenceAgeMs?.toString(), version: g.consensus.version } : undefined,
      appState: g.appStateFile ? undefined : new TextDecoder().decode(g.appState),
      appStateFile: g.appStateFile,
    },
    null,
    2,
  );
}

/** `baseDir` is what a relative `appStateFile` is resolved against. */
export function genesisFromJson(s: string, baseDir = '.'): Genesis {
  const j = JSON.parse(s);
  if (typeof j.chainId !== 'string' || j.chainId.length === 0) throw new Error('genesis: bad chainId');
  const appStateFile = typeof j.appStateFile === 'string' ? resolve(baseDir, j.appStateFile) : undefined;
  if (j.signatureScheme !== undefined) schemeTag(String(j.signatureScheme)); // a name the code knows, or a clear error
  return {
    chainId: j.chainId,
    ...(j.signatureScheme !== undefined ? { signatureScheme: schemeName(schemeTag(String(j.signatureScheme))) } : {}),
    genesisTime: BigInt(j.genesisTime),
    validators: Array.isArray(j.validators) ? (j.validators as any[]).map((v) => ({ publicKey: fromHex(v.publicKey), power: BigInt(v.power), name: v.name })) : undefined,
    consensus: j.consensus
      ? { maxEvidenceAgeMs: j.consensus.maxEvidenceAgeMs !== undefined ? BigInt(j.consensus.maxEvidenceAgeMs) : undefined, version: j.consensus.version }
      : undefined,
    appState: appStateFile ? new Uint8Array() : new TextEncoder().encode(typeof j.appState === 'string' ? j.appState : JSON.stringify(j.appState ?? {})),
    ...(appStateFile ? { appStateFile } : {}),
  };
}

export function loadGenesisFile(path: string): Genesis {
  return genesisFromJson(readFileSync(path, 'utf8'), dirname(path));
}
