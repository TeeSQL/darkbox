#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const GRAPHQL_URL = "https://api2.ethglobal.com/graphql";
const MAX_AGENT_TEXT_LENGTH = 300;

type Args = {
  event: string;
  outDir: string;
  details: boolean;
  take: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    event: "newyork2026",
    outDir: "data/ethglobal",
    details: false,
    take: 100,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--event" || arg === "-e") args.event = argv[++i];
    else if (arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--details") args.details = true;
    else if (arg === "--take") args.take = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: pnpm fetch:ethglobal --event <event-slug> [--details] [--out-dir data/ethglobal]\n\nExamples:\n  pnpm fetch:ethglobal --event newyork2026\n  pnpm fetch:ethglobal --event cannes2026 --details`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.event) throw new Error("Missing --event <event-slug>");
  if (!Number.isFinite(args.take) || args.take <= 0 || args.take > 100) {
    throw new Error("--take must be between 1 and 100");
  }
  return args;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "origin": "https://ethglobal.com",
      "referer": "https://ethglobal.com/showcase/",
      "user-agent": "darkbox-ethglobal-fetcher/0.2 (+https://github.com/TeeSQL/darkbox)",
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok || body.errors?.length) {
    const message = body.errors?.map((error) => error.message).join("; ") || response.statusText;
    throw new Error(`ETHGlobal GraphQL error: ${message}`);
  }
  if (!body.data) throw new Error("ETHGlobal GraphQL returned no data");
  return body.data;
}

const LIST_QUERY = /* GraphQL */ `
  query GetPaginatedSubmittedProjects($filters: ProjectFilters!, $pagination: Pagination!) {
    getPaginatedSubmittedProjects(filters: $filters, pagination: $pagination) {
      skip
      items {
        uuid
        slug
        name
        tagline
        event { name slug startTime endTime }
        banner { file { fullUrl } }
        prizes {
          name
          prize {
            name
            type
            sponsor { name organization { uuid name squareLogo { fullUrl } } }
          }
        }
        meta
      }
    }
  }
`;

const DETAIL_QUERY = /* GraphQL */ `
  query GetShowcaseProjectByUuid($uuid: String!) {
    getShowcaseProjectByUuid(uuid: $uuid) {
      uuid
      slug
      name
      tagline
      description
      howItsMade
      sourceCodeUrl
      url
      primaryRepository { url }
      logo { file { fullUrl } }
      banner { file { fullUrl } }
      video { file { fullUrl } muxUrl muxThumbnailUrl youtubeId }
      screenshots { uuid rank file { fullUrl } }
      prizes {
        uuid
        name
        poolPrize
        prize { name type sponsor { name organization { uuid name squareLogo { fullUrl } } } }
      }
      event { slug name startTime endTime }
      meta
    }
  }
`;

type EthGlobalProject = {
  uuid: string;
  slug: string;
  name: string;
  tagline?: string | null;
  description?: string | null;
  howItsMade?: string | null;
  sourceCodeUrl?: string | null;
  url?: string | null;
  primaryRepository?: { url?: string | null } | null;
  event?: { name: string; slug: string; startTime?: string; endTime?: string } | null;
  banner?: { file?: { fullUrl?: string | null } | null } | null;
  prizes?: Array<{
    name?: string | null;
    prize?: { name?: string | null; type?: string | null; sponsor?: { name?: string | null; organization?: { name?: string | null } | null } | null } | null;
  }> | null;
  meta?: Record<string, unknown> | null;
};

type CompactProject = {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description?: string | null;
  howItsMade?: string | null;
  event: string | null;
  showcaseUrl: string;
  projectUrl: string | null;
  repoUrl: string | null;
  prizeNames: string[];
  sponsorNames: string[];
  demoVideoReady: boolean | null;
};

function cleanText(value: unknown, maxLength = MAX_AGENT_TEXT_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));
}

function compactProject(project: EthGlobalProject): CompactProject {
  return {
    id: project.uuid,
    slug: project.slug,
    name: cleanText(project.name, 120) ?? project.name,
    tagline: cleanText(project.tagline, 240),
    description: cleanText(project.description, MAX_AGENT_TEXT_LENGTH),
    howItsMade: cleanText(project.howItsMade, MAX_AGENT_TEXT_LENGTH),
    event: project.event?.slug ?? null,
    showcaseUrl: `https://ethglobal.com/showcase/${project.slug}-${project.uuid}`,
    projectUrl: cleanText(project.url, 300),
    repoUrl: cleanText(project.primaryRepository?.url ?? project.sourceCodeUrl, 300),
    prizeNames: unique(project.prizes?.flatMap((prize) => [prize.name, prize.prize?.name]) ?? []),
    sponsorNames: unique(project.prizes?.map((prize) => prize.prize?.sponsor?.organization?.name ?? prize.prize?.sponsor?.name) ?? []),
    demoVideoReady: typeof project.meta?.demoVideoReady === "boolean" ? project.meta.demoVideoReady : null,
  };
}

async function fetchAllProjects(event: string, take: number): Promise<EthGlobalProject[]> {
  const projects: EthGlobalProject[] = [];
  let skip = 0;

  while (true) {
    const data = await graphql<{
      getPaginatedSubmittedProjects: { skip: number; items: EthGlobalProject[] };
    }>(LIST_QUERY, {
      filters: { events: [event] },
      pagination: { skip, take },
    });

    const items = data.getPaginatedSubmittedProjects.items;
    projects.push(...items);
    if (items.length < take) break;
    skip += take;
  }

  return projects;
}

async function fetchDetails(projects: EthGlobalProject[]): Promise<EthGlobalProject[]> {
  const details: EthGlobalProject[] = [];
  for (const project of projects) {
    const data = await graphql<{ getShowcaseProjectByUuid: EthGlobalProject }>(DETAIL_QUERY, { uuid: project.uuid });
    details.push(data.getShowcaseProjectByUuid);
  }
  return details;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const eventDir = path.join(args.outDir, args.event);
  await mkdir(eventDir, { recursive: true });

  const fetchedAt = new Date().toISOString();
  const projects = await fetchAllProjects(args.event, args.take);
  const detailedProjects = args.details && projects.length > 0 ? await fetchDetails(projects) : projects;
  const compactProjects = detailedProjects.map(compactProject);
  const summary = {
    event: args.event,
    fetchedAt,
    count: projects.length,
    source: GRAPHQL_URL,
    detailHydrated: args.details,
  };

  await writeFile(
    path.join(eventDir, "projects.raw.json"),
    JSON.stringify({ ...summary, projects: detailedProjects }, null, 2) + "\n",
  );
  await writeFile(
    path.join(eventDir, "projects.compact.json"),
    JSON.stringify({ ...summary, projects: compactProjects }, null, 2) + "\n",
  );
  await writeFile(
    path.join(eventDir, "manifest.json"),
    JSON.stringify({ ...summary, files: ["projects.compact.json", "projects.raw.json"] }, null, 2) + "\n",
  );

  // Compatibility alias for quick local inspection.
  await writeFile(
    path.join(eventDir, "projects.json"),
    JSON.stringify({ ...summary, projects: compactProjects }, null, 2) + "\n",
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
