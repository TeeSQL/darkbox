/**
 * Resolve a Telegram user to a stable DarkBox identity (owner + shadow account).
 *
 * Telegram-only players have no wallet at claim time, so we mint a deterministic
 * synthetic owner from their Telegram id and derive the shadow account from it
 * using the same `deriveShadowAccount(gameId, owner)` rule the bridge/contracts
 * use. When the player later supplies a real withdrawal-destination wallet we can
 * bind it without changing their game identity.
 */
import { deriveShadowAccount } from "@darkbox/shared";
import type { Address } from "viem";
import { config } from "./config.js";
import { db, syntheticOwner, type Identity } from "./store.js";

export function resolveIdentity(telegramId: string, suppliedOwner?: Address): Identity {
  const existing = db.getIdentity(telegramId);
  if (existing) {
    // Upgrade a synthetic owner to a real one if the player now supplied a wallet.
    if (existing.ownerIsSynthetic && suppliedOwner) {
      const shadowAccount = deriveShadowAccount(config.gameId, suppliedOwner);
      return db.upsertIdentity({
        ...existing,
        owner: suppliedOwner,
        ownerIsSynthetic: false,
        shadowAccount,
      });
    }
    return existing;
  }

  const owner = suppliedOwner ?? syntheticOwner(telegramId);
  const shadowAccount = deriveShadowAccount(config.gameId, owner);
  return db.upsertIdentity({
    telegramId,
    owner,
    ownerIsSynthetic: suppliedOwner === undefined,
    shadowAccount,
    createdAt: new Date().toISOString(),
  });
}
