// Browser-side MCP client.
// Fetches the same-origin /api/mcp/tools manifest and invokes tools via
// POST /api/mcp.  Designed to be injected into openaiProvider so the AI
// director can surface tools without changing its public API.

const getOrigin = () => {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  if (typeof process !== 'undefined' && process.env?.LIFESPEAK_BACKEND_ORIGIN) {
    return process.env.LIFESPEAK_BACKEND_ORIGIN;
  }
  return 'http://localhost:8080';
};
const BASE = '/api/mcp';

let _manifest = null;
let _manifestPromise = null;

function maskAuthHeaders(headers = {}) {
  const masked = {};
  const re = /authorization|api[-_]?key|x-api-key|proxy-authorization/i;
  for (const [k, v] of Object.entries(headers)) {
    if (re.test(k)) {
      const s = String(v);
      masked[k] = s.length > 8 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '***';
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

function maskKeyInUrl(u) {
  return String(u).replace(/([?&](?:key|api_key|access_token)=)[^&]+/gi, '$1***MASKED***');
}

function toCurl({ url, method = 'GET', headers = {}, body }) {
  const parts = [`curl -X ${method} '${maskKeyInUrl(url)}'`];
  for (const [k, v] of Object.entries(maskAuthHeaders(headers))) {
    parts.push(`-H '${k}: ${v}'`);
  }
  if (body !== undefined) {
    const b = typeof body === 'string' ? body : JSON.stringify(body);
    parts.push(`--data-raw '${b.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(' \\n  ');
}

function logRequest({ action, url, method = 'GET', headers = {}, body }) {
  console.log(`[mcp:${action}] ${method} ${maskKeyInUrl(url)}`);
  console.log('  headers:', maskAuthHeaders(headers));
  if (body !== undefined) {
    console.log('  body:', typeof body === 'string' ? body : JSON.stringify(body));
  }
  console.log(`  curl: ${toCurl({ url, method, headers, body })}`);
}

function logResponse({ action, status, body }) {
  console.log(`[mcp:${action}] response status=${status}`);
  if (body !== undefined) {
    console.log('  body:', typeof body === 'string' ? body : JSON.stringify(body));
  }
}

export function _resetMcpClientForTests() {
  _manifest = null;
  _manifestPromise = null;
}

export async function fetchToolsManifest({ fetchImpl = fetch } = {}) {
  if (_manifest) return _manifest;
  _manifestPromise ||= (async () => {
    const url = `${getOrigin()}${BASE}/tools`;
    logRequest({ action: 'tools.list', url, method: 'GET', headers: {} });
    try {
      const res = await fetchImpl(url, { method: 'GET' });
      const body = await res.json().catch(() => ({ tools: [] }));
      logResponse({ action: 'tools.list', status: res.status, body });
      if (!res.ok || !Array.isArray(body?.tools)) return { tools: [] };
      return body;
    } catch (e) {
      logResponse({ action: 'tools.list', status: 0, body: String(e?.message || e) });
      return { tools: [] };
    }
  })();
  try {
    _manifest = await _manifestPromise;
  } finally {
    // reset promise so future callers can retry if the first attempt failed
    _manifestPromise = null;
  }
  return _manifest;
}

export async function invokeTool({ toolId, args }, { fetchImpl = fetch } = {}) {
  const url = `${getOrigin()}${BASE}`;
  const headers = { 'content-type': 'application/json' };
  const body = {
    id: `mcp-${Date.now()}`,
    method: 'tools.invoke',
    params: { tool: toolId, args },
  };
  logRequest({ action: 'invoke', url, method: 'POST', headers, body });
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    logResponse({ action: 'invoke', status: 0, body: String(e?.message || e) });
    throw new Error(`mcp invoke network: ${String(e?.message || e)}`);
  }
  const parsed = await res.json().catch(() => ({ error: `non-json status ${res.status}` }));
  logResponse({ action: 'invoke', status: res.status, body: parsed });
  return parsed;
}
