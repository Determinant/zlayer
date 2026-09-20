import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GeoPointFeature } from '@zlayer/contracts';
import { emptyRoutePlan } from '@zlayer/domain';
import { navaidMorse } from '../src/layers/navigation/navaid-morse';
import { featureDetailRows } from '../src/layers/navigation/feature-details';
import { MetarClient } from '../src/layers/metar-taf/metar/client';
import { FeatureDetailsPanel } from '../src/workspace/feature-details-panel';

function navaid(type: string, ident: string, extra: GeoPointFeature['properties'] = {}): GeoPointFeature {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] },
    properties: { kind: 'navaid', type, ident, frequency: '115.8', ...extra } };
}

test('frequency cards retain the published frequency and encode the NAVAID identifier', () => {
  for (const type of ['VOR', 'VOR/DME', 'VORTAC', 'DME', 'TACAN']) {
    const frequency = featureDetailRows(navaid(type, 'SFO', { icaoId: 'KSFO', faaId: 'OTHER' }))
      .find(row => row.label === 'Frequency');
    assert.equal(frequency?.value, '115.8');
    assert.equal(frequency.morse?.identifier, 'SFO');
    assert.deepEqual(frequency.morse?.groups, ['···', '··−·', '−−−']);
  }
  assert.deepEqual(navaidMorse(navaid('NDB', 'MB'))?.groups, ['−−', '−···']);
  assert.deepEqual(navaidMorse(navaid('NDB/DME', 'ADK'))?.groups, ['·−', '−··', '−·−']);
  assert.deepEqual(navaidMorse(navaid('DME', ' qz9 '))?.groups, ['−−·−', '−−··', '−−−−·']);
});

test('localizers include the broadcast I prefix exactly once, without encoding chart punctuation', () => {
  for (const type of ['LOC', 'LOC/DME', 'ILS', 'ILS/DME', 'LDA', 'LDA/DME']) {
    for (const ident of ['DIA', 'IDIA', 'I-DIA', 'I–DIA', ' i-dia ']) {
      const morse = navaidMorse(navaid(type, ident));
      assert.equal(morse?.identifier, 'IDIA');
      assert.deepEqual(morse.groups, ['··', '−··', '··', '·−']);
    }
  }
  assert.equal(navaidMorse(navaid('LOC', 'ISM'))?.identifier, 'IISM');
  assert.equal(navaidMorse(navaid('DME', 'I-DIA'))?.identifier, 'IDIA');
  assert.equal(navaidMorse(navaid('SDF', 'DIA'))?.identifier, 'DIA');
  assert.equal(navaidMorse(navaid('VOR', 'ISM'))?.identifier, 'ISM');
});

test('compact facility spellings retain the canonical Morse identifier without broadening supported types', () => {
  for (const [canonical, aliases] of [
    ['VOR/DME', ['VORDME', 'VOR-DME', ' vordme ']],
    ['NDB/DME', ['NDBDME', 'NDB-DME', ' ndb-dme ']],
  ] as const) {
    for (const type of aliases) {
      assert.deepEqual(navaidMorse(navaid(type, 'ABC')), navaidMorse(navaid(canonical, 'ABC')));
    }
  }
  for (const type of ['VOR--DME', 'NDB DME', 'VOT/DME', 'UNKNOWN']) {
    assert.equal(navaidMorse(navaid(type, 'ABC')), undefined);
  }
});

test('non-identifying facilities, unrelated frequencies and invalid identifiers do not get invented Morse', () => {
  for (const type of ['VOT', 'FAN MARKER', 'GLIDESLOPE', 'UNKNOWN']) {
    assert.equal(navaidMorse(navaid(type, 'SFO')), undefined);
  }
  assert.equal(navaidMorse(navaid('VOR', 'SFO', { kind: 'airport' })), undefined);
  assert.equal(navaidMorse(navaid('VOR', 'SFO', { kind: 'fix' })), undefined);
  for (const ident of ['', 'S?O', 'S/FO', 'S FO', 'ABCDE', 'A']) {
    assert.equal(navaidMorse(navaid('VOR', ident)), undefined);
  }
  for (const ident of ['AB', 'ABCD']) assert.equal(navaidMorse(navaid('LOC', ident)), undefined);
  const feature = navaid('DME', 'SFO');
  delete feature.properties.frequency;
  assert.equal(featureDetailRows(feature).find(row => row.label === 'Frequency'), undefined);
});

test('frequency Morse is Unicode text with an accessible dot/dash description', () => {
  const feature = navaid('VOR/DME', 'SFO');
  const html = renderToStaticMarkup(createElement(FeatureDetailsPanel, {
      onIdentificationChange() {},
    feature, metarClient: new MetarClient(new URL('https://example.test/metars')), procedureResource: undefined, revision: '2026-09-03',
    route: { plan: emptyRoutePlan(), update() {} }, onClose: () => {}, onOpenProcedure: () => {},
  }));
  assert.match(html, /<dt>Frequency<\/dt><dd>115\.8<span class="navaid-morse"/);
  assert.match(html, /aria-label="Morse identifier SFO: S dot dot dot; F dot dot dash dot; O dash dash dash"/);
  for (const code of ['···', '··−·', '−−−']) assert.ok(html.includes(code));
});
