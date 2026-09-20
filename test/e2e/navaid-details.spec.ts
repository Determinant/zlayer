import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

for (const [width, height] of [[1280, 900], [393, 852], [568, 320]] as const) {
  test(`VOR details show frequency and Morse at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.getByLabel('Search FAA navigation data').fill('CMA');
    await page.locator('.search-results button').filter({ hasText: 'CMA' }).click();

    const card = page.locator('.feature-card');
    const details = card.getByRole('region', { name: 'Feature information' });
    const frequency = details.locator('dt', { hasText: 'Frequency' }).locator('..').locator('dd');
    await expect(card.locator('h2')).toHaveText('CMA');
    await expect(frequency).toContainText('115.8');
    await expect(frequency.getByRole('img', { name: /Morse identifier CMA/ })).toBeVisible();
    await expect(details).toBeVisible();
    expect((await details.boundingBox())!.height).toBeGreaterThan(40);
  });
}
