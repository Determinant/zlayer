import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPirepSnapshot, isPirepSourceSnapshot, PIREP_MAX_AGE_MS, PIREP_MAX_BYTES } from '@zlayer/contracts';
import { readPirepCache, PIREP_SOURCE } from '../tools/info-server/pirep-source';
import { createInfoServer } from '../tools/info-server/server';
import { resourceFor } from '../tools/info-server/weather-resources';
import { digest } from '../tools/info-server/upstream';
import { createWeatherController } from '../src/layers/weather-awc/controller';
import { weatherAwcPreferences } from '../src/layers/weather-awc/preferences';
import { decodePirepSource } from '../src/layers/weather-awc/pireps/decode';
import { selectedPireps } from '../src/layers/weather-awc/pireps/selection';
import { cacheFixture } from './helpers/cache';

const NOW = Date.parse('2026-10-13T06:29:00Z');
const captured = await readFile(new URL('./fixtures/pireps/2026-10-13.xml.gz', import.meta.url));
const source = await readPirepCache(captured, NOW);
const snapshot = decodePirepSource(source);
const reportXml = snapshot.reports.find(r => r.type === 'Urgent PIREP')!.sourceXml;
const envelope = (members: string[], count = members.length) => `<response version="2.0"><data_source name="aircraftreport"/><request type="retrieve"/><errors/><warnings/><data num_results="${count}">${members.join('')}</data></response>`;
const parse = async (xml: string) => decodePirepSource(await readPirepCache(gzipSync(xml), NOW));

function browserCache(t: TestContext) {
  const fixture = cacheFixture(t, 'zlayers-plugin-files-v1:weather-awc:pireps');
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : Reflect.deleteProperty(globalThis, 'window'));
  return { ...fixture, storage };
}

test('PWA decodes the complete captured cache, retaining qualifiers, negatives and raw source', () => {
  assert.ok(isPirepSourceSnapshot(source)); assert.equal(source.records.length, 2098);
  assert.ok(isPirepSnapshot(snapshot)); assert.equal(snapshot.reports.length, 2097); assert.equal(snapshot.issues.length, 1);
  assert.match(snapshot.issues[0]!.sourceXml, /<bad_location>TRUE/);
  assert.equal(snapshot.issues[0]!.qualityFlag, 'bad_location');
  assert.equal(snapshot.issues[0]!.report?.text, 'DEN UA /OV 7 SOUTH/TM 0620/FL080/TP B737/RM SMOOTH');
  assert.equal(snapshot.reports.filter(r => r.urgent).length, 2);
  assert.equal(snapshot.reports.filter(r => r.type === 'AIREP').length, 2077);
  const urgent = snapshot.reports.find(r => r.urgent)!;
  assert.equal(urgent.altitudeFt, 14000); assert.equal(urgent.aircraft, 'B737');
  assert.deepEqual(urgent.icing, ['RIME MOD · 10500–14000 ft MSL']);
  assert.match(urgent.text, /RNO UUA/); assert.match(urgent.sourceXml, /^<AircraftReport>.*<\/AircraftReport>$/);
  assert.ok(JSON.stringify(snapshot).length * 2 < 4 * 1024 * 1024, 'captured interpretation remains small');
});

test('info server transports every source member verbatim without interpreting, deduplicating or clipping', async () => {
  const flagged = reportXml.replace('<aircraft_ref>', '<quality_control_flags><bad_location>TRUE</bad_location><no_time_stamp>TRUE</no_time_stamp></quality_control_flags><aircraft_ref>');
  const records = [reportXml, reportXml, flagged, '<AircraftReport/>',
    '<AircraftReport><raw_text><![CDATA[<AircraftReport/> & raw text]]></raw_text></AircraftReport>',
    reportXml.replace('<raw_text>', `<raw_text>${'x'.repeat(20_001)}`),
    reportXml.replace('<raw_text>', '<raw_text><AircraftReport/>'),
    reportXml.replace('2026-10-13T05:21:00.000Z', 'invalid')];
  const transported = await readPirepCache(gzipSync(envelope(records)), NOW);
  assert.deepEqual(transported, { schemaVersion: 2, checkedAt: NOW, source: PIREP_SOURCE, records });
  assert.ok(isPirepSourceSnapshot(transported));
  assert.deepEqual((await readPirepCache(gzipSync(envelope([])), NOW)).records, []);
  const interpreted = decodePirepSource(transported);
  assert.equal(interpreted.reports.length, 1);
  assert.equal(interpreted.issues.length, records.length - 2);
  assert.deepEqual(transported.records, records, 'interpretation does not mutate source evidence');
});

test('PWA decodes legacy rejected XML without requiring a server-parsed observation', () => {
  const flagged = reportXml.replace('<aircraft_ref>', '<quality_control_flags><bad_location>TRUE</bad_location></quality_control_flags><aircraft_ref>');
  const legacy = { schemaVersion: 1 as const, checkedAt: NOW, source: PIREP_SOURCE, reports: [],
    issues: [{ id: 'legacy-rejection', reason: 'Rejected upstream location', sourceXml: flagged }] };
  assert.ok(isPirepSnapshot(legacy));
  const decoded = decodePirepSource(legacy);
  assert.equal(decoded.issues[0]!.qualityFlag, 'bad_location');
  assert.ok(decoded.issues[0]!.report, 'raw /OV recovery no longer depends on issue.report from the server');
  assert.equal(decoded.issues[0]!.report!.text, snapshot.reports.find(r => r.urgent)!.text);
  const current = decodePirepSource({ schemaVersion: 2, checkedAt: NOW, source: PIREP_SOURCE, records: [flagged] });
  assert.deepEqual(decoded.issues[0], { ...current.issues[0], id: 'legacy-rejection' });
  assert.equal('report' in legacy.issues[0]!, false);
  const malformed = decodePirepSource({ ...source, records: ['<AircraftReport>', reportXml] });
  assert.equal(malformed.issues.length, 1); assert.equal(malformed.reports.length, 1);
});

test('complete envelopes replace atomically; independent invalid members are explicit issues', async () => {
  for (const bad of [envelope([reportXml], 2), envelope([reportXml]).replace('</response>', ''),
    envelope([reportXml]).replace('<warnings/>', '<warnings><warning>truncated</warning></warnings>'),
    '<!DOCTYPE response [<!ENTITY external SYSTEM "file:///etc/passwd">]>' + envelope([reportXml])]) {
    await assert.rejects(parse(bad));
  }
  assert.deepEqual((await parse(envelope([]))).reports, []);
  for (const bad of [reportXml.replace('<latitude>39.4991</latitude>', '<latitude>91</latitude>'),
    reportXml.replace('2026-10-13T05:21:00.000Z', '2026-02-30T05:21:00Z'),
    reportXml.replace('2026-10-13T05:21:00.000Z', '2026-10-14T05:21:00Z'),
    reportXml.replace('<raw_text>', '<raw_text>partial <unexpected>lost text</unexpected>'),
    reportXml.replace('<aircraft_ref>', '<icing_condition>lost condition</icing_condition><aircraft_ref>'),
    reportXml.replace('<aircraft_ref>', '<quality_control_flags><no_time_stamp><unexpected>TRUE</unexpected></no_time_stamp></quality_control_flags><aircraft_ref>'),
    reportXml.replace('<latitude>', '<latitude>39</latitude><latitude>')]) {
    const partial = await parse(envelope([reportXml, bad]));
    assert.equal(partial.reports.length, 1); assert.equal(partial.issues.length, 1);
    assert.equal(partial.issues[0]!.qualityFlag, undefined, 'malformed reports are not source-quality exclusions');
    assert.equal((await parse(envelope([bad]))).issues.length, 1);
  }
});

test('oversized member text becomes a bounded issue while valid neighbors publish', async () => {
  for (const content of ['x'.repeat(20_001), `<![CDATA[${'x'.repeat(20_001)}]]>`]) {
    const oversized = reportXml.replace(/<raw_text>.*?<\/raw_text>/s, `<raw_text>${content}</raw_text>`);
    const parsed = await parse(envelope([reportXml, oversized, reportXml]));
    assert.equal(parsed.reports.length, 1);
    assert.equal(parsed.issues.length, 1);
    assert.equal(parsed.issues[0]!.qualityFlag, undefined);
    assert.ok(parsed.issues[0]!.sourceXml.length <= 20_000);
    assert.match(parsed.issues[0]!.sourceXml, /\[Source excerpt\]$/);
    assert.ok(isPirepSnapshot(parsed));
  }
  await assert.rejects(parse(envelope([reportXml]).replace('<errors/>', `<errors>${'x'.repeat(20_001)}</errors>`)),
    'envelope limits still reject the collection');
  await assert.rejects(parse(envelope([reportXml.replace('<raw_text>', `<raw_text>${'x'.repeat(8 * 1024 * 1024)}`)])),
    'decoded document limit remains enforced');
});

test('quality flags require explicit boolean values before source-quality classification', async () => {
  for (const flag of ['bad_location', 'no_time_stamp', 'no_flt_lvl', 'mid_point_assumed']) {
    for (const value of ['UNKNOWN', 'yes', '2', '', 'true false']) {
      const member = reportXml.replace('<aircraft_ref>', `<quality_control_flags><${flag}>${value}</${flag}></quality_control_flags><aircraft_ref>`);
      const parsed = await parse(envelope([reportXml, member]));
      assert.equal(parsed.reports.length, 1, `${flag}: ${value}`);
      assert.equal(parsed.issues.length, 1);
      assert.equal(parsed.issues[0]!.qualityFlag, undefined, 'invalid flags remain explicit PWA interpretation issues');
    }
    for (const value of ['FALSE', 'false', ' 0 ']) {
      const member = reportXml.replace('<aircraft_ref>', `<quality_control_flags><${flag}>${value}</${flag}></quality_control_flags><aircraft_ref>`);
      const parsed = await parse(envelope([member]));
      assert.equal(parsed.issues.length, 0); assert.deepEqual(parsed.reports[0]!.quality, []);
    }
  }
  for (const value of ['TRUE', 'true', ' 1 ']) {
    const member = reportXml.replace('<aircraft_ref>', `<quality_control_flags><bad_location>${value}</bad_location></quality_control_flags><aircraft_ref>`);
    assert.equal((await parse(envelope([member]))).issues[0]!.qualityFlag, 'bad_location');
  }
});

test('repeated condition layers, negative reports and optional fields preserve source meaning', async () => {
  const member = `<AircraftReport><observation_time>2026-10-13T06:20:00Z</observation_time>
    <latitude>38</latitude><longitude>-122</longitude>
    <quality_control_flags><mid_point_assumed>TRUE</mid_point_assumed><no_flt_lvl>FALSE</no_flt_lvl></quality_control_flags>
    <sky_condition sky_cover="FEW" cloud_base_ft_msl="1000"/>
    <sky_condition sky_cover="BKN" cloud_base_ft_msl="4000" cloud_top_ft_msl="6000"/>
    <turbulence_condition turbulence_intensity="MOD-SEV" turbulence_type="CHOP" turbulence_freq="OCNL" turbulence_base_ft_msl="7000" turbulence_top_ft_msl="9000"/>
    <turbulence_condition turbulence_intensity="NEG"/>
    <icing_condition icing_intensity="NEG"/>
    <raw_text>  TEST /RM SKY &amp; TB <![CDATA[<UNCHANGED>]]>  </raw_text></AircraftReport>`;
  const parsed = await parse(envelope([member]));
  assert.equal(parsed.issues.length, 0);
  const report = parsed.reports[0]!;
  assert.equal(report.receivedAt, null); assert.equal(report.altitudeFt, null);
  assert.equal(report.aircraft, ''); assert.equal(report.type, 'Unknown'); assert.equal(report.urgent, false);
  assert.deepEqual(report.quality, ['mid_point_assumed']);
  assert.deepEqual(report.sky, ['FEW · 1000–? ft MSL', 'BKN · 4000–6000 ft MSL']);
  assert.deepEqual(report.turbulence, ['CHOP MOD-SEV OCNL · 7000–9000 ft MSL', 'NEG']);
  assert.deepEqual(report.icing, ['NEG']);
  assert.equal(report.text, '  TEST /RM SKY & TB <UNCHANGED>  ');
  assert.equal(report.sourceXml, member);
});

test('equivalent fields and repeated delivery preserve identity; unknown/qualified altitude stays unknown', async () => {
  const duplicate = reportXml.replace('05:30:05.812Z', '05:31:05.812Z');
  assert.equal((await parse(envelope([reportXml, duplicate]))).reports.length, 1);
  const missingReceipt = reportXml.replace(/<receipt_time>[^<]*<\/receipt_time>/, '');
  for (const members of [[missingReceipt, duplicate, reportXml], [reportXml, duplicate, missingReceipt]]) {
    const reports = (await parse(envelope(members))).reports;
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.receivedAt, Date.parse('2026-10-13T05:30:05.812Z'));
    assert.equal(reports[0]!.sourceXml, reportXml, 'keep evidence for the earliest known receipt');
  }
  const offset = reportXml.replace('2026-10-13T05:21:00.000Z', '2026-10-12T22:21:00-07:00');
  assert.equal((await parse(envelope([offset]))).reports[0]!.id, snapshot.reports.find(r => r.urgent)!.id);
  for (const flag of ['no_flt_lvl', 'flt_lvl_range', 'above_ground_level_indicated']) {
    const altered = reportXml.replace('<aircraft_ref>', `<quality_control_flags><${flag}>TRUE</${flag}></quality_control_flags><aircraft_ref>`);
    const r = (await parse(envelope([altered]))).reports[0]!;
    assert.equal(r.altitudeFt, null); assert.deepEqual(r.quality, [flag]);
  }
  const negative = reportXml.replace('icing_intensity="MOD"', 'icing_intensity="NEG"');
  assert.match((await parse(envelope([negative]))).reports[0]!.icing[0]!, /NEG/);
});

test('only complete raw flight-level uncertainty markers override the structured altitude', () => {
  for (const altitude of [0, 8000]) {
    for (const [text, expected] of [
      ...['DURC', 'DURD', 'UNKN', ' durc '].map(flightLevel => [`AMA UA /OV AMA/TM 0620/FL${flightLevel}/SK OVC045-TOPS053`, null] as const),
      ['AMA UA /OV AMA/TM 0620/FL000', altitude],
      ['AMA UA /OV AMA/TM 0620/FL070/RM DURC /FLUNKN', altitude],
      ['AMA UA /OV AMA/TM 0620/RM /FLDURC', altitude],
      ['AMA UA /OV AMA/TM 0620/FLDURC020', altitude],
      ['AMA UA /OV AMA/TM 0620/FLDURC/FL080', altitude],
    ] as const) {
      const member = `<AircraftReport><observation_time>2026-10-13T06:20:00Z</observation_time>
        <latitude>35.2194</latitude><longitude>-101.7059</longitude><altitude_ft_msl>${altitude}</altitude_ft_msl>
        <sky_condition sky_cover="OVC" cloud_base_ft_msl="4500" cloud_top_ft_msl="5300"/>
        <report_type>PIREP</report_type><raw_text>${text}</raw_text></AircraftReport>`;
      const snapshot = decodePirepSource({ schemaVersion: 2, source: 'Synthetic altitude regression', checkedAt: NOW, records: [member] });
      assert.equal(snapshot.issues.length, 0, text);
      const report = snapshot.reports[0]!;
      assert.equal(report.altitudeFt, expected, text);
      assert.deepEqual(report.sky, ['OVC · 4500–5300 ft MSL']);
      assert.deepEqual(report.quality, []);
      assert.equal(report.text, text); assert.equal(report.sourceXml, member);
      const malformed = member.replace(`<altitude_ft_msl>${altitude}`, '<altitude_ft_msl>INVALID');
      const invalid = decodePirepSource({ schemaVersion: 2, source: 'Synthetic altitude regression', checkedAt: NOW, records: [malformed] });
      assert.equal(invalid.reports.length, 0, 'uncertain raw altitude cannot conceal malformed structured altitude');
      assert.equal(invalid.issues.length, 1); assert.equal(invalid.issues[0]!.sourceXml, malformed);
    }
  }
});

test('equivalent XML attribute order, numeric fields and qualifier order keep one report identity', async () => {
  for (const [name, attributes] of [
    ['sky_condition', 'sky_cover="BKN" cloud_base_ft_msl="7000" cloud_top_ft_msl="9000"'],
    ['turbulence_condition', 'turbulence_type="CHOP" turbulence_intensity="MOD" turbulence_freq="OCNL" turbulence_base_ft_msl="7000"'],
    ['icing_condition', 'icing_type="RIME" icing_intensity="MOD" icing_top_ft_msl="9000"'],
  ]) {
    const member = `<AircraftReport><observation_time>2026-10-13T06:20:00Z</observation_time>
      <latitude>38</latitude><longitude>-122</longitude><altitude_ft_msl>8000</altitude_ft_msl>
      <${name} ${attributes}/><raw_text>TEST REPORT</raw_text></AircraftReport>`;
    const equivalent = member.replace(attributes!, attributes!.split(' ').reverse().join(' ').replace('="7000"', '="+07000"'))
      .replace('<latitude>38', '<latitude>+3.8e1').replace('<longitude>-122', '<longitude>-1.22E2')
      .replace('<altitude_ft_msl>8000', '<altitude_ft_msl>+08000');
    const parsed = await parse(envelope([member, equivalent]));
    assert.equal(parsed.issues.length, 0, name); assert.equal(parsed.reports.length, 1, name);
    const flags = '<mid_point_assumed>TRUE</mid_point_assumed><flt_lvl_range>TRUE</flt_lvl_range>';
    const flagged = member.replace('<raw_text>', `<quality_control_flags>${flags}</quality_control_flags><raw_text>`);
    const reordered = flagged.replace(flags, '<flt_lvl_range>TRUE</flt_lvl_range><mid_point_assumed>TRUE</mid_point_assumed>');
    assert.equal((await parse(envelope([flagged, reordered]))).reports.length, 1, name);
  }
});

test('malformed condition heights and ambiguous qualifiers are issues with complete original evidence', async () => {
  for (const bad of ['INVALID', '', '1.5', '1e3', '-2001', '100001']) {
    const member = reportXml.replace('icing_base_ft_msl="10500"', `icing_base_ft_msl="${bad}"`);
    const parsed = await parse(envelope([reportXml, member]));
    assert.equal(parsed.reports.length, 1, bad); assert.equal(parsed.issues.length, 1, bad);
    assert.equal(parsed.issues[0]!.sourceXml, member);
  }
  for (const member of [
    reportXml.replace('icing_base_ft_msl="10500"', 'icing_base_ft_msl="15000"'),
    reportXml.replace('icing_type="RIME"', 'unknown_condition="RIME"'),
    reportXml.replace('<raw_text>', '<raw_text><AircraftReport/>'),
    reportXml.replace('<aircraft_ref>', '<quality_control_flags><bad_location>FALSE</bad_location><bad_location>TRUE</bad_location></quality_control_flags><aircraft_ref>'),
    reportXml.replace('<aircraft_ref>', '<quality_control_flags>unsupported qualifier</quality_control_flags><aircraft_ref>'),
  ]) {
    const parsed = await parse(envelope([reportXml, member]));
    assert.equal(parsed.reports.length, 1); assert.equal(parsed.issues.length, 1);
    assert.equal(parsed.issues[0]!.qualityFlag, undefined);
    assert.equal(parsed.issues[0]!.sourceXml, member);
  }
});

test('AWC location/time exclusions remain classified when raw text cannot recover their flagged fields', async () => {
  for (const [flag, field] of [['no_time_stamp', 'observation_time'], ['bad_location', 'latitude']]) {
    for (const replacement of ['', `<${field}>invalid</${field}>`]) {
      let flagged = reportXml.replace(new RegExp(`<${field}>[^<]*</${field}>`), replacement)
        .replace('<aircraft_ref>', `<quality_control_flags><${flag}>TRUE</${flag}></quality_control_flags><aircraft_ref>`);
      if (flag === 'no_time_stamp') flagged = flagged.replace(/\/TM\s*\d{4}/, '/TM UNKN');
      const partial = await parse(envelope([reportXml, flagged]));
      assert.equal(partial.reports.length, 1);
      assert.equal(partial.issues.length, 1);
      assert.equal(partial.issues[0]!.qualityFlag, flag);
      assert.equal(partial.issues[0]!.sourceXml, flagged);
    }
  }
});

test('unlocated observations retain validated fields for /OV recovery without promoting malformed members', async () => {
  const raw = reportXml.replace(/<raw_text>.*?<\/raw_text>/s, '<raw_text>GFK UUA /OV GFK180005/TM 0521/FL140/TP B737/IC MOD RIME</raw_text>');
  for (const member of [
    raw.replace('<aircraft_ref>', '<quality_control_flags><bad_location>TRUE</bad_location></quality_control_flags><aircraft_ref>'),
    raw.replace(/<latitude>[^<]*<\/latitude>/, ''),
    raw.replace(/<latitude>[^<]*<\/latitude>/, '<latitude>91</latitude>'),
  ]) {
    const partial = await parse(envelope([member]));
    assert.ok(isPirepSnapshot(partial)); assert.equal(partial.reports.length, 0);
    const report = partial.issues[0]!.report!;
    assert.ok(report); assert.equal(report.observedAt, Date.parse('2026-10-13T05:21:00Z'));
    assert.equal(report.aircraft, 'B737'); assert.equal(report.altitudeFt, 14000);
    assert.deepEqual(report.icing, ['RIME MOD · 10500–14000 ft MSL']);
    assert.equal(partial.issues[0]!.sourceXml, member); assert.equal('sourceXml' in report, false);
    assert.equal('latitude' in report, false); assert.equal('longitude' in report, false);
    assert.equal(isPirepSnapshot({ ...partial, issues: [{ ...partial.issues[0], report: { ...report, latitude: 0 } }] }), false);
    assert.equal(isPirepSnapshot({ ...partial, issues: [{ ...partial.issues[0], report: { ...report, observedAt: NOW + 60_001 } }] }), false);
    assert.equal(isPirepSnapshot({ ...partial, issues: [{ ...partial.issues[0], report: { ...report, sourceXml: '<different/>' } }] }), false);
    for (const malformed of [member.replace('icing_base_ft_msl="10500"', 'icing_base_ft_msl="INVALID"'),
      member.replace('2026-10-13T05:21:00.000Z', 'invalid'),
      member.replace('2026-10-13T05:21:00.000Z', '2026-10-14T05:21:00Z'),
      member.replace('<raw_text>', '<raw_text><unexpected/>')]) {
      const issue = (await parse(envelope([malformed]))).issues[0]!;
      assert.equal(issue.report, undefined); assert.equal(issue.qualityFlag, undefined);
    }
  }
  const missingTime = raw.replace('<aircraft_ref>', '<quality_control_flags><bad_location>TRUE</bad_location><no_time_stamp>TRUE</no_time_stamp></quality_control_flags><aircraft_ref>');
  const recovered = await parse(envelope([missingTime]));
  assert.ok(isPirepSnapshot(recovered));
  assert.equal(recovered.issues[0]!.report?.timeSource, 'raw');
  assert.equal(recovered.issues[0]!.report?.observedAt, Date.parse('2026-10-13T05:21:00Z'));
  assert.equal((await parse(envelope([missingTime.replace('/TM 0521', '/TM UNKN')]))).issues[0]!.report, undefined);
});

test('report selection respects clock, altitude and negative reports without changing forecast altitude', () => {
  const c = createWeatherController({ advisories: { restore: () => ({ loading: false }), refresh: async () => { throw new Error(); } } });
  const urgent = snapshot.reports.find(r => r.urgent)!;
  const state = { ...c.getSnapshot(), now: NOW, pireps: { loading: false, snapshot },
    preferences: weatherAwcPreferences.select({ awcEnabled: true, awcPireps: true }) };
  assert.ok(selectedPireps(state).some(r => r.id === urgent.id));
  assert.equal(selectedPireps({ ...state, selectedTime: NOW + 1 }).length, 0);
  assert.equal(selectedPireps({ ...state, now: NOW + PIREP_MAX_AGE_MS }).length, 0);
  assert.equal(selectedPireps({ ...state, preferences: { ...state.preferences, awcPirepAge: '30' } }).some(r => r.id === urgent.id), false);
  const lower = selectedPireps({ ...state, preferences: { ...state.preferences, awcPirepAltitude: 'low' } });
  assert.ok(lower.every(r => r.altitudeFt !== null && r.altitudeFt < 10_000));
  const icing = selectedPireps({ ...state, preferences: { ...state.preferences, awcPirepHazard: 'icing' } });
  assert.ok(icing.length && icing.every(r => r.icing.length));
  assert.ok(selectedPireps({ ...state, selectedTime: urgent.observedAt }).every(r => r.observedAt <= urgent.observedAt));
});

test('background PIREPs publish, survive restart and failures, reject old source time, and replace with empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-pireps-'));
  let now = NOW, modified = NOW, body = captured, fail = false, reads = 0;
  const options = { directory, now: () => now, startUpdates: false, spacing: 0, fetch: async (url: string | URL | Request) => {
    assert.equal(String(url), PIREP_SOURCE); reads++;
    return new Response(fail ? 'unavailable' : body, { status: fail ? 500 : 200,
      headers: { 'last-modified': new Date(modified).toUTCString() } });
  } };
  let app = await createInfoServer(options);
  const listen = async () => {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const addr = app.server.address(); assert.ok(addr && typeof addr === 'object'); return `http://127.0.0.1:${addr.port}`;
  };
  try {
    let origin = await listen();
    assert.equal((await fetch(origin + '/api/weather/pireps.json')).status, 503); assert.equal(reads, 0, 'HTTP cannot acquire');
    app.pireps.refresh(); await app.pireps.close();
    const first = await (await fetch(origin + '/api/weather/pireps.json')).json();
    assert.ok(isPirepSourceSnapshot(first)); assert.equal(first.checkedAt, NOW);
    assert.equal(first.records.length, 2098);
    assert.equal(app.pireps.status.recordCount, 2098); assert.equal(app.pireps.status.error, null);
    await app.close(); app = await createInfoServer(options); origin = await listen();
    assert.equal(reads, 1); assert.equal(app.pireps.status.checkedAt, NOW);
    assert.equal(app.pireps.status.recordCount, 2098);
    now += 61_000; fail = true; app.pireps.refresh(); await app.pireps.close();
    assert.ok(app.pireps.status.error); assert.equal(app.pireps.status.checkedAt, NOW);
    assert.equal((await fetch(origin + '/api/weather/pireps.json')).status, 200, 'last snapshot remains readable within source age bound');
    now += 61_000; fail = false; modified = NOW - 60_000; app.pireps.refresh(); await app.pireps.close();
    assert.ok(app.pireps.status.error); assert.equal(app.pireps.status.checkedAt, NOW);
    now += 61_000; modified = now; body = gzipSync(envelope([])); app.pireps.refresh(); await app.pireps.close();
    assert.equal(app.pireps.status.error, null);
    assert.equal((await (await fetch(origin + '/api/weather/pireps.json')).json()).records.length, 0);
    now += 61_000; modified = now; body = gzipSync(envelope(['<AircraftReport/>', '<AircraftReport/>']));
    app.pireps.refresh(); await app.pireps.close();
    assert.equal(app.pireps.status.ready, true); assert.equal(app.pireps.status.error, null);
    assert.equal(app.pireps.status.recordCount, 2, 'uninterpretable entries are still complete source delivery');
    now -= 3600_000; modified = now;
    app.pireps.refresh(); await app.pireps.close();
    assert.equal(app.pireps.status.checkedAt, now, 'clock rollback releases the old retry deadline and future publication');
    assert.equal(app.pireps.status.error, null);
    now += 11 * 60_000;
    assert.equal((await fetch(origin + '/api/weather/pireps.json')).status, 503);
    // A 200 for an old CDN publication must not advance the source clock.
    app.pireps.refresh(); await app.pireps.close(); assert.equal(app.pireps.status.error, 'stale-source');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('browser caches raw source and interprets it on live acquisition and offline restoration', async t => {
  const { PirepClient } = await import('../src/layers/weather-awc/pireps/client');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { stored } = browserCache(t);
  const raw = { ...source, records: [reportXml, reportXml, '<AircraftReport/>'] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(raw));
  const endpoint = 'https://fixture.invalid/api/weather/pireps.json', signal = new AbortController().signal;
  const decoded = await new PirepClient(endpoint).refresh(signal);
  assert.equal(decoded.reports.length, 1); assert.equal(decoded.issues.length, 1);
  assert.deepEqual(await [...stored.values()][0]!.clone().json(), raw, 'saved source includes duplicates and undecodable members');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline restore must not fetch'); });
  assert.deepEqual(await new PirepClient(endpoint).restore(signal), { snapshot: decoded, loading: false, restored: true });
});

test('server migration reacquires complete source instead of reusing either legacy cache entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zlayer-pireps-migration-'));
  let reads = 0;
  const options = { directory, now: () => NOW, startUpdates: false, spacing: 0, fetch: async () => {
    reads++;
    return new Response(captured, { headers: { 'last-modified': new Date(NOW).toUTCString() } });
  } };
  let app = await createInfoServer(options);
  try {
    const body = Buffer.from(JSON.stringify(snapshot));
    const old = { body, status: 200, checkedAt: NOW, sha256: digest(body),
      headers: { 'content-type': 'application/json', 'x-weather-catalog': 'pireps-v1' } };
    const published = resourceFor('/api/weather/pireps.json');
    await app.cache.put(published, old);
    await app.cache.put({ key: PIREP_SOURCE, url: PIREP_SOURCE, upstream: 'awc', kind: 'pirep-cache',
      ttl: 10 * 60_000, maxBytes: PIREP_MAX_BYTES }, old);
    await app.close(); app = await createInfoServer(options);
    assert.equal(reads, 0); assert.equal(app.pireps.status.ready, false);
    assert.equal(await app.cache.read(published), undefined, 'old interpretation is not complete source delivery');
    app.pireps.refresh(); await app.pireps.close();
    assert.equal(reads, 1, 'legacy upstream bytes cannot satisfy the new source identity');
    assert.equal(app.pireps.status.ready, true); assert.equal(app.pireps.status.recordCount, 2098);
    const saved = await app.cache.read(published);
    assert.ok(saved); assert.equal(saved.headers['x-weather-catalog'], 'pireps-v2');
    assert.deepEqual(JSON.parse(saved.body.toString()), source);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const schemaVersion of [1, 2]) test(`browser acquisition rejects a regressing publication without advancing its saved source time (schema ${schemaVersion})`, async t => {
  const { PirepClient } = await import('../src/layers/weather-awc/pireps/client');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  // This observation predates both clocks, so source rollback remains the only variable.
  const original = { ...source, records: [reportXml] };
  const payload = schemaVersion === 2 ? original : decodePirepSource(original);
  let checkedAt = NOW;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...payload, checkedAt }));
  const client = new PirepClient('https://fixture.invalid/api/weather/pireps.json'), signal = new AbortController().signal;
  assert.equal((await client.refresh(signal)).checkedAt, NOW);
  checkedAt -= 60_000;
  await assert.rejects(client.refresh(signal), /older source publication/);
  checkedAt = NOW + 60_000;
  await assert.rejects(client.refresh(signal), /future source timestamp/);
  // A clock correction must not leave the former live timestamp as a barrier.
  checkedAt = NOW - 3600_000; t.mock.timers.setTime(checkedAt);
  assert.equal((await client.refresh(signal)).checkedAt, checkedAt);
  checkedAt -= 60_000;
  await assert.rejects(client.refresh(signal), /older source publication/);
});

test('browser restore migrates inline snapshots, ignores future/foreign data and tolerates storage failure', async t => {
  const { PirepClient } = await import('../src/layers/weather-awc/pireps/client');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const endpoint = 'https://fixture.invalid/api/weather/pireps.json';
  const live = { ...snapshot, reports: [snapshot.reports[0]!] };
  const { storage, cache } = browserCache(t);
  storage.setItem('', JSON.stringify({ endpoint, snapshot: { ...live, checkedAt: NOW + 60_000 } }));
  t.mock.method(globalThis, 'fetch', async () => Response.json(live));
  const client = new PirepClient(endpoint), signal = new AbortController().signal;
  assert.deepEqual(await client.restore(signal), { loading: false });
  storage.setItem('', JSON.stringify({ endpoint, snapshot: live }));
  assert.deepEqual(await client.restore(signal), { snapshot: live, loading: false, restored: true }, 'existing inline cache remains usable offline');
  assert.deepEqual(await client.refresh(signal), live, 'a future cache must not poison publication ordering');
  assert.deepEqual(await new PirepClient(endpoint).restore(signal), { snapshot: live, loading: false, restored: true });
  assert.deepEqual(await new PirepClient('https://other.invalid/api/weather/pireps.json').restore(signal), { loading: false });
  const pointer = storage.getItem()!;
  assert.equal(JSON.parse(pointer).checkedAt, NOW);
  assert.equal(JSON.parse(pointer).snapshot, undefined);
  const deniedCache = t.mock.method(cache, 'put', async () => { throw new Error('Cache storage denied'); });
  const newer = { ...live, checkedAt: NOW + 1000 };
  t.mock.method(globalThis, 'fetch', async () => Response.json(newer));
  assert.deepEqual(await client.refresh(signal), newer);
  assert.equal(storage.getItem(), pointer, 'failed persistence keeps the prior reference');
  deniedCache.mock.restore();
  t.mock.method(storage, 'setItem', () => { throw new Error('Storage full'); });
  assert.deepEqual(await client.refresh(signal), newer);
  t.mock.method(storage, 'getItem', () => { throw new Error('Storage unavailable'); });
  assert.deepEqual(await new PirepClient(endpoint).restore(signal), { loading: false });
});

test('large valid snapshots restore from the async file cache without a large localStorage write', async t => {
  const { PirepClient } = await import('../src/layers/weather-awc/pireps/client');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { storage, stored } = browserCache(t);
  const large = { ...snapshot, reports: Array.from({ length: 200 }, (_, i) => ({ ...snapshot.reports[0]!,
    id: i.toString(16).padStart(64, '0'), sourceXml: `<AircraftReport><raw_text>${'x'.repeat(19_000)}</raw_text></AircraftReport>` })) };
  const size = Buffer.byteLength(JSON.stringify(large));
  assert.ok(isPirepSnapshot(large)); assert.ok(size > 3 * 1024 * 1024 && size <= PIREP_MAX_BYTES);
  t.mock.method(globalThis, 'fetch', async () => Response.json(large));
  const endpoint = 'https://fixture.invalid/api/weather/pireps.json', signal = new AbortController().signal;
  assert.deepEqual(await new PirepClient(endpoint).refresh(signal), large);
  assert.ok(storage.getItem()!.length < 512, 'localStorage contains only a small authenticated reference');
  assert.equal(stored.size, 1);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline restore must not fetch'); });
  assert.deepEqual(await new PirepClient(endpoint).restore(signal), { snapshot: large, loading: false, restored: true });
  const saved = [...stored.values()][0]!;
  stored.set([...stored.keys()][0]!, new Response('damaged', { headers: saved.headers }));
  assert.deepEqual(await new PirepClient(endpoint).restore(signal), { loading: false }, 'damaged bytes cannot claim a restored snapshot');
});

test('live readiness precedes optional saving and a delayed restore cannot replace live data', async t => {
  const { PirepClient } = await import('../src/layers/weather-awc/pireps/client');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { cache } = browserCache(t);
  const endpoint = 'https://fixture.invalid/api/weather/pireps.json', signal = new AbortController().signal;
  let live = { ...snapshot, reports: [snapshot.reports[0]!] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(live));
  await new PirepClient(endpoint).refresh(signal);
  let release!: () => void, reading!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { reading = resolve; });
  const match = cache.match;
  let hold = true;
  t.mock.method(cache, 'match', async (key: RequestInfo | URL) => {
    const response = await match(key);
    if (hold) { hold = false; reading(); await held; }
    return response;
  });
  const client = new PirepClient(endpoint), restore = client.restore(signal);
  await started;
  live = { ...live, checkedAt: NOW + 1000 };
  let ready = false;
  const put = cache.put;
  t.mock.method(cache, 'put', async (...args: Parameters<typeof put>) => {
    assert.ok(ready, 'live data must be delivered before optional cache publication');
    return put(...args);
  });
  assert.deepEqual(await client.refresh(signal, value => { assert.equal(value.checkedAt, live.checkedAt); ready = true; }), live);
  release();
  assert.deepEqual(await restore, { loading: false });
  live = { ...live, checkedAt: NOW };
  await assert.rejects(client.refresh(signal), /older source publication/, 'late restoration cannot regress the source clock');
});
