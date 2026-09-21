import { test, expect } from '@playwright/test';

const coordinateFormats = [
  [/^ForeFlight/, '374529N/1223030W'],
  [/^SkyVector \/ ZLayer/, '374529N1223030W'],
  [/^ICAO \/ 1800WX/, '3745N12231W'],
] as const;

test('route menu copies current edits, supports keyboard dismissal and clears the draft', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/test/browser/routes.html');
  const trigger = page.getByRole('button', { name: 'Route actions', exact: true });
  const input = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await input.fill('KSFO');
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Copy Route', exact: true }).click();
  await page.getByRole('menuitem', { name: /^SkyVector \/ ZLayer/ }).click();
  await expect(page.locator('.route-menu').getByRole('status')).toHaveText('Route copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('KSFO UNKNOWN KSJC KSFO');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('menuitem', { name: 'Copy Route', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Clear Route', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await page.locator('header').click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Clear Route', exact: true }).click();
  await expect(input).toBeFocused();
  await expect(page.locator('.route-token')).toHaveCount(0);
  await trigger.click();
  await expect(page.getByRole('menuitem', { name: 'Copy Route', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Clear Route', exact: true })).toBeDisabled();
});

test('clipboard failure offers selected route text for manual copying', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Denied')) } });
  });
  await page.goto('/test/browser/routes.html');
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy Route', exact: true }).click();
  await page.getByRole('menuitem', { name: /^ForeFlight/ }).click();
  const fallback = page.getByRole('textbox', { name: 'Route text to copy', exact: true });
  await expect(fallback).toHaveValue('KSFO UNKNOWN KSJC');
  await expect(fallback).toBeFocused();
  expect(await fallback.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd)))
    .toBe('KSFO UNKNOWN KSJC');
  await fallback.press('ArrowLeft');
  await expect(fallback).toBeFocused();
  await fallback.press('Escape');
  await expect(fallback).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Copy Route', exact: true })).toBeFocused();
});

test('desktop copy expands a keyboard-accessible format menu and copies the selected coordinate syntax', async ({ page }, testInfo) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/test/browser/routes.html');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('374529N1223030W');
  const trigger = page.getByRole('button', { name: 'Route actions', exact: true });
  await trigger.click();
  const copy = page.getByRole('menuitem', { name: 'Copy Route', exact: true });
  await expect(copy).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const formats = page.getByRole('menu', { name: 'Copy route format', exact: true });
  await expect(formats).toBeVisible();
  await expect(formats.getByRole('menuitem', { name: /^ForeFlight/ })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(copy).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(formats.getByRole('menuitem', { name: /^ForeFlight/ })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('desktop-copy-formats.png') });
  for (const [name, token] of coordinateFormats) {
    await formats.getByRole('menuitem', { name }).click();
    await expect(page.locator('.route-menu').getByRole('status')).toHaveText('Route copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`KSFO UNKNOWN KSJC ${token}`);
  }
  await expect(page.locator('.route-token strong').last()).toHaveText('37°45′N 122°30′W');
  await page.keyboard.press('Home');
  await expect(formats.getByRole('menuitem', { name: /^ForeFlight/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(formats.getByRole('menuitem', { name: /^SkyVector/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(formats).toHaveCount(0);
  await expect(copy).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('manual copying uses the chosen format and a narrow desktop menu stays on screen', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Denied')) } });
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/test/browser/routes.html');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('374529N1223030W');
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy Route', exact: true }).click();
  await page.getByRole('menuitem', { name: /^ICAO \/ 1800WX/ }).click();
  const fallback = page.getByRole('textbox', { name: 'Route text to copy', exact: true });
  await expect(fallback).toHaveValue('KSFO UNKNOWN KSJC 3745N12231W');
  await expect(fallback).toBeFocused();
  expect(await fallback.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd)))
    .toBe('KSFO UNKNOWN KSJC 3745N12231W');
  const box = (await page.locator('.route-menu-popover').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
});

for (const platform of ['Android', 'iPhone', 'iPad']) {
  test(`${platform} copies every format without changing the draft`, async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(platform => {
      Object.defineProperty(navigator, 'userAgent', { value: platform === 'iPad' ? 'Mozilla/5.0 Macintosh' : platform });
      Object.defineProperty(navigator, 'platform', { value: platform === 'iPad' ? 'MacIntel' : platform });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
    }, platform);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/test/browser/routes.html');
    await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('374529N1223030W');
    await page.getByRole('button', { name: 'Route actions', exact: true }).click();
    const copy = page.getByRole('menuitem', { name: 'Copy Route', exact: true });
    await expect(copy).toHaveAttribute('aria-haspopup', 'menu');
    await copy.click();
    const formats = page.getByRole('menu', { name: 'Copy route format', exact: true });
    for (const [name, token] of coordinateFormats) {
      await formats.getByRole('menuitem', { name }).click();
      await expect(page.locator('.route-menu').getByRole('status')).toHaveText('Route copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`KSFO UNKNOWN KSJC ${token}`);
    }
    await expect(page.locator('.route-token strong').last()).toHaveText('37°45′N 122°30′W');
  });
}

for (const platform of ['Desktop', 'Android', 'iPhone', 'iPad']) {
  test(`${platform} shares the selected format and keeps the saved precision`, async ({ page }, testInfo) => {
    await page.addInitScript(platform => {
      Object.defineProperty(navigator, 'userAgent', { value: platform === 'iPad' ? 'Mozilla/5.0 Macintosh' : platform });
      Object.defineProperty(navigator, 'platform', { value: platform === 'iPad' ? 'MacIntel' : platform });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: platform === 'Desktop' ? 0 : 5 });
      Object.defineProperty(navigator, 'share', { value: async (data: ShareData) => {
        document.body.dataset.sharedRoute = JSON.stringify(data);
      } });
    }, platform);
    await page.setViewportSize(platform === 'Desktop' ? { width: 1280, height: 900 } : { width: 320, height: 844 });
    await page.goto('/test/browser/routes.html');
    await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('374529N1223030W');
    const trigger = page.getByRole('button', { name: 'Route actions', exact: true });
    for (const [name, token] of coordinateFormats) {
      await trigger.click();
      await expect(page.getByRole('menuitem', { name: 'Open in ForeFlight', exact: true }))
        .toHaveCount(platform === 'iPhone' || platform === 'iPad' ? 1 : 0);
      const share = page.getByRole('menuitem', { name: 'Share…', exact: true });
      await expect(share).toHaveAttribute('aria-haspopup', 'menu');
      await share.focus();
      await page.keyboard.press('ArrowRight');
      const formats = page.getByRole('menu', { name: 'Share route format', exact: true });
      await expect(formats.getByRole('menuitem', { name: /^ForeFlight/ })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(share).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(formats.getByRole('menuitem', { name: /^ForeFlight/ })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(share).toBeFocused();
      await share.click();
      await formats.getByRole('menuitem', { name }).click();
      await expect(page.locator('body')).toHaveAttribute('data-shared-route', JSON.stringify({ text: `KSFO UNKNOWN KSJC ${token}` }));
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toBeFocused();
      await expect(page.locator('.route-token strong').last()).toHaveText('37°45′N 122°30′W');
    }
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Share…', exact: true }).click();
    const box = (await page.locator('.route-menu-popover').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.screenshot({ path: testInfo.outputPath(`${platform.toLowerCase()}-share-formats.png`) });
    await page.getByRole('menuitem', { name: 'Clear Route', exact: true }).click();
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: 'Copy Route', exact: true })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: 'Share…', exact: true })).toBeDisabled();
  });
}

test('share cancellation survives native sheet focus loss and allows retry', async ({ page }) => {
  await page.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(navigator, 'share', { value: async (data: ShareData) => {
      (document.activeElement as HTMLElement)?.blur();
      if (!attempts++) throw new DOMException('Cancelled', 'AbortError');
      document.body.dataset.sharedRoute = data.text;
    } });
  });
  await page.goto('/test/browser/routes.html');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('374529N1223030W');
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Share…', exact: true }).click();
  const format = page.getByRole('menu', { name: 'Share route format', exact: true })
    .getByRole('menuitem', { name: /^ICAO/ });
  // Touch activation need not focus the chosen button before opening the sheet.
  await format.dispatchEvent('click');
  await expect(format).toBeFocused();
  await expect(page.locator('.route-menu').getByRole('status')).toBeEmpty();
  await format.click();
  await expect(page.locator('body')).toHaveAttribute('data-shared-route', 'KSFO UNKNOWN KSJC 3745N12231W');
  await expect(page.getByRole('button', { name: 'Route actions', exact: true })).toHaveAttribute('aria-expanded', 'false');
});

test('share failure offers copying and switching actions clears stale feedback', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Denied')) } });
    Object.defineProperty(navigator, 'share', { value: async () => {
      (document.activeElement as HTMLElement)?.blur();
      throw new DOMException('Denied', 'NotAllowedError');
    } });
  });
  await page.goto('/test/browser/routes.html');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('374529N1223030W');
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Share…', exact: true }).click();
  await page.getByRole('menuitem', { name: /^ICAO/ }).click();
  const status = page.locator('.route-menu').getByRole('status');
  await expect(status).toHaveText('Sharing is unavailable. Use Copy Route.');
  await page.getByRole('menuitem', { name: 'Copy Route', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Share route format', exact: true })).toHaveCount(0);
  await expect(status).toBeEmpty();
  await page.getByRole('menuitem', { name: /^ICAO/ }).click();
  const fallback = page.getByRole('textbox', { name: 'Route text to copy', exact: true });
  await expect(fallback).toHaveValue('KSFO UNKNOWN KSJC 3745N12231W');
  await page.getByRole('menuitem', { name: 'Share…', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Copy route format', exact: true })).toHaveCount(0);
  await expect(fallback).toHaveCount(0);
  await expect(status).toBeEmpty();
});

test('late clipboard failure cannot replace the Share menu with stale fallback text', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => new Promise<void>((_, reject) => {
      window.addEventListener('reject-copy', () => reject(new Error('Denied')), { once: true });
    }) } });
    Object.defineProperty(navigator, 'share', { value: async () => {} });
  });
  await page.goto('/test/browser/routes.html');
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy Route', exact: true }).click();
  await page.getByRole('menuitem', { name: /^ForeFlight/ }).click();
  await page.getByRole('menuitem', { name: 'Share…', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('reject-copy')));
  const formats = page.getByRole('menu', { name: 'Share route format', exact: true });
  await expect(formats.getByRole('menuitem', { name: /^ForeFlight/ })).toBeFocused();
  await expect(page.locator('.route-menu').getByRole('status')).toBeEmpty();
  await expect(page.getByRole('textbox', { name: 'Route text to copy', exact: true })).toHaveCount(0);
});

for (const outcome of ['success', 'failure']) {
  test(`late share ${outcome} leaves a reopened menu and its focus alone`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: () => new Promise<void>((resolve, reject) => {
        window.addEventListener('settle-share', event => {
          if ((event as CustomEvent).detail === 'success') resolve();
          else reject(new DOMException('Denied', 'NotAllowedError'));
        }, { once: true });
      }) });
    });
    await page.goto('/test/browser/routes.html');
    const trigger = page.getByRole('button', { name: 'Route actions', exact: true });
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Share…', exact: true }).click();
    await page.getByRole('menuitem', { name: /^ForeFlight/ }).click();
    await page.locator('header').click();
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Copy Route', exact: true }).click();
    const formats = page.getByRole('menu', { name: 'Copy route format', exact: true });
    await page.evaluate(outcome => window.dispatchEvent(new CustomEvent('settle-share', { detail: outcome })), outcome);
    await expect(formats).toBeVisible();
    await expect(formats.getByRole('menuitem', { name: /^ForeFlight/ })).toBeFocused();
    await expect(page.locator('.route-menu').getByRole('status')).toBeEmpty();
  });
}

test('Apple mobile opens ForeFlight with converted route coordinates', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
  });
  await page.goto('/test/browser/routes.html');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('374529N1223030W');
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  const session = await page.context().newCDPSession(page);
  await session.send('Page.enable');
  const navigation = new Promise<string>(resolve => session.once('Page.frameRequestedNavigation', event => resolve(event.url)));
  await page.getByRole('menuitem', { name: 'Open in ForeFlight', exact: true }).click();
  const url = new URL(await navigation);
  expect(url.protocol).toBe('foreflightmobile:');
  expect(url.searchParams.get('q')).toBe('KSFO UNKNOWN KSJC 374529N/1223030W');
  await expect(page.getByRole('menu', { name: 'Route actions', exact: true })).toHaveCount(0);
  await session.detach();
});

test('route menu replaces a token menu and stays within a short landscape viewport', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto('/test/browser/routes.html');
  await page.locator('.route-token').first().click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Replace route item', exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Route actions', exact: true });
  await trigger.focus();
  await trigger.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Copy Route', exact: true })).toBeFocused();
  await expect(page.getByRole('menuitem', { name: 'Replace route item', exact: true })).toHaveCount(0);
  const popover = (await page.locator('.route-menu-popover').boundingBox())!;
  expect(popover.y + popover.height).toBeLessThanOrEqual(320);
});
