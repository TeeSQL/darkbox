import type { FaucetEnqueueRecord } from "./store.js";

export async function enqueueFaucetMint(record: FaucetEnqueueRecord): Promise<"accepted" | "skipped"> {
  const base = process.env["BRIDGE_URL"] ?? "";
  if (!base) return "skipped";

  const res = await fetch(`${base.replace(/\/$/, "")}/internal/faucet/human-promo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationId: record.operationId,
      telegramId: record.telegramId,
      inviteId: record.inviteId,
      owner: record.owner,
      shadowAccount: record.shadowAccount,
      amount: record.amount,
      currency: record.currency,
      requestedAt: record.createdAt,
    }),
  });
  if (!res.ok) {
    throw new Error(`bridge faucet enqueue failed: ${res.status}`);
  }
  return "accepted";
}
