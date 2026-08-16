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

# Syntax check
node --check src/engine/engine.js && node --check src/game/loop.js

# Asset manifest validation
python3 -m json.tool assets/kits/manifest.json > /dev/null
```
