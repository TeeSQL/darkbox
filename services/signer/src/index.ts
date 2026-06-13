import { startServer } from "./server.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  console.log("[signer] starting up");

  // Fail loud on an unsafe posture.
  if (!config.signerPrivateKey) {
    console.error("[signer] FATAL: SIGNER_PRIVATE_KEY unset — refusing to start.");
    process.exit(1);
  }
  if (!config.bridgeToken && !config.allowInsecureDev) {
    console.warn("[signer] SIGNER_BRIDGE_TOKEN unset — sign endpoint will 503 until configured.");
  }
  if (!config.burnVerifyUrl) {
    console.warn("[signer] BURN_VERIFY_URL unset — burn check fails closed (will reject).");
  }
  if (!config.publicRpcUrl) {
    console.warn("[signer] PUBLIC_RPC_URL unset — nonce check fails closed (will reject).");
  }

  await startServer();

  const shutdown = () => {
    console.log("[signer] shutting down");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[signer] fatal:", err);
  process.exit(1);
});
