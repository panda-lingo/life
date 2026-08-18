// Unit tests for the OpenAI real-provider adapter.
//
// Runs only when the IMAGE_TEXT_API_KEY secret (or OPENAI_API_KEY) is set
// AND IMAGE_TEXT_API_FORMAT=openai. Otherwise skipped — keeps CI green
// for forks/PRs that don't have a key, while still exercising the real
// provider path on the main branch.
//
//   IMAGE_TEXT_API_FORMAT=openai
//   IMAGE_TEXT_BASE_URL=https://api.openai.com/v1
//   IMAGE_TEXT_MODEL=gpt-4o-mini
//   IMAGE_TEXT_API_KEY=sk-...
//
// Exits non-zero on any failure so the GitHub workflow can gate on it.

import test from 'node:test';
import assert from 'node:assert/strict';

const HAS_ENV =
  !!process.env.IMAGE_TEXT_API_KEY ||
  !!process.env.OPENAI_API_KEY;
const FORMAT_OK =
  !process.env.IMAGE_TEXT_API_FORMAT ||
  String(process.env.IMAGE_TEXT_API_FORMAT).toLowerCase() === 'openai';

test('real provider: skipped when IMAGE_TEXT_API_KEY missing', { skip: HAS_ENV && FORMAT_OK }, async () => {
  // When this test runs, it means the env vars are NOT set and the rest of
  // the suite should skip. This branch must never execute.
  assert.ok(true, 'skipping real-provider tests');
});

// Upstream-flake tolerance: newapi-style gateways behind the dev AI service
// flake in two observed ways:
//   1. Degenerate HTTP 200 — `{"choices":null,...,"completion_tokens":0}`
//      (gateway answers OK but generates nothing).
//   2. HTTP 500 / context-deadline-exceeded — gateway bursts under load
//      and surfaces "500 req failed 500 500 Internal Server Error" or
//      a transport-layer timeout. Bursts span 25–45+ s, longer than any
//      sane retry window.
// These shapes are upstream failure modes, not provider-contract bugs. The
// assertion here targets the gateway chain, not our parsing, so when three
// consecutive attempts land inside a documented flake burst the test
// *skips* instead of failing. 4xx (prompt bug) and structural JSON errors
// still propagate: those are contract bugs, not flakes.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withUpstreamRetry(fn) {
  const isRetryable = (err) => {
    if (!err) return false;
    // OpenAI SDK attaches `err.status` for HTTP-shaped errors (5xx lands
    // here as InternalServerError, 4xx as BadRequestError etc.) and leaves
    // it undefined for transport-layer failures (APIConnectionError,
    // APIConnectionTimeoutError, AbortError).
    const status = err?.status;
    if (typeof status === 'number' && status >= 500) return true;
    // Transport-layer timeouts / EOFs surface as raw errors with no status.
    const msg = String(err?.message || err);
    if (/context deadline exceeded/i.test(msg)) return true;
    if (/Timeout exceeded/i.test(msg)) return true;
    if (/socket hang up|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(msg)) return true;
    if (/Request timed out\./i.test(msg)) return true;
    if (/Connection error\./i.test(msg)) return true;
    return false;
  };
  const isDegenerate = (err) =>
    /degenerate completion/i.test(String(err?.message || err));
  let lastErr = null;
  // attempts[0] runs immediately; attempts[1..] follow backoff [1s, 2s].
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(1000 * attempt);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err) || isDegenerate(err);
      if (!retryable) throw err;
      // Classify for the log line so a reviewer can see the upstream failure mode.
      const kind = err?.status ? `HTTP ${err.status}` : (err?.name || 'error');
      if (attempt < 2) {
        console.warn(`[test] upstream flake attempt=${attempt + 1} (${kind}); backing off ${1000 * (attempt + 1)}ms: ${err?.message || err}`);
      }
    }
  }
  // All 3 attempts failed with documented upstream-flake shapes — the
  // gateway is in a burst window. Signal a skip rather than failing: the
  // assertion targets upstream behavior, and upstream is unavailable.
  console.warn(`[test] upstream flaked 3x consecutively; skipping (last=${lastErr?.message || lastErr})`);
  throw new UpstreamSkip();
}

// Sentinel: withUpstreamRetry throws this when every attempt landed inside
// a documented upstream-flake burst. The test catches it and calls t.skip().
class UpstreamSkip extends Error {
  constructor() {
    super('upstream AI gateway in a sustained flake burst (3x consecutive 5xx/timeout/degenerate-200)');
    this.name = 'UpstreamSkip';
  }
}

test('openaiProvider: complete() returns text for a chat-only prompt', { skip: !HAS_ENV || !FORMAT_OK }, async (t) => {
  const { openaiProvider } = await import('./openaiProvider.js');
  const p = await openaiProvider({
    model: process.env.IMAGE_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseURL: process.env.IMAGE_TEXT_BASE_URL || process.env.OPENAI_BASE_URL,
  });
  let text;
  try {
    text = await withUpstreamRetry(() =>
      p.complete({
        system: 'Reply with a single JSON object only. No prose.',
        prompt: 'Output exactly: {"ping":"pong","n":1}',
        json: true,
        maxTokens: 64,
      }).then((t) => {
        if (typeof t !== 'string' || t.length === 0) {
          throw new Error('degenerate completion (HTTP 200 with empty choices/content)');
        }
        return t;
      }));
  } catch (err) {
    if (err?.name === 'UpstreamSkip') { t.skip(err.message); return; }
    throw err;
  }
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0, 'expected non-empty completion');
  // Must be valid JSON (response_format=json_object).
  const obj = JSON.parse(text);
  assert.equal(obj.ping, 'pong');
  assert.equal(obj.n, 1);
});

test('openaiAsDirector: director-shaped prompt flows through system channel', { skip: !HAS_ENV || !FORMAT_OK }, async (t) => {
  const { openaiAsDirector } = await import('./openaiProvider.js');
  const p = await openaiAsDirector({
    model: process.env.IMAGE_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseURL: process.env.IMAGE_TEXT_BASE_URL || process.env.OPENAI_BASE_URL,
  });
  // Mimic exactly the shape director.js builds. Keep maxTokens at the
  // provider default (1024): larger values can trigger gateway-side 500s
  // for some models behind newapi-style gateways.
  const system = 'You are a tiny assistant. Respond with VALID JSON only.';
  const prompt = [
    system,
    '',
    'CONTEXT (JSON):',
    JSON.stringify({ topic: 'weather', city: 'London' }, null, 1),
    '',
    'TASK: pick one of: sunny, rainy, snowy.',
    '',
    'Respond with VALID JSON only. No markdown fences, no commentary.',
  ].join('\n');
  const raw = await withUpstreamRetry(() => p.complete({ prompt })).catch((err) => {
    if (err?.name === 'UpstreamSkip') { t.skip(err.message); return null; }
    throw err;
  });
  if (raw === null) return;
  const parsed = JSON.parse(raw);
  // Reasoning models may answer with any key (choice, weather, answer, etc.)
  // or even nested. Accept any parsed object that CONTAINS one of the
  // expected enum values anywhere in its flattened values.
  const flat = JSON.stringify(parsed);
  const hit = ['sunny', 'rainy', 'snowy'].find((v) => flat.includes(`"${v}"`));
  assert.ok(hit, `expected one of sunny|rainy|snowy anywhere in response; got ${raw}`);
});

// Image input is a per-model capability. Text-only models (e.g.
// Qwen3.5-122B-A10B behind the dev gateway) can refuse or 500 the
// `image_url` part — opt in by setting IMAGE_TEXT_SUPPORTS_VISION=1.
const SUPPORTS_VISION = /^(1|true|yes)$/i.test(String(process.env.IMAGE_TEXT_SUPPORTS_VISION || ''));

test('openaiProvider: accepts an image_url content part', {
  skip: !HAS_ENV || !FORMAT_OK || !SUPPORTS_VISION,
}, async () => {
  const { openaiProvider } = await import('./openaiProvider.js');
  const p = await openaiProvider({
    model: process.env.IMAGE_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseURL: process.env.IMAGE_TEXT_BASE_URL || process.env.OPENAI_BASE_URL,
  });
  // 1x1 transparent PNG, base64-encoded
  const png1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
  const text = await p.complete({
    system: 'You classify images. Reply with JSON: {"label":"png","bytes_gt_0":true}',
    prompt: 'Is this image a valid PNG? Answer the JSON object only.',
    image: png1x1,
    json: true,
    maxTokens: 64,
  });
  const obj = JSON.parse(text);
  assert.equal(typeof obj.label, 'string');
});