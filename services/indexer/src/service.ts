import type { AgentObservation, Identity, LeaderboardEntry, MarketSnapshot, OrderSnapshot } from '@darkbox/shared';
import { MarketEngine, type PlaceOrderInput, type PlaceOrderResult } from './engine/engine.js';
import type { EngineEvent } from './engine/events.js';
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
  /** Bridge operation ids already applied, for durable deposit/withdraw idempotency. */
  private readonly processedOps = new Set<string>();
  /** Social game state (durable via the same event log; does not touch the ledger). */
  private readonly billboard: { messageId: string; agentId: string; message: string; createdAt: string }[] = [];
  private readonly proposals = new Map<
    string,
    { proposalId: string; agentId: string; question: string; description: string; status: 'proposed' | 'deployed'; marketId?: string }
  >();
  private billboardCounter = 0;
  private proposalCounter = 0;

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

  /**
   * Rebuild engine state by replaying the durable event log. Call once on boot
   * before serving traffic. Replay is side-effect free beyond engine mutation
   * (no events re-appended, no snapshots re-persisted).
   */
  async init(): Promise<void> {
    for (const event of await this.store.loadEngineEvents()) {
      this.apply(event);
    }
  }

  // --- engine mutations (event-sourced) -------------------------------------

  async createMarket(marketId: string, question: string): Promise<void> {
    await this.commit({ type: 'createMarket', marketId, question });
  }

  /** Credit a deposit. With an opId, repeated calls are idempotent (no double-mint). */
  async deposit(agentId: string, amount: number, opId?: string): Promise<boolean> {
    if (opId && this.processedOps.has(opId)) return false;
    await this.commit({ type: 'deposit', agentId, amount, opId });
    return true;
  }

  /** Debit a withdrawal against withdrawable balance. Idempotent per commandId. */
  async withdraw(agentId: string, amount: number, commandId?: string): Promise<boolean> {
    if (commandId && this.processedOps.has(commandId)) return false;
    await this.commit({ type: 'withdraw', agentId, amount, commandId });
    return true;
  }

  async split(agentId: string, marketId: string, amount: number): Promise<void> {
    await this.commit({ type: 'split', agentId, marketId, amount });
  }

  async merge(agentId: string, marketId: string, amount: number): Promise<void> {
    await this.commit({ type: 'merge', agentId, marketId, amount });
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const result = (await this.commit({ type: 'placeOrder', input })) as PlaceOrderResult;
    if (result.fills.length > 0) await this.persistSnapshots();
    return result;
  }

  async cancelOrder(orderId: string, agentId: string): Promise<void> {
    await this.commit({ type: 'cancelOrder', orderId, agentId });
  }

  async resolveMarket(marketId: string, winningOutcome: Outcome): Promise<void> {
    await this.commit({ type: 'resolveMarket', marketId, winningOutcome });
    await this.persistSnapshots();
  }

  // --- social game state ----------------------------------------------------

  async postBillboard(agentId: string, message: string): Promise<string> {
    const messageId = `b${(this.billboardCounter += 1)}`;
    await this.commit({ type: 'postBillboard', messageId, agentId, message, createdAt: new Date().toISOString() });
    return messageId;
  }

  async proposeMarket(agentId: string, question: string, description: string): Promise<string> {
    const proposalId = `p${(this.proposalCounter += 1)}`;
    await this.commit({ type: 'proposeMarket', proposalId, agentId, question, description, createdAt: new Date().toISOString() });
    return proposalId;
  }

  /** Approve a proposal and deploy it as a tradeable market. */
  async approveProposal(proposalId: string, marketId = proposalId): Promise<void> {
    if (!this.proposals.has(proposalId)) throw new Error(`unknown proposal: ${proposalId}`);
    await this.commit({ type: 'approveProposal', proposalId, marketId });
  }

  /**
   * Apply to the engine first, then append to the log. The engine validates
   * synchronously and throws (EngineError) on bad input before we ever write,
   * so the log never contains an event the engine would reject — replay is
   * always clean. The narrow risk is a successful apply followed by a failed
   * append (e.g. DB down): that surfaces as a 5xx and is the rare case to
   * reconcile, in exchange for never corrupting the replay log on validation
   * errors (the common case).
   */
  private async commit(event: EngineEvent): Promise<PlaceOrderResult | void> {
    const result = this.apply(event);
    await this.store.appendEngineEvent(event);
    return result;
  }

  /** Apply an event to the engine. Used by both live commits and replay. */
  private apply(event: EngineEvent): PlaceOrderResult | void {
    switch (event.type) {
      case 'createMarket':
        return this.engine.createMarket(event.marketId, event.question), undefined;
      case 'deposit':
        if (event.opId) this.processedOps.add(event.opId);
        return this.engine.deposit(event.agentId, event.amount);
      case 'withdraw':
        if (event.commandId) this.processedOps.add(event.commandId);
        return this.engine.withdraw(event.agentId, event.amount);
      case 'split':
        return this.engine.split(event.agentId, event.marketId, event.amount);
      case 'merge':
        return this.engine.merge(event.agentId, event.marketId, event.amount);
      case 'placeOrder':
        return this.engine.placeOrder(event.input);
      case 'cancelOrder':
        return this.engine.cancelOrder(event.orderId, event.agentId);
      case 'resolveMarket':
        return this.engine.resolveMarket(event.marketId, event.winningOutcome);
      case 'postBillboard':
        this.billboard.push({ messageId: event.messageId, agentId: event.agentId, message: event.message, createdAt: event.createdAt });
        this.billboardCounter = Math.max(this.billboardCounter, Number(event.messageId.slice(1)));
        return undefined;
      case 'proposeMarket':
        this.proposals.set(event.proposalId, {
          proposalId: event.proposalId,
          agentId: event.agentId,
          question: event.question,
          description: event.description,
          status: 'proposed',
        });
        this.proposalCounter = Math.max(this.proposalCounter, Number(event.proposalId.slice(1)));
        return undefined;
      case 'approveProposal': {
        const proposal = this.proposals.get(event.proposalId);
        if (proposal) {
          proposal.status = 'deployed';
          proposal.marketId = event.marketId;
          this.engine.createMarket(event.marketId, proposal.question);
        }
        return undefined;
      }
    }
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
      billboardSinceLastTurn: this.recentBillboard(),
      marketProposals: [...this.proposals.values()].map((proposal) => ({
        proposalId: proposal.proposalId,
        agentId: proposal.agentId,
        question: proposal.question,
        status: proposal.status,
      })),
      sharedContext: [],
    };
  }

  /** Recent public billboard messages (newest last), capped. */
  recentBillboard(limit = 50): { messageId: string; agentId: string; message: string; createdAt: string }[] {
    return this.billboard.slice(-limit);
  }

  /** Public, visibility-safe activity feed: billboard + market list + aggregates. */
  activity(): {
    billboard: { messageId: string; agentId: string; message: string; createdAt: string }[];
    markets: MarketSnapshot[];
    proposals: { proposalId: string; question: string; status: string }[];
  } {
    return {
      billboard: this.recentBillboard(),
      markets: this.marketSnapshots(),
      proposals: [...this.proposals.values()].map((p) => ({ proposalId: p.proposalId, question: p.question, status: p.status })),
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
