import assert from 'node:assert/strict';
import test from 'node:test';
import { isChartSupplementCatalog, type ChartSupplementCatalog } from '../src/index.js';

const catalog: ChartSupplementCatalog = {
  schemaVersion: 1, builderVersion: 1, generatedAt: '2026-09-16T00:00:00Z',
  effectiveDate: '2026-09-03', expirationDate: '2026-10-29',
  sourceXml: { url: 'https://example.test/afd.xml', sha256: 'a'.repeat(64) },
  volumes: [{ id: 'SW', url: '../cs-sw.pdf', pageCount: 831, byteLength: 100, sha256: 'b'.repeat(64) }],
  airports: [{ faaId: 'HWD', name: 'HAYWARD EXEC', city: 'HAYWARD', state: 'CALIFORNIA',
    volumeId: 'SW', printedPage: '174', pageIndex: 175 }],
};

test('accepts a 56-day CS edition during either 28-day TPP cycle', () => {
  assert.equal(isChartSupplementCatalog(catalog, '2026-09-03'), true);
  assert.equal(isChartSupplementCatalog(catalog, '2026-10-01'), true);
  assert.equal(isChartSupplementCatalog(catalog, '2026-10-29'), false);
  assert.equal(isChartSupplementCatalog(catalog, '2026-09-02'), false);
});

test('requires valid book identities, unique targets, and physical page bounds', () => {
  for (const mutate of [
    (c: ChartSupplementCatalog) => { c.volumes[0]!.sha256 = 'wrong'; },
    (c: ChartSupplementCatalog) => { c.volumes[0]!.byteLength = 0; },
    (c: ChartSupplementCatalog) => { c.volumes.push(c.volumes[0]!); },
    (c: ChartSupplementCatalog) => { c.airports[0]!.pageIndex = 831; },
    (c: ChartSupplementCatalog) => { c.airports[0]!.pageIndex = -1; },
    (c: ChartSupplementCatalog) => { c.airports[0]!.volumeId = 'AK'; },
    (c: ChartSupplementCatalog) => { c.airports.push(c.airports[0]!); },
    (c: ChartSupplementCatalog) => { c.effectiveDate = '2026-02-30'; },
  ]) {
    const changed = structuredClone(catalog); mutate(changed);
    assert.equal(isChartSupplementCatalog(changed), false);
  }
});
