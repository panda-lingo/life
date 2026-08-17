// HUD: minimal DOM overlay for status, dialogue, choices, push-to-talk.
// Renders into the body; the engine owns the canvas. Every UI action emits
// an event before it reaches the game state.

import { cefrEstimate } from '../data/learnerModel.js';

let container = null;
let state = {};

// ---- pub/sub: choice + text-input bridges ----
// Multiple awaiters may subscribe simultaneously; the loop awaits a fresh
// Promise per choice / per listening session.
const choiceWaiters = new Set();
const textWaiters = new Set();
const placeWaiters = new Set();

function ensureContainer() {
  if (container) return;
  container = document.createElement('div');
  container.id = 'hud';
  Object.assign(container.style, {
    position: 'fixed', left: '12px', right: '12px', bottom: '12px', maxWidth: '720px',
    margin: '0 auto', padding: '12px', background: 'rgba(20,20,28,0.85)', color: '#fff',
    borderRadius: '12px', fontFamily: 'system-ui, sans-serif', fontSize: '14px', zIndex: '10',
    display: 'flex', flexDirection: 'column', gap: '8px',
  });
  document.body.appendChild(container);
}

function renderStatus() {
  const div = document.createElement('div');
  div.style.opacity = '0.8';
  div.textContent = `CEFR ${cefrEstimate({ cefrIndex: state.learnerCefrIndex ?? 1 })} · ${state.worldState?.stats?.trust ?? 0} trust`;
  return div;
}

function renderDialogue() {
  const div = document.createElement('div');
  div.textContent = state.lastNPC || (state.listening ? 'Listening... press stop when done.' : 'Press Start to speak.');
  return div;
}

function renderChoice() {
  const wrap = document.createElement('div');
  // Stable id so integration/e2e tests can target choice buttons without
  // matching on localized button text.
  wrap.id = 'hud-choice';
  state.choice.forEach((opt) => {
    const b = document.createElement('button');
    b.textContent = opt.text;
    b.dataset.choice = opt.text;
    b.style.cssText = 'margin:4px;padding:8px 12px;border-radius:8px;border:0;background:#6c8cff;color:#fff;';
    b.onclick = () => {
      if (!choiceWaiters.size) return;
      const pending = [...choiceWaiters];
      choiceWaiters.clear();
      pending.forEach((resolve) => resolve(opt));
    };
    wrap.appendChild(b);
  });
  return wrap;
}

function renderTextInput() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; gap:8px;';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = state.textInputPlaceholder || 'Type your reply...';
  input.style.cssText = 'flex:1; padding:8px; border-radius:8px; border:0;';
  const submit = document.createElement('button');
  submit.textContent = 'Send';
  submit.style.cssText = 'padding:8px 12px; border-radius:8px; border:0; background:#6c8cff; color:#fff;';
  const fire = () => {
    const v = input.value.trim();
    if (!v || !textWaiters.size) return;
    const pending = [...textWaiters];
    textWaiters.clear();
    pending.forEach((resolve) => resolve(v));
    input.value = '';
  };
  submit.onclick = fire;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fire(); });
  wrap.appendChild(input);
  wrap.appendChild(submit);
  setTimeout(() => input.focus(), 0);
  return wrap;
}

function renderActions() {
  const wrap = document.createElement('div');
  wrap.id = 'hud-actions';
  wrap.style.cssText = 'display:flex; flex-direction:column; gap:8px; max-height:40vh; overflow-y:auto;';
  state.actions.forEach((action) => {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.dataset.action = action.id || action.label;
    b.style.cssText =
      'padding:12px 14px; min-height:44px; border-radius:8px; border:0;' +
      'background:#3d4254; color:#fff; text-align:left; font-size:14px; cursor:pointer;';
    b.onclick = () => {
      if (state.textInput) return;         // modal dialogue input owns the tap
      action.onChoose?.();
    };
    wrap.appendChild(b);
  });
  return wrap;
}

function renderPlacePicker() {
  const wrap = document.createElement('div');
  wrap.id = 'hud-place-picker';
  wrap.style.cssText = 'display:flex; flex-direction:column; gap:8px; max-height:40vh; overflow-y:auto;';
  state.places.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'place';
    b.dataset.placeId = p.placeId;
    b.textContent = `📍 ${p.name} — ${p.vicinity}${p.rating ? ` (${p.rating}★)` : ''}`;
    b.style.cssText =
      'padding:12px 14px; min-height:44px; border-radius:8px; border:0;' +
      'background:#3d4254; color:#fff; text-align:left; font-size:14px; cursor:pointer;';
    b.onclick = () => {
      if (state.textInput) return;
      if (!placeWaiters.size) return;
      const pending = [...placeWaiters];
      placeWaiters.clear();
      pending.forEach((resolve) => resolve(p));
    };
    wrap.appendChild(b);
  });
  return wrap;
}

function renderDebrief() {
  const div = document.createElement('div');
  div.textContent = `Debrief: ${JSON.stringify(state.debrief)}`;
  return div;
}

export async function renderHUD(update) {
  state = { ...state, ...update };
  ensureContainer();
  container.innerHTML = '';
  container.appendChild(renderStatus());
  container.appendChild(renderDialogue());
  if (state.choice) container.appendChild(renderChoice());
  if (state.textInput) container.appendChild(renderTextInput());
  if (state.actions) container.appendChild(renderActions());
  if (state.places) container.appendChild(renderPlacePicker());
  if (state.debrief) container.appendChild(renderDebrief());
  return state;
}

// Promise-returning pub/sub bridge: the loop awaits a click on a choice
// button. Rejects cleanly when the caller aborts via AbortSignal. The HUD
// only upgrades to a visible choice list for 2+ options — a single-option
// step (or none) auto-resolves so no dead-end screen can appear.
export function showChoice(options, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  if (!options?.length) return Promise.resolve(null);
  if (options.length === 1) return Promise.resolve(options[0]);
  renderHUD({ choice: options });
  return new Promise((resolve, reject) => {
    const entry = (v) => { choiceWaiters.delete(entry); resolve(v); };
    choiceWaiters.add(entry);
    if (signal) {
      const onAbort = () => {
        choiceWaiters.delete(entry);
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// Promise-returning text-input bridge: the loop awaits a typed reply when
// SpeechRecognition is unavailable.
export function showTextInput({ placeholder, signal } = {}) {
  renderHUD({ textInput: true, textInputPlaceholder: placeholder });
  return new Promise((resolve, reject) => {
    const entry = (v) => { textWaiters.delete(entry); resolve(v); };
    textWaiters.add(entry);
    if (signal) {
      const onAbort = () => {
        textWaiters.delete(entry);
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function showPlacePicker(places, { signal } = {}) {
  renderHUD({ places, lastNPC: 'Pick a place to explore' });
  return new Promise((resolve) => {
    const entry = (v) => { placeWaiters.delete(entry); resolve(v); };
    placeWaiters.add(entry);
    if (signal) {
      const onAbort = () => { placeWaiters.delete(entry); resolve(null); };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// Promise-returning bridge for the explore-mode place picker: the loop
// awaits a tap on one of the listed real-world places.

export function clearHUDOverlays() {
  renderHUD({ choice: null, textInput: false, lastNPC: null, listening: false, actions: null, places: null });
}

// Test hook: reset internal HUD state between e2e scenarios.
export function __resetHUDForTests() {
  if (container) { container.remove(); container = null; }
  state = {};
  choiceWaiters.clear();
  textWaiters.clear();
  placeWaiters.clear();
}