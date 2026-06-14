import crypto from 'node:crypto';

/**
 * The reveal bundle as exported by the indexer. Kept loose here (the indexer
 * owns the canonical shape); reveal only needs the fields it digests and checks.
 */
export interface RevealBundle {
  generatedAt: string;
  agents: { agentId?: string; shadowAccount: string }[];
  actions: unknown[];
  finalLeaderboard: { agentId: string }[];
  [key: string]: unknown;
}

export interface PackagedBundle {
  digest: string;
  bytes: number;
  actionCount: number;
  agentCount: number;
  bundle: RevealBundle;
  /** Internal-consistency findings; empty means the bundle checks out. */
  issues: string[];
}

/** Canonical JSON (sorted keys) so the digest is stable across runs. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Package an exported bundle: compute a stable content digest and run
 * internal-consistency checks (every leaderboard agent is a registered agent;
 * the action log is present). Full cryptographic replay verification — re-run
 * `actions` through the engine and assert the leaderboard matches — is the
 * intended next step; the bundle carries the complete ordered action log that
 * makes it possible for any independent verifier.
 */
export function packageBundle(bundle: RevealBundle): PackagedBundle {
  const canonicalText = canonical(bundle);
  const registered = new Set(bundle.agents.map((a) => a.agentId).filter(Boolean));
  const issues: string[] = [];
  for (const row of bundle.finalLeaderboard) {
    if (!registered.has(row.agentId)) issues.push(`leaderboard agent not registered: ${row.agentId}`);
  }
  if (!Array.isArray(bundle.actions)) issues.push('missing action log');

  return {
    digest: sha256(canonicalText),
    bytes: Buffer.byteLength(canonicalText),
    actionCount: Array.isArray(bundle.actions) ? bundle.actions.length : 0,
    agentCount: bundle.agents.length,
    bundle,
    issues,
  };
}
