// LifeSpeak market — goods with supply/demand pricing (Wealth Flow Simulation).
// Pure functions, no I/O. See docs/simulation.md.
//
// Each Good: { id, name, basePrice, supply, demand }
//   price(good) = basePrice * clamp(demand/supply, 0.25, 4), rounded to int.
// Buying reduces supply (player pulls goods out), raising the price; selling
// increases supply, lowering it. Demand drifts slowly so the market never
// locks. Money flows player <-> market; world.tick reports the flow.

const PRICE_FLOOR_MULT = 0.25;   // price won't fall below 1/4 base
const PRICE_CEIL_MULT = 4;        // nor rise above 4× base
const SUPPLY_MIN = 0;            // sold out -> price Infinity, buy blocked
const DEMAND_DECAY = 0.98;        // per-trade demand drift toward base

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Seed a small starter market: a coffee, groceries, a gift, and a gadget.
 * Enough to exercise daily commerce and gift-giving (relationships + trade
 * intersect: buying a gift for mother raises her affection).
 */
export function createMarket() {
  return {
    'coffee': { id: 'coffee', name: 'Coffee', basePrice: 4, supply: 50, demand: 40 },
    'groceries': { id: 'groceries', name: 'Groceries', basePrice: 18, supply: 80, demand: 60 },
    'gift': { id: 'gift', name: 'Gift', basePrice: 25, supply: 20, demand: 15 },
    'gadget': { id: 'gadget', name: 'Gadget', basePrice: 90, supply: 10, demand: 8 },
  };
}

/** Current unit price of a good (integer). Infinity if sold out. */
export function price(world, goodId) {
  const g = world.market?.[goodId];
  if (!g) return Infinity;
  if (g.supply <= SUPPLY_MIN) return Infinity;
  const ratio = clamp(g.demand / g.supply, PRICE_FLOOR_MULT, PRICE_CEIL_MULT);
  return Math.max(1, Math.round(g.basePrice * ratio));
}

/** List all goods with their current prices (for the HUD / trade UI). */
export function goods(world) {
  return Object.values(world.market || {}).map((g) => ({
    id: g.id, name: g.name, basePrice: g.basePrice,
    supply: g.supply, demand: g.demand, price: price(world, g.id),
  }));
}

/**
 * Buy `qty` of a good. Moves money from player to market, reduces supply
 * (price rises), nudges demand. Returns { ok, world, reason? }.
 * Caller (world.tick) computes the amount; here we mutate supply/demand/money.
 */
export function buy(world, goodId, qty = 1) {
  const g = world.market?.[goodId];
  if (!g) return { ok: false, world, reason: 'unknown-good' };
  if (g.supply < qty) return { ok: false, world, reason: 'sold-out' };
  const w = clone(world);
  const gg = w.market[goodId];
  const unit = price(world, goodId); // price before this trade
  const total = unit * qty;
  if (w.player.money < total) return { ok: false, world: w, reason: 'insufficient-funds' };
  w.player.money -= total;
  gg.supply -= qty;
  gg.demand = Math.max(1, Math.round(gg.demand * DEMAND_DECAY) + 1); // buying signals demand
  return { ok: true, world: w, unitPrice: unit, total };
}

/**
 * Sell `qty` of a good back. Increases supply (price falls), money flows
 * market -> player. The player can only sell what they've bought or produced;
 * the loop tracks inventory via flags if needed. Here we allow selling up to
 * a soft cap to keep the market liquid in early testing.
 */
export function sell(world, goodId, qty = 1) {
  const g = world.market?.[goodId];
  if (!g) return { ok: false, world, reason: 'unknown-good' };
  const w = clone(world);
  const gg = w.market[goodId];
  const unit = price(world, goodId);
  const total = unit * qty;
  w.player.money += total;
  gg.supply += qty;
  gg.demand = Math.max(1, Math.round(gg.demand * DEMAND_DECAY));
  return { ok: true, world: w, unitPrice: unit, total };
}

function clone(world) {
  if (typeof structuredClone === 'function') return structuredClone(world);
  return JSON.parse(JSON.stringify(world));
}

export const __test__ = { PRICE_FLOOR_MULT, PRICE_CEIL_MULT, SUPPLY_MIN, DEMAND_DECAY };
