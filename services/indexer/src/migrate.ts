import { readdir, readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withTransaction } from "./db.js";
import type pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The migrations directory location depends on the build/runtime layout, so
// resolve it robustly instead of assuming a single path. Compiled, this file is
// at dist/services/indexer/src, so the dist-relative SQL is ../migrations; the
// container image copies the SQL to /app/services/indexer/migrations
// (../../../../migrations from here); under tsx the source sits next to
// ../migrations. Pick the first candidate that exists.
//
// Bug this guards against: the built image copied migrations to a path the
// compiled code did NOT look in, so readdir() threw ENOENT → runMigrations threw
// → process.exit(1) → crash-loop, and the HTTP server (which only starts AFTER
// migrations) never bound → "connection refused" on every request.
async function resolveMigrationsDir(): Promise<string> {
  const candidates = [
    join(__dirname, "..", "migrations"),
    join(__dirname, "..", "..", "..", "..", "migrations"),
  ];
  for (const dir of candidates) {
    try {
      await access(dir);
      return dir;
    } catch {
      // not here — try the next candidate
    }
  }
  return candidates[0]!;
}

export async function runMigrations(): Promise<void> {
  const migrationsDir = await resolveMigrationsDir();
  await withTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = await client.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id",
    );
    const appliedSet = new Set(applied.rows.map((r) => r.id));

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), "utf-8");
      console.log(`[migrate] applying ${file}`);
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    }
  });
}
