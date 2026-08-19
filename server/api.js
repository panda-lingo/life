// /api/* request handlers. Pure of transport concerns: each handler receives
// (req, res, ctx) where ctx = { config, events, fetchImpl } so tests inject
// fakes. Every handler logs request + response via httpLog (masked).

import { logRequest, logResponse } from './httpLog.js';
import { handleMcp, isEnvPresent } from './mcpRouter.js';
import { ALL_TOOLS } from './mcpTools.js';

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
    const tools = ['TAVILY_API_KEY'].filter((k) => isEnvPresent(config, k));
    return finish(sendJson(res, 200, {
      ok: true,
      ai: config.ai.configured,
      maps: !!config.maps.apiKey,
      mcp: tools.length > 0,
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

  if (path.startsWith('/api/mcp')) {
    const body = req.method === 'POST' ? await readBody(req, config.mcpBodyLimit) : undefined;
    logRequest({ action: 'mcp', url: url.toString(), method: req.method, headers: req.headers, body });
    return handleMcp({ req, res, url, config, body, fetchImpl });
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

  // MCP tools: when the caller wants tools and the backend has at least
  // one enabled tool, forward the spec to chat-completions. Disabled tools
  // are filtered out via buildToolManifest elsewhere; here we just trust
  // the boolean `wantTools` flag (the browser only sets it after a manifest
  // check, and for the direct-test path we filter server-side too).
  const wantTools = body.tools === true;
  const toolSpecs = wantTools
    ? ALL_TOOLS.filter((t) => t.requiredEnv.every((k) => isEnvPresent(config, k))).map((t) => t.spec)
    : [];

  const upstreamUrl = `${config.ai.baseURL}/chat/completions`;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${config.ai.apiKey}`,
  };

  async function postUpstream(msgs, withJson) {
    const upstreamBody = {
      model: config.ai.model,
      messages: msgs,
      ...(toolSpecs.length ? { tools: toolSpecs } : {}),
      ...(withJson && !toolSpecs.length ? { response_format: { type: 'json_object' } } : {}),
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
      return { ok: false, status: 502, error: `upstream unreachable: ${String(e?.message || e)}` };
    }
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    logResponse({ action: 'ai.upstream', status: res.status, body: parsed, ms: Date.now() - reqStarted });
    if (!res.ok) {
      return { ok: false, status: res.status, error: parsed?.error?.message || `upstream ${res.status}`, parsed };
    }
    return { ok: true, parsed };
  }

  let upstreamRes = await postUpstream(messages, true);
  if (!upstreamRes.ok) {
    return { status: upstreamRes.status, body: { error: upstreamRes.error } };
  }

  // Tool-call loop: when the model requests tools, dispatch each via
  // handleMcp's invocation path. Capped to avoid runaway recursion.
  const MAX_TOOL_ROUNDS = 3;
  let rounds = 0;
  while (
    upstreamRes.parsed?.choices?.[0]?.message?.tool_calls?.length &&
    rounds < MAX_TOOL_ROUNDS
  ) {
    rounds += 1;
    const assistantMsg = upstreamRes.parsed.choices[0].message;
    messages.push(assistantMsg);
    for (const call of assistantMsg.tool_calls) {
      const fnName = call.function?.name;
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(call.function?.arguments || '{}'); } catch { parsedArgs = {}; }
      const toolResult = await runMcpTool(config, fnName, parsedArgs);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(toolResult),
      });
    }
    upstreamRes = await postUpstream(messages, true);
    if (!upstreamRes.ok) {
      return { status: upstreamRes.status, body: { error: upstreamRes.error } };
    }
  }

  const completion = upstreamRes.parsed?.choices?.[0]?.message?.content ?? '';
  return { status: 200, body: { text: completion } };
}

// Server-side equivalent of src/ai/mcpClient.invokeTool. Runs the tool
// directly (the model never sees TAVILY_API_KEY etc.) and returns the
// structured result the chat-completions tool protocol expects.
async function runMcpTool(config, toolId, args) {
  const tool = ALL_TOOLS.find((t) => t.id === toolId);
  if (!tool) return { ok: false, error: `unknown tool: ${toolId}` };
  const missing = tool.requiredEnv.filter((k) => !isEnvPresent(config, k));
  if (missing.length) return { ok: false, error: `tool not enabled (missing: ${missing.join(',')})` };
  const timer = config.mcp.timeoutMs || 8000;
  try {
    const value = await Promise.race([
      Promise.resolve(tool.run(args, { config })),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`tool ${toolId} timed out after ${timer}ms`)), timer)),
    ]);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
