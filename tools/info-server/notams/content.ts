import { isDeepStrictEqual } from 'node:util';
import type { NotamRecord } from '@zlayer/contracts';
import { compareNoticeText, sharedLocalNotice, type NoticeComparison } from '../../../src/layers/notams/notice-comparison';
import { notamEndKind } from '../../../src/layers/notams/validity';
import { parseNotamSchedule, equalNotamSchedules, notamBodySchedule, notamScheduleFits, conflictingNotamSchedules, type NotamSchedule } from '../../../src/layers/notams/schedule';
import { sharedIcaoSchedule } from '../../../src/layers/notams/notice-evidence';
import { compareNotamIdentity, notamNumberContent as numberContent } from './identity';
import { complementaryNotamScopes } from './association-scopes';
import { notamCancellationConflicts } from './cancellation-identity';
import { equivalentNotamTime, notamContentFields, notamFieldRules } from './structured-fields';

function equivalentSchedule(previous: NotamRecord, next: NotamRecord, before: NotamSchedule, after: NotamSchedule): string | undefined {
  if (equalNotamSchedules(before, after)) return previous.schedule;
  // Equality of meaning needs no notice-specific exception. Supplementing an
  // omission does: both records must be witnessed by the same complete notice.
  const body = previous.text.replace(/\s+/g, ' ').trim();
  const native = previous.classification === 'DOMESTIC' && next.classification === 'DOMESTIC' &&
    sharedLocalNotice(previous, next) && body === next.text.replace(/\s+/g, ' ').trim();
  const witness = native ? notamBodySchedule(body) : sharedIcaoSchedule(previous, next);
  if (!witness || !notamScheduleFits(before, witness) || !notamScheduleFits(after, witness)) return undefined;
  // Preserve the most complete original field. Never synthesize a schedule or
  // replace retained hours with a later sparse rendering at the same revision.
  return before.kind === 'empty' || before.kind === 'weekly' && !before.window && after.kind === 'weekly' && after.window
    ? next.schedule : previous.schedule;
}
const sameLocations = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every(code => b.includes(code));
function contentDifferences(previous: NotamRecord, next: NotamRecord, text: NoticeComparison, complementaryScopes: boolean, schedule: string | undefined,
  cancellationConflicts: ReturnType<typeof notamCancellationConflicts>) {
  return notamContentFields.filter(field => {
    if (cancellationConflicts.some(conflict => conflict === field)) return true;
    const rule = notamFieldRules[field];
    switch (rule) {
    case 'exact': return !isDeepStrictEqual(previous[field], next[field]);
    case 'number': return numberContent(previous.number) !== numberContent(next.number);
    case 'locations': return !sameLocations(previous.locations, next.locations);
    case 'start-time': return !equivalentNotamTime(previous, next, 'effectiveStart');
    case 'end-time': return !equivalentNotamTime(previous, next, 'effectiveEnd');
    case 'schedule': return schedule === undefined;
    case 'icao-locations':
      // FNSE's optional association is absent from some renderings. Absence
      // cannot withdraw a supplied association at the same source revision.
      return !complementaryScopes && previous.icaoLocations.length > 0 && next.icaoLocations.length > 0 &&
        !sameLocations(previous.icaoLocations, next.icaoLocations);
    case 'end-kind': {
      if (previous.endKind === next.endKind) return false;
      // This is a derivation, not an independently versioned source field.
      // A missing optional translation cannot disprove its matching EST suffix.
      if (![previous.endKind, next.endKind].every(kind => kind === 'fixed' || kind === 'estimated')) return true;
      const translations = [...previous.translations, ...next.translations];
      return notamEndKind({ ...previous, translations }) !== 'estimated' ||
        notamEndKind({ ...next, translations }) !== 'estimated';
    }
    case 'body': return text.body === undefined;
    case 'reference': {
      if (!previous.referred || !next.referred) return false;
      const content = (value: NotamRecord['referred']) => value && { ...value, number: numberContent(value.number) };
      return !isDeepStrictEqual(content(previous.referred), content(next.referred));
    }
    case 'translations': return !text.translationsCompatible;
    default: { const exhaustive: never = rule; return exhaustive; }
    }
  });
}

/** Decisions describe content evidence only; source ordering and cancellation
 * precedence remain owned by the collection/lifecycle path. */
type ContentEvidence = 'source-year-omission' | 'complementary-association-scopes' | 'location-set-equivalence' | 'validity-time-equivalence';
export type NotamContentComparison = {
  outcome: 'equivalent' | 'compatible-evidence' | 'contradictory' | 'unproven';
  fields: ReturnType<typeof contentDifferences>; text: NoticeComparison;
  evidence: ContentEvidence[];
};

/** One evaluation supplies both the explanation and the values the merge may
 * publish. Publication must not re-derive a decision from proof-name strings. */
export function evaluateNotamContent(previous: NotamRecord, next: NotamRecord,
  identity = compareNotamIdentity(previous, next), suppliedText?: NoticeComparison): {
    comparison: NotamContentComparison; schedule: string | undefined; scopes: string[] | undefined;
  } {
  const { before, after, proofs } = identity;
  const beforeSchedule = parseNotamSchedule(before.schedule), afterSchedule = parseNotamSchedule(after.schedule);
  const schedule = equivalentSchedule(before, after, beforeSchedule, afterSchedule);
  const scopes = complementaryNotamScopes(before, after);
  const cancellationConflicts = notamCancellationConflicts(before, after);
  const text = suppliedText ?? compareNoticeText(before, after);
  const fields = contentDifferences(before, after, text, !!scopes, schedule, cancellationConflicts);
  const evidence: ContentEvidence[] = [...proofs];
  if (scopes) evidence.push('complementary-association-scopes');
  if ((['locations', 'icaoLocations'] as const).some(field => !isDeepStrictEqual(before[field], after[field]) &&
    sameLocations(before[field], after[field]))) evidence.push('location-set-equivalence');
  if ((['effectiveStart', 'effectiveEnd'] as const).some(field => before[field] !== after[field] &&
    equivalentNotamTime(before, after, field))) evidence.push('validity-time-equivalence');
  const beforeTypes = new Set(previous.translations.map(t => t.type)), afterTypes = new Set(next.translations.map(t => t.type));
  const missing = !!proofs.length || !!previous.icaoLocations.length !== !!next.icaoLocations.length || !!previous.referred !== !!next.referred ||
    beforeTypes.size !== afterTypes.size || [...beforeTypes].some(type => !afterTypes.has(type)) ||
    (beforeSchedule.kind === 'empty') !== (afterSchedule.kind === 'empty') ||
    beforeSchedule.kind === 'weekly' && afterSchedule.kind === 'weekly' && !!beforeSchedule.window !== !!afterSchedule.window;
  const knownScheduleDifference = fields.includes('schedule') && conflictingNotamSchedules(beforeSchedule, afterSchedule);
  const contradictory = cancellationConflicts.length > 0 ||
    fields.some(field => field !== 'text' && field !== 'translations' && field !== 'schedule') ||
    knownScheduleDifference || text.failure === 'different-content';
  const outcome = cancellationConflicts.length || fields.length ? contradictory ? 'contradictory' : 'unproven'
    : missing || scopes ? 'compatible-evidence' : 'equivalent';
  return { comparison: { outcome, fields, text, evidence }, schedule, scopes };
}

export function compareNotamContent(previous: NotamRecord, next: NotamRecord): NotamContentComparison {
  return evaluateNotamContent(previous, next).comparison;
}
export function notamContentDifferences(previous: NotamRecord, next: NotamRecord, text?: NoticeComparison) {
  return evaluateNotamContent(previous, next, undefined, text).comparison.fields;
}
