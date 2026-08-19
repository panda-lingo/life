// Unit tests for the frontend MCP client.
// Dependency-injected — no real fetch, no browser, no secrets.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchToolsManifest, invokeTool, _resetMcpClientForTests } from './mcpClient.js';

test.beforeEach(() => {
  _resetMcpClientForTests();
});

test('fetchToolsManifest: returns parsed manifest on success', async () => {
  const fakeManifest = {
    tools: [
      { id: 'fx.rate', enabled: true, spec: { type: 'function', function: { name: 'fx_rate' } } },
      { id: 'web.search', enabled: false, spec: { type: 'function', function: { name: 'web_search' } } },
    ],
  };
  const fakeFetch = async (url) => {
    assert.match(url, /\/api\/mcp\/tools$/);
    return {
      ok: true,
      status: 200,
      json: async () => fakeManifest,
    };
  };
  const out = await fetchToolsManifest({ fetchImpl: fakeFetch });
  assert.equal(out.tools.length, 2);
  assert.equal(out.tools[0].id, 'fx.rate');
});

test('fetchToolsManifest: network failure returns empty tools list gracefully', async () => {
  const failingFetch = async () => {
    throw new Error('connection refused');
  };
  const out = await fetchToolsManifest({ fetchImpl: failingFetch });
  assert.deepEqual(out, { tools: [] });
});

test('fetchToolsManifest: non-2xx returns empty tools list', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'down' }),
  });
  const out = await fetchToolsManifest({ fetchImpl: fakeFetch });
  assert.deepEqual(out, { tools: [] });
});

test('invokeTool: sends JSON-RPC 2.0 shaped body and parses response', async () => {
  let capturedUrl = null;
  let capturedInit = null;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 'mcp-xyz',
        result: { ok: true, value: { rate: 0.92 } },
      }),
    };
  };
  const res = await invokeTool(
    { toolId: 'fx.rate', args: { base: 'USD', target: 'EUR' } },
    { fetchImpl: fakeFetch },
  );
  assert.match(capturedUrl, /\/api\/mcp$/);
  assert.equal(capturedInit.method, 'POST');
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.method, 'tools.invoke');
  assert.equal(body.params.tool, 'fx.rate');
  assert.equal(body.params.args.base, 'USD');
  assert.equal(res.result.ok, true);
  assert.equal(res.result.value.rate, 0.92);
});

test('invokeTool: network failure throws with descriptive message', async () => {
  const failingFetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(
    invokeTool({ toolId: 'fx.rate', args: {} }, { fetchImpl: failingFetch }),
    /mcp invoke network: ECONNREFUSED/,
  );
});

test('invokeTool: non-json response is wrapped', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 502,
    json: async () => { throw new Error('not json'); },
  });
  const res = await invokeTool({ toolId: 'fx.rate', args: {} }, { fetchImpl: fakeFetch });
  assert.match(String(res.error), /non-json status 502/);
});

test('_resetMcpClientForTests: clears memoized manifest', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ tools: [{ id: 'fx.rate', enabled: true, spec: {} }] }),
    };
  };
  await fetchToolsManifest({ fetchImpl: fakeFetch });
  await fetchToolsManifest({ fetchImpl: fakeFetch });
  assert.equal(calls, 1, 'manifest is memoized');
  _resetMcpClientForTests();
  await fetchToolsManifest({ fetchImpl: fakeFetch });
  assert.equal(calls, 2, 'reset clears the cache');
});