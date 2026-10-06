import { expect, test } from '@playwright/test';

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
