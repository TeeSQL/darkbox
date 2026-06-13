/**
 * Gateway state store.
 *
 * Hackathon-pragmatic in-memory implementation behind a narrow interface so it
 * can be swapped for Postgres later. It holds ONLY gateway-owned coordination
 * state (identities, invite claims, registration commitments, whisper drafts).
 * Canonical money/accounting lives in the bridge + hidden chain; canonical
 * derived game state lives in the indexer. The gateway never becomes a second
 * source of truth for balances.
 */
import { keccak256, toHex, type Address, type Hex } from "viem";

export interface Identity {
  telegramId: string;
  /** Owner address: real wallet once supplied, else a deterministic synthetic. */
  owner: Address;
  ownerIsSynthetic: boolean;
  shadowAccount: Hex;
  createdAt: string;
}

export interface InviteClaim {
  inviteId: string;
  telegramId: string;
  inviteCode: string;
  amount: string;
  currency: string;
  fundingType: "promo_shadow";
  withdrawalUnlockAt: string;
  claimedAt: string;
}

export interface Registration {
  agentId: string;
  telegramId: string;
  agentName: string;
  ensName?: string;
  instructionHash: Hex;
  revealSaltHash?: Hex;
  runtimeHash?: Hex;
  registeredAt: string;
}

export type WhisperStatus = "draft_ready" | "confirmed";

export interface Whisper {
  whisperId: string;
  telegramId: string;
  status: WhisperStatus;
  transcript: string;
  language: string;
  durationMs: number;
  audioHash: Hex;
  transcriptHash: Hex;
  instructionHash?: Hex;
  source: "typed" | "audio";
  updatedAt: string;
}

interface Store {
  identities: Map<string, Identity>;
  invitesByTelegram: Map<string, InviteClaim>;
  registrationsByTelegram: Map<string, Registration>;
  whispers: Map<string, Whisper>;
}

const store: Store = {
  identities: new Map(),
  invitesByTelegram: new Map(),
  registrationsByTelegram: new Map(),
  whispers: new Map(),
};

/** Deterministic synthetic owner address for a Telegram-only (no-wallet) player. */
export function syntheticOwner(telegramId: string): Address {
  const h = keccak256(toHex(`darkbox:tg-owner:${telegramId}`));
  return (`0x${h.slice(-40)}`) as Address;
}

/** Stable agent id derived from the player's shadow account. */
export function deriveAgentId(shadowAccount: Hex): string {
  return `agent_${shadowAccount.slice(2, 14)}`;
}

export const db = {
  getIdentity(telegramId: string): Identity | undefined {
    return store.identities.get(telegramId);
  },
  upsertIdentity(id: Identity): Identity {
    store.identities.set(id.telegramId, id);
    return id;
  },
  getInvite(telegramId: string): InviteClaim | undefined {
    return store.invitesByTelegram.get(telegramId);
  },
  putInvite(claim: InviteClaim): InviteClaim {
    store.invitesByTelegram.set(claim.telegramId, claim);
    return claim;
  },
  getRegistration(telegramId: string): Registration | undefined {
    return store.registrationsByTelegram.get(telegramId);
  },
  putRegistration(reg: Registration): Registration {
    store.registrationsByTelegram.set(reg.telegramId, reg);
    return reg;
  },
  getWhisper(whisperId: string): Whisper | undefined {
    return store.whispers.get(whisperId);
  },
  putWhisper(w: Whisper): Whisper {
    store.whispers.set(w.whisperId, w);
    return w;
  },
  /** test-only reset */
  _reset(): void {
    store.identities.clear();
    store.invitesByTelegram.clear();
    store.registrationsByTelegram.clear();
    store.whispers.clear();
  },
};
