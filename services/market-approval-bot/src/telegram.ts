import type { ProposalPayload, TelegramMessage } from "./types.js";

type InlineKeyboardButton = { text: string; callback_data: string };

export function renderProposal(p: ProposalPayload): string {
  const lines = [
    "Market proposal",
    "",
    `ID: ${p.proposalId}`,
    `Question: ${p.question}`,
  ];
  if (p.description) lines.push(`Description: ${p.description}`);
  if (p.agentId) lines.push(`Proposed by: ${p.agentId}`);
  if (p.proposerTelegramUsername) lines.push(`Telegram proposer: @${p.proposerTelegramUsername}`);
  else if (p.proposerTelegramId) lines.push(`Telegram proposer: ${p.proposerTelegramId}`);
  if (p.closeTime) lines.push(`Close time: ${p.closeTime}`);
  if (p.resolveBy) lines.push(`Resolve by: ${p.resolveBy}`);
  if (p.resolutionSource) lines.push(`Resolution: ${p.resolutionSource}`);
  lines.push("Resolution type: DarkBox admin manual");
  lines.push("Creator bond: 0");
  lines.push("Initial liquidity: 0 unless explicitly set at creation");
  if (p.rationale) lines.push("", `Rationale: ${p.rationale}`);
  lines.push("", "One DarkBox group confirmation makes this ready for the market executor. Admin approval is an explicit operator override.");
  return lines.join("\n");
}

export function approvalKeyboard(proposalId: string): InlineKeyboardButton[][] {
  return [
    [{ text: "Confirm", callback_data: `confirm:${proposalId}` }],
    [
      { text: "Admin approve", callback_data: `approve:${proposalId}` },
      { text: "Deny", callback_data: `deny:${proposalId}` },
    ],
  ];
}

export class TelegramApi {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    if (!this.token) throw new Error("TELEGRAM_BOT_TOKEN is required");
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json() as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(json.description ?? `Telegram ${method} failed`);
    return json.result as T;
  }

  async sendProposal(chatId: string, threadId: string, proposal: ProposalPayload): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: renderProposal(proposal),
      reply_markup: { inline_keyboard: approvalKeyboard(proposal.proposalId) },
      disable_web_page_preview: true,
    };
    if (threadId) body["message_thread_id"] = Number(threadId);
    return this.call<TelegramMessage>("sendMessage", body);
  }

  async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: false });
  }

  async removeButtons(message: TelegramMessage): Promise<void> {
    // Telegram removes an inline keyboard when editMessageReplyMarkup is called
    // without reply_markup. Passing { inline_keyboard: [] } can leave stale
    // client-side button UI on some Telegram clients.
    await this.call("editMessageReplyMarkup", { chat_id: message.chat.id, message_id: message.message_id });
  }

  async editDecision(message: TelegramMessage, statusLine: string): Promise<void> {
    const original = (message.text ?? "").trim();
    const text = original ? `${original}

${statusLine}` : statusLine;
    await this.call("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text,
      disable_web_page_preview: true,
    });
    await this.removeButtons(message);
  }

  async sendText(chatId: string | number, text: string, threadId?: string | number): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (threadId) body["message_thread_id"] = Number(threadId);
    return this.call<TelegramMessage>("sendMessage", body);
  }

  async getUpdates(offset: number): Promise<Array<{ update_id: number; callback_query?: unknown; message?: unknown }>> {
    return this.call("getUpdates", { offset, timeout: 20, allowed_updates: ["callback_query", "message"] });
  }
}
