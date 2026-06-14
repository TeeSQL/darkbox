import type { IndexerApi } from './coordinator.js';

/** HTTP implementation of IndexerApi against the indexer internal API. */
export class HttpIndexerApi implements IndexerApi {
  private readonly base: string;
  private readonly token?: string;

  constructor(internalUrl = process.env.INDEXER_INTERNAL_URL ?? 'http://darkbox-indexer:8080/internal', token = process.env.INTERNAL_API_TOKEN) {
    this.base = internalUrl.replace(/\/$/, '');
    this.token = token;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.token ? { 'x-internal-token': this.token } : {}) };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }

  async deposit(agentId: string, amount: number, opId: string): Promise<boolean> {
    const body = (await this.post('/deposits', { agentId, amount, opId })) as { applied?: boolean };
    return body.applied !== false;
  }

  async withdraw(agentId: string, amount: number, commandId: string): Promise<boolean> {
    const body = (await this.post('/withdrawals', { agentId, amount, commandId })) as { applied?: boolean };
    return body.applied !== false;
  }

  async withdrawable(agentId: string): Promise<number> {
    const res = await fetch(`${this.base}/agents/${encodeURIComponent(agentId)}/balance`, {
      headers: this.token ? { 'x-internal-token': this.token } : {},
    });
    if (!res.ok) throw new Error(`balance -> ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { withdrawable: number };
    return body.withdrawable;
  }

  async resolveAgentId(shadowAccount: string): Promise<string | null> {
    const res = await fetch(`${this.base}/identity/by-shadow/${encodeURIComponent(shadowAccount)}`, {
      headers: this.token ? { 'x-internal-token': this.token } : {},
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`identity -> ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { identity: { agentId?: string } };
    return body.identity.agentId ?? null;
  }
}
