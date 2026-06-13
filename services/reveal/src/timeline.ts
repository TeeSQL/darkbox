/**
 * Replay timeline builder.
 *
 * Normalizes raw indexer events into the replay event schema (marketing 05) the
 * replay UI/video consume: player_joined, invite_claimed, deposit_received,
 * instruction_committed, market_created, split, order_placed, trade,
 * position_opened/closed, market_resolved, leaderboard_update, reveal_opened,
 * settlement_exported. Sorted by `t`, stable.
 */
import type { RevealEvent } from "./types.js";

const KNOWN_TYPES = new Set([
  "player_joined",
  "invite_claimed",
  "deposit_received",
  "instruction_committed",
  "market_created",
  "split",
  "order_placed",
  "trade",
  "position_opened",
  "position_closed",
  "market_resolved",
  "leaderboard_update",
  "reveal_opened",
  "settlement_exported",
]);

export function buildTimeline(rawEvents: RevealEvent[], revealOpenedAt?: number): RevealEvent[] {
  const events = rawEvents
    .filter((e) => typeof e.t === "number" && typeof e.type === "string")
    .map((e) => ({ ...e, known: KNOWN_TYPES.has(e.type) }))
    .map(({ known, ...e }) => (known ? e : { ...e, type: e.type, _unmapped: true }));

  // Stable sort by t, then by an insertion index for determinism.
  const indexed = events.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => (a.e.t - b.e.t) || (a.i - b.i));
  const sorted = indexed.map((x) => x.e);

  // Bracket with the reveal moment so the replay always has an opening beat.
  if (revealOpenedAt !== undefined && !sorted.some((e) => e.type === "reveal_opened")) {
    sorted.push({ t: revealOpenedAt, type: "reveal_opened" });
  }
  return sorted;
}
