// Tests for src/sim/world.js — pure simulation core.
// Run with: node --test src/sim/world.test.mjs
//
// Asserts the declarative rules in docs/simulation.md: time rolls days with
// sleep recovery, energy gates beats, money is conserved, costs scale at
// tired hours, and tick() is the single mutation entry point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld, advanceTime, applyCost, canAfford, applyEffects, tick,
  snapshot, clockString, isExhausted, isTiredHour, __test__,
} from './world.js';

const { DAY_MINUTES, DAY_END_MINUTES, TIRED_AFTER_MINUTE, TIRED_MULTIPLIER } = __test__;

test('createWorld seeds a Monday 08:00 world with vitals', () => {
  const w = createWorld();
  assert.equal(w.clock.day, 1);
  assert.equal(w.clock.minute, 8 * 60);
  assert.equal(w.player.money, 120);
  assert.equal(w.player.energy, 80);
  assert.ok(w.people && w.people.mother);
  assert.ok(w.market && w.market.coffee);
});

test('clockString formats Day + HH:MM', () => {
  const w = createWorld();
  assert.match(clockString(w), /Day 1 · 08:00/);
});

test('advanceTime moves minutes within a day without rolling', () => {
  const w = createWorld();
  const r = advanceTime(w, 90);
  assert.equal(r.world.clock.minute, 8 * 60 + 90);
  assert.equal(r.world.clock.day, 1);
  assert.equal(r.rolled, false);
  // original world untouched (purity)
  assert.equal(w.clock.minute, 8 * 60);
});

test('advanceTime rolls the day at 24:00 and applies sleep recovery', () => {
  const w = createWorld();
  w.player.energy = 20;
  w.player.stress = 60;
  // 08:00 + 17h = 25:00 -> rolls to next day 01:00
  const r = advanceTime(w, 17 * 60);
  assert.equal(r.rolled, true);
  assert.equal(r.world.clock.day, 2);
  assert.equal(r.world.clock.minute, 60);
  assert.ok(r.world.player.energy > 20, 'sleep restored energy');
  assert.ok(r.world.player.stress < 60, 'sleep reduced stress');
});

test('advanceTime past 26:00 clamps to the rollover boundary', () => {
  const w = createWorld();
  // 08:00 + 19h = 27:00 -> beyond the 26:00 hard stop; clamped to midnight
  const r = advanceTime(w, 19 * 60);
  assert.equal(r.rolled, true);
  assert.equal(r.world.clock.day, 2);
  assert.equal(r.world.clock.minute, 0); // clamped to exactly midnight -> 00:00
});

test('canAfford respects energy, money, and time gates', () => {
  const w = createWorld();
  assert.equal(canAfford(w, { energy: 10, money: 50, minutes: 60 }), true);
  assert.equal(canAfford(w, { energy: 1000 }), false); // not enough energy
  assert.equal(canAfford(w, { money: 1000 }), false); // not enough money
  // time gate: blow past the 26:00 hard stop
  assert.equal(canAfford(w, { minutes: DAY_END_MINUTES }), false);
});

test('applyCost deducts energy, money, and advances time', () => {
  const w = createWorld();
  const w2 = applyCost(w, { energy: 10, money: 5, minutes: 30 });
  assert.equal(w2.player.energy, 70);
  assert.equal(w2.player.money, 115);
  assert.equal(w2.clock.minute, 8 * 60 + 30);
  // purity
  assert.equal(w.player.energy, 80);
});

test('applyCost multiplies energy cost during tired hours', () => {
  const w = createWorld();
  w.clock.minute = TIRED_AFTER_MINUTE; // 22:00
  const w2 = applyCost(w, { energy: 10 });
  assert.equal(w2.player.energy, 80 - Math.round(10 * TIRED_MULTIPLIER));
});

test('isTiredHour and isExhausted flag state correctly', () => {
  const w = createWorld();
  assert.equal(isTiredHour(w), false);
  w.clock.minute = TIRED_AFTER_MINUTE;
  assert.equal(isTiredHour(w), true);
  assert.equal(isExhausted(w), false);
  w.player.energy = 0;
  assert.equal(isExhausted(w), true);
});

test('applyEffects moves money/energy/mood and merges flags', () => {
  const w = createWorld();
  const w2 = applyEffects(w, {
    flags: { metMom: true },
    stats: { money: 50, energy: -10, mood: 5, trust: 2 },
  });
  assert.equal(w2.flags.metMom, true);
  assert.equal(w2.player.money, 170);
  assert.equal(w2.player.energy, 70);
  assert.equal(w2.player.mood, 65);
  assert.equal(w2.stats.trust, 2);
});

test('tick is the single mutation entry point for all action kinds', () => {
  const w = createWorld();
  const r1 = tick(w, { kind: 'advanceTime', minutes: 60 });
  assert.equal(r1.world.clock.minute, 9 * 60);
  assert.equal(r1.result.ok, true);

  const r2 = tick(r1.world, { kind: 'applyCost', cost: { energy: 5 } });
  assert.equal(r2.world.player.energy, 75);

  const r3 = tick(r2.world, { kind: 'applyEffects', effects: { stats: { money: 10 } } });
  assert.equal(r3.world.player.money, 130);

  // unknown kind is a no-op with ok:false
  const r4 = tick(r3.world, { kind: 'bogus' });
  assert.equal(r4.result.ok, false);
  assert.equal(r4.world, r3.world);
});

test('snapshot is a deep copy that does not share references', () => {
  const w = createWorld();
  const s = snapshot(w);
  s.player.money = 999;
  s.flags.hack = true;
  assert.equal(w.player.money, 120);
  assert.equal(w.flags.hack, undefined);
});

test('tick buy/sell flow money between player and market', () => {
  const w = createWorld();
  const before = w.player.money;
  const r = tick(w, { kind: 'buy', goodId: 'coffee', qty: 2 });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.from, 'player');
  assert.equal(r.result.to, 'market');
  assert.ok(r.result.amount > 0);
  assert.equal(w.player.money, before, 'original world untouched');
  assert.ok(r.world.player.money < before, 'player paid');
});

test('tick buy blocks when funds are insufficient', () => {
  const w = createWorld();
  w.player.money = 0;
  const r = tick(w, { kind: 'buy', goodId: 'gadget', qty: 1 });
  assert.equal(r.result.ok, false);
  assert.match(r.result.reason, /insufficient|sold/);
});
