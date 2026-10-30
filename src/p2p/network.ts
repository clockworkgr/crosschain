/**
 * Peer management in the style of Graphene (BitShares): a flat set of
 * peers, one stream each, no channels. After the handshake a peer is a peer;
 * which side dialed is remembered only for slot accounting, so that inbound
 * connections can never fill every slot and eclipse the node.
 *
 * Handshake (mutual, nonce-bound, one and a half round trips, no key
 * exchange because nothing is encrypted):
 *
 *   A -> B   hello_A  (chain id, node key, nonce, listen address, height)
 *   B -> A   helloAck (hello_B, sig_B over hello_A || hello_B)
 *   A -> B   auth     (sig_A over hello_A || hello_B)
 *
 * A is a peer the moment it sends auth, and may talk at once; B is still
 * verifying that signature. Frames that arrive at B in that window are held
 * and delivered as soon as the peer is established, so an early request is
 * not lost.
 *
 * Both nonces sit inside the signed bytes, so a signature can never be
 * replayed in another session. Node identity is sha256 of the node's public
 * key, which is of the chain's signature scheme.
 */
import { randomBytes } from 'node:crypto';
import { bytesEqual, toHex } from '../crypto/hash.ts';
import { addressOf, isPublicKey, sign, signContext, type KeyPair } from '../crypto/keys.ts';
import type { Verifier } from '../crypto/verifier.ts';
import type { Logger } from '../util/log.ts';
import { NONCE_SIZE, RejectCode, decodeMessage, encodeMessage, handshakeSignBytes, type Hello, type Message, type MessageType } from './messages.ts';
import type { PeerDb } from './peerdb.ts';
import type { Conn, Transport } from './transport.ts';

export interface NetworkConfig {
  chainId: string;
  nodeKey: KeyPair;
  transport: Transport;
  /** Address to bind, or null to accept no inbound connections. */
  listenAddr: string | null;
  /** Address told to peers; defaults to listenAddr. */
  advertiseAddr?: string;
  peerDb: PeerDb;
  verifier: Verifier;
  getHeight: () => bigint;
  log: Logger;
  desiredOutbound?: number;
  maxInbound?: number;
  connectIntervalMs?: number;
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  userAgent?: string;
}

export interface Peer {
  readonly id: string;
  readonly publicKey: Uint8Array;
  readonly remoteAddr: string;
  readonly listenAddr: string;
  readonly direction: 'in' | 'out';
  height: bigint;
  latencyMs: number;
  lastRecv: number;
  readonly connectedAt: number;
  send(m: Message): void;
  close(): void;
}

type Handler<T extends MessageType> = (peer: Peer, msg: Extract<Message, { type: T }>) => void;

class HandshakeError extends Error {}

/** A duplicate connection older than this is assumed to belong to a peer that restarted. */
const STALE_DUPLICATE_MS = 2000;
export const BAN_THRESHOLD = 100;
export const BAN_MS = 3_600_000;

/** Frames received between the last handshake message and the peer's establishment, by connection. */
const heldFrames = new WeakMap<Conn, Uint8Array[]>();
const MAX_HELD_FRAMES = 64;

function nextMessage(conn: Conn, timeoutMs: number): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new HandshakeError('handshake timeout'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      // Until the next handshake step or establishment takes over, keep what the other side sends.
      conn.onFrame((frame) => {
        const held = heldFrames.get(conn) ?? [];
        if (held.length < MAX_HELD_FRAMES) held.push(frame);
        heldFrames.set(conn, held);
      });
    };
    conn.onClose(() => {
      cleanup();
      reject(new HandshakeError('closed during handshake'));
    });
    const deliver = (frame: Uint8Array) => {
      cleanup();
      try {
        resolve(decodeMessage(frame));
      } catch (e) {
        reject(new HandshakeError(`bad handshake message: ${(e as Error).message}`));
      }
    };
    // A step may already have arrived while the previous one was being verified.
    const early = heldFrames.get(conn);
    if (early && early.length > 0) {
      const first = early.shift()!;
      if (early.length === 0) heldFrames.delete(conn);
      deliver(first);
      return;
    }
    conn.onFrame(deliver);
  });
}

export class Network {
  readonly id: string;
  readonly peers = new Map<string, Peer>();
  /** Misbehaviour points per peer id, decaying one point a minute; a ban at the threshold. */
  private readonly scores = new Map<string, { points: number; last: number }>();
  private readonly bannedIds = new Map<string, number>();
  private readonly cfg: Required<Omit<NetworkConfig, 'advertiseAddr' | 'listenAddr'>> & { listenAddr: string | null; advertiseAddr: string };
  private readonly handlers = new Map<MessageType, Handler<any>[]>();
  private readonly peerListeners: ((p: Peer) => void)[] = [];
  private readonly peerGoneListeners: ((p: Peer) => void)[] = [];
  private readonly dialing = new Set<string>();
  private readonly handshaking = new Set<Conn>();
  private readonly p2pCtx: Uint8Array;
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(cfg: NetworkConfig) {
    this.cfg = {
      desiredOutbound: 8,
      maxInbound: 32,
      connectIntervalMs: 1000,
      pingIntervalMs: 10_000,
      idleTimeoutMs: 45_000,
      handshakeTimeoutMs: 10_000,
      userAgent: 'crosschain/0.1',
      ...cfg,
      advertiseAddr: cfg.advertiseAddr ?? cfg.listenAddr ?? '',
    };
    this.id = toHex(addressOf(cfg.nodeKey.publicKey));
    this.p2pCtx = signContext(cfg.chainId, 'p2p');
  }

  // ----------------------------------------------------------------- public

  on<T extends MessageType>(type: T, handler: Handler<T>): void {
    let list = this.handlers.get(type);
    if (!list) this.handlers.set(type, (list = []));
    list.push(handler);
  }

  onPeer(fn: (p: Peer) => void): void {
    this.peerListeners.push(fn);
  }

  onPeerGone(fn: (p: Peer) => void): void {
    this.peerGoneListeners.push(fn);
  }

  async start(): Promise<void> {
    this.running = true;
    if (this.cfg.listenAddr) {
      await this.cfg.transport.listen(this.cfg.listenAddr, (conn) => void this.acceptInbound(conn));
      this.cfg.log('info', 'listening', { addr: this.cfg.listenAddr });
    }
    this.timers.push(setInterval(() => this.connectLoop(), this.cfg.connectIntervalMs));
    this.timers.push(setInterval(() => this.keepaliveLoop(), this.cfg.pingIntervalMs));
    for (const t of this.timers) t.unref();
    this.connectLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const c of [...this.handshaking]) c.close();
    this.handshaking.clear();
    for (const p of [...this.peers.values()]) p.close();
    await this.cfg.transport.close();
  }

  get outboundCount(): number {
    let n = 0;
    for (const p of this.peers.values()) if (p.direction === 'out') n++;
    return n;
  }

  get inboundCount(): number {
    return this.peers.size - this.outboundCount;
  }

  broadcast(m: Message, exceptPeerId: string | null = null): void {
    for (const p of this.peers.values()) if (p.id !== exceptPeerId) p.send(m);
  }

  /** Dial and handshake. Resolves with the peer, or rejects. */
  async connect(addr: string): Promise<Peer> {
    if (this.dialing.has(addr)) throw new Error('already dialing');
    this.dialing.add(addr);
    this.cfg.peerDb.markAttempt(addr);
    let conn: Conn | null = null;
    try {
      if (!this.running) throw new Error('network stopped');
      conn = await this.cfg.transport.dial(addr);
      this.handshaking.add(conn);
      const peer = await this.handshakeOutbound(conn, addr);
      this.cfg.peerDb.markSuccess(addr);
      return peer;
    } catch (e) {
      this.cfg.peerDb.markFailure(addr);
      this.cfg.log('debug', 'dial failed', { addr, err: (e as Error).message });
      conn?.close(); // a connection that did not become a peer is not kept
      throw e;
    } finally {
      this.dialing.delete(addr);
      if (conn) this.handshaking.delete(conn);
    }
  }

  // ------------------------------------------------------------- handshake

  private makeHello(): Hello {
    return {
      chainId: this.cfg.chainId,
      publicKey: this.cfg.nodeKey.publicKey,
      nonce: new Uint8Array(randomBytes(NONCE_SIZE)),
      listenAddr: this.cfg.advertiseAddr,
      height: this.cfg.getHeight(),
      userAgent: this.cfg.userAgent,
    };
  }

  /** Checks common to both directions. Returns a reject code or null. */
  private vetHello(h: Hello): { code: number; reason: string } | null {
    if (h.chainId !== this.cfg.chainId) return { code: RejectCode.WrongChain, reason: 'wrong chain id' };
    if (!isPublicKey(h.publicKey)) return { code: RejectCode.Invalid, reason: 'bad public key' };
    if (bytesEqual(h.publicKey, this.cfg.nodeKey.publicKey)) return { code: RejectCode.Self, reason: 'connected to self' };
    const until = this.bannedIds.get(toHex(addressOf(h.publicKey)));
    if (until !== undefined && until > Date.now()) return { code: RejectCode.NotAccepting, reason: 'banned' };
    return null;
  }

  private reject(conn: Conn, code: number, reason: string): void {
    conn.send(encodeMessage({ type: 'reject', code, reason }));
    setTimeout(() => conn.close(), 50);
  }

  private async handshakeOutbound(conn: Conn, addr: string): Promise<Peer> {
    const helloA = this.makeHello();
    conn.send(encodeMessage({ type: 'hello', hello: helloA }));
    const m = await nextMessage(conn, this.cfg.handshakeTimeoutMs);
    if (m.type === 'reject') {
      conn.close();
      throw new HandshakeError(`rejected: ${m.reason}`);
    }
    if (m.type !== 'helloAck') {
      conn.close();
      throw new HandshakeError(`expected helloAck, got ${m.type}`);
    }
    const bad = this.vetHello(m.hello);
    if (bad) {
      this.reject(conn, bad.code, bad.reason);
      throw new HandshakeError(bad.reason);
    }
    const signBytes = handshakeSignBytes(helloA, m.hello);
    const ok = await this.cfg.verifier.verifyOne({ sig: m.signature, msg: signBytes, publicKey: m.hello.publicKey, context: this.p2pCtx });
    if (!ok) {
      this.reject(conn, RejectCode.Invalid, 'bad handshake signature');
      throw new HandshakeError('bad handshake signature');
    }
    conn.send(encodeMessage({ type: 'auth', signature: sign(signBytes, this.cfg.nodeKey.secretKey, this.p2pCtx) }));
    return this.establish(conn, m.hello, 'out', addr);
  }

  private pendingInbound = 0;

  private async acceptInbound(conn: Conn): Promise<void> {
    if (!this.running) {
      conn.close();
      return;
    }
    if (this.pendingInbound >= this.cfg.maxInbound) {
      conn.close(); // more handshakes in flight than peers allowed: not worth even reading
      return;
    }
    this.pendingInbound++;
    this.handshaking.add(conn);
    try {
      await this.handshakeInbound(conn);
    } catch (e) {
      this.cfg.log('debug', 'inbound handshake failed', { from: conn.remoteAddr, err: (e as Error).message });
      conn.close();
    } finally {
      this.pendingInbound--;
      this.handshaking.delete(conn);
    }
  }

  private async handshakeInbound(conn: Conn): Promise<Peer> {
    const m = await nextMessage(conn, this.cfg.handshakeTimeoutMs);
    if (m.type !== 'hello') throw new HandshakeError(`expected hello, got ${m.type}`);
    const helloA = m.hello;
    const bad = this.vetHello(helloA);
    if (bad) {
      this.reject(conn, bad.code, bad.reason);
      throw new HandshakeError(bad.reason);
    }
    // Handshakes in progress hold slots too, or a flood of half-done handshakes passes the limit.
    if (this.inboundCount + this.pendingInbound - 1 >= this.cfg.maxInbound) {
      this.reject(conn, RejectCode.NotAccepting, 'inbound slots full');
      throw new HandshakeError('inbound slots full');
    }
    const helloB = this.makeHello();
    const signBytes = handshakeSignBytes(helloA, helloB);
    conn.send(encodeMessage({ type: 'helloAck', hello: helloB, signature: sign(signBytes, this.cfg.nodeKey.secretKey, this.p2pCtx) }));
    const a = await nextMessage(conn, this.cfg.handshakeTimeoutMs);
    if (a.type === 'reject') throw new HandshakeError(`rejected: ${a.reason}`);
    if (a.type !== 'auth') throw new HandshakeError(`expected auth, got ${a.type}`);
    const ok = await this.cfg.verifier.verifyOne({ sig: a.signature, msg: signBytes, publicKey: helloA.publicKey, context: this.p2pCtx });
    if (!ok) {
      this.reject(conn, RejectCode.Invalid, 'bad handshake signature');
      throw new HandshakeError('bad handshake signature');
    }
    return this.establish(conn, helloA, 'in', null);
  }

  // ------------------------------------------------------------ peer setup

  private establish(conn: Conn, their: Hello, direction: 'in' | 'out', dialedAddr: string | null): Peer {
    if (!this.running) {
      conn.close();
      throw new HandshakeError('network stopped');
    }
    const id = toHex(addressOf(their.publicKey));
    const network = this;
    const peer: Peer = {
      id,
      publicKey: their.publicKey,
      remoteAddr: conn.remoteAddr,
      listenAddr: their.listenAddr,
      direction,
      height: their.height,
      latencyMs: 0,
      lastRecv: Date.now(),
      connectedAt: Date.now(),
      send(m: Message) {
        if (!conn.closed) conn.send(encodeMessage(m));
      },
      close() {
        conn.close();
        network.removePeer(peer);
      },
    };

    // Two connections to the same node. Either both sides dialed at once,
    // in which case both are young and we keep the one initiated by the
    // lower node id (both sides compute the same answer), or the old one is
    // stale (the peer restarted and its old socket has not timed out yet),
    // in which case the new one wins.
    const existing = this.peers.get(id);
    if (existing) {
      const stale = Date.now() - existing.connectedAt > STALE_DUPLICATE_MS;
      const iAmLower = this.id < id;
      const newIsCanonical = (direction === 'out') === iAmLower && existing.direction !== direction;
      if (!stale && !newIsCanonical) {
        this.cfg.log('debug', 'dropping duplicate connection', { peer: id.slice(0, 8), direction });
        conn.close();
        throw new HandshakeError('duplicate connection');
      }
      this.cfg.log('debug', 'replacing duplicate connection', { peer: id.slice(0, 8), direction, stale });
      existing.close();
    }

    this.peers.set(id, peer);
    conn.onFrame((frame) => this.onFrame(peer, frame));
    conn.onClose(() => this.removePeer(peer));
    if (their.listenAddr) this.cfg.peerDb.add(their.listenAddr);
    if (dialedAddr) this.cfg.peerDb.markSuccess(dialedAddr);
    this.cfg.log('info', 'peer connected', { peer: id.slice(0, 8), direction, addr: their.listenAddr || conn.remoteAddr, height: their.height });

    peer.send({ type: 'addrRequest' });
    peer.send({ type: 'status', height: this.cfg.getHeight() });
    for (const fn of this.peerListeners) fn(peer);
    const held = heldFrames.get(conn);
    heldFrames.delete(conn);
    if (held) for (const frame of held) this.onFrame(peer, frame);
    return peer;
  }

  private removePeer(peer: Peer): void {
    if (this.peers.get(peer.id) !== peer) return;
    this.peers.delete(peer.id);
    this.cfg.log('info', 'peer disconnected', { peer: peer.id.slice(0, 8) });
    for (const fn of this.peerGoneListeners) fn(peer);
  }

  private onFrame(peer: Peer, frame: Uint8Array): void {
    let m: Message;
    try {
      m = decodeMessage(frame);
    } catch (e) {
      this.cfg.log('warn', 'undecodable message', { peer: peer.id.slice(0, 8), err: (e as Error).message });
      this.score(peer.id, 20, 'malformed message');
      return;
    }
    peer.lastRecv = Date.now();
    this.handleControl(peer, m);
    const list = this.handlers.get(m.type);
    if (list) for (const h of list) h(peer, m);
  }

  /**
   * Charge a peer for misbehaving. Points decay by one a minute; at the
   * threshold the peer is disconnected and its address and id are banned for
   * an hour, doubling on each repeat.
   */
  score(peerId: string, points: number, reason: string): void {
    const now = Date.now();
    const s = this.scores.get(peerId) ?? { points: 0, last: now };
    s.points = Math.max(0, s.points - (now - s.last) / 60_000) + points;
    s.last = now;
    this.scores.set(peerId, s);
    this.cfg.log('debug', 'peer scored', { peer: peerId.slice(0, 8), points, total: Math.round(s.points), reason });
    if (s.points < BAN_THRESHOLD) return;
    this.scores.delete(peerId);
    const peer = this.peers.get(peerId);
    // Only an address we dialed is known to be this peer's; an advertised one could be anybody's.
    const addr = peer?.direction === 'out' ? peer.remoteAddr : null;
    const until = addr ? this.cfg.peerDb.ban(addr, BAN_MS, now) : now + BAN_MS;
    this.bannedIds.set(peerId, until);
    this.cfg.log('warn', 'peer banned', { peer: peerId.slice(0, 8), reason, untilMs: until - now });
    peer?.close();
  }

  /** Current misbehaviour points of a peer, after decay. */
  scoreOf(peerId: string): number {
    const s = this.scores.get(peerId);
    return s ? Math.max(0, s.points - (Date.now() - s.last) / 60_000) : 0;
  }

  isBanned(peerId: string): boolean {
    const until = this.bannedIds.get(peerId);
    return until !== undefined && until > Date.now();
  }

  /** Messages the network layer answers itself. Others also see them through `on`. */
  private handleControl(peer: Peer, m: Message): void {
    switch (m.type) {
      case 'ping':
        peer.send({ type: 'pong', time: m.time });
        break;
      case 'pong':
        peer.latencyMs = Date.now() - Number(m.time);
        break;
      case 'status':
        peer.height = m.height;
        break;
      case 'addrRequest': {
        const exclude = new Set([peer.listenAddr, this.cfg.advertiseAddr]);
        const addrs = new Set<string>();
        for (const p of this.peers.values()) if (p.listenAddr && !exclude.has(p.listenAddr)) addrs.add(p.listenAddr);
        for (const a of this.cfg.peerDb.sample(16, exclude)) addrs.add(a);
        peer.send({ type: 'addrResponse', addrs: [...addrs].slice(0, 32) });
        break;
      }
      case 'addrResponse':
        for (const a of m.addrs) if (a !== this.cfg.advertiseAddr) this.cfg.peerDb.add(a);
        break;
      case 'hello':
      case 'helloAck':
      case 'auth':
        this.cfg.log('warn', 'handshake message after handshake; dropping peer', { peer: peer.id.slice(0, 8) });
        peer.close();
        break;
      case 'reject':
        peer.close();
        break;
    }
  }

  // ------------------------------------------------------------------ loops

  private connectLoop(): void {
    if (!this.running) return;
    const need = this.cfg.desiredOutbound - this.outboundCount - this.dialing.size;
    if (need <= 0) return;
    const exclude = new Set<string>([this.cfg.advertiseAddr, ...this.dialing]);
    // Addresses we dialed are taken; an inbound peer's advertised address is only a claim and must not stop us dialing it.
    for (const p of this.peers.values()) if (p.direction === 'out') exclude.add(p.remoteAddr);
    for (const addr of this.cfg.peerDb.candidates(exclude).slice(0, need)) void this.connect(addr).catch(() => {});
  }

  private keepaliveLoop(): void {
    if (!this.running) return;
    const now = Date.now();
    for (const p of [...this.peers.values()]) {
      if (now - p.lastRecv > this.cfg.idleTimeoutMs) {
        this.cfg.log('info', 'dropping idle peer', { peer: p.id.slice(0, 8) });
        p.close();
      } else {
        p.send({ type: 'ping', time: BigInt(now) });
      }
    }
  }
}
