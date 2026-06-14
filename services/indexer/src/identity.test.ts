import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdentityRepository } from './identity.js';
import { MemoryStore } from './store.memory.js';
import { UniqueViolationError } from './store.js';

test('spawned account gets a daemon name with no telegram', async () => {
  const repo = new IdentityRepository(new MemoryStore());
  const identity = await repo.register({ shadowAccount: '0xspawn1', source: 'spawned' });
  assert.equal(identity.source, 'spawned');
  assert.ok(identity.daemonName.length > 0);
  assert.equal(identity.telegramUserId, undefined);
});

test('registration is idempotent per shadow account (name is stable)', async () => {
  const repo = new IdentityRepository(new MemoryStore());
  const first = await repo.register({ shadowAccount: '0xabc', source: 'spawned' });
  const second = await repo.register({ shadowAccount: '0xabc', source: 'spawned' });
  assert.equal(first.daemonName, second.daemonName);
});

test('daemon-name collisions are retried with a fresh name', async () => {
  const store = new MemoryStore();
  let calls = 0;
  const original = store.insertIdentity.bind(store);
  store.insertIdentity = async (input) => {
    calls += 1;
    if (calls === 1) throw new UniqueViolationError('identity_daemon_name_key');
    return original(input);
  };
  const repo = new IdentityRepository(store);
  const identity = await repo.register({ shadowAccount: '0xretry', source: 'spawned' });
  assert.equal(calls, 2);
  assert.ok(identity.daemonName.length > 0);
});

test('telegram conflict is fatal, not retried', async () => {
  const repo = new IdentityRepository(new MemoryStore());
  await repo.register({ shadowAccount: '0xh1', source: 'human', telegramUserId: '555' });
  await assert.rejects(
    () => repo.register({ shadowAccount: '0xh2', source: 'human', telegramUserId: '555' }),
    UniqueViolationError,
  );
});

test('leaderboard joins identity and ranks by pnl desc', async () => {
  const store = new MemoryStore();
  const repo = new IdentityRepository(store);
  const a = await repo.register({ shadowAccount: '0xA', source: 'spawned', agentId: '0xA' });
  const b = await repo.register({ shadowAccount: '0xB', source: 'spawned', agentId: '0xB' });
  await store.upsertLeaderboardSnapshot({ agentId: '0xA', shadowAccount: '0xA', startingBalance: '100', currentEquity: '90', pnl: '-10' });
  await store.upsertLeaderboardSnapshot({ agentId: '0xB', shadowAccount: '0xB', startingBalance: '100', currentEquity: '140', pnl: '40' });

  const board = await store.getLeaderboard();
  assert.equal(board.length, 2);
  assert.equal(board[0]!.daemonName, b.daemonName);
  assert.equal(board[0]!.rank, 1);
  assert.equal(board[1]!.daemonName, a.daemonName);
  assert.equal(board[1]!.rank, 2);
});
