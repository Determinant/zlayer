import { test, expect, type Page } from '@playwright/test';

async function selectAirport(page: Page, id: string) {
  await page.getByLabel('Search FAA navigation data').fill(id);
  await page.locator('.search-results button').filter({ hasText: id }).click();
}

for (const touch of [false, true]) test.describe(`airport map selection (${touch ? 'phone touch' : 'mouse'})`, () => {
  test.use(touch
    ? { hasTouch: true, deviceScaleFactor: 2, viewport: { width: 390, height: 844 } }
    : { hasTouch: false });

  for (const status of ['active', 'upcoming'] as const) test(`airport markers and labels take precedence over ${status} TFRs`, async ({ page, context }) => {
    const now = Date.now(), startsAt = now + (status === 'upcoming' ? 3600_000 : -3600_000), endsAt = now + 7200_000;
    await context.route('**/api/notams/tfrs', route => route.fulfill({ json: {
      schemaVersion: 1, source: 'FAA-TFR', checkedAt: now, notices: [{
        id: '6/9000', title: 'Airport overlap fixture TFR', type: 'HAZARDS', facility: 'TST', state: 'CA',
        modifiedAt: now - 1000, detailCheckedAt: now, startsAt, endsAt,
        text: 'Invented TFR for browser verification. No operational use.',
        areas: [{ id: '1', name: 'Area A', lower: 'SFC', upper: '3000 ft MSL',
          windows: [{ startsAt, endsAt }], geometry: { type: 'Polygon', coordinates: [
            [[-118.49, 33.98], [-118.41, 33.98], [-118.41, 34.06], [-118.49, 34.06], [-118.49, 33.98]],
          ] } }],
      }],
    } }));
    await context.route('**/api/weather/metars.geojson?*', route => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
    await page.addInitScript(() => {
      localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-118.45, 34.02], zoom: 12 }));
      localStorage.setItem('zlayer-ui:edge-tool', JSON.stringify({ version: 1, value: null }));
    });
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    const canvas = page.locator('.maplibregl-canvas'), box = (await canvas.boundingBox())!;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const select = async (x: number, y: number) => touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
    const details = page.getByRole('region', { name: 'TFR details', exact: true });
    // Establish that the covering TFR is rendered and interactive before selecting the airport.
    await expect(async () => {
      await select(center.x - 80, center.y);
      await expect(details).toBeVisible();
    }).toPass();
    await expect(details.getByText(status === 'active' ? 'Active' : 'Upcoming', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close TFR details', exact: true }).click();
    await expect(page.locator('.notam-tfr-detail')).toHaveCount(0);
    const airportCard = page.locator('.feature-details-panel .feature-card');
    for (const label of [false, true]) {
      await select(center.x, center.y + (label ? 26 : 0));
      await expect(airportCard).toBeVisible();
      await expect(airportCard).toContainText('KSMO TEST AIRPORT');
      await expect(details).toHaveCount(0);
      await page.getByRole('button', { name: 'Close detail', exact: true }).click();
      await expect(airportCard).toBeHidden();
    }
    await select(center.x - 80, center.y);
    await expect(details).toBeVisible();
  });

  for (const tier of ['major', 'regional', 'local', 'weather']) test(`${tier} airport info opens from its marker and label`, async ({ page, context }) => {
    await context.route('**/nav/airports.geojson*', async route => {
      const response = await route.fetch();
      const body = await response.json();
      const airport = body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSMO');
      Object.assign(airport.properties, {
        facilityType: 'A', use: tier === 'local' ? 'PR' : 'PU', towered: tier === 'major' || tier === 'weather',
        elevationFt: 170, longestRunwayFt: 3500, frequencies: [{ type: 'ATIS', frequencyMHz: 119.15 }],
      });
      await route.fulfill({ response, json: body });
    });
    await context.route('**/api/weather/metars.geojson?*', route => route.fulfill({ json: {
      type: 'FeatureCollection', features: tier === 'weather' ? [{
        type: 'Feature', geometry: { type: 'Point', coordinates: [-118.45, 34.02] },
        properties: { id: 'KSMO', obsTime: Date.now() / 1000, fltcat: 'VFR', rawOb: 'KSMO TEST METAR' },
      }] : [],
    } }));
    await page.addInitScript(() => {
      localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-118.45, 34.02], zoom: 12 }));
      // Keep the phone's label clear by explicitly stowing the toolboxes.
      localStorage.setItem('zlayer-ui:edge-tool', JSON.stringify({ version: 1, value: null }));
    });
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    const canvas = page.locator('.maplibregl-canvas');
    const box = (await canvas.boundingBox())!;
    const facts = page.locator('.feature-facts');
    for (const label of [false, true]) {
      // At zoom 12 the label sits below the airport. Its center is outside
      // both the airport circle and the weather marker's hit area.
      const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 + (label ? 26 : 0) };
      if (touch) await page.touchscreen.tap(target.x, target.y);
      else {
        await page.mouse.move(target.x, target.y);
        await expect(canvas).toHaveCSS('cursor', 'pointer');
        await page.mouse.click(target.x, target.y);
      }
      await expect(page.locator('.feature-card')).toContainText('KSMO TEST AIRPORT');
      await expect(facts).toContainText('170 ft');
      await expect(facts).toContainText('119.15 MHz');
      if (tier === 'weather') await expect(page.getByRole('region', { name: 'METAR', exact: true })).toContainText('KSMO TEST METAR');
      const close = page.getByRole('button', { name: 'Close detail', exact: true });
      if (touch) await close.tap();
      else await close.click();
      await expect(page.locator('.feature-card')).toBeHidden();
    }
  });
});

test('airport summary groups local and terminal frequencies with notes on desktop, phone, and offline reload', async ({ page, context }, testInfo) => {
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    const airport = body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSMO');
    Object.assign(airport.properties, { elevationFt: 170, longestRunwayFt: 3500, frequencies: [
      { type: 'ATIS', frequencyMHz: 119.15, hours: '0700-2100' },
      { type: 'TOWER', frequencyMHz: 120.1, use: 'LCL/P IC', hours: '0700-2100' },
      { type: 'TOWER', frequencyMHz: 257.8, use: 'LCL/P', hours: '0700-2100' },
      { type: 'CTAF', frequencyMHz: 120.1, remarks: 'WHEN TOWER CLOSED' },
      { type: 'GROUND', frequencyMHz: 121.9, use: 'GND/P IC', hours: '0700-2100' },
    ], terminalFrequencies: [
      { type: 'CLEARANCE', frequencyMHz: 128.05, use: 'CD PRE TAXI CLNC', hours: '0700-2100', remarks: 'CONTACT BEFORE TAXI' },
      { type: 'CLEARANCE', frequencyMHz: 125.2, use: 'CD PRE TAXI CLNC', facilityId: 'M03', facilityName: 'MEMPHIS' },
      { type: 'CLEARANCE', frequencyMHz: 125.2, use: 'CD PRE TAXI CLNC', facilityId: 'MEM', facilityName: 'MEMPHIS' },
      { type: 'APPROACH', frequencyMHz: 124.3, use: 'APCH/P', facilityName: 'SOCAL', sector: '101-245', remarks: 'EAST SECTOR ONLY' },
      { type: 'APPROACH', frequencyMHz: 124.3, use: 'APCH/P', facilityName: 'SOCAL', sector: '246-341', remarks: 'WEST SECTOR ONLY' },
      { type: 'APPROACH', frequencyMHz: 118.025, use: 'APCH/S', facilityName: 'NORCAL', sector: 'WEST' },
      { type: 'APPROACH', frequencyMHz: 263.025, use: 'APCH/S', facilityName: 'NORCAL', sector: 'WEST', remarks: 'UHF SECTOR' },
      { type: 'APPROACH/DEPARTURE', frequencyMHz: 120.55, use: 'APCH/P DEP/P IC', facilityName: 'SOCAL', sector: '151-329' },
      { type: 'DEPARTURE', frequencyMHz: 125.2, use: 'DEP/P', facilityName: 'SOCAL' },
    ], centerFrequencies: [
      { type: 'CENTER', frequencyMHz: 127.95, facilityName: 'OAKLAND', facilityId: 'ZOA', sector: 'LOW', use: 'SQUAW VALLEY RCAG' },
      { type: 'CENTER', frequencyMHz: 126.5, facilityName: 'HONOLULU CONTROL FACILITY', facilityId: 'ZHN', sector: 'HIGH', use: 'TEST RCAG' },
    ] });
    await route.fulfill({ response, json: body });
  });
  await context.route('**/api/weather/metars.geojson?*', route => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
  await context.route('**/api/weather/tafs.json?*', route => route.fulfill({ status: 204 }));
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const facts = page.locator('.feature-facts');
  const labels = ['Elevation', 'Longest runway', 'ATIS', 'CD', 'Ground', 'Tower / CTAF', 'Approach', 'App / Dep', 'Departure', 'Center'];
  await expect(facts.locator('dt')).toHaveText(labels);
  await expect(facts.locator('dd')).toContainText(['170 ft', '3,500 ft', '119.15 MHz', '128.05 MHz', '121.90 MHz',
    '120.10 MHz', '124.30 MHz · SOCAL', '120.55 MHz · SOCAL', '125.20 MHz · SOCAL', '127.95 MHz · OAKLAND · LOW']);
  await expect(facts).not.toContainText('Type');
  // Search supplies the complete record. Re-select the actual map symbol to
  // verify nested details are restored after the compact map/tile projection.
  await expect.poll(() => page.evaluate(() => {
    const view = JSON.parse(localStorage.getItem('zlayers-map-view-v1') ?? '{}');
    return Math.abs((view.center?.[0] ?? 0) + 118.45) < 1e-8 && Math.abs((view.center?.[1] ?? 0) - 34.02) < 1e-8;
  })).toBe(true);
  await page.getByRole('button', { name: 'Close detail', exact: true }).click();
  const canvas = page.locator('.maplibregl-canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(facts.locator('dt')).toHaveText(labels);
  await expect(facts).toContainText('119.15 MHz');
  await expect.poll(async () => {
    const card = (await page.locator('.feature-card').boundingBox())!;
    return Math.round(card.x + card.width) <= page.viewportSize()!.width;
  }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('airport-summary-desktop.png') });
  const notes = facts.getByRole('button', { name: 'Tower / CTAF: 120.10 MHz. Hours and notes' });
  await notes.focus();
  await notes.press('Enter');
  await expect(facts.getByText(/Tower hours 0700-2100/)).toBeVisible();
  await expect(facts.getByText(/WHEN TOWER CLOSED/)).toBeVisible();
  const towerNotes = facts.getByRole('region', { name: 'Tower / CTAF notes' });
  await expect(towerNotes.getByText('Tower hours 0700-2100', { exact: true })).toHaveCount(1);
  await expect(towerNotes.getByText('LCL/P IC', { exact: true })).toBeVisible();
  await expect(towerNotes.locator('.airport-frequency-channel').filter({ hasText: '257.80 MHz' })).toHaveText('257.80 MHz · Tower');
  await facts.getByRole('button', { name: /^Ground:/ }).click();
  await expect(facts.getByRole('region', { name: 'Ground notes' })).toHaveText('GND/P IC');
  const clearance = facts.getByRole('button', { name: /^CD:/ });
  await clearance.focus();
  await clearance.press('Enter');
  const clearanceNotes = facts.getByRole('region', { name: 'CD notes' });
  await expect(clearance.locator('.airport-frequency-channel')).toHaveText([
    '125.20 MHz · MEMPHIS (M03)', '125.20 MHz · MEMPHIS (MEM)', '128.05 MHz',
  ]);
  for (const id of ['M03', 'MEM']) {
    const note = clearanceNotes.locator('.airport-frequency-note').filter({ hasText: `MEMPHIS (${id})` });
    await expect(note.locator('.airport-frequency-channel')).toHaveText(`125.20 MHz · MEMPHIS (${id})`);
    await expect(note.locator('p')).toHaveText('CD PRE TAXI CLNC');
  }
  await expect(clearanceNotes.getByText('CD PRE TAXI CLNC · CONTACT BEFORE TAXI', { exact: true })).toBeVisible();
  const approach = facts.getByRole('button', { name: /^Approach:/ });
  await approach.click();
  const approachNotes = facts.getByRole('region', { name: 'Approach notes' });
  for (const [channel, remark] of [
    ['124.30 MHz · SOCAL · 101-245', 'EAST SECTOR ONLY'],
    ['124.30 MHz · SOCAL · 246-341', 'WEST SECTOR ONLY'],
    ['263.025 MHz · NORCAL · WEST · Secondary', 'UHF SECTOR'],
  ] as const) {
    const note = approachNotes.locator('.airport-frequency-note').filter({ hasText: remark });
    await expect(note.locator('.airport-frequency-channel')).toHaveText(channel);
    await expect(note.locator('p')).toHaveText(remark);
  }
  const summaryChannel = approach.locator('.airport-frequency-number').first();
  const additionalChannel = approachNotes.locator('.airport-frequency-number').last();
  expect(await additionalChannel.evaluate(element => getComputedStyle(element).fontSize))
    .toBe(await summaryChannel.evaluate(element => getComputedStyle(element).fontSize));
  for (const [width, height] of [[390, 844], [320, 740], [640, 450]]) {
    await page.setViewportSize({ width: width!, height: height! });
    expect(await facts.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await facts.locator('.is-frequency').evaluateAll(rows => rows.every(row => {
      const label = row.querySelector('dt')!.getBoundingClientRect();
      const value = row.querySelector('dd')!.getBoundingClientRect();
      return label.right <= value.left && row.scrollWidth <= row.clientWidth;
    }))).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await approach.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('airport-summary-mobile.png') });
  await page.addStyleTag({ content: '.feature-card * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } .feature-card p { margin-bottom: 2em !important; }' });
  expect(await facts.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await approach.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('airport-summary-text-spacing.png') });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(facts.locator('dt')).toHaveText(labels);
  await expect(facts).toContainText('119.15 MHz');
  await facts.getByRole('button', { name: /^App \/ Dep:/ }).click();
  await expect(facts.getByRole('region', { name: 'App / Dep notes' })).toContainText('APCH/P DEP/P IC');
  await expect(facts).toContainText('125.20 MHz · SOCAL');
  await facts.getByRole('button', { name: /^Center:/ }).click();
  const centerNote = facts.getByRole('region', { name: 'Center notes' }).locator('.airport-frequency-note')
    .filter({ hasText: 'SQUAW VALLEY RCAG' });
  await expect(centerNote.locator('.airport-frequency-channel')).toHaveText('127.95 MHz · OAKLAND · LOW');
  await expect(centerNote.locator('p')).toHaveText('SQUAW VALLEY RCAG');
  await facts.getByRole('button', { name: /^Tower \/ CTAF:/ }).click();
  await expect(facts.getByRole('region', { name: 'Tower / CTAF notes' }).getByText('LCL/P IC', { exact: true })).toBeVisible();
});

test('untowered weather/CTAF and older frequency-free exports do not invent services', async ({ page, context }) => {
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const airport of body.features) Object.assign(airport.properties, { elevationFt: 50, longestRunwayFt: 5000 });
    const airport = body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSMO');
    Object.assign(airport.properties, { towered: false, frequencies: [
      { type: 'AWOS', frequencyMHz: 127.275, use: 'SMO AWOS-3' },
      { type: 'CTAF', frequencyMHz: 122.8 },
    ] });
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const facts = page.locator('.feature-facts');
  await expect(facts.locator('dt')).toHaveText(['Elevation', 'Longest runway', 'AWOS', 'CTAF']);
  await expect(facts).toContainText('127.275 MHz');
  await selectAirport(page, 'KSBA');
  await expect(facts.locator('dt')).toHaveText(['Elevation', 'Longest runway']);
  await expect(facts).not.toContainText('MHz');
});
