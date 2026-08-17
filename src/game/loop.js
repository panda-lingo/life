// Game loop: wire director → composer → engine, drive NPC dialogue via
// speech I/O, score every utterance, debrief on scenario end, persist
// all events. This is the only file that talks to every other module.

import { beats, eligibleBeats, applyEffects } from '../../scenarios/scenarios.js';
import { initSession, emit, downloadExport } from '../data/eventlog.js';
import {
  createLearnerModel, updateLanguage, updateSkills,
  fossilizedErrors, cefrEstimate,
} from '../data/learnerModel.js';
import {
  createRecognizer, speak, pickVoice, stopSpeaking, speechCapabilities,
} from '../speech/speech.js';
import {
  directNextScenario, composeScene, npcTurn, scoreUtterance, debriefScenario,
} from '../ai/director.js';
import { renderHUD, showChoice, showTextInput, showPlacePicker, clearHUDOverlays } from '../ui/hud.js';
import { createExplorer, placeToBeat } from '../gmaps/maps.js';

// --------- per-session state ---------
let session = null;

function createSession() {
  return {
    worldState: { flags: {}, stats: {} },
    learnerModel: createLearnerModel(),
    transcriptLog: [],           // { from: 'npc'|'player', text, ts }
    currentBeat: null,
    engineRef: null,
    stopLoop: null,
    ctrl: new AbortController(),
  };
}

// Tunables.
const LISTEN_TIMEOUT_MS = 12_000;
const NPC_PAUSE_MS = 800;            // pacing fallback when TTS missing

/**
 * Boot the game. Container is the DOM node the Three.js renderer mounts to.
 * Each call creates its own session so concurrent games can be torn down
 * independently in tests or hot-reload scenarios.
 */
export async function startGame(container) {
  const s = (session = createSession());
  const { signal } = s.ctrl;

  initSession({
    selfAssessedLevel: 'B1',
    targetLevel: 'C1',
    skillsFocus: ['conflict', 'time', 'collaboration'],
  });

  // Lazy: the Three.js engine (and its `three` bare specifier, resolved via
  // the index.html importmap) is only needed for the classic 3D game. Explore
  // mode is a flat map + HUD and never pulls this in — which also keeps the
  // module importable in bare Node for integration tests.
  const { createEngine } = await import('../engine/engine.js');
  const e = createEngine(container);
  s.engineRef = e;
  s.stopLoop = e.loop(() => e.render());

  await renderHUD({
    onExit: () => emit('session.end', {}),
    onExport: () => downloadExport(),
    onCefr: () => cefrEstimate(s.learnerModel),
  });

  // Drive the scenario graph until no eligible beats remain or the
  // session is aborted (e.g. user exits).
  while (!signal.aborted) {
    const candidates = eligibleBeats(s.worldState).map((b) => ({
      id: b.id,
      framing: b.title,
      skillFocus: b.skillFocus,
      cefrRange: b.cefrRange,
    }));
    if (!candidates.length) break;

    const continued = await runNextBeat(s, { signal, candidates });
    if (!continued) break;
  }

  if (s.stopLoop) { s.stopLoop(); s.stopLoop = null; }
  stopSpeaking();
}

/**
 * Explore mode: boot Google Maps in the given container and let the player
 * discover real-world places nearby, then walk a scenario beat built from
 * the chosen place via the maps boundary (`placeToBeat`). Uses the same
 * dialogue / scoring / debrief pipeline as the classic game.
 *
 * With no `GOOGLE_MAPS_API_KEY` (local dev, CI), the maps module falls back
 * to a deterministic mock so the whole flow remains playable and testable.
 */
export async function startExplore(container, { explorerFactory = createExplorer } = {}) {
  const s = (session = createSession());
  const { signal } = s.ctrl;

  // Geolocate before initSession: emit() persists to IndexedDB, which is
  // unavailable in bare Node (unit tests), so nothing must be emitted until
  // player interaction begins in a real browser.
  const center = await currentPosition();

  initSession({
    mode: 'explore',
    selfAssessedLevel: 'B1',
    targetLevel: 'C1',
    skillsFocus: ['interaction'],
  });

  const explorer = await explorerFactory(container, { center });
  await emit('explore.start', { mode: explorer.mock ? 'mock' : 'live', center });

  const earliestPlaces = await explorer.searchNearby({ location: center, radius: 500 });
  await emit('places.searched', { count: earliestPlaces.length });

  // Zero-results live search (ZERO_RESULTS, quota/limit errors — the maps
  // boundary resolves [] for every non-OK status) must never render an
  // empty, dead-end picker: report it and hand control back to the splash
  // screen. Same no-dead-screen guard showChoice applies to empty option
  // lists.
  if (!earliestPlaces.length) {
    await renderHUD({
      lastNPC: 'No places found nearby — check your connection or API key, then try again.',
    });
    await emit('explore.empty', { mode: explorer.mock ? 'mock' : 'live' });
    explorer.dispose();
    returnToSplash();
    return false;
  }

  const chosen = await showPlacePicker(earliestPlaces, { signal });
  if (signal.aborted || !chosen) { explorer.dispose(); return; }
  clearHUDOverlays();
  await emit('place.selected', {
    placeId: chosen.placeId, name: chosen.name, rating: chosen.rating,
  });

  const continued = await runNextBeat(s, {
    signal,
    candidates: [{
      id: `real-place:${chosen.placeId}`,
      framing: chosen.name,
      skillFocus: ['interaction'],
      cefrRange: ['B1', 'C1'],
    }],
    beatMap: { [`real-place:${chosen.placeId}`]: placeToBeat(chosen) },
  });
  return continued;
}

// Best-effort geolocation; resolves null when unsupported or denied.
function currentPosition({ timeoutMs = 4_000 } = {}) {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => { clearTimeout(timer); resolve(null); },
      { timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

// No-progress escape hatch: reload back to the splash screen. Used by the
// zero-results explore path, where the splash was already removed and the
// HUD has no navigation affordance.
function returnToSplash() {
  setTimeout(() => { if (typeof location !== 'undefined') location.reload(); }, 2_000);
}

async function runNextBeat(s, { signal, candidates, beatMap = beats }) {  const { beatId, framing } = await directNextScenario({
    worldState: s.worldState,
    learnerModel: s.learnerModel,
    candidates,
    fossilized: fossilizedErrors(s.learnerModel),
  });
  s.currentBeat = beatMap[beatId];
  if (!s.currentBeat) return false;

  await emit('beat.start', { beatId, framing, worldState: structuredClone(s.worldState) });

  // 1. Compose + render the scene (only when a 3D engine is mounted —
  // explore mode renders the map instead and skips scene composition).
  if (s.engineRef) {
    const composition = await composeScene({
      beat: s.currentBeat, availableKits: s.engineRef.listKits(), worldState: s.worldState,
    });
    s.engineRef.composeComposition(composition);
    await emit('scene.composed', { beatId, composition });
  }

  // 2. Opening line from the NPC.
  const opening = await npcTurn({
    beat: s.currentBeat,
    npc: s.currentBeat.npcs[0],
    worldState: s.worldState,
    history: s.transcriptLog,
    learnerUtterance: '(scene opens)',
    targetLevel: cefrEstimate(s.learnerModel),
  });
  await playNPC(s, opening.text);

  // 3. Walk the beat graph.
  await playDialogueSteps(s, { signal, beat: s.currentBeat });

  await emit('beat.end', { beatId });
  await runDebrief(s, { beatId });
  return true;
}

async function playDialogueSteps(s, { signal, beat }) {
  for (const step of beat.beats) {
    if (signal.aborted) return;

    const dialogueKinds = new Set(['npc-dialogue', 'npc-dialogue-2', 'npc-dialogue-success']);
    const isDialogue = dialogueKinds.has(step.kind) || /^npc-\d+$/.test(step.kind);
    const isNarration = step.kind === 'narration' || /^narration-\d+$/.test(step.kind);

    if (isDialogue) {
      // Listen first so the NPC can react to what the player actually said,
      // then score that utterance and advance the learner model.
      const utterance = await capturePlayerUtterance(s, { signal });
      if (signal.aborted) return;
      s.transcriptLog.push({ from: 'player', text: utterance, ts: Date.now() });

      const score = await scoreUtterance({
        transcript: utterance,
        context: { beatId: beat.id, recentHistory: s.transcriptLog.slice(-6) },
        targetLevel: cefrEstimate(s.learnerModel),
      });
      await emit('utterance.scored', { transcript: utterance, score });
      updateLanguage(s.learnerModel, score, score.errors || []);

      const reply = await npcTurn({
        beat, npc: beat.npcs[0], worldState: s.worldState, history: s.transcriptLog,
        learnerUtterance: utterance || '(silence)',
        targetLevel: cefrEstimate(s.learnerModel),
      });
      await playNPC(s, reply.text);
    } else if (step.kind === 'choice') {
      await presentChoice(s, { signal, step });
      await clearHUDOverlays();
    } else if (isNarration) {
      await playNPC(s, step.text);
    } else if (step.kind === 'end') {
      return;
    }
  }
}

async function presentChoice(s, { signal, step }) {
  const chosen = await showChoice(step.options, { signal });
  if (!chosen) return;
  // Merge effects back into the world state before the next NPC turn sees them.
  const merged = applyEffects(s.worldState, chosen.effects || {});
  s.worldState.flags = merged.flags;
  s.worldState.stats = merged.stats;
  await emit('choice.made', {
    stepIndex: s.currentBeat.beats.indexOf(step),
    chosen,
  });
}

// ----- NPC voice -----
async function playNPC(s, text) {
  s.transcriptLog.push({ from: 'npc', text, ts: Date.now() });
  await emit('npc.said', { text });
  await renderHUD({ lastNPC: text });
  if (speechCapabilities().tts) {
    return new Promise((resolve) => {
      speak(text, {
        voice: pickVoice({ lang: 'en', preferFemale: true }),
        onEnd: resolve,
      });
    });
  }
  // No TTS: brief pause so the dialogue still paces.
  await new Promise((r) => setTimeout(r, NPC_PAUSE_MS));
}

// ----- Player voice -----
// Returns an outcome describing how listening ended; never rejects.
function listenOnce(s, { signal } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => { if (!settled) { settled = true; resolve(outcome); } };

    const rec = createRecognizer({
      lang: 'en-US',
      onInterim: (t) => renderHUD({ interim: t }),
      onFinal: (t) => settle({ kind: 'final', text: t }),
      onError: (e) => { console.warn('STT', e); settle({ kind: 'error', error: e }); },
    });
    if (!rec) return settle({ kind: 'unavailable' });

    let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; rec.stop(); };

    const onAbort = () => { stop(); settle({ kind: 'aborted' }); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    renderHUD({
      listening: true,
      onStop: () => { stop(); settle({ kind: 'manual-stop' }); },
    });

    const startedAt = Date.now();
    const watchdog = setInterval(() => {
      if (stopped || settled || Date.now() - startedAt > LISTEN_TIMEOUT_MS) { clearInterval(watchdog); stop(); }
    }, 100);

    rec.start();
  });
}

async function capturePlayerUtterance(s, { signal }) {
  // Prefer STT; degrade to text input where SpeechRecognition is missing.
  const result = await listenOnce(s, { signal });
  await renderHUD({ listening: false, interim: null });

  if (result.kind === 'final' && result.text) return result.text;

  if (['unavailable', 'error', 'aborted', 'manual-stop'].includes(result.kind)) {
    const typed = await showTextInput({
      placeholder: 'Speech unavailable — type your reply',
      signal,
    });
    return typed || '';
  }
  return '';
}

async function runDebrief(s, { beatId }) {
  const debrief = await debriefScenario({
    beat: s.currentBeat, transcriptLog: s.transcriptLog, skillFocus: s.currentBeat.skillFocus,
  });
  await emit('scenario.debrief', { beatId, debrief });
  updateSkills(s.learnerModel, debrief.scores || {});
  await renderHUD({ debrief });
  clearHUDOverlays();
}

// Convenience export so tests can drive a single beat without a full engine.
export const __test__ = {
  get worldState() { return session?.worldState; },
  get learnerModel() { return session?.learnerModel; },
  get transcriptLog() { return session?.transcriptLog; },
  runNextBeat,
  presentChoice,
  capturePlayerUtterance,
  newSession() { session = createSession(); return session; },
  setSession(s) { session = s; },
  setEngine(engine) { if (session) session.engineRef = engine; },
  setCurrentBeat(beat) { if (session) session.currentBeat = beat; },
  reset() {
    session = createSession();
  },
};