# Data Model — LifeSpeak

Everything the game records is an **append-only event**. The browser's
IndexedDB (`lifespeak` DB, `events` store) is the write-through source of
truth; when the backend server is reachable, every event is **mirrored
server-side** (`POST /api/events`, batched, deduped by `id`) into JSONL files
under the server's `DATA_DIR`. Sessions are the unit of analysis; each session
has a random UUID. Both stores export JSONL — one JSON object per line — which
any offline tool (pandas, duckdb, jq, Excel) can ingest.

## Event envelope

```json
{
  "id": "uuid-v4",
  "v": 1,
  "ts": 1730000000000,
  "sessionId": "s_uuid",
  "seq": 42,
  "type": "utterance.scored",
  "...payload": "type-specific fields"
}
```

`v` is the schema version; migrations happen on `onupgradeneeded`. `seq` is a per-session monotonic counter so events can be re-ordered deterministically even if clocks skew.

## Event taxonomy (xAPI-flavored)

| Type | Emitted when | Key payload |
|---|---|---|
| `session.start` | game boot | `profile` (self-assessed level, target, skill focus), `ua`, `screen` |
| `session.end` | player exits | — |
| `beat.start` | scenario begins | `beatId`, `framing`, `worldState` snapshot |
| `beat.end` | scenario ends | `beatId` |
| `scene.composed` | AI picks kit/layout/props | `composition` |
| `npc.said` | NPC line spoken | `text`, `npcId` |
| `utterance.scored` | after each player utterance | `transcript`, `rubric {fluency,range,accuracy,interaction}`, `errors[]`, `betterVersion` |
| `choice.made` | player picks a dialogue option | `stepIndex`, `chosen` (text + effects) |
| `scenario.debrief` | scenario closes | `debrief {scores, evidence, nextTime}` |
| `skill.updated` | learner model updates | `skill`, `newValue` |
| `world.tick` | sim clock advances / day rolls | `clock {day,minute}`, `player` snapshot, `reason` |
| `trade.made` | player buys/sells a good | `goodId`, `qty`, `unitPrice`, `from`, `to`, `amount` |
| `relationship.delta` | NPC affection/trust shifts after a beat | `npcId`, `affection`, `trust`, `evidence` |
| `vital.changed` | energy/health/mood/stress crosses a threshold | `vital`, `from`, `to` |

## Server-side persistence

- `POST /api/events` accepts `{events: [...]}` batches (envelope shape above), deduped by event `id`, and appends them as JSONL to `DATA_DIR/events-YYYY-MM-DD.jsonl` (one file per UTC day).
- `GET /api/events?session=<id>&type=<prefix>&since=<ms>` reads them back as `{events: [...]}` — same filters as the IndexedDB `queryEvents()`.
- The browser mirror is asynchronous and offline-tolerant: `eventlog.emit()` writes IndexedDB first, then queues the event for the backend; failures retry with backoff and a `sendBeacon` flush runs on `pagehide`. When the backend is absent, the game behaves exactly as before (IndexedDB-only).
- Ordering: within a session, `seq` (per-session monotonic) is authoritative on both stores; `ts` remains for cross-session timelines.

## Learner model (offline heuristics)

- **Language dimensions** (`fluency`, `range`, `accuracy`, `interaction`): EMA with α=0.25, 0–5 scale anchored to CEFR.
- **CEFR estimate**: mean of the four dimensions mapped onto a 5-step ladder `B1, B1+, B2, B2+, C1`.
- **Soft skills** (`conflict`, `time`, `collaboration`): EMA 0–1 from debrief scores.
- **Error patterns**: per-pattern count; once ≥3, considered fossilized and fed to the AI director as targeting hints.

This is deliberately simple and explainable — no server, no black box. A real deployment can swap EMA for BKT/IRT offline later.

## Storage & privacy

- IndexedDB `events` store, indexes on `ts`, `sessionId`, `type` — the **source of truth** on the client.
- **Backend mirror**: when the backend server is reachable (`/api/healthz`), every event is also POSTed to `/api/events` in small batches. Mirroring is async and never blocks gameplay; failures are queued in memory and retried with exponential backoff (5s → 60s cap), with a `sendBeacon` flush on `pagehide`. The server appends to per-day JSONL files under `DATA_DIR` (`events-YYYY-MM-DD.jsonl`) and dedupes by event `id` (within each batch and again at read time), so client retries never produce duplicate analysis rows. `GET /api/events?session=<id>` reads the server-side log back.
- No PII beyond optional profile fields the player provides; analysis works offline from either the client export or the server JSONL files.
- Export produces one `.jsonl` file; sample analysis notebook planned under `docs/`.
- Data minimization: events capture *what* happened (scores, flags, transcripts) but never raw audio — audio stays on device and is discarded after STT. The same event envelope crosses the wire; no additional fields are collected server-side.

## Offline analysis contract

Any JSONL file must be sufficient to answer:
1. What CEFR level is the learner at now, and how has it moved?
2. Which error patterns are fossilizing?
3. Which soft skills are weakest, and in which scenario archetypes?
4. What did the learner actually say at each decision point?

To make that possible, every scoring event embeds the full context (`transcript`, `worldState` snapshot) — not foreign keys that would require a live DB join.

## Simulation state (wealth-flow reconstruction)

The simulation core ([`docs/simulation.md`](simulation.md)) emits its own
events so the JSONL export alone can reconstruct the player's day, wealth, and
relationships without a live DB:

- `world.tick` — full `clock` + `player` vitals snapshot every time the clock
  advances (per beat) and on day rollover. Replaying these in order gives the
  complete vital trajectory (energy/money/mood/stress over time).
- `trade.made` — money-flow triple `from`/`to`/`amount` plus `unitPrice` and
  `qty`, so a pandas/duckdb pass can sum net wealth flow player ⇄ market.
- `relationship.delta` — per-NPC affection/trust after each beat, with
  `evidence` (transcript-derived); reconstructs the relationship graph over time.
- `vital.changed` — threshold crossings (energy hitting 0, mood crashing) for
  alerting/analysis without diffing snapshots.

Every simulation event embeds enough snapshot to be self-contained, matching
the existing "no live DB join" contract.
