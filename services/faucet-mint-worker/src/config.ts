import type { Address, Hex } from "viem";

/**
 * Faucet-mint-worker configuration (mirrors services/bridge/src/config.ts and
 * services/market-executor/src/config.ts). Values come from environment / sealed
 * secrets; `loadConfig` reads `process.env` with sane defaults for everything
 * EXCEPT secrets and chain-identifying addresses, which are required.
 *
 * SECURITY: `coordinatorPrivateKey` is read from env ONLY. It is NEVER logged,
 * echoed, or written to disk — only the derived coordinator ADDRESS (public) is
 * ever surfaced. Treat it like the bridge signer key.
 */
export interface FaucetMintWorkerConfig {
  hiddenRpcUrl: string;
  hiddenChainId: number;
  /** ShadowBridgeController address on the hidden chain (the mint target). */
  shadowBridgeControllerAddress: Address;
  /** bytes32 game id all faucet grants are minted under. */
  gameId: Hex;
  /** Coordinator/minter key (authorized on the controller). NEVER log this. */
  coordinatorPrivateKey: Hex;
  /** Poll cadence for the drain loop. */
  pollIntervalMs: number;
  /** Faucet grant size in shadow-USDC base units (6 decimals). 5_000_000 = $5. */
  faucetAmount: bigint;
  /** Earliest block to scan for the findExistingMint idempotency lookup. */
  fromBlock: bigint;
  /** Max pending records drained per poll iteration. */
  fetchLimit: number;
  /** Internal HTTP port for the mesh-only faucet endpoints. */
  port: number;
  /**
   * Shared secret gating the mesh-internal endpoints (presented as
   * `x-mesh-token`). Unset ⇒ endpoints refuse (503) unless `allowInsecureDev`.
   */
  meshToken: string;
  allowInsecureDev: boolean;
}

function req(name: string, value: string | undefined): string {
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FaucetMintWorkerConfig {
  return {
    hiddenRpcUrl: env.HIDDEN_RPC_URL ?? "http://localhost:8545",
    hiddenChainId: Number(env.HIDDEN_CHAIN_ID ?? "88813"),
    shadowBridgeControllerAddress: req(
      "SHADOW_BRIDGE_CONTROLLER_ADDRESS",
      env.SHADOW_BRIDGE_CONTROLLER_ADDRESS,
    ) as Address,
    gameId: req("GAME_ID", env.GAME_ID) as Hex,
    coordinatorPrivateKey: req("COORDINATOR_PRIVATE_KEY", env.COORDINATOR_PRIVATE_KEY) as Hex,
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? "8000"),
    faucetAmount: BigInt(env.FAUCET_AMOUNT ?? "5000000"),
    fromBlock: BigInt(env.FROM_BLOCK ?? "0"),
    fetchLimit: Number(env.FETCH_LIMIT ?? "25"),
    port: Number(env.PORT ?? "8090"),
    meshToken: env.MESH_TOKEN ?? "",
    allowInsecureDev: env.ALLOW_INSECURE_DEV === "true",
  };
}
