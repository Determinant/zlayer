import { test, expect } from '@playwright/test';
import { WEATHER_NOW } from '../fixtures/awc-advisories';
import { pirepFixture } from '../fixtures/pireps';
import type { GeoJSONSource } from 'maplibre-gl';

const LAYER = 'weather-awc-pirep-circles';
test.beforeEach(async ({ request, page }) => {
  await request.post('/__test/reset'); await page.clock.install({ time: WEATHER_NOW });
  await page.route('**/api/weather/pireps.json', route => route.fulfill({ json: pirepFixture() }));
});

test('PIREPs render, follow the viewport and world copy, survive style recovery, and expire', async ({ page }) => {
  await page.goto('/test/browser/weather-progs.html');
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.loaded())).toBe(true);
  await page.evaluate(() => window.progsMapAudit.change({ awcPireps: true, awcProgs: false }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepView.length)).toBe(24);
  await expect.poll(() => page.evaluate(layer => window.progsMapAudit.map.queryRenderedFeatures(undefined, { layers: [layer] }).length, LAYER)).toBe(24);
  await page.evaluate(() => window.progsMapAudit.map.jumpTo({ center: [238, 37.3], bearing: 35 }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepView.length)).toBe(24);
  await page.evaluate(() => window.progsMapAudit.map.jumpTo({ center: [-90, 40] }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepView.length)).toBe(0);
  await page.evaluate(() => { window.progsMapAudit.map.jumpTo({ center: [-122, 37.3] }); window.progsMapAudit.recover(); });
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepView.length)).toBe(24);
  await expect.poll(() => page.evaluate(layer => window.progsMapAudit.map.getLayoutProperty(layer, 'visibility'), LAYER)).toBe('visible');
  await page.evaluate(() => window.progsMapAudit.change({ awcPirepHazard: 'icing' }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepView.length)).toBe(1);
  await page.evaluate(() => window.progsMapAudit.change({ awcPirepHazard: 'all', awcProgs: true }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().progs.forecast.snapshot?.frames.length ?? 0)).toBeGreaterThan(0);
  await page.evaluate(() => window.progsMapAudit.select(window.progsMapAudit.state().progs.forecast.snapshot!.frames.at(-1)!.validTime));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepView.length)).toBe(0);
  await page.evaluate(() => window.progsMapAudit.select(null));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepView.length)).toBe(24);
  await page.clock.fastForward(91 * 60_000);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepView.length)).toBe(0);
  expect(await page.evaluate(() => window.progsMapAudit.errors)).toEqual([]);
});

test('raw /TM and /OV recovery updates map and list when navigation arrives or changes', async ({ page }) => {
  const fixture = pirepFixture(), report = fixture.reports[0]!;
  const time = new Date(report.observedAt).toISOString().slice(11, 16).replace(':', '');
  const snapshot = { schemaVersion: 2, checkedAt: fixture.checkedAt, source: fixture.source, records: [
    `<AircraftReport><observation_time>${new Date(report.observedAt).toISOString()}</observation_time>
      <report_type>Urgent PIREP</report_type><aircraft_ref>C172</aircraft_ref><altitude_ft_msl>8000</altitude_ft_msl>
      <quality_control_flags><bad_location>TRUE</bad_location><no_time_stamp>TRUE</no_time_stamp></quality_control_flags>
      <raw_text>GFK UUA /OV GFK180005/TM ${time}/FL080/TP C172</raw_text></AircraftReport>`,
  ] };
  await page.route('**/api/weather/pireps.json', route => route.fulfill({ json: snapshot }));
  await page.goto('/test/browser/weather-progs.html?pireps');
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.loaded())).toBe(true);
  await page.evaluate(() => window.progsMapAudit.change({ awcPireps: true, awcProgs: false }));
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pireps.resolved?.issues.length)).toBe(1);
  await page.evaluate(() => window.progsMapAudit.setNavigation({
    airports: { type: 'FeatureCollection', features: [], meta: { revision: '2026-10-01', layer: 'airports', returned: 0, truncated: false } },
    navaids: { type: 'FeatureCollection', meta: { revision: '2026-10-01', layer: 'navaids', returned: 1, truncated: false },
      features: [{ type: 'Feature', id: 'test-gfk', geometry: { type: 'Point', coordinates: [-122, 37.3] },
        properties: { kind: 'navaid', ident: 'GFK', type: 'VOR/DME', stationDeclinationDeg: 0, status: 'OPERATIONAL IFR' } }] },
  }));
  const row = page.locator('.awc-pirep-list [data-report-id]');
  await expect(row).toBeVisible(); await row.getByRole('button').click();
  await expect(row.getByText('Decoded /OV · GFK180005', { exact: true })).toBeVisible();
  await expect(row.getByRole('row', { name: /Observed .*Decoded \/TM/ })).toBeVisible();
  await expect(row.getByText('Time unverified', { exact: true })).toBeVisible();
  await expect(row.getByText(/Source qualifiers/)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pireps.resolved?.issues.length)).toBe(0);
  await expect.poll(() => page.evaluate(layer => window.progsMapAudit.map.queryRenderedFeatures(undefined, { layers: [layer] }).length, LAYER)).toBe(1);
  await page.evaluate(() => window.progsMapAudit.setNavigation({}));
  await expect(row).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepView.length)).toBe(0);
  await expect.poll(() => page.evaluate(layer => window.progsMapAudit.map.queryRenderedFeatures(undefined, { layers: [layer] }).length, LAYER)).toBe(0);
  expect(await page.evaluate(() => window.progsMapAudit.errors)).toEqual([]);
});

test('partially visible PIREP rings at every viewport edge reveal their report row', async ({ page }) => {
  const snapshot = pirepFixture(); snapshot.reports = [snapshot.reports[0]!];
  await page.route('**/api/weather/pireps.json', route => route.fulfill({ json: snapshot }));
  await page.goto('/test/browser/weather-progs.html?pireps');
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.loaded())).toBe(true);
  await page.evaluate(() => window.progsMapAudit.change({ awcPireps: true, awcProgs: false }));
  const row = page.locator(`[data-report-id="${snapshot.reports[0]!.id}"]`);
  await expect(row).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepDisplay.loading)).toBe(false);
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    const point = await page.evaluate(edge => {
      const { map, state } = window.progsMapAudit, report = state().pireps.snapshot!.reports[0]!;
      map.jumpTo({ center: [report.longitude, report.latitude], bearing: 35 });
      const canvas = map.getCanvas(), center = map.project([report.longitude, report.latitude]);
      const target = { x: edge === 'left' ? -8 : edge === 'right' ? canvas.clientWidth + 8 : canvas.clientWidth / 2,
        y: edge === 'top' ? -8 : edge === 'bottom' ? canvas.clientHeight + 8 : canvas.clientHeight / 2 };
      map.panBy([center.x - target.x, center.y - target.y], { duration: 0 });
      return { x: Math.max(1, Math.min(canvas.clientWidth - 1, target.x)), y: Math.max(1, Math.min(canvas.clientHeight - 1, target.y)) };
    }, edge);
    await expect.poll(() => page.evaluate(({ point, layer }) => window.progsMapAudit.map.queryRenderedFeatures([point.x, point.y], { layers: [layer] }).length,
      { point, layer: LAYER })).toBeGreaterThan(0);
    await expect(row).toBeVisible();
    await page.evaluate(point => window.progsMapAudit.inspectPirep(point), point);
    await expect(row.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  }
  await page.evaluate(() => window.progsMapAudit.map.panBy([0, -80], { duration: 0 }));
  await expect(row).toHaveCount(0);
});

test('PIREP interactions avoid report rescans and source resubmission; stowed lists catch up on reopening', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const snapshot = pirepFixture();
  snapshot.reports.forEach((report, i) => { report.longitude += (i % 6) * .25; report.latitude += Math.floor(i / 6) * .23; });
  await page.route('**/api/weather/pireps.json', route => route.fulfill({ json: snapshot }));
  await page.goto('/test/browser/weather-progs.html?pireps');
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.loaded())).toBe(true);
  await page.evaluate(() => window.progsMapAudit.change({ awcPireps: true, awcProgs: false }));
  const list = page.getByRole('region', { name: 'PIREPs in viewport', exact: true });
  const rows = list.locator('[data-report-id]'), first = rows.nth(0), second = rows.nth(1);
  await expect(rows).toHaveCount(24);
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepDisplay.loading)).toBe(false);
  // Keep observation ages fixed while allowing MapLibre's animation frames.
  const interactionTime = await page.evaluate(() => window.progsMapAudit.state().now);
  await page.clock.setFixedTime(interactionTime);
  const order = await page.evaluate(() => window.progsMapAudit.map.getStyle().layers.map(layer => layer.id));
  expect(order.indexOf('weather-awc-pirep-highlight')).toBeGreaterThan(order.indexOf('zlayer-weather-slot'));
  expect(order.indexOf(LAYER)).toBeLessThan(order.indexOf('zlayer-weather-slot'));
  const ids = pirepFixture().reports.map(r => r.id);
  const highlighted = () => page.evaluate(() => [...new Set(window.progsMapAudit.map
    .queryRenderedFeatures(undefined, { layers: ['weather-awc-pirep-highlight'] }).map(f => f.properties.id))]);
  const before = await page.evaluate(() => {
    const map = window.progsMapAudit.map, source = map.getSource('weather-awc-pireps') as GeoJSONSource;
    const setData = source.setData.bind(source), audit = { writes: 0, reportReads: 0 };
    Object.assign(window, { pirepHighlightAudit: audit });
    source.setData = (...args: Parameters<typeof setData>) => { audit.writes++; return setData(...args); };
    for (const report of window.progsMapAudit.state().pireps.snapshot!.reports) {
      const observedAt = report.observedAt;
      Object.defineProperty(report, 'observedAt', { get() { audit.reportReads++; return observedAt; } });
    }
    return { center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing() };
  });
  await first.hover(); await expect.poll(highlighted).toEqual([ids[0]]);
  await expect(first.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await second.hover(); await expect.poll(highlighted).toEqual([ids[1]]);
  await page.screenshot({ path: testInfo.outputPath('pirep-hover.png') });
  await page.mouse.move(20, 20); await expect.poll(highlighted).toEqual([]);
  // Keyboard focus persists when a newer pointer interaction leaves.
  await first.getByRole('button').focus(); await expect.poll(highlighted).toEqual([ids[0]]);
  await second.hover(); await expect.poll(highlighted).toEqual([ids[1]]);
  await page.mouse.move(20, 20); await expect.poll(highlighted).toEqual([ids[0]]);
  expect(await page.evaluate(() => (window as unknown as { pirepHighlightAudit: { reportReads: number } }).pirepHighlightAudit.reportReads)).toBe(0);
  await first.getByRole('button').click();
  await first.getByText('Raw report', { exact: true }).focus();
  await second.hover(); await expect.poll(highlighted).toEqual([ids[1]]);
  await page.mouse.move(20, 20); await expect.poll(highlighted).toEqual([ids[0]]);
  await first.getByRole('button').click(); // Clear explicit selection.
  await list.focus(); await page.mouse.move(20, 20); await expect.poll(highlighted).toEqual([]);
  // Touch pointer entry alone must not create a sticky hover during scrolling.
  await second.dispatchEvent('pointerover', { pointerType: 'touch', bubbles: true });
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.state().pirepHighlight ?? null)).toBe(null);
  expect(await page.evaluate(() => {
    const map = window.progsMapAudit.map;
    return { center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing() };
  })).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { pirepHighlightAudit: { writes: number } }).pirepHighlightAudit.writes)).toBe(0);
  await first.getByRole('button').focus();
  await page.evaluate(() => window.progsMapAudit.change({ awcPirepHazard: 'icing' }));
  await expect(rows).toHaveCount(1); await expect.poll(highlighted).toEqual([]);
  await rows.first().getByRole('button').focus(); await expect.poll(highlighted).toEqual([ids[1]]);
  await page.keyboard.press('Escape'); await expect(list).not.toBeVisible(); await expect.poll(highlighted).toEqual([]);
  const stowedList = page.locator('.awc-pirep-list'), stowedText = await stowedList.textContent();
  await page.clock.setSystemTime(interactionTime);
  await page.clock.fastForward(120_000);
  await expect(stowedList).toHaveText(stowedText!);
  await page.getByRole('button', { name: 'Show PIREP in View', exact: true }).click();
  await expect(list).toBeVisible(); await expect.poll(highlighted).toEqual([]);
  await expect(stowedList).not.toHaveText(stowedText!);
  await rows.first().hover(); await expect.poll(highlighted).toEqual([ids[1]]);
  await page.evaluate(() => window.progsMapAudit.map.fire('error', { sourceId: 'weather-awc-pireps', error: new Error('PIREP test failure') }));
  await expect.poll(highlighted).toEqual([]);
  await page.evaluate(() => window.progsMapAudit.checkPireps());
  await expect.poll(() => page.evaluate(() => window.progsMapAudit.map.queryRenderedFeatures(undefined, { layers: ['weather-awc-pirep-circles'] }).length)).toBe(1);
  expect(await page.evaluate(() => window.progsMapAudit.map.getStyle().layers.map(layer => layer.id))).toEqual(order);
  await page.getByLabel('Close PIREPs', { exact: true }).click(); await expect(list).toHaveCount(0);
  await expect.poll(highlighted).toEqual([]);
});

test('independent PIREP controls and a scrollable temporary viewport panel use core UI', async ({ page }, testInfo) => {
  const snapshot = pirepFixture();
  let requests = 0;
  snapshot.reports[0]!.aircraft = 'B737';
  snapshot.reports[1]!.aircraft = 'C172'; // AIREP flight reference: no inferred aircraft name.
  snapshot.reports[2]!.aircraft = 'C172';
  snapshot.reports[3]!.aircraft = ''; snapshot.reports[3]!.type = 'Unknown';
  snapshot.reports[4]!.aircraft = 'LONG-AIRCRAFT-REFERENCE';
  snapshot.reports[4]!.turbulence = ['MOD-SEV CHOP OCNL · 7000–9000 ft MSL', 'NEG'];
  await page.route('**/api/weather/pireps.json', route => { requests++; return route.fulfill({ json: snapshot }); });
  await page.addInitScript(() => localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-122, 37.3], zoom: 7 })));
  await page.goto('/'); await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
  await page.getByRole('tab', { name: 'PIREPs', exact: true }).click();
  await page.getByRole('switch', { name: 'Show PIREPs', exact: true }).click();
  const list = page.getByRole('region', { name: 'PIREPs in viewport', exact: true });
  await expect(list).toBeVisible(); await expect(list.locator('[data-report-id]')).toHaveCount(24);
  expect(await list.evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true);
  const selectedRow = list.locator('[data-report-id]').first();
  await expect(selectedRow.locator('.ui-panel-title')).toHaveText('B737 (Boeing 737-700)');
  await expect(selectedRow.getByText('Urgent', { exact: true })).toBeVisible();
  await expect(selectedRow.getByText('Pilot report', { exact: true })).toBeVisible();
  await expect(list.locator('[data-report-id]').nth(1).getByText('Air report', { exact: true })).toBeVisible();
  await expect(list.locator('[data-report-id]').nth(1).locator('.ui-panel-title')).toHaveText('C172');
  await expect(list.locator('[data-report-id]').nth(2).locator('.ui-panel-title')).toHaveText('C172 (Cessna 172 Skyhawk)');
  await expect(list.getByText('Aircraft unspecified', { exact: true })).toBeVisible();
  await expect(list.getByText('Type unspecified', { exact: true })).toBeVisible();
  await selectedRow.hover();
  const hoverBackground = await selectedRow.evaluate(e => getComputedStyle(e).backgroundColor);
  await selectedRow.getByRole('button').click();
  await expect(selectedRow.getByText('Turbulence: MOD CHOP', { exact: true })).toHaveCount(1);
  await list.getByText('Raw report', { exact: true }).click();
  await expect(list.locator('pre')).toHaveText('SYNTHETIC PIREP 1 /RM TEST REPORT');
  await page.screenshot({ path: testInfo.outputPath('pireps-desktop.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.screenshot({ path: testInfo.outputPath('pireps-desktop-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.getByLabel('Close PIREPs', { exact: true }).click();
  await expect(list).toHaveCount(0); await expect(page.getByRole('switch', { name: 'Show PIREPs', exact: true })).toBeChecked();
  const checked = requests;
  await page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true }).click();
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AWC Weather toolbox', exact: true })).toBeVisible();
  expect(requests).toBe(checked);
  await page.clock.setSystemTime(await page.evaluate(() => Date.now() + 61_000));
  await page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true }).click();
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await expect.poll(() => requests).toBe(checked + 1);
  await expect(list).toHaveCount(0);
  await page.clock.fastForward(61_000); await expect(list).toHaveCount(0);
  await expect.poll(() => requests).toBe(checked + 2);
  const canvas = (await page.locator('.maplibregl-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await expect(list).toBeVisible();
  await expect(selectedRow.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  await expect(list).toBeFocused();
  expect(await selectedRow.evaluate(e => e.matches(':hover, :focus-within'))).toBe(false);
  expect(await selectedRow.evaluate(e => getComputedStyle(e).backgroundColor)).toBe(hoverBackground);
  expect(await list.locator('[data-report-id]').nth(1).evaluate(e => getComputedStyle(e).backgroundColor)).not.toBe(hoverBackground);
  await page.screenshot({ path: testInfo.outputPath('pirep-map-selection.png') });
  await page.getByLabel('Close PIREPs', { exact: true }).click();
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Inspect PIREPs', exact: true }).click();
  await expect(list).toBeVisible(); await expect(list).toBeFocused();
  await page.keyboard.press('Escape'); await expect(list).not.toBeVisible();
  await page.getByRole('combobox', { name: 'Reported conditions', exact: true }).selectOption('icing');
  await expect(page.getByText('1 report in view', { exact: true })).toBeVisible();
  await expect(list).not.toBeVisible();
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await expect(list).toBeVisible(); await expect(list.locator('[data-report-id]')).toHaveCount(1);
  await page.getByLabel('Close PIREPs', { exact: true }).click();
  await expect(list).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Reported conditions', exact: true }).selectOption('all');
  await expect(page.getByText('24 reports in view', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 568 });
  const tabs = page.getByRole('tablist', { name: 'AWC weather products' });
  expect(await tabs.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('pirep-controls-phone.png') });
  await page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true }).click();
  await page.locator('.maplibregl-canvas').click();
  await expect(list).toBeVisible(); expect(await list.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await expect(list).toBeFocused();
  await expect.poll(() => page.locator('.edge-panels').evaluateAll(groups => groups.every(group =>
    group.getAnimations().every(animation => animation.playState !== 'running')))).toBe(true);
  const listBounds = (await list.boundingBox())!;
  expect(listBounds.x).toBeGreaterThanOrEqual(0);
  expect(listBounds.x + listBounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('pireps-phone.png') });
  const longRow = list.locator('[data-report-id]').nth(4);
  await expect(longRow.locator('.ui-panel-title')).toHaveText('LONG-AIRCRAFT-REFERENCE');
  await longRow.scrollIntoViewIfNeeded();
  expect(await longRow.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('pireps-phone-long-reference.png') });
  await page.getByLabel('Close PIREPs', { exact: true }).click();
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await page.getByRole('switch', { name: 'Show PIREPs', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'PIREPs', exact: true })).not.toHaveAttribute('data-active', 'true');
});

test('unplotted PIREPs show structured source evidence and collapsible original report text without XML', async ({ page }, testInfo) => {
  const snapshot = pirepFixture();
  const raw = 'DEN UA /OV UNKN/TM 0620/FL080/TP B737/RM SMOOTH & CLEAR';
  snapshot.issues = [
    { id: 'bad-location', qualityFlag: 'bad_location', reason: 'AWC flagged the report location as unreliable',
      sourceXml: `<AircraftReport><receipt_time>2026-09-22T21:00:00Z</receipt_time><observation_time>2026-09-22T20:55:00Z</observation_time>
        <quality_control_flags><bad_location>TRUE</bad_location><mid_point_assumed>TRUE</mid_point_assumed></quality_control_flags><aircraft_ref>B737</aircraft_ref>
        <latitude>39.8125</latitude><longitude>-104.6607</longitude><altitude_ft_msl>8000</altitude_ft_msl>
        <report_type>PIREP</report_type><raw_text>${raw.replace('&', '&amp;')}</raw_text></AircraftReport>` },
    { id: 'invalid-fields', reason: 'Report location, time or fields unavailable',
      sourceXml: `<AircraftReport><observation_time>2026-02-30T06:20:00Z</observation_time><aircraft_ref>C172</aircraft_ref><report_type>AIREP</report_type>
        <latitude>UNKNOWN</latitude><latitude>91</latitude><icing_condition icing_type="RIME" icing_intensity="MOD" icing_base_ft_msl="INVALID"/>
        <provider_note>Unverified source value</provider_note><constructor>Source extension</constructor>
        <raw_text><![CDATA[  AIREP /RM <UNCHANGED> & UNVERIFIED  ]]></raw_text></AircraftReport>` },
    { id: 'missing-time', qualityFlag: 'no_time_stamp', reason: 'AWC flagged the observation time as missing',
      sourceXml: '<AircraftReport><quality_control_flags><no_time_stamp>TRUE</no_time_stamp></quality_control_flags></AircraftReport>' },
    { id: 'truncated-source', reason: 'Incomplete source entry', sourceXml: '<AircraftReport><raw_text>TRUNCATED\n[Source excerpt]' },
    { id: 'unsupported-source', reason: 'Unsupported source entry',
      sourceXml: '<!DOCTYPE AircraftReport [<!ENTITY test "EXPANDED ENTITY">]><AircraftReport><raw_text>&test;</raw_text></AircraftReport>' },
  ];
  await page.route('**/api/weather/pireps.json', route => route.fulfill({ json: snapshot }));
  await page.goto('/'); await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await page.getByRole('switch', { name: 'Show AWC weather', exact: true }).click();
  await page.getByRole('tab', { name: 'PIREPs', exact: true }).click();
  await page.getByRole('switch', { name: 'Show PIREPs', exact: true }).click();
  await page.getByLabel('Close PIREPs', { exact: true }).click();
  const disclosure = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Reports not plotted$/ }) });
  const disclosureToggle = disclosure.locator(':scope > summary');
  const entries = disclosure.getByRole('article');
  await expect(entries).toHaveCount(0, { timeout: 1000 });
  await disclosureToggle.click();
  await expect(entries).toHaveCount(5);
  const first = entries.nth(0);
  await expect(first.getByRole('heading', { name: 'Location unavailable' })).toBeVisible();
  await expect(first.getByText(snapshot.issues[0]!.reason, { exact: true })).toHaveCount(0);
  await expect(first.getByRole('row', { name: 'Aircraft B737 (Boeing 737-700)', exact: true })).toBeVisible();
  await expect(first.getByRole('row', { name: 'Observed Sep 22 · 20:55Z', exact: true })).toBeVisible();
  await expect(first.getByRole('row', { name: /Quality|Unreliable location/ })).toHaveCount(0);
  await expect(first.getByText('Midpoint assumed', { exact: true })).toBeVisible();
  await expect(first.locator('pre')).toBeHidden();
  await first.getByText('Raw report', { exact: true }).click();
  await expect(first.locator('pre')).toBeVisible();
  expect(await first.locator('pre').textContent()).toBe(raw);
  await first.getByText('Raw report', { exact: true }).click();
  await expect(first.locator('pre')).toBeHidden();
  await first.getByText('Raw report', { exact: true }).press('Enter');
  await expect(first.locator('pre')).toBeVisible();
  const second = entries.nth(1);
  await expect(second.getByRole('row', { name: 'Observed 2026-02-30T06:20:00Z', exact: true })).toHaveCount(1);
  await expect(second.getByRole('row', { name: 'Aircraft C172', exact: true })).toHaveCount(1);
  await expect(second.getByRole('row', { name: 'Latitude UNKNOWN', exact: true })).toHaveCount(1);
  await expect(second.getByRole('row', { name: 'Latitude 91', exact: true })).toHaveCount(1);
  await expect(second.getByRole('row', { name: 'Icing · Base (ft MSL) INVALID', exact: true })).toHaveCount(1);
  await expect(second.getByRole('row', { name: 'Provider note Unverified source value', exact: true })).toHaveCount(1);
  await expect(second.getByRole('row', { name: 'Constructor Source extension', exact: true })).toHaveCount(1);
  await expect(second.locator('pre')).toBeHidden();
  await second.getByText('Raw report', { exact: true }).click();
  await expect(second.locator('pre')).toBeVisible();
  expect(await second.locator('pre').textContent()).toBe('  AIREP /RM <UNCHANGED> & UNVERIFIED  ');
  await expect(second.locator('unchanged')).toHaveCount(0);
  await expect(entries.nth(2).getByText('Raw report unavailable.', { exact: true })).toHaveCount(1);
  await expect(entries.nth(2).getByRole('heading', { name: 'Observation time unavailable', exact: true })).toHaveCount(1);
  await expect(entries.nth(2).getByRole('table')).toHaveCount(0);
  await expect(entries.nth(3).getByText('Readable source details unavailable.', { exact: true })).toHaveCount(1);
  await expect(entries.nth(4).getByText('Readable source details unavailable.', { exact: true })).toHaveCount(1);
  expect(await disclosure.textContent()).not.toMatch(/<AircraftReport>|<raw_text>|<!DOCTYPE|EXPANDED ENTITY/);
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('pirep-source-desktop.png') });
  await page.setViewportSize({ width: 320, height: 568 });
  for (const entry of [first, second]) {
    await entry.locator('pre').scrollIntoViewIfNeeded();
    expect(await entry.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(entry.locator('pre')).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath('pirep-source-phone.png') });
  await disclosureToggle.click(); await expect(entries).toHaveCount(0);
  await disclosureToggle.click(); await expect(first.locator('pre')).toBeHidden();
  await first.getByText('Raw report', { exact: true }).click();
  await expect(first.locator('pre')).toBeVisible(); await expect(first.locator('pre')).toHaveText(raw);
});
