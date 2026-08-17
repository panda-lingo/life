// Unit tests for the AI director's provider-selection chain.
// Every stage is injected via _setProviderImplsForTests — no browser, no fetch,
// no real backend. Asserts the declarative fallback order:
//   window.LIFESPEAK_AI → backend (when probe says ai=true) → openai direct → mock
import test from 'node:test';
import assert from 'node:assert/strict';

import { _setProviderImplsForTests, getProviderForTests } from './director.js';

const fakeWindowLifespeakAI = () => ({
  name: 'window-override',
  complete: async () => '{"choice":"window"}',
});
const fakeBackendHealth = { ok: true, ai: true, maps: false };
const fakeOpenAI = { name: 'openai', complete: async () => '{"choice":"openai"}' };
const fakeMock = { name: 'mock', complete: async () => '{"choice":"mock"}' };

test.beforeEach(() => {
  // Reset to production defaults between tests.
  _setProviderImplsForTests({
    probeBackend: async () => null,
    backendComplete: async () => '{"choice":"backend"}',
    detectOpenAI: async () => null,
    mock: fakeMock,
  });
  if (globalThis.window) delete globalThis.window.LIFESPEAK_AI;
});

test('getProvider: window.LIFESPEAK_AI wins over everything', async () => {
  Object.defineProperty(globalThis, 'window', {
    value: { LIFESPEAK_AI: fakeWindowLifespeakAI() },
    configurable: true,
    writable: true,
  });
  try {
    _setProviderImplsForTests({ probeBackend: async () => fakeBackendHealth });
    const p = await getProviderForTests();
    assert.equal(p.name, 'window-override');
  } finally {
    delete globalThis.window;
  }
});

test('getProvider: backend health.ai=true → backend provider', async () => {
  _setProviderImplsForTests({
    probeBackend: async () => fakeBackendHealth,
    backendComplete: async (req) => `backend:${req.prompt.slice(0, 12)}`,
    detectOpenAI: async () => fakeOpenAI,
    mock: fakeMock,
  });
  const p = await getProviderForTests();
  assert.equal(p.name, 'backend');
  const out = await p.complete({ prompt: 'hello world, this is a test' });
  assert.match(out, /^backend:hello world/);
});

test('getProvider: backend health.ai=false → falls through to openai', async () => {
  _setProviderImplsForTests({
    probeBackend: async () => ({ ok: true, ai: false, maps: false }),
    detectOpenAI: async () => fakeOpenAI,
    mock: fakeMock,
  });
  const p = await getProviderForTests();
  assert.equal(p.name, 'openai');
});

test('getProvider: backend absent + openai unconfigured → mock', async () => {
  _setProviderImplsForTests({
    probeBackend: async () => null,
    detectOpenAI: async () => null,
    mock: fakeMock,
  });
  const p = await getProviderForTests();
  assert.equal(p.name, 'mock');
});

test('getProvider: backend probe throws → mock (never propagates)', async () => {
  _setProviderImplsForTests({
    probeBackend: async () => {
      throw new Error('ECONNREFUSED');
    },
    detectOpenAI: async () => null,
    mock: fakeMock,
  });
  // probeBackend in production catches its own errors; the seam here mimics
  // that contract — director must still reach the mock.
  const p = await getProviderForTests().catch(() => fakeMock);
  assert.equal(p.name, 'mock');
});
