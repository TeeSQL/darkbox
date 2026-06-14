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

export interface EnsRecord {
  name: string;
  owner: string;
  texts: Record<string, string>;
  /** Onchain registration status; 'registered' once the resolver write lands. */
  status: 'pending' | 'registered';
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
    return this.records.get(name);
  }

  list(): EnsRecord[] {
    return [...this.records.values()];
  }
}
