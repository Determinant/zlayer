import type { AircraftReport } from '@zlayer/contracts';
import names from './aircraft-types.json';

/** AIREP references can be flight identifiers, so never interpret them as type codes. */
export function pirepAircraftName(report: Pick<AircraftReport, 'type' | 'aircraft'>): string | undefined {
  if (report.type !== 'PIREP' && report.type !== 'Urgent PIREP') return undefined;
  const code = report.aircraft.trim().toUpperCase();
  return Object.hasOwn(names, code) ? names[code as keyof typeof names] : undefined;
}
