/**
 * The JSON-RPC methods, each a function of a parameter object. They read the
 * node and its application; the server (server.ts) only parses, limits and
 * dispatches. See RPC-SYNC-PROOFS.md section 3.3 for the contract.
 */
import { schemeName } from '../crypto/keys.ts';
import { CoreApp } from '../app/core/app.ts';
import { decodeVirtualData, HISTORY_KIND_NAMES, HistoryKind } from '../app/core/history.ts';
import { delegationOf, powerOf, precisionOf, selfBondOf, tokensForShares, validatorByOperator } from '../app/core/staking.ts';
import { decodeOperation, decodeTransaction } from '../app/core/tx.ts';
import { AccountType, AssetType, BalanceType, CORE_TYPES, DelegationType, ProposalType, UnbondingType, ValidatorType } from '../app/core/types.ts';
import { Reader } from '../codec/reader.ts';
import { toHex } from '../crypto/hash.ts';
import { typeOf, type ObjectId } from '../db/id.ts';
import { key } from '../db/keys.ts';
import { keyProofToBytes, proofToBytes } from '../db/proof.ts';
import type { Node } from '../node/node.ts';
import { blockHash, txHash } from '../types/block.ts';
import { genesisToJson } from '../types/genesis.ts';
import type { RpcEvents } from './events.ts';
import { jsonify, parseBigint, parseHex, parseId, txQueryToJson, validatorSetToJson } from './json.ts';

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const NOT_FOUND = -32001;
export const CHECK_FAILED = -32002;
export const TIMEOUT = -32003;
export const RATE_LIMITED = -32004;
export const INVALID_PARAMS = -32602;

export interface RpcMethod {
  /** Costly calls spend more of the rate budget. */
  costly?: boolean;
  fn(params: Record<string, unknown>): Promise<unknown>;
}

/** The longest a commit-mode broadcast may hold a connection open. */
const MAX_COMMIT_WAIT_MS = 120_000;

const STATUS_NAMES = ['candidate', 'jailed', 'tombstoned'];

function coreApp(node: Node): CoreApp {
  if (!(node.app instanceof CoreApp)) throw new RpcError(NOT_FOUND, 'this node does not run the core application');
  return node.app;
}

function heightParam(node: Node, p: Record<string, unknown>, name = 'height'): bigint {
  if (p[name] === undefined) return node.height;
  return parseBigint(p[name], name);
}

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

function str(p: Record<string, unknown>, name: string): string {
  if (typeof p[name] !== 'string') throw new RpcError(INVALID_PARAMS, `${name} must be a string`);
  return p[name];
}

function typeByName(name: string) {
  const t = CORE_TYPES.find((t) => t.name === name);
  if (!t) throw new RpcError(INVALID_PARAMS, `unknown type ${name}`);
  return t;
}

/** An account by name or by id. */
function accountRef(app: CoreApp, ref: unknown): ObjectId {
  if (typeof ref !== 'string') throw new RpcError(INVALID_PARAMS, 'account must be a name or an id');
  if (/^\d+\.\d+$/.test(ref)) return parseId(ref);
  const a = app.accountByName(ref);
  if (!a) throw new RpcError(NOT_FOUND, `no account ${ref}`);
  return a.id;
}

function validatorRef(app: CoreApp, ref: unknown): ObjectId {
  if (typeof ref !== 'string') throw new RpcError(INVALID_PARAMS, 'validator must be an operator name or an id');
  if (/^\d+\.\d+$/.test(ref)) return parseId(ref);
  const v = validatorByOperator(app.db, accountRef(app, ref));
  if (!v) throw new RpcError(NOT_FOUND, `${ref} runs no validator`);
  return v.id;
}

function decodeHistoryEntry(e: { kind: number; data: Uint8Array }): unknown {
  if (e.kind === HistoryKind.operation) return jsonify(decodeOperation(new Reader(e.data)));
  return jsonify(decodeVirtualData(e.kind as any, e.data));
}

export function makeMethods(node: Node, events: RpcEvents): Record<string, RpcMethod> {
  const stored = (height: bigint) => {
    const s = node.store.loadBlock(height);
    if (!s) throw new RpcError(NOT_FOUND, `no block ${height}`);
    return s;
  };

  return {
    status: {
      async fn() {
        const state = node.executor.state;
        const last = node.store.loadBlock(state.lastHeight);
        let best = state.lastHeight;
        for (const p of node.network.peers.values()) if (p.height > best) best = p.height;
        return {
          chainId: state.chainId,
          version: state.version,
          signatureScheme: schemeName(state.scheme),
          latestHeight: state.lastHeight.toString(),
          latestHash: last ? toHex(blockHash(last.block)) : null,
          latestTime: state.lastBlockTime.toString(),
          appHash: toHex(state.appHash),
          catchingUp: best > state.lastHeight + 1n,
          lowestHeight: node.store.lowestHeight().toString(),
          joinedAt: node.joinedAt === null ? null : node.joinedAt.toString(),
          peers: node.network.peers.size,
          validatorAddress: node.privValidator ? toHex(node.privValidator.address) : null,
          memory: { level: node.memoryLevel, shedding: node.isShedding, ...node.memoryGuard.stats, database: node.app instanceof CoreApp ? jsonify(node.app.db.memory()) : null },
          gc: node.gcScheduler.stats(),
          rpcVersion: 1,
        };
      },
    },
    genesis: {
      async fn() {
        const j = JSON.parse(genesisToJson(node.genesis));
        delete j.appStateFile; // a local path; an application genesis in a file is not served
        return j;
      },
    },
    header: {
      fn: async (p) => {
        const h = heightParam(node, p);
        // Below its lowest block a state-synced node may still hold the header alone; a light client walking back needs it.
        const header = node.store.loadBlock(h)?.block.header ?? node.store.loadHeader(h);
        if (!header) throw new RpcError(NOT_FOUND, `no block ${h}`);
        return jsonify(header);
      },
    },
    block: {
      costly: true, // a full block of transactions is as much work to serve as any query
      async fn(p) {
        const { block, commit } = stored(heightParam(node, p));
        return { header: jsonify(block.header), txs: block.txs.map(toHex), lastCommit: block.lastCommit ? jsonify(block.lastCommit) : null, evidence: jsonify(block.evidence), commit: jsonify(commit) };
      },
    },
    commit: { fn: async (p) => jsonify(stored(heightParam(node, p)).commit) },
    validators: {
      async fn(p) {
        const h = heightParam(node, p);
        const set = node.executor.validatorSetAtHeight(h);
        if (!set) throw new RpcError(NOT_FOUND, `no validator set for height ${h}`);
        return { height: h.toString(), ...(validatorSetToJson(set) as object) };
      },
    },
    validatorSet: {
      async fn(p) {
        const set = node.store.loadValidatorSet(parseHex(p.hash, 'hash'));
        if (!set) throw new RpcError(NOT_FOUND, 'no validator set with that hash');
        return validatorSetToJson(set);
      },
    },
    object: {
      costly: true,
      async fn(p) {
        const app = coreApp(node);
        const id = parseId(p.id);
        const type = CORE_TYPES.find((t) => t.id === typeOf(id));
        if (!type) throw new RpcError(INVALID_PARAMS, 'unknown object type');
        const height = p.height === undefined ? app.lastHeight : parseBigint(p.height, 'height');
        const obj = height === app.lastHeight ? app.db.getCommitted(type, id) : app.db.getAt(type, id, Number(height));
        const out: Record<string, unknown> = { type: type.name, height: height.toString(), object: obj ? jsonify(obj) : null };
        if (bool(p, 'prove')) out.proof = toHex(proofToBytes(app.proofAt(id, height)));
        return out;
      },
    },
    key: {
      costly: true,
      async fn(p) {
        const app = coreApp(node);
        const type = typeByName(str(p, 'type'));
        const index = str(p, 'index');
        const k = parseHex(p.key, 'key');
        const height = p.height === undefined ? app.lastHeight : parseBigint(p.height, 'height');
        const live = app.db.lookup(type, index, k);
        const out: Record<string, unknown> = { height: height.toString(), id: live ? jsonify(live.id, 'id') : null };
        if (bool(p, 'prove')) out.proof = toHex(keyProofToBytes(app.db.proveKeyAt(type, index, k, Number(height))));
        return out;
      },
    },
    account: {
      costly: true,
      async fn(p) {
        const app = coreApp(node);
        const name = str(p, 'name');
        const a = app.accountByName(name);
        const height = p.height === undefined ? app.lastHeight : parseBigint(p.height, 'height');
        const out: Record<string, unknown> = { height: height.toString(), account: a ? jsonify(a) : null };
        if (a) {
          out.balances = app.db
            .range(BalanceType, 'byOwnerAsset', key((k) => k.id(a.id)))
            .map((live) => app.db.getCommitted(BalanceType, live.id))
            .filter((b): b is NonNullable<typeof b> => b !== null)
            .map((b) => {
              const asset = app.db.getCommitted(AssetType, b.asset);
              return { asset: asset?.symbol, assetId: jsonify(b.asset, 'asset'), precision: asset?.precision ?? 0, amount: b.amount.toString() };
            });
          const v = validatorByOperator(app.db, a.id);
          out.validator = v && app.db.getCommitted(ValidatorType, v.id) ? jsonify(v.id, 'id') : null;
          out.history = app.accountHistory(a.id, 0n, 0).total.toString();
        }
        if (bool(p, 'prove')) out.proof = toHex(keyProofToBytes(app.proveAccountName(name, height)));
        return out;
      },
    },
    validator: {
      async fn(p) {
        const app = coreApp(node);
        const v = app.db.getCommitted(ValidatorType, validatorRef(app, p.operator ?? p.id));
        if (!v) throw new RpcError(NOT_FOUND, 'no such validator');
        const active = app.dynamic().active.find((a) => a.validator === v.id);
        // Every field comes from the committed view: the live indices only say where to look.
        const self = delegationOf(app.db, v.operator, v.id);
        const selfCommitted = self ? app.db.getCommitted(DelegationType, self.id) : null;
        let delegators = 0;
        for (const d of app.db.scan(DelegationType, 'byValidator', key((k) => k.id(v.id)))) if (app.db.getCommitted(DelegationType, d.id)) delegators++;
        return {
          ...(jsonify(v) as object),
          status: STATUS_NAMES[v.status],
          active: active !== undefined,
          power: (active?.power ?? powerOf(v.tokens, precisionOf(app.db))).toString(),
          selfBond: tokensForShares(v, selfCommitted?.shares ?? 0n).toString(),
          delegators,
          operatorName: app.account(v.operator)?.name,
        };
      },
    },
    delegation: {
      costly: true,
      async fn(p) {
        const app = coreApp(node);
        const delegator = accountRef(app, p.delegator);
        const validator = validatorRef(app, p.validator);
        const v = app.db.getCommitted(ValidatorType, validator);
        if (!v) throw new RpcError(NOT_FOUND, 'no such validator');
        const live = delegationOf(app.db, delegator, validator);
        const d = live ? app.db.getCommitted(DelegationType, live.id) : null;
        const height = p.height === undefined ? app.lastHeight : parseBigint(p.height, 'height');
        const out: Record<string, unknown> = {
          height: height.toString(),
          delegation: d ? { ...(jsonify(d) as object), tokens: tokensForShares(v, d.shares).toString() } : null,
          unbonding: app.db
            .range(UnbondingType, 'byDelegatorValidator', key((k) => k.id(delegator).id(validator)))
            .map((live) => app.db.getCommitted(UnbondingType, live.id))
            .filter((u): u is NonNullable<typeof u> => u !== null)
            .map((u) => jsonify(u)),
        };
        if (bool(p, 'prove')) out.proof = toHex(keyProofToBytes(app.proveDelegation(delegator, validator, height)));
        return out;
      },
    },
    balance: {
      async fn(p) {
        const app = coreApp(node);
        const account = accountRef(app, p.account);
        const asset = p.asset === undefined ? app.coreAsset : parseId(p.asset);
        return { account: jsonify(account, 'id'), asset: jsonify(asset, 'asset'), amount: app.balance(account, asset).toString() };
      },
    },
    accountHistory: {
      costly: true,
      async fn(p) {
        const app = coreApp(node);
        const account = accountRef(app, p.account);
        const from = p.from === undefined ? 0n : parseBigint(p.from, 'from');
        const limit = Math.min(num(p, 'limit', 20), 100);
        const r = app.accountHistory(account, from, limit, bool(p, 'reverse'));
        return {
          account: jsonify(account, 'id'),
          total: r.total.toString(),
          entries: r.entries.map((e) => ({
            sequence: e.sequence.toString(),
            height: e.height.toString(),
            position: e.position === 0xffffffff ? null : e.position,
            opIndex: e.opIndex,
            kind: HISTORY_KIND_NAMES[e.kind],
            txHash: e.txHash ? toHex(e.txHash) : null,
            data: decodeHistoryEntry(e),
          })),
        };
      },
    },
    tx: {
      costly: true,
      async fn(p) {
        const hash = parseHex(p.hash, 'hash');
        const loc = node.store.txLocation(hash);
        if (!loc) throw new RpcError(NOT_FOUND, 'unknown transaction');
        const { block } = stored(loc.height);
        const raw = block.txs[loc.index]!;
        let decoded: unknown = null;
        try {
          decoded = jsonify(decodeTransaction(raw));
        } catch {
          decoded = null;
        }
        const out: Record<string, unknown> = { hash: toHex(hash), height: loc.height.toString(), index: loc.index, ok: loc.ok, error: loc.error, tx: toHex(raw), decoded };
        if (bool(p, 'prove')) {
          const q = node.queryTx(hash);
          out.proof = q ? txQueryToJson(q) : null;
        }
        return out;
      },
    },
    broadcastTx: {
      costly: true,
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
    accounts: {
      costly: true,
      async fn(p) {
        const app = coreApp(node);
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
      },
    },
    /** The live chain parameters: what fees cost and how staking works. What a wallet reads before pricing a transaction. */
    parameters: {
      async fn() {
        const app = coreApp(node);
        const g = app.global();
        const core = app.db.getCommitted(AssetType, g.coreAsset)!;
        return {
          height: app.lastHeight.toString(),
          coreAsset: { id: jsonify(g.coreAsset, 'id'), symbol: core.symbol, precision: core.precision },
          maxTxExpirationMs: g.maxTxExpirationMs.toString(),
          fees: jsonify(g.fees),
          staking: jsonify(g.staking),
        };
      },
    },
    /** Open parameter proposals, soonest to expire first, each with the full parameters it would adopt. */
    proposals: {
      costly: true,
      async fn() {
        const app = coreApp(node);
        return app.db
          .range(ProposalType, 'byExpiration', new Uint8Array(0))
          .map((live) => app.db.getCommitted(ProposalType, live.id))
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .map((p) => jsonify(p));
      },
    },
    mempool: {
      async fn() {
        const txs = node.mempool.list();
        return { count: txs.length, bytes: txs.reduce((s, t) => s + t.length, 0), hashes: txs.slice(0, 100).map((t) => toHex(txHash(t))) };
      },
    },
    peers: {
      async fn() {
        return [...node.network.peers.values()].map((p) => ({ id: p.id, addr: p.listenAddr || p.remoteAddr, direction: p.direction, height: p.height.toString(), latencyMs: p.latencyMs }));
      },
    },
    snapshots: { fn: async () => [] },
  };
}
