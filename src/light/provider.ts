/**
 * A light-client provider over a node in the same process: what an RPC
 * client would do over the wire, without the wire. Every validator set a
 * header can name was saved by hash when it became the next set, so the
 * store answers every lookup the client makes.
 */
import type { Node } from '../node/node.ts';
import type { LightProvider, SignedHeader } from './client.ts';
import type { Header } from '../types/block.ts';
import type { ValidatorSet } from '../types/validator.ts';

export class NodeProvider implements LightProvider {
  private readonly node: Node;

  constructor(node: Node) {
    this.node = node;
  }

  async latestHeight(): Promise<bigint> {
    return this.node.height;
  }

  async signedHeader(height: bigint): Promise<SignedHeader | null> {
    const stored = this.node.store.loadBlock(height);
    return stored ? { header: stored.block.header, commit: stored.commit } : null;
  }

  async header(height: bigint): Promise<Header | null> {
    return this.node.store.loadBlock(height)?.block.header ?? this.node.store.loadHeader(height);
  }

  async validatorSet(hash: Uint8Array): Promise<ValidatorSet | null> {
    return this.node.store.loadValidatorSet(hash);
  }
}
