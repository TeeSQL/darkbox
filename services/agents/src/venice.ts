import { parseAgentTurnOutput, type AgentObservation, type AgentTurnOutput } from '@darkbox/shared';
import type { StrategyModule } from './random.js';

interface VeniceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface VeniceChoice {
  message?: { content?: string };
}

interface VeniceResponse {
  choices?: VeniceChoice[];
  error?: unknown;
}

export interface VeniceStrategyOptions {
  apiKey?: string;
  model?: string;
  endpoint?: string;
}

const DEFAULT_MODEL = 'llama-3.3-70b';
const DEFAULT_ENDPOINT = 'https://api.venice.ai/api/v1/chat/completions';

function buildMessages(observation: AgentObservation): VeniceMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are a DarkBox trading agent inside a hidden prediction-market arena.',
        'You have full visibility of the internal indexer snapshot provided by the user.',
        'Return ONLY valid JSON matching this TypeScript shape:',
        '{ tradeActions: TradeAction[], billboardPost: {message:string}|null, marketProposal: MarketProposal|null, reason?: string }',
        'TradeAction types: make_order, take_order, cancel_order, split, merge, claim, update_position, hold.',
        'You may include multiple tradeActions, one billboardPost max, and one marketProposal max.',
        'Do not wrap JSON in markdown. Do not include prose outside JSON.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({ observation }, null, 2),
    },
  ];
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) ?? trimmed.match(/(\{[\s\S]*\})/);
    if (!match) throw new Error(`model did not return JSON: ${trimmed.slice(0, 200)}`);
    return JSON.parse(match[1]!);
  }
}

export function createVeniceStrategy(options: VeniceStrategyOptions = {}): StrategyModule {
  const apiKey = options.apiKey ?? process.env.VENICE_API_KEY;
  const model = options.model ?? process.env.VENICE_MODEL ?? DEFAULT_MODEL;
  const endpoint = options.endpoint ?? process.env.VENICE_CHAT_URL ?? DEFAULT_ENDPOINT;

  return {
    name: `venice-${model}`,
    async decide(observation): Promise<AgentTurnOutput> {
      if (!apiKey) {
        throw new Error('VENICE_API_KEY is not set');
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: buildMessages(observation),
          temperature: 0.4,
          max_tokens: 900,
        }),
      });

      const body = (await response.json()) as VeniceResponse;
      if (!response.ok) {
        throw new Error(`Venice request failed ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
      }

      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error(`Venice response missing content: ${JSON.stringify(body).slice(0, 500)}`);
      return parseAgentTurnOutput(extractJson(content));
    },
  };
}
