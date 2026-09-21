import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GeoPointFeature } from '@zlayer/contracts';
import { emptyRoutePlan } from '@zlayer/domain';
import { MetarClient } from '../src/layers/metar-taf/metar/client';
import { FeatureDetailsPanel } from '../src/workspace/feature-details-panel';
import { createRouteRemovalResolver } from './helpers/route-removal';

test('airport and fix headers offer one clearly labelled append-to-route action beside the identifier', () => {
  const cases = [
    { properties: { kind: 'landing-facility', icaoId: 'KHWD', faaId: 'HWD' }, ident: 'KHWD' },
    { properties: { kind: 'landing-facility', faaId: '0Q3' }, ident: '0Q3' },
    { properties: { kind: 'fix', ident: 'SUNOL' }, ident: 'SUNOL' },
    { properties: { kind: 'coordinate', ident: '374529N1223030W', name: 'GPS waypoint' },
      ident: '374529N1223030W', label: '37°45′N 122°30′W' },
  ];
  for (const { properties, ident, label = ident } of cases) {
    const feature: GeoPointFeature = {
      type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] }, properties,
    };
    const html = renderToStaticMarkup(createElement(FeatureDetailsPanel, {
      onIdentificationChange() {},
      feature, metarClient: new MetarClient(new URL('https://example.test/metars')), procedureResource: undefined, revision: '2026-09-03',
      route: { plan: emptyRoutePlan(), update() {} }, onClose: () => {}, onOpenProcedure: () => {},
    }));
    const heading = html.match(/<div class="feature-card-heading">(.*?)<\/div>/)?.[1];
    assert.ok(heading, `${ident} has a heading row`);
    assert.ok(heading.includes(`>${label}</h2>`));
    if (properties.kind === 'coordinate') {
      assert.ok(html.includes('37°45′29″N 122°30′30″W'), 'fix info retains the saved seconds rather than rounded map geometry');
    }
    const actionLabel = `aria-label="Add ${ident} to end of route"`;
    const action = heading.match(/<button\b[^>]*>/g)?.find(button => button.includes(actionLabel));
    assert.ok(action?.includes('type="button"'), 'a named button belongs beside the identifier');
    assert.equal(html.split(actionLabel).length - 1, 1, 'the append action is not duplicated elsewhere');
  }
});

test('the shared panel derives add and remove actions from route membership for every feature type', () => {
  const plan = createRouteRemovalResolver()('KSBA TAILS CMA VPTEST 350000N1190000W KSMX');
  for (const { ident, feature } of plan.waypoints) {
    const render = (onRoute: boolean) => renderToStaticMarkup(createElement(FeatureDetailsPanel, {
      onIdentificationChange() {},
      feature, metarClient: new MetarClient(new URL('https://example.test/metars')), procedureResource: undefined, revision: 'test',
      route: { plan: onRoute ? plan : emptyRoutePlan(), update() {} }, onClose() {}, onOpenProcedure() {},
    }));
    const html = render(true);
    const buttons = html.split('<div class="feature-card-header">')[0]!
      .split('<div class="feature-card-heading">')[1]!.match(/<button\b[^>]*>/g)!;
    assert.equal(buttons.length, 3);
    assert.ok(buttons[0]!.includes(`aria-label="Remove ${ident} from route"`));
    assert.ok(buttons[1]!.includes(`aria-label="Add ${ident} to end of route"`));
    assert.ok(buttons[2]!.includes(`aria-label="Identify ${ident} with nearby navaids"`));
    assert.equal(render(false).includes(`Remove ${ident} from route`), false);
  }
});

test('plates retain their airport and legacy FAA-ID eligibility independently of weather sections', () => {
  const cases = [
    { properties: { kind: 'airport', icaoId: 'KSNS' }, plates: true, taf: true },
    { properties: { kind: 'landing-facility', faaId: 'SNS' }, plates: true, taf: true },
    { properties: { kind: 'landing-facility', icaoId: 'KSNS' }, plates: false, taf: true },
    { properties: { faaId: 'SNS' }, plates: true, taf: false },
    { properties: { kind: 'navaid', ident: 'SNS' }, plates: false, taf: false },
    { properties: { kind: 'fix', ident: 'SNS' }, plates: false, taf: false },
  ];
  for (const { properties, plates, taf } of cases) {
    const html = renderToStaticMarkup(createElement(FeatureDetailsPanel, {
      onIdentificationChange() {},
      feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] }, properties },
      metarClient: new MetarClient(new URL('https://example.test/metars')), procedureResource: undefined, revision: 'test',
      route: { plan: emptyRoutePlan(), update() {} }, onClose() {}, onOpenProcedure() {},
    }));
    assert.equal(html.includes('aria-label="Airport detail"'), plates);
    assert.equal(html.includes('aria-label="TAF"'), taf);
  }
});
