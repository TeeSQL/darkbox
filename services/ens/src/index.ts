import http from 'node:http';
import { EnsRegistry } from './records.js';

const PORT = Number(process.env.PORT ?? 8099);
const registry = new EnsRegistry();

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://ens');
    const seg = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (method === 'GET' && (url.pathname === '/health' || url.pathname === '/ens/health')) {
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && url.pathname === '/ens/names') return send(res, 200, { records: registry.list() });

    if (method === 'POST' && url.pathname === '/ens/register') {
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name : '';
      const owner = typeof body.owner === 'string' ? body.owner : '';
      const texts = (body.texts ?? {}) as Record<string, string>;
      if (!name || !owner) return send(res, 400, { error: 'name and owner required' });
      return send(res, 200, { record: registry.register(name, owner, texts) });
    }
    if (method === 'POST' && seg[0] === 'ens' && seg[1] === 'names' && seg[2] && seg[3] === 'records') {
      const body = await readJson(req);
      return send(res, 200, { record: registry.setRecords(decodeURIComponent(seg[2]), (body.texts ?? {}) as Record<string, string>) });
    }
    if (method === 'GET' && seg[0] === 'ens' && seg[1] === 'names' && seg[2]) {
      const record = registry.get(decodeURIComponent(seg[2]));
      return record ? send(res, 200, { record }) : send(res, 404, { error: 'not found' });
    }
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    return send(res, 400, { error: error instanceof Error ? error.message : 'bad request' });
  }
});

server.listen(PORT, () => console.log(`darkbox-ens listening on :${PORT}`));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

export { EnsRegistry } from './records.js';
