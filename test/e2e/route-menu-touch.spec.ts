import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => {
      if (!navigator.userActivation.isActive) throw new Error('Copy requires user activation');
      document.body.dataset.copiedRoute = text;
    } } });
    Object.defineProperty(navigator, 'share', { value: async (data: ShareData) => {
      if (!navigator.userActivation.isActive) throw new Error('Share requires user activation');
      (document.activeElement as HTMLElement)?.blur();
      document.body.dataset.sharedRoute = data.text;
    } });
    // Safari/iPadOS blur the focused control without focusing a tapped button.
    // Reproduce that sequence even in Chromium, before the tap's click arrives.
    document.addEventListener('mousedown', event => {
      if (!(event.target instanceof Element) || !event.target.closest('.route-menu button')) return;
      event.preventDefault();
      (document.activeElement as HTMLElement)?.blur();
    }, true);
  });
  await page.goto('/test/browser/routes.html');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('374529N1223030W');
});

test('iPad tap opens Copy formats and copies with user activation after focus loss', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Route actions', exact: true });
  await trigger.tap();
  await page.getByRole('menuitem', { name: 'Copy Route', exact: true }).tap();
  const formats = page.getByRole('menu', { name: 'Copy route format', exact: true });
  await expect(formats).toBeVisible();
  const format = formats.getByRole('menuitem', { name: /^ForeFlight/ });
  await format.tap();
  await expect(page.locator('body')).toHaveAttribute('data-copied-route', 'KSFO UNKNOWN KSJC 374529N/1223030W');
  await expect(page.locator('.route-menu').getByRole('status')).toHaveText('Route copied');
  await expect(page.locator('.route-token strong').last()).toHaveText('37°45′N 122°30′W');
  await expect(format).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(formats).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Copy Route', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await trigger.tap();
  await page.getByRole('menuitem', { name: 'Reverse Route', exact: true }).tap();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.route-token strong')).toHaveText(['37°45′N 122°30′W', 'KSJC', 'UNKNOWN', 'KSFO']);
});

test('iPad tap opens Share formats and shares with user activation after focus loss', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Route actions', exact: true });
  await trigger.tap();
  await page.getByRole('menuitem', { name: 'Share…', exact: true }).tap();
  const formats = page.getByRole('menu', { name: 'Share route format', exact: true });
  await expect(formats).toBeVisible();
  await formats.getByRole('menuitem', { name: /^ICAO/ }).tap();
  await expect(page.locator('body')).toHaveAttribute('data-shared-route', 'KSFO UNKNOWN KSJC 3745N12231W');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('iPad clipboard denial keeps manual copying available after focus loss', async ({ page }) => {
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.getByRole('button', { name: 'Route actions', exact: true }).tap();
  await page.getByRole('menuitem', { name: 'Copy Route', exact: true }).tap();
  await page.getByRole('menuitem', { name: /^ForeFlight/ }).tap();
  const fallback = page.getByRole('textbox', { name: 'Route text to copy', exact: true });
  await expect(fallback).toHaveValue('KSFO UNKNOWN KSJC 374529N/1223030W');
  await expect(fallback).toBeFocused();
  expect(await fallback.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd)))
    .toBe('KSFO UNKNOWN KSJC 374529N/1223030W');
});

test('iPad route menu still dismisses on outside taps, keyboard focus and Escape', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Route actions', exact: true });
  const copy = page.getByRole('menuitem', { name: 'Copy Route', exact: true });
  await trigger.tap();
  await copy.tap();
  await page.locator('header').tap();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.tap();
  await page.getByRole('menuitem', { name: 'Clear Route', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.tap();
  await copy.tap();
  await page.keyboard.press('Escape');
  await expect(copy).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('iPad ForeFlight tap requests the app handoff after focus loss', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Observing external app navigation requires CDP.');
  await page.getByRole('button', { name: 'Route actions', exact: true }).tap();
  const session = await page.context().newCDPSession(page);
  await session.send('Page.enable');
  const navigations: string[] = [];
  session.on('Page.frameRequestedNavigation', event => navigations.push(event.url));
  await page.getByRole('menuitem', { name: 'Open in ForeFlight', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Route actions', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => navigations[0]).toBe(
    `foreflightmobile://maps/search?q=${encodeURIComponent('KSFO UNKNOWN KSJC 374529N/1223030W')}`);
  await session.detach();
});
