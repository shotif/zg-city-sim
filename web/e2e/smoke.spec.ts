import { expect, test } from '@playwright/test';

// Live road closures come from the repository's live-data branch; tests use a fixed copy.
test.beforeEach(async ({ page }) => {
  await page.route('**/live-data/closures.json', (route) =>
    route.fulfill({ path: 'e2e/fixtures/closures.json', contentType: 'application/json' }),
  );
});

test('renders Zagreb terrain, roads and buildings in the map, isometric and 3D views', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('./');
  await page.waitForFunction(() => window.__ZG__?.ready === true, null, { timeout: 150_000 });
  await expect(page.locator('.hud-overlay-error')).toHaveCount(0);
  await page.waitForFunction(
    () => window.__ZG__?.roadsReady === true && window.__ZG__?.buildingsReady === true,
    null,
    { timeout: 150_000 },
  );
  await page.waitForTimeout(1000);
  await page.screenshot({ path: testInfo.outputPath('city.png') });

  // Close-up of the city centre: detailed roads are built around the camera.
  for (const [mode, viewHeight] of [
    ['map', 1400],
    ['iso', 900],
    ['free', 700],
  ] as const) {
    await page.evaluate(
      ([m, h]) => {
        window.__ZG__?.setView(m);
        window.__ZG__?.lookAt(0, 150, h);
      },
      [mode, viewHeight] as const,
    );
    await page.waitForTimeout(4000);
    await page.screenshot({ path: testInfo.outputPath(`${mode}.png`) });
    await expect(page.locator(`.hud-toolbar .hud-button[aria-pressed="true"]`)).toHaveCount(1);
  }
  const chunks = await page.evaluate(() => [
    window.__ZG__?.roads?.builtChunks ?? 0,
    window.__ZG__?.buildings?.builtChunks ?? 0,
  ]);
  expect(chunks[0]).toBeGreaterThan(0);
  expect(chunks[1]).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});

test('simulates traffic and draws the vehicles', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('./');
  await page.waitForFunction(() => window.__ZG__?.sim?.ready === true, null, { timeout: 150_000 });
  // The streets fill with traffic at full speed, then the clock runs in real time.
  await page.waitForFunction(() => window.__ZG__?.sim?.warming === false, null, {
    timeout: 150_000,
  });
  await expect(page.locator('.hud-sim-clock')).toHaveText(/^07:0\d$/);
  const [running, trams, buses] = await page.evaluate(() => {
    const stats = window.__ZG__?.sim?.stats;
    return [stats?.[1] ?? 0, stats?.[14] ?? 0, stats?.[15] ?? 0];
  });
  expect(running).toBeGreaterThan(1000);
  // ZET runs about 150 trams and 200 buses at 7 in the morning.
  expect(trams).toBeGreaterThan(80);
  expect(buses).toBeGreaterThan(100);

  // Look at the busiest place near the centre.
  const spot = await page.evaluate(() => {
    const render = window.__ZG__!.sim!.cur!.render;
    const floats = new Float32Array(render.buffer);
    const cells = new Map<string, number>();
    for (let o = 0; o < render.length; o += 8) {
      if (render[o + 5] === 0) continue;
      const [x, z] = [floats[o], floats[o + 2]];
      if (Math.abs(x) > 5000 || Math.abs(z) > 5000) continue;
      const key = `${Math.floor(x / 200)},${Math.floor(z / 200)}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    const [best] = [...cells.entries()].sort((a, b) => b[1] - a[1]);
    const [cx, cz] = best[0].split(',').map(Number);
    return [cx * 200 + 100, cz * 200 + 100];
  });
  await page.evaluate(([x, z]) => {
    window.__ZG__?.setView('free');
    window.__ZG__?.lookAt(x, z, 150);
  }, spot);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: testInfo.outputPath('traffic.png') });
  expect(await page.evaluate(() => window.__ZG__?.vehicles?.drawn ?? 0)).toBeGreaterThan(0);

  // Speed up, then pause: the clock follows.
  await page.getByRole('button', { name: '16×' }).click();
  await page.waitForTimeout(2000);
  await page.keyboard.press(' ');
  const paused = await page.locator('.hud-sim-clock').textContent();
  await page.waitForTimeout(1500);
  await expect(page.locator('.hud-sim-clock')).toHaveText(paused!);

  expect(errors).toEqual([]);
});

test('shows news hotspots and live road closures', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('./?sim=off');
  await page.waitForFunction(
    () => window.__ZG__?.newsPanel !== undefined && window.__ZG__?.closures !== undefined,
    null,
    { timeout: 150_000 },
  );
  // Every closure in the test feed lies on the network.
  const closed = await page.evaluate(() => window.__ZG__!.closures!.map((c) => c.edges.length));
  expect(closed.length).toBe(4);
  expect(Math.min(...closed)).toBeGreaterThan(0);
  await expect(page.locator('.closure-marker')).toHaveCount(4);

  // News markers appear with N; Jadranski most has the most reports.
  await page.keyboard.press('n');
  await page.evaluate(() => window.__ZG__?.lookAt(-1964, 3285, 4000));
  const marker = page.locator('.news-marker[aria-label^="Jadranski most:"]');
  await expect(marker).toBeVisible();
  await marker.click();
  await expect(page.locator('.news-panel')).toBeVisible();
  await expect(page.locator('.news-title')).toHaveText('Jadranski most');
  expect(await page.locator('.news-list li').count()).toBeGreaterThan(5);
  await expect(page.locator('.news-traffic')).toHaveText(/not running/);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: testInfo.outputPath('news.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('.news-panel')).toBeHidden();

  expect(errors).toEqual([]);
});

test('edits roads with the Build tools, keeps them and shares them', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  const ready = () =>
    page.waitForFunction(
      () => window.__ZG__?.sim?.ready === true && window.__ZG__?.build !== undefined,
      null,
      { timeout: 150_000 },
    );
  const applied = (n: number) =>
    page.waitForFunction((k) => window.__ZG__?.sim?.editsApplied?.applied === k, n, {
      timeout: 30_000,
    });

  await page.goto('./');
  await ready();
  // A two-lane stretch of Savska cesta near the centre.
  const target = await page.evaluate(() => {
    const index = window.__ZG__!.roadIndex!;
    const net = index.net;
    for (let e = 0; e < net.edgeCount; e++) {
      if (net.nameOf(e) !== 'Savska cesta' || net.edgeLaneCount[e] < 2) continue;
      if (!index.editable(e) || index.turns(e).length < 2) continue;
      const ref = index.ref(e);
      if (Math.hypot(ref.x, ref.z) < 4000) return { edge: e, x: ref.x, z: ref.z };
    }
    return null;
  });
  expect(target).not.toBeNull();

  await page.keyboard.press('b');
  await expect(page.locator('.build-panel')).toBeVisible();
  await expect(page.locator('.build-hint')).toBeVisible();
  await page.evaluate(({ x, z }) => {
    window.__ZG__?.setView('map');
    window.__ZG__?.lookAt(x, z, 250);
  }, target!);
  await page.waitForTimeout(2000);
  // Click the road in the middle of the view.
  const canvas = page.locator('canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.locator('.build-road-name')).toHaveText('Savska cesta');
  expect(await page.evaluate(() => window.__ZG__?.build?.selected)).toBe(target!.edge);

  // A lower speed limit, a bus lane and a banned turn reach the engine.
  await page.getByLabel('Speed limit').selectOption('30');
  await expect(page.locator('.build-list li')).toHaveCount(1);
  await expect(page.locator('.build-list li').first()).toContainText('Savska cesta: 30 km/h');
  await applied(1);
  await page.getByLabel('Lane 1 from the left').selectOption('bus');
  await applied(2);
  await page.locator('.build-turns input[type="checkbox"]').first().uncheck();
  await expect(page.locator('.build-list li')).toHaveCount(3);
  await applied(3);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: testInfo.outputPath('build.png') });

  // Kept in the browser across a reload.
  await page.reload();
  await ready();
  await applied(3);
  await page.keyboard.press('b');
  await expect(page.locator('.build-list li')).toHaveCount(3);

  // Shared as a link, which opens with the same edits.
  await page.getByRole('button', { name: 'Share link' }).click();
  await expect(page.locator('.build-status')).toHaveText('Link copied.');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#edits=[A-Za-z0-9_-]+$/);
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.build-list li')).toHaveCount(0);
  await applied(0);
  await page.goto(link);
  await ready();
  await expect(page.locator('.build-panel')).toBeVisible();
  await expect(page.locator('.build-status')).toContainText('Loaded 3 edits from the link.');
  await expect(page.locator('.build-list li')).toHaveCount(3);
  await applied(3);
  expect(page.url()).not.toContain('#edits=');

  expect(errors).toEqual([]);
});

test("compares edited roads with today's", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('./');
  await page.waitForFunction(
    () => window.__ZG__?.sim?.ready === true && window.__ZG__?.build !== undefined,
    null,
    { timeout: 150_000 },
  );
  // Close a stretch of Savska cesta near the centre.
  const edge = await page.evaluate(() => {
    const index = window.__ZG__!.roadIndex!;
    const net = index.net;
    for (let e = 0; e < net.edgeCount; e++) {
      if (net.nameOf(e) !== 'Savska cesta' || net.edgeLaneCount[e] < 2 || !index.editable(e)) {
        continue;
      }
      const ref = index.ref(e);
      if (Math.hypot(ref.x, ref.z) < 3000) return e;
    }
    return -1;
  });
  expect(edge).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('b');
  await page.evaluate((e) => window.__ZG__!.build!.select(e), edge);
  await page.getByRole('button', { name: 'Close road' }).click();
  await expect(page.locator('.build-list li')).toHaveCount(1);

  // Both simulations start again at 06:50 with the same trips, today's without the edit.
  await page.getByRole('button', { name: "Compare with today's roads" }).click();
  await expect(page.getByRole('button', { name: 'Stop comparing' })).toBeVisible();
  await page.waitForFunction(
    () =>
      window.__ZG__?.baseline?.ready === true && window.__ZG__?.sim?.editsApplied?.applied === 1,
    null,
    { timeout: 150_000 },
  );
  await expect(page.locator('.build-table tbody tr')).toHaveCount(6, { timeout: 120_000 });
  await expect(page.locator('.build-travel-summary')).toContainText('on average over', {
    timeout: 120_000,
  });
  await page.getByLabel('Difference map').check();
  await page.waitForFunction(() => (window.__ZG__?.compared?.diff ?? -Infinity) > 0, null, {
    timeout: 120_000,
  });
  const ref = await page.evaluate((e) => window.__ZG__!.roadIndex!.ref(e), edge);
  await page.evaluate(({ x, z }) => {
    window.__ZG__?.setView('map');
    window.__ZG__?.lookAt(x, z, 3000);
  }, ref);
  await page.waitForTimeout(2000);
  await page.locator('.build-travel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('compare.png') });

  await page.getByRole('button', { name: 'Stop comparing' }).click();
  await expect(page.locator('.build-table')).toBeHidden();
  expect(await page.evaluate(() => window.__ZG__?.baseline)).toBeUndefined();

  expect(errors).toEqual([]);
});
