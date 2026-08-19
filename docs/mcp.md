# MCP (Model Context Protocol) — design note

Status: implemented and verified against the official
`@modelcontextprotocol/sdk` (server-side). The end state below is the
contract the implementation must satisfy.

## Desired end state (one paragraph)

The AI director, when it would benefit from real-world information (news,
weather, exchange rates, etc.), can call whitelisted **MCP tools** that run
on the backend with their own server-side credentials. The browser never
sees a tool API key; secrets live next to the existing `IMAGE_TEXT_*`
env block. Every call (browser → backend, backend → upstream) is logged as
a masked curl command. When no MCP tool is configured, or the upstream
fails, the director gracefully degrades: no tool calls, no broken
dialogue, no leaked secrets. The tool layer is purely additive to the
existing AI pipeline (`complete({ prompt, image }) -> text`); the
non-tool path is byte-identical to today's behavior.

## SDK adoption (v1.1 — current)

The server-side registry is implemented with the official
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
(Node-only package). The browser continues to use plain JSON-RPC 2.0
over fetch — there is no browser SDK entry in this project.

The adoption follows a **hybrid pattern**:

| Layer | What the SDK owns | What we own |
|---|---|---|
| Registry | `McpServer` singleton, `registerTool()` with zod input schemas | `ALL_TOOLS` manifest in `server/mcpTools.js` |
| Validation | zod `safeParse` via the registered `inputSchema` | same zod validation on the direct-call path |
| Invocation (browser) | — (no transport round-trip) | `invokeToolDirect()` — direct `tool.run()` with timeout |
| Invocation (future MCP client) | `StreamableHTTPServerTransport` + `server.connect()` | same handler (registered for completeness) |

**Why hybrid instead of pure SDK transport?** The SDK's
`connect()` enforces single-transport-per-server. Stateless mode
(`sessionIdGenerator: undefined`) requires a fresh transport per
request, and pairing it with a fresh `McpServer` per request is the
only safe pattern. But our only callers today are in-process (the
AI director inside the same Node process), so a transport round-trip
is pure overhead and adds a failure mode (SSE framing, stream
lifecycle) that we don't need. Using the SDK for registry + zod
validation + JSON-Schema generation gives us the spec compliance
without the transport complexity. A future MCP-native client
(Streamable HTTP, stdio, etc.) can be wired in alongside by adding
a transport — the tool implementations won't change.

### Two schema shapes, one source of truth

Each tool in `server/mcpTools.js` carries two schema shapes side-by-side:

- `spec` — OpenAI chat-completions JSON-Schema, forwarded verbatim to
  the upstream `tools: [...]` array in `callUpstream` (`server/api.js`).
- `schema` — zod `inputSchema`, registered with the SDK's
  `McpServer.registerTool()`. The SDK's internal `toJsonSchemaCompat`
  derives the wire format from this for native MCP clients.

The two shapes are intentionally redundant — they target two different
protocols. The zod schema is the runtime validator; the OpenAI spec is
what the model sees. Guard tests in `server/mcpRouter.test.mjs` pin
this contract so a future tool can't ship one without the other.

## Constraints (from CLAUDE.md / AGENTS.md)

- All AI provider calls route through `src/ai/director.js`. **No tool
  call may bypass that boundary.** This means the MCP client lives next
  to the provider, and the director decides when (and which) tools to
  attach to a `complete()` call.
- Secrets server-side only. Tool credentials are read by
  `server/config.js` alongside `IMAGE_TEXT_*` / `GOOGLE_MAPS_*`.
- Browser → backend is same-origin `/api/*`. The new endpoint is
  `POST /api/mcp`.
- HTTP logging: every request and response (browser + server side)
  logs url, action, headers, body, and a masked curl command.
- Offline-first: no tool configured → the director sees zero tools and
  behaves as before (deterministic mock fallback still works).
- Asset pipeline stays manifest-driven; no runtime asset synthesis.

## Data-driven mapping (the manifest)

Tools are declared once, in code, in `server/mcpTools.js`. The registry
is a pure data structure — adding a new tool means adding one entry to
the registry plus its implementation module; nothing else needs to
change. Each entry is:

```
{
  id: 'web.search',                 // stable dotted id the director references
  requiredEnv: ['TAVILY_API_KEY'],  // presence decides enabled
  spec: {                           // OpenAI chat-completions function spec
    type: 'function',
    function: {
      name: 'web_search',            // MCP tool name (used in SDK registry)
      description: '...',
      parameters: { ... },           // JSON Schema for the model
    },
  },
  schema: z.object({ ... }),        // zod inputSchema (registered with SDK)
  run: async (args, ctx) => object, // ctx = { config, fetchImpl }
  mockRun: (args) => object,        // deterministic offline fallback
}
```

The same registry is exposed two ways:

1. To the AI director — via the OpenAI-compatible `tools` field, sent
   in chat-completions requests. The director's prompt stays unaware
   of the toolset; `server/api.js` injects the tool schemas when
   constructing the upstream body and intercepts the model's tool-call
   responses (loop, max 3 rounds).
2. To the browser — via `GET /api/mcp/tools`, which returns the
   per-tool `{ id, enabled, spec }` shape. The frontend uses this to
   know whether the AI might call a tool at all.

### Naming note

The **MCP tool name** (e.g. `web_search`, `fx_rate`) is the
OpenAI function name — this is what the model sees and what the SDK
registry is keyed by. The **internal dotted id** (e.g. `web.search`,
`fx.rate`) is what the browser envelope addresses tools by. The two
are mapped in `mcpRouter.js` (`toolIdFromMcpName`). New tools must
provide both and keep them consistent.

## Endpoints

| Path | Method | Purpose |
|---|---|---|
| `/api/mcp` | POST | JSON-RPC 2.0: `{ id, method: 'tools.list' } -> { result: { tools } }` or `{ id, method: 'tools.invoke', params: { tool, args } } -> { result: { ok, value \| error, code? } }`. Tool calls go through zod validation + per-call timeout before execution. |
| `/api/mcp/tools` | GET | Public manifest for the frontend (same shape as `tools.list` result). |

Native MCP-spec method names (`tools/list`, `tools/call`) are
deliberately rejected on the browser-facing route — the legacy
envelope is the only browser contract. A future MCP-native client
can connect via `StreamableHTTPServerTransport` alongside.

## Director flow with tools

```
director.directNextScenario(ctx)        // or debriefScenario, directTrade
  -> backendProvider.complete({ prompt, tools: true })
       POST /api/ai/complete { prompt, tools: true }
         server/api.js: callUpstream with tools = [spec of each enabled tool]
           upstream chat-completions, with `tools: [...manifest]`
           model may reply with `tool_calls: [{ id, function: { name, arguments } }]`
           if tool_calls present:
             for each tool_call:
               invokeToolDirect({ tool, args })   // zod-validated, timeout-capped
               append tool message to thread
             send a SECOND chat-completions round with the tool results
           return the final assistant text
  -> JSON.parse(extractJSON(text))
```

The director's contract functions (`directNextScenario`, `npcTurn`,
`scoreUtterance`, etc.) are unchanged. Tool use is opt-in per call —
only `directNextScenario`, `debriefScenario`, and `directTrade` pass
`tools: true`. Latency-sensitive paths (`npcTurn`, `scoreUtterance`)
stay tool-free by design.

## Failure modes (degrade by default)

| Failure | Behavior |
|---|---|
| `GET /api/mcp/tools` returns empty enabled list (no env set) | director runs tool-less; behavior identical to today |
| Director attaches tools but model never calls one | identical to today's tool-less path |
| Director calls `/api/mcp` with bad args (zod mismatch) | tool returns `{ ok: false, error: 'invalid arguments: ...' }` to the model; the model can retry or proceed without it |
| `/api/mcp` 5xx's or times out | tool returns `{ ok: false, error: "..." }` to the model; mock fallback semantics still apply at the *director* level (5xx → mock for the whole turn, mirroring the existing `directNextScenario` / `npcTurn` resilience) |
| `/api/mcp` tool disabled at runtime | returns `{ error: 'tool disabled', code: 4100 }` to the model — non-fatal |
| Browser offline / backend unreachable | director.js's existing `probeBackend()` short-circuits; tools never attached |

## What ships in v1

Three tools, each with a mock fallback so the game stays testable in
CI without secrets:

| Tool id | MCP name | What it does | Required env |
|---|---|---|---|
| `web.search` | `web_search` | Headlines / facts for a query (Tavily-compatible shape) | `TAVILY_API_KEY` |
| `web.fetch` | `web_fetch` | Extract text from a single URL | `TAVILY_API_KEY` |
| `fx.rate` | `fx_rate` | Currency conversion (open.er-api.com, keyless) | none — works offline |

Each tool:

- Enforces a per-call timeout (configurable via `config.mcp.timeoutMs`,
  default 8s).
- Caps the returned payload size (e.g. `web.search` returns ≤ 5
  results, each trimmed to title + snippet + URL).
- Logs every upstream call as masked curl (reusing `server/httpLog.js`).
- Has a deterministic mock fallback used when the upstream is
  unreachable (so unit tests don't need real API keys).

## Test strategy

- **Unit** (Node, no network): `server/mcpRouter.test.mjs` covers
  the router, each tool's happy path + failure, payload cap, timeout,
  log masking, and the SDK-adoption contract (registry contents, zod
  schemas, legacy envelope shape). `src/ai/mcp.test.mjs` covers the
  client (function-call parsing, tool execution loop, mock fallback)
  using fake `fetchImpl`.
- **Integration** (Node, ephemeral port, fake upstream): round-trip
  one tool call through `handleApi` to a fake `fetchImpl` —
  `server/server.test.mjs`.
- **e2e** (Playwright): `tests/backend.spec.js` asserts
  `GET /api/mcp/tools` returns the expected enabled/disabled set, and
  drives a tool call through `POST /api/mcp` against the real server.

## In-game surfacing: the briefing card (v1.2)

Tool results would vanish the moment the model folds them into prose
unless the game keeps a copy. v1.2 makes tool use visible: every tool
the AI calls during a director turn is recorded, normalized into
**briefing items**, stored on the simulation world (`world.data`), and
rendered as a collapsible HUD card (`#hud-briefing`) so the player can
see *what real-world data the game is using*.

### Desired end state (one paragraph)

When a tool-enabled director call (`directNextScenario`, `debriefScenario`,
`directTrade`) makes the model invoke `web.search` / `web.fetch` /
`fx.rate`, the backend executes the tool and appends each invocation to a
`toolLog` array on the `/api/ai/complete` response. The frontend backend
provider unwraps `toolLog` and returns it beside the text; the director
returns `{ ...result, toolLog }` from tool-enabled calls only (the
latency-sensitive `npcTurn` / `scoreUtterance` / scene-composition calls
keep returning plain parsed JSON so the mock-provider contract is
unchanged). The loop reduces each tool-log entry through the pure
`briefingFromToolLog()` mapping into a capped `world.data` array via
`tick(world, { kind: 'setData', items })`, emits a `data.updated` event
with a world snapshot, and the HUD renders the briefing card above
`#hud-status` whenever `world.data` is non-empty. With no tools
configured, or when the model never calls one, `world.data` stays empty
and the card never renders — the game is byte-identical to the tool-less
path.

### Data-driven mapping: toolLog → briefing items

`src/sim/world.js` owns the pure mapping (data-driven: keyed by tool id):

| Tool | Item shape | Icon |
|---|---|---|
| `fx.rate` | `{ id: 'fx:BASE:TARGET', kind: 'fx', icon: '💱', title: 'BASE→TARGET rate', summary: '1 USD ≈ 0.92 EUR', source: 'open.er-api.com', ts }` | 💱 |
| `web.search` | one item per result: `{ id: 'news:<url-host>:<i>', kind: 'news', icon: '📰', title: result.title, summary: result.content, source: result.url, ts }` | 📰 |
| `web.fetch` | `{ id: 'web:<url-host>', kind: 'web', icon: '🌐', title: <url-host>, summary: rawContent excerpt, source: url, ts }` | 🌐 |

Rules:

- Only `{ ok: true }` tool-log entries produce items; failures are
  skipped (the model already saw the error).
- `world.data` is **capped at 12 items** (newest first); a re-fetched id
  replaces the older entry in place. This keeps the context JSON small
  and the card readable on a phone.
- `ts` is injected by the caller (loop) — `world.js` stays free of
  `Date.now()` per the pure-core constraint.
- Failed entries are still observable: the loop emits
  `mcp.tool.failed { tool, error }` events.

### Backend surface: `toolLog`

`POST /api/ai/complete` with `tools: true` now responds
`{ text, toolLog: [{ tool, args, ok, value? | error?, ms }] }`. `toolLog`
is present on every tool-enabled response (possibly an empty array) and
absent on tool-less responses. Tool secrets never appear in it: `value`
is the already-capped tool payload, and every entry is logged server-side
as masked curl via the existing `httpLog` rules.

### Dialogue grounding

`world.data` is included in the `CONTEXT (JSON)` of `npcTurn` (and
`directNextScenario` already sees the world) under the key
`briefing: [...]`. The `npcTurn` system prompt gains one rule: when
`briefing` is non-empty, the NPC *may* naturally reference at most one
relevant item ("did you see the dollar slipped?") — never more, and
never fabricated topics. `scoreUtterance` and composition contexts stay
briefing-free to keep payloads small.

### HUD card contract (`#hud-briefing`)

- Rendered by `renderHUD` whenever `state.world.data` is non-empty;
  removed (not hidden) when empty.
- A single collapsed pill line by default: `📰 <n> · 💱 <m> · <latest title>`.
  Tapping toggles an expanded list (≤ 5 visible rows, scrollable), each
  row `icon title — summary`, with a `data-briefing-kind` attribute per
  row for tests.
- Sits above `#hud-status` inside the existing HUD container, so it
  inherits the responsive fixed-bottom layout and is covered by the same
  desktop + mobile/redroid e2e viewports.
- Pure render: the card reflects `world.data`; it never fetches.

### Failure modes (additions to the table above)

| Failure | Behavior |
|---|---|
| Tool succeeds but payload shape unexpected | `briefingFromToolLog` yields `[]`; world unchanged |
| `toolLog` missing from backend response (old server) | director defaults to `[]`; loop skips `data.updated` |
| All tool calls in a turn fail | no `world.data` mutation; one `mcp.tool.failed` event per failure |
| Backend 5xx mid tool-loop | existing rule: whole turn degrades to mock (no toolLog) |

## Out of scope (v1)

- Bidirectional MCP streaming / SSE (we proxy a single round-trip;
  a future native client would use `StreamableHTTPServerTransport`).
- User-installed MCP servers. The registry is server-controlled; the
  browser cannot add tools.
- Image-aware tools (we keep the existing `image` channel separate).
- MCP resources, prompts, or completion — only `tools` capability is
  registered on the `McpServer`.