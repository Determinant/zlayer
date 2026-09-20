import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });
test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

test('first visit shows installation and safety before the workspace, then remembers acknowledgment', async ({ page, context }) => {
  await page.goto('/');
  const welcome = page.getByRole('dialog', { name: 'Welcome to ZLayer', exact: true });
  await expect(welcome).toBeVisible();
  await expect(welcome.getByRole('heading', { name: 'Welcome to ZLayer', exact: true })).toBeFocused();
  await expect(welcome).toContainText('iPhone and iPad');
  await expect(welcome).toContainText('Android');
  await expect(welcome).toContainText('offline');
  await expect(welcome).toContainText('No warranty');
  await expect(welcome).toContainText('Your responsibility');
  await expect(page.getByLabel('Settings and offline downloads')).toBeHidden();
  const accept = welcome.getByRole('button', { name: 'I understand', exact: true });
  const body = welcome.getByRole('region', { name: 'Installation and safety notice' });
  await expect(accept).toBeDisabled();
  await body.hover();
  await page.mouse.wheel(0, 120);
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(accept).toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(welcome).toBeVisible();
  await page.reload();
  await expect(welcome).toBeVisible();
  await expect(accept).toBeDisabled();
  await body.hover();
  await page.mouse.wheel(0, 10_000);
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(welcome).toBeHidden();
  await expect(page.getByLabel('Search FAA navigation data')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Search FAA navigation data')).toBeVisible();
  await expect(welcome).toBeHidden();
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByLabel('Search FAA navigation data')).toBeVisible();
  await expect(other.getByRole('dialog', { name: 'Welcome to ZLayer', exact: true })).toBeHidden();

  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByLabel('Search FAA navigation data')).toBeVisible();
  await expect(welcome).toBeHidden();
});

test('acknowledgment restores the original Settings and About without the installation card', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('zlayer-ui:settings-open', JSON.stringify({ version: 1, value: true }));
    localStorage.setItem('zlayer-ui:about-open', JSON.stringify({ version: 1, value: true }));
  });
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'Welcome to ZLayer' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'About ZLayer' })).toBeHidden();
  await page.getByRole('region', { name: 'Installation and safety notice' }).press('End');
  await page.getByRole('button', { name: 'I understand', exact: true }).click();

  const about = page.getByRole('dialog', { name: 'About ZLayer', exact: true });
  await expect(about).toBeVisible();
  await expect(about).toContainText('A modern, lightweight EFB.');
  await expect(about).toContainText('Everything starts with a layer.');
  await expect(about).toContainText('ZLayer is a personal hobby project. The app and its data are provided');
  await page.getByLabel('Close about dialog').click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('button', { name: 'About ZLayer', exact: true })).toBeVisible();
  await expect(settings.getByLabel('FAA data cycle')).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'App storage', exact: true })).toBeVisible();
  await expect(settings.getByLabel('Find a state or territory')).toBeVisible();
  await expect(settings.getByText('Take ZLayer with you', { exact: true })).toBeHidden();
});

for (const [width, height] of [[320, 568], [393, 852], [568, 320], [1440, 900]] as const) {
  test(`welcome remains readable and actionable at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const welcome = page.getByRole('dialog', { name: 'Welcome to ZLayer', exact: true });
    await expect(welcome).toBeVisible();
    const box = (await welcome.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    const body = welcome.getByRole('region', { name: 'Installation and safety notice' });
    const accept = welcome.getByRole('button', { name: 'I understand', exact: true });
    await expect(accept).toBeDisabled();
    expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect((await body.boundingBox())!.height).toBeGreaterThanOrEqual(100);
    await page.keyboard.press('Tab');
    await expect(body).toBeFocused();
    await body.press('End');
    await expect(welcome.getByText('By selecting “I understand,”', { exact: false })).toBeInViewport();
    await expect(accept).toBeEnabled();
    await body.press('Home');
    await expect(accept).toBeDisabled();
    await body.press('End');
    await expect(accept).toBeEnabled();
    await expect(accept).toBeInViewport();
    expect((await accept.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Tab');
    await expect(accept).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Search FAA navigation data')).toBeVisible();
  });
}

test('unavailable local storage allows acknowledgment for the current session', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable', 'QuotaExceededError'); };
  });
  await page.goto('/');
  await page.getByRole('region', { name: 'Installation and safety notice' }).press('End');
  await page.getByRole('button', { name: 'I understand', exact: true }).click();
  await expect(page.getByLabel('Search FAA navigation data')).toBeVisible();
  await page.getByLabel('Settings and offline downloads').click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Welcome to ZLayer', exact: true })).toBeVisible();
});
