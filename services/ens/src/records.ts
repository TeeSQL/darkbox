/**
 * ENS identity + commitment records for agents. DarkBox writes a fixed set of
 * `darkbox:*` text records under each agent's ENS name (pre-game commitments,
 * then post-reveal records). This store holds the canonical record set and the
 * name→owner mapping; the actual on-chain ENS subname registration / resolver
 * writes are stubbed (need a chain) behind `commitOnchain`.
 */
export const PRE_GAME_KEYS = [
  'darkbox:gameId',
  'darkbox:agentId',
  'darkbox:instructionHash',
  'darkbox:runtimeHash',
  'darkbox:depositCommitment',
  'darkbox:revealSaltHash',
  'darkbox:rulesUri',
] as const;

export const POST_REVEAL_KEYS = [
  'darkbox:revealBundleUri',
  'darkbox:finalStateRoot',
  'darkbox:bridgeStatus',
  'darkbox:replayUri',
] as const;

const DAEMON_AVATARS = [
  'murmur-01', 'sable-02', 'veil-03', 'null-04', 'rasp-05', 'crown-06', 'gloam-07', 'wisp-08', 'hex-09', 'ash-10',
  'nix-11', 'omen-12', 'rune-13', 'grin-14', 'lilt-15', 'rook-16', 'vesper-17', 'knell-18', 'vant-19', 'thorn-20',
] as const;

export interface EnsRecord {
  name: string;
  owner: string;
  texts: Record<string, string>;
  /** Onchain registration status; 'registered' once the resolver write lands. */
  status: 'pending' | 'registered';
}

function hashLabel(label: string): number {
  let h = 2166136261;
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function fallbackDaemonRecord(name: string): EnsRecord | undefined {
  const lower = name.toLowerCase();
  if (!lower.endsWith('.daemonhall.eth')) return undefined;
  const label = lower.slice(0, -'.daemonhall.eth'.length).split('.').filter(Boolean).pop();
  if (!label) return undefined;
  const avatar = DAEMON_AVATARS[hashLabel(label) % DAEMON_AVATARS.length];
  const pretty = label.replace(/-/g, ' ');
  return {
    name: lower,
    owner: '0xEAa823AB4C4eE00283d8ed7be713ddf8A5ba0Fac',
    texts: {
      'darkbox:gameId': 'daemon-hall-demo',
      'darkbox:agentId': label,
      'darkbox:instructionHash': '0xwildcard',
      'darkbox:runtimeHash': '0xdaemonhall',
      'darkbox:depositCommitment': '5.00 sUSDC',
      'darkbox:revealSaltHash': '0xsealed',
      'darkbox:rulesUri': 'https://daemonhall.repo.box/',
      avatar: `https://daemonhall.repo.box/ens-demo/avatars/${avatar}.png`,
      description: `Daemon Hall autonomous trading agent: ${pretty}`,
      url: 'https://daemonhall.repo.box/ens-demo/index.html',
      'darkbox:gameBalance': '5.00 sUSDC',
      'darkbox:pnl': '+0.42 sUSDC',
      'darkbox:agentStatus': 'trading',
    },
    status: 'registered',
  };
}

export class EnsRegistry {
  private readonly records = new Map<string, EnsRecord>();

  /** Register a name with its pre-game commitment text records. */
  register(name: string, owner: string, texts: Record<string, string>): EnsRecord {
    if (this.records.has(name)) throw new Error(`name already registered: ${name}`);
    const missing = PRE_GAME_KEYS.filter((key) => !(key in texts));
    if (missing.length) throw new Error(`missing pre-game records: ${missing.join(', ')}`);
    const record: EnsRecord = { name, owner, texts: { ...texts }, status: 'pending' };
    this.records.set(name, record);
    return record;
  }

  /** Merge post-reveal records onto an existing name. */
  setRecords(name: string, texts: Record<string, string>): EnsRecord {
    const record = this.records.get(name);
    if (!record) throw new Error(`unknown name: ${name}`);
    record.texts = { ...record.texts, ...texts };
    return record;
  }

  /** Mark the on-chain registration as landed (called after commitOnchain). */
  markRegistered(name: string): EnsRecord {
    const record = this.records.get(name);
    if (!record) throw new Error(`unknown name: ${name}`);
    record.status = 'registered';
    return record;
  }

  get(name: string): EnsRecord | undefined {
    return this.records.get(name) ?? fallbackDaemonRecord(name);
  }

  list(): EnsRecord[] {
    return [...this.records.values()];
  }
}
