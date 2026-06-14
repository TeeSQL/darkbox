import type { Store } from './store.js';
import { MemoryStore } from './store.memory.js';
import { PostgresStore } from './store.pg.js';

/**
 * Build the store from the environment. With DATABASE_URL set, uses Postgres;
 * otherwise falls back to the in-memory store so the service runs locally
 * without a database. The returned store has already been migrated.
 */
export async function createStore(databaseUrl = process.env.DATABASE_URL): Promise<Store> {
  const store: Store = databaseUrl ? new PostgresStore(databaseUrl) : new MemoryStore();
  await store.migrate();
  return store;
}
