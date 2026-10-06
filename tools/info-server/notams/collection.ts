import { isDeepStrictEqual } from 'node:util';
import { NOTAM_MAX_ISSUE_VARIANTS, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import { NotamError } from './error';
import { compareNotamRevision, mergeNotamRecords } from './revision';
import { notamCancellationExpiresAt } from './policy';

export const NO_NOTAM_ISSUES: readonly NotamSourceIssue[] = Object.freeze([]);
export type NotamCollection = { records: readonly NotamRecord[]; issues?: readonly NotamSourceIssue[] };

function unresolved(variants: NotamRecord[], reason: NotamSourceIssue['reason'], prior?: NotamSourceIssue): NotamSourceIssue {
  const locations = [...new Set([...(prior?.locations ?? []), ...variants.flatMap(r => r.locations)])].sort();
  const icaoLocations = [...new Set([...(prior?.icaoLocations ?? []), ...variants.flatMap(r => r.icaoLocations)])].sort();
  // Keep stable bounded samples and all known associations. Losing association
  // evidence widens the warning; it must never hide an issue from an airport.
  return { id: variants[0]!.id, reason, variants: variants.slice(0, NOTAM_MAX_ISSUE_VARIANTS),
    variantsTruncated: !!prior?.variantsTruncated || variants.length > NOTAM_MAX_ISSUE_VARIANTS,
    locations: locations.slice(0, 32), icaoLocations: icaoLocations.slice(0, 32),
    unscoped: !!prior?.unscoped || locations.length > 32 || icaoLocations.length > 32 ||
      variants.some(r => !r.locations.length && !r.icaoLocations.length) };
}

/** Every identifiable source record becomes either usable data or explicit
 * uncertainty. Neither an unfamiliar rendering nor an unknown lifecycle can
 * prevent independent IDs in a structurally valid response from advancing. */
export function collectNotamRecords(previous: NotamCollection, updates: readonly NotamRecord[]): NotamCollection {
  if (!updates.length) return previous;
  const records = new Map(previous.records.map(r => [r.id, r]));
  const issues = new Map((previous.issues ?? NO_NOTAM_ISSUES).map(r => [r.id, r]));
  const groups = new Map<string, NotamRecord[]>();
  for (const record of updates) {
    const group = groups.get(record.id) ?? []; group.push(record); groups.set(record.id, group);
  }
  let changed = false;
  for (const [id, incoming] of groups) {
    const old = records.get(id), issue = issues.get(id), retained = issue?.variants ?? (old ? [old] : []);
    let newest = retained[0] ?? incoming[0]!;
    for (const record of incoming) if (compareNotamRevision(record, newest) > 0) newest = record;
    const prior = issue && compareNotamRevision(newest, issue.variants[0]!) === 0 ? issue : undefined;
    const variants = [...new Map([...retained, ...incoming].filter(r => compareNotamRevision(r, newest) === 0)
      .map(r => [r.revision, r])).values()].sort((a, b) => a.revision.localeCompare(b.revision));
    if (old && old.lifecycle !== 'unknown' && variants.length === 1 && variants[0]!.revision === old.revision) continue;
    let reason: NotamSourceIssue['reason'] | undefined = prior?.variantsTruncated ? prior.reason
      : variants.some(r => r.lifecycle === 'unknown') ? 'unsupported-lifecycle' : undefined;
    let resolved: NotamRecord | undefined;
    if (!reason) {
      try { resolved = mergeNotamRecords(old ? [old] : [], variants)[0]; }
      catch (cause) {
        if (!(cause instanceof NotamError) || !['revision-conflict', 'unsupported-lifecycle', 'invalid-record'].includes(cause.code)) throw cause;
        reason = cause.code === 'invalid-record' ? 'representation-limit' : cause.code as NotamSourceIssue['reason'];
      }
    }
    if (resolved) {
      if (!issue && old?.revision === resolved.revision) continue;
      records.set(id, resolved); issues.delete(id); changed = true;
    } else {
      const next = unresolved(variants, reason!, prior);
      if (issue && isDeepStrictEqual(issue, next)) continue;
      issues.set(id, next); records.delete(id); changed = true;
    }
  }
  if (records.size + issues.size > 150_000) throw new NotamError('record-limit');
  return changed ? { records: [...records.values()].sort((a, b) => a.id.localeCompare(b.id)),
    issues: [...issues.values()].sort((a, b) => a.id.localeCompare(b.id)) } : previous;
}

/** A replacement snapshot is not evidence that a still-present equal-revision
 * disagreement disappeared. Carry evidence forward through the completed bridge.
 * Absence resolves an issue only when the full snapshot itself is recent enough. */
export function rebaseNotamRecords(current: NotamCollection, bulk: readonly NotamRecord[], absenceBefore: number | undefined): NotamCollection {
  const present = new Set(bulk.map(r => r.id));
  // A response may include observations newer than its conservative watermark.
  // An older full snapshot cannot withdraw those observations, even when it
  // covers the watermark. Equality remains conservative at timestamp precision.
  const keep = (id: string, updatedAt: number) => present.has(id) || absenceBefore === undefined || updatedAt >= absenceBefore;
  // A bulk load can omit cancelled IDs while its overlapping bridge still
  // replays sparse active renderings. Preserve recent cancellation evidence;
  // the bridge applies ordinary expiry against its actual collection time.
  const retained: NotamCollection = { records: current.records.filter(r => keep(r.id, r.updatedAt) ||
    (notamCancellationExpiresAt(r) ?? 0) > (absenceBefore ?? Infinity)),
    issues: (current.issues ?? []).filter(r => keep(r.id, r.variants[0]!.updatedAt)) };
  return collectNotamRecords(retained, bulk);
}
