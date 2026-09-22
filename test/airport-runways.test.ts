import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GeoPointFeature } from '@zlayer/contracts';
import { AirportRunways } from '../src/layers/navigation/airport-runways';
import { RunwayWind, RunwayWindNotes } from '../src/layers/metar-taf';

function renderRunways(feature: GeoPointFeature) {
  return renderToStaticMarkup(createElement(AirportRunways, { feature, weather: {
    notes: createElement(RunwayWindNotes, { properties: feature.properties }),
    wind: heading => createElement(RunwayWind, { heading, properties: feature.properties }),
  } }));
}

const feature: GeoPointFeature = {
  type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
  properties: {
    metarWindDirection: 180, metarWindSpeedKt: 10, metarWindGustKt: 20,
    runways: [{ id: '09/27', lengthFt: 4000, widthFt: 75, surface: 'ASPH', ends: [
      { id: '09', trueHeadingDeg: 90, trafficPattern: 'left' },
      { id: '27', trueHeadingDeg: 270, trafficPattern: 'right' },
    ] }],
  },
};

test('airport runways show each published pattern, dimensions, crosswind side and gusts', () => {
  const html = renderRunways(feature);
  for (const value of ['4,000 × 75 ft', 'Left traffic', 'Right traffic', '090°T',
    'Crosswind from right', 'Crosswind from left', 'Wind <span>(kt)</span>', ' G20']) {
    assert.ok(html.includes(value), value);
  }
  assert.ok(!html.includes('Wind 180°T 10G20 kt'), 'the Info table already shows the METAR wind');
});

test('unspecified runway patterns default left without inventing true headings or wind components', () => {
  const html = renderRunways({
    ...feature, properties: { ...feature.properties, runways: [{ id: '09/27' }, { id: 'H1' }] },
  });
  assert.equal((html.match(/Left traffic \(default; AIM 4-3-3\)/g) ?? []).length, 2);
  assert.ok(!html.includes('Not published'));
  assert.ok(!html.includes('Right traffic'));
  assert.ok(html.includes('Runways &amp; helipads'));
  assert.equal((html.match(/<table/g) ?? []).length, 1, 'only the runway gets a table');
  assert.ok(!html.includes('Pattern not published'), 'helipads do not get a runway pattern');
  assert.ok(html.includes('True heading unavailable'));
  assert.ok(!html.includes('Crosswind from'));
});

test('helipads show their identity, dimensions and surface without runway headings, patterns or wind components', () => {
  for (const ends of [undefined, [{ id: 'H1', trueHeadingDeg: 90, trafficPattern: 'right' as const }]]) {
    const html = renderRunways({
      ...feature, properties: { ...feature.properties, runways: [{
        id: 'H1', lengthFt: 24, widthFt: 22, surface: 'ASPH', ...(ends ? { ends } : {}),
      }] },
    });
    assert.ok(html.includes('<h3>Helipads</h3>'));
    assert.ok(html.includes('<strong>H1</strong>'));
    assert.ok(html.includes('Helipad · 24 × 22 ft · ASPH'));
    for (const value of ['<table', 'Pattern', '°T', 'True heading unavailable', 'Wind', 'Cross', 'gust']) {
      assert.ok(!html.includes(value), `helipad must not show ${value}`);
    }
  }
});

test('variable METAR directions remain explicit in runway information', () => {
  const html = renderRunways({
    ...feature, properties: { ...feature.properties, metarWindDirection: 'VRB' },
  });
  assert.ok(html.includes('Variable direction · components unavailable'));
  assert.ok(!html.includes('Crosswind from'));
});


test('omitting the weather contribution keeps runway metadata without cached wind UI', () => {
  const html = renderToStaticMarkup(createElement(AirportRunways, { feature }));
  for (const value of ['4,000 × 75 ft', 'Left traffic', 'Right traffic', '090°T']) assert.ok(html.includes(value));
  for (const value of ['Wind', 'Crosswind', 'Headwind', 'Tailwind', ' G20']) assert.ok(!html.includes(value), value);
});
