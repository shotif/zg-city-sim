import { expect, test } from '@playwright/test';

// Live road closures and the weather come from the repository's live-data branch; tests
// use fixed copies (clear weather, so the light is as the time of day makes it).
test.beforeEach(async ({ page }) => {
  await page.route('**/live-data/closures.json', (route) =>
    route.fulfill({ path: 'e2e/fixtures/closures.json', contentType: 'application/json' }),
  );
  await page.route('**/live-data/weather.json', (route) =>
    route.fulfill({ path: 'e2e/fixtures/weather.json', contentType: 'application/json' }),
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
    // The terrain in tiles coarser with distance (M6f): 1.9 million triangles before.
    const terrain = await page.evaluate(() => [
      window.__ZG__?.terrain?.drawn ?? 0,
      window.__ZG__?.terrain?.triangles ?? 0,
    ]);
    expect(terrain[0]).toBeGreaterThan(0);
    expect(terrain[1]).toBeLessThan(500_000);
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

  // ?perf shows how fast it runs (M6f).
  await page.goto('./?perf');
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
  // Cars of several shapes among them (M6c).
  const shapes = await page.evaluate(
    () =>
      new Set(
        window
          .__ZG__!.vehicles!.object.children.filter(
            (m) => (m as unknown as { count: number }).count > 0,
          )
          .map((m) => m.name)
          .filter((name) => /^vehicles [0-4]$/.test(name)),
      ).size,
  );
  expect(shapes).toBeGreaterThan(1);
  await expect(page.locator('.perf-overlay')).toContainText(/fps drawn[\s\S]*ms\/step/);
  const perf = await page.evaluate(() => window.__ZG__?.perf);
  expect(perf?.drawCalls).toBeGreaterThan(0);
  expect(perf?.sim?.stepMs).toBeGreaterThan(0);

  // Speed up, then pause: the clock follows.
  await page.getByRole('button', { name: '16×' }).click();
  await page.waitForTimeout(2000);
  await page.keyboard.press(' ');
  // The last frame before the pause may still be on its way: read the clock once it is in.
  await page.waitForTimeout(1500);
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
  const canvas = page.locator('canvas').first();
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

test('runs a planned project and compares it with today', async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('./');
  await page.waitForFunction(() => window.__ZG__?.build !== undefined, null, {
    timeout: 150_000,
  });
  await page.keyboard.press('b');
  await page.getByLabel('Project').selectOption('jarunski-most');
  await expect(page.locator('.build-project-status')).toContainText('Planned');
  await page.getByRole('button', { name: 'Open this project' }).click();

  // The project's network runs in place of today's, with the bridge on it.
  await page.waitForURL(/project=jarunski-most/);
  await page.waitForFunction(
    () => window.__ZG__?.project === 'jarunski-most' && window.__ZG__?.sim?.ready === true,
    null,
    { timeout: 150_000 },
  );
  const bridge = await page.evaluate(() => {
    const zg = window.__ZG__!;
    const project = zg.projects!.find((p) => p.id === zg.project)!;
    return project.newEdges.filter((e) => zg.roadIndex!.net.nameOf(e) === 'Jarunski most').length;
  });
  expect(bridge).toBeGreaterThan(0);
  await expect(page.locator('.build-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: "Back to today's roads" })).toBeVisible();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: testInfo.outputPath('project.png') });

  // Compared with today's roads, loaded as a second network.
  await page.getByRole('button', { name: "Compare with today's roads" }).click();
  await page.waitForFunction(() => window.__ZG__?.baseline?.ready === true, null, {
    timeout: 150_000,
  });
  await expect(page.locator('.build-table thead')).toContainText('With project', {
    timeout: 120_000,
  });
  await expect(page.locator('.build-travel .build-travel-summary')).toContainText('on average', {
    timeout: 120_000,
  });
  await page.getByRole('button', { name: 'Stop comparing' }).click();

  await page.getByRole('button', { name: "Back to today's roads" }).click();
  await page.waitForURL((url) => !url.searchParams.has('project'));
  await page.waitForFunction(() => window.__ZG__?.roadsReady === true, null, { timeout: 150_000 });
  expect(await page.evaluate(() => window.__ZG__?.project)).toBeUndefined();

  expect(errors).toEqual([]);
});

test('draws a new road that traffic takes, and takes it away again', async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('./?speed=16');
  await page.waitForFunction(
    () => window.__ZG__?.sim?.ready === true && window.__ZG__?.drawer !== undefined,
    null,
    { timeout: 150_000 },
  );
  // The middles of two main roads in Novi Zagreb, 300-450 m apart.
  const ends = await page.evaluate(() => {
    const index = window.__ZG__!.roadIndex!;
    const net = index.net;
    const roads: { x: number; z: number }[] = [];
    for (let e = 0; e < net.edgeCount; e++) {
      if (!index.editable(e) || !['primary', 'secondary', 'tertiary'].includes(net.edgeClass[e])) {
        continue;
      }
      const ref = index.ref(e);
      if (
        Math.hypot(ref.x - 1000, ref.z - 4500) < 1500 &&
        net.laneLength[net.edgeLaneStart[e]] > 150
      ) {
        roads.push(ref);
      }
    }
    for (const a of roads) {
      for (const b of roads) {
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d > 300 && d < 450) return [a, b];
      }
    }
    return [];
  });
  expect(ends).toHaveLength(2);
  const before = await page.evaluate(() => window.__ZG__!.network!.edgeCount);

  // Draw it on the map: a click where it starts, one where it ends, then Finish road.
  await page.keyboard.press('b');
  await page.getByRole('button', { name: 'Draw a road' }).click();
  const canvas = page.locator('canvas').first();
  for (const p of ends) {
    await page.evaluate(({ x, z }) => {
      window.__ZG__?.setView('map');
      window.__ZG__?.lookAt(x, z, 800);
    }, p);
    await page.waitForTimeout(500);
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await page.getByRole('button', { name: 'Finish road' }).click();
  await expect(page.locator('.build-list li')).toContainText('New secondary road');
  await page.waitForFunction(() => (window.__ZG__?.sim?.networkApplied ?? 0) >= 1, null, {
    timeout: 60_000,
  });
  const road = await page.evaluate(() => window.__ZG__!.drawn!.roads[0]);
  expect(road).toHaveLength(2);
  expect(await page.evaluate(() => window.__ZG__!.network!.edgeCount)).toBeGreaterThan(before);
  // It cost money (M5e): two lanes of 300-450 m at €1.1 million a lane-km.
  const spent = await page.evaluate(() => window.__ZG__!.budget!.budget.spent);
  expect(spent).toBeGreaterThan(600_000);
  expect(spent).toBeLessThan(2_000_000);
  await expect(page.locator('.build-list li')).toContainText('€');

  // Traffic drives onto it.
  await expect
    .poll(
      () =>
        page.evaluate(async (edges) => {
          const sim = window.__ZG__!.sim!;
          const { counts } = await sim.volumes(sim.stats![0]);
          return edges.reduce((n, e) => n + counts[e], 0);
        }, road),
      { timeout: 180_000, intervals: [5_000] },
    )
    .toBeGreaterThan(0);
  const mid = { x: (ends[0].x + ends[1].x) / 2, z: (ends[0].z + ends[1].z) / 2 };
  await page.evaluate(({ x, z }) => window.__ZG__?.lookAt(x, z, 900), mid);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: testInfo.outputPath('new-road.png') });

  // Undo takes it away again; the vehicles on it leave and the rest drive on.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(() => (window.__ZG__?.sim?.networkApplied ?? 0) >= 2, null, {
    timeout: 60_000,
  });
  expect(await page.evaluate(() => window.__ZG__!.network!.edgeCount)).toBe(before);
  const running = await page.evaluate(() => window.__ZG__!.sim!.stats![1]);
  expect(running).toBeGreaterThan(100);
  // Taken back, it is refunded; and a road the City cannot pay for is not built.
  expect(await page.evaluate(() => window.__ZG__!.budget!.budget.spent)).toBe(0);
  await page.evaluate(() => {
    window.__ZG__!.budget!.budget.balance = 1000;
  });
  await page.getByRole('button', { name: 'Draw a road' }).click();
  for (const p of ends) {
    await page.evaluate(({ x, z }) => window.__ZG__?.lookAt(x, z, 800), p);
    await page.waitForTimeout(500);
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await page.getByRole('button', { name: 'Finish road' }).click();
  await expect(page.locator('.build-draw-status')).toContainText('Not enough money');
  expect(await page.evaluate(() => window.__ZG__!.network!.edgeCount)).toBe(before);

  // The Budget panel: the balance, a year's flows and the balance over time.
  await page.keyboard.press('Escape');
  await page.keyboard.press('m');
  await expect(page.locator('.budget-panel')).toBeVisible();
  await expect(page.locator('.budget-balance')).toContainText('€');
  await expect(page.locator('.budget-rows')).toContainText('Streets budget');
  await page.screenshot({ path: testInfo.outputPath('budget.png') });

  expect(errors).toEqual([]);
});

test('makes a junction a roundabout and sets traffic lights', async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('./?speed=16');
  await page.waitForFunction(
    () => window.__ZG__?.sim?.ready === true && window.__ZG__?.build !== undefined,
    null,
    { timeout: 150_000 },
  );
  // Each network applied, or the engine stopped (its message is among the errors).
  const networkApplied = async (n: number) => {
    await expect
      .poll(
        async () =>
          errors.length > 0 ||
          (await page.evaluate(() => window.__ZG__?.sim?.networkApplied ?? 0)) >= n,
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(errors).toEqual([]);
  };
  // Junctions in Novi Zagreb without lights or tracks where three or four main roads meet,
  // each road into them at least 80 m long.
  const candidates = await page.evaluate(() => {
    const index = window.__ZG__!.roadIndex!;
    const net = index.net;
    const ins = new Map<number, number[]>();
    const tracks = new Set<number>();
    for (let e = 0; e < net.edgeCount; e++) {
      if (net.isInternal(e)) continue;
      for (let k = 0; k < net.edgeLaneCount[e]; k++) {
        const lane = net.edgeLaneStart[e] + k;
        if (net.allows(lane, 'tram') || net.allows(lane, 'rail')) {
          tracks.add(net.edgeTo[e]);
          tracks.add(net.edgeFrom[e]);
        }
      }
      if (!index.editable(e)) continue;
      const list = ins.get(net.edgeTo[e]) ?? [];
      list.push(e);
      ins.set(net.edgeTo[e], list);
    }
    const out: { edge: number; x: number; z: number }[] = [];
    for (const [j, list] of ins) {
      const x = net.junctionPos[j * 2];
      const z = net.junctionPos[j * 2 + 1];
      if (net.index.junctionTypes[net.junctionType[j]] !== 'priority' || tracks.has(j)) continue;
      if (list.length < 3 || list.length > 4 || Math.hypot(x - 1000, z - 4500) > 2500) continue;
      const main = list.filter((e) =>
        ['primary', 'secondary', 'tertiary'].includes(net.edgeClass[e]),
      );
      if (main.length < 2) continue;
      if (list.some((e) => net.laneLength[net.edgeLaneStart[e]] < 80)) continue;
      out.push({ edge: main[0], x, z });
    }
    return out.slice(0, 10);
  });
  expect(candidates.length).toBeGreaterThan(0);
  const before = await page.evaluate(() => window.__ZG__!.network!.edgeCount);

  // The roundabout tool, on the junction ahead of the road chosen.
  await page.keyboard.press('b');
  let made: { x: number; z: number } | undefined;
  for (const c of candidates) {
    await page.evaluate((edge) => window.__ZG__!.build!.select(edge), c.edge);
    await page.getByRole('button', { name: 'Make a roundabout' }).click();
    if ((await page.locator('.build-list li').count()) > 0) {
      made = c;
      break;
    }
  }
  expect(made).toBeDefined();
  await expect(page.locator('.build-list li').first()).toContainText('Roundabout at');
  await networkApplied(1);
  const ring = await page.evaluate(() => window.__ZG__!.drawn!.roads[0]);
  expect(ring.length).toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => window.__ZG__!.network!.edgeCount)).toBeGreaterThan(before);
  // Traffic drives round it.
  await expect
    .poll(
      () =>
        page.evaluate(async (edges) => {
          const sim = window.__ZG__!.sim!;
          const { counts } = await sim.volumes(sim.stats![0]);
          return edges.reduce((n, e) => n + counts[e], 0);
        }, ring),
      { timeout: 180_000, intervals: [5_000] },
    )
    .toBeGreaterThan(0);
  await page.evaluate(({ x, z }) => {
    window.__ZG__?.setView('map');
    window.__ZG__?.lookAt(x, z, 250);
  }, made!);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: testInfo.outputPath('roundabout.png') });

  // The signal editor, on lights near the centre: a longer first phase, run as set.
  const lights = await page.evaluate(() => {
    const index = window.__ZG__!.roadIndex!;
    const net = index.net;
    for (let e = 0; e < net.edgeCount; e++) {
      if (!index.editable(e) || index.signalAt(e) === undefined) continue;
      const ref = index.ref(e);
      if (Math.hypot(ref.x, ref.z) < 3000 && index.turns(e).length >= 3) return e;
    }
    return -1;
  });
  expect(lights).toBeGreaterThanOrEqual(0);
  // The roundabout's own junctions offer no roundabout again.
  await expect(page.locator('.build-junction')).not.toContainText('Make a roundabout');
  await page.evaluate((edge) => window.__ZG__!.build!.select(edge), lights);
  await page.evaluate((edge) => {
    const net = window.__ZG__!.network!;
    const j = net.edgeTo[edge];
    window.__ZG__?.lookAt(net.junctionPos[j * 2], net.junctionPos[j * 2 + 1], 250);
  }, lights);
  await page.getByRole('button', { name: 'Edit traffic lights' }).click();
  await expect(page.locator('.build-signals')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: testInfo.outputPath('signal-editor.png') });
  const length = page.getByLabel('Phase 1 length (s)');
  await length.fill('45');
  await length.dispatchEvent('change');
  await page.getByRole('button', { name: 'Apply lights' }).click();
  await expect(page.locator('.build-list li')).toHaveCount(2);
  await expect(page.locator('.build-list li').nth(1)).toContainText('Traffic lights at');
  await networkApplied(2);
  await page.waitForFunction(
    (edge) => {
      const zg = window.__ZG__!;
      const t = zg.roadIndex!.signalAt(edge);
      const signals = zg.sim?.signals;
      return t !== undefined && signals?.duration[signals.phaseOffsets[t]] === 45;
    },
    lights,
    { timeout: 30_000 },
  );
  await page.screenshot({ path: testInfo.outputPath('signals.png') });

  // Undone, both: today's roads again, and the traffic drives on.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await networkApplied(3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await networkApplied(4);
  expect(await page.evaluate(() => window.__ZG__!.network!.edgeCount)).toBe(before);
  expect(await page.evaluate(() => window.__ZG__!.sim!.stats![1])).toBeGreaterThan(100);

  expect(errors).toEqual([]);
});

test('zones lots by painting them, and keeps and shares the zoning', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const ready = () =>
    page.waitForFunction(() => window.__ZG__?.zoning !== undefined, null, { timeout: 150_000 });
  const zoned = () =>
    page.evaluate(() => window.__ZG__!.zoning!.zones.reduce((n, z) => n + (z > 0 ? 1 : 0), 0));

  await page.goto('./');
  await ready();
  // A village street in southern Novi Zagreb with free lots planned for housing.
  const spot = await page.evaluate(() => {
    const lots = window.__ZG__!.zoning!.lots;
    let best = { x: 0, z: 0, n: 0 };
    for (let i = 0; i < lots.count; i++) {
      if (lots.planOf(i)?.id !== 'residential') continue;
      if (Math.hypot(lots.x[i] + 1500, lots.z[i] - 7800) > 2000) continue;
      const n = lots.within(lots.x[i], lots.z[i], 60).length;
      if (n > best.n) best = { x: lots.x[i], z: lots.z[i], n };
    }
    return best;
  });
  expect(spot.n).toBeGreaterThan(2);

  await page.keyboard.press('z');
  await expect(page.locator('.zones-panel')).toBeVisible();
  await page.evaluate(({ x, z }) => {
    window.__ZG__?.setView('map');
    window.__ZG__?.lookAt(x, z, 400);
  }, spot);
  await page.waitForTimeout(1500);

  // Houses, painted by dragging across the middle of the view: the map stays put.
  await page.getByRole('button', { name: 'Houses', exact: true }).click();
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  const before = await page.evaluate(() => window.__ZG__!.rig!.state().target.clone());
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy, { steps: 10 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.__ZG__!.rig!.state().target.clone());
  expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(1);
  const houses = await page.evaluate(
    () => window.__ZG__!.zoning!.zones.filter((z) => z === 1).length,
  );
  expect(houses).toBeGreaterThan(0);
  await expect(page.locator('.zone-totals')).toContainText('Houses');
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath('zones.png') });

  // As the City plans, with a large brush, and the plan shown.
  await page.getByRole('button', { name: 'As the City plans' }).click();
  await page.getByLabel('Brush size').selectOption('200');
  await page.mouse.click(cx, cy + 40);
  expect(await zoned()).toBeGreaterThan(houses);
  await page.getByLabel("The City's planned land use").check();
  await page.keyboard.press('Escape');
  await page.evaluate(({ x, z }) => window.__ZG__?.lookAt(x, z, 3000), spot);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: testInfo.outputPath('zones-plan.png') });
  const total = await zoned();
  const strokes = await page.evaluate(() => window.__ZG__!.zoning!.strokes.length);
  expect(strokes).toBe(2);

  // Kept across a reload.
  await page.reload();
  await ready();
  expect(await zoned()).toBe(total);

  // Shared as a link, which opens with the same zoning.
  await page.keyboard.press('z');
  await page.getByRole('button', { name: 'Share zoning' }).click();
  await expect(page.locator('.zones-status')).toHaveText('Link copied.');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#zoning=[A-Za-z0-9_-]+$/);
  await page.getByRole('button', { name: 'Clear zoning' }).click();
  expect(await zoned()).toBe(0);
  await page.goto(link);
  await ready();
  await expect(page.locator('.zones-panel')).toBeVisible();
  await expect(page.locator('.zones-status')).toContainText('Loaded 2 strokes from the link.');
  expect(await zoned()).toBe(total);
  expect(page.url()).not.toContain('#zoning=');

  expect(errors).toEqual([]);
});

test('grows buildings on zoned lots as the day goes on', async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const ready = () =>
    page.waitForFunction(
      () => window.__ZG__?.zoning !== undefined && window.__ZG__?.sim?.ready === true,
      null,
      { timeout: 150_000 },
    );

  await page.goto('./?speed=64');
  await ready();
  // Free lots in a row along a street in southern Novi Zagreb, zoned for shops (built in
  // 20 simulated minutes) and houses.
  const spot = await page.evaluate(() => {
    const lots = window.__ZG__!.zoning!.lots;
    let best = { x: 0, z: 0, n: 0 };
    for (let i = 0; i < lots.count; i++) {
      if (Math.hypot(lots.x[i] + 1500, lots.z[i] - 7800) > 2000) continue;
      const n = lots.within(lots.x[i], lots.z[i], 80).length;
      if (n > best.n) best = { x: lots.x[i], z: lots.z[i], n };
    }
    // Houses on lots of their own, 150-500 m away.
    let houses = { x: 0, z: 0, n: 0 };
    for (let i = 0; i < lots.count; i++) {
      const d = Math.hypot(lots.x[i] - best.x, lots.z[i] - best.z);
      if (d < 150 || d > 500) continue;
      const n = lots.within(lots.x[i], lots.z[i], 60).length;
      if (n > houses.n) houses = { x: lots.x[i], z: lots.z[i], n };
    }
    return { ...best, houses };
  });
  expect(spot.n).toBeGreaterThan(4);
  expect(spot.houses.n).toBeGreaterThan(2);
  await page.evaluate(({ x, z, houses }) => {
    const zoning = window.__ZG__!.zoning!;
    zoning.paint('shops', 60, [[x, z]]);
    zoning.paint('houses', 60, [[houses.x, houses.z]]);
  }, spot);

  const built = () =>
    page.evaluate(() => {
      const zg = window.__ZG__!;
      return zg.zoning!.growth.totals(zg.sim!.cur?.time ?? 0);
    });
  await expect
    .poll(async () => (await built()).built, { timeout: 240_000, intervals: [5_000] })
    .toBeGreaterThan(0);
  const totals = await built();
  expect(totals.jobs).toBeGreaterThan(0);
  // What grew pays communal contributions once finished and fees every year (M5e).
  await expect
    .poll(() => page.evaluate(() => window.__ZG__!.budget!.budget.yearly.fee), {
      timeout: 60_000,
      intervals: [2_000],
    })
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__ZG__!.budget!.budget.contributions)).toBeGreaterThan(0);
  // The houses' residents make car trips: the simulation's daily total goes up (M5c).
  const today = await page.evaluate(
    async () =>
      (
        (await (await fetch('data/manifest.json')).json()) as {
          layers: { demand: { dailyCarTrips: number } };
        }
      ).layers.demand.dailyCarTrips,
  );
  await expect
    .poll(() => page.evaluate(() => window.__ZG__!.sim!.demandTrips ?? 0), {
      timeout: 240_000,
      intervals: [5_000],
    })
    .toBeGreaterThan(today);

  // In the 3D view, and listed in the Zones panel.
  await page.keyboard.press('z');
  await expect(page.locator('.zones-growth')).toContainText('Grown:');

  // Demand per kind of zone, and land value measured on the traffic simulated (M5d):
  // Novi Zagreb, by the centre, is better placed than Samobor, 20 km out.
  await expect(page.getByRole('meter')).toHaveCount(3);
  await expect(page.getByRole('meter', { name: 'Demand for homes' })).toHaveAttribute(
    'aria-valuenow',
    /^-?\d+$/,
  );
  await expect
    .poll(() => page.evaluate(() => window.__ZG__!.zoning!.landValue.access.measured), {
      timeout: 240_000,
      intervals: [5_000],
    })
    .toBe(true);
  const placed = await page.evaluate(({ x, z }) => {
    const zoning = window.__ZG__!.zoning!;
    const access = zoning.landValue.access;
    const near = zoning.lots.within(x, z, 100);
    return {
      here: access.at(x, z),
      samobor: access.at(-20701, 1177),
      value: zoning.landValue.mean(near),
      used: zoning.growth.value === zoning.landValue.value,
    };
  }, spot);
  expect(placed.here).toBeGreaterThan(placed.samobor);
  expect(placed.value).toBeGreaterThan(0);
  expect(placed.used).toBe(true);
  await page.getByRole('checkbox', { name: 'Land value' }).check();
  await expect(page.locator('.zones-value')).toContainText('best-placed land');
  await page.evaluate(({ x, z }) => window.__ZG__?.lookAt(x, z, 2500), spot);
  // Drawn once the lots around are coloured (software rendering is slow).
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => !window.__ZG__!.zoning!.layer.filling);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: testInfo.outputPath('land-value.png') });
  await page.getByRole('checkbox', { name: 'Land value' }).uncheck();
  await page.keyboard.press('z');
  await page.evaluate(({ x, z }) => {
    window.__ZG__?.setView('iso');
    window.__ZG__?.lookAt(x, z, 300);
  }, spot);
  // Drawn once the camera is down among them (software rendering is slow with the traffic).
  await page.waitForFunction(() => {
    const grown = window.__ZG__!.zoning!.grown.object;
    return grown.visible && grown.children.length > 0;
  });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: testInfo.outputPath('grown.png') });

  // Kept across a reload: the buildings stand where they grew.
  const saved = await page.evaluate(
    () => window.__ZG__!.zoning!.growth.buildings.filter((b) => b !== undefined).length,
  );
  await page.reload();
  await ready();
  const restored = await page.evaluate(
    () => window.__ZG__!.zoning!.growth.buildings.filter((b) => b !== undefined).length,
  );
  expect(restored).toBeGreaterThanOrEqual(saved);

  expect(errors).toEqual([]);
});

test('lights the city as the time of day: noon, and night with street lamps', async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const ready = () =>
    page.waitForFunction(
      () => window.__ZG__?.sim?.ready === true && window.__ZG__?.streetLights !== undefined,
      null,
      { timeout: 150_000 },
    );

  // The light for simulated time `at` (s): until the first frame comes, it follows the clock.
  const lightAt = async (at: number) => {
    await page.waitForFunction(
      (t) => Math.abs((window.__ZG__?.light?.time ?? -1e9) - t) < 1200,
      at,
      { timeout: 150_000 },
    );
    return page.evaluate(() => window.__ZG__!.light!);
  };

  // Noon: the sun high in the south, no lamps.
  await page.goto('./?start=12:00');
  await ready();
  const noon = await lightAt(12 * 3600);
  expect(noon.night).toBe(0);
  expect(noon.direction[1]).toBeGreaterThan(0.3);
  expect(noon.direction[2]).toBeGreaterThan(0.3);
  expect(await page.evaluate(() => window.__ZG__!.streetLights!.object.visible)).toBe(false);

  // Half past eleven at night: dark sky, lamps along the streets, lit windows.
  await page.goto('./?start=23:30');
  await ready();
  await expect(page.locator('.hud-sim-clock')).toHaveText(/^23:/);
  const night = await lightAt(23.5 * 3600);
  expect(night.night).toBe(1);
  expect(night.background).toBe(0x0b1424);
  expect(await page.evaluate(() => window.__ZG__!.streetLights!.count)).toBeGreaterThan(50_000);
  await page.evaluate(() => {
    window.__ZG__?.setView('3d');
    window.__ZG__?.lookAt(300, 900, 900);
  });
  await page.waitForFunction(() => {
    const lamps = window.__ZG__!.streetLights!.object;
    return lamps.visible && lamps.children.length > 0;
  });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: testInfo.outputPath('night.png') });

  // Always day: light as at midday, whatever the time; kept for the next visit.
  // (A frame of the night view in software rendering can take several seconds.)
  await page.getByRole('button', { name: 'Always day' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ZG__!.light!.night), { timeout: 30_000 })
    .toBe(0);
  await expect
    .poll(() => page.evaluate(() => window.__ZG__!.streetLights!.object.visible), {
      timeout: 30_000,
    })
    .toBe(false);
  await page.reload();
  await ready();
  await expect(page.getByRole('button', { name: 'Always day' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await page.evaluate(() => window.__ZG__!.light!.night)).toBe(0);

  expect(errors).toEqual([]);
});

test("shows Zagreb's weather, and drives and looks as the weather picked", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const ready = () =>
    page.waitForFunction(() => window.__ZG__?.sim?.ready === true, null, { timeout: 150_000 });

  await page.goto('./?start=12:00');
  await ready();
  // DHMZ's observation, copied by the live-data job.
  const picker = page.getByRole('combobox', { name: 'Weather' });
  await expect(picker.locator('option').first()).toHaveText(/^Live: (?!loading)/, {
    timeout: 30_000,
  });
  const live = await page.evaluate(() => window.__ZG__!.weather!);
  expect(live.choice).toBe('live');
  expect(live.kind).toBe('clear');
  await expect(picker.locator('option').first()).toHaveText('Live: Clear, 18 °C');
  const clearLight = await page.evaluate(() => window.__ZG__!.light!.intensity);

  // Heavy snow: a dimmer sun, snow falling in the 3D view, slower traffic in the engine.
  await picker.selectOption('heavySnow');
  await expect.poll(() => page.evaluate(() => window.__ZG__!.weather!.kind)).toBe('heavySnow');
  // On the next frame drawn, which takes seconds in headless Chromium on a busy machine.
  await expect
    .poll(() => page.evaluate(() => window.__ZG__!.light!.intensity), { timeout: 30_000 })
    .toBeLessThan(clearLight * 0.5);
  await page.evaluate(() => {
    window.__ZG__?.setView('3d');
    window.__ZG__?.lookAt(300, 600, 500);
  });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: testInfo.outputPath('heavy-snow.png') });

  // Kept for the next visit; back to the live weather.
  await page.reload();
  await ready();
  await expect(picker).toHaveValue('heavySnow');
  await picker.selectOption('live');
  await expect.poll(() => page.evaluate(() => window.__ZG__!.weather!.choice)).toBe('live');

  // The city's sound (M6e): on with a click, generated in the page; off again.
  await page.getByRole('button', { name: 'Sound' }).click();
  await expect.poll(() => page.evaluate(() => window.__ZG__!.sound!.state)).toBe('running');
  await page.getByRole('button', { name: 'Sound' }).click();
  await expect.poll(() => page.evaluate(() => window.__ZG__!.sound!.state)).toBe('suspended');

  expect(errors).toEqual([]);
});
