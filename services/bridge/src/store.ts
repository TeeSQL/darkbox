import type { Address, Hex } from "viem";
import type {
  AccountMapping,
  DepositIntent,
  DepositRecord,
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
}

export class InMemoryBridgeStore implements BridgeStore {
  private deposits = new Map<Hex, DepositRecord>();
  private mappingsByOwner = new Map<string, AccountMapping>();
  private mappingsByShadow = new Map<string, AccountMapping>();
  private intents = new Map<Hex, DepositIntent>();
  private withdrawals = new Map<Hex, WithdrawalRecord>();

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
}
