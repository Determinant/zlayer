import { isRecord, type NotamRecord } from '@zlayer/contracts';
import { notamTime } from '../../../src/layers/notams/validity';
import { compareNotamRevision } from './identity';
import { NotamError } from './error';

export type NotamMemberRejection = { id: string; reason: string; sourceUpdatedAt: string | null };
export type NotamPendingMember = NotamMemberRejection & { observedAt: number };
const MAX_PENDING_MEMBERS = 32; // Keeps authenticated manifest metadata below 16 KiB.
const revision = (sourceUpdatedAt: string) => ({ sourceUpdatedAt, updatedAt: notamTime(sourceUpdatedAt)! });

export function isNotamPendingMembers(value: unknown): value is NotamPendingMember[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_PENDING_MEMBERS &&
    value.every(item => isRecord(item) && typeof item.id === 'string' && /^\d{16}$/.test(item.id) &&
      typeof item.reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item.reason) &&
      (item.sourceUpdatedAt === null || typeof item.sourceUpdatedAt === 'string' && item.sourceUpdatedAt.length <= 64 && notamTime(item.sourceUpdatedAt) !== null) &&
      typeof item.observedAt === 'number' && Number.isSafeInteger(item.observedAt) && item.observedAt >= 0) &&
    new Set(value.map(item => item.id)).size === value.length;
}

/** A sparse/empty retry cannot erase rejected source evidence. A strictly newer
 * qualified revision, or absence from a later complete full snapshot, closes it.
 * Unknown source time uses observation only as a conservative recovery bound;
 * it never orders records, advances collection, or manufactures a source time. */
export function pendingNotamMembers(previous: readonly NotamPendingMember[] | undefined,
  records: readonly NotamRecord[], rejected: readonly NotamMemberRejection[], observedAt: number,
  absenceBefore?: number, retained: readonly NotamRecord[] = []): NotamPendingMember[] {
  if (!previous?.length && !rejected.length) return [];
  const pending = new Map((previous ?? []).map(member => [member.id, member]));
  const present = new Set([...records, ...rejected].map(record => record.id));
  for (const member of rejected) {
    const old = pending.get(member.id);
    const sourceUpdatedAt = !old ? member.sourceUpdatedAt : old.sourceUpdatedAt === null || member.sourceUpdatedAt === null ? null
      : compareNotamRevision(revision(member.sourceUpdatedAt), revision(old.sourceUpdatedAt)) > 0 ? member.sourceUpdatedAt : old.sourceUpdatedAt;
    pending.set(member.id, { ...member, sourceUpdatedAt, observedAt: Math.max(old?.observedAt ?? 0, observedAt) });
  }
  const invalid = new Set(rejected.map(member => member.id));
  for (const group of [retained, records]) for (const record of group) {
    const member = pending.get(record.id);
    if (member && (member.sourceUpdatedAt === null ? group === records && !invalid.has(record.id) && record.updatedAt > member.observedAt
      : compareNotamRevision(record, revision(member.sourceUpdatedAt)) > 0)) pending.delete(record.id);
  }
  if (!rejected.length && absenceBefore !== undefined) for (const member of pending.values()) {
    if (!present.has(member.id) && absenceBefore > member.observedAt) pending.delete(member.id);
  }
  if (pending.size > MAX_PENDING_MEMBERS) throw new NotamError('member-issue-limit');
  return [...pending.values()].sort((a, b) => a.id.localeCompare(b.id));
}
