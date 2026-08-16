// Tests for scenarios/scenarios.js. Run with: node --test scenarios/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beats, eligibleBeats, applyEffects } from './scenarios.js';

test('every beat has required shape', () => {
  for (const b of Object.values(beats)) {
    assert.ok(b.id, 'beat missing id');
    assert.ok(typeof b.title === 'string', `${b.id} title`);
    assert.ok(typeof b.prereq === 'function', `${b.id} prereq`);
    assert.ok(Array.isArray(b.beats), `${b.id} beats[]`);
    assert.ok(Array.isArray(b.skillFocus), `${b.id} skillFocus[]`);
  }
});

test('choice.next references existing step kinds', () => {
  const knownKinds = new Set(['npc-dialogue', 'npc-dialogue-2', 'npc-dialogue-success', 'narration', 'end', 'fail']);
  for (const b of Object.values(beats)) {
    for (const step of b.beats) {
      if (step.kind !== 'choice') continue;
      for (const opt of step.options) {
        const next = opt.next;
        assert.ok(
          knownKinds.has(next) || /^npc-\d+$/.test(next) || /^narration-\d+$/.test(next) || beats[next],
          `${b.id} choice points at unknown next: ${next}`,
        );
      }
    }
  }
});

test('applyEffects deep-merges with no input mutation', () => {
  const ws = { flags: { a: 1 }, stats: { trust: 0 } };
  const ws2 = applyEffects(ws, { flags: { b: 2 }, stats: { trust: 1 } });
  assert.deepEqual(ws2.flags, { a: 1, b: 2 });
  assert.deepEqual(ws2.stats, { trust: 1 });
  assert.deepEqual(ws.flags, { a: 1 });
  assert.deepEqual(ws.stats, { trust: 0 });
});

test('eligibleBeats: cafe-ordering is always eligible', () => {
  const ok = eligibleBeats({ flags: {}, stats: {} });
  assert.ok(ok.find((b) => b.id === 'cafe-ordering'));
});

test('eligibleBeats: colleague-disagreement hidden until hasFinishedIntro', () => {
  const before = eligibleBeats({ flags: {}, stats: {} }).map((b) => b.id);
  assert.ok(!before.includes('colleague-disagreement'));
  const after = eligibleBeats({ flags: { hasFinishedIntro: true }, stats: {} }).map((b) => b.id);
  assert.ok(after.includes('colleague-disagreement'));
});

test('eligibleBeats: salary-negotiation needs resolvedConflict', () => {
  const before = eligibleBeats({ flags: {}, stats: {} }).map((b) => b.id);
  assert.ok(!before.includes('salary-negotiation'));
  const after = eligibleBeats({ flags: { resolvedConflict: true }, stats: {} }).map((b) => b.id);
  assert.ok(after.includes('salary-negotiation'));
});
