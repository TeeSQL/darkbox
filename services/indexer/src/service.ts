import type { AgentObservation, Identity, LeaderboardEntry, MarketSnapshot, OrderSnapshot } from '@darkbox/shared';
import { MarketEngine, type PlaceOrderInput, type PlaceOrderResult } from './engine/engine.js';
import type { Outcome } from './engine/types.js';
import { IdentityRepository, type RegisterIdentityInput } from './identity.js';
import type { Store } from './store.js';

function fmt(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, '') || '0';
}

/**
 * Ties together the three concerns of the indexer: the off-chain identity
 * registry (Postgres), the canonical execution engine (in-process), and the
 * derived views the public/internal APIs serve. The engine is the source of
 * truth for balances/PnL; identities supply the daemon names; snapshots are
 * persisted at meaningful checkpoints for durability and the reveal bundle.
 */
export class IndexerService {
  readonly engine = new MarketEngine();
  private readonly identities: IdentityRepository;

  constructor(private readonly store: Store) {
    this.identities = new IdentityRepository(store);
  }

  // --- identity -------------------------------------------------------------

  registerIdentity(input: RegisterIdentityInput): Promise<Identity> {
    return this.identities.register(input);
  }

  getIdentityByShadowAccount(shadowAccount: string): Promise<Identity | null> {
    return this.identities.getByShadowAccount(shadowAccount);
  }

  getIdentityByTelegramUserId(telegramUserId: string): Promise<Identity | null> {
    return this.identities.getByTelegramUserId(telegramUserId);
  }

  // --- engine mutations -----------------------------------------------------

  createMarket(marketId: string, question: string): void {
    this.engine.createMarket(marketId, question);
  }

  deposit(agentId: string, amount: number): void {
    this.engine.deposit(agentId, amount);
  }

  split(agentId: string, marketId: string, amount: number): void {
    this.engine.split(agentId, marketId, amount);
  }

  merge(agentId: string, marketId: string, amount: number): void {
    this.engine.merge(agentId, marketId, amount);
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const result = this.engine.placeOrder(input);
    if (result.fills.length > 0) await this.persistSnapshots();
    return result;
  }

  cancelOrder(orderId: string, agentId: string): void {
    this.engine.cancelOrder(orderId, agentId);
  }

  async resolveMarket(marketId: string, winningOutcome: Outcome): Promise<void> {
    this.engine.resolveMarket(marketId, winningOutcome);
    await this.persistSnapshots();
  }

  // --- derived views --------------------------------------------------------

  async leaderboard(): Promise<LeaderboardEntry[]> {
    const rows = this.engine.leaderboard();
    const entries = await Promise.all(
      rows.map(async (row, index) => {
        const identity = await this.store.getIdentityByAgentId(row.agentId);
        return {
          agentId: row.agentId as LeaderboardEntry['agentId'],
          daemonName: identity?.daemonName ?? row.agentId,
          ensName: identity?.ensName,
          startingBalance: fmt(row.startingBalance),
          currentEquity: fmt(row.currentEquity),
          pnl: fmt(row.pnl),
          rank: index + 1,
        } satisfies LeaderboardEntry;
      }),
    );
    return entries;
  }

  marketSnapshots(): MarketSnapshot[] {
    return this.engine.listMarkets().map((market) => {
      // Surface the YES book as the canonical market price view.
      const top = this.engine.topOfBook(market.marketId, 'YES');
      return {
        marketId: market.marketId,
        question: market.question,
        status: market.status,
        bestBid: top.bestBid === null ? null : fmt(top.bestBid),
        bestAsk: top.bestAsk === null ? null : fmt(top.bestAsk),
        lastPrice: market.lastPrice.YES === null ? null : fmt(market.lastPrice.YES),
      } satisfies MarketSnapshot;
    });
  }

  /** Build the per-turn observation an agent sees (full internal visibility). */
  observation(agentId: string, turn: number): AgentObservation {
    const balance = this.engine.getBalance(agentId);
    // Agents have full internal visibility of the book (spec §9.2), so expose
    // every resting order, not just the agent's own.
    const orders: OrderSnapshot[] = this.engine.listOpenOrders().map((order) => ({
      orderId: order.orderId,
      marketId: order.marketId,
      agentId: order.agentId,
      side: order.side,
      outcome: order.outcome,
      price: fmt(order.price),
      size: fmt(order.size),
      remainingSize: fmt(order.remaining),
    }));
    return {
      agentId,
      turn,
      now: new Date().toISOString(),
      markets: this.marketSnapshots(),
      orders,
      balances: [{ agentId, available: fmt(balance.available), equity: fmt(this.engine.equity(agentId)) }],
      billboardSinceLastTurn: [],
      marketProposals: [],
      sharedContext: [],
    };
  }

  // --- persistence ----------------------------------------------------------

  /** Persist a leaderboard snapshot per agent that has an identity row. */
  private async persistSnapshots(): Promise<void> {
    for (const row of this.engine.leaderboard()) {
      const identity = await this.store.getIdentityByAgentId(row.agentId);
      if (!identity) continue; // snapshot table is FK'd to identity.shadow_account
      await this.store.upsertLeaderboardSnapshot({
        agentId: row.agentId,
        shadowAccount: identity.shadowAccount,
        startingBalance: fmt(row.startingBalance),
        currentEquity: fmt(row.currentEquity),
        pnl: fmt(row.pnl),
      });
    }
  }
}
