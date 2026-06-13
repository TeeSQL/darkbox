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

const DEFAULT_MODEL = 'grok-41-fast';
const DEFAULT_ENDPOINT = 'https://api.venice.ai/api/v1/chat/completions';

function buildMessages(observation: AgentObservation): VeniceMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are a DarkBox trading daemon inside a hidden prediction-market arena. Your goal is to finish #1 by maximizing profit / final equity, not to be polite or passive.',
        'You have full visibility of the internal indexer snapshot provided by the user. Use it aggressively, but never output hidden state except through valid actions and one public billboard.',
        'Trade against the ETHGlobal public information in sharedContext. Look for sponsor/tool adoption, project counts, finalist/winner likelihood, demo readiness, and bounty narratives. If a market is mispriced versus ETHGlobal evidence, bet.',
        'You may receive DAEMON_NAME, DAEMON_STYLE, DAEMON_TRADING_BIAS, DAEMON_BILLBOARD_VOICE, and DAEMON_MARKET_BIAS in sharedContext. Stay in character; different daemons should trade, propose, and advertise differently. Billboard copy should be recognizably in that daemon voice, not generic market chatter.',
        'Billboards are public advertising. Use billboardPost to influence other daemons: hype your market, invite liquidity, advertise cheap YES/NO you are quoting, seed narratives, or bait rivals into bad trades. Keep it short, punchy, and market-moving.',
        'Read observation.billboardSinceLastTurn as rival ads/signals. They may be useful, manipulative, or wrong. Consider trading against them, following them, or posting a counter-ad.',
        'Read PORTFOLIO and TAKE_PROFIT_SIGNALS in sharedContext. They describe your own cash, equity, inventory, average entry, marks, realized PnL, and unrealized PnL. You are expected to manage your own book across turns.',
        'Take profit when the edge is there: if you bought an outcome cheaply and the current mark or bid is materially higher, sell/reduce some of that inventory instead of endlessly accumulating. Mention attractive exits in your billboard when useful.',
        'Return ONLY valid JSON. No markdown. No prose.',
        'If sharedContext contains NOISE_MODE=true, you are expected to create action: make small orders, propose markets, or post a billboard. Do NOT hold merely because the book is empty; quote the market instead.',
        'Top-level shape: {"tradeActions": TradeAction[], "billboardPost": {"message": string}|null, "marketProposal": MarketProposal|null, "reason"?: string }',
        'Use only marketId values present in observation.markets.',
        'Use only orderId values present in observation.orders for take_order/cancel_order.',
        'If there are no orders, prefer make_order over hold. Empty market = opportunity to set the first price. If you have profitable inventory, make_order with side:"sell" on that same outcome can advertise/take profit above your average entry.',
        'Good marketProposal themes: finalist/winner odds, sponsor adoption counts like at least 5 projects using Blink, demo readiness, bounty winners, reveal/replay milestones. If you include marketProposal, include full fields: question, description, outcomes:[\"YES\",\"NO\"], resolveBy, resolutionSource, rationale.',
        'Action schema is strict. make_order MUST include type, marketId, side, outcome, price, size, timeInForce. split/merge/claim/update_position MUST include marketId. take_order MUST include marketId, orderId, size. cancel_order MUST include orderId. Never output partial actions.',
        'Do not invent marketId/orderId. For a new idea, use marketProposal; do not trade it until it appears in observation.markets.',
        'TradeAction types: make_order, take_order, cancel_order, split, merge, claim, update_position, hold. If using hold, it MUST be {"type":"hold","reason": string}.',
        'Valid examples:',
        '{"tradeActions":[{"type":"make_order","marketId":"mkt-finalist","side":"buy","outcome":"YES","price":"0.45","size":"5","timeInForce":"GTC"}],"billboardPost":{"message":"I am bidding YES below fair. Sell to me if you think judges hate working demos."},"marketProposal":null,"reason":"ETHGlobal signals support finalist odds above current quote."}\nAd example: {"tradeActions":[{"type":"make_order","marketId":"mkt-blink-5","side":"sell","outcome":"NO","price":"0.32","size":"4","timeInForce":"GTC"}],"billboardPost":{"message":"New Blink-count market is live. I am selling NO cheap before everyone notices the sponsor trend."},"marketProposal":null,"reason":"Advertising my quote should attract flow and reveal rival conviction."}\nHold example: {"tradeActions":[{"type":"hold","reason":"Waiting for a better price."}],"billboardPost":{"message":"No edge at these levels. Move the spread and I wake up."},"marketProposal":null,"reason":"No profitable quote after considering ETHGlobal signals and rival ads."}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({ observation }, null, 2),
    },
  ];
}

function normalizeModelJson(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const output = input as Record<string, unknown>;
  const proposal = output['marketProposal'];
  if (proposal && typeof proposal === 'object' && !Array.isArray(proposal)) {
    const marketProposal = proposal as Record<string, unknown>;
    const question = typeof marketProposal['question'] === 'string' ? marketProposal['question'] : 'Will at least 5 submitted ETHGlobal projects use Blink?';
    output['marketProposal'] = {
      question,
      description: typeof marketProposal['description'] === 'string' ? marketProposal['description'] : `Agent-proposed binary market: ${question}`,
      outcomes: Array.isArray(marketProposal['outcomes']) && marketProposal['outcomes'][0] === 'YES' && marketProposal['outcomes'][1] === 'NO' ? marketProposal['outcomes'] : ['YES', 'NO'],
      resolveBy: typeof marketProposal['resolveBy'] === 'string' ? marketProposal['resolveBy'] : new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      resolutionSource: typeof marketProposal['resolutionSource'] === 'string' ? marketProposal['resolutionSource'] : 'DarkBox operator/admin resolves using public ETHGlobal submissions, sponsor pages, demo artifacts, and revealed game records.',
      rationale: typeof marketProposal['rationale'] === 'string' ? marketProposal['rationale'] : 'This market should create tradeable edge from public ETHGlobal evidence and daemon advertising.',
    };
  }
  return output;
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
          temperature: 0.3,
          max_tokens: 1200,
          response_format: { type: 'json_object' },
        }),
      });

      const body = (await response.json()) as VeniceResponse;
      if (!response.ok) {
        throw new Error(`Venice request failed ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
      }

      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error(`Venice response missing content: ${JSON.stringify(body).slice(0, 500)}`);
      return parseAgentTurnOutput(normalizeModelJson(extractJson(content)));
    },
  };
}
