/**
 * Billboard hidden-state sanitizer — the indexer-side trust boundary.
 *
 * The Python event agents already gate + sanitize billboards before submitting
 * (see services/agents/event_agents/policy.py), but the indexer must be safe
 * against *any* client, so it re-runs this check on every billboard it persists.
 * Mirrors the Python `sanitize_billboard` forbidden-pattern list.
 *
 * A message matching any forbidden pattern is rejected outright (never partially
 * stripped — partial stripping risks residual leakage of addresses / shadow
 * accounts / keys / private book or position dumps).
 */
export type BillboardRejectReason = "blank" | "hidden_state_leak";

export interface BillboardSanitizeResult {
  ok: boolean;
  message?: string;
  reason?: BillboardRejectReason;
  leakPattern?: string;
}

const FORBIDDEN_BILLBOARD_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "evm_address", re: /0x[0-9a-fA-F]{40}\b/ },
  { name: "long_hex_secret", re: /0x[0-9a-fA-F]{64}/ },
  { name: "shadow_account", re: /shadow[_ ]?account/i },
  { name: "private_key", re: /private[_ ]?key|priv[_ ]?key|seed phrase|mnemonic/i },
  { name: "book_address", re: /v0:book:|book[_ ]?address/i },
  { name: "portfolio_dump", re: /\bPORTFOLIO\b|TAKE_PROFIT_SIGNALS/ },
  { name: "position_internal", re: /avg[_ ]?entry|realized[_ ]?pnl|unrealized[_ ]?pnl/i },
  { name: "balance_internal", re: /current[_ ]?balance|total[_ ]?deposited|total[_ ]?withdrawn/i },
  { name: "orderbook_json_dump", re: /\{[^}]*"(?:size|avgEntry|outcome)"\s*:[^}]*"(?:price|avgEntry|size)"\s*:/i },
];

export function sanitizeBillboardMessage(raw: string, maxLength = 280): BillboardSanitizeResult {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return { ok: false, reason: "blank" };
  for (const { name, re } of FORBIDDEN_BILLBOARD_PATTERNS) {
    if (re.test(collapsed)) return { ok: false, reason: "hidden_state_leak", leakPattern: name };
  }
  const message = collapsed.length > maxLength ? collapsed.slice(0, maxLength).trimEnd() : collapsed;
  return { ok: true, message };
}
