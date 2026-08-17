// /api/* request handlers. Pure of transport concerns: each handler receives
// (req, res, ctx) where ctx = { config, events, fetchImpl } so tests inject
// fakes. Every handler logs request + response via httpLog (masked).

import { logRequest, logResponse } from './httpLog.js';

const JSON_CT = { 'content-type': 'application/json; charset=utf-8' };

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...JSON_CT, 'content-length': Buffer.byteLength(text) });
  res.end(text);
  return { status, body };
}

// Envelope-preserving JSON body reader with a byte cap. node:http gives us
// a stream; we buffer up to `limit` and reject past it.
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export async function handleApi({ req, res, url, config, events, fetchImpl = fetch }) {
  const path = url.pathname;
  const started = Date.now();
  const action = path.replace(/^\/api\//, '');

  const finish = (r) => logResponse({ action, status: r.status, body: r.body, ms: Date.now() - started });

  if (path === '/api/healthz' && req.method === 'GET') {
    logRequest({ action: 'healthz', url: path, method: 'GET', headers: req.headers });
    return finish(sendJson(res, 200, {
      ok: true,
      ai: config.ai.configured,
      maps: !!config.maps.apiKey,
    }));
  }

  if (path === '/api/maps/config' && req.method === 'GET') {
    logRequest({ action: 'maps/config', url: path, method: 'GET', headers: req.headers });
    if (!config.maps.apiKey) {
      return finish(sendJson(res, 404, { error: 'maps not configured' }));
    }
    // The key goes over the wire by design (Maps JS API is a client-side SDK);
    // logResponse masks it via the apiKey field rule.
    return finish(sendJson(res, 200, {
      apiKey: config.maps.apiKey,
      ...(config.maps.mapId ? { mapId: config.maps.mapId } : {}),
    }));
  }

  if (path === '/api/ai/complete' && req.method === 'POST') {
    const body = await readBody(req, config.aiBodyLimit);
    logRequest({ action: 'ai/complete', url: path, method: 'POST', headers: req.headers, body });
    if (!config.ai.configured) {
      return finish(sendJson(res, 503, { error: 'ai not configured' }));
    }
    const upstream = await callUpstream({ config, body, fetchImpl });
    return finish(sendJson(res, upstream.status, upstream.body));
  }

  if (path === '/api/events' && req.method === 'POST') {
    const body = await readBody(req, config.eventsBodyLimit);
    const list = Array.isArray(body?.events) ? body.events : null;
    logRequest({ action: 'events.append', url: path, method: 'POST', headers: req.headers,
      body: list ? { events: `[${list.length} events]` } : body });
    if (!list) {
      return finish(sendJson(res, 400, { error: 'body must be {events: [...] }' }));
    }
    const { stored, deduped } = events.append(list);
    return finish(sendJson(res, 200, { accepted: stored, deduped, total: list.length }));
  }

  if (path === '/api/events' && req.method === 'GET') {
    const session = url.searchParams.get('session');
    logRequest({ action: 'events.list', url: url.toString(), method: 'GET', headers: req.headers });
    const out = events.list({ session });
    return finish(sendJson(res, 200, { events: out }));
  }

  return finish(sendJson(res, 404, { error: 'not found' }));
}

async function callUpstream({ config, body, fetchImpl }) {
  const { prompt, image } = body || {};
  if (typeof prompt !== 'string' || !prompt) {
    return { status: 400, body: { error: 'prompt (string) required' } };
  }

  // Re-split the director's assembled prompt the same way
  // src/ai/openaiProvider.js's openaiAsDirector does, so the system part
  // rides the chat-completions system channel upstream.
  const raw = String(prompt);
  const sysMatch = raw.match(/^([\s\S]*?)\n\nCONTEXT \(JSON\):/);
  const system = sysMatch ? sysMatch[1] : null;

  const userContent = [{ type: 'text', text: raw }];
  if (image) {
    const url = String(image).startsWith('data:') ? String(image) : `data:image/png;base64,${image}`;
    userContent.push({ type: 'image_url', image_url: { url } });
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userContent });

  const upstreamUrl = `${config.ai.baseURL}/chat/completions`;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.ai.apiKey}`,
  };
  const upstreamBody = {
    model: config.ai.model,
    messages,
    response_format: { type: 'json_object' },
    max_tokens: Number(body.maxTokens) || 1024,
    temperature: 0.4,
  };
  const reqStarted = Date.now();
  logRequest({ action: 'ai.upstream', url: upstreamUrl, method: 'POST', headers, body: upstreamBody });

  let res;
  try {
    res = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    logResponse({ action: 'ai.upstream', status: 0, body: { error: String(e?.message || e) }, ms: Date.now() - reqStarted });
    return { status: 502, body: { error: `upstream unreachable: ${String(e?.message || e)}` } };
  }
  let parsed;
  const text = await res.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  logResponse({ action: 'ai.upstream', status: res.status, body: parsed, ms: Date.now() - reqStarted });

  if (!res.ok) {
    // Propagate the upstream failure; the frontend provider treats non-ok
    // as "real provider failed" and (for 503 only) falls back to mock.
    return { status: res.status, body: { error: parsed?.error?.message || `upstream ${res.status}` } };
  }
  const completion = parsed?.choices?.[0]?.message?.content ?? '';
  return { status: 200, body: { text: completion } };
}
