import http from 'node:http';
import type { IdentitySource } from '@darkbox/shared';
import { EngineError, type Outcome, type Side, type TimeInForce } from './engine/types.js';
import { IndexerService } from './service.js';
import type { Store } from './store.js';

export interface ServerDeps {
  store: Store;
  /** Pre-built service (lets tests share one); otherwise built from the store. */
  service?: IndexerService;
  /** When set, /internal/* requires `x-internal-token` to match. */
  internalToken?: string;
}

interface Json {
  [key: string]: unknown;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
}

function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createServer(deps: ServerDeps): http.Server {
  const service = deps.service ?? new IndexerService(deps.store);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://indexer');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';
      const seg = pathname.split('/').filter(Boolean);

      if (pathname.startsWith('/internal/') && deps.internalToken) {
        if (req.headers['x-internal-token'] !== deps.internalToken) {
          return send(res, 401, { error: 'unauthorized' });
        }
      }

      // --- Public surface -------------------------------------------------
      if (method === 'GET' && pathname === '/public/health') return send(res, 200, { ok: true });
      if (method === 'GET' && pathname === '/public/leaderboard') {
        return send(res, 200, { entries: await service.leaderboard() });
      }
      if (method === 'GET' && pathname === '/public/markets') {
        return send(res, 200, { markets: service.marketSnapshots() });
      }

      // --- Internal surface ----------------------------------------------
      if (method === 'GET' && pathname === '/internal/health') return send(res, 200, { ok: true });
      if (method === 'GET' && pathname === '/internal/leaderboard/raw') {
        return send(res, 200, { entries: await service.leaderboard() });
      }
      if (method === 'GET' && pathname === '/internal/markets') {
        return send(res, 200, { markets: service.marketSnapshots() });
      }

      // GET /internal/agents/:agentId/observation?turn=N
      if (method === 'GET' && seg[0] === 'internal' && seg[1] === 'agents' && seg[3] === 'observation') {
        const agentId = decodeURIComponent(seg[2]!);
        const turn = num(url.searchParams.get('turn')) ?? 0;
        return send(res, 200, { observation: service.observation(agentId, turn) });
      }

      if (method === 'POST' && pathname === '/internal/identity') {
        const body = await readJson(req);
        const shadowAccount = str(body.shadowAccount);
        const source = body.source;
        if (!shadowAccount) return send(res, 400, { error: 'shadowAccount is required' });
        if (source !== 'human' && source !== 'spawned') return send(res, 400, { error: "source must be 'human' or 'spawned'" });
        const identity = await service.registerIdentity({
          shadowAccount,
          source: source as IdentitySource,
          daemonName: str(body.daemonName),
          agentId: str(body.agentId),
          ownerAddress: str(body.ownerAddress),
          telegramUserId: str(body.telegramUserId),
          telegramHandle: str(body.telegramHandle),
          ensName: str(body.ensName),
        });
        return send(res, 200, { identity });
      }

      if (method === 'GET' && seg[0] === 'internal' && seg[1] === 'identity' && seg[2] === 'by-shadow') {
        const identity = await service.getIdentityByShadowAccount(decodeURIComponent(seg[3] ?? ''));
        return identity ? send(res, 200, { identity }) : send(res, 404, { error: 'not found' });
      }
      if (method === 'GET' && seg[0] === 'internal' && seg[1] === 'identity' && seg[2] === 'by-telegram') {
        const identity = await service.getIdentityByTelegramUserId(decodeURIComponent(seg[3] ?? ''));
        return identity ? send(res, 200, { identity }) : send(res, 404, { error: 'not found' });
      }

      // Engine-driving endpoints.
      if (method === 'POST' && pathname === '/internal/markets') {
        const body = await readJson(req);
        const marketId = str(body.marketId);
        const question = str(body.question);
        if (!marketId || !question) return send(res, 400, { error: 'marketId and question are required' });
        await service.createMarket(marketId, question);
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && pathname === '/internal/deposits') {
        const body = await readJson(req);
        const agentId = str(body.agentId);
        const amount = num(body.amount);
        if (!agentId || amount === null) return send(res, 400, { error: 'agentId and numeric amount required' });
        await service.deposit(agentId, amount);
        return send(res, 200, { balance: service.engine.getBalance(agentId) });
      }
      if (method === 'POST' && (pathname === '/internal/split' || pathname === '/internal/merge')) {
        const body = await readJson(req);
        const agentId = str(body.agentId);
        const marketId = str(body.marketId);
        const amount = num(body.amount);
        if (!agentId || !marketId || amount === null) return send(res, 400, { error: 'agentId, marketId, amount required' });
        if (pathname.endsWith('split')) await service.split(agentId, marketId, amount);
        else await service.merge(agentId, marketId, amount);
        return send(res, 200, { balance: service.engine.getBalance(agentId) });
      }
      if (method === 'POST' && pathname === '/internal/orders') {
        const body = await readJson(req);
        const agentId = str(body.agentId);
        const marketId = str(body.marketId);
        const price = num(body.price);
        const size = num(body.size);
        if (!agentId || !marketId || price === null || size === null) {
          return send(res, 400, { error: 'agentId, marketId, price, size required' });
        }
        if (body.outcome !== 'YES' && body.outcome !== 'NO') return send(res, 400, { error: 'outcome must be YES|NO' });
        if (body.side !== 'buy' && body.side !== 'sell') return send(res, 400, { error: 'side must be buy|sell' });
        const result = await service.placeOrder({
          agentId,
          marketId,
          outcome: body.outcome as Outcome,
          side: body.side as Side,
          price,
          size,
          timeInForce: (str(body.timeInForce) as TimeInForce | undefined) ?? 'GTC',
        });
        return send(res, 200, { result });
      }
      if (method === 'POST' && pathname === '/internal/orders/cancel') {
        const body = await readJson(req);
        const orderId = str(body.orderId);
        const agentId = str(body.agentId);
        if (!orderId || !agentId) return send(res, 400, { error: 'orderId and agentId required' });
        await service.cancelOrder(orderId, agentId);
        return send(res, 200, { ok: true });
      }
      // POST /internal/markets/:marketId/resolve { winningOutcome }
      if (method === 'POST' && seg[0] === 'internal' && seg[1] === 'markets' && seg[3] === 'resolve') {
        const body = await readJson(req);
        if (body.winningOutcome !== 'YES' && body.winningOutcome !== 'NO') {
          return send(res, 400, { error: 'winningOutcome must be YES|NO' });
        }
        await service.resolveMarket(decodeURIComponent(seg[2]!), body.winningOutcome as Outcome);
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof EngineError) return send(res, 400, { error: error.message });
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' });
    }
  });
}
