export const config = {
  port: parseInt(process.env["PORT"] ?? "8080", 10),
  databaseUrl: process.env["DATABASE_URL"] ?? "postgres://darkbox:darkbox_dev_only@localhost:5432/darkbox",
  hiddenRpcUrl: process.env["HIDDEN_RPC_URL"] ?? "http://localhost:8545",
  publicChainId: parseInt(process.env["PUBLIC_CHAIN_ID"] ?? "8453", 10),
  hiddenChainId: parseInt(process.env["HIDDEN_CHAIN_ID"] ?? "1337", 10),
  gameId: (process.env["GAME_ID"] ?? "0x0000000000000000000000000000000000000000000000000000000000000001") as `0x${string}`,
  bridgeAddress: (process.env["BRIDGE_ADDRESS"] ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  shadowBridgeControllerAddress: (process.env["SHADOW_BRIDGE_CONTROLLER_ADDRESS"] ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  usdcAddress: (process.env["USDC_ADDRESS"] ?? "usdc").toLowerCase(),
  marketFactoryAddress: (process.env["MARKET_FACTORY_ADDRESS"] ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  pollIntervalMs: parseInt(process.env["POLL_INTERVAL_MS"] ?? "2000", 10),
  pollBatchSize: parseInt(process.env["POLL_BATCH_SIZE"] ?? "100", 10),
  // Per-RPC-request timeout so a dropped/half-open geth socket REJECTS instead of
  // hanging the scan loop forever (a frozen await would stall the cursor silently).
  rpcTimeoutMs: parseInt(process.env["RPC_TIMEOUT_MS"] ?? "15000", 10),
  // Max backoff applied between scan cycles after consecutive RPC failures (e.g.
  // geth down for a restart window). Exponential, capped here.
  scanMaxBackoffMs: parseInt(process.env["SCAN_MAX_BACKOFF_MS"] ?? "30000", 10),
  snapshotIntervalMs: parseInt(process.env["SNAPSHOT_INTERVAL_MS"] ?? "60000", 10),
  marketLifecycleEnabled: process.env["MARKET_LIFECYCLE_ENABLED"] !== "false",
  marketLifecycleIntervalMs: parseInt(process.env["MARKET_LIFECYCLE_INTERVAL_MS"] ?? "60000", 10),
};
