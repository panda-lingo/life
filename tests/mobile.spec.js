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

test.describe('LifeSpeak mobile (redroid)', () => {
  test.use({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    hasTouch: true,
    isMobile: true,
  });

  test('mobile viewport: splash fits, start button is tappable', async ({ page }) => {
    await page.goto('/');
    const splash = page.locator('#splash');
    const button = page.locator('#start');
    await expect(splash).toBeVisible();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    // 44pt minimum tap target (iOS HIG / Material a11y)
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await button.tap();
    await expect(splash).toHaveCount(0, { timeout: 5000 });
  });

  test('three.js scene runs on mobile viewport with WebGL', async ({ page }) => {
    await page.goto('/');
    await page.locator('#start').tap();
    const status = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const mod = await import('/src/engine/engine.js');
      const eng = mod.createEngine(document.getElementById('stage'), { headless: true });
      eng.dispose();
      return { webgl: !!gl, ok: true };
    });
    expect(status.webgl).toBeTruthy();
    expect(status.ok).toBeTruthy();
  });

  test('no fatal console errors on mobile load', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(750);
    const fatal = consoleErrors.filter((t) =>
      !/favicon/i.test(t) && !/microphone/i.test(t) && !/permissions-policy/i.test(t),
    );
    expect(fatal, fatal.join('\n')).toEqual([]);
  });

  test('sim status bar renders and wraps responsively at mobile width', async ({ page }) => {
    // The sim status bar (docs/simulation.md) uses flex-wrap so time/money/
    // energy/mood/stress fit a 412px redroid viewport without overflow.
    await page.goto('/');
    await page.locator('#start').tap();
    await expect(page.locator('#splash')).toHaveCount(0, { timeout: 5000 });

    const status = page.locator('#hud-status');
    await expect(status).toBeVisible({ timeout: 10_000 });
    await expect(status).toContainText(/Day 1/);
    await expect(status).toContainText(/💰/);
    await expect(status).toContainText(/⚡/);
    // No horizontal overflow: the document never scrolls past the viewport.
    const overflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollW, 'page overflows viewport horizontally').toBeLessThanOrEqual(overflow.clientW);
  });

  test('explore mode: place picker tappable, dialogue HUD renders (mock maps)', async ({ page, request }) => {
    // Same flow as the desktop explore test, exercised at the redroid
    // viewport. Mock maps (no API key) renders 3 places; real maps (key set
    // in CI) renders >=1 — both paths must work, tap targets must hit 44px.
    await page.goto('/');
    const mapsCfg = await request.get('/api/maps/config');
    const realMaps = mapsCfg.status() === 200;
    const health = await request.get('/api/healthz').then((r) => r.json().catch(() => ({})));
    const realAI = health?.ai === true;
    await page.locator('#explore').tap();
    await expect(page.locator('#splash')).toHaveCount(0, { timeout: 5000 });

    const picker = page.locator('#hud-place-picker');
    await expect(picker).toBeVisible({ timeout: 10_000 });
    if (realMaps) {
      await expect(picker.locator('button.place')).not.toHaveCount(0);
    } else {
      await expect(picker.locator('button.place')).toHaveCount(3);
    }

    // Tap target: every place button meets the 44px minimum.
    const box = await picker.locator('button.place').first().boundingBox();
    expect(box).not.toBeNull();
    expect(box.height).toBeGreaterThanOrEqual(44);

    await picker.locator('button.place').first().tap();
    await expect(page.locator('#hud')).toBeVisible({ timeout: 10_000 });
    // In CI with real AI + Google Maps configured, advancing through the
    // explore beat involves two backend AI calls (directNextScenario + npcTurn
    // opening line) before the headless STT synthetic stuck timer (2s) degrades
    // to the typed reply input. Upstream gateway latency bursts can push this
    // step beyond 20s, so allow up to 45s for the input to appear.
    const input = page.locator('#hud input');
    if (realAI) {
      // Upstream gateway flake tolerance — mirrors realai.spec.js + the desktop
      // explore test. Skip rather than fail when the gateway bursts past 45s.
      let appeared = false;
      try { await expect(input).toBeVisible({ timeout: 45_000 }); appeared = true; } catch { appeared = false; }
      if (!appeared) test.skip(true, 'upstream AI gateway flake: explore dialogue input did not appear in 45s');
    } else {
      await expect(input).toBeVisible({ timeout: 45_000 });
    }

    // Mock-maps fallback: the backend answers 404 for /api/maps/config when
    // GOOGLE_MAPS_API_KEY is unset (documented failure mode → mock places).
    // The browser logs the 404 as a console error; that's expected, not fatal.
    // Backend-AI 5xx: when the upstream gateway flakes, the director's
    // backend-only resilience (commit 9a934ac) catches the throw and completes
    // the turn with the deterministic mock — also documented, also logged by
    // the browser as a console error.
    const fatal = consoleErrors.filter((t) =>
      !/favicon/i.test(t) &&
      !/microphone/i.test(t) &&
      !/permissions-policy/i.test(t) &&
      !/\/api\/maps\/config/i.test(t) &&
      !/status of 404/i.test(t) &&
      !/\/api\/ai\/complete/i.test(t) &&
      !/status of 5\d\d/i.test(t) &&
      // Headless/CI has no real WebGL — Google Maps JS SDK logs this
      // expected warning and silently falls back to raster tiles.
      !/vector map/i.test(t) && !/failed.*webgl/i.test(t),
    );
    expect(fatal, fatal.join('\n')).toEqual([]);
  });
});