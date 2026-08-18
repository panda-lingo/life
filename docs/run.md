# Run — LifeSpeak

## Backend server (Docker / Node)

The game container is a single Node process (`server/server.js`, zero npm
dependencies) that serves the static game **and** the `/api/*` backend:

```bash
docker build -t lifespeak:local .
docker run -d --rm -p 127.0.0.1:8080:8080 \
  -e IMAGE_TEXT_API_FORMAT=openai \
  -e IMAGE_TEXT_BASE_URL=https://your-gateway/v1 \
  -e IMAGE_TEXT_MODEL=your-model \
  -e IMAGE_TEXT_API_KEY=sk-... \
  -e GOOGLE_MAPS_API_KEY=AIza... \
  -v lifespeak-data:/app/data \
  lifespeak:local
# Open http://127.0.0.1:8080
```

Server environment variables (all optional — every unset feature degrades
gracefully):

| Variable | Purpose | When unset |
|---|---|---|
| `PORT` | listen port (default `8080`) | — |
| `DATA_DIR` | where user event JSONL is persisted (default `<repo>/data`) | events still accepted, written under repo `data/` |
| `IMAGE_TEXT_API_FORMAT` | `openai` (only supported format) | `POST /api/ai/complete` answers 503 → game uses mock/browser provider |
| `IMAGE_TEXT_BASE_URL` / `IMAGE_TEXT_MODEL` / `IMAGE_TEXT_API_KEY` | OpenAI-compatible endpoint creds, **server-side only** | same 503 fallback |
| `GOOGLE_MAPS_API_KEY` / `GOOGLE_MAPS_MAP_ID` | Maps bootstrap, handed to the page via `GET /api/maps/config` | 404 → explore mode runs deterministic mock |
| `EVENTS_BODY_LIMIT` / `AI_BODY_LIMIT` | request size caps (defaults 256 KB / 1 MB) | — |

Secrets never reach the page: the browser only ever talks to same-origin
`/api/*`. The server logs every request and response (url, action, headers,
body) as a curl command with auth headers masked (`sk-ab…wxyz`).

Local dev without Docker:

```bash
node server/server.js        # serves the game + API on :8080
```

## Static hosting (no backend)

Any static file server still works — the game detects the missing backend via
`/api/healthz` and falls back to in-page providers and IndexedDB-only storage:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080` in Chrome/Edge/Firefox. Click **Start** (classic
3D scenarios), allow microphone access, and hold the **talk** button (or the
mic hotkey) to speak.

## Explore mode (Google Maps)

The splash screen has a second entry: **Explore a real place**. Instead of the
3D stage, the game shows a map of your surroundings, lists nearby places
(cafés, restaurants, parks …), and builds a dialogue beat out of the place you
pick — same scoring, debrief, and learner-model pipeline as classic mode.

Maps configuration resolution order (first hit wins):

1. **Backend** `GET /api/maps/config` — the key lives only on the server.
2. `window.__LIFESPEAK_GOOGLE_MAPS_CONFIG` (set before the page script runs,
   e.g. via a small inline script in a local-only HTML page) — dev override
   when the backend is absent.
3. `GOOGLE_MAPS_API_KEY` / `GOOGLE_MAPS_MAP_ID` env vars where a
   `process.env` exists.

All are optional — nothing needs configuring to play:
- **No key anywhere** → deterministic *mock mode*: a canned center and three mock
  places (`The Central Perk Café` etc.) appear. Mock mode is the default for
  local dev without secrets.
- **Key found** → the Maps JS API loads with the Places library; geolocation
  permission is best-effort (denied → fallback center, Places search still
  runs). All Maps traffic goes through `src/gmaps/maps.js`, which logs every
  request/response (url, action, headers, body, masked-key curl
  reconstruction) per the project HTTP-logging constraint. If a live search
  returns zero places (ZERO_RESULTS / quota errors), the HUD says so and the
  page returns to the splash — the place picker never renders empty.

CI e2e may run against either mode: the workflow injects `GOOGLE_MAPS_API_KEY`
and `GOOGLE_MAPS_MAP_ID` when the GitHub secret/var are set, otherwise the
container runs without them and the backend answers `404` for
`/api/maps/config`. Playwright specs probe `/api/maps/config` first and expect
**3 mock places** on `404` or **≥1 real place** on `200`, so the same suite
passes with or without secrets.

## Mobile (same Wi-Fi)

```bash
npx serve . --listen 0.0.0.0:8080
```

Find your machine's LAN IP (`ip addr | grep "inet "`), then open
`http://<LAN-IP>:8080` on your phone. iOS Safari and Android Chrome both work;
iOS requires HTTPS for mic access in some contexts — if mic is blocked, serve
via a tunnel (`npx localtunnel --port 8080` or Tailscale).

## Docker

```bash
docker build -t lifespeak:local .
docker run -d --rm -p 127.0.0.1:8080:8080 lifespeak:local
# Open http://127.0.0.1:8080
```

The image is multi-arch (`linux/amd64`, `linux/arm64`), runs as the non-root
`node` user, and has a built-in healthcheck on `/api/healthz`. Persist user
data across container restarts by mounting a volume at `/app/data` (the
default `DATA_DIR` inside the image).

## Controls

- **Push-to-talk**: hold the mic button, speak, release. Interim transcript
  streams live; release (or auto-timeout after 12s) scores the utterance.
- **Text input fallback**: if SpeechRecognition is unavailable, never starts
  (headless Chromium), or a listen times out with no transcript, a text field
  appears and works identically. This is the path e2e runs drive.
- **TTS degradation**: NPC lines are spoken via speechSynthesis where voices
  exist. Where synthesis errors (no voices — headless/CI/servers) or the
  engine stalls, the dialogue continues automatically after a rate-scaled
  watchdog (`TTS_FLOOR_MS` floor, ~75 ms/char in `src/game/loop.js`) so the
  game never freezes on audio.
- **Export data**: click the export icon in the HUD to download
  `lifespeak-export-YYYY-MM-DD.jsonl` for offline analysis.

## Dev

```bash
# Tests
npm test

# Syntax check (CI uses this)
for f in src/engine/engine.js src/engine/props.js src/game/loop.js \
         src/ai/director.js src/ai/provider.js src/ai/mockProvider.js \
         src/data/eventlog.js src/data/learnerModel.js src/data/analytics.js \
         src/gmaps/maps.js \
         src/speech/speech.js src/ui/hud.js \
         src/sim/world.js src/sim/people.js src/sim/market.js \
         scenarios/scenarios.js; do
  node --check "$f"
done

# Asset manifest validation
node -e 'JSON.parse(require("fs").readFileSync("assets/kits/manifest.json","utf8"))'

# e2e (requires Playwright + a running game on :8080)
npm install
npx playwright install --with-deps chromium
npx playwright test --project=desktop

# Mobile e2e via redroid (CI workflow does this)
./scripts/ci-start-redroid.sh
npx playwright test --project=mobile
```

## CI

The `.github/workflows/ci.yml` workflow runs on every push / PR:

1. **test-unit** — Node unit tests + JSON manifest + `node --check` over every module.
2. **test-desktop-e2e** — builds the multi-arch image, runs it on
   `127.0.0.1:8080`, drives Playwright with Chrome (SwiftShader WebGL).
3. **test-mobile-e2e** — starts `redroid/redroid:12.0.0-latest`, installs
   Cromite as the browser, runs the `mobile` Playwright project against the
   same containerized game.
4. **build-and-publish** — multi-arch (`linux/amd64`, `linux/arm64`) image
   built and pushed to `ghcr.io/<repo>` on `main` / `v*` tags; load-only on PRs.

The workflow honors `PUBLISH_IMAGE` so PRs only load, not push.

### e2e timeout tuning

The desktop and mobile explore-mode tests wait up to 45s on `#hud input`
because advancing through a place-driven dialogue beat invokes two
sequential backend AI calls (`directNextScenario` + `npcTurn` opening
line) plus the headless STT synthetic-stuck timer (2s) that degrades
to the typed-reply path. Under upstream AI gateway latency bursts that
chain can easily exceed 30s, which is Playwright's default test
timeout. To give the 45s locator assertion headroom, `playwright.config.cjs`
raises the global test timeout to **90s in CI** (30s locally). Locator
timeouts are bounded by their enclosing test timeout — raising only the
locator's `timeout` flag without raising the test timeout has no effect,
which is why this lives at the config level rather than per-test.
