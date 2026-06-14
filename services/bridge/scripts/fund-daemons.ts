import { readFile } from "node:fs/promises";
import { daemonFundingOperationId, daemonFundingOperationString } from "@darkbox/shared";
import type { Address, Hex } from "viem";

interface AgentIdentity {
  agentId: string;
  address: Address;
  shadowAccount: Hex;
}

interface AgentIdentityFile {
  agents: AgentIdentity[];
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((v) => v.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const gameId = (arg("game-id") ?? process.env["GAME_ID"]) as Hex | undefined;
  if (!gameId) throw new Error("missing --game-id or GAME_ID");

  const file = arg("agents") ?? "../agents/config/agent-identities.json";
  const bridgeUrl = arg("bridge-url") ?? process.env["BRIDGE_URL"];
  const amount = arg("amount") ?? process.env["FAUCET_AMOUNT"] ?? "5.00";
  const dryRun = process.argv.includes("--dry-run") || !bridgeUrl;

  const parsed = JSON.parse(await readFile(file, "utf8")) as AgentIdentityFile;
  const requests = parsed.agents.map((agent) => {
    const operationString = daemonFundingOperationString({
      gameId,
      daemonId: agent.agentId,
      daemonAddress: agent.address,
      shadowAccount: agent.shadowAccount,
    });
    return {
      operationId: daemonFundingOperationId({
        gameId,
        daemonId: agent.agentId,
        daemonAddress: agent.address,
        shadowAccount: agent.shadowAccount,
      }),
      operationString,
      daemonId: agent.agentId,
      daemonAddress: agent.address,
      shadowAccount: agent.shadowAccount,
      amount,
      currency: "USDC",
      requestedAt: new Date().toISOString(),
    };
  });

  if (dryRun) {
    console.log(JSON.stringify({ mode: "dry_run", count: requests.length, requests }, null, 2));
    return;
  }

  for (const request of requests) {
    const res = await fetch(`${bridgeUrl!.replace(/\/$/, "")}/internal/faucet/daemon-funding`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new Error(`daemon faucet enqueue failed for ${request.daemonId}: ${res.status}`);
    }
    console.log(`${request.daemonId} ${request.operationId} accepted`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
