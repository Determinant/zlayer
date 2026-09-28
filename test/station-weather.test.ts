import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { MetarFeature, TafReport } from '@zlayer/contracts';
import { Hooks, hookModule } from './helpers/hooks';
import { metarReportSummary } from '../src/layers/metar-taf/metar/summary';
import { tafReportSummary } from '../src/layers/metar-taf/taf/summary';
import type { ReportStatus } from '../src/layers/metar-taf/station-weather';

const react = hookModule + encodeURIComponent('\nexport const useEffectEvent = fn => { const ref = useRef(fn); ref.current = fn; return (...args) => ref.current(...args); };');
const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' && String(context.parentURL).endsWith('/station-weather.tsx') ? { url: react, shortCircuit: true } : next(specifier, context);
} });
const { StationWeather } = await import('../src/layers/metar-taf/station-weather');
loader.deregister();

for (const name of ['METAR', 'TAF'] as const) test(`${name} activity follows source-check age and clock rollback`, async t => {
  const now = Date.parse('2026-09-27T19:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now });
  const hooks = new Hooks();
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const online = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  Object.assign(globalThis, { testHooks: hooks,
    window: Object.assign(new EventTarget(), { setInterval, clearInterval }),
    document: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  t.after(() => {
    hooks.unmount(); globalThis.window = previousWindow; globalThis.document = previousDocument;
    if (online) Object.defineProperty(navigator, 'onLine', online); else Reflect.deleteProperty(navigator, 'onLine');
  });
  const metar: MetarFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { id: 'KSFO', obsTime: now / 1000, rawOb: 'METAR KSFO TEST' } };
  const taf: TafReport = { icaoId: 'KSFO', issueTime: new Date(now - 3600000).toISOString(),
    validTimeFrom: now / 1000, validTimeTo: now / 1000 + 86400, rawTAF: 'TAF KSFO TEST', fcsts: [] };
  let ownReads = 0, nearbyReads = 0;
  let checkedAt = now, update: (() => void) | undefined, status: ReportStatus | undefined;
  const report = name === 'METAR' ? metar : taf;
  const client = { get: () => { ownReads++; return { report, checkedAt }; }, nearby: () => { nearbyReads++; return []; }, nearbyStatus: () => undefined,
    refreshNearby: async () => {}, subscribe: (listener: () => void) => { update = listener; return () => { update = undefined; }; } };
  const summarize = (entry: { checkedAt?: number } | undefined, time: number) => name === 'METAR'
    ? metarReportSummary({ ...entry, report: metar }, time) : tafReportSummary({ ...entry, report: taf }, time);
  const render = () => hooks.render(() => StationWeather({
    feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] }, properties: { kind: 'landing-facility', icaoId: 'KSFO' } },
    client, name, intervalMs: name === 'METAR' ? 60000 : 300000, refreshStation: async () => {}, summarize,
    View: () => null, onStatus: (_name, next) => { status = next; },
  }));
  render(); t.mock.timers.tick(0); await new Promise(resolve => setImmediate(resolve)); render(); assert.equal(status, 'ready');
  t.mock.timers.tick(name === 'METAR' ? 120000 : 330000);
  await new Promise(resolve => setImmediate(resolve));
  render(); assert.equal(status, 'cached', 'an unexpired report with an old source check is cached');
  checkedAt = Date.now(); update?.(); render(); assert.equal(status, 'ready');
  t.mock.timers.setTime(Date.now() - 30000); update?.(); render();
  assert.equal(status, 'cached', 'a check in the future is unverified after rollback');
  assert.equal(nearbyReads, 0, 'a current local report needs no nearby cache scan');
  Object.assign(document, { visibilityState: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
  const hiddenReads = ownReads;
  t.mock.timers.tick(60000);
  checkedAt = Date.now(); update?.(); render();
  assert.equal(ownReads, hiddenReads, 'hidden timers and cache publications do not read the report');
  assert.equal(status, 'cached', 'hidden cards do not perform display updates');
  Object.assign(document, { visibilityState: 'visible' }); document.dispatchEvent(new Event('visibilitychange'));
  render(); assert.equal(status, 'ready', 'resume immediately reads the current cache');
});
