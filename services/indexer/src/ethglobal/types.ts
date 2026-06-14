export type EthGlobalProjectRecord = {
  eventSlug: string;
  externalProjectId: string | null;
  externalProjectSlug: string;
  name: string;
  shortestDescription: string;
  sponsors: string[];
  prizes: Array<Record<string, unknown>>;
  sourceUrl: string;
  rawSummary: Record<string, unknown>;
};

export type EthGlobalFetchResult = {
  eventSlug: string;
  eventName: string;
  sourceUrl: string;
  fetchedAt: Date;
  projects: EthGlobalProjectRecord[];
};

export type EthGlobalIngestResult = {
  eventSlug: string;
  runId: string | null;
  projectCount: number;
  fetchedAt: Date;
};
