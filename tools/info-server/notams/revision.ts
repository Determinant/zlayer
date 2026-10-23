import { isDeepStrictEqual } from 'node:util';
import { isNotamRecord, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import { NotamError } from './error';
import { recordWithRevision } from './normalize';
import type { NoticeComparison } from '../../../src/layers/notams/notice-comparison';
import { notamEndKind } from '../../../src/layers/notams/validity';
import { notamCancellationExpiresAt } from './policy';
import { compareNotamIdentity, compareNotamRevision, hasPositiveNotamCancellation } from './identity';
import { evaluateNotamContent, compareNotamContent, notamContentDifferences } from './content';
import { notamCancellationConflicts, notamCancellationIdentity } from './cancellation-identity';
export { compareNotamContent, notamContentDifferences } from './content';
export { compareNotamRevision } from './identity';

type RevisionProof = NonNullable<NoticeComparison['proof']> | 'source-record' | 'source-revision' | 'positive-cancellation' | 'inactive-record' |
  ReturnType<typeof compareNotamContent>['evidence'][number];
type ConflictEvidence = { previous: NotamRecord; next: NotamRecord; comparison: ReturnType<typeof compareNotamContent> };
export type NotamRevisionDecision =
  | { kind: 'resolved'; record: NotamRecord; proofs: RevisionProof[] }
  | { kind: 'unresolved'; reason: NotamSourceIssue['reason']; conflicts: ConflictEvidence[] };
function mergeSameNotamRevision(previous: NotamRecord, next: NotamRecord): NotamRevisionDecision {
  const identity = compareNotamIdentity(previous, next);
  // No lifecycle shortcut may erase a disagreement about which notice this is.
  if (identity.fields.length || notamCancellationConflicts(identity.before, identity.after).length) return { kind: 'unresolved', reason: 'revision-conflict',
    conflicts: [{ previous, next, comparison: compareNotamContent(previous, next) }] };
  const inactive = (selected: NotamRecord, proof: RevisionProof): NotamRevisionDecision => {
    const year = identity.before.year;
    const years = [...new Set([previous, next].flatMap(record => record.sourceYears ?? [record.year]))].sort();
    const sourceYears = years.length > 1 ? years : undefined;
    // Keep cancellation identity evidence through sparse repeats and restarts.
    // Otherwise choosing a terse rendering could erase a supplied reference.
    const referred = selected.lifecycle === 'cancellation' ? previous.referred ?? next.referred : selected.referred;
    const translations = selected.lifecycle === 'cancellation' ? [...new Map([previous, next].flatMap(r => r.translations)
      .map(t => [JSON.stringify([t.type, t.text]), t])).values()] : selected.translations;
    const text = selected.lifecycle === 'cancellation' && !notamCancellationIdentity(selected).primaryHeader
      ? [previous, next].find(r => notamCancellationIdentity(r).primaryHeader)?.text ?? selected.text : selected.text;
    const { revision: _revision, ...facts } = selected;
    const record = selected.year === year && isDeepStrictEqual(selected.sourceYears, sourceYears) &&
      selected.text === text && isDeepStrictEqual(selected.referred, referred) && isDeepStrictEqual(selected.translations, translations) ? selected
      : recordWithRevision({ ...facts, year, text, referred, translations, ...(sourceYears ? { sourceYears } : {}) });
    if (!isNotamRecord(record)) return { kind: 'unresolved', reason: 'representation-limit', conflicts: [] };
    return { kind: 'resolved', record, proofs: [proof, ...identity.proofs] };
  };
  // A timestamped original-ID cancellation is positive source evidence. An
  // omitted optional canceled field at that same revision is not a resurrection.
  // Cancellation can occur after lastUpdated without advancing the source
  // revision. Older cancellation evidence must not withdraw that revision.
  for (const [cancelled, active] of [[previous, next], [next, previous]] as const) {
    if (active.lifecycle === 'active' && !active.canceledAt && hasPositiveNotamCancellation(cancelled))
      return inactive(cancelled, 'positive-cancellation');
  }
  // These records have no active-airport membership. NMS can replace their text
  // with a terse cancellation rendering at the same source revision. Keep the
  // retained record as the base unless a later cancellation extends retention,
  // preserving identity evidence from both. Presentation alone is not a conflict.
  // A NOTAMC message and an original-ID tombstone remain distinct lifecycle kinds.
  if (previous.lifecycle === next.lifecycle &&
    (previous.lifecycle === 'cancelled' || previous.lifecycle === 'cancellation')) {
    return inactive(notamCancellationExpiresAt(next)! > notamCancellationExpiresAt(previous)! ? next : previous, 'inactive-record');
  }
  const { comparison, schedule, scopes } = evaluateNotamContent(previous, next, identity);
  if (comparison.fields.length) return { kind: 'unresolved', reason: 'revision-conflict', conflicts: [{ previous, next, comparison }] };
  // Comparison views can be equal while the source bytes differ. Keep both
  // actual renderings; bounded overflow remains an explicit source issue.
  const added = next.translations.filter(t => !previous.translations.some(old => old.type === t.type && old.text === t.text));
  // Issue time is publication metadata, not the revision or effective boundary.
  // Alternate FAA renderings can report it differently. Retain the earliest
  // supplied issue time; never use this reconciliation to advance freshness.
  const issued = [previous.issuedAt, next.issuedAt].filter((time): time is number => time !== null);
  const issuedAt = issued.length ? Math.min(...issued) : null;
  const text = comparison.text.body!, referred = previous.referred ?? next.referred;
  const year = identity.before.year;
  const icaoLocations = scopes ?? (previous.icaoLocations.length ? previous.icaoLocations : next.icaoLocations);
  const years = [...new Set([previous, next].flatMap(record => record.sourceYears ?? [record.year]))].sort();
  const sourceYears = years.length > 1 ? years : undefined;
  const associationSets = [...new Map([previous, next].flatMap(record => record.sourceIcaoLocations ?? [record.icaoLocations])
    .map(set => [[...set].sort().join(','), set])).values()].sort((a, b) => a.join(',').localeCompare(b.join(',')));
  const sourceIcaoLocations = scopes ? associationSets : previous.sourceIcaoLocations ?? next.sourceIcaoLocations;
  const translations = added.length ? [...previous.translations, ...added] : previous.translations;
  const endKind = notamEndKind({ ...previous, translations });
  // Equivalent operational content needs no temporal winner. Retain each actual
  // counter pair, including evidence carried through prior merges; never combine
  // independently selected sequence/correction values into an invented pair.
  const counters = [...new Map([previous, next].flatMap(record => record.sourceCounters ??
    [{ sequence: record.sequence, correction: record.correction }])
    .map(pair => [`${pair.sequence}:${pair.correction}`, pair])).values()]
    .sort((a, b) => a.sequence - b.sequence || a.correction - b.correction);
  const { sequence, correction } = counters[0]!;
  const sourceCounters = counters.length > 1 ? counters : undefined;
  const resolved = (record: NotamRecord): NotamRevisionDecision => ({ kind: 'resolved', record,
    proofs: [comparison.text.proof!, ...comparison.evidence] });
  if (!added.length && issuedAt === previous.issuedAt && text === previous.text && referred === previous.referred && year === previous.year &&
    isDeepStrictEqual(icaoLocations, previous.icaoLocations) && endKind === previous.endKind && schedule === previous.schedule &&
    sequence === previous.sequence && correction === previous.correction && isDeepStrictEqual(sourceCounters, previous.sourceCounters) &&
    isDeepStrictEqual(sourceYears, previous.sourceYears) && isDeepStrictEqual(sourceIcaoLocations, previous.sourceIcaoLocations)) return resolved(previous);
  const { revision: _revision, ...facts } = previous;
  const merged = recordWithRevision({ ...facts, issuedAt, text, referred, year, icaoLocations, endKind, schedule: schedule!, translations,
    ...(sourceYears ? { sourceYears } : {}), ...(sourceIcaoLocations ? { sourceIcaoLocations } : {}),
    sequence, correction, ...(sourceCounters ? { sourceCounters } : {}) });
  if (!isNotamRecord(merged)) return { kind: 'unresolved', reason: 'representation-limit', conflicts: [] };
  return resolved(merged);
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
    issue.variants.some(r => r.lifecycle !== 'active' || !r.locations.length || r.icaoLocationVariants ||
      r.id !== issue.variants[0]!.id || compareNotamRevision(r, issue.variants[0]!) !== 0)) return;
  const sets = [...new Map(issue.variants.filter(r => r.icaoLocations.length).map(r =>
    [[...r.icaoLocations].sort().join(','), r.icaoLocations])).values()];
  if (sets.length < 2) return;
  const withoutAssociation = (record: NotamRecord) => {
    const { revision: _revision, sourceIcaoLocations: _sourceIcaoLocations, ...facts } = record;
    return recordWithRevision({ ...facts, icaoLocations: [] });
  };
  const decision = resolveNotamRevision(issue.variants.map(withoutAssociation));
  if (decision.kind !== 'resolved') return;
  const resolved = decision.record;
  const { revision: _revision, ...facts } = resolved;
  const record = recordWithRevision({ ...facts,
    icaoLocations: sets[0]!.filter(code => sets.every(set => set.includes(code))), icaoLocationVariants: sets });
  return isNotamRecord(record) ? record : undefined;
}

/** Pure decision for one identity. Only the newest qualified source-time group
 * constrains content. Expected uncertainty is data, not an exception. */
export function resolveNotamRevision(observations: readonly NotamRecord[]): NotamRevisionDecision {
  const first = observations[0];
  if (!first || observations.some(record => record.id !== first.id)) throw new Error('Expected one NOTAM identity');
  const newest = observations.reduce((a, b) => compareNotamRevision(b, a) > 0 ? b : a);
  const variants = [...new Map(observations.filter(record => compareNotamRevision(record, newest) === 0)
    .map(record => [record.revision, record])).values()];
  if (variants.some(record => record.lifecycle === 'unknown'))
    return { kind: 'unresolved', reason: 'unsupported-lifecycle', conflicts: [] };
  let record = variants[0]!;
  const proofs = new Set<RevisionProof>([observations.some(value => compareNotamRevision(value, newest) < 0) ? 'source-revision' : 'source-record']);
  const pending: NotamRecord[] = [];
  for (const next of variants.slice(1)) {
    const decision = mergeSameNotamRevision(record, next);
    if (decision.kind === 'unresolved') {
      if (decision.reason !== 'revision-conflict') return decision;
      pending.push(next);
    } else { record = decision.record; decision.proofs.forEach(proof => proofs.add(proof)); }
  }
  // Each accepted observation can establish evidence needed by another. Retry
  // to a fixed point; each successful pass removes an observation, so this
  // terminates without guessing a winner or accepting an unproved variant.
  while (pending.length) {
    const before = pending.length, conflicts: ConflictEvidence[] = [];
    for (let i = 0; i < pending.length;) {
      const decision = mergeSameNotamRevision(record, pending[i]!);
      if (decision.kind === 'unresolved') {
        if (decision.reason !== 'revision-conflict') return decision;
        conflicts.push(...decision.conflicts); i++;
      } else {
        record = decision.record; decision.proofs.forEach(proof => proofs.add(proof)); pending.splice(i, 1);
      }
    }
    if (pending.length === before) return { kind: 'unresolved', reason: 'revision-conflict', conflicts };
  }
  return { kind: 'resolved', record, proofs: [...proofs] };
}

/** Compatibility API for callers that require a complete record array. Collection
 * and filing-scope publication consume the typed decision directly. */
export function mergeNotamRecords(previous: readonly NotamRecord[], updates: readonly NotamRecord[]): readonly NotamRecord[] {
  if (!updates.length) return previous;
  const records = new Map(previous.map(record => [record.id, record]));
  const groups = new Map<string, NotamRecord[]>();
  for (const record of updates) {
    const group = groups.get(record.id) ?? []; group.push(record); groups.set(record.id, group);
  }
  let changed = false;
  for (const [id, group] of groups) {
    const old = records.get(id), decision = resolveNotamRevision(old ? [old, ...group] : group);
    if (decision.kind === 'unresolved') {
      if (decision.reason !== 'revision-conflict') throw new NotamError(decision.reason === 'representation-limit' ? 'invalid-record' : decision.reason);
      const errors = decision.conflicts.map(({ previous, next, comparison }) => new NotamRevisionConflict(previous, next, comparison.fields));
      const conflict = errors[0]!; conflict.related.push(...errors.slice(1, 32)); throw conflict;
    }
    if (old?.revision !== decision.record.revision) { records.set(id, decision.record); changed = true; }
  }
  if (records.size > 150_000) throw new NotamError('record-limit');
  return changed ? [...records.values()].sort((a, b) => a.id.localeCompare(b.id)) : previous;
}
