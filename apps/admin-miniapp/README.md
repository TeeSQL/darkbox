# Daemon Hall Admin Mini App

Standalone operator/admin Mini App, intentionally separated from the player Telegram Mini App.

- Intended host: `https://daemonhall-admin.repo.box/`
- Bot: `@darkbox_mic_lab_bot`, renamed/displayed as **Daemon Hall Admin**, configured with menu button → `https://daemonhall-admin.repo.box/`
- Local source: `apps/admin-miniapp/`
- Build: `pnpm --filter @darkbox/admin-miniapp build`
- Runtime API: `pnpm --filter @darkbox/admin-miniapp start`

The admin app only proxies operator-safe indexer data today. Privileged controls remain pending until explicit operator auth exists.

If `ADMIN_ACCESS_TOKEN` is set, every page/API route except `/healthz` and the Telegram webhook requires `?token=...` once; the server stores an HttpOnly cookie and redirects to a clean URL.
