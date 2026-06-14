import { createStore } from './db.js';
import { createServer } from './server.js';
import { IndexerService } from './service.js';

const PORT = Number(process.env.PORT ?? 8080);

async function main(): Promise<void> {
  const store = await createStore();
  const service = new IndexerService(store);
  await service.init(); // replay the engine event log before serving
  const server = createServer({ store, service, internalToken: process.env.INTERNAL_API_TOKEN });

  server.listen(PORT, () => {
    const backend = process.env.DATABASE_URL ? 'postgres' : 'in-memory';
    console.log(`darkbox-indexer listening on :${PORT} (store: ${backend})`);
  });

  const shutdown = async () => {
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

export { createServer } from './server.js';
export { createStore } from './db.js';
export { IdentityRepository } from './identity.js';
export { IndexerService } from './service.js';
