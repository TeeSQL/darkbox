import { createServer } from 'node:http';
import {
  agentTurnLogSchema,
  internalAgentStateSchema,
  internalFillSchema,
  internalOrderSchema,
  publicActivitySchema,
  publicGameSchema,
  publicLeaderboardEntrySchema,
  publicMarketSchema,
} from '@darkbox/shared';
import { ethGlobalContextCard, findEthGlobalProject, loadEthGlobalProjects, searchEthGlobalProjects } from './ethglobal-context.js';
import { Router } from './http.js';
import { resolveEligibleMarkets } from './resolution.js';
import { createSeedState, findById, publicLeaderboard } from './store.js';

const state = createSeedState();
const router = new Router();

router.get('/health', () => ({ ok: true, service: 'darkbox-indexer' }));
router.get('/public/health', () => ({ ok: true, surface: 'public' }));
router.get('/internal/health', () => ({ ok: true, surface: 'internal' }));

router.get('/public/game', () => publicGameSchema.parse(state.game));
router.get('/public/markets', () => state.markets.map((market) => publicMarketSchema.parse(market)));
router.get('/public/markets/:marketId', ({ params }) => {
  const market = findById(state.markets, 'marketId', params.marketId);
  if (!market) return { error: 'market_not_found' };
  return publicMarketSchema.parse(market);
});
router.get('/public/leaderboard', () => publicLeaderboard(state).map((entry) => publicLeaderboardEntrySchema.parse(entry)));
router.get('/public/activity', () => publicActivitySchema.parse(state.activity));
router.get('/public/agents/:agentId/status', ({ params }) => {
  const agent = findById(state.agents, 'agentId', params.agentId);
  if (!agent) return { error: 'agent_not_found' };
  const entry = publicLeaderboard(state).find((leaderboardEntry) => leaderboardEntry.agentId === params.agentId);
  return entry ? publicLeaderboardEntrySchema.parse(entry) : { error: 'agent_not_found' };
});
router.get('/public/reveal/status', () => ({ revealStatus: state.game.revealStatus, updatedAt: state.game.updatedAt }));

router.get('/internal/game', () => state.game);
router.get('/internal/markets', () => state.markets);
router.get('/internal/markets/:marketId', ({ params }) => findById(state.markets, 'marketId', params.marketId) ?? { error: 'market_not_found' });
router.get('/internal/agents', () => state.agents.map((agent) => internalAgentStateSchema.parse(agent)));
router.get('/internal/agents/:agentId/state', ({ params }) => {
  const agent = findById(state.agents, 'agentId', params.agentId);
  return agent ? internalAgentStateSchema.parse(agent) : { error: 'agent_not_found' };
});
router.get('/internal/markets/:marketId/orderbook', ({ params }) => ({
  marketId: params.marketId,
  orders: state.orders.filter((order) => order.marketId === params.marketId).map((order) => internalOrderSchema.parse(order)),
}));
router.get('/internal/orders', () => state.orders.map((order) => internalOrderSchema.parse(order)));
router.get('/internal/fills', () => state.fills.map((fill) => internalFillSchema.parse(fill)));
router.post('/internal/resolution/check', async ({ query }) => {
  const event = query.get('event') ?? process.env.ETHGLOBAL_EVENT_SLUG ?? 'newyork2026';
  const bundle = await loadEthGlobalProjects(event);
  return resolveEligibleMarkets(state, [bundle]);
});
router.get('/internal/resolution/dossiers', () => ({
  dossiers: state.markets.flatMap((market) => market.resolutionDossier ? [market.resolutionDossier] : []),
}));
router.get('/internal/agent-turn-logs', () => ({ logs: state.agentTurnLogs }));
router.post('/internal/agent-turn-logs', ({ body }) => {
  const log = agentTurnLogSchema.parse(body);
  state.agentTurnLogs.push(log);
  return { ok: true, stored: 1, agentId: log.agentId, turn: log.turn };
});
router.get('/internal/leaderboard/raw', () => ({ agents: state.agents, orders: state.orders, fills: state.fills }));

router.get('/internal/context/ethglobal', async ({ query }) => {
  const event = query.get('event') ?? process.env.ETHGLOBAL_EVENT_SLUG ?? 'newyork2026';
  const bundle = await loadEthGlobalProjects(event);
  return { event, card: ethGlobalContextCard(bundle) };
});
router.get('/internal/context/ethglobal/projects', async ({ query }) => {
  const event = query.get('event') ?? process.env.ETHGLOBAL_EVENT_SLUG ?? 'newyork2026';
  const limit = Number(query.get('limit') ?? 25);
  const bundle = await loadEthGlobalProjects(event);
  return searchEthGlobalProjects(bundle, { q: query.get('q'), limit: Number.isFinite(limit) ? limit : 25 });
});
router.get('/internal/context/ethglobal/projects/:idOrSlug', async ({ params, query }) => {
  const event = query.get('event') ?? process.env.ETHGLOBAL_EVENT_SLUG ?? 'newyork2026';
  const bundle = await loadEthGlobalProjects(event);
  return findEthGlobalProject(bundle, params.idOrSlug) ?? { error: 'project_not_found' };
});

export function startServer(port = Number(process.env.PORT ?? 8080)): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void router.handle(req, res);
  });
  server.listen(port, () => {
    console.log(`darkbox-indexer listening on :${port}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
