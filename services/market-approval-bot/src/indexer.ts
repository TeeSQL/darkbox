import type { ProposalPayload } from "./types.js";

export class IndexerClient {
  constructor(private readonly internalUrl: string) {}

  async upsertProposal(proposal: ProposalPayload, review?: { chatId: string; threadId: string; messageId: string }): Promise<void> {
    const res = await fetch(`${this.internalUrl}/market-proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...proposal, review }),
    });
    if (!res.ok) throw new Error(`indexer proposal upsert failed: ${res.status} ${await res.text()}`);
  }

  async decide(proposalId: string, status: "approved" | "denied", reviewedBy: string, reviewMessageId?: string): Promise<void> {
    const res = await fetch(`${this.internalUrl}/market-proposals/${encodeURIComponent(proposalId)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, reviewedBy, reviewMessageId }),
    });
    if (!res.ok) throw new Error(`indexer proposal decision failed: ${res.status} ${await res.text()}`);
  }
}
