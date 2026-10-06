import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { isNotamAirportSnapshot, isProcedureCatalog } from '@zlayer/contracts';
import { NOTAM_PARSER_VERSION, parseNotam } from '../src/layers/notams/parser';
import { NOTAM_MATCHER_VERSION, matchPlateNotams, notamTargetKind, procedureTargetMatch } from '../src/layers/notams/matcher';
import { notamInterpretationNotes } from '../src/layers/notams/flairs';
import { procedureSelection } from '../src/layers/plates/data';
import { procedureNoticeContext } from '../src/layers/plates/page-context';

// Diagnostic inventory, not a semantic oracle or a pass/fail qualification gate.
// Read only retained inputs; never fetch FAA data or modify source snapshots.
const [directory, catalogPath, output] = process.argv.slice(2);
if (!directory || !catalogPath || !output) throw new Error(
  'Usage: node --import=tsx tools/audit-notam-matching.ts CORPUS_DIRECTORY CATALOG.json REPORT.json');
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
  capture: { startedAt: string; finishedAt: string; reviewTime: number };
  payload: { file: string; bytes: number; sha256: string };
  totals: { airports: number; records: number };
  airports: { faaId: string; icaoId?: string; records: number }[];
};
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const payload = gunzipSync(await readFile(join(directory, manifest.payload.file)));
assert.equal(payload.length, manifest.payload.bytes, 'corpus size');
assert.equal(digest(payload), manifest.payload.sha256, 'corpus hash');
const catalogFile = await readFile(catalogPath), catalogBytes = catalogPath.endsWith('.gz') ? gunzipSync(catalogFile) : catalogFile;
const catalog: unknown = JSON.parse(catalogBytes.toString());
assert(isProcedureCatalog(catalog), 'catalog schema');
const lines = payload.toString().trimEnd().split('\n');
assert.equal(lines.length, manifest.totals.airports, 'airport count');

const increment = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const emptyCounts = () => ({ notices: 0, applies: 0, reviewOnly: 0, noMatch: 0 });
const totals = { airports: lines.length, retainedRecords: 0, eligibleRecords: 0, ...emptyCounts(),
  recognizedTargets: 0, unmatchedTargets: 0, unmatchedTargetNotices: 0, partialTargetNotices: 0,
  unresolvedNotices: 0, originalAmendmentSpellingNotices: 0, otherAmendmentReviewNotices: 0 };
const subjects: Record<string, ReturnType<typeof emptyCounts>> = {};
const issues: Record<string, number> = {}, notes: Record<string, number> = {}, reviewReasons: Record<string, number> = {};
const amendmentPairs: Record<string, number> = {};
const missingCatalog: string[] = [];
type Reference = { airport: string; id: string; number: string; series: string | null };
const references = (airport: string, record: { id: string; number: string; series: string | null }): Reference =>
  ({ airport, id: record.id, number: record.number, series: record.series });
const unmatchedTargets: (Reference & { subject: string; title: string; amendment: string | null; otherTitleMatched: boolean })[] = [];
const subjectOrHeadingIssues: (Reference & { issues: string[]; text: string })[] = [];
const originalAmendmentSpellings: (Reference & { pairs: string[] })[] = [];
const otherAmendmentReviews: (Reference & { pairs: string[] })[] = [];
const categoryRestrictions: (Reference & { runway: string; special: boolean; categories: string[]; plates: string[] })[] = [];
const plateFamilies: Record<string, { notices: number; withCatalogKind: number; matchedToKind: number; example: Reference }> = {};
const facilitySignatures = new Map<string, { notices: number; example: Reference; text: string }>();

for (const [index, line] of lines.entries()) {
  const snapshot: unknown = JSON.parse(line), expected = manifest.airports[index];
  assert(isNotamAirportSnapshot(snapshot) && expected, `snapshot ${index}`);
  assert.equal(snapshot.query.faaId, expected.faaId, 'FAA identity');
  assert.equal(snapshot.query.icaoId ?? '', expected.icaoId ?? '', 'ICAO identity');
  assert.equal(snapshot.records.length, expected.records, 'record count');
  const sourceBefore = JSON.stringify(snapshot);
  // Do not infer a K-prefix or select the first of conflicting catalog identities.
  const airports = catalog.airports.filter(a => !!a.faaId && a.faaId === snapshot.query.faaId ||
    !!a.icaoId && a.icaoId === snapshot.query.icaoId);
  assert(airports.length <= 1, `ambiguous catalog identity: ${expected.faaId}`);
  const airport = airports[0], plates = airport?.procedures.filter(p => p.source.userAction !== 'D') ?? [];
  if (!airport) missingCatalog.push(expected.faaId);
  const records = snapshot.records.filter(r => ['DOMESTIC', 'DOM', 'FDC'].includes(r.classification));
  totals.retainedRecords += snapshot.records.length;
  totals.eligibleRecords += records.length;
  const matchesById = new Map(records.map(record => [record.id, [] as {
    title: string; kind: string; amendment: string | null; outcome: string; reason: string;
  }[]]));
  for (const plate of plates) {
    const selection = procedureSelection(catalog, airport!, plate, 'https://audit.invalid/catalog.json', 'https://audit.invalid/');
    // Same catalog-entry context used by plate rows. This does not establish
    // unique airport/page context for combined-volume pages in the PDF viewer.
    const context = procedureNoticeContext(selection, airport!, plate);
    for (const match of matchPlateNotams(records, context).matches) matchesById.get(match.record.id)!.push({
      title: plate.name, kind: plate.kind, amendment: plate.source.amendmentNumber, outcome: match.outcome, reason: match.reason,
    });
  }
  for (const record of records) {
    const parsed = parseNotam(record), ref = references(expected.faaId, record), matches = matchesById.get(record.id)!;
    if (parsed.unresolved) totals.unresolvedNotices++;
    for (const issue of parsed.issues) increment(issues, issue);
    for (const note of notamInterpretationNotes(parsed)) increment(notes, note.label);
    if (parsed.categoryTarget) categoryRestrictions.push({ ...ref, runway: parsed.categoryTarget.runway,
      special: parsed.categoryTarget.special, categories: parsed.categoryTarget.values, plates: matches.map(m => m.title) });
    if (parsed.issues.some(i => i === 'subject' || i === 'headings' ||
      i === 'procedure-target' && parsed.subject !== 'ODP')) subjectOrHeadingIssues.push({ ...ref, issues: parsed.issues, text: parsed.body });
    if (parsed.issues.includes('facility-dependency')) {
      const signature = parsed.body.toUpperCase().replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ');
      const group = facilitySignatures.get(signature) ?? { notices: 0, example: ref, text: parsed.body };
      group.notices++;
      facilitySignatures.set(signature, group);
    }
    if (!parsed.procedureNotice) continue;
    const counts = subjects[parsed.subject!] ??= emptyCounts();
    const state = matches.some(m => m.outcome === 'applies') ? 'applies' : matches.length ? 'reviewOnly' : 'noMatch';
    totals.notices++; counts.notices++; totals[state]++; counts[state]++;
    for (const reason of new Set(matches.filter(m => m.outcome === 'review').map(m =>
      m.reason.replace(/notice amendment .*?displayed plate .*?\. /, 'notice/displayed amendment differ. ')))) increment(reviewReasons, reason);

    const targetResults = parsed.targets.map(target => ({ target, titleMatched: plates.some(plate =>
      procedureTargetMatch(target.title, parsed.subject, plate)) }));
    // Independently count each heading: one matching sibling must not hide a miss.
    // This is title/kind coverage only; actual match outcomes above also enforce
    // source airport association, lifecycle, amendment and conditional scope.
    if (['IAP', 'SID', 'STAR'].includes(parsed.subject!)) {
      totals.recognizedTargets += targetResults.length;
      const missing = targetResults.filter(r => !r.titleMatched);
      if (missing.length) {
        totals.unmatchedTargetNotices++;
        const otherTitleMatched = targetResults.some(r => r.titleMatched);
        if (otherTitleMatched) totals.partialTargetNotices++;
        for (const { target } of missing) unmatchedTargets.push({ ...ref, subject: parsed.subject!, title: target.title,
          amendment: target.amendment ?? null, otherTitleMatched });
      }
    }
    const originalPairs = new Set<string>(), otherPairs = new Set<string>();
    for (const match of matches.filter(m => /[Nn]otice amendment .*?, displayed plate /.test(m.reason))) {
      // Inventory the exact reason emitted by the matcher; do not assume that
      // every heading in a multi-target notice produced this match.
      const amendment = /[Nn]otice amendment (.*?), displayed plate /.exec(match.reason)![1]!;
      const pair = `${amendment} / ${match.amendment ?? 'unknown'}`;
      if (/^ORIG(?:-[A-Z])?$/.test(amendment) && amendment.replace(/^ORIG-?/, '0') === match.amendment) originalPairs.add(pair);
      else otherPairs.add(pair);
    }
    if (originalPairs.size) { totals.originalAmendmentSpellingNotices++; originalAmendmentSpellings.push({ ...ref, pairs: [...originalPairs] }); }
    if (otherPairs.size) { totals.otherAmendmentReviewNotices++; otherAmendmentReviews.push({ ...ref, pairs: [...otherPairs] }); }
    for (const pair of new Set([...originalPairs, ...otherPairs])) increment(amendmentPairs, pair);

    for (const family of new Set(parsed.targets.map(t => notamTargetKind(t.title, parsed.subject)).filter((kind): kind is NonNullable<typeof kind> => !!kind))) {
      const group = plateFamilies[family] ??= { notices: 0, withCatalogKind: 0, matchedToKind: 0, example: ref };
      group.notices++;
      if (plates.some(p => p.kind === family)) group.withCatalogKind++;
      if (matches.some(m => m.kind === family)) group.matchedToKind++;
    }
  }
  assert.equal(JSON.stringify(snapshot), sourceBefore, `source mutated: ${expected.faaId}`);
}
totals.unmatchedTargets = unmatchedTargets.length;
assert.equal(totals.retainedRecords, manifest.totals.records, 'corpus record count');
const report = {
  schemaVersion: 1,
  scope: 'Retained D/FDC corpus against catalog-entry matching; no effective-time filter, no PDF-viewer/page qualification, no semantic pass/fail oracle.',
  sources: { corpus: { ...manifest.payload, capture: manifest.capture }, catalog: {
    bytes: catalogBytes.length, sha256: digest(catalogBytes), cycle: catalog.cycle, effectiveDate: catalog.effectiveDate,
    expirationDate: catalog.expirationDate, generatedAt: catalog.generatedAt, sourceXml: catalog.sourceXml,
  } },
  implementation: { parserVersion: NOTAM_PARSER_VERSION, matcherVersion: NOTAM_MATCHER_VERSION },
  totals, subjects, issues, notes, reviewReasons, missingCatalog, plateFamilies, amendmentPairs,
  unmatchedTargets, subjectOrHeadingIssues, originalAmendmentSpellings, otherAmendmentReviews,
  categoryRestrictions: { notices: categoryRestrictions.length, matched: categoryRestrictions.filter(r => r.plates.length).length,
    unmatched: categoryRestrictions.filter(r => !r.plates.length).length, references: categoryRestrictions },
  facilitySignatures: [...facilitySignatures].map(([signature, group]) => ({ signature, ...group })).sort((a, b) => b.notices - a.notices),
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ totals, subjects, issues, notes }, null, 2));
