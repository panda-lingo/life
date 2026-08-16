# LifeSpeak

An AI-native 3D life-simulation game that trains **spoken English (CEFR B1 → C1)** and **soft skills** (conflict management, time management, collaboration) through consequential everyday scenarios.

- **Play**: speak to NPCs with your real voice (push-to-talk). An AI director composes scenes from pre-generated 3D assets and drives NPC dialogue; every decision shifts world state and future scenarios.
- **Learn**: each utterance is scored on a CEFR-aligned rubric (fluency, range, accuracy, interaction); soft-skill behavior is scored through embedded models (Thomas–Kilmann, interest-based negotiation, Eisenhower).
- **Analyze offline**: every event is appended to a local, versioned, replayable log (xAPI-flavored). Export JSONL for offline analysis — no server required.

## Stack

| Layer | Choice |
|---|---|
| 3D | Three.js, low-poly pre-generated GLB kits, runtime scene composition |
| AI | Text+image in → text out (scenario selection, NPC dialogue, utterance scoring) |
| Speech | Web Speech API (STT/TTS) with graceful fallbacks |
| Data | IndexedDB append-only event log → JSONL export |
| Targets | PC + mobile browsers (touch-first UI, perf budgets) |

## Run

```bash
npx serve .        # or any static server; open on desktop or phone
```

## Repo map

- `docs/` — research synthesis, game design document, data model spec
- `src/` — engine, AI, speech, data, UI modules (ES modules, no build step)
- `assets/` — pre-generated scene/prop/character manifests (kit-based composition)
- `scenarios/` — authored scenario graph (beats, gates, rubric anchors)
