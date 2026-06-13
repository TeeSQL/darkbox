import type { Address, Hex } from "viem";

/**
 * Cross-chain liquidity rebalancing for withdrawals (spec section 7).
 *
 * Withdrawals only ever move PUBLIC escrow liquidity between chains so the
 * user-selected destination bridge can pay out. Rebalancing NEVER mints shadow
 * USDC and NEVER changes game balances — the shadow burn has already removed
 * the funds from the user's spendable balance before any rebalance runs.
 */

export type RebalanceProvider = "circle-cctp" | "chainlink-ccip" | "lifi" | "manual";

/**
 * Rebalance lifecycle. The signing service may only authorize a payout once the
 * destination escrow is fundable (`not_needed` or `destination_funded`).
 */
export type RebalanceStatus =
  | "not_needed" // destination escrow already has enough liquidity
  | "required" // a move is needed; no route submitted yet
  | "route_selected" // a provider route has been chosen
  | "source_transfer_submitted" // the move is in flight
  | "destination_funded" // destination escrow now has enough liquidity
  | "failed_needs_operator_reconcile"; // no route / move failed; operator must act

export interface DestinationLiquidityRequest {
  withdrawalId: Hex;
  destinationChainId: bigint;
  destinationBridge: Address;
  amount: bigint;
}

export interface DestinationLiquidityResult {
  status: RebalanceStatus;
  provider?: RebalanceProvider;
  rebalanceRef?: Hex;
}

/** True iff the destination escrow can pay now (signing is allowed). */
export function isFundedStatus(status: RebalanceStatus): boolean {
  return status === "not_needed" || status === "destination_funded";
}

/**
 * Ensures the destination public escrow can pay a withdrawal.
 * `ensureDestinationLiquidity` DRIVES the rebalance (may submit a provider
 * route) and returns the current status; it must be idempotent per
 * `withdrawalId`. `isDestinationFunded` is a READ-ONLY check the signing
 * service uses as its final guard before issuing an authorization.
 */
export interface DestinationLiquidityManager {
  ensureDestinationLiquidity(
    request: DestinationLiquidityRequest,
  ): Promise<DestinationLiquidityResult>;
  isDestinationFunded(request: DestinationLiquidityRequest): Promise<boolean>;
}

export class DestinationLiquidityUnavailable extends Error {
  constructor(readonly result: DestinationLiquidityResult) {
    super(`destination liquidity unavailable: ${result.status}`);
    this.name = "DestinationLiquidityUnavailable";
  }
}

/** MVP default: destination escrow is assumed funded (single-chain / pre-funded). */
export class NoopDestinationLiquidityManager implements DestinationLiquidityManager {
  async ensureDestinationLiquidity(): Promise<DestinationLiquidityResult> {
    return { status: "not_needed" };
  }
  async isDestinationFunded(): Promise<boolean> {
    return true;
  }
}

/** Reads the destination escrow's spendable USDC balance (per chain+bridge). */
export interface DestinationEscrowReader {
  balanceOf(chainId: bigint, bridge: Address): Promise<bigint>;
}

/**
 * Liquidity manager backed by static, pre-seeded balances. Does not rebalance:
 * if the destination is short it reports `failed_needs_operator_reconcile`.
 */
export class StaticBalanceLiquidityManager implements DestinationLiquidityManager {
  constructor(private readonly balances: Map<string, bigint>) {}

  private key(chainId: bigint, bridge: Address): string {
    return `${chainId}:${bridge.toLowerCase()}`;
  }

  async ensureDestinationLiquidity(
    req: DestinationLiquidityRequest,
  ): Promise<DestinationLiquidityResult> {
    const balance = this.balances.get(this.key(req.destinationChainId, req.destinationBridge)) ?? 0n;
    if (balance >= req.amount) return { status: "not_needed" };
    return { status: "failed_needs_operator_reconcile", provider: "manual" };
  }

  async isDestinationFunded(req: DestinationLiquidityRequest): Promise<boolean> {
    const balance = this.balances.get(this.key(req.destinationChainId, req.destinationBridge)) ?? 0n;
    return balance >= req.amount;
  }
}

// ---------------------------------------------------------------------------
// Provider adapters (Circle CCTP / Chainlink CCIP / LI.FI)
// ---------------------------------------------------------------------------

export interface RouteQuote {
  provider: RebalanceProvider;
  /** estimated fee in USDC base units */
  fee: bigint;
  etaSeconds: number;
}

export interface SubmittedRoute {
  provider: RebalanceProvider;
  rebalanceRef: Hex;
}

/**
 * A cross-chain USDC transport provider. MVP ships stubs; the coordinator and
 * manager already model the route lifecycle, so a real adapter is a drop-in.
 */
export interface LiquidityRouteProvider {
  readonly name: RebalanceProvider;
  /** Returns a quote, or null if this provider cannot serve the route. */
  quote(req: DestinationLiquidityRequest): Promise<RouteQuote | null>;
  /** Submits the source-side transfer; returns a tracking ref. */
  submit(req: DestinationLiquidityRequest): Promise<SubmittedRoute>;
  /** Current status of a previously submitted route. */
  status(rebalanceRef: Hex): Promise<RebalanceStatus>;
}

export class NotImplementedProviderError extends Error {
  constructor(provider: RebalanceProvider, op: string) {
    super(`${provider} ${op} not implemented in MVP`);
    this.name = "NotImplementedProviderError";
  }
}

/** Circle Cross-Chain Transfer Protocol adapter (MVP stub). */
export class CircleCctpProvider implements LiquidityRouteProvider {
  readonly name = "circle-cctp" as const;
  async quote(): Promise<RouteQuote | null> {
    throw new NotImplementedProviderError(this.name, "quote");
  }
  async submit(): Promise<SubmittedRoute> {
    throw new NotImplementedProviderError(this.name, "submit");
  }
  async status(): Promise<RebalanceStatus> {
    throw new NotImplementedProviderError(this.name, "status");
  }
}

/** Chainlink CCIP adapter (MVP stub). */
export class ChainlinkCcipProvider implements LiquidityRouteProvider {
  readonly name = "chainlink-ccip" as const;
  async quote(): Promise<RouteQuote | null> {
    throw new NotImplementedProviderError(this.name, "quote");
  }
  async submit(): Promise<SubmittedRoute> {
    throw new NotImplementedProviderError(this.name, "submit");
  }
  async status(): Promise<RebalanceStatus> {
    throw new NotImplementedProviderError(this.name, "status");
  }
}

/** LI.FI adapter (MVP stub). */
export class LiFiProvider implements LiquidityRouteProvider {
  readonly name = "lifi" as const;
  async quote(): Promise<RouteQuote | null> {
    throw new NotImplementedProviderError(this.name, "quote");
  }
  async submit(): Promise<SubmittedRoute> {
    throw new NotImplementedProviderError(this.name, "submit");
  }
  async status(): Promise<RebalanceStatus> {
    throw new NotImplementedProviderError(this.name, "status");
  }
}

/**
 * Liquidity manager that moves public escrow via a {@link LiquidityRouteProvider}
 * when the destination is short. Tracks per-withdrawal route state in memory so
 * repeated `ensureDestinationLiquidity` calls advance/observe the same route
 * (idempotent per `withdrawalId`) rather than submitting twice.
 */
export class ProviderBackedLiquidityManager implements DestinationLiquidityManager {
  private routes = new Map<string, SubmittedRoute>();

  constructor(
    private readonly provider: LiquidityRouteProvider,
    private readonly reader: DestinationEscrowReader,
  ) {}

  async ensureDestinationLiquidity(
    req: DestinationLiquidityRequest,
  ): Promise<DestinationLiquidityResult> {
    const balance = await this.reader.balanceOf(req.destinationChainId, req.destinationBridge);
    if (balance >= req.amount) return { status: "not_needed" };

    const existing = this.routes.get(req.withdrawalId.toLowerCase());
    if (existing) {
      const status = await this.provider.status(existing.rebalanceRef);
      return { status, provider: existing.provider, rebalanceRef: existing.rebalanceRef };
    }

    const quote = await this.provider.quote(req);
    if (!quote) {
      return { status: "failed_needs_operator_reconcile", provider: this.provider.name };
    }
    const route = await this.provider.submit(req);
    this.routes.set(req.withdrawalId.toLowerCase(), route);
    const status = await this.provider.status(route.rebalanceRef);
    return { status, provider: route.provider, rebalanceRef: route.rebalanceRef };
  }

  async isDestinationFunded(req: DestinationLiquidityRequest): Promise<boolean> {
    const balance = await this.reader.balanceOf(req.destinationChainId, req.destinationBridge);
    if (balance >= req.amount) return true;
    const existing = this.routes.get(req.withdrawalId.toLowerCase());
    if (!existing) return false;
    return (await this.provider.status(existing.rebalanceRef)) === "destination_funded";
  }
}
