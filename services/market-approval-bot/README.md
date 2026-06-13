# DarkBox Market Approval Bot

Small ops bot for the market-creation gate.

Flow:
1. A gateway/indexer/agent submits a proposal to `POST /proposals`.
2. The bot posts the market details into the configured Telegram approval topic.
3. A DarkBox admin clicks **Approve** or **Deny**.
4. The bot records the decision through `POST /internal/market-proposals/:proposalId/decision` on the indexer.

Environment:
- `TELEGRAM_BOT_TOKEN` — bot token from BotFather.
- `APPROVAL_CHAT_ID` — DarkBox group id, currently `-1003946790386`.
- `APPROVAL_THREAD_ID` — forum topic id for approvals. Current DarkBox topic: `894` (`04 Market Approvals`).
- `APPROVAL_ADMIN_USER_IDS` — comma-separated Telegram numeric user ids allowed to click buttons. Fran is `475212779`.
- `INDEXER_INTERNAL_URL` — defaults to `http://darkbox-indexer:8080/internal`.
- `TELEGRAM_ENABLE_POLLING` — set `true` only for a dedicated bot with no webhook. Default is `false`; configure Telegram webhook to `/telegram/webhook` for button callbacks.

The bot does **not** create the on-chain market by itself yet. It is the approval gate and audit trail. The execution step should consume approved rows and create the on-chain market through the admin/coordinator key.
