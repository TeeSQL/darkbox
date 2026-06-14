import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeCoordinator, type IndexerApi } from './coordinator.js';

/** In-memory fake indexer mirroring the real idempotency + withdrawable rules. */
class FakeIndexer implements IndexerApi {
  available = new Map<string, number>();
  deposited = new Map<string, number>();
  private readonly ops = new Set<string>();
  private readonly identities = new Map<string, string>();

  mapIdentity(shadowAccount: string, agentId: string): void {
    this.identities.set(shadowAccount, agentId);
  }

  async deposit(agentId: string, amount: number, opId: string): Promise<boolean> {
    if (this.ops.has(opId)) return false;
    this.ops.add(opId);
    this.available.set(agentId, (this.available.get(agentId) ?? 0) + amount);
    this.deposited.set(agentId, (this.deposited.get(agentId) ?? 0) + amount);
    return true;
  }

  async withdraw(agentId: string, amount: number, commandId: string): Promise<boolean> {
    if (this.ops.has(commandId)) return false;
    this.ops.add(commandId);
    this.available.set(agentId, (this.available.get(agentId) ?? 0) - amount);
    return true;
  }

  async withdrawable(agentId: string): Promise<number> {
    return this.available.get(agentId) ?? 0;
  }

  async resolveAgentId(shadowAccount: string): Promise<string | null> {
    return this.identities.get(shadowAccount) ?? null;
  }
}

test('deposit credits the mapped agent and is idempotent per opId', async () => {
  const indexer = new FakeIndexer();
  indexer.mapIdentity('0xshadowA', 'agent-a');
  const bridge = new BridgeCoordinator(indexer);

  const first = await bridge.processDeposit({ opId: 'op-1', amount: 100, shadowAccount: '0xshadowA' });
  assert.equal(first.status, 'minted');
  assert.equal(first.agentId, 'agent-a');

  const replay = await bridge.processDeposit({ opId: 'op-1', amount: 100, shadowAccount: '0xshadowA' });
  assert.equal(replay.status, 'minted'); // returns the cached record, no re-credit
  assert.equal(indexer.available.get('agent-a'), 100); // credited once
});

test('withdrawal rejected when above withdrawable balance', async () => {
  const indexer = new FakeIndexer();
  const bridge = new BridgeCoordinator(indexer);
  await bridge.processDeposit({ opId: 'op-1', amount: 30, agentId: 'agent-a' });

  const rejected = await bridge.processWithdrawal({ commandId: 'w-1', amount: 50, agentId: 'agent-a' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(indexer.available.get('agent-a'), 30); // untouched
});

test('withdrawal authorizes within balance and emits an exit authorization', async () => {
  const indexer = new FakeIndexer();
  const bridge = new BridgeCoordinator(indexer);
  await bridge.processDeposit({ opId: 'op-1', amount: 100, agentId: 'agent-a' });

  const ok = await bridge.processWithdrawal({ commandId: 'w-1', amount: 40, agentId: 'agent-a' });
  assert.equal(ok.status, 'authorized');
  assert.ok(ok.exitAuthorization);
  assert.equal(indexer.available.get('agent-a'), 60);

  // Idempotent: replaying the command does not debit again.
  const replay = await bridge.processWithdrawal({ commandId: 'w-1', amount: 40, agentId: 'agent-a' });
  assert.equal(replay.status, 'authorized');
  assert.equal(indexer.available.get('agent-a'), 60);
});

test('unresolvable agent is an error', async () => {
  const bridge = new BridgeCoordinator(new FakeIndexer());
  await assert.rejects(() => bridge.processDeposit({ opId: 'op-x', amount: 10, shadowAccount: '0xunknown' }));
});
