import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface EthGlobalCompactProject {
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
}

export interface EthGlobalProjectBundle {
  event: string;
  fetchedAt: string;
  count: number;
  source: string;
  detailHydrated?: boolean;
  projects: EthGlobalCompactProject[];
}

export interface ProjectSearchOptions {
  q?: string | null;
  limit?: number;
}

const MAX_LIMIT = 100;

function dataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const cwdData = path.resolve(process.cwd(), 'data');
  const repoDataFromPackage = path.resolve(process.cwd(), '../../data');
  return process.cwd().endsWith(path.join('services', 'indexer')) ? repoDataFromPackage : cwdData;
}

function compactPath(event: string): string {
  return path.join(dataDir(), 'ethglobal', event, 'projects.compact.json');
}

function normalizeQuery(query: string | null | undefined): string[] {
  return (query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function searchableText(project: EthGlobalCompactProject): string {
  return [
    project.name,
    project.slug,
    project.tagline,
    project.description,
    project.howItsMade,
    project.repoUrl,
    project.projectUrl,
    ...project.prizeNames,
    ...project.sponsorNames,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export async function loadEthGlobalProjects(event: string): Promise<EthGlobalProjectBundle> {
  const body = await readFile(compactPath(event), 'utf8');
  return JSON.parse(body) as EthGlobalProjectBundle;
}

export function searchEthGlobalProjects(
  bundle: EthGlobalProjectBundle,
  options: ProjectSearchOptions = {},
): EthGlobalProjectBundle {
  const terms = normalizeQuery(options.q);
  const limit = Math.min(Math.max(options.limit ?? 25, 1), MAX_LIMIT);
  const projects = terms.length === 0
    ? bundle.projects
    : bundle.projects.filter((project) => {
      const haystack = searchableText(project);
      return terms.every((term) => haystack.includes(term));
    });

  return {
    ...bundle,
    count: projects.length,
    projects: projects.slice(0, limit),
  };
}

export function findEthGlobalProject(bundle: EthGlobalProjectBundle, idOrSlug: string): EthGlobalCompactProject | null {
  return bundle.projects.find((project) => project.id === idOrSlug || project.slug === idOrSlug) ?? null;
}

export function ethGlobalContextCard(bundle: EthGlobalProjectBundle): string {
  return [
    `ETHGlobal context loaded for ${bundle.event}.`,
    `${bundle.count} submitted projects cached from ${bundle.source}.`,
    `Fetched at ${bundle.fetchedAt}.`,
    'Agents should query /internal/context/ethglobal/projects?event=<slug>&q=<term>&limit=<n> instead of loading the full file into prompt context.',
  ].join(' ');
}
