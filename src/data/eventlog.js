// LifeSpeak data layer — append-only, versioned event log.
// IndexedDB is the write-through source of truth; when the backend server is
// reachable, every event is ALSO mirrored via POST /api/events (async, queued
// with backoff, sendBeacon flush on pagehide). Backend absence changes
// nothing for gameplay — storage silently stays IndexedDB-only.

import { appendEvents, beaconEvents, probeBackend } from '../net/backend.js';

// DI seams for Node unit tests: the mirror loop calls these indirections so
// tests can inject a fake backend without touching the network module's
// memoized probe. Production leaves them null → the real imports run.
let _impl = { probeBackend: null, appendEvents: null, beaconEvents: null };
const _probe = () => (_impl.probeBackend || probeBackend)();
const _append = (batch) => (_impl.appendEvents || appendEvents)(batch);
const _beacon = (batch) => (_impl.beaconEvents || beaconEvents)(batch);

// Test hook: inject fakes (pass {} to restore real implementations).
export function _setBackendImplForTests(impls = {}) {
  _impl = { probeBackend: null, appendEvents: null, beaconEvents: null, ...impls };
}

export const SCHEMA_VERSION = 1;
const DB_NAME = 'lifespeak';
const STORE = 'events';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, SCHEMA_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('ts', 'ts');
        store.createIndex('session', 'sessionId');
        store.createIndex('type', 'type');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

let sessionId = null;
let seq = 0;

export function initSession(profile = {}) {
  sessionId = `s_${crypto.randomUUID()}`;
  seq = 0;
  return emit('session.start', {
    profile,                       // { selfAssessedLevel, targetLevel, skillsFocus[] }
    ua: navigator.userAgent,
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
  });
}

export async function emit(type, payload = {}) {
  const event = {
    id: crypto.randomUUID(),
    v: SCHEMA_VERSION,
    ts: Date.now(),
    sessionId,
    seq: seq++,
    type,                          // namespaced: 'utterance.scored', 'choice.made', ...
    ...payload,
  };
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(event);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  mirrorToBackend(event); // async, best-effort — never awaited by gameplay
  return event;
}

// ---------- backend mirror -------------------------------------------------
// Source of truth stays IndexedDB; the mirror is fire-and-forget with an
// in-memory retry queue. Declarative rules:
//   backend healthy  → POST batches as they accumulate (flush at 10 events)
//   POST fails       → requeue, retry with backoff 5s → 60s cap
//   pagehide         → sendBeacon final flush (survives teardown)
//   backend absent   → queue persists in memory only; nothing else changes
const FLUSH_AT = 10;
const RETRY_FLOOR_MS = 5_000;
const RETRY_CAP_MS = 60_000;
let _queue = [];
let _retryMs = RETRY_FLOOR_MS;
let _timer = null;
let _flushing = null;
let _beaconWired = false;

function mirrorToBackend(event) {
  _queue.push(event);
  if (_queue.length >= FLUSH_AT) scheduleFlush(0);
  else scheduleFlush(1_000);
  wireBeacon();
}

function wireBeacon() {
  if (_beaconWired || typeof window === 'undefined' || !window.addEventListener) return;
  _beaconWired = true;
  window.addEventListener('pagehide', () => {
    if (_queue.length === 0) return;
    if (_beacon(_queue)) _queue = [];
  });
}

function scheduleFlush(delayMs) {
  if (_timer || _flushing) return;
  _timer = setTimeout(() => {
    _timer = null;
    flushSyncQueue();
  }, delayMs);
}

// Exported for tests and for loop.js's teardown path.
export async function flushSyncQueue() {
  if (_flushing || _queue.length === 0) return _flushing || Promise.resolve();
  _flushing = (async () => {
    const health = await _probe();
    if (!health) return; // backend absent — keep queued, retry next emit
    const batch = _queue.slice(0, 100);
    try {
      await _append(batch);
      _queue = _queue.slice(batch.length);
      _retryMs = RETRY_FLOOR_MS;
      if (_queue.length > 0) scheduleFlush(0);
    } catch {
      _retryMs = Math.min(RETRY_CAP_MS, _retryMs * 2);
      scheduleFlush(_retryMs);
    }
  })().finally(() => {
    _flushing = null;
  });
  return _flushing;
}

// Test hook: fully reset mirror state.
export function _resetSyncForTests() {
  _queue = [];
  _retryMs = RETRY_FLOOR_MS;
  if (_timer) clearTimeout(_timer);
  _timer = null;
  _flushing = null;
  _beaconWired = false;
  _impl = { probeBackend: null, appendEvents: null, beaconEvents: null };
}

// Test hook: inspect mirror state without touching internals.
export function _syncState() {
  return { queued: _queue.length, retryMs: _retryMs, timerArmed: !!_timer, flushing: !!_flushing };
}

export async function queryEvents({ session = null, type = null, since = 0 } = {}) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const out = [];
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('ts');
    const range = IDBKeyRange.lowerBound(since);
    idx.openCursor(range).onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return res(out);
      const ev = cur.value;
      if ((!session || ev.sessionId === session) && (!type || ev.type.startsWith(type))) out.push(ev);
      cur.continue();
    };
    tx.onerror = () => rej(tx.error);
  });
}

// Full log as JSONL — the canonical offline-analysis artifact.
export async function exportJSONL() {
  const events = await queryEvents();
  return events.map((e) => JSON.stringify(e)).join('\n');
}

export async function downloadExport() {
  const jsonl = await exportJSONL();
  const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lifespeak-export-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  URL.revokeObjectURL(a.href);
}
