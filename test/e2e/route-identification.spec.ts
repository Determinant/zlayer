import { test, expect, type Page } from '@playwright/test';
import { routeDraftFromText } from '@zlayer/domain';

async function openRoute(page: Page, text: string, extra = '') {
  await page.addInitScript(entries => {
    if (!localStorage.getItem('zlayer-plugin:routes:draft')) localStorage.setItem('zlayer-plugin:routes:draft', JSON.stringify({ version: 2, entries }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
      (window as unknown as { copied: string }).copied = text;
    } } });
  }, routeDraftFromText(text).entries);
  await page.goto(`/test/browser/routes.html?identification${extra}`);
}
async function identify(page: Page, index = 0) {
  await page.locator('.route-token').nth(index).click();
  await page.getByRole('menuitem', { name: 'Identify point…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Identify route point', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Identify .* with nearby navaids/ })).toHaveAttribute('aria-pressed', 'true');
  return page.getByRole('region', { name: 'Feature identification', exact: true });
}
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-plugin:routes:draft')!));

test('airport magnetic and true bearing inputs resolve through the app and retain their saved geometry offline', async ({ page, context }) => {
  await page.addInitScript(() => {
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: false }));
    if (!localStorage.getItem('zlayer-plugin:routes:draft')) localStorage.setItem('zlayer-plugin:routes:draft', JSON.stringify({ version: 2,
      entries: [{ id: 'magnetic', text: 'KSBA/090M/10' }, { id: 'true', text: 'KSBA/090T/10' }] }));
  });
  await page.goto('/');
  await expect.poll(async () => (await saved(page)).entries.filter((entry: { radialPosition?: unknown }) => entry.radialPosition).length).toBe(2);
  const before = await saved(page);
  expect(before.entries[0].radialPosition.reference).toMatchObject({ bearing: 'magnetic', magnetic: { model: 'WMM-2025', epoch: 2025 } });
  expect(before.entries[1].radialPosition.reference).toMatchObject({ bearing: 'true', declination: 0 });
  expect(before.entries[0].radialPosition.coordinate).not.toEqual(before.entries[1].radialPosition.coordinate);
  await expect(page.locator('.route-token.is-unresolved')).toHaveCount(0);
  await identify(page);
  await expect(page.locator('.route-identification-current')).toContainText('KSBA/090M/10.0');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.route-token strong')).toHaveText(['KSBA/090M/10.0', 'KSBA/090T/10.0']);
  await expect(page.locator('.route-token.is-unresolved')).toHaveCount(0);
  expect((await saved(page)).entries).toEqual(before.entries);
});

for (const [width, height, scale, spaced] of [[320, 740, 1, false], [1280, 900, 1, false],
  [640, 450, 2, true], [320, 740, 1, true]] as const) test.describe(`ID at ${width}px, scale ${scale}, spacing ${spaced}`, () => {
  test.use({ viewport: { width, height }, deviceScaleFactor: scale });
  test('name, GPS and alternate radial descriptions retain route identity', async ({ page }, testInfo) => {
    await openRoute(page, 'KSFO KSJC');
    if (spaced) await page.addStyleTag({ content: `.feature-details-panel * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
      .feature-details-panel p { margin-bottom: 2em !important; }` });
    const original = await saved(page);
    const dialog = await identify(page);
    await dialog.getByRole('button', { name: 'GPS coordinate', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Copy point', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('combobox', { name: 'Format', exact: true })).toHaveCount(0);
    await expect(page.locator('output')).toHaveText('1 legs; 0 issues');
    await dialog.getByRole('button', { name: 'Use PYE radial and distance', exact: true }).click();
    await expect(page.locator('.route-token strong').first()).toHaveText(/^PYE\//);
    await expect(dialog.getByRole('region', { name: 'Nearby VOR/DME', exact: true })).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Use PYE radial and distance', exact: true })).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Use PYE radial and distance', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const station = dialog.getByRole('button', { name: 'Use PYE radial and distance', exact: true });
    const target = await station.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(44);
    expect(target!.height).toBeGreaterThanOrEqual(44);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await dialog.getByRole('region', { name: 'Nearby VOR/DME', exact: true })
      .evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath('route-identification.png') });
    await dialog.getByRole('button', { name: 'Use OSI radial and distance', exact: true }).press('Enter');
    await expect(page.locator('.route-token strong').first()).toContainText('OSI/');
    const modified = await saved(page);
    expect(modified.entries.map((entry: { id: string }) => entry.id)).toEqual(original.entries.map((entry: { id: string }) => entry.id));
    expect(modified.entries[0].text).toBe('KSFO');
    expect(modified.entries[0].pinnedFeatureId).toBe('KSFO');
    await page.getByRole('button', { name: 'Close detail', exact: true }).click();
    await page.reload();
    await expect(page.locator('.route-token strong').first()).toContainText('OSI/');
    const reopened = await identify(page);
    await reopened.getByRole('button', { name: 'Name · KSFO', exact: true }).click();
    await expect(page.locator('.route-token strong').first()).toHaveText('KSFO');
    expect((await saved(page)).entries[0].identifications).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test('a GPS point offers nearby airport, navaid and fix choices without automatic snapping', async ({ page }) => {
  await openRoute(page, '373708N1222230W KSJC', '&map');
  const original = await saved(page);
  const dialog = await identify(page);
  const named = dialog.getByRole('region', { name: 'Nearby named points' });
  await expect(named.getByRole('button', { name: /^KSFO ·/ })).toBeVisible();
  await expect(named.getByRole('button', { name: /^SFO ·/ })).toBeVisible();
  await expect(named.getByRole('button', { name: /^BAYPT ·/ })).toBeVisible();
  await named.getByRole('button', { name: /^SFO ·/ }).click();
  expect(await saved(page)).toEqual(original);
  await named.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await saved(page)).toEqual(original);
  await named.getByRole('button', { name: /^KSFO ·/ }).click();
  await named.getByRole('button', { name: 'Use KSFO', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Name · KSFO', exact: true })).toBeVisible();
  expect((await saved(page)).entries[0]).toMatchObject({ id: original.entries[0].id, text: 'KSFO', pinnedFeatureId: 'KSFO' });
  await expect(page.locator('.route-token strong')).toHaveText(['KSFO', 'KSJC']);
  await expect(page.locator('.route-token.is-unresolved')).toHaveCount(0);
});

test('typed radial coordinates freeze, restore and can choose a different reference', async ({ page }) => {
  await openRoute(page, 'KSFO');
  const input = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await input.pressSequentially('PYE/090/10');
  await expect(input).toHaveValue('PYE/090/10');
  await input.press('Enter');
  await expect(page.locator('output')).toHaveText('1 legs; 0 issues');
  await expect.poll(async () => (await saved(page)).entries[1].radialPosition?.reference.ident).toBe('PYE');
  const position = (await saved(page)).entries[1].radialPosition;
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy Route', exact: true }).click();
  for (const [format, text] of [[/^ForeFlight/, 'KSFO PYE/090/10'], [/^SkyVector/, 'KSFO PYE090010']] as const) {
    await page.getByRole('menuitem', { name: format }).click();
    expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(text);
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const dialog = await identify(page, 1);
  await expect(dialog.getByRole('button', { name: 'Use PYE radial and distance', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: /^Saved radial/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Use OSI radial and distance', exact: true }).click();
  expect((await saved(page)).entries[1].radialPosition).toEqual(position);
  await page.reload();
  expect((await saved(page)).entries[1].radialPosition).toEqual(position);
  await expect(page.locator('.route-token strong').nth(1)).toContainText('OSI/');
});

test('published TEC children change description while keeping ownership and route export', async ({ page }) => {
  await openRoute(page, 'KSFO BAYT1 KSJC', '&composition');
  const before = await page.locator('output').textContent();
  const dialog = await identify(page, 1);
  await dialog.getByRole('combobox', { name: 'Route point' }).selectOption({ label: '2. MID' });
  await dialog.getByRole('button', { name: 'GPS coordinate', exact: true }).click();
  await expect(dialog.getByRole('note')).toContainText('belongs to a published route');
  const entries = (await saved(page)).entries;
  expect(entries.map((entry: { text: string }) => entry.text)).toEqual(['KSFO', 'BAYT1', 'KSJC']);
  expect(entries[1].identifications).toHaveLength(1);
  await expect(page.locator('output')).toHaveText(before!);
});
