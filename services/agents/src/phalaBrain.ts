// Phala confidential-LLM brain client for the resolver agent.
//
// Talks to a Phala-hosted, OpenAI-compatible chat-completions endpoint (e.g.
// Redpill / Phala Cloud Confidential AI) so the resolution reasoning runs inside
// a TEE. Mirrors the Venice trading brain (venice.ts) but is purpose-built for
// market resolution: it returns a structured verdict, never free-form trades.
//
// Config (all via env, injected as sealed CVM vars — never baked into the image):
//   PHALA_LLM_URL     full chat-completions URL (required to enable resolution)
//   PHALA_LLM_MODEL   model id (default: phala/deepseek-chat-v3)
//   PHALA_LLM_API_KEY bearer token (required)

export type ResolutionOutcome = 'Yes' | 'No' | 'Invalid';

export interface ResolutionVerdict {
  // Whether the brain believes the market can be resolved NOW from the evidence.
  resolvable: boolean;
  // Proposed outcome when resolvable; null otherwise.
  outcome: ResolutionOutcome | null;
  // 0..1 self-reported confidence.
  confidence: number;
  // Human-readable justification grounded in the supplied evidence.
  rationale: string;
  // Short tags pointing at the evidence used (project slugs, "leaderboard", etc).
  evidenceRefs: string[];
}

export interface PhalaBrainOptions {
  url?: string;
  model?: string;
  apiKey?: string;
}

export interface ResolutionBrain {
  readonly model: string;
  assess(input: { question: string; evidence: unknown }): Promise<ResolutionVerdict>;
}

const DEFAULT_MODEL = 'phala/deepseek-chat-v3';

const SYSTEM_PROMPT = [
  'You are the DarkBox resolution oracle running inside a confidential VM.',
  'You decide whether a binary prediction market can be RESOLVED from the supplied evidence.',
  'Evidence is one of two kinds:',
  '  (a) ETHGlobal hackathon facts — a catalog of submitted projects (names, taglines, prizes, sponsors).',
  '  (b) DarkBox market facts — the live indexer leaderboard, market prices, and game aggregates.',
  'Resolve ONLY when the evidence is sufficient and unambiguous. When in doubt, set resolvable=false.',
  'Outcome must be exactly "Yes", "No", or "Invalid". Use "Invalid" only for malformed/unanswerable markets.',
  'Return ONLY valid JSON. No markdown, no prose outside the JSON.',
  'Shape: {"resolvable": boolean, "outcome": "Yes"|"No"|"Invalid"|null, "confidence": number (0..1), "rationale": string, "evidenceRefs": string[]}',
  'If resolvable is false, outcome must be null.',
].join('\n');

function extractJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // Fall back to the first {...} block (some models wrap JSON in prose/fences).
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Phala brain returned no JSON: ${content.slice(0, 200)}`);
  }
}

function coerceVerdict(raw: unknown): ResolutionVerdict {
  const o = (raw ?? {}) as Record<string, unknown>;
  const resolvable = o['resolvable'] === true;
  let outcome: ResolutionOutcome | null = null;
  if (resolvable && (o['outcome'] === 'Yes' || o['outcome'] === 'No' || o['outcome'] === 'Invalid')) {
    outcome = o['outcome'];
  }
  const confidenceRaw = typeof o['confidence'] === 'number' ? o['confidence'] : Number(o['confidence']);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
  const evidenceRefs = Array.isArray(o['evidenceRefs'])
    ? o['evidenceRefs'].map((x) => String(x)).slice(0, 20)
    : [];
  return {
    resolvable: resolvable && outcome !== null,
    outcome,
    confidence,
    rationale: typeof o['rationale'] === 'string' ? o['rationale'] : '',
    evidenceRefs,
  };
}

/**
 * Build a Phala resolution brain, or return null if it is not configured
 * (missing URL/key) — callers should then skip the resolution pass rather than
 * crash the showcase loop.
 */
export function createPhalaBrain(options: PhalaBrainOptions = {}): ResolutionBrain | null {
  const url = options.url ?? process.env['PHALA_LLM_URL'];
  const apiKey = options.apiKey ?? process.env['PHALA_LLM_API_KEY'];
  const model = options.model ?? process.env['PHALA_LLM_MODEL'] ?? DEFAULT_MODEL;
  if (!url || !apiKey) return null;

  return {
    model,
    async assess({ question, evidence }) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 800,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `MARKET QUESTION:\n${question}\n\nEVIDENCE:\n${JSON.stringify(evidence, null, 2)}`,
            },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`Phala LLM HTTP ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content ?? '';
      if (!content) throw new Error('Phala LLM returned empty content');
      return coerceVerdict(extractJson(content));
    },
  };
}
