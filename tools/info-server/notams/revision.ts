import { isDeepStrictEqual } from 'node:util';
import { isNotamRecord, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import { NotamError } from './error';
import { recordWithRevision } from './normalize';
import { compareNoticeText, sharedLocalNotice, translationContent, translationsByType, type NoticeComparison } from '../../../src/layers/notams/notice-comparison';
import { notamEndKind, notamTime } from '../../../src/layers/notams/validity';
import { notamCancellationExpiresAt } from './policy';
import { parseNotamSchedule, equalNotamSchedules, notamBodySchedule, notamScheduleFits } from '../../../src/layers/notams/schedule';

const fraction = (value: string) => (/\.(\d+)Z$/.exec(value)?.[1] ?? '').padEnd(9, '0');
/** NMS modification time is the revision clock, preserving sub-millisecond
 * precision. Zero means the same source time, not identical content or counters.
 * AIXM sequence/correction values require TimeSlice context to order corrections;
 * they remain compared evidence and never silently supersede a tied NMS record. */
export function compareNotamRevision(next: NotamRecord, previous: NotamRecord): number {
  return next.updatedAt - previous.updatedAt || fraction(next.sourceUpdatedAt).localeCompare(fraction(previous.sourceUpdatedAt));
}

// Compare representation separately from content; never rewrite the retained raw
// spelling. Only decimal numbers admit zero padding (not composite identifiers).
const numberContent = (value: string) => /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value;
function equivalentSchedule(previous: NotamRecord, next: NotamRecord): string | undefined {
  const before = parseNotamSchedule(previous.schedule), after = parseNotamSchedule(next.schedule);
  if (equalNotamSchedules(before, after)) return previous.schedule;
  // Equality of meaning needs no notice-specific exception. Supplementing an
  // omission does: both records must be witnessed by the same complete notice.
  if (previous.classification !== 'DOMESTIC' || next.classification !== 'DOMESTIC' || !sharedLocalNotice(previous, next)) return undefined;
  const body = previous.text.replace(/\s+/g, ' ').trim();
  if (body !== next.text.replace(/\s+/g, ' ').trim()) return undefined;
  const witness = notamBodySchedule(body);
  if (!witness || !notamScheduleFits(before, witness) || !notamScheduleFits(after, witness)) return undefined;
  // Preserve the most complete original field. Never synthesize a schedule or
  // replace retained hours with a later sparse rendering at the same revision.
  return before.kind === 'empty' || before.kind === 'weekly' && !before.window && after.kind === 'weekly' && after.window
    ? next.schedule : previous.schedule;
}
function effectiveEndContent(record: NotamRecord): string {
  // EST can be encoded in effectiveEnd or in the retained source translation.
  // Only a known estimated end at the same instant admits that spelling change.
  return record.endKind === 'estimated' && record.endsAt !== null &&
    /^\d{12}(?:EST)?$/.test(record.effectiveEnd) && notamTime(record.effectiveEnd) === record.endsAt
    ? record.effectiveEnd.replace(/EST$/, '') : record.effectiveEnd;
}
// Source ID/time spellings already participate in canonical matching/ordering.
// Other operational content remains exact, including lifecycle and timing.
const contentFields = ['id', 'classification', 'number', 'series', 'year', 'locations', 'icaoLocations', 'accountability',
  'updatedAt', 'canceledAt', 'referred', 'startsAt', 'endsAt', 'endKind', 'effectiveStart', 'effectiveEnd',
  'schedule', 'changeType', 'lifecycle', 'text', 'translations', 'sequence', 'correction'] as const satisfies readonly (keyof NotamRecord)[];
export function notamContentDifferences(previous: NotamRecord, next: NotamRecord, text = compareNoticeText(previous, next)) {
  return contentFields.filter(field => {
    if (field === 'number') return numberContent(previous.number) !== numberContent(next.number);
    if (field === 'effectiveEnd') return effectiveEndContent(previous) !== effectiveEndContent(next);
    if (field === 'schedule') return equivalentSchedule(previous, next) === undefined;
    if (field === 'icaoLocations') {
      // FNSE's optional association is absent from some renderings. Absence
      // cannot withdraw a supplied association at the same source revision.
      return previous.icaoLocations.length > 0 && next.icaoLocations.length > 0 &&
        !isDeepStrictEqual([...previous.icaoLocations].sort(), [...next.icaoLocations].sort());
    }
    if (field === 'endKind' && previous.endKind !== next.endKind) {
      // This is a derivation, not an independently versioned source field.
      // A missing optional translation cannot disprove its matching EST suffix.
      if (![previous.endKind, next.endKind].every(kind => kind === 'fixed' || kind === 'estimated')) return true;
      const translations = [...previous.translations, ...next.translations];
      return notamEndKind({ ...previous, translations }) !== 'estimated' ||
        notamEndKind({ ...next, translations }) !== 'estimated';
    }
    if (field === 'text') return text.body === undefined;
    if (field === 'referred') {
      if (!previous.referred || !next.referred) return false;
      const content = (value: NotamRecord['referred']) => value && { ...value, number: numberContent(value.number) };
      return !isDeepStrictEqual(content(previous.referred), content(next.referred));
    }
    if (field === 'translations') return !text.translationsCompatible;
    return !isDeepStrictEqual(previous[field], next[field]);
  });
}

/** Decisions describe content evidence only; source ordering and cancellation
 * precedence remain owned by the collection/lifecycle path. */
export function compareNotamContent(previous: NotamRecord, next: NotamRecord): {
  outcome: 'equivalent' | 'compatible-evidence' | 'contradictory' | 'unproven';
  fields: ReturnType<typeof notamContentDifferences>; text: NoticeComparison;
} {
  const text = compareNoticeText(previous, next), fields = notamContentDifferences(previous, next, text);
  const beforeSchedule = parseNotamSchedule(previous.schedule), afterSchedule = parseNotamSchedule(next.schedule);
  const beforeTypes = new Set(previous.translations.map(t => t.type)), afterTypes = new Set(next.translations.map(t => t.type));
  const missing = !!previous.icaoLocations.length !== !!next.icaoLocations.length || !!previous.referred !== !!next.referred ||
    beforeTypes.size !== afterTypes.size || [...beforeTypes].some(type => !afterTypes.has(type)) ||
    (beforeSchedule.kind === 'empty') !== (afterSchedule.kind === 'empty') ||
    beforeSchedule.kind === 'weekly' && afterSchedule.kind === 'weekly' && !!beforeSchedule.window !== !!afterSchedule.window;
  const knownScheduleDifference = fields.includes('schedule') && beforeSchedule.kind === 'weekly' && afterSchedule.kind === 'weekly';
  return { outcome: fields.length ? fields.some(field => field !== 'text' && field !== 'translations' && field !== 'schedule') ||
    knownScheduleDifference || text.failure === 'different-content'
    ? 'contradictory' : 'unproven' : missing ? 'compatible-evidence' : 'equivalent', fields, text };
}

export function mergeSameNotamRevision(previous: NotamRecord, next: NotamRecord): NotamRecord {
  // A timestamped original-ID cancellation is positive source evidence. An
  // omitted optional canceled field at that same revision is not a resurrection.
  // Cancellation can occur after lastUpdated without advancing the source
  // revision. Older cancellation evidence must not withdraw that revision.
  for (const [cancelled, active] of [[previous, next], [next, previous]] as const) {
    const canceledAt = notamTime(cancelled.canceledAt);
    if (cancelled.id === active.id && cancelled.classification === active.classification &&
      numberContent(cancelled.number) === numberContent(active.number) && cancelled.series === active.series && cancelled.year === active.year &&
      cancelled.changeType === active.changeType && cancelled.lifecycle === 'cancelled' && active.lifecycle === 'active' && !active.canceledAt &&
      canceledAt !== null && (canceledAt > cancelled.updatedAt ||
        canceledAt === cancelled.updatedAt && fraction(cancelled.canceledAt) >= fraction(cancelled.sourceUpdatedAt))) return cancelled;
  }
  // These records have no active-airport membership. NMS can replace their text
  // with a terse cancellation rendering at the same source revision. Preserve
  // the retained raw record unless a later cancellation extends its retention;
  // presentation differences cannot break continuity.
  // A NOTAMC message and an original-ID tombstone remain distinct lifecycle kinds.
  if (previous.id === next.id && previous.lifecycle === next.lifecycle &&
    (previous.lifecycle === 'cancelled' || previous.lifecycle === 'cancellation')) {
    return notamCancellationExpiresAt(next)! > notamCancellationExpiresAt(previous)! ? next : previous;
  }
  const comparison = compareNotamContent(previous, next);
  if (comparison.fields.length) throw new NotamRevisionConflict(previous, next, comparison.fields);
  const types = translationsByType(previous);
  const added = next.translations.filter(t => !types.get(t.type)?.has(translationContent(t.text)));
  // Issue time is publication metadata, not the revision or effective boundary.
  // Alternate FAA renderings can report it differently. Retain the earliest
  // supplied issue time; never use this reconciliation to advance freshness.
  const issued = [previous.issuedAt, next.issuedAt].filter((time): time is number => time !== null);
  const issuedAt = issued.length ? Math.min(...issued) : null;
  const text = comparison.text.body!, referred = previous.referred ?? next.referred;
  const schedule = equivalentSchedule(previous, next)!;
  const icaoLocations = previous.icaoLocations.length ? previous.icaoLocations : next.icaoLocations;
  const translations = added.length ? [...previous.translations, ...added] : previous.translations;
  const endKind = notamEndKind({ ...previous, translations });
  if (!added.length && issuedAt === previous.issuedAt && text === previous.text && referred === previous.referred &&
    icaoLocations === previous.icaoLocations && endKind === previous.endKind && schedule === previous.schedule) return previous;
  const { revision: _revision, ...facts } = previous;
  const merged = recordWithRevision({ ...facts, issuedAt, text, referred, icaoLocations, endKind, schedule, translations });
  if (!isNotamRecord(merged)) throw new NotamError('invalid-record');
  return merged;
}

export class NotamRevisionConflict extends NotamError {
  readonly related: NotamRevisionConflict[] = [];
  constructor(readonly previous: NotamRecord, readonly next: NotamRecord,
    readonly fields: ReturnType<typeof notamContentDifferences>) { super('revision-conflict'); }
}

/** Content can be certain in the agreed filing scope while auxiliary airport
 * associations remain disputed. Keep the durable source issue and all its raw
 * variants; this projection cannot establish a disputed ICAO alias or repair a
 * substantive content/lifecycle conflict. */
export function resolveNotamFilingScope(issue: NotamSourceIssue): NotamRecord | undefined {
  if (issue.reason !== 'revision-conflict' || issue.variantsTruncated || issue.unscoped || issue.variants.length < 2 ||
    issue.variants.some(r => r.lifecycle !== 'active' || !r.locations.length || r.icaoLocationVariants)) return;
  const sets = [...new Map(issue.variants.filter(r => r.icaoLocations.length).map(r =>
    [[...r.icaoLocations].sort().join(','), r.icaoLocations])).values()];
  if (sets.length < 2) return;
  const withoutAssociation = (record: NotamRecord) => {
    const { revision: _revision, ...facts } = record;
    return recordWithRevision({ ...facts, icaoLocations: [] });
  };
  let resolved = withoutAssociation(issue.variants[0]!);
  try {
    for (const variant of issue.variants.slice(1)) {
      if (compareNotamRevision(resolved, variant) !== 0) return;
      resolved = mergeSameNotamRevision(resolved, withoutAssociation(variant));
    }
  } catch (cause) { if (cause instanceof NotamError) return; throw cause; }
  const { revision: _revision, ...facts } = resolved;
  const record = recordWithRevision({ ...facts,
    icaoLocations: sets[0]!.filter(code => sets.every(set => set.includes(code))), icaoLocationVariants: sets });
  return isNotamRecord(record) ? record : undefined;
}

export function mergeNotamRecords(previous: readonly NotamRecord[], updates: readonly NotamRecord[]): readonly NotamRecord[] {
  if (!updates.length) return previous;
  const records = new Map(previous.map(record => [record.id, record]));
  let changed = false;
  const pending: NotamRecord[] = [];
  let conflict: NotamRevisionConflict | undefined;
  for (let next of updates) {
    if (next.lifecycle === 'unknown') throw new NotamError('unsupported-lifecycle');
    const old = records.get(next.id);
    if (old) {
      const order = compareNotamRevision(next, old);
      if (order < 0) continue;
      if (!order && next.revision !== old.revision) {
        try { next = mergeSameNotamRevision(old, next); }
        catch (cause) {
          if (!(cause instanceof NotamRevisionConflict)) throw cause;
          pending.push(next);
          continue;
        }
      }
      if (next.revision === old.revision) continue;
    }
    records.set(next.id, next); changed = true;
  }
  // A later member of this batch may supply the complete witness missing from
  // an earlier pair. Retry deferred variants once against the admitted evidence;
  // every variant must still pass the same content and lifecycle rules. This
  // bounded second pass never treats digest/arrival order as source authority.
  for (const next of pending) {
    const old = records.get(next.id)!;
    if (compareNotamRevision(next, old) < 0 || next.revision === old.revision) continue;
    try {
      const merged = mergeSameNotamRevision(old, next);
      if (merged.revision !== old.revision) { records.set(next.id, merged); changed = true; }
    } catch (cause) {
      if (!(cause instanceof NotamRevisionConflict)) throw cause;
      if (!conflict) conflict = cause;
      else if (conflict.related.length < 31) conflict.related.push(cause);
    }
  }
  if (conflict) throw conflict;
  if (records.size > 150_000) throw new NotamError('record-limit');
  return changed ? [...records.values()].sort((a, b) => a.id.localeCompare(b.id)) : previous;
}
