import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isGeoPointFeature, type GeoPointFeature } from '@zlayer/contracts';
import { NearbyNavaids } from '../src/layers/navigation/nearby-navaids';
import { nearbyVorStations } from '@zlayer/domain';

const point: GeoPointFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 1] },
  properties: { kind: 'coordinate', ident: '010000N0000000E' } };
const station: GeoPointFeature = { type: 'Feature', id: 'TEST', geometry: { type: 'Point', coordinates: [0, 0] },
  properties: { kind: 'navaid', type: 'VOR/DME', ident: 'TEST', frequency: '115.8', stationDeclinationDeg: 15 } };

test('nearby references show a prominent MB and separate TB, including when magnetic alignment is missing', () => {
  const render = (navaid: GeoPointFeature) => renderToStaticMarkup(createElement(NearbyNavaids,
    { stations: nearbyVorStations(point.geometry.coordinates, [navaid]) }));
  const html = render(station);
  assert.match(html, /class="navaid-magnetic"[^>]*>MB 345°<\/strong>/);
  assert.match(html, /class="navaid-true"[^>]*>TB 360°<\/small>/);
  assert.match(html, /60\.0/);
  assert.match(html, /115\.8 · VOR\/DME/);
  assert.match(html, /Ground distance/);
  const fallback = render({ ...station, properties: { kind: 'navaid', ident: 'TEST', type: 'VOR/DME' } });
  assert.doesNotMatch(fallback, /MB 360°/);
  assert.match(fallback, /Magnetic bearing unavailable/);
  assert.match(fallback, /station alignment is missing/);
  assert.match(fallback, />MB —<\/strong>/);
  assert.match(fallback, />TB 360°<\/small>/);
});

test('loading, unavailable navigation and no nearby station remain distinct states', () => {
  const render = (navaids: GeoPointFeature[] | undefined, loading = false) =>
    renderToStaticMarkup(createElement(NearbyNavaids,
      { stations: navaids && nearbyVorStations(point.geometry.coordinates, navaids), loading }));
  assert.match(render(undefined, true), /Loading nearby stations/);
  assert.match(render(undefined), /Navaid data unavailable/);
  assert.match(render([]), /No VOR stations within 100 NM/);
});

test('station declination is optional but validates numeric type and range when present', () => {
  for (const value of [0, 15, -15, 180, -180, undefined]) {
    assert.equal(isGeoPointFeature({ ...station, properties: { ...station.properties, stationDeclinationDeg: value } }), true);
  }
  for (const value of [null, '15', NaN, Infinity, 181, -181]) {
    assert.equal(isGeoPointFeature({ ...station, properties: { ...station.properties, stationDeclinationDeg: value } }), false);
  }
});
