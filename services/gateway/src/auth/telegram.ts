/**
 * Telegram Mini App `initData` validation.
 *
 * Telegram signs the launch params with a key derived from the bot token:
 *   secret_key      = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   data_check_str  = join("\n", sorted("<k>=<v>" for k != "hash"))
 *   expected_hash   = hex(HMAC_SHA256(key=secret_key, msg=data_check_str))
 * The payload is authentic iff expected_hash === provided hash.
 *
 * Ref: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * We additionally enforce an `auth_date` freshness window to bound replay.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export interface TelegramUser {
  id: string; // numeric Telegram id, stringified (stable identity key)
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
}

export interface AuthResult {
  ok: boolean;
  user?: TelegramUser;
  reason?: string;
  /** true when the request was authenticated via the insecure dev fallback. */
  dev?: boolean;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Validate a raw `initData` query string. Returns the resolved Telegram user on
 * success. Pure function of (initData, token, now) so it is unit-testable.
 */
export function validateInitData(
  initData: string,
  botToken: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): AuthResult {
  if (!initData) return { ok: false, reason: "missing_init_data" };
  if (!botToken) return { ok: false, reason: "server_missing_bot_token" };

  const params = new URLSearchParams(initData);
  const providedHash = params.get("hash");
  if (!providedHash) return { ok: false, reason: "missing_hash" };

  // Build the data-check string from every field except `hash`, sorted by key.
  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    if (k === "hash") continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (!constantTimeEqualHex(expectedHash, providedHash)) {
    return { ok: false, reason: "bad_hash" };
  }

  // Freshness: reject stale launches to bound replay.
  const authDate = parseInt(params.get("auth_date") ?? "0", 10);
  if (!authDate) return { ok: false, reason: "missing_auth_date" };
  if (nowSec - authDate > config.telegramAuthMaxAgeSec) {
    return { ok: false, reason: "expired" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "missing_user" };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(userRaw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "bad_user_json" };
  }
  if (parsed["id"] === undefined || parsed["id"] === null) {
    return { ok: false, reason: "missing_user_id" };
  }

  return {
    ok: true,
    user: {
      id: String(parsed["id"]),
      username: parsed["username"] as string | undefined,
      firstName: parsed["first_name"] as string | undefined,
      lastName: parsed["last_name"] as string | undefined,
      languageCode: parsed["language_code"] as string | undefined,
    },
  };
}

/**
 * Authenticate a request. Reads `initData` from either the
 * `Authorization: tma <initData>` header or an `X-Telegram-Init-Data` header.
 *
 * Dev fallback: when no bot token is configured AND `ALLOW_INSECURE_DEV_AUTH` is
 * set, accepts an `X-Dev-Telegram-Id` header so the stack is runnable locally
 * without a bot token. This path is refused whenever a token IS configured.
 */
export function authenticate(headers: Record<string, unknown>): AuthResult {
  const authz = (headers["authorization"] as string | undefined) ?? "";
  const headerInit = (headers["x-telegram-init-data"] as string | undefined) ?? "";
  const initData = authz.toLowerCase().startsWith("tma ")
    ? authz.slice(4).trim()
    : headerInit;

  if (config.telegramBotToken) {
    return validateInitData(initData, config.telegramBotToken);
  }

  // No token configured.
  if (config.allowInsecureDevAuth) {
    const devId = (headers["x-dev-telegram-id"] as string | undefined) ?? "";
    if (devId) {
      return { ok: true, dev: true, user: { id: String(devId), username: "dev_user" } };
    }
    return { ok: false, reason: "dev_missing_x_dev_telegram_id" };
  }

  return { ok: false, reason: "server_missing_bot_token" };
}
