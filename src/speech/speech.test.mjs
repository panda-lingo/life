// Speech boundary unit tests: fake SpeechRecognition/speechSynthesis shims
// exercise the degradation contracts the game loop depends on — most
// importantly that headless/CI environments (recognizer never starts,
// synthesis errors instead of ending) can never wedge the dialogue loop.
// These exact conditions are reproduced live by the desktop/mobile e2e specs.

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- browser shims (reset per test) --------------------------------
let recognitionImpl = null;   // constructor used by the next createRecognizer
const synthCalls = [];

function installWindow() {
  globalThis.window = globalThis;
  delete globalThis.SpeechRecognition;
  delete globalThis.webkitSpeechRecognition;
  if (recognitionImpl) globalThis.SpeechRecognition = recognitionImpl;
  globalThis.speechSynthesis = {
    cancel() { synthCalls.push('cancel'); },
    speak(u) { synthCalls.push(u); u.__speak?.(); },
    getVoices: () => [],
    onvoiceschanged: null,
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.rate = 1; this.pitch = 1; }
  };
}

async function loadSpeech() {
  // Fresh module state per test (voicesCache is module-level).
  return import(`./speech.js?case=${Math.random().toString(36).slice(2)}`);
}

// Fake recognizer: constructor arg controls whether onstart ever fires.
function makeRecognition({ starts = true } = {}) {
  return class FakeRecognition {
    constructor() { this.lang = ''; this.interimResults = false; }
    start() { if (starts) setTimeout(() => this.onstart?.(), 0); }
    stop() {}
    abort() {}
  };
}

test('createRecognizer: stuck recognizer (no onstart) reports a synthetic error', async (t) => {
  recognitionImpl = makeRecognition({ starts: false });
  installWindow();
  const { createRecognizer } = await loadSpeech();

  const errors = [];
  const rec = createRecognizer({ onError: (e) => errors.push(e) });
  assert.ok(rec, 'recognizer object exists (API is "supported")');

  rec.start();
  // Real timers: the stuck-start detector needs 2s of wall clock.
  await new Promise((r) => setTimeout(r, 2_200));
  assert.deepEqual(errors, ['stuck'], 'stuck start surfaces as onError("stuck")');
});

test('createRecognizer: healthy recognizer (onstart fires) reports no error', async (t) => {
  recognitionImpl = makeRecognition({ starts: true });
  installWindow();
  const { createRecognizer } = await loadSpeech();

  const errors = [];
  const rec = createRecognizer({ onError: (e) => errors.push(e) });
  rec.start();
  await new Promise((r) => setTimeout(r, 2_200));
  assert.deepEqual(errors, [], 'no synthetic error when recognition starts');
});

test('createRecognizer: returns null when SpeechRecognition is unsupported', async () => {
  recognitionImpl = null;
  installWindow();
  const { createRecognizer, speechCapabilities } = await loadSpeech();
  assert.equal(createRecognizer({}), null);
  assert.equal(speechCapabilities().stt, false);
});

test('speak: onerror (synthesis-failed, headless CI) completes via onEnd', async () => {
  installWindow();
  const { speak } = await loadSpeech();

  const done = new Promise((resolve) => {
    speak('hello there', {
      onEnd: resolve,
    });
  });
  const utterance = synthCalls.at(-1);
  assert.equal(utterance.text, 'hello there');
  // Simulate the headless-Chromium failure: error instead of end.
  utterance.onerror({ error: 'synthesis-failed' });
  await done; // resolves — the loop is not wedged
});

test('speak: normal completion still completes via onEnd exactly once per event', async () => {
  installWindow();
  const { speak } = await loadSpeech();

  let ends = 0;
  const done = new Promise((resolve) => speak('a line', { onEnd: () => { ends += 1; resolve(); } }));
  synthCalls.at(-1).onend();
  await done;
  assert.equal(ends, 1);
});

test('speak: without speechSynthesis it completes synchronously', async () => {
  globalThis.window = globalThis;
  delete globalThis.speechSynthesis;
  const { speak } = await loadSpeech();
  let called = false;
  speak('no tts here', { onEnd: () => { called = true; } });
  assert.equal(called, true);
});
