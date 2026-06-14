// ETHGlobal showcase fetcher.
//
// Pulls submitted-project snapshots for an ETHGlobal event from the public
// Apollo GraphQL API (https://api2.ethglobal.com/graphql) and caches them on
// disk. The API needs no auth for these two operations, but it does check the
// Origin header, so we send the same one the showcase site uses.
//
// Two passes:
//   1. getPaginatedSubmittedProjects(events: [slug]) -> list of project stubs.
//   2. getShowcaseProjectByUuid(uuid)                -> full per-project snapshot.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API_URL = 'https://api2.ethglobal.com/graphql';
const API_ORIGIN = 'https://ethglobal.com';

// Default event. ETHGlobal's internal slug for ETHGlobal New York 2025.
export const DEFAULT_EVENT_SLUG = 'newyork2025';

const PAGE_SIZE = 100;
const SNAPSHOT_CONCURRENCY = 6;

const LIST_QUERY = `
  query GetPaginatedSubmittedProjects($filters: ProjectFilters!, $pagination: Pagination!) {
    getPaginatedSubmittedProjects(filters: $filters, pagination: $pagination) {
      skip
      items {
        uuid
        slug
        name
        tagline
        event { slug name startTime }
      }
    }
  }
`;

const SNAPSHOT_QUERY = `
  query getShowcaseProjectByUuid($uuid: String!) {
    getShowcaseProjectByUuid(uuid: $uuid) {
      uuid
      slug
      name
      tagline
      description
      howItsMade
      sourceCodeUrl
      primaryRepository { url }
      url
      logo { file { fullUrl } }
      banner { file { fullUrl } }
      video { file { fullUrl } muxUrl muxThumbnailUrl youtubeId }
      screenshots { uuid rank file { fullUrl } }
      prizes {
        uuid
        name
        poolPrize
        prize {
          name
          type
          sponsor { name organization { uuid name squareLogo { fullUrl } } }
        }
      }
      event { slug name startTime }
      meta
    }
  }
`;

export interface ProjectStub {
  uuid: string;
  slug: string;
  name: string;
  tagline: string | null;
  event: { slug: string; name: string; startTime: string | null } | null;
}

// Snapshot shape is whatever getShowcaseProjectByUuid returns; we keep it loose
// so the cache survives upstream schema additions without code changes.
export type ProjectSnapshot = Record<string, unknown> & { uuid: string; slug: string };

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: API_ORIGIN },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`ETHGlobal API HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new Error(`ETHGlobal API error: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data) {
    throw new Error('ETHGlobal API returned no data');
  }
  return body.data;
}

/** List every submitted project for an event, paging until the API runs dry. */
export async function listEventProjects(eventSlug: string): Promise<ProjectStub[]> {
  const all: ProjectStub[] = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const data = await gql<{
      getPaginatedSubmittedProjects: { skip: number; items: ProjectStub[] };
    }>(LIST_QUERY, {
      filters: { events: [eventSlug] },
      pagination: { skip, take: PAGE_SIZE },
    });
    const items = data.getPaginatedSubmittedProjects.items;
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return all;
}

/** Fetch the full showcase snapshot for one project. */
export async function fetchProjectSnapshot(uuid: string): Promise<ProjectSnapshot> {
  const data = await gql<{ getShowcaseProjectByUuid: ProjectSnapshot }>(SNAPSHOT_QUERY, { uuid });
  return data.getShowcaseProjectByUuid;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface CacheResult {
  eventSlug: string;
  dir: string;
  count: number;
  fetchedAt: string;
}

/**
 * Pull all project snapshots for an event and cache them under
 * `<cacheRoot>/<eventSlug>/`: one JSON file per project plus an `index.json`.
 */
export async function cacheEventProjects(
  eventSlug = DEFAULT_EVENT_SLUG,
  cacheRoot = join(process.cwd(), 'data', 'ethglobal'),
  log: (msg: string) => void = () => {},
): Promise<CacheResult> {
  const dir = join(cacheRoot, eventSlug);
  const projectsDir = join(dir, 'projects');
  await mkdir(projectsDir, { recursive: true });

  log(`Listing projects for "${eventSlug}"…`);
  const stubs = await listEventProjects(eventSlug);
  log(`Found ${stubs.length} projects. Fetching snapshots…`);

  let done = 0;
  const snapshots = await mapWithConcurrency(stubs, SNAPSHOT_CONCURRENCY, async (stub) => {
    const snapshot = await fetchProjectSnapshot(stub.uuid);
    await writeFile(
      join(projectsDir, `${stub.uuid}.json`),
      JSON.stringify(snapshot, null, 2),
      'utf8',
    );
    done += 1;
    if (done % 25 === 0 || done === stubs.length) log(`  ${done}/${stubs.length}`);
    return snapshot;
  });

  const fetchedAt = new Date().toISOString();
  const index = {
    eventSlug,
    eventName: stubs[0]?.event?.name ?? null,
    fetchedAt,
    source: API_URL,
    count: snapshots.length,
    projects: stubs.map((s) => ({ uuid: s.uuid, slug: s.slug, name: s.name, tagline: s.tagline })),
  };
  await writeFile(join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

  return { eventSlug, dir, count: snapshots.length, fetchedAt };
}
