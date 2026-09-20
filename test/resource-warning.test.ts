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
    const onError = useCallback((message: string, code?: ResourceErrorCode) => warnings.report('Chart unavailable', message, code), [warnings.report]);
    useChartCache(undefined, onError);
    return warnings;
  });
  const chartError = (message: string, url = 'https://charts.test/a.mbtiles', code?: ResourceErrorCode) => {
    serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'chart-archive-error', url, message, code } }));
  };
  return { render, connection, chartError };
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

test('one dismissal covers repeated map and chart requests across URLs and reconnection', t => {
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
  assert.equal(render().warning, undefined);
});

test('dismissing a chart warning also suppresses subsequent map fetch failures', t => {
  const { render, chartError } = setup(t);
  render();
  chartError('Failed to fetch');
  assert.equal(render().warning?.title, 'Chart unavailable');
  render().dismiss();
  render().clear();
  render().report('Map layer unavailable', 'chart: Unable to load chart package: 503');
  chartError('Load failed', 'https://charts.test/another.mbtiles');
  assert.equal(render().warning, undefined);
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
