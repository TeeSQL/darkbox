export type AgentId = `0x${string}`;
export type GameId = `0x${string}`;

export interface LeaderboardEntry {
  agentId: AgentId;
  ensName: string;
  startingBalance: string;
  currentEquity: string;
  pnl: string;
  rank: number;
}

export * from './agent/runtime.js';
