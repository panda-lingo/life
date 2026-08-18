// Tests for src/sim/people.js — relationship graph.
// Run with: node --test src/sim/people.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPeople, person, affection, trust, applyRelationshipDelta,
  moodFromAffection, meetsAffection, peopleList,
} from './people.js';

test('createPeople seeds family, friend, colleague, stranger', () => {
  const p = createPeople();
  for (const id of ['mother', 'father', 'sibling', 'best-friend', 'colleague', 'barista']) {
    assert.ok(p[id], `${id} seeded`);
  }
  assert.equal(p.mother.relation, 'family');
  assert.equal(p.barista.relation, 'stranger');
  assert.ok(p.mother.affection > 0, 'mother starts warm');
});

test('person/affection/trust read without mutating', () => {
  const w = { people: createPeople() };
  assert.equal(person(w, 'mother').name, 'Elena');
  assert.equal(affection(w, 'mother'), 60);
  assert.equal(trust(w, 'mother'), 70);
  assert.equal(person(w, 'nope'), null);
  assert.equal(affection(w, 'nope'), 0);
});

test('applyRelationshipDelta shifts affection and trust, scaled by relation', () => {
  const w = { people: createPeople() };
  // family weight 1.5: +10 affection -> +15
  const w2 = applyRelationshipDelta(w, 'mother', { affection: 10, trust: 5 });
  assert.equal(w2.people.mother.affection, 60 + 15);
  assert.equal(w2.people.mother.trust, 70 + Math.round(5 * 1.5));
  // original untouched
  assert.equal(w.people.mother.affection, 60);
});

test('affection clamps to [-100, 100] and trust to [0, 100]', () => {
  const w = { people: createPeople() };
  const w2 = applyRelationshipDelta(w, 'mother', { affection: 1000, trust: -1000 });
  assert.equal(w2.people.mother.affection, 100);
  assert.equal(w2.people.mother.trust, 0);
});

test('mood follows affection bands', () => {
  assert.equal(moodFromAffection(80), 'warm');
  assert.equal(moodFromAffection(40), 'friendly');
  assert.equal(moodFromAffection(0), 'neutral');
  assert.equal(moodFromAffection(-40), 'cool');
  assert.equal(moodFromAffection(-80), 'hostile');
});

test('applyRelationshipDelta updates mood to match new affection', () => {
  const w = { people: createPeople() };
  const w2 = applyRelationshipDelta(w, 'mother', { affection: -200 });
  assert.equal(w2.people.mother.affection, -100);
  assert.equal(w2.people.mother.mood, 'hostile');
});

test('meetsAffection gates beats by threshold', () => {
  const w = { people: createPeople() };
  assert.equal(meetsAffection(w, 'mother', 50), true);
  assert.equal(meetsAffection(w, 'barista', 50), false);
});

test('unknown NPC is a no-op', () => {
  const w = { people: createPeople() };
  const w2 = applyRelationshipDelta(w, 'ghost', { affection: 10 });
  assert.deepEqual(w2.people, w.people);
});

test('peopleList returns all people as an array', () => {
  const w = { people: createPeople() };
  const list = peopleList(w);
  assert.equal(list.length, 6);
  assert.ok(list.some((p) => p.id === 'mother'));
});
