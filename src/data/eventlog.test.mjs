// Unit tests for the eventlog backend mirror (src/data/eventlog.js).
// IndexedDB is faked in-memory; the backend is injected via
// _setBackendImplForTests() so the queue/backoff/beacon rules are exercised
// deterministically in Node.
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- fake IndexedDB (minimal surface eventlog.js touches) ----------
function fakeIndexedDB() {
  const rows = new Map();
  const store = {
    put: (ev) => rows.set(ev.id, ev),
    index: () => ({
      openCursor: () => {
        const req = {};
        queueMicrotask(() => {
          const iter = rows.values();
          const step = () => {
            const { value, done } = iter.next();
            if (done) return req.onsuccess({ target: { result: null } });
            return req.onsuccess({
              target: {
                result: {
                  value,
                  continue: step,
                },
              },
            });
          };
          step();
        });
        return req;
      },
    }),
  };
  return {
    open: () => {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const tx = { objectStore: () => store };
            queueMicrotask(() => tx.oncomplete?.());
            return tx;
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
    _rows: rows,
  };
}

// IDBKeyRange.lowerBound is only used for the (unused-here) since filter.
globalThis.IDBKeyRange = { lowerBound: (v) => v };
// initSession() stamps browser facts; provide minimal globals in Node.
// (Node ≥21 has a getter-only `navigator` — must use defineProperty.)
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node:test' }, configurable: true });
Object.defineProperty(globalThis, 'screen', { value: { width: 1280, height: 720 }, configurable: true });
Object.defineProperty(globalThis, 'devicePixelRatio', { value: 1, configurable: true });

const db = fakeIndexedDB();
globalThis.indexedDB = db;

const {
  emit,
  flushSyncQueue,
  queryEvents,
  initSession,
  _resetSyncForTests,
  _setBackendImplForTests,
  _syncState,
} = await import('./eventlog.js');

test.beforeEach(() => {
  _resetSyncForTests();
});

// ---------- IndexedDB remains the source of truth ---------------------------
test('emit: writes to IndexedDB even when the backend is absent', async () => {
  _setBackendImplForTests({ probeBackend: async () => null }); // backend down
  const ev = await emit('test.absent', { n: 1 });
  assert.ok(ev.id);
  const all = await queryEvents();
  assert.ok(all.some((e) => e.id === ev.id), 'event persisted locally');
  assert.equal(_syncState().queued, 1, 'event still queued for later mirror');
});

test('mirror: backend absent → flushSyncQueue keeps the queue, no crash', async () => {
  _setBackendImplForTests({ probeBackend: async () => null });
  await emit('test.keep', {});
  await flushSyncQueue();
  assert.equal(_syncState().queued, 1);
});

// ---------- happy-path mirror ----------------------------------------------
test('mirror: healthy backend drains the queue via POST batches', async () => {
  const posted = [];
  _setBackendImplForTests({
    probeBackend: async () => ({ ok: true, ai: false, maps: false }),
    appendEvents: async (batch) => {
      posted.push(...batch);
      return { accepted: batch.length, deduped: 0, total: posted.length };
    },
  });
  const e1 = await emit('test.a', {});
  const e2 = await emit('test.b', {});
  assert.equal(_syncState().queued, 2);
  await flushSyncQueue();
  assert.equal(_syncState().queued, 0);
  assert.deepEqual(posted.map((e) => e.id).sort(), [e1.id, e2.id].sort());
});

// ---------- retry / backoff -------------------------------------------------
test('mirror: failed POST requeues and escalates backoff up to the cap', async () => {
  _setBackendImplForTests({
    probeBackend: async () => ({ ok: true }),
    appendEvents: async () => {
      throw new Error('backend events 500');
    },
  });
  await emit('test.fail', {});
  await flushSyncQueue();
  assert.equal(_syncState().queued, 1, 'event requeued after failure');
  assert.equal(_syncState().retryMs, 10_000, 'backoff doubled from 5s floor');
  assert.equal(_syncState().timerArmed, true, 'retry scheduled');
  await flushSyncQueue(); // timer is fake-friendlier than waiting; invoke directly
  // second failure doubles again (but never above 60s cap)
  for (let i = 0; i < 10; i++) await flushSyncQueue();
  assert.ok(_syncState().retryMs <= 60_000, 'backoff capped at 60s');
});

test('mirror: success after failure resets backoff to the floor', async () => {
  let fail = true;
  _setBackendImplForTests({
    probeBackend: async () => ({ ok: true }),
    appendEvents: async () => {
      if (fail) throw new Error('boom');
      return { accepted: 1, deduped: 0, total: 1 };
    },
  });
  await emit('test.recover', {});
  await flushSyncQueue();
  assert.equal(_syncState().retryMs, 10_000);
  fail = false;
  await flushSyncQueue();
  assert.equal(_syncState().queued, 0);
  assert.equal(_syncState().retryMs, 5_000, 'backoff reset after success');
});

// ---------- sendBeacon on pagehide ------------------------------------------
test('mirror: pagehide hands the queue to sendBeacon and clears it on success', async () => {
  let beaconPayload = null;
  _setBackendImplForTests({
    probeBackend: async () => null, // even with the backend "down", beacon fires
    beaconEvents: (batch) => {
      beaconPayload = batch;
      return true;
    },
  });
  let pagehideHandler = null;
  const fakeWindow = {
    addEventListener: (ev, cb) => {
      if (ev === 'pagehide') pagehideHandler = cb;
    },
  };
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true });
  try {
    const ev = await emit('test.beacon', {});
    assert.ok(pagehideHandler, 'pagehide listener wired on first emit');
    pagehideHandler();
    assert.deepEqual(beaconPayload.map((e) => e.id), [ev.id]);
    assert.equal(_syncState().queued, 0, 'queue cleared after successful beacon');
  } finally {
    delete globalThis.window;
  }
});

test('mirror: pagehide keeps the queue when sendBeacon refuses the payload', async () => {
  _setBackendImplForTests({ beaconEvents: () => false });
  let pagehideHandler = null;
  const fakeWindow = {
    addEventListener: (ev, cb) => {
      if (ev === 'pagehide') pagehideHandler = cb;
    },
  };
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true });
  try {
    await emit('test.beacon-fail', {});
    pagehideHandler();
    assert.equal(_syncState().queued, 1, 'queue retained for next page load');
  } finally {
    delete globalThis.window;
  }
});

// ---------- session/query basics (unchanged behavior) ------------------------
test('initSession: stamps sessionId and records session.start', async () => {
  _setBackendImplForTests({ probeBackend: async () => null });
  const ev = await initSession({ selfAssessedLevel: 'B1' });
  assert.equal(ev.type, 'session.start');
  assert.match(ev.sessionId, /^s_/);
  const mine = await queryEvents({ session: ev.sessionId });
  assert.ok(mine.some((e) => e.id === ev.id));
});
