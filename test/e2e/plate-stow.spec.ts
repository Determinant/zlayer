import { expect, test, type Page, type Route } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { openSidePanel } from './side-panel-fixture';

async function selectAirport(page: Page, ident: string) {
  await page.getByLabel('Search FAA navigation data').fill(ident);
  await page.locator('.search-results button').filter({ hasText: ident }).click();
}

async function ready(page: Page) {
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.procedure-page-stage canvas')).toBeVisible();
  await page.locator('.side-panels').evaluate(group => Promise.all(group.getAnimations().map(animation => animation.finished)));
}

test.describe('stowable plate panel', () => {
  test.use({ hasTouch: true });
  for (const [width, height] of [[320, 568], [393, 852], [568, 320], [1280, 900]] as const) {
    test(`the map stays usable and the reader survives stowing at ${width}×${height}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await selectAirport(page, 'KSBA');
      await page.getByRole('tab', { name: 'Plates', exact: true }).tap();
      const opener = page.getByRole('button', { name: /TEST APPROACH/ });
      await opener.tap();
      await ready(page);
      const dialog = page.getByRole('dialog', { name: 'TEST APPROACH', exact: true });
      const canvas = page.locator('.procedure-page-stage canvas');
      const originalCanvas = await canvas.elementHandle();
      expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(false);
      expect(await dialog.evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none');
      await expect(page.locator('.feature-card')).toBeHidden();
      await expect(page.locator('.side-panels .edge-panel.is-open')).toHaveCount(1);
      const search = page.getByLabel('Search FAA navigation data');
      await search.focus();
      await expect(search).toBeFocused();
      if (width === 1280) {
        const map = (await page.locator('.maplibregl-canvas').boundingBox())!;
        const camera = () => page.evaluate(() => JSON.parse(localStorage.getItem('zlayers-map-view-v1')!).center);
        const before = await camera();
        await page.mouse.move(map.x + 120, map.y + map.height / 2);
        await page.mouse.down();
        await page.mouse.move(map.x + 200, map.y + map.height / 2 + 40, { steps: 8 });
        await page.mouse.up();
        await expect.poll(camera).not.toEqual(before);
      }
      await page.screenshot({ path: testInfo.outputPath('plate-panel.png') });

      // Stow the current panel to expose the other tab, retaining both contents.
      await openSidePanel(page, 'details');
      await expect(page.getByRole('tab', { name: 'Plates', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(dialog).toBeHidden();
      await expect(canvas).toBeHidden();
      await openSidePanel(page, 'plate');
      await expect(page.locator('.feature-card')).toBeHidden();
      await expect(dialog).toBeVisible();
      await page.locator('.side-panels').evaluate(group => Promise.all(group.getAnimations().map(animation => animation.finished)));
      const airportTab = (await page.getByRole('button', { name: 'Show KSBA details', exact: true }).boundingBox())!;
      expect(Math.round(airportTab.x + airportTab.width)).toBe(width);

      const requests: string[] = [];
      page.on('request', request => { if (/\.pdf/i.test(request.url())) requests.push(request.url()); });
      for (let index = 0; index < 5; index++) await dialog.getByRole('button', { name: 'Zoom in', exact: true }).tap();
      await ready(page);
      const zoom = await page.locator('.procedure-zoom-controls').textContent();
      const stage = page.locator('.procedure-page-stage');
      const scroll = await stage.evaluate(element => {
        element.scrollTo(40, 60);
        return { left: element.scrollLeft, top: element.scrollTop };
      });
      expect(scroll.top).toBeGreaterThan(0);
      const hide = page.getByRole('button', { name: 'Hide KSBA plate', exact: true });
      const target = (await hide.boundingBox())!;
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      await hide.tap();
      await expect(dialog).toBeHidden();
      await expect(page.locator('.feature-card')).toBeHidden();
      const show = page.getByRole('button', { name: 'Show KSBA plate', exact: true });
      await expect(show).toHaveAttribute('aria-expanded', 'false');
      await expect.poll(async () => {
        const edge = (await show.boundingBox())!;
        return Math.round(edge.x + edge.width);
      }).toBe(width);
      await expect(page.getByRole('button', { name: 'Close plate', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Zoom in', exact: true }).tap();
      await expect(show).toHaveAttribute('aria-expanded', 'false');
      await page.screenshot({ path: testInfo.outputPath('plate-stowed.png') });
      await show.tap();
      await ready(page);
      await page.locator('.side-panels').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
      expect(await canvas.evaluate((element, original) => element === original, originalCanvas)).toBe(true);
      await expect(page.locator('.procedure-zoom-controls')).toHaveText(zoom!);
      expect(await stage.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }))).toEqual(scroll);
      expect(requests).toEqual([]);
      await page.getByRole('button', { name: 'Close plate', exact: true }).tap();
      await expect(page.locator('.procedure-panel')).toHaveCount(0);
      await expect(page.locator('.feature-card')).toBeHidden();
      await openSidePanel(page, 'details');
      await expect(opener).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Plates', exact: true })).toHaveAttribute('aria-selected', 'true');
    });
  }
});

test('stowing retains a later PDF page and Escape returns focus to the handle', async ({ page }) => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.addPage([200, 300]);
  const body = Buffer.from(await pdf.save());
  await page.route('**/stow-test.pdf', route => route.fulfill({ contentType: 'application/pdf', body }));
  await page.addInitScript(() => localStorage.setItem('zlayer-plugin:plates:plate-selection', JSON.stringify({ version: 1, value: {
    airport: { id: 'KSBA' }, procedure: { id: 'two-page', name: 'Two-page plate' },
    cycle: '2026-09-03', effectiveDate: '2026-09-03', expirationDate: '2026-10-01',
    document: { url: `${location.origin}/stow-test.pdf`, nativeUrl: `${location.origin}/stow-test.pdf`,
      pageIndex: 0, source: 'faa-individual' },
  } })));
  await page.goto('/');
  await ready(page);
  const next = page.getByRole('button', { name: 'Next PDF page', exact: true });
  await next.click();
  await ready(page);
  await expect(page.locator('.procedure-page-controls')).toContainText('Page 2 / 2');
  await page.getByRole('button', { name: 'Enter full screen', exact: true }).press('Escape');
  const show = page.getByRole('button', { name: 'Show KSBA plate', exact: true });
  await expect(show).toBeFocused();
  await expect(page.getByRole('dialog')).toBeHidden();
  await show.press('Enter');
  await ready(page);
  await expect(page.locator('.procedure-page-controls')).toContainText('Page 2 / 2');
  await expect(page.getByLabel('PDF page 2', { exact: true })).toBeVisible();
  await selectAirport(page, 'KSMO');
  await expect(page.locator('.procedure-panel')).toHaveCount(1);
  await expect(page.locator('.feature-card h2')).toHaveText('KSMO');
  await page.getByRole('button', { name: 'Close detail', exact: true }).click();
  await expect(page.locator('.feature-card')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeHidden();
  await openSidePanel(page, 'plate');
  await expect(page.locator('.procedure-page-controls')).toContainText('Page 2 / 2');
  await expect(page.getByLabel('PDF page 2', { exact: true })).toBeVisible();
});

test('a download can finish while stowed without reopening the panel or replacing its reader', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  let release!: (route: Route) => void;
  const pending = new Promise<Route>(resolve => { release = resolve; });
  let requests = 0;
  await page.route('**/book.pdf*', route => { requests++; release(route); });
  await page.goto('/');
  await selectAirport(page, 'KSBA');
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  const held = await pending;
  const dialog = await page.getByRole('dialog').elementHandle();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await page.getByRole('button', { name: 'Hide KSBA plate', exact: true }).click();
  const show = page.getByRole('button', { name: 'Show KSBA plate', exact: true });
  await expect(show).toBeFocused();
  await held.continue();
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.feature-card')).toBeHidden();
  await show.click();
  await ready(page);
  expect(await page.getByRole('dialog').evaluate((element, original) => element === original, dialog)).toBe(true);
  expect(requests).toBe(1);
});

for (const width of [393, 1280]) {
  test(`airport and plate windows have independent lifetimes and one instance each at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 852 });
    await page.goto('/');
    await selectAirport(page, 'KSBA');
    await page.getByRole('tab', { name: 'Plates', exact: true }).click();
    const originalInfo = (await page.locator('.feature-card').boundingBox())!;
    await page.getByRole('button', { name: /TEST APPROACH/ }).click();
    await ready(page);
    const canvas = await page.locator('.procedure-page-stage canvas').elementHandle();
    const requests: string[] = [];
    page.on('request', request => { if (/\.pdf/i.test(request.url())) requests.push(request.url()); });

    const plate = (await page.getByRole('dialog').boundingBox())!;
    if (width === 1280) expect(originalInfo.width).toBeLessThan(plate.width);
    await expect(page.locator('.feature-card')).toBeHidden();
    const infoTab = (await page.getByRole('button', { name: 'Show KSBA details', exact: true }).boundingBox())!;
    const plateTab = (await page.getByRole('button', { name: 'Hide KSBA plate', exact: true }).boundingBox())!;
    const expectTabSlots = async () => {
      for (const [name, original] of [['details', infoTab], ['plate', plateTab]] as const) {
        const handle = page.locator(`.side-panels [data-edge-tab="${name}"] button`);
        if (await handle.count()) expect((await handle.boundingBox())!.y, `${name} keeps its slot`).toBe(original.y);
      }
    };
    expect(infoTab.x + infoTab.width).toBe(width);
    expect(plateTab.x + plateTab.width).toBe(plate.x);
    expect(infoTab.y + infoTab.height).toBeLessThanOrEqual(plateTab.y);
    // The active handle and header controls stay usable. Stowed tabs cannot
    // intercept controls at the right edge of the open panel.
    expect(await page.locator('.side-panels').evaluate(group => {
      const controls = group.querySelectorAll('.edge-panel-tabs > .is-presented button, .procedure-viewer-actions button');
      return [...controls].filter(button => !button.matches(':disabled')).every(button => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      });
    })).toBe(true);

    await page.getByRole('button', { name: 'Hide KSBA plate', exact: true }).click();
    await expect(page.locator('.side-panels .edge-panel.is-presented')).toHaveCount(0);
    await expectTabSlots();
    expect(await page.locator('.side-panels .map-edge-handle').evaluateAll(buttons => buttons.every(button => {
      const box = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }))).toBe(true);

    // Each tab follows only its own panel, which keeps its original dimensions.
    await openSidePanel(page, 'details');
    await expect.poll(() => page.locator('.feature-card').boundingBox()).toEqual(originalInfo);
    await expectTabSlots();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.locator('.procedure-page-stage canvas')).toBeHidden();
    await expect(page.locator('.side-panels .edge-panel.is-open')).toHaveCount(1);
    await openSidePanel(page, 'plate');
    await openSidePanel(page, 'details');
    await page.screenshot({ path: testInfo.outputPath('airport-and-plate.png') });
    await page.getByRole('button', { name: 'Close detail', exact: true }).click();
    await expect(page.locator('.feature-details-panel')).toHaveCount(0);
    await expectTabSlots();
    await openSidePanel(page, 'plate');
    await expect(page.getByRole('dialog', { name: 'TEST APPROACH', exact: true })).toBeVisible();
    await expectTabSlots();

    await selectAirport(page, 'KSMO');
    await expect(page.locator('.feature-card h2')).toHaveText('KSMO');
    await expectTabSlots();
    await expect(page.locator('.procedure-panel')).toHaveCount(1);
    expect(await page.locator('.procedure-page-stage canvas').evaluate((element, original) => element === original, canvas)).toBe(true);
    expect(requests).toEqual([]);

    await openSidePanel(page, 'plate');
    await page.getByRole('button', { name: 'Close plate', exact: true }).click();
    await expect(page.locator('.procedure-panel')).toHaveCount(0);
    await expect(page.locator('.feature-card h2')).toHaveText('KSMO');
    await expectTabSlots();

    await selectAirport(page, 'KSBA');
    await page.getByRole('button', { name: /TEST APPROACH/ }).click();
    await ready(page);
    await openSidePanel(page, 'details');
    await page.getByRole('button', { name: /Chart Supplement/ }).click();
    await ready(page);
    await expect(page.getByRole('dialog', { name: 'Chart Supplement', exact: true })).toBeVisible();
    await expect(page.locator('.procedure-panel')).toHaveCount(1);
    await expect(page.locator('.feature-details-panel')).toHaveCount(1);
    await expect(page.locator('.feature-card h2')).toHaveText('KSBA');
    await expectTabSlots();
    await openSidePanel(page, 'details');
    await expect(page.getByRole('tab', { name: 'Plates', exact: true })).toHaveAttribute('aria-selected', 'true');
  });
}
