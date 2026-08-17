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

test('openaiProvider: complete() returns text for a chat-only prompt', { skip: !HAS_ENV || !FORMAT_OK }, async () => {
  const { openaiProvider } = await import('./openaiProvider.js');
  const p = await openaiProvider({
    model: process.env.IMAGE_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseURL: process.env.IMAGE_TEXT_BASE_URL || process.env.OPENAI_BASE_URL,
  });
  const text = await p.complete({
    system: 'Reply with a single JSON object only. No prose.',
    prompt: 'Output exactly: {"ping":"pong","n":1}',
    json: true,
    maxTokens: 64,
  });
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0, 'expected non-empty completion');
  // Must be valid JSON (response_format=json_object).
  const obj = JSON.parse(text);
  assert.equal(obj.ping, 'pong');
  assert.equal(obj.n, 1);
});

test('openaiAsDirector: director-shaped prompt flows through system channel', { skip: !HAS_ENV || !FORMAT_OK }, async () => {
  const { openaiAsDirector } = await import('./openaiProvider.js');
  const p = await openaiAsDirector({
    model: process.env.IMAGE_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseURL: process.env.IMAGE_TEXT_BASE_URL || process.env.OPENAI_BASE_URL,
  });
  // Mimic exactly the shape director.js builds.
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
  const raw = await p.complete({ prompt });
  const parsed = JSON.parse(raw);
  assert.ok(['sunny', 'rainy', 'snowy'].includes(parsed.choice || parsed.weather),
    `expected one of sunny|rainy|snowy; got ${raw}`);
});

test('openaiProvider: accepts an image_url content part', { skip: !HAS_ENV || !FORMAT_OK }, async () => {
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