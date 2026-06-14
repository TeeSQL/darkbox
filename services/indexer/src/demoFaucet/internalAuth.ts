/**
 * Internal-only gate for the demo-faucet mint route.
 *
 * Defense-in-depth: even though POST /public/demo-faucet lives under the
 * indexer's `/public/*` namespace, it is a privileged mint and must only ever be
 * reachable from the Telegram-authed gateway hop — never directly, even if the
 * indexer's public port were somehow exposed. This mirrors the faucet-mint-worker
 * `x-mesh-token` pattern: a shared sealed secret (INTERNAL_FAUCET_TOKEN) present
 * on BOTH the gateway and the indexer; the gateway presents it as `x-internal-token`
 * and the indexer refuses anything missing/with the wrong token.
 *
 * Fail closed: if no token is configured the route refuses (503) rather than
 * running open — it can't be safely exposed without the shared secret.
 *
 * Pure function of (presented, expected) so it is unit-testable with no server.
 */
export interface InternalAuthResult {
  ok: boolean;
  statusCode?: number;
  body?: Record<string, unknown>;
}

export function checkInternalToken(
  presented: string | undefined,
  expected: string,
): InternalAuthResult {
  if (!expected) {
    return {
      ok: false,
      statusCode: 503,
      body: { error: "demo_faucet_internal_auth_not_configured" },
    };
  }
  if (!presented || presented !== expected) {
    return { ok: false, statusCode: 401, body: { error: "unauthorized" } };
  }
  return { ok: true };
}
