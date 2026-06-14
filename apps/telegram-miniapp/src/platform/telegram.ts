/**
 * Platform adapter — the single seam between "running inside Telegram" and
 * "running as a plain web page".
 *
 * The miniapp and the web build are the SAME bundle in the SAME webview; the
 * only real difference is whether `window.Telegram.WebApp` exists. Everything
 * that differs between the two targets lives here and nowhere else, so views
 * and the api layer never branch on the platform themselves.
 *
 * Web/dev fallbacks are intentionally no-ops or env-driven so the app renders
 * and authenticates outside Telegram (using the gateway's dev-auth path).
 */

interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  button_color?: string;
  [key: string]: string | undefined;
}

interface TelegramWebApp {
  initData?: string;
  themeParams?: TelegramThemeParams;
  colorScheme?: "light" | "dark";
  ready?: () => void;
  expand?: () => void;
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy") => void;
    notificationOccurred?: (type: "error" | "success" | "warning") => void;
  };
}

function webApp(): TelegramWebApp | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram
    ?.WebApp;
}

/** True when running inside the Telegram client (initData is present). */
export function isTelegram(): boolean {
  const app = webApp();
  return Boolean(app?.initData);
}

/**
 * The Telegram Mini App `initData` string used to authenticate gateway calls.
 * Undefined on the web — callers fall back to dev auth (see `devTelegramId`).
 */
export function getInitData(): string | undefined {
  return webApp()?.initData || undefined;
}

/** Local/web dev only: read X-Dev-Telegram-Id from a build-time env var. */
export function getDevTelegramId(): string | undefined {
  // Vite inlines import.meta.env.* at build time.
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.VITE_DEV_TELEGRAM_ID || undefined;
}

export type ColorScheme = "light" | "dark";

export function colorScheme(): ColorScheme {
  return webApp()?.colorScheme ?? "dark";
}

/** Light haptic tap — no-op on the web. */
export function haptic(style: "light" | "medium" | "heavy" = "light"): void {
  webApp()?.HapticFeedback?.impactOccurred?.(style);
}

/** Call once on boot: tell Telegram we're ready and expand to full height. */
export function initPlatform(): void {
  const app = webApp();
  app?.ready?.();
  app?.expand?.();
}
