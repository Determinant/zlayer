import { formatTimestamp } from '../../../core/format/time';

/** Device zone, including DST at the forecast instant; dates follow the shared UI format. */
export function formatTafLocalTime(isoTime: string, options: { now?: number; timeZone?: string } = {}): string {
  return formatTimestamp(isoTime, { ...options, timeZone: options.timeZone ?? 'local' });
}
