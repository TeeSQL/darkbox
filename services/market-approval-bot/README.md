# DarkBox Market Approval Bot

Small ops bot for the market proposal and confirmation gate.

Flow:
1. Anyone in the configured DarkBox Telegram group can submit `/propose <question>`, or an internal service can submit `POST /proposals`.
2. The bot posts the market details into the configured Telegram proposal topic.
3. Any group member can click **Confirm**. One confirmation is enough for MVP and records status `confirmed`.
4. DarkBox admins or explicit Ocean operators can click **Admin approve** or **Deny**. Operator access is configured by env and logged in the indexer audit table.
5. The bot records every proposal and decision through `/internal/market-proposals` on the indexer.

Environment:
- `TELEGRAM_BOT_TOKEN` — bot token from BotFather.
- `APPROVAL_CHAT_ID` — DarkBox group id, currently `-1003946790386`.
- `APPROVAL_THREAD_ID` — forum topic id for approvals. Current DarkBox topic: `894` (`04 Market Approvals`).
- `APPROVAL_ADMIN_USER_IDS` — comma-separated Telegram numeric user ids allowed to admin-approve or deny. Fran is `475212779`.
- `OCEAN_OPERATOR_TELEGRAM_IDS` — comma-separated Telegram numeric user ids allowed to propose/confirm/admin-approve/deny through an explicit audited operator role.
- `INDEXER_INTERNAL_URL` — defaults to `http://darkbox-indexer:8080/internal`.
- `TELEGRAM_ENABLE_POLLING` — set `true` only for a dedicated bot with no webhook. Default is `false`; configure Telegram webhook to `/telegram/webhook` for messages and button callbacks.

The bot does **not** create the on-chain market by itself. Confirmed or approved proposal rows are the handoff for a separate market executor. The default resolver type is always `AdminManual`; proposal expiry defaults in the indexer to Sunday 5pm `America/New_York` when no explicit close time is supplied.
