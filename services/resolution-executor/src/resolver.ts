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
import { marketFactoryAbi, marketResolvedEvent, marketVoidedEvent } from "./abis.js";
import { OUTCOME_CODE, type PendingResolution } from "./types.js";

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
   * Idempotency lookup: return the tx hash of the resolution/void already
   * applied on-chain for this intent, or `null` if none exists yet. Scans the
   * market's `MarketResolved`/`MarketVoided` logs (mirrors the faucet worker's
   * `findExistingMint`). Used so a crash-recovered or re-sourced market records
   * the REAL existing tx instead of sending a second one (which would revert) —
   * and so the settlement write-back never has to post a null hash.
   */
  findExistingResolutionTx(intent: PendingResolution): Promise<Hex | null>;
}

export interface ViemResolverConfig {
  rpcUrl: string;
  chainId: number;
  factoryAddress: Address;
  /** Coordinator / factory-owner key. NEVER log this. */
  coordinatorPrivateKey: Hex;
  /** Earliest block to scan for findExistingResolutionTx logs (default 0). */
  fromBlock?: bigint;
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
  private readonly fromBlock: bigint;

  /** Coordinator address derived from the key — safe to expose/log (NOT the key). */
  readonly coordinatorAddress: Address;

  constructor(cfg: ViemResolverConfig) {
    const account = privateKeyToAccount(cfg.coordinatorPrivateKey);
    this.coordinatorAddress = account.address;
    const chain = chainFor(cfg.chainId, cfg.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.walletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
    this.factory = cfg.factoryAddress;
    this.fromBlock = cfg.fromBlock ?? 0n;
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
    }

    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash };
  }

  async findExistingResolutionTx(intent: PendingResolution): Promise<Hex | null> {
    // The market emits MarketResolved (for resolve) / MarketVoided (for void),
    // keyed by the indexed marketId. Find the existing settlement tx so we record
    // the REAL hash rather than sending a duplicate (which reverts BadStatus) or
    // posting a null hash to complete-resolution.
    const event = intent.intentType === "voidMarket" ? marketVoidedEvent : marketResolvedEvent;
    const logs = await this.publicClient.getLogs({
      address: intent.marketAddress,
      event,
      args: { marketId: intent.marketId },
      fromBlock: this.fromBlock,
      toBlock: "latest",
    });
    return logs[0]?.transactionHash ?? null;
  }
}
