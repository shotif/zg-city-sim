import { expect, test } from '@playwright/test';

test('renders Zagreb in the map, isometric and 3D views', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('./');
  await page.waitForFunction(() => window.__ZG__?.ready === true, null, { timeout: 150_000 });
  await expect(page.locator('.hud-overlay-error')).toHaveCount(0);

  for (const mode of ['map', 'iso', 'free'] as const) {
    await page.evaluate((m) => window.__ZG__?.setView(m), mode);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: testInfo.outputPath(`${mode}.png`) });
    await expect(page.locator(`.hud-button[aria-pressed="true"]`)).toHaveCount(1);
  }

  expect(errors).toEqual([]);
});
