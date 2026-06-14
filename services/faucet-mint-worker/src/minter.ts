import type { ShadowMintSubmitter } from "@darkbox/bridge";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { shadowBridgeControllerAbi, shadowMintedEvent } from "./abis.js";

export interface ViemFaucetMinterConfig {
  rpcUrl: string;
  chainId: number;
  /** ShadowBridgeController address (the mint target). */
  controllerAddress: Address;
  /** Coordinator/minter key — passed straight to viem, never logged. */
  coordinatorPrivateKey: Hex;
  /** Earliest block to scan for findExistingMint (default 0). */
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
 * viem-backed {@link ShadowMintSubmitter} for the faucet worker. Drives the real
 * `ShadowBridgeController.mintShadow(...)` on the hidden chain, keyed by the
 * faucet `operationId` (passed as `depositOpId`). Mirrors the bridge's
 * `ViemShadowMintSubmitter` (services/bridge/src/chain/adapters.ts) but owns its
 * own viem client construction like the market-executor factory client.
 *
 * Idempotency: `findExistingMint(operationId)` scans `ShadowMinted` logs so a
 * crash-recovered or duplicate record re-uses the existing tx instead of minting
 * a second time. The controller also reverts on replay, so it is belt-and-braces.
 */
export class ViemFaucetMinter implements ShadowMintSubmitter {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly controller: Address;
  private readonly fromBlock: bigint;

  /** Coordinator address derived from the key — safe to log (NOT the key). */
  readonly coordinatorAddress: Address;

  constructor(cfg: ViemFaucetMinterConfig) {
    const account = privateKeyToAccount(cfg.coordinatorPrivateKey);
    this.coordinatorAddress = account.address;
    const chain = chainFor(cfg.chainId, cfg.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.walletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
    this.controller = cfg.controllerAddress;
    this.fromBlock = cfg.fromBlock ?? 0n;
  }

  async mintShadow(p: {
    depositOpId: Hex;
    owner: Address;
    shadowAccount: Hex;
    amount: bigint;
  }): Promise<{ txHash: Hex }> {
    const account = this.walletClient.account!;
    const { request } = await this.publicClient.simulateContract({
      account,
      address: this.controller,
      abi: shadowBridgeControllerAbi,
      functionName: "mintShadow",
      args: [p.depositOpId, p.owner, p.shadowAccount, p.amount],
    });
    const txHash = await this.walletClient.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash };
  }

  async findExistingMint(depositOpId: Hex): Promise<Hex | null> {
    const logs = await this.publicClient.getLogs({
      address: this.controller,
      event: shadowMintedEvent,
      args: { depositOpId },
      fromBlock: this.fromBlock,
      toBlock: "latest",
    });
    return logs[0]?.transactionHash ?? null;
  }
}
