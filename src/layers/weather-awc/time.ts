import type { AwcAdvisorySnapshot, WeatherAdvisory } from '@zlayer/contracts';

export const HOUR = 3_600_000;

/** Actual change points only. A retained selection cannot invent a stop for inactive data. */
export function forecastStops(times: readonly number[], now: number, selected: number | null, history: readonly number[] = []): (number | null)[] {
  const past = history.filter(time => time < now);
  return [...(past.length || selected === null || selected > now ? [null] : []),
    ...new Set([...past, ...times.filter(time => time > now), ...(selected !== null && times.includes(selected) && (!past.length || selected !== now) ? [selected] : [])])]
    .sort((a, b) => (a ?? now) - (b ?? now));
}

/** Preceding snapshot inside the horizon; a display choice, not interval validity. */
export function currentFrame(times: readonly number[], now: number, cadence: number): number | undefined {
  const ordered = [...times].sort((a, b) => b - a);
  if (!ordered.length || now > ordered[0]!) return undefined;
  const previous = ordered.find(time => time <= now);
  return previous !== undefined && now - previous < cadence ? previous : undefined;
}

export function advisoryFrame(snapshot: AwcAdvisorySnapshot | undefined, requested: number): {
  time: number | undefined; advisories: WeatherAdvisory[];
} {
  if (!snapshot) return { time: undefined, advisories: [] };
  if (snapshot.product === 'gairmet') {
    const time = currentFrame(snapshot.frameTimes, requested, 3 * HOUR);
    return { time, advisories: snapshot.advisories.filter(a => a.validFrom === time) };
  }
  return { time: requested, advisories: snapshot.advisories.filter(a => a.validFrom <= requested && requested < a.validTo!) };
}
