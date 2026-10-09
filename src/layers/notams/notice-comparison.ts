import type { NotamRecord } from '@zlayer/contracts';
import { fdcContinuationEvidence } from './source-text';
import { noticeRepresentation, parseIcaoNotice, parseLocalNotice, icaoContentKey, type IcaoNotice } from './representation';
import { localKey, sharedLocalNotice, icaoBody, matchesIcaoBody, icaoEvidence } from './notice-evidence';
import { compareIcaoQualification, type IcaoQualificationProof } from './notice-qualification';
export { sharedLocalNotice } from './notice-evidence';

/** Baseline comparison retains literal entity spelling. Decoding is admitted
 * only through a complete, identified envelope/body witness below. */
export const translationContent = (text: string): string => noticeRepresentation(text, true, false)?.text ?? text;
export function translationsByType(record: NotamRecord) {
  const types = new Map<string, Set<string>>();
  for (const { type, text } of record.translations) {
    const values = types.get(type) ?? new Set<string>();
    values.add(translationContent(text)); types.set(type, values);
  }
  return types;
}

/** Processed views are comparison evidence only. Raw source fields and every
 * distinct retained translation survive merging. Rules apply to the complete
 * set, so sparse input cannot erase a disagreement or manufacture a correction. */
type IcaoProof = { body: string; proof: 'icao-notice' | 'icao-rendering' | 'icao-distribution-annotation' | IcaoQualificationProof };
function sharedIcaoProof(previous: NotamRecord, next: NotamRecord): IcaoProof | undefined {
  const before = icaoEvidence(previous), after = icaoEvidence(next);
  if (!before || !after) return;
  const annotated = before.bodyAnnotation || after.bodyAnnotation || before.translationAnnotation || after.translationAnnotation;
  // If the disclaimer exists only in a primary body, keep that original body.
  // Otherwise a shorter rendering can be selected while translations preserve it.
  const preserveBodyAnnotation = annotated && !before.translationAnnotation && !after.translationAnnotation;
  const candidates = [[previous, before], [next, after]] as const;
  const bodies = candidates.filter(([, evidence]) => !preserveBodyAnnotation || evidence.bodyAnnotation).map(([record]) => record.text);
  bodies.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const witness = (proof: IcaoProof['proof']): IcaoProof => ({ body: bodies[0]!, proof });
  const notices = [...before.notices, ...after.notices], first = notices[0]!;
  if (notices.every(notice => icaoContentKey(notice) === icaoContentKey(first))) {
    if (annotated) return witness('icao-distribution-annotation');
    return witness(before.recordBound && after.recordBound ? 'icao-notice' : 'icao-rendering');
  }
  // Corrections and qualification upgrades need stronger authority than equality
  // of renderings whose shared source metadata may itself be inconsistent.
  if (!before.recordBound || !after.recordBound) return;
  const qualification = compareIcaoQualification(notices);
  return qualification ? witness(qualification) : undefined;
}

function compatibleIcao(a: string, b: string): boolean {
  if (a === b) return true;
  const left = parseIcaoNotice(a), right = parseIcaoNotice(b);
  if (!left.ok || !right.ok) return false;
  const before = left.value, after = right.value;
  if (before.change !== 'N' || after.change !== 'N') return false;
  // Only the demonstrated domestic/international identity pair may differ.
  if (before.identity !== after.identity && /^[A-Z]/.test(before.identity) === /^[A-Z]/.test(after.identity)) return false;
  const content = (notice: IcaoNotice) => JSON.stringify([notice.locations, notice.start, notice.end, notice.schedule, icaoBody(notice)]);
  return content(before) === content(after) && before.q.every((value, i) => value === after.q[i] ||
    i >= 2 && i <= 4 && (!value || !after.q[i]));
}

export type NoticeComparison = { body: string | undefined; translationsCompatible: boolean;
  proof: IcaoProof['proof'] | 'exact' | 'local-notice' | 'icao-body' | 'fdc-continuation' | null;
  failure: 'unsupported-representation' | 'different-content' | null };

/** Reconciliation consumes complete representations, independently of the PWA's
 * intentionally partial operational facts. Every supplied variant constrains it. */
export function compareNoticeText(previous: NotamRecord, next: NotamRecord): NoticeComparison {
  const local = sharedLocalNotice(previous, next), icao = sharedIcaoProof(previous, next);
  const before = translationsByType(previous), after = translationsByType(next);
  const continuation = !local && !icao ? fdcContinuationEvidence([previous, next]) : undefined;
  let body: string | undefined, proof: NoticeComparison['proof'] = null;
  if (previous.text === next.text) { body = previous.text; proof = 'exact'; }
  else if (icao) { body = icao.body; proof = icao.proof; }
  else if (local) { body = previous.text; proof = 'local-notice'; }
  else if (continuation) { body = continuation.body; proof = 'fdc-continuation'; }
  else for (const translation of before.get('OTHER:ICAO') ?? []) {
    if (!after.get('OTHER:ICAO')?.has(translation)) continue;
    // The identical retained rendering can prove its E)-onward substring even
    // when it omits C). Missing fields cannot establish general notice equality.
    const parsed = parseIcaoNotice(translation, { allowMissingEnd: true }); if (!parsed.ok) continue;
    const full = parsed.value.representation.text;
    const a = noticeRepresentation(previous.text, true)?.text, b = noticeRepresentation(next.text, true)?.text;
    if (matchesIcaoBody(a, parsed.value) && b === full) body = previous.text;
    else if (matchesIcaoBody(b, parsed.value) && a === full) body = next.text;
    if (body !== undefined) { proof = 'icao-body'; break; }
  }
  const translationFailures = [...before].map(([type, values]): NoticeComparison['failure'] => {
    const incoming = after.get(type);
    if (!incoming || values.size === incoming.size && [...values].every(value => incoming.has(value))) return null;
    if (type === 'LOCAL_FORMAT' && (local || continuation)) return null;
    if (type === 'OTHER:ICAO') {
      if (local || icao || continuation) return null;
      const richer = [...incoming].every(text => values.has(text)) ? previous
        : [...values].every(text => incoming.has(text)) ? next : undefined;
      if (richer && localKey(richer) !== undefined) return null;
      if ([...values].every(a => [...incoming].every(b => compatibleIcao(a, b)))) return null;
    }
    const supported = (value: string) => type === 'LOCAL_FORMAT' ? parseLocalNotice(value).ok
      : type === 'OTHER:ICAO' && parseIcaoNotice(value).ok;
    return [...values, ...incoming].every(supported) ? 'different-content' : 'unsupported-representation';
  });
  const recognized = (record: NotamRecord) => localKey(record) !== undefined || !!icaoEvidence(record);
  const bodyFailure: NoticeComparison['failure'] = body !== undefined ? null
    : recognized(previous) && recognized(next) ? 'different-content' : 'unsupported-representation';
  const failures = [bodyFailure, ...translationFailures];
  // These policies also explain differences confined to translations, even
  // when the primary bodies were already exactly equal.
  if (icao && icao.proof !== 'icao-notice' && icao.proof !== 'icao-rendering') proof = icao.proof;
  return { body, translationsCompatible: translationFailures.every(failure => failure === null), proof,
    failure: failures.includes('different-content') ? 'different-content'
      : failures.includes('unsupported-representation') ? 'unsupported-representation' : null };
}
