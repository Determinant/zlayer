import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { inspectWeather } from './weather-inspection';
import { advisorySource, WEATHER_NOW } from '../fixtures/awc-advisories';

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
  await request.post('/__test/awc', { data: { gairmet: [0, 3, 6, 9, 12].map(hour => advisorySource('gairmet', hour)),
    sigmet: advisorySource('sigmet'), cwa: advisorySource('cwa') } });
});

async function enable(page: Page) {
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('Open map layers', { exact: true }).click();
  await page.getByRole('switch', { name: /Forecasts & advisories/ }).click();
  await page.getByLabel('Close map layers', { exact: true }).click();
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Weather timeline' })).toBeVisible();
  await page.locator('.awc-source-status > summary').click();
  await expect(page.locator('.awc-toolbox [data-product="gairmet"]')).toContainText('Checked');
  await expect(page.locator('.awc-toolbox [data-product="cwa"]')).toContainText('Checked');
}
async function requests(request: APIRequestContext) { return (await (await request.get('/__test/awc-counts')).json()).requests as number; }

test('CWA with no hazard classification remains checked, visible and inspectable', async ({ page, request }) => {
  const cwa = advisorySource('cwa');
  cwa.features[0]!.properties.hazard = null;
  await request.post('/__test/awc', { data: { gairmet: [0, 3, 6, 9, 12].map(hour => advisorySource('gairmet', hour)),
    sigmet: advisorySource('sigmet'), cwa } });
  await enable(page);
  await expect(page.locator('.awc-toolbox [data-product="cwa"]')).toContainText('1 shown');
  await expect(async () => {
    await inspectWeather(page);
    const advisory = page.getByRole('article', { name: 'CWA 101', exact: true });
    await expect(advisory.getByRole('heading', { name: 'Unspecified hazard', exact: true })).toBeVisible();
  }).toPass();
  const advisory = page.getByRole('article', { name: 'CWA 101', exact: true });
  await advisory.locator('summary').click();
  await expect(advisory.locator('pre')).toHaveText('SYNTHETIC CWA TEST');
});

test('advisories render and pick overlapping bulletins, scrub published snapshots, and preserve time through WebGL recovery', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await enable(page);
  await expect(page.locator('.awc-toolbox [data-product="gairmet"]')).toContainText('1 shown');
  await page.locator('.awc-source-status > summary').click();
  const canvas = page.locator('.maplibregl-canvas');
  await expect(async () => {
    await inspectWeather(page);
    await expect(page.getByRole('region', { name: 'Weather advisory details' })).toBeVisible();
  }).toPass();
  const details = page.getByRole('region', { name: 'Weather advisory details' });
  await expect(details.getByRole('article', { name: 'Convective SIGMET 1W', exact: true })
    .getByRole('heading', { name: 'Thunderstorms', exact: true })).toBeVisible();
  const cwa = details.getByRole('article', { name: 'CWA 101', exact: true });
  await expect(cwa.locator('pre')).toBeHidden();
  await cwa.locator('summary').click();
  await expect(cwa.locator('pre')).toBeVisible();
  await expect(cwa.locator('pre')).toHaveText('SYNTHETIC CWA TEST');
  await expect(details.locator('article')).toHaveCount(4);
  await page.getByLabel('Close weather details').click();
  const slider = page.getByRole('slider', { name: 'Weather forecast time' });
  await slider.focus(); await slider.press('End');
  await page.locator('.awc-source-status > summary').click();
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 23 · 09:00Z');
  await expect(page.locator('.awc-toolbox [data-product="gairmet"]')).toContainText('09:00');
  await expect(page.getByRole('button', { name: 'Next weather time' })).toBeDisabled();
  await expect(page.locator('.awc-toolbox [data-product="cwa"]')).toContainText('No issued advisories cover this time');
  await slider.focus(); await slider.press('Home');
  await slider.press('ArrowRight'); await slider.press('ArrowRight'); await slider.press('ArrowRight');
  await expect(slider).toHaveValue(String(WEATHER_NOW + 6 * 3600000));
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 23 · 03:00Z');
  await expect(page.locator('.awc-toolbox [data-product="gairmet"]')).toContainText('03:00');
  await page.locator('.awc-source-status > summary').click();
  await canvas.evaluate(element => new Promise<void>(resolve => {
    const gl = (element as HTMLCanvasElement).getContext('webgl2');
    const extension = gl!.getExtension('WEBGL_lose_context')!;
    element.addEventListener('webglcontextrestored', () => resolve(), { once: true });
    extension.loseContext();
    setTimeout(() => extension.restoreContext(), 200);
  }));
  await expect(page.locator('.map-runtime-error')).toHaveCount(0);
  await expect(slider).toHaveValue(String(WEATHER_NOW + 6 * 3600000));
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 23 · 03:00Z');
  await page.getByRole('button', { name: 'Now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Now', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(async () => {
    await inspectWeather(page);
    await expect(page.getByRole('region', { name: 'Weather advisory details' }).locator('article')).toHaveCount(4);
  }).toPass();
  expect(errors).toEqual([]);
});

for (const [width, height] of [[1280, 900], [320, 568], [568, 320]] as const) {
  test(`advisory cards separate forecasts and bulletins with reachable details at ${width}×${height}`, async ({ page, request }, testInfo) => {
    const gairmet = [0, 3, 6, 9, 12].map(hour => {
      const source = advisorySource('gairmet', hour), area = source.features[0]!;
      return { ...source, features: [{ ...area, properties: { ...area.properties, product: 'TANGO', hazard: 'TURB-HI',
        tag: '3W', base: '270', top: '370', dueTo: '' } }] };
    });
    const source = advisorySource('sigmet'), area = source.features[0]!;
    const bulletin = 'SYNTHETIC BULLETIN FOR UI TEST\nCONVECTIVE SIGMET 9W\nVALID UNTIL 2300Z\nWY UT ID\n'
      + 'FROM 30SW JAC-50N HVE-40ESE DTA-40SE BVL-40W PIH-30SW JAC\n'
      + 'AREA SEV TS MOV FROM 22010KT. TOPS TO FL400.\nHAIL TO 1 IN...WIND GUSTS TO 50KT POSS.\n\n'
      + 'OUTLOOK VALID 222300-230300\nFROM 30N HLN-60SW DDY-50SW ELP-70SW TUS-50S HVE-ILC-BOI-60SE\nMLP-30N HLN\n'
      + 'WST ISSUANCES POSS. REFER TO MOST RECENT ACUS01 KWNS FROM STORM\nPREDICTION CENTER FOR SYNOPSIS AND METEOROLOGICAL DETAILS.';
    await request.post('/__test/awc', { data: { gairmet,
      sigmet: { ...source, features: [{ ...area, properties: { ...area.properties, seriesId: '9W', rawAirSigmet: bulletin } }] },
      cwa: { type: 'FeatureCollection', features: [] } } });
    await page.setViewportSize({ width, height });
    await enable(page);
    await page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true }).click();
    const details = page.getByRole('region', { name: 'Weather advisory details' });
    await expect(async () => {
      await inspectWeather(page);
      await expect(details).toBeVisible();
    }).toPass();
    const forecast = details.getByRole('article', { name: 'G-AIRMET 3W', exact: true });
    const convective = details.getByRole('article', { name: 'Convective SIGMET 9W', exact: true });
    await expect(details.getByRole('article')).toHaveCount(2);
    await expect(forecast.getByRole('heading', { name: 'High-altitude turbulence', exact: true })).toBeVisible();
    await expect(forecast).toContainText('G-AIRMET 3W · TANGO');
    await expect(forecast).toContainText('Base 27,000 ft · Top 37,000 ft');
    await expect(forecast).toContainText('Snapshot Sep 22 · 21:00Z');
    await expect(forecast).toContainText('Issued Sep 22 · 21:00Z');
    await expect(forecast.locator('details')).toHaveCount(0);
    await expect(convective.getByRole('heading', { name: 'Thunderstorms', exact: true })).toBeVisible();
    await expect(convective).toContainText('Convective SIGMET 9W · KKCI');
    await expect(convective).toContainText('Valid Sep 22 · 21:00–23:00Z');
    await expect(convective).toContainText('TOPS TO FL400');
    await expect(convective).toContainText('KKCI');
    await expect(details).not.toContainText('shown');
    await expect(details).not.toContainText('applicable advisories');
    await expect(details).not.toContainText('No bulletin text supplied');
    await expect(convective.locator('pre')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('awc-advisory-cards.png'), animations: 'disabled' });
    await convective.locator('summary').click();
    await expect(convective.locator('pre')).toBeVisible();
    await expect(convective.locator('pre')).toHaveText(bulletin);
    const list = details;
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const close = page.getByLabel('Close weather details');
    await expect(close).toBeInViewport();
    expect(await list.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('awc-advisory-bulletin.png'), animations: 'disabled' });
    const originalBulletin = await convective.locator('pre').elementHandle();
    const scrollTop = await list.evaluate(element => element.scrollTop);
    await list.focus();
    await page.keyboard.press('Escape');
    const reopen = page.getByRole('button', { name: 'Show Weather advisory details', exact: true });
    await expect(reopen).toBeFocused();
    await expect(details).toBeHidden();
    await reopen.click();
    await expect(details).toBeVisible();
    await expect(convective.locator('pre')).toBeVisible();
    expect(await convective.locator('pre').evaluate((element, original) => element === original, originalBulletin)).toBe(true);
    expect(await list.evaluate(element => element.scrollTop)).toBe(scrollTop);
    await page.getByRole('button', { name: 'Hide Weather advisory details', exact: true }).click();
    await expect(details).toBeHidden();
    await inspectWeather(page);
    await expect(details).toBeVisible();
    await expect(convective.locator('pre')).toBeVisible();
    await request.post('/__test/awc', { data: { failure: true } });
    await page.clock.fastForward(5 * 60_000 + 1_000);
    await expect(forecast.locator('.awc-advisory-freshness')).toContainText('Refresh failed');
    await expect(convective.locator('.awc-advisory-freshness')).toContainText('Refresh failed');
    await expect(convective.locator('pre')).toHaveText(bulletin);
    await page.clock.fastForward(2 * 3_600_000);
    await expect(convective.getByText('Expired', { exact: true })).toBeVisible();
    await close.click();
    await expect(details).toHaveCount(0);
  });
}

test('a controlling worker cannot hide upstream failure; disabling stops polling and preserves saved advisories', async ({ page, request }) => {
  await enable(page);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const before = await page.evaluate(() => localStorage.getItem('zlayer-plugin:weather-awc:cwa'));
  expect(before).toBeTruthy();
  await request.post('/__test/awc', { data: { failure: true } });
  await page.clock.fastForward(5 * 60_000 + 1_000);
  await expect(page.locator('.awc-toolbox [data-product="cwa"]')).toContainText('Refresh failed');
  expect(await page.evaluate(() => localStorage.getItem('zlayer-plugin:weather-awc:cwa'))).toBe(before);
  await page.getByLabel('Open map layers', { exact: true }).click();
  await page.getByRole('switch', { name: /Forecasts & advisories/ }).click();
  await page.getByLabel('Close map layers', { exact: true }).click();
  await expect(page.locator('.awc-timeline')).toHaveCount(0);
  const stopped = await requests(request);
  await page.clock.fastForward(6 * 60_000);
  expect(await requests(request)).toBe(stopped);
  await page.reload();
  await expect(page.locator('.awc-timeline')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('zlayer-plugin:weather-awc:cwa'))).toBe(before);
});

test('AWC toolbox sits above terrain, keeps filters out of Map Display, and snaps pointer/keyboard selection to available frames', async ({ page }) => {
  await enable(page);
  await page.locator('.awc-source-status > summary').click();
  const awcTab = page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true });
  const terrainTab = page.getByRole('button', { name: 'Show terrain toolbox', exact: true });
  expect((await terrainTab.boundingBox())!.y - (await awcTab.boundingBox())!.y).toBe(48);
  await expect(page.getByRole('combobox', { name: 'Forecast overlay', exact: true })).toHaveCount(0);
  const tabs = page.getByRole('tablist', { name: 'AWC weather products' });
  await expect(tabs.getByRole('tab')).toHaveText(['Advis.', 'Progs', 'Radar', 'Cloud', 'Icing', 'Winds']);
  await tabs.getByRole('tab', { name: 'Advisories', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tabpanel', { name: 'Progs', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tabpanel', { name: 'Radar', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tabpanel', { name: 'Cloud', exact: true })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tabpanel', { name: 'Winds', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tabpanel', { name: 'Icing', exact: true })).toBeVisible();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tabpanel', { name: 'Advisories', exact: true })).toBeVisible();
  expect(await page.locator('.map-edge-awc .awc-time-mark').evaluateAll(elements => elements.map(e => e.getAttribute('title')))).toEqual([
    'Now', 'Sep 22 · 23:00Z', 'Sep 23 · 00:00Z', 'Sep 23 · 03:00Z', 'Sep 23 · 06:00Z', 'Sep 23 · 09:00Z',
  ]);
  const slider = page.getByRole('slider', { name: 'Weather forecast time' });
  await slider.scrollIntoViewIfNeeded();
  // Put the 03Z track position inside the scrollable viewport before tapping.
  await page.locator('.awc-time-scroll').evaluate(e => { e.scrollLeft = 0; });
  const track = (await slider.boundingBox())!;
  await page.mouse.click(track.x + 8 + (track.width - 16) * 0.5, track.y + track.height / 2);
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 23 · 03:00Z');
  await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 23 · 06:00Z');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true })).toBeFocused();
  await expect(page.getByRole('region', { name: 'AWC Weather toolbox' })).toBeHidden();
  await terrainTab.click();
  await page.getByRole('button', { name: 'Hide terrain toolbox', exact: true }).click();
  await page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true }).click();
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sep 23 · 06:00Z');
  await page.getByRole('checkbox', { name: 'G-AIRMET', exact: true }).uncheck();
  await expect(slider).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Now', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('.map-edge-awc .awc-time-mark').evaluateAll(elements => elements.map(e => e.getAttribute('title')))).toEqual(['Now', 'Sep 22 · 23:00Z']);
  for (const name of ['SIGMET', 'Convective SIGMET', 'CWA']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
  await expect(slider).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next weather time' })).toBeDisabled();
  await expect(page.locator('.map-edge-awc .awc-time-mark')).toHaveText(['Now']);
  await page.getByRole('checkbox', { name: 'Freezing contours', exact: true }).check();
  await expect(slider).toBeEnabled();
  await page.getByLabel('Open map layers', { exact: true }).click();
  const awc = page.locator('.layer-section').filter({ has: page.getByRole('heading', { name: 'AWC Weather', exact: true }) });
  await expect(awc.getByRole('switch', { name: /Forecasts & advisories/ })).toBeChecked();
  await expect(awc.getByRole('checkbox')).toHaveCount(0);
});

for (const [width, height] of [[320, 568], [568, 320], [744, 1133]] as const) {
  test(`weather toolbox controls and status remain reachable at ${width}×${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await enable(page);
    const map = (await page.getByLabel('Aviation chart map').boundingBox())!;
    const body = page.locator('.map-edge-awc .edge-panel-body');
    const box = (await body.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(map.x);
    expect(box.x + box.width).toBeLessThanOrEqual(map.x + map.width);
    expect(box.y).toBeGreaterThanOrEqual(map.y);
    expect(box.y + box.height).toBeLessThanOrEqual(map.y + map.height);
    await page.locator('.awc-source-status > summary').click();
    await page.getByRole('button', { name: 'Next weather time' }).click();
    await expect(page.getByRole('button', { name: 'Now', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('slider', { name: 'Weather forecast time' })).toHaveAttribute('aria-valuetext', 'Sep 22 · 23:00Z');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('checkbox', { name: 'Convective SIGMET', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Convective SIGMET', exact: true }).check();
    await page.locator('.awc-hazards > summary').click();
    await page.getByRole('checkbox', { name: 'Surface wind / wind shear', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Surface wind / wind shear', exact: true }).check();
    await page.locator('.awc-source-status > summary').click();
    const link = page.getByRole('link', { name: 'NOAA / Aviation Weather Center' });
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport();
    expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('awc-status.png'), animations: 'disabled' });
    await body.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath('awc-toolbox.png'), animations: 'disabled' });
    for (const [name, fields] of [
      ['Cloud', ['None', 'Cloud coverage', 'Cloud bases', 'Cloud tops']],
      ['Icing', ['None', 'Icing probability', 'Icing severity', 'SLD potential', 'Lowest freezing height', 'Highest freezing height']],
    ] as const) {
      const tab = page.getByRole('tab', { name, exact: true });
      await tab.click();
      await expect(page.getByRole('combobox', { name: 'Forecast overlay', exact: true }).locator('option')).toHaveText(fields);
      await expect(page.getByRole('group', { name: 'Advisory products', exact: true })).toHaveCount(0);
      await expect(page.getByRole('slider', { name: 'Weather forecast time' })).toHaveAttribute('aria-valuetext', 'Sep 22 · 23:00Z');
      const panelBody = page.locator('.map-edge-awc.is-open .edge-panel-body');
      const forecast = page.getByRole('combobox', { name: 'Forecast overlay', exact: true });
      await forecast.scrollIntoViewIfNeeded();
      await expect(forecast).toBeInViewport();
      expect(await panelBody.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await panelBody.evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`awc-${name.toLowerCase()}-toolbox.png`), animations: 'disabled' });
    }
    await page.getByRole('button', { name: 'Hide AWC Weather toolbox', exact: true }).click();
  });
}
