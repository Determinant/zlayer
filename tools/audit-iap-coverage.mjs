// Read-only audit of every catalog approach and offered entry in one state.
// Run: node --import=tsx tools/audit-iap-coverage.mjs <cycle-directory> <output.json> [state]
// Writes detailed JSON and a companion chart-inventory CSV; changes no source data.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isTerminalProceduresData, isProcedureCatalog } from '@zlayer/contracts';
import { approachIdent, findApproachRoutes, approachEntryOptions, approachEntryLegs, approachPreview, distanceNm } from '@zlayer/domain';
import { approachCourse, bearing } from '../packages/domain/src/approach-geometry.ts';

const [directory, output, state = 'CA'] = process.argv.slice(2);
if (!directory || !output) throw new Error('Usage: node --import=tsx tools/audit-iap-coverage.mjs <cycle-directory> <output.json> [state]');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const catalogBytes = readFileSync(resolve(directory, 'tpp/catalog.json'));
const routesBytes = readFileSync(resolve(directory, 'nav/terminal-procedures.json'));
const catalog = JSON.parse(catalogBytes), terminal = JSON.parse(routesBytes);
if (!isProcedureCatalog(catalog) || !isTerminalProceduresData(terminal) || !terminal.approaches ||
    catalog.effectiveDate !== terminal.approaches.metadata.effectiveDate) throw new Error('Invalid or mismatched procedure editions');
const archive = resolve(directory, `nasr/CIFP_${catalog.effectiveDate.slice(2).replaceAll('-', '')}.zip`);
// FAA's excluded-procedure workbook is part of the source archive. Python's
// standard library reads the XLSX container; no spreadsheet service is needed.
const excluded = new Set(JSON.parse(execFileSync('python3', ['-c', `
import json,sys,zipfile,io,xml.etree.ElementTree as E
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as z:
 name=next(n for n in z.namelist() if n.startswith('Not_In_CIFP') and n.endswith('.xlsx'))
 with zipfile.ZipFile(io.BytesIO(z.read(name))) as w:
  strings=[''.join(si.itertext()) for si in E.fromstring(w.read('xl/sharedStrings.xml'))]
  result=[]
  for row in E.fromstring(w.read('xl/worksheets/sheet1.xml')).findall('.//m:row',ns):
   values={}
   for c in row:
    v=c.find('m:v',ns)
    if v is not None: values[''.join(x for x in c.attrib['r'] if x.isalpha())]=strings[int(v.text)] if c.attrib.get('t')=='s' else v.text
   if 'A' in values and 'B' in values: result.append(values['A']+':'+values['B'])
  print(json.dumps(result[1:]))
`, archive], { encoding: 'utf8' })));
const raw = readFileSync(resolve(directory, 'nasr/FAACIFP18'), 'utf8');
if (!raw.startsWith('HDR01') || raw.slice(35, 39) !== catalog.cycle) throw new Error('CIFP cycle does not match catalog');
const rawIds = new Set(), rawRoutes = new Map();
for (const line of raw.split(/\r?\n/)) {
  if (!['P', 'H'].includes(line[4]) || line[12] !== 'F' || !['0', '1'].includes(line[38])) continue;
  const id = `${line.slice(6, 10).trim()}:${line.slice(13, 19).trim()}`;
  rawIds.add(id);
  const branches = rawRoutes.get(id) ?? new Set();
  branches.add(`${line[19]}:${line.slice(20, 25).trim()}`); rawRoutes.set(id, branches);
}
const routes = new Map(terminal.approaches.procedures.map(p => [p.id, p]));
const rawAirports = new Set([...rawIds].map(id => id.split(':')[0]));
const near = (a, b) => distanceNm(a, b) < .01;
const angle = (a, b) => Math.abs((a - b + 540) % 360 - 180);
const round = value => Math.round(value * 1000) / 1000;
const crosses = (a, b, c, d) => {
  const side = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return side(a, b, c) * side(a, b, d) < -1e-15 && side(c, d, a) * side(c, d, b) < -1e-15;
};

// Select the exact source branch. Do not compare a feeder's TF with a same-name
// CF elsewhere in the procedure: a fix can be revisited from another direction.
function sourceLegs(procedure, entryId) {
  return approachEntryLegs(procedure, entryId);
}

function inspectEntry(procedure, entry) {
  const preview = approachPreview(procedure, entry.id), legs = sourceLegs(procedure, entry.id), warnings = [];
  const warn = (code, detail) => warnings.push({ code, ...detail });
  for (const issue of preview.issues) warn(issue.code, issue);
  const map = procedure.final.find(l => !l.missed && l.fix?.role === 'MAP')?.fix;
  const landing = preview.landingEnd === undefined ? undefined : preview.points[preview.landingEnd];
  if (map && (!landing || landing.ident !== map.ident || !near(landing.coordinate, map.coordinate)))
    warn('missing-landing-fix', { ident: map.ident });
  const faf = procedure.final.find(l => !l.missed && l.fix?.role === 'FAF')?.fix;
  if (faf && !preview.points.some((p, i) => i <= (preview.landingEnd ?? -1) && p.ident === faf.ident && near(p.coordinate, faf.coordinate)))
    warn('missing-final-approach-fix', { ident: faf.ident });
  for (const span of preview.spans.filter(s => s.kind !== 'gap' && s.coordinates.length > 1 && s.symbol !== 'hold')) {
    const leg = legs[span.legs.at(-1)], p = span.coordinates;
    if (leg?.path === 'CF' && leg.fix && near(p.at(-1), leg.fix.coordinate)) {
      const expected = approachCourse(leg, procedure);
      const actual = (bearing(p.at(-1), p.at(-2)) + 180) % 360;
      if (expected !== undefined && distanceNm(p.at(-1), p.at(-2)) > .02 && angle(actual, expected) > 15)
        warn('CF-course-mismatch', { index: span.legs.at(-1), degrees: round(angle(actual, expected)) });
    }
    if (span.kind !== 'schematic') continue;
    const maneuver = span.symbol === 'procedure-turn' || span.assumptions.includes('direct-return');
    const [climb, intercept, arrival] = span.legs.map(i => legs[i]);
    // Independently check the source and the crossing segment's course. A return
    // annotation alone must not exempt every crossing on its final segment.
    const floor = l => l?.altitude && ['', '+'].includes(l.altitude.restriction) && /^\d{5}$/.test(l.altitude.first)
      ? Number(l.altitude.first) : undefined;
    const climbCourse = climb && approachCourse(climb, procedure);
    const climbReturn = span.assumptions.includes('climb-return') && span.phase === 'missed' && span.legs.length === 3 &&
      [climb, intercept, arrival].every(l => l?.missed) && ['CA', 'VA', 'FA'].includes(climb.path) &&
      ['CI', 'VI'].includes(intercept.path) && intercept.turn && arrival.path === 'CF' &&
      floor(climb) !== undefined && floor(arrival) > floor(climb) &&
      arrival.reference?.type === 'navaid' && arrival.reference.coordinate && arrival.reference.declination !== undefined &&
      arrival.fix && near(arrival.fix.coordinate, arrival.reference.coordinate) && near(p.at(-1), arrival.fix.coordinate);
    let returnCrossings = 0;
    if (span.symbol !== 'procedure-turn') for (let i = 1; i < p.length; i++) for (let j = i + 2; j < p.length; j++) {
      if (span.assumptions.includes('direct-return') && j === p.length - 1) continue;
      if (!crosses(p[i - 1], p[i], p[j - 1], p[j])) continue;
      if (climbReturn && j === p.length - 1 && climbCourse !== undefined &&
          angle(bearing(p[i - 1], p[i]), climbCourse) < .2 && ++returnCrossings === 1) continue;
      warn('schematic-self-crossing', { kind: span.symbol, segments: [i - 1, j - 1] });
    }
    if (span.assumptions.includes('climb-return') && (!climbReturn || returnCrossings !== 1)) warn('unverified-climb-return', {});
    const length = p.slice(1).reduce((sum, x, i) => sum + distanceNm(p[i], x), 0);
    const direct = distanceNm(p[0], p.at(-1));
    if (!maneuver && !span.assumptions.includes('altitude-dependent') && length > 2 * direct + 3) warn('schematic-detour', { kind: span.symbol, lengthNm: round(length), directNm: round(direct) });
    for (let i = 1; i < p.length - 1; i++) {
      if (distanceNm(p[i - 1], p[i]) < .001 || distanceNm(p[i], p[i + 1]) < .001) continue;
      const bend = angle(bearing(p[i], p[i - 1]) + 180, bearing(p[i], p[i + 1]));
      if (bend > 90) warn('schematic-sharp-bend', { kind: span.symbol, vertex: i, degrees: round(bend) });
    }
  }
  for (const line of [...preview.segments, ...preview.depictions]) {
    if (line.coordinates.some(p => p.some(x => !Number.isFinite(x)))) warn('nonfinite-geometry', {});
  }
  if (preview.incomplete && !warnings.length) warn('unclassified-gap', {});
  return { id: entry.id, name: entry.name, incomplete: preview.incomplete, policy: preview.policy,
    assumptions: [...new Set(preview.spans.flatMap(s => s.assumptions))], issues: preview.issues,
    points: preview.points.length, segments: preview.segments.length,
    schematics: [...new Set(preview.depictions.map(d => d.kind))], warnings };
}

const airports = [];
for (const airport of catalog.airports.filter(a => state === '*' || a.state === state)) {
  const charts = airport.procedures.filter(c => c.kind === 'approach' && c.source.userAction !== 'D');
  if (!charts.length) continue;
  const airportCode = airport.icaoId ?? airport.faaId;
  const records = charts.map(chart => {
    const procedures = findApproachRoutes(terminal.approaches, airportCode, chart.name), procedure = procedures[0];
    const ident = approachIdent(chart.name), id = procedure?.id ?? (ident && `${airportCode}:${ident}`);
    // Candidate aliases are diagnostic only; they never select a route in the app.
    const conventionalTitle = chart.name.replace(/ OR (?:GPS|TACAN)(?=[ -])/, '').replace(/^LOC\/DME BC-/, 'LOC BC-').replace(/^LOC\/DME-/, 'LOC-');
    const candidate = approachIdent(conventionalTitle);
    const candidateId = candidate && `${airportCode}:${candidate}`;
    // The FAA omission workbook uses both S/V for runway VOR procedures and
    // N/Q for NDB/DME. These identifiers are evidence for the ledger only;
    // they never authorize an association with an available route.
    // Legacy numbered VOR charts also have literal numbered workbook IDs.
    const numberedVor = /^VOR-(\d) RWY (\d{2}[LCR]?)$/.exec(chart.name);
    const omissionCandidates = [ident, candidate, numberedVor && `S${numberedVor[2]}${numberedVor[1]}`].filter(Boolean)
      .flatMap(i => [i, i.replace(/^S(?=\d)/, 'V'), i.replace(/^N(?=\d)/, 'Q')])
      .flatMap(i => [i, i.replaceAll('-', '')]);
    const faaExcludedIds = [...new Set(omissionCandidates.map(i => `${airportCode}:${i}`).filter(i => excluded.has(i)))];
    const visual = /\bVISUAL\b/.test(chart.name);
    // A missing exact identifier is not proof that FAA omitted the procedure:
    // chart names and CIFP identifiers sometimes use different variants/types.
    const status = visual ? 'visual-chart' : procedure ? 'matched' : ident ? terminal.approaches.unavailable?.some(p => p.id === id) ? 'unavailable-source-branch' : rawIds.has(id) ? 'export-omission' : 'no-exact-coded-match' : 'unmatched-title';
    const unmatchedReason = visual || procedure ? null
      : ['export-omission', 'unavailable-source-branch'].includes(status) ? status
      : /\bCAT (?:II|III)\b|\bCAT I - II\b|\bPRM\b|\bCONVERGING\b|^GLS\b/.test(chart.name) ? 'outside-published-cifp-scope'
      : faaExcludedIds.length ? 'faa-listed-omission'
      : !rawAirports.has(airportCode) ? 'airport-without-coded-approaches'
      : / RWY \d{2}[LCR]\/[LCR]$/.test(chart.name) ? 'distinct-runway-branches'
      : /^(HI-|TACAN\b|COPTER\b)/.test(chart.name) ? 'special-family-without-verified-association'
      : ident ? 'no-exact-source-record' : 'unrecognized-title';
    return { id: chart.id, name: chart.name, url: chart.pdfUrl, status,
      codedId: id ?? null, codedIds: procedures.map(p => p.id), availableTitleCandidate: !procedure && routes.has(candidateId) ? candidateId : null,
      faaExcluded: faaExcludedIds.length > 0, faaExcludedIds, unmatchedReason,
      rawBranches: [...new Set((procedures.length ? procedures.map(p => p.id) : [id]).flatMap(id => [...(rawRoutes.get(id) ?? [])]))].sort(),
      unofferedTransitions: procedures.flatMap(p => p.transitions.filter(t => !approachEntryOptions(p).some(e => e.id === `transition:${t.id}`))
        .map(t => procedures.length > 1 ? `${p.ident}:${t.id}` : t.id)),
      entries: procedures.flatMap(p => approachEntryOptions(p).map(entry => ({ ...inspectEntry(p, entry), routeId: p.id }))) };
  });
  airports.push({ id: airport.id, name: airport.name, state: airport.state,
    rawProcedureIds: [...rawIds].filter(id => id.startsWith(`${airportCode}:`)).sort(), charts: records });
}
const records = airports.flatMap(a => a.charts), entries = records.flatMap(c => c.entries);
const warningCounts = {};
for (const entry of entries) for (const code of new Set(entry.warnings.map(w => w.code))) warningCounts[code] = (warningCounts[code] ?? 0) + 1;
const summary = {
  airports: airports.length, catalogApproachRecords: records.length,
  instrumentChartRecords: records.filter(c => c.status !== 'visual-chart').length,
  statuses: Object.fromEntries([...new Set(records.map(c => c.status))].sort().map(status => [status, records.filter(c => c.status === status).length])),
  unmatchedReasons: Object.fromEntries([...new Set(records.map(c => c.unmatchedReason).filter(Boolean))].sort().map(reason => [reason, records.filter(c => c.unmatchedReason === reason).length])),
  availableTitleCandidates: records.filter(c => c.availableTitleCandidate).length,
  faaExcludedRecords: records.filter(c => c.faaExcluded).length,
  matchedWithoutEntries: records.filter(c => c.status === 'matched' && !c.entries.length).length,
  unofferedTransitions: records.reduce((sum, c) => sum + c.unofferedTransitions.length, 0),
  entries: entries.length, incompleteEntries: entries.filter(e => e.incomplete).length,
  chartsWithGaps: records.filter(c => c.entries.some(e => e.incomplete)).length,
  airportsWithGaps: airports.filter(a => a.charts.some(c => c.entries.some(e => e.incomplete))).length,
  warningEntries: entries.filter(e => e.warnings.length).length,
  warningEntriesMarkedComplete: entries.filter(e => !e.incomplete && e.warnings.length).length,
  warningCounts,
};
const report = { metadata: { state, cycle: catalog.cycle, effectiveDate: catalog.effectiveDate,
  catalogSha256: hash(catalogBytes), routesSha256: hash(routesBytes), cifpSha256: hash(raw),
  rendererSha256: hash(readFileSync(new URL('../packages/domain/src/approaches.ts', import.meta.url))),
  matchingSha256: hash(readFileSync(new URL('../packages/domain/src/approach-matching.ts', import.meta.url))),
  joiningSha256: hash(readFileSync(new URL('../packages/domain/src/approach-joining.ts', import.meta.url))),
  geometrySha256: hash(['approach-geometry.ts', 'approach-path.ts', 'approach-path-geometry.ts'].map(f => readFileSync(new URL('../packages/domain/src/' + f, import.meta.url))).join('\n')),
  schemaVersion: terminal.approaches.metadata.schemaVersion ?? 1,
  scope: 'Every non-deleted catalog approach record in the state, all offered entries; automated screening, not plate certification.',
  geometryThresholds: { courseMismatchDegrees: 15, sharpBendDegrees: 90, detour: 'length > 2 * endpoint distance + 3 NM, except bounded reversals and altitude-dependent paths' },
}, summary, airports };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const inventory = [['airport', 'airportName', 'chart', 'status', 'codedId', 'faaExcluded', 'unmatchedReason', 'faaExcludedIds', 'entries', 'incompleteEntries', 'unofferedTransitions', 'entryWarnings', 'plateUrl'],
  ...airports.flatMap(a => a.charts.map(c => [a.id, a.name, c.name, c.status, c.codedId, c.faaExcluded,
    c.unmatchedReason, c.faaExcludedIds.join('; '),
    c.entries.length, c.entries.filter(e => e.incomplete).length, c.unofferedTransitions.join('; '),
    c.entries.filter(e => e.warnings.length).map(e => `${e.id}: ${[...new Set(e.warnings.map(w => w.code))].join(', ')}`).join('; '), c.url]))];
writeFileSync(output.replace(/\.json$/, '') + '.csv', inventory.map(row => row.map(cell).join(',')).join('\n') + '\n');
console.log(JSON.stringify(summary, null, 2));
