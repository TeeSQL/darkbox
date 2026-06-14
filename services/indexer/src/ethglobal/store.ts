import type pg from "pg";
import { withTransaction } from "../db.js";
import type { EthGlobalFetchResult, EthGlobalIngestResult } from "./types.js";

export async function storeEthGlobalFetch(
  fetchResult: EthGlobalFetchResult,
): Promise<EthGlobalIngestResult> {
  return withTransaction((client) => storeEthGlobalFetchWithClient(client, fetchResult));
}

export async function storeEthGlobalFetchWithClient(
  client: pg.PoolClient,
  fetchResult: EthGlobalFetchResult,
): Promise<EthGlobalIngestResult> {
  const fetchedAt = fetchResult.fetchedAt.toISOString();

  await client.query(
    `INSERT INTO ethglobal_events (event_slug, name, source_url, fetched_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_slug) DO UPDATE SET
       name = EXCLUDED.name,
       source_url = EXCLUDED.source_url,
       fetched_at = EXCLUDED.fetched_at,
       updated_at = NOW()`,
    [fetchResult.eventSlug, fetchResult.eventName, fetchResult.sourceUrl, fetchedAt],
  );

  for (const project of fetchResult.projects) {
    await client.query(
      `INSERT INTO ethglobal_projects (
         event_slug, external_project_id, external_project_slug, name,
         shortest_description, sponsors, prizes, source_url, raw_summary,
         fetched_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10)
       ON CONFLICT (event_slug, external_project_slug) DO UPDATE SET
         external_project_id = EXCLUDED.external_project_id,
         name = EXCLUDED.name,
         shortest_description = EXCLUDED.shortest_description,
         sponsors = EXCLUDED.sponsors,
         prizes = EXCLUDED.prizes,
         source_url = EXCLUDED.source_url,
         raw_summary = EXCLUDED.raw_summary,
         fetched_at = EXCLUDED.fetched_at,
         updated_at = NOW()`,
      [
        project.eventSlug,
        project.externalProjectId,
        project.externalProjectSlug,
        project.name,
        project.shortestDescription,
        JSON.stringify(project.sponsors),
        JSON.stringify(project.prizes),
        project.sourceUrl,
        JSON.stringify(project.rawSummary),
        fetchedAt,
      ],
    );
  }

  const run = await client.query<{ id: string }>(
    `INSERT INTO ethglobal_ingest_runs (
       event_slug, source_url, status, project_count, fetched_at
     ) VALUES ($1, $2, 'ok', $3, $4)
     RETURNING id`,
    [fetchResult.eventSlug, fetchResult.sourceUrl, fetchResult.projects.length, fetchedAt],
  );

  return {
    eventSlug: fetchResult.eventSlug,
    runId: run.rows[0]?.id ?? null,
    projectCount: fetchResult.projects.length,
    fetchedAt: fetchResult.fetchedAt,
  };
}

export async function storeEthGlobalIngestFailure(
  eventSlug: string,
  sourceUrl: string,
  error: unknown,
  fetchedAt = new Date(),
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO ethglobal_events (event_slug, name, source_url, fetched_at)
       VALUES ($1, '', $2, $3)
       ON CONFLICT (event_slug) DO UPDATE SET
         source_url = EXCLUDED.source_url,
         fetched_at = EXCLUDED.fetched_at,
         updated_at = NOW()`,
      [eventSlug, sourceUrl, fetchedAt.toISOString()],
    );
    await client.query(
      `INSERT INTO ethglobal_ingest_runs (
         event_slug, source_url, status, project_count, error, fetched_at
       ) VALUES ($1, $2, 'error', 0, $3, $4)`,
      [eventSlug, sourceUrl, error instanceof Error ? error.message : String(error), fetchedAt.toISOString()],
    );
  });
}
