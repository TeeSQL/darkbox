import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnsRegistry, PRE_GAME_KEYS } from './records.js';

function preGameTexts(): Record<string, string> {
  return Object.fromEntries(PRE_GAME_KEYS.map((key) => [key, `v:${key}`]));
}

test('register requires the full pre-game commitment record set', () => {
  const registry = new EnsRegistry();
  assert.throws(() => registry.register('a.darkbox.eth', '0xowner', { 'darkbox:gameId': 'g' }), /missing pre-game records/);
  const record = registry.register('a.darkbox.eth', '0xowner', preGameTexts());
  assert.equal(record.status, 'pending');
  assert.equal(record.owner, '0xowner');
});

test('post-reveal records merge and registration can be marked', () => {
  const registry = new EnsRegistry();
  registry.register('a.darkbox.eth', '0xowner', preGameTexts());
  registry.setRecords('a.darkbox.eth', { 'darkbox:revealBundleUri': 'ipfs://x' });
  const record = registry.markRegistered('a.darkbox.eth');
  assert.equal(record.status, 'registered');
  assert.equal(record.texts['darkbox:revealBundleUri'], 'ipfs://x');
});

test('duplicate registration is rejected', () => {
  const registry = new EnsRegistry();
  registry.register('a.darkbox.eth', '0xowner', preGameTexts());
  assert.throws(() => registry.register('a.darkbox.eth', '0xowner', preGameTexts()), /already registered/);
});
