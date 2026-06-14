import type { AgentId } from './index.js';

export type IdentitySource = 'human' | 'spawned';

/**
 * Off-chain identity record, keyed by shadowAccount — the only attribute every
 * participant is guaranteed to have. Lives in the indexer database, not on-chain.
 *
 * - `daemonName` is always present and is the name shown on the leaderboard.
 *   It is generated once at insert and never changed (see generateDaemonName).
 * - `telegram*` and `ownerAddress` are null for spawned agents.
 * - `ensName` is null until/unless the account registers an ENS subname.
 */
export interface Identity {
  shadowAccount: string;
  daemonName: string;
  source: IdentitySource;
  agentId?: AgentId;
  ownerAddress?: string;
  telegramUserId?: string;
  telegramHandle?: string;
  ensName?: string;
  createdAt: string;
}

const ADJECTIVES = [
  'amber', 'ashen', 'azure', 'bitter', 'bleak', 'brisk', 'cobalt', 'crimson',
  'dim', 'dusk', 'ember', 'feral', 'frost', 'gilded', 'glass', 'gloom',
  'hollow', 'iron', 'jade', 'lone', 'lucid', 'murk', 'onyx', 'pale',
  'quiet', 'rapid', 'rust', 'sable', 'silent', 'sly', 'still', 'swift',
  'umbral', 'vivid', 'wan', 'wild',
] as const;

const NOUNS = [
  'raven', 'moss', 'glass', 'fox', 'heron', 'wren', 'lynx', 'kite',
  'shrike', 'vole', 'adder', 'crane', 'newt', 'finch', 'hawk', 'mink',
  'otter', 'pike', 'rook', 'stoat', 'tern', 'viper', 'weasel', 'asp',
  'badger', 'corvid', 'drake', 'egret', 'falcon', 'gull', 'ibis', 'jay',
] as const;

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/**
 * Produce a random daemon name. The caller persists the result once and never
 * regenerates it, so the name is stable for the life of the account. Uniqueness
 * is enforced by the DB UNIQUE constraint on daemonName — on collision, retry.
 */
export function generateDaemonName(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}
