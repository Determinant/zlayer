import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRouteResolver, emptyRoutePlan } from '@zlayer/domain';

// Browser tests cover the styles; the server-rendering checks only need the markup.
const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier.endsWith('.css') ? { url: 'data:text/javascript,export{}', shortCircuit: true } : next(specifier, context);
} });
const { RouteBar } = await import('../src/layers/routes/bar');
loader.deregister();

const noop = () => {};

test('procedure tokens retain filing text and explain the transition and preview limitations', () => {
  const plan = { ...emptyRoutePlan('KSJC SPTNS1 VLREE'), procedures: [{ tokenIndex: 1, ident: 'SPTNS1',
    kind: 'departure' as const, airport: 'SJC', transition: 'VLREE', points: [], partial: false }] };
  const html = renderToStaticMarkup(createElement(RouteBar, { ...props, plan }));
  assert.match(html, /SPTNS1 · SID · SJC · VLREE transition · waypoint preview/);
  assert.match(html, /<strong>SPTNS1<\/strong>/);
  assert.match(html, /airport connections, vectors, turn paths and constraints are not depicted/);
});
const props: ComponentProps<typeof RouteBar> = {
  plan: emptyRoutePlan('KSFO BAD KSJC'), status: 'ready',
  catalog: { schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-16T00:00:00Z', charts: [], navigation: [], weather: [] },
  onUseRoute: noop, onAppendInput: noop, onInsertInput: noop, onReplaceInput: noop, onRemoveEntry: noop,
  onMoveEntry: noop, onClear: noop, onFit: noop,
};

test('route tokens show only their identifier while retaining accessible actions', () => {
  const html = renderToStaticMarkup(createElement(RouteBar, props));
  const tokens = [...html.matchAll(/<button\b(?=[^>]*\bclass="route-token\b)[^>]*>(.*?)<\/button>/g)];
  assert.deepEqual(tokens.map(match => match[1]), ['<strong>KSFO</strong>', '<strong>BAD</strong>', '<strong>KSJC</strong>']);
  for (const [token] of tokens) {
    assert.match(token, /aria-haspopup="menu"/);
    assert.match(token, /Drag to reorder; open context menu for actions/);
  }
});

test('GPS tokens resolve while named tokens stay pending until navigation loading finishes', () => {
  const plan = createRouteResolver([])('350000N1190535W TEST 360000N1200000W');
  const loading = renderToStaticMarkup(createElement(RouteBar, { ...props, plan, status: 'loading' }));
  assert.match(loading, /TEST · Resolving route entry/);
  assert.doesNotMatch(loading, /aria-invalid="true"/);
  assert.doesNotMatch(loading, /350000N1190535W · Resolving route entry/);
  assert.doesNotMatch(loading, /<button[^>]*disabled=""[^>]*aria-label="Fit route on map"/);
  const failed = renderToStaticMarkup(createElement(RouteBar, { ...props, plan, status: 'error' }));
  assert.match(failed, /TEST · Invalid or unknown route entry/);
});

test('TEC stays one route token with published restrictions in expandable details', () => {
  const plan = { ...emptyRoutePlan('KSNA CSTQ1 KBUR'), distanceNm: 80, tecRoutes: [{ tokenIndex: 1, route: {
    id: 'preferred-route:SNA:BUR:TEC:1', originId: 'SNA', destinationId: 'BUR', routeType: 'TEC', routeNumber: 1,
    designator: 'CSTQ1', route: 'SLI V23 POPPR SMO SILEX', altitude: 'PQ40', segments: [],
  } }] };
  const html = renderToStaticMarkup(createElement(RouteBar, { ...props, plan }));
  const tokens = [...html.matchAll(/<button\b(?=[^>]*\bclass="route-token\b)[^>]*>(.*?)<\/button>/g)];
  assert.deepEqual(tokens.map(match => match[1]), ['<strong>KSNA</strong>', '<strong>CSTQ1</strong>', '<strong>KBUR</strong>']);
  assert.match(html, /CSTQ1 · TEC · SNA → BUR/);
  assert.match(html, /<details class="route-summary">/);
  assert.match(html, /aria-label="TEC route details and published conditions"/);
  assert.match(html, /CSTQ1: SLI V23 POPPR SMO SILEX/);
  assert.match(html, /Altitude: PQ40/);
  assert.match(html, /eligibility and ATC clearance are not verified/);
});

test('route errors have an accessible expandable control containing every explanation', () => {
  const plan = { ...props.plan, issues: [
    { tokenIndex: 1, token: 'BAD', code: 'waypoint-not-found' as const, message: 'BAD is not a known waypoint' },
    { tokenIndex: 2, token: 'V25', code: 'airway-no-path' as const, message: 'V25 does not connect the selected endpoints' },
  ] };
  const html = renderToStaticMarkup(createElement(RouteBar, { ...props, plan }));
  assert.match(html, /<details class="route-summary is-error">/);
  assert.match(html, /<summary aria-label="Route issues \(2\): BAD is not a known waypoint"/);
  assert.match(html, /<li>BAD is not a known waypoint<\/li>/);
  assert.match(html, /<li>V25 does not connect the selected endpoints<\/li>/);
});

test('partial and unavailable route data show an actionable warning even without token errors', () => {
  const partial = renderToStaticMarkup(createElement(RouteBar, { ...props, status: 'partial' }));
  assert.match(partial, /Some route data is unavailable; the route may be incomplete/);
  const unavailable = renderToStaticMarkup(createElement(RouteBar, { ...props, status: 'error' }));
  assert.match(unavailable, /Connect to download the FAA index/);
});
