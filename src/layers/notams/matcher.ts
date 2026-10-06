import type { NotamRecord, ProcedureKind, ProcedureRecord } from '@zlayer/contracts';
import type { PlateNoticeContext } from '../plates/public';
import { normalizeRunway, parseNotam, type ParsedNotam } from './parser';
import { approachFacilities } from './interpretation';
import { approachTitleIdentity, approachTitleKey, type ApproachCategory } from './procedure-title';

export const NOTAM_MATCHER_VERSION = 8;
export type PlateNotamMatch = { record: NotamRecord; parsed: ParsedNotam; outcome: 'applies' | 'review'; reason: string };
const numbers = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
  'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN', 'TWENTY'];
const continuationSuffix = /,?\s*CONT\.\s*\d+\s*$/i;
export function normalizeProcedureTitle(title: string, named = false): string {
  let text = title.toUpperCase().replace(continuationSuffix, '').replace(/\bRWY\s+0(\d)/g, 'RWY $1');
  if (named) text = text.replace(/\b(?:DEPARTURE|ARRIVAL)\b/g, '').replace(/\(RNAV\)/g, '')
    .replace(/\b[A-Z]+\b/g, word => numbers.includes(word) ? String(numbers.indexOf(word)) : word);
  else {
    const key = approachTitleKey(text);
    if (key) return key;
  }
  return text.replace(/[^A-Z0-9]/g, '');
}

export function procedureTitleAliases(title: string, named: boolean): string[] {
  return titleAliases(normalizeProcedureTitle(title, named), named);
}
function titleAliases(normalized: string, named: boolean): string[] {
  const combined = !named && /^((?:HI)?(?:COPTER)?)(ILS(?:DME)?[XYZ]?)OR(LOC(?:DME)?[XYZ]?)(RWY\d{1,2}[LRC]?|[A-Z])((?:(?:SA)?CAT\[[I,]+\])*)$/.exec(normalized);
  // Keep the qualifier, runway and each branch's own variant/subtype. In
  // "ILS OR LOC Z", only the LOC branch is Z; never transfer it to the ILS.
  return combined ? [normalized, `${combined[1]}${combined[2]}${combined[4]}${combined[5]}`, `${combined[1]}${combined[3]}${combined[4]}${combined[5]}`] : [normalized];
}

/** Comparison keys never replace the FAA's source spelling or amendment. */
export function normalizeProcedureAmendment(value: string): string {
  return value.trim().toUpperCase().replace(/^AMDT\s*/, '').replace(/^ORIG(?:INAL)?(?:-([A-Z]))?$/, (_, letter: string | undefined) => `0${letter ?? ''}`);
}

export function notamTargetKind(title: string, subject: string | undefined): ProcedureKind | undefined {
  if (subject === 'IAP') return /^RADAR[ -]\d+$/i.test(title) ? 'radar-minimums' : 'approach';
  if (subject === 'SID') return 'departure';
  if (subject === 'STAR') return 'arrival';
  if (subject === 'ODP' || subject === 'DVA') return /^DIVERSE VECTOR AREA/i.test(title) || subject === 'DVA' ? 'diverse-vector-area'
    : /^(?:IFR )?TAKE-?OFF MINIMUMS/i.test(title) || !title ? 'takeoff-minimums' : 'departure';
  return;
}

/** Relevance is distinct from identity equality: a combined chart can contain
 * the notice's affected category. Report only the explicit common category. */
export function procedureTargetMatch(title: string, subject: string | undefined, plate: ProcedureRecord): { scope?: string; review?: string } | undefined {
  const kind = notamTargetKind(title, subject);
  if (kind !== plate.kind) return;
  if (kind === 'takeoff-minimums') return /^(?:IFR )?TAKE-?OFF MINIMUMS(?: AND \(OBSTACLE\) DEPARTURE PROCEDURES)?$/i.test(title) ? {} : undefined;
  if (kind === 'diverse-vector-area') return /^DIVERSE VECTOR AREA(?:\s*\((?:DVA|RADAR VECTORS)\))?$/i.test(title) ? {} : undefined;
  if (kind === 'radar-minimums') return /^RADAR[ -]1$/i.test(title) ? {} : undefined;
  const named = kind !== 'approach';
  const targetIdentity = !named && approachTitleIdentity(title), plateIdentity = !named && approachTitleIdentity(plate.name);
  if (targetIdentity && plateIdentity && targetIdentity.categories.length && plateIdentity.categories.length) {
    if (!titleAliases(targetIdentity.base, false).some(key => titleAliases(plateIdentity.base, false).includes(key))) return;
    const scopes = targetIdentity.categories.flatMap(category => {
      const common = category.values.filter(value => plateIdentity.categories.some(c => c.special === category.special && c.values.includes(value)));
      return common.length ? [`${category.special ? 'SA ' : ''}CAT ${common.join('/')}`] : [];
    });
    return scopes.length ? { scope: scopes.join('; ') } : undefined;
  }
  const plateTitle = subject === 'ODP' ? plate.name.replace(/\(OBSTACLE\)/gi, '') : plate.name;
  if (procedureTitleAliases(title, named).some(key => procedureTitleAliases(plateTitle, named).includes(key))) return {};
  // AIM 5-4-5 describes removing /DME from titles in favor of chart equipment
  // notes. Keep identity keys distinct; this forward transition is review-only.
  // Preserve HI/COPTER, variants, runway/circling letter and the OR TACAN branch.
  if (targetIdentity && plateIdentity && /^(?:HI)?(?:COPTER)?VORDME/.test(targetIdentity.key) &&
      targetIdentity.key.replace(/^((?:HI)?(?:COPTER)?)VORDME/, '$1VOR') === plateIdentity.key)
    return { review: 'Possible VOR/DME title transition. Verify the chart equipment notes and procedure edition.' };
  return;
}

function categoryScope(parsed: ParsedNotam, plate: ProcedureRecord): string | undefined {
  const target = parsed.categoryTarget, runway = /\bRWY\s+(\d{1,2}[LRC]?)\b/i.exec(plate.name)?.[1];
  if (!target || plate.kind !== 'approach' || !runway || normalizeRunway(runway) !== target.runway || !/\bILS\b/i.test(plate.name)) return;
  const category = approachTitleIdentity(plate.name)?.categories.find(c => c.special === target.special);
  const common = category?.values.filter(value => target.values.includes(value));
  return common?.length ? `${target.special ? 'SA ' : ''}CAT ${common.join('/')}` : undefined;
}

function missingCategories(target: ApproachCategory, plates: readonly ProcedureRecord[]): string[] {
  const categories = plates.flatMap(plate => approachTitleIdentity(plate.name.replace(continuationSuffix, ''))?.categories ?? []);
  return target.values.filter(value => !categories.some(category => category.special === target.special && category.values.includes(value)));
}

// Immutable catalog/record references share coverage across rows and clock ticks.
// Weak keys let replaced editions and snapshots leave memory with their owners.
const coverageByCatalog = new WeakMap<readonly ProcedureRecord[], {
  procedures: readonly ProcedureRecord[]; records: WeakMap<NotamRecord, readonly string[]>;
}>();

function unmatchedProcedureReferences(record: NotamRecord, parsed: ParsedNotam, catalogProcedures: readonly ProcedureRecord[]): readonly string[] {
  let coverage = coverageByCatalog.get(catalogProcedures);
  if (!coverage) {
    coverage = { procedures: catalogProcedures.filter(p => p.source.userAction !== 'D'), records: new WeakMap() };
    coverageByCatalog.set(catalogProcedures, coverage);
  }
  const cached = coverage.records.get(record);
  if (cached) return cached;
  const missing: string[] = [];
  for (const target of parsed.targets) {
    const related = coverage.procedures.filter(p => procedureTargetMatch(target.title, parsed.subject, p));
    if (!related.length) { missing.push(target.title); continue; }
    // A related plate can cover only part of a heading's requested categories.
    const categories = parsed.subject === 'IAP' ? approachTitleIdentity(target.title)?.categories ?? [] : [];
    for (const category of categories) {
      const values = missingCategories(category, related);
      if (values.length) missing.push(`${target.title} · Unmatched ${category.special ? 'SA ' : ''}CAT ${values.join('/')}`);
    }
  }
  if (parsed.categoryTarget) {
    const target = parsed.categoryTarget;
    const related = coverage.procedures.filter(p => categoryScope(parsed, p));
    const values = missingCategories(target, related);
    if (values.length) missing.push(`ILS RWY ${target.runway} (${target.special ? 'SA ' : ''}CAT ${values.join('/')})`);
  }
  coverage.records.set(record, missing);
  return missing;
}

export function matchPlateNotams(records: readonly NotamRecord[], context: PlateNoticeContext) {
  const matches: PlateNotamMatch[] = [], unresolvedNotices: NotamRecord[] = [];
  const unmatchedTargets: { record: NotamRecord; titles: readonly string[] }[] = [];
  if (context.status !== 'resolved' || !context.procedure || !context.airport) return { matches, unresolved: 0, unresolvedNotices, unmatchedTargets, available: false };
  const plate = context.procedure;
  const runway = /\bRWY\s+(\d{1,2}[LRC]?)\b/i.exec(plate.name)?.[1];
  for (const record of records) {
    if (record.lifecycle === 'cancelled' || record.lifecycle === 'cancellation') continue;
    // Cross-format INTL/MIL notices are retained server-side. They are outside
    // this release's D/FDC matching scope and can duplicate a domestic notice.
    if (!['DOMESTIC', 'DOM', 'FDC'].includes(record.classification)) continue;
    if (!(context.airport.faaId && record.locations.includes(context.airport.faaId)) &&
        !(context.airport.icaoId && record.icaoLocations.includes(context.airport.icaoId))) continue;
    const parsed = parseNotam(record);
    const missing = context.procedures ? unmatchedProcedureReferences(record, parsed, context.procedures) : [];
    if (missing.length) unmatchedTargets.push({ record, titles: missing });
    if (parsed.unresolved || missing.length) unresolvedNotices.push(record);
    const targets = parsed.targets.flatMap(target => {
      const relation = procedureTargetMatch(target.title, parsed.subject, plate);
      return relation ? [{ target, relation }] : [];
    });
    if (targets.length || parsed.broad && plate.kind === 'approach') {
      const displayed = plate.source.amendmentNumber;
      const mismatch = targets.find(({ target }) => target.amendment && (!displayed || normalizeProcedureAmendment(target.amendment) !== normalizeProcedureAmendment(displayed)));
      const unknownEdition = !displayed && ['takeoff-minimums', 'diverse-vector-area', 'radar-minimums'].includes(plate.kind);
      const titleReview = targets.find(({ relation }) => relation.review)?.relation.review;
      const reason = parsed.broadRestricted
        ? 'Addresses all approaches with an exclusion or condition. Review applicability to this plate.' : mismatch
        ? `Procedure matches; notice amendment ${mismatch.target.amendment}, displayed plate ${displayed ?? 'unknown'}. Review applicability.`
        : unknownEdition ? 'Procedure matches; the displayed plate amendment is unavailable. Review applicability.'
        : parsed.broad ? 'Explicitly addresses all instrument approaches at this airport.' : targets.map(({ target, relation }) =>
          `Names ${target.title}.${relation.scope ? ` Affected scope on this plate: ${relation.scope}.` : ''}`).join(' ');
      matches.push({ record, parsed, outcome: mismatch || unknownEdition || parsed.broadRestricted || titleReview ? 'review' : 'applies',
        reason: titleReview ? `${titleReview} ${reason.replace(/^Procedure matches; notice/, 'Notice')}` : reason });
    } else if (parsed.categoryTarget) {
      const scope = categoryScope(parsed, plate);
      if (scope) matches.push({ record, parsed, outcome: 'applies',
        reason: `Explicit ${scope} restriction for runway ${runway}. Read the stated effect and exceptions.` });
    } else if (plate.kind === 'approach' && runway && parsed.facilityTarget?.runway === normalizeRunway(runway)) {
      const facility = parsed.facilityTarget.facility;
      const supported = approachFacilities.has(facility);
      const usesFacility = facility === 'ILS' || facility.startsWith('LOC') ? /\b(?:ILS|LOC)\b/i.test(plate.name) : /\bILS\b/i.test(plate.name);
      if (supported && usesFacility) matches.push({ record, parsed, outcome: 'applies',
        reason: `Explicit ${facility} ${parsed.facilityTarget.effect === 'unmonitored' ? 'monitoring restriction' : 'outage'} for runway ${runway} used by this procedure. Read the stated effect and exceptions.` });
      else if (!supported) {
        matches.push({ record, parsed, outcome: 'review', reason: `Runway ${runway} matches; the ${facility} dependency is unconfirmed.` });
      }
    } else if (runway && parsed.runwayTargets.includes(normalizeRunway(runway))) {
      matches.push({ record, parsed, outcome: 'applies', reason: `Addresses runway ${runway} used by this procedure. Read the stated effect and exceptions.` });
    } else if (parsed.procedureNotice && (parsed.targets.length ? parsed.targets.some(t => notamTargetKind(t.title, parsed.subject) === plate.kind)
      : notamTargetKind('', parsed.subject) === plate.kind) && parsed.issues.some(i => i === 'headings' || i === 'procedure-target')) {
      matches.push({ record, parsed, outcome: 'review', reason: 'Airport procedure notice; its target could not be resolved. Review applicability.' });
    }
  }
  return { matches, unresolved: unresolvedNotices.length, unresolvedNotices, unmatchedTargets, available: true };
}
