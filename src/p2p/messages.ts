/**
 * Wire messages. One byte of type, then the payload. Both the Hello used in
 * the handshake and the consensus messages reuse the type codecs, so a
 * message's bytes are the same bytes that get hashed and signed elsewhere.
 */
import { decode, type Reader } from '../codec/reader.ts';
import { Writer, encode } from '../codec/writer.ts';
import { HASH_SIZE } from '../crypto/hash.ts';
import { PUBLIC_KEY_SIZE, SIGNATURE_SIZE } from '../crypto/keys.ts';
import { decodeBlock, decodeCommit, decodeHeader, encodeBlock, encodeCommit, encodeHeader, type Block, type Commit, type Header } from '../types/block.ts';
import { ValidatorSet } from '../types/validator.ts';
import { decodeProposal, encodeProposal, type Proposal } from '../types/proposal.ts';
import { decodeVote, encodeVote, type Vote } from '../types/vote.ts';

export const NONCE_SIZE = 32;

export interface Hello {
  chainId: string;
  publicKey: Uint8Array;
  nonce: Uint8Array;
  /** Where this node accepts connections, or '' if it does not. */
  listenAddr: string;
  height: bigint;
  userAgent: string;
}

export const RejectCode = { WrongChain: 1, Self: 2, AlreadyConnected: 3, NotAccepting: 4, Invalid: 5 } as const;

export const InvKind = { Tx: 1, Evidence: 2 } as const;

/** The most headers one headersResponse carries: from the height asked downward, as many consecutive ones as are held. */
export const MAX_HEADERS = 1000;

export type Message =
  | { type: 'hello'; hello: Hello }
  | { type: 'helloAck'; hello: Hello; signature: Uint8Array }
  | { type: 'auth'; signature: Uint8Array }
  | { type: 'reject'; code: number; reason: string }
  | { type: 'addrRequest' }
  | { type: 'addrResponse'; addrs: string[] }
  | { type: 'ping'; time: bigint }
  | { type: 'pong'; time: bigint }
  | { type: 'status'; height: bigint }
  | { type: 'inv'; kind: number; hashes: Uint8Array[] }
  | { type: 'fetch'; kind: number; hashes: Uint8Array[] }
  | { type: 'item'; kind: number; data: Uint8Array }
  | { type: 'itemNotFound'; kind: number; hash: Uint8Array }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'vote'; vote: Vote }
  | { type: 'blockRequest'; height: bigint }
  | { type: 'blockResponse'; height: bigint; block: Block | null; commit: Commit | null }
  | { type: 'blocksRequest'; from: bigint; count: number }
  | { type: 'blocksResponse'; from: bigint; blocks: { block: Block; commit: Commit }[] }
  | { type: 'headerRequest'; height: bigint }
  | { type: 'headerResponse'; height: bigint; header: Header | null; commit: Commit | null }
  | { type: 'headersRequest'; height: bigint; count: number }
  | { type: 'headersResponse'; height: bigint; headers: Header[] }
  | { type: 'validatorSetRequest'; hash: Uint8Array }
  | { type: 'validatorSetResponse'; hash: Uint8Array; set: ValidatorSet | null }
  | { type: 'validatorsRequest'; height: bigint }
  | { type: 'validatorsResponse'; height: bigint; set: ValidatorSet | null }
  | { type: 'snapshotsRequest' }
  | { type: 'snapshotsResponse'; heights: bigint[] }
  | { type: 'manifestRequest'; height: bigint }
  | { type: 'manifestResponse'; height: bigint; manifest: Uint8Array | null }
  | { type: 'chunkRequest'; height: bigint; objectType: number; index: number }
  | { type: 'chunkResponse'; height: bigint; objectType: number; index: number; chunk: Uint8Array | null };

export type MessageType = Message['type'];

const CODES: Record<MessageType, number> = {
  hello: 1,
  helloAck: 2,
  auth: 3,
  reject: 4,
  addrRequest: 5,
  addrResponse: 6,
  ping: 7,
  pong: 8,
  status: 9,
  inv: 10,
  fetch: 11,
  item: 12,
  itemNotFound: 13,
  proposal: 20,
  vote: 21,
  blockRequest: 30,
  blockResponse: 31,
  blocksRequest: 32,
  blocksResponse: 33,
  headerRequest: 34,
  headerResponse: 35,
  headersRequest: 46,
  headersResponse: 47,
  validatorSetRequest: 36,
  validatorSetResponse: 37,
  validatorsRequest: 38,
  validatorsResponse: 39,
  snapshotsRequest: 40,
  snapshotsResponse: 41,
  manifestRequest: 42,
  manifestResponse: 43,
  chunkRequest: 44,
  chunkResponse: 45,
};
const BY_CODE = new Map<number, MessageType>(Object.entries(CODES).map(([k, v]) => [v, k as MessageType]));

export function encodeHello(w: Writer, h: Hello): void {
  w.string(h.chainId);
  w.fixed(h.publicKey);
  w.fixed(h.nonce);
  w.string(h.listenAddr);
  w.u64(h.height);
  w.string(h.userAgent);
}

export function decodeHello(r: Reader): Hello {
  return {
    chainId: r.string(256),
    publicKey: r.fixed(PUBLIC_KEY_SIZE),
    nonce: r.fixed(NONCE_SIZE),
    listenAddr: r.string(256),
    height: r.u64(),
    userAgent: r.string(256),
  };
}

export function helloBytes(h: Hello): Uint8Array {
  return encode((w) => encodeHello(w, h));
}

/** Both sides sign the same bytes: the initiator's hello then the acceptor's. The nonces inside bind it to this session. */
export function handshakeSignBytes(helloInitiator: Hello, helloAcceptor: Hello): Uint8Array {
  return encode((w) => {
    w.bytes(helloBytes(helloInitiator));
    w.bytes(helloBytes(helloAcceptor));
  });
}

export function encodeMessage(m: Message): Uint8Array {
  return encode((w) => {
    w.u8(CODES[m.type]);
    switch (m.type) {
      case 'hello':
        encodeHello(w, m.hello);
        break;
      case 'helloAck':
        encodeHello(w, m.hello);
        w.fixed(m.signature);
        break;
      case 'auth':
        w.fixed(m.signature);
        break;
      case 'reject':
        w.u8(m.code);
        w.string(m.reason);
        break;
      case 'addrRequest':
        break;
      case 'addrResponse':
        w.array(m.addrs, (w, a) => w.string(a));
        break;
      case 'ping':
      case 'pong':
        w.u64(m.time);
        break;
      case 'status':
        w.u64(m.height);
        break;
      case 'inv':
      case 'fetch':
        w.u8(m.kind);
        w.array(m.hashes, (w, h) => w.fixed(h));
        break;
      case 'item':
        w.u8(m.kind);
        w.bytes(m.data);
        break;
      case 'itemNotFound':
        w.u8(m.kind);
        w.fixed(m.hash);
        break;
      case 'proposal':
        encodeProposal(w, m.proposal);
        break;
      case 'vote':
        encodeVote(w, m.vote);
        break;
      case 'blockRequest':
        w.u64(m.height);
        break;
      case 'blockResponse':
        w.u64(m.height);
        w.option(m.block, encodeBlock);
        w.option(m.commit, encodeCommit);
        break;
      case 'blocksRequest':
        w.u64(m.from).u32(m.count);
        break;
      case 'blocksResponse':
        w.u64(m.from).array(m.blocks, (w, b) => {
          encodeBlock(w, b.block);
          encodeCommit(w, b.commit);
        });
        break;
      case 'headerRequest':
        w.u64(m.height);
        break;
      case 'headerResponse':
        w.u64(m.height).option(m.header, encodeHeader).option(m.commit, encodeCommit);
        break;
      case 'headersRequest':
        w.u64(m.height).u32(m.count);
        break;
      case 'headersResponse':
        w.u64(m.height).array(m.headers, encodeHeader);
        break;
      case 'validatorSetRequest':
        w.fixed(m.hash);
        break;
      case 'validatorSetResponse':
        w.fixed(m.hash).option(m.set, (w, s) => s.encode(w));
        break;
      case 'validatorsRequest':
        w.u64(m.height);
        break;
      case 'validatorsResponse':
        w.u64(m.height).option(m.set, (w, s) => s.encode(w));
        break;
      case 'snapshotsRequest':
        break;
      case 'snapshotsResponse':
        w.array(m.heights, (w, h) => w.u64(h));
        break;
      case 'manifestRequest':
        w.u64(m.height);
        break;
      case 'manifestResponse':
        w.u64(m.height).option(m.manifest, (w, b) => w.bytes(b));
        break;
      case 'chunkRequest':
        w.u64(m.height).u16(m.objectType).u32(m.index);
        break;
      case 'chunkResponse':
        w.u64(m.height).u16(m.objectType).u32(m.index).option(m.chunk, (w, b) => w.bytes(b));
        break;
    }
  });
}

export function decodeMessage(buf: Uint8Array): Message {
  return decode(buf, (r): Message => {
    const type = BY_CODE.get(r.u8());
    if (!type) throw new Error('unknown message type');
    switch (type) {
      case 'hello':
        return { type, hello: decodeHello(r) };
      case 'helloAck':
        return { type, hello: decodeHello(r), signature: r.fixed(SIGNATURE_SIZE) };
      case 'auth':
        return { type, signature: r.fixed(SIGNATURE_SIZE) };
      case 'reject':
        return { type, code: r.u8(), reason: r.string(1024) };
      case 'addrRequest':
        return { type };
      case 'addrResponse':
        return { type, addrs: r.array((r) => r.string(256), 256) };
      case 'ping':
      case 'pong':
        return { type, time: r.u64() };
      case 'status':
        return { type, height: r.u64() };
      case 'inv':
      case 'fetch':
        return { type, kind: r.u8(), hashes: r.array((r) => r.fixed(HASH_SIZE), 10_000) };
      case 'item':
        return { type, kind: r.u8(), data: r.bytes() };
      case 'itemNotFound':
        return { type, kind: r.u8(), hash: r.fixed(HASH_SIZE) };
      case 'proposal':
        return { type, proposal: decodeProposal(r) };
      case 'vote':
        return { type, vote: decodeVote(r) };
      case 'blockRequest':
        return { type, height: r.u64() };
      case 'blockResponse':
        return { type, height: r.u64(), block: r.option(decodeBlock), commit: r.option(decodeCommit) };
      case 'blocksRequest':
        return { type, from: r.u64(), count: r.u32() };
      case 'blocksResponse':
        return { type, from: r.u64(), blocks: r.array((r) => ({ block: decodeBlock(r), commit: decodeCommit(r) }), 64) };
      case 'headerRequest':
        return { type, height: r.u64() };
      case 'headerResponse':
        return { type, height: r.u64(), header: r.option(decodeHeader), commit: r.option(decodeCommit) };
      case 'headersRequest':
        return { type, height: r.u64(), count: r.u32() };
      case 'headersResponse':
        return { type, height: r.u64(), headers: r.array(decodeHeader, MAX_HEADERS) };
      case 'validatorSetRequest':
        return { type, hash: r.fixed(HASH_SIZE) };
      case 'validatorSetResponse':
        return { type, hash: r.fixed(HASH_SIZE), set: r.option(ValidatorSet.decode) };
      case 'validatorsRequest':
        return { type, height: r.u64() };
      case 'validatorsResponse':
        return { type, height: r.u64(), set: r.option(ValidatorSet.decode) };
      case 'snapshotsRequest':
        return { type };
      case 'snapshotsResponse':
        return { type, heights: r.array((r) => r.u64(), 64) };
      case 'manifestRequest':
        return { type, height: r.u64() };
      case 'manifestResponse':
        return { type, height: r.u64(), manifest: r.option((r) => r.bytes()) };
      case 'chunkRequest':
        return { type, height: r.u64(), objectType: r.u16(), index: r.u32() };
      case 'chunkResponse':
        return { type, height: r.u64(), objectType: r.u16(), index: r.u32(), chunk: r.option((r) => r.bytes()) };
    }
  });
}
