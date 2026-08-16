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
       └────────────── AI director (text+image → text)
                    ┌──────────┐
                    │    ai/   │
                    │ director │  ← mock provider by default
                    │ provider │  ← real HTTP provider adapter
                    └──────────┘
```

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
| speechSynthesis | no voices | subtitle-only, timed delay |
| AI provider | network down / no key | deterministic mock provider |
| IndexedDB | quota exceeded | in-memory log + warning banner |
| WebGL | context lost | canvas pause + retry button |

## Module contracts

- `eventlog.js`: `emit(type, payload)`, `queryEvents()`, `exportJSONL()`, `downloadExport()`
- `learnerModel.js`: pure functions, no I/O
- `speech.js`: `createRecognizer({onInterim,onFinal,onError})`, `speak(text, opts)`, `speechCapabilities()`
- `director.js`: five JSON-contract functions; the only file that talks to the AI provider
- `engine.js`: `createEngine(container)`, `composeComposition(comp)`, `listKits()`
- `hud.js`: `renderHUD(update)`, `showChoice(options) -> Promise<choice>`, `listenOnce() -> Promise<transcript>`
- `loop.js`: `startGame(container)`; the only place that imports all modules
