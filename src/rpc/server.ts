/**
 * JSON-RPC 2.0 over HTTP on node:http, plus Server-Sent Events. The server
 * parses, limits and dispatches; the methods live in methods.ts.
 *
 *   POST /        one request or a batch of at most 20
 *   GET  /events  SSE: ?types=block,tx,account,validatorSet&tx=<hash>&account=<name|id>
 *   GET  /health  height and peer count
 *
 * Exposure defaults to loopback. Every remote address has a token bucket;
 * costly methods spend more. Bodies over the limit are refused before they
 * are read.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CoreApp } from '../app/core/app.ts';
import { toHex } from '../crypto/hash.ts';
import type { Node } from '../node/node.ts';
import { blockHash, txHash } from '../types/block.ts';
import { silentLogger, type Logger } from '../util/log.ts';
import { blockEventJson, RpcEvents, type CommittedEvent } from './events.ts';
import { jsonify } from './json.ts';
import { INVALID_PARAMS, makeMethods, NOT_FOUND, RATE_LIMITED, RpcError, type RpcMethod } from './methods.ts';
import { TxError } from '../app/core/state.ts';
import { HISTORY_KIND_NAMES } from '../app/core/history.ts';
import { idToString } from '../db/id.ts';

export interface RpcLimits {
  bodyBytes: number;
  ratePerSecond: number;
  burst: number;
  costlyCost: number;
  maxStreams: number;
}

export const DEFAULT_RPC_LIMITS: RpcLimits = { bodyBytes: 1024 * 1024, ratePerSecond: 50, burst: 100, costlyCost: 5, maxStreams: 8 };
const EVENT_TYPES = new Set(['block', 'tx', 'account', 'validatorSet']);
/** Idle buckets are forgotten after this, so one-off clients do not accumulate. */
const BUCKET_IDLE_MS = 10 * 60_000;
/** Blocks replayed to a reconnecting event stream at most. */
const MAX_REPLAY = 1000n;
/** Bytes an event stream may have queued unread before it is dropped. */
const MAX_STREAM_BACKLOG = 1024 * 1024;

export interface RpcServerOptions {
  host?: string;
  port?: number;
  log?: Logger;
  limits?: Partial<RpcLimits>;
}

interface Bucket {
  tokens: number;
  last: number;
}

interface Stream {
  res: ServerResponse;
  types: Set<string>;
  tx: string | null;
  account: bigint | null;
  remote: string;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID' };

export class RpcServer {
  private readonly node: Node;
  private readonly log: Logger;
  private readonly limits: RpcLimits;
  private readonly host: string;
  private readonly port: number;
  private readonly server: Server;
  private readonly methods: Record<string, RpcMethod>;
  private readonly events: RpcEvents;
  private readonly buckets = new Map<string, Bucket>();
  private allowCalls = 0;
  private readonly streams = new Set<Stream>();
  private boundPort = 0;

  constructor(node: Node, opts: RpcServerOptions = {}) {
    this.node = node;
    this.log = opts.log ?? silentLogger;
    this.limits = { ...DEFAULT_RPC_LIMITS, ...opts.limits };
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 0;
    this.events = new RpcEvents(node);
    this.methods = makeMethods(node, this.events);
    this.server = createServer((req, res) => {
      req.on('error', () => res.destroy());
      this.handle(req, res).catch((e) => {
        this.log('warn', 'rpc request failed', { err: (e as Error).message });
        if (!res.headersSent) res.writeHead(500, CORS);
        res.end();
      });
    });
    this.events.onCommitted((e) => this.push(e));
  }

  get url(): string {
    return `http://${this.host}:${this.boundPort}`;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.boundPort = (this.server.address() as AddressInfo).port;
        this.log('info', 'rpc listening', { url: this.url });
        resolve(this.boundPort);
      });
    });
  }

  async stop(): Promise<void> {
    for (const s of this.streams) s.res.end();
    this.streams.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private allow(remote: string, cost: number): boolean {
    const now = Date.now();
    if (++this.allowCalls % 1000 === 0) for (const [k, b] of this.buckets) if (now - b.last > BUCKET_IDLE_MS) this.buckets.delete(k);
    let b = this.buckets.get(remote);
    if (!b) this.buckets.set(remote, (b = { tokens: this.limits.burst, last: now }));
    b.tokens = Math.min(this.limits.burst, b.tokens + ((now - b.last) / 1000) * this.limits.ratePerSecond);
    b.last = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? 'unknown';
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify({ height: this.node.height.toString(), peers: this.node.network.peers.size, memory: this.node.memoryLevel }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      this.openStream(req, res, url, remote);
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/') {
      res.writeHead(404, CORS).end();
      return;
    }
    if (!this.allow(remote, 1)) {
      res.writeHead(429, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: RATE_LIMITED, message: 'rate limited' } }));
      return;
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > this.limits.bodyBytes) {
      res.writeHead(413, CORS).end();
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > this.limits.bodyBytes) {
        tooBig = true;
        break;
      }
      chunks.push(c as Buffer);
    }
    if (tooBig) {
      res.writeHead(413, CORS).end();
      req.destroy();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    const batch = Array.isArray(parsed);
    const requests = batch ? (parsed as unknown[]) : [parsed];
    if (requests.length === 0 || requests.length > 20) {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch of 1 to 20 requests' } }));
      return;
    }
    const responses: unknown[] = [];
    for (const r of requests) {
      const answer = await this.one(r, remote);
      if (answer !== undefined) responses.push(answer);
    }
    // Notifications alone leave nothing to answer: no content, as JSON-RPC over HTTP has it.
    if (responses.length === 0) {
      res.writeHead(204, CORS).end();
      return;
    }
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify(batch ? responses : responses[0]));
  }

  /** One request's response, or undefined for a notification (a request without an id), which is carried out but not answered. */
  private async one(r: unknown, remote: string): Promise<unknown> {
    const hasId = !!r && typeof r === 'object' && 'id' in r;
    const rawId = hasId ? (r as { id: unknown }).id : null;
    const id = typeof rawId === 'string' || typeof rawId === 'number' || rawId === null ? rawId : null;
    const reply = (error: { code: number; message: string } | null, result?: unknown) => (error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
    // Something that is not a request at all is answered with a null id, since no id could be read from it.
    if (!r || typeof r !== 'object' || (r as { jsonrpc?: unknown }).jsonrpc !== '2.0' || typeof (r as { method?: unknown }).method !== 'string' || id !== rawId) {
      return reply({ code: -32600, message: 'invalid request' });
    }
    const answer = hasId ? reply : () => undefined;
    const { method, params } = r as { method: string; params?: unknown };
    const m = this.methods[method];
    if (!m) return answer({ code: -32601, message: `unknown method ${method}` });
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) return answer({ code: INVALID_PARAMS, message: 'params must be an object' });
    if (m.costly && this.node.isShedding) return answer({ code: RATE_LIMITED, message: 'node under memory pressure' });
    if (m.costly && !this.allow(remote, this.limits.costlyCost - 1)) return answer({ code: RATE_LIMITED, message: 'rate limited' });
    try {
      return answer(null, await m.fn((params as Record<string, unknown>) ?? {}));
    } catch (e) {
      if (e instanceof RpcError) return answer({ code: e.code, message: e.message });
      if (e instanceof TxError) return answer({ code: NOT_FOUND, message: e.message });
      const msg = (e as Error).message ?? String(e);
      this.log('warn', 'rpc method failed', { method, err: msg });
      return answer({ code: INVALID_PARAMS, message: msg });
    }
  }

  // ---- events ----

  private openStream(req: IncomingMessage, res: ServerResponse, url: URL, remote: string): void {
    let streams = 0;
    for (const s of this.streams) if (s.remote === remote) streams++;
    if (streams >= this.limits.maxStreams) {
      res.writeHead(429, CORS).end();
      return;
    }
    // A stream is memory held for the client; none are opened while the node sheds load.
    if (this.node.isShedding) {
      res.writeHead(503, CORS).end();
      return;
    }
    const types = new Set((url.searchParams.get('types') ?? 'block').split(',').map((t) => t.trim()));
    for (const t of types) {
      if (!EVENT_TYPES.has(t)) {
        res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' }).end(`unknown event type ${t}`);
        return;
      }
    }
    const tx = url.searchParams.get('tx');
    let account: bigint | null = null;
    const accountParam = url.searchParams.get('account');
    if (accountParam) {
      if (/^\d+\.\d+$/.test(accountParam)) account = BigInt(accountParam.split('.')[0]!) * 2n ** 48n + BigInt(accountParam.split('.')[1]!);
      else if (this.node.app instanceof CoreApp) account = this.node.app.accountByName(accountParam)?.id ?? null;
      if (account === null) {
        res.writeHead(404, CORS).end();
        return;
      }
    }
    // Replaying the blocks after the one the client last saw costs as much as a
    // costly call. Refuse it up front rather than open a stream with a gap in it.
    const last = String(req.headers['last-event-id'] ?? '');
    const replayFrom = last !== '' && types.has('block') && /^\d+$/.test(last) ? BigInt(last) + 1n : null;
    if (replayFrom !== null && !this.allow(remote, this.limits.costlyCost)) {
      res.writeHead(429, CORS).end();
      return;
    }
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const stream: Stream = { res, types, tx, account, remote };
    this.streams.add(stream);
    req.on('close', () => this.streams.delete(stream));
    if (replayFrom !== null) {
      const oldest = this.node.height - MAX_REPLAY + 1n;
      const start = replayFrom < oldest ? oldest : replayFrom;
      for (let h = start; h <= this.node.height; h++) {
        const stored = this.node.store.loadBlock(h);
        if (!stored || res.writableLength > 1024 * 1024) break;
        this.send(stream, 'block', h, { height: h.toString(), hash: toHex(blockHash(stored.block)), time: stored.block.header.time.toString(), txs: stored.block.txs.length, appHash: toHex(stored.block.header.appHash), proposer: toHex(stored.block.header.proposerAddress) });
      }
    }
  }

  private send(s: Stream, event: string, id: bigint, data: unknown): void {
    if (!this.streams.has(s)) return;
    // A consumer that stops reading would otherwise hold every event since; it gets cut off and may resume with Last-Event-ID.
    if (s.res.writableLength > MAX_STREAM_BACKLOG) {
      this.streams.delete(s);
      s.res.end();
      return;
    }
    s.res.write(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private push(e: CommittedEvent): void {
    const h = e.block.header.height;
    for (const s of this.streams) {
      if (s.types.has('block')) this.send(s, 'block', h, blockEventJson(e));
      if (s.types.has('tx')) {
        e.block.txs.forEach((tx, i) => {
          const hash = toHex(txHash(tx));
          if (s.tx && s.tx !== hash) return;
          const r = e.results[i]!;
          this.send(s, 'tx', h, { hash, height: h.toString(), index: i, ok: r.ok, error: r.error ?? '' });
        });
      }
      if (s.types.has('account') && s.account !== null) {
        for (const [account, entry] of e.history) {
          if (account !== s.account) continue;
          this.send(s, 'account', h, { account: idToString(account), height: entry.height.toString(), kind: HISTORY_KIND_NAMES[entry.kind], txHash: entry.txHash ? toHex(entry.txHash) : null, position: entry.position === 0xffffffff ? null : entry.position, opIndex: entry.opIndex, data: toHex(entry.data) });
        }
      }
      if (s.types.has('validatorSet') && e.updates.length > 0) this.send(s, 'validatorSet', h, { height: h.toString(), updates: jsonify(e.updates) });
    }
  }
}
