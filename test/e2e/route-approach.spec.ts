import { expect, test, type Locator, type Page } from '@playwright/test';
import catalog from '../fixtures/route-approaches.json' with { type: 'json' };
import legs from '../fixtures/route-approach-legs.json' with { type: 'json' };
import moffett from '../fixtures/route-approach-nuq.json' with { type: 'json' };
import published from '../fixtures/route-approach-published.json' with { type: 'json' };
import type { Map as MapLibreMap } from 'maplibre-gl';

test.use({ hasTouch: true });

for (const touch of [false, true]) test(`dragging the leg into an approach inserts a waypoint and preserves its bundle (${touch ? 'touch' : 'mouse'})`, async ({ page, request }, testInfo) => {
  await request.post('/__test/published-approaches');
  try {
    await page.setViewportSize({ width: touch ? 390 : 1280, height: 900 });
    await page.clock.setFixedTime(new Date('2026-09-20T23:00:00Z'));
    const procedure = published.airports.find(airport => airport.id === 'KSNS')!.procedures.find(procedure => procedure.name === 'ILS RWY 31')!;
    const entry = published.terminal.approaches.procedures.find(procedure => procedure.id === 'KSNS:I31')!
      .transitions.find(transition => transition.id === 'SNS2')!.legs.find(leg => leg.fix?.ident === 'ARTYY')!.fix!;
    await page.addInitScript(({ procedure, entry }) => {
      if (localStorage.getItem('zlayer-route-draft-v1')) return;
      localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: false }));
      localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1,
        center: [(-122 + entry.coordinate[0]!) / 2, entry.coordinate[1]], zoom: 9, bearing: 0, pitch: 0 }));
      localStorage.setItem('zlayer-route-draft-v1', JSON.stringify({ version: 2, entries: [
        { id: 'origin', text: '362729N1220000W' },
        { id: 'airport', text: 'KSNS', approach: { airportId: 'KSNS', procedureId: procedure.id,
          name: procedure.name, cycle: '2609', entry: { routeId: 'KSNS:I31', transitionId: 'transition-fix:SNS2:1',
            name: 'ARTYY', effectiveDate: '2026-09-03' } } },
      ] }));
    }, { procedure, entry });
    await page.goto('/');
    const bundle = page.locator('.route-attached-approach'), tokens = page.locator('.route-token strong');
    await expect(bundle).toHaveText('ILS 31 · ARTYY');
    await expect(page.getByLabel('Approach map details', { exact: true })).toBeVisible();
    const hideTerrain = page.getByLabel('Hide terrain toolbox', { exact: true });
    if (await hideTerrain.isVisible()) await hideTerrain.click();
    const airport = await page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-route-draft-v1')!).entries[1]);
    const canvas = page.locator('.maplibregl-canvas'), box = (await canvas.boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const end = { x: start.x + 60, y: start.y + 70 };
    await expect(async () => {
      await page.mouse.move(start.x, start.y);
      await expect(canvas).toHaveCSS('cursor', 'grab');
    }).toPass();
    if (touch) {
      const session = await page.context().newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else {
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
    }
    await expect(tokens).toHaveText(['362729N1220000W', /^\d{6}N\d{7}W$/, 'KSNS']);
    await expect(bundle).toHaveText('ILS 31 · ARTYY');
    await expect(page.locator('.route-token.is-error')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-route-draft-v1')!).entries[2])).toEqual(airport);
    const inserted = await tokens.nth(1).textContent();
    await page.screenshot({ path: testInfo.outputPath('approach-connector-insertion.png') });
    await history(page, 'Undo');
    await expect(tokens).toHaveText(['362729N1220000W', 'KSNS']);
    await expect(bundle).toHaveText('ILS 31 · ARTYY');
    await history(page, 'Redo');
    await expect(tokens).toHaveText(['362729N1220000W', inserted!, 'KSNS']);
    await page.reload();
    await expect(tokens).toHaveText(['362729N1220000W', inserted!, 'KSNS']);
    await expect(bundle).toHaveText('ILS 31 · ARTYY');
    await expect(page.getByLabel('Approach map details', { exact: true })).toBeVisible();
  } finally { await request.post('/__test/reset'); }
});

for (const width of [320, 1280]) test(`NUQ missed approach connects to the OAK hold before and after reload at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const airport = catalog.airports[0]!;
  const ils = airport.procedures.find(p => p.id === 'ils')!;
  await page.route('**/route-approaches.json', route => route.fulfill({ json: { ...catalog, airports: [
    { ...airport, id: 'KNUQ', faaId: 'NUQ', icaoId: 'KNUQ', procedures: [{ ...ils, name: 'ILS OR LOC RWY 32R' }] },
  ] } }));
  await page.route('**/route-approach-legs.json', route => route.fulfill({ json: moffett }));
  const hasMissedConnection = () => page.evaluate(() => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    return !!map.getLayer('route-missed-line') && map.queryRenderedFeatures({ layers: ['route-missed-line'] })
      .some(f => f.properties.routeKind === 'approach-missed');
  });
  await page.goto('/test/browser/routes.html?map&nuq');
  await choose(page);
  await page.getByRole('button', { name: 'ILS OR LOC RWY 32R', exact: true }).click();
  for (const entry of ['ZAPEP', 'Vectors to final (VTF)']) {
    await page.getByRole('radio', { name: entry, exact: true }).check();
    await expect.poll(hasMissedConnection).toBe(true);
    await expect(page.getByRole('dialog', { name: 'Choose entry', exact: true })).not.toContainText('Gaps remain');
  }
  await page.getByRole('button', { name: 'Add to route', exact: true }).click();
  await expect(page.locator('.route-attached-approach')).toHaveText('ILS OR LOC 32R · VTF');
  await expect.poll(hasMissedConnection).toBe(true);
  await page.reload();
  await expect(page.locator('.route-attached-approach')).toHaveText('ILS OR LOC 32R · VTF');
  await expect.poll(hasMissedConnection).toBe(true);
  await page.getByLabel('Approach map', { exact: true }).screenshot({ path: testInfo.outputPath('nuq-missed-approach.png') });
});

for (const width of [320, 1280]) test(`entry selection previews, cancels and changes the map to VTF at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/test/browser/routes.html?map');
  const savedDraft = await page.evaluate(() => localStorage.getItem('zlayer-route-draft-v1'));
  const hasPoint = (name: string) => page.evaluate(name => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    return map.querySourceFeatures('route-plan').some(f => String(f.properties.ident).startsWith(name));
  }, name);
  await choose(page);
  await page.getByRole('button', { name: 'ILS OR LOC RWY 28R', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose entry', exact: true });
  await expect(picker.getByRole('button', { name: 'Add to route', exact: true })).toBeDisabled();
  await expect(picker.getByRole('radio', { checked: true })).toHaveCount(0);
  await picker.getByRole('radio', { name: 'ARCHI', exact: true }).check();
  await expect.poll(() => hasPoint('ARCHI')).toBe(true);
  await expect(page.locator('.route-attached-approach')).toHaveCount(0);
  await expect(picker.getByRole('img')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('zlayer-route-draft-v1'))).toBe(savedDraft);
  // The map remains interactive while the selection panel stays open.
  const center = await page.evaluate(() => (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit.getCenter().lng);
  const mapBox = (await page.getByLabel('Approach map', { exact: true }).boundingBox())!;
  await page.mouse.move(mapBox.x + 80, mapBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(mapBox.x + 130, mapBox.y + 100, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit.getCenter().lng)).not.toBe(center);
  await expect(picker).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('published-entry-preview.png') });
  await page.keyboard.press('Escape');
  await expect.poll(() => hasPoint('ARCHI')).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('zlayer-route-draft-v1'))).toBe(savedDraft);
  await choose(page);
  await page.getByRole('button', { name: 'ILS OR LOC RWY 28R', exact: true }).click();
  await picker.getByRole('radio', { name: 'ARCHI', exact: true }).check();
  await picker.getByRole('button', { name: 'Add to route', exact: true }).click();
  await page.waitForFunction(() => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    return map.getLayer('route-approach-line') && map.queryRenderedFeatures({ layers: ['route-approach-line'] }).length > 0;
  });
  await expect.poll(() => hasPoint('ARCHI')).toBe(true);
  await page.locator('.route-attached-approach').click();
  await page.getByRole('button', { name: 'Change entry', exact: true }).click();
  await picker.getByRole('radio', { name: 'Vectors to final (VTF)', exact: true }).check();
  await expect.poll(() => hasPoint('ARCHI')).toBe(false);
  await expect.poll(() => hasPoint('AXMUL')).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.route-attached-approach')).toHaveText('ILS OR LOC 28R · ARCHI');
  await expect.poll(() => hasPoint('ARCHI')).toBe(true);
  await page.locator('.route-attached-approach').click();
  await page.getByRole('button', { name: 'Change entry', exact: true }).click();
  await picker.getByRole('radio', { name: 'Vectors to final (VTF)', exact: true }).check();
  await page.screenshot({ path: testInfo.outputPath('vtf-preview.png') });
  await picker.getByRole('button', { name: 'Replace approach', exact: true }).click();
  await expect.poll(() => hasPoint('ARCHI')).toBe(false);
  await expect.poll(() => hasPoint('AXMUL')).toBe(true);
  await page.waitForFunction(() => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    return map.queryRenderedFeatures({ layers: ['route-approach-extension'] }).length > 0 &&
      map.queryRenderedFeatures({ layers: ['route-missed-line'] }).length > 0;
  });
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    return map.queryRenderedFeatures({ layers: ['route-missed-line'] }).some(f => f.properties.routeKind === 'approach-hold');
  })).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit
    .getPaintProperty('route-missed-line', 'line-dasharray'))).toEqual([2.5, 1.5]);
  await frameHold(page);
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    return map.queryRenderedFeatures({ layers: ['route-hold-direction'] }).length;
  })).toBe(1);
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    return map.querySourceFeatures('route-plan').some(f => f.properties.ident === 'VIKYU' &&
      /HOLD R · (DIRECT|PARALLEL|TEARDROP)/.test(String(f.properties.approachRole)));
  })).toBe(true);
  await page.getByLabel('Approach map', { exact: true }).screenshot({ path: testInfo.outputPath('vtf-map.png') });
  await page.reload();
  await expect(page.locator('.route-attached-approach')).toHaveText('ILS OR LOC 28R · VTF');
  await frameHold(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit
    .queryRenderedFeatures({ layers: ['route-hold-direction'] }).length)).toBe(1);
});

async function frameHold(page: Page) {
  await page.waitForFunction(() => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    return map.getSource('route-plan') && map.querySourceFeatures('route-plan').some(f => f.properties.routeKind === 'hold-direction');
  });
  // This fixture has a fixed initial camera; put the entire hold in view to check its symbol.
  await page.evaluate(() => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    const arrow = map.querySourceFeatures('route-plan').find(f => f.properties.routeKind === 'hold-direction')!;
    if (arrow.geometry.type === 'Point') map.jumpTo({ center: arrow.geometry.coordinates as [number, number], zoom: 11 });
  });
}

test('entry data failure retries without attaching; missing coded data offers the plate', async ({ page }) => {
  let available = false;
  await page.route('**/route-approach-legs.json', route => available ? route.fulfill({ json: legs }) : route.fulfill({ status: 503 }));
  await page.goto('/test/browser/routes.html');
  await choose(page);
  await page.getByRole('button', { name: 'ILS OR LOC RWY 28R', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Published entries could not be loaded');
  await expect(page.locator('.route-attached-approach')).toHaveCount(0);
  available = true;
  await page.getByRole('button', { name: 'Retry entries', exact: true }).click();
  await selectEntry(page, 'Vectors to final (VTF)');
  await expect(page.locator('.route-attached-approach')).toHaveText('ILS OR LOC 28R · VTF');
  await page.unroute('**/route-approach-legs.json');
  await page.route('**/route-approach-legs.json', route => route.fulfill({ json: { ...legs, approaches: undefined } }));
  await page.evaluate(async () => {
    for (const name of await caches.keys()) await (await caches.open(name)).delete('/route-approach-legs.json');
  });
  await page.reload();
  await page.locator('.route-attached-approach').click();
  await page.getByRole('button', { name: 'Change entry', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Published entry data is unavailable');
  await expect(page.getByRole('button', { name: 'View plate', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replace approach', exact: true })).toHaveCount(0);
});

async function choose(page: Page, token = page.locator('.route-token').first()) {
  await token.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Choose approach…', exact: true }).click();
  return page.getByRole('dialog', { name: 'Choose approach', exact: true });
}
async function selectEntry(page: Page, name = 'ARCHI') {
  const picker = page.getByRole('dialog', { name: 'Choose entry', exact: true });
  await expect(picker).toBeVisible();
  await picker.getByRole('radio', { name, exact: true }).check();
  await expect(picker).toContainText('Preview on map');
  await picker.getByRole('button', { name: /^(Add to route|Replace approach)$/ }).click();
}
async function history(page: Page, action: 'Undo' | 'Redo') {
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: `${action} route edit`, exact: true }).click();
}
async function longPress(page: Page, token: Locator) {
  await token.scrollIntoViewIfNeeded();
  const box = (await token.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
  await expect(page.getByRole('menuitem', { name: 'Choose approach…', exact: true })).toBeVisible();
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

for (const width of [320, 1280]) test(`attach, switch, restore, detach and undo an approach at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/test/browser/routes.html');
  const tokens = page.locator('.route-token');
  const ids = await page.locator('[data-route-entry]').evaluateAll(items => items.map(item => (item as HTMLElement).dataset.routeEntry));
  const picker = await choose(page);
  await expect(picker.getByRole('button', { name: 'RNAV (GPS) RWY 28L', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'OLD APPROACH', exact: true })).toHaveCount(0);
  await expect(picker.getByRole('button', { name: 'AIRPORT DIAGRAM', exact: true })).toHaveCount(0);
  await picker.getByRole('searchbox', { name: 'Filter approaches' }).fill('RNAV');
  await expect(picker.getByRole('button', { name: 'ILS OR LOC RWY 28R', exact: true })).toHaveCount(0);
  await picker.getByRole('button', { name: 'RNAV (GPS) RWY 28L', exact: true }).click();
  await selectEntry(page);
  await expect(picker).toHaveCount(0);
  await expect(tokens.locator('strong')).toHaveText(['KSFO', 'UNKNOWN', 'KSJC']);
  await expect(page.locator('.route-approach-bundle')).toHaveCount(1);
  await expect(page.locator('output')).toHaveText('7 legs; 1 issues');
  const attachment = page.getByRole('button', { name: 'Change approach for KSFO: RNAV (GPS) RWY 28L', exact: true });
  await expect(attachment).toBeVisible();
  await page.locator('.route-bar').screenshot({ path: testInfo.outputPath('approach-bundle.png') });
  await attachment.click();
  const change = page.getByRole('dialog', { name: 'Change approach', exact: true });
  await expect(change.getByRole('button', { name: /RNAV.*Selected/ })).toHaveAttribute('aria-pressed', 'true');
  await change.screenshot({ path: testInfo.outputPath('approach-picker.png') });
  const bounds = (await change.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
  await change.getByRole('button', { name: 'View plate', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Opened plate:' })).toHaveText('Opened plate: RNAV (GPS) RWY 28L');
  await attachment.click();
  await change.getByRole('button', { name: 'ILS OR LOC RWY 28R', exact: true }).click();
  await selectEntry(page);
  await expect(page.locator('.route-attached-approach')).toHaveText('ILS OR LOC 28R · ARCHI');
  await history(page, 'Undo');
  await expect(page.locator('.route-attached-approach')).toHaveText('RNAV (GPS) 28L · ARCHI');
  await history(page, 'Redo');
  await expect(page.locator('.route-attached-approach')).toHaveText('ILS OR LOC 28R · ARCHI');
  await page.reload();
  await expect(page.locator('.route-attached-approach')).toHaveText('ILS OR LOC 28R · ARCHI');
  expect(await page.locator('[data-route-entry]').evaluateAll(items => items.map(item => (item as HTMLElement).dataset.routeEntry))).toEqual(ids);
  const remove = page.getByRole('button', { name: 'Remove ILS OR LOC RWY 28R approach from KSFO', exact: true });
  expect((await remove.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await remove.click();
  await expect(page.locator('.route-attached-approach')).toHaveCount(0);
  await expect(tokens.locator('strong')).toHaveText(['KSFO', 'UNKNOWN', 'KSJC']);
  await history(page, 'Undo');
  await expect(page.locator('.route-attached-approach')).toHaveText('ILS OR LOC 28R · ARCHI');
  await tokens.first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove approach', exact: true }).click();
  await page.reload();
  await expect(page.locator('.route-attached-approach')).toHaveCount(0);
  await expect(tokens).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('touch and keyboard menus handle empty airports, cancel, and remove from the picker', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/test/browser/routes.html');
  const tokens = page.locator('.route-token');
  await tokens.nth(1).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Choose approach…', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await longPress(page, tokens.last());
  await page.getByRole('menuitem', { name: 'Choose approach…', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('No approaches published for KSJC');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(tokens.last()).toBeFocused();
  await tokens.first().focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Choose approach…', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'RNAV (GPS) RWY 28L', exact: true }).click();
  await selectEntry(page);
  await tokens.first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Change approach…', exact: true }).click();
  await page.getByRole('button', { name: 'Remove approach', exact: true }).click();
  await expect(page.locator('.route-attached-approach')).toHaveCount(0);
  await expect(tokens.first()).toBeFocused();
  await tokens.first().press('Control+z');
  await expect(page.locator('.route-attached-approach')).toHaveText('RNAV (GPS) 28L · ARCHI');
});

test('approach remains attached to its occurrence through drag and replacement clears it', async ({ page }) => {
  await page.goto('/test/browser/routes.html');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('KSFO KSJC');
  const tokens = page.locator('.route-token');
  await choose(page);
  await page.getByRole('button', { name: 'RNAV (GPS) RWY 28L', exact: true }).click();
  await selectEntry(page);
  const source = (await tokens.first().boundingBox())!;
  const destination = (await tokens.last().boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x + destination.width - 2, destination.y + destination.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(tokens.locator('strong')).toHaveText(['UNKNOWN', 'KSJC', 'KSFO', 'KSJC', 'KSFO']);
  await expect(page.locator('[data-route-entry]').last().locator('.route-attached-approach')).toHaveText('RNAV (GPS) 28L · ARCHI');
  await tokens.last().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Replace route item', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Replace route item KSFO', exact: true });
  await field.fill('KSJC');
  await field.press('Enter');
  await expect(page.locator('.route-attached-approach')).toHaveCount(0);
});

test('failed catalog loads can retry and unavailable saved approaches remain removable', async ({ page }) => {
  let fail = true;
  await page.route('**/route-approaches.json', route => fail ? route.fulfill({ status: 503 }) : route.fulfill({ json: catalog }));
  await page.addInitScript(() => localStorage.setItem('zlayer-route-draft-v1', JSON.stringify({ version: 2, entries: [{
    id: 'airport', text: 'KSFO', approach: { airportId: 'KSFO', procedureId: 'old', name: 'SAVED APPROACH', cycle: '2608' },
  }] })));
  await page.goto('/test/browser/routes.html');
  await page.locator('.route-attached-approach').click();
  await expect(page.getByRole('alert')).toContainText('Approaches could not be loaded');
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('not in the loaded edition');
  await expect(page.getByRole('button', { name: 'View plate', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove approach', exact: true }).click();
  await expect(page.locator('.route-token strong')).toHaveText(['KSFO']);
});

test('a cancelled load leaves the route intact and cached approaches reopen offline', async ({ page }) => {
  let finish: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/route-approaches.json', async route => { await pending; await route.fulfill({ json: catalog }); });
  await page.goto('/test/browser/routes.html');
  await choose(page);
  await expect(page.getByRole('dialog')).toContainText('Loading approaches');
  await page.getByRole('button', { name: 'Close approach picker', exact: true }).click();
  finish!();
  await expect(page.locator('.route-attached-approach')).toHaveCount(0);
  await choose(page);
  await page.getByRole('button', { name: 'RNAV (GPS) RWY 28L', exact: true }).click();
  await selectEntry(page);
  await page.reload();
  await page.context().setOffline(true);
  await page.locator('.route-attached-approach').click();
  await expect(page.getByRole('button', { name: /RNAV.*Selected/ })).toBeVisible();
  await page.getByRole('button', { name: 'ILS OR LOC RWY 28R', exact: true }).click();
  await selectEntry(page);
  await expect(page.locator('.route-attached-approach')).toHaveText('ILS OR LOC 28R · ARCHI');
});

test('the production route bar offers the plate when an approach has no coded entry data', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('zlayer-route-draft-v1', JSON.stringify({ version: 2,
    entries: [{ id: 'origin', text: 'KSMO' }, { id: 'airport', text: 'KSBA' }] })));
  await page.goto('/');
  const airport = page.locator('.route-token').last();
  await expect(airport).toHaveClass(/is-airports/);
  await choose(page, airport);
  await page.getByRole('button', { name: 'TEST APPROACH', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Published entry data is unavailable');
  await expect(page.locator('.route-attached-approach')).toHaveCount(0);
  await page.getByRole('button', { name: 'View plate', exact: true }).click();
  await expect(page.getByRole('dialog', { name: /TEST APPROACH/ })).toBeVisible();
});

test('approach previews fit the main map beside the picker and clear when returning to the list', async ({ page, request }, testInfo) => {
  await request.post('/__test/published-approaches');
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.clock.setFixedTime(new Date('2026-09-20T23:00:00Z'));
    await page.goto('/');
    await page.getByLabel('Hide terrain toolbox', { exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Add route waypoint' });
    await input.fill('KSNS '); await input.press('Enter');
    await expect(page.locator('.route-token').first()).toHaveClass(/is-airports/);
    const saved = await page.evaluate(() => localStorage.getItem('zlayer-route-draft-v1'));
    await choose(page);
    const search = page.getByRole('searchbox', { name: 'Filter approaches' });
    await search.fill('ILS'); await search.press('Enter');
    expect(await page.evaluate(() => localStorage.getItem('zlayer-route-draft-v1'))).toBe(saved);
    await page.getByRole('button', { name: 'ILS RWY 31', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose entry', exact: true });
    await picker.getByRole('radio', { name: 'AANNE', exact: true }).check();
    for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
      await page.setViewportSize({ width: width!, height: height! });
      await expect(picker.getByRole('button', { name: 'Add to route', exact: true })).toBeInViewport();
      await expect.poll(() => magentaPixels(page)).toBeGreaterThan(30);
      const bounds = (await picker.boundingBox())!, map = (await page.locator('.map-canvas').boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(8);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width! - 8);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height!);
      expect(width! <= 640 ? bounds.y - map.y : bounds.x - map.x).toBeGreaterThan(140);
      await page.screenshot({ path: testInfo.outputPath(`approach-on-map-${width}.png`) });
    }
    await picker.getByRole('radio', { name: 'Vectors to final (VTF)', exact: true }).check();
    await expect.poll(() => magentaPixels(page)).toBeGreaterThan(30);
    await picker.getByRole('button', { name: '‹ Approaches', exact: true }).click();
    await expect.poll(() => magentaPixels(page)).toBe(0);
    await expect(page.locator('.route-attached-approach')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('zlayer-route-draft-v1'))).toBe(saved);
  } finally { await request.post('/__test/reset'); }
});

test('published entries, route depiction and approach switching survive a cold offline region', async ({ page, context, request }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await request.post('/__test/published-approaches');
  try {
    await page.clock.setFixedTime(new Date('2026-09-20T23:00:00Z'));
    await page.goto('/');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const input = page.getByRole('textbox', { name: 'Add route waypoint' });
    await input.fill('KSNS ');
    await input.press('Enter');
    await expect(page.locator('.route-token').first()).toHaveClass(/is-airports/);
    await choose(page);
    await page.getByRole('button', { name: 'ILS RWY 31', exact: true }).click();
    await expect(page.getByRole('radio')).toHaveCount(5);
    await expect(page.getByRole('radio', { name: 'SNS via AANNE', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'SNS via ARTYY', exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'ARTYY', exact: true }).check();
    await expect.poll(() => magentaPixels(page)).toBeGreaterThan(30);
    await expect(page.locator('.route-attached-approach')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('salinas-published-entry.png') });
    await page.getByRole('button', { name: 'Add to route', exact: true }).click();
    await expect(page.locator('.route-attached-approach')).toHaveText('ILS 31 · ARTYY');
    await page.getByLabel('Fit route on map').click();
    await expect.poll(() => magentaPixels(page)).toBeGreaterThan(30);
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByLabel('Find a state or territory').fill('California');
    await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
    page.once('dialog', dialog => void dialog.accept());
    await page.getByText('Temporary files and storage limits', { exact: true }).click();
    await page.getByRole('button', { name: 'Remove temporary charts and plates' }).click();
    await expect(page.getByRole('button', { name: 'Check saved files', exact: true })).toBeEnabled();
    expect(await page.evaluate(async () => {
      const cache = await caches.open('zlayers-data-v6');
      const request = (await cache.keys()).find(key => key.url.includes('/terminal-procedures.json') && key.url.includes('jsonSha256='));
      const data = request && await (await cache.match(request))!.json();
      return data?.approaches.procedures.find((p: { id: string }) => p.id === 'KSNS:I31')
        ?.transitions.find((t: { id: string }) => t.id === 'SNS2')?.legs.find((leg: { path: string }) => leg.path === 'AF');
    })).toMatchObject({ path: 'AF', center: [-121.60318333333333, 36.66383888888889], radiusNm: 22, turn: 'R' });
    await page.getByLabel('Close settings').click();
    await context.setOffline(true);
    const cold = await context.newPage();
    cold.on('pageerror', error => errors.push(error.message));
    await cold.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
    await page.close();
    await cold.goto('/');
    await expect(cold.locator('.offline-banner')).toBeVisible();
    await expect(cold.locator('.route-attached-approach')).toHaveText('ILS 31 · ARTYY');
    await expect.poll(() => magentaPixels(cold)).toBeGreaterThan(30);
    await expect(cold.getByLabel('Approach map details')).toBeVisible();
    await cold.getByLabel('Approach map details').click();
    await expect(cold.locator('.route-issues')).toContainText('Holding racetracks and altitude-dependent missed turns are schematic');
    await cold.getByLabel('Approach map details').click();
    await cold.screenshot({ path: testInfo.outputPath('salinas-cold-offline-arc.png') });
    await cold.locator('.route-attached-approach').click();
    await cold.getByRole('button', { name: 'Change entry', exact: true }).click();
    await selectEntry(cold, 'Vectors to final (VTF)');
    await expect(cold.locator('.route-attached-approach')).toHaveText('ILS 31 · VTF');
    await cold.getByLabel('Fit route on map').click();
    await expect.poll(() => magentaPixels(cold)).toBeGreaterThan(30);
    await cold.screenshot({ path: testInfo.outputPath('salinas-cold-offline-map.png') });
    await cold.locator('.route-attached-approach').click();
    await cold.getByRole('button', { name: 'RNAV (GPS) Y RWY 31', exact: true }).click();
    await expect(cold.getByRole('radio', { checked: true })).toHaveCount(0);
    await selectEntry(cold, 'Vectors to final (VTF)');
    await expect(cold.locator('.route-attached-approach')).toHaveText('RNAV (GPS) Y 31 · VTF');
    await cold.reload();
    await expect(cold.locator('.route-attached-approach')).toHaveText('RNAV (GPS) Y 31 · VTF');
    await expect.poll(() => magentaPixels(cold)).toBeGreaterThan(30);
    expect(errors).toEqual([]);
  } finally { await request.post('/__test/reset'); }
});

async function magentaPixels(page: Page) {
  const screenshot = await page.locator('.maplibregl-canvas').screenshot();
  return page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 190 && pixels[i + 1]! < 160 && pixels[i + 2]! > 175) count++;
    return count;
  }, screenshot.toString('base64'));
}

test('Verify / update makes new approaches available for first-use offline planning', async ({ page, context, request }) => {
  try {
    await page.goto('/');
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByLabel('Find a state or territory').fill('California');
    await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
    await request.post('/__test/published-approaches');
    await page.reload();
    await page.waitForFunction(async () => {
      const manifest = await (await caches.open('zlayers-data-v6')).match('/chart-data/2026-09-03/nav/manifest.json');
      return manifest && (await manifest.json()).generatedAt === '2026-09-20T22:52:37.101Z';
    });
    await page.locator('.download-card').getByRole('button', { name: 'Verify / update' }).click();
    await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
    await page.getByLabel('Close settings').click();
    // No route or approach has been opened online; all dependencies come from the saved region.
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.route-token')).toHaveCount(0);
    const input = page.getByRole('textbox', { name: 'Add route waypoint' });
    await input.fill('KSNS '); await input.press('Enter');
    await expect(page.locator('.route-token')).toHaveClass(/is-airports/);
    await choose(page);
    await page.getByRole('button', { name: 'ILS RWY 31', exact: true }).click();
    await selectEntry(page, 'AANNE');
    await page.reload();
    await expect(page.locator('.route-attached-approach')).toHaveText('ILS 31 · AANNE');
    await page.locator('.route-attached-approach').click();
    await page.getByRole('button', { name: 'Change entry', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'AANNE', exact: true })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'ARTYY', exact: true })).toBeVisible();
  } finally { await request.post('/__test/reset'); }
});
