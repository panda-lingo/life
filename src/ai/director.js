// AI provider boundary. The game talks ONLY to this module.
// Contract (per project constraint): text + image in  ->  text out.
// Default implementation is a deterministic offline mock so the whole game
// runs with zero keys; plug a real provider by setting window.LIFESPEAK_AI
// or editing provider.js.

import { mockProvider } from './mockProvider.js';
import detectOpenAIProvider from './openaiProvider.js';

function getProvider() {
  return window.LIFESPEAK_AI || detectOpenAIProvider() || mockProvider;
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
  const p = getProvider();
  const raw = await p.complete({ prompt: jsonPrompt(system, task, context), image });
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
