/**
 * Replay data model.
 *
 * This is a SUPERSET of the canonical DarkBox reveal bundle
 * (`services/reveal/src/types.ts` -> RevealBundle): same meta / markets /
 * leaderboard / agents / timeline event vocabulary, plus the dense time-series a
 * cinematic replay needs (per-market price curves, TVL-over-time) and the
 * billboard posts. A real reveal bundle can be adapted into this shape; until
 * then `scripts/gen.ts` emits a deterministic mock at `public/replay.json`.
 *
 * Timeline event `type` vocabulary mirrors services/reveal/src/timeline.ts:
 *   player_joined, invite_claimed, deposit_received, instruction_committed,
 *   market_created, split, order_placed, trade, position_opened,
 *   position_closed, market_resolved, leaderboard_update, reveal_opened,
 *   settlement_exported
 */

/** Milliseconds since UNIX epoch. */
export type Millis = number;

export interface ReplayMeta {
  gameId: string;
  title: string;
  productName: string;
  seasonLabel: string;
  ensDomain: string;
  /** Game wall-clock window. The replay compresses [startTime, endTime] into a video. */
  startTime: Millis;
  endTime: Millis;
  /** Human label for the arena, shown on the title card. */
  arena: string;
}

export interface Player {
  agentId: string;
  ensName: string;
  /** Short display handle. */
  name: string;
  /** Public daemon epithet, shown post-reveal. */
  epithet: string;
  /** Public award/reel label. */
  awardHint?: string;
  /** Looping portrait video path, public and post-reveal safe. */
  videoSrc?: string;
  /** Stable hue 0..360 for this daemon's colour identity. */
  hue: number;
  joinedAt: Millis;
  /** USDC the human deposited / was credited. */
  deposited: number;
  /** One-line whisper flavour (revealed after the box opens). */
  blurb: string;
}

export interface Market {
  marketId: string;
  question: string;
  creatorAgentId: string;
  createdAt: Millis;
  resolvedAt?: Millis;
  /** 'Yes' | 'No' | 'Invalid' once resolved. */
  outcome?: 'Yes' | 'No' | 'Invalid';
}

/** A sampled YES price (0..1 probability) for one market at time t. */
export interface PricePoint {
  marketId: string;
  t: Millis;
  yes: number;
}

/** Total value locked sample. */
export interface TvlPoint {
  t: Millis;
  tvl: number;
}

export interface Trade {
  t: Millis;
  marketId: string;
  agentId: string;
  side: 'buy' | 'sell';
  outcome: 'Yes' | 'No';
  /** Outcome-token size. */
  size: number;
  /** Price paid (0..1). */
  price: number;
  /** Notional USDC moved. */
  notional: number;
}

export interface BillboardPost {
  t: Millis;
  agentId: string;
  message: string;
  /** Author flags their own zinger; the replay gives these hero treatment. */
  spicy?: boolean;
}

export interface TimelineEvent {
  t: Millis;
  type: string;
  [k: string]: unknown;
}

export interface ReplayBundle {
  meta: ReplayMeta;
  players: Player[];
  markets: Market[];
  prices: PricePoint[];
  tvl: TvlPoint[];
  trades: Trade[];
  billboard: BillboardPost[];
  timeline: TimelineEvent[];
}
