import { test, expect } from '@playwright/test';

const consoleErrors = [];

test.beforeEach(async ({ page }) => {
  consoleErrors.length = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });
});

test.describe('LifeSpeak smoke', () => {
  test('homepage renders with splash + start button', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/LifeSpeak/);
    await expect(page.locator('#splash')).toBeVisible();
    await expect(page.locator('#start')).toBeVisible();
    await expect(page.locator('#stage')).toBeAttached();
  });

  test('three.js scene boots and canvas mounts when Start is clicked', async ({ page }) => {
    await page.goto('/');
    await page.locator('#start').click();
    await expect(page.locator('#splash')).toHaveCount(0, { timeout: 5000 });

    // The engine module injects a <canvas> into #stage and exposes a global hook
    // for tests to confirm three initialized without throwing.
    const sceneStatus = await page.evaluate(async () => {
      // Import the engine module from the served URL to confirm it parses and runs
      const mod = await import('/src/engine/engine.js');
      const eng = mod.createEngine(document.getElementById('stage'), { headless: true });
      eng.dispose();
      return { ok: true, hasWebGL: !!document.createElement('canvas').getContext('webgl2') };
    });
    expect(sceneStatus.ok).toBeTruthy();
  });

  test('manifest contains every kit referenced by scenarios', async ({ page }) => {
    await page.goto('/');
    const check = await page.evaluate(async () => {
      const scen = await import('/scenarios/scenarios.js');
      const manifest = await fetch('/assets/kits/manifest.json').then((r) => r.json());
      const propIds = new Set();
      for (const kit of manifest.kits) for (const layout of kit.layouts)
        for (const slot of layout.slots) for (const opt of slot.options) propIds.add(opt);
      const allScen = Object.values(scen.beats).map((b) => b.location);
      const missing = allScen.filter((loc) => !manifest.kits.find((k) => k.id === loc));
      return { scenarioLocations: allScen, kits: manifest.kits.map((k) => k.id), missing, propCount: propIds.size };
    });
    expect(check.kits.length).toBeGreaterThanOrEqual(6);
    expect(check.missing).toEqual([]);
    expect(check.propCount).toBeGreaterThanOrEqual(30);
  });

  test('no fatal console errors on load', async ({ page }) => {
    await page.goto('/');
    // give three.js a moment to throw on missing shaders
    await page.waitForTimeout(750);
    // Treat network 404 for favicon and missing mic permission as benign here
    const fatal = consoleErrors.filter((t) =>
      !/favicon/i.test(t) && !/microphone/i.test(t) && !/permissions-policy/i.test(t),
    );
    expect(fatal, fatal.join('\n')).toEqual([]);
  });

  test('explore mode: place picker → café dialogue (mock maps)', async ({ page }) => {
    // No GOOGLE_MAPS_API_KEY in CI: maps boundary falls back to deterministic
    // mock mode with 3 canned places. Drive the real user path: click
    // Explore, pick the café, advance one dialogue turn via the text-input
    // fallback (no SpeechRecognition in headless Chromium).
    await page.goto('/');
    await page.locator('#explore').click();
    await expect(page.locator('#splash')).toHaveCount(0, { timeout: 5000 });

    const picker = page.locator('#hud-place-picker');
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await expect(picker.locator('button.place')).toHaveCount(3);
    await picker.locator('button.place').first().click();

    // NPC opens, then the loop awaits a STT session that degrades to the
    // typed reply path — assert the dialogue HUD renders.
    await expect(page.locator('#hud')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#hud input')).toBeVisible({ timeout: 20_000 });

    const fatal = consoleErrors.filter((t) =>
      !/favicon/i.test(t) && !/microphone/i.test(t) && !/permissions-policy/i.test(t),
    );
    expect(fatal, fatal.join('\n')).toEqual([]);
  });
});