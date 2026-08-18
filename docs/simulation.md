# Simulation — LifeSpeak World

The game models a lived day: a person with **energy**, **money**, **time**,
**relationships** (family + friends), and a **market** they trade in. The
existing dialogue/scoring pipeline is preserved — the simulation wraps it so
every conversation now costs time and energy, can earn or spend money, and
moves relationships. The design goal is a *Wealth Flow Simulation*: money and
energy flow between the player, NPCs, and the market; relationships gate what
beats become available.

## Desired end state

A single persistent `world` object drives the whole game:

```jsonc
{
  "clock": { "day": 1, "minute": 480 },          // 24h clock, 480 = 08:00
  "player": {
    "money": 120, "energy": 80, "health": 100,   // 0..100 vitals
    "mood": 60, "stress": 20
  },
  "people": { /* id -> Person */ },
  "market": { /* id -> Good */ },
  "flags": {},                                    // narrative flags (unchanged)
  "stats": {}                                      // legacy stats (trust, etc.)
}
```

Every dialogue turn, choice, and trade is a **deterministic transition** on
this object. The AI director *selects* beats and *writes* dialogue; it never
mutates the world directly — `world.js` applies all state changes so the
simulation stays explainable and testable without a live AI.

## Constraints (declarative)

1. **Pure core, no I/O.** `src/sim/world.js`, `people.js`, `market.js` are
   pure functions: `(world, action) -> world`. No fetch, no IndexedDB, no
   `Date.now()`. Time advances by explicit `tick` calls driven by the loop.
2. **AI stays behind the director.** All AI provider calls go through
   `src/ai/director.js` (unchanged project rule). The director gains two new
   contract functions — `directTrade` and `npcRelationshipDelta` — but they
   are still `complete({prompt,image}) -> text` under the hood.
3. **Energy/time gate gameplay.** A beat with `cost: { energy: 10, minutes: 30 }`
   is unselectable when `player.energy < 10` or the day has no minutes left.
   The director's candidate filter enforces this *before* the AI picks.
4. **Money is conserved.** Trades move money player ⇄ NPC/market; salaries and
   sales add it; purchases remove it. Every money delta is an event with a
   `from`/`to`/`amount` triple so the JSONL export can reconstruct wealth flow.
5. **Relationships are a directed graph.** Each `Person` has `relation`
   (`family` | `friend` | `colleague` | `stranger`), `affection` (-100..100),
   and `trust` (0..100). Affection gates beats (`prereq: ws => affection(mom) > 0`)
   and shifts NPC mood in `npcTurn`.
6. **Offline-first, unchanged.** The world lives in the session and is
   snapshotted into the event log (`world.tick` events) so IndexedDB remains
   the source of truth and the backend mirror is unchanged.
7. **Responsive UI.** The new status bar (time/money/energy/mood) renders in
   the existing HUD and is tested on desktop + mobile/redroid viewports.

## Time system

- Clock is **minutes since 00:00**, day counter starts at 1.
- `advanceTime(world, minutes)` moves the clock; crossing 24:00 (1440) rolls
  to the next day, restores a chunk of energy (sleep), and decays stress.
- Each beat declares `minutes` cost; the loop advances time when a beat ends.
- Hard gates: beats after 22:00 (1320) are "tired" (energy cost ×1.5); the
  day ends at 26:00 (forces sleep → new day).

## Money & trade

- `player.money` is an integer (currency units). Starts at a modest amount.
- `market.js` holds `Good` entries: `{ id, name, basePrice, supply, demand }`.
  `price(good)` = basePrice × (demand/supply), clamped — a simple flow model.
- `buy(world, goodId, qty)` / `sell(world, goodId, qty)` move money and shift
  supply/demand so prices react to the player's trades (wealth flows).
- Some beats pay a salary (`stats: { money: +120 }` — already supported by
  `applyEffects`); trades are the player-driven money source.

## Energy & vitals

- `energy` 0..100. Dialogue beats cost energy; rest/food beats restore it.
- `health` 0..100, decays slowly when energy or money stay low for days.
- `mood` 0..100, moves with relationship deltas and money gains/losses.
- `stress` 0..100, rises with conflict beats, falls with sleep/leisure.
- Energy ≤ 0 forces a rest beat (the director offers only `rest` candidates).

## Relationships (family + friends)

- `people.js` seeds a cast: mother, father, sibling (family); a best friend,
  a colleague, a barista (friend/colleague/stranger).
- Each NPC beat references `npcId`; after the beat, `npcRelationshipDelta`
  scores the transcript and shifts that NPC's affection/trust.
- Affection thresholds unlock beats: e.g. `loan-from-mom` requires
  `affection(mother) >= 40`; `betray-colleague` drops trust by 30 and locks
  future collaboration beats.
- Family beats carry higher stakes (affection swings larger; money can flow
  both ways — gifts, loans).

## Event taxonomy additions

| Type | Emitted when | Key payload |
|---|---|---|
| `world.tick` | time advances / day rolls | `clock`, `player` snapshot, `reason` |
| `trade.made` | buy/sell | `goodId`, `qty`, `unitPrice`, `from`, `to`, `amount` |
| `relationship.delta` | after a beat's NPC delta | `npcId`, `affection`, `trust`, `evidence` |
| `vital.changed` | energy/health/mood/stress cross a threshold | `vital`, `from`, `to` |

All embed a full `world` snapshot (per the offline-analysis contract) so JSONL
alone reconstructs the whole simulation.

## Module contracts

- `src/sim/world.js`: `createWorld()`, `advanceTime(w, mins)`,
  `applyCost(w, cost)`, `canAfford(w, cost)`, `snapshot(w)`, `tick(w, action)`.
- `src/sim/people.js`: `createPeople()`, `person(w, id)`,
  `applyRelationshipDelta(w, npcId, {affection, trust})`,
  `affection(w, id)`, `trust(w, id)`.
- `src/sim/market.js`: `createMarket()`, `price(w, goodId)`,
  `buy(w, goodId, qty)`, `sell(w, goodId, qty)`, `goods(w)`.
- `src/ai/director.js` (extended): `directTrade({world, goodId})`,
  `npcRelationshipDelta({npc, transcriptLog})` — both via the existing
  `call()` boundary; mock provider answers deterministically when offline.

## Failure modes & fallbacks

| Component | Failure | Fallback |
|---|---|---|
| Simulation core | invalid action (negative qty, unknown good) | `tick()` returns world unchanged + `{ ok:false, reason }`; loop logs `world.invalid` |
| Energy depleted | player.energy ≤ 0 | director offers only `rest`/`sleep` candidates until energy > 0 |
| Market | supply hits 0 (sold out) | `price()` → Infinity; buy returns `{ ok:false }`; HUD shows "sold out" |
| AI director (trade/relationship) | 5xx / no key | mock provider returns deterministic delta (unchanged resilience rule) |
| Day rollover | clock overflow | `advanceTime` rolls day, applies sleep recovery, emits `world.tick` |
