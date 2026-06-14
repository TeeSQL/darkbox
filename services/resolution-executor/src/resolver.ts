import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { binaryMarketAbi, marketFactoryAbi } from "./abis.js";
import { MarketStatus, OUTCOME_CODE, type PendingResolution } from "./types.js";

/** Result of an executed on-chain resolution. */
export interface ResolveResult {
  txHash: Hex;
}

/**
 * The on-chain operations the executor depends on. Implemented by the
 * viem-backed `ViemMarketResolver` against the real hidden-chain factory, and by
 * a fake in tests.
 */
export interface MarketResolver {
  /**
   * Execute the EXPLICIT resolution for `intent` on-chain: simulate -> write ->
   * wait. The caller guarantees `intent` has already passed outcome validation,
   * so this never has to infer or default an outcome. Throws on revert.
   */
  resolveMarket(intent: PendingResolution): Promise<ResolveResult>;
  /**
   * Idempotency guard: true if the market is already in a terminal state for
   * this intent, so we must NOT send a second tx. For resolve/void that means
   * the market already reads Resolved or Voided; for closeMarket it means the
   * market is already Closed (or beyond).
   */
  isAlreadyResolved(intent: PendingResolution): Promise<boolean>;
}

export interface ViemResolverConfig {
  rpcUrl: string;
  chainId: number;
  factoryAddress: Address;
  /** Coordinator / factory-owner key. NEVER log this. */
  coordinatorPrivateKey: Hex;
}

function chainFor(id: number, rpc: string) {
  return defineChain({
    id,
    name: `hidden-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

/**
 * Deterministic, non-zero bytes32 anchor recorded on-chain alongside a
 * resolution. The contract does not validate it — it is a stable, auditable
 * fingerprint of (market, outcome) so the same decision always hashes the same.
 */
function resolutionHashFor(intent: PendingResolution): Hex {
  return keccak256(
    stringToHex(`darkbox:resolution:${intent.marketId}:${intent.intentType}:${intent.outcome}`),
  );
}

export class ViemMarketResolver implements MarketResolver {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly factory: Address;

  /** Coordinator address derived from the key — safe to expose/log (NOT the key). */
  readonly coordinatorAddress: Address;

  constructor(cfg: ViemResolverConfig) {
    const account = privateKeyToAccount(cfg.coordinatorPrivateKey);
    this.coordinatorAddress = account.address;
    const chain = chainFor(cfg.chainId, cfg.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.walletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
    this.factory = cfg.factoryAddress;
  }

  async resolveMarket(intent: PendingResolution): Promise<ResolveResult> {
    const account = this.walletClient.account!;
    let txHash: Hex;

    switch (intent.intentType) {
      case "resolveMarket": {
        // Yes/No only. Validation upstream guarantees outcome is Yes or No, so
        // OUTCOME_CODE is 1 or 2 here — never Invalid (the contract reverts on
        // Invalid in resolve()).
        const outcomeCode = OUTCOME_CODE[intent.outcome as "Yes" | "No"];
        const { request } = await this.publicClient.simulateContract({
          account,
          address: this.factory,
          abi: marketFactoryAbi,
          functionName: "resolveMarket",
          args: [intent.marketId, outcomeCode, resolutionHashFor(intent)],
        });
        txHash = await this.walletClient.writeContract(request);
        break;
      }
      case "voidMarket": {
        const { request } = await this.publicClient.simulateContract({
          account,
          address: this.factory,
          abi: marketFactoryAbi,
          functionName: "voidMarket",
          args: [intent.marketId, "admin-resolved-invalid", resolutionHashFor(intent)],
        });
        txHash = await this.walletClient.writeContract(request);
        break;
      }
      case "closeMarket": {
        const { request } = await this.publicClient.simulateContract({
          account,
          address: this.factory,
          abi: marketFactoryAbi,
          functionName: "closeMarket",
          args: [intent.marketId],
        });
        txHash = await this.walletClient.writeContract(request);
        break;
      }
    }

    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash };
  }

  async isAlreadyResolved(intent: PendingResolution): Promise<boolean> {
    // On-chain status is the source of truth for idempotency. (Equivalently we
    // could scan for the market's MarketResolved/MarketVoided logs; the status
    // read is cheaper and crash-safe.)
    const status = await this.publicClient.readContract({
      address: intent.marketAddress,
      abi: binaryMarketAbi,
      functionName: "status",
    });
    if (intent.intentType === "closeMarket") {
      // close is a no-op once trading has already stopped.
      return status >= MarketStatus.Closed;
    }
    return status === MarketStatus.Resolved || status === MarketStatus.Voided;
  }
}
