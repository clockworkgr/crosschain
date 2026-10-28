/**
 * In-process transport. A hub links named endpoints; dialing a name creates
 * a pair of connected endpoints. Latency and partitions are injectable, so a
 * test can delay, drop, or split the network and watch consensus react.
 */
import { BaseConn, type Conn, type Transport } from './transport.ts';

export class MemoryHub {
  latencyMs = 0;
  /** Returns false to drop a frame between two addresses, for tests that want to lose one kind of message. */
  messageFilter: ((from: string, to: string, frame: Uint8Array) => boolean) | null = null;
  private readonly listeners = new Map<string, (conn: Conn) => void>();
  private readonly blocked = new Set<string>();

  private key(a: string, b: string): string {
    return `${a}|${b}`;
  }

  /** Drop every frame between any address in A and any address in B, both directions. */
  partition(groupA: string[], groupB: string[]): void {
    for (const a of groupA)
      for (const b of groupB) {
        this.blocked.add(this.key(a, b));
        this.blocked.add(this.key(b, a));
      }
  }

  /** Cut `addr` off from everyone. */
  isolate(addr: string, others: string[]): void {
    this.partition([addr], others.filter((o) => o !== addr));
  }

  heal(): void {
    this.blocked.clear();
  }

  isBlocked(from: string, to: string): boolean {
    return this.blocked.has(this.key(from, to));
  }

  transport(addr: string): Transport {
    const hub = this;
    let bound: string | null = null;
    return {
      async dial(target: string): Promise<Conn> {
        const accept = hub.listeners.get(target);
        if (!accept) throw new Error(`connection refused: ${target}`);
        const [a, b] = MemoryConn.pair(hub, addr, target);
        setTimeout(() => accept(b), hub.latencyMs);
        return a;
      },
      async listen(bind: string, onConn: (conn: Conn) => void): Promise<void> {
        if (hub.listeners.has(bind)) throw new Error(`address in use: ${bind}`);
        hub.listeners.set(bind, onConn);
        bound = bind;
      },
      async close(): Promise<void> {
        if (bound !== null) hub.listeners.delete(bound);
        bound = null;
      },
    };
  }
}

class MemoryConn extends BaseConn {
  readonly remoteAddr: string;
  private readonly localAddr: string;
  private readonly hub: MemoryHub;
  private peer!: MemoryConn;

  private constructor(hub: MemoryHub, localAddr: string, remoteAddr: string) {
    super();
    this.hub = hub;
    this.localAddr = localAddr;
    this.remoteAddr = remoteAddr;
  }

  static pair(hub: MemoryHub, a: string, b: string): [MemoryConn, MemoryConn] {
    const ca = new MemoryConn(hub, a, b);
    const cb = new MemoryConn(hub, b, a);
    ca.peer = cb;
    cb.peer = ca;
    return [ca, cb];
  }

  send(frame: Uint8Array): void {
    if (this.closed) return;
    if (this.hub.isBlocked(this.localAddr, this.remoteAddr)) return;
    if (this.hub.messageFilter && !this.hub.messageFilter(this.localAddr, this.remoteAddr, frame)) return;
    const peer = this.peer;
    const copy = frame.slice(); // as over a wire: the receiver's bytes are its own
    setTimeout(() => peer.deliver(copy), this.hub.latencyMs);
  }

  close(): void {
    if (this.closed) return;
    this.markClosed();
    const peer = this.peer;
    setTimeout(() => peer.markClosed(), this.hub.latencyMs);
  }
}
