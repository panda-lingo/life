# Run — LifeSpeak

## Desktop

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

Configuration is read from `window.__LIFESPEAK_GOOGLE_MAPS_CONFIG` (set before
the page script runs, e.g. via a small inline script in a local-only HTML page)
or from `GOOGLE_MAPS_API_KEY` / `GOOGLE_MAPS_MAP_ID` env vars where a
`process.env` exists. Both are optional — nothing needs configuring to play:
- **No key** → deterministic *mock mode*: a canned center and three mock
  places (`The Central Perk Café` etc.) appear. This is the default for local
  dev and CI, and all e2e/integration coverage runs against it.
- **Key set** → the Maps JS API loads with the Places library; geolocation
  permission is best-effort (denied → fallback center, Places search still
  runs). All Maps traffic goes through `src/gmaps/maps.js`, which logs every
  request/response (url, action, headers, body, masked-key curl
  reconstruction) per the project HTTP-logging constraint. If a live search
  returns zero places (ZERO_RESULTS / quota errors), the HUD says so and the
  page returns to the splash — the place picker never renders empty.

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

The image is multi-arch (`linux/amd64`, `linux/arm64`) and runs as the
non-root `nginx` user with a built-in healthcheck on `/`.

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
