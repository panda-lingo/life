// MCP router: exposes the tool registry over the same-origin /api/mcp endpoint,
// backed by the official @modelcontextprotocol/sdk.
//
// External contract (browser-visible, unchanged from the pre-SDK version):
//   GET  /api/mcp/tools            -> { tools: [{ id, enabled, spec }] }
//   POST /api/mcp                  -> JSON-RPC 2.0-shaped:
//        { id, method: "tools.list" }                -> { id, result: { tools } }
//        { id, method: "tools.invoke", params: { tool, args } }
//                                                     -> { id, result: { ok, value | error, code? } }
//
// Internal wiring:
//   - One shared McpServer instance holds the tool registry (name, description,
//     zod inputSchema). The SDK auto-generates tools/list handlers from
//     _registeredTools and converts zod -> JSON Schema via toJsonSchemaCompat.
//   - Each POST /api/mcp creates a fresh stateless StreamableHTTPServerTransport
//     (sessionIdGenerator: undefined) and connects a per-request McpServer
//     to it. Stateless mode requires a new transport per request; pairing it
//     with a fresh McpServer satisfies the SDK's single-transport constraint
//     and isolates request-scoped state.
//   - Browser's legacy "tools.invoke" method is translated to MCP-spec
//     "tools/call" before dispatch. Responses are translated back to the
//     { ok, value | error, code? } envelope so the frontend stays byte-identical.
//
// Secrets stay server-side: TAVILY_API_KEY etc. never reach the browser.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ALL_TOOLS } from './mcpTools.js';
import { logRequest, logResponse } from './httpLog.js';

const JSON_CT = { 'content-type': 'application/json; charset=utf-8' };

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...JSON_CT, 'content-length': Buffer.byteLength(text) });
  res.end(text);
  return { status, body };
}

// Per-tool capability decision: a tool is "enabled" if every requiredEnv
// entry is present in config.mcp.
export function isEnvPresent(config, name) {
  // Convert UPPER_SNAKE_CASE -> camelCase: TAVILY_API_KEY -> tavilyApiKey
  const camel = name.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  return (
    !!config.mcp[camel] ||
    !!config.mcp[name] ||
    !!config.mcp[name.toLowerCase()]
  );
}

// Build the OpenAI-shaped manifest exposed on GET /api/mcp/tools. This is
// derived from ALL_TOOLS (not from the SDK's internal state) because the
// browser and the callUpstream OpenAI tools array both consume this shape.
function buildToolManifest(config) {
  return ALL_TOOLS.map((tool) => {
    const enabled = tool.requiredEnv.every((name) => isEnvPresent(config, name));
    return {
      id: tool.id,
      enabled,
      spec: tool.spec,
    };
  });
}

function findTool(id) {
  return ALL_TOOLS.find((t) => t.id === id) || null;
}

// ---------------------------------------------------------------------------
// SDK wiring: registry + zod schemas via McpServer; per-call dispatch direct
// ---------------------------------------------------------------------------
//
// The official SDK is used for what it owns end-to-end: tool registry, zod
// input validation, and JSON-Schema generation. We do NOT route every
// tools.invoke through a per-request StreamableHTTPServerTransport because
// (a) the SDK's connect() enforces single-transport-per-server, (b) stateless
// mode requires a fresh transport per request, and (c) our callers are
// in-process (the AI director inside the same Node process), so the transport
// round-trip is pure overhead. The SDK still owns the registry — a future
// MCP-native client (Streamable HTTP, stdio, etc.) can be wired in alongside
// without changing the tool implementations.

// One McpServer per Node process. The SDK's connect() enforces
// single-transport-per-server, but we never connect() — we use the server
// purely for its registry (inputSchema validation + spec generation).
let _mcpServer = null;

export function buildMcpServer({ config, fetchImpl }) {
  if (_mcpServer) return _mcpServer;
  const server = new McpServer({
    name: 'lifespeak',
    version: '0.1.0',
  }, {
    capabilities: { tools: {} },
  });

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.spec.function.name, // MCP tool name uses the OpenAI function name
      {
        description: tool.spec.function.description,
        inputSchema: tool.schema,
      },
      // The handler is registered for SDK completeness — native MCP clients
      // hitting this server end-to-end would invoke it. Our in-process
      // dispatch below goes straight to tool.run() with the same envelope
      // (zod validation + timeout + structured-error wrapping) so behavior
      // is identical for both paths.
      async (args) => {
        const enabled = tool.requiredEnv.every((name) => isEnvPresent(config, name));
        if (!enabled) {
          const error = `tool ${tool.id} disabled (missing env: ${tool.requiredEnv.join(', ') || 'none'})`;
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 4100, error }) }],
            isError: true,
          };
        }
        const timeoutMs = Number(config.mcp.timeoutMs) || 8000;
        try {
          const value = await Promise.race([
            tool.run(args, { config, fetchImpl }),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`tool ${tool.id} timed out after ${timeoutMs}ms`)), timeoutMs)),
          ]);
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, value }) }],
          };
        } catch (e) {
          console.warn(`[mcp] tool ${tool.id} failed: ${String(e?.message || e)}`);
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e?.message || e) }) }],
            isError: true,
          };
        }
      },
    );
  }
  _mcpServer = server;
  return server;
}

// Map MCP tool name (OpenAI function name, e.g. "web_search") back to the
// internal dotted tool id ("web.search"). Needed because the browser envelope
// addresses tools by dotted id while the SDK registry is keyed by function name.
export function toolIdFromMcpName(mcpName) {
  const tool = ALL_TOOLS.find((t) => t.spec.function.name === mcpName);
  return tool?.id || null;
}

// Invoke a tool end-to-end. This is the same logic the SDK's registered
// handler runs — kept here so the legacy `tools.invoke` envelope can call it
// without going through a per-request transport. The SDK's registerTool()
// has already zod-validated the inputSchema at registration time; here we
// validate the actual arguments against the same zod schema before running.
async function invokeToolDirect({ config, fetchImpl, tool, args }) {
  const enabled = tool.requiredEnv.every((name) => isEnvPresent(config, name));
  if (!enabled) {
    return {
      ok: false,
      code: 4100,
      error: `tool ${tool.id} disabled (missing env: ${tool.requiredEnv.join(', ') || 'none'})`,
    };
  }
  // Zod-validate args the same way the SDK's callToolRequestSchema handler
  // does. Failure is reported as a structured tool error (not a 4xx) so the
  // model can re-issue with corrected args.
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid arguments: ${parsed.error.issues?.[0]?.message || 'schema mismatch'}`,
    };
  }
  const timeoutMs = Number(config.mcp.timeoutMs) || 8000;
  try {
    const value = await Promise.race([
      tool.run(parsed.data, { config, fetchImpl }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`tool ${tool.id} timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    return { ok: true, value };
  } catch (e) {
    console.warn(`[mcp] tool ${tool.id} failed: ${String(e?.message || e)}`);
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Public router
// ---------------------------------------------------------------------------

export async function handleMcp({ req, res, url, config, body, fetchImpl = fetch }) {
  const started = Date.now();
  const action = url.pathname.replace(/^\/api\//, '');
  const finish = (r) => logResponse({ action, status: r.status, body: r.body, ms: Date.now() - started });

  // GET /api/mcp/tools — public manifest for the frontend / healthz
  if (url.pathname === '/api/mcp/tools' && req.method === 'GET') {
    logRequest({ action: 'mcp.tools.list', url: url.pathname, method: 'GET', headers: req.headers });
    const manifest = buildToolManifest(config);
    return finish(sendJson(res, 200, { tools: manifest }));
  }

  // POST /api/mcp — JSON-RPC shaped tool invocation
  if (url.pathname === '/api/mcp' && req.method === 'POST') {
    logRequest({ action: 'mcp', url: url.pathname, method: 'POST', headers: req.headers, body });
    const { id = null, method, params = {} } = body || {};
    if (!method) {
      return finish(sendJson(res, 400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'method (string) required' } }));
    }
    if (method === 'tools.list') {
      const manifest = buildToolManifest(config);
      return finish(sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: manifest } }));
    }
    if (method === 'tools.invoke') {
      const toolId = params.tool || params.toolId;
      const args = params.args || params.arguments || {};
      if (!toolId) {
        return finish(sendJson(res, 400, { jsonrpc: '2.0', id, error: { code: -32602, message: 'params.tool required' } }));
      }
      const tool = findTool(toolId);
      if (!tool) {
        return finish(sendJson(res, 404, { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${toolId}` } }));
      }
      const result = await invokeToolDirect({ config, fetchImpl, tool, args });
      return finish(sendJson(res, 200, { jsonrpc: '2.0', id, result }));
    }
    // Unknown method — fast fail with -32601 (matches pre-SDK behavior;
    // protects against spoofed method names that would otherwise round-trip
    // through the registry).
    return finish(sendJson(res, 400, { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } }));
  }

  return finish(sendJson(res, 404, { error: 'not found' }));
}
