/**
 * TCP transport with length-prefixed framing: 4-byte big-endian length, then
 * the frame. TCP is a byte stream, so the receiver reassembles frames from
 * whatever chunk sizes the kernel hands it.
 */
import { createServer, connect, type Server, type Socket } from 'node:net';
import { BaseConn, type Conn, type Transport } from './transport.ts';

/** Bytes queued for one peer before we give up on it. */
const MAX_BUFFERED = 32 * 1024 * 1024;
const MAX_FRAME = 32 * 1024 * 1024;

function parseAddr(addr: string): { host: string; port: number } {
  const i = addr.lastIndexOf(':');
  if (i < 0) throw new Error(`bad address ${addr}`);
  const port = Number(addr.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`bad port in ${addr}`);
  let host = addr.slice(0, i) || '0.0.0.0';
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // [::1]:port
  return { host, port };
}

class TcpConn extends BaseConn {
  readonly remoteAddr: string;
  private readonly socket: Socket;
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(socket: Socket) {
    super();
    this.socket = socket;
    this.remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.markClosed(err));
    socket.on('close', () => this.markClosed());
  }

  private onData(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (true) {
      if (this.buffered < 4) return;
      // Chunks are joined only once a whole frame is in, so a frame arriving in many pieces costs linear work.
      if (this.chunks[0]!.length < 4) this.chunks = [Buffer.concat(this.chunks)];
      const len = this.chunks[0]!.readUInt32BE(0);
      if (len > MAX_FRAME) {
        this.close();
        return;
      }
      if (this.buffered < 4 + len) return;
      const buf = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
      const frame = new Uint8Array(buf.subarray(4, 4 + len));
      const rest = buf.subarray(4 + len);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.buffered = rest.length;
      this.deliver(frame);
    }
  }

  send(frame: Uint8Array): void {
    if (this.closed) return;
    // A peer that stops reading must not make us buffer without bound.
    if (this.socket.writableLength > MAX_BUFFERED) {
      this.close();
      return;
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(frame.length, 0);
    this.socket.write(Buffer.concat([header, Buffer.from(frame)]));
  }

  close(): void {
    if (this.closed) return;
    this.socket.destroy();
    this.markClosed();
  }
}

export class TcpTransport implements Transport {
  private server: Server | null = null;

  dial(addr: string): Promise<Conn> {
    const { host, port } = parseAddr(addr);
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const onError = (err: Error) => reject(err);
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        resolve(new TcpConn(socket));
      });
    });
  }

  listen(addr: string, onConn: (conn: Conn) => void): Promise<void> {
    const { host, port } = parseAddr(addr);
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => onConn(new TcpConn(socket)));
      server.once('error', reject);
      server.listen(port, host, () => {
        this.server = server;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}
