import { test } from "node:test";
import assert from "node:assert/strict";
import { createIndexerClient, IndexerError } from "./indexer.js";

interface Call {
  url: string;
  method: string;
}

/** Fake fetch recording requests and replying from a route map. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    calls.push({ url, method });
    const route = routes[path] ?? { body: {} };
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      async text() {
        return JSON.stringify(route.body);
      },
      async json() {
        return route.body;
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("hits /public/* paths and strips trailing slash from base", async () => {
  const { impl, calls } = fakeFetch({
    "/public/leaderboard": { body: [{ agentId: "a", rank: 1 }] },
  });
  const c = createIndexerClient({ baseUrl: "http://idx/", fetchImpl: impl });
  const board = await c.leaderboard();
  assert.equal(calls[0]?.url, "http://idx/public/leaderboard");
  assert.equal(board[0]?.agentId, "a");
});

test("encodes market id and returns detail", async () => {
  const { impl, calls } = fakeFetch({
    "/public/markets/0xABC": { body: { market_id: "0xabc", question: "q" } },
  });
  const c = createIndexerClient({ baseUrl: "http://idx", fetchImpl: impl });
  await c.market("0xABC");
  assert.equal(calls[0]?.url, "http://idx/public/markets/0xABC");
});

test("throws IndexerError on non-2xx", async () => {
  const { impl } = fakeFetch({
    "/public/game": { status: 503, body: { error: "down" } },
  });
  const c = createIndexerClient({ baseUrl: "http://idx", fetchImpl: impl });
  await assert.rejects(() => c.game(), (err) => {
    assert.ok(err instanceof IndexerError);
    assert.equal(err.status, 503);
    return true;
  });
});
