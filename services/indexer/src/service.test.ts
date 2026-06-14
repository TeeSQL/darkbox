import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IndexerService } from './service.js';
import { MemoryStore } from './store.memory.js';

async function buildScenario(store: MemoryStore): Promise<IndexerService> {
  const service = new IndexerService(store);
  await service.registerIdentity({ shadowAccount: '0xA', agentId: 'alice', source: 'spawned' });
  await service.registerIdentity({ shadowAccount: '0xB', agentId: 'bob', source: 'human', telegramUserId: '9' });
  await service.createMarket('m1', 'will it resolve YES?');
  await service.deposit('alice', 100);
  await service.deposit('bob', 100);
  await service.split('alice', 'm1', 20);
  await service.placeOrder({ agentId: 'alice', marketId: 'm1', outcome: 'NO', side: 'sell', price: 0.3, size: 20 });
  await service.placeOrder({ agentId: 'bob', marketId: 'm1', outcome: 'NO', side: 'buy', price: 0.3, size: 20 });
  await service.resolveMarket('m1', 'YES');
  return service;
}

test('leaderboard reflects engine equity with daemon names', async () => {
  const service = await buildScenario(new MemoryStore());
  const board = await service.leaderboard();
  assert.equal(board[0]!.agentId, 'alice');
  assert.equal(board[0]!.pnl, '6');
  assert.equal(board[1]!.pnl, '-6');
  // identities supply the daemon names
  assert.ok(board.every((entry) => entry.daemonName && entry.daemonName !== entry.agentId));
});

test('engine state survives a restart by replaying the event log', async () => {
  const store = new MemoryStore();
  const original = await buildScenario(store);
  const before = await original.leaderboard();

  // Simulate a process restart: brand-new service over the SAME durable store.
  const restarted = new IndexerService(store);
  await restarted.init();
  const after = await restarted.leaderboard();

  assert.deepEqual(after, before);
  assert.equal(after[0]!.pnl, '6');
});

test('billboard and proposals are stored, surfaced, and replayed', async () => {
  const store = new MemoryStore();
  const service = new IndexerService(store);
  await service.registerIdentity({ shadowAccount: '0xA', agentId: 'alice', source: 'spawned' });
  await service.postBillboard('alice', 'going long YES');
  const proposalId = await service.proposeMarket('alice', 'Will X ship in Q3?', 'desc');
  await service.approveProposal(proposalId); // deploys a market

  const obs = service.observation('alice', 1);
  assert.equal(obs.billboardSinceLastTurn.length, 1);
  assert.equal(obs.billboardSinceLastTurn[0]!.message, 'going long YES');
  assert.equal(obs.marketProposals[0]!.status, 'deployed');
  assert.ok(obs.markets.some((m) => m.marketId === proposalId)); // proposal became a market

  // Survives restart.
  const restarted = new IndexerService(store);
  await restarted.init();
  const obs2 = restarted.observation('alice', 2);
  assert.equal(obs2.billboardSinceLastTurn.length, 1);
  assert.equal(obs2.marketProposals[0]!.status, 'deployed');
  assert.ok(obs2.markets.some((m) => m.marketId === proposalId));
});

test('replay does not duplicate events', async () => {
  const store = new MemoryStore();
  await buildScenario(store);
  const eventCountBefore = (await store.loadEngineEvents()).length;
  const restarted = new IndexerService(store);
  await restarted.init();
  const eventCountAfter = (await store.loadEngineEvents()).length;
  assert.equal(eventCountAfter, eventCountBefore); // init() replays, never re-appends
});
