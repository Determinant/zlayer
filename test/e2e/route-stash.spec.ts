import { test, expect, type Page } from '@playwright/test';

const stashKey = 'zlayer-plugin:routes:stash', draftKey = 'zlayer-plugin:routes:draft';
const approach = { airportId: 'KSFO', procedureId: 'ils', name: 'ILS OR LOC RWY 28R', cycle: '2609',
  entry: { routeId: 'KSFO:I28R', transitionId: 'transition:ARCHI', name: 'ARCHI', effectiveDate: '2026-09-03' } };
const entries = [{ id: 'gps', text: '374529N1223030W' }, { id: 'sfo', text: 'KSFO', pinnedFeatureId: 'KSFO', approach }];

async function action(page: Page, name: string) {
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function saved(page: Page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!).routes, stashKey); }
async function active(page: Page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!).entries, draftKey); }

test('save includes pending input; blank names stay hidden and load restores the full draft', async ({ page }, testInfo) => {
  await page.addInitScript(({ draftKey, entries }) => {
    if (!localStorage.getItem(draftKey)) localStorage.setItem(draftKey, JSON.stringify({ version: 2, entries }));
  }, { draftKey, entries });
  await page.goto('/test/browser/routes.html');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('KSJC');
  await action(page, 'Save Route');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Save route');
  await expect(dialog.getByRole('textbox', { name: 'Name (optional)', exact: true })).toBeFocused();
  await expect(dialog.getByRole('textbox')).toHaveValue('');
  await expect(dialog.locator('.route-stash-chip')).toHaveText(['37°45′N 122°30′W', 'KSFO', 'KSJC']);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('Route Stash');
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveCount(0);
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await expect(dialog.locator('.route-stash-approach')).toHaveText('ILS OR LOC 28R · ARCHI');
  const snapshot = (await saved(page))[0];
  expect(snapshot.name).toBe('');
  expect(snapshot.draft.entries.slice(0, 2)).toEqual(entries.map(entry => entry.approach
    ? { ...entry, approach: { ...entry.approach, kind: 'approach', source: 'chart' } } : entry));
  await page.screenshot({ path: testInfo.outputPath('stash-desktop.png') });
  await dialog.getByRole('button', { name: 'Close route stash' }).click();
  await expect(page.getByRole('button', { name: 'Route actions', exact: true })).toBeFocused();
  await action(page, 'Clear Route');
  await page.reload();
  await action(page, 'Manage Routes');
  await dialog.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await active(page)).toEqual(snapshot.draft.entries);
  await expect(page.locator('.route-token strong').first()).toHaveText('37°45′N 122°30′W');
  expect((await saved(page))[0]).toEqual(snapshot);
});

test('edit, reorder and removal persist without changing the active route', async ({ page }) => {
  await page.goto('/test/browser/routes.html');
  const original = await active(page);
  for (const name of ['First', 'Second']) {
    await action(page, 'Save Route');
    await page.getByRole('textbox', { name: 'Name (optional)', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Close route stash' }).click();
  }
  await action(page, 'Manage Routes');
  const dialog = page.getByRole('dialog'), first = dialog.getByRole('listitem', { name: 'First', exact: true });
  await first.getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name (optional)', exact: true }).fill('   ');
  await dialog.getByRole('textbox', { name: 'Route', exact: true }).fill('ksjc DCT knuq');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(['Second']);
  await expect(dialog.locator('.route-stash-path').first().locator('.route-stash-chip')).toHaveText(['KSJC', 'KNUQ']);
  await expect(dialog.locator('.route-stash-path').last().locator('.route-stash-chip')).toHaveText(['KSFO', 'UNKNOWN', 'KSJC']);
  expect(await active(page)).toEqual(original);
  await dialog.getByRole('listitem', { name: 'Second', exact: true }).getByRole('button', { name: 'Move up' }).click();
  await expect(dialog.getByRole('listitem').first()).toHaveAccessibleName('Second');
  await expect(dialog.getByRole('listitem').first().getByRole('button', { name: 'Move up' })).toBeDisabled();
  await expect(dialog.getByRole('listitem').last().getByRole('button', { name: 'Move down' })).toBeDisabled();
  expect((await saved(page)).map((route: { name: string }) => route.name)).toEqual(['Second', '']);
  await page.reload();
  await action(page, 'Manage Routes');
  await expect(dialog.getByRole('listitem').first()).toHaveAccessibleName('Second');
  await expect(dialog.locator('.route-stash-path').last().locator('.route-stash-chip')).toHaveText(['KSJC', 'KNUQ']);
  await dialog.getByRole('listitem').first().getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  expect((await saved(page)).map((route: { name: string }) => route.name)).toEqual(['']);
  await page.reload();
  await action(page, 'Manage Routes');
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  expect(await active(page)).toEqual(original);
});

test('save and edit cancellation preserve data; an empty active route can still open the stash', async ({ page }) => {
  await page.goto('/test/browser/routes.html');
  await action(page, 'Save Route');
  await page.getByRole('textbox', { name: 'Name (optional)', exact: true }).fill('Cancelled');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(key => localStorage.getItem(key), stashKey)).toBeNull();
  await action(page, 'Save Route');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Route Stash');
  const snapshot = await saved(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Route', exact: true }).fill('KNUQ');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Route Stash');
  expect(await saved(page)).toEqual(snapshot);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await action(page, 'Clear Route');
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Save Route', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Manage Routes', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('listitem')).toHaveCount(1);
});

test('failed saves keep the dialog and existing routes, then allow retry', async ({ page }) => {
  await page.goto('/test/browser/routes.html');
  await action(page, 'Save Route');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Route Stash');
  const snapshot = await saved(page);
  await page.getByRole('button', { name: 'Close route stash' }).click();
  await action(page, 'Save Route');
  await page.getByRole('textbox', { name: 'Name (optional)', exact: true }).fill('Retry me');
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) {
        Storage.prototype.setItem = original;
        throw new DOMException('Full', 'QuotaExceededError');
      }
      return original.call(this, name, value);
    };
  }, stashKey);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Save route');
  await expect(page.getByRole('alert')).toContainText('Could not save');
  expect(await saved(page)).toEqual(snapshot);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('heading', { level: 3 })).toHaveText('Retry me');
});

test('other tabs refresh the list and cannot silently overwrite an open edit', async ({ page, context }) => {
  await page.goto('/test/browser/routes.html');
  await action(page, 'Save Route');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name (optional)', exact: true }).fill('Unsaved edit');
  const other = await context.newPage();
  await other.goto('/test/browser/routes.html');
  await action(other, 'Manage Routes');
  await other.getByRole('button', { name: 'Edit', exact: true }).click();
  await other.getByRole('textbox', { name: 'Name (optional)', exact: true }).fill('Updated elsewhere');
  await other.getByRole('button', { name: 'Save changes' }).click();
  await page.bringToFront();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('changed in another window');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { level: 3 })).toHaveText('Updated elsewhere');
  expect((await saved(page))[0].name).toBe('Updated elsewhere');
});

test('a competing window cannot lose a save, and retry uses its committed list', async ({ page, context }) => {
  await page.goto('/test/browser/routes.html');
  await action(page, 'Save Route');
  await page.getByRole('textbox', { name: 'Name (optional)', exact: true }).fill('This window');
  const other = await context.newPage();
  await other.goto('/test/browser/routes.html');
  await other.evaluate(key => new Promise<void>(acquired => {
    void navigator.locks.request(key, async () => {
      await new Promise<void>(release => {
        window.addEventListener('release-stash-write', () => release(), { once: true });
        acquired();
      });
      localStorage.setItem(key, JSON.stringify({ version: 1, routes: [
        { id: 'other-window', name: 'Other window', draft: { entries: [{ id: 'other-airport', text: 'KSJC' }] } },
      ] }));
    });
  }), stashKey);
  await page.bringToFront();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Another window is saving routes');
  expect(await page.evaluate(key => localStorage.getItem(key), stashKey)).toBeNull();
  await other.evaluate(() => window.dispatchEvent(new Event('release-stash-write')));
  await expect.poll(async () => (await navigatorLocks(other)).length).toBe(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Route Stash');
  expect((await saved(page)).map((route: { name: string }) => route.name)).toEqual(['Other window', 'This window']);
});

async function navigatorLocks(page: Page) {
  return page.evaluate(async key => (await navigator.locks.query()).held?.filter(lock => lock.name === key) ?? [], stashKey);
}

for (const width of [320, 820]) {
  test.describe(`touch stash at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
    test('long routes wrap, controls stay reachable and the list scrolls inside the dialog', async ({ page }, testInfo) => {
      await page.addInitScript(({ stashKey, entries }) => {
        localStorage.setItem(stashKey, JSON.stringify({ version: 1, routes: Array.from({ length: 8 }, (_, i) => ({
          id: `saved-${i}`, name: i === 1 ? '' : `Bay Area arrival ${i + 1}`, draft: { entries: [
            ...Array.from({ length: 10 }, (_, j) => ({ id: `extra-${j}`, text: 'KSJC' })), ...entries,
          ] },
        })) }));
      }, { stashKey, entries });
      await page.goto('/test/browser/routes.html');
      await page.getByRole('button', { name: 'Route actions', exact: true }).tap();
      await page.getByRole('menuitem', { name: 'Manage Routes', exact: true }).tap();
      const dialog = page.getByRole('dialog'), rows = dialog.getByRole('listitem');
      await expect(rows).toHaveCount(8);
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`stash-${width}.png`) });
      await rows.last().getByRole('button', { name: 'Move up' }).tap();
      await expect(rows.nth(6)).toHaveAccessibleName('Bay Area arrival 8');
      await rows.nth(6).getByRole('button', { name: 'Edit', exact: true }).tap();
      await page.getByRole('textbox', { name: 'Name (optional)', exact: true }).fill('');
      await page.screenshot({ path: testInfo.outputPath(`stash-edit-${width}.png`) });
      await page.getByRole('button', { name: 'Save changes' }).tap();
      await expect(rows.nth(6).getByRole('heading')).toHaveCount(0);
      await rows.nth(6).getByRole('button', { name: 'Load', exact: true }).tap();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.route-token')).toHaveCount(12);
    });
  });
}
