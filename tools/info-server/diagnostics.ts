import { HttpError, InvalidForecastSourceError } from './routes';
import { WeatherSourceError } from './source-error';

export type SourceFailureCode = 'stale-source' | 'future-source' | 'invalid-source' | 'upstream-unavailable' |
  'upstream-backoff' | 'storage-unavailable' | 'processing-failed';
export function sourceFailureCode(cause: unknown): SourceFailureCode {
  if (cause instanceof WeatherSourceError) return cause.code;
  if (cause instanceof InvalidForecastSourceError) return 'invalid-source';
  if (cause instanceof HttpError) return cause.status === 507 ? 'storage-unavailable'
    : cause.status === 503 || cause.status === 429 ? 'upstream-backoff' : 'upstream-unavailable';
  return 'processing-failed';
}

/** One bounded entry per source identity; log state changes, never each poll.
 * Keys are caller-owned station/product names, not URLs or request parameters. */
export class SourceDiagnostics {
  private failures = new Map<string, { code: SourceFailureCode; since: number; lastAt: number; count: number }>();
  constructor(private readonly limit: number, private readonly now = Date.now, private readonly log?: (message: string) => void) {}
  failed(key: string, code: SourceFailureCode) {
    const previous = this.failures.get(key), at = this.now();
    if (!previous && this.failures.size >= this.limit) return;
    if (previous?.code !== code) this.log?.(`${key} ${code}`);
    this.failures.set(key, { code, since: previous?.code === code ? previous.since : at, lastAt: at, count: (previous?.count ?? 0) + 1 });
  }
  recovered(key: string) {
    if (this.failures.delete(key)) this.log?.(`${key} recovered`);
  }
  retain(keys: ReadonlySet<string>) { for (const key of this.failures.keys()) if (!keys.has(key)) this.failures.delete(key); }
  get status() {
    const counts: Partial<Record<SourceFailureCode, number>> = {};
    for (const { code } of this.failures.values()) counts[code] = (counts[code] ?? 0) + 1;
    return { counts, sources: Object.fromEntries(this.failures) };
  }
}
