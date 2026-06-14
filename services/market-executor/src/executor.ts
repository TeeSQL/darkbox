import { keccak256, stringToHex, type Address, type Hex } from "viem";
import type { CreateMarketInput, CreatedMarket, FactoryClient } from "./factory.js";
import type { IndexerClient, ProposalRow } from "./indexerClient.js";

/** ResolverType.AdminManual — the only resolver the factory accepts (MVP). */
export const RESOLVER_TYPE_ADMIN_MANUAL = 0;

export interface ExecutorDeps {
  factory: FactoryClient;
  indexer: IndexerClient;
  /** Coordinator address (factory owner/coordinator). Used as the params.resolver. */
  coordinatorAddress: Address;
  gameId: Hex;
  creatorBond: bigint;
  initialLiquidity: bigint;
  /** Resolves (closeTime, resolveBy) for a newly built market. */
  marketTimes: () => { closeTime: bigint; resolveBy: bigint };
  /** How many approved proposals to pull per poll. */
  fetchLimit?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

function defaultLog(msg: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(`[market-executor] ${msg}`, extra);
  else console.log(`[market-executor] ${msg}`);
}

/**
 * Builds the on-chain CreateMarketParams for a proposal.
 *
 * - gameId / bond / liquidity / times come from config.
 * - question/description from the proposal.
 * - metadataURI: the factory reverts on empty metadata, so fall back to a
 *   deterministic per-proposal URI when the proposal has none.
 * - resolver: AdminManual with `coordinatorAddress` as the resolver address and
 *   sourceId = keccak256(resolution_source || "admin"). The factory pins the
 *   real resolver to AdminManual+owner anyway, but `_validate` requires the
 *   resolverType to be AdminManual, so we send a valid config.
 */
export function buildCreateMarketInput(
  proposal: ProposalRow,
  deps: Pick<
    ExecutorDeps,
    "coordinatorAddress" | "gameId" | "creatorBond" | "initialLiquidity" | "marketTimes"
  >,
): CreateMarketInput {
  const { closeTime, resolveBy } = deps.marketTimes();
  const metadataURI =
    proposal.metadata_uri && proposal.metadata_uri.length > 0
      ? proposal.metadata_uri
      : `darkbox:proposal:${proposal.proposal_id}`;
  const description = proposal.description ?? "";
  const resolutionSource =
    proposal.resolution_source && proposal.resolution_source.length > 0
      ? proposal.resolution_source
      : "admin";

  return {
    gameId: deps.gameId,
    question: proposal.question,
    description,
    metadataURI,
    resolver: {
      resolverType: RESOLVER_TYPE_ADMIN_MANUAL,
      resolver: deps.coordinatorAddress,
      sourceId: keccak256(stringToHex(resolutionSource)),
      data: "0x",
    },
    closeTime,
    resolveBy,
    creatorBond: deps.creatorBond,
    initialLiquidity: deps.initialLiquidity,
  };
}

/**
 * Processes a single APPROVED proposal end-to-end. Idempotent by question (the
 * on-chain duplicate guard keys off gameId+question+...): before sending a tx we
 * look for an existing market with the same question and, if found, recover by
 * writing the result back WITHOUT creating a second market.
 *
 * Never throws on a factory revert / indexer error for this proposal — it marks
 * the proposal `deploy_failed` and returns, so the poll loop keeps going.
 * Returns the created/recovered market, or null if it failed.
 */
export async function processProposal(
  proposal: ProposalRow,
  deps: ExecutorDeps,
): Promise<CreatedMarket | null> {
  const log = deps.log ?? defaultLog;
  const proposalId = proposal.proposal_id;
  try {
    // Idempotency / crash-recovery: did we already create this market?
    const existing = await deps.factory.findExistingMarketByQuestion(
      deps.gameId,
      proposal.question,
    );
    let result: CreatedMarket;
    if (existing) {
      log("recovered existing market (skipping createMarket)", {
        proposalId,
        marketId: existing.marketId,
      });
      result = existing;
    } else {
      const input = buildCreateMarketInput(proposal, deps);
      result = await deps.factory.createMarket(input);
      log("created market", {
        proposalId,
        txHash: result.txHash,
        marketId: result.marketId,
        market: result.marketAddress,
      });
    }

    await deps.indexer.markDeployed(proposalId, {
      marketId: result.marketId,
      marketAddress: result.marketAddress,
      yesBook: result.yesBook,
      noBook: result.noBook,
      yesToken: result.yesToken,
      noToken: result.noToken,
      txHash: result.txHash,
      creatorAddress: deps.coordinatorAddress,
      closeTime: result.closeTime.toString(),
      resolveBy: result.resolveBy.toString(),
      createdAtBlock: result.createdAtBlock.toString(),
    });
    log("marked deployed", { proposalId, marketId: result.marketId });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("deploy FAILED", { proposalId, error: message });
    // Best-effort: record the failure so the proposal isn't silently retried
    // forever. If the indexer itself is unreachable, swallow it — the next poll
    // will retry the whole proposal.
    try {
      await deps.indexer.markFailed(proposalId, message);
    } catch (markErr) {
      const m = markErr instanceof Error ? markErr.message : String(markErr);
      log("markFailed ALSO failed (will retry next poll)", { proposalId, error: m });
    }
    return null;
  }
}

/**
 * One poll iteration: fetch approved proposals and process each. Per-proposal
 * errors are contained in `processProposal`, so this resolves even if some
 * proposals fail. Throws only if the *fetch* itself fails (the loop catches it).
 */
export async function runOnce(deps: ExecutorDeps): Promise<number> {
  const limit = deps.fetchLimit ?? 25;
  const proposals = await deps.indexer.getApprovedProposals(limit);
  let processed = 0;
  for (const proposal of proposals) {
    await processProposal(proposal, deps);
    processed += 1;
  }
  return processed;
}

/**
 * The forever poll loop. Catches and logs per-iteration errors (e.g. the
 * indexer not being up yet) and keeps going — it never hard-exits.
 */
export async function runLoop(deps: ExecutorDeps, pollIntervalMs: number): Promise<never> {
  const log = deps.log ?? defaultLog;
  for (;;) {
    try {
      await runOnce(deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("poll iteration error (continuing)", { error: message });
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
