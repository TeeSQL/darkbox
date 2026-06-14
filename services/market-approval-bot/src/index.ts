import http from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { IndexerClient } from "./indexer.js";
import { TelegramApi } from "./telegram.js";
import type { ProposalPayload, TelegramUpdate } from "./types.js";

const ProposalSchema = z.object({
  proposalId: z.string().min(1),
  agentId: z.string().optional(),
  question: z.string().min(1).max(512),
  description: z.string().optional(),
  outcomes: z.array(z.string()).optional(),
  resolveBy: z.string().optional(),
  resolutionSource: z.string().optional(),
  rationale: z.string().optional(),
  metadataURI: z.string().optional(),
  runId: z.string().optional(),
  turn: z.number().int().optional(),
  closeTime: z.union([z.string(), z.number().int()]).optional(),
  expiry: z.union([z.string(), z.number().int()]).optional(),
  proposerKind: z.string().optional(),
  proposerId: z.string().optional(),
  proposerTelegramId: z.string().optional(),
  proposerTelegramUsername: z.string().optional(),
  proposerRole: z.string().optional(),
});

const telegram = new TelegramApi(config.telegramBotToken);
const indexer = new IndexerClient(config.indexerInternalUrl);

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function handleProposal(payload: ProposalPayload): Promise<{ ok: true; messageId: number }> {
  if (!config.approvalChatId) throw new Error("APPROVAL_CHAT_ID is required");
  const message = await telegram.sendProposal(config.approvalChatId, config.approvalThreadId, payload);
  await indexer.upsertProposal(payload, {
    chatId: String(message.chat.id),
    threadId: String(message.message_thread_id ?? config.approvalThreadId ?? ""),
    messageId: String(message.message_id),
  });
  return { ok: true, messageId: message.message_id };
}

function isApprovalChat(chatId: string | number | undefined): boolean {
  return Boolean(config.approvalChatId) && String(chatId) === String(config.approvalChatId);
}

function roleFor(userId: string): "group_member" | "admin" | "operator" {
  if (config.oceanOperatorTelegramIds.has(userId)) return "operator";
  if (config.adminUserIds.has(userId)) return "admin";
  return "group_member";
}

async function handleCallback(update: TelegramUpdate): Promise<void> {
  const cb = update.callback_query;
  if (!cb?.data || !cb.message) return;
  const [action, proposalId] = cb.data.split(":", 2);
  if (!proposalId || (action !== "confirm" && action !== "approve" && action !== "deny")) return;
  const userId = String(cb.from.id);
  const role = roleFor(userId);
  if (!isApprovalChat(cb.message.chat.id) && role !== "operator") {
    await telegram.answerCallback(cb.id, "Use the DarkBox group proposal message");
    return;
  }
  if ((action === "approve" || action === "deny") && role === "group_member") {
    await telegram.answerCallback(cb.id, "Only admins/operators can approve or deny");
    return;
  }
  const status = action === "confirm" ? "confirmed" : action === "approve" ? "approved" : "denied";
  try {
    await telegram.removeButtons(cb.message);
  } catch (err) {
    console.warn("[market-approval-bot] button removal failed before decision", err);
  }
  await indexer.decide(proposalId, status, {
    telegramId: userId,
    telegramUsername: cb.from.username,
    role,
    reviewMessageId: String(cb.message.message_id),
  });
  try {
    await telegram.answerCallback(cb.id, `${status}: ${proposalId}`);
  } catch (err) {
    // Local smoke tests and expired Telegram callbacks have invalid callback IDs.
    // The durable decision is already recorded, so do not fail the webhook.
    console.warn("[market-approval-bot] callback acknowledgement failed", err);
  }
  const who = cb.from.username ? `@${cb.from.username}` : userId;
  const label = action === "confirm" ? "CONFIRMED" : action === "approve" ? "APPROVED" : "DENIED";
  await telegram.editDecision(cb.message, `${label} by ${who} (${role}). Proposal ${proposalId}.`);
}

async function handleMessage(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.text || !message.from) return;
  const userId = String(message.from.id);
  const role = roleFor(userId);
  if (!isApprovalChat(message.chat.id) && role !== "operator") return;
  const match = message.text.match(/^\/propose(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return;
  const question = match[1]?.trim();
  if (!question) {
    await telegram.sendText(message.chat.id, "Usage: /propose Will DarkBox ...?", message.message_thread_id);
    return;
  }
  const payload: ProposalPayload = {
    proposalId: `tg-${randomUUID()}`,
    question,
    outcomes: ["YES", "NO"],
    resolutionSource: "DarkBox admin manual",
    proposerKind: "telegram",
    proposerId: userId,
    proposerTelegramId: userId,
    proposerTelegramUsername: message.from.username,
    proposerRole: role,
  };
  const result = await handleProposal(payload);
  await telegram.sendText(message.chat.id, `Proposal queued: ${payload.proposalId} (message ${result.messageId})`, message.message_thread_id);
}

function startHttp(): void {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "darkbox-market-approval-bot" }));
        return;
      }
      if (req.method === "POST" && req.url === "/proposals") {
        const parsed = ProposalSchema.parse(await readJson(req));
        const result = await handleProposal(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === "POST" && req.url === "/telegram/webhook") {
        const update = await readJson(req) as TelegramUpdate;
        await handleCallback(update);
        await handleMessage(update);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown_error";
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(`[market-approval-bot] listening on :${config.port}`);
  });
}

async function startPolling(): Promise<void> {
  if (!config.enablePolling) {
    console.log("[market-approval-bot] polling disabled; configure Telegram webhook to /telegram/webhook");
    return;
  }
  if (!config.telegramBotToken) {
    console.warn("[market-approval-bot] TELEGRAM_BOT_TOKEN missing; polling disabled");
    return;
  }
  let offset = 0;
  for (;;) {
    try {
      const updates = await telegram.getUpdates(offset) as TelegramUpdate[];
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        await handleCallback(update);
        await handleMessage(update);
      }
    } catch (err) {
      console.error("[market-approval-bot] polling error", err);
      await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
  }
}

startHttp();
void startPolling();
