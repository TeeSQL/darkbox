import type { Address, Hex, PublicClient, WalletClient } from "viem";
import {
  InsufficientAvailableError,
  type ShadowBurnSubmitter,
  type ShadowMintSubmitter,
} from "../shadow.js";
import type { NonceChecker, ShadowBurnVerifier } from "../signingService.js";
import { darkBoxBridgeAbi, shadowBridgeControllerAbi } from "./abis.js";

/**
 * Viem-backed implementations of the shadow-side and public-side interfaces the
 * bridge service depends on. These talk to the real `ShadowBridgeController` and
 * `DarkBoxBridge` contracts; the in-memory `FakeShadowChain` mirrors them for
 * unit tests.
 */

export interface ShadowClientConfig {
  publicClient: PublicClient;
  walletClient: WalletClient;
  controller: Address;
  /** Earliest block to scan for idempotency/event lookups. */
  fromBlock?: bigint;
  /** Confirmations required before a burn counts as confirmed (default 1). */
  confirmations?: number;
}

export class ViemShadowMintSubmitter implements ShadowMintSubmitter {
  constructor(private readonly cfg: ShadowClientConfig) {}

  async mintShadow(p: {
    depositOpId: Hex;
    owner: Address;
    shadowAccount: Hex;
    asset: Address;
    amount: bigint;
  }): Promise<{ txHash: Hex }> {
    const account = this.cfg.walletClient.account!;
    const { request } = await this.cfg.publicClient.simulateContract({
      account,
      address: this.cfg.controller,
      abi: shadowBridgeControllerAbi,
      functionName: "mintShadow",
      args: [p.depositOpId, p.owner, p.shadowAccount, p.asset, p.amount],
    });
    const txHash = await this.cfg.walletClient.writeContract(request);
    await this.cfg.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash };
  }

  async findExistingMint(depositOpId: Hex): Promise<Hex | null> {
    const logs = await this.cfg.publicClient.getLogs({
      address: this.cfg.controller,
      event: shadowBridgeControllerAbi[7], // ShadowMinted
      args: { depositOpId },
      fromBlock: this.cfg.fromBlock ?? 0n,
      toBlock: "latest",
    });
    return logs[0]?.transactionHash ?? null;
  }
}

export class ViemShadowBurnSubmitter
  implements ShadowBurnSubmitter, ShadowBurnVerifier
{
  constructor(private readonly cfg: ShadowClientConfig) {}

  async withdrawableBalance(shadowAccount: Hex, asset: Address): Promise<bigint> {
    return this.cfg.publicClient.readContract({
      address: this.cfg.controller,
      abi: shadowBridgeControllerAbi,
      functionName: "withdrawableBalance",
      args: [shadowAccount, asset],
    });
  }

  async burnForWithdrawal(p: {
    withdrawalId: Hex;
    owner: Address;
    shadowAccount: Hex;
    asset: Address;
    amount: bigint;
    userCommandHash: Hex;
  }): Promise<{ shadowBurnRef: Hex }> {
    // Surface insufficient-available as a typed rejection (not a raw revert) so
    // the coordinator rejects the command instead of retrying.
    const available = await this.withdrawableBalance(p.shadowAccount, p.asset);
    if (available < p.amount) {
      throw new InsufficientAvailableError(
        p.shadowAccount,
        p.asset,
        p.amount,
        available,
      );
    }

    const account = this.cfg.walletClient.account!;
    const { request } = await this.cfg.publicClient.simulateContract({
      account,
      address: this.cfg.controller,
      abi: shadowBridgeControllerAbi,
      functionName: "burnForWithdrawal",
      args: [
        p.withdrawalId,
        p.owner,
        p.shadowAccount,
        p.asset,
        p.amount,
        p.userCommandHash,
      ],
    });
    const txHash = await this.cfg.walletClient.writeContract(request);
    await this.cfg.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { shadowBurnRef: txHash };
  }

  async findExistingBurn(withdrawalId: Hex): Promise<Hex | null> {
    const log = await this.findBurnLog(withdrawalId);
    return log?.transactionHash ?? null;
  }

  async hasConfirmedBurn(p: {
    withdrawalId: Hex;
    shadowBurnRef: Hex;
    asset: Address;
    amount: bigint;
  }): Promise<boolean> {
    const log = await this.findBurnLog(p.withdrawalId);
    if (!log) return false;
    if (log.args.asset?.toLowerCase() !== p.asset.toLowerCase()) return false;
    if (log.args.amount !== p.amount) return false;

    const required = BigInt(this.cfg.confirmations ?? 1);
    const head = await this.cfg.publicClient.getBlockNumber();
    return head - log.blockNumber + 1n >= required;
  }

  private async findBurnLog(withdrawalId: Hex) {
    const logs = await this.cfg.publicClient.getLogs({
      address: this.cfg.controller,
      event: shadowBridgeControllerAbi[8], // ShadowBurned
      args: { withdrawalId },
      fromBlock: this.cfg.fromBlock ?? 0n,
      toBlock: "latest",
    });
    return logs[0] ?? null;
  }
}

/** Reads used-nonce state from the public bridge contract. */
export class ViemNonceChecker implements NonceChecker {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly bridge: Address,
  ) {}

  async isNonceUsed(owner: Address, nonce: bigint): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.bridge,
      abi: darkBoxBridgeAbi,
      functionName: "usedNonces",
      args: [owner, nonce],
    });
  }
}
