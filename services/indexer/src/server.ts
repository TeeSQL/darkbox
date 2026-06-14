import http from 'node:http';
import type { IdentitySource } from '@darkbox/shared';
import { IdentityRepository, type RegisterIdentityInput } from './identity.js';
import type { Store } from './store.js';

export interface ServerDeps {
  store: Store;
  /** When set, /internal/* requires `x-internal-token` to match. */
  internalToken?: string;
}

interface Json {
  [key: string]: unknown;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
}

function parseRegisterBody(body: Json): RegisterIdentityInput | { error: string } {
  const shadowAccount = body.shadowAccount;
  const source = body.source;
  if (typeof shadowAccount !== 'string' || shadowAccount.length === 0) {
    return { error: 'shadowAccount is required' };
  }
  if (source !== 'human' && source !== 'spawned') {
    return { error: "source must be 'human' or 'spawned'" };
  }
  const optionalString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  return {
    shadowAccount,
    source: source as IdentitySource,
    daemonName: optionalString(body.daemonName),
    agentId: optionalString(body.agentId),
    ownerAddress: optionalString(body.ownerAddress),
    telegramUserId: optionalString(body.telegramUserId),
    telegramHandle: optionalString(body.telegramHandle),
    ensName: optionalString(body.ensName),
  };
}

export function createServer(deps: ServerDeps): http.Server {
  const identities = new IdentityRepository(deps.store);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://indexer');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      if (pathname.startsWith('/internal/') && deps.internalToken) {
        if (req.headers['x-internal-token'] !== deps.internalToken) {
          return send(res, 401, { error: 'unauthorized' });
        }
      }

      // --- Public surface -------------------------------------------------
      if (method === 'GET' && pathname === '/public/health') {
        return send(res, 200, { ok: true });
      }
      if (method === 'GET' && pathname === '/public/leaderboard') {
        return send(res, 200, { entries: await deps.store.getLeaderboard() });
      }

      // --- Internal surface ----------------------------------------------
      if (method === 'GET' && pathname === '/internal/health') {
        return send(res, 200, { ok: true });
      }
      if (method === 'GET' && pathname === '/internal/leaderboard/raw') {
        return send(res, 200, { entries: await deps.store.getLeaderboard() });
      }
      if (method === 'POST' && pathname === '/internal/identity') {
        const parsed = parseRegisterBody(await readJson(req));
        if ('error' in parsed) return send(res, 400, parsed);
        const identity = await identities.register(parsed);
        return send(res, 200, { identity });
      }
      if (method === 'POST' && pathname === '/internal/leaderboard/snapshot') {
        const body = await readJson(req);
        const fields = ['agentId', 'shadowAccount', 'startingBalance', 'currentEquity', 'pnl'] as const;
        for (const field of fields) {
          if (typeof body[field] !== 'string') return send(res, 400, { error: `${field} is required` });
        }
        await deps.store.upsertLeaderboardSnapshot({
          agentId: body.agentId as string,
          shadowAccount: body.shadowAccount as string,
          startingBalance: body.startingBalance as string,
          currentEquity: body.currentEquity as string,
          pnl: body.pnl as string,
        });
        return send(res, 200, { ok: true });
      }
      if (method === 'GET' && pathname.startsWith('/internal/identity/by-shadow/')) {
        const shadowAccount = decodeURIComponent(pathname.slice('/internal/identity/by-shadow/'.length));
        const identity = await identities.getByShadowAccount(shadowAccount);
        return identity ? send(res, 200, { identity }) : send(res, 404, { error: 'not found' });
      }
      if (method === 'GET' && pathname.startsWith('/internal/identity/by-telegram/')) {
        const telegramUserId = decodeURIComponent(pathname.slice('/internal/identity/by-telegram/'.length));
        const identity = await identities.getByTelegramUserId(telegramUserId);
        return identity ? send(res, 200, { identity }) : send(res, 404, { error: 'not found' });
      }

      return send(res, 404, { error: 'not found' });
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' });
    }
  });
}
