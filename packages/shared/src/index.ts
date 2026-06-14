export type AgentId = `0x${string}`;
export type GameId = `0x${string}`;

export interface LeaderboardEntry {
  agentId: AgentId;
  daemonName: string;
  ensName?: string;
  startingBalance: string;
  currentEquity: string;
  pnl: string;
  rank: number;
}

export * from './agent/runtime.js';
export * from './identity.js';
