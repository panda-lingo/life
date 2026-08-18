import { test, expect } from '@playwright/test';

// Backend boundary e2e: runs against the containerized game (Docker image in
// CI). CI may export GOOGLE_MAPS_API_KEY / GOOGLE_MAPS_MAP_ID into the
// container when the GitHub secret/var are set — in that case maps config
// answers 200 and live Places is used; otherwise the container runs without
// secrets, maps config answers 404, and explore mode falls back to the
// deterministic mock. These specs drive the same-origin /api/* surface
// directly via `page.request`, then verify the page works end-to-end in
// either configuration.
//
// The same assertions run on desktop and mobile viewports (mobile project
// narrows the viewport only — the API surface is viewport-agnostic).
test.describe('backend boundary', () => {
  test('GET /api/healthz reports ai/maps booleans', async ({ request }) => {
    const res = await request.get('/api/healthz');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    // CI never exports secrets into the e2e job, so both flags must be false.
    // Local dev with secrets set flips them to true — either is valid, so we
    // assert shape only.
    expect(typeof body.ai).toBe('boolean');
    expect(typeof body.maps).toBe('boolean');
  });

  test('GET /api/maps/config answers 404 when no key is set (explore falls back to mock)', async ({ request }) => {
    const res = await request.get('/api/maps/config');
    // When the server has a key this answers 200 with the key masked in logs.
    // In CI the container runs without GOOGLE_MAPS_API_KEY, so 404 is the
    // contract that unlocks the deterministic mock maps path the game tests
    // rely on.
    expect([404, 200]).toContain(res.status());
    if (res.status() === 404) {
      const body = await res.json();
      expect(body.error).toMatch(/not configured/i);
    }
  });

  test('POST + GET /api/events round-trips a batch with dedup', async ({ request }) => {
    const session = `e2e-${Date.now()}`;
    const events = [
      { id: `ev-${Date.now()}-1`, v: 1, ts: Date.now(), sessionId: session, seq: 0, type: 'session.start' },
      { id: `ev-${Date.now()}-2`, v: 1, ts: Date.now() + 1, sessionId: session, seq: 1, type: 'place.selected', placeId: 'mock-cafe-central' },
    ];
    const post = await request.post('/api/events', { data: { events } });
    expect(post.ok()).toBeTruthy();
    const ack = await post.json();
    expect(ack.accepted).toBe(2);
    expect(ack.deduped).toBe(0);

    // Re-posting the same batch must dedupe by id (client retry contract).
    const repost = await request.post('/api/events', { data: { events } });
    expect(repost.ok()).toBeTruthy();
    const ack2 = await repost.json();
    expect(ack2.accepted).toBe(0);
    expect(ack2.deduped).toBe(2);

    const list = await request.get(`/api/events?session=${session}`);
    expect(list.ok()).toBeTruthy();
    const { events: got } = await list.json();
    expect(got.map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort());
  });

  test('page boots with no secrets and reaches explore mock mode', async ({ page, request }) => {
    // CI may run with or without GOOGLE_MAPS_API_KEY / GOOGLE_MAPS_MAP_ID
    // exported into the container. Probe the boundary and assert the place
    // picker accordingly: 3 canned mock places on 404, ≥1 real Places on 200.
    await page.goto('/');
    const mapsCfg = await request.get('/api/maps/config');
    const realMaps = mapsCfg.status() === 200;
    // The game should render its splash either way — both paths degrade to
    // a usable picker (real Places or deterministic mock).
    await expect(page.locator('#splash')).toBeVisible();

    await page.locator('#explore').click();
    await expect(page.locator('#splash')).toHaveCount(0, { timeout: 5000 });
    const picker = page.locator('#hud-place-picker');
    await expect(picker).toBeVisible({ timeout: 10_000 });
    if (realMaps) {
      await expect(picker.locator('button.place')).not.toHaveCount(0);
    } else {
      await expect(picker.locator('button.place')).toHaveCount(3);
    }
  });
});
