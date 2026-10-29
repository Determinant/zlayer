import { notice } from './notams';
import { recordWithRevision } from '../../tools/info-server/notams/normalize';

// Independent expectations from FAA JO 7930.2U §1-2-1, not the implementation's
// vocabulary or a production cohort. Prose and identities below are invented.
export const faaKeywords = ['RWY', 'TWY', 'APRON', 'AD', 'OBST', 'NAV', 'COM', 'SVC', 'AIRSPACE',
  'ODP', 'SID', 'STAR', 'CHART', 'DATA', 'DVA', 'IAP', 'VFP', 'ROUTE', 'SPECIAL', 'SECURITY'];
export const fdcHeaderCases = [
  ...faaKeywords.map(subject => ({ subject, preamble: '', separator: ' ' })),
  { subject: 'ROUTE', preamble: 'OK ', separator: ' ' },
  { subject: 'AIRSPACE', preamble: 'VA MD ', separator: ' ' },
  { subject: 'AIRSPACE', preamble: 'CA/NV ', separator: ' ' },
  { subject: 'AIRSPACE', preamble: 'CA,NV..', separator: '' },
  { subject: 'ROUTE', preamble: 'MN..', separator: ' ' },
  { subject: 'AIRSPACE', preamble: 'CA.. ', separator: ' ' },
  { subject: 'SECURITY', preamble: '', separator: '' },
  { subject: 'NAV', preamble: '(U) ', separator: ' ' },
  { subject: 'AIRSPACE', preamble: 'CA (U) ', separator: ' ' },
];
export function localGrammarNotice(header = fdcHeaderCases[0]!, end = '2610051200') {
  const body = `${header.separator ? '' : '...'}TEST CONTENT. ALL LIMITS REMAIN SIGNIFICANT.`;
  const interval = `2610041159-${end}`;
  const text = `${header.preamble}${header.subject}${header.separator}${body}`;
  const { revision: _revision, ...fields } = notice({ classification: 'FDC', accountability: 'FDC',
    locations: ['ZAB'], icaoLocations: ['KZAB'], text,
    effectiveEnd: end === 'PERM' ? 'PERM' : `20${end.replace(/EST$/, '')}`,
    endsAt: end === 'PERM' ? null : Date.parse('2026-10-05T12:00:00Z'),
    endKind: end === 'PERM' ? 'permanent' : end.endsWith('EST') ? 'estimated' : 'fixed',
    translations: [{ type: 'LOCAL_FORMAT', text: `!FDC 6/1001 ZAB ${text} ${interval}` }] });
  return { record: recordWithRevision(fields), body, interval,
    withoutSubject: header.preamble + body };
}
