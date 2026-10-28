import { afterEach, describe, expect, it } from 'vitest';
import { keyPairFromSeed } from '../src/crypto/keys.ts';
import { InlineVerifier, type Verifier } from '../src/crypto/verifier.ts';
import { MemoryHub } from '../src/p2p/memory.ts';
import { Network } from '../src/p2p/network.ts';
import { PeerDb } from '../src/p2p/peerdb.ts';
import { TcpTransport } from '../src/p2p/tcp.ts';
import type { Transport } from '../src/p2p/transport.ts';
import { seedFor, sleep, testLogger, waitFor } from './helpers.ts';

const verifier = new InlineVerifier();
const nets: Network[] = [];
afterEach(async () => {
  await Promise.all(nets.map((n) => n.stop()));
  nets.length = 0;
});

function makeNet(name: string, transport: Transport, listenAddr: string, opts: { chainId?: string; seeds?: string[]; key?: string; height?: bigint; verifier?: Verifier } = {}): Network {
  const n = new Network({
    chainId: opts.chainId ?? 'net-test',
    nodeKey: keyPairFromSeed(seedFor(opts.key ?? name)),
    transport,
    listenAddr,
    peerDb: new PeerDb(null, opts.seeds ?? []),
    verifier: opts.verifier ?? verifier,
    getHeight: () => opts.height ?? 0n,
    log: testLogger(name),
    connectIntervalMs: 50,
    pingIntervalMs: 200,
    idleTimeoutMs: 1000,
  });
  nets.push(n);
  return n;
}

describe('p2p over the in-memory transport', () => {
  it('handshakes, exchanges status and addresses, and pings', async () => {
    const hub = new MemoryHub();
    const a = makeNet('a', hub.transport('a:1'), 'a:1', { height: 7n });
    const b = makeNet('b', hub.transport('b:1'), 'b:1', { seeds: ['a:1'] });
    const c = makeNet('c', hub.transport('c:1'), 'c:1', { seeds: ['b:1'] });
    await a.start();
    await b.start();
    await c.start();
    await waitFor(() => a.peers.size === 2 && b.peers.size === 2 && c.peers.size === 2, 5000, 'full mesh via address exchange');
    const aFromB = b.peers.get(a.id)!;
    expect(aFromB.height).toBe(7n);
    expect(aFromB.listenAddr).toBe('a:1');
    await sleep(500);
    expect(aFromB.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Date.now() - aFromB.lastRecv).toBeLessThan(500);
  });

  it('delivers a message sent the instant a peer connects, while the other side is still verifying the handshake', async () => {
    const hub = new MemoryHub();
    // The accepting side takes its time over the final handshake signature, as a busy verification pool would.
    const slow: Verifier = {
      verify: (jobs) => verifier.verify(jobs),
      verifyOne: async (job) => {
        await sleep(100);
        return verifier.verifyOne(job);
      },
      close: async () => {},
    };
    const a = makeNet('a', hub.transport('a:1'), 'a:1', { verifier: slow });
    const b = makeNet('b', hub.transport('b:1'), 'b:1', { seeds: ['a:1'] });
    let early: bigint | null = null;
    a.on('status', (_peer, m) => {
      if (m.height === 42n) early = m.height;
    });
    b.onPeer((peer) => peer.send({ type: 'status', height: 42n }));
    await a.start();
    await b.start();
    await waitFor(() => early === 42n, 3000, 'the message sent right after the handshake');
  });

  it('rejects a peer on another chain and a connection to itself', async () => {
    const hub = new MemoryHub();
    const a = makeNet('a', hub.transport('a:1'), 'a:1', { chainId: 'one' });
    const b = makeNet('b', hub.transport('b:1'), 'b:1', { chainId: 'two' });
    await a.start();
    await b.start();
    await expect(b.connect('a:1')).rejects.toThrow(/wrong chain/);
    await expect(a.connect('a:1')).rejects.toThrow(/self/);
    expect(a.peers.size).toBe(0);
  });

  it('a simultaneous dial leaves exactly one connection on each side', async () => {
    const hub = new MemoryHub();
    hub.latencyMs = 20;
    const a = makeNet('a', hub.transport('a:1'), 'a:1');
    const b = makeNet('b', hub.transport('b:1'), 'b:1');
    await a.start();
    await b.start();
    const results = await Promise.allSettled([a.connect('b:1'), b.connect('a:1')]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    await sleep(200);
    expect(a.peers.size).toBe(1);
    expect(b.peers.size).toBe(1);
    expect(a.peers.get(b.id)!.direction).not.toBe(b.peers.get(a.id)!.direction);
  });

  it('drops a peer that goes silent', async () => {
    const hub = new MemoryHub();
    const a = makeNet('a', hub.transport('a:1'), 'a:1');
    const b = makeNet('b', hub.transport('b:1'), 'b:1', { seeds: ['a:1'] });
    await a.start();
    await b.start();
    await waitFor(() => a.peers.size === 1, 2000, 'connect');
    hub.partition(['a:1'], ['b:1']);
    await waitFor(() => a.peers.size === 0, 3000, 'idle drop');
  });
});

describe('p2p over TCP', () => {
  it('handshakes over real sockets and delivers framed messages', async () => {
    const a = makeNet('a', new TcpTransport(), '127.0.0.1:38881', { height: 3n });
    const b = makeNet('b', new TcpTransport(), '127.0.0.1:38882', { seeds: ['127.0.0.1:38881'] });
    await a.start();
    await b.start();
    await waitFor(() => a.peers.size === 1 && b.peers.size === 1, 5000, 'tcp handshake');
    const got: bigint[] = [];
    a.on('status', (_p, m) => got.push(m.height));
    b.peers.get(a.id)!.send({ type: 'status', height: 42n });
    await waitFor(() => got.includes(42n), 2000, 'status delivery');
    expect(b.peers.get(a.id)!.height).toBe(3n);
  });
});
