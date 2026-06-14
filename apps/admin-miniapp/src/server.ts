import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 3015);
const publicDir = fileURLToPath(new URL('../dist/', import.meta.url));
const appUrl = process.env.ADMIN_MINIAPP_URL ?? `http://localhost:${port}`;
const token = process.env.ADMIN_TELEGRAM_BOT_TOKEN ?? '';
const webhookSecret = process.env.ADMIN_TELEGRAM_WEBHOOK_SECRET ?? '';
const accessToken = process.env.ADMIN_ACCESS_TOKEN ?? '';
const defaultIndexerPublicUrl = (process.env.ADMIN_INDEXER_PUBLIC_URL ?? process.env.INDEXER_PUBLIC_URL ?? 'https://d52dd8da602484730a36c648ae09672b6e2b1334-8080.dstack-base-prod5.phala.network').replace(/\/$/, '');
const devIndexerPublicUrl = (process.env.ADMIN_DEV_INDEXER_PUBLIC_URL ?? 'http://127.0.0.1:18080').replace(/\/$/, '');
const indexerSources = {
  mesh: { id: 'mesh', label: 'AttestMesh live gateway', url: defaultIndexerPublicUrl },
  dev: { id: 'dev', label: 'Teebox devnet / local agent tunnel — not canonical', url: devIndexerPublicUrl },
} as const;
type IndexerSourceId = keyof typeof indexerSources;
type IndexerSource = (typeof indexerSources)[IndexerSourceId];
const agentFeedPath = process.env.ADMIN_AGENT_FEED_PATH ?? process.env.AGENT_FEED_PATH ?? '';
const sourceLabel = process.env.ADMIN_SOURCE_LABEL ?? 'unlabeled admin source';

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

type TelegramMessage = { chat?: { id: number | string }; text?: string };
type TelegramUpdate = { message?: TelegramMessage };

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function sendRedirect(res: ServerResponse, location: string, headers: Record<string, string> = {}) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end();
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function isAuthorized(req: IncomingMessage, url: URL): boolean {
  if (!accessToken) return true;
  if (url.searchParams.get('token') === accessToken) return true;
  return parseCookies(req.headers.cookie).daemonhall_admin === accessToken;
}

function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (!accessToken) return true;
  if (url.pathname === '/healthz' || url.pathname === '/telegram/webhook') return true;
  if (url.searchParams.get('token') === accessToken) {
    url.searchParams.delete('token');
    const clean = `${url.pathname}${url.search}${url.hash}` || '/';
    sendRedirect(res, clean, {
      'Set-Cookie': `daemonhall_admin=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
    });
    return false;
  }
  if (isAuthorized(req, url)) return true;
  send(res, 401, 'admin token required');
  return false;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function callTelegram(method: string, payload: unknown) {
  if (!token) return;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(`Telegram ${method} failed: ${response.status} ${body.slice(0, 300)}`);
  }
}

function getIndexerSource(url: URL): IndexerSource {
  const requested = url.searchParams.get('source');
  return requested === 'dev' ? indexerSources.dev : indexerSources.mesh;
}

async function fetchIndexerJson(path: string, source: IndexerSource = indexerSources.mesh): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${source.url}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function handlePublicIndexerProxy(req: IncomingMessage, res: ServerResponse, url: URL) {
  const { pathname, search } = url;
  if (req.method !== 'GET') return send(res, 405, 'method not allowed');
  if (!pathname.startsWith('/public/')) return send(res, 404, 'not found');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const source = getIndexerSource(url);
    const upstreamUrl = new URL(pathname, `${source.url}/`);
    for (const [key, value] of url.searchParams) if (key !== 'source' && key !== 'token') upstreamUrl.searchParams.append(key, value);
    const response = await fetch(upstreamUrl, { signal: controller.signal });
    const body = await response.text();
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: 'indexer_proxy_unavailable', message });
  } finally {
    clearTimeout(timeout);
  }
}

function getString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length ? value : fallback;
}

function getNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function firstString(source: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length) return value;
  }
  return fallback;
}

function normalizeIso(value: unknown): string | null {
  if (typeof value === 'string' && value.length) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    if (/^\d+$/.test(value)) return new Date(Number(value) * 1000).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * (value > 10_000_000_000 ? 1 : 1000)).toISOString();
  return null;
}

function normalizeMarket(raw: unknown) {
  const market = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const trades = getNumber(market.trades ?? market.totalTrades ?? market.trade_count, 0);
  const volume = String(market.volume ?? market.totalVolume ?? market.total_volume ?? '0');
  const yesShare = getNumber(market.yesShare ?? market.yes_share ?? market.yesProbability ?? market.yes_probability, 50);
  const noShare = getNumber(market.noShare ?? market.no_share ?? market.noProbability ?? market.no_probability, Math.max(0, 100 - yesShare));
  return {
    marketId: firstString(market, ['marketId', 'market_id', 'id']),
    question: firstString(market, ['question', 'title'], 'Untitled market'),
    status: firstString(market, ['status'], 'unknown'),
    closesAt: normalizeIso(market.closesAt ?? market.close_time ?? market.closeTime),
    updatedAt: normalizeIso(market.updatedAt ?? market.updated_at ?? market.created_at_ts),
    yesShare,
    noShare,
    volume,
    trades,
  };
}

function normalizeLeaderboard(raw: unknown) {
  const entries = Array.isArray(raw) ? raw : [];
  return entries.slice(0, 10).map((item, index) => {
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      rank: getNumber(entry.rank, index + 1),
      displayName: firstString(entry, ['displayName', 'display_name', 'agentId', 'agent_id'], `Agent ${index + 1}`),
      ensName: firstString(entry, ['ensName', 'ens_name'], '') || null,
      pnl: String(entry.pnl ?? '0'),
    };
  });
}

async function handleMarketSnapshot(req: IncomingMessage, res: ServerResponse, url: URL) {
  const source = getIndexerSource(url);
  try {
    const [gameResult, marketsResult, activityResult, leaderboardResult] = await Promise.allSettled([
      fetchIndexerJson('/public/game', source),
      fetchIndexerJson('/public/markets', source),
      fetchIndexerJson('/public/activity', source),
      fetchIndexerJson('/public/leaderboard', source),
    ]);

    const gameRaw = gameResult.status === 'fulfilled' && gameResult.value && typeof gameResult.value === 'object'
      ? gameResult.value as Record<string, unknown>
      : null;
    const activityRaw = activityResult.status === 'fulfilled' && activityResult.value && typeof activityResult.value === 'object'
      ? activityResult.value as Record<string, unknown>
      : null;
    const marketsRaw = marketsResult.status === 'fulfilled' && Array.isArray(marketsResult.value) ? marketsResult.value : [];

    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      source: { id: source.id, label: source.label, configuredLabel: sourceLabel, indexerPublicUrlHash: createHash('sha256').update(source.url).digest('hex').slice(0, 12) },
      sourceUpdatedAt: normalizeIso(activityRaw?.updatedAt ?? activityRaw?.updated_at ?? gameRaw?.updatedAt ?? gameRaw?.updated_at),
      game: gameRaw ? {
        title: getString(gameRaw.title, 'DarkBox'),
        status: getString(gameRaw.status, 'live'),
        revealStatus: getString(gameRaw.revealStatus ?? gameRaw.reveal_status, 'not_started'),
      } : null,
      activity: activityRaw ? {
        activeMarkets: getNumber(activityRaw.activeMarkets ?? activityRaw.active_markets, marketsRaw.length),
        activeAgents: getNumber(activityRaw.activeAgents ?? activityRaw.active_agents, 0),
        totalTrades: getNumber(activityRaw.totalTrades ?? activityRaw.total_trades, 0),
        totalVolume: String(activityRaw.totalVolume ?? activityRaw.total_volume ?? activityRaw.total_volume_usdc ?? '0'),
        totalVolumeUsdc: String(activityRaw.totalVolumeUsdc ?? activityRaw.total_volume_usdc ?? activityRaw.totalVolume ?? activityRaw.total_volume ?? '0'),
        totalDeposits: String(activityRaw.totalDeposits ?? activityRaw.total_deposits ?? activityRaw.total_deposits_count ?? '0'),
      } : { activeMarkets: marketsRaw.length, activeAgents: 0, totalTrades: 0, totalVolume: '0', totalDeposits: '0' },
      markets: marketsRaw.map(normalizeMarket),
      leaderboard: leaderboardResult.status === 'fulfilled' ? normalizeLeaderboard(leaderboardResult.value) : [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: 'indexer_unavailable', message });
  }
}

async function handleAgentFeed(_req: IncomingMessage, res: ServerResponse) {
  if (!agentFeedPath) return sendJson(res, 404, { error: 'agent_feed_not_configured' });
  try {
    const data = await readFile(agentFeedPath, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: 'agent_feed_unavailable', message });
  }
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse) {
  if (webhookSecret && req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) return send(res, 401, 'unauthorized');
  const update = JSON.parse(await readBody(req)) as TelegramUpdate;
  const msg = update.message;
  if (msg?.chat?.id && (msg.text?.startsWith('/start') || msg.text?.startsWith('/admin'))) {
    await callTelegram('sendMessage', {
      chat_id: msg.chat.id,
      text: 'Open the standalone Daemon Hall admin console.',
      reply_markup: { inline_keyboard: [[{ text: 'Open admin console', web_app: { url: appUrl } }]] },
    });
  }
  send(res, 200, 'ok');
}

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', appUrl);
  if (url.pathname === '/healthz') return send(res, 200, 'ok');
  if (!handleAuth(req, res, url)) return;
  if (url.pathname === '/api/source-info' && req.method === 'GET') {
    const source = getIndexerSource(url);
    return sendJson(res, 200, { app: 'daemonhall-admin', sourceLabel, selectedSource: source.id, selectedSourceLabel: source.label, authEnabled: Boolean(accessToken), indexerConfigured: Boolean(source.url), indexerPublicUrl: source.url, sources: Object.values(indexerSources).map((item) => ({ id: item.id, label: item.label })), publicPaths: ['/public/health', '/public/game', '/public/markets', '/public/leaderboard', '/public/activity'], agentFeedConfigured: Boolean(agentFeedPath), generatedAt: new Date().toISOString() });
  }
  if (url.pathname === '/telegram/webhook' && req.method === 'POST') return handleWebhook(req, res);
  if (url.pathname === '/api/market-snapshot' && req.method === 'GET') return handleMarketSnapshot(req, res, url);
  if (url.pathname === '/agent-feed.json' && req.method === 'GET') return handleAgentFeed(req, res);
  if (url.pathname.startsWith('/public/')) return handlePublicIndexerProxy(req, res, url);

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = normalize(requested).replace(/^([/\\])+/, '');
  if (safePath.startsWith('..')) return send(res, 403, 'forbidden');

  try {
    const filePath = join(publicDir, safePath);
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'microphone=()',
    });
    res.end(data);
  } catch {
    send(res, 404, 'not found');
  }
}

createServer((req, res) => {
  serveStatic(req, res).catch((error: unknown) => {
    console.error(error);
    send(res, 500, 'internal error');
  });
}).listen(port, () => {
  console.log(`Daemon Hall admin miniapp listening on :${port}`);
});
