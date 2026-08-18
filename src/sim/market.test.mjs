// Tests for src/sim/market.js — supply/demand pricing and trade flow.
// Run with: node --test src/sim/market.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarket, price, goods, buy, sell } from './market.js';

const world = (market = createMarket(), money = 500) => ({ market, player: { money } });

test('createMarket seeds coffee, groceries, gift, gadget', () => {
  const m = createMarket();
  for (const id of ['coffee', 'groceries', 'gift', 'gadget']) assert.ok(m[id]);
  assert.equal(m.coffee.basePrice, 4);
});

test('price = basePrice * clamp(demand/supply, 0.25, 4), rounded >= 1', () => {
  const w = world();
  // coffee: base 4, demand 40, supply 50 -> ratio 0.8 -> 4*0.8 = 3.2 -> 3
  assert.equal(price(w, 'coffee'), 3);
  assert.ok(price(w, 'coffee') >= 1);
});

test('price is Infinity when supply is 0 (sold out)', () => {
  const m = createMarket();
  m.coffee.supply = 0;
  const w = world(m);
  assert.equal(price(w, 'coffee'), Infinity);
});

test('buy reduces supply, raises price, moves money player -> market', () => {
  const w = world();
  const beforeMoney = w.player.money;
  const beforePrice = price(w, 'coffee');
  const r = buy(w, 'coffee', 5);
  assert.equal(r.ok, true);
  assert.equal(r.world.player.money, beforeMoney - beforePrice * 5);
  assert.ok(r.world.market.coffee.supply < w.market.coffee.supply);
  assert.ok(price(r.world, 'coffee') >= beforePrice, 'price rose after buying');
  // purity
  assert.equal(w.market.coffee.supply, 50);
});

test('buy blocks on sold-out', () => {
  const m = createMarket();
  m.coffee.supply = 1;
  const w = world(m, 1000);
  const r = buy(w, 'coffee', 5);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sold-out');
});

test('buy blocks on insufficient funds', () => {
  const w = world(createMarket(), 0);
  const r = buy(w, 'gadget', 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient-funds');
});

test('buy blocks on unknown good', () => {
  const w = world();
  const r = buy(w, 'unobtainium', 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-good');
});

test('sell increases supply, lowers price, moves money market -> player', () => {
  const w = world();
  const beforeMoney = w.player.money;
  const beforePrice = price(w, 'coffee');
  const r = sell(w, 'coffee', 5);
  assert.equal(r.ok, true);
  assert.equal(r.world.player.money, beforeMoney + beforePrice * 5);
  assert.ok(r.world.market.coffee.supply > w.market.coffee.supply);
  assert.ok(price(r.world, 'coffee') <= beforePrice, 'price fell after selling');
});

test('goods lists every good with its current price', () => {
  const w = world();
  const list = goods(w);
  assert.equal(list.length, 4);
  assert.ok(typeof list[0].price === 'number');
  assert.ok(list.some((g) => g.id === 'gadget'));
});
