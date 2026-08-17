// HTTP request/response logging with auth masking — the server-side half of
// the project constraint ("all http request/response should log url, action,
// header, body, request format as curl cmd, auth info should be mask").
// Mirrors the masking rules in src/ai/openaiProvider.js.

const SENSITIVE_HEADER = /authorization|api[-_]?key|x-api-key|proxy-authorization|cookie|set-cookie/i;
const SENSITIVE_FIELD = /api[-_]?key|apikey|token|secret|password|authorization/i;

export function maskValue(v) {
  const s = String(v);
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '***';
}

export function maskAuthHeaders(headers = {}) {
  const masked = {};
  for (const [k, v] of Object.entries(headers)) {
    masked[k] = SENSITIVE_HEADER.test(k) ? maskValue(v) : v;
  }
  return masked;
}

// Deep-masks sensitive fields in a parsed-JSON-able body. Returns a new
// structure; never mutates the caller's object.
export function maskBody(body) {
  if (body === null || body === undefined) return body;
  if (Array.isArray(body)) return body.map(maskBody);
  if (typeof body === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(body)) {
      out[k] = SENSITIVE_FIELD.test(k) && typeof v === 'string' ? maskValue(v) : maskBody(v);
    }
    return out;
  }
  return body;
}

export function maskKeyInUrl(u) {
  return String(u).replace(/([?&](?:key|api_key|access_token)=)[^&]+/gi, '$1***MASKED***');
}

export function toCurl({ url, method = 'GET', headers = {}, body }) {
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

function fmtBody(body) {
  if (body === undefined) return undefined;
  if (typeof body === 'string') {
    // Bodies that arrived as raw strings may contain secrets in JSON form;
    // try to parse+mask, else truncate long blobs (e.g. data URLs).
    try {
      return JSON.stringify(maskBody(JSON.parse(body)));
    } catch {
      return body.length > 512 ? `${body.slice(0, 512)}…[${body.length} chars]` : body;
    }
  }
  return JSON.stringify(maskBody(body));
}

export function logRequest({ action, url, method = 'GET', headers = {}, body }) {
  console.log(`[server:${action}] ${method} ${maskKeyInUrl(url)}`);
  console.log('  headers:', maskAuthHeaders(headers));
  const b = fmtBody(body);
  if (b !== undefined) console.log('  body:', b);
  console.log(`  curl: ${toCurl({ url, method, headers, body })}`);
}

export function logResponse({ action, status, body, ms }) {
  const timing = ms === undefined ? '' : ` in ${Math.round(ms)}ms`;
  console.log(`[server:${action}] response status=${status}${timing}`);
  const b = fmtBody(body);
  if (b !== undefined) console.log('  body:', b);
}
