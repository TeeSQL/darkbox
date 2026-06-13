/**
 * Reveal builder configuration. Runs in the confidential plane (reads the
 * indexer's INTERNAL state + on-chain deploy metadata). Output is the audit/
 * replay bundle — publishing it is an explicit, gated action, not automatic.
 */
export const config = {
  port: parseInt(process.env["PORT"] ?? "8096", 10),
  indexerInternalUrl: process.env["INDEXER_INTERNAL_URL"] ?? "http://localhost:8080/internal",
  // Directory of on-chain deployment artifacts (addresses) to embed.
  deploymentsDir: process.env["DEPLOYMENTS_DIR"] ?? "packages/contracts/deployments",
  // Where `build:bundle` writes the bundle + timeline.
  outDir: process.env["REVEAL_OUT_DIR"] ?? ".artifacts/reveal",
  gameId: process.env["GAME_ID"] ?? "0x0000000000000000000000000000000000000000000000000000000000000001",
  gameTitle: process.env["GAME_TITLE"] ?? "DarkBox",
  // Strategy preimages are revealed ONLY when this is explicitly true.
  includeInstructions: process.env["REVEAL_INCLUDE_INSTRUCTIONS"] === "true",
};

export type Config = typeof config;
