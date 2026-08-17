// Unit tests for the Google Maps boundary module (mock-only mode).
//
// The whole suite runs WITHOUT a browser DOM and WITHOUT GOOGLE_MAPS_API_KEY:
// Node has no `window`, so loadGoogleMaps() short-circuits to null and every
// explorer falls into deterministic mock mode — the same path CI exercises.
// This mirrors the AI provider's env-gated test pattern.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadGoogleMaps,
  createExplorer,
  searchNearby,
  getDetails,
  placeToBeat,
  effectiveMapsConfig,
  resetGoogleMapsLoaderForTests,
  __test__,
} from './maps.js';

test('effectiveMapsConfig: empty without env or runtime config', () => {
  const cfg = effectiveMapsConfig();
  assert.equal(cfg.apiKey, undefined);
  assert.equal(cfg.mapId, undefined);
});

test('loadGoogleMaps: resolves null (never throws) outside a browser', async () => {
  resetGoogleMapsLoaderForTests();
  const maps = await loadGoogleMaps();
  assert.equal(maps, null);
});

test('loadGoogleMaps: resolves null when no API key is set', async () => {
  resetGoogleMapsLoaderForTests();
  const maps = await loadGoogleMaps(''); // empty key → error path
  assert.equal(maps, null);
});

test('createExplorer: mock mode returns canned places via searchNearby', async () => {
  const explorer = await createExplorer(null);
  assert.equal(explorer.mock, true);
  assert.equal(explorer.map, null);

  const places = await explorer.searchNearby({});
  assert.ok(Array.isArray(places));
  assert.equal(places.length, __test__.MOCK_PLACES.length);
  for (const p of places) {
    assert.ok(p.placeId, 'placeId present');
    assert.ok(p.name, 'name present');
    assert.ok(typeof p.vicinity === 'string');
    assert.ok(Array.isArray(p.types));
    assert.ok(typeof p.location.lat === 'number');
    assert.ok(typeof p.location.lng === 'number');
  }
  explorer.dispose();
});

test('createExplorer: mock getDetails returns details for known and unknown ids', async () => {
  const explorer = await createExplorer(null);
  const known = await explorer.getDetails('mock-cafe-central');
  assert.equal(known.placeId, 'mock-cafe-central');
  assert.equal(known.name, 'The Central Perk Café');
  assert.ok(known.phone);
  assert.ok(known.openingHours);

  const fallback = await explorer.getDetails('does-not-exist');
  assert.equal(fallback.placeId, __test__.MOCK_PLACES[0].placeId);
  explorer.dispose();
});

test('searchNearby/getDetails wrappers work without a container', async () => {
  const places = await searchNearby({});
  assert.ok(places.length >= 1);
  const details = await getDetails(places[0].placeId);
  assert.equal(details.placeId, places[0].placeId);
});

test('placeToBeat: bridges a place summary into the scenario-beat shape', () => {
  const place = __test__.MOCK_PLACES[0]; // café
  const beat = placeToBeat(place);

  assert.equal(beat.id, `real-place:${place.placeId}`);
  assert.equal(beat.title, place.name);
  assert.equal(beat.location, 'cafe');       // first known type wins
  assert.deepEqual(beat.realPlace, place);
  assert.equal(typeof beat.prereq, 'function');
  assert.equal(beat.prereq({}), true);

  // Consumable by loop.js: npcs + beat graph with the canonical kinds.
  assert.ok(Array.isArray(beat.npcs) && beat.npcs.length >= 1);
  const kinds = beat.beats.map((b) => b.kind);
  assert.deepEqual(kinds, ['npc-dialogue', 'choice', 'npc-dialogue-2', 'end']);
  const choice = beat.beats.find((b) => b.kind === 'choice');
  assert.ok(choice.options.length >= 2);
});

test('placeToBeat: kind inference falls back to store for unknown types', () => {
  const beat = placeToBeat({ placeId: 'x', name: 'X', types: ['point_of_interest'] });
  assert.equal(beat.location, 'store');
});

test('placeToBeat: park kind maps to Staff role', () => {
  const park = __test__.MOCK_PLACES.find((p) => p.placeId === 'mock-park');
  const beat = placeToBeat(park);
  assert.equal(beat.location, 'park');
  assert.equal(beat.npcs[0].role, 'Staff');
});
