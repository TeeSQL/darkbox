import { parseAbi } from "viem";

/**
 * Minimal ShadowBridgeController fragments the faucet minter needs. Mirrors the
 * canonical fragments in services/bridge/src/chain/abis.ts (USDC-only: a single
 * asset, so no asset parameter). Kept local so the worker owns its chain surface
 * the same way services/market-executor owns its factory ABI.
 */
export const shadowBridgeControllerAbi = parseAbi([
  "function mintShadow(bytes32 depositOpId, address owner, bytes32 shadowAccount, uint256 amount)",
  "event ShadowMinted(bytes32 indexed depositOpId, bytes32 indexed shadowAccount, uint256 amount)",
]);

/** ShadowMinted event item (name-addressed, index-independent) for getLogs. */
export const shadowMintedEvent = parseAbi([
  "event ShadowMinted(bytes32 indexed depositOpId, bytes32 indexed shadowAccount, uint256 amount)",
])[0];
