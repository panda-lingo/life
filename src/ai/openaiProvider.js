// Real-provider adapter. Honors the project's "all AI calls go through
// src/ai/director.js" boundary — game code never imports openai directly.
//
// Configuration (env-driven, all optional):
//   IMAGE_TEXT_API_FORMAT  = "openai"            (other formats may follow)
//   IMAGE_TEXT_BASE_URL    = https://api.openai.com/v1  (or your gateway)
//   IMAGE_TEXT_MODEL       = gpt-4o-mini / etc.
//   IMAGE_TEXT_API_KEY     = the secret (also accepts OPENAI_API_KEY)
//
// When any of these is set AND `openai` is importable, the game uses the
// real provider; otherwise it falls back to mockProvider so the game still
// runs offline / in CI without a key.

import OpenAI from 'openai';

function envConfig() {
  const fmt = (typeof process !== 'undefined' ? process.env : {}).IMAGE_TEXT_API_FORMAT;
  if (!fmt) return null;
  if (String(fmt).toLowerCase() !== 'openai') return null;
  const apiKey =
    (typeof process !== 'undefined' ? process.env : {}).IMAGE_TEXT_API_KEY ||
    (typeof process !== 'undefined' ? process.env : {}).OPENAI_API_KEY;
  const baseURL =
    (typeof process !== 'undefined' ? process.env : {}).IMAGE_TEXT_BASE_URL ||
    (typeof process !== 'undefined' ? process.env : {}).OPENAI_BASE_URL ||
    undefined;
  const model =
    (typeof process !== 'undefined' ? process.env : {}).IMAGE_TEXT_MODEL ||
    (typeof process !== 'undefined' ? process.env : {}).OPENAI_MODEL ||
    undefined;
  return { apiKey, baseURL, model };
}

// ---- runtime config (browser): window.__LIFESPEAK_AI_CONFIG populated
//      by an in-page init script that reads env vars embedded at build time.
function runtimeConfig() {
  if (typeof window === 'undefined') return null;
  return window.__LIFESPEAK_AI_CONFIG || null;
}

function effectiveConfig() {
  return envConfig() || runtimeConfig();
}

export function openaiProvider({ apiKey, baseURL, model } = {}) {
  const cfg = effectiveConfig() || {};
  const key = apiKey || cfg.apiKey;
  const url = baseURL || cfg.baseURL;
  const mdl = model || cfg.model;
  if (!key) throw new Error('IMAGE_TEXT_API_KEY (or apiKey arg) required for openaiProvider');
  const client = new OpenAI({ apiKey: key, baseURL: url || undefined });
  const useModel = mdl || 'gpt-4o-mini';

  return {
    name: 'openai',
    model: useModel,
    async complete({ prompt, image = null, system = null, json = true, maxTokens = 1024 } = {}) {
      const userContent = [];
      userContent.push({ type: 'text', text: String(prompt ?? '') });
      if (image) {
        const url = String(image).startsWith('data:')
          ? String(image)
          : `data:image/png;base64,${image}`;
        userContent.push({ type: 'image_url', image_url: { url } });
      }
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: userContent });

      const res = await client.chat.completions.create({
        model: useModel,
        messages,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        max_tokens: maxTokens,
        temperature: 0.4,
      });
      const text = res?.choices?.[0]?.message?.content ?? '';
      return text;
    },
  };
}

// Convenience: build a provider that's compatible with director.js's
// `complete({ prompt, image }) -> string (JSON)` contract. The director
// wraps the returned string in `JSON.parse(extractJSON(...))`.
export function openaiAsDirector({ apiKey, baseURL, model } = {}) {
  const inner = openaiProvider({ apiKey, baseURL, model });
  return {
    async complete(req) {
      // director.js assembles system + context JSON inside `prompt`; we
      // re-split on the canonical markers so the system message can flow
      // through the chat-completions `system` channel for better results.
      const raw = String(req.prompt ?? '');
      const sysMatch = raw.match(/^([\s\S]*?)\n\nCONTEXT \(JSON\):/);
      const system = sysMatch ? sysMatch[1] : null;
      return inner.complete({ ...req, system });
    },
  };
}

// `createHttpProvider` (legacy) kept for callers that already use it.
export function createHttpProvider({ endpoint, apiKey, model }) {
  return {
    async complete({ prompt, image = null }) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, prompt, image }),
      });
      if (!res.ok) throw new Error(`AI provider ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.text;
    },
  };
}

// Default export: provider selected from env, or null (so director.js
// falls back to mockProvider). Callers can also `import { openaiProvider }`.
export default function detectProvider() {
  const cfg = effectiveConfig();
  if (!cfg) return null;
  try {
    return openaiAsDirector({});
  } catch (e) {
    // openai SDK not importable in this environment — return null so the
    // caller can decide what to do (game still works with the mock).
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(e?.message || e))) return null;
    throw e;
  }
}