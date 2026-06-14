/**
 * Bridge coordinator: turns confirmed public-escrow deposits into shadow
 * credits, and user-signed withdrawal commands into shadow debits + exit
 * authorizations. The durable double-mint / double-spend guarantee lives in the
 * indexer (deposits/withdrawals are idempotent per operation id in its event
 * log); this service maps owner/shadow → agent, enforces the lifecycle, and
 * mirrors operation status for indexing/recovery.
 *
 * Out of scope here (needs a live chain): the on-chain escrow contract, the
 * deposit-event watcher, and a real key-holding signing service. Those seams are
 * isolated behind IndexerApi and signExit so they can be swapped without
 * touching the lifecycle logic.
 */
export interface IndexerApi {
  /** Returns true if newly applied, false if the opId was already processed. */
  deposit(agentId: string, amount: number, opId: string): Promise<boolean>;
  withdraw(agentId: string, amount: number, commandId: string): Promise<boolean>;
  withdrawable(agentId: string): Promise<number>;
  /** Resolve a shadow account to its agentId via the identity registry. */
  resolveAgentId(shadowAccount: string): Promise<string | null>;
}

export type OpStatus = 'minted' | 'duplicate' | 'authorized' | 'rejected';

export interface DepositRequest {
  opId: string;
  amount: number;
  agentId?: string;
  shadowAccount?: string;
}

export interface WithdrawalRequest {
  commandId: string;
  amount: number;
  agentId?: string;
  shadowAccount?: string;
  /** User signature over the withdrawal command; required in production. */
  ownerSignature?: string;
}

export interface DepositRecord {
  opId: string;
  agentId: string;
  amount: number;
  status: Extract<OpStatus, 'minted' | 'duplicate'>;
}

export interface WithdrawalRecord {
  commandId: string;
  agentId: string;
  amount: number;
  status: Extract<OpStatus, 'authorized' | 'duplicate' | 'rejected'>;
  reason?: string;
  /** Exit authorization handed to the public escrow contract. */
  exitAuthorization?: string;
}

/** Stub for the signing service: deterministic authorization token, no real key. */
function signExit(commandId: string, agentId: string, amount: number): string {
  return `exit:${commandId}:${agentId}:${amount}`;
}

export class BridgeCoordinator {
  private readonly deposits = new Map<string, DepositRecord>();
  private readonly withdrawals = new Map<string, WithdrawalRecord>();

  constructor(private readonly indexer: IndexerApi) {}

  private async resolveAgent(req: { agentId?: string; shadowAccount?: string }): Promise<string> {
    if (req.agentId) return req.agentId;
    if (req.shadowAccount) {
      const agentId = await this.indexer.resolveAgentId(req.shadowAccount);
      if (agentId) return agentId;
    }
    throw new Error('cannot resolve agent: provide agentId or a mapped shadowAccount');
  }

  async processDeposit(req: DepositRequest): Promise<DepositRecord> {
    const existing = this.deposits.get(req.opId);
    if (existing) return existing;
    if (!(req.amount > 0)) throw new Error('deposit amount must be positive');

    const agentId = await this.resolveAgent(req);
    const applied = await this.indexer.deposit(agentId, req.amount, req.opId);
    const record: DepositRecord = { opId: req.opId, agentId, amount: req.amount, status: applied ? 'minted' : 'duplicate' };
    this.deposits.set(req.opId, record);
    return record;
  }

  async processWithdrawal(req: WithdrawalRequest): Promise<WithdrawalRecord> {
    const existing = this.withdrawals.get(req.commandId);
    if (existing) return existing;
    if (!(req.amount > 0)) throw new Error('withdrawal amount must be positive');

    const agentId = await this.resolveAgent(req);
    const withdrawable = await this.indexer.withdrawable(agentId);
    if (withdrawable + 1e-9 < req.amount) {
      const record: WithdrawalRecord = {
        commandId: req.commandId,
        agentId,
        amount: req.amount,
        status: 'rejected',
        reason: `amount ${req.amount} exceeds withdrawable ${withdrawable}`,
      };
      this.withdrawals.set(req.commandId, record);
      return record;
    }

    // Burn shadow funds first, then authorize the public escrow exit.
    const applied = await this.indexer.withdraw(agentId, req.amount, req.commandId);
    const record: WithdrawalRecord = {
      commandId: req.commandId,
      agentId,
      amount: req.amount,
      status: applied ? 'authorized' : 'duplicate',
      exitAuthorization: applied ? signExit(req.commandId, agentId, req.amount) : undefined,
    };
    this.withdrawals.set(req.commandId, record);
    return record;
  }

  getDeposit(opId: string): DepositRecord | undefined {
    return this.deposits.get(opId);
  }

  getWithdrawal(commandId: string): WithdrawalRecord | undefined {
    return this.withdrawals.get(commandId);
  }
}
