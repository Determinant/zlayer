import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { GeoPointFeature, NavigationData } from '@zlayer/contracts';
import { isPirepSnapshot } from '@zlayer/contracts';
import { readPirepCache } from '../tools/info-server/pirep-source';
import { isMagneticModel } from '../src/core/geo/magnetic-model';
import { decodePirepSource } from '../src/layers/weather-awc/pireps/decode';
import { readPirepLocation } from '../src/layers/weather-awc/pireps/location';
import { createPirepLocations } from '../src/layers/weather-awc/pireps/locations';
import { selectedPireps } from '../src/layers/weather-awc/pireps/selection';
import { weatherAwcPreferences } from '../src/layers/weather-awc/preferences';
import model from './fixtures/magnetic-model.json';

const references = JSON.parse(await readFile(new URL('./fixtures/pireps/2026-10-01-locations.json', import.meta.url), 'utf8')) as
  Record<'airports' | 'navaids' | 'fixes', GeoPointFeature[]>;
// Complete for the locations needing recovery in these captures, not national coverage.
const data: NavigationData = {};
for (const layer of ['airports', 'navaids', 'fixes'] as const) {
  data[layer] = { type: 'FeatureCollection', features: references[layer],
    meta: { layer, revision: '2026-10-01', returned: references[layer].length, truncated: false } };
}

for (const capture of [
  { day: '2026-10-13', checkedAt: '2026-10-13T06:29:00Z', records: 2098, pireps: 21, recoveries: 1,
    unsupported: ['IAH UA /OV RWY 8L', 'QX UA /OV 4615N04155W'] },
  { day: '2026-10-14', checkedAt: '2026-10-14T21:37:37.459Z', records: 1079, pireps: 337, recoveries: 10,
    unsupported: ['BJC UA /OV RWY 30R', 'ORF UA /OV 375202N0621207W', 'YZ UA /OV SSM 090020',
      'PVU UA /OV SOUTHWEST OF PVU', 'MOB UA /OV 2235N 9015W', 'WG EG UA /OV 5230N08600W'] },
]) {
  test(`all ${capture.pireps} PIREPs in the ${capture.day} capture reach map selection with original observations intact`, async () => {
    const source = await readPirepCache(await readFile(new URL(`./fixtures/pireps/${capture.day}.xml.gz`, import.meta.url)), Date.parse(capture.checkedAt));
    const snapshot = decodePirepSource(source), before = JSON.stringify(snapshot);
    assert.ok(isPirepSnapshot(snapshot));
    assert.ok(isMagneticModel(model));
    assert.equal(source.records.length, capture.records);
    assert.equal(snapshot.issues.length, capture.recoveries);
    const observations = [...snapshot.reports, ...snapshot.issues.map(issue => {
      assert.equal(issue.qualityFlag, 'bad_location');
      assert.ok(issue.report); return issue.report;
    })];
    const pireps = observations.filter(report => ['PIREP', 'Urgent PIREP'].includes(report.type));
    assert.equal(pireps.length, capture.pireps);
    // Raw syntax support differs from source usability: these reports retain valid AWC coordinates.
    const unsupported = pireps.filter(report => readPirepLocation(report.text).kind !== 'parsed');
    assert.deepEqual(unsupported.map(report => report.text.split('/TM')[0]!.trim()).sort(), [...capture.unsupported].sort());
    const derive = createPirepLocations(), resolved = derive(snapshot, data, model)!;
    assert.deepEqual(resolved.issues, []);
    assert.equal(resolved.reports.length, capture.records);
    const byId = new Map(resolved.reports.map(report => [report.id, report]));
    for (const report of snapshot.reports) assert.deepEqual(byId.get(report.id), report, 'valid source coordinates and all fields retain precedence');
    for (const issue of snapshot.issues) {
      const recovered = byId.get(issue.report!.id)!;
      const { longitude, latitude, sourceXml, decodedLocation, locationEstimated: _estimated, ...observation } = recovered;
      assert.deepEqual(observation, issue.report, 'location recovery preserves observation identity, conditions, time and raw text');
      assert.equal(sourceXml, issue.sourceXml);
      assert.ok(Number.isFinite(longitude) && Number.isFinite(latitude));
      assert.match(decodedLocation!, /^(Approx\.|Decoded \/OV)/);
    }
    const selected = selectedPireps({ selectedTime: null, now: source.checkedAt, pireps: { loading: false, snapshot, resolved },
      preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true }) });
    assert.equal(selected.filter(report => ['PIREP', 'Urgent PIREP'].includes(report.type)).length, capture.pireps);
    assert.equal(derive(snapshot)!.reports.length, snapshot.reports.length, 'withdrawing references removes only derived locations');
    assert.equal(JSON.stringify(snapshot), before, 'the complete source-derived snapshot remains unchanged');
  });
}
