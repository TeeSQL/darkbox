import type { Identity } from '@darkbox/shared';

export interface IndexerIdentityClientOptions {
  /** Base URL of the indexer internal API, e.g. http://darkbox-indexer:8080/internal */
  internalUrl?: string;
  internalToken?: string;
}

/**
 * Client for registering agent identities with the indexer. Spawned agents have
 * no telegram account but must have a daemon name to appear on leaderboards, so
 * registration only requires a shadowAccount; the indexer assigns the name.
 */
export class IndexerIdentityClient {
  private readonly internalUrl: string;
  private readonly internalToken?: string;

  constructor(options: IndexerIdentityClientOptions = {}) {
    this.internalUrl = (options.internalUrl ?? process.env.INDEXER_INTERNAL_URL ?? 'http://darkbox-indexer:8080/internal').replace(/\/$/, '');
    this.internalToken = options.internalToken ?? process.env.INTERNAL_API_TOKEN;
  }

  async registerSpawnedAgent(params: { shadowAccount: string; agentId?: string }): Promise<Identity> {
    const response = await fetch(`${this.internalUrl}/identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.internalToken ? { 'x-internal-token': this.internalToken } : {}),
      },
      body: JSON.stringify({
        shadowAccount: params.shadowAccount,
        agentId: params.agentId,
        source: 'spawned',
      }),
    });
    if (!response.ok) {
      throw new Error(`identity registration failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { identity: Identity };
    return body.identity;
  }
}
