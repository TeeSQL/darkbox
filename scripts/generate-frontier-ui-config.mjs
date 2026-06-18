#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error(`Usage: node scripts/generate-frontier-ui-config.mjs \\
  --deploy-json packages/contracts/deployments/darkbox-arc-testnet-5042002.json \\
  --rpc-url https://rpc.testnet.arc.network \\
  --side yes|no \\
  --out /path/to/frontier/ui/public/deployment.json`);
  process.exit(2);
}

const args = process.argv.slice(2);
const opts = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || !args[i + 1]) usage();
  opts.set(args[i].slice(2), args[i + 1]);
}

const deployJson = opts.get("deploy-json");
const rpcUrl = opts.get("rpc-url") ?? "https://rpc.testnet.arc.network";
const side = (opts.get("side") ?? "yes").toLowerCase();
const out = opts.get("out") ?? "frontier-deployment.json";
const gatewayUrl = opts.get("gateway-url") ?? undefined;

if (!deployJson || !["yes", "no"].includes(side)) usage();

const artifact = JSON.parse(fs.readFileSync(deployJson, "utf8"));
const canonical = artifact.canonicalMarket ?? {};
const frontier = artifact.frontier ?? {};
const darkbox = artifact.darkbox ?? {};

const book = side === "yes" ? canonical.yesBook : canonical.noBook;
const outcomeToken = side === "yes" ? canonical.yesToken : canonical.noToken;
const outcomeLabel = side.toUpperCase();

for (const [label, value] of Object.entries({
  chainId: artifact.chainId,
  router: frontier.router,
  lens: frontier.lens,
  book,
  outcomeToken,
  syntheticUSDC: darkbox.syntheticUSDC,
})) {
  if (!value) throw new Error(`deployment artifact missing ${label}`);
}

// This is intentionally compatible with the existing single-book Frontier UI.
// `weth` is repurposed as the selected outcome token and `usdc` as sUSDC.
// DarkBox-specific metadata is included under `darkbox` for upgraded shells.
const uiConfig = {
  name: `DarkBox Arc Testnet — ${outcomeLabel}/sUSDC`,
  chainId: Number(artifact.chainId),
  rpcUrl,
  contracts: {
    book,
    router: frontier.router,
    lens: frontier.lens,
    factory: frontier.factory,
    registry: frontier.registry,
    weth: outcomeToken,
    usdc: darkbox.syntheticUSDC,
  },
  tokens: {
    base: outcomeLabel,
    quote: "sUSDC",
    baseAddress: outcomeToken,
    quoteAddress: darkbox.syntheticUSDC,
    baseDecimals: 6,
    quoteDecimals: 6,
  },
  darkbox: {
    network: "arc-testnet",
    gatewayUrl,
    marketFactory: darkbox.marketFactory,
    syntheticUSDC: darkbox.syntheticUSDC,
    selectedSide: side,
    market: {
      marketId: canonical.marketId,
      market: canonical.market,
      question: canonical.question ?? "Will the canonical project win the hackathon?",
      yesToken: canonical.yesToken,
      noToken: canonical.noToken,
      yesBook: canonical.yesBook,
      noBook: canonical.noBook,
    },
  },
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(uiConfig, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(`selected ${outcomeLabel} book ${book}`);
