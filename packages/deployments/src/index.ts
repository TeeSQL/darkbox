import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The Arc-testnet deployment of the DarkBox prediction-market CLOB.
 *
 * Source of truth is the canonical deploy artifact emitted in-repo by the
 * forge deploy scripts (`packages/contracts/script/*Arc*`). The frontier UI's
 * `ui/public/deployment.json` is *generated* from this file
 * (`scripts/generate-frontier-ui-config.mjs`), so this artifact — not the UI
 * copy — is what we read.
 */
const DEPLOYMENT_URL = new URL(
  "../../contracts/deployments/darkbox-arc-grant-market-v2-5042002.json",
  import.meta.url,
);

/** Default Arc-testnet RPC (the deploy artifact records addresses, not the RPC). */
export const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network";

const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x address");
const Hex = z.string().regex(/^0x[0-9a-fA-F]+$/, "expected a 0x hex string");

export const ArcDeploymentSchema = z.object({
  chainId: z.number().int(),
  deployer: Address,
  frontier: z.object({
    factory: Address,
    router: Address,
    lens: Address,
  }),
  feeConfig: z
    .object({
      makerFeeBps: z.number().int(),
      takerFeeBps: z.number().int(),
    })
    .optional(),
  darkbox: z.object({
    syntheticUSDC: Address,
    marketFactory: Address,
  }),
  canonicalMarket: z.object({
    marketId: Hex,
    market: Address,
    question: z.string(),
    yesToken: Address,
    noToken: Address,
    yesBook: Address,
    noBook: Address,
  }),
});

export type ArcDeployment = z.infer<typeof ArcDeploymentSchema>;

function loadDeployment(): ArcDeployment {
  let raw: string;
  try {
    raw = readFileSync(fileURLToPath(DEPLOYMENT_URL), "utf8");
  } catch (err) {
    throw new Error(
      "@darkbox/deployments: cannot read " +
        "packages/contracts/deployments/darkbox-arc-grant-market-v2-5042002.json " +
        `(${(err as Error).message})`,
    );
  }
  return ArcDeploymentSchema.parse(JSON.parse(raw));
}

/** The validated Arc-testnet PM-CLOB deployment (the canonical in-repo artifact). */
export const arcTestnet: ArcDeployment = loadDeployment();

/**
 * Map the deployment onto the environment variables darkbox services read
 * (see each service's `config.ts`). Only values the deployment owns are
 * emitted; private keys, API tokens and hidden-chain config stay in sealed
 * env and are intentionally not produced here.
 */
export function toEnv(d: ArcDeployment = arcTestnet): Record<string, string> {
  return {
    PUBLIC_CHAIN_ID: String(d.chainId),
    PUBLIC_RPC_URL: ARC_TESTNET_RPC_URL,
    USDC_ADDRESS: d.darkbox.syntheticUSDC,
    MARKET_FACTORY_ADDRESS: d.darkbox.marketFactory,
  };
}
