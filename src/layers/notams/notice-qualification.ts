import { icaoContentKey, surfaceClosureSubject, type IcaoContent } from './representation';

// FAA Order 7930.2U Appendix B: FA aerodrome, MN apron, MR runway,
// MX taxiway; LC closed. These codes describe the parsed subject, not an airport.
const closureCodes = { AD: 'QFALC', APRON: 'QMNLC', RWY: 'QMRLC', TWY: 'QMXLC' } as const;
const closureAlternatives = new Set<string>([...Object.values(closureCodes), 'QXXXX']);
// OPADD 4.1, Qualifier PURPOSE (p. 91): only these documented upgrades.
// This is not a general ranking of arbitrary qualifier strings or missing data.
const purposes = ['M', 'B', 'BO', 'NBO'] as const;

export type IcaoQualificationProof = 'icao-selection-code' | 'icao-purpose-upgrade' | 'icao-qualification';

/** Caller must establish complete record-bound envelopes and primary bodies.
 * Compare the whole retained set against one qualification, never pairwise
 * normalization that can lose a third variant. Raw source fields are unchanged. */
export function compareIcaoQualification(notices: readonly IcaoContent[]): IcaoQualificationProof | undefined {
  const first = notices[0];
  if (!first) return;
  const codeChanged = notices.some(notice => notice.q[1] !== first.q[1]);
  const purposeChanged = notices.some(notice => notice.q[3] !== first.q[3]);
  if (!codeChanged && !purposeChanged) return;
  let code = first.q[1]!, purpose = first.q[3]!;
  if (codeChanged) {
    // OPADD §3.18.3: unambiguous E establishes its code, including replacing
    // QXXXX. Require an agreeing supplied code; do not invent absent evidence.
    const subject = surfaceClosureSubject(first.body);
    if (!subject) return;
    code = closureCodes[subject];
    if (!notices.some(notice => notice.q[1] === code) ||
      notices.some(notice => notice.lower || notice.upper || !closureAlternatives.has(notice.q[1]!))) return;
  }
  if (purposeChanged) {
    let highest = -1;
    for (const notice of notices) {
      const rank = purposes.findIndex(purpose => purpose === notice.q[3]);
      if (rank < 0) return;
      highest = Math.max(highest, rank);
    }
    // Always compare against the highest supplied purpose. Sparse or later
    // lower-purpose renderings cannot downgrade the retained qualification.
    purpose = purposes[highest]!;
  }
  const key = (notice: IcaoContent) => icaoContentKey({ ...notice,
    q: notice.q.map((value, i) => i === 1 ? code : i === 3 ? purpose : value) });
  const expected = key(first);
  if (!notices.every(notice => notice.change === 'N' && key(notice) === expected)) return;
  return codeChanged ? purposeChanged ? 'icao-qualification' : 'icao-selection-code' : 'icao-purpose-upgrade';
}
