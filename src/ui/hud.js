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
  state.choice.forEach((opt) => {
    const b = document.createElement('button');
    b.textContent = opt.text;
    b.style.cssText = 'margin:4px;padding:8px 12px;border-radius:8px;border:0;background:#6c8cff;color:#fff;';
    b.onclick = () => {
      // Resolve every waiter exactly once. First-pick-wins semantics keep
      // the rest of the choice buttons inert after a click.
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
  if (state.debrief) container.appendChild(renderDebrief());
  return state;
}

// Promise-returning pub/sub bridge: the loop awaits a click on a choice
// button. Rejects cleanly when the caller aborts via AbortSignal.
export function showChoice(options, { signal } = {}) {
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

export function clearHUDOverlays() {
  renderHUD({ choice: null, textInput: false, lastNPC: null, listening: false });
}