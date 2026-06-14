import type { EthGlobalFetchResult, EthGlobalProjectRecord } from "./types.js";

const ETHGLOBAL_ORIGIN = "https://ethglobal.com";
const MAX_DESCRIPTION_CHARS = 300;

type RawRecord = Record<string, unknown>;

type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

export function ethGlobalShowcaseUrl(eventSlug: string): string {
  return `${ETHGLOBAL_ORIGIN}/showcase?events=${encodeURIComponent(eventSlug)}`;
}

export async function fetchEthGlobalShowcase(
  eventSlug: string,
  fetchFn: FetchLike = fetch,
): Promise<EthGlobalFetchResult> {
  const sourceUrl = ethGlobalShowcaseUrl(eventSlug);
  const response = await fetchFn(sourceUrl, {
    headers: {
      "accept": "text/html,application/xhtml+xml",
      "user-agent": "darkbox-ethglobal-ingest/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`ETHGlobal fetch failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return parseEthGlobalShowcaseHtml(eventSlug, sourceUrl, html, new Date());
}

export function parseEthGlobalShowcaseHtml(
  eventSlug: string,
  sourceUrl: string,
  html: string,
  fetchedAt = new Date(),
): EthGlobalFetchResult {
  const events = extractJsonArraysAfterKey(html, "events").flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  const event = events.find((entry) => isRecord(entry) && entry["slug"] === eventSlug);
  const eventName = isRecord(event) ? text(event["name"]) : "";

  const projects = extractJsonArraysAfterKey(html, "projects")
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter(isRecord)
    .map((project) => normalizeProject(eventSlug, project))
    .filter((project): project is EthGlobalProjectRecord => project !== null);

  return { eventSlug, eventName, sourceUrl, fetchedAt, projects };
}

function normalizeProject(eventSlug: string, raw: RawRecord): EthGlobalProjectRecord | null {
  const name = clean(text(raw["name"]));
  if (!name) return null;

  const externalProjectId = clean(text(raw["uuid"] ?? raw["id"])) || null;
  const externalProjectSlug = clean(text(raw["slug"])) || slugify(externalProjectId ?? name);
  if (!externalProjectSlug) return null;

  const meta = isRecord(raw["meta"]) ? raw["meta"] : {};
  const shortestDescription = shortestNonEmpty([
    text(raw["tagline"]),
    text(meta["autoSummary"]),
    text(raw["description"]),
    text(raw["summary"]),
  ]);
  const prizes = normalizePrizes(raw["prizes"]);
  const sponsors = [...new Set(prizes.map((prize) => text(prize["sponsor"])).filter(Boolean))];

  return {
    eventSlug,
    externalProjectId,
    externalProjectSlug,
    name,
    shortestDescription,
    sponsors,
    prizes,
    sourceUrl: `${ETHGLOBAL_ORIGIN}/showcase/${externalProjectSlug}`,
    rawSummary: {
      uuid: externalProjectId,
      slug: externalProjectSlug,
      name,
      tagline: clean(text(raw["tagline"])),
      autoSummary: clean(text(meta["autoSummary"])),
      eventName: isRecord(raw["event"]) ? clean(text(raw["event"]["name"])) : "",
      prizeCount: prizes.length,
      demoVideoReady: Boolean(meta["demoVideoReady"]),
    },
  };
}

function normalizePrizes(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((entry) => {
    const prize = isRecord(entry["prize"]) ? entry["prize"] : entry;
    const sponsor = findSponsorName(prize) || findSponsorName(entry);
    return {
      name: clean(text(prize["name"] ?? prize["title"] ?? prize["label"])),
      sponsor,
      rank: clean(text(entry["rank"] ?? entry["place"] ?? entry["placement"])),
      amount: clean(text(prize["amount"] ?? prize["value"] ?? prize["cashPrize"])),
    };
  });
}

function findSponsorName(value: unknown): string {
  if (!isRecord(value)) return "";
  const sponsor = value["sponsor"];
  const organization = isRecord(sponsor) ? sponsor["organization"] : value["organization"];
  const org = isRecord(organization) ? organization : {};
  return clean(text(
    org["name"] ??
    org["displayName"] ??
    org["slug"] ??
    org["uuid"] ??
    (isRecord(sponsor) ? sponsor["name"] : undefined),
  ));
}

function extractJsonArraysAfterKey(html: string, key: string): unknown[] {
  const candidates = decodedNextFlightPayloads(html);
  if (candidates.length === 0) {
    candidates.push(
      html
        .replace(/\\"/g, "\"")
        .replace(/\\u003c/g, "<")
        .replace(/\\u003e/g, ">")
        .replace(/\\u0026/g, "&"),
    );
  }

  const needle = `"${key}":[`;
  const arrays: unknown[] = [];

  for (const candidate of candidates) {
    let cursor = 0;
    while (cursor < candidate.length) {
      const keyIndex = candidate.indexOf(needle, cursor);
      if (keyIndex < 0) break;
      const arrayStart = keyIndex + needle.length - 1;
      const arrayText = readJsonArray(candidate, arrayStart);
      if (arrayText) {
        try {
          arrays.push(JSON.parse(arrayText) as unknown);
        } catch {
          // ETHGlobal's page payload is not an API contract; skip malformed
          // candidates and continue scanning for later complete arrays.
        }
        cursor = arrayStart + arrayText.length;
      } else {
        cursor = arrayStart + 1;
      }
    }
  }

  return arrays;
}

function decodedNextFlightPayloads(html: string): string[] {
  const payloads: string[] = [];
  const pattern = /self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g;
  for (const match of html.matchAll(pattern)) {
    const encoded = match[1];
    if (!encoded) continue;
    try {
      const parsed = JSON.parse(encoded) as unknown;
      collectStrings(parsed, payloads);
    } catch {
      // Fall back to the legacy whole-document scan when chunks are not JSON.
    }
  }
  return payloads;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
  }
}

function readJsonArray(textValue: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < textValue.length; index += 1) {
    const char = textValue[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) return textValue.slice(start, index + 1);
    }
  }

  return null;
}

function shortestNonEmpty(values: string[]): string {
  const cleaned = values.map(clean).filter(Boolean);
  cleaned.sort((a, b) => a.length - b.length);
  return truncate(cleaned[0] ?? "", MAX_DESCRIPTION_CHARS);
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}.`;
}

function slugify(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
