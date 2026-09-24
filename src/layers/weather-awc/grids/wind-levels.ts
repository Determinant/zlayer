import type { ForecastManifest, SourceFrame, WindFrame } from './native-source';

export const WIND_ALTITUDES = [
  ...Array.from({ length: 35 }, (_, i) => (i + 1) * 500),
  ...Array.from({ length: 36 }, (_, i) => 18000 + i * 1000),
];
export const isWindAltitude = (value: unknown): value is number => typeof value === 'number' && WIND_ALTITUDES.includes(value);
export const windLevelLabel = (altitude: number) => altitude < 18000 ? `${altitude.toLocaleString('en-US')} ft MSL` : `FL${altitude / 100}`;
export const windLevelDescription = (altitude: number) => altitude < 18000 ? `${altitude.toLocaleString('en-US')} feet MSL` : `Flight level ${altitude / 100}`;

/** Standard-atmosphere geopotential altitude, valid through 20 km (above FL530).
 * 44330.769 = T0 / lapse rate; 6341.62 = R * 216.65 K / g above the 11 km tropopause.
 * Used for flight levels and as an MSL search seed only; never substitutes for HGT. */
export function windPressure(altitude: number): number {
  const metres = altitude * 0.3048;
  return metres <= 11000 ? 1013.25 * (1 - metres / 44330.769) ** (1 / 0.1902632)
    : 226.3206 * Math.exp((11000 - metres) / 6341.62);
}
export function pressureAltitude(pressureHpa: number): number {
  const metres = pressureHpa >= 226.3206 ? 44330.769 * (1 - (pressureHpa / 1013.25) ** 0.1902632)
    : 11000 - 6341.62 * Math.log(pressureHpa / 226.3206);
  return Math.round(metres / 0.3048 / 100) * 100;
}
export function restoredWindAltitude(saved: Record<string, unknown>): number {
  if (isWindAltitude(saved.awcWindAltitude)) return saved.awcWindAltitude;
  const pressure = saved.awcWindPressure;
  if (typeof pressure !== 'number' || !Number.isInteger(pressure) || pressure < 100 || pressure > 1000 || pressure % 25) return 5000;
  const previous = pressureAltitude(pressure);
  return WIND_ALTITUDES.reduce((best, level) => Math.abs(level - previous) < Math.abs(best - previous) ? level : best, 5000);
}

const selections = new WeakMap<ForecastManifest, Map<number, WindFrame[]>>();
/** Keep source catalogs immutable; selected height slices are derived descriptors. */
export function windFrames(manifest: ForecastManifest, altitude: number): WindFrame[] {
  if (manifest.product !== 'winds' || !isWindAltitude(altitude)) return [];
  let levels = selections.get(manifest);
  if (!levels) { levels = new Map(); selections.set(manifest, levels); }
  const cached = levels.get(altitude);
  if (cached) return cached;
  const times = new Map<number, SourceFrame[]>();
  for (const frame of manifest.frames) {
    if (frame.pressureHpa === undefined) continue;
    const frames = times.get(frame.validTime) ?? []; frames.push(frame); times.set(frame.validTime, frames);
  }
  const pressureHpa = altitude >= 18000 ? windPressure(altitude) : undefined;
  const frames: WindFrame[] = [];
  for (const [validTime, source] of times) {
    source.sort((a, b) => b.pressureHpa! - a.pressureHpa!);
    let selected = source;
    if (pressureHpa !== undefined) {
      const below = source.filter(f => f.pressureHpa! >= pressureHpa).pop(), above = source.find(f => f.pressureHpa! <= pressureHpa);
      if (!below || !above) continue;
      selected = below === above ? [below] : [below, above];
    }
    if (!selected.length) continue;
    frames.push({ validTime, windAltitude: altitude, altitudeFtMsl: pressureHpa === undefined ? altitude : null,
      ...(pressureHpa === undefined ? {} : { pressureHpa }), levels: selected,
      sources: [...new Set(selected.flatMap(f => f.sources))] });
  }
  levels.set(altitude, frames); return frames;
}

/** First try the nearest pressure level, then expand only where heights need it. */
export function windSeed(levels: readonly SourceFrame[], altitude: number): number {
  const target = windPressure(altitude);
  return levels.reduce((best, frame, i) => Math.abs(frame.pressureHpa! - target) < Math.abs(levels[best]!.pressureHpa! - target) ? i : best, 0);
}
