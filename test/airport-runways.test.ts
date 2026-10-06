import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GeoPointFeature } from '@zlayer/contracts';
import { windForRunway } from '../src/layers/metar-taf/metar/runway-wind';
import { AirportRunways } from '../src/layers/navigation/airport-runways';
import { RunwayWind, createRunwayWeather, bestWindRunwayEnds } from '../src/layers/metar-taf';

function renderRunways(feature: GeoPointFeature) {
  return renderToStaticMarkup(createElement(AirportRunways, {
    feature, weather: createRunwayWeather(feature.properties),
  }));
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
    'Crosswind from right', 'Crosswind from left', 'Wind <span>(kt)</span>', 'G20']) {
    assert.ok(html.includes(value), value);
  }
  assert.ok(!html.includes('Wind 180°T 10G20 kt'), 'the Info table already shows the METAR wind');
});

test('number-only runways label magnetic estimates and require a magnetic reference for wind', () => {
  const html = renderRunways({
    ...feature, properties: { ...feature.properties, runways: [{ id: '09/27' }, { id: 'H1' }] },
  });
  assert.equal((html.match(/Left traffic \(default; AIM 4-3-3\)/g) ?? []).length, 2);
  assert.ok(!html.includes('Not published'));
  assert.ok(!html.includes('Right traffic'));
  assert.ok(html.includes('Runways &amp; helipads'));
  assert.equal((html.match(/<table/g) ?? []).length, 1, 'only the runway gets a table');
  assert.ok(!html.includes('Pattern not published'), 'helipads do not get a runway pattern');
  assert.ok(html.includes('≈090°M'));
  assert.ok(html.includes('Magnetic reference unavailable'));
  assert.ok(!html.includes('Crosswind from'));
});

test('helipads show their identity, dimensions and surface without runway headings, patterns or wind components', () => {
  for (const ends of [undefined, [{ id: 'H1', trueHeadingDeg: 90, trafficPattern: 'right' as const }]]) {
    const html = renderRunways({
      ...feature, properties: { ...feature.properties, runways: [{
        id: 'H1', lengthFt: 24, widthFt: 22, surface: 'ASPH', ...(ends ? { ends } : {}),
      }] },
    });
    assert.match(html, /<h3\b[^>]*>Helipads<\/h3>/);
    assert.ok(html.includes('<strong>H1</strong>'));
    assert.ok(html.includes('Helipad · 24 × 22 ft · ASPH'));
    for (const value of ['<table', 'Pattern', '°T', 'Runway heading unavailable', 'Wind', 'Cross', 'gust']) {
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
  for (const value of ['Wind', 'Crosswind', 'Headwind', 'Tailwind', ' G20', 'Best Wind']) assert.ok(!html.includes(value), value);
});

test('best wind marks the strongest headwind across runways and follows changes in wind', () => {
  const properties = { ...feature.properties, metarWindDirection: 95, runways: [
    ...feature.properties.runways!,
    { id: '10/28', ends: [{ id: '10', trueHeadingDeg: 100.1 }, { id: '28', trueHeadingDeg: 280.1 }] },
    { id: 'H1', ends: [{ id: 'H1', trueHeadingDeg: 95 }] },
  ] };
  // Both headwinds round to 10 kt, but 09 has the better alignment.
  assert.deepEqual(bestWindRunwayEnds(properties), ['09']);
  const html = renderRunways({ ...feature, properties });
  assert.equal((html.match(/>Best Wind<\/span>/g) ?? []).length, 1);
  assert.deepEqual(bestWindRunwayEnds({ ...properties, metarWindDirection: 275 }), ['27']);
});

test('compact wind arrows describe wind movement and retain accessible component and gust labels', () => {
  const renderWind = (heading: number, direction: number) => renderToStaticMarkup(createElement(RunwayWind, {
    end: { id: '09', trueHeadingDeg: heading }, properties: { metarWindDirection: direction, metarWindSpeedKt: 10, metarWindGustKt: 20 },
  }));
  const fromRight = renderWind(90, 180);
  assert.ok(fromRight.includes('aria-label="Crosswind from right: 10 kt, gust 20 kt"'));
  const fromLeft = renderWind(270, 180);
  assert.ok(fromLeft.includes('aria-label="Crosswind from left: 10 kt, gust 20 kt"'));
  const headwind = renderWind(90, 90);
  assert.ok(headwind.includes('aria-label="Headwind: 10 kt, gust 20 kt"'));
  const tailwind = renderWind(270, 90);
  assert.ok(tailwind.includes('aria-label="Tailwind: 10 kt, gust 20 kt"'));
});

test('best wind preserves parallel and equally aligned ties across north', () => {
  assert.deepEqual(bestWindRunwayEnds({
    metarWindDirection: '360', metarWindSpeedKt: 10, metarWindGustKt: 25,
    runways: [{ id: '35L/17R', ends: [{ id: '35L', trueHeadingDeg: 350 }] },
      { id: '35R/17L', ends: [{ id: '35R', trueHeadingDeg: 350 }] },
      { id: '01/19', ends: [{ id: '01', trueHeadingDeg: 10 }] }],
  }), ['35L', '35R', '01']);
});

test('best wind stays absent without positive directional headwind and a matching heading reference', () => {
  for (const properties of [
    feature.properties, // Direct crosswind on both ends.
    { ...feature.properties, metarWindSpeedKt: 0, metarWindGustKt: null },
    { ...feature.properties, metarWindDirection: 'VRB' },
    { ...feature.properties, metarWindDirection: null },
    { ...feature.properties, metarWindSpeedKt: null },
    { ...feature.properties, metarWindDirection: 90, runways: [{ id: '09/27' }] },
    { ...feature.properties, metarWindDirection: 90, runways: [{ id: '27', ends: [{ id: '27', trueHeadingDeg: 270 }] }] },
    { ...feature.properties, metarWindDirection: 90, runways: [{ id: '09', ends: [{ id: '09', trueHeadingDeg: NaN }] }] },
    { ...feature.properties, metarWindDirection: 90, metarWindSpeedKt: 0 }, // Gust-only report.
  ]) {
    assert.deepEqual(bestWindRunwayEnds(properties), []);
    assert.ok(!renderRunways({ ...feature, properties }).includes('Best Wind'));
  }
});


test('published magnetic runway headings use magnetic wind, including north wrap and reciprocal ends', () => {
  const properties = { metarWindDirection: '055', metarWindSpeedKt: 10, metarWindGustKt: 20,
    runways: [{ id: '04L/22R', ends: [{ id: '04L', magneticHeadingDeg: 43 }, { id: '22R', magneticHeadingDeg: 223 }] }] };
  const end = properties.runways[0]!.ends[0]!;
  const wind = windForRunway(end, properties, 12);
  assert.deepEqual(wind, { kind: 'directional', headwindKt: 10, crosswindKt: 0, gust: { headwindKt: 20, crosswindKt: 0 } });
  assert.deepEqual(windForRunway({ ...end, trueHeadingDeg: 90 }, properties, 12), wind, 'published magnetic heading takes priority');
  assert.deepEqual(bestWindRunwayEnds(properties, 12), ['04L']);
  assert.deepEqual(bestWindRunwayEnds({ ...properties, metarWindDirection: '235' }, 12), ['22R']);
  assert.deepEqual(windForRunway({ id: '35', magneticHeadingDeg: 350 }, { ...properties, metarWindDirection: '002' }, 12), wind);
  const html = renderToStaticMarkup(createElement(AirportRunways, { feature: { ...feature, properties },
    weather: createRunwayWeather(properties, 12) }));
  assert.ok(html.includes('043°M'));
  assert.ok(html.includes('Best Wind'));
  assert.ok(html.includes('Headwind: 10 kt, gust 20 kt'));
});

test('magnetic calculation requires a reference and preserves legacy true pairs', () => {
  const properties = { metarWindDirection: 55, metarWindSpeedKt: 10 };
  const end = { id: '04L', magneticHeadingDeg: 43 };
  for (const declination of [undefined, null, NaN]) {
    assert.deepEqual(windForRunway(end, properties, declination), { kind: 'unavailable', reason: 'heading' });
    const fallback = windForRunway({ ...end, trueHeadingDeg: 55 }, properties, declination);
    assert.equal(fallback.kind, 'directional');
    if (fallback.kind === 'directional') assert.equal(fallback.headwindKt, 10);
  }
  const html = renderToStaticMarkup(createElement(RunwayWind, { end, properties }));
  assert.ok(html.includes('Magnetic reference unavailable'));
  assert.deepEqual(windForRunway(end, { ...properties, metarWindDirection: 400 }, 12), { kind: 'unavailable', reason: 'direction' });
  assert.equal(windForRunway(end, { ...properties, metarWindDirection: 'VRB' }, 12).kind, 'variable');
});


test('number-only legacy runways calculate labeled estimated wind and participate in Best Wind', () => {
  const properties = { metarWindDirection: 55, metarWindSpeedKt: 10, metarWindGustKt: 20,
    runways: [{ id: '04L/22R' }] };
  const snapshot = JSON.stringify(properties);
  const wind = windForRunway({ id: '04L' }, properties, 15);
  assert.deepEqual(wind, { kind: 'directional', headwindKt: 10, crosswindKt: 0, gust: { headwindKt: 20, crosswindKt: 0 } });
  assert.deepEqual(bestWindRunwayEnds(properties, 15), ['04L']);
  assert.deepEqual(bestWindRunwayEnds({ ...properties, metarWindDirection: 235 }, 15), ['22R']);
  const html = renderToStaticMarkup(createElement(AirportRunways, { feature: { ...feature, properties },
    weather: createRunwayWeather(properties, 15) }));
  assert.ok(html.includes('≈040°M'));
  assert.ok(html.includes('≈220°M'));
  assert.ok(html.includes('Heading and wind components estimated from runway number'));
  assert.ok(html.includes('aria-label="Approximate Headwind: 10 kt, gust 20 kt"'));
  assert.ok(html.includes('Best Wind'));
  assert.equal(JSON.stringify(properties), snapshot, 'estimates never overwrite FAA source metadata');
});

test('estimates preserve unavailable, calm, and variable states and never displace published true headings', () => {
  const properties = { metarWindDirection: 55, metarWindSpeedKt: 10 };
  assert.deepEqual(windForRunway({ id: '04', trueHeadingDeg: 55 }, properties, 15),
    { kind: 'directional', headwindKt: 10, crosswindKt: 0 });
  for (const id of ['N', 'H1', '37']) {
    assert.deepEqual(windForRunway({ id }, properties, 15), { kind: 'unavailable', reason: 'heading' });
  }
  assert.deepEqual(windForRunway({ id: '04' }, properties), { kind: 'unavailable', reason: 'heading' });
  assert.equal(windForRunway({ id: '04' }, { ...properties, metarWindSpeedKt: 0 }, 15).kind, 'calm');
  assert.equal(windForRunway({ id: '04' }, { ...properties, metarWindDirection: 'VRB' }, 15).kind, 'variable');
  assert.deepEqual(windForRunway({ id: '04' }, { ...properties, metarWindDirection: 999 }, 15),
    { kind: 'unavailable', reason: 'direction' });
  assert.deepEqual(windForRunway({ id: '36' }, { ...properties, metarWindDirection: 12 }, 12),
    { kind: 'directional', headwindKt: 10, crosswindKt: 0 });
});
