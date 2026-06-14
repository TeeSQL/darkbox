import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 3000);
// Public indexer API to proxy /public/* to (keeps the browser same-origin).
const INDEXER_PUBLIC_URL = (process.env.PUBLIC_INDEXER_URL ?? 'http://darkbox-indexer:8080/public').replace(/\/$/, '');
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://frontend');

  // Proxy public API calls to the indexer so the page can fetch same-origin.
  if (url.pathname.startsWith('/public/')) {
    try {
      const upstream = await fetch(`${INDEXER_PUBLIC_URL}${url.pathname.slice('/public'.length)}${url.search}`);
      const body = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(body);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'upstream error' }));
    }
    return;
  }

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(requested));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`darkbox-frontend listening on :${PORT} (indexer: ${INDEXER_PUBLIC_URL})`);
});
