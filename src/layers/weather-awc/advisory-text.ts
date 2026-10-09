import type { WeatherAdvisory } from '@zlayer/contracts';

export const HAZARDS: Readonly<Record<string, string>> = {
  ICE: 'Icing', TURB: 'Turbulence', 'TURB-HI': 'High-altitude turbulence', 'TURB-LO': 'Low-altitude turbulence',
  IFR: 'IFR', MT_OBSC: 'Mountain obscuration', SFC_WND: 'Surface wind', LLWS: 'Wind shear',
  FZLVL: 'Freezing level', M_FZLVL: 'Multiple freezing levels', CONVECTIVE: 'Thunderstorms',
  TS: 'Thunderstorms', VA: 'Volcanic ash', TC: 'Tropical cyclone', PCPN: 'Precipitation',
  UNK: 'Unspecified hazard',
};
export function advisoryTitle(a: WeatherAdvisory): string {
  const type = a.product === 'gairmet' ? 'G-AIRMET' : a.product === 'cwa' ? 'CWA'
    : a.hazard === 'CONVECTIVE' ? 'Convective SIGMET' : 'SIGMET';
  return `${type} ${a.identifier}`;
}

/** Older saved snapshots retain the qualifier in sourceProperties. */
export function advisoryHazard(a: WeatherAdvisory): string {
  const hazard = HAZARDS[a.hazard] ?? a.hazard;
  const severity = a.severity ?? (a.product === 'gairmet' && typeof a.sourceProperties.severity === 'string' ? a.sourceProperties.severity : '');
  if (!severity) return hazard;
  const labels: Record<string, string> = { MOD: 'Moderate', SEV: 'Severe', LGT: 'Light' };
  return `${labels[severity] ?? severity} · ${hazard}`;
}
