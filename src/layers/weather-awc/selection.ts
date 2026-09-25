import { awcGridProduct, type WeatherAdvisory } from '@zlayer/contracts';
import type { WeatherState, WeatherTimeProduct } from './controller';
import type { WeatherAwcPreferences } from './preferences';
import { gridTimes } from './grids/controller';
import { radarTimes } from './radar/time';

export function advisoryEnabled(advisory: WeatherAdvisory, preferences: WeatherAwcPreferences): boolean {
  const { product, hazard } = advisory;
  if (product === 'cwa') return preferences.awcCwa;
  if (product === 'sigmet') return hazard === 'CONVECTIVE' ? preferences.awcConvective : preferences.awcSigmet;
  if (hazard === 'FZLVL' || hazard === 'M_FZLVL') return preferences.awcFreezing;
  if (!preferences.awcGairmet) return false;
  if (hazard.startsWith('TURB')) return preferences.awcTurbulence;
  switch (hazard) {
    case 'ICE': return preferences.awcIcing;
    case 'IFR': return preferences.awcIfr;
    case 'MT_OBSC': return preferences.awcMountain;
    case 'SFC_WND': case 'LLWS': return preferences.awcWind;
    default: return true;
  }
}

export function forecastChanges(state: WeatherState) {
  const changes = new Map<number, Set<WeatherTimeProduct>>(), p = state.preferences;
  const add = (product: WeatherTimeProduct, times: readonly number[]) => {
    for (const time of times) {
      if (!changes.has(time)) changes.set(time, new Set());
      changes.get(time)!.add(product);
    }
  };
  if (p.awcGairmet || p.awcFreezing) add('gairmet', state.products.gairmet.snapshot?.frameTimes ?? []);
  for (const product of ['sigmet', 'cwa'] as const) add(product, state.products[product].snapshot?.advisories
    .filter(a => advisoryEnabled(a, p)).flatMap(a => [a.validFrom, a.validTo!]) ?? []);
  const product = awcGridProduct(p.awcGridMode);
  if (product && product !== 'winds') add(product, gridTimes(state.grid, p.awcGridMode, p.awcGridAltitude));
  if (p.awcWindBarbs || product === 'winds') add('winds', gridTimes(state.wind, 'temperature', p.awcWindAltitude));
  if (p.awcProgs) add('progs', state.progs.forecast.snapshot?.frames.map(frame => frame.validTime) ?? []);
  if (p.awcProgs && p.awcProgsCoverage) add('progs', state.coverage.snapshot?.frames
    .filter(frame => frame.validTime > frame.chartReferenceTime).map(frame => frame.validTime) ?? []);
  if (p.awcRadar) add('radar', radarTimes(state.radar.snapshot, state.now));
  return [...changes].sort(([a], [b]) => a - b).map(([time, products]) => ({ time, products: [...products] }));
}
export const forecastTimes = (state: WeatherState): readonly number[] => forecastChanges(state).map(change => change.time);

export function reconcileWeatherTime(state: WeatherState, now: number): WeatherState {
  // Mobile timers can remain suspended after a source request completes.
  // Source publications and explicit Now actions use the actual wall clock.
  const next = { ...state, now };
  // A field/altitude change preserves the absolute selection even without
  // matching coverage. Inactive catalogs validate that selection, but must
  // not populate Next/Prev with steps that change nothing on the map.
  if (next.selectedTime !== null && !forecastTimes(next).includes(next.selectedTime) &&
    ![...Object.values(next.grid.products), ...Object.values(next.wind.products)].some(product => product.manifest?.frames.some(frame => frame.validTime === next.selectedTime)) &&
    !next.progs.forecast.snapshot?.frames.some(frame => frame.validTime === next.selectedTime) &&
    !next.coverage.snapshot?.frames.some(frame => frame.validTime === next.selectedTime) &&
    !(next.selectedTime <= next.now && radarTimes(next.radar.snapshot, next.now).some(time => time <= next.selectedTime!))) {
    next.selectedTime = null;
    next.selectedIds = []; next.gridPoint = undefined;
  }
  return next;
}
