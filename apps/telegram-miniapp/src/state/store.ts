/**
 * App state store (Preact Signals).
 *
 * Two slices mirroring the backend's auth boundary (see
 * docs/MINIAPP_FRONTEND_ARCHITECTURE.md):
 *
 *   public  — unauthenticated spectator data from the indexer (markets,
 *             leaderboard, game stats). Shared, pollable, safe to cache.
 *   self    — the authenticated player's own gateway state (self-status,
 *             whisper drafts, funding). Per-user.
 *
 * Views read these signals directly and re-render reactively; the `load*`
 * helpers are the single place network results flow into state. No component
 * calls `fetch` or mutates these structures inline.
 */

import { signal, computed } from "@preact/signals";
import { gateway, indexer } from "../api/index.js";
import type { SelfStatus } from "../gatewayClient.js";
import type {
  GameStats,
  LeaderboardEntry,
  MarketRow,
} from "../api/indexer.js";

export type LoadState = "idle" | "loading" | "ready" | "error";

// ── public slice (indexer, no auth) ──────────────────────────────────────
export const game = signal<GameStats | null>(null);
export const markets = signal<MarketRow[]>([]);
export const leaderboard = signal<LeaderboardEntry[]>([]);
export const publicState = signal<LoadState>("idle");
export const publicError = signal<unknown>(null);

// ── self slice (gateway, authed) ─────────────────────────────────────────
export const self = signal<SelfStatus | null>(null);
export const selfState = signal<LoadState>("idle");
export const selfError = signal<unknown>(null);

// ── derived ──────────────────────────────────────────────────────────────
export const isRegistered = computed(
  () => self.value?.registrationStatus === "registered",
);
export const isFunded = computed(
  () => self.value?.fundingStatus === "promo_funded",
);

// ── loaders (the only place results enter state) ─────────────────────────
export async function loadPublic(): Promise<void> {
  publicState.value = "loading";
  publicError.value = null;
  try {
    const [g, m, b] = await Promise.all([
      indexer.game(),
      indexer.markets(),
      indexer.leaderboard(),
    ]);
    game.value = g;
    markets.value = m;
    leaderboard.value = b;
    publicState.value = "ready";
  } catch (err) {
    publicError.value = err;
    publicState.value = "error";
  }
}

export async function loadSelf(): Promise<void> {
  selfState.value = "loading";
  selfError.value = null;
  try {
    self.value = await gateway.selfStatus();
    selfState.value = "ready";
  } catch (err) {
    selfError.value = err;
    selfState.value = "error";
  }
}
