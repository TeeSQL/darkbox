import http from 'node:http';
import { BridgeCoordinator } from './coordinator.js';

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
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json) : {};
}

function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createBridgeServer(coordinator: BridgeCoordinator): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://bridge');
      const seg = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/bridge/health') return send(res, 200, { ok: true });

      if (method === 'POST' && url.pathname === '/bridge/deposits') {
        const body = await readJson(req);
        const opId = str(body.opId);
        const amount = num(body.amount);
        if (!opId || amount === null) return send(res, 400, { error: 'opId and numeric amount required' });
        const record = await coordinator.processDeposit({
          opId,
          amount,
          agentId: str(body.agentId),
          shadowAccount: str(body.shadowAccount),
        });
        return send(res, 200, { deposit: record });
      }

      if (method === 'POST' && url.pathname === '/bridge/withdrawals') {
        const body = await readJson(req);
        const commandId = str(body.commandId);
        const amount = num(body.amount);
        if (!commandId || amount === null) return send(res, 400, { error: 'commandId and numeric amount required' });
        const record = await coordinator.processWithdrawal({
          commandId,
          amount,
          agentId: str(body.agentId),
          shadowAccount: str(body.shadowAccount),
          ownerSignature: str(body.ownerSignature),
        });
        return send(res, record.status === 'rejected' ? 409 : 200, { withdrawal: record });
      }

      if (method === 'GET' && seg[0] === 'bridge' && seg[1] === 'deposits' && seg[2]) {
        const record = coordinator.getDeposit(decodeURIComponent(seg[2]));
        return record ? send(res, 200, { deposit: record }) : send(res, 404, { error: 'not found' });
      }
      if (method === 'GET' && seg[0] === 'bridge' && seg[1] === 'withdrawals' && seg[2]) {
        const record = coordinator.getWithdrawal(decodeURIComponent(seg[2]));
        return record ? send(res, 200, { withdrawal: record }) : send(res, 404, { error: 'not found' });
      }

      return send(res, 404, { error: 'not found' });
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : 'bad request' });
    }
  });
}
