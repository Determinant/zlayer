import { PIREP_MAX_AGE_MS, type AircraftReport } from '@zlayer/contracts';
import type { WeatherState } from '../controller';
import type { LocatedPirep } from './locations';

export function selectedPireps(state: Pick<WeatherState, 'preferences' | 'selectedTime' | 'now' | 'pireps'>): LocatedPirep[] {
  const p = state.preferences, time = state.selectedTime ?? state.now;
  if (!p.awcEnabled || !p.awcPireps || time > state.now || state.now - time >= PIREP_MAX_AGE_MS) return [];
  return (state.pireps.resolved?.reports ?? state.pireps.snapshot?.reports ?? []).filter(r => r.observedAt <= time &&
    time - r.observedAt < Number(p.awcPirepAge) * 60_000 && state.now - r.observedAt < PIREP_MAX_AGE_MS &&
    (p.awcPirepHazard === 'all' || (p.awcPirepHazard === 'icing' ? r.icing : r.turbulence).length > 0) &&
    (p.awcPirepAltitude === 'all' || r.altitudeFt !== null &&
      (p.awcPirepAltitude === 'low' ? r.altitudeFt < 10_000 : p.awcPirepAltitude === 'mid' ? r.altitudeFt >= 10_000 && r.altitudeFt < 18_000 : r.altitudeFt >= 18_000)));
}
export const pirepAltitude = (report: AircraftReport) => report.altitudeFt === null ? 'Altitude unknown / qualified' : `${report.altitudeFt.toLocaleString('en-US')} ft MSL`;
export const pirepConditions = (report: AircraftReport) => [
  ...report.turbulence.map(v => `Turbulence: ${v}`), ...report.icing.map(v => `Icing: ${v}`), ...report.sky.map(v => `Sky: ${v}`),
];
