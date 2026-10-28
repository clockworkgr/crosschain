/**
 * The transport delivers whole frames between two endpoints. Everything
 * above it (handshake, gossip, consensus) is the same whether the frames
 * travel over TCP or between objects in one process. That is what lets a
 * whole validator set run inside a single test.
 */
export interface Conn {
  readonly remoteAddr: string;
  send(frame: Uint8Array): void;
  /** Replaces any previous handler. Frames that arrive before a handler is set are buffered. */
  onFrame(cb: (frame: Uint8Array) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): void;
  readonly closed: boolean;
}

export interface Transport {
  dial(addr: string): Promise<Conn>;
  listen(addr: string, onConn: (conn: Conn) => void): Promise<void>;
  close(): Promise<void>;
}

/** Shared buffering logic for the two Conn implementations. */
export abstract class BaseConn implements Conn {
  abstract readonly remoteAddr: string;
  closed = false;
  private frameCb: ((frame: Uint8Array) => void) | null = null;
  private closeCb: ((err?: Error) => void) | null = null;
  private pending: Uint8Array[] = [];
  private closeErr: Error | undefined;
  private closeDelivered = false;

  abstract send(frame: Uint8Array): void;
  abstract close(): void;

  onFrame(cb: (frame: Uint8Array) => void): void {
    this.frameCb = cb;
    const queued = this.pending;
    this.pending = [];
    for (const f of queued) cb(f);
  }

  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
    if (this.closed && !this.closeDelivered) {
      this.closeDelivered = true;
      cb(this.closeErr);
    }
  }

  protected deliver(frame: Uint8Array): void {
    if (this.closed) return;
    if (this.frameCb) this.frameCb(frame);
    else this.pending.push(frame);
  }

  protected markClosed(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeErr = err;
    if (this.closeCb && !this.closeDelivered) {
      this.closeDelivered = true;
      this.closeCb(err);
    }
  }
}
