// Frontend client for the LifeSpeak backend (same-origin /api/*).
// The declarative boundary: the browser exchanges data ONLY through this
// module — AI completions, maps bootstrap, and user-event mirroring.
// Every call logs a masked curl command (project HTTP-logging constraint).

const BASE = '/api';

let _healthPromise = null;

function origin() {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  if (typeof process !== 'undefined' && process.env?.LIFESPEAK_BACKEND_ORIGIN) {
    return process.env.LIFESPEAK_BACKEND_ORIGIN;
  }
  return 'http://localhost:8080';
}

// ---------- masked auth logging (same standard as src/ai/openaiProvider.js)
const SENSITIVE_HEADER = /authorization|api[-_]?key|x-api-key|proxy-authorization/i;
const SENSITIVE_FIELD = /api[-_]?key|apikey|token|secret|password|authorization/i;

export function maskAuthHeaders(headers = {}) {
  const masked = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER.test(k)) {
      const s = String(v);
      masked[k] = s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '***';
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

export function maskKeyInUrl(u) {
  return String(u).replace(/([?&](?:key|api_key|access_token)=)[^&]+/gi, '$1***MASKED***');
}

function maskBody(body) {
  if (body === null || body === undefined) return body;
  if (Array.isArray(body)) return body.map(maskBody);
  if (typeof body === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(body)) {
      out[k] = SENSITIVE_FIELD.test(k) && typeof v === 'string'
        ? (v.length > 10 ? `${v.slice(0, 6)}…${v.slice(-4)}` : '***')
        : maskBody(v);
    }
    return out;
  }
  return body;
}

function toCurl({ url, method = 'GET', headers = {}, body }) {
  const parts = [`curl -X ${method} '${maskKeyInUrl(url)}'`];
  for (const [k, v] of Object.entries(maskAuthHeaders(headers))) {
    parts.push(`-H '${k}: ${v}'`);
  }
  if (body !== undefined) {
    const b = typeof body === 'string' ? body : JSON.stringify(maskBody(body));
    parts.push(`--data-raw '${String(b).replace(/'/g, "'\\''")}'`);
  }
  return parts.join(' \\\n  ');
}

function logRequest({ action, url, method = 'GET', headers = {}, body }) {
  console.log(`[backend:${action}] ${method} ${maskKeyInUrl(url)}`);
  console.log('  headers:', maskAuthHeaders(headers));
  if (body !== undefined) {
    console.log('  body:', typeof body === 'string' ? body : JSON.stringify(maskBody(body)));
  }
  console.log(`  curl: ${toCurl({ url, method, headers, body })}`);
}

function logResponse({ action, status, body }) {
  console.log(`[backend:${action}] response status=${status}`);
  if (body !== undefined) {
    console.log('  body:', typeof body === 'string' ? body : JSON.stringify(maskBody(body)));
  }
}

// ---------- health probe ---------------------------------------------------
// Memoized for the page lifetime: one probe decides whether the backend
// exists at all. When it fails, every other call short-circuits to null so
// callers degrade (mock AI, mock maps, IndexedDB-only storage) without
// paying a network timeout per feature.

export function probeBackend({ fetchImpl = fetch } = {}) {
  const url = `${origin()}${BASE}/healthz`;
  _healthPromise ||= (async () => {
    logRequest({ action: 'healthz', url, method: 'GET' });
    try {
      const res = await fetchImpl(url, { method: 'GET' });
      const body = await res.json().catch(() => null);
      logResponse({ action: 'healthz', status: res.status, body });
      if (!res.ok || !body?.ok) return null;
      return body; // { ok, ai, maps }
    } catch (e) {
      logResponse({ action: 'healthz', status: 0, body: String(e?.message || e) });
      return null;
    }
  })();
  return _healthPromise;
}

// Test hook: reset the memoized probe.
export function _resetBackendProbe() {
  _healthPromise = null;
}

export async function backendAvailable(opts) {
  return (await probeBackend(opts)) !== null;
}

// ---------- AI completion proxy -------------------------------------------
// director.js treats this as a provider: complete({prompt, image}) -> text.
// A non-ok response throws, EXCEPT 503 (AI unconfigured upstream) which the
// director interprets as "fall through to the next provider in the chain".

export async function backendComplete({ prompt, image = null, tools = false }, { fetchImpl = fetch } = {}) {
  const url = `${origin()}${BASE}/ai/complete`;
  const headers = { 'content-type': 'application/json' };
  const body = { prompt, image, ...(tools ? { tools: true } : {}) };
  logRequest({ action: 'ai/complete', url, method: 'POST', headers, body });
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  logResponse({ action: 'ai/complete', status: res.status, body: parsed });
  if (!res.ok) {
    const err = new Error(parsed?.error || `backend ai ${res.status}`);
    err.status = res.status;
    throw err;
  }
  // Tool-enabled responses carry a toolLog ([{ tool, args, ok, value|error, ms }]);
  // the director unwraps { text, toolLog } so the loop can surface briefing items.
  if (tools && Array.isArray(parsed.toolLog)) {
    return { text: parsed.text, toolLog: parsed.toolLog };
  }
  return parsed.text;
}

// ---------- Google Maps bootstrap -----------------------------------------

export async function backendMapsConfig({ fetchImpl = fetch } = {}) {
  const url = `${origin()}${BASE}/maps/config`;
  logRequest({ action: 'maps/config', url, method: 'GET' });
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET' });
  } catch (e) {
    logResponse({ action: 'maps/config', status: 0, body: String(e?.message || e) });
    return null;
  }
  const body = await res.json().catch(() => null);
  // The key arrives in this body; maskBody redacts the apiKey field in logs.
  logResponse({ action: 'maps/config', status: res.status, body });
  if (!res.ok || !body?.apiKey) return null;
  return body; // { apiKey, mapId? }
}

// ---------- MCP tool proxy -------------------------------------------------
// Mirrors POST /api/mcp from the server. openaiProvider uses this to run
// tool calls requested by the AI without exposing secrets to the page.

export async function backendMcpInvoke(toolId, args, { fetchImpl = fetch } = {}) {
  const url = `${origin()}${BASE}`;
  const headers = { 'content-type': 'application/json' };
  const body = { id: `mcp-${Date.now()}`, method: 'tools.invoke', params: { tool: toolId, args } };
  logRequest({ action: 'mcp/invoke', url, method: 'POST', headers, body });
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    logResponse({ action: 'mcp/invoke', status: 0, body: String(e?.message || e) });
    throw new Error(`mcp invoke network: ${String(e?.message || e)}`);
  }
  const parsed = await res.json().catch(() => ({ error: `non-json status ${res.status}` }));
  logResponse({ action: 'mcp/invoke', status: res.status, body: parsed });
  return parsed;
}

export async function backendMcpTools({ fetchImpl = fetch } = {}) {
  const url = `${origin()}${BASE}/tools`;
  logRequest({ action: 'mcp/tools', url, method: 'GET' });
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET' });
  } catch (e) {
    logResponse({ action: 'mcp/tools', status: 0, body: String(e?.message || e) });
    return { tools: [] };
  }
  const parsed = await res.json().catch(() => ({ tools: [] }));
  logResponse({ action: 'mcp/tools', status: res.status, body: parsed });
  if (!res.ok || !Array.isArray(parsed?.tools)) return { tools: [] };
  return parsed;
}

// ---------- event mirroring ------------------------------------------------

export async function appendEvents(events, { fetchImpl = fetch } = {}) {
  if (!Array.isArray(events) || events.length === 0) return { accepted: 0, deduped: 0, total: 0 };
  const url = `${origin()}${BASE}/events`;
  const headers = { 'content-type': 'application/json' };
  const body = { events };
  logRequest({ action: 'events.append', url, method: 'POST', headers,
    body: { events: `[${events.length} events]` } });
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const parsed = await res.json().catch(() => null);
  logResponse({ action: 'events.append', status: res.status, body: parsed });
  if (!res.ok) {
    const err = new Error(parsed?.error || `backend events ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return parsed; // { accepted, deduped, total }
}

// Fire-and-forget variant for pagehide: uses sendBeacon when present so the
// flush survives page teardown. Returns true when the payload was handed off.
export function beaconEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return false;
  const url = `${origin()}${BASE}/events`;
  const payload = JSON.stringify({ events });
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    logRequest({ action: 'events.beacon', url, method: 'POST',
      headers: { 'content-type': 'application/json' }, body: { events: `[${events.length} events]` } });
    const blob = new Blob([payload], { type: 'application/json' });
    return navigator.sendBeacon(url, blob);
  }
  return false;
}
