// Tests for src/data/analytics.js. Run with: node --test src/data/analytics.test.mjs
//
// The analytics module mirrors learnerModel.js: EMA alpha=0.25, CEFR ladder,
// threshold=3 for fossilization. We assert the same numbers the live model
// would have produced, so offline replay matches in-game behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCefrTimeline,
  fossilizedErrors,
  skillRadar,
  transcriptForDecision,
  summaryReport,
} from './analytics.js';

const now = 1_700_000_000_000;
const session = 's_test';
const ev = (type, ts, seq, payload = {}) => ({
  id: `e${ts}`, v: 1, ts, sessionId: session, seq, type, ...payload,
});

const sample = [
  ev('session.start', now, 0),
  ev('beat.start', now + 1, 1, { beatId: 'cafe-ordering' }),
  ev('utterance.scored', now + 100, 2, {
    transcript: 'I go yesterday to the store', beatId: 'cafe-ordering',
    score: { fluency: 3, range: 2, accuracy: 2, interaction: 3, errors: ['past-tense', 'article-omission'] },
  }),
  ev('utterance.scored', now + 200, 3, {
    transcript: 'Yesterday I went to the store for buying some apples', beatId: 'cafe-ordering',
    score: { fluency: 4, range: 3, accuracy: 3, interaction: 3, errors: ['past-tense'] },
  }),
  ev('utterance.scored', now + 300, 4, {
    transcript: 'Yesterday I went to the store to buy some apples', beatId: 'cafe-ordering',
    score: { fluency: 4, range: 4, accuracy: 4, interaction: 4, errors: [] },
  }),
  ev('scenario.debrief', now + 400, 5, {
    beatId: 'cafe-ordering',
    debrief: { scores: { conflict: 0.2, time: 0.5, collaboration: 0.7 } },
  }),
  ev('beat.end', now + 401, 6, { beatId: 'cafe-ordering' }),
  ev('beat.start', now + 5000, 7, { beatId: 'colleague-disagreement' }),
  ev('npc.said', now + 5050, 8, { text: 'We need to talk about the report.' }),
  ev('utterance.scored', now + 5100, 9, {
    transcript: 'I think we should maybe consider both perspectives', beatId: 'colleague-disagreement',
    score: { fluency: 4, range: 4, accuracy: 4, interaction: 5, errors: ['hedging-absent'] },
  }),
  ev('utterance.scored', now + 5200, 10, {
    transcript: 'If we could maybe compromise, we both get what we need', beatId: 'colleague-disagreement',
    score: { fluency: 4, range: 5, accuracy: 4, interaction: 5, errors: ['past-tense', 'past-tense'] },
  }),
  ev('scenario.debrief', now + 5300, 11, {
    beatId: 'colleague-disagreement',
    debrief: { scores: { conflict: 0.8, time: 0.6, collaboration: 0.9 } },
  }),
];

test('computeCefrTimeline: chronological, EMA-mirrored, final CEFR sensible', () => {
  const t = computeCefrTimeline(sample);
  assert.equal(t.length, 5);
  assert.ok(t.every((p) => p.sessionId === session));
  assert.ok(t.every((p, i, a) => i === 0 || p.ts >= a[i - 1].ts), 'chronological');
  const final = t[t.length - 1];
  assert.ok(final.cefrIndex >= 2 && final.cefrIndex <= 4, `final CEFR ${final.cefr}`);
});

test('fossilizedErrors: past-tense recurs >= 3 times, sorted desc', () => {
  const f = fossilizedErrors(sample);
  const past = f.find((x) => x.pattern === 'past-tense');
  assert.ok(past, 'past-tense should be fossilized');
  assert.equal(past.totalCount, 4);
  assert.equal(past.fossilized, true);
  const by = past.bySession.find((x) => x.sessionId === session);
  assert.equal(by.count, 4);
});

test('skillRadar: per-session EMA after each debrief', () => {
  const r = skillRadar(sample);
  assert.equal(r.length, 1);
  const radar = r[0];
  assert.equal(radar.sessionId, session);
  // EMA alpha=0.25 over two debriefs (assert with float tolerance):
  assert.ok(Math.abs(radar.latest.conflict - 0.35) < 1e-9, `conflict ${radar.latest.conflict}`);
  assert.ok(Math.abs(radar.latest.time - 0.525) < 1e-9, `time ${radar.latest.time}`);
  assert.ok(Math.abs(radar.latest.collaboration - 0.75) < 1e-9, `collab ${radar.latest.collaboration}`);
});

test('transcriptForDecision: reconstructs the player utterance before the last choice', () => {
  const t = transcriptForDecision(sample, session, 'colleague-disagreement');
  assert.ok(t);
  assert.equal(t.sessionId, session);
  assert.equal(t.beatId, 'colleague-disagreement');
  assert.equal(t.playerUtterance, 'If we could maybe compromise, we both get what we need');
  assert.deepEqual(t.npcContext, ['We need to talk about the report.']);
});

test('summaryReport: headline stats + current CEFR + most-played beats', () => {
  const s = summaryReport(sample);
  assert.equal(s.sessions, 1);
  assert.equal(s.utterances, 5);
  assert.ok(s.mostPlayedBeats.length >= 2);
  assert.equal(s.mostPlayedBeats[0].plays, 1);
  assert.ok(s.currentCefr);
});
