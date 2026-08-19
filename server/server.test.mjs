// Unit tests for the backend server. Everything is dependency-injected:
//   - fetchImpl fakes the upstream AI gateway
//   - fsImpl fakes the DATA_DIR filesystem
//   - real sockets only in the integration test at the bottom (ephemeral port)
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { serverConfig } from './config.js';
import { createEventStore } from './eventStore.js';
import { createServer } from './server.js';
import { toCurl, maskAuthHeaders, maskBody, maskKeyInUrl } from './httpLog.js';

// ---------- helpers --------------------------------------------------------
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    bodyText: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(text = '') {
      this.bodyText += text;
    },
    get body() {
      try {
        return JSON.parse(this.bodyText);
      } catch {
        return this.bodyText;
      }
    },
  };
}

function jsonReq(method, body) {
  // Minimal IncomingMessage stand-in: an EventTarget-ish object with
  // data/end events driven synchronously.
  const listeners = {};
  return {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-secret-1234' },
    on(ev, cb) {
      listeners[ev] = cb;
      if (ev === 'data' && body !== undefined) {
        queueMicrotask(() => {
          listeners.data?.(Buffer.from(JSON.stringify(body)));
          listeners.end?.();
        });
      } else if (ev === 'end' && body === undefined) {
        queueMicrotask(() => listeners.end?.());
      }
    },
    destroy() {},
  };
}

function makeConfig(overrides = {}) {
  const env = {
    PORT: '0',
    DATA_DIR: '/tmp/x',
    ...overrides,
  };
  return serverConfig(env);
}

// ---------- config ---------------------------------------------------------
test('config: ai unconfigured when creds missing', () => {
  const c = makeConfig({});
  assert.equal(c.ai.configured, false);
  assert.equal(c.maps.apiKey, '');
});

test('config: ai configured with full IMAGE_TEXT_* set', () => {
  const c = makeConfig({
    IMAGE_TEXT_API_FORMAT: 'openai',
    IMAGE_TEXT_BASE_URL: 'https://gw.example/v1/',
    IMAGE_TEXT_MODEL: 'm1',
    IMAGE_TEXT_API_KEY: 'sk-x',
  });
  assert.equal(c.ai.configured, true);
  assert.equal(c.ai.baseURL, 'https://gw.example/v1'); // trailing slash stripped
  assert.equal(c.maps.apiKey, '');
});

test('config: maps key + mapId read from env', () => {
  const c = makeConfig({ GOOGLE_MAPS_API_KEY: 'AIza', GOOGLE_MAPS_MAP_ID: 'mid' });
  assert.equal(c.maps.apiKey, 'AIza');
  assert.equal(c.maps.mapId, 'mid');
});

// ---------- httpLog masking ------------------------------------------------
test('httpLog: toCurl masks auth headers', () => {
  const curl = toCurl({
    url: 'https://x/v1/chat/completions',
    method: 'POST',
    headers: { authorization: 'Bearer sk-abcdef1234567890', 'content-type': 'application/json' },
    body: { model: 'm' },
  });
  assert.ok(!curl.includes('sk-abcdef1234567890'), 'raw key must not appear');
  assert.ok(curl.includes('Bearer…7890'));
  assert.ok(curl.includes("curl -X POST 'https://x/v1/chat/completions'"));
});

test('httpLog: maskAuthHeaders masks api-key variants', () => {
  const m = maskAuthHeaders({ 'x-api-key': 'abcdefghijklmnopqrstuvwxyz', accept: 'x' });
  assert.equal(m['x-api-key'], 'abcdef…wxyz');
  assert.equal(m.accept, 'x');
});

test('httpLog: maskBody redacts apiKey/token fields deeply', () => {
  const m = maskBody({ apiKey: 'sk-supersecretvalue', nested: { token: 'tok-123456789012' }, keep: 'yes' });
  assert.equal(m.apiKey, 'sk-sup…alue');
  assert.equal(m.nested.token, 'tok-12…9012');
  assert.equal(m.keep, 'yes');
});

test('httpLog: maskKeyInUrl redacts key query param', () => {
  assert.equal(
    maskKeyInUrl('https://maps.googleapis.com/maps/api/js?key=AIzaSECRET&v=weekly'),
    'https://maps.googleapis.com/maps/api/js?key=***MASKED***&v=weekly',
  );
});

// ---------- eventStore -----------------------------------------------------
function memFs() {
  const files = new Map();
  return {
    files,
    mkdirSync() {},
    appendFileSync(p, text) {
      files.set(p, (files.get(p) || '') + text);
    },
    readdirSync() {
      return [...files.keys()].map((p) => p.split('/').pop());
    },
    readFileSync(p) {
      const v = files.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
  };
}

test('eventStore: appends and lists events, deduped by id', () => {
  const f = memFs();
  const store = createEventStore({ dataDir: '/data', fsImpl: f });
  const ev = (id, session = 's1') => ({ id, v: 1, ts: 1730000000000, sessionId: session, seq: 0, type: 'x' });
  assert.deepEqual(store.append([ev('a'), ev('b'), ev('a')]), { stored: 2, deduped: 1 });
  const all = store.list({});
  assert.equal(all.length, 2);
  assert.deepEqual(store.list({ session: 's1' }).map((e) => e.id), ['a', 'b']);
  assert.deepEqual(store.list({ session: 'nope' }), []);
});

test('eventStore: skips malformed events; missing dir lists empty', () => {
  const f = memFs();
  const store = createEventStore({ dataDir: '/data', fsImpl: f });
  assert.deepEqual(store.append([{ noId: true }, null, { id: 'ok', ts: 1 }]), { stored: 1, deduped: 0 });
  const empty = createEventStore({ dataDir: '/nope', fsImpl: memFs() });
  // readdirSync on missing dir throws in the fake — list() catches it
  assert.deepEqual(empty.list({}), []);
});

// ---------- api routes (via createServer + injected fetch) -----------------
import { handleApi } from './api.js';

function apiCall({ path, method = 'GET', body, config, events, fetchImpl }) {
  const req = jsonReq(method, body);
  const res = fakeRes();
  const url = new URL(`http://localhost${path}`);
  return handleApi({ req, res, url, config, events, fetchImpl }).then(() => res);
}

test('api: healthz reports feature configuration', async () => {
  const config = makeConfig({});
  const events = { append: () => {}, list: () => [] };
  const res = await apiCall({ path: '/api/healthz', config, events });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, ai: false, maps: false, mcp: false });
});

test('api: healthz reports mcp=true when TAVILY_API_KEY set', async () => {
  const config = makeConfig({ TAVILY_API_KEY: 'tvly-test' });
  const events = { append: () => {}, list: () => [] };
  const res = await apiCall({ path: '/api/healthz', config, events });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mcp, true);
});

test('api: maps/config 404 without key, 200 with key', async () => {
  const events = { append: () => {}, list: () => [] };
  let res = await apiCall({ path: '/api/maps/config', config: makeConfig({}), events });
  assert.equal(res.statusCode, 404);

  res = await apiCall({
    path: '/api/maps/config',
    config: makeConfig({ GOOGLE_MAPS_API_KEY: 'AIzaKEY', GOOGLE_MAPS_MAP_ID: 'm1' }),
    events,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { apiKey: 'AIzaKEY', mapId: 'm1' });
});

test('api: ai/complete 503 when unconfigured — frontend falls back to mock', async () => {
  const res = await apiCall({
    path: '/api/ai/complete',
    method: 'POST',
    body: { prompt: 'hi' },
    config: makeConfig({}),
    events: { append: () => {}, list: () => [] },
  });
  assert.equal(res.statusCode, 503);
});

test('api: ai/complete proxies to upstream with server-side creds', async () => {
  const config = makeConfig({
    IMAGE_TEXT_API_FORMAT: 'openai',
    IMAGE_TEXT_BASE_URL: 'https://gw.example/v1',
    IMAGE_TEXT_MODEL: 'm1',
    IMAGE_TEXT_API_KEY: 'sk-secret',
  });
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"choice":"sunny"}' } }] }),
    };
  };
  const res = await apiCall({
    path: '/api/ai/complete',
    method: 'POST',
    body: { prompt: 'SYSTEM PART\n\nCONTEXT (JSON):\n{}', image: null },
    config,
    events: { append: () => {}, list: () => [] },
    fetchImpl,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.text, '{"choice":"sunny"}');
  assert.equal(seen.url, 'https://gw.example/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer sk-secret');
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.model, 'm1');
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.messages[0].content, 'SYSTEM PART');
  assert.equal(sent.messages[1].role, 'user');
});

test('api: ai/complete surfaces upstream failure status', async () => {
  const config = makeConfig({
    IMAGE_TEXT_API_FORMAT: 'openai',
    IMAGE_TEXT_BASE_URL: 'https://gw.example/v1',
    IMAGE_TEXT_MODEL: 'm1',
    IMAGE_TEXT_API_KEY: 'sk-secret',
  });
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({ error: { message: 'gateway exploded' } }),
  });
  const res = await apiCall({
    path: '/api/ai/complete',
    method: 'POST',
    body: { prompt: 'p' },
    config,
    events: { append: () => {}, list: () => [] },
    fetchImpl,
  });
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /gateway exploded/);
});

test('api: ai/complete 502 when upstream unreachable', async () => {
  const config = makeConfig({
    IMAGE_TEXT_API_FORMAT: 'openai',
    IMAGE_TEXT_BASE_URL: 'https://gw.example/v1',
    IMAGE_TEXT_MODEL: 'm1',
    IMAGE_TEXT_API_KEY: 'sk-secret',
  });
  const res = await apiCall({
    path: '/api/ai/complete',
    method: 'POST',
    body: { prompt: 'p' },
    config,
    events: { append: () => {}, list: () => [] },
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(res.statusCode, 502);
});

test('api: events POST stores, dedupes; GET lists per session', async () => {
  const store = createEventStore({ dataDir: '/data', fsImpl: memFs() });
  const config = makeConfig({});
  const ev = { id: 'e1', v: 1, ts: 1730000000000, sessionId: 's1', seq: 0, type: 't' };
  const post = await apiCall({
    path: '/api/events',
    method: 'POST',
    body: { events: [ev, ev] },
    config,
    events: store,
  });
  assert.equal(post.statusCode, 200);
  assert.deepEqual(post.body, { accepted: 1, deduped: 1, total: 2 });

  const get = await apiCall({ path: '/api/events?session=s1', config, events: store });
  assert.equal(get.statusCode, 200);
  assert.equal(get.body.events.length, 1);
  assert.equal(get.body.events[0].id, 'e1');
});

test('api: events POST rejects non-array body with 400', async () => {
  const res = await apiCall({
    path: '/api/events',
    method: 'POST',
    body: { nope: true },
    config: makeConfig({}),
    events: { append: () => ({ stored: 0, deduped: 0 }), list: () => [] },
  });
  assert.equal(res.statusCode, 400);
});

test('api: unknown route 404s', async () => {
  const res = await apiCall({
    path: '/api/nope',
    config: makeConfig({}),
    events: { append: () => {}, list: () => [] },
  });
  assert.equal(res.statusCode, 404);
});

// ---------- MCP integration (via api.js dispatch) --------------------------
// Asserts /api/ai/complete and /api/mcp wire together end-to-end through
// handleApi without booting a real server.

test('api: mcp/tools manifest returns empty enabled list when no keys', async () => {
  const res = await apiCall({
    path: '/api/mcp/tools',
    config: makeConfig({}),
    events: { append: () => {}, list: () => [] },
  });
  assert.equal(res.statusCode, 200);
  const byId = Object.fromEntries(res.body.tools.map((t) => [t.id, t]));
  assert.equal(byId['fx.rate'].enabled, true);
  assert.equal(byId['web.search'].enabled, false);
});

test('api: mcp/tools manifest enables web.* when TAVILY_API_KEY present', async () => {
  const res = await apiCall({
    path: '/api/mcp/tools',
    config: makeConfig({ TAVILY_API_KEY: 'tvly-test' }),
    events: { append: () => {}, list: () => [] },
  });
  assert.equal(res.statusCode, 200);
  const byId = Object.fromEntries(res.body.tools.map((t) => [t.id, t]));
  assert.equal(byId['web.search'].enabled, true);
  assert.equal(byId['web.fetch'].enabled, true);
});

test('api: mcp invoke fx.rate via POST /api/mcp works without keys', async () => {
  // fx.rate uses keyless er-api.com. With a fake fetch returning the upstream
  // shape, the router should return { ok: true, value: { rate: ... } }.
  const fetchImpl = async (url) => {
    assert.match(url, /open\.er-api\.com/);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        result: 'success',
        base_code: 'USD',
        rates: { EUR: 0.92 },
        time_last_update_utc: 'Wed, 19 Aug 2026 00:00:01 GMT',
      }),
    };
  };
  const res = await apiCall({
    path: '/api/mcp',
    method: 'POST',
    body: { id: 'r1', method: 'tools.invoke', params: { tool: 'fx.rate', args: { base: 'USD', target: 'EUR' } } },
    config: makeConfig({}),
    events: { append: () => {}, list: () => [] },
    fetchImpl,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.ok, true);
  assert.equal(res.body.result.value.rate, 0.92);
});

test('api: ai/complete with tools=true forwards tool specs to upstream', async () => {
  const config = makeConfig({
    IMAGE_TEXT_API_FORMAT: 'openai',
    IMAGE_TEXT_BASE_URL: 'https://gw.example/v1',
    IMAGE_TEXT_MODEL: 'm1',
    IMAGE_TEXT_API_KEY: 'sk-secret',
    TAVILY_API_KEY: 'tvly-test',
  });
  let firstBody = null;
  const fetchImpl = async (url, init) => {
    if (!firstBody) {
      firstBody = JSON.parse(init.body);
    }
    // First call: model asks for fx.rate tool.
    // Second call: model returns final content.
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(init.body);
      const hasToolMsg = body.messages.some((m) => m.role === 'tool');
      if (!hasToolMsg) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'fx_rate',
                    arguments: JSON.stringify({ base: 'USD', target: 'EUR' }),
                  },
                }],
              },
            }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '{"final":"with tool data"}' } }],
        }),
      };
    }
    if (url.includes('open.er-api.com')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: 'success', rates: { EUR: 0.92 } }),
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  const res = await apiCall({
    path: '/api/ai/complete',
    method: 'POST',
    body: { prompt: 'Tell me about EUR', tools: true },
    config,
    events: { append: () => {}, list: () => [] },
    fetchImpl,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.text, '{"final":"with tool data"}');
  // The first chat-completions call must include `tools`.
  assert.ok(Array.isArray(firstBody.tools), 'tools field present');
  assert.ok(firstBody.tools.length > 0, 'at least one tool spec attached');
  // response_format should be omitted when tools are present (OpenAI constraint).
  assert.equal(firstBody.response_format, undefined);
});

test('api: ai/complete without tools flag sends no tools (backward compat)', async () => {
  const config = makeConfig({
    IMAGE_TEXT_API_FORMAT: 'openai',
    IMAGE_TEXT_BASE_URL: 'https://gw.example/v1',
    IMAGE_TEXT_MODEL: 'm1',
    IMAGE_TEXT_API_KEY: 'sk-secret',
    TAVILY_API_KEY: 'tvly-test',
  });
  let sentBody = null;
  const fetchImpl = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '{"plain":"no tools"}' } }],
      }),
    };
  };
  const res = await apiCall({
    path: '/api/ai/complete',
    method: 'POST',
    body: { prompt: 'hi' },
    config,
    events: { append: () => {}, list: () => [] },
    fetchImpl,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(sentBody.tools, undefined, 'tools field must be absent when body.tools=false');
  assert.deepEqual(sentBody.response_format, { type: 'json_object' });
});

test('api: ai/complete with tools=true but no TAVILY_API_KEY sends only fx.rate', async () => {
  const config = makeConfig({
    IMAGE_TEXT_API_FORMAT: 'openai',
    IMAGE_TEXT_BASE_URL: 'https://gw.example/v1',
    IMAGE_TEXT_MODEL: 'm1',
    IMAGE_TEXT_API_KEY: 'sk-secret',
  });
  let sentBody = null;
  const fetchImpl = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '{"ok":1}' } }],
      }),
    };
  };
  await apiCall({
    path: '/api/ai/complete',
    method: 'POST',
    body: { prompt: 'hi', tools: true },
    config,
    events: { append: () => {}, list: () => [] },
    fetchImpl,
  });
  assert.equal(sentBody.tools.length, 1);
  assert.equal(sentBody.tools[0].function.name, 'fx_rate');
});

// ---------- integration: real sockets --------------------------------------
test('server: serves statics, SPA fallback, traversal guard over real HTTP', async () => {
  const fsImpl = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'lifespeak-root-'));
  fsImpl.writeFileSync(path.join(root, 'index.html'), '<h1>game</h1>');
  fsImpl.mkdirSync(path.join(root, 'src'));
  fsImpl.writeFileSync(path.join(root, 'src', 'x.js'), 'export const x = 1;');

  const config = makeConfig({ DATA_DIR: fsImpl.mkdtempSync(path.join(os.tmpdir(), 'lifespeak-data-')) });
  const server = createServer({ config, root });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const idx = await fetch(`${base}/`);
    assert.equal(idx.status, 200);
    assert.match(await idx.text(), /game/);

    const spa = await fetch(`${base}/some/client/route`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /game/);

    const js = await fetch(`${base}/src/x.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    const missing = await fetch(`${base}/nope.js`);
    assert.equal(missing.status, 404);

    // Traversal probes. Two distinct encodings matter:
    //  1. %2e%2e as whole segments — WHATWG URL parsing (both client-side and
    //     the server's own `new URL(req.url, ...)`) normalizes these to plain
    //     dot-dot BEFORE we see them, collapsing to an in-root path. Safe, and
    //     the SPA fallback just serves index.html.
    //  2. %2e%2e%2f — %2f is not a dot segment, so it survives URL parsing;
    //     decodeURIComponent then yields '/../../etc/passwd' and our
    //     containment check must 403 it.
    // Send raw paths via http.request so no client-side normalization hides
    // what the server actually does with the bytes.
    const rawGet = (rawPath) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: rawPath }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });

    const dotSeg = await rawGet('/%2e%2e/%2e%2e/etc/passwd');
    assert.ok(
      (dotSeg.status === 200 && /game/.test(dotSeg.body)) || dotSeg.status === 404,
      `normalized dot-segments must stay in root, got ${dotSeg.status}`,
    );
    assert.ok(!/root:.*:0:0:/.test(dotSeg.body), 'must never serve /etc/passwd');

    const encodedSlash = await rawGet('/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
    assert.equal(encodedSlash.status, 403);

    const health = await fetch(`${base}/api/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
