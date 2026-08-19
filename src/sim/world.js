// LifeSpeak simulation core — a deterministic life-sim world.
// Pure functions: (world, action) -> world. No I/O, no Date.now(), no fetch.
// See docs/simulation.md for the desired end state and constraints.
//
// The world holds: a 24h clock (minutes + day counter), player vitals
// (money, energy, health, mood, stress), narrative flags/stats, plus the
// people graph and market (created by their modules and merged in here).

import { createPeople, applyRelationshipDelta } from './people.js';
import { createMarket, buy as marketBuy, sell as marketSell, price as marketPrice } from './market.js';

// ---- tunables -----------------------------------------------------------
const DAY_MINUTES = 24 * 60;          // 1440 — a day is 00:00..23:59
const DAY_END_MINUTES = 26 * 60;      // 1560 — hard stop, forces sleep
const SLEEP_ENERGY = 45;              // energy restored on day rollover
const SLEEP_STRESS = -25;             // stress reduced on day rollover
const LOW_ENERGY_REST_THRESHOLD = 0;   // at/below this, only rest beats offered
const TIRED_AFTER_MINUTE = 22 * 60;   // 22:00 — energy costs ×1.5
const TIRED_MULTIPLIER = 1.5;
const VITAL_MIN = 0;
const VITAL_MAX = 100;
const DATA_CAP = 12;                  // briefing items kept (newest first)
const DATA_SUMMARY_MAX = 220;         // chars kept per briefing summary

// Vitals that live on player and are clamped to [0,100].
const CLAMPED_VITALS = ['energy', 'health', 'mood', 'stress'];

const clamp = (v, lo = VITAL_MIN, hi = VITAL_MAX) => Math.max(lo, Math.min(hi, v));

/**
 * Create a fresh world. The people graph and market are seeded by their
 * modules; world.js owns the clock + player vitals + flags/stats.
 */
export function createWorld({ people = createPeople(), market = createMarket() } = {}) {
  return {
    clock: { day: 1, minute: 8 * 60 },   // start Monday 08:00
    player: {
      money: 120,
      energy: 80,
      health: 100,
      mood: 60,
      stress: 20,
    },
    people,
    market,
    data: [],     // briefing items from MCP tool results (see docs/mcp.md)
    flags: {},
    stats: {},
  };
}

/** Read-only snapshot for event payloads (deep, so callers can't mutate). */
export function snapshot(world) {
  return structuredClone({
    clock: world.clock,
    player: world.player,
    flags: world.flags,
    stats: world.stats,
    people: world.people,
    market: world.market,
    data: world.data || [],
  });
}

/** Format the clock as HH:MM for the HUD. */
export function clockString(world) {
  const m = world.clock.minute % DAY_MINUTES;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `Day ${world.clock.day} · ${hh}:${mm}`;
}

/** Is the player out of energy (only rest beats eligible)? */
export function isExhausted(world) {
  return world.player.energy <= LOW_ENERGY_REST_THRESHOLD;
}

/** Is it late at night (energy costs multiplied)? */
export function isTiredHour(world) {
  return (world.clock.minute % DAY_MINUTES) >= TIRED_AFTER_MINUTE;
}

/**
 * Advance the clock by `minutes`. Crossing 24:00 rolls the day and applies
 * sleep recovery (energy up, stress down). Crossing 26:00 forces a rollover.
 * Returns { world, rolled, prevMinute } so the loop can emit a world.tick.
 */
export function advanceTime(world, minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) {
    return { world, rolled: false, prevMinute: world.clock.minute, advanced: 0 };
  }
  const w = clone(world);
  const prevMinute = w.clock.minute;
  let minute = w.clock.minute + minutes;
  let rolled = false;

  // Hard stop: if we've blown past 26:00, clamp to the rollover boundary so
  // the player sleeps rather than accumulating a 30h day.
  if (minute >= DAY_END_MINUTES) {
    minute = DAY_MINUTES; // exactly midnight → rolls below
  }

  if (minute >= DAY_MINUTES) {
    w.clock.day += 1;
    w.clock.minute = minute - DAY_MINUTES;
    rolled = true;
    applySleep(w);
  } else {
    w.clock.minute = minute;
  }
  return { world: w, rolled, prevMinute, advanced: minutes };
}

// Sleep recovery on day rollover: restore energy, shed stress, small mood lift.
function applySleep(w) {
  w.player.energy = clamp(w.player.energy + SLEEP_ENERGY);
  w.player.stress = clamp(w.player.stress + SLEEP_STRESS);
  w.player.mood = clamp(w.player.mood + 5);
}

/**
 * A beat's cost: { energy?, money?, minutes? }. Returns true if the player
 * can pay all of them right now (energy/money non-negative afterwards, time
 * within the day). Does NOT mutate.
 */
export function canAfford(world, cost = {}) {
  if (!cost) return true;
  const energy = cost.energy ?? 0;
  const money = cost.money ?? 0;
  const minutes = cost.minutes ?? 0;
  if (world.player.energy < energy) return false;
  if (world.player.money < money) return false;
  // Time gate: the day must still have room (before the 26:00 hard stop).
  if (world.clock.minute + minutes > DAY_END_MINUTES) return false;
  return true;
}

/**
 * Apply a cost to the world (energy down, money down, time forward). Energy
 * cost is multiplied by TIRED_MULTIPLIER during tired hours. Returns a new
 * world; does NOT emit events (the loop does that). Caller must have checked
 * canAfford first — this clamps rather than rejecting.
 */
export function applyCost(world, cost = {}) {
  const w = clone(world);
  const mult = isTiredHour(w) ? TIRED_MULTIPLIER : 1;
  if (cost.energy) w.player.energy = clamp(w.player.energy - Math.round(cost.energy * mult));
  if (cost.money) w.player.money = w.player.money - cost.money;
  if (cost.minutes) {
    const advanced = advanceTime(w, cost.minutes);
    // advanceTime returns a fresh world; adopt its clock + sleep effects.
    w.clock = advanced.world.clock;
    w.player.energy = advanced.world.player.energy;
    w.player.stress = advanced.world.player.stress;
    w.player.mood = advanced.world.player.mood;
  }
  return w;
}

/**
 * Apply a stat/flag delta (legacy applyEffects-style) to the world. Used for
 * beat effects and choice effects that touch money/mood/trust directly.
 * `effects.stats.money` is special-cased to move player.money.
 */
export function applyEffects(world, effects = {}) {
  if (!effects) return world;
  const w = clone(world);
  w.flags = { ...(w.flags || {}), ...(effects.flags || {}) };
  const stats = effects.stats || {};
  for (const [k, v] of Object.entries(stats)) {
    if (k === 'money') {
      w.player.money = (w.player.money || 0) + v;
    } else if (k === 'energy') {
      w.player.energy = clamp(w.player.energy + v);
    } else if (k === 'mood') {
      w.player.mood = clamp(w.player.mood + v);
    } else if (k === 'stress') {
      w.player.stress = clamp(w.player.stress + v);
    } else if (k === 'health') {
      w.player.health = clamp(w.player.health + v);
    } else {
      w.stats[k] = (w.stats[k] || 0) + v;
    }
  }
  return w;
}

/**
 * The single entry point for any world mutation the loop needs. `action` is
 * a tagged object; returns { world, result } where result describes what
 * happened (for event emission). Pure — no I/O.
 *
 * Supported actions:
 *   { kind:'advanceTime', minutes }
 *   { kind:'applyCost', cost }
 *   { kind:'applyEffects', effects }
 *   { kind:'buy', goodId, qty }
 *   { kind:'sell', goodId, qty }
 *   { kind:'relationshipDelta', npcId, delta:{affection?,trust?} }
 */
export function tick(world, action) {
  if (!action || typeof action !== 'object') {
    return { world, result: { ok: false, reason: 'no-action' } };
  }
  switch (action.kind) {
    case 'advanceTime': {
      const r = advanceTime(world, action.minutes || 0);
      return { world: r.world, result: { ok: true, ...r } };
    }
    case 'applyCost': {
      const w = applyCost(world, action.cost || {});
      return { world: w, result: { ok: true } };
    }
    case 'applyEffects': {
      const w = applyEffects(world, action.effects || {});
      return { world: w, result: { ok: true } };
    }
    case 'buy': {
      const unit = marketPrice(world, action.goodId);
      const r = marketBuy(world, action.goodId, action.qty || 1);
      if (!r.ok) return { world: r.world, result: { ok: false, reason: r.reason } };
      return {
        world: r.world,
        result: {
          ok: true, goodId: action.goodId, qty: action.qty, unitPrice: unit,
          from: 'player', to: 'market', amount: unit * (action.qty || 1),
        },
      };
    }
    case 'sell': {
      const unit = marketPrice(world, action.goodId);
      const r = marketSell(world, action.goodId, action.qty || 1);
      if (!r.ok) return { world: r.world, result: { ok: false, reason: r.reason } };
      return {
        world: r.world,
        result: {
          ok: true, goodId: action.goodId, qty: action.qty, unitPrice: unit,
          from: 'market', to: 'player', amount: unit * (action.qty || 1),
        },
      };
    }
    case 'relationshipDelta': {
      const w = applyRelationshipDelta(world, action.npcId, action.delta || {});
      return { world: w, result: { ok: true, npcId: action.npcId, delta: action.delta } };
    }
    case 'setData': {
      const w = clone(world);
      const incoming = Array.isArray(action.items) ? action.items : [];
      // Replace-by-id: fold new items in, then cap newest-first.
      const byId = new Map();
      for (const item of [...(w.data || []), ...incoming]) {
        if (item && item.id) byId.set(item.id, item);
      }
      w.data = [...byId.values()]
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, DATA_CAP);
      return { world: w, result: { ok: true, count: w.data.length, added: incoming.length } };
    }
    default:
      return { world, result: { ok: false, reason: `unknown-kind:${action.kind}` } };
  }
}

// ---- briefing: reduce MCP toolLog entries to world.data items -----------
// Pure mapping, data-driven by tool id (docs/mcp.md "In-game surfacing").
// Only ok:true entries produce items; failures are skipped (the loop still
// logs them as mcp.tool.failed events).

const trimSummary = (s, max = DATA_SUMMARY_MAX) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'web'; }
};

// Each mapper: (value, args, ts) -> briefing item | [items] | null.
const BRIEFING_MAPPERS = {
  'fx.rate': (v, args, ts) => {
    if (typeof v?.rate !== 'number') return null;
    const base = v.base || args?.base || '';
    const target = v.target || args?.target || '';
    return {
      id: `fx:${base}:${target}`,
      kind: 'fx', icon: '💱',
      title: `${base}→${target} rate`,
      summary: `1 ${base} ≈ ${v.rate} ${target}`,
      source: v.source || 'open.er-api.com', ts,
    };
  },
  'web.search': (v, _args, ts) => {
    const results = Array.isArray(v?.results) ? v.results : [];
    return results.slice(0, 5).map((r, i) => ({
      id: `news:${hostOf(r.url)}:${i}`,
      kind: 'news', icon: '📰',
      title: trimSummary(r.title, 120),
      summary: trimSummary(r.content),
      source: r.url || '', ts,
    }));
  },
  'web.fetch': (v, args, ts) => {
    const url = v?.url || args?.url || '';
    const host = hostOf(url);
    const text = v?.rawContent || v?.content || '';
    if (!text) return null;
    return {
      id: `web:${host}`,
      kind: 'web', icon: '🌐',
      title: host,
      summary: trimSummary(text),
      source: url, ts,
    };
  },
};

/**
 * Reduce a backend `toolLog` (array of { tool, args, ok, value }) into
 * briefing items for world.data. Pure — `ts` must be injected by the caller
 * so world.js never calls Date.now(). Returns [] for non-array / no ok:true
 * entries. Unknown tools are ignored.
 */
export function briefingFromToolLog(toolLog, { ts = 0 } = {}) {
  if (!Array.isArray(toolLog)) return [];
  const items = [];
  for (const entry of toolLog) {
    if (!entry?.ok) continue;
    const mapper = BRIEFING_MAPPERS[entry.tool];
    if (!mapper) continue;
    const mapped = mapper(entry.value, entry.args || {}, ts);
    if (Array.isArray(mapped)) items.push(...mapped.filter(Boolean));
    else if (mapped) items.push(mapped);
  }
  return items.filter((it) => it && it.id);
}

// Deep clone via structuredClone so pure functions never share references with
// the caller's world. Falls back to JSON for environments without it.
function clone(world) {
  if (typeof structuredClone === 'function') return structuredClone(world);
  return JSON.parse(JSON.stringify(world));
}

// ---- test seam ----
export const __test__ = {
  DAY_MINUTES, DAY_END_MINUTES, TIRED_AFTER_MINUTE, TIRED_MULTIPLIER,
  clamp,
};
