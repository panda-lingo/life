// AI provider boundary. The game talks ONLY to this module.
// Contract (per project constraint): text + image in  ->  text out.
//
// Provider order (first healthy wins):
//   1. backend server provider  — POST /api/ai/complete; secrets live
//      server-side. Skipped entirely when /api/healthz is unreachable.
//   2. window.LIFESPEAK_AI      — explicit dev/test override.
//   3. browser-direct OpenAI    — window.__LIFESPEAK_AI_CONFIG / env creds.
//   4. mockProvider             — deterministic offline fallback.

import { mockProvider } from './mockProvider.js';
import detectOpenAIProvider from './openaiProvider.js';
import { probeBackend, backendComplete } from '../net/backend.js';

// director.js stays import-safe in browsers even when the openai SDK is
// unavailable (no importmap entry), because detectOpenAIProvider() is
// async and lazily loads the SDK. The provider selection happens inside
// call() so a synchronous module graph never blows up on page load.

let _detectPromise = null;
// Dependency seams so Node unit tests can inject fake providers without a
// browser, fetch, or real backend. Production leaves them null → real imports.
let _probeBackend = probeBackend;
let _backendComplete = backendComplete;
let _detectOpenAI = detectOpenAIProvider;
let _mock = mockProvider;

export function _setProviderImplsForTests(impls = {}) {
  if ('probeBackend' in impls) _probeBackend = impls.probeBackend;
  if ('backendComplete' in impls) _backendComplete = impls.backendComplete;
  if ('detectOpenAI' in impls) _detectOpenAI = impls.detectOpenAI;
  if ('mock' in impls) _mock = impls.mock;
  _detectPromise = null;
}

export async function getProviderForTests() {
  return getProvider();
}

async function getProvider() {
  if (typeof window !== 'undefined' && window.LIFESPEAK_AI) return window.LIFESPEAK_AI;
  // Prefer the backend: when it answers, secrets never enter the page.
  const health = await _probeBackend();
  if (health?.ai) {
    return { name: 'backend', complete: (req) => _backendComplete(req) };
  }
  _detectPromise ||= _detectOpenAI();
  const real = await _detectPromise;
  return real || _mock;
}

// ---- prompt assembly -------------------------------------------------
// Every request is a single text prompt with a strict "respond with JSON
// only" contract; optional screenshot (dataURL) for visual grounding.

function jsonPrompt(system, task, context) {
  return [
    system.trim(),
    '',
    'CONTEXT (JSON):',
    JSON.stringify(context, null, 1),
    '',
    `TASK: ${task}`,
    '',
    'Respond with VALID JSON only. No markdown fences, no commentary.',
  ].join('\n');
}

async function call(system, task, context, { image = null } = {}) {
  const p = await getProvider();
  const prompt = jsonPrompt(system, task, context);
  // Backend-only resilience: when the chosen provider is the backend server
  // proxy, a 5xx (or network throw) must NOT crash the dialogue beat. Log
  // a masked line and complete the turn with the deterministic mock. We
  // intentionally don't retry — retry multiplies pressure on a known-flaky
  // upstream (Qwen3.5 503 bursts) and the mock is <5ms. Non-backend providers
  // (openai direct, window override) still throw: masking their bugs would
  // hide real failures.
  if (p.name === 'backend') {
    try {
      const raw = await p.complete({ prompt, image });
      return JSON.parse(extractJSON(raw));
    } catch (err) {
      const status = err?.status;
      // 4xx errors are client-side bugs (malformed prompt, bad max_tokens, etc.)
      // and must re-throw so callers see the failure. Only 5xx / network throws
      // fall back to mock.
      if (typeof status === 'number' && status >= 400 && status < 500) {
        throw err;
      }
      console.warn(`[ai-director] backend provider failed (${status ?? 'network'}); degrading this turn to mock`);
      const raw = await _mock.complete({ prompt, image });
      return JSON.parse(extractJSON(raw));
    }
  }
  const raw = await p.complete({ prompt, image });
  return JSON.parse(extractJSON(raw));
}

function extractJSON(raw) {
  const m = String(raw).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) throw new Error(`AI returned non-JSON: ${raw.slice(0, 200)}`);
  return m[0];
}

// ---- 1. Director: pick the next scenario node ------------------------
// Candidate beats are pre-filtered by hard gates (stats/flags/time); the AI
// chooses among them for pedagogical + narrative fit.
export async function directNextScenario({ worldState, learnerModel, candidates, fossilized }) {
  return call(
    `You are the AI director of a life-simulation English learning game (CEFR B1-C1).
Pick the next scenario beat that best targets the learner's weaknesses while
keeping narrative continuity. Prefer beats exercising fossilized error patterns
or the least-practiced soft skill, unless a pending consequence demands follow-up.`,
    'Choose one candidate beat id and explain pacing rationale.',
    { worldState, learner: learnerModel, fossilizedErrors: fossilized, candidates },
  );
  // -> { "beatId": "...", "rationale": "...", "framing": "one-line scene setup" }
}

// ---- 2. Scene composition: choose kit + layout + props ---------------
export async function composeScene({ beat, availableKits, worldState }) {
  return call(
    `You are the scene composer of a low-poly 3D life sim. Given a narrative beat
and the available pre-generated asset kits/layouts/props, select a kit, a layout,
and fill each prop slot so the environment matches the beat's location and mood.
Only use ids from the provided manifests — never invent assets.`,
    'Return the scene composition.',
    { beat, availableKits, worldState },
  );
  // -> { "kit": "...", "layout": "...", "props": {slot: assetId}, "lighting": "day|evening|night", "npcs": [charIds] }
}

// ---- 3. NPC dialogue turn --------------------------------------------
export async function npcTurn({ beat, npc, worldState, history, learnerUtterance, targetLevel }) {
  return call(
    `You are ${npc.name} (${npc.role}) in a life-sim English practice game.
Personality: ${npc.personality}. Current mood toward player: ${npc.mood}.
Speak natural ${targetLevel}-appropriate English (input slightly above learner
level). React to what the player said, advance your hidden agenda, and keep
turns under 40 words. Also output your new mood and any world-state effects.`,
    'Reply in character.',
    { beat, worldState, recentHistory: history.slice(-8), learnerUtterance },
  );
  // -> { "text": "...", "mood": "...", "effects": {"flags": {...}, "stats": {...}}, "beatAdvance": "stay|advance|fail" }
}

// ---- 4. Utterance scoring (CEFR rubric) -------------------------------
export async function scoreUtterance({ transcript, context, targetLevel }) {
  return call(
    `You are a CEFR speaking examiner (Cambridge/IELTS style). Score the learner
utterance in context on four 0-5 scales anchored to B1-C1:
fluency (pace/hesitation), range (vocab & grammar stretch), accuracy (errors),
interaction (appropriacy, turn-taking, strategies like hedging/clarifying).
Identify concrete error patterns with short labels (e.g. "article-omission",
"past-tense", "hedging-absent"). Give one actionable, encouraging correction.`,
    'Score this utterance.',
    { targetLevel, context, transcript },
  );
  // -> { "fluency": n, "range": n, "accuracy": n, "interaction": n,
  //      "errors": ["pattern", ...], "correction": "...", "betterVersion": "..." }
}

// ---- 5. Scenario debrief (soft skills) --------------------------------
export async function debriefScenario({ beat, transcriptLog, skillFocus }) {
  return call(
    `You are a soft-skills coach doing an after-action review. Score 0..1 per
skill using these lenses: conflict = Thomas-Kilmann (collaborating/compromising
> avoiding/competing, evidence: exploring interests, acknowledging other side);
time = prioritization clarity (Eisenhower: named urgency/importance, committed
to a plan); collaboration = psychological safety moves (invited input, built on
others' ideas, explicit role/task clarity). Cite the player's own words as
evidence. End with one concrete "next time try" suggestion.`,
    'Produce the debrief.',
    { beat, skillFocus, transcriptLog },
  );
  // -> { "scores": {"conflict": x, "time": y, "collaboration": z},
  //      "evidence": ["quote -> why", ...], "nextTime": "..." }
}
