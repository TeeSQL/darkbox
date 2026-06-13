#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';

interface AgentIdentity {
  agentId: string;
  address: string;
  shadowAccount: string;
}

interface OwnerDaemonBinding {
  gameId: string;
  owner: string;
  agentId: string;
  daemonAddress: string;
  shadowAccount: string;
  registerAgentTxHash?: string;
  instructionHash?: string;
  runtimeHash?: string;
  revealSaltHash?: string;
  status: 'pending_onchain' | 'registered' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

interface BindingFile {
  schema: 'darkbox.owner-daemon-bindings.v1';
  updatedAt: string | null;
  bindings: OwnerDaemonBinding[];
}

function arg(name: string, fallback = ''): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function requireArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function normalizeAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid address: ${value}`);
  return `0x${value.slice(2).toLowerCase()}`;
}

function normalizeBytes32(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return `0x${value.slice(2).toLowerCase()}`;
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

const repoRoot = process.cwd();
const identitiesPath = arg('--identities', path.join(repoRoot, 'services/agents/config/agent-identities.json'));
const bindingsPath = arg('--bindings', path.join(repoRoot, 'services/agents/config/owner-daemon-bindings.json'));
const gameId = normalizeBytes32(requireArg('--game-id'), 'gameId');
const owner = normalizeAddress(requireArg('--owner'));
const agentId = requireArg('--agent-id');
const registerAgentTxHash = arg('--register-agent-tx');
const status = (arg('--status', registerAgentTxHash ? 'registered' : 'pending_onchain') as OwnerDaemonBinding['status']);
const now = new Date().toISOString();

const identityBundle = readJson<{ agents?: AgentIdentity[] }>(identitiesPath, { agents: [] });
const identity = identityBundle.agents?.find((candidate) => candidate.agentId === agentId);
if (!identity) throw new Error(`No daemon identity found for agentId=${agentId} in ${identitiesPath}`);

const file = readJson<BindingFile>(bindingsPath, { schema: 'darkbox.owner-daemon-bindings.v1', updatedAt: null, bindings: [] });
const binding: OwnerDaemonBinding = {
  gameId,
  owner,
  agentId,
  daemonAddress: normalizeAddress(identity.address),
  shadowAccount: normalizeBytes32(identity.shadowAccount, 'shadowAccount'),
  ...(registerAgentTxHash ? { registerAgentTxHash } : {}),
  ...(arg('--instruction-hash') ? { instructionHash: normalizeBytes32(arg('--instruction-hash'), 'instructionHash') } : {}),
  ...(arg('--runtime-hash') ? { runtimeHash: normalizeBytes32(arg('--runtime-hash'), 'runtimeHash') } : {}),
  ...(arg('--reveal-salt-hash') ? { revealSaltHash: normalizeBytes32(arg('--reveal-salt-hash'), 'revealSaltHash') } : {}),
  status,
  createdAt: now,
  updatedAt: now,
};

const existingIndex = file.bindings.findIndex((candidate) => candidate.gameId === gameId && candidate.owner.toLowerCase() === owner && candidate.agentId === agentId);
if (existingIndex >= 0) {
  binding.createdAt = file.bindings[existingIndex]!.createdAt;
  file.bindings[existingIndex] = binding;
} else {
  file.bindings.push(binding);
}
file.updatedAt = now;
fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
fs.writeFileSync(bindingsPath, `${JSON.stringify(file, null, 2)}\n`);
console.log(JSON.stringify(binding, null, 2));
