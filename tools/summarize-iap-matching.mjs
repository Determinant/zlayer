// Compare the retained policy-3 audit with a matching audit of the same edition.
// node --import=tsx tools/summarize-iap-matching.mjs <before.json[.gz]> <after.json> <output-prefix>
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { reviewedApproachAssociations } from '../packages/domain/src/approach-matching.ts';

const [beforePath, afterPath, output] = process.argv.slice(2);
if (!beforePath || !afterPath || !output) throw new Error('Expected before, after and output prefix');
const beforeBytes = readFileSync(beforePath), afterBytes = readFileSync(afterPath);
const before = JSON.parse(beforePath.endsWith('.gz') ? gunzipSync(beforeBytes) : beforeBytes);
const after = JSON.parse(afterBytes);
assert.equal(after.metadata.cycle, '2609', 'Recorded radar and source-review exceptions require a new review for other cycles');
assert.equal(before.metadata.cycle, after.metadata.cycle);
assert.equal(before.metadata.catalogSha256, after.metadata.catalogSha256);
const us = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const old = new Map(before.airports.flatMap(a => a.charts.map(c => [`${a.id}/${c.id}`, c])));
const states = new Map(after.airports.map(a => [a.id, a.state]));
const unresolved = (chart, entry) => chart.codedId === 'PABT:S02' || entry.warnings.length > 0 && chart.codedId !== 'KRFD:I07';
const counts = values => Object.fromEntries([...new Set(values)].sort().map(v => [v, values.filter(x => x === v).length]));
function summarize(audit, predicate) {
  const charts = audit.airports.filter(a => predicate(states.get(a.id))).flatMap(a => a.charts).filter(c => c.status !== 'visual-chart');
  const entries = charts.flatMap(c => c.entries), bad = charts.flatMap(c => c.entries.filter(e => unresolved(c, e)));
  const matched = charts.filter(c => c.status === 'matched');
  const clean = matched.filter(c => c.entries.length && !c.entries.some(e => unresolved(c, e)));
  return { instrumentCharts: charts.length, matchedCharts: matched.length, unmatchedCharts: charts.length - matched.length,
    uniqueSelectableRoutes: new Set(matched.flatMap(c => c.codedIds ?? [c.codedId])).size,
    entries: entries.length, unresolvedEntries: bad.length, acceptableEntries: entries.length - bad.length,
    acceptableCharts: clean.length, unresolvedCharts: matched.filter(c => c.entries.some(e => unresolved(c, e))).length,
    allChartCoveragePercent: 100 * clean.length / charts.length,
    offeredEntryCoveragePercent: 100 * (entries.length - bad.length) / entries.length,
    unmatchedReasons: counts(charts.map(c => c.unmatchedReason).filter(Boolean)) };
}
function mechanism(a, c) {
  if (reviewedApproachAssociations.some(([airport, title]) => airport === a.id && title === c.name)) return 'plate-reviewed-association';
  if (['87N', 'KJRA'].includes(a.id)) return 'heliport-export';
  if (c.name.endsWith('(SA CAT I)')) return 'category-i-title';
  if (/, CONT\.\d+$/.test(c.name)) return 'continuation-title';
  if (/ RWY \d{2}[LCR]\/[LCR]$/.test(c.name)) return 'parallel-runway-chart';
  if (c.name.startsWith('COPTER ')) return 'helicopter-heading-title';
  return 'conventional-title-format';
}
const recovered = [], ledger = [];
for (const a of after.airports) for (const c of a.charts) {
  const previous = old.get(`${a.id}/${c.id}`);
  assert.ok(previous, `${a.id}/${c.id} must exist in the baseline`);
  if (previous.status === 'matched') {
    assert.equal(c.status, 'matched');
    assert.deepEqual(c.entries.map(({ routeId, ...e }) => e), previous.entries, 'Existing offered entries and diagnostics must remain unchanged');
    continue;
  }
  if (previous.status === 'visual-chart') continue;
  const row = { airport: a.id, state: a.state, chartId: c.id, name: c.name, url: c.url,
    previousStatus: previous.status, status: c.status, reason: c.unmatchedReason,
    codedIds: c.codedIds, faaExcludedIds: c.faaExcludedIds, rawProcedureIds: a.rawProcedureIds,
    entries: c.entries.length, unresolvedEntries: c.entries.filter(e => unresolved(c, e)).length };
  ledger.push(row);
  if (c.status === 'matched') recovered.push({ ...row, mechanism: mechanism(a, c) });
}
const summary = { metadata: after.metadata, before: { us50dc: summarize(before, s => us.has(s)), fullFaa: summarize(before, () => true) },
  after: { us50dc: summarize(after, s => us.has(s)), fullFaa: summarize(after, () => true) },
  recoveryMechanisms: { us50dc: counts(recovered.filter(r => us.has(r.state)).map(r => r.mechanism)), fullFaa: counts(recovered.map(r => r.mechanism)) },
  preservedExistingCharts: before.summary.statuses.matched,
  expectedRadar: after.airports.flatMap(a => a.charts.filter(c => c.codedId === 'KRFD:I07').map(c => ({ airport: a.id, name: c.name, entries: c.entries.length, url: c.url }))),
  sourceReview: 'All six PABT:S02 entries remain unresolved: source MAP at BTT versus plate MAP at BTT 1.3 DME. See the policy-3 refinement review.',
  recovered };
writeFileSync(output + '.json', JSON.stringify(summary, null, 2) + '\n');
const cell = v => `"${String(Array.isArray(v) ? v.join('; ') : v ?? '').replaceAll('"', '""')}"`;
const columns = Object.keys(ledger[0]);
writeFileSync(output + '.csv', [columns, ...ledger.map(row => columns.map(k => row[k]))].map(row => row.map(cell).join(',')).join('\n') + '\n');
writeFileSync(output + '-national.json.gz', gzipSync(afterBytes, { level: 9 }));
console.log(JSON.stringify({ before: summary.before, after: summary.after, recoveryMechanisms: summary.recoveryMechanisms }, null, 2));
