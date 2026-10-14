import { test, expect } from '@playwright/test';

test('public product page is readable without JavaScript and has working discovery resources', async ({ browser, baseURL, request }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    const response = await page.goto('/about');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(`${baseURL}/about/`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Free and Open-Source EFB.');
    await expect(page.getByRole('heading', { name: 'FAA charts & navigation', exact: true })).toBeVisible();
    await page.getByText('Does it sync my routes between devices?', { exact: true }).click();
    await expect(page.getByText(/There is no account-based cloud sync/)).toBeVisible();
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://zlayer.tedyin.com/about/');
    const application = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!);
    expect(application).toMatchObject({ '@type': 'WebApplication', name: 'ZLayer', url: 'https://zlayer.tedyin.com/',
      offers: { price: '0', priceCurrency: 'USD' } });
    const preview = await request.get(new URL(application.screenshot).pathname);
    expect(preview.status()).toBe(200);
    expect(preview.headers()['content-type']).toContain('image/webp');
    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.status()).toBe(200);
    expect(sitemap.headers()['content-type']).toContain('xml');
    expect(await sitemap.text()).toContain('<loc>https://zlayer.tedyin.com/about/</loc>');
    const robots = await request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    expect(robots.headers()['content-type']).toContain('text/plain');
    expect(await robots.text()).toContain('Sitemap: https://zlayer.tedyin.com/sitemap.xml');
    await page.getByRole('link', { name: 'Open ZLayer', exact: false }).first().click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Free EFB');
    await expect(page.getByRole('link', { name: /explore ZLayer’s features/ })).toBeInViewport();
  } finally { await context.close(); }
});

test('cached app preserves its About popup and About URLs keep their own navigation responses', async ({ page, context, request }) => {
  await request.post('/__test/reset');
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const route = page.getByRole('textbox', { name: 'Add route waypoint' });
  await route.fill('KSBA KSMO ');
  await route.press('Enter');
  await expect(page.locator('[data-route-entry]')).toHaveCount(2);
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('button', { name: 'About ZLayer', exact: true }).click();
  const about = page.getByRole('dialog', { name: 'About ZLayer', exact: true });
  await expect(about).toContainText('Everything starts with a layer.');
  const opened = context.waitForEvent('page');
  await about.getByRole('link', { name: 'Features and getting started', exact: true }).click();
  const publicPage = await opened;
  await expect(publicPage.getByRole('heading', { level: 1 })).toContainText('Free and Open-Source EFB.');
  await publicPage.reload();
  await expect(publicPage.getByRole('heading', { level: 1 })).toContainText('Free and Open-Source EFB.');
  await expect(about).toBeVisible();
  // About URLs bypass the cached app in the same window, including missing files.
  await page.getByLabel('Close about dialog').click();
  await page.getByLabel('Close settings').click();
  await page.goto('/about/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Free and Open-Source EFB.');
  const missing = await page.goto('/about/missing-public-page');
  expect(missing?.status()).toBe(404);
  await page.goto('/');
  await expect(page.locator('[data-route-entry]')).toHaveCount(2);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('[data-route-entry]')).toHaveCount(2);
  await context.setOffline(false);
  // Keep the original reset coordination: all tabs, including About, stop on
  // the reset screen. Older workers may have served the app at non-root URLs.
  await page.getByLabel('Settings and offline downloads').click();
  const advanced = page.locator('.reset-settings');
  await advanced.getByText('Advanced', { exact: true }).click();
  await advanced.getByLabel('Type DELETE to confirm').fill('DELETE');
  await advanced.getByRole('button', { name: 'Delete all local data', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local data cleared' })).toBeVisible({ timeout: 25_000 });
  await expect(publicPage).toHaveURL(/\/\?reset=1$/);
  await expect(publicPage.getByRole('heading', { name: 'Local data cleared' })).toBeVisible({ timeout: 25_000 });
  await publicPage.close();
});

for (const width of [320, 1440]) {
  test(`product page remains readable and links fit at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/about/');
    await expect(page.locator('.workspace-preview img')).toBeVisible();
    expect(await page.locator('.workspace-preview img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const openApp = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /Open ZLayer/ });
    await expect(openApp).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`about-${width}.png`), fullPage: true });
  });
}
