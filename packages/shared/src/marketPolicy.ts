/**
 * Market resolution policy (spec §5.2 + the resolution grammar).
 *
 * Prevents subjective / unresolvable "spam" markets and produces a reproducible
 * resolution dossier for objective ones. Off-chain policy layer that complements
 * the on-chain factory (which is permissionless — see audit M-2): the indexer /
 * gateway / admin tooling run a candidate market through `validateMarket` before
 * surfacing or resolving it.
 *
 * Two objective families are auto-resolvable:
 *  - `ethglobal_metric` — counts over submitted hackathon projects
 *  - `darkbox_metric`   — counts over in-game activity (daemons, volume, markets…)
 * Anything subjective ("best UX", "most innovative", "funniest") is rejected
 * unless the creator explicitly uses an `AdminManual` resolver (a human vouches).
 */
export type ResolverType =
  | "AdminManual"
  | "CanonicalWinner"
  | "DependentMarket"
  | "ExternalAttested"
  | "VoidOnly";

export type MarketFamily = "ethglobal_metric" | "darkbox_metric" | "admin_manual" | "unknown";

export type Comparator = ">=" | ">" | "<=" | "<" | "==";

export interface MarketCandidate {
  question: string;
  resolverType: ResolverType;
  /** unix seconds */
  closeTime: number;
  /** unix seconds */
  resolveBy?: number;
  metadataURI?: string;
  /** unix seconds; close must be <= gameEndsAt unless allowExtendedClose */
  gameEndsAt?: number;
  allowExtendedClose?: boolean;
}

export interface Classification {
  family: MarketFamily;
  /** objective + has a clear, reproducible source of truth */
  resolvable: boolean;
  /** contains subjective language that needs a human resolver */
  subjective: boolean;
  reasons: string[];
}

export interface ResolutionDossier {
  family: MarketFamily;
  metric?: string;
  comparator?: Comparator;
  threshold?: number;
  unit?: string;
  /** where a resolver reads truth from */
  source: "ethglobal" | "darkbox_indexer" | "admin_manual";
  resolveBy?: number;
  normalizedQuestion: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  classification: Classification;
  dossier?: ResolutionDossier;
}

export const MAX_QUESTION_LEN = 200;

// Note: bare "most"/"least" are intentionally excluded — they collide with the
// "at least" / "at most" comparators. Subjective superlatives are caught by the
// specific words below (e.g. "most innovative" still trips on "innovative").
const SUBJECTIVE_MARKERS = [
  "best", "worst", "funniest", "coolest", "nicest", "prettiest",
  "innovative", "creative", "impressed", "impressive", "beautiful", "favorite",
  "favourite", "deserve", "deserves", "vibe", "vibes", "meaningful", "meaningfully",
  "amazing", "awesome", "cleverest", "smartest",
];

/** Normalize for duplicate detection + grammar matching (do not raw-compare). */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.!,;:]+$/g, "")
    .trim();
}

function firstNumber(s: string): number | undefined {
  // Strip thousands separators inside numbers, then grab the first integer/decimal.
  const m = s.replace(/(\d),(\d)/g, "$1$2").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

function comparatorFrom(s: string): Comparator {
  if (/\b(at least|reach(es)?|or more|minimum|>=)\b/.test(s)) return ">=";
  if (/\b(exceed|more than|over|greater than|above|surpass)\b/.test(s)) return ">";
  if (/\b(at most|fewer than|less than|under|below|<=)\b/.test(s)) return "<=";
  if (/\b(any)\b/.test(s)) return ">="; // "will any daemon reach +20%" => >= 1 occurrence
  return ">=";
}

function detectSubjective(norm: string): string[] {
  return SUBJECTIVE_MARKERS.filter((w) => new RegExp(`\\b${w}\\b`).test(norm));
}

/** Classify a question into a resolution family. Pure function of the text. */
export function classifyMarket(question: string, resolverType: ResolverType): Classification {
  const norm = normalizeQuestion(question);
  const reasons: string[] = [];
  const subjectiveHits = detectSubjective(norm);
  const subjective = subjectiveHits.length > 0;
  if (subjective) reasons.push(`subjective terms: ${subjectiveHits.join(", ")}`);

  const hasNumber = firstNumber(norm) !== undefined;
  const ethglobal = /\bprojects?\b/.test(norm) &&
    (/\b(mention|use|using|submit|submitted|exceed|total|reach|integrat)/.test(norm)) &&
    hasNumber;
  const darkbox = /\b(daemon|daemons|volume|markets?|pnl|trades?|players?|active|in-?game)\b/.test(norm) &&
    hasNumber;

  // AdminManual / VoidOnly are human-vouched: allowed even when subjective.
  if (resolverType === "AdminManual" || resolverType === "CanonicalWinner") {
    reasons.push("human/admin resolver");
    return { family: "admin_manual", resolvable: true, subjective, reasons };
  }
  if (resolverType === "VoidOnly") {
    reasons.push("void-only resolver");
    return { family: "admin_manual", resolvable: true, subjective, reasons };
  }

  // Objective automated resolvers must match a known metric family AND be objective.
  if (subjective) {
    reasons.push("subjective question requires AdminManual");
    return { family: "unknown", resolvable: false, subjective, reasons };
  }
  if (ethglobal) {
    reasons.push("matched ethglobal project-metric family");
    return { family: "ethglobal_metric", resolvable: true, subjective: false, reasons };
  }
  if (darkbox) {
    reasons.push("matched darkbox in-game metric family");
    return { family: "darkbox_metric", resolvable: true, subjective: false, reasons };
  }
  reasons.push("no objective metric family matched; needs AdminManual");
  return { family: "unknown", resolvable: false, subjective: false, reasons };
}

/** Build the reproducible resolution dossier for a classified market. */
export function buildResolutionDossier(
  candidate: MarketCandidate,
  classification: Classification,
): ResolutionDossier {
  const norm = normalizeQuestion(candidate.question);
  const threshold = firstNumber(norm);
  const comparator = comparatorFrom(norm);

  let source: ResolutionDossier["source"] = "admin_manual";
  let metric: string | undefined;
  let unit: string | undefined;

  if (classification.family === "ethglobal_metric") {
    source = "ethglobal";
    unit = "projects";
    if (/\bmention|use|using|integrat/.test(norm)) {
      const sponsor = norm.match(/(?:mention|use|using|integrat\w*)\s+([a-z0-9.\- ]+?)(?:\?|$| and | or )/);
      metric = sponsor ? `projects_referencing:${sponsor[1]?.trim()}` : "projects_referencing";
    } else {
      metric = "projects_total";
    }
  } else if (classification.family === "darkbox_metric") {
    source = "darkbox_indexer";
    if (/\bvolume\b/.test(norm)) { metric = "total_volume_usdc"; unit = "usdc"; }
    else if (/\bmarkets?\b/.test(norm)) { metric = "markets_created"; unit = "markets"; }
    else if (/\bpnl|%/.test(norm)) { metric = "max_agent_pnl_pct"; unit = "percent"; }
    else if (/\btrades?\b/.test(norm)) { metric = "total_trades"; unit = "trades"; }
    else { metric = "active_daemons"; unit = "daemons"; }
  }

  return {
    family: classification.family,
    metric,
    comparator: classification.family === "admin_manual" ? undefined : comparator,
    threshold: classification.family === "admin_manual" ? undefined : threshold,
    unit,
    source,
    resolveBy: candidate.resolveBy,
    normalizedQuestion: norm,
  };
}

/** Full validation: spec §5.2 structural checks + resolution grammar. */
export function validateMarket(candidate: MarketCandidate): ValidationResult {
  const errors: string[] = [];
  const q = candidate.question?.trim() ?? "";

  if (q.length === 0) errors.push("empty_question");
  if (q.length > MAX_QUESTION_LEN) errors.push("question_too_long");
  if (!candidate.metadataURI || candidate.metadataURI.trim() === "") errors.push("missing_metadata");
  if (!Number.isFinite(candidate.closeTime) || candidate.closeTime <= 0) errors.push("bad_close_time");
  if (
    candidate.gameEndsAt !== undefined &&
    !candidate.allowExtendedClose &&
    candidate.closeTime > candidate.gameEndsAt
  ) {
    errors.push("close_after_game_end");
  }
  if (candidate.resolveBy !== undefined && candidate.resolveBy < candidate.closeTime) {
    errors.push("resolve_by_before_close");
  }

  const classification = classifyMarket(q, candidate.resolverType);
  if (!classification.resolvable) {
    errors.push(classification.subjective ? "subjective_requires_admin" : "unresolvable_no_family");
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    classification,
    dossier: classification.resolvable ? buildResolutionDossier(candidate, classification) : undefined,
  };
}
