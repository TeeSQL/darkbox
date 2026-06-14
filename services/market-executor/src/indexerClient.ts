import type { Address, Hex } from "viem";

/**
 * One row from `market_proposals` as returned by
 * GET /internal/market-proposals?status=approved. snake_case mirrors the DB
 * columns (services/indexer/migrations 002 + 003). Only the fields the executor
 * needs are typed; extra columns are tolerated.
 */
export interface ProposalRow {
  proposal_id: string;
  agent_id?: string;
  question: string;
  description?: string;
  outcomes?: unknown;
  resolve_by?: string;
  resolution_source?: string;
  rationale?: string;
  metadata_uri?: string;
  status: string;
  run_id?: string;
  turn?: number;
}

/** Payload written back to the indexer once a market is created on-chain. */
export interface DeployedResult {
  marketId: Hex;
  marketAddress: Address;
  yesBook: Address;
  noBook: Address;
  yesToken: Address;
  noToken: Address;
  txHash: Hex | null;
  /** Coordinator (factory owner) address — recorded as the markets.creator_address. */
  creatorAddress: Address;
  /** bigint as string (JSON-safe): market close time, unix seconds. */
  closeTime: string;
  /** bigint as string (JSON-safe): resolve-by deadline, unix seconds. */
  resolveBy: string;
  /** bigint as string (JSON-safe): block the market was created in. */
  createdAtBlock: string;
}

/** The indexer operations the executor depends on (faked in tests). */
export interface IndexerClient {
  getApprovedProposals(limit: number): Promise<ProposalRow[]>;
  markDeployed(proposalId: string, result: DeployedResult): Promise<void>;
  markFailed(proposalId: string, error: string): Promise<void>;
}

export class HttpIndexerClient implements IndexerClient {
  /** @param internalUrl base internal URL WITHOUT trailing slash, e.g. http://host:8080/internal */
  constructor(private readonly internalUrl: string) {}

  async getApprovedProposals(limit: number): Promise<ProposalRow[]> {
    const url = `${this.internalUrl}/market-proposals?status=approved&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`indexer getApprovedProposals failed: ${res.status} ${await res.text()}`);
    }
    const rows = (await res.json()) as ProposalRow[];
    return Array.isArray(rows) ? rows : [];
  }

  async markDeployed(proposalId: string, result: DeployedResult): Promise<void> {
    const res = await fetch(
      `${this.internalUrl}/market-proposals/${encodeURIComponent(proposalId)}/deployed`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      },
    );
    if (!res.ok) {
      throw new Error(`indexer markDeployed failed: ${res.status} ${await res.text()}`);
    }
  }

  async markFailed(proposalId: string, error: string): Promise<void> {
    const res = await fetch(
      `${this.internalUrl}/market-proposals/${encodeURIComponent(proposalId)}/deploy-failed`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error }),
      },
    );
    if (!res.ok) {
      throw new Error(`indexer markFailed failed: ${res.status} ${await res.text()}`);
    }
  }
}
