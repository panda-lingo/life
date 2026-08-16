// LifeSpeak data layer — append-only, versioned event log on IndexedDB.
// xAPI-flavored statements; everything analyzable offline via JSONL export.

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
  return event;
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
