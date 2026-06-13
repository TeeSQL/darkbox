import type { Address, Hex } from "viem";

/**
 * One public USDC bridge/escrow on a configured chain. MVP runs one per chain
 * (Base + Arc); deposits on any of them mint canonical shadow USDC, and a
 * withdrawal's destination must be one of these (spec sections 5–7).
 */
export interface PublicChainConfig {
  /** Human label, e.g. "base" / "arc". */
  name: string;
  chainId: number;
  /** DarkBoxBridge escrow address on this chain. */
  bridgeAddress: Address;
  /** USDC token address on this chain. */
  usdcAddress: Address;
  rpcUrl: string;
}

/**
 * Bridge service configuration (spec section 13). Values normally come from
 * environment/secrets; `loadConfig` reads `process.env` with sane MVP defaults.
 */
export interface BridgeConfig {
  gameId: Hex;
  /** All public escrow chains the service watches and can pay out to. */
  publicChains: PublicChainConfig[];
  shadowRpcUrl: string;
  shadowChainId: number;
  shadowBridgeControllerAddress: Address;
  signerAddress: Address;
  confirmationsRequired: number;
  databaseUrl: string;
}

function req(name: string, value: string | undefined): string {
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

/**
 * Parses the configured public chains. Base is always required; Arc is included
 * when its env vars are present. Each chain needs `<PREFIX>_CHAIN_ID`,
 * `<PREFIX>_BRIDGE_ADDRESS`, `<PREFIX>_USDC_ADDRESS`, `<PREFIX>_RPC_URL`.
 * Falls back to the legacy single-chain vars (`USDC_ADDRESS`/`BRIDGE_ADDRESS`/
 * `PUBLIC_RPC_URL`) for Base.
 */
function parsePublicChains(env: NodeJS.ProcessEnv): PublicChainConfig[] {
  const chains: PublicChainConfig[] = [];

  chains.push({
    name: "base",
    chainId: Number(env.BASE_CHAIN_ID ?? "8453"),
    bridgeAddress: req("BRIDGE_ADDRESS", env.BASE_BRIDGE_ADDRESS ?? env.BRIDGE_ADDRESS) as Address,
    usdcAddress: req("USDC_ADDRESS", env.BASE_USDC_ADDRESS ?? env.USDC_ADDRESS) as Address,
    rpcUrl: req("PUBLIC_RPC_URL", env.BASE_RPC_URL ?? env.PUBLIC_RPC_URL),
  });

  if (env.ARC_CHAIN_ID || env.ARC_BRIDGE_ADDRESS) {
    chains.push({
      name: "arc",
      chainId: Number(req("ARC_CHAIN_ID", env.ARC_CHAIN_ID)),
      bridgeAddress: req("ARC_BRIDGE_ADDRESS", env.ARC_BRIDGE_ADDRESS) as Address,
      usdcAddress: req("ARC_USDC_ADDRESS", env.ARC_USDC_ADDRESS) as Address,
      rpcUrl: req("ARC_RPC_URL", env.ARC_RPC_URL),
    });
  }

  return chains;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    gameId: req("GAME_ID", env.GAME_ID) as Hex,
    publicChains: parsePublicChains(env),
    shadowRpcUrl: req("SHADOW_RPC_URL", env.SHADOW_RPC_URL),
    shadowChainId: Number(env.SHADOW_CHAIN_ID ?? "1337"),
    shadowBridgeControllerAddress: req(
      "SHADOW_BRIDGE_CONTROLLER_ADDRESS",
      env.SHADOW_BRIDGE_CONTROLLER_ADDRESS,
    ) as Address,
    signerAddress: req("SIGNER_ADDRESS", env.SIGNER_ADDRESS) as Address,
    confirmationsRequired: Number(env.CONFIRMATIONS_REQUIRED ?? "3"),
    databaseUrl: env.DATABASE_URL ?? "sqlite::memory:",
  };
}
