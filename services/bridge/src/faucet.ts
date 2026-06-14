import {
  daemonFundingOperationId,
  daemonFundingOperationString,
  FaucetMintState,
  humanPromoOperationId,
  humanPromoOperationString,
} from "@darkbox/shared";
import type { Address, Hex } from "viem";
import type { ShadowMintSubmitter } from "./shadow.js";
import type { BridgeStore } from "./store.js";
import type { FaucetMintRecord } from "./types.js";

export interface FaucetCoordinatorConfig {
  gameId: Hex;
  amount: bigint;
}

export interface HumanPromoFaucetRequest {
  telegramId: string;
  inviteId: string;
  owner: Address;
  shadowAccount: Hex;
  requestedAt?: string;
}

export interface DaemonFundingFaucetRequest {
  daemonId: string;
  daemonAddress: Address;
  shadowAccount: Hex;
  requestedAt?: string;
}

export class FaucetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaucetConflictError";
  }
}

/**
 * Durable faucet ledger/queue coordinator.
 *
 * The queue is intentionally separate from public deposits: promo and daemon
 * funding are bridge-authorized shadow mints with their own idempotency keys.
 * Actual mint submission still goes through the bridge/signer trust boundary.
 */
export class FaucetCoordinator {
  constructor(
    private readonly cfg: FaucetCoordinatorConfig,
    private readonly store: BridgeStore,
    private readonly minter: ShadowMintSubmitter,
  ) {}

  enqueueHumanPromo(req: HumanPromoFaucetRequest): FaucetMintRecord {
    const operationString = humanPromoOperationString({
      gameId: this.cfg.gameId,
      telegramId: req.telegramId,
    });
    const operationId = humanPromoOperationId({
      gameId: this.cfg.gameId,
      telegramId: req.telegramId,
    });
    const existing = this.store.getFaucetMint(operationId);
    if (existing) return existing;

    const byTelegram = this.store.getHumanPromoMint(this.cfg.gameId, req.telegramId);
    if (byTelegram) return byTelegram;

    const now = req.requestedAt ?? new Date().toISOString();
    const record: FaucetMintRecord = {
      operationId,
      operationString,
      kind: "human_promo",
      gameId: this.cfg.gameId,
      amount: this.cfg.amount,
      owner: req.owner,
      shadowAccount: req.shadowAccount,
      state: FaucetMintState.Pending,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      telegramId: req.telegramId,
      inviteId: req.inviteId,
    };
    this.store.putFaucetMint(record);
    return record;
  }

  enqueueDaemonFunding(req: DaemonFundingFaucetRequest): FaucetMintRecord {
    const existingDaemon = this.store.getDaemonFundingMint(this.cfg.gameId, req.daemonId);
    if (existingDaemon) return this.assertSameDaemon(existingDaemon, req);

    const existingAddress = this.store.getDaemonFundingMintByAddress(
      this.cfg.gameId,
      req.daemonAddress,
    );
    if (existingAddress) return this.assertSameDaemon(existingAddress, req);

    const existingShadow = this.store.getDaemonFundingMintByShadow(
      this.cfg.gameId,
      req.shadowAccount,
    );
    if (existingShadow) return this.assertSameDaemon(existingShadow, req);

    const operationString = daemonFundingOperationString({
      gameId: this.cfg.gameId,
      daemonId: req.daemonId,
      daemonAddress: req.daemonAddress,
      shadowAccount: req.shadowAccount,
    });
    const operationId = daemonFundingOperationId({
      gameId: this.cfg.gameId,
      daemonId: req.daemonId,
      daemonAddress: req.daemonAddress,
      shadowAccount: req.shadowAccount,
    });
    const now = req.requestedAt ?? new Date().toISOString();
    const record: FaucetMintRecord = {
      operationId,
      operationString,
      kind: "daemon_funding",
      gameId: this.cfg.gameId,
      amount: this.cfg.amount,
      owner: req.daemonAddress,
      shadowAccount: req.shadowAccount,
      state: FaucetMintState.Pending,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      daemonId: req.daemonId,
      daemonAddress: req.daemonAddress,
    };
    this.store.putFaucetMint(record);
    return record;
  }

  listPending(limit?: number): FaucetMintRecord[] {
    return this.store.listPendingFaucetMints(limit);
  }

  async processNext(now = new Date().toISOString()): Promise<FaucetMintRecord | null> {
    const [record] = this.store.listPendingFaucetMints(1);
    if (!record) return null;
    return this.process(record.operationId, now);
  }

  async process(operationId: Hex, now = new Date().toISOString()): Promise<FaucetMintRecord> {
    const existing = this.store.getFaucetMint(operationId);
    if (!existing) throw new Error(`unknown faucet mint: ${operationId}`);
    if (existing.state === FaucetMintState.Minted) return existing;

    const minting = {
      ...existing,
      state: FaucetMintState.Minting,
      retryCount: existing.retryCount + 1,
      error: undefined,
      updatedAt: now,
    };
    this.store.putFaucetMint(minting);

    try {
      let txHash = await this.minter.findExistingMint(existing.operationId);
      if (!txHash) {
        const res = await this.minter.mintShadow({
          depositOpId: existing.operationId,
          owner: existing.owner,
          shadowAccount: existing.shadowAccount,
          amount: existing.amount,
        });
        txHash = res.txHash;
      }
      const minted = {
        ...minting,
        state: FaucetMintState.Minted,
        txHash,
        mintedAt: now,
        updatedAt: now,
      };
      this.store.putFaucetMint(minted);
      return minted;
    } catch (err) {
      const failed = {
        ...minting,
        state: FaucetMintState.Failed,
        error: err instanceof Error ? err.message : String(err),
        updatedAt: now,
      };
      this.store.putFaucetMint(failed);
      return failed;
    }
  }

  retry(operationId: Hex, now = new Date().toISOString()): FaucetMintRecord {
    const existing = this.store.getFaucetMint(operationId);
    if (!existing) throw new Error(`unknown faucet mint: ${operationId}`);
    if (existing.state !== FaucetMintState.Failed) return existing;
    const pending = {
      ...existing,
      state: FaucetMintState.Pending,
      error: undefined,
      updatedAt: now,
    };
    this.store.putFaucetMint(pending);
    return pending;
  }

  private assertSameDaemon(
    existing: FaucetMintRecord,
    req: DaemonFundingFaucetRequest,
  ): FaucetMintRecord {
    const same =
      existing.daemonId === req.daemonId &&
      existing.daemonAddress?.toLowerCase() === req.daemonAddress.toLowerCase() &&
      existing.shadowAccount.toLowerCase() === req.shadowAccount.toLowerCase();
    if (!same) {
      throw new FaucetConflictError(
        "daemon funding already exists for this daemon id, address, or shadow account",
      );
    }
    return existing;
  }
}
