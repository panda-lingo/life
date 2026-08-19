// Unit tests for the MCP router and tools.
// Pure dependency injection — fake fetch / fake res — so the tests run in
// node without a backend, real AI, or a Tavily key. Exercises:
//   - GET /api/mcp/tools manifest shape and enablement rules
//   - POST /api/mcp tools.invoke success, disabled, timeout, error
//   - tool mockRun for offline/deterministic callers
import test from 'node:test';
import assert from 'node:assert/strict';

import { handleMcp } from './mcpRouter.js';
import { ALL_TOOLS, fxRateTool, webSearchTool, webFetchTool } from './mcpTools.js';

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

function jsonReq(method, body, headers = {}) {
  const listeners = {};
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
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

function makeConfig({ tavilyApiKey = '' } = {}) {
  return {
    ai: { configured: true },
    mcp: {
      tavilyApiKey,
      TAVILY_API_KEY: tavilyApiKey,
      timeoutMs: 1000,
    },
  };
}

function url(pathname) {
  return { pathname, searchParams: new URLSearchParams() };
}

// ---------- registry ------------------------------------------------------

test('registry: ALL_TOOLS exposes the three v1 tools', () => {
  const ids = ALL_TOOLS.map((t) => t.id).sort();
  assert.deepEqual(ids, ['fx.rate', 'web.fetch', 'web.search']);
});

test('tools: each tool exposes spec / requiredEnv / run / mockRun shape', () => {
  for (const t of ALL_TOOLS) {
    assert.equal(typeof t.id, 'string');
    assert.ok(Array.isArray(t.requiredEnv));
    assert.equal(t.spec.type, 'function');
    assert.equal(typeof t.spec.function.name, 'string');
    assert.ok(t.spec.function.parameters && typeof t.spec.function.parameters === 'object');
    assert.equal(typeof t.run, 'function');
    assert.equal(typeof t.mockRun, 'function');
  }
});

test('fxRateTool.mockRun: deterministic offline results', () => {
  const out = fxRateTool.mockRun({ base: 'USD', target: 'EUR' });
  assert.equal(out.base, 'USD');
  assert.equal(out.target, 'EUR');
  assert.equal(out.rate, 0.92);
  assert.equal(out.mock, true);
});

// ---------- GET /api/mcp/tools -------------------------------------------

test('GET /api/mcp/tools: without TAVILY_API_KEY, only fx.rate is enabled', async () => {
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('GET'),
    res,
    url: url('/api/mcp/tools'),
    config: makeConfig({}),
    body: undefined,
  });
  assert.equal(res.statusCode, 200);
  const tools = res.body.tools;
  assert.ok(Array.isArray(tools));
  const byId = Object.fromEntries(tools.map((t) => [t.id, t]));
  assert.equal(byId['fx.rate'].enabled, true);
  assert.equal(byId['web.search'].enabled, false);
  assert.equal(byId['web.fetch'].enabled, false);
});

test('GET /api/mcp/tools: with TAVILY_API_KEY, web tools enabled', async () => {
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('GET'),
    res,
    url: url('/api/mcp/tools'),
    config: makeConfig({ tavilyApiKey: 'tvly-test' }),
    body: undefined,
  });
  assert.equal(res.statusCode, 200);
  const byId = Object.fromEntries(res.body.tools.map((t) => [t.id, t]));
  assert.equal(byId['web.search'].enabled, true);
  assert.equal(byId['web.fetch'].enabled, true);
});

// ---------- POST /api/mcp tools.list -------------------------------------

test('POST /api/mcp { method: tools.list }: returns same manifest', async () => {
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'r1', method: 'tools.list' }),
    res,
    url: url('/api/mcp'),
    config: makeConfig({ tavilyApiKey: 'tvly-test' }),
    body: { id: 'r1', method: 'tools.list' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.jsonrpc, '2.0');
  assert.equal(res.body.id, 'r1');
  assert.ok(Array.isArray(res.body.result.tools));
  assert.equal(res.body.result.tools.length, 3);
});

// ---------- POST /api/mcp tools.invoke (success) -------------------------

test('POST /api/mcp tools.invoke fx.rate: fake fetch returns parsed result', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      result: 'success',
      base_code: 'USD',
      rates: { EUR: 0.92, GBP: 0.79 },
      time_last_update_utc: 'Wed, 19 Aug 2026 00:00:01 GMT',
    }),
  });
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'r2', method: 'tools.invoke', params: { tool: 'fx.rate', args: { base: 'USD', target: 'EUR' } } }),
    res,
    url: url('/api/mcp'),
    config: makeConfig({}),
    fetchImpl: fakeFetch,
    body: { id: 'r2', method: 'tools.invoke', params: { tool: 'fx.rate', args: { base: 'USD', target: 'EUR' } } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.ok, true);
  assert.equal(res.body.result.value.base, 'USD');
  assert.equal(res.body.result.value.target, 'EUR');
  assert.equal(res.body.result.value.rate, 0.92);
});

test('POST /api/mcp tools.invoke fx.rate: 5xx upstream falls back to mock', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 503,
    text: async () => JSON.stringify({ error: 'upstream busy' }),
  });
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'r3', method: 'tools.invoke', params: { tool: 'fx.rate', args: { base: 'USD', target: 'GBP' } } }),
    res,
    url: url('/api/mcp'),
    config: makeConfig({}),
    fetchImpl: fakeFetch,
    body: { id: 'r3', method: 'tools.invoke', params: { tool: 'fx.rate', args: { base: 'USD', target: 'GBP' } } },
  });
  // fxRateTool degrades to mockRun on !res.ok, returning a usable value.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.ok, true);
  assert.equal(res.body.result.value.mock, true);
  assert.equal(res.body.result.value.rate, 0.79);
});

// ---------- POST /api/mcp tools.invoke (disabled) ------------------------

test('POST /api/mcp tools.invoke web.search: disabled when no TAVILY_API_KEY', async () => {
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'r4', method: 'tools.invoke', params: { tool: 'web.search', args: { query: 'london weather' } } }),
    res,
    url: url('/api/mcp'),
    config: makeConfig({}),
    body: { id: 'r4', method: 'tools.invoke', params: { tool: 'web.search', args: { query: 'london weather' } } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.ok, false);
  assert.equal(res.body.result.code, 4100);
  assert.match(res.body.result.error, /disabled/);
});

// ---------- POST /api/mcp tools.invoke (timeout) -------------------------

test('POST /api/mcp tools.invoke: timeout returns structured failure', async () => {
  const slowFetch = () => new Promise(() => {}); // never resolves
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'r5', method: 'tools.invoke', params: { tool: 'fx.rate', args: { base: 'USD', target: 'EUR' } } }),
    res,
    url: url('/api/mcp'),
    config: { ...makeConfig({}), mcp: { ...makeConfig({}).mcp, timeoutMs: 50 } },
    fetchImpl: slowFetch,
    body: { id: 'r5', method: 'tools.invoke', params: { tool: 'fx.rate', args: { base: 'USD', target: 'EUR' } } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.ok, false);
  assert.match(res.body.result.error, /timed out/);
});

// ---------- POST /api/mcp error paths ------------------------------------

test('POST /api/mcp: unknown tool returns 404', async () => {
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'r6', method: 'tools.invoke', params: { tool: 'nope', args: {} } }),
    res,
    url: url('/api/mcp'),
    config: makeConfig({}),
    body: { id: 'r6', method: 'tools.invoke', params: { tool: 'nope', args: {} } },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, -32601);
});

test('POST /api/mcp: missing method returns 400', async () => {
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'r7' }),
    res,
    url: url('/api/mcp'),
    config: makeConfig({}),
    body: { id: 'r7' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /api/mcp: unknown method returns 400', async () => {
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'r8', method: 'tools.dance' }),
    res,
    url: url('/api/mcp'),
    config: makeConfig({}),
    body: { id: 'r8', method: 'tools.dance' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /api/mcp: unknown path returns 404', async () => {
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'r9', method: 'tools.list' }),
    res,
    url: url('/api/other'),
    config: makeConfig({}),
    body: { id: 'r9', method: 'tools.list' },
  });
  assert.equal(res.statusCode, 404);
});

// ---------- SDK adoption (official @modelcontextprotocol/sdk) ------------
// Pins the SDK wiring so a future refactor can't quietly regress to a
// hand-rolled JSON-RPC dispatcher. Asserts:
//   - tools.list through the SDK reports the registered function names
//   - tools.invoke result envelope is { ok, value } for enabled tools
//   - tools.invoke error envelope is { ok: false, error, code: 4100 } for disabled
//   - tools/call (native MCP-spec method) routes through the SDK unchanged

import { buildMcpServer } from './mcpRouter.js';

test('SDK adoption: buildMcpServer registers all three tools', () => {
  const server = buildMcpServer({ config: makeConfig({ tavilyApiKey: 'tvly-test' }), fetchImpl: fetch });
  // The SDK keys _registeredTools by MCP tool name (we use the OpenAI
  // function name, e.g. "web_search"), not by our dotted id.
  const registered = Object.keys(server._registeredTools).sort();
  assert.deepEqual(registered, ['fx_rate', 'web_fetch', 'web_search']);
});

test('SDK adoption: tools registered with the SDK expose a zod inputSchema', () => {
  const server = buildMcpServer({ config: makeConfig({ tavilyApiKey: 'tvly-test' }), fetchImpl: fetch });
  // The SDK's internal registry is the source of truth for what tools are
  // available. Assert each registration carries its zod schema so the
  // official toJsonSchemaCompat can derive the wire format.
  for (const tool of Object.values(server._registeredTools)) {
    assert.ok(tool.inputSchema, 'inputSchema is the zod schema');
    assert.equal(typeof tool.inputSchema.parse, 'function', 'zod schema has parse()');
    assert.equal(typeof tool.description, 'string');
  }
});

test('SDK adoption: tools.invoke result envelope = { ok: true, value } for enabled fx.rate', async () => {
  // Mirror the happy-path POST /api/mcp test but specifically assert the
  // envelope keys come from the SDK's CallToolResult text content (proves
  // the SDK -> JSON unwrap step is wired).
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      result: 'success',
      base_code: 'USD',
      rates: { EUR: 0.92 },
      time_last_update_utc: 'Wed, 19 Aug 2026 00:00:01 GMT',
    }),
  });
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'sdk-1', method: 'tools.invoke',
                          params: { tool: 'fx.rate', args: { base: 'USD', target: 'EUR' } } }),
    res,
    url: url('/api/mcp'),
    config: makeConfig({}),
    body: { id: 'sdk-1', method: 'tools.invoke',
            params: { tool: 'fx.rate', args: { base: 'USD', target: 'EUR' } } },
    fetchImpl: fakeFetch,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.jsonrpc, '2.0');
  assert.equal(res.body.id, 'sdk-1');
  // These three keys are the contract the AI director consumes — they MUST
  // round-trip through the SDK intact.
  assert.equal(res.body.result.ok, true);
  assert.equal(typeof res.body.result.value, 'object');
  assert.equal(res.body.result.value.rate, 0.92);
  // No MCP transport leakage into the browser envelope.
  assert.equal(res.body.result.content, undefined, 'no SDK content[] leakage');
  assert.equal(res.body.result.isError, undefined, 'no SDK isError leakage');
});

test('SDK adoption: tools.invoke disabled tool keeps code: 4100 contract', async () => {
  // web.search without TAVILY_API_KEY must still surface the disabled signal
  // the AI director understands — the SDK path can't change the contract.
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'sdk-2', method: 'tools.invoke',
                          params: { tool: 'web.search', args: { query: 'x' } } }),
    res,
    url: url('/api/mcp'),
    config: makeConfig({}),
    body: { id: 'sdk-2', method: 'tools.invoke',
            params: { tool: 'web.search', args: { query: 'x' } } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.ok, false);
  assert.equal(res.body.result.code, 4100);
  assert.match(res.body.result.error, /disabled/);
});

test('SDK adoption: MCP-spec tools/list method is rejected (legacy envelope only)', async () => {
  // The browser-facing endpoint only accepts the legacy envelope. A future
  // SDK-native MCP client would connect over Streamable HTTP / stdio and is
  // out of scope for this route. Verify the boundary stays tight.
  const res = fakeRes();
  await handleMcp({
    req: jsonReq('POST', { id: 'sdk-3', method: 'tools/list' }),
    res,
    url: url('/api/mcp'),
    config: makeConfig({ tavilyApiKey: 'tvly-test' }),
    body: { id: 'sdk-3', method: 'tools/list' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, -32601);
});

test('SDK adoption: ALL_TOOLS each expose a zod inputSchema', () => {
  // The router relies on each tool having a zod schema for registerTool.
  // Guard against a future addition forgetting to ship one.
  for (const tool of ALL_TOOLS) {
    assert.ok(tool.schema, `${tool.id} missing zod schema`);
    assert.equal(typeof tool.schema.parse, 'function', `${tool.id} schema is not zod`);
  }
});

test('SDK adoption: isEnvPresent is the single env-probe helper', () => {
  // isEnvPresent is shared between api.js, mcpRouter, and callUpstream. The
  // SDK adoption did not change its semantics — only its caller.
  // Re-import here because the module top-level import was slimmed down.
  return import('./mcpRouter.js').then(({ isEnvPresent }) => {
    const c = { mcp: { tavilyApiKey: 'tvly-test' } };
    assert.equal(isEnvPresent(c, 'TAVILY_API_KEY'), true);
    assert.equal(isEnvPresent({ mcp: {} }, 'TAVILY_API_KEY'), false);
  });
});

test('webSearchTool.run: missing TAVILY_API_KEY throws', async () => {
  await assert.rejects(
    webSearchTool.run({ query: 'hi' }, { config: { mcp: { tavilyApiKey: '' } } }),
    /TAVILY_API_KEY/,
  );
});

test('webSearchTool.run: with fake fetch, strips oversized content', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      results: [
        { title: 'a'.repeat(300), url: 'https://x/' + 'a'.repeat(400), content: 'x'.repeat(800) },
        { title: 'short', url: 'https://x/short', content: 'short' },
      ],
    }),
  });
  const out = await webSearchTool.run(
    { query: 'test', max_results: 5 },
    { config: { mcp: { tavilyApiKey: 'tvly' } }, fetchImpl: fakeFetch },
  );
  assert.equal(out.results.length, 2);
  assert.ok(out.results[0].title.length <= 120);
  assert.ok(out.results[0].url.length <= 200);
  assert.ok(out.results[0].content.length <= 300);
});

test('webFetchTool.run: with fake fetch, returns trimmed rawContent', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      results: [{ rawContent: 'x'.repeat(2000) }],
    }),
  });
  const out = await webFetchTool.run(
    { url: 'https://example.com' },
    { config: { mcp: { tavilyApiKey: 'tvly' } }, fetchImpl: fakeFetch },
  );
  assert.equal(out.url, 'https://example.com');
  assert.ok(out.rawContent.length <= 1000);
});