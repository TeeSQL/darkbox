import { generateDaemonName, type Identity, type IdentitySource } from '@darkbox/shared';
import { type IdentityInsert, type Store, UniqueViolationError } from './store.js';

const MAX_NAME_ATTEMPTS = 16;

export interface RegisterIdentityInput {
  shadowAccount: string;
  source: IdentitySource;
  /** Optional explicit name; when omitted a random daemon name is generated. */
  daemonName?: string;
  agentId?: string;
  ownerAddress?: string;
  telegramUserId?: string;
  telegramHandle?: string;
  ensName?: string;
}

/**
 * Registers an identity, assigning a stable daemon name. A random name is
 * generated once and persisted; on a UNIQUE collision we retry with a fresh
 * name. The name is never regenerated after a successful insert.
 */
export class IdentityRepository {
  constructor(private readonly store: Store) {}

  async register(input: RegisterIdentityInput): Promise<Identity> {
    const existing = await this.store.getIdentityByShadowAccount(input.shadowAccount);
    if (existing) return existing;

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
      const daemonName = input.daemonName ?? generateDaemonName();
      const insert: IdentityInsert = { ...input, daemonName, source: input.source };
      try {
        return await this.store.insertIdentity(insert);
      } catch (error) {
        lastError = error;
        // Retry only daemon-name collisions, and only when we're free to pick a
        // new random name. An explicit name or a telegram/pk conflict is fatal.
        const retriable =
          error instanceof UniqueViolationError &&
          error.constraintHint.includes('daemon_name') &&
          !input.daemonName;
        if (!retriable) throw error;
      }
    }
    throw new Error(
      `could not allocate a unique daemon name after ${MAX_NAME_ATTEMPTS} attempts`,
      { cause: lastError },
    );
  }

  getByShadowAccount(shadowAccount: string): Promise<Identity | null> {
    return this.store.getIdentityByShadowAccount(shadowAccount);
  }

  getByTelegramUserId(telegramUserId: string): Promise<Identity | null> {
    return this.store.getIdentityByTelegramUserId(telegramUserId);
  }
}
