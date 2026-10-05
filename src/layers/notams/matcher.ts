import type { NotamRecord } from '@zlayer/contracts';
import type { PlateNoticeContext } from '../plates/public';
import { normalizeRunway, parseNotam, type ParsedNotam } from './parser';

export const NOTAM_MATCHER_VERSION = 4;
export type PlateNotamMatch = { record: NotamRecord; parsed: ParsedNotam; outcome: 'applies' | 'review'; reason: string };
const numbers = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
  'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN', 'TWENTY'];
export function normalizeProcedureTitle(title: string, named = false): string {
  let text = title.toUpperCase().replace(/,?\s*CONT\.\s*\d+\s*$/, '').replace(/\bRWY\s+0(\d)/g, 'RWY $1');
  if (named) text = text.replace(/\b(?:DEPARTURE|ARRIVAL)\b/g, '').replace(/\(RNAV\)/g, '')
    .replace(/\b[A-Z]+\b/g, word => numbers.includes(word) ? String(numbers.indexOf(word)) : word);
  return text.replace(/[^A-Z0-9]/g, '');
}

function procedureAliases(title: string, named: boolean): string[] {
  const normalized = normalizeProcedureTitle(title, named);
  const combined = !named && /^((?:HI)?(?:COPTER)?)(ILS(?:DME)?[XYZ]?)OR(LOC(?:DME)?[XYZ]?)(RWY\d{1,2}[LRC]?|[A-Z])$/.exec(normalized);
  // Keep the qualifier, runway and each branch's own variant/subtype. In
  // "ILS OR LOC Z", only the LOC branch is Z; never transfer it to the ILS.
  return combined ? [normalized, `${combined[1]}${combined[2]}${combined[4]}`, `${combined[1]}${combined[3]}${combined[4]}`] : [normalized];
}

export function matchPlateNotams(records: readonly NotamRecord[], context: PlateNoticeContext) {
  const matches: PlateNotamMatch[] = [], unresolvedNotices: NotamRecord[] = [];
  if (context.status !== 'resolved' || !context.procedure || !context.airport) return { matches, unresolved: 0, unresolvedNotices, available: false };
  const plate = context.procedure, named = plate.kind !== 'approach';
  const titles = procedureAliases(plate.name, named);
  const runway = /\bRWY\s+(\d{1,2}[LRC]?)\b/i.exec(plate.name)?.[1];
  for (const record of records) {
    if (record.lifecycle === 'cancelled' || record.lifecycle === 'cancellation') continue;
    // Cross-format INTL/MIL notices are retained server-side. They are outside
    // this release's D/FDC matching scope and can duplicate a domestic notice.
    if (!['DOMESTIC', 'DOM', 'FDC'].includes(record.classification)) continue;
    if (!(context.airport.faaId && record.locations.includes(context.airport.faaId)) &&
        !(context.airport.icaoId && record.icaoLocations.includes(context.airport.icaoId))) continue;
    const parsed = parseNotam(record);
    if (parsed.unresolved) unresolvedNotices.push(record);
    const kind = parsed.subject === 'IAP' ? 'approach' : parsed.subject === 'SID' || parsed.subject === 'ODP' ? 'departure'
      : parsed.subject === 'STAR' ? 'arrival' : undefined;
    const target = parsed.targets.find(t => procedureAliases(t.title, named).some(v => titles.includes(v)));
    if (kind === plate.kind && (target || parsed.broad && plate.kind === 'approach')) {
      const amendment = target?.amendment, displayed = plate.source.amendmentNumber;
      const differs = !!amendment && (!displayed || amendment.replace(/^AMDT\s*/i, '') !== displayed.replace(/^AMDT\s*/i, ''));
      matches.push({ record, parsed, outcome: differs || parsed.broadRestricted ? 'review' : 'applies', reason: parsed.broadRestricted
        ? 'Addresses all approaches with an exclusion or condition. Review applicability to this plate.' : differs
        ? `Procedure matches; notice amendment ${amendment}, displayed plate ${displayed ?? 'unknown'}. Review applicability.`
        : parsed.broad ? 'Explicitly addresses all instrument approaches at this airport.' : `Names ${target!.title}.` });
    } else if (plate.kind === 'approach' && runway && parsed.facilityTarget?.runway === normalizeRunway(runway)) {
      const facility = parsed.facilityTarget.facility;
      const supported = ['ILS', 'LOC', 'GP', 'GS'].includes(facility);
      const usesFacility = facility === 'ILS' || facility === 'LOC' ? /\b(?:ILS|LOC)\b/i.test(plate.name) : /\bILS\b/i.test(plate.name);
      if (supported && usesFacility) matches.push({ record, parsed, outcome: 'applies',
        reason: `Explicit ${facility} outage for runway ${runway} used by this procedure. Read the stated effect and exceptions.` });
      else if (!supported) {
        matches.push({ record, parsed, outcome: 'review', reason: `Runway ${runway} matches; the ${facility} dependency is unconfirmed.` });
      }
    } else if (runway && parsed.runwayTargets.includes(normalizeRunway(runway))) {
      matches.push({ record, parsed, outcome: 'applies', reason: `Addresses runway ${runway} used by this procedure. Read the stated effect and exceptions.` });
    } else if (parsed.procedureNotice && kind === plate.kind && parsed.unresolved) {
      matches.push({ record, parsed, outcome: 'review', reason: 'Airport procedure notice; its target could not be resolved. Review applicability.' });
    }
  }
  return { matches, unresolved: unresolvedNotices.length, unresolvedNotices, available: true };
}
