export const config = {
  port: parseInt(process.env["PORT"] ?? "8097", 10),
  telegramBotToken: process.env["TELEGRAM_BOT_TOKEN"] ?? "",
  approvalChatId: process.env["APPROVAL_CHAT_ID"] ?? "",
  approvalThreadId: process.env["APPROVAL_THREAD_ID"] ?? "",
  adminUserIds: new Set(
    (process.env["APPROVAL_ADMIN_USER_IDS"] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  ),
  oceanOperatorTelegramIds: new Set(
    (process.env["OCEAN_OPERATOR_TELEGRAM_IDS"] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  ),
  indexerInternalUrl: (process.env["INDEXER_INTERNAL_URL"] ?? "http://darkbox-indexer:8080/internal").replace(/\/$/, ""),
  pollMs: parseInt(process.env["TELEGRAM_POLL_MS"] ?? "1500", 10),
  enablePolling: (process.env["TELEGRAM_ENABLE_POLLING"] ?? "false") === "true",
};
