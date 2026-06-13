/**
 * `pnpm --filter @darkbox/reveal build:bundle` — one command builds the reveal
 * bundle + replay timeline and writes them to REVEAL_OUT_DIR. This is the "open
 * the box" command.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { HttpRevealSources } from "./sources.js";
import { buildRevealBundle } from "./bundle.js";

async function main(): Promise<void> {
  const sources = new HttpRevealSources(config.indexerInternalUrl, config.deploymentsDir);
  const bundle = await buildRevealBundle(sources, {
    gameId: config.gameId,
    title: config.gameTitle,
    builtAt: new Date().toISOString(),
    revealPolicy: { includeInstructions: config.includeInstructions },
  });

  await mkdir(config.outDir, { recursive: true });
  const short = config.gameId.slice(0, 10);
  const bundlePath = join(config.outDir, `reveal-${short}.json`);
  const timelinePath = join(config.outDir, `timeline-${short}.json`);
  await writeFile(bundlePath, JSON.stringify(bundle, null, 2));
  await writeFile(timelinePath, JSON.stringify(bundle.timeline, null, 2));

  console.log(`[reveal] wrote ${bundlePath}`);
  console.log(`[reveal] wrote ${timelinePath}`);
  console.log(
    `[reveal] markets=${bundle.markets.length} agents=${bundle.agents.length} ` +
      `events=${bundle.integrity.eventCount} reconciled=${bundle.accounting.reconciled} ` +
      `discrepancy=${bundle.accounting.discrepancyUsdc} hash=${bundle.integrity.bundleHash.slice(0, 12)}…`,
  );
  if (!bundle.accounting.reconciled) {
    console.warn("[reveal] WARNING: accounting NOT reconciled — public-USDC vs shadow mismatch.");
  }
}

main().catch((err) => {
  console.error("[reveal] build failed:", err);
  process.exit(1);
});
