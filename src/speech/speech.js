// Speech I/O: push-to-talk STT (Web Speech API) + TTS with voice selection.
// Designed PC + mobile; exposes capability detection so the UI can degrade
// gracefully (e.g. text input fallback where SpeechRecognition is missing).

export function speechCapabilities() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  return {
    stt: Boolean(SR),
    tts: 'speechSynthesis' in window,
    interim: Boolean(SR),          // interim transcripts where supported
  };
}

// ---------------- STT ----------------
export function createRecognizer({ lang = 'en-US', onInterim, onFinal, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;          // push-to-talk: one utterance per press
  rec.maxAlternatives = 1;

  // Headless/CI Chromium exposes SpeechRecognition but the recognizer never
  // starts: start() returns and no event (not even onerror) ever fires, which
  // would wedge callers awaiting onFinal/onError. Detect the stuck start via
  // onstart and report it as an error so callers degrade to the text path.
  const started = new Promise((resolve) => {
    rec.onstart = () => resolve(true);
    setTimeout(() => resolve(false), 2_000);
  });

  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) onFinal?.(r[0].transcript.trim(), r[0].confidence);
      else onInterim?.(r[0].transcript);
    }
  };
  rec.onerror = (e) => onError?.(e.error);
  return {
    start: () => {
      try { rec.start(); } catch { /* already started */ }
      started.then((ok) => { if (!ok) onError?.('stuck'); });
    },
    stop: () => rec.stop(),
    abort: () => rec.abort(),
  };
}

// ---------------- TTS ----------------
let voicesCache = [];
function loadVoices() {
  voicesCache = speechSynthesis.getVoices();
  return voicesCache;
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = loadVoices;

// Prefer natural/neural English voices; stable ordering across platforms.
export function pickVoice({ lang = 'en', preferFemale = null } = {}) {
  const voices = voicesCache.length ? voicesCache : loadVoices();
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const score = (v) => {
    let s = 0;
    const n = v.name.toLowerCase();
    if (n.includes('natural') || n.includes('neural')) s += 4;
    if (n.includes('google')) s += 3;
    if (n.includes('samantha') || n.includes('aria') || n.includes('jenny')) s += 2;
    if (v.localService === false) s += 1;      // often higher quality server voices
    if (preferFemale === true && /female|samantha|aria|jenny|zira/.test(n)) s += 2;
    if (preferFemale === false && /male|daniel|guy|david/.test(n)) s += 1;
    return s;
  };
  return en.sort((a, b) => score(b) - score(a))[0] || voices[0] || null;
}

export function speak(text, { voice = null, rate = 1.0, pitch = 1.0, onEnd } = {}) {
  if (!('speechSynthesis' in window)) return onEnd?.();
  speechSynthesis.cancel();                    // barge-in: never queue over self
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = rate;                               // expose to UI: 0.85 for B1, 1.0+ for C1
  u.pitch = pitch;
  // In voice-less environments (headless Chromium, CI, servers) speak() fires
  // onerror('synthesis-failed') instead of onend; both complete the turn.
  // Callers racing speak() must also cover the stalled-engine case where
  // neither event fires (see playNPC's watchdog in game/loop.js).
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
  return u;
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
