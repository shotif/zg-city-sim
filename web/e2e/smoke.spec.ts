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
    await expect(page.locator(`.hud-button[aria-pressed="true"]`)).toHaveCount(1);
  }
  const chunks = await page.evaluate(() => [
    window.__ZG__?.roads?.builtChunks ?? 0,
    window.__ZG__?.buildings?.builtChunks ?? 0,
  ]);
  expect(chunks[0]).toBeGreaterThan(0);
  expect(chunks[1]).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
