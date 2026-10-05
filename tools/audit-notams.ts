import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isNotamAirportSnapshot, type NotamRecord } from '@zlayer/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseNotam, localNotamContent } from '../src/layers/notams/parser';
import { presentNotam, notamBlockText, type NotamBodyBlock, type NotamPresentation } from '../src/layers/notams/presentation';
import { NotamList } from '../src/layers/notams/ui';
import { chartedNotamPresentation, notamChartKey } from '../src/layers/notams/chart';
import { notamObstacles } from '../src/layers/notams/obstacles';
import { notamArea } from '../src/layers/notams/areas';
import { NOTAM_COORDINATE } from '../src/layers/notams/coordinates';
import { auditValueBindings } from './notam-value-audit';

const numbers = (text: string) => text.match(/\d+(?:\.\d+)?/g) ?? [];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const increment = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };

// This is a content-preservation check, not a second semantic parser. Only known
// display aliases and grammar words are normalized; identifiers/qualifiers remain.
function words(text: string, kind: NotamBodyBlock['kind']): string[] {
  let value = text.toUpperCase().replace(/\s+/g, ' ').replace(/TAKE-OFF/g, 'TAKEOFF').replace(/&/g, 'AND')
    .replace(/\bAMDT\b/g, 'AMENDMENT');
  if (kind === 'instruction') value = value.replace(/CHANGE (.*?) TO READ\b/g, 'REPLACE $1')
    .replace(/\bINOP\b/g, 'INOPERATIVE').replace(/\bCATS\b/g, 'CATEGORIES');
  if (['minima', 'minima-group', 'takeoff', 'takeoff-group', 'distances'].includes(kind)) {
    value = value.replace(/NOT AUTHORIZED/g, 'NA').replace(/\bRWYS?\b/g, 'RUNWAY').replace(/\bCATS?\b|\bCATEGORIES\b/g, 'CAT')
      .replace(/\bVIS\b/g, 'VISIBILITY').replace(/\bSTD\b/g, 'STANDARD')
      .replace(/\bFEET\b/g, 'FT').replace(/\bDIST\b/g, 'DISTANCES');
  }
  if (kind === 'takeoff' || kind === 'takeoff-group') value = value.replace(/STANDARD MINIMUMS/g, 'STANDARD')
    .replace(/(?:WITH (?:A )?)?MINIMUM CLIMB(?: GRADIENT)?(?: OF)?/g, 'MINIMUM CLIMB').replace(/FT PER NM/g, 'FT/NM');
  return (value.match(/[A-Z]+|\d+(?:\.\d+)?|[*#]/g) ?? []).sort();
}

function sourceWords(source: string, block: NotamBodyBlock): string[] {
  // Repeated explicit scopes can share a heading; shorthand visibility rows gain
  // an explicit label. Account for these grammar operations, never arbitrary words.
  if (block.kind === 'minima') {
    const scope = block.scope.toUpperCase();
    if (!['MINIMUMS', 'VISIBILITY'].includes(scope)) {
      source = source.split(/(,\s*)/).map((part, i) => i > 0 && part.startsWith(`${scope} `) ? part.slice(scope.length + 1) : part).join('');
    }
    const result = words(source, block.kind);
    if (['Minimums', 'Visibility'].includes(block.scope)) result.push(block.scope.toUpperCase());
    const explicit = (source.match(/\bVIS(?:IBILITY)?\b/g) ?? []).length;
    const displayed = block.rows.flatMap(row => row.values).filter(v => v.label === 'Visibility').length;
    result.push(...Array(Math.max(0, displayed - explicit)).fill('VISIBILITY'));
    if (/^SIDESTEP:? \d/.test(source)) result.push('RUNWAY');
    return result.sort();
  }
  return words(source, block.kind);
}

export function auditNotam(record: NotamRecord, presentation?: NotamPresentation): string[] {
  const before = JSON.stringify(record), parsed = parseNotam(record), body = parsed.body;
  presentation ??= presentNotam(record);
  const issues: string[] = [];
  const fail = (reason: string) => issues.push(reason);
  if (presentation.blocks.length !== presentation.sourceSpans.length) fail('block/span count');
  let end = 0;
  for (const [index, block] of presentation.blocks.entries()) {
    const span = presentation.sourceSpans[index];
    if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < end || span.end < span.start || span.end > body.length) { fail(`span ${index}`); continue; }
    const gap = body.slice(end, span.start);
    const identityLength = body.length - localNotamContent(body, record).length;
    if (gap.trim() && !(index === 0 && span.start === identityLength)) fail(`uncovered text before ${index}`);
    const source = body.slice(span.start, span.end);
    let display = notamBlockText(block);
    if (block.kind === 'instruction' && ['Condition', 'Exception', 'Inoperative equipment condition'].includes(block.label)) display = block.text;
    // Value order may change when categories precede numbers or labeled triplets
    // become a table. Exact field/category associations are tested by golden cases.
    if (!equal(numbers(source).sort(), numbers(display).sort())) fail(`numeric preservation ${index}`);
    if (body && !equal(sourceWords(source, block), words(display, block.kind))) fail(`word preservation ${index}`);
    for (const issue of auditValueBindings(source, block)) fail(`${issue} ${index}`);
    end = span.end;
  }
  const suffix = body.slice(end).trim();
  if (suffix) {
    const range = /^(\d{10})-(\d{10})(EST)?$/.exec(suffix);
    const stamp = (value: number | null) => value === null ? '' : new Date(value).toISOString().replace(/\D/g, '').slice(2, 12);
    if (!range || range[1] !== stamp(record.startsAt) || range[2] !== stamp(record.endsAt) ||
      (range[3] ? record.endKind !== 'estimated' : record.endKind !== 'fixed')) fail('unaccounted validity suffix');
  }
  for (const item of [...parsed.flairs, ...parsed.targets]) {
    if (body.slice(item.evidence.start, item.evidence.end) !== item.evidence.text) fail('invalid evidence span');
  }
  if (JSON.stringify(record) !== before) fail('source mutated');
  return issues;
}

/** Check the shared React reader, excluding the raw disclosure and metadata. */
export function auditRenderedNotam(record: NotamRecord, mapped = false): string[] {
  const presentation = mapped ? chartedNotamPresentation(record)?.presentation : presentNotam(record);
  if (!presentation) return [];
  const html = renderToStaticMarkup(createElement(NotamList, { entries: [{ record }], now: record.startsAt ?? 0,
    ...(mapped ? { charted: new Set([notamChartKey(record)]) } : {}) }));
  const start = html.indexOf('<div class="notam-readable">'), end = html.indexOf('<div class="notam-validity">');
  if (!presentation.blocks.length) return start < 0 ? [] : ['unexpected mapped body'];
  if (start < 0 || end < start) return ['readable region missing'];
  // React emits escaped text and these known entities. Decode once, after removing
  // generated tags; literal markup in a source notice must remain text.
  const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };
  // Expand the reader's one explicit compact label before comparing all content.
  // This preserves category/footnote multiplicity; it does not accept arbitrary titles.
  const displayed = html.slice(start, end).replace(/<p class="notam-chart-note">[\s\S]*?<\/p>/g, '').replaceAll('<abbr title="Visibility">Vis</abbr>', 'Visibility')
    .replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|#x27);/g, entity => entities[entity]!);
  return equal(words(displayed, 'text'), words(presentation.searchText, 'text')) ? [] : ['rendered content differs from reading model'];
}

/** Independent deletion check for the shortened reader: location prose is the
 * only removable content, apart from exact unconditional statuses visible as badges. */
export function auditMappedNotam(record: NotamRecord, reading = chartedNotamPresentation(record)?.presentation): string[] {
  if (!reading) return [];
  const parsed = parseNotam(record), area = notamArea(record), obstacles = notamObstacles(record);
  let retained: string;
  if (obstacles.some(o => o.standalone)) {
    const content = localNotamContent(parsed.body, record).replace(/\s+/g, ' ').trim();
    const height = /\(\d+(?:\.\d+)?\s*FT AGL\)/.exec(content);
    if (!height) return ['mapped obstacle lacks explicit height'];
    retained = content.slice(height.index + height[0].length).trim();
    const lighting = /^OBST (?:\w+ ){1,2}LGT\b/.test(content);
    if (retained.replace(/\.$/, '') === 'FLAGGED AND LGTD' && parsed.flairs.some(f => f.label === 'Flagged and Lighted')) retained = '';
    else if (retained.replace(/\.$/, '') === 'U/S' && lighting && parsed.flairs.some(f => f.label === 'Obstacle Light Outage')) retained = '';
    else if (lighting) retained = `LGT ${retained}`;
  } else if (area) {
    // The elided source may contain coordinates, radius, explicit location aliases
    // and closure wording. Altitudes, operational nouns and conditions are not geometry.
    const location = parsed.body.slice(area.span.start, area.span.end).replace(NOTAM_COORDINATE, '')
      .replace(/\((?:[.\d]+\s*NM?\s*[NSEW]{1,3}\s+[A-Z0-9]+|[A-Z0-9]{2,5}\s*\d{6}(?:\.\d+)?)\)/g, '');
    if ((location.match(/[A-Z]+/g) ?? []).some(w => !['WI','WITHIN','A','AN','AREA','DEFINED','AS','NM','RADIUS','OF','CENTERED','AT','TO','THE','POINT','ORIGIN'].includes(w))) {
      return ['mapped area removed non-location wording'];
    }
    retained = parsed.body.slice(0, area.span.start) + parsed.body.slice(area.span.end);
  } else retained = parsed.body.replace(NOTAM_COORDINATE, '');
  if (!retained.trim()) return reading.blocks.length ? ['unexpected mapped content'] : [];
  // Rebase spans on independently retained source, so the ordinary audit checks
  // every remaining word/value without borrowing the shortened model's source.
  const reference = presentNotam({ ...record, text: retained });
  if (!equal(words(reading.searchText, 'text'), words(reference.searchText, 'text'))) return ['mapped operational content differs'];
  return [];
}

async function main() {
  const [directory, output] = process.argv.slice(2);
  if (!directory || !output) throw new Error('Usage: node --import=tsx tools/audit-notams.ts SNAPSHOT_DIRECTORY REPORT.json');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
    rankingSource: string; rankingDate: string; airports: { rank?: number; faaId: string; icaoId: string }[];
  };
  const unique = new Map<string, NotamRecord>(), airports = [], issues = [];
  for (const airport of manifest.airports) {
    const snapshot: unknown = JSON.parse(await readFile(join(directory, `${airport.icaoId}.json`), 'utf8'));
    if (!isNotamAirportSnapshot(snapshot) || snapshot.query.faaId !== airport.faaId || snapshot.query.icaoId !== airport.icaoId) {
      throw new Error(`Invalid snapshot or airport identity: ${airport.icaoId}`);
    }
    const blocks: Record<string, number> = {};
    for (const record of snapshot.records) {
      // Audit before the first derivation below, so a mutation cannot be hidden by caching.
      const findings = auditNotam(record);
      if (findings.length) issues.push({ airport: airport.icaoId, id: record.id, issues: findings });
      const previous = unique.get(record.id);
      if (previous && !equal(previous, record)) issues.push({ airport: airport.icaoId, id: record.id, issues: ['inconsistent copies'] });
      unique.set(record.id, record);
      for (const block of presentNotam(record).blocks) increment(blocks, block.kind);
    }
    airports.push({ ...airport, records: snapshot.records.length, blocks, feed: snapshot.feed, associationCoverage: snapshot.associationCoverage });
  }
  const blocks: Record<string, number> = {}, classes: Record<string, number> = {}, subjects: Record<string, number> = {};
  const fallback = new Map<string, { count: number; exampleId: string; text: string }>();
  let noticesWithValues = 0, proseOnly = 0, closureRestrictions = 0;
  for (const record of unique.values()) {
    const findings = [...auditRenderedNotam(record), ...auditMappedNotam(record), ...auditRenderedNotam(record, true)];
    if (findings.length) issues.push({ id: record.id, issues: findings });
    increment(classes, record.classification); increment(subjects, parseNotam(record).subject ?? 'Unknown');
    const presentation = presentNotam(record);
    if (presentation.blocks.some(b => ['minima', 'minima-group', 'takeoff', 'takeoff-group', 'distances'].includes(b.kind))) noticesWithValues++;
    if (presentation.blocks.every(b => b.kind === 'text')) proseOnly++;
    closureRestrictions += parseNotam(record).flairs.filter(f => f.label.endsWith('Closure Restriction')).length;
    for (const block of presentation.blocks) {
      increment(blocks, block.kind);
      if (block.kind !== 'text') continue;
      const key = block.text.toUpperCase().replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ');
      const entry = fallback.get(key) ?? { count: 0, exampleId: record.id, text: block.text };
      entry.count++; fallback.set(key, entry);
    }
  }
  const mappedNotices = [...unique.values()].filter(r => chartedNotamPresentation(r)).length;
  const totals = { airports: airports.length, uniqueRecordIds: unique.size, classes, subjects, blocks, noticesWithValues, proseOnly, closureRestrictions, mappedNotices, issues: issues.length };
  await writeFile(output, JSON.stringify({ auditedAt: new Date().toISOString(), rankingSource: manifest.rankingSource,
    rankingDate: manifest.rankingDate, totals, airports, issues, fallbackPatterns: [...fallback.values()].sort((a, b) => b.count - a.count) }, null, 2) + '\n');
  console.log(JSON.stringify(totals, null, 2));
  if (issues.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
