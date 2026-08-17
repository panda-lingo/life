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

let _OpenAI = null;
let _OpenAILoadError = null;
async function loadOpenAI() {
  if (_OpenAI || _OpenAILoadError) return { OpenAI: _OpenAI, error: _OpenAILoadError };
  try {
    // In browsers, bare specifiers need an importmap. index.html does NOT
    // include one for "openai" (and shouldn't — the SDK is a Node dev dep),
    // so we attempt the import and gracefully degrade if it fails.
    const mod = await import('openai');
    _OpenAI = mod.default || mod;
  } catch (e) {
    _OpenAILoadError = e;
  }
  return { OpenAI: _OpenAI, error: _OpenAILoadError };
}

// ---------- request/response logging ------------------------------------
// Logs every HTTP call the provider makes. Auth headers are masked.
// Intended for debugging CI runs and local development; safe to enable by
// default because it never prints secrets.

function maskAuthHeaders(headers = {}) {
  const masked = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/authorization|api[-_]?key|x-api-key|proxy-authorization/i.test(k)) {
      const s = String(v);
      masked[k] = s.length > 8 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '***';
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

function toCurl({ url, method = 'POST', headers = {}, body }) {
  const parts = [`curl -X ${method} '${url}'`];
  for (const [k, v] of Object.entries(maskAuthHeaders(headers))) {
    parts.push(`-H '${k}: ${v}'`);
  }
  if (body !== undefined) {
    const b = typeof body === 'string' ? body : JSON.stringify(body);
    parts.push(`--data-raw '${b.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(' \\\n  ');
}

function logRequest({ action, url, method = 'POST', headers = {}, body }) {
  const line = `[ai:${action}] ${method} ${url}`;
  console.log(line);
  console.log(`  headers:`, maskAuthHeaders(headers));
  if (body !== undefined) console.log(`  body:`, typeof body === 'string' ? body : JSON.stringify(body));
  console.log(`  curl: ${toCurl({ url, method, headers, body })}`);
}

function logResponse({ action, status, body }) {
  console.log(`[ai:${action}] response status=${status}`);
  if (body !== undefined) console.log(`  body:`, typeof body === 'string' ? body : JSON.stringify(body));
}

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

export async function openaiProvider({ apiKey, baseURL, model } = {}) {
  const cfg = effectiveConfig() || {};
  const key = apiKey || cfg.apiKey;
  const url = baseURL || cfg.baseURL;
  const mdl = model || cfg.model;
  if (!key) throw new Error('IMAGE_TEXT_API_KEY (or apiKey arg) required for openaiProvider');
  const { OpenAI, error } = await loadOpenAI();
  if (!OpenAI) {
    throw new Error(
      `openai SDK not available in this environment (${error?.message || 'module not found'}). ` +
        'Use mockProvider, or add an importmap entry for "openai" to run in a browser.',
    );
  }
  const baseUrlUsed = (url || 'https://api.openai.com/v1').replace(/\/$/, '');
  const client = new OpenAI({
    apiKey: key,
    baseURL: url || undefined,
    // The official SDK doesn't expose a request logger, so we wrap fetch
    // ourselves to log every call as a curl command with auth masked.
    fetch: async (input, init) => {
      const u = typeof input === 'string' ? input : input.url;
      const method = init?.method || 'GET';
      const headers = init?.headers || {};
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const action = u.replace(baseUrlUsed, '').replace(/^\//, '') || 'root';
      logRequest({ action, url: u, method, headers, body });
      const res = await fetch(input, init);
      const cloned = res.clone();
      let parsedBody;
      try { parsedBody = await cloned.json(); } catch { parsedBody = await cloned.text(); }
      logResponse({ action, status: res.status, body: parsedBody });
      return res;
    },
  });
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
export async function openaiAsDirector({ apiKey, baseURL, model } = {}) {
  const inner = await openaiProvider({ apiKey, baseURL, model });
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
      const headers = {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };
      const body = { model, prompt, image };
      logRequest({ action: 'legacy', url: endpoint, method: 'POST', headers, body });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsedBody;
      try { parsedBody = JSON.parse(text); } catch { parsedBody = text; }
      logResponse({ action: 'legacy', status: res.status, body: parsedBody });
      if (!res.ok) throw new Error(`AI provider ${res.status}: ${text}`);
      const data = parsedBody;
      return data.text;
    },
  };
}

// Default export: provider selected from env, or null (so director.js
// falls back to mockProvider). Callers can also `import { openaiProvider }`.
export default async function detectProvider() {
  const cfg = effectiveConfig();
  if (!cfg) return null;
  try {
    return await openaiAsDirector({});
  } catch (e) {
    // openai SDK not importable in this environment — return null so the
    // caller can decide what to do (game still works with the mock).
    if (/Cannot find module|ERR_MODULE_NOT_FOUND|not available in this environment/.test(String(e?.message || e))) {
      return null;
    }
    throw e;
  }
}