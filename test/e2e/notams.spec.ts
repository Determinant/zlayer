import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type ViteDevServer } from 'vite';
import { PDFDocument } from 'pdf-lib';
import { detailedNotices, notice, notamSnapshot, testAirport, testCatalog, testProcedure, testResource } from '../fixtures/notams';
import { contrast } from '../../tools/theme/color';
import { procedureSelection } from '../../src/layers/plates/data';

let server: ViteDevServer, origin: string, directory: string, pdf: Buffer;
let catalog: typeof testCatalog, resource: typeof testResource;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'zlayer-notams-browser-'));
  const document = await PDFDocument.create();
  for (const name of ['Test approach', 'Other airport approach', 'Unindexed page']) document.addPage([400, 600]).drawText(name, { x: 25, y: 400, size: 20 });
  pdf = Buffer.from(await document.save());
  const hash = createHash('sha256').update(pdf).digest('hex');
  catalog = { ...testCatalog, volumes: [{ ...testCatalog.volumes[0]!, byteLength: pdf.length, sha256: hash, resolvedTargetCount: 2 }],
    airports: [testAirport, { ...testAirport, id: 'PANC', faaId: 'ANC', icaoId: 'PANC', procedures: [{ ...testProcedure, id: 'other-iap', name: 'ILS RWY 15',
      volumeTarget: { ...testProcedure.volumeTarget!, pageIndex: 1 } }] }] };
  resource = { ...testResource, airportCount: 2, sourceAirportCount: 2, procedureCount: 2, sourceProcedureCount: 2 };
  server = await createServer({ cacheDir: directory, server: { host: '0.0.0.0', port: 0, strictPort: false, hmr: false }, logLevel: 'error' });
  await server.listen(); const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Vite address unavailable');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ resource, selection }) => {
    (window as unknown as { notamFixtureResource: unknown }).notamFixtureResource = resource;
    (window as unknown as { notamFixtureSelection: unknown }).notamFixtureSelection = selection;
    // The container has no external network; local requests are intercepted.
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  }, { resource, selection: procedureSelection(catalog, testAirport, testProcedure, resource.url, 'https://example.test/', resource) });
  await page.route('https://example.test/**', route => route.fulfill({ status: 200,
    ...(route.request().url().includes('catalog.json') ? { contentType: 'application/json', body: JSON.stringify(catalog) }
      : { contentType: 'application/pdf', body: pdf }), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('**/api/notams/airports?**', route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams), now = Date.now();
    const records = query.faaId === 'TST' ? [notice({ issuedAt: now - 60_000, startsAt: now - 60_000, endsAt: now + 86_400_000 }),
      notice({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002', classification: 'FDC', number: '1002', issuedAt: now, startsAt: now - 1000, endsAt: now + 86_400_000,
        text: 'IAP TEST AIRPORT, CA.\nRNAV (GPS) Y RWY 09L, AMDT 2...\nCIRCLING NA EXC CAT A.' })] : [];
    const snapshot = notamSnapshot(records, { query }); snapshot.feed.checkedAt = snapshot.feed.watermark = now;
    return route.fulfill({ json: snapshot });
  });
  await page.goto(`${origin}/test/browser/notams.html`);
});
test('airport third tab shows D/FDC with raw text, filters and no Plates dependency', async ({ page }) => {
  const tabs = page.getByRole('tablist', { name: 'Airport detail' });
  await expect(tabs.getByRole('tab')).toHaveText(['Info', 'Plates', 'NOTAM']);
  await tabs.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await expect(page.getByText('2 of 2 retained notices')).toBeVisible();
  await expect(page.getByText('Lighting Unavailable', { exact: true })).toBeVisible();
  await page.getByText('Show raw', { exact: true }).first().click();
  await expect(page.locator('.notam-raw[open] pre').first()).toBeVisible();
  await page.getByLabel('Classification', { exact: true }).selectOption('FDC');
  await expect(page.getByText('1 of 2 retained notices')).toBeVisible();
  await page.getByRole('button', { name: 'Toggle Plates availability' }).click();
  await expect(tabs.getByRole('tab')).toHaveText(['Info', 'NOTAM']);
  await expect(tabs.getByRole('tab', { name: 'NOTAM', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Disable NOTAM plugin' }).click();
  await expect(tabs).toHaveCount(0);
  await page.getByRole('button', { name: 'Enable NOTAM plugin' }).click();
  await expect(tabs.getByRole('tab', { name: 'NOTAM', exact: true })).toHaveAttribute('aria-selected', 'true');
});
test('detailed tags distinguish closures, outages and procedure notes in both themes on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.route('**/api/notams/airports?**', route => {
    const now = Date.now(), records = detailedNotices().map(record => ({ ...record, startsAt: now - 1000, endsAt: now + 86_400_000 }));
    const snapshot = notamSnapshot(records); snapshot.feed.checkedAt = snapshot.feed.watermark = now;
    return route.fulfill({ json: snapshot });
  });
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await expect(page.getByText('5 of 5 retained notices')).toBeVisible();
  const procedure = page.locator('.notam-entry').filter({ hasText: 'RNAV (RNP) Z RWY 30L' });
  await expect(procedure.locator('.notam-flairs')).toContainText('Inoperative Lighting Note');
  await expect(procedure.locator('.notam-flairs')).not.toContainText(/unavailable/i);
  await procedure.getByText('Show raw', { exact: true }).click();
  await expect(procedure.locator('.notam-raw[open] pre').first()).toHaveText(detailedNotices()[0]!.translations[0]!.text);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const colors = [];
    for (const label of ['Runway', 'RNAV (RNP) Z RWY 30L', 'Minima Amended', 'Runway Closed']) {
      const color = await page.locator('.notam-flairs').getByText(label, { exact: true }).evaluate(element => {
        const style = getComputedStyle(element);
        return { text: style.color, background: style.backgroundColor };
      });
      expect(contrast(color.text, color.background), `${theme}: ${label}`).toBeGreaterThanOrEqual(4.5);
      colors.push(color.background);
    }
    expect(new Set(colors).size).toBe(4);
    expect(await page.locator('.airport-notams').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await procedure.getByText('Show raw', { exact: true }).click();
    await procedure.locator('.notam-flairs').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`notam-flairs-${theme}.png`) });
    await procedure.getByText('Show raw', { exact: true }).click();
  }
});
test('plate bar shares data, follows actual pages, scrolls and leaves the PDF mounted', async ({ page }) => {
  let pdfRequests = 0, notamRequests = 0;
  page.on('request', request => { if (request.url().includes('test.pdf')) pdfRequests++; if (request.url().includes('/api/notams/airports?')) notamRequests++; });
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  const row = page.getByRole('button', { name: /RNAV \(GPS\) Y RWY 09L/ });
  // Establish a completed snapshot before stowing the row; an in-flight request may be cancelled.
  await expect(row).toContainText('NOTAM · 2 matched');
  await row.click();
  const canvas = page.getByLabel('PDF page 1'); await expect(canvas).toBeVisible();
  const bar = page.getByRole('button', { name: /NOTAM · 2 matched/ }); await expect(bar).toBeVisible();
  await canvas.evaluate(node => { node.setAttribute('data-notam-pdf-marker', 'same'); });
  await bar.click();
  await expect(page.getByRole('region', { name: 'Notices for displayed plate' })).toBeVisible();
  await expect(page.getByText('Applies to this plate', { exact: true })).toBeVisible();
  await expect(canvas).toHaveAttribute('data-notam-pdf-marker', 'same');
  expect(notamRequests).toBe(1);
  await page.getByRole('button', { name: 'Disable NOTAM plugin' }).click();
  await expect(page.locator('.plate-notams')).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-notam-pdf-marker', 'same');
  await page.getByRole('button', { name: 'Enable NOTAM plugin' }).click();
  await expect(bar).toBeVisible();
  await page.getByRole('button', { name: 'Next PDF page' }).click();
  await expect(page.getByLabel('PDF page 2')).toBeVisible();
  await expect(page.getByRole('button', { name: /NOTAM · 0 matched/ })).toBeVisible();
  await page.getByRole('button', { name: 'Next PDF page' }).click();
  await expect(page.getByRole('button', { name: 'NOTAM · Matching unavailable' })).toBeVisible();
  await expect(page.getByLabel('PDF page 3')).toHaveAttribute('data-notam-pdf-marker', 'same');
  expect(pdfRequests).toBe(1);
});
test('offline staging notices keep one testing warning; stowing releases demand', async ({ page }) => {
  // Install before module evaluation so the client's captured Date.now uses this clock.
  await page.clock.install();
  await page.reload();
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await expect(page.getByText('2 of 2 retained notices')).toBeVisible();
  let requests = 0; page.on('request', request => { if (request.url().includes('/api/notams/airports?')) requests++; });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await page.clock.fastForward(7 * 60_000);
  await expect(page.getByText('Testing with FAA staging data. Notices may be incomplete. Do not use for flight planning.', { exact: true })).toHaveCount(1);
  await expect(page.getByText('2 of 2 retained notices', { exact: true })).toBeVisible();
  await expect(page.getByText(/Stale|Incomplete coverage|Current completeness unconfirmed|Feed update incomplete/)).toHaveCount(0);
  expect(requests).toBe(0);
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await page.clock.fastForward(4 * 60_000); expect(requests).toBe(0);
});
test('narrow expanded notices preserve PDF space and collapse independently', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /RNAV \(GPS\) Y RWY 09L/ }).click();
  await expect(page.getByLabel('PDF page 1')).toBeVisible();
  await page.getByRole('button', { name: /NOTAM · 2 matched/ }).click();
  const box = await page.locator('.procedure-page-stage').boundingBox(); expect(box!.height).toBeGreaterThan(40);
  const scroll = await page.locator('.plate-notams-list').evaluate(el => ({ height: el.clientHeight, total: el.scrollHeight }));
  expect(scroll.total).toBeGreaterThan(scroll.height);
  await page.getByRole('button', { name: /NOTAM · 2 matched/ }).click();
  await expect(page.getByRole('region', { name: 'Notices for displayed plate' })).toHaveCount(0);
  await expect(page.getByLabel('PDF page 1')).toBeVisible();
});
for (const recovery of ['retry', 'reconnect'] as const) {
  test(`saved plate catalog recovers after ${recovery} without replacing the PDF`, async ({ page }) => {
    let fail = true, requests = 0;
    await page.route('https://example.test/**/catalog.json?*', route => {
      requests++;
      return fail ? route.fulfill({ status: 503, body: 'Temporarily unavailable' }) : route.fulfill({ json: catalog });
    });
    await page.getByRole('button', { name: 'Open saved plate', exact: true }).click();
    const canvas = page.getByLabel('PDF page 1'); await expect(canvas).toBeVisible();
    await canvas.evaluate(node => node.setAttribute('data-notam-pdf-marker', 'same'));
    await page.getByRole('button', { name: 'NOTAM · Matching unavailable' }).click();
    await expect(page.getByRole('button', { name: 'Retry plate catalog' })).toBeVisible();
    fail = false;
    if (recovery === 'retry') await page.getByRole('button', { name: 'Retry plate catalog' }).click();
    else {
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
        window.dispatchEvent(new Event('offline'));
      });
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
        window.dispatchEvent(new Event('online'));
      });
    }
    await expect(page.getByRole('button', { name: /NOTAM · 2 matched/ })).toBeVisible();
    await expect(page.getByText('Applies to this plate', { exact: true })).toBeVisible();
    await expect(canvas).toHaveAttribute('data-notam-pdf-marker', 'same');
    expect(requests).toBeGreaterThanOrEqual(2);
  });
}
