import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Hooks, hookModule } from './helpers/hooks';
import type { ResourceErrorCode } from '../src/core/data/errors';

const moduleUrl = (source: string) => 'data:text/javascript,' + encodeURIComponent(source);
const react = moduleUrl(`export * from ${JSON.stringify(hookModule)};
  export const useCallback = (callback, dependencies) => globalThis.testHooks.useMemo(() => callback, dependencies);`);
const loader = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react') return { url: react, shortCircuit: true };
  if (specifier === '../../pwa') return { url: moduleUrl('export const preparePwa = async () => true;'), shortCircuit: true };
  return next(specifier, context);
} });
const { useCallback } = await import('react');
const { useNotifications } = await import('../src/shell/use-notifications');
const { useResourceWarning } = await import('../src/shell/use-resource-warning');
const { useChartCache } = await import('../src/layers/charts/use-cache');
loader.deregister();

function setup(t: test.TestContext, online = true) {
  const hooks = new Hooks();
  Object.assign(globalThis, { testHooks: hooks });
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const serviceWorker = new EventTarget();
  const connection = { onLine: online, serviceWorker };
  globalThis.window = new EventTarget() as Window & typeof globalThis;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: connection });
  t.after(() => {
    hooks.unmount();
    globalThis.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const render = () => hooks.render(() => {
    const warnings = useResourceWarning(connection.onLine);
    const onError = useCallback((message: string, code?: ResourceErrorCode, url?: string) =>
      warnings.report('Chart unavailable', message, code, url), [warnings.report]);
    const onRecovered = useCallback((url: string) => warnings.recover('Chart unavailable', url), [warnings.recover]);
    useChartCache(undefined, onError, true, onRecovered);
    const notifications = useNotifications(warnings.warning ? [{ id: 'resource', ...warnings.warning }] : []);
    return { ...warnings, warning: notifications.visible.length ? warnings.warning : undefined,
      notices: notifications.notices, dismiss: () => notifications.dismiss(notifications.notices[0]!) };
  });
  const chartError = (message: string, url = 'https://charts.test/a.mbtiles', code?: ResourceErrorCode) => {
    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'chart-archive-error', url, message, code } }));
  };
  const chartReady = (url = 'https://charts.test/a.mbtiles') => {
    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'chart-archive-ready', url } }));
  };
  return { render, connection, chartError, chartReady };
}

test('offline tile and uncached chart failures stay quiet, including worker messages', t => {
  const { render, chartError } = setup(t, false);
  const warnings = render();
  for (const message of ['basemap: Failed to fetch', 'Map: Load failed',
    'relief: NetworkError when attempting to fetch resource.',
    'chart: Unable to load chart package: 503', 'Map: AJAXError:  (0): https://tiles.test/1',
    "chart: Couldn't load https://charts.test/sheet.mbtiles. Status: 503",
    'Map: AJAXError: Service Unavailable (503): https://tiles.test/507/1/2',
    "chart: Failed to execute 'send' on 'XMLHttpRequest': Failed to load 'https://charts.test/sheet.mbtiles'."]) {
    warnings.report('Map layer unavailable', message);
    assert.equal(render().warning, undefined);
  }
  chartError('Failed to fetch');
  assert.equal(render().warning, undefined);
});

test('typed worker failures are classified by code independently of their display text', t => {
  const { render, chartError } = setup(t, false);
  render();
  chartError('The origin cannot be reached', undefined, 'request');
  assert.equal(render().warning, undefined);
  chartError('Failed to fetch a valid receipt', undefined, 'invalid-data');
  assert.ok(render().warning, 'an integrity failure stays visible even when its wording contains a network phrase');
});

test('one dismissal covers repeated map and chart requests until connectivity resets the condition', t => {
  const { render, connection, chartError } = setup(t);
  render().report('Map layer unavailable', 'basemap: Failed to fetch');
  assert.equal(render().warning?.title, 'Map layer unavailable');
  render().dismiss();
  render().report('Map layer unavailable', 'relief: AJAXError: Service Unavailable (503): https://tiles.test/2');
  render().report('Map layer unavailable', "chart: Couldn't load https://charts.test/sheet.mbtiles. Status: 503");
  chartError('Failed to fetch');
  chartError('Unable to cache chart archive: 503', 'https://charts.test/b.mbtiles');
  assert.equal(render().warning, undefined);
  connection.onLine = false;
  render();
  connection.onLine = true;
  render().report('Map layer unavailable', 'basemap: Load failed');
  assert.ok(render().warning, 'a new failure after reconnect is a new occurrence');
});

test('dismissing a chart warning retains its details and recovery clears the notice', t => {
  const { render, chartError } = setup(t);
  render();
  chartError('Failed to fetch');
  assert.equal(render().warning?.title, 'Chart unavailable');
  render().dismiss();
  assert.match(render().notices[0]!.message, /Failed to fetch/);
  render().report('Map layer unavailable', 'chart: Unable to load chart package: 503');
  chartError('Load failed', 'https://charts.test/another.mbtiles');
  assert.equal(render().warning, undefined);
  render().clear();
  assert.equal(render().notices.length, 0);
});

test('going offline clears an existing fetch warning without replaying it on reconnect', t => {
  const { render, connection } = setup(t);
  const warnings = render();
  warnings.report('Map layer unavailable', 'basemap: Failed to fetch');
  assert.ok(render().warning);
  connection.onLine = false;
  // A callback from the previous render must read the current connection state.
  warnings.report('Map layer unavailable', 'relief: Load failed');
  assert.equal(render().warning, undefined);
  connection.onLine = true;
  assert.equal(render().warning, undefined);
  render().report('Map layer unavailable', 'basemap: Failed to fetch');
  assert.ok(render().warning, 'a new online failure still warns unless explicitly dismissed');
});

test('storage, integrity and rendering errors remain visible and independently dismissible', t => {
  const { render, connection, chartError } = setup(t);
  render().report('Map layer unavailable', 'basemap: Failed to fetch');
  render().dismiss();
  connection.onLine = false;
  for (const message of ['QuotaExceededError: Storage is full', 'Chart archive SHA-256 mismatch']) {
    chartError(message);
    assert.ok(render().warning?.message.includes(message));
    render().dismiss();
    chartError(message);
    assert.equal(render().warning, undefined);
    render().clear();
    render();
  }
  render().report('Map layer unavailable', 'Unable to load chart package: 507');
  assert.ok(render().warning?.message.includes('507'));
  render().dismiss();
  render().report('Map layer unavailable', 'Unable to create WebGL map.');
  assert.equal(render().warning?.message, 'Unable to create WebGL map.');
});

test('a stream of failed tiles does not replace an actionable warning', t => {
  const { render, chartError } = setup(t);
  render();
  chartError('Chart archive SHA-256 mismatch');
  render().report('Map layer unavailable', 'basemap: Failed to fetch');
  assert.ok(render().warning?.message.includes('SHA-256 mismatch'));
});

test('confirmed tile recovery removes its dismissed notice and allows a later failure to surface', t => {
  const { render } = setup(t);
  const message = 'zlayer-basemap: Failed to fetch';
  render().report('Map layer unavailable', message);
  render().dismiss();
  assert.equal(render().notices.length, 1);
  render().recover('Map layer unavailable', 'other-source: Failed to fetch');
  assert.equal(render().notices.length, 1);
  render().recover('Map layer unavailable', message);
  assert.equal(render().notices.length, 0);
  render().report('Map layer unavailable', message);
  assert.ok(render().warning);
});

test('late map tile recovery preserves chart warnings and non-request failures', t => {
  const { render, chartError } = setup(t);
  const message = 'zlayer-basemap: Failed to fetch';
  render();
  chartError(message);
  render().recover('Map layer unavailable', message);
  assert.equal(render().warning?.title, 'Chart unavailable');
  render().report('Map layer unavailable', message, 'invalid-data');
  render().recover('Map layer unavailable', message);
  assert.ok(render().warning);
});

test('VFR/IFR archive recovery uses exact resource identity and preserves other pending failures and dismissal', t => {
  const { render, chartError, chartReady } = setup(t);
  const vfr = 'https://charts.test/vfr.mbtiles?sha256=old', ifr = 'https://charts.test/ifr.mbtiles?sha256=old';
  render();
  chartError('Failed to fetch VFR', vfr);
  chartError('Failed to fetch IFR', ifr);
  render().dismiss();
  chartReady('https://charts.test/vfr.mbtiles?sha256=new');
  assert.match(render().notices[0]!.message, /VFR/);
  chartReady(vfr);
  assert.match(render().notices[0]!.message, /IFR/, 'IFR is still unavailable after VFR recovers');
  assert.equal(render().warning, undefined, 'dismissal covers the continuing request condition');
  render().report('Map layer unavailable', 'basemap: Failed to fetch');
  chartReady(ifr);
  assert.match(render().notices[0]!.message, /basemap/);
  render().recover('Map layer unavailable', 'basemap: Failed to fetch');
  assert.equal(render().notices.length, 0);
  chartError('Failed to fetch IFR', ifr);
  assert.ok(render().warning, 'a later outage is a new occurrence');
});

test('archive availability does not dismiss storage or integrity warnings', t => {
  const { render, chartError, chartReady } = setup(t);
  render();
  chartError('Storage unavailable', undefined, 'storage');
  chartReady();
  assert.match(render().warning!.message, /Storage unavailable/);
  chartError('Checksum mismatch', undefined, 'invalid-data');
  chartReady();
  assert.match(render().warning!.message, /Checksum mismatch/);
});

test('one source warning survives a tile-error storm and clears independently with its source', t => {
  const { render } = setup(t);
  const first = 'zlayer-basemap: AJAXError: Service Unavailable (503): https://tiles.test/0';
  render().report('Map layer unavailable', first, 'http', 'zlayer-basemap');
  render().dismiss();
  const report = render().report;
  for (let i = 1; i < 5000; i++) report('Map layer unavailable',
    `zlayer-basemap: AJAXError: Service Unavailable (503): https://tiles.test/${i}`, 'http', 'zlayer-basemap');
  report('Map layer unavailable', 'terrain: Failed to fetch', 'request', 'terrain');
  assert.equal(render().notices[0]!.message, first, 'the representative message remains stable');
  assert.equal(render().warning, undefined, 'changing tile URLs cannot reset dismissal');
  render().recover('Map layer unavailable', 'zlayer-basemap');
  assert.equal(render().notices[0]!.message, 'terrain: Failed to fetch', 'one recovery retires every failure from that source');
  render().recover('Map layer unavailable', 'terrain');
  assert.equal(render().notices.length, 0);
  report('Map layer unavailable', first, 'http', 'zlayer-basemap');
  assert.ok(render().warning, 'a new source failure can surface again');
});
