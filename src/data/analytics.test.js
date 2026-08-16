// Run with: node --test src/data/analytics.test.js
// Five offline analytics test cases against canned event log data.
// Each case: hand-crafted events → assertions on the analytics output.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCefrTimeline,
  fossilizedErrors,
  skillRadar,
  transcriptForDecision,
  summaryReport,
} from './analytics.js';

// ---------- shared fixture helpers ----------
let seq = 0;
const nextSeq = () => seq++;

function ev(overrides) {
  return {
    id: 'e' + nextSeq(),
    v: 1,
    ts: 1_700_000_000_000 + nextSeq() * 100,
    sessionId: 's1',
    seq: 0, // will be overwritten below
    type: 'utterance.scored',
    ...overrides,
  };
}

function withSeq(events) {
  // Re-sequence per session monotonically and stamp ts.
  const counters = new Map();
  let tsBase = 1_700_000_000_000;
  return events.map((e) => {
    const c = (counters.get(e.sessionId) || 0);
    counters.set(e.sessionId, c + 1);
    tsBase += 100;
    return { ...e, seq: c, ts: e.ts ?? tsBase };
  });
}

// ====================================================================
// CASE 1 — computeCefrTimeline: ladder steps match learnerModel math.
// ====================================================================
test('computeCefrTimeline produces an EMA ladder that climbs across sessions', () => {
  seq = 0;
  const events = withSeq([
    // session A — three utterances, all weak (mean ~2.25 → B1+)
    { sessionId: 'sA', type: 'utterance.scored',
      score: { fluency: 2, range: 2, accuracy: 3, interaction: 2, errors: [] } },
    { sessionId: 'sA', type: 'utterance.scored',
      score: { fluency: 2, range: 2, accuracy: 3, interaction: 2, errors: [] } },
    { sessionId: 'sA', type: 'utterance.scored',
      score: { fluency: 2, range: 2, accuracy: 3, interaction: 2, errors: [] } },
    // session B — three strong utterances (climbs to B2+)
    { sessionId: 'sB', type: 'utterance.scored',
      score: { fluency: 4, range: 4, accuracy: 4, interaction: 4, errors: [] } },
    { sessionId: 'sB', type: 'utterance.scored',
      score: { fluency: 5, range: 5, accuracy: 5, interaction: 5, errors: [] } },
    { sessionId: 'sB', type: 'utterance.scored',
      score: { fluency: 4, range: 4, accuracy: 4, interaction: 4, errors: [] } },
  ]);

  const tl = computeCefrTimeline(events);
  assert.equal(tl.length, 6);
  // session A first point: mean 2.25, round→2, idx = round−1 = 1 → B1+
  assert.equal(tl[0].cefr, 'B1+');
  assert.equal(tl[0].cefrIndex, 1);
  // session A third point: EMA stabilizes at 2.25 → still B1+
  assert.equal(tl[2].cefr, 'B1+');
  // last point is in session B, mean should land at idx 3 (B2+) or 4 (C1)
  assert.ok(['B2+', 'C1'].includes(tl[5].cefr), `got ${tl[5].cefr}`);
  // every point has a sessionId and ts
  for (const p of tl) {
    assert.ok(p.sessionId);
    assert.ok(p.ts);
  }
});

// ====================================================================
// CASE 2 — fossilizedErrors: flags patterns at threshold, ranks by count.
// ====================================================================
test('fossilizedErrors flags patterns hitting threshold and orders by count', () => {
  seq = 0;
  const events = withSeq([
    // "article-omission" hits 4 across two sessions — fossilized
    { sessionId: 'sA', type: 'utterance.scored',
      score: { fluency: 3, range: 3, accuracy: 3, interaction: 3, errors: ['article-omission'] } },
    { sessionId: 'sA', type: 'utterance.scored',
      score: { fluency: 3, range: 3, accuracy: 3, interaction: 3, errors: ['article-omission'] } },
    { sessionId: 'sB', type: 'utterance.scored',
      score: { fluency: 3, range: 3, accuracy: 3, interaction: 3, errors: ['article-omission', 'past-tense'] } },
    { sessionId: 'sB', type: 'utterance.scored',
      score: { fluency: 3, range: 3, accuracy: 3, interaction: 3, errors: ['article-omission'] } },
    // "past-tense" only 1 — not fossilized
    // "hedging-absent" hits 3 — fossilized (tied for boundary)
    { sessionId: 'sA', type: 'utterance.scored',
      score: { fluency: 3, range: 3, accuracy: 3, interaction: 3, errors: ['hedging-absent'] } },
    { sessionId: 'sB', type: 'utterance.scored',
      score: { fluency: 3, range: 3, accuracy: 3, interaction: 3, errors: ['hedging-absent'] } },
    { sessionId: 'sB', type: 'utterance.scored',
      score: { fluency: 3, range: 3, accuracy: 3, interaction: 3, errors: ['hedging-absent'] } },
  ]);

  const rows = fossilizedErrors(events);
  // top row: article-omission, count 4, fossilized true
  assert.equal(rows[0].pattern, 'article-omission');
  assert.equal(rows[0].totalCount, 4);
  assert.equal(rows[0].fossilized, true);
  assert.equal(rows[0].bySession.length, 2);
  assert.deepEqual(rows[0].bySession.map((x) => x.sessionId).sort(), ['sA', 'sB']);

  // past-tense appears too, count 1, NOT fossilized
  const pt = rows.find((r) => r.pattern === 'past-tense');
  assert.ok(pt);
  assert.equal(pt.totalCount, 1);
  assert.equal(pt.fossilized, false);

  // hedging-absent is fossilized (>=3)
  const ha = rows.find((r) => r.pattern === 'hedging-absent');
  assert.equal(ha.fossilized, true);
  assert.equal(ha.totalCount, 3);

  // overall ordering by count desc
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].totalCount >= rows[i].totalCount);
  }
});

// ====================================================================
// CASE 3 — skillRadar: latest EMA values reflect debrief history per session.
// ====================================================================
test('skillRadar returns latest EMA per session from debrief events', () => {
  seq = 0;
  const events = withSeq([
    // session sA: two debriefs. scores move from low to higher on conflict.
    { sessionId: 'sA', type: 'scenario.debrief',
      debrief: { scores: { conflict: 0.2, time: 0.3, collaboration: 0.4 }, evidence: [], nextTime: '' } },
    { sessionId: 'sA', type: 'scenario.debrief',
      debrief: { scores: { conflict: 1.0, time: 0.5, collaboration: 0.6 }, evidence: [], nextTime: '' } },
    // session sB: one debrief.
    { sessionId: 'sB', type: 'scenario.debrief',
      debrief: { scores: { conflict: 0.8, time: 0.7, collaboration: 0.9 }, evidence: [], nextTime: '' } },
  ]);

  const radar = skillRadar(events);
  assert.equal(radar.length, 2);
  assert.equal(radar[0].sessionId, 'sA');
  assert.equal(radar[1].sessionId, 'sB');

  // sA latest: ema(prev,next) with alpha=0.25
  assert.equal(radar[0].latest.conflict, 0.4);       // ema(0.2, 1.0)
  assert.equal(radar[0].latest.time, 0.35);          // ema(0.3, 0.5)
  assert.equal(radar[0].latest.collaboration, 0.45); // ema(0.4, 0.6)

  // sB: only one observation, so latest equals it directly
  assert.equal(radar[1].latest.conflict, 0.8);
  assert.equal(radar[1].latest.time, 0.7);
  assert.equal(radar[1].latest.collaboration, 0.9);
});

// ====================================================================
// CASE 4 — transcriptForDecision: stitches NPC lines + player + chosen.
// ====================================================================
test('transcriptForDecision reconstructs the player utterance at a choice point', () => {
  seq = 0;
  const events = withSeq([
    { sessionId: 's1', type: 'beat.start', beatId: 'cafe-ordering' },
    { sessionId: 's1', type: 'npc.said', text: 'Welcome! What can I get you?' },
    { sessionId: 's1', type: 'utterance.scored',
      transcript: 'Could I have a latte with oat milk, please?',
      score: { fluency: 4, range: 4, accuracy: 4, interaction: 5, errors: [] } },
    { sessionId: 's1', type: 'npc.said', text: 'Sure, anything else?' },
    { sessionId: 's1', type: 'choice.made', stepIndex: 2,
      chosen: { text: 'No, that is all. Thank you.', effects: {} } },
    { sessionId: 's1', type: 'npc.said', text: 'Great, have a nice day!' },
    { sessionId: 's1', type: 'beat.end', beatId: 'cafe-ordering' },
  ]);

  const t = transcriptForDecision(events, 's1', 'cafe-ordering');
  assert.ok(t);
  assert.equal(t.sessionId, 's1');
  assert.equal(t.beatId, 'cafe-ordering');
  assert.equal(t.stepIndex, 2);
  assert.equal(t.chosenText, 'No, that is all. Thank you.');
  // The utterance captured *before* the choice is the player's last scored line.
  assert.equal(t.playerUtterance, 'Could I have a latte with oat milk, please?');
  // NPC context must include everything said before the choice, in order,
  // and nothing after.
  assert.deepEqual(t.npcContext, [
    'Welcome! What can I get you?',
    'Sure, anything else?',
  ]);
  assert.equal(t.npcContext.includes('Great, have a nice day!'), false);

  // Wrong session or beat yields null.
  assert.equal(transcriptForDecision(events, 's1', 'nonexistent'), null);
  assert.equal(transcriptForDecision(events, 'other', 'cafe-ordering'), null);
});

// ====================================================================
// CASE 5 — summaryReport: rollups of sessions, utterances, rubric, beats.
// ====================================================================
test('summaryReport rolls up sessions, utterances, rubric avg, and beat play counts', () => {
  seq = 0;
  const events = withSeq([
    { sessionId: 's1', type: 'beat.start', beatId: 'cafe-ordering' },
    { sessionId: 's1', type: 'utterance.scored',
      score: { fluency: 4, range: 4, accuracy: 4, interaction: 4, errors: [] } }, // mean 4
    { sessionId: 's1', type: 'utterance.scored',
      score: { fluency: 2, range: 2, accuracy: 2, interaction: 2, errors: [] } }, // mean 2
    { sessionId: 's1', type: 'beat.end', beatId: 'cafe-ordering' },
    { sessionId: 's2', type: 'beat.start', beatId: 'cafe-ordering' },
    { sessionId: 's2', type: 'utterance.scored',
      score: { fluency: 3, range: 3, accuracy: 3, interaction: 3, errors: [] } }, // mean 3
    { sessionId: 's2', type: 'beat.start', beatId: 'deadline-pressure' },
    { sessionId: 's2', type: 'beat.end', beatId: 'cafe-ordering' },
    { sessionId: 's2', type: 'beat.end', beatId: 'deadline-pressure' },
  ]);

  const r = summaryReport(events);
  assert.equal(r.sessions, 2);
  assert.equal(r.utterances, 3);
  assert.equal(r.avgRubric, 3);                  // (4 + 2 + 3) / 3
  assert.equal(r.currentCefr, 'B2');            // last utterance mean 3 → round(3)-1 = 2 → 'B2'
  // cafe-ordering appears twice, deadline-pressure once
  assert.deepEqual(r.mostPlayedBeats, [
    { beatId: 'cafe-ordering', plays: 2 },
    { beatId: 'deadline-pressure', plays: 1 },
  ]);

  // empty event log → safe defaults
  const empty = summaryReport([]);
  assert.equal(empty.sessions, 0);
  assert.equal(empty.utterances, 0);
  assert.equal(empty.avgRubric, null);
  assert.equal(empty.currentCefr, null);
  assert.deepEqual(empty.mostPlayedBeats, []);
});