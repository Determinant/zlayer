import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { isPirepSnapshot, type NavigationData } from '@zlayer/contracts';
import { readPirepTime } from '../src/layers/weather-awc/pireps/text';
import { decodePirepSource, pirepReceiptEvidence } from '../src/layers/weather-awc/pireps/decode';
import { createPirepLocations } from '../src/layers/weather-awc/pireps/locations';
import { weatherAwcPreferences } from '../src/layers/weather-awc/preferences';
import { selectedPireps } from '../src/layers/weather-awc/pireps/selection';

const checkedAt = Date.parse('2026-10-13T22:34:29Z');
const sourceXml = await readFile(new URL('./fixtures/pireps/2026-10-13-gfk.xml', import.meta.url), 'utf8');
const source = { schemaVersion: 2 as const, checkedAt, source: 'AWC captured report', records: [sourceXml] };

test('/TM uses one complete field and the source publication date, including UTC midnight', () => {
  const midnight = Date.parse('2026-10-14T00:15:00Z');
  const raw = (time: string) => `GFK UA /OV GFK180005/TM ${time}/FL025`;
  assert.equal(readPirepTime(raw('2210'), checkedAt), Date.parse('2026-10-13T22:10:00Z'));
  assert.equal(readPirepTime(raw('2355'), midnight), Date.parse('2026-10-13T23:55:00Z'));
  assert.equal(readPirepTime(raw('0000'), midnight), Date.parse('2026-10-14T00:00:00Z'));
  assert.equal(readPirepTime(raw('2246'), midnight), Date.parse('2026-10-13T22:46:00Z'));
  for (const time of ['', '2400', '1260', '25', '22:10', '2210 EXTRA', '22100', 'UNKN', '0016', '2245']) {
    assert.equal(readPirepTime(raw(time), midnight), undefined, time);
  }
  for (const raw of ['GFK UA /OV GFK /RM /TM 2210', 'GFK UA /TM 2210/TM 2210',
    'GFK UA /TM 2200/TM 2210', 'GFK UA /TM /TM 2210', 'AIREP /TM 2210',
    'GFK UA /TM 2210/UNKNOWN', `GFK UA /TM 2210/RM ${'x'.repeat(20_001)}`]) {
    assert.equal(readPirepTime(raw, checkedAt), undefined, raw.slice(0, 80));
  }
  assert.equal(readPirepTime('GFK UUA /TM2210/SK OVC028-TOP045/OVC060/RM QUOTED /TM 2350', checkedAt),
    Date.parse('2026-10-13T22:10:00Z'));
});

test('captured GFK report becomes selectable from either wire format despite AWC missing-time metadata', () => {
  const legacy = { schemaVersion: 1 as const, checkedAt, source: source.source, reports: [],
    issues: [{ id: 'legacy-missing-time', reason: 'AWC flagged the observation time as missing',
      qualityFlag: 'no_time_stamp' as const, sourceXml }] };
  for (const payload of [source, legacy]) {
    const snapshot = decodePirepSource(payload);
    assert.ok(isPirepSnapshot(snapshot)); assert.equal(snapshot.issues.length, 0); assert.equal(snapshot.reports.length, 1);
    const report = snapshot.reports[0]!;
    assert.equal(report.observedAt, Date.parse('2026-10-13T22:10:00Z'));
    assert.equal(report.receivedAt, Date.parse('2026-10-13T21:20:10.884Z'), 'conflicting receipt remains source evidence');
    assert.equal(report.timeSource, 'raw'); assert.deepEqual(report.quality, ['no_time_stamp']);
    assert.equal(report.sourceXml, sourceXml);
    assert.deepEqual([report.longitude, report.latitude], [-97.2048, 47.8726]);
    assert.equal(report.altitudeFt, 2500); assert.deepEqual(report.sky, ['OVC · 2800–4500 ft MSL']);
    const state = { selectedTime: null, now: checkedAt, pireps: { loading: false, snapshot },
      preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true, awcPirepAge: '30' }) };
    assert.deepEqual(selectedPireps(state), [report]);
    assert.equal(selectedPireps({ ...state, selectedTime: report.observedAt - 1 }).length, 0);
    assert.equal(selectedPireps({ ...state, now: report.observedAt + 90 * 60_000 }).length, 0);
  }
});

test('recovered /TM also allows independent /OV recovery while preserving both source flags', () => {
  const flagged = sourceXml.replace('<no_time_stamp>', '<bad_location>TRUE</bad_location><no_time_stamp>');
  const snapshot = decodePirepSource({ ...source, records: [flagged] });
  assert.ok(isPirepSnapshot(snapshot)); assert.equal(snapshot.reports.length, 0);
  const report = snapshot.issues[0]!.report!;
  assert.equal(report.timeSource, 'raw'); assert.deepEqual(report.quality, ['bad_location', 'no_time_stamp']);
  const { timeSource: _timeSource, ...unprovenTime } = report;
  assert.equal(isPirepSnapshot({ ...snapshot, issues: [{ ...snapshot.issues[0], report: unprovenTime }] }), false);
  const navigation: NavigationData = {
    airports: { type: 'FeatureCollection', features: [], meta: { revision: 'fixture', layer: 'airports', returned: 0, truncated: false } },
    navaids: { type: 'FeatureCollection', meta: { revision: 'fixture', layer: 'navaids', returned: 1, truncated: false }, features: [
      { type: 'Feature', id: 'fixture-gfk', geometry: { type: 'Point', coordinates: [-97.2, 47.95] },
        properties: { kind: 'navaid', ident: 'GFK', type: 'VOR/DME', stationDeclinationDeg: 0 } },
    ] },
  };
  const located = createPirepLocations()(snapshot, navigation)!;
  assert.equal(located.issues.length, 0); assert.equal(located.reports.length, 1);
  assert.equal(located.reports[0]!.decodedLocation, 'Decoded /OV · GFK180005');
  assert.equal(located.reports[0]!.timeSource, 'raw');
  assert.equal(located.reports[0]!.observedAt, Date.parse('2026-10-13T22:10:00Z'));
});

test('unusable /TM retains a report with receipt-based expiry, while valid source time retains precedence', () => {
  for (const raw of ['/TM 2235', '/TM 2000', '/TM UNKN', '/TM 2210/TM 2210', '/RM /TM 2210']) {
    const snapshot = decodePirepSource({ ...source, records: [sourceXml.replace('/TM 2210', raw)] });
    assert.ok(isPirepSnapshot(snapshot)); assert.equal(snapshot.issues.length, 0, raw);
    const report = snapshot.reports[0]!;
    assert.equal(report.timeSource, 'receipt'); assert.equal(report.observedAt, report.receivedAt);
    assert.deepEqual(report.quality, ['no_time_stamp']); assert.ok(report.text.includes(raw));
    const state = { selectedTime: null, now: checkedAt, pireps: { loading: false, snapshot },
      preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true }) };
    assert.deepEqual(selectedPireps(state), [report]);
    assert.equal(selectedPireps({ ...state, selectedTime: report.receivedAt! - 1 }).length, 0);
    assert.equal(selectedPireps({ ...state, now: report.receivedAt! + 90 * 60_000 }).length, 0);
    assert.equal(isPirepSnapshot({ ...snapshot, reports: [{ ...report, receivedAt: null }] }), false);
    assert.equal(isPirepSnapshot({ ...snapshot, reports: [{ ...report, observedAt: report.observedAt - 1 }] }), false);
  }
  const unflagged = sourceXml.replace('<no_time_stamp>TRUE</no_time_stamp>', '');
  const existing = decodePirepSource({ ...source, records: [unflagged] }).reports[0]!;
  assert.equal(existing.observedAt, Date.parse('2026-10-13T21:20:00Z')); assert.equal(existing.timeSource, undefined);
  const missing = unflagged.replace(/<observation_time>.*?<\/observation_time>/, '');
  const recovered = decodePirepSource({ ...source, records: [missing] }).reports[0]!;
  assert.equal(recovered.timeSource, 'raw'); assert.equal(recovered.observedAt, Date.parse('2026-10-13T22:10:00Z'));
  const invalid = decodePirepSource({ ...source, records: [sourceXml.replace('cloud_base_ft_msl="2800"', 'cloud_base_ft_msl="invalid"')] });
  assert.equal(invalid.reports.length, 0, 'time recovery cannot bypass other field validation');
});

test('unknown observation times need a valid nonfuture receipt; expired receipts remain expired', () => {
  const unknown = sourceXml.replace('/TM 2210', '/TM UNKN');
  for (const receipt of ['', 'invalid', '2026-10-13T22:34:30Z']) {
    const xml = unknown.replace(/<receipt_time>.*?<\/receipt_time>/, receipt ? `<receipt_time>${receipt}</receipt_time>` : '');
    const snapshot = decodePirepSource({ ...source, records: [xml] });
    assert.equal(snapshot.reports.length, 0, receipt); assert.equal(snapshot.issues.length, 1);
    assert.equal(snapshot.issues[0]!.sourceXml, xml);
  }
  for (const receipt of ['2026-10-13T21:04:29Z', '2026-10-12T22:30:00Z']) {
    const xml = unknown.replace(/<receipt_time>.*?<\/receipt_time>/, `<receipt_time>${receipt}</receipt_time>`);
    const snapshot = decodePirepSource({ ...source, records: [xml] });
    assert.equal(snapshot.reports[0]!.observedAt, Date.parse(receipt));
    assert.equal(selectedPireps({ selectedTime: null, now: checkedAt, pireps: { loading: false, snapshot },
      preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true }) }).length, 0);
  }
  const later = unknown.replace('2026-10-13T21:20:10.884Z', '2026-10-13T22:30:00Z');
  for (const records of [[unknown, later], [later, unknown]]) {
    const snapshot = decodePirepSource({ ...source, records });
    assert.equal(snapshot.reports.length, 1); assert.equal(snapshot.issues.length, 0);
    assert.equal(snapshot.reports[0]!.sourceXml, unknown);
    assert.equal(snapshot.reports[0]!.observedAt, Date.parse('2026-10-13T21:20:10.884Z'));
    const flagged = records.map(xml => xml.replace('<no_time_stamp>', '<bad_location>TRUE</bad_location><no_time_stamp>'));
    const unlocated = decodePirepSource({ ...source, records: flagged });
    assert.ok(isPirepSnapshot(unlocated));
    assert.equal(new Set(unlocated.issues.map(issue => issue.report!.id)).size, 1);
    assert.ok(unlocated.issues.every(issue => issue.report?.timeSource === 'receipt'));
  }
});

test('receipt deduplication precedes expiry and preserves the earliest evidence at the age boundary', () => {
  const unknown = sourceXml.replace('/TM 2210', '/TM UNKN');
  const later = unknown.replace('2026-10-13T21:20:10.884Z', '2026-10-13T22:30:00Z');
  const firstReceipt = Date.parse('2026-10-13T21:20:10.884Z');
  for (const flagged of [false, true]) for (const order of [[unknown, later], [later, unknown]]) {
    const records = flagged ? order.map(xml => xml.replace('<no_time_stamp>', '<bad_location>TRUE</bad_location><no_time_stamp>')) : order;
    for (const at of [firstReceipt + 90 * 60_000 - 1, firstReceipt + 90 * 60_000, firstReceipt + 91 * 60_000]) {
      const snapshot = decodePirepSource({ ...source, checkedAt: at, records });
      assert.ok(isPirepSnapshot(snapshot));
      const report = snapshot.reports[0] ?? snapshot.issues.map(i => i.report!).sort((a, b) => a.observedAt - b.observedAt)[0]!;
      assert.equal(report.observedAt, firstReceipt, 'an expired earlier receipt still constrains a retransmission');
      const evidence = flagged ? snapshot.issues.find(i => i.report?.receivedAt === firstReceipt)!.sourceXml : snapshot.reports[0]!.sourceXml;
      assert.equal(evidence, records.find(xml => xml.includes('21:20:10.884Z')));
      assert.deepEqual(decodePirepSource(snapshot), snapshot, 'offline reinterpretation preserves the same receipt');
      const state = { selectedTime: null, now: at, pireps: { loading: false, snapshot },
        preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true }) };
      assert.equal(selectedPireps(state).length, !flagged && at < firstReceipt + 90 * 60_000 ? 1 : 0);
    }
  }
});

test('retained receipt witnesses constrain only the same present identity and cannot bypass source validation', () => {
  const early = sourceXml.replace('/TM 2210', '/TM UNKN');
  const later = early.replace('2026-10-13T21:20:10.884Z', '2026-10-13T22:30:00Z');
  const prior = decodePirepSource({ ...source, records: [early] });
  const evidence = pirepReceiptEvidence(prior), before = JSON.stringify(evidence);
  for (const records of [[], [sourceXml], [later.replace('/FL025', '/FL030')], [later.replace('cloud_base_ft_msl="2800"', 'cloud_base_ft_msl="invalid"')]]) {
    const input = { ...source, records }, baseline = decodePirepSource(input);
    assert.deepEqual(decodePirepSource(input, evidence), baseline, 'no admission, time override or interpretation repair from history');
  }
  const current = { ...source, records: [later] };
  const baseline = decodePirepSource(current);
  const future = early.replace('2026-10-13T21:20:10.884Z', '2026-10-13T23:00:00Z');
  assert.deepEqual(decodePirepSource(current, [future, '<AircraftReport/>']), baseline);
  for (const payload of [current, baseline]) {
    const bounded = decodePirepSource(payload, evidence);
    assert.equal(bounded.reports[0]!.observedAt, prior.reports[0]!.observedAt);
    assert.equal(bounded.reports[0]!.sourceXml, early);
  }
  const flagged = [later, early].map(xml => xml.replace('<no_time_stamp>', '<bad_location>TRUE</bad_location><no_time_stamp>'));
  const unlocated = decodePirepSource({ ...source, records: flagged });
  assert.deepEqual(pirepReceiptEvidence(unlocated), [flagged[1]], 'one earliest witness per identity');
  assert.throws(() => decodePirepSource(current, Array(10_001).fill(early)), /receipt evidence/);
  assert.equal(JSON.stringify(evidence), before); assert.equal(current.records[0], later);
});
