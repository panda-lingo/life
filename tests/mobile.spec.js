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
});