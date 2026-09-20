import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TafReport } from '@zlayer/contracts';
import { emptyRoutePlan } from '@zlayer/domain';
import { TafReportView } from '../src/layers/metar-taf/taf/report';
import { MetarClient } from '../src/layers/metar-taf/metar/client';
import { FeatureDetailsPanel } from '../src/workspace/feature-details-panel';

const now = Date.parse('2026-09-17T19:00:00Z');
const report: TafReport = { icaoId: 'KSFO', issueTime: '2026-09-17T18:00:00Z',
  validTimeFrom: now / 1000, validTimeTo: now / 1000 + 86400, rawTAF: 'TAF KSFO TEST', fcsts: [] };

test('TAF status distinguishes unavailable, offline, cached, expired and cancelled forecasts', () => {
  const html = (overrides: Partial<Parameters<typeof TafReportView>[0]>) => renderToStaticMarkup(createElement(TafReportView, {
    entry: undefined, loading: false, online: true, now, ...overrides,
  }));
  assert.match(html({ loading: true }), /Loading TAF/);
  assert.match(html({}), /No TAF available for this airport/);
  assert.match(html({ online: false }), /No saved TAF · Offline/);
  assert.match(html({ entry: { error: '503' } }), /Refresh failed/);
  assert.match(html({ entry: { report } }), /Cached forecast/);
  assert.match(html({ entry: { report, checkedAt: now, error: '503' } }), /Refresh unavailable/);
  assert.match(html({ entry: { report, checkedAt: now }, now: now + 86400_000 }), /Expired forecast/);
  assert.match(html({ entry: { report: { ...report, rawTAF: 'TAF KSFO CNL' }, checkedAt: now } }), /Forecast cancelled/);
  assert.match(html({ entry: { report: { ...report, rawTAF: 'TAF KSFO NIL' }, checkedAt: now } }), /No forecast issued/);
});

test('airport details put TAF immediately after METAR, and fixes have neither weather section', () => {
  const html = (kind: string) => renderToStaticMarkup(createElement(FeatureDetailsPanel, {
      onIdentificationChange() {},
    feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
      properties: { kind, icaoId: 'KSFO', metarObservedAt: '2026-09-17T18:56:00Z', rawMetar: 'METAR KSFO TEST' } },
    metarClient: new MetarClient(new URL('https://example.test/metars')), procedureResource: undefined, revision: 'test',
    route: { plan: emptyRoutePlan(), update() {} }, onClose() {}, onOpenProcedure() {},
  }));
  assert.match(html('landing-facility'), /<section[^>]+aria-label="METAR"[\s\S]*?<\/section><section[^>]+aria-label="TAF"/);
  assert.ok(!html('fix').includes('aria-label="TAF"'));
  assert.ok(!html('fix').includes('aria-label="METAR"'));
});
