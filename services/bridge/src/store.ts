import type { Address, Hex } from "viem";
import type {
  AccountMapping,
  DepositIntent,
  DepositRecord,
  FaucetMintRecord,
  WithdrawalRecord,
} from "./types.js";

/**
 * Persistence interface for the bridge service (spec section 12 "Required
 * persistence"). The in-memory implementation is used for tests and the local
 * MVP; a Postgres/SQLite-backed implementation can satisfy the same interface
 * for CVM deployment.
 */
export interface BridgeStore {
  // deposits
  getDeposit(depositOpId: Hex): DepositRecord | undefined;
  putDeposit(record: DepositRecord): void;
  listDeposits(): DepositRecord[];

  // mappings
  getMappingByOwner(owner: Address): AccountMapping | undefined;
  getMappingByShadow(shadowAccount: Hex): AccountMapping | undefined;
  putMapping(mapping: AccountMapping): void;

  // intents (FIFO by createdAt)
  putIntent(intent: DepositIntent): void;
  getIntent(intentId: Hex): DepositIntent | undefined;
  listOpenIntents(): DepositIntent[];

  // withdrawals
  getWithdrawal(withdrawalId: Hex): WithdrawalRecord | undefined;
  putWithdrawal(record: WithdrawalRecord): void;
  listWithdrawals(): WithdrawalRecord[];

  // faucet mints
  getFaucetMint(operationId: Hex): FaucetMintRecord | undefined;
  getHumanPromoMint(gameId: Hex, telegramId: string): FaucetMintRecord | undefined;
  getDaemonFundingMint(gameId: Hex, daemonId: string): FaucetMintRecord | undefined;
  getDaemonFundingMintByAddress(gameId: Hex, daemonAddress: Address): FaucetMintRecord | undefined;
  getDaemonFundingMintByShadow(gameId: Hex, shadowAccount: Hex): FaucetMintRecord | undefined;
  putFaucetMint(record: FaucetMintRecord): void;
  listPendingFaucetMints(limit?: number): FaucetMintRecord[];
  listFaucetMints(): FaucetMintRecord[];
}

export class InMemoryBridgeStore implements BridgeStore {
  private deposits = new Map<Hex, DepositRecord>();
  private mappingsByOwner = new Map<string, AccountMapping>();
  private mappingsByShadow = new Map<string, AccountMapping>();
  private intents = new Map<Hex, DepositIntent>();
  private withdrawals = new Map<Hex, WithdrawalRecord>();
  private faucetMints = new Map<string, FaucetMintRecord>();

  getDeposit(depositOpId: Hex): DepositRecord | undefined {
    return this.deposits.get(depositOpId);
  }
  putDeposit(record: DepositRecord): void {
    this.deposits.set(record.depositOpId, record);
  }
  listDeposits(): DepositRecord[] {
    return [...this.deposits.values()];
  }

  getMappingByOwner(owner: Address): AccountMapping | undefined {
    return this.mappingsByOwner.get(owner.toLowerCase());
  }
  getMappingByShadow(shadowAccount: Hex): AccountMapping | undefined {
    return this.mappingsByShadow.get(shadowAccount.toLowerCase());
  }
  putMapping(mapping: AccountMapping): void {
    this.mappingsByOwner.set(mapping.owner.toLowerCase(), mapping);
    this.mappingsByShadow.set(mapping.shadowAccount.toLowerCase(), mapping);
  }

  putIntent(intent: DepositIntent): void {
    this.intents.set(intent.intentId, intent);
  }
  getIntent(intentId: Hex): DepositIntent | undefined {
    return this.intents.get(intentId);
  }
  listOpenIntents(): DepositIntent[] {
    return [...this.intents.values()]
      .filter((i) => i.state === ("open" as DepositIntent["state"]))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getWithdrawal(withdrawalId: Hex): WithdrawalRecord | undefined {
    return this.withdrawals.get(withdrawalId);
  }
  putWithdrawal(record: WithdrawalRecord): void {
    this.withdrawals.set(record.withdrawalId, record);
  }
  listWithdrawals(): WithdrawalRecord[] {
    return [...this.withdrawals.values()];
  }

  getFaucetMint(operationId: Hex): FaucetMintRecord | undefined {
    return this.faucetMints.get(operationId.toLowerCase());
  }
  getHumanPromoMint(gameId: Hex, telegramId: string): FaucetMintRecord | undefined {
    return [...this.faucetMints.values()].find(
      (r) =>
        r.kind === "human_promo" &&
        r.gameId.toLowerCase() === gameId.toLowerCase() &&
        r.telegramId === telegramId,
    );
  }
  getDaemonFundingMint(gameId: Hex, daemonId: string): FaucetMintRecord | undefined {
    return [...this.faucetMints.values()].find(
      (r) =>
        r.kind === "daemon_funding" &&
        r.gameId.toLowerCase() === gameId.toLowerCase() &&
        r.daemonId === daemonId,
    );
  }
  getDaemonFundingMintByAddress(gameId: Hex, daemonAddress: Address): FaucetMintRecord | undefined {
    return [...this.faucetMints.values()].find(
      (r) =>
        r.kind === "daemon_funding" &&
        r.gameId.toLowerCase() === gameId.toLowerCase() &&
        r.daemonAddress?.toLowerCase() === daemonAddress.toLowerCase(),
    );
  }
  getDaemonFundingMintByShadow(gameId: Hex, shadowAccount: Hex): FaucetMintRecord | undefined {
    return [...this.faucetMints.values()].find(
      (r) =>
        r.kind === "daemon_funding" &&
        r.gameId.toLowerCase() === gameId.toLowerCase() &&
        r.shadowAccount.toLowerCase() === shadowAccount.toLowerCase(),
    );
  }
  putFaucetMint(record: FaucetMintRecord): void {
    this.faucetMints.set(record.operationId.toLowerCase(), record);
  }
  listPendingFaucetMints(limit = 100): FaucetMintRecord[] {
    return [...this.faucetMints.values()]
      .filter((r) => r.state === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }
  listFaucetMints(): FaucetMintRecord[] {
    return [...this.faucetMints.values()];
  }
}
