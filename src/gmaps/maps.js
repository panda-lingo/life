// Google Maps boundary. The game talks ONLY to this module — game/loop, engine,
// and UI code never call Google APIs directly. This mirrors the AI-provider
// boundary at src/ai/director.js.
//
// Configuration (env-driven, all optional):
//   GOOGLE_MAPS_API_KEY   = browser API key with Maps JS + Places + Geometry enabled
//   GOOGLE_MAPS_MAP_ID    = optional cloud-styled map id
//
// When the key is missing or the loader fails (offline dev, CI without secrets),
// the module falls back to a deterministic mock so the rest of the game keeps
// working — the same pattern used by the AI provider.
//
// Public surface:
//   loadGoogleMaps(apiKey?)         -> google.maps namespace | null on failure
//   createExplorer(container, opts) -> { mock, map, searchNearby, getDetails, dispose }
//   searchNearby(opts)              -> Promise<PlaceSummary[]>
//   getDetails(placeId)             -> Promise<PlaceDetails|null>
//   placeToBeat(place, opts?)       -> scenario-shaped beat (consumed by loop.js)
//
// PlaceSummary = { placeId, name, vicinity, types, location:{lat,lng}, rating?, userRatingsTotal? }
// PlaceDetails = PlaceSummary + { phone?, website?, openingHours?, reviews?[] }

// ---------- request logging ------------------------------------------------
// Standing project rule: every HTTP request/response logs url, action,
// headers, body, and a curl reconstruction with auth masked. For Google Maps
// the browser SDK issues the requests internally (we cannot intercept its
// fetch), so we log OUR half: the SDK loader URL with a masked key, and each
// Places call with its full request params. Response bodies are summarized —
// no secrets are ever logged (the key is masked; no auth headers exist).
function _maskKeyInUrl(u) {
  return String(u).replace(/([?&]key=)[^&]+/i, '$1***MASKED***');
}
function logMaps(action, detail) {
  try { console.log(`[gmaps:${action}]`, JSON.stringify(detail, null, 1)); } catch { /* non-serializable detail — skip */ }
}

// Canonical Places web-service endpoints equivalent to what the JS SDK issues
// internally. The constraint ("log request as curl cmd, auth masked") is
// honored against these: the SDK's own URL/headers are unavailable to page
// code, but the endpoint + query params are knowable and the key is always
// masked — same parity as src/ai/openaiProvider.js's toCurl/logRequest.
const _PLACES_V1_URL = {
  nearbySearch: 'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
  details: 'https://maps.googleapis.com/maps/api/place/details/json',
};
function placesLogQuery(params) {
  const flat = {};
  for (const [k, v] of Object.entries(params)) {
    flat[k] = v && typeof v === 'object' ? JSON.stringify(v) : v;
  }
  return new URLSearchParams({ ...flat, key: '***MASKED***' }).toString();
}
function logPlaces(action, params) {
  const base = _PLACES_V1_URL[action];
  if (!base) return;
  const url = `${base}?${placesLogQuery(params)}`;
  logMaps(action, {
    action,
    url,
    headers: {},
    body: params,
    curl: `curl '${url.replace(/'/g, "'\\''")}'`,
  });
}

// ---------- config ---------------------------------------------------------
// Key resolution order (declarative mapping, docs/architecture.md):
//   1. backend GET /api/maps/config  — secrets live server-side
//   2. window.__LIFESPEAK_GOOGLE_MAPS_CONFIG — explicit dev override
//   3. GOOGLE_MAPS_API_KEY / GOOGLE_MAPS_MAP_ID env (Node/tests)
//   4. mock mode
import { backendMapsConfig } from '../net/backend.js';

function envConfig() {
  const env = (typeof process !== 'undefined' ? process.env : {}) || {};
  return {
    apiKey: env.GOOGLE_MAPS_API_KEY || env.GOOGLE_MAPS_KEY || undefined,
    mapId: env.GOOGLE_MAPS_MAP_ID || undefined,
  };
}
function runtimeConfig() {
  if (typeof window === 'undefined') return null;
  return window.__LIFESPEAK_GOOGLE_MAPS_CONFIG || null;
}
export function effectiveMapsConfig() {
  return runtimeConfig() || envConfig();
}

// Backend-first: returns {apiKey, mapId?} or null. Memoized per page so the
// explorer and any later consumer share one probe.
let _backendMapsConfigPromise = null;
// Dependency seam for tests: Node unit tests inject a stub here so the
// resolution order can be asserted without a real network call.
let _backendMapsConfigImpl = backendMapsConfig;
export function resolveMapsConfig() {
  _backendMapsConfigPromise ||= (async () => {
    const fromBackend = await _backendMapsConfigImpl();
    return fromBackend || effectiveMapsConfig() || null;
  })();
  return _backendMapsConfigPromise;
}
// Test hook: reset the memoized backend-config probe.
export function _resetMapsConfig() {
  _backendMapsConfigPromise = null;
}
// Test hook: inject a fake backend maps config fetcher.
export function _setBackendMapsConfigImpl(impl) {
  _backendMapsConfigImpl = impl;
  _backendMapsConfigPromise = null;
}

// ---------- loader ---------------------------------------------------------
// Lazy: the Google Maps JS API is only fetched on first use. Promise is cached
// so concurrent callers share one <script> injection.
let _googleMapsPromise = null;
let _googleMapsError = null;

export function loadGoogleMaps(apiKey) {
  if (typeof window === 'undefined') {
    _googleMapsError = new Error('google maps loader requires a browser');
    return Promise.resolve(null);
  }
  if (window.google?.maps?.places) return Promise.resolve(window.google.maps);
  if (_googleMapsPromise) return _googleMapsPromise;
  if (_googleMapsError) return Promise.resolve(null);

  const cfg = effectiveMapsConfig() || {};
  const key = apiKey || cfg.apiKey;
  if (!key) {
    _googleMapsError = new Error('GOOGLE_MAPS_API_KEY not set');
    return Promise.resolve(null);
  }
  const mapId = cfg.mapId;
  const params = new URLSearchParams({
    key,
    libraries: 'places,geometry',
    v: 'weekly',
    loading: 'async',
    ...(mapId ? { map_ids: mapId } : {}),
  });
  _googleMapsPromise = new Promise((resolve) => {
    const cb = `__lifespeakGmapsInit_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let settled = false;
    const done = (maps) => {
      if (settled) return;
      settled = true;
      delete window[cb];
      resolve(maps || null);
    };
    window[cb] = () => {
      try { done(window.google?.maps || null); } catch { done(null); }
    };
    script.src = `https://maps.googleapis.com/maps/api/js?${params}&callback=${cb}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => { done(null); };
    // Hard timeout so an unreachable-edge case (offline network, blocked domain)
    // can't wedge the game.
    setTimeout(() => done(null), 15_000);
    // curl reconstruction of the SDK load; the SDK's own tile/Places HTTP
    // calls happen inside Google's code and cannot be intercepted.
    logMaps('load-sdk', { url: _maskKeyInUrl(script.src), curl: `curl '${_maskKeyInUrl(script.src)}'` });
    document.head.appendChild(script);
  }).then((maps) => {
    if (!maps) {
      _googleMapsError = new Error('google maps script failed to load');
      _googleMapsPromise = null;
    }
    logMaps('load-sdk:response', { loaded: !!maps });
    return maps;
  });
  return _googleMapsPromise;
}

// For tests / hot-reload: drop the cached loader so a fresh key can be used.
export function resetGoogleMapsLoaderForTests() {
  _googleMapsPromise = null;
  _googleMapsError = null;
}

// ---------- mock fallback -------------------------------------------------
// Canned data so the game stays playable without a key. Deterministic, no I/O.
const MOCK_CENTER = { lat: 51.5074, lng: -0.1278 }; // London
const MOCK_PLACES = [
  {
    placeId: 'mock-cafe-central',
    name: 'The Central Perk Café',
    vicinity: '12 Old Compton St, Soho, London',
    types: ['cafe', 'food', 'point_of_interest'],
    location: { lat: 51.5136, lng: -0.1318 },
    rating: 4.5,
    userRatingsTotal: 1287,
  },
  {
    placeId: 'mock-bookshop',
    name: 'Foyles Bookshop',
    vicinity: '107 Charing Cross Rd, London',
    types: ['book_store', 'point_of_interest'],
    location: { lat: 51.5139, lng: -0.1297 },
    rating: 4.7,
    userRatingsTotal: 5312,
  },
  {
    placeId: 'mock-park',
    name: 'Soho Square Gardens',
    vicinity: 'Soho Square, London',
    types: ['park', 'point_of_interest'],
    location: { lat: 51.5153, lng: -0.1325 },
    rating: 4.3,
    userRatingsTotal: 892,
  },
];

function mockSearchNearby(_opts = {}) {
  return Promise.resolve(MOCK_PLACES.map(placeToSummary));
}
function mockGetDetails(placeId) {
  const found = MOCK_PLACES.find((p) => p.placeId === placeId) || MOCK_PLACES[0];
  return Promise.resolve({
    ...placeToSummary(found),
    phone: '+44 20 7946 0000',
    website: 'https://example.com',
    openingHours: { openNow: true, weekdayText: ['Mon–Sun: 7am–10pm'] },
    reviews: [],
  });
}

// Shape a real Places API result into the same flat PlaceSummary the mock
// returns. Keeps callers ignorant of which path produced the data.
function placeToSummary(p) {
  return {
    placeId: p.place_id || p.placeId,
    name: p.name,
    vicinity: p.vicinity || p.formatted_address || '',
    types: p.types || [],
    location: p.geometry?.location
      ? { lat: p.geometry.location.lat(), lng: p.geometry.location.lng() }
      : p.location,
    rating: p.rating,
    userRatingsTotal: p.user_ratings_total ?? p.userRatingsTotal,
  };
}
function placeToDetails(p) {
  return {
    ...placeToSummary(p),
    phone: p.formatted_phone_number || p.phone,
    website: p.website,
    openingHours: p.opening_hours
      ? {
          openNow: p.opening_hours.isOpen?.() ?? p.opening_hours.open_now,
          weekdayText: p.opening_hours.weekday_text || p.opening_hours.weekdayText,
        }
      : undefined,
    reviews: (p.reviews || []).slice(0, 3).map((r) => ({
      author: r.author_name,
      rating: r.rating,
      text: r.text,
      relativeTime: r.relative_time_description,
    })),
  };
}

// ---------- public API -----------------------------------------------------
/**
 * Boot the explorer. Returns a handle whose searchNearby/getDetails hit real
 * Google when a key + script load succeeded; otherwise they fall through to
 * the mock. Never throws — failure surfaces as `mock: true`.
 */
export async function createExplorer(container, opts = {}) {
  const cfg = await resolveMapsConfig() || {};
  const maps = await loadGoogleMaps(opts.apiKey || cfg.apiKey);
  if (!maps) {
    // Render a placeholder so the container isn't blank in mock mode; the
    // engine keeps owning the WebGL canvas underneath.
    if (container && typeof document !== 'undefined') {
      const div = document.createElement('div');
      div.id = 'gmaps-mock';
      div.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'background:#1a2233;color:#fff;font:14px system-ui;pointer-events:none;';
      div.textContent = 'Google Maps (mock mode — set GOOGLE_MAPS_API_KEY to enable)';
      container.appendChild(div);
    }
    return {
      mock: true,
      map: null,
      searchNearby: (o) => mockSearchNearby(o),
      getDetails: (id) => mockGetDetails(id),
      dispose() { container?.querySelector?.('#gmaps-mock')?.remove(); },
    };
  }
  const center = opts.center || MOCK_CENTER;
  const zoom = opts.zoom ?? 15;
  const map = new maps.Map(container, {
    center,
    zoom,
    ...(cfg.mapId ? { mapId: cfg.mapId } : {}),
    disableDefaultUI: false,
    zoomControl: true,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });
  const placeService = new maps.places.PlacesService(map);
  return {
    mock: false,
    map,
    placeService,
    searchNearby: (o) => searchNearbyReal(placeService, o),
    getDetails: (id) => getDetailsReal(placeService, id),
    dispose() { /* google.maps.Map owns its DOM node; GC'd with container */ },
  };
}

/** Nearby search via Places; resolves to PlaceSummary[]. */
function searchNearbyReal(placeService, opts = {}) {
  return new Promise((resolve) => {
    const req = {
      location: opts.location || MOCK_CENTER,
      radius: opts.radius ?? 500,
      ...(opts.type ? { type: opts.type } : {}),       // 'cafe', 'restaurant', 'park', ...
      ...(opts.keyword ? { keyword: opts.keyword } : {}),
    };
    const lat = req.location?.lat ?? req.location?.lat?.();
    const lng = req.location?.lng ?? req.location?.lng?.();
    logPlaces('nearbySearch', {
      location: `${lat},${lng}`,
      radius: req.radius,
      ...(req.type ? { type: req.type } : {}),
      ...(req.keyword ? { keyword: req.keyword } : {}),
    });
    placeService.nearbySearch(req, (results, status) => {
      if (status !== 'OK' || !Array.isArray(results)) {
        logMaps('places.nearbySearch:response', { status, count: 0 });
        return resolve([]);
      }
      logMaps('places.nearbySearch:response', { status, count: results.length });
      resolve(results.slice(0, opts.limit ?? 10).map(placeToSummary));
    });
  });
}

/** Details for one place; resolves to PlaceDetails or null. */
function getDetailsReal(placeService, placeId) {
  return new Promise((resolve) => {
    const req = {
      placeId,
      fields: ['place_id', 'name', 'vicinity', 'types', 'geometry', 'rating', 'user_ratings_total', 'formatted_phone_number', 'website', 'opening_hours', 'reviews'],
    };
    logPlaces('details', { placeId, fields: req.fields });
    placeService.getDetails(req, (place, status) => {
      if (status !== 'OK' || !place) {
        logMaps('places.getDetails:response', { status });
        return resolve(null);
      }
      logMaps('places.getDetails:response', { status, name: place.name });
      resolve(placeToDetails(place));
    });
  });
}

/**
 * Async wrappers matching the legacy signatures; they auto-create an explorer
 * under the hood so ad-hoc callers (tests, REPL) don't need a container.
 * For production code paths, prefer createExplorer() and reuse its closures.
 */
export async function searchNearby(opts = {}, container = null) {
  const exp = await createExplorer(container ?? ensureHiddenContainer(), opts);
  const out = await exp.searchNearby(opts);
  exp.dispose();
  return out;
}
export async function getDetails(placeId, opts = {}) {
  const exp = await createExplorer(ensureHiddenContainer(), opts);
  const out = await exp.getDetails(placeId);
  exp.dispose();
  return out;
}

let _hiddenContainer = null;
function ensureHiddenContainer() {
  if (typeof document === 'undefined') return null;
  if (_hiddenContainer && document.body.contains(_hiddenContainer)) return _hiddenContainer;
  _hiddenContainer = document.createElement('div');
  // Google Places requires an attached Map or element; keep it off-screen.
  _hiddenContainer.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;';
  document.body.appendChild(_hiddenContainer);
  return _hiddenContainer;
}

// ---------- scenario bridge ------------------------------------------------
// Map a real-world place onto a scenario-beat-shaped object so the existing
// director + composer + dialogue pipeline can consume it without learning
// about Google-specific types.
export function placeToBeat(place, opts = {}) {
  const id = `real-place:${place.placeId}`;
  const kind = (place.types || []).find((t) =>
    ['cafe', 'restaurant', 'bar', 'park', 'store', 'book_store', 'museum', 'library', 'gym', 'pharmacy'].includes(t),
  ) || 'store';
  return {
    id,
    title: place.name,
    location: kind,
    realPlace: place,
    cefrRange: opts.cefrRange || ['B1', 'C1'],
    skillFocus: opts.skillFocus || ['interaction'],
    prereq: () => true,
    flags: {},
    stats: {},
    npcs: [{
      id: 'npc-staff',
      name: opts.npcName || 'Local',
      role: kind === 'cafe' ? 'Barista' : kind === 'restaurant' ? 'Server' : 'Staff',
      personality: 'friendly, helpful',
      mood: 'welcoming',
    }],
    beats: [
      { kind: 'npc-dialogue', turn: 'open' },
      { kind: 'choice', options: [
        { text: 'Ask for a recommendation', next: 'npc-dialogue-2' },
        { text: 'Place a simple order or ask for directions', next: 'npc-dialogue-2' },
      ]},
      { kind: 'npc-dialogue-2' },
      { kind: 'end' },
    ],
  };
}

// Exposed for tests so they can assert against a known fallback coordinate.
export const __test__ = { MOCK_CENTER, MOCK_PLACES };
