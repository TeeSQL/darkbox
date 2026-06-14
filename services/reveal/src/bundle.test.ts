import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageBundle, sha256 } from './bundle.js';

const sample = {
  generatedAt: '2026-06-14T00:00:00.000Z',
  agents: [{ agentId: 'a', shadowAccount: '0xa' }, { agentId: 'b', shadowAccount: '0xb' }],
  actions: [{ type: 'deposit', agentId: 'a', amount: 100 }],
  finalLeaderboard: [{ agentId: 'a' }, { agentId: 'b' }],
};

test('packages a clean bundle with a stable digest', () => {
  const p1 = packageBundle({ ...sample });
  const p2 = packageBundle({ ...sample });
  assert.equal(p1.digest, p2.digest); // deterministic
  assert.equal(p1.actionCount, 1);
  assert.equal(p1.agentCount, 2);
  assert.deepEqual(p1.issues, []);
});

test('digest changes when actions change', () => {
  const base = packageBundle({ ...sample });
  const mutated = packageBundle({ ...sample, actions: [{ type: 'deposit', agentId: 'a', amount: 999 }] });
  assert.notEqual(base.digest, mutated.digest);
});

test('flags a leaderboard agent that was never registered', () => {
  const p = packageBundle({ ...sample, finalLeaderboard: [{ agentId: 'ghost' }] });
  assert.ok(p.issues.some((i) => i.includes('ghost')));
});

test('sha256 helper matches known value', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
