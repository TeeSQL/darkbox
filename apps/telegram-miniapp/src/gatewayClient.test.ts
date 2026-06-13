import { test } from "node:test";
import assert from "node:assert/strict";
import { createGatewayClient } from "./gatewayClient.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Build a fake fetch that records calls and replies from a route map. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    calls.push({
      url,
      method,
      headers: (init.headers as Record<string, string>) ?? {},
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const key = `${method} ${path}`;
    const payload = routes[key] ?? routes[path] ?? {};
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
      async json() {
        return payload;
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SELF = {
  enteredViaInvite: false,
  registrationStatus: "unregistered",
  agentId: "agent_x",
};

test("auth header uses initData when present", async () => {
  const { impl, calls } = fakeFetch({ "GET /api/self/status": SELF });
  const c = createGatewayClient({
    gatewayBaseUrl: "http://gw",
    getInitData: () => "user=abc&hash=def",
    fetchImpl: impl,
  });
  await c.selfStatus();
  assert.equal(calls[0]?.headers["authorization"], "tma user=abc&hash=def");
});

test("dev telegram id is used when no initData", async () => {
  const { impl, calls } = fakeFetch({ "GET /api/self/status": SELF });
  const c = createGatewayClient({
    gatewayBaseUrl: "http://gw",
    getInitData: () => undefined,
    devTelegramId: "99",
    fetchImpl: impl,
  });
  await c.selfStatus();
  assert.equal(calls[0]?.headers["x-dev-telegram-id"], "99");
  assert.equal(calls[0]?.headers["authorization"], undefined);
});

test("claimInvite posts to the invite endpoint", async () => {
  const { impl, calls } = fakeFetch({
    "POST /api/invites/claim": { claimStatus: "claimed", inviteId: "i1" },
  });
  const c = createGatewayClient({ gatewayBaseUrl: "http://gw", devTelegramId: "1", fetchImpl: impl });
  const r = await c.claimInvite();
  assert.equal(r.claimStatus, "claimed");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "http://gw/api/invites/claim");
});

test("runJoinFlow executes the full sequence in order", async () => {
  const { impl, calls } = fakeFetch({
    "GET /api/self/status": SELF,
    "POST /api/invites/claim": { claimStatus: "claimed", inviteId: "i1" },
    "POST /api/whispers/transcriptions": { whisperId: "w1", status: "draft_ready" },
    "POST /api/whispers/transcriptions/w1/confirm": {
      whisperId: "w1",
      status: "confirmed",
      instructionHash: "0xhash",
      commitmentPayload: { instructionHash: "0xhash", transcriptHash: "0xt" },
    },
    "POST /api/registrations": { registrationStatus: "registered", agentId: "agent_x", instructionHash: "0xhash" },
  });
  const c = createGatewayClient({ gatewayBaseUrl: "http://gw", devTelegramId: "1", fetchImpl: impl });
  const out = await c.runJoinFlow({ agentName: "Murmur", whisperText: "Buy NO on wrappers" });

  assert.equal(out.claim?.claimStatus, "claimed");
  assert.equal(out.confirmed.instructionHash, "0xhash");
  assert.equal(out.registration.registrationStatus, "registered");
  // Order: self-status, claim, whisper, confirm, register, self-status
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url.replace("http://gw", "")}`),
    [
      "GET /api/self/status",
      "POST /api/invites/claim",
      "POST /api/whispers/transcriptions",
      "POST /api/whispers/transcriptions/w1/confirm",
      "POST /api/registrations",
      "GET /api/self/status",
    ],
  );
});

test("runJoinFlow skips claim when already entered via invite", async () => {
  const { impl, calls } = fakeFetch({
    "GET /api/self/status": { ...SELF, enteredViaInvite: true },
    "POST /api/whispers/transcriptions": { whisperId: "w1", status: "draft_ready" },
    "POST /api/whispers/transcriptions/w1/confirm": {
      whisperId: "w1",
      status: "confirmed",
      instructionHash: "0xhash",
      commitmentPayload: { instructionHash: "0xhash", transcriptHash: "0xt" },
    },
    "POST /api/registrations": { registrationStatus: "registered", agentId: "agent_x", instructionHash: "0xhash" },
  });
  const c = createGatewayClient({ gatewayBaseUrl: "http://gw", devTelegramId: "1", fetchImpl: impl });
  const out = await c.runJoinFlow({ agentName: "Murmur", whisperText: "x" });
  assert.equal(out.claim, null);
  assert.ok(!calls.some((c) => c.url.includes("/invites/claim")));
});
