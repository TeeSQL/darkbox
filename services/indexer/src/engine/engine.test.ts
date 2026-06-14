import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarketEngine } from './engine.js';
import { EngineError } from './types.js';

function approx(actual: number, expected: number, eps = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);
}

test('deposit sets starting balance and equity', () => {
  const e = new MarketEngine();
  e.deposit('alice', 1000);
  approx(e.getBalance('alice').deposited, 1000);
  approx(e.equity('alice'), 1000);
});

test('split then merge conserves collateral', () => {
  const e = new MarketEngine();
  e.deposit('alice', 100);
  e.createMarket('m1', 'will it rain?');
  e.split('alice', 'm1', 40);
  approx(e.getBalance('alice').available, 60);
  // No trades: YES+NO marks default to 0.5 each, so equity is unchanged.
  approx(e.equity('alice'), 100);
  e.merge('alice', 'm1', 40);
  approx(e.getBalance('alice').available, 100);
  approx(e.equity('alice'), 100);
});

test('crossing orders fill at maker price and move tokens', () => {
  const e = new MarketEngine();
  e.createMarket('m1', 'q');
  e.deposit('maker', 100);
  e.deposit('taker', 100);
  // maker holds YES via split, rests a sell at 0.60
  e.split('maker', 'm1', 10);
  const made = e.placeOrder({ agentId: 'maker', marketId: 'm1', outcome: 'YES', side: 'sell', price: 0.6, size: 10 });
  assert.equal(made.status, 'resting');
  // taker buys 4 YES at up to 0.70 -> fills at maker's 0.60
  const took = e.placeOrder({ agentId: 'taker', marketId: 'm1', outcome: 'YES', side: 'buy', price: 0.7, size: 4 });
  assert.equal(took.fills.length, 1);
  approx(took.fills[0]!.price, 0.6);
  approx(took.fills[0]!.size, 4);
  // taker paid 4*0.60 = 2.40, reservation at 0.70 refunded the 0.40 difference
  approx(e.getBalance('taker').available, 100 - 2.4);
  // maker received 2.40 collateral
  approx(e.getBalance('maker').available, 90 + 2.4);
  approx(e.markPrice('m1', 'YES'), 0.6);
});

test('FOK rejects when not fully fillable, no state change', () => {
  const e = new MarketEngine();
  e.createMarket('m1', 'q');
  e.deposit('m', 100);
  e.deposit('t', 100);
  e.split('m', 'm1', 3);
  e.placeOrder({ agentId: 'm', marketId: 'm1', outcome: 'YES', side: 'sell', price: 0.5, size: 3 });
  const r = e.placeOrder({ agentId: 't', marketId: 'm1', outcome: 'YES', side: 'buy', price: 0.5, size: 5, timeInForce: 'FOK' });
  assert.equal(r.status, 'cancelled');
  assert.equal(r.fills.length, 0);
  approx(e.getBalance('t').available, 100); // nothing reserved or spent
});

test('IOC fills available then cancels remainder, releasing reservation', () => {
  const e = new MarketEngine();
  e.createMarket('m1', 'q');
  e.deposit('m', 100);
  e.deposit('t', 100);
  e.split('m', 'm1', 2);
  e.placeOrder({ agentId: 'm', marketId: 'm1', outcome: 'YES', side: 'sell', price: 0.5, size: 2 });
  const r = e.placeOrder({ agentId: 't', marketId: 'm1', outcome: 'YES', side: 'buy', price: 0.5, size: 5, timeInForce: 'IOC' });
  assert.equal(r.status, 'cancelled');
  approx(r.remaining, 3);
  approx(e.getBalance('t').available, 100 - 1); // paid 2*0.5, no leftover reservation
  approx(e.getBalance('t').reservedCollateral, 0);
});

test('cancel releases reserved collateral', () => {
  const e = new MarketEngine();
  e.createMarket('m1', 'q');
  e.deposit('t', 100);
  const r = e.placeOrder({ agentId: 't', marketId: 'm1', outcome: 'YES', side: 'buy', price: 0.4, size: 10 });
  approx(e.getBalance('t').available, 100 - 4);
  approx(e.getBalance('t').reservedCollateral, 4);
  e.cancelOrder(r.orderId, 't');
  approx(e.getBalance('t').available, 100);
  approx(e.getBalance('t').reservedCollateral, 0);
});

test('resolution settles winners and is zero-sum across agents', () => {
  const e = new MarketEngine();
  e.createMarket('m1', 'q');
  e.deposit('alice', 100);
  e.deposit('bob', 100);
  // alice mints sets and sells NO to bob at 0.30 (keeps YES)
  e.split('alice', 'm1', 20);
  e.placeOrder({ agentId: 'alice', marketId: 'm1', outcome: 'NO', side: 'sell', price: 0.3, size: 20 });
  const fill = e.placeOrder({ agentId: 'bob', marketId: 'm1', outcome: 'NO', side: 'buy', price: 0.3, size: 20 });
  assert.equal(fill.status, 'filled');

  e.resolveMarket('m1', 'YES'); // alice's YES wins, bob's NO is worthless

  // Conservation: all collateral returns to agents, total preserved, zero-sum PnL.
  approx(e.getBalance('alice').available + e.getBalance('bob').available, 200);
  approx(e.getBalance('alice').reservedCollateral, 0);
  approx(e.getBalance('bob').reservedCollateral, 0);
  approx(e.getBalance('alice').realizedPnl + e.getBalance('bob').realizedPnl, 0);
  // bob paid 6 for NO that expired worthless.
  approx(e.getBalance('bob').realizedPnl, -6);
  approx(e.getBalance('alice').realizedPnl, 6);
  approx(e.equity('alice'), 106);
  approx(e.equity('bob'), 94);
});

test('leaderboard ranks by pnl desc', () => {
  const e = new MarketEngine();
  e.createMarket('m1', 'q');
  e.deposit('alice', 100);
  e.deposit('bob', 100);
  e.split('alice', 'm1', 20);
  e.placeOrder({ agentId: 'alice', marketId: 'm1', outcome: 'NO', side: 'sell', price: 0.3, size: 20 });
  e.placeOrder({ agentId: 'bob', marketId: 'm1', outcome: 'NO', side: 'buy', price: 0.3, size: 20 });
  e.resolveMarket('m1', 'YES');
  const board = e.leaderboard();
  assert.equal(board[0]!.agentId, 'alice');
  approx(board[0]!.pnl, 6);
  assert.equal(board[1]!.agentId, 'bob');
  approx(board[1]!.pnl, -6);
});

test('rejects orders that violate constraints', () => {
  const e = new MarketEngine();
  e.createMarket('m1', 'q');
  e.deposit('t', 1);
  assert.throws(() => e.placeOrder({ agentId: 't', marketId: 'm1', outcome: 'YES', side: 'buy', price: 1.2, size: 1 }), EngineError);
  assert.throws(() => e.placeOrder({ agentId: 't', marketId: 'm1', outcome: 'YES', side: 'buy', price: 0.5, size: 100 }), EngineError);
  assert.throws(() => e.placeOrder({ agentId: 't', marketId: 'mX', outcome: 'YES', side: 'buy', price: 0.5, size: 1 }), EngineError);
});
