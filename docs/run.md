# Run — LifeSpeak

## Desktop

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080` in Chrome/Edge/Firefox. Click **Start**, allow
microphone access, and hold the **talk** button (or the mic hotkey) to speak.

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
- **Text input fallback**: if SpeechRecognition is unavailable (rare), a text
  field appears and works identically.
- **Export data**: click the export icon in the HUD to download
  `lifespeak-export-YYYY-MM-DD.jsonl` for offline analysis.

## Dev

```bash
# Tests
node --test scenarios/ src/data/

# Syntax check (CI uses this)
for f in src/engine/engine.js src/engine/props.js src/game/loop.js \
         src/ai/director.js src/ai/provider.js src/ai/mockProvider.js \
         src/data/eventlog.js src/data/learnerModel.js src/data/analytics.js \
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
