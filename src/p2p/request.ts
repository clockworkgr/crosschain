/**
 * Request and response over the peer protocol, which has no correlation ids:
 * a request is matched to the first response of the expected type from the
 * same peer that satisfies a predicate, or it times out. Callers only await.
 */
import type { Message, MessageType } from './messages.ts';
import type { Network, Peer } from './network.ts';

type Of<T extends MessageType> = Extract<Message, { type: T }>;

interface Pending {
  peerId: string;
  type: MessageType;
  match(m: Message): boolean;
  resolve(m: Message): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

const RESPONSE_TYPES: MessageType[] = ['blockResponse', 'blocksResponse', 'headerResponse', 'headersResponse', 'validatorSetResponse', 'validatorsResponse', 'snapshotsResponse', 'manifestResponse', 'chunkResponse', 'addrResponse'];

export class Requester {
  private readonly pending: Pending[] = [];

  constructor(network: Network) {
    for (const t of RESPONSE_TYPES) network.on(t, (peer, m) => this.deliver(peer.id, m));
    network.onPeerGone((peer) => {
      for (const p of this.pending.filter((p) => p.peerId === peer.id)) this.settle(p, new Error('peer disconnected'));
    });
  }

  private settle(p: Pending, error: Error | null, m?: Message): void {
    const i = this.pending.indexOf(p);
    if (i >= 0) this.pending.splice(i, 1);
    clearTimeout(p.timer);
    if (error) p.reject(error);
    else p.resolve(m!);
  }

  private deliver(peerId: string, m: Message): void {
    const p = this.pending.find((p) => p.peerId === peerId && p.type === m.type && p.match(m));
    if (p) this.settle(p, null, m);
  }

  request<T extends MessageType>(peer: Peer, msg: Message, responseType: T, match: (m: Of<T>) => boolean, timeoutMs = 5000): Promise<Of<T>> {
    return new Promise<Of<T>>((resolve, reject) => {
      const p: Pending = {
        peerId: peer.id,
        type: responseType,
        match: (m) => match(m as Of<T>),
        resolve: (m) => resolve(m as Of<T>),
        reject,
        timer: setTimeout(() => this.settle(p, new Error(`${responseType} from ${peer.id.slice(0, 8)} timed out`)), timeoutMs),
      };
      this.pending.push(p);
      try {
        peer.send(msg);
      } catch (e) {
        this.settle(p, e as Error);
      }
    });
  }

  get inflight(): number {
    return this.pending.length;
  }
}
