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
import { humanPromoOperationId, humanPromoOperationString } from "@darkbox/shared";

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
  promoOperationId: Hex;
}

export interface FaucetEnqueueRecord {
  operationId: Hex;
  operationString: string;
  kind: "human_promo";
  gameId: Hex;
  telegramId: string;
  inviteId: string;
  owner: Address;
  shadowAccount: Hex;
  amount: string;
  currency: string;
  status: "pending" | "accepted" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
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

/**
 * An authenticated deposit order ("intent").
 *
 * Created when a returning player taps "Feed the daemon": it binds an off-chain
 * order to the player's resolved identity (owner + shadowAccount) and a unique
 * on-chain reconciliation tag, so a confirmed deposit to the shared bridge
 * escrow can be attributed back to the right account — the same account the
 * player keeps control of (synthetic owner now, upgradeable to a real wallet).
 *
 * The gateway is NOT the balance source of truth. Canonical attribution +
 * shadow mint is the bridge's job; the gateway records the order and reconciles
 * its own view from the indexer's credited-balance read.
 */
export type DepositIntentStatus =
  | "intent_created"
  | "awaiting_settlement"
  | "credited"
  | "expired";

export interface DepositIntent {
  depositOpId: string;
  telegramId: string;
  owner: Address;
  shadowAccount: Hex;
  /** Unique per-order reconciliation tag (bytes32) for operator/watcher match. */
  depositRef: Hex;
  chainId: number;
  currency: string;
  /** Requested amount in USDC decimal string, e.g. "25.00". */
  amount: string;
  /** Amount the player must send, base + unique micro-USDC tag, e.g. "25.004213". */
  exactDepositAmount: string;
  /** The unique micro-USDC tag added on top of `amount` (integer micro-USDC). */
  amountTagMicroUsdc: number;
  /** Public bridge escrow the deposit settles to. */
  depositAddress: Address;
  /** Token contract for the deposit (USDC). */
  tokenAddress: Address;
  /** Indexer total_deposited (micro-USDC) at creation, the reconciliation floor. */
  baselineDepositedMicro: string;
  status: DepositIntentStatus;
  /** Set once the indexer shows the credit; null until then. */
  creditedAt: string | null;
  createdAt: string;
  expiresAt: string;
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
  depositIntents: Map<string, DepositIntent>;
  faucetEnqueues: Map<string, FaucetEnqueueRecord>;
}

const store: Store = {
  identities: new Map(),
  invitesByTelegram: new Map(),
  registrationsByTelegram: new Map(),
  whispers: new Map(),
  depositIntents: new Map(),
  faucetEnqueues: new Map(),
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
  buildHumanPromoFaucetRecord(params: {
    gameId: Hex;
    telegramId: string;
    inviteId: string;
    owner: Address;
    shadowAccount: Hex;
    amount: string;
    currency: string;
    now: string;
  }): FaucetEnqueueRecord {
    const operationId = humanPromoOperationId({
      gameId: params.gameId,
      telegramId: params.telegramId,
    });
    return {
      operationId,
      operationString: humanPromoOperationString({
        gameId: params.gameId,
        telegramId: params.telegramId,
      }),
      kind: "human_promo",
      gameId: params.gameId,
      telegramId: params.telegramId,
      inviteId: params.inviteId,
      owner: params.owner,
      shadowAccount: params.shadowAccount,
      amount: params.amount,
      currency: params.currency,
      status: "pending",
      createdAt: params.now,
      updatedAt: params.now,
    };
  },
  getFaucetEnqueue(operationId: Hex): FaucetEnqueueRecord | undefined {
    return store.faucetEnqueues.get(operationId.toLowerCase());
  },
  putFaucetEnqueue(record: FaucetEnqueueRecord): FaucetEnqueueRecord {
    store.faucetEnqueues.set(record.operationId.toLowerCase(), record);
    return record;
  },
  listPendingFaucetEnqueues(): FaucetEnqueueRecord[] {
    return [...store.faucetEnqueues.values()]
      .filter((r) => r.status === "pending" || r.status === "failed")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  listFaucetEnqueues(): FaucetEnqueueRecord[] {
    return [...store.faucetEnqueues.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
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
  getDepositIntent(depositOpId: string): DepositIntent | undefined {
    return store.depositIntents.get(depositOpId);
  },
  putDepositIntent(intent: DepositIntent): DepositIntent {
    store.depositIntents.set(intent.depositOpId, intent);
    return intent;
  },
  /** test-only reset */
  _reset(): void {
    store.identities.clear();
    store.invitesByTelegram.clear();
    store.registrationsByTelegram.clear();
    store.whispers.clear();
    store.depositIntents.clear();
    store.faucetEnqueues.clear();
  },
};
