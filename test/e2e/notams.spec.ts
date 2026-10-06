import { TFR_DETAIL_REFRESH_MS, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import { test, expect, type Locator } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type ViteDevServer } from 'vite';
import { PDFDocument } from 'pdf-lib';
import { approachAmendmentNotice, departureNotice, detailedNotices, notice, notamSnapshot, testAirport, testCatalog, testProcedure, testResource } from '../fixtures/notams';
import { contrast } from '../../tools/theme/color';
import { procedureSelection } from '../../src/layers/plates/data';
import corpus from '../fixtures/notams-corpus.json' with { type: 'json' };
import formats from '../fixtures/notams-formats.json' with { type: 'json' };
import bullFire from '../fixtures/notams-us-artcc/bull-fire-tfr.json' with { type: 'json' };
import znyTfrs from '../fixtures/notams-us-artcc/zny-tfrs.json' with { type: 'json' };
import znyRegion from '../fixtures/notams-us-artcc/zny-hover.json' with { type: 'json' };
import znyNavaids from '../fixtures/notams-us-artcc/zny-navaids.json' with { type: 'json' };
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

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
  await page.route('**/api/notams/tfrs', route => route.fulfill({ json: { schemaVersion: 1, source: 'FAA-TFR', checkedAt: Date.now(), notices: [] } }));
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
  await expect(page.getByText('RWY 09L · Lighting Unavailable', { exact: true })).toBeVisible();
  await page.getByText('Show raw', { exact: true }).first().click();
  await expect(page.locator('.notam-raw[open] pre').first()).toBeVisible();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
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
for (const [width, height] of [[393, 900], [1280, 900], [640, 360]] as const) test(`airport ARTCC/FIR tabs stay fixed above scrolling notices at ${width}×${height}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height });
  const calls: string[] = [];
  await page.route('**/api/notams/regions?**', route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams), now = Date.now();
    calls.push(route.request().url()); expect(query).toEqual({ artccId: 'ZOA', firId: 'KZOA' });
    const records = ['DOMESTIC', 'FDC', 'INTL'].map((classification, index) => notice({
      id: String(100 + index).padStart(16, '0'), sourceId: String(100 + index).padStart(16, '0'), classification,
      locations: ['ZOA'], icaoLocations: ['KZOA'], startsAt: now - 60_000, endsAt: now + 86_400_000,
      text: index === 0 ? 'NAV GPS MAY NOT BE AVBL' : `AIRSPACE REGIONAL FIXTURE ${index}`, translations: [],
    }));
    const snapshot = { ...notamSnapshot(records), query, scope: 'region-location', associationCoverage: 'incomplete' };
    snapshot.feed.checkedAt = snapshot.feed.watermark = now;
    return route.fulfill({ json: snapshot });
  });
  await page.goto(`${origin}/test/browser/notams.html?region=1`);
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await expect(page.getByText('2 of 2 retained notices')).toBeVisible(); expect(calls).toHaveLength(0);
  const areas = page.getByRole('tablist', { name: 'NOTAM area', exact: true });
  await areas.getByRole('tab', { name: 'Airport', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(areas.getByRole('tab', { name: 'ARTCC / FIR', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'ARTCC / FIR', exact: true })).toBeVisible();
  const regional = page.getByRole('region', { name: 'Regional NOTAMs', exact: true });
  await expect(regional.getByText('3 of 3 retained notices')).toBeVisible();
  await expect(regional.getByRole('button', { name: 'Filters', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: testInfo.outputPath('airport-regional-notams.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scroller = page.locator('.feature-card-content');
  const areaBox = (await areas.boundingBox())!;
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(areas).toBeInViewport({ ratio: 1 });
  expect((await areas.boundingBox())!.y).toBe(areaBox.y);
  await page.screenshot({ path: testInfo.outputPath('airport-regional-scrolled.png') });
  await areas.getByRole('tab', { name: 'Airport', exact: true }).click();
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
  await expect(areas).toBeInViewport({ ratio: 1 });
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
  await expect(areas).toHaveCount(0);
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await areas.getByRole('tab', { name: 'ARTCC / FIR', exact: true }).click();
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
  await regional.getByRole('button', { name: 'Filters', exact: true }).click();
  await regional.getByLabel('Classification', { exact: true }).selectOption('FDC');
  await expect(regional.getByText('1 of 3 retained notices')).toBeVisible();
  await regional.getByLabel('Classification', { exact: true }).selectOption('all');
  await scroller.evaluate(element => { element.scrollTop = 80; });
  const readingPosition = await scroller.evaluate(element => element.scrollTop);
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  await expect(regional).not.toBeVisible();
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  await expect(regional.getByText('3 of 3 retained notices')).toBeVisible();
  expect(await scroller.evaluate(element => element.scrollTop)).toBe(readingPosition);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline'));
  });
  await expect(regional.getByText(/Offline/)).toBeVisible();
  await expect(regional.getByText('3 of 3 retained notices')).toBeVisible();
  await areas.getByRole('tab', { name: 'Airport', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Airport NOTAMs', exact: true }).getByText('2 of 2 retained notices')).toBeVisible();
  await expect(regional).toHaveCount(0); expect(calls).toHaveLength(1);
});
test('airport with no published ARTCC/FIR association reports unavailable without a regional request', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/notams/regions?**', route => { calls++; return route.fulfill({ status: 500 }); });
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await page.getByRole('tab', { name: 'ARTCC / FIR', exact: true }).click();
  await expect(page.getByText(/ARTCC\/FIR lookup is unavailable/)).toBeVisible();
  await expect(page.getByText('No retained regional notices in this snapshot.')).toHaveCount(0);
  expect(calls).toBe(0);
});
for (const width of [393, 1280]) test(`collapsed airport filters expose restrictions and clear together at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  const airport = page.getByRole('region', { name: 'Airport NOTAMs', exact: true });
  const filters = airport.getByRole('button', { name: /^Filters/ });
  await expect(airport.getByText('2 of 2 retained notices')).toBeVisible();
  await expect(filters).toHaveAttribute('aria-expanded', 'false');
  await expect(airport.getByRole('searchbox')).toHaveCount(0);
  await expect(airport.getByRole('button', { name: 'Refresh NOTAMs' })).toHaveCount(0);
  await expect(airport.locator('.notam-entry').first()).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('airport-compact-notams.png') });
  await filters.click();
  await airport.getByLabel('Classification', { exact: true }).selectOption('D');
  await airport.getByLabel('Subject', { exact: true }).selectOption('RWY');
  await airport.getByRole('searchbox', { name: 'Search' }).fill('09L');
  await expect(airport.getByText('1 of 2 retained notices')).toBeVisible();
  await filters.click();
  await expect(filters).toHaveText('Filters (3)');
  await expect(airport.getByText('D · RWY · Search: “09L”', { exact: true })).toBeVisible();
  await expect(airport.getByRole('searchbox')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('airport-active-filters.png') });
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  await expect(filters).toHaveAttribute('aria-expanded', 'false');
  await expect(airport.getByText('1 of 2 retained notices')).toBeVisible();
  await airport.getByRole('button', { name: 'Clear NOTAM filters', exact: true }).click();
  await expect(airport.getByText('2 of 2 retained notices')).toBeVisible();
  await expect(filters).toHaveText('Filters');
  await expect(airport.getByText('D · RWY · Search: “09L”', { exact: true })).toHaveCount(0);
  await filters.focus(); await page.keyboard.press('Enter');
  await expect(airport.getByLabel('Classification', { exact: true })).toHaveValue('all');
  await expect(airport.getByLabel('Subject', { exact: true })).toHaveValue('all');
  await expect(airport.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
});
test('airport notices prioritize closures and navaid outages separately within each timing section and filters', async ({ page }) => {
  const now = Date.now();
  const samples = [
    { text: 'RWY 09 WIP', issuedAt: now },
    { text: 'SVC TWR CLSD', issuedAt: now - 1000 },
    { text: 'NAV VOR U/S', issuedAt: now - 2000 },
    { text: 'TWY A CLSD', issuedAt: now - 3000 },
    { text: 'RWY 09 CLSD', issuedAt: now - 4000 },
    { text: 'RWY 27 CLSD', issuedAt: null, updatedAt: now - 3000 },
    { text: 'IAP ALL IAPS NA', classification: 'FDC', issuedAt: now },
    { text: 'NAV VOR NOT MNT', issuedAt: now },
  ];
  const records = [100, 200, 300].flatMap(base => samples.map((sample, i) => {
    const number = String(base + i + 1);
    return notice({ ...sample, number, id: number.padStart(16, '0'), sourceId: number.padStart(16, '0'), translations: [],
      startsAt: base === 300 ? now + 3_600_000 : now - 60_000, endsAt: now + 86_400_000,
      schedule: base === 200 ? 'SR-SS' : '' });
  })).reverse();
  await page.route('**/api/notams/airports?**', route => route.fulfill({ json: notamSnapshot(records) }));
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  const airport = page.locator('.airport-notams');
  await expect(airport.getByRole('heading', { level: 3 })).toHaveText(['Active 8', 'Check timing 8', 'Upcoming 8']);
  const assertOrder = async (order: number[]) => {
    for (const [section, base] of [['Active', 100], ['Check timing', 200], ['Upcoming', 300]] as const) {
      await expect(airport.getByRole('region', { name: section, exact: true }).locator('.notam-entry-heading strong'))
        .toHaveText(order.map(n => `${n === 7 ? 'FDC' : 'D'} · ${base + n}/2026`));
    }
  };
  await assertOrder([4, 6, 5, 3, 7, 8, 2, 1]);
  await airport.getByRole('button', { name: 'Filters', exact: true }).click();
  await airport.getByLabel('Classification', { exact: true }).selectOption('D');
  await assertOrder([4, 6, 5, 3, 8, 2, 1]);
  await airport.getByLabel('Classification', { exact: true }).selectOption('all');
  await airport.getByLabel('Subject', { exact: true }).selectOption('NAV');
  await assertOrder([3, 8]);
  await airport.getByLabel('Subject', { exact: true }).selectOption('all');
  await airport.getByRole('searchbox', { name: 'Search' }).fill('CLSD');
  await assertOrder([4, 6, 5, 2]);
  await airport.getByRole('searchbox', { name: 'Search' }).clear();
  await assertOrder([4, 6, 5, 3, 7, 8, 2, 1]);
});
for (const width of [393, 1280]) test(`source conflicts remain visible offline and qualify only affected airports at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const variants = [notice({ text: 'RWY 09L CLSD', translations: [], revision: 'a'.repeat(64) }),
    notice({ text: 'RWY 09L OPEN', translations: [], revision: 'b'.repeat(64) })];
  const issue: NotamSourceIssue = { id: variants[0]!.id, reason: 'revision-conflict', variants,
    variantsTruncated: false, locations: ['TST'], icaoLocations: ['KTST'], unscoped: false };
  await page.route('**/api/notams/airports?**', route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams), affected = query.faaId === 'TST', now = Date.now();
    const snapshot = notamSnapshot([], { query, issues: affected ? [issue] : [], contentCoverage: affected ? 'incomplete' : 'complete' });
    snapshot.feed = { ...snapshot.feed, environment: 'production', state: 'degraded', recordCount: 1,
      checkedAt: now, watermark: now, continuity: 'incomplete', collectionContinuity: 'complete',
      unresolvedRecords: 1, unscopedRecords: 0, error: 'unresolved-records' };
    return route.fulfill({ json: snapshot });
  });
  await page.reload();
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  const airport = page.locator('.airport-notams');
  await expect(airport.getByText(/Incomplete coverage/)).toBeVisible();
  await expect(airport.getByRole('heading', { name: /Source data needs review/ })).toBeVisible();
  await airport.getByText('Review FAA source versions', { exact: true }).click();
  await expect(airport.locator('pre')).toHaveText(['RWY 09L CLSD', 'RWY 09L OPEN']);
  await airport.locator('pre').last().scrollIntoViewIfNeeded();
  await expect(airport.locator('pre').last()).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('source-issues.png') });
  await airport.getByRole('button', { name: 'Filters', exact: true }).click();
  await airport.getByRole('searchbox').fill('unmatched search');
  await expect(airport.getByRole('heading', { name: /Source data needs review/ })).toBeVisible();
  await page.getByRole('button', { name: 'Open saved plate', exact: true }).click();
  await expect(page.getByLabel('PDF page 1', { exact: true })).toBeVisible();
  const toggle = page.getByRole('button', { name: 'NOTAM · 0 matched · Source data needs review', exact: true });
  await expect(toggle).toBeVisible(); await toggle.click();
  const plate = page.getByRole('region', { name: 'Notices for displayed plate', exact: true });
  await expect(plate.getByRole('heading', { name: /Source data needs review/ })).toBeVisible();
  await expect(plate.locator('.notam-chart-note')).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline'));
  });
  await expect(plate.getByText(/Offline/)).toBeVisible();
  await expect(plate.getByRole('heading', { name: /Source data needs review/ })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online'));
  });
  if (width < 600) await page.getByRole('button', { name: /Choose PDF page/ }).click();
  await page.getByRole('button', { name: 'Next PDF page' }).click();
  await page.getByRole('button', { name: 'NOTAM · 0 matched', exact: true }).click();
  await expect(plate.getByText(/Incomplete coverage|Source data needs review|Feed update incomplete/)).toHaveCount(0);
});
test('temporary obstacle map context follows open readers, filters, stow and plugin lifetime', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  // Reuse the second indexed page as a diagram to exercise procedure/non-procedure transitions.
  await page.route('https://example.test/**/catalog.json?*', route => route.fulfill({ json: {
    ...catalog, airports: catalog.airports.map(airport => airport.id === 'PANC' ? { ...airport,
      procedures: airport.procedures.map(procedure => ({ ...procedure, kind: 'airport-diagram', name: 'Airport diagram',
        source: { ...procedure.source, chartCode: 'APD' } })),
    } : airport),
  } }));
  const now = Date.now();
  const records = [
    'OBST CRANE (ASN 2026-AWP-3090-OE) 370015N1220015W (1NM E TST) 350FT (200FT AGL) FLAGGED',
    'OBST TOWER LGT (ASR UNKNOWN) 370010N1220030W (1NM W TST) 1500FT (1200FT AGL) U/S',
    'IAP TEST AIRPORT, CA. RNAV (GPS) Y RWY 09L, AMDT 2... PERM CRANE (06-000846) 439FT MSL (4A) 370005.50N/1220010.50W.',
  ].map((text, i) => notice({ id: `175760000000003${i}`, sourceId: `NMS_ID_175760000000003${i}`, text,
    classification: i === 2 ? 'FDC' : 'DOMESTIC', startsAt: now - 1000, endsAt: now + 86_400_000 }));
  await page.route('**/api/notams/airports?**', route => route.fulfill({ json: notamSnapshot(records) }));
  await page.goto(`${origin}/test/browser/notams.html?map`);
  const rendered = () => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit?: { map: MapLibreMap } }).notamMapAudit?.map;
    return map?.getLayer('notam-obstacle-symbols') ? [...new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-obstacle-symbols'] }).map(f => f.id))].length : 0;
  });
  const dof = () => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit?: { map: MapLibreMap } }).notamMapAudit?.map;
    return map?.getLayer('route-obstruction-symbols') ? map.queryRenderedFeatures(undefined, { layers: ['route-obstruction-symbols'] }).length : 0;
  });
  await expect.poll(dof).toBeGreaterThan(0);
  await expect.poll(rendered).toBe(0);
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await expect.poll(rendered).toBe(3);
  const entries = page.locator('.airport-notams .notam-entry');
  const crane = entries.filter({ hasText: '2026-AWP-3090-OE' });
  await expect(crane.locator('.notam-chart-note')).toHaveText('Location shown on chart');
  await expect(crane.locator('.notam-readable')).toHaveText('Flagged');
  await expect(entries.filter({ hasText: 'ASR UNKNOWN' }).locator('.notam-readable')).toHaveText('LGT U/S');
  await expect(entries.filter({ hasText: '06-000846' }).locator('.notam-readable')).toContainText('RNAV (GPS) Y');
  await crane.getByText('Show raw', { exact: true }).click();
  await expect(crane.locator('.notam-raw pre').last()).toHaveText(records[0]!.text);
  await crane.getByText('Show raw', { exact: true }).click();
  await page.getByRole('button', { name: 'Detach NOTAM chart', exact: true }).click();
  await expect(crane.locator('.notam-readable')).toContainText('2026-AWP-3090-OE');
  await page.getByRole('button', { name: 'Attach NOTAM chart', exact: true }).click();
  await expect.poll(rendered).toBe(3);
  await expect(crane.locator('.notam-readable')).toHaveText('Flagged');
  await page.screenshot({ path: testInfo.outputPath('notam-obstacles-open.png') });
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search' });
  await search.fill('2026-AWP-3090-OE'); await expect(entries).toHaveCount(1); await expect.poll(rendered).toBe(1);
  await search.fill('Crane'); await expect.poll(rendered).toBe(2);
  await search.fill('no-matching-notice'); await expect.poll(rendered).toBe(0);
  await search.fill(''); await expect.poll(rendered).toBe(3);
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  await expect.poll(rendered).toBe(0); await expect.poll(dof).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('notam-obstacles-stowed.png') });
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  await expect.poll(rendered).toBe(3);
  await page.getByRole('tab', { name: 'Info', exact: true }).click(); await expect.poll(rendered).toBe(0);
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /RNAV \(GPS\) Y RWY 09L/ }).click();
  await expect(page.getByLabel('PDF page 1')).toBeVisible();
  const bar = page.getByRole('button', { name: /NOTAM · 1 matched/ });
  await expect(bar).toBeVisible(); await expect.poll(rendered).toBe(0);
  await bar.click(); await expect.poll(rendered).toBe(1);
  await bar.click(); await expect.poll(rendered).toBe(0);
  await bar.click(); await expect.poll(rendered).toBe(1);
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click(); await expect.poll(rendered).toBe(0);
  await page.getByRole('button', { name: 'Show KTST plate', exact: true }).click(); await expect.poll(rendered).toBe(1);
  await page.getByRole('button', { name: 'Remount NOTAM map' }).click(); await expect.poll(rendered).toBe(1);
  await page.getByRole('button', { name: 'Disable NOTAM plugin' }).click(); await expect.poll(rendered).toBe(0);
  await expect.poll(dof).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Enable NOTAM plugin' }).click();
  await expect(bar).toBeVisible(); await expect.poll(rendered).toBe(0);
  await bar.click(); await expect.poll(rendered).toBe(1);
  await page.getByRole('button', { name: 'Next PDF page' }).click();
  await expect(page.getByLabel('PDF page 2')).toBeVisible(); await expect.poll(rendered).toBe(0);
  await expect(page.locator('.plate-notams')).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous PDF page' }).click();
  await expect(page.getByLabel('PDF page 1')).toBeVisible(); await expect.poll(rendered).toBe(1);
  expect(errors).toEqual([]);
});
for (const touch of [false, true]) test.describe(touch ? 'touch TFR inspection' : 'mouse TFR inspection', () => {
  test.use({ hasTouch: touch });
  test('TFRs persist independently of airport readers, use red/yellow solid areas and follow plugin lifetime', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 900 });
    const now = Date.now();
    await page.clock.install({ time: now });
    const records = [-122.03,-122.017,-122.005].map((lon,i) => ({ id: `6/900${i}`, modifiedAt: now-1000, detailCheckedAt: now,
      title: ['Active fixture TFR','Upcoming fixture TFR','Expired fixture TFR'][i], type: 'HAZARDS', facility: 'TST', state: 'CA',
      startsAt: i === 1 ? now+3600_000 : now-3600_000, endsAt: i === 2 ? now-1000 : now+7200_000,
      text: 'Invented TFR for browser verification. No operational use.',
      areas: [{ id: '1', name: 'Area A', lower: 'SFC', upper: '3000 ft MSL', geometry: { type: 'Polygon',
        coordinates: [[[lon-.004,37.001],[lon+.004,37.001],[lon+.004,37.009],[lon-.004,37.009],[lon-.004,37.001]]] },
        windows: [{ startsAt: i === 1 ? now+3600_000 : now-3600_000, endsAt: i === 2 ? now-1000 : now+7200_000 }] }] }));
    records.push({ ...records[0]!, id: '6/9003', title: 'Overlapping fixture TFR' });
    await page.route('**/api/notams/tfrs', route => route.fulfill({ json: { schemaVersion: 1, source: 'FAA-TFR', checkedAt: now, notices: records } }));
    await page.goto(`${origin}/test/browser/notams.html?map`);
    const displayed = () => page.evaluate(() => {
      const map = (window as unknown as { notamMapAudit?: { map: MapLibreMap } }).notamMapAudit?.map;
      return map?.getLayer('notam-tfr-fill') ? [...new Map(map.queryRenderedFeatures(undefined,{layers:['notam-tfr-fill']})
        .map(f=>[f.properties.noticeId,{id:f.properties.noticeId,color:f.state.color}])).values()].sort((a,b)=>a.id.localeCompare(b.id)) : [];
    });
    const expected = [{id:'6/9000',color:'#ff4d55'},{id:'6/9001',color:'#ffd54a'},{id:'6/9003',color:'#ff4d55'}];
    await expect.poll(displayed).toEqual(expected);
    expect(await page.evaluate(() => (window as unknown as {notamMapAudit:{map:MapLibreMap}}).notamMapAudit.map.getPaintProperty('notam-tfr-fill','fill-pattern'))).toBeUndefined();
    expect(await page.evaluate(() => (window as unknown as {notamMapAudit:{map:MapLibreMap}}).notamMapAudit.map.getStyle().layers
      .filter(layer => layer.id.startsWith('notam-tfr-')).map(layer => [layer.id, layer.type]))).toEqual([
      ['notam-tfr-fill', 'fill'], ['notam-tfr-line', 'line'],
      ['notam-tfr-highlight-halo', 'line'], ['notam-tfr-highlight', 'line'],
    ]);
    await expect.poll(() => page.evaluate(() => (window as unknown as {notamMapAudit:{map:MapLibreMap}}).notamMapAudit.map
      .queryRenderedFeatures(undefined, { layers: ['notam-tfr-highlight-halo', 'notam-tfr-highlight'] }).length)).toBe(0);
    await page.getByRole('tab',{name:'NOTAM',exact:true}).click(); await expect.poll(displayed).toEqual(expected);
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.getByRole('searchbox',{name:'Search'}).fill('nothing-matches'); await expect.poll(displayed).toEqual(expected);
    await page.getByRole('button',{name:'Stow fixture',exact:true}).click(); await expect.poll(displayed).toEqual(expected);
    await page.screenshot({animations:'disabled',path:testInfo.outputPath('tfr-active-upcoming.png')});
    const point = await page.evaluate(() => {
      const p=(window as unknown as {notamMapAudit:{map:MapLibreMap}}).notamMapAudit.map.project([-122.03,37.004]); return {x:p.x,y:p.y};
    });
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    const details = page.getByRole('region', { name: 'TFR details', exact: true });
    await expect(details).toBeVisible();
    await expect(details.getByRole('heading', { level: 3 })).toHaveText(['6/9000 · HAZARDS', '6/9003 · HAZARDS']);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
    await expect(page.locator('.notam-tfr-detail')).toContainText('6/9000');
    await expect(page.locator('.notam-tfr-detail')).toContainText('SFC–3000 ft MSL');
    await expect(page.getByRole('button', { name: /^(Show|Hide) TFR details$/ })).toHaveCount(0);
    await details.screenshot({ animations: 'disabled', path: testInfo.outputPath('tfr-desktop-details.png') });
    await page.locator('.notam-tfr-detail summary').first().click();
    await expect(page.locator('.notam-tfr-detail pre').first()).toHaveText(records[0]!.text);
    await details.press('Escape');
    await expect(details).toBeHidden();
    await expect(page.locator('.maplibregl-canvas')).toBeFocused();
    await page.clock.fastForward(30_000);
    await expect(details).toBeHidden();
    const menu = page.getByRole('menu', { name: 'Map actions' });
    if (touch) {
      const session = await page.context().newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await expect(menu).toBeVisible();
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else await page.mouse.click(point.x, point.y, { button: 'right' });
    await expect(menu).toBeVisible();
    await expect(details).toBeHidden();
    await expect(menu.getByRole('menuitem', { name: /coordinate · GPS waypoint/ })).toHaveCount(1);
    await menu.getByRole('menuitem', { name: 'Inspect TFRs', exact: true }).click();
    await expect(details).toBeVisible();
    await page.clock.fastForward(6 * 60_000);
    await expect(details).toContainText('May be out of date');
    await page.getByRole('button', { name: 'Close TFR details', exact: true }).click();
    await expect(details).toHaveCount(0);
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await expect(details).toBeVisible();
    await page.getByRole('button',{name:'Disable NOTAM plugin'}).click(); await expect.poll(displayed).toEqual([]);
    await expect(page.locator('.notam-tfr-detail')).toHaveCount(0);
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await expect(menu).toHaveCount(0);
    await page.getByRole('button',{name:'Enable NOTAM plugin'}).click(); await expect.poll(displayed).toEqual(expected);
    await page.getByRole('button',{name:'Remount NOTAM map'}).click(); await expect.poll(displayed).toEqual(expected);
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(() => {
      const map=(window as unknown as {notamMapAudit:{map:MapLibreMap}}).notamMapAudit.map;
      map.resize(); map.jumpTo({center:[-122.03,37.005]});
    });
    if (touch) await page.touchscreen.tap(195, 422);
    else await page.mouse.click(195, 422);
    await expect(page.locator('.notam-tfr-detail')).toContainText('6/9000');
    await expect(details).toBeInViewport({ ratio: 1 });
    const bounds=await details.boundingBox();
    expect(bounds).toBeTruthy(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(391);
    await page.screenshot({animations:'disabled',path:testInfo.outputPath('tfr-mobile-details.png')});
    await expect(details).toBeVisible();
    await containedText(details);
    expect(errors).toEqual([]);
  });
});
test('TFR restoration, refresh and detail expiry preserve colors until the schedule changes', async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  let requests = 0;
  const records = [-122.03, -122.017].map((lon, i) => ({ id: `6/900${i}`, modifiedAt: now - TFR_DETAIL_REFRESH_MS - 120_000,
    detailCheckedAt: now - TFR_DETAIL_REFRESH_MS + 60_000 + i * 1000,
    title: 'Synthetic TFR', type: 'HAZARDS', facility: 'TST', state: 'CA', text: 'Test only',
    startsAt: i ? now + 3600_000 : now - 3600_000, endsAt: now + 7200_000,
    areas: [{ id: '1', name: 'Area A', lower: 'SFC', upper: '3000 ft MSL', geometry: { type: 'Polygon',
      coordinates: [[[lon - .004, 37.001], [lon + .004, 37.001], [lon + .004, 37.009], [lon - .004, 37.009], [lon - .004, 37.001]]] },
      windows: [{ startsAt: i ? now + 3600_000 : now - 3600_000, endsAt: now + 7200_000 }] }] }));
  const savedAt = now - TFR_DETAIL_REFRESH_MS - 60_000;
  await page.addInitScript(snapshot => localStorage.setItem('zlayer-plugin:notams:tfr-snapshot', JSON.stringify(snapshot)),
    { schemaVersion: 1, source: 'FAA-TFR', checkedAt: savedAt, notices: records.map(record => ({ ...record, detailCheckedAt: savedAt })) });
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/notams/tfrs', async route => {
    requests++;
    await responseReady;
    return route.fulfill({ json: { schemaVersion: 1, source: 'FAA-TFR', checkedAt: now, notices: records } });
  });
  await page.goto(`${origin}/test/browser/notams.html?map&tfr-status`);
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  const footer = page.locator('.notam-tfr-status');
  await expect(footer).toContainText('2 need source review');
  const colors = () => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit?: { map: MapLibreMap } }).notamMapAudit?.map;
    return map?.getLayer('notam-tfr-fill') ? [...new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-tfr-fill'] })
      .map(f => f.state.color))].sort() : [];
  });
  await expect.poll(colors).toEqual(['#ff4d55', '#ffd54a']);
  const pixel = () => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    const canvas = map.getCanvas(), gl = canvas.getContext('webgl2')!, p = map.project([-122.017, 37.005]);
    const pixel = new Uint8Array(4), scale = canvas.width / canvas.clientWidth;
    gl.readPixels(Math.round(p.x * scale), Math.round(canvas.height - p.y * scale), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return [...pixel];
  });
  await expect.poll(async () => {
    const [r, g, b] = await pixel(); return g! > b! + 10 && r! >= g! - 10;
  }).toBe(true);
  await page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    const audit = { submissions: 0, hidden: 0, colors: [] as string[] };
    Object.assign(window, { tfrRenderAudit: audit });
    const source = map.getSource('notam-tfrs') as GeoJSONSource, setData = source.setData.bind(source);
    source.setData = data => { audit.submissions++; return setData(data); };
    const setLayout = map.setLayoutProperty.bind(map), setState = map.setFeatureState.bind(map);
    map.setLayoutProperty = (id, name, value, options) => {
      if (id.startsWith('notam-tfr-') && name === 'visibility' && value === 'none') audit.hidden++;
      return setLayout(id, name, value, options);
    };
    map.setFeatureState = (feature, state) => {
      if (feature.source === 'notam-tfrs') audit.colors.push(state.color);
      return setState(feature, state);
    };
  });
  // An app/server restart restores stale detail while the fresh response is pending.
  release();
  await expect(footer).not.toContainText('need source review');
  await expect.poll(colors).toEqual(['#ff4d55', '#ffd54a']);
  expect(await page.evaluate(() => (window as unknown as { tfrRenderAudit: unknown }).tfrRenderAudit))
    .toEqual({ submissions: 0, hidden: 0, colors: [] });
  // Cross each separately acquired detail's deadline, as the live national feed does.
  const elapsed = await page.evaluate(() => Date.now()) - now;
  await page.clock.fastForward(59_000 - elapsed);
  await page.clock.runFor(3000);
  await expect(footer).toContainText('2 need source review');
  await expect.poll(colors).toEqual(['#ff4d55', '#ffd54a']);
  expect(await page.evaluate(() => (window as unknown as { tfrRenderAudit: unknown }).tfrRenderAudit))
    .toEqual({ submissions: 0, hidden: 0, colors: [] });
  expect(requests).toBe(1);
  await expect.poll(async () => {
    const [r, g, b] = await pixel(); return g! > b! + 10 && r! >= g! - 10;
  }).toBe(true);
  // Stale data still follows actual activation times, including the drawing buffer.
  await page.clock.fastForward(now + 3600_000 - await page.evaluate(() => Date.now()));
  await expect.poll(colors).toEqual(['#ff4d55']);
  expect(await page.evaluate(() => (window as unknown as { tfrRenderAudit: unknown }).tfrRenderAudit))
    .toEqual({ submissions: 0, hidden: 0, colors: ['#ff4d55'] });
  await expect.poll(async () => {
    const [r, g, b] = await pixel(); return r! > g! + 20 && r! > b! + 10;
  }).toBe(true);
});
for (const area of ['Airport', 'ARTCC / FIR'] as const) test(`${area} entry hover and keyboard focus highlight only its accepted map depiction`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const now = Date.now();
  const records = [
    'AIRSPACE UAS WI AN AREA DEFINED AS .15NM RADIUS OF 370015N1220100W SFC-400FT AGL',
    'OBST CRANE (ASN UNKNOWN) 370020N1220120W 350FT (200FT AGL) FLAGGED',
    'NAV VOR U/S',
  ].map((text, i) => notice({ id: `175760000000007${i}`, sourceId: `NMS_ID_175760000000007${i}`, text,
    translations: [{ type: 'LOCAL_FORMAT', text }], startsAt: now - 1000, endsAt: now + 86_400_000 }));
  await page.route('**/api/notams/airports?**', route => route.fulfill({ json: notamSnapshot(records) }));
  await page.route('**/api/notams/regions?**', route => route.fulfill({ json: {
    ...notamSnapshot(records), query: { artccId: 'ZOA', firId: 'KZOA' }, scope: 'region-location',
  } }));
  await page.goto(`${origin}/test/browser/notams.html?map&region`);
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await page.getByRole('tablist', { name: 'NOTAM area' }).getByRole('tab', { name: area, exact: true }).click();
  const entries = page.locator('.airport-notams .notam-entry');
  const boundary = entries.filter({ hasText: 'AIRSPACE' }), crane = entries.filter({ hasText: 'Flagged' }), uncharted = entries.filter({ hasText: 'VOR Unavailable' });
  await expect(boundary).toHaveAttribute('tabindex', '0'); await expect(crane).toHaveAttribute('tabindex', '0');
  await expect(uncharted).not.toHaveAttribute('tabindex');
  const highlighted = () => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return ['notam-highlight-area', 'notam-highlight-point'].map(id => [...new Set(map.queryRenderedFeatures(undefined, { layers: [id] })
      .map(f => f.properties.noticeId))].sort());
  });
  const before = await page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    const source = map.getSource('notam-graphics') as GeoJSONSource, setData = source.setData.bind(source);
    const audit = { writes: 0 }; Object.assign(window, { notamHighlightAudit: audit });
    source.setData = (...args: Parameters<typeof setData>) => { audit.writes++; return setData(...args); };
    return { center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing() };
  });
  await boundary.hover(); await expect.poll(highlighted).toEqual([[records[0]!.id], []]);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('highlight-area.png') });
  await crane.hover(); await expect.poll(highlighted).toEqual([[], [records[1]!.id]]);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('highlight-obstacle.png') });
  await uncharted.hover(); await expect.poll(highlighted).toEqual([[], []]);
  await crane.focus(); await expect.poll(highlighted).toEqual([[], [records[1]!.id]]);
  await crane.getByText('Show raw', { exact: true }).focus();
  await expect.poll(highlighted).toEqual([[], [records[1]!.id]]);
  await page.getByRole('button', { name: 'Filters', exact: true }).focus();
  await expect.poll(highlighted).toEqual([[], []]);
  expect(await page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return { center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing() };
  })).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { notamHighlightAudit: { writes: number } }).notamHighlightAudit.writes)).toBe(0);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await boundary.hover(); await expect.poll(highlighted).toEqual([[records[0]!.id], []]);
  await page.getByRole('searchbox', { name: 'Search' }).fill('CRANE');
  await expect(entries).toHaveCount(1); await expect.poll(highlighted).toEqual([[], []]);
  await entries.first().focus(); await expect.poll(highlighted).toEqual([[], [records[1]!.id]]);
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  await expect.poll(highlighted).toEqual([[], []]);
  expect(errors).toEqual([]);
});

test('temporary areas replace only mapped location prose and restore it when the chart detaches', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const now = Date.now(), circle = 'AIRSPACE UAS WI AN AREA DEFINED AS .15NM RADIUS OF 370015N1220015W (1NM E TST) SFC-400FT AGL';
  const records = [circle,
    'AIRSPACE UAS WI AN AREA DEFINED AS 370008N1220100W TO 370008N1220030W TO 370030N1220030W TO 370030N1220100W TO POINT OF ORIGIN SFC-200FT AGL',
    'NAV GPS MAY NOT BE AVAILABLE WITHIN A .8NM RADIUS CENTERED AT 370000N1220010W FL250-UNL DECREASING IN AREA WITH A DECREASE IN ALTITUDE DEFINED AS: .4NM RADIUS AT 10000FT, .2NM RADIUS AT 50FT AGL.',
    'AIRSPACE UAS WI AN AREA DEFINED AS .1NM EITHER SIDE OF A LINE FM 370000N1220100W TO 370100N1220100W TO 370200N1220200W SFC-400FT AGL',
  ].map((text, i) => notice({ id: `175760000000004${i}`, sourceId: `NMS_ID_175760000000004${i}`, text,
    translations: [{ type: 'LOCAL_FORMAT', text }], startsAt: now - 1000, endsAt: now + 86_400_000 }));
  await page.route('**/api/notams/airports?**', route => route.fulfill({ json: notamSnapshot(records) }));
  await page.goto(`${origin}/test/browser/notams.html?map`);
  const areas = () => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit?: { map: MapLibreMap } }).notamMapAudit?.map;
    return map?.getLayer('notam-area-fill') ? new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-area-fill'] }).map(f => f.id)).size : 0;
  });
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await expect.poll(areas).toBe(4);
  const entries = page.locator('.airport-notams .notam-entry'), first = entries.first();
  await expect(page.getByText('Area shown on chart', { exact: true })).toHaveCount(3);
  await expect(first.locator('.notam-readable')).not.toContainText('370015N1220015W');
  await expect(first.locator('.notam-readable')).toContainText('SFC-400FT AGL');
  const gps = entries.filter({ hasText: 'NAV GPS' });
  await expect(gps.locator('.notam-chart-note')).toHaveText('Outer area shown on chart · Extent varies with altitude');
  await expect(gps.locator('.notam-readable')).toContainText('.4NM radius at 10000FT');
  await expect(gps.locator('.notam-readable')).toContainText('50FT AGL');
  const corridor = entries.last();
  await expect(corridor.locator('.notam-chart-note')).toHaveText('Area shown on chart');
  await expect(corridor.locator('.notam-readable')).not.toContainText('370000N1220100W');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('notam-areas.png') });
  await first.getByText('Show raw', { exact: true }).click();
  await expect(first.locator('.notam-raw pre').last()).toHaveText(circle);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search' });
  await search.fill('370015N1220015W'); await expect(entries).toHaveCount(1); await expect.poll(areas).toBe(1);
  await page.getByRole('button', { name: 'Detach NOTAM chart', exact: true }).click();
  await expect.poll(areas).toBe(0);
  await expect(first.locator('.notam-chart-note')).toHaveCount(0);
  await expect(first.locator('.notam-readable')).toContainText('370015N1220015W');
  await page.getByRole('button', { name: 'Attach NOTAM chart', exact: true }).click();
  await expect.poll(areas).toBe(1); await expect(first.locator('.notam-chart-note')).toHaveText('Area shown on chart');
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click(); await expect.poll(areas).toBe(0);
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click(); await expect.poll(areas).toBe(1);
  await page.setViewportSize({ width: 320, height: 740 });
  await containedText(page.locator('.airport-notams'));
  const validity = first.locator('.notam-validity');
  await expect(validity.locator('.notam-validity-label')).toHaveText(['From', 'Until']);
  const from = (await validity.locator(':scope > div').first().boundingBox())!, until = (await validity.locator(':scope > div').last().boundingBox())!;
  expect(until.y).toBeGreaterThanOrEqual(from.y + from.height);
  await validity.screenshot({ animations: 'disabled', path: testInfo.outputPath('notam-validity-phone.png') });
  expect(errors).toEqual([]);
});

test('ZOA ADS-B duplicate filings share map geometry and labels while preserving both source notices', async ({ page }, testInfo) => {
  const now = Date.now(), text = 'ADS-B, AUTO DEPENDENT SURVEILLANCE REBROADCAST (ADS-R), TFC INFO SER BCST (TIS-B), ' +
    'FLT INFO SER BCST (FIS-B) SER MAY NOT BE AVBL WI AN AREA DEFINED AS 141NM RADIUS OF 384306N1254053W. ' +
    'AP AIRSPACE AFFECTED MAY INCLUDE STS, LLR. 2000FT-UNL.';
  const record = notice({ id: '5336971619014012', sourceId: '5336971619014012', number: '7169', classification: 'FDC', locations: ['ZOA'],
    icaoLocations: ['KZOA'], text, translations: [{ type: 'LOCAL_FORMAT', text }], startsAt: now - 1000, endsAt: now + 86_400_000 });
  const duplicate = { ...record, id: '5336971619014013', sourceId: '5336971619014013', number: '7171' };
  await page.route('**/api/notams/regions?**', route => route.fulfill({ json: {
    ...notamSnapshot([record, duplicate]), query: { artccId: 'ZOA', firId: 'KZOA' }, scope: 'region-location', associationCoverage: 'complete',
  } }));
  await page.goto(`${origin}/test/browser/notams.html?map&region`);
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await page.getByRole('tab', { name: 'ARTCC / FIR', exact: true }).click();
  const entries = page.locator('.airport-notams .notam-entry'), entry = entries.first();
  await expect(entries).toHaveCount(2);
  await expect(entries.locator('.notam-chart-note')).toHaveCount(2);
  await expect(entry.locator('.notam-chart-note')).toHaveText('Area shown on chart');
  await page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    map.jumpTo({ center: [-125 - 40 / 60 - 53 / 3600, 38 + 43 / 60 + 6 / 3600], zoom: 5 });
  });
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-area-fill'] }).map(f => f.id)).size;
  })).toBe(1);
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return new Set(map.querySourceFeatures('notam-graphics').filter(f => f.properties.kind === 'area-label').map(f => f.id)).size;
  })).toBe(1);
  await entries.last().hover();
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-highlight-area'] }).map(f => f.id)).size;
  })).toBe(1);
  await expect(entry.locator('.notam-readable')).toContainText('STS, LLR');
  await expect(entry.locator('.notam-readable')).toContainText('2000FT-UNL');
  await entry.getByText('Show raw', { exact: true }).click();
  await expect(entry.locator('.notam-raw pre').last()).toHaveText(text);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('zoa-adsb-area.png') });
});

test('Bull Fire regional notice refers to accepted national TFR geometry and restores prose on map detachment', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date(bullFire.checkedAt) });
  const fire = bullFire.notices[0]!;
  const body = fire.text.replace(/^!FDC 6\/7106 ZOA /, '').replace(/ \d{10}-\d{10}$/, '');
  const record = notice({ id: '4102096289613864', sourceId: '4102096289613864', number: '7106', classification: 'FDC',
    locations: ['ZOA'], icaoLocations: ['KZOA'], text: body, translations: [{ type: 'LOCAL_FORMAT', text: fire.text }],
    startsAt: fire.startsAt, endsAt: fire.endsAt + 60_000 });
  await page.route('**/api/notams/tfrs', route => route.fulfill({ json: bullFire }));
  await page.route('**/api/notams/regions?**', route => route.fulfill({ json: {
    ...notamSnapshot([record]), query: { artccId: 'ZOA', firId: 'KZOA' }, scope: 'region-location', associationCoverage: 'complete',
  } }));
  await page.goto(`${origin}/test/browser/notams.html?map&region`);
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await page.getByRole('tab', { name: 'ARTCC / FIR', exact: true }).click();
  const entry = page.locator('.airport-notams .notam-entry');
  await expect(entry.locator('.notam-chart-note')).toContainText('TFR 6/7106 shown on chart · SFC–10000 ft MSL');
  await expect(entry.locator('.notam-readable')).toHaveCount(0);
  await page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    map.jumpTo({ center: [-120, 39.55], zoom: 10 });
  });
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-tfr-fill'] }).map(f => f.id)).size;
  })).toBe(1);
  await expect(entry).toHaveAttribute('tabindex', '0');
  await entry.hover();
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return [...new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-tfr-highlight'] }).map(f => f.properties.noticeId))];
  })).toEqual(['6/7106']);
  await entry.getByText('Show raw', { exact: true }).click();
  await expect(entry.locator('.notam-raw pre').first()).toHaveText(fire.text);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('bull-fire-chart-reference.png') });
  await page.getByRole('button', { name: 'Detach NOTAM chart', exact: true }).click();
  await expect(entry.locator('.notam-chart-note')).toHaveCount(0);
  await expect(entry.locator('.notam-readable')).toContainText('BULL FIRE');
  await page.getByRole('button', { name: 'Attach NOTAM chart', exact: true }).click();
  await expect(entry.locator('.notam-readable')).toHaveCount(0);
});

test('KEWR ARTCC TFR and VOR radial references highlight on hover and focus', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.install({ time: new Date(znyRegion.feed.checkedAt) });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(navaids => Object.assign(window, { notamFixtureNavigation: { navaids }, notamFixtureAirport: {
    faaId: 'EWR', icaoId: 'KEWR', country: 'US', responsibleArtcc: 'ZNY',
  } }), znyNavaids);
  await page.route('**/api/notams/tfrs', route => route.fulfill({ json: znyTfrs }));
  await page.route('**/api/notams/regions?**', route => {
    expect(Object.fromEntries(new URL(route.request().url()).searchParams)).toEqual({ artccId: 'ZNY' });
    return route.fulfill({ json: znyRegion });
  });
  await page.goto(`${origin}/test/browser/notams.html?map&region`);
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await page.getByRole('tab', { name: 'ARTCC / FIR', exact: true }).click();
  const entries = page.locator('.airport-notams .notam-entry');
  const newYork = entries.filter({ hasText: 'TFR 5/2811 shown on chart' });
  const baltimore = entries.filter({ hasText: 'TFR 6/7096 shown on chart' });
  await expect(newYork).toHaveAttribute('tabindex', '0');
  await expect(baltimore).toHaveAttribute('tabindex', '0');
  const highlighted = () => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return [...new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-tfr-highlight'] }).map(f => f.id))].sort();
  });
  const camera = () => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return { center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing() };
  });
  await page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    map.jumpTo({ center: [-73.94, 40.75], zoom: 11 });
    const source = map.getSource('notam-tfrs') as GeoJSONSource, setData = source.setData.bind(source);
    const audit = { writes: 0 }; Object.assign(window, { notamHighlightAudit: audit });
    source.setData = (...args: Parameters<typeof setData>) => { audit.writes++; return setData(...args); };
  });
  const beforeNewYork = await camera();
  await newYork.hover(); await expect.poll(highlighted).toEqual(['5/2811:24623']);
  expect(await camera()).toEqual(beforeNewYork);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('kewr-new-york-tfr-highlight.png') });
  await page.getByRole('tab', { name: 'ARTCC / FIR', exact: true }).hover();
  await expect.poll(highlighted).toEqual([]);
  await page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    map.jumpTo({ center: [-76.3, 39.24], zoom: 8 });
  });
  const beforeBaltimore = await camera();
  await baltimore.focus(); await expect.poll(highlighted).toEqual(['6/7096:404', '6/7096:406']);
  await baltimore.getByText('Show raw', { exact: true }).focus();
  await expect.poll(highlighted).toEqual(['6/7096:404', '6/7096:406']);
  expect(await camera()).toEqual(beforeBaltimore);
  expect(await page.evaluate(() => (window as unknown as { notamHighlightAudit: { writes: number } }).notamHighlightAudit.writes)).toBe(0);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search' }).fill('HTO');
  await expect(entries).toHaveCount(1); await expect.poll(highlighted).toEqual([]);
  await page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    map.jumpTo({ center: [-72.25, 40.92], zoom: 10 });
  });
  const radial = entries.first(), beforeRadial = await camera();
  await expect(radial).toHaveAttribute('tabindex', '0');
  await expect(radial.locator('.notam-readable')).toContainText(/R-236 unusable/i);
  await radial.hover();
  const radialDirections = () => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return map.queryRenderedFeatures(undefined, { layers: ['notam-highlight-radial'] }).map(f => f.properties.bearing);
  });
  await expect.poll(radialDirections).toHaveLength(1);
  expect((await radialDirections())[0]).toBeCloseTo(223, 6);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('kewr-hto-radial-highlight.png') });
  expect(await camera()).toEqual(beforeRadial);
  await page.getByRole('tab', { name: 'ARTCC / FIR', exact: true }).hover();
  await expect.poll(radialDirections).toHaveLength(0);
  await radial.focus(); await expect.poll(radialDirections).toHaveLength(1);
  await page.getByRole('searchbox', { name: 'Search' }).fill('');
  await expect.poll(radialDirections).toHaveLength(0);
  await newYork.focus();
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return map.getFilter('notam-tfr-highlight');
  })).toEqual(['==', ['get', 'noticeId'], '5/2811']);
  await page.getByRole('button', { name: 'Detach NOTAM chart', exact: true }).click();
  await expect(entries.locator('.notam-chart-note')).toHaveCount(0);
  await expect(entries.locator('.notam-readable')).toHaveCount(3);
  await expect(entries.locator(':scope[tabindex="0"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Attach NOTAM chart', exact: true }).click();
  await expect(newYork).toHaveAttribute('tabindex', '0');
  await page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    map.jumpTo({ center: [-76.3, 39.24], zoom: 8 });
  });
  await baltimore.focus(); await expect.poll(highlighted).toEqual(['6/7096:404', '6/7096:406']);
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  await expect.poll(highlighted).toEqual([]);
  expect(errors).toEqual([]);
});

test('regional named-center and VOR radial areas reach the renderer and retain their published reference wording', async ({ page }, testInfo) => {
  const now = Date.now();
  const records = [
    'AIRSPACE PJE WI AN AREA DEFINED AS .15NM RADIUS OF TST SFC-6500FT',
    'AIRSPACE UAS WI AN AREA DEFINED AS .15NM RADIUS OF TST090000.3 SFC-400FT AGL',
    'AIRSPACE UAS WI AN AREA DEFINED AS TST000000.4 TO TST120000.4 TO TST240000.4 TO POINT OF ORIGIN SFC-200FT AGL',
  ].map((text, i) => notice({ id: `175760000000007${i}`, sourceId: `NMS_ID_175760000000007${i}`, text,
    translations: [{ type: 'LOCAL_FORMAT', text }], startsAt: now - 1000, endsAt: now + 86_400_000 }));
  await page.addInitScript(() => {
    const collection = (layer: string, properties: object, coordinates: number[]) => ({ type: 'FeatureCollection',
      features: [{ type: 'Feature', id: layer + ':TST', geometry: { type: 'Point', coordinates }, properties }],
      meta: { layer, revision: '2026-10-01', returned: 1, truncated: false } });
    Object.assign(window, { notamFixtureNavigation: {
      airports: collection('airports', { kind: 'airport', faaId: 'TST', icaoId: 'KTST' }, [-122.025, 37.004]),
      navaids: collection('navaids', { kind: 'navaid', ident: 'TST', type: 'VOR/DME', stationDeclinationDeg: 10,
        status: 'OPERATIONAL IFR' }, [-122.012, 37.004]),
    } });
  });
  await page.route('**/api/notams/regions?**', route => route.fulfill({ json: {
    ...notamSnapshot(records), query: { artccId: 'ZOA', firId: 'KZOA' }, scope: 'region-location', associationCoverage: 'incomplete',
  } }));
  await page.goto(`${origin}/test/browser/notams.html?map&region`);
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await page.getByRole('tab', { name: 'ARTCC / FIR', exact: true }).click();
  await expect(page.locator('.airport-notams .notam-entry--charted')).toHaveCount(3);
  await expect(page.getByText('Area shown on chart', { exact: true })).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    return new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-area-fill'] }).map(f => f.id)).size;
  })).toBe(3);
  for (const reference of ['TST090000.3', 'TST120000.4']) {
    await expect(page.locator('.airport-notams .notam-readable').filter({ hasText: reference })).toHaveCount(1);
  }
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('notam-reference-areas.png') });
  await page.getByRole('button', { name: 'Detach NOTAM chart', exact: true }).click();
  await expect(page.getByText('Area shown on chart', { exact: true })).toHaveCount(0);
  await expect(page.locator('.airport-notams .notam-readable').filter({ hasText: 'TST090000.3' })).toHaveCount(1);
});
test('detailed tags distinguish closures, outages and procedure notes in both themes on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.route('**/api/notams/airports?**', route => {
    const now = Date.now(), records: NotamRecord[] = detailedNotices().map(record => ({ ...record, startsAt: now - 1000, endsAt: now + 86_400_000 }));
    records.push(notice({ id: '1757600000000019', sourceId: 'NMS_ID_1757600000000019', text: 'RWY 09L/27R CLSD', startsAt: now - 1000, endsAt: now + 86_400_000 }));
    records.push(notice({ id: '1757600000000020', sourceId: 'NMS_ID_1757600000000020', classification: 'FDC',
      text: 'IAP TEST, CA. ILS OR LOC RWY 09, AMDT 1... RNAV (GPS) RWY 09, AMDT 2... LNAV MDA 600/HAT 400, VIS CAT C 1 1/2.',
      startsAt: now - 1000, endsAt: now + 86_400_000 }));
    const snapshot = notamSnapshot(records); snapshot.feed.checkedAt = snapshot.feed.watermark = now;
    return route.fulfill({ json: snapshot });
  });
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await expect(page.getByText('7 of 7 retained notices')).toBeVisible();
  await expect(page.getByText('RWY 12R/30L · Closure Restriction', { exact: true })).toContainClass('notam-flair--caution');
  const procedure = page.locator('.notam-entry').filter({ hasText: 'RNAV (RNP) Z RWY 30L' });
  await expect(procedure.locator('.notam-flairs')).toContainText('Minima Amended');
  await expect(procedure.locator('.notam-flairs')).toContainText('Visibility Amended');
  await expect(procedure.locator('.notam-flairs')).not.toContainText('RNAV (RNP) Z RWY 30L');
  await expect(procedure.locator('.notam-flairs')).not.toContainText('Inoperative Lighting Note');
  await expect(procedure.locator('.notam-readable')).toContainText('For inoperative ALS');
  await expect(procedure.locator('.notam-flairs')).not.toContainText(/unavailable/i);
  const multiple = page.locator('.notam-entry').filter({ has: page.getByText('Multiple Approaches', { exact: true }) });
  await expect(multiple.locator('.notam-flairs > span')).toHaveText(['Multiple Approaches', 'Minima Amended', 'Visibility Amended']);
  await expect(multiple.locator('.notam-readable')).toContainText('ILS OR LOC RWY 09');
  await expect(multiple.locator('.notam-readable')).toContainText('RNAV (GPS) RWY 09');
  await procedure.getByText('Show raw', { exact: true }).click();
  await expect(procedure.locator('.notam-raw[open] pre').first()).toHaveText(detailedNotices()[0]!.translations[0]!.text);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const colors = [];
    for (const label of ['Approach', 'Minima Amended', 'RWY 09L/27R · Closed']) {
      const color = await page.locator('.notam-flairs').getByText(label, { exact: true }).first().evaluate(element => {
        const style = getComputedStyle(element);
        return { text: style.color, background: style.backgroundColor };
      });
      expect(contrast(color.text, color.background), `${theme}: ${label}`).toBeGreaterThanOrEqual(4.5);
      colors.push(color.background);
    }
    expect(new Set(colors).size).toBe(3);
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
  await expect(page.getByText('Related to this plate', { exact: true })).toBeVisible();
  await expect(page.getByText(/Show remaining airport NOTAMs/)).toHaveCount(0);
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
for (const width of [393, 1280]) test(`plate remainder keeps each notice accessible once at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const now = Date.now(), related = approachAmendmentNotice();
  const records = [related,
    { ...related, id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002',
      text: related.text.replace('AMDT 2', 'AMDT 99'), translations: [] },
    notice({ id: '1757600000000003', sourceId: 'NMS_ID_1757600000000003', text: 'TWY B CLSD',
      translations: [{ type: 'LOCAL_FORMAT', text: '!TST 10/003 TST TWY B CLSD 2610041159-2710042359' }] }),
  ].map(record => ({ ...record, startsAt: now - 60_000, endsAt: now + 86_400_000 }));
  await page.route('**/api/notams/airports?**', route => route.fulfill({ json: notamSnapshot(records) }));
  await page.getByRole('button', { name: 'Open saved plate', exact: true }).click();
  await page.getByRole('button', { name: /NOTAM · 2 matched · 1 review/ }).click();
  const plate = page.getByRole('region', { name: 'Notices for displayed plate', exact: true });
  await expect(plate.getByRole('heading', { level: 4 })).toHaveText(['Related to this plate', 'Review applicability']);
  await expect(plate.locator('.notam-entry')).toHaveCount(2);
  const summary = page.getByText('Show remaining airport NOTAMs (1)', { exact: true });
  await summary.click();
  const remainder = plate.locator('details').filter({ has: summary });
  await expect(remainder.locator('.notam-entry')).toHaveCount(1);
  await expect(plate.locator('.notam-entry')).toHaveCount(3);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const foreground = await plate.evaluate(element => getComputedStyle(element).color);
    await expect(remainder.locator('.notam-entry-heading > strong')).toHaveCSS('color', foreground);
    await expect(remainder.locator('.notam-readable')).toHaveCSS('color', foreground);
  }
  await remainder.getByText('Show raw', { exact: true }).click();
  await expect(remainder.locator('pre')).toHaveText(records[2]!.translations[0]!.text);
  await page.locator('.procedure-viewer').screenshot({ animations: 'disabled', path: testInfo.outputPath('remaining-notams.png') });
  await summary.click();
  await expect(plate.locator('.notam-entry')).toHaveCount(2);
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
  await expect(page.getByRole('button', { name: 'Refresh NOTAMs' })).toHaveCount(0);
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
    await expect(page.getByText('Related to this plate', { exact: true })).toBeVisible();
    await expect(canvas).toHaveAttribute('data-notam-pdf-marker', 'same');
    expect(requests).toBeGreaterThanOrEqual(2);
  });
}

async function containedText(region: Locator) {
  const overflow = await region.evaluate(root => [...root.querySelectorAll<HTMLElement>('*'), root].filter(element =>
    element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 &&
    !element.matches('input, select'))
    .map(element => `${element.tagName}.${element.className}`));
  expect(overflow).toEqual([]);
}

test.describe('NOTAM reading layout', () => {
  test.use({ hasTouch: true });
  for (const width of [320, 1280]) test(`expanded publisher formats retain units, scopes and conditions at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const names = ['explicit-units', 'newline-minima', 'conditional-rvr', 'short-climb-stage', 'escaped-airport'];
    const records = names.map((name, i) => notice({ id: `175760000000009${i}`, sourceId: `NMS_ID_175760000000009${i}`,
      classification: 'FDC', text: formats.cases.find(c => c.name === name)!.record.text, translations: [],
      startsAt: Date.now() - 1000, endsAt: Date.now() + 86400_000 }));
    await page.route('**/api/notams/airports?**', route => route.fulfill({ json: notamSnapshot(records) }));
    await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
    const airport = page.locator('.airport-notams'), entries = airport.locator('.notam-entry');
    await expect(entries).toHaveCount(5);
    const units = entries.filter({ hasText: '396FT' }).locator('.notam-minima').first();
    await expect(units.locator('dt')).toHaveText(['DA', 'HAT', 'Vis']);
    await expect(units.locator('dd')).toHaveText(['396FT', '388FT', '1-1/8SM']);
    const grouped = entries.filter({ hasText: 'RNAV (GPS) Y RWY 6R' }).locator('.notam-minima');
    await expect(grouped).toHaveCount(2);
    await expect(grouped.first().locator('dd')).toHaveText(['474', '358', '3000']);
    await expect(grouped.last().locator('dd')).toHaveText(['580', '464', '5000']);
    await expect(grouped.last()).toContainText('CAT C/D');
    const conditional = entries.filter({ hasText: 'S-ILS 25L CAT II' });
    await expect(conditional.locator('.notam-minima dd')).toHaveText(['1200']);
    await expect(conditional.locator('.notam-readable')).toContainText('RVR 1000 authorized with specific OPSPEC');
    await expect(entries.locator('.notam-climb')).toHaveText(['Minimum climb: 500 ft/NM to 680', 'Then minimum climb: 280 ft/NM to 6300']);
    const escaped = entries.filter({ hasText: "O'Hare" });
    await expect(escaped).toHaveCount(1);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await containedText(airport);
      await units.screenshot({ animations: 'disabled', path: testInfo.outputPath(`explicit-units-${theme}.png`) });
    }
    await escaped.getByText('Show raw', { exact: true }).click();
    await expect(escaped.locator('.notam-raw pre')).toContainText('O&apos;HARE');
  });
  for (const width of [320, 1440]) test(`aircraft scopes, staged climbs and RVR fields stay distinct at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({width,height:900});
    const names=['aircraft-specific-takeoff','staged-climb','unsupported-visibility-order','departure-na-alternative'];
    const records=names.map((name,i)=>notice({id:`175760000000008${i}`,sourceId:`NMS_ID_175760000000008${i}`,
      classification:'FDC',text:corpus.cases.find(c=>c.name===name)!.record.text,translations:[],startsAt:Date.now()-1000,endsAt:Date.now()+86400_000}));
    await page.route('**/api/notams/airports?**',route=>route.fulfill({json:notamSnapshot(records)}));
    await page.getByRole('tab',{name:'NOTAM',exact:true}).click();
    const entries=page.locator('.airport-notams .notam-entry');
    await expect(entries).toHaveCount(4);
    const aircraftEntry=entries.filter({has:page.getByText('Jets · Runway 31L/R',{exact:true})});
    const aircraft=aircraftEntry.locator('.notam-takeoff');
    await expect(aircraft.locator('.notam-block-title')).toHaveText(['Jets · Runway 31L/R','Props · Runway 31L/R']);
    await expect(aircraft.nth(0).locator('.notam-climb')).toHaveCount(0);
    await expect(aircraft.nth(1).locator('.notam-climb')).toHaveText('Minimum climb: 235 ft/NM to 1300');
    const stages=entries.filter({has:page.getByText('Runway 8L',{exact:true})}).locator('.notam-takeoff');
    await expect(stages.locator('.notam-climb')).toHaveText(['Minimum climb: 500 ft/NM to 520','Then minimum climb: 391 ft/NM to 1700']);
    await expect(entries.locator('.notam-minima').filter({has:page.getByText('RNP 0.21',{exact:true})}).locator('dd')).toHaveText(['1382','450','RVR 4500']);
    await expect(entries.filter({has:page.getByText('Departure not authorized',{exact:true})}).locator('.notam-takeoff-option')).toHaveText(['300-1','Departure not authorized']);
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
      await containedText(page.locator('.airport-notams'));
      await aircraftEntry.locator('.notam-minima-group').screenshot({path:testInfo.outputPath(`aircraft-${theme}.png`)});
      await stages.screenshot({path:testInfo.outputPath(`stages-${theme}.png`)});
    }
  });
  for (const width of [320, 393, 1440]) test(`captured airport structures retain clear fields at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 852 });
    const names = ['mixed-minima', 'labeled-triplet', 'unavailable-minima', 'departure-both-climbs', 'declared-distances', 'inoperative-note'];
    // Keep the captured bodies exact; use invented transport metadata so layout
    // coverage is independent of expiry and the D/FDC vs Other classification filter.
    const records = names.map((name, i) => notice({ id: `175760000000002${i}`, sourceId: `NMS_ID_175760000000002${i}`,
      classification: 'FDC', text: corpus.cases.find(entry => entry.name === name)!.record.text, translations: [],
      startsAt: Date.now() - 1000, endsAt: Date.now() + 86_400_000 }));
    await page.route('**/api/notams/airports?**', route => route.fulfill({ json: notamSnapshot(records) }));
    await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
    const airport = page.getByRole('tabpanel', { name: 'NOTAM', exact: true }).getByRole('region', { name: 'Airport NOTAMs', exact: true });
    await expect(airport.getByText('6 of 6 retained notices')).toBeVisible();
    await expect(airport.getByText('Not authorized', { exact: true })).toHaveCount(2);
    await expect(airport.locator('.notam-minima-group')).toHaveCount(2);
    const distances = airport.locator('.notam-distances');
    await expect(distances.locator('dt')).toHaveText(['TORA', 'TODA', 'ASDA', 'LDA']);
    await expect(distances.locator('dd')).toHaveText(['6000 FT', '6000 FT', '5750 FT', '5545 FT']);
    const takeoff = airport.locator('.notam-takeoff');
    await expect(takeoff.locator('.notam-climb')).toHaveText(['Minimum climb: 290 ft/NM to 1800', 'Minimum climb: 435 ft/NM to 4000']);
    const triplet = airport.locator('.notam-minima').filter({ has: page.getByText('RNP 0.15', { exact: true }) });
    await expect(triplet.locator('dt')).toHaveText(['DA', 'RVR', 'HAT']);
    await expect(triplet.locator('dd')).toHaveText(['713', '2600', '334']);
    const unavailable = airport.locator('.notam-minima-group').filter({ hasText: 'Not authorized' });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await containedText(airport);
      for (const [name, section] of [['triplet', triplet], ['unavailable', unavailable], ['alternatives', takeoff], ['distances', distances]] as const) {
        await section.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${name}-${theme}.png`) });
      }
    }
    await airport.getByRole('button', { name: 'Filters', exact: true }).click();
    await airport.getByRole('searchbox', { name: 'Search' }).fill('Not authorized');
    await expect(airport.locator('.notam-entry')).toHaveCount(1);
    await page.addStyleTag({ content: '.notam-readable * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }' });
    await containedText(airport);
    await airport.getByText('Show raw', { exact: true }).click();
    await expect(airport.locator('.notam-raw pre').last()).toHaveText(records[2]!.text);
  });
  for (const width of [320, 393, 1440]) test(`approach content keeps its typography and conditions in both hosts at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 852 });
    const record = approachAmendmentNotice();
    await page.route('**/api/notams/airports?**', route => {
      const snapshot = notamSnapshot([record]);
      snapshot.feed.environment = 'production';
      snapshot.feed.checkedAt = snapshot.feed.watermark = Date.now();
      return route.fulfill({ json: snapshot });
    });
    await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
    const airport = page.getByRole('tabpanel', { name: 'NOTAM', exact: true }).getByRole('region', { name: 'Airport NOTAMs', exact: true });
    await expect(airport.locator('.notam-minima')).toHaveCount(3);
    const minimumTypography = (root: Locator) => root.locator('.notam-minimum-row').first().evaluate(row =>
      ['dt', 'dd', 'dl', 'dl > div'].map(selector => {
        const style = getComputedStyle(row.querySelector(selector)!);
        return { font: style.font, spacing: style.letterSpacing, transform: style.textTransform, padding: style.padding, border: style.borderWidth };
      }));
    const airportTypography = await minimumTypography(airport);
    const lnav = airport.locator('.notam-minima').filter({ has: page.getByText('LNAV', { exact: true }) });
    await expect(lnav.locator('.notam-minimum-row').first()).toContainText('MDA880HAT460All categories');
    await expect(lnav.locator('.notam-minimum-row').last()).toContainText('Vis1 1/4CAT C/D');
    await expect(lnav.locator('abbr')).toHaveAttribute('title', 'Visibility');
    await expect(airport.locator('.notam-instruction').filter({ hasText: 'Replace note' })).toContainText('For inoperative MALSR');
    await expect(airport.locator('.notam-instruction').filter({ hasText: 'Disregard note' })).toContainText('RVR 1800 authorized with use of FD or AP or HUD to DA.');
    const missedText = 'Climb to 520, then climbing right turn to 2000 direct WHITE and on track 015 to CROSS and hold.';
    const missed = airport.locator('.notam-instruction').filter({ hasText: 'Missed approach' });
    await expect(missed).toContainText(missedText);
    await expect(airport.locator('.notam-readable')).toContainText('Temporary crane 640 MSL 4200FT east of RWY 09L.');
    await page.evaluate(() => document.fonts.ready);
    const compactValues = async (root: Locator) => {
      const rows = root.locator('.notam-minima').first().locator('.notam-minimum-row');
      const altitude = (await rows.first().locator('dd').first().boundingBox())!;
      const visibility = (await rows.last().locator('dd').first().boundingBox())!;
      expect(Math.abs(altitude.y - visibility.y)).toBeLessThan(1);
      expect(visibility.x).toBeGreaterThan(altitude.x + altitude.width);
      for (const field of await rows.locator('dl > div').all()) {
        const label = (await field.locator('dt').boundingBox())!, value = (await field.locator('dd').boundingBox())!;
        expect(Math.abs(label.y + label.height - value.y - value.height)).toBeLessThan(2);
      }
    };
    await compactValues(airport);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await containedText(airport);
      await airport.locator('.notam-body-title').scrollIntoViewIfNeeded();
      await page.locator('.feature-card').screenshot({ animations: 'disabled', path: testInfo.outputPath(`airport-${theme}.png`) });
      await lnav.screenshot({ animations: 'disabled', path: testInfo.outputPath(`approach-minima-${theme}.png`) });
      await airport.locator('.notam-minima').first().screenshot({ animations: 'disabled', path: testInfo.outputPath(`approach-da-${theme}.png`) });
      await airport.locator('.notam-instruction').first().screenshot({ animations: 'disabled', path: testInfo.outputPath(`approach-note-${theme}.png`) });
      await missed.screenshot({ animations: 'disabled', path: testInfo.outputPath(`missed-approach-${theme}.png`) });
    }
    await airport.getByText('Show raw', { exact: true }).click();
    await expect(airport.locator('.notam-raw[open] pre')).toHaveText([record.translations[0]!.text]);
    await expect(airport.getByText('Original NOTAM', { exact: true })).toBeVisible();
    await expect(airport.getByText('Source body', { exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Plates', exact: true }).click();
    await page.getByRole('button', { name: /RNAV \(GPS\) Y RWY 09L/ }).click();
    const canvas = page.getByLabel('PDF page 1');
    await expect(canvas).toBeVisible();
    await page.getByRole('button', { name: /NOTAM · 1 matched/ }).click();
    const plate = page.getByRole('region', { name: 'Notices for displayed plate', exact: true });
    await expect(plate.locator('.notam-minima')).toHaveCount(3);
    expect(await minimumTypography(plate)).toEqual(airportTypography);
    await compactValues(plate);
    await expect(plate.getByText('Replace note', { exact: true })).toBeVisible();
    await expect(plate.locator('.notam-instruction').filter({ hasText: 'Missed approach' })).toContainText(missedText);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await containedText(plate);
      await plate.locator('.notam-minima').first().scrollIntoViewIfNeeded();
      await page.locator('.procedure-viewer').screenshot({ animations: 'disabled', path: testInfo.outputPath(`plate-${theme}.png`) });
    }
    await page.addStyleTag({ content: `.notam-readable * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
      .notam-readable p { margin-bottom: 2em !important; }` });
    await containedText(plate);
    expect((await page.locator('.procedure-page-stage').boundingBox())!.height).toBeGreaterThan(40);
    await page.getByRole('button', { name: /NOTAM · 1 matched/ }).click();
    await expect(canvas).toBeVisible();
  });
  for (const width of [393, 320, 1440]) test(`departure minimums keep runway alternatives readable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 852 });
    const record = departureNotice();
    await page.route('**/api/notams/airports?**', route => {
      const snapshot = notamSnapshot([record]);
      snapshot.feed.environment = 'production';
      snapshot.feed.checkedAt = snapshot.feed.watermark = Date.now();
      return route.fulfill({ json: snapshot });
    });
    await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
    const airport = page.getByRole('tabpanel', { name: 'NOTAM', exact: true }).getByRole('region', { name: 'Airport NOTAMs', exact: true });
    await expect(airport.getByText('1 of 1 retained notices')).toBeVisible();
    await airport.getByRole('button', { name: 'Filters', exact: true }).click();
    const search = airport.getByRole('searchbox', { name: 'Search' });
    await search.fill('Runway 13');
    await expect(airport.locator('.notam-entry')).toHaveCount(1);
    const readable = airport.locator('.notam-readable');
    await expect(readable).toContainText('Takeoff minimums & obstacle departure procedures');
    const runways = readable.locator('.notam-takeoff');
    await expect(runways).toHaveCount(2);
    for (const [i, runway, gradient, altitude] of [[0, '13', '412', '3500'], [1, '31', '210', '2300']] as const) {
      await expect(runways.nth(i)).toContainText(`Runway ${runway}`);
      await expect(runways.nth(i)).toContainText(`Minimum climb: ${gradient} ft/NM to ${altitude}`);
      await expect(runways.nth(i).locator('.notam-alternative')).toHaveText('or');
      await expect(runways.nth(i).locator('.notam-takeoff-option').last()).toContainText('3100-3For climb in visual conditions');
    }
    await expect(readable).not.toContainText('2610041159-2710042359EST');
    await expect(airport.locator('.notam-validity')).toContainText('(estimated)');
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await containedText(airport);
      await readable.screenshot({ animations: 'disabled', path: testInfo.outputPath(`departure-${theme}.png`) });
      await runways.first().screenshot({ animations: 'disabled', path: testInfo.outputPath(`runway-${theme}.png`) });
    }
    await page.addStyleTag({ content: `.notam-readable * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
      .notam-readable p { margin-bottom: 2em !important; }` });
    await containedText(airport);
    await airport.getByText('Show raw', { exact: true }).click();
    await expect(airport.locator('.notam-raw[open] pre')).toHaveText([record.translations[0]!.text]);
    await expect(airport.getByText('Original NOTAM', { exact: true })).toBeVisible();
    await expect(airport.getByText('Source body', { exact: true })).toHaveCount(0);
    await containedText(airport);
  });
  test('loading, failed, empty and unavailable views retain readable status and recovery controls', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 740 });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let failing = true;
    await page.route('**/api/notams/airports?**', async route => {
      await pending;
      if (failing) return route.fulfill({ status: 503, body: 'Unavailable' });
      const now = Date.now(), query = Object.fromEntries(new URL(route.request().url()).searchParams);
      const snapshot = notamSnapshot([], { query });
      snapshot.feed.environment = 'production';
      snapshot.feed.checkedAt = snapshot.feed.watermark = now;
      return route.fulfill({ json: snapshot });
    });
    await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
    const airport = page.getByRole('tabpanel', { name: 'NOTAM', exact: true }).getByRole('region', { name: 'Airport NOTAMs', exact: true });
    await expect(airport.getByText('Loading NOTAMs…', { exact: true })).toBeVisible();
    await expect(airport.getByRole('button', { name: 'Refresh NOTAMs' })).toHaveCount(0);
    await containedText(airport);
    release();
    await expect(airport.getByRole('status')).toContainText('Unable to refresh NOTAMs');
    await containedText(airport);
    await page.locator('.feature-card').screenshot({ animations: 'disabled', path: testInfo.outputPath('airport-error.png') });
    failing = false;
    await page.getByRole('tab', { name: 'Info', exact: true }).click();
    await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
    await expect(airport.getByText('No retained notices.', { exact: true })).toBeVisible();
    const airportStatusFont = await airport.locator('.notam-list-status').first().evaluate(element => getComputedStyle(element).font);
    await page.getByRole('tab', { name: 'Plates', exact: true }).click();
    await page.getByRole('button', { name: /RNAV \(GPS\) Y RWY 09L/ }).click();
    await expect(page.getByLabel('PDF page 1')).toBeVisible();
    await page.getByRole('button', { name: /NOTAM · 0 matched/ }).click();
    const plate = page.getByRole('region', { name: 'Notices for displayed plate', exact: true });
    const empty = plate.getByText('No retained airport NOTAMs.', { exact: true });
    await expect(empty).toBeVisible();
    expect(await empty.evaluate(element => getComputedStyle(element).font)).toBe(airportStatusFont);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await containedText(plate);
      const colors = await empty.evaluate(element => ({ text: getComputedStyle(element).color,
        background: getComputedStyle(element.closest('.plate-notams')!).backgroundColor }));
      expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
      await page.locator('.procedure-viewer').screenshot({ animations: 'disabled', path: testInfo.outputPath(`plate-empty-${theme}.png`) });
    }
    await page.getByRole('button', { name: /Choose PDF page/ }).click();
    await page.getByRole('button', { name: 'Next PDF page' }).click();
    await expect(page.getByLabel('PDF page 2')).toBeVisible();
    await page.getByRole('button', { name: /Choose PDF page/ }).click();
    await page.getByRole('button', { name: 'Next PDF page' }).click();
    await page.getByRole('button', { name: 'NOTAM · Matching unavailable' }).click();
    await expect(plate.getByText(/This page’s airport and procedure could not be established/)).toBeVisible();
    await containedText(plate);
    await page.locator('.procedure-viewer').screenshot({ animations: 'disabled', path: testInfo.outputPath('plate-unavailable.png') });
  });
  for (const [width, height, spaced] of [[1280, 900, false], [320, 740, true], [640, 450, true]] as const) {
    test(`long notices and raw disclosures remain readable at ${width}×${height}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      const raw = `RWY 09L RWY END ID LGT U/S\nREFERENCE ${'SOURCE_REFERENCE_'.repeat(12)}`;
      await page.route('**/api/notams/airports?**', route => {
        const now = Date.now();
        const records = [
          notice({ number: '1'.repeat(64), startsAt: now - 1000, endsAt: now + 86_400_000,
            text: raw, translations: [{ type: 'SOURCE_TRANSLATION_'.repeat(3), text: raw }] }),
          notice({ id: '1757600000000002', sourceId: 'NMS_ID_1757600000000002', startsAt: now - 1000, endsAt: now + 86_400_000, schedule: 'SR-SS' }),
          notice({ id: '1757600000000003', sourceId: 'NMS_ID_1757600000000003', classification: 'FDC', startsAt: now + 3_600_000, endsAt: now + 86_400_000,
            // Put the independent numerical clause before the exception; the
            // conservative parser does not infer where a later condition ends.
            text: 'IAP TEST AIRPORT, CA.\nRNAV (GPS) Y RWY 09L, AMDT 99...\n' +
              'TAKE-OFF MINIMUMS RWY 09L, STANDARD WITH MINIMUM CLIMB OF 412 FT/NM TO 3500, OR 3100-3 FOR CLIMB IN VISUAL CONDITIONS.\nCIRCLING NA EXC CAT A.' }),
        ];
        const snapshot = notamSnapshot(records);
        snapshot.feed.checkedAt = snapshot.feed.watermark = now;
        snapshot.feed.environment = 'production';
        snapshot.feed.continuity = 'incomplete';
        return route.fulfill({ json: snapshot });
      });
      if (spaced) await page.addStyleTag({ content: `
        .airport-notams *, .plate-notams *, .plate-notam-count {
          line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important;
        }
        .airport-notams p, .plate-notams p { margin-bottom: 2em !important; }
      ` });
      await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
      const airport = page.getByRole('tabpanel', { name: 'NOTAM', exact: true }).getByRole('region', { name: 'Airport NOTAMs', exact: true });
      await expect(airport.getByText('3 of 3 retained notices')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.fonts.check('700 14px B612'))).toBe(true);
      await expect(airport.getByRole('heading', { level: 3 })).toHaveText(['Active 1', 'Check timing 1', 'Upcoming 1']);
      const summary = airport.getByText('Show raw', { exact: true }).first();
      await page.getByRole('tablist', { name: 'NOTAM area', exact: true }).getByRole('tab', { name: 'Airport', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(page.locator('.feature-card-content')).toBeFocused();
      await page.keyboard.press('Tab');
      const filters = airport.getByRole('button', { name: 'Filters', exact: true });
      await expect(filters).toBeFocused();
      await page.keyboard.press('Enter');
      const search = airport.getByRole('searchbox', { name: 'Search' });
      await search.focus();
      await page.keyboard.press('Tab');
      await expect(summary).toBeFocused();
      await summary.press('Enter');
      await expect(airport.locator('.notam-raw[open] pre').first()).toHaveText(raw);
      const target = (await summary.boundingBox())!;
      expect(target.height).toBeGreaterThanOrEqual(44 - .001);
      expect(await summary.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await containedText(airport);
        await page.locator('.feature-card').screenshot({ animations: 'disabled', path: testInfo.outputPath(`airport-${theme}.png`) });
      }
      await page.getByRole('tab', { name: 'Plates', exact: true }).click();
      const row = page.getByRole('button', { name: /RNAV \(GPS\) Y RWY 09L/ });
      await expect(row.locator('.plate-notam-count')).toHaveText('NOTAM · 3 matched · 1 review · Coverage incomplete');
      await containedText(row);
      await row.click();
      const canvas = page.getByLabel('PDF page 1');
      await expect(canvas).toBeVisible();
      await canvas.evaluate(element => element.setAttribute('data-layout-marker', 'retained'));
      const toggle = page.getByRole('button', { name: /NOTAM · 3 matched/ });
      await toggle.click();
      const plate = page.getByRole('region', { name: 'Notices for displayed plate', exact: true });
      await expect(plate.getByRole('heading', { level: 3 })).toHaveText(['Active 1', 'Check timing 1', 'Upcoming 1']);
      await expect(plate.locator('.notam-takeoff')).toContainText('412 ft/NM');
      await expect(plate.locator('.notam-takeoff')).toContainText('For climb in visual conditions');
      await expect(plate.getByRole('button', { name: 'Refresh NOTAMs' })).toHaveCount(0);
      const plateSourceBox = (await plate.locator('.notam-source').boundingBox())!;
      const activeBox = (await plate.getByRole('heading', { name: 'Active 1', exact: true }).boundingBox())!;
      expect(activeBox.y - plateSourceBox.y - plateSourceBox.height).toBeGreaterThanOrEqual(8);
      await plate.getByText('Show raw', { exact: true }).first().focus();
      await plate.getByText('Show raw', { exact: true }).first().press('Enter');
      await expect(plate.locator('.notam-raw[open] pre').first()).toHaveText(raw);
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await containedText(plate);
        await page.locator('.procedure-viewer').screenshot({ animations: 'disabled', path: testInfo.outputPath(`plate-${theme}.png`) });
      }
      expect((await page.locator('.procedure-page-stage').boundingBox())!.height).toBeGreaterThan(40);
      await page.getByRole('button', { name: 'Enter full screen' }).click();
      await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
      await containedText(plate);
      await page.getByRole('button', { name: 'Exit full screen' }).click();
      await toggle.click();
      await expect(plate).toHaveCount(0);
      await expect(canvas).toHaveAttribute('data-layout-marker', 'retained');
    });
  }
});

for (const width of [393, 1280]) test(`plate counts stay compact while exposing stale data and refresh failures at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const now = Date.now(); let failed = false, fresh = false;
  await page.clock.install({ time: now });
  await page.route('**/api/notams/airports?**', route => {
    if (failed) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    const snapshot = notamSnapshot([notice({ text: 'NAV ILS U/S', startsAt: now - 60_000, endsAt: now + 86_400_000 })], { query });
    snapshot.feed = { ...snapshot.feed, environment: 'production', checkedAt: fresh ? Date.now() : now - 600_000 };
    return route.fulfill({ json: snapshot });
  });
  await page.reload();
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  const row = page.getByRole('button', { name: /RNAV \(GPS\) Y RWY 09L/ }).locator('.plate-notam-count');
  await expect(row).toHaveText('NOTAM · 0 matched · Stale');
  await page.getByRole('button', { name: 'Open saved plate', exact: true }).click();
  const toggle = page.locator('.plate-notam-toggle');
  await expect(toggle).toContainText('NOTAM · 0 matched · Stale');
  await toggle.click();
  const plate = page.getByRole('region', { name: 'Notices for displayed plate', exact: true });
  await plate.getByText('Show remaining airport NOTAMs (1)', { exact: true }).click();
  await expect(plate.getByText('ILS Unavailable', { exact: true })).toBeVisible();
  await expect(plate.getByText(/Matching is incomplete/)).toBeVisible();
  failed = true;
  await page.clock.fastForward(3 * 60_000);
  await expect(toggle).toContainText('Refresh failed · Stale');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline'));
  });
  await expect(toggle).toContainText('Offline');
  await toggle.click();
  await expect(toggle).toContainText('Offline · Refresh failed · Stale');
  await page.screenshot({ path: testInfo.outputPath('collapsed-uncertainty.png') });
  failed = false; fresh = true;
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online'));
  });
  await expect(toggle).toHaveText('NOTAM · 0 matched▾');
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  await expect(row).toHaveText('NOTAM · 0 matched');
});

test('a matched plate keeps unsupported headings in the expanded view', async ({ page }) => {
  const now = Date.now();
  const record = notice({ classification: 'FDC', text: 'IAP TEST, CA. RNAV (GPS) Y RWY 09L, AMDT 2... SPECIAL ILS RWY 18... PROCEDURES NA.',
    startsAt: now - 60_000, endsAt: now + 86_400_000 });
  await page.route('**/api/notams/airports?**', route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    const snapshot = notamSnapshot([record], { query });
    snapshot.feed = { ...snapshot.feed, environment: 'production', checkedAt: now };
    return route.fulfill({ json: snapshot });
  });
  await page.reload(); await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await expect(page.getByRole('button', { name: /RNAV \(GPS\) Y RWY 09L/ }).locator('.plate-notam-count'))
    .toHaveText('NOTAM · 1 matched');
  await page.getByRole('button', { name: 'Open saved plate', exact: true }).click();
  await expect(page.locator('.plate-notam-toggle')).toContainText('1 matched');
  await page.locator('.plate-notam-toggle').click();
  await expect(page.getByRole('region', { name: 'Notices for displayed plate', exact: true }).getByText(/Matching is incomplete/)).toBeVisible();
});

for (const width of [393, 1280]) test(`TFR source review includes retained, unknown and unmappable details at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const now = Date.now(), startsAt = now - 3600_000, endsAt = now + 86_400_000;
  const retained = { id: '6/9000', modifiedAt: startsAt, detailCheckedAt: startsAt, title: 'Retained fixture boundary', type: 'HAZARDS', facility: 'TST', state: 'CA',
    startsAt, endsAt, text: 'Original source evidence.', areas: [{ id: 'A', name: 'Area A', lower: 'SFC', upper: '3000 ft MSL',
      geometry: { type: 'Polygon', coordinates: [[[-122.035,37],[-122.025,37],[-122.025,37.01],[-122.035,37.01],[-122.035,37]]] },
      windows: [{ startsAt, endsAt }] }] };
  const unknown = { ...retained, id: '6/9001', detailCheckedAt: now, title: 'Unknown schedule', areas: [{ ...retained.areas[0]!, windows: null }] };
  const unmappable = { ...retained, id: '6/9003', detailCheckedAt: now, title: 'Unmappable source notice',
    text: 'Complete retained raw text for the notice without a drawable boundary.', areas: [{ ...retained.areas[0]!, geometry: null }] };
  const noAreas = { ...unmappable, id: '6/9004', title: 'Notice without published areas', areas: [] };
  const identity = { modifiedAt: now - 1000, title: 'Updated fixture detail', type: 'HAZARDS', facility: 'TST', state: 'CA', reason: 'detail-unavailable' };
  await page.route('**/api/notams/tfrs', route => route.fulfill({ json: { schemaVersion: 1, source: 'FAA-TFR', checkedAt: now,
    notices: [retained, unknown, unmappable, noAreas], error: 'incomplete-details', issues: [
      { ...identity, id: retained.id, retainedCheckedAt: startsAt }, { ...identity, id: '6/9002', retainedCheckedAt: null },
    ] } }));
  await page.goto(`${origin}/test/browser/notams.html?map&tfr-status`);
  await page.getByRole('button', { name: 'Stow fixture', exact: true }).click();
  const footer = page.locator('.notam-tfr-status');
  await expect(footer).not.toContainText('Red:');
  await expect(footer).toContainText('5 need source review');
  await footer.screenshot({ animations: 'disabled', path: testInfo.outputPath('tfr-footer.png') });
  await footer.getByText('5 need source review', { exact: true }).click();
  await expect(footer).toContainText('No retained detail');
  await expect(footer).toContainText('Retained detail');
  await expect(footer.getByRole('link', { name: '6/9002 · Updated fixture detail' })).toHaveAttribute('href', 'https://tfr.faa.gov/tfr3/?page=detail_6_9002');
  for (const record of [unmappable, noAreas]) {
    const entry = footer.locator('section').filter({ has: page.getByRole('link', { name: `${record.id} · ${record.title}`, exact: true }) });
    await expect(entry).toContainText('Boundary unavailable');
    await expect(entry.getByRole('link')).toHaveAttribute('href', `https://tfr.faa.gov/tfr3/?page=detail_${record.id.replace('/', '_')}`);
    await entry.getByText('Show raw', { exact: true }).click();
    await expect(entry.locator('pre')).toBeVisible(); await expect(entry.locator('pre')).toHaveText(record.text);
    expect(await entry.locator('pre').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await footer.locator('..').screenshot({ animations: 'disabled', path: testInfo.outputPath('tfr-source-review.png') });
  await footer.getByText('5 need source review', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit?: { map: MapLibreMap } }).notamMapAudit?.map;
    return map?.getLayer('notam-tfr-fill') ? [...new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-tfr-fill'] }).map(f => f.state.color))] : [];
  })).toEqual(['#ff4d55']);
  const point = await page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit: { map: MapLibreMap } }).notamMapAudit.map;
    map.jumpTo({ center: [-122.03,37.004] });
    const p = map.project([-122.03,37.004]); return { x:p.x,y:p.y };
  });
  await page.mouse.click(point.x, point.y);
  const details = page.getByRole('region', { name: 'TFR details', exact: true });
  await expect(details).toContainText('Red: active or unknown schedule · Yellow: upcoming. Colors follow the saved schedule.');
  await expect(details).toContainText('FAA detail refresh failed. Showing retained detail.');
  await expect(details).toContainText('Check source schedule');
  await expect(details.getByText('Active', { exact: true })).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('tfr-unresolved-details.png') });
});

test('multiple areas and recovered coordinates render with qualifications and activity positions stay points', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const now = Date.now(), texts = [
    'AIRSPACE UAS WI AN AREA DEFINED AS .12NM RADIUS OF 370010N1220010W SFC-300FT AGL AND WI AN AREA DEFINED AS .1NM RADIUS OF 370030N1220030W SFC-400FT AGL',
    'AIRSPACE UAS WI AN AREA DEFINED AS .15NM RADIUS OF 365960N1220100W SFC-200FT AGL',
    'AIRSPACE UNMANNED FREE BALLOON 370010N1220030W (1NM W TST) SFC-FL950 SEB',
  ];
  const records = texts.map((text, i) => notice({ id: `175760000000008${i}`, sourceId: `NMS_ID_175760000000008${i}`, text,
    translations: [{ type: 'LOCAL_FORMAT', text }], startsAt: now - 1000, endsAt: now + 86400000 }));
  await page.route('**/api/notams/airports?**', route => route.fulfill({ json: notamSnapshot(records) }));
  await page.goto(`${origin}/test/browser/notams.html?map`);
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit?: { map: MapLibreMap } }).notamMapAudit?.map;
    return map?.getLayer('notam-area-fill') ? new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-area-fill'] }).map(f => f.id)).size : 0;
  })).toBe(2);
  const entries = page.locator('.airport-notams .notam-entry');
  await expect(entries.nth(0).locator('.notam-readable')).toContainText('SFC-300FT AGL');
  await expect(entries.nth(0).locator('.notam-readable')).toContainText('SFC-400FT AGL');
  await expect(entries.nth(1).locator('.notam-readable')).toContainText('365960N1220100W');
  await expect(entries.nth(1).locator('.notam-chart-note')).toContainText('Coordinate normalized');
  await expect(entries.nth(2).locator('.notam-chart-note')).toContainText('Source position shown');
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit?: { map: MapLibreMap } }).notamMapAudit?.map;
    return map?.getLayer('notam-activity-points') ? map.queryRenderedFeatures(undefined, { layers: ['notam-activity-points'] }).length : 0;
  })).toBeGreaterThan(0);
  await entries.nth(2).hover();
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit?: { map: MapLibreMap } }).notamMapAudit?.map;
    return map?.queryRenderedFeatures(undefined, { layers: ['notam-highlight-point'] }).length ?? 0;
  })).toBeGreaterThan(0);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('notam-recovered-and-multiple.png') });
  expect(errors).toEqual([]);
});
