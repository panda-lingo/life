# Architecture — LifeSpeak

## System overview

```
┌─────────────────────────────────────────────────────────────┐
│                        index.html                           │
│                    (ES modules, no build)                   │
└────────────────────────┬────────────────────────────────────┘
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
       │                   │ STT/TTS  │      │ eventlog │
       │                   └──────────┘      │ learner  │
       │                                     │ model    │
       │                                     └────┬─────┘
       │                                          │
       │                              IndexedDB / JSONL export
       │
       ├────────────── AI director (text+image → text)
       │           ┌──────────┐
       │           │    ai/   │
       │           │ director │  ← mock provider by default
       │           │ provider │  ← real HTTP provider adapter
       │           └──────────┘
       │
       └────────────── Google Maps (real-world explore mode)
                   ┌──────────┐
                   │  gmaps/  │
                   │ maps.js  │  ← boundary: game never calls Google directly
                   └──────────┘  ← deterministic mock when no API key
```

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
| AI provider | network down / no key | deterministic mock provider |
| Google Maps | no key / script blocked / offline | deterministic mock (canned Soho places) |
| Google Maps | nearby search returns no places (ZERO_RESULTS / quota) | in-HUD "no places" message + `explore.empty` event; no dead-end picker |
| IndexedDB | quota exceeded | in-memory log + warning banner |
| WebGL | context lost | canvas pause + retry button |

## Module contracts

- `eventlog.js`: `emit(type, payload)`, `queryEvents()`, `exportJSONL()`, `downloadExport()`
- `learnerModel.js`: pure functions, no I/O
- `speech.js`: `createRecognizer({onInterim,onFinal,onError})`, `speak(text, opts)`, `speechCapabilities()`
- `director.js`: five JSON-contract functions; the only file that talks to the AI provider
- `gmaps/maps.js`: `createExplorer(container) -> {mock, searchNearby, getDetails, dispose}`,
  `placeToBeat(place) -> scenario-beat shape`; the only file that talks to Google Maps.
  Honors `GOOGLE_MAPS_API_KEY` / `GOOGLE_MAPS_MAP_ID` env, or
  `window.__LIFESPEAK_GOOGLE_MAPS_CONFIG` at browser runtime; falls back to mock.
- `engine.js`: `createEngine(container)`, `composeComposition(comp)`, `listKits()`
- `hud.js`: `renderHUD(update)`, `showChoice(options) -> Promise<choice>`,
  `showTextInput({placeholder})`, `showPlacePicker(places)`, `clearHUDOverlays()`
- `loop.js`: `startGame(container)` (classic 3D mode; lazy-imports `engine.js`)
  and `startExplore(container)` (maps mode; never loads three.js) — the only
  file that talks to every other module
