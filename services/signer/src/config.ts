/**
 * Isolated withdrawal-signer configuration.
 *
 * This service exists to hold the withdrawal-signer key OFF the bridge and
 * inside the confidential plane (CVM/TEE). It exposes ONE narrow endpoint,
 * reachable only by the bridge (shared-secret gated), and signs a
 * `WithdrawalAuthorization` only after the SigningService's mandatory checks
 * pass. Fails CLOSED: no key / no bridge token ⇒ it refuses to sign.
 */
export const config = {
  port: parseInt(process.env["PORT"] ?? "8099", 10),

  // Signer key — injected from CVM/TEE secret, NEVER committed or logged.
  signerPrivateKey: (process.env["SIGNER_PRIVATE_KEY"] ?? "") as `0x${string}` | "",

  // EIP-712 domain (must match the public bridge that verifies the signature).
  domainChainId: parseInt(process.env["PUBLIC_CHAIN_ID"] ?? "8453", 10),
  bridgeAddress: (process.env["BRIDGE_ADDRESS"] ??
    "0x0000000000000000000000000000000000000000") as `0x${string}`,
  gameId: (process.env["GAME_ID"] ??
    "0x0000000000000000000000000000000000000000000000000000000000000001") as `0x${string}`,
  authTtlSeconds: parseInt(process.env["AUTH_TTL_SECONDS"] ?? "86400", 10),

  // Bridge-only access: the bridge must present this shared secret. No token
  // configured ⇒ the endpoint is refused (unless dev override).
  bridgeToken: process.env["SIGNER_BRIDGE_TOKEN"] ?? "",
  allowInsecureDev: process.env["ALLOW_INSECURE_DEV"] === "true",

  // Burn confirmation source (hidden chain / indexer internal). Unset ⇒ the
  // burn check fails closed (the signer will not authorize without proof).
  burnVerifyUrl: process.env["BURN_VERIFY_URL"] ?? "",

  // Public bridge RPC for nonce reads. Unset ⇒ nonce check fails closed.
  publicRpcUrl: process.env["PUBLIC_RPC_URL"] ?? "",
};

export type Config = typeof config;
