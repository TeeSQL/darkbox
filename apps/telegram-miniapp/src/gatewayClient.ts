/**
 * DarkBox gateway client — the "tiny client" for the Telegram Mini App.
 *
 * Self-contained and framework-agnostic (browser `fetch`, zero deps). It talks
 * to the authenticated player gateway (`/api/*`) and the public indexer
 * (`/public/*`). Point `gatewayBaseUrl` / `publicBaseUrl` at a local stack now
 * and the deployed services later — nothing else changes.
 *
 * Auth: every `/api/*` call carries the Telegram Mini App `initData` as
 * `Authorization: tma <initData>`. For local dev without a bot token, pass
 * `devTelegramId` and the gateway (with ALLOW_INSECURE_DEV_AUTH=true) accepts
 * an `X-Dev-Telegram-Id` header instead.
 *
 * See GATEWAY_WIRING.md for exactly which flow.js mock points each call replaces.
 */

export interface WithdrawalLock {
  locked: boolean;
  reason: string | null;
  unlockAt: string | null;
}

export interface SelfStatus {
  owner: string;
  ownerIsSynthetic: boolean;
  telegramId: string;
  agentId: string;
  registrationStatus: "registered" | "unregistered";
  fundingStatus: "unfunded" | "promo_funded";
  enteredViaInvite: boolean;
  inviteId: string | null;
  withdrawableAvailableBalance: string | null;
  instructionCommitmentHash: string | null;
  withdrawalLock: WithdrawalLock;
  registrationFreezeAt: string;
  updatedAt: string;
}

export interface ClaimResult {
  inviteId: string;
  claimStatus: "claimed" | "already_claimed";
  agentFundingCredit: { currency: string; amount: string; type: string };
  withdrawalLock: { locked: boolean; unlockAt: string };
  shadowAccount: string;
  updatedAt: string;
}

export interface WhisperDraft {
  whisperId: string;
  status: "draft_ready" | "confirmed";
  transcript: string;
  language: string;
  durationMs: number;
  instructionHash?: string;
  updatedAt: string;
}

export interface ConfirmResult {
  whisperId: string;
  status: "confirmed";
  instructionHash: string;
  commitmentPayload: { instructionHash: string; transcriptHash: string };
  updatedAt: string;
}

export interface RegisterResult {
  registrationStatus: "registered";
  agentId: string;
  commitmentRecorded: boolean;
  instructionHash: string;
  registeredAt: string;
  frozen: boolean;
}

export interface LeaderboardRow {
  agentId: string;
  displayName?: string;
  ensName?: string;
  pnl: number | string;
  rank: number;
  updatedAt?: string;
}

export interface GatewayClientConfig {
  /** Authenticated player API, e.g. http://localhost:8090 or https://gateway.darkbox… */
  gatewayBaseUrl: string;
  /** Public indexer spectator API, e.g. http://localhost:8080/public */
  publicBaseUrl?: string;
  /** Returns the Telegram Mini App initData string. Defaults to window.Telegram.WebApp.initData. */
  getInitData?: () => string | undefined;
  /** Local-dev only: gateway must run with ALLOW_INSECURE_DEV_AUTH=true. */
  devTelegramId?: string;
  /** Injectable fetch (defaults to global fetch); handy for tests. */
  fetchImpl?: typeof fetch;
}

export class GatewayError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`gateway ${status}`);
    this.name = "GatewayError";
  }
}

function defaultInitData(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Telegram?: { WebApp?: { initData?: string } } })
    .Telegram?.WebApp?.initData;
}

export function createGatewayClient(config: GatewayClientConfig) {
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const getInitData = config.getInitData ?? defaultInitData;
  const gw = config.gatewayBaseUrl.replace(/\/$/, "");
  const pub = (config.publicBaseUrl ?? "").replace(/\/$/, "");

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    const initData = getInitData();
    if (initData) h["authorization"] = `tma ${initData}`;
    else if (config.devTelegramId) h["x-dev-telegram-id"] = config.devTelegramId;
    return h;
  }

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${gw}${path}`, {
      method,
      headers: { "content-type": "application/json", ...authHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new GatewayError(res.status, parsed);
    return parsed as T;
  }

  return {
    // ── Authenticated player API ──────────────────────────────────────────
    selfStatus: () => api<SelfStatus>("GET", "/api/self/status"),

    claimInvite: (opts: { inviteCode?: string; owner?: string } = {}) =>
      api<ClaimResult>("POST", "/api/invites/claim", opts),

    /** Create a whisper draft from typed text (or a Telegram file id). */
    createWhisper: (opts: { text?: string; telegramFileId?: string; languageHint?: string }) =>
      api<WhisperDraft>("POST", "/api/whispers/transcriptions", opts),

    getWhisper: (whisperId: string) =>
      api<WhisperDraft>("GET", `/api/whispers/transcriptions/${encodeURIComponent(whisperId)}`),

    confirmWhisper: (whisperId: string, finalTranscript: string) =>
      api<ConfirmResult>(
        "POST",
        `/api/whispers/transcriptions/${encodeURIComponent(whisperId)}/confirm`,
        { finalTranscript },
      ),

    register: (opts: {
      agentName: string;
      instructionHash: string;
      ensName?: string;
      revealSaltHash?: string;
      runtimeHash?: string;
    }) => api<RegisterResult>("POST", "/api/registrations", opts),

    // ── Public spectator API (no auth) ────────────────────────────────────
    async leaderboard(): Promise<LeaderboardRow[]> {
      if (!pub) return [];
      const res = await doFetch(`${pub}/leaderboard`);
      if (!res.ok) return [];
      return (await res.json()) as LeaderboardRow[];
    },

    /**
     * One-shot join flow (Ocean's spec):
     *   self-status → claim promo (if not entered) → whisper(typed) → confirm →
     *   register → self-status refresh.
     * Returns each step's result so the UI can drive its existing screens.
     */
    async runJoinFlow(opts: { agentName: string; whisperText: string }) {
      const before = await this.selfStatus();
      const claim = before.enteredViaInvite ? null : await this.claimInvite();
      const draft = await this.createWhisper({ text: opts.whisperText });
      const confirmed = await this.confirmWhisper(draft.whisperId, opts.whisperText);
      const registration = await this.register({
        agentName: opts.agentName,
        instructionHash: confirmed.instructionHash,
      });
      const after = await this.selfStatus();
      return { before, claim, draft, confirmed, registration, after };
    },
  };
}

export type GatewayClient = ReturnType<typeof createGatewayClient>;
