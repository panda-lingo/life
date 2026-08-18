# Architecture — LifeSpeak

## System overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     Browser (index.html)                          │
│                    (ES modules, no build)                         │
└────────────────────────┬─────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
  ┌──────────┐    ┌──────────┐    ┌──────────────┐
  │  engine/ │    │   ui/    │    │    game/     │
  │ three.js │◄───┤   hud    │◄───┤   loop.js    │
  │ renderer │    │  DOM     │    │  orchestrator│
  └────▲─────┘    └────▲─────┘    └──────┬───────┘
       │               │                  │
       │               │         ┌────────┴────────┐
       │               │         ▼                 ▼
       │               │   ┌──────────┐      ┌──────────┐
       │               └───┤  speech  │      │   data   │
       │                   │ STT/TTS  │      │ eventlog │──► IndexedDB
       │                   └──────────┘      └────┬─────┘
       │                                          │ mirror (async,
       │                                          │  offline-queued)
       ├────────────── AI director (text+image → text)  │
       │           ┌──────────┐                       │
       │           │    ai/   │   provider chain:     │
       │           │ director │   backend ► window    │
       │           └────┬─────┘   ► browser-direct ►  │
       │                │         mock                │
       │                ▼                             │
       └────────────── Google Maps explore mode        │
                   ┌──────────┐                        │
                   │  gmaps/  │  key resolution:       │
                   │ maps.js  │  backend ► window ►    │
                   └────┬─────┘  env ► mock            │
                        │                                │
────────────────────────┼────────────────────────────────┼─────────
                        │  HTTPS (same origin)           ▼
┌───────────────────────▼─────────────────────────────────────────┐
│                 server/server.js (Node, zero deps)               │
│  single runtime: statics + API (replaces the static-only image)  │
│  POST /api/ai/complete   AI proxy — IMAGE_TEXT_* creds here only │
│  GET  /api/maps/config   Google Maps key — GOOGLE_MAPS_* here    │
│  POST/GET /api/events    user event log — JSONL under DATA_DIR   │
│  GET  /api/healthz                                               │
│  Every request/response logged as a masked curl command.         │
└──────────────────────────────────────────────────────────────────┘
```

## Backend boundary (secrets + user data server-side)

The browser **never sees a secret**. The desired end state is a data-driven
mapping from capability to endpoint, all served by the same Node runtime that
serves the static game:

| Capability | Endpoint | Server-side env | Browser fallback when backend absent |
|---|---|---|---|
| AI completion (text+image → text) | `POST /api/ai/complete` | `IMAGE_TEXT_API_FORMAT/BASE_URL/MODEL/API_KEY` | `window.LIFESPEAK_AI` → browser-direct OpenAI (`__LIFESPEAK_AI_CONFIG`) → mock |
| Google Maps bootstrap | `GET /api/maps/config` | `GOOGLE_MAPS_API_KEY`, optional `GOOGLE_MAPS_MAP_ID` | `window.__LIFESPEAK_GOOGLE_MAPS_CONFIG` → env → mock |
| User data (event log) | `POST /api/events` (batch), `GET /api/events?session=` | `DATA_DIR` (default `<repo>/data`) | IndexedDB remains source of truth; events queued and retried |

Constraints:

- **Same origin**: the frontend calls relative `/api/...` paths — no CORS
  surface, no exposed ports beyond the game container's 8080.
- **No keys in the page**: when the backend is healthy, `director.js` never
  constructs a browser-direct OpenAI client and `maps.js` never reads a
  page-injected key. The `window.__LIFESPEAK_*_CONFIG` shims remain as
  explicit dev/offline overrides only.
- **Offline-first user data**: `eventlog.js` writes to IndexedDB first
  (unchanged source of truth) and mirrors each event to `POST /api/events`
  asynchronously. Failures are queued in-memory and retried with backoff;
  a final `sendBeacon` flush runs on `pagehide`. The server appends to a
  per-day JSONL file under `DATA_DIR`, deduped by event `id`.
- **Observability**: the server logs every request and response (url, action,
  headers, body) as a curl command with auth headers masked — the same
  standard the browser-side providers already use.
- **Graceful degradation**: with no `IMAGE_TEXT_*` configured the AI endpoint
  answers 503 and the director falls back to the deterministic mock; with no
  `GOOGLE_MAPS_API_KEY` the maps endpoint answers 404 and explore mode runs
  the deterministic mock — the game always boots.

Two entry modes from the splash screen:

- **Start** — the classic scenario-graph game (Three.js engine, AI director picks beats).
- **Explore a real place** — Google Maps explorer (`startExplore`). The player
  searches real cafés/shops/parks nearby, picks one from the list, and the
  place is bridged into the scenario engine via `placeToBeat()` so the same
  dialogue/scoring pipeline runs against a real location.

## Data flow per dialogue turn

1. **Loop** asks AI director for the next beat (director picks from `eligibleBeats(worldState)`).
2. **Loop** asks AI composer for scene composition (kit + layout + props from manifest).
3. **Engine** renders the composition; **HUD** shows NPC framing line.
4. **Speech** listens (push-to-talk); interim transcript streams to HUD; final transcript is emitted.
5. **AI scorer** returns rubric + errors + better version; **learner model** updates (EMA); events appended.
6. **Loop** sends transcript to **NPC turn**; NPC replies, mood and world effects applied; events appended.
7. On beat end, **AI debrief** scores soft skills; events appended; learner model updates.
8. Player can **export JSONL** at any time for offline analysis.

## Constraints honored

- **AI provider**: only text + image in, text out. All calls in `src/ai/director.js` are `complete({prompt, image}) -> text`.
- **Offline analysis**: all state lives in IndexedDB event log; export is JSONL; analytics module is dependency-free.
- **Pre-generated assets**: kits/layouts/props are data (manifest.json); runtime AI only *selects* ids, never generates geometry.
- **PC + mobile**: touch-first HUD, capped DPR, no shadows, small geometry budget, Web Speech API with graceful fallbacks.
- **B1 → C1**: rubric is 4-dimension IELTS/Cambridge-aligned; TTS rate and prompt complexity scale with `cefrEstimate()`.

## Failure modes & fallbacks

| Component | Failure | Fallback |
|---|---|---|
| SpeechRecognition | unsupported / permission denied | text input field in HUD |
| SpeechRecognition | stuck recognizer (no `onstart`/`onerror` — headless/CI Chromium) | `createRecognizer` reports a synthetic `stuck` error after 2s; loop degrades to the same text input |
| SpeechRecognition | listen watchdog fires with no final transcript (silence/muted mic) | `manual-stop`/`timeout` outcomes degrade to the text input instead of re-listening forever |
| speechSynthesis | no voices, `synthesis-failed` error (headless/CI), or stalled engine (neither `onend` nor `onerror` fires) | `speak()` wires `onerror` to the same completion callback; the loop additionally races TTS against a rate-scaled watchdog proportional to text length, then continues with the timed pause |
| Backend server | down / unreachable (static hosting, offline) | director detects via `/api/healthz` and skips the server provider; maps falls back to window/env/mock; event mirroring queues and retries — game is fully playable |
| AI provider | network down / no key (server answers 503) | deterministic mock provider |
| Backend AI provider | 5xx mid-session (upstream gateway overload/EOF, server 502 "upstream unreachable") | `director.call()` catches the backend throw, logs a masked line with the provider name + `err.status`, and completes the turn with the mock for this call. No retry — retry multiplies pressure on a known-flaky upstream and the mock is deterministic & cheap. 4xx (prompt bug) still throws so the caller sees it |
| Google Maps | backend has key (200), real Places API returns ≥1 place | up to 10 real places; picker renders whatever count Google returns |
| Google Maps | no key (server answers 404) / script blocked / offline | deterministic mock (3 canned Soho places) |
| Google Maps | nearby search returns no places (ZERO_RESULTS / quota) | in-HUD "no places" message + `explore.empty` event; no dead-end picker |
| IndexedDB | quota exceeded | in-memory log + warning banner |
| WebGL | context lost | canvas pause + retry button |

## Module contracts

- `net/backend.js`: `getBackend()` (memoized health probe), `backendAvailable()`,
  `backendComplete({prompt,image}) -> text` (server AI proxy),
  `backendMapsConfig() -> {apiKey, mapId} | null`, `appendEvents(events)`,
  `beaconEvents(events)` (pagehide flush). Logs every call as a masked curl.
- `server/server.js` (+ `router.js`, `config.js`, `httpLog.js`,
  `eventStore.js`): Node zero-dep runtime serving statics and `/api/*`;
  the only place secrets are read. `createServer({config, root})` is
  dependency-injectable for tests.
- `eventlog.js`: `emit(type, payload)` (IndexedDB first, then async backend
  mirror with retry queue), `queryEvents()`, `exportJSONL()`,
  `downloadExport()`, `flushSyncQueue()` (exported for tests)
- `learnerModel.js`: pure functions, no I/O
- `speech.js`: `createRecognizer({onInterim,onFinal,onError})`, `speak(text, opts)`, `speechCapabilities()`
- `director.js`: five JSON-contract functions; the only file that talks to
  the AI provider. Provider order: backend server provider →
  `window.LIFESPEAK_AI` → browser-direct OpenAI → mock.
- `gmaps/maps.js`: `createExplorer(container) -> {mock, searchNearby, getDetails, dispose}`,
  `placeToBeat(place) -> scenario-beat shape`; the only file that talks to Google Maps.
  Key resolution order: backend `/api/maps/config` →
  `window.__LIFESPEAK_GOOGLE_MAPS_CONFIG` → `GOOGLE_MAPS_API_KEY`/`GOOGLE_MAPS_MAP_ID`
  env → deterministic mock.
- `engine.js`: `createEngine(container)`, `composeComposition(comp)`, `listKits()`
- `hud.js`: `renderHUD(update)`, `showChoice(options) -> Promise<choice>`,
  `showTextInput({placeholder})`, `showPlacePicker(places)`, `clearHUDOverlays()`
- `loop.js`: `startGame(container)` (classic 3D mode; lazy-imports `engine.js`)
  and `startExplore(container)` (maps mode; never loads three.js) — the only
  file that talks to every other module
