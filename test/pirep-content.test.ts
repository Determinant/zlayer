import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { isPirepSnapshot, type PirepSourceSnapshot } from '@zlayer/contracts';
import { decodePirepSource } from '../src/layers/weather-awc/pireps/decode';
import { readPirepHazard, readPirepSky } from '../src/layers/weather-awc/pireps/content';
import { pirepConditions } from '../src/layers/weather-awc/pireps/selection';
import { readPirepAltitude } from '../src/layers/weather-awc/pireps/content-altitude';

const october15: PirepSourceSnapshot = JSON.parse(await readFile(new URL('./fixtures/pireps/2026-10-15-unplotted.json', import.meta.url), 'utf8'));
const extra: { captures: PirepSourceSnapshot[] } = JSON.parse(await readFile(new URL('./fixtures/pireps/2026-10-15-content.json', import.meta.url), 'utf8'));
const remaining: { captures: PirepSourceSnapshot[] } = JSON.parse(await readFile(new URL('./fixtures/pireps/2026-10-15-content-remaining.json', import.meta.url), 'utf8'));

test('captured six reports have independently specified content expectations, not merely preserved source fields', () => {
  const snapshot = decodePirepSource(october15);
  const reports = [...snapshot.reports, ...snapshot.issues.map(issue => issue.report!)];
  const expected = [
    { station: 'PBI', altitude: 3000, aircraft: 'P28A', sky: ['BKN · 2200–? ft MSL'], turbulence: [] },
    { station: 'LTS', altitude: 500, aircraft: 'C17', sky: ['BKN · 200–? ft MSL'], turbulence: [] },
    { station: 'DPA', altitude: null, aircraft: 'C25C', sky: ['BKN · 2500–? ft MSL'], turbulence: [] },
    { station: 'CID', altitude: 1700, aircraft: 'SR22', sky: ['OVC · 1700–? ft MSL'], turbulence: [] },
    { station: 'POU', altitude: 400, aircraft: 'P28A', sky: [], turbulence: ['MOD'] },
    { station: 'EEO', altitude: 36000, aircraft: 'B752', sky: [], turbulence: ['LGT CONT', 'MOD OCNL'] },
  ];
  for (const e of expected) {
    const report = reports.find(r => r.text.startsWith(`${e.station} `))!;
    assert.ok(report, e.station);
    assert.equal(report.altitudeFt, e.altitude, e.station); assert.equal(report.aircraft, e.aircraft, e.station);
    assert.deepEqual(report.sky, e.sky, e.station); assert.deepEqual(report.turbulence, e.turbulence, e.station);
    assert.deepEqual(report.icing, [], e.station); assert.equal(report.urgent, false, e.station);
  }
});

test('captured content errors recover cloud shorthand, coverage ranges, hazard clauses and frequency ranges', () => {
  const reports = extra.captures.flatMap(source => {
    const snapshot = decodePirepSource(source); assert.ok(isPirepSnapshot(snapshot));
    return [...snapshot.reports, ...snapshot.issues.map(issue => issue.report!)];
  });
  for (const [raw, field, expected] of [
    ['/TB CONS LGT OCNL MOD CHOP 230-250', 'turbulence', ['LGT CONT', 'CHOP MOD OCNL · 23000–25000 ft MSL']],
    ['/TB OCNL-CONS LGT-MOD CAT 370', 'turbulence', ['CAT LGT-MOD OCNL-CONT · at 37000 ft MSL']],
    ['/IC MOD RIME 180-150 NEG 140', 'icing', ['RIME MOD · 15000–18000 ft MSL', 'NEG · at 14000 ft MSL']],
    ['/IC TRACE MX 160 NEG 150', 'icing', ['MIXED TRC · at 16000 ft MSL', 'NEG · at 15000 ft MSL']],
    ['/SK B005 T021', 'sky', ['Unspecified · 500–2100 ft MSL']],
    ['/SK T050 B018', 'sky', ['Unspecified · 1800–5000 ft MSL']],
    ['/SK SCT-BKN035-TOP040', 'sky', ['SCT-BKN · 3500–4000 ft MSL']],
    ['/SK TOPS 060V065', 'sky', ['Unspecified · base ? / top 6000–6500 ft MSL']],
    ['/SK OVC011-TOP045-100', 'sky', ['OVC · base 1100 / top 4500–10000 ft MSL']],
  ] as const) {
    const report = reports.find(report => report.text.includes(raw))!;
    assert.ok(report, raw); assert.deepEqual(report[field], expected, raw);
  }
  for (const level of ['B350', '1400', '0100', '015-']) {
    const report = reports.find(report => report.text.includes(`/FL${level}/`))!;
    assert.equal(report.altitudeFt, null, level); assert.match(report.contentNotes![0]!, /altitude|Altitude/);
  }
  const ambiguous = reports.find(report => report.text.includes('/SK OVC007-TOPS1600'))!;
  assert.deepEqual(ambiguous.sky, ['OVC · base 700 ft MSL / top 1600 (units unresolved)'], 'a four-digit top cannot silently become 16,000 ft');
});

test('STJ retains conflicting clouds and explicitly unknown altitude instead of source zero', async () => {
  const xml = (await readFile(new URL('./fixtures/pireps/2026-10-15-stj.xml', import.meta.url), 'utf8')).trim();
  const snapshot = decodePirepSource({ ...october15, checkedAt: Date.parse('2026-10-15T17:26:37Z'), records: [xml] });
  const report = snapshot.reports[0]!;
  assert.equal(report.altitudeFt, null);
  assert.deepEqual(report.sky, ['OVC · reported base 25000 / top 2000 ft MSL (inconsistent)']);
  assert.match(pirepConditions(report).join(' '), /Altitude unresolved: \/FL2000/);
  assert.equal(report.sourceXml, xml);
  const { contentNotes: _notes, ...legacy } = report;
  const repaired = decodePirepSource({ ...snapshot, reports: [{ ...legacy, altitudeFt: 0 }] });
  assert.deepEqual(repaired.reports, snapshot.reports, 'already-plotted legacy reports receive the same content correction');
  assert.equal(isPirepSnapshot({ ...snapshot, reports: [{ ...report, contentNotes: [42] }] }), false);
});

test('hazard state transitions keep qualifiers, height limits, repeated layers and terminal attribution', () => {
  for (const [text, expected] of [
    ['CONS LGT CAT OCNL MOD', ['CAT LGT CONT', 'MOD OCNL']],
    ['CONS LGT-OCNL MOD', ['LGT CONT', 'MOD OCNL']],
    ['LGT-MOD CONS', ['LGT-MOD CONT']],
    ['OCNLLGT CHOP', ['CHOP LGT OCNL']],
    ['MOD-CHOP-INTMT', ['CHOP MOD INTMT']],
    ['LGT 240-240/ MOD 320-335/ NEG ABV 335', ['LGT · 24000–24000 ft MSL', 'MOD · 32000–33500 ft MSL', 'NEG · above 33500 ft MSL']],
    ['MOD-SEV BLO 080', ['MOD-SEV · below 8000 ft MSL']],
    ['NEG/ZLC', ['NEG']],
    ['MOD CHOP SHORT FINAL', ['CHOP MOD · on short final']],
    ['MOD CHOP 003 AND BELOW', ['CHOP MOD · at or below 300 ft MSL']],
    ['CONT TURB', ['Intensity unspecified CONT']],
    ['MOD 170 OCNL BLO 160', ['MOD · at 17000 ft MSL', 'Intensity unspecified OCNL · below 16000 ft MSL']],
    ['LGT CHOP THRU 040', ['CHOP LGT · through 4000 ft MSL (other bound unspecified)']],
    ['N/A', []],
  ] as const) assert.deepEqual(readPirepHazard(text, 'TB'), expected, text);
  assert.deepEqual(readPirepHazard('LGT RIME DURC 260-268', 'IC'), ['RIME LGT · during climb 26000–26800 ft MSL']);
  for (const text of ['CONS', 'LGT EXTRA', 'LGT 150-', 'MOD 1500', 'MOD BLO', 'MOD/UNKNOWN', 'SHORT FINAL', 'LGT 150 AGL',
    'MOD 003 AND', 'MOD 003 AND BEYOND', 'MOD ABOVE 003 AND BELOW', 'MOD SHORT FINAL EXTRA', 'N/A LGT', 'LEG CHOP', 'ZDVWC-34 LGT']) {
    assert.equal(readPirepHazard(text, 'TB'), undefined, text);
  }
});

test('sky states preserve unknowns, explicit shorthand and full-layer boundaries without guessing omitted units', () => {
  for (const [text, expected] of [
    ['B004 TUNKN', ['Unspecified · 400–? ft MSL']],
    ['013OVCUNKN', ['OVC · 1300–? ft MSL']],
    ['BASE OVC027', ['OVC · 2700–? ft MSL']],
    ['B023 OVC T028', ['OVC · 2300–2800 ft MSL']],
    ['OVC015-TOP035/OVC230', ['OVC · 1500–3500 ft MSL', 'OVC · 23000–? ft MSL']],
    ['OVC010-TOPS ABOVE120', ['OVC · base 1000 / top above 12000 ft MSL']],
    ['SCT-BKN050-TOP100', ['SCT-BKN · 5000–10000 ft MSL']],
    ['OVC065-TOPUNKN', ['OVC · 6500–? ft MSL']],
    ['OVC100-TOP110/ SKC', ['OVC · 10000–11000 ft MSL', 'SKC above 11000 ft MSL']],
    ['TOPS038 CLR ABV', ['Unspecified · ?–3800 ft MSL', 'CLR above 3800 ft MSL']],
    ['OVC007-TOPS1600', ['OVC · base 700 ft MSL / top 1600 (units unresolved)']],
    ['OVC013-040', ['OVC · reported heights 1300 / 4000 ft MSL (base/top roles unspecified)']],
    ['OVC015-TOP', ['OVC · 1500–? ft MSL']],
    ['VV002', ['Vertical visibility 200 ft']],
    ['CLR AT 010, CLOUDS ABOVE. NO ESTIMATE', ['CLR at 1000 ft MSL; clouds above (heights unspecified)']],
    ['B027 T032 LYRS ABV', ['Unspecified · 2700–3200 ft MSL; additional layers above (heights unspecified)']],
    ['UNKNOVC056', ['OVC · reported height 5600 ft MSL (UNKN qualifier scope unclear)']],
    ['BASES BKN010 TOPS VRB/060', ['BKN · base 1000 ft MSL / top variable (reported 6000 ft MSL; bounds unspecified)']],
  ] as const) assert.deepEqual(readPirepSky(text), expected, text);
  for (const text of ['OVC015 EXTRA', 'OVC015 AGL', 'OVC015/', 'OVC013-040 TOP060', 'TOPS VRB/', 'VV002 EXTRA',
    'CLR AT 010, CLOUDS ABOVE. NO ESTIMATE EXTRA', 'B027 T032 LYRS ABV EXTRA', 'UNKNOVC056 EXTRA',
    'VV002 OVC005', 'UNKNOVC056 TOP100', 'CLR AT 010 BASE020', 'TOP038 CLR ABV 050']) {
    assert.equal(readPirepSky(text), undefined, text);
  }
});

test('all 20 remaining condition fields retain the known facts and explicitly identify source ambiguity', () => {
  const reports = remaining.captures.flatMap(source => {
    const snapshot = decodePirepSource(source); assert.ok(isPirepSnapshot(snapshot));
    assert.deepEqual(decodePirepSource(snapshot), snapshot, 'restoration keeps interpretations, source notes and identities stable');
    assert.deepEqual(decodePirepSource(decodePirepSource(snapshot)), snapshot);
    const records = [...snapshot.reports, ...snapshot.issues.map(issue => ({ ...issue.report!, sourceXml: issue.sourceXml }))];
    for (const report of records) assert.ok(source.records.includes(report.sourceXml), 'original evidence is unchanged');
    return records;
  });
  assert.equal(reports.length, 27);
  const expectations = [
    ['ONT', 'turbulence', ['CHOP MOD · at or below 300 ft MSL']],
    ['BDL', 'turbulence', ['Intensity unspecified CONT']],
    ['FLL', 'turbulence', ['CHOP LGT']],
    ['GRR UA /OV KGRR', 'sky', ['OVC · reported heights 2700 / 3500 ft MSL (base/top roles unspecified)']],
    ['SUS', 'sky', ['OVC · reported heights 1300 / 4000 ft MSL (base/top roles unspecified)']],
    ['NEW', 'sky', ['CLR at 1000 ft MSL; clouds above (heights unspecified)']],
    ['ABI', 'turbulence', ['CHOP LGT']],
    ['DFW', 'sky', ['SCT · reported heights 2500 / 2700 ft MSL (base/top roles unspecified)']],
    ['CPS', 'turbulence', ['CHOP LGT · on short final']],
    ['OLM', 'sky', ['Vertical visibility 200 ft']],
    ['EVV', 'sky', ['OVC · base 700 ft MSL / top 1600 (units unresolved)']],
    ['EMP', 'turbulence', ['MOD · at 17000 ft MSL', 'Intensity unspecified OCNL · below 16000 ft MSL']],
    ['BET', 'turbulence', ['CHOP LGT · through 4000 ft MSL (other bound unspecified)']],
    ['GRR UA /OV GRR', 'sky', ['Unspecified · 2700–3200 ft MSL; additional layers above (heights unspecified)']],
    ['IND', 'sky', ['OVC · reported height 5600 ft MSL (UNKN qualifier scope unclear)']],
    ['MOT', 'turbulence', []], ['MOT', 'icing', []],
    ['OKC', 'sky', ['Unspecified · top unknown']],
    ['STL', 'sky', ['BKN · base 1000 ft MSL / top variable (reported 6000 ft MSL; bounds unspecified)']],
    ['LAR', 'icing', []],
  ] as const;
  assert.equal(expectations.length, 20);
  for (const [prefix, field, expected] of expectations) {
    const matches = reports.filter(report => report.text.startsWith(prefix));
    assert.equal(matches.length, 1, prefix); assert.deepEqual(matches[0]![field], expected, prefix);
  }
  for (const station of ['FLL', 'ABI']) assert.match(reports.find(r => r.text.startsWith(station))!.contentNotes!.join(' '), /assumed spelling correction/);
  for (const station of ['NEW', 'MOT', 'OKC']) {
    const report = reports.find(r => r.text.startsWith(station))!;
    assert.deepEqual(report.icing, [], `${station}: AWC NEGclr must not become an explicit negative icing observation`);
    assert.match(report.contentNotes!.join(' '), /AWC icing qualifier: NEGclr/);
  }
  assert.match(reports.find(r => r.text.startsWith('LAR'))!.contentNotes!.join(' '), /Icing not reported.*ZDVWC-34/);
});

test('all eight remaining altitude cases distinguish missing units, incomplete ranges, absent heights and probable transposition', () => {
  const reports = remaining.captures.flatMap(source => {
    const snapshot = decodePirepSource(source); return [...snapshot.reports, ...snapshot.issues.map(issue => issue.report!)];
  });
  for (const [station, note] of [
    ['DLH', /possible transposition: B350 at 11000 ft MSL \(unconfirmed\)/],
    ['MHK', /\/FL1400; nonstandard digit count without explicit units/],
    ['DPA', /\/FL0100; nonstandard digit count without explicit units/],
    ['STJ', /\/FL2000; nonstandard digit count without explicit units/],
    ['HYA', /VFR supplies flight conditions, not a height/],
    ['OAK', /starts at 1500 ft MSL, other endpoint missing/],
    ['RST', /\/FL2000; nonstandard digit count without explicit units/],
    ['AFW', /nonstandard token DURA supplies no height/],
  ] as const) {
    const report = reports.find(report => report.text.startsWith(station))!;
    assert.ok(report, station); assert.equal(report.altitudeFt, null, station);
    assert.match(report.contentNotes!.join(' '), note, station);
  }
  assert.equal(reports.find(report => report.text.startsWith('DLH'))!.aircraft, '', 'the suspected altitude in /TP is not published as an aircraft type');
  assert.deepEqual(readPirepAltitude('2000'), { kind: 'units-unknown', value: '2000' });
  assert.deepEqual(readPirepAltitude('2000 FT MSL'), { kind: 'single', feet: 2000 });
  assert.deepEqual(readPirepAltitude('2000 FT AGL'), { kind: 'qualified', feet: 2000, qualifier: 'AGL' });
  assert.deepEqual(readPirepAltitude('015-020'), { kind: 'range', low: 1500, high: 2000 });
  assert.deepEqual(readPirepAltitude('BLO 020'), { kind: 'qualified', feet: 2000, qualifier: 'below' });
  for (const value of ['2000 FT MSL EXTRA', '015-FOO', 'FL', '015--020', 'ABV 020-030', '100001 FT', '015/020']) {
    assert.deepEqual(readPirepAltitude(value), { kind: 'unsupported' }, value);
  }
});

test('unparsed fields remain explicit, duplicate empty sky does not erase its observation, and remarks stay terminal', () => {
  const xml = (raw: string) => `<AircraftReport><observation_time>2026-10-15T16:41:00Z</observation_time><latitude>40</latitude><longitude>-100</longitude><altitude_ft_msl>3000</altitude_ft_msl><raw_text>${raw}</raw_text></AircraftReport>`;
  for (const [raw, expected] of [
    ['PBI UA /FL030/SK /SK BKN022/TB MOD EXTRA/IC TRACE-RIME', { sky: ['BKN · 2200–? ft MSL'], turbulence: ['Reported /TB: MOD EXTRA (not fully decoded)'], icing: ['RIME TRC'] }],
    ['PBI UA /FL030/SK BKN022/RM /TB MOD /SK OVC015', { sky: ['BKN · 2200–? ft MSL'], turbulence: [], icing: [] }],
    ['PBI UA /FL030/SK OVC100-TOP110/ SKC', { sky: ['OVC · 10000–11000 ft MSL', 'SKC above 11000 ft MSL'], turbulence: [], icing: [] }],
  ] as const) {
    const report = decodePirepSource({ ...october15, records: [xml(raw)] }).reports[0]!;
    assert.deepEqual(report.sky, expected.sky); assert.deepEqual(report.turbulence, expected.turbulence); assert.deepEqual(report.icing, expected.icing);
  }
});

test('numeric altitude recovery honors MSL quality, source conflicts and repeated legacy interpretation', () => {
  const xml = (level: string, altitude: string, flags = '') => `<AircraftReport><observation_time>2026-10-15T16:41:00Z</observation_time><latitude>40</latitude><longitude>-100</longitude>${flags}${altitude}<raw_text>PBI UA /FL${level}/TP C172</raw_text></AircraftReport>`;
  for (const [member, expected] of [
    [xml('030', ''), 3000],
    [xml('30', '<altitude_ft_msl>3000</altitude_ft_msl>'), 3000],
    [xml('000', '<altitude_ft_msl>0</altitude_ft_msl>'), 0],
    [xml('030', '<altitude_ft_msl>0</altitude_ft_msl>'), null],
    [xml('030', '', '<quality_control_flags><above_ground_level_indicated>TRUE</above_ground_level_indicated></quality_control_flags>'), null],
  ] as const) {
    const snapshot = decodePirepSource({ ...october15, records: [member] });
    assert.equal(snapshot.reports[0]!.altitudeFt, expected, member);
    assert.deepEqual(decodePirepSource(snapshot), snapshot, 'restoring an interpreted view cannot erase the original conflict');
  }
});
