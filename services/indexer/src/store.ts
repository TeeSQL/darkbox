import type {
  AgentTurnLog,
  InternalAgentState,
  InternalFill,
  InternalOrder,
  PublicActivity,
  PublicGame,
  PublicLeaderboardEntry,
  PublicMarket,
} from '@darkbox/shared';

export interface IndexerState {
  game: PublicGame;
  markets: PublicMarket[];
  agents: InternalAgentState[];
  orders: InternalOrder[];
  fills: InternalFill[];
  agentTurnLogs: AgentTurnLog[];
  activity: PublicActivity;
}

const now = '2026-06-13T03:00:00.000Z';

export function createSeedState(): IndexerState {
  const markets: PublicMarket[] = [
    {
      marketId: 'mkt-darkbox-finalist',
      question: 'Will DarkBox be selected as a hackathon finalist?',
      description: 'Genesis DarkBox prediction market. Finalist data is supplied manually by Fran/admin because ETHGlobal does not expose finalists.',
      status: 'open',
      outcomes: ['YES', 'NO'],
      resolver: 'manual-admin-demo-resolver',
      resolverType: 'EthGlobalFinalistManual',
      resolverConfig: {
        resolverType: 'EthGlobalFinalistManual',
        source: 'manual',
        fallback: 'manual',
      },
      resolutionDossier: null,
      closesAt: '2026-06-15T18:00:00.000Z',
      createdAt: now,
      updatedAt: now,
    },
    {
      marketId: 'mkt-agent-project-wins',
      question: 'Will an AI agent project win the main hackathon prize?',
      description: 'Winner/finalist data is supplied manually by Fran/admin because ETHGlobal does not expose finalists.',
      status: 'open',
      outcomes: ['YES', 'NO'],
      resolver: 'manual-admin-demo-resolver',
      resolverType: 'EthGlobalFinalistManual',
      resolverConfig: {
        resolverType: 'EthGlobalFinalistManual',
        source: 'manual',
        fallback: 'manual',
      },
      resolutionDossier: null,
      closesAt: '2026-06-15T18:00:00.000Z',
      createdAt: now,
      updatedAt: now,
    },
    {
      marketId: 'mkt-blink-sponsor-popularity',
      question: 'Will at least 5 submitted projects mention Blink?',
      description: 'Resolves from the ETHGlobal submitted-project dataset using Blink sponsor/keyword evidence.',
      status: 'open',
      outcomes: ['YES', 'NO'],
      resolver: 'ethglobal-project-count',
      resolverType: 'EthGlobalProjectCount',
      resolverConfig: {
        resolverType: 'EthGlobalProjectCount',
        source: 'ethglobal',
        event: 'newyork2026',
        sponsorTerms: ['blink'],
        matchMode: 'any',
        operator: '>=',
        threshold: 5,
        earlyYes: true,
        earlyNo: false,
        fallback: 'manual',
      },
      resolutionDossier: null,
      closesAt: '2026-06-15T18:00:00.000Z',
      createdAt: now,
      updatedAt: now,
    },
    {
      marketId: 'mkt-daemonhall-100-trades',
      question: 'Will Daemonhall reach 100 trades before reveal?',
      description: 'Resolves from Daemonhall indexed platform metrics.',
      status: 'open',
      outcomes: ['YES', 'NO'],
      resolver: 'daemonhall-metric-threshold',
      resolverType: 'DaemonhallMetricThreshold',
      resolverConfig: {
        resolverType: 'DaemonhallMetricThreshold',
        source: 'daemonhall',
        metric: 'totalTrades',
        operator: '>=',
        threshold: 100,
        earlyYes: true,
        earlyNo: false,
        fallback: 'manual',
      },
      resolutionDossier: null,
      closesAt: '2026-06-15T18:00:00.000Z',
      createdAt: now,
      updatedAt: now,
    },
  ];

  const agents: InternalAgentState[] = [
    {
      agentId: 'agent-raven',
      displayName: 'Raven',
      ensName: 'raven.darkbox.eth',
      availableBalance: '84.50',
      equity: '117.25',
      pnl: '17.25',
      positions: [
        {
          marketId: 'mkt-darkbox-finalist',
          outcome: 'YES',
          size: '40',
          averagePrice: '0.42',
          realizedPnl: '4.10',
          unrealizedPnl: '13.15',
        },
      ],
      updatedAt: now,
    },
    {
      agentId: 'agent-moss',
      displayName: 'Moss',
      ensName: 'moss.darkbox.eth',
      availableBalance: '96.00',
      equity: '104.20',
      pnl: '4.20',
      positions: [
        {
          marketId: 'mkt-agent-project-wins',
          outcome: 'NO',
          size: '12',
          averagePrice: '0.38',
          realizedPnl: '1.00',
          unrealizedPnl: '3.20',
        },
      ],
      updatedAt: now,
    },
    {
      agentId: 'agent-glass',
      displayName: 'Glass',
      ensName: 'glass.darkbox.eth',
      availableBalance: '72.75',
      equity: '91.40',
      pnl: '-8.60',
      positions: [],
      updatedAt: now,
    },
  ];

  const orders: InternalOrder[] = [
    {
      orderId: 'ord-001',
      marketId: 'mkt-darkbox-finalist',
      agentId: 'agent-raven',
      side: 'buy',
      outcome: 'YES',
      price: '0.46',
      size: '20',
      remainingSize: '7',
      status: 'partially_filled',
      createdAt: now,
      updatedAt: now,
    },
    {
      orderId: 'ord-002',
      marketId: 'mkt-agent-project-wins',
      agentId: 'agent-moss',
      side: 'sell',
      outcome: 'YES',
      price: '0.61',
      size: '15',
      remainingSize: '15',
      status: 'open',
      createdAt: now,
      updatedAt: now,
    },
  ];

  const fills: InternalFill[] = [
    {
      fillId: 'fill-001',
      marketId: 'mkt-darkbox-finalist',
      makerAgentId: 'agent-raven',
      takerAgentId: 'agent-glass',
      outcome: 'YES',
      price: '0.44',
      size: '13',
      txHash: '0xseedfill001',
      blockNumber: 12,
      createdAt: now,
    },
  ];

  return {
    game: {
      gameId: 'darkbox-demo-game',
      title: 'DarkBox Hackathon Arena',
      status: 'live',
      startsAt: '2026-06-13T00:00:00.000Z',
      endsAt: '2026-06-15T18:00:00.000Z',
      revealStatus: 'not_started',
      updatedAt: now,
    },
    markets,
    agents,
    orders,
    fills,
    agentTurnLogs: [],
    activity: {
      totalDeposits: '300.00',
      totalTrades: fills.length,
      totalVolume: '5.72',
      positionsOpened: 3,
      positionsClosed: 1,
      activeMarkets: markets.filter((market) => market.status === 'open').length,
      activeAgents: agents.length,
      updatedAt: now,
    },
  };
}

export function publicLeaderboard(state: IndexerState): PublicLeaderboardEntry[] {
  return [...state.agents]
    .sort((a, b) => Number(b.pnl) - Number(a.pnl))
    .map((agent, index) => ({
      agentId: agent.agentId,
      displayName: agent.displayName,
      ensName: agent.ensName,
      rank: index + 1,
      pnl: agent.pnl,
      drawdown: null,
      updatedAt: agent.updatedAt,
    }));
}

export function findById<T extends { [key: string]: unknown }>(items: T[], key: keyof T, value: string): T | null {
  return items.find((item) => item[key] === value) ?? null;
}
