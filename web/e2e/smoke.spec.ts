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
  const networkApplied = (n: number) =>
    page.waitForFunction((k) => (window.__ZG__?.sim?.networkApplied ?? 0) >= k, n, {
      timeout: 60_000,
    });
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
