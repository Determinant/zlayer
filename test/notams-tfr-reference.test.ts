import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isNotamRegionSnapshot, isTfrSnapshot } from '@zlayer/contracts';
import regionFixture from './fixtures/notams-us-artcc/zny-hover.json';
import nationalFixture from './fixtures/notams-us-artcc/zny-tfrs.json';
import { chartedTfrReference } from '../src/layers/notams/tfr-reference';
import { createNotamMapPreviews } from '../src/layers/notams/map-state';
import { notamChartKey } from '../src/layers/notams/public';
import { NotamList } from '../src/layers/notams/ui';

const region: unknown = regionFixture, national: unknown = nationalFixture;
assert(isNotamRegionSnapshot(region));
assert(isTfrSnapshot(national));
const newYork = region.records.find(r => r.number === '2811')!;
const baltimore = region.records.find(r => r.number === '7096')!;

test('KEWR ZNY single and complete multipart notices match their exact national boundaries', () => {
  assert.equal(chartedTfrReference(newYork, national.notices)?.id, '5/2811');
  assert.equal(chartedTfrReference(baltimore, national.notices)?.id, '6/7096');
  for (const record of [newYork, baltimore]) {
    const markup = renderToStaticMarkup(createElement(NotamList, { entries: [{ record }], now: national.checkedAt,
      chartedTfrs: national.notices, highlight: () => () => {} }));
    assert.match(markup, /tabindex="0"/);
    assert.match(markup, /TFR .* shown on chart/);
    assert.doesNotMatch(markup, /class="notam-readable"/);
    assert.match(markup, /Show raw/);
  }
  const radial = region.records.find(r => r.number === '8436')!;
  assert.equal(chartedTfrReference(radial, national.notices), undefined, 'HTO R-236 is a radial, not a TFR identity');
});

test('changed bodies, incomplete or reordered parts and invalid envelopes never claim a national depiction', () => {
  for (const text of [
    newYork.text + ' ADDITIONAL RESTRICTION',
    newYork.text.replace(/END PART 2 OF 3/, 'END PART 1 OF 3'),
    newYork.text.replace(/END PART 3 OF 3/, ''),
    newYork.text.split('END PART 2 OF 3')[0]!,
    newYork.text.replace('END PART 1 OF 3', 'END PART 1 OF 3 PART 3 OF 3'),
    'AIRSPACE SEE FDC 5/2811',
  ]) assert.equal(chartedTfrReference({ ...newYork, text }, national.notices), undefined);
  for (const text of [baltimore.text + ' 2610061845-2610062246',
    '!FDC 6/0000 ZNY ' + baltimore.text, '!FDC 6/7096 ZOA ' + baltimore.text]) {
    assert.equal(chartedTfrReference({ ...baltimore, text }, national.notices), undefined);
  }
  assert.equal(chartedTfrReference({ ...newYork, startsAt: newYork.startsAt! + 60_000 }, national.notices), undefined);
  assert.equal(chartedTfrReference({ ...newYork, lifecycle: 'cancelled' }, national.notices), undefined);
});

test('national highlights share reader ownership with temporary previews and require current map receipts', () => {
  const previews = createNotamMapPreviews(), airport = previews.open(), plate = previews.open();
  airport.update([newYork, baltimore]); plate.update([baltimore]);
  const leaveNewYork = airport.highlight(notamChartKey(newYork));
  assert.equal(previews.highlighted.getSnapshot(), undefined);
  previews.showTfrs(national.notices);
  assert.equal(previews.highlightedTfr.getSnapshot(), '5/2811');
  const leaveBaltimore = plate.highlight(notamChartKey(baltimore));
  leaveNewYork();
  assert.equal(previews.highlightedTfr.getSnapshot(), '6/7096');
  previews.show([]);
  assert.equal(previews.highlightedTfr.getSnapshot(), '6/7096', 'temporary source failure cannot erase national highlights');
  plate.release();
  assert.equal(previews.highlightedTfr.getSnapshot(), undefined);
  airport.highlight(notamChartKey(newYork));
  leaveBaltimore();
  assert.equal(previews.highlightedTfr.getSnapshot(), '5/2811', 'stale cleanup cannot erase a newer interaction');
  previews.showTfrs([]);
  assert.equal(previews.highlighted.getSnapshot(), undefined);
  previews.showTfrs(national.notices);
  airport.update([{ ...newYork, revision: 'replacement', text: newYork.text + ' CHANGED' }]);
  assert.equal(previews.highlightedTfr.getSnapshot(), undefined);
  airport.release();
  assert.deepEqual(previews.chartedTfrs.getSnapshot(), national.notices, 'stow does not remove the persistent national layer');
  previews.clear();
  assert.deepEqual(previews.chartedTfrs.getSnapshot(), []);
});
