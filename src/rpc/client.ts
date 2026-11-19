/**
 * A JSON-RPC client on the global fetch. `call` is the whole protocol; the
 * typed helpers are what the CLI and the light-client provider use.
 */
export class RpcClientError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export class RpcClient {
  readonly url: string;
  /** Sent as `Authorization: Bearer <token>` with every call, for a server that asks for one. */
  private readonly token: string | null;
  private nextId = 1;

  constructor(url: string, token: string | null = null) {
    this.url = url.replace(/\/$/, '');
    // Checked here, without the value in the message: fetch would refuse a header it cannot send and say what it was.
    if (token !== null && (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token))) throw new Error('the rpc token must be visible ASCII characters with no spaces');
    this.token = token;
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.url + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token === null ? {} : { Authorization: `Bearer ${this.token}` }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    });
    if (res.status === 429) throw new RpcClientError(-32004, 'rate limited');
    if (res.status === 401) throw new RpcClientError(-32000, 'the server asks for a token (http 401): pass --rpc-token or set RPC_TOKEN');
    if (!res.ok) throw new RpcClientError(-32000, `http ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (j.error) throw new RpcClientError(j.error.code, j.error.message);
    return j.result as T;
  }

  status() {
    return this.call('status');
  }
  header(height: bigint) {
    return this.call('header', { height: height.toString() });
  }
  commit(height: bigint) {
    return this.call('commit', { height: height.toString() });
  }
  validators(height: bigint) {
    return this.call('validators', { height: height.toString() });
  }
  validatorSet(hash: string) {
    return this.call('validatorSet', { hash });
  }
  account(name: string, prove = false) {
    return this.call('account', { name, prove });
  }
  broadcastTx(txHex: string, mode: 'sync' | 'commit' = 'sync', timeoutMs = 30_000) {
    return this.call('broadcastTx', { tx: txHex, mode, timeoutMs });
  }
  tx(hash: string, prove = false) {
    return this.call('tx', { hash, prove });
  }
  parameters() {
    return this.call('parameters');
  }
  proposals() {
    return this.call('proposals');
  }
}
