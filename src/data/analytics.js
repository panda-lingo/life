// LifeSpeak offline analytics — pure functions over the JSONL event log.
// Answers the four questions in docs/data-model.md without importing anything
// from the game modules. Treats events as plain objects, so it runs in
// both the browser and Node (ESM, zero deps).
//
// Heuristics mirror src/data/learnerModel.js so numbers reported here match
// what the in-game model would have computed, even if the live model is gone.

// ---- tuning constants (must match learnerModel.js) ----
const EMA_ALPHA = 0.25;
const CEFR_STEPS = ['B1', 'B1+', 'B2', 'B2+', 'C1'];
const FOSSIL_THRESHOLD = 3;
const SKILL_KEYS = ['conflict', 'time', 'collaboration'];
const RUBRIC_KEYS = ['fluency', 'range', 'accuracy', 'interaction'];

// ---- JSDoc types ----
/**
 * @typedef {Object} Event
 * @property {string} id            UUID v4
 * @property {number} v             Schema version
 * @property {number} ts            Wall-clock ms
 * @property {string} sessionId     Session UUID
 * @property {number} seq           Per-session monotonic counter
 * @property {string} type          'utterance.scored' | 'scenario.debrief' | ...
 * @property {string} [transcript]
 * @property {{fluency:number,range:number,accuracy:number,interaction:number,errors?:string[],correction?:string,betterVersion?:string}} [score]
 * @property {string} [beatId]
 * @property {{scores?:{conflict?:number,time?:number,collaboration?:number},evidence?:string[],nextTime?:string}} [debrief]
 * @property {string} [text]
 * @property {number} [stepIndex]
 * @property {{text?:string,effects?:object}} [chosen]
 * @property {string} [npcId]
 */

/**
 * @typedef {Object} CefrPoint
 * @property {string} sessionId
 * @property {number} ts
 * @property {number} cefrIndex   0..4
 * @property {string} cefr        'B1'|'B1+'|'B2'|'B2+'|'C1'
 * @property {number} mean        Mean of the four rubric dimensions (0..5)
 */

/**
 * @typedef {Object} ErrorPatternRow
 * @property {string} pattern
 * @property {number} totalCount
 * @property {boolean} fossilized   true once count >= FOSSIL_THRESHOLD
 * @property {{sessionId:string,count:number}[]} bySession  per-session count, session order
 */

/**
 * @typedef {Object} SkillRadar
 * @property {string} sessionId
 * @property {{conflict:(number|null),time:(number|null),collaboration:(number|null)}} latest  EMA after the last debrief of this session (null if that skill never scored)
 */

/**
 * @typedef {Object} DecisionTranscript
 * @property {string} sessionId
 * @property {string} beatId
 * @property {number|null} stepIndex       index into the beat's steps array, if known
 * @property {string|null} playerUtterance raw transcript captured at the choice point (null if none recorded)
 * @property {string[]} npcContext         NPC lines spoken immediately before the choice
 * @property {string[]} options            option texts as presented (if recoverable from events)
 * @property {string|null} chosenText      text of the option the player picked (null if no choice event)
 */

/**
 * @typedef {Object} SummaryReport
 * @property {number} sessions
 * @property {number} utterances
 * @property {number|null} avgRubric       mean of all utterance rubric means (0..5), null if no utterances
 * @property {string|null} currentCefr     latest CEFR label across all sessions
 * @property {{beatId:string,plays:number}[]} mostPlayedBeats  sorted desc
 */

// ---- helpers ----
const bySessionThenSeq = (a, b) =>
  a.sessionId === b.sessionId ? a.seq - b.seq : (a.sessionId < b.sessionId ? -1 : 1);

function ema(prev, next) {
  return prev == null ? next : prev + EMA_ALPHA * (next - prev);
}

function cefrFromMean(mean) {
  const idx = Math.max(0, Math.min(CEFR_STEPS.length - 1, Math.round(mean) - 1));
  return { cefrIndex: idx, cefr: CEFR_STEPS[idx] };
}

function rubricMean(score) {
  const vals = RUBRIC_KEYS.map((k) => score?.[k]).filter((v) => typeof v === 'number');
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Normalize an utterance.scored payload — the score may sit at top level
// (older exports) or nested under .score (current emit call).
function scoreOf(event) {
  const s = event.score || event;
  if (RUBRIC_KEYS.some((k) => typeof s[k] === 'number')) return s;
  return null;
}

function groupBySession(events) {
  const map = new Map();
  for (const e of events) {
    if (!map.has(e.sessionId)) map.set(e.sessionId, []);
    map.get(e.sessionId).push(e);
  }
  return map;
}

// ---- public API ----

/**
 * 1. "What CEFR level is the learner at now, and how has it moved?"
 * Replays utterance.scored events in per-session seq order, re-running the
 * same EMA + ladder mapping the live model used. Emits one point per scored
 * utterance.
 *
 * @param {Event[]} events
 * @returns {CefrPoint[]}
 */
export function computeCefrTimeline(events) {
  const utterances = events
    .filter((e) => e.type === 'utterance.scored')
    .slice()
    .sort(bySessionThenSeq);

  const perSession = new Map(); // sessionId -> {fluency,range,accuracy,interaction}
  const out = [];
  for (const e of utterances) {
    const score = scoreOf(e);
    if (!score) continue;
    if (!perSession.has(e.sessionId)) {
      perSession.set(e.sessionId, { fluency: null, range: null, accuracy: null, interaction: null });
    }
    const lang = perSession.get(e.sessionId);
    for (const k of RUBRIC_KEYS) {
      if (typeof score[k] === 'number') lang[k] = ema(lang[k], score[k]);
    }
    const mean = rubricMean(lang);
    if (mean == null) continue;
    const { cefrIndex, cefr } = cefrFromMean(mean);
    out.push({ sessionId: e.sessionId, ts: e.ts, cefrIndex, cefr, mean });
  }
  return out;
}

/**
 * 2. "Which error patterns are fossilizing?"
 * Counts every error label emitted by utterance.scored, splits per-session,
 * flags patterns at/above the fossilization threshold.
 *
 * @param {Event[]} events
 * @returns {ErrorPatternRow[]} sorted by totalCount desc
 */
export function fossilizedErrors(events) {
  const tally = new Map(); // pattern -> { total, perSession: Map }
  for (const e of events) {
    if (e.type !== 'utterance.scored') continue;
    const score = scoreOf(e);
    const errs = Array.isArray(score?.errors) ? score.errors : [];
    for (const p of errs) {
      if (!tally.has(p)) tally.set(p, { total: 0, perSession: new Map() });
      const row = tally.get(p);
      row.total += 1;
      row.perSession.set(e.sessionId, (row.perSession.get(e.sessionId) || 0) + 1);
    }
  }
  return [...tally.entries()]
    .map(([pattern, { total, perSession }]) => ({
      pattern,
      totalCount: total,
      fossilized: total >= FOSSIL_THRESHOLD,
      bySession: [...perSession.entries()].map(([sessionId, count]) => ({ sessionId, count })),
    }))
    .sort((a, b) => b.totalCount - a.totalCount || (a.pattern < b.pattern ? -1 : 1));
}

/**
 * 3. "Which soft skills are weakest, and in which scenario archetypes?"
 * Replays scenario.debrief events per session, EMA-ing each skill, and
 * returns the latest radar per session. (Archetype = beatId; for a
 * per-archetype view, group the debriefs by beatId first — the raw events
 * already carry beatId.)
 *
 * @param {Event[]} events
 * @returns {SkillRadar[]} one row per session, in first-seen order
 */
export function skillRadar(events) {
  const debriefs = events
    .filter((e) => e.type === 'scenario.debrief')
    .slice()
    .sort(bySessionThenSeq);

  const state = new Map(); // sessionId -> {conflict,time,collaboration}
  const order = [];
  for (const e of debriefs) {
    if (!state.has(e.sessionId)) {
      state.set(e.sessionId, { conflict: null, time: null, collaboration: null });
      order.push(e.sessionId);
    }
    const cur = state.get(e.sessionId);
    const scores = e.debrief?.scores || {};
    for (const k of SKILL_KEYS) {
      if (typeof scores[k] === 'number') cur[k] = ema(cur[k], scores[k]);
    }
  }
  return order.map((sessionId) => ({ sessionId, latest: { ...state.get(sessionId) } }));
}

/**
 * 4. "What did the learner actually say at each decision point?"
 * Reconstructs the dialogue around the (sessionId, beatId) choice point:
 * locates the beat's [beat.start .. beat.end] window in that session,
 * pulls the choice.made event inside it, the NPC lines leading up to the
 * choice, and the player's utterance(s) scored between the choice and the
 * previous NPC/choice (i.e. what they said while deliberating).
 *
 * The game currently emits choice.made without a beatId, so we correlate
 * via seq-window; if multiple choice.made events exist in the window we
 * return the LAST one (most recent decision).
 *
 * @param {Event[]} events
 * @param {string} sessionId
 * @param {string} beatId
 * @returns {DecisionTranscript|null} null if the beat never ran in that session
 */
export function transcriptForDecision(events, sessionId, beatId) {
  const session = events
    .filter((e) => e.sessionId === sessionId)
    .slice()
    .sort((a, b) => a.seq - b.seq);

  const start = session.find((e) => e.type === 'beat.start' && e.beatId === beatId);
  if (!start) return null;
  const end = session.find((e) => e.type === 'beat.end' && e.beatId === beatId && e.seq > start.seq);
  const endSeq = end ? end.seq : Infinity;

  const window = session.filter((e) => e.seq > start.seq && e.seq < endSeq);
  const choices = window.filter((e) => e.type === 'choice.made');
  const choice = choices[choices.length - 1] || null;
  const choiceSeq = choice ? choice.seq : endSeq;

  const npcContext = [];
  let playerUtterance = null;
  for (const e of window) {
    if (e.seq >= choiceSeq) break;
    if (e.type === 'npc.said') npcContext.push(e.text);
    if (e.type === 'utterance.scored') playerUtterance = e.transcript ?? null;
  }

  return {
    sessionId,
    beatId,
    stepIndex: choice?.stepIndex ?? null,
    playerUtterance,
    npcContext,
    options: [],                    // options aren't currently emitted on choice.made
    chosenText: choice?.chosen?.text ?? null,
  };
}

/**
 * High-level rollup: session/utterance counts, average rubric, current CEFR,
 * and most-played beats.
 *
 * @param {Event[]} events
 * @returns {SummaryReport}
 */
export function summaryReport(events) {
  const sessions = new Set(events.map((e) => e.sessionId)).size;

  const utteranceEvents = events.filter((e) => e.type === 'utterance.scored');
  let rubricSum = 0;
  let rubricN = 0;
  for (const e of utteranceEvents) {
    const m = rubricMean(scoreOf(e));
    if (m != null) { rubricSum += m; rubricN += 1; }
  }
  const avgRubric = rubricN ? rubricSum / rubricN : null;

  const timeline = computeCefrTimeline(events);
  const currentCefr = timeline.length ? timeline[timeline.length - 1].cefr : null;

  const beatCounts = new Map();
  for (const e of events) {
    if (e.type === 'beat.start' && e.beatId) {
      beatCounts.set(e.beatId, (beatCounts.get(e.beatId) || 0) + 1);
    }
  }
  const mostPlayedBeats = [...beatCounts.entries()]
    .map(([beatId, plays]) => ({ beatId, plays }))
    .sort((a, b) => b.plays - a.plays || (a.beatId < b.beatId ? -1 : 1));

  return {
    sessions,
    utterances: utteranceEvents.length,
    avgRubric,
    currentCefr,
    mostPlayedBeats,
  };
}
