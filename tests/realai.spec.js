import { test, expect } from '@playwright/test';

// Real-AI smoke: drives the actual OpenAI-compatible chat-completions API
// from inside the page so the game path (not just the unit tests) is
// covered. Skipped unless the workflow exports IMAGE_TEXT_API_FORMAT=openai
// and the three creds (base url, model, key) are present.
const env = process.env;
const hasRealAI =
  !!env.IMAGE_TEXT_API_KEY &&
  !!env.IMAGE_TEXT_BASE_URL &&
  !!env.IMAGE_TEXT_MODEL &&
  (!env.IMAGE_TEXT_API_FORMAT ||
    String(env.IMAGE_TEXT_API_FORMAT).toLowerCase() === 'openai');

test.describe('real AI provider (IMAGE_TEXT_*)', () => {
  test.skip(!hasRealAI, 'IMAGE_TEXT_API_KEY/BASE_URL/MODEL not set — using mock provider');

  test.use({
    viewport: { width: 1280, height: 720 },
  });

  test('director call from the page hits the real OpenAI endpoint', async ({ page }) => {
    // Inject the config the game reads via window.__LIFESPEAK_AI_CONFIG.
    await page.addInitScript(
      ({ baseURL, model, apiKey }) => {
        window.__LIFESPEAK_AI_CONFIG = { baseURL, model, apiKey };
      },
      {
        baseURL: env.IMAGE_TEXT_BASE_URL,
        model: env.IMAGE_TEXT_MODEL,
        apiKey: env.IMAGE_TEXT_API_KEY,
      },
    );
    await page.goto('/');

    const result = await page.evaluate(async () => {
      const { openaiAsDirector } = await import('/src/ai/openaiProvider.js');
      const p = openaiAsDirector({});
      const raw = await p.complete({
        prompt: [
          'You are a tiny assistant. Respond with VALID JSON only.',
          '',
          'CONTEXT (JSON):',
          JSON.stringify({ city: 'London' }),
          '',
          'TASK: pick one of: sunny, rainy, snowy.',
          '',
          'Respond with VALID JSON only. No markdown fences, no commentary.',
        ].join('\n'),
      });
      const parsed = JSON.parse(raw);
      return { raw, parsed };
    });
    expect(['sunny', 'rainy', 'snowy']).toContain(
      result.parsed.choice || result.parsed.weather,
    );
  });
});