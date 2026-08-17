// Unit tests for the frontend backend client (src/net/backend.js).
// Runs in Node: fetchImpl is injected everywhere (no real network), so this
// exercises request shaping, masked logging, and fallback semantics only.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  maskAuthHeaders,
  maskKeyInUrl,
  probeBackend,
  backendAvailable,
  backendComplete,
  backendMapsConfig,
  appendEvents,
  beaconEvents,
  _resetBackendProbe,
} from './backend.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ---------- masking helpers (the project HTTP-logging constraint) ----------
test('maskAuthHeaders: masks auth-ish headers, leaves the rest', () => {
  const masked = maskAuthHeaders({
    authorization: 'Bearer sk-abcdef1234567890',
    'x-api-key': 'AIzaSecretKey123456',
    'content-type': 'application/json',
  });
  assert.ok(!masked.authorization.includes('sk-abcdef1234567890'));
  assert.ok(!masked['x-api-key'].includes('AIzaSecretKey123456'));
  assert.equal(masked['content-type'], 'application/json');
});

test('maskKeyInUrl: redacts key/api_key/access_token query params', () => {
  assert.equal(
    maskKeyInUrl('https://maps.googleapis.com/x?key=SECRET&v=weekly'),
    'https://maps.googleapis.com/x?key=***MASKED***&v=weekly',
  );
  assert.equal(
    maskKeyInUrl('https://x/api?access_token=tok123&other=1'),
    'https://x/api?access_token=***MASKED***&other=1',
  );
});

// ---------- health probe ---------------------------------------------------
test('probeBackend: returns {ok,ai,maps} on healthy and is memoized', async () => {
  _resetBackendProbe();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { ok: true, ai: true, maps: false });
  };
  const health = await probeBackend({ fetchImpl });
  assert.deepEqual(health, { ok: true, ai: true, maps: false });
  await probeBackend({ fetchImpl });
  assert.equal(calls, 1, 'second probe reuses the memoized promise');
  _resetBackendProbe();
});

test('probeBackend: null (degrade to mocks) on 404 and on network failure', async () => {
  _resetBackendProbe();
  const staticHost = await probeBackend({ fetchImpl: async () => jsonResponse(404, null) });
  assert.equal(staticHost, null);

  _resetBackendProbe();
  const down = await probeBackend({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(down, null);
  _resetBackendProbe();
});

test('backendAvailable: boolean convenience over the probe', async () => {
  _resetBackendProbe();
  assert.equal(await backendAvailable({ fetchImpl: async () => jsonResponse(200, { ok: true }) }), true);
  _resetBackendProbe();
  assert.equal(await backendAvailable({ fetchImpl: async () => jsonResponse(500, {}) }), false);
  _resetBackendProbe();
});

// ---------- AI completion ---------------------------------------------------
test('backendComplete: POSTs prompt and returns upstream text', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse(200, { text: '{"choice":"sunny"}' });
  };
  const text = await backendComplete({ prompt: 'hello', image: null }, { fetchImpl });
  assert.equal(text, '{"choice":"sunny"}');
  assert.ok(seen.url.endsWith('/api/ai/complete'));
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { prompt: 'hello', image: null });
});

test('backendComplete: throws with err.status on non-ok (503 → director fallback)', async () => {
  const fetchImpl = async () => jsonResponse(503, { error: 'ai not configured' });
  await assert.rejects(
    () => backendComplete({ prompt: 'hi' }, { fetchImpl }),
    (err) => {
      assert.equal(err.status, 503);
      assert.match(err.message, /not configured/);
      return true;
    },
  );
});

// ---------- maps config -----------------------------------------------------
test('backendMapsConfig: returns {apiKey,mapId} when configured, null otherwise', async () => {
  const withKey = await backendMapsConfig({
    fetchImpl: async () => jsonResponse(200, { apiKey: 'AIza', mapId: 'm1' }),
  });
  assert.deepEqual(withKey, { apiKey: 'AIza', mapId: 'm1' });

  const staticHost = await backendMapsConfig({ fetchImpl: async () => jsonResponse(404, null) });
  assert.equal(staticHost, null);

  const down = await backendMapsConfig({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(down, null);
});

// ---------- event mirroring -------------------------------------------------
test('appendEvents: POSTs the batch and returns {accepted,deduped,total}', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse(200, { accepted: 2, deduped: 1, total: 3 });
  };
  const events = [{ id: 'a' }, { id: 'b' }, { id: 'a' }];
  const out = await appendEvents(events, { fetchImpl });
  assert.deepEqual(out, { accepted: 2, deduped: 1, total: 3 });
  assert.ok(seen.url.endsWith('/api/events'));
  assert.deepEqual(JSON.parse(seen.init.body), { events });
});

test('appendEvents: empty array short-circuits without a network call', async () => {
  let called = false;
  const out = await appendEvents([], {
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, {});
    },
  });
  assert.deepEqual(out, { accepted: 0, deduped: 0, total: 0 });
  assert.equal(called, false);
});

test('appendEvents: throws with err.status on failure (queue retries later)', async () => {
  await assert.rejects(
    () => appendEvents([{ id: 'x' }], { fetchImpl: async () => jsonResponse(413, { error: 'too big' }) }),
    (err) => err.status === 413,
  );
});

test('beaconEvents: false without sendBeacon; never throws on empty input', () => {
  // Node has no navigator.sendBeacon → graceful false.
  assert.equal(beaconEvents([{ id: 'x' }]), false);
  assert.equal(beaconEvents([]), false);
  assert.equal(beaconEvents(null), false);
});
