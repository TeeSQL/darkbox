import http from 'node:http';
import { packageBundle, type PackagedBundle, type RevealBundle } from './bundle.js';

const PORT = Number(process.env.PORT ?? 8095);
const INDEXER_INTERNAL_URL = (process.env.INDEXER_INTERNAL_URL ?? 'http://darkbox-indexer:8080/internal').replace(/\/$/, '');
const TOKEN = process.env.INTERNAL_API_TOKEN;

let packaged: PackagedBundle | null = null;

async function build(): Promise<PackagedBundle> {
  const res = await fetch(`${INDEXER_INTERNAL_URL}/reveal/export`, {
    headers: TOKEN ? { 'x-internal-token': TOKEN } : {},
  });
  if (!res.ok) throw new Error(`reveal export -> ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { bundle: RevealBundle };
  packaged = packageBundle(body.bundle);
  return packaged;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://reveal').pathname;
    const method = req.method ?? 'GET';
    if (method === 'GET' && path === '/reveal/health') return send(res, 200, { ok: true });
    if (method === 'POST' && path === '/reveal/build') return send(res, 200, summary(await build()));
    if (method === 'GET' && path === '/reveal/digest') {
      return packaged ? send(res, 200, summary(packaged)) : send(res, 404, { error: 'not built; POST /reveal/build' });
    }
    if (method === 'GET' && path === '/reveal/bundle') {
      return packaged ? send(res, 200, { bundle: packaged.bundle }) : send(res, 404, { error: 'not built; POST /reveal/build' });
    }
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    return send(res, 502, { error: error instanceof Error ? error.message : 'reveal error' });
  }
});

function summary(p: PackagedBundle): Omit<PackagedBundle, 'bundle'> {
  const { bundle: _bundle, ...rest } = p;
  return rest;
}

server.listen(PORT, () => console.log(`darkbox-reveal listening on :${PORT} (indexer: ${INDEXER_INTERNAL_URL})`));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

export { packageBundle } from './bundle.js';
