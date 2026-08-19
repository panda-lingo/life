// Server-side tool implementations for the MCP layer.
// Each tool is a self-contained module exporting:
//   - spec: OpenAI-compatible function-calling declaration
//   - schema: zod inputSchema (for @modelcontextprotocol/sdk registerTool)
//   - requiredEnv: list of env vars needed to activate (empty = always on)
//   - run(args, ctx): async implementation returning an object or throwing
//
// Two schema shapes live side-by-side on purpose: the OpenAI chat-completions
// `tools` array still wants raw JSON-Schema (callUpstream in api.js forwards
// `spec` directly), while the SDK's McpServer.registerTool wants zod (the
// router calls zod-to-JSON-Schema internally via toJsonSchemaCompat).

import { z } from 'zod';
import { logRequest, logResponse } from './httpLog.js';

// ---------------------------------------------------------------------------
// 1. web.search — Search the web for headlines, facts, places, or news
// Compatible with the Tavily search endpoint (or similar HTTP gateways).
// When TAVILY_API_KEY is unset, run() throws an unconfigured error; the router
// falls back to mock results in test/dev mode.
// ---------------------------------------------------------------------------
export const webSearchTool = {
  id: 'web.search',
  requiredEnv: ['TAVILY_API_KEY'],
  spec: {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for real-world information, current news, local facts, or recent events to incorporate into game dialogue or context.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to look up (e.g. "latest tech news London", "best coffee shop Soho")',
          },
          max_results: {
            type: 'number',
            description: 'Number of results to return (1-5, default: 3)',
          },
        },
        required: ['query'],
      },
    },
  },
  // zod schema for the official @modelcontextprotocol/sdk (server.registerTool).
  // Kept in sync with `spec.function.parameters` above; the SDK's toJsonSchemaCompat
  // derives the wire format from this.
  schema: z.object({
    query: z.string().min(1).describe('The search query to look up (e.g. "latest tech news London", "best coffee shop Soho")'),
    max_results: z.number().int().min(1).max(5).optional()
      .describe('Number of results to return (1-5, default: 3)'),
  }),
  async run({ query, max_results = 3 }, { config, fetchImpl = fetch } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('query (string) required');
    const limit = Math.max(1, Math.min(5, Number(max_results) || 3));

    const apiKey = config?.mcp?.tavilyApiKey;
    if (!apiKey) {
      throw new Error('TAVILY_API_KEY not configured on server');
    }

    const url = 'https://api.tavily.com/search';
    const body = {
      api_key: apiKey,
      query: q,
      max_results: limit,
      search_depth: 'basic',
      include_answer: false,
    };
    const headers = { 'content-type': 'application/json' };

    const reqStarted = Date.now();
    logRequest({ action: 'mcp.webSearch', url, method: 'POST', headers, body });

    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      logResponse({ action: 'mcp.webSearch', status: 0, body: { error: String(e?.message || e) }, ms: Date.now() - reqStarted });
      throw new Error(`web.search gateway unreachable: ${String(e?.message || e)}`);
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 200) };
    }
    logResponse({ action: 'mcp.webSearch', status: res.status, body: parsed, ms: Date.now() - reqStarted });

    if (!res.ok) {
      throw new Error(parsed?.error || `web.search upstream ${res.status}`);
    }

    // Strip large blobs, limit text lengths per result
    const results = (parsed.results || []).slice(0, limit).map((r) => ({
      title: (r.title || '').slice(0, 120),
      url: (r.url || '').slice(0, 200),
      content: (r.content || '').slice(0, 300),
    }));

    return { query: q, results };
  },
  mockRun({ query, max_results = 3 }) {
    const q = String(query || '').trim();
    return {
      query: q,
      results: [
        {
          title: `Local updates: ${q}`,
          url: 'https://example.com/news/1',
          content: `Breaking report on ${q}: community discussions and city updates show positive momentum.`,
        },
        {
          title: `${q} overview`,
          url: 'https://example.com/facts/2',
          content: `Everything you need to know about ${q}, including practical tips and background.`,
        },
      ].slice(0, Number(max_results) || 2),
    };
  },
};

// ---------------------------------------------------------------------------
// 2. web.fetch — Extract textual summary of a specific URL
// ---------------------------------------------------------------------------
export const webFetchTool = {
  id: 'web.fetch',
  requiredEnv: ['TAVILY_API_KEY'],
  spec: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch and extract readable text from a URL to get detailed context on an article or web page.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch and read',
          },
        },
        required: ['url'],
      },
    },
  },
  schema: z.object({
    url: z.string().url().describe('The URL to fetch and read'),
  }),
  async run({ url }, { config, fetchImpl = fetch } = {}) {
    const targetUrl = String(url || '').trim();
    if (!targetUrl) throw new Error('url (string) required');

    const apiKey = config?.mcp?.tavilyApiKey;
    if (!apiKey) {
      throw new Error('TAVILY_API_KEY not configured on server');
    }

    const endpoint = 'https://api.tavily.com/extract';
    const body = {
      api_key: apiKey,
      urls: [targetUrl],
    };
    const headers = { 'content-type': 'application/json' };

    const reqStarted = Date.now();
    logRequest({ action: 'mcp.webFetch', url: endpoint, method: 'POST', headers, body });

    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      logResponse({ action: 'mcp.webFetch', status: 0, body: { error: String(e?.message || e) }, ms: Date.now() - reqStarted });
      throw new Error(`web.fetch gateway unreachable: ${String(e?.message || e)}`);
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 200) };
    }
    logResponse({ action: 'mcp.webFetch', status: res.status, body: parsed, ms: Date.now() - reqStarted });

    if (!res.ok) {
      throw new Error(parsed?.error || `web.fetch upstream ${res.status}`);
    }

    const first = (parsed.results || [])[0] || {};
    return {
      url: targetUrl,
      rawContent: (first.rawContent || '').slice(0, 1000),
    };
  },
  mockRun({ url }) {
    return {
      url: String(url || ''),
      rawContent: `Mock extracted text for ${url}: Details, key points, and factual narrative for use in the game.`,
    };
  },
};

// ---------------------------------------------------------------------------
// 3. fx.rate — Real-world currency exchange rates (works keyless / offline)
// ---------------------------------------------------------------------------
export const fxRateTool = {
  id: 'fx.rate',
  requiredEnv: [], // Always available
  spec: {
    type: 'function',
    function: {
      name: 'fx_rate',
      description: 'Get current foreign exchange rates between major currencies for market/travel contexts in the game.',
      parameters: {
        type: 'object',
        properties: {
          base: {
            type: 'string',
            description: 'Base currency code, e.g. USD, EUR, GBP',
          },
          target: {
            type: 'string',
            description: 'Target currency code, e.g. EUR, GBP, JPY',
          },
        },
        required: ['base', 'target'],
      },
    },
  },
  schema: z.object({
    base: z.string().length(3).describe('Base currency code, e.g. USD, EUR, GBP'),
    target: z.string().length(3).describe('Target currency code, e.g. EUR, GBP, JPY'),
  }),
  async run({ base, target }, { fetchImpl = fetch } = {}) {
    const b = String(base || 'USD').toUpperCase();
    const t = String(target || 'EUR').toUpperCase();

    // Keyless public exchange rate API
    const url = `https://open.er-api.com/v6/latest/${b}`;
    const reqStarted = Date.now();
    logRequest({ action: 'mcp.fxRate', url, method: 'GET' });

    let res;
    try {
      res = await fetchImpl(url, { method: 'GET' });
    } catch (e) {
      logResponse({ action: 'mcp.fxRate', status: 0, body: { error: String(e?.message || e) }, ms: Date.now() - reqStarted });
      // Degrade to mock rates on network error
      return this.mockRun({ base: b, target: t });
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
    logResponse({ action: 'mcp.fxRate', status: res.status, body: parsed, ms: Date.now() - reqStarted });

    if (!res.ok || !parsed.rates) {
      return this.mockRun({ base: b, target: t });
    }

    const rate = parsed.rates[t];
    if (rate === undefined) {
      throw new Error(`Unknown target currency: ${t}`);
    }

    return {
      base: b,
      target: t,
      rate,
      time_last_update_utc: parsed.time_last_update_utc || new Date().toUTCString(),
    };
  },
  mockRun({ base, target }) {
    const b = String(base || 'USD').toUpperCase();
    const t = String(target || 'EUR').toUpperCase();
    const mockRates = {
      USD: { EUR: 0.92, GBP: 0.79, JPY: 155.0, CAD: 1.36, USD: 1.0 },
      EUR: { USD: 1.09, GBP: 0.86, JPY: 168.0, EUR: 1.0 },
      GBP: { USD: 1.27, EUR: 1.16, JPY: 196.0, GBP: 1.0 },
    };
    const rate = mockRates[b]?.[t] ?? 1.0;
    return {
      base: b,
      target: t,
      rate,
      mock: true,
      time_last_update_utc: '2026-08-19 00:00:00 UTC',
    };
  },
};

// All available tools in the registry
export const ALL_TOOLS = [webSearchTool, webFetchTool, fxRateTool];
