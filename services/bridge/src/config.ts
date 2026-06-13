import type { Address, Hex } from "viem";

/**
 * Bridge service configuration (spec section 13). Values normally come from
 * environment/secrets; `loadConfig` reads `process.env` with sane MVP defaults.
 */
export interface BridgeConfig {
  gameId: Hex;
  baseChainId: number;
  usdcAddress: Address;
  bridgeAddress: Address;
  publicRpcUrl: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    gameId: req("GAME_ID", env.GAME_ID) as Hex,
    baseChainId: Number(env.BASE_CHAIN_ID ?? "8453"),
    usdcAddress: req("USDC_ADDRESS", env.USDC_ADDRESS) as Address,
    bridgeAddress: req("BRIDGE_ADDRESS", env.BRIDGE_ADDRESS) as Address,
    publicRpcUrl: req("PUBLIC_RPC_URL", env.PUBLIC_RPC_URL),
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
