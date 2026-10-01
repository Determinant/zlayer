import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Download, DownloadPlan } from '../src/offline/downloads';
import { regionKey, supersededRegionPlans } from '../src/offline/region-selection';
import { regionDownloadEntries } from '../src/shell/region-downloads';
import { RegionDownloadRow } from '../src/shell/region-download-row';

function plan(revision: string, root = 'https://charts.test/charts'): DownloadPlan {
  return { id: `${root}/${revision}|us-CA`, regionId: 'us-CA', title: 'California (CA)', revision,
    references: [{ id: 'airways', title: 'Airways', count: 1, sourceCount: 1, url: `${root}/${revision}/nav/airways.json` }],
    files: [{ kind: 'chart', url: `${root}/2026-09-03/mbtiles/shared.mbtiles`, byteLength: 100, sha256: 'a'.repeat(64) }] };
}
function job(plan: DownloadPlan, state: Download['state'] = 'complete'): Download {
  return { ...plan, state, completedFiles: 1, completedBytes: 100, ...(state === 'complete' ? { completedAt: 1 } : {}) };
}

test('region identity groups mixed product dates while isolating publishers and unknown legacy layouts', () => {
  const old = plan('2026-09-03'), next = plan('2026-10-01'), future = plan('2026-10-29');
  const other = plan(old.revision, 'https://other.test/charts');
  assert.equal(regionKey(old), regionKey(next));
  assert.notEqual(regionKey(old), regionKey(other));
  assert.deepEqual(supersededRegionPlans(next, [old, next, future, other]), [old]);
  assert.equal(regionKey({ ...old, files: [], references: [] }), old.id);
});

test('one region row retains the saved edition while a newer download is staged or interrupted', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-01T12:00:00Z'));
  const old = job(plan('2026-09-03')), next = job(plan('2026-10-01'), 'paused');
  const [entry] = regionDownloadEntries([{ plan: plan('2026-10-29') }], [old, next]);
  assert.equal(entry!.job, next);
  assert.equal(entry!.active, old);
  assert.equal(regionDownloadEntries([{ plan: next }], [old, next]).length, 1);
  const html = renderToStaticMarkup(createElement(RegionDownloadRow, {
    region: entry!, details: 'ready', pending: undefined, error: undefined, busy: false, canUpdate: true,
    onStart: () => {}, onUpdate: () => {}, onPause: () => {}, onRemove: () => {},
  }));
  assert.match(html, /Saved cycle Sep 3 stays selected until this update finishes/);
  assert.match(html, />Resume<\/button>/);
  assert.match(html, />Update to latest<\/button>/);
});

test('verification stays available offline while latest updates are disabled', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-01T12:00:00Z'));
  const saved = job(plan('2026-09-03'));
  const [region] = regionDownloadEntries([{ plan: plan('2026-10-01') }], [saved]);
  const html = renderToStaticMarkup(createElement(RegionDownloadRow, {
    region: region!, details: 'ready', pending: undefined, error: undefined, busy: false, canUpdate: false,
    onStart: () => {}, onUpdate: () => {}, onPause: () => {}, onRemove: () => {},
  }));
  assert.match(html, /New cycle available: Oct 1/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Update to latest<\/button>/);
  assert.doesNotMatch(html.match(/<button[^>]*>Verify saved files<\/button>/)![0], /disabled/);
});
