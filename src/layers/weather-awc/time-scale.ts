import { HOUR } from './time';
import { RADAR_HISTORY_STEP } from '@zlayer/contracts';

/** Bound decoration independently of source validation. Ordinary forecast hours
 * and radar minutes retain their spacing; extreme spans get a sparse ruler. */
export function weatherTimeTicks(start: number, end: number, now: number, history: boolean) {
  const ticks = (until: number, unit: number) => {
    const step = unit * Math.max(1, Math.ceil((until - start) / unit / 511));
    return Array.from({ length: Math.max(0, Math.floor((until - start) / step) + 1) }, (_, i) => start + i * step);
  };
  const hours = ticks(end, HOUR);
  const days = [start, ...hours.filter(time => time > start && time < end && time % (24 * HOUR) === 0)];
  const minutes = history ? ticks(Math.min(end, now), RADAR_HISTORY_STEP)
    .filter(time => time < Math.min(end, now) && time % HOUR !== 0) : [];
  return { hours, days, minutes };
}

/** Forecasts retain 11 px/hour. Past observations use 11 px/five minutes so
 * short radar history stays draggable beside a seven-day prog horizon. */
export function weatherTimeScale(start: number, end: number, now: number, history: boolean) {
  const split = history ? Math.max(start, Math.min(end, now)) : start;
  const futureRate = 11 / HOUR, pastRate = history ? 11 / RADAR_HISTORY_STEP : futureRate;
  const pastWidth = (split - start) * pastRate;
  const offset = (time: number) => time <= split ? (time - start) * pastRate : pastWidth + (time - split) * futureRate;
  const width = offset(end);
  return { width, offset, position: (time: number) => offset(time) / width * 100,
    timeAt: (fraction: number) => {
      const x = fraction * width;
      return x <= pastWidth ? start + x / pastRate : split + (x - pastWidth) / futureRate;
    } };
}
