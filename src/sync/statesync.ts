/**
 * Joining from a snapshot instead of replaying from genesis.
 *
 * The operator supplies a height and header hash they trust. From there the
 * light client verifies forward to the header after the snapshot height,
 * which fixes the app hash every chunk must fold to. Chunks are fetched from
 * several peers at once and verified one by one against the manifest, then
 * loaded into a fresh database whose root must equal that app hash. Headers
 * below the snapshot height are fetched as far back as evidence may reach,
 * each bound to the one above by its hash, so a block carrying evidence of a
 * double sign before the join can still be checked and applied. Then the
 * application store and the chain state at the snapshot height are written
 * in one transaction, and block sync takes over from the next height. See
 * RPC-SYNC-PROOFS.md 4.2.
 */
import { CoreApp } from '../app/core/app.ts';
import { chunkCount, importSnapshot, manifestFromBytes, verifyChunk, verifyManifest, type SnapshotChunk, type SnapshotManifest } from '../app/core/snapshot.ts';
import { bytesEqual, toHex } from '../crypto/hash.ts';
import { schemeName, schemeOf, type SchemeTag } from '../crypto/keys.ts';
import type { Verifier } from '../crypto/verifier.ts';
import type { ObjectDatabase } from '../db/database.ts';
import type { ObjectType } from '../db/index.ts';
import { MAX_HEADERS } from '../p2p/messages.ts';
import { LightClient, type LightProvider, type SignedHeader } from '../light/client.ts';
import type { Network, Peer } from '../p2p/network.ts';
import type { Requester } from '../p2p/request.ts';
import type { BlockStore } from '../store/blockstore.ts';
import type { KvStore } from '../store/kv.ts';
import { bodyMatchesHeader } from '../consensus/validate.ts';
import { headerHash, type Block, type Commit, type Header } from '../types/block.ts';
import { verifyCommit } from '../consensus/validate.ts';

export { bodyMatchesHeader } from '../consensus/validate.ts';

/** The address a set with these priorities picks for a round. */
export function proposerForRound(set: ValidatorSet, round: number): Uint8Array {
  if (round === 0) return set.proposer().address;
  const copy = set.copy();
  copy.incrementProposerPriority(round);
  return copy.proposer().address;
}
import type { ChainState } from '../types/state.ts';
import type { ValidatorSet } from '../types/validator.ts';
import type { Logger } from '../util/log.ts';

export interface StateSyncOptions {
  chainId: string;
  network: Network;
  requester: Requester;
  verifier: Verifier;
  chainStore: BlockStore;
  appKv: KvStore;
  types: ObjectType<any>[];
  retainVersions?: number;
  log: Logger;
  trustHeight: bigint;
  trustHash: Uint8Array;
  /** The chain's signature scheme from genesis; a validator set with keys of another is not this chain's. */
  scheme: SchemeTag;
  /**
   * How old evidence may be, given the imported state (the unbonding period
   * it holds, unless the operator fixed one): headers this far below the
   * snapshot height are fetched so the node can check such evidence.
   */
  evidenceAgeMs: (db: ObjectDatabase) => bigint;
  /** Runs the install's writes to the application and chain stores as one transaction (KvEnv.transaction). */
  transaction?: (fn: () => void) => void;
  peerWaitMs?: number;
  requestTimeoutMs?: number;
  parallel?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns the height joined at, or null when no peer offers a snapshot and replay from genesis is the way. */
export async function stateSync(o: StateSyncOptions): Promise<{ height: bigint } | null> {
  const timeout = o.requestTimeoutMs ?? 10_000;
  const deadline = Date.now() + (o.peerWaitMs ?? 30_000);
  while (o.network.peers.size === 0) {
    if (Date.now() > deadline) {
      o.log('warn', 'state sync: no peers; replaying from genesis');
      return null;
    }
    await sleep(200);
  }
  // A moment for more peers to connect, so snapshots can be cross-checked and chunks spread.
  const settle = Date.now() + 3000;
  while (o.network.peers.size < 2 && Date.now() < settle) await sleep(100);
  const peers = () => [...o.network.peers.values()];
  const ask = async <T>(candidates: Peer[], fn: (p: Peer) => Promise<T | null>): Promise<T | null> => {
    for (const p of candidates) {
      try {
        const r = await fn(p);
        if (r !== null) return r;
      } catch (e) {
        o.log('debug', 'state sync request failed', { peer: p.id.slice(0, 8), err: (e as Error).message });
      }
    }
    return null;
  };

  const provider: LightProvider = {
    latestHeight: async () => peers().reduce((m, p) => (p.height > m ? p.height : m), 0n),
    signedHeader: (height) =>
      ask<SignedHeader>(
        peers().filter((p) => p.height >= height),
        async (p) => {
          const m = await o.requester.request(p, { type: 'headerRequest', height }, 'headerResponse', (m) => m.height === height, timeout);
          return m.header && m.commit ? { header: m.header, commit: m.commit } : null;
        },
      ),
    validatorSet: (hash) =>
      ask<ValidatorSet>(peers(), async (p) => {
        const m = await o.requester.request(p, { type: 'validatorSetRequest', hash }, 'validatorSetResponse', (m) => bytesEqual(m.hash, hash), timeout);
        return m.set;
      }),
  };
  const client = await LightClient.trust({ chainId: o.chainId, provider, verifier: o.verifier }, o.trustHeight, o.trustHash);
  o.log('info', 'state sync: trusted header verified', { height: o.trustHeight });

  // Which snapshot: the highest height at least two peers offer, else the highest offered.
  const offers = new Map<string, bigint[]>();
  for (const p of peers()) {
    try {
      const m = await o.requester.request(p, { type: 'snapshotsRequest' }, 'snapshotsResponse', () => true, timeout);
      offers.set(p.id, [...new Set(m.heights)]); // a height counts once per peer, however often it is listed
    } catch {
      offers.set(p.id, []);
    }
  }
  const tally = new Map<bigint, string[]>();
  for (const [id, heights] of offers) for (const h of heights) tally.set(h, [...(tally.get(h) ?? []), id]);
  const heights = [...tally.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const chosen = heights.find((h) => tally.get(h)!.length >= 2) ?? heights[0];
  if (chosen === undefined) {
    o.log('warn', 'state sync: no peer offers a snapshot; replaying from genesis');
    return null;
  }
  const H = chosen;
  const sources = () => tally.get(H)!.map((id) => o.network.peers.get(id)).filter((p): p is Peer => p !== undefined);

  const verified = await client.verifyToHeight(H + 1n);
  const next = verified.header;
  o.log('info', 'state sync: joining', { height: H, appHash: next.appHash, peers: sources().length });

  // Manifest.
  let manifest: SnapshotManifest | null = null;
  for (const p of sources()) {
    try {
      const m = await o.requester.request(p, { type: 'manifestRequest', height: H }, 'manifestResponse', (m) => m.height === H, timeout);
      if (!m.manifest) continue;
      const candidate = manifestFromBytes(m.manifest);
      const problem = verifyManifest(next.appHash, candidate, o.types);
      if (problem) {
        o.network.score(p.id, 50, `bad snapshot manifest: ${problem}`);
        continue;
      }
      manifest = candidate;
      break;
    } catch (e) {
      o.log('debug', 'manifest request failed', { peer: p.id.slice(0, 8), err: (e as Error).message });
    }
  }
  if (!manifest) throw new Error(`state sync: no valid manifest for height ${H}`);

  // Chunks, in parallel, each verified as it arrives.
  const jobs: { type: number; index: number }[] = [];
  for (const t of manifest.types) for (let i = 0; i < t.chunkHashes.length; i++) jobs.push({ type: t.type, index: i });
  const chunks: SnapshotChunk[] = [];
  const bad = new Set<string>();
  const failures = new Map<string, number>();
  let turn = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs.shift();
      if (!job) return;
      const candidates = sources().filter((p) => !bad.has(p.id));
      if (candidates.length === 0) throw new Error('state sync: every snapshot peer failed');
      const p = candidates[turn++ % candidates.length]!;
      try {
        const m = await o.requester.request(p, { type: 'chunkRequest', height: H, objectType: job.type, index: job.index }, 'chunkResponse', (m) => m.height === H && m.objectType === job.type && m.index === job.index, timeout);
        if (!m.chunk) throw new Error('peer has no such chunk');
        const r = verifyChunk(manifest!, m.chunk);
        if (!('error' in r) && (r.chunk.type !== job.type || r.chunk.index !== job.index)) {
          o.network.score(p.id, 50, 'snapshot chunk for the wrong request');
          bad.add(p.id);
          jobs.push(job);
          continue;
        }
        if ('error' in r) {
          o.network.score(p.id, 50, `bad snapshot chunk: ${r.error}`);
          bad.add(p.id);
          jobs.push(job);
          continue;
        }
        chunks.push(r.chunk);
      } catch (e) {
        // A timeout is not proof of a bad peer; give it a few before giving up on it.
        const n = (failures.get(p.id) ?? 0) + 1;
        failures.set(p.id, n);
        o.log('debug', 'chunk request failed', { peer: p.id.slice(0, 8), attempt: n, err: (e as Error).message });
        if (n >= 3) bad.add(p.id);
        jobs.push(job);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.parallel ?? 4, Math.max(1, sources().length)) }, worker));
  if (chunks.length !== chunkCount(manifest)) throw new Error('state sync: chunk count mismatch');

  const db = importSnapshot(manifest, chunks, o.types, { retainVersions: o.retainVersions });
  o.log('info', 'state sync: state verified', { height: H, chunks: chunks.length });

  // Chain state at H: the block, and the exact sets (with priorities) for H, H+1 and H+2.
  const atH = await provider.signedHeader(H);
  if (!atH || !bytesEqual(headerHash(atH.header), next.lastBlockHash)) throw new Error('state sync: header at the snapshot height does not chain');
  const setsAt = async (height: bigint, expectedHash: Uint8Array): Promise<ValidatorSet> => {
    const set = await ask<ValidatorSet>(sources(), async (p) => {
      const m = await o.requester.request(p, { type: 'validatorsRequest', height }, 'validatorsResponse', (m) => m.height === height, timeout);
      return m.set && bytesEqual(m.set.hash(), expectedHash) ? m.set : null;
    });
    if (!set) throw new Error(`state sync: no validator set for height ${height}`);
    return set;
  };
  const lastValidators = await setsAt(H, atH.header.validatorsHash);
  const validators = await setsAt(H + 1n, next.validatorsHash);
  const nextValidators = await setsAt(H + 2n, next.nextValidatorsHash);
  for (const set of [lastValidators, validators, nextValidators]) {
    for (const v of set.validators) if (schemeOf(v.publicKey) !== o.scheme) throw new Error(`state sync: a validator key is not a ${schemeName(o.scheme)} key; this is not the chain genesis describes`);
  }
  // The block and its commit come from one peer; a commit that does not verify marks that peer and the next one is asked.
  const block = await ask(sources(), async (p) => {
    const m = await o.requester.request(p, { type: 'blockRequest', height: H }, 'blockResponse', (m) => m.height === H, timeout);
    if (!m.block || !m.commit || !bytesEqual(headerHash(m.block.header), headerHash(atH.header))) return null;
    if (!bodyMatchesHeader(m.block) || !bytesEqual(m.commit.blockHash, headerHash(m.block.header))) {
      o.network.score(p.id, 50, 'state sync: block does not match its header');
      return null;
    }
    const commitError = await verifyCommit(o.chainId, lastValidators, headerHash(atH.header), m.commit, o.verifier);
    if (commitError) {
      o.network.score(p.id, 50, `state sync: commit of block ${H}: ${commitError}`);
      return null;
    }
    return { block: m.block, commit: m.commit };
  });
  if (!block) throw new Error(`state sync: no peer served block ${H} with a valid commit`);
  // Priorities are not covered by the set hash; at least the proposers the chain actually used must agree with them.
  // A block decided in round r may have been first proposed in an earlier round (a re-proposal keeps that proposer's name).
  for (const [set, header, commit] of [[lastValidators, atH.header, block.commit], [validators, next, verified.commit]] as [ValidatorSet, Header, Commit][]) {
    let named = false;
    for (let r = 0; r <= commit.round && !named; r++) named = bytesEqual(proposerForRound(set, r), header.proposerAddress);
    if (!named) throw new Error(`state sync: validator set for height ${header.height} names a proposer the chain did not use`);
  }

  // Headers below H, as far back as evidence may reach. A block after H may carry evidence of a double sign at any
  // height within the evidence age, and applying it takes the validator set (named by the header) and the time of that
  // height, which every other node reads from its own blocks. A header is enough, and each is bound to the one above
  // by its hash, so no commit is needed below H. Records are written as they arrive, so an interrupted join resumes
  // from them when they still chain, and a batch off the chain costs its peer 50 points.
  const oldest = atH.header.time - o.evidenceAgeMs(db);
  let expectedHash = atH.header.lastBlockHash;
  let height = H - 1n;
  let lowestHeader: bigint | null = null;
  let fetched = 0;
  outer: while (height >= 1n) {
    const have = o.chainStore.loadHeader(height);
    if (have && bytesEqual(headerHash(have), expectedHash)) {
      if (have.time < oldest) break;
      lowestHeader = height;
      expectedHash = have.lastBlockHash;
      height--;
      continue;
    }
    const top = height;
    let served = false;
    for (const p of sources()) {
      let m;
      try {
        m = await o.requester.request(p, { type: 'headersRequest', height: top, count: MAX_HEADERS }, 'headersResponse', (m) => m.height === top, timeout);
      } catch (e) {
        o.log('debug', 'headers request failed', { peer: p.id.slice(0, 8), err: (e as Error).message });
        continue;
      }
      if (m.headers.length === 0) continue;
      const batch: Header[] = [];
      let done = false;
      for (const hd of m.headers) {
        if (hd.height !== height || hd.chainId !== o.chainId || !bytesEqual(headerHash(hd), expectedHash)) break;
        if (hd.time < oldest) {
          done = true;
          break;
        }
        batch.push(hd);
        expectedHash = hd.lastBlockHash;
        height--;
      }
      if (batch.length === 0 && !done) {
        o.network.score(p.id, 50, `state sync: headers below ${top} are off the chain`);
        continue;
      }
      // A set a header names that the store lacks is fetched by hash, as the block backfill does.
      for (const hd of batch) {
        if (o.chainStore.loadValidatorSet(hd.validatorsHash)) continue;
        const set = await provider.validatorSet(hd.validatorsHash);
        if (!set || !bytesEqual(set.hash(), hd.validatorsHash)) throw new Error(`state sync: no peer serves the validator set of height ${hd.height}`);
        o.chainStore.saveValidatorSet(set);
      }
      o.chainStore.batch(() => {
        for (const hd of batch) o.chainStore.saveHeader(hd);
      });
      fetched += batch.length;
      if (batch.length > 0) lowestHeader = batch[batch.length - 1]!.height;
      served = true;
      if (done) break outer;
      break;
    }
    if (!served) throw new Error(`state sync: no peer serves the headers below ${top} that evidence may still name`);
  }
  if (lowestHeader !== null) o.log('info', 'state sync: headers for the evidence window', { from: lowestHeader, to: H - 1n, fetched });

  const state: ChainState = {
    chainId: o.chainId,
    version: next.version,
    lastHeight: H,
    lastBlockHash: headerHash(atH.header),
    lastBlockTime: atH.header.time,
    appHash: next.appHash,
    lastResultsHash: next.lastResultsHash,
    lastValidators,
    validators,
    nextValidators,
    scheme: o.scheme,
  };
  // The application store and the chain state land in one transaction, so a crash leaves either a complete join or
  // nothing, and a restart simply joins again.
  const install = () => {
    CoreApp.writeImportedState(o.appKv, db, H, next.appHash);
    for (const [h, s] of [[H, lastValidators], [H + 1n, validators], [H + 2n, nextValidators]] as [bigint, ValidatorSet][]) {
      o.chainStore.saveValidatorSet(s);
      o.chainStore.saveValidatorsAt(h, s);
    }
    o.chainStore.saveBlock(block.block, block.commit, null);
    o.chainStore.setLowestHeight(H);
    if (lowestHeader !== null) {
      const known = o.chainStore.lowestHeaderHeight();
      o.chainStore.setLowestHeaderHeight(known !== null && known < lowestHeader ? known : lowestHeader);
    }
    o.chainStore.saveState(state);
  };
  if (o.transaction) o.transaction(install);
  else install();
  o.log('info', 'state sync: done', { height: H, hash: toHex(state.lastBlockHash).slice(0, 12) });
  return { height: H };
}
