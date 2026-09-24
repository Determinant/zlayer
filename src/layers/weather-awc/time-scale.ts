import { HOUR } from './time';
import { RADAR_HISTORY_STEP } from '@zlayer/contracts';

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
