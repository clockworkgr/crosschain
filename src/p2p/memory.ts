/**
 * In-process transport. A hub links named endpoints; dialing a name creates
 * a pair of connected endpoints. Latency and partitions are injectable, so a
 * test can delay, drop, or split the network and watch consensus react.
 */
import { BaseConn, type Conn, type Transport } from './transport.ts';

/**
 * One transport's end of the hub: its connections and what is on its way to them. Closing the transport closes
 * the connections and takes back the timers, so that nothing of a stopped network is left to happen.
 */
class End {
  closed = false;
  readonly conns = new Set<MemoryConn>();
  private readonly timers = new Set<NodeJS.Timeout>();

  /** Run `fn` after the hub's latency; at once if this end is closed, when there is no wire left to cross. */
  after(ms: number, fn: () => void): void {
    if (this.closed) {
      fn();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const c of [...this.conns]) c.close();
    this.conns.clear();
  }
}

export class MemoryHub {
  latencyMs = 0;
  /** Returns false to drop a frame between two addresses, for tests that want to lose one kind of message. */
  messageFilter: ((from: string, to: string, frame: Uint8Array) => boolean) | null = null;
  private readonly listeners = new Map<string, { accept: (conn: Conn) => void; end: End }>();
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
    const end = new End();
    return {
      async dial(target: string): Promise<Conn> {
        const listener = hub.listeners.get(target);
        if (!listener) throw new Error(`connection refused: ${target}`);
        end.closed = false;
        const [a, b] = MemoryConn.pair(hub, addr, target, end, listener.end);
        // A listener that closed while the connection was on its way never sees it.
        listener.end.after(hub.latencyMs, () => (listener.end.closed ? b.close() : listener.accept(b)));
        return a;
      },
      async listen(bind: string, onConn: (conn: Conn) => void): Promise<void> {
        if (hub.listeners.has(bind)) throw new Error(`address in use: ${bind}`);
        end.closed = false;
        hub.listeners.set(bind, { accept: onConn, end });
        bound = bind;
      },
      async close(): Promise<void> {
        if (bound !== null) hub.listeners.delete(bound);
        bound = null;
        end.close();
      },
    };
  }
}

class MemoryConn extends BaseConn {
  readonly remoteAddr: string;
  private readonly localAddr: string;
  private readonly hub: MemoryHub;
  private peer!: MemoryConn;
  private readonly end: End;

  private constructor(hub: MemoryHub, localAddr: string, remoteAddr: string, end: End) {
    super();
    this.end = end;
    end.conns.add(this);
    this.hub = hub;
    this.localAddr = localAddr;
    this.remoteAddr = remoteAddr;
  }

  static pair(hub: MemoryHub, a: string, b: string, endA: End, endB: End): [MemoryConn, MemoryConn] {
    const ca = new MemoryConn(hub, a, b, endA);
    const cb = new MemoryConn(hub, b, a, endB);
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
    peer.end.after(this.hub.latencyMs, () => peer.deliver(copy));
  }

  close(): void {
    if (this.closed) return;
    this.markClosed();
    this.end.conns.delete(this);
    const peer = this.peer;
    peer.end.after(this.hub.latencyMs, () => {
      peer.end.conns.delete(peer);
      peer.markClosed();
    });
  }
}
