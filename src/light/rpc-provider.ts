/**
 * The light client's view of a node over JSON-RPC: headers, commits and
 * validator sets by hash, exactly what the in-process provider reads from a
 * store, but from the wire.
 */
import type { RpcClient } from '../rpc/client.ts';
import { commitFromJson, headerFromJson, validatorSetFromJson } from '../rpc/json.ts';
import { toHex } from '../crypto/hash.ts';
import type { Header } from '../types/block.ts';
import type { ValidatorSet } from '../types/validator.ts';
import type { LightProvider, SignedHeader } from './client.ts';

export class RpcProvider implements LightProvider {
  private readonly rpc: RpcClient;

  constructor(rpc: RpcClient) {
    this.rpc = rpc;
  }

  async latestHeight(): Promise<bigint> {
    return BigInt((await this.rpc.status()).latestHeight);
  }

  async signedHeader(height: bigint): Promise<SignedHeader | null> {
    try {
      const [h, c] = await Promise.all([this.rpc.header(height), this.rpc.commit(height)]);
      return { header: headerFromJson(h), commit: commitFromJson(c) };
    } catch (e) {
      if ((e as { code?: number }).code === -32001) return null;
      throw e;
    }
  }

  async header(height: bigint): Promise<Header | null> {
    try {
      return headerFromJson(await this.rpc.header(height));
    } catch (e) {
      if ((e as { code?: number }).code === -32001) return null;
      throw e;
    }
  }

  async validatorSet(hash: Uint8Array): Promise<ValidatorSet | null> {
    try {
      return validatorSetFromJson(await this.rpc.validatorSet(toHex(hash)));
    } catch (e) {
      if ((e as { code?: number }).code === -32001) return null;
      throw e;
    }
  }
}
