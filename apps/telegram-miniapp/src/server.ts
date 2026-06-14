import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { signBlinkDepositRequest, type BlinkSignerRequest } from './blink-signer.js';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 3014);
const publicDir = fileURLToPath(new URL('../dist/', import.meta.url));
const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
const blinkMerchantId = process.env.BLINK_MERCHANT_ID ?? '';
const blinkPrivateKey = process.env.BLINK_MERCHANT_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? '';
const blinkPrivateKeyPath = process.env.BLINK_MERCHANT_PRIVATE_KEY_PATH ?? '';
const blinkAllowedChainId = process.env.BLINK_ALLOWED_CHAIN_ID ? Number(process.env.BLINK_ALLOWED_CHAIN_ID) : undefined;
const blinkAllowedAddress = process.env.BLINK_ALLOWED_DESTINATION_ADDRESS ?? undefined;
const blinkAllowedToken = process.env.BLINK_ALLOWED_TOKEN ?? undefined;
const blinkMaxAmount = process.env.BLINK_MAX_AMOUNT_USD ? Number(process.env.BLINK_MAX_AMOUNT_USD) : undefined;
const appUrl = process.env.MINIAPP_URL ?? `http://localhost:${port}`;
const indexerPublicUrl = (process.env.INDEXER_PUBLIC_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const dynamicEnvironmentId = process.env.DYNAMIC_ENVIRONMENT_ID ?? '';
const dynamicApiToken = process.env.DYNAMIC_API_TOKEN ?? '';
const dynamicBaseUrl = (process.env.DYNAMIC_BASE_URL ?? 'https://app.dynamicauth.com/api/v0').replace(/\/$/, '');
const dynamicCheckoutId = process.env.DYNAMIC_FLOW_CHECKOUT_ID ?? '';
const dynamicBridgeAddress = process.env.DYNAMIC_FLOW_DESTINATION_ADDRESS ?? blinkAllowedAddress ?? '0x55E84818FCEDc3E892A22b46715Ee2B4A947E138';
const dynamicSettlementChainId = process.env.DYNAMIC_FLOW_CHAIN_ID ?? '8453';
const dynamicSettlementToken = process.env.DYNAMIC_FLOW_USDC_TOKEN ?? blinkAllowedToken ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

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

type TelegramMessage = {
  chat?: { id: number | string };
  text?: string;
};

type TelegramUpdate = {
  message?: TelegramMessage;
};

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
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

function isEvmAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isDynamicSessionToken(value: unknown): value is string {
  return typeof value === 'string' && /^dct_[A-Za-z0-9_-]{16,}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function bytes32From(value: string) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function makeDepositIntent(input: { gameId: string; beneficiary: string; amount: number; memo: string; telegramOwner: string }) {
  const nonce = randomBytes(8).toString('hex');
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const depositIntentId = `dbx-dyn-${Date.now().toString(36)}-${nonce}`;
  const depositRef = bytes32From(`${depositIntentId}:${input.gameId}:${input.beneficiary}:${input.amount}`);
  return {
    depositIntentId,
    depositRef,
    gameId: input.gameId,
    beneficiary: input.beneficiary,
    telegramOwner: input.telegramOwner,
    amount: input.amount,
    amountUsd: input.amount.toFixed(2),
    destination: {
      chainName: 'EVM',
      chainId: dynamicSettlementChainId,
      tokenAddress: dynamicSettlementToken,
      symbol: 'USDC',
      tokenDecimals: 6,
      bridgeAddress: dynamicBridgeAddress,
    },
    memo: {
      kind: 'darkbox_dynamic_flow_deposit',
      depositIntentId,
      depositRef,
      gameId: input.gameId,
      beneficiary: input.beneficiary,
      telegramOwner: input.telegramOwner,
      note: input.memo,
    },
    createdAt,
    expiresAt,
  };
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


async function fetchIndexerJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${indexerPublicUrl}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function handlePublicIndexerProxy(req: IncomingMessage, res: ServerResponse, pathname: string, search: string) {
  if (req.method !== 'GET') return send(res, 405, 'method not allowed');
  if (!pathname.startsWith('/public/')) return send(res, 404, 'not found');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const upstreamPath = `${pathname}${search}`;
    const response = await fetch(`${indexerPublicUrl}${upstreamPath}`, { signal: controller.signal });
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

async function handleDynamicFlowIntent(req: IncomingMessage, res: ServerResponse) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, { error: 'invalid_json' });
  }

  const amount = Number(body.amount);
  const beneficiary = String(body.beneficiary ?? '').trim();
  const gameId = String(body.gameId ?? 'darkbox-nyc-finalist').trim();
  const memo = String(body.memo ?? '').slice(0, 240);
  const telegramOwner = String(body.telegramOwner ?? 'web-test-user').slice(0, 120);

  if (!Number.isFinite(amount) || amount <= 0 || amount > 25) {
    return sendJson(res, 400, { error: 'amount must be between 0 and 25 for the test app' });
  }
  if (!isEvmAddress(beneficiary)) return sendJson(res, 400, { error: 'beneficiary must be an EVM address' });
  if (!gameId || gameId.length > 80) return sendJson(res, 400, { error: 'gameId is required and must be short' });
  if (!isEvmAddress(dynamicBridgeAddress) || !isEvmAddress(dynamicSettlementToken)) {
    return sendJson(res, 503, { error: 'dynamic destination/token config is invalid' });
  }

  const intent = makeDepositIntent({ amount, beneficiary, gameId, memo, telegramOwner });
  const checkoutConfig = {
    mode: 'deposit',
    settlementConfig: { strategy: 'cheapest', settlements: [{ chainName: 'EVM', chainId: dynamicSettlementChainId, tokenAddress: dynamicSettlementToken, symbol: 'USDC', tokenDecimals: 6 }] },
    destinationConfig: { destinations: [{ chainName: 'EVM', type: 'address', identifier: dynamicBridgeAddress }] },
    depositConfig: { minimum: '1.00', presets: ['1.00', '5.00', '10.00'] },
    enableOrchestration: true,
  };
  const transactionPayload = { amount: intent.amountUsd, currency: 'USD', expiresIn: 900, memo: intent.memo };

  if (!dynamicEnvironmentId || !dynamicCheckoutId) {
    return sendJson(res, 200, {
      mode: 'dry-run',
      reason: 'DYNAMIC_ENVIRONMENT_ID and DYNAMIC_FLOW_CHECKOUT_ID are not configured on the test app API yet.',
      intent,
      dynamic: { createCheckout: checkoutConfig, createTransaction: transactionPayload, expectedEndpoint: '/sdk/{environmentId}/checkouts/{checkoutId}/transactions' },
      coordinatorMapping: { matchBy: ['memo.depositIntentId', 'memo.depositRef', 'settled Base USDC amount', 'destination bridge address'], creditCallShape: 'DepositCoordinator credits beneficiary after Dynamic webhook or bridge watcher confirms settlement.' },
    });
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (dynamicApiToken) headers.Authorization = `Bearer ${dynamicApiToken}`;
    const response = await fetch(`${dynamicBaseUrl}/sdk/${dynamicEnvironmentId}/checkouts/${dynamicCheckoutId}/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(transactionPayload),
    });
    const dynamicBody = await response.json().catch(async () => ({ raw: await response.text() }));
    if (!response.ok) return sendJson(res, 502, { mode: 'live', error: 'dynamic_transaction_failed', status: response.status, intent, dynamic: dynamicBody });
    return sendJson(res, 200, { mode: 'live', intent, dynamic: dynamicBody });
  } catch (error) {
    return sendJson(res, 502, { mode: 'live', error: error instanceof Error ? error.message : String(error), intent });
  }
}

async function handleDynamicFlowSource(req: IncomingMessage, res: ServerResponse) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, { error: 'invalid_json' });
  }

  const transactionId = String(body.transactionId ?? '').trim();
  const sessionToken = String(body.sessionToken ?? '').trim();
  const fromAddress = String(body.fromAddress ?? '').trim();
  const fromChainId = String(body.fromChainId ?? dynamicSettlementChainId).trim();
  const fromChainName = String(body.fromChainName ?? 'EVM').trim();

  if (!dynamicEnvironmentId) return sendJson(res, 503, { error: 'DYNAMIC_ENVIRONMENT_ID is not configured' });
  if (!isUuid(transactionId)) return sendJson(res, 400, { error: 'transactionId must be a UUID' });
  if (!isDynamicSessionToken(sessionToken)) return sendJson(res, 400, { error: 'sessionToken is invalid or missing' });
  if (fromChainName === 'EVM' && !isEvmAddress(fromAddress)) return sendJson(res, 400, { error: 'fromAddress must be an EVM address' });

  const response = await fetch(`${dynamicBaseUrl}/sdk/${dynamicEnvironmentId}/transactions/${transactionId}/source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dynamic-checkout-session-token': sessionToken },
    body: JSON.stringify({ sourceType: 'wallet', fromAddress, fromChainId, fromChainName }),
  });
  const dynamicBody = await response.json().catch(async () => ({ raw: await response.text() }));
  return sendJson(res, response.ok ? 200 : response.status, { mode: 'live', dynamic: dynamicBody });
}

async function handleDynamicFlowQuote(req: IncomingMessage, res: ServerResponse) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, { error: 'invalid_json' });
  }

  const transactionId = String(body.transactionId ?? '').trim();
  const sessionToken = String(body.sessionToken ?? '').trim();
  const fromTokenAddress = String(body.fromTokenAddress ?? dynamicSettlementToken).trim();

  if (!dynamicEnvironmentId) return sendJson(res, 503, { error: 'DYNAMIC_ENVIRONMENT_ID is not configured' });
  if (!isUuid(transactionId)) return sendJson(res, 400, { error: 'transactionId must be a UUID' });
  if (!isDynamicSessionToken(sessionToken)) return sendJson(res, 400, { error: 'sessionToken is invalid or missing' });
  if (!isEvmAddress(fromTokenAddress)) return sendJson(res, 400, { error: 'fromTokenAddress must be an EVM token address' });

  const response = await fetch(`${dynamicBaseUrl}/sdk/${dynamicEnvironmentId}/transactions/${transactionId}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dynamic-checkout-session-token': sessionToken },
    body: JSON.stringify({ fromTokenAddress }),
  });
  const dynamicBody = await response.json().catch(async () => ({ raw: await response.text() }));
  return sendJson(res, response.ok ? 200 : response.status, { mode: 'live', dynamic: dynamicBody });
}

async function handleDynamicFlowPrepare(req: IncomingMessage, res: ServerResponse) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, { error: 'invalid_json' });
  }

  const transactionId = String(body.transactionId ?? '').trim();
  const sessionToken = String(body.sessionToken ?? '').trim();

  if (!dynamicEnvironmentId) return sendJson(res, 503, { error: 'DYNAMIC_ENVIRONMENT_ID is not configured' });
  if (!isUuid(transactionId)) return sendJson(res, 400, { error: 'transactionId must be a UUID' });
  if (!isDynamicSessionToken(sessionToken)) return sendJson(res, 400, { error: 'sessionToken is invalid or missing' });

  const response = await fetch(`${dynamicBaseUrl}/sdk/${dynamicEnvironmentId}/transactions/${transactionId}/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dynamic-checkout-session-token': sessionToken },
    body: JSON.stringify({ assertBalanceForGasCost: false, assertBalanceForTransferAmount: false }),
  });
  const dynamicBody = await response.json().catch(async () => ({ raw: await response.text() }));
  return sendJson(res, response.ok ? 200 : response.status, { mode: 'live', dynamic: dynamicBody });
}

async function handleMarketSnapshot(_req: IncomingMessage, res: ServerResponse) {
  try {
    const [gameResult, marketsResult, activityResult, leaderboardResult] = await Promise.allSettled([
      fetchIndexerJson('/public/game'),
      fetchIndexerJson('/public/markets'),
      fetchIndexerJson('/public/activity'),
      fetchIndexerJson('/public/leaderboard'),
    ]);

    const gameRaw = gameResult.status === 'fulfilled' && gameResult.value && typeof gameResult.value === 'object'
      ? gameResult.value as Record<string, unknown>
      : null;
    const activityRaw = activityResult.status === 'fulfilled' && activityResult.value && typeof activityResult.value === 'object'
      ? activityResult.value as Record<string, unknown>
      : null;
    const marketsRaw = marketsResult.status === 'fulfilled' && Array.isArray(marketsResult.value) ? marketsResult.value : [];

    const payload = {
      generatedAt: new Date().toISOString(),
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
        totalVolume: String(activityRaw.totalVolume ?? activityRaw.total_volume ?? '0'),
        totalDeposits: String(activityRaw.totalDeposits ?? activityRaw.total_deposits ?? '0'),
      } : { activeMarkets: marketsRaw.length, activeAgents: 0, totalTrades: 0, totalVolume: '0', totalDeposits: '0' },
      markets: marketsRaw.map(normalizeMarket),
      leaderboard: leaderboardResult.status === 'fulfilled' ? normalizeLeaderboard(leaderboardResult.value) : [],
    };

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(res, 502, JSON.stringify({ error: 'indexer_unavailable', message }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse) {
  if (webhookSecret && req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
    return send(res, 401, 'unauthorized');
  }
  const update = JSON.parse(await readBody(req)) as TelegramUpdate;
  const msg = update.message;
  if (msg?.chat?.id && (msg.text?.startsWith('/start') || msg.text?.startsWith('/mic'))) {
    await callTelegram('sendMessage', {
      chat_id: msg.chat.id,
      text: 'Open the DarkBox Dynamic Flow lab to create a test deposit intent.',
      reply_markup: {
        inline_keyboard: [[{ text: 'Open Dynamic Flow lab', web_app: { url: `${appUrl}/dynamic-flow.html` } }]],
      },
    });
  }
  send(res, 200, 'ok');
}

async function loadBlinkPrivateKey() {
  if (blinkPrivateKey) return blinkPrivateKey;
  if (blinkPrivateKeyPath) return readFile(blinkPrivateKeyPath, 'utf8');
  return '';
}

async function handleBlinkSigner(req: IncomingMessage, res: ServerResponse) {
  const privateKeyPem = await loadBlinkPrivateKey();
  if (!blinkMerchantId || !privateKeyPem) {
    return send(res, 503, JSON.stringify({ error: 'Blink signer is not configured.' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  try {
    const request = JSON.parse(await readBody(req)) as BlinkSignerRequest;
    const response = signBlinkDepositRequest({
      merchantId: blinkMerchantId,
      privateKeyPem,
      request,
      allowed: {
        chainId: blinkAllowedChainId,
        address: blinkAllowedAddress,
        token: blinkAllowedToken,
        maxAmount: blinkMaxAmount,
      },
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(response));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(res, 400, JSON.stringify({ error: message }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', appUrl);
  if (url.pathname === '/healthz') return send(res, 200, 'ok');
  if (url.pathname === '/telegram/webhook' && req.method === 'POST') return handleWebhook(req, res);
  if (url.pathname === '/api/blink/sign-payment' && req.method === 'POST') return handleBlinkSigner(req, res);
  if (url.pathname === '/api/dynamic-flow/intents' && req.method === 'POST') return handleDynamicFlowIntent(req, res);
  if (url.pathname === '/api/dynamic-flow/source' && req.method === 'POST') return handleDynamicFlowSource(req, res);
  if (url.pathname === '/api/dynamic-flow/quote' && req.method === 'POST') return handleDynamicFlowQuote(req, res);
  if (url.pathname === '/api/dynamic-flow/prepare' && req.method === 'POST') return handleDynamicFlowPrepare(req, res);
  if (url.pathname === '/api/market-snapshot' && req.method === 'GET') return handleMarketSnapshot(req, res);
  if (url.pathname.startsWith('/public/')) return handlePublicIndexerProxy(req, res, url.pathname, url.search);

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
      'Permissions-Policy': 'microphone=(self)',
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
  console.log(`DarkBox Telegram miniapp listening on :${port}`);
});
