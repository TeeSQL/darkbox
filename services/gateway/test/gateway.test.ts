import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Configure BEFORE importing app modules (config reads env at import time).
process.env["TELEGRAM_BOT_TOKEN"] = "test-bot-token:123";
process.env["REGISTRATION_FREEZE_AT"] = "2999-01-01T00:00:00.000Z";
process.env["PROMO_UNLOCK_AT"] = "2999-01-01T00:00:00.000Z";

const { buildServer } = await import("../src/server.js");
const { validateInitData } = await import("../src/auth/telegram.js");
const { db } = await import("../src/store.js");

const TOKEN = "test-bot-token:123";

function makeInitData(user: object, authDateSec: number, token = TOKEN): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(authDateSec));
  params.set("query_id", "AAEtest");
  params.set("user", JSON.stringify(user));
  const pairs = [...params.entries()]
    .filter(([k]) => k !== "hash")
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

const nowSec = () => Math.floor(Date.now() / 1000);
const authHeader = (initData: string) => ({ authorization: `tma ${initData}` });

let app: Awaited<ReturnType<typeof buildServer>>;
before(async () => {
  app = await buildServer();
});
beforeEach(() => db._reset());
after(async () => {
  await app.close();
});

test("validateInitData accepts a correctly signed payload", () => {
  const initData = makeInitData({ id: 42, username: "neo" }, nowSec());
  const r = validateInitData(initData, TOKEN);
  assert.equal(r.ok, true);
  assert.equal(r.user?.id, "42");
});

test("validateInitData rejects a tampered payload", () => {
  const initData = makeInitData({ id: 42 }, nowSec());
  const tampered = initData.replace(/user=[^&]+/, "user=" + encodeURIComponent('{"id":99}'));
  assert.equal(validateInitData(tampered, TOKEN).ok, false);
});

test("validateInitData rejects an expired payload", () => {
  const initData = makeInitData({ id: 42 }, nowSec() - 999999);
  const r = validateInitData(initData, TOKEN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
});

test("unauthenticated /api/* is rejected with 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/self/status" });
  assert.equal(res.statusCode, 401);
});

test("invite claim is idempotent per identity ($5 once)", async () => {
  const headers = authHeader(makeInitData({ id: 7 }, nowSec()));
  const first = await app.inject({ method: "POST", url: "/api/invites/claim", headers, payload: {} });
  assert.equal(first.statusCode, 200);
  const a = first.json();
  assert.equal(a.claimStatus, "claimed");
  assert.equal(a.agentFundingCredit.amount, "5.00");
  assert.equal(a.withdrawalLock.locked, true);

  const second = await app.inject({ method: "POST", url: "/api/invites/claim", headers, payload: {} });
  const b = second.json();
  assert.equal(b.claimStatus, "already_claimed");
  assert.equal(b.inviteId, a.inviteId, "no second invite id => no double credit");
});

test("self/status reflects the claim", async () => {
  const headers = authHeader(makeInitData({ id: 8 }, nowSec()));
  await app.inject({ method: "POST", url: "/api/invites/claim", headers, payload: {} });
  const res = await app.inject({ method: "GET", url: "/api/self/status", headers });
  const s = res.json();
  assert.equal(s.enteredViaInvite, true);
  assert.equal(s.registrationStatus, "unregistered");
  assert.equal(s.withdrawalLock.locked, true);
});

test("whisper typed flow produces an instruction commitment", async () => {
  const headers = authHeader(makeInitData({ id: 9 }, nowSec()));
  const draft = await app.inject({
    method: "POST",
    url: "/api/whispers/transcriptions",
    headers,
    payload: { text: "Buy NO on thin AI-wrapper projects." },
  });
  assert.equal(draft.statusCode, 200);
  const d = draft.json();
  assert.equal(d.status, "draft_ready");

  const confirm = await app.inject({
    method: "POST",
    url: `/api/whispers/transcriptions/${d.whisperId}/confirm`,
    headers,
    payload: { finalTranscript: "Buy NO on thin AI-wrapper projects. Prefer real-usage infra." },
  });
  const c = confirm.json();
  assert.equal(c.status, "confirmed");
  assert.match(c.instructionHash, /^0x[0-9a-f]{64}$/);
});

test("arbitrary audioUrl is not accepted on the public whisper route (SSRF guard)", async () => {
  const headers = authHeader(makeInitData({ id: 77 }, nowSec()));
  const res = await app.inject({
    method: "POST",
    url: "/api/whispers/transcriptions",
    headers,
    payload: { audioUrl: "http://169.254.169.254/latest/meta-data" },
  });
  // audioUrl is not in the schema, so it's ignored -> no text/audio -> 400.
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "need_text_or_audio");
});

test("another user cannot read someone else's whisper draft", async () => {
  const aliceHeaders = authHeader(makeInitData({ id: 100 }, nowSec()));
  const bobHeaders = authHeader(makeInitData({ id: 200 }, nowSec()));
  const draft = await app.inject({
    method: "POST",
    url: "/api/whispers/transcriptions",
    headers: aliceHeaders,
    payload: { text: "secret strategy" },
  });
  const wid = draft.json().whisperId;
  const res = await app.inject({
    method: "GET",
    url: `/api/whispers/transcriptions/${wid}`,
    headers: bobHeaders,
  });
  assert.equal(res.statusCode, 403);
});

test("withdrawals are disabled by default (demo posture)", async () => {
  const headers = authHeader(makeInitData({ id: 11 }, nowSec()));
  const res = await app.inject({
    method: "POST",
    url: "/api/withdrawals/commands",
    headers,
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "withdrawals_disabled");
});
