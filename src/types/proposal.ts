import type { Reader } from '../codec/reader.ts';
import { Writer, encode } from '../codec/writer.ts';
import { decodeSignature } from '../crypto/keys.ts';
import { blockHash, decodeBlock, encodeBlock, type Block } from './block.ts';

/**
 * A proposal carries the whole block. Blocks are small enough here that
 * splitting them into gossiped parts, as Tendermint does, is not worth it.
 *
 * `polRound` ("proof of lock round") is the round in which the proposer saw
 * a +2/3 prevote majority for this block, or -1 if it is a fresh block. It
 * lets validators locked on an older block safely unlock.
 */
export interface Proposal {
  height: bigint;
  round: number;
  polRound: number;
  block: Block;
  signature: Uint8Array;
}

export type UnsignedProposal = Omit<Proposal, 'signature'>;

export function proposalSignBytes(chainId: string, p: UnsignedProposal): Uint8Array {
  return encode((w) => {
    w.string(chainId);
    w.u64(p.height);
    w.u32(p.round);
    w.i64(BigInt(p.polRound));
    w.fixed(blockHash(p.block));
  });
}

export function encodeProposal(w: Writer, p: Proposal): void {
  w.u64(p.height);
  w.u32(p.round);
  w.i64(BigInt(p.polRound));
  encodeBlock(w, p.block);
  w.fixed(p.signature);
}

export function decodeProposal(r: Reader): Proposal {
  return {
    height: r.u64(),
    round: r.u32(),
    polRound: Number(r.i64()),
    block: decodeBlock(r),
    signature: decodeSignature(r),
  };
}
