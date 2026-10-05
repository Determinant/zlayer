import type { NotamRecord, NotamSourceIssue } from '@zlayer/contracts';
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
import type { Map as MapLibreMap } from 'maplibre-gl';

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
  const entries = page.locator('.airport-notams .notam-entry'), crane = entries.first();
  await expect(crane.locator('.notam-chart-note')).toHaveText('Location shown on chart');
  await expect(crane.locator('.notam-readable')).toHaveText('Flagged');
  await expect(entries.nth(1).locator('.notam-readable')).toHaveCount(0);
  await expect(entries.nth(2).locator('.notam-readable')).toContainText('RNAV (GPS) Y');
  await crane.getByText('Show raw', { exact: true }).click();
  await expect(crane.locator('.notam-raw pre').last()).toHaveText(records[0]!.text);
  await crane.getByText('Show raw', { exact: true }).click();
  await page.getByRole('button', { name: 'Detach NOTAM chart', exact: true }).click();
  await expect(crane.locator('.notam-readable')).toContainText('2026-AWP-3090-OE');
  await page.getByRole('button', { name: 'Attach NOTAM chart', exact: true }).click();
  await expect.poll(rendered).toBe(3);
  await expect(crane.locator('.notam-readable')).toHaveText('Flagged');
  await page.screenshot({ path: testInfo.outputPath('notam-obstacles-open.png') });
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
    const records = [-122.03,-122.017,-122.005].map((lon,i) => ({ id: `6/900${i}`, modifiedAt: now-1000,
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
        .map(f=>[f.properties.noticeId,{id:f.properties.noticeId,color:f.properties.color,status:f.properties.status}])).values()].sort((a,b)=>a.id.localeCompare(b.id)) : [];
    });
    const expected = [{id:'6/9000',color:'#ff4d55',status:'active'},{id:'6/9001',color:'#ffd54a',status:'upcoming'},{id:'6/9003',color:'#ff4d55',status:'active'}];
    await expect.poll(displayed).toEqual(expected);
    expect(await page.evaluate(() => (window as unknown as {notamMapAudit:{map:MapLibreMap}}).notamMapAudit.map.getPaintProperty('notam-tfr-fill','fill-pattern'))).toBeUndefined();
    expect(await page.evaluate(() => (window as unknown as {notamMapAudit:{map:MapLibreMap}}).notamMapAudit.map.getStyle().layers
      .filter(layer => layer.id.startsWith('notam-tfr-')).map(layer => layer.type))).toEqual(['fill', 'line']);
    await page.getByRole('tab',{name:'NOTAM',exact:true}).click(); await expect.poll(displayed).toEqual(expected);
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
test('temporary areas replace only mapped location prose and restore it when the chart detaches', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const now = Date.now(), circle = 'AIRSPACE UAS WI AN AREA DEFINED AS .15NM RADIUS OF 370015N1220015W (1NM E TST) SFC-400FT AGL';
  const records = [circle,
    'AIRSPACE UAS WI AN AREA DEFINED AS 370008N1220100W TO 370008N1220030W TO 370030N1220030W TO 370030N1220100W TO POINT OF ORIGIN SFC-200FT AGL',
    'NAV GPS MAY NOT BE AVAILABLE WITHIN A .8NM RADIUS CENTERED AT 370000N1220010W FL250-UNL DECREASING IN AREA WITH A DECREASE IN ALTITUDE DEFINED AS: .4NM RADIUS AT 10000FT, .2NM RADIUS AT 50FT AGL.',
    'AIRSPACE UAS WI AN AREA DEFINED AS .1NM EITHER SIDE OF A LINE FM 370000N1220100W TO 370100N1220100W SFC-400FT AGL',
  ].map((text, i) => notice({ id: `175760000000004${i}`, sourceId: `NMS_ID_175760000000004${i}`, text,
    translations: [{ type: 'LOCAL_FORMAT', text }], startsAt: now - 1000, endsAt: now + 86_400_000 }));
  await page.route('**/api/notams/airports?**', route => route.fulfill({ json: notamSnapshot(records) }));
  await page.goto(`${origin}/test/browser/notams.html?map`);
  const areas = () => page.evaluate(() => {
    const map = (window as unknown as { notamMapAudit?: { map: MapLibreMap } }).notamMapAudit?.map;
    return map?.getLayer('notam-area-fill') ? new Set(map.queryRenderedFeatures(undefined, { layers: ['notam-area-fill'] }).map(f => f.id)).size : 0;
  });
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await expect.poll(areas).toBe(3);
  const entries = page.locator('.airport-notams .notam-entry'), first = entries.first();
  await expect(page.getByText('Area shown on chart', { exact: true })).toHaveCount(2);
  await expect(first.locator('.notam-readable')).not.toContainText('370015N1220015W');
  await expect(first.locator('.notam-readable')).toContainText('SFC-400FT AGL');
  const gps = entries.filter({ hasText: 'NAV GPS' });
  await expect(gps.locator('.notam-chart-note')).toHaveText('Outer area shown on chart · Extent varies with altitude');
  await expect(gps.locator('.notam-readable')).toContainText('.4NM radius at 10000FT');
  await expect(gps.locator('.notam-readable')).toContainText('50FT AGL');
  const corridor = entries.last();
  await expect(corridor.locator('.notam-chart-note')).toHaveCount(0);
  await expect(corridor.locator('.notam-readable')).toContainText('370000N1220100W');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('notam-areas.png') });
  await first.getByText('Show raw', { exact: true }).click();
  await expect(first.locator('.notam-raw pre').last()).toHaveText(circle);
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
test('detailed tags distinguish closures, outages and procedure notes in both themes on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.route('**/api/notams/airports?**', route => {
    const now = Date.now(), records: NotamRecord[] = detailedNotices().map(record => ({ ...record, startsAt: now - 1000, endsAt: now + 86_400_000 }));
    records.push(notice({ id: '1757600000000019', sourceId: 'NMS_ID_1757600000000019', text: 'RWY 09L/27R CLSD', startsAt: now - 1000, endsAt: now + 86_400_000 }));
    const snapshot = notamSnapshot(records); snapshot.feed.checkedAt = snapshot.feed.watermark = now;
    return route.fulfill({ json: snapshot });
  });
  await page.getByRole('tab', { name: 'NOTAM', exact: true }).click();
  await expect(page.getByText('6 of 6 retained notices')).toBeVisible();
  await expect(page.getByText('Runway Closure Restriction', { exact: true })).toHaveClass('notam-flair--caution');
  const procedure = page.locator('.notam-entry').filter({ hasText: 'RNAV (RNP) Z RWY 30L' });
  await expect(procedure.locator('.notam-flairs')).toContainText('Inoperative Lighting Note');
  await expect(procedure.locator('.notam-flairs')).not.toContainText(/unavailable/i);
  await procedure.getByText('Show raw', { exact: true }).click();
  await expect(procedure.locator('.notam-raw[open] pre').first()).toHaveText(detailedNotices()[0]!.translations[0]!.text);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const colors = [];
    for (const label of ['Runway', 'RNAV (RNP) Z RWY 30L', 'Minima Amended', 'Runway Closed']) {
      const color = await page.locator('.notam-flairs').getByText(label, { exact: true }).first().evaluate(element => {
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
  await expect(page.getByRole('button', { name: 'Refresh NOTAMs' })).toBeDisabled();
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

async function containedText(region: Locator) {
  const overflow = await region.evaluate(root => [...root.querySelectorAll<HTMLElement>('*'), root].filter(element =>
    element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1 &&
    !element.matches('input, select'))
    .map(element => `${element.tagName}.${element.className}`));
  expect(overflow).toEqual([]);
}

test.describe('NOTAM reading layout', () => {
  test.use({ hasTouch: true });
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
    await expect(airport.locator('.notam-raw[open] pre').last()).toHaveText(record.text);
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
    await expect(airport.locator('.notam-raw[open] pre').first()).toHaveText(record.translations[0]!.text);
    await expect(airport.locator('.notam-raw[open] pre').last()).toHaveText(record.text);
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
    const refresh = airport.getByRole('button', { name: 'Refresh NOTAMs' });
    await expect(refresh).toBeDisabled();
    await containedText(airport);
    release();
    await expect(airport.getByRole('status')).toContainText('Unable to refresh NOTAMs');
    await expect(refresh).toBeEnabled();
    await containedText(airport);
    await page.locator('.feature-card').screenshot({ animations: 'disabled', path: testInfo.outputPath('airport-error.png') });
    failing = false;
    await refresh.click();
    await expect(airport.getByText('No retained notices.', { exact: true })).toBeVisible();
    await expect(refresh).toBeEnabled();
    const airportStatusFont = await airport.locator('.notam-list-status').first().evaluate(element => getComputedStyle(element).font);
    await page.getByRole('tab', { name: 'Plates', exact: true }).click();
    await page.getByRole('button', { name: /RNAV \(GPS\) Y RWY 09L/ }).click();
    await expect(page.getByLabel('PDF page 1')).toBeVisible();
    await page.getByRole('button', { name: /NOTAM · 0 matched/ }).click();
    const plate = page.getByRole('region', { name: 'Notices for displayed plate', exact: true });
    const empty = plate.getByText('No matches in the retained notices.', { exact: true });
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
      const search = airport.getByRole('searchbox', { name: 'Search' });
      const refresh = airport.getByRole('button', { name: 'Refresh NOTAMs' });
      const searchBox = (await search.boundingBox())!, refreshBox = (await refresh.boundingBox())!;
      expect(refreshBox.x).toBeGreaterThanOrEqual(searchBox.x + searchBox.width);
      expect(Math.abs(refreshBox.y + refreshBox.height - searchBox.y - searchBox.height)).toBeLessThan(1);
      expect(refreshBox.width).toBeGreaterThanOrEqual(44);
      expect(refreshBox.height).toBeGreaterThanOrEqual(44);
      await search.focus();
      await page.keyboard.press('Tab');
      await expect(refresh).toBeFocused();
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
      await expect(row.locator('.plate-notam-count')).toHaveText('NOTAM · 3 matched · Review · Coverage incomplete');
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
      const plateRefreshBox = (await plate.getByRole('button', { name: 'Refresh NOTAMs' }).boundingBox())!;
      const activeBox = (await plate.getByRole('heading', { name: 'Active 1', exact: true }).boundingBox())!;
      expect(activeBox.y - plateRefreshBox.y - plateRefreshBox.height).toBeGreaterThanOrEqual(8);
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
