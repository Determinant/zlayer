/** Admission weights cover JSON text plus object/array overhead. These are policy
 * bounds, not measurements of a browser's heap representation. */
export const REPORT_WEIGHT_LIMIT = 128 * 1024;
export const SAVED_REPORT_BYTES = 2 * 1024 * 1024;
export const METAR_CACHE_WEIGHT = 16 * 1024 * 1024;
export const TAF_CACHE_WEIGHT = 4 * 1024 * 1024;

const weights = new WeakMap<object, number>();
export function reportWeight(report: object): number {
  const known = weights.get(report);
  if (known !== undefined) return known;
  let bytes = 0;
  const stringBytes = (text: string) => {
    if (text.length * 2 > REPORT_WEIGHT_LIMIT) throw new Error('Weather report exceeds the memory limit');
    // Upper-bound JSON escapes without building a second serialized report.
    let size = 4 + text.length * 2;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 32 || code >= 0xd800 && code <= 0xdfff) size += 10;
      else if (code === 34 || code === 92) size += 2;
    }
    return size;
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32) throw new Error('Weather report exceeds the nesting limit');
    bytes += typeof value === 'string' ? stringBytes(value) : 64;
    if (bytes > REPORT_WEIGHT_LIMIT) throw new Error('Weather report exceeds the memory limit');
    if (value && typeof value === 'object') {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        bytes += stringBytes(key) + 16;
        visit((value as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  visit(report, 0);
  weights.set(report, bytes);
  return bytes;
}

export class ReportBudget {
  readonly #entries = new Map<string, number>();
  #bytes = 0;
  constructor(readonly limit: number) {}
  accept(id: string, report: object): void {
    this.acceptAll([[id, report]]);
  }
  /** Stage the final batch weight before changing any admission or live report. */
  acceptAll(reports: readonly (readonly [string, object | undefined])[]): void {
    const next = new Map(reports.map(([id, report]) => [id, report ? reportWeight(report) : 0]));
    let total = this.#bytes;
    for (const [id, bytes] of next) total += bytes - (this.#entries.get(id) ?? 0);
    // Do not silently evict another station that a mounted consumer may own.
    if (total > this.limit) throw new Error('Weather cache exceeds the memory limit');
    for (const [id, bytes] of next) {
      if (bytes) this.#entries.set(id, bytes);
      else this.#entries.delete(id);
    }
    this.#bytes = total;
  }
  delete(id: string): void {
    this.#bytes -= this.#entries.get(id) ?? 0;
    this.#entries.delete(id);
  }
}

/** Select complete recent reports before serialization. Live ownership is untouched. */
export function savedReports<T extends object>(reports: T[]): T[] {
  let bytes = 128; // Collection envelope, brackets and separators.
  const saved: T[] = [];
  for (let i = reports.length - 1; i >= 0; i--) {
    const report = reports[i]!, weight = reportWeight(report) + 2;
    if (bytes + weight > SAVED_REPORT_BYTES) continue;
    bytes += weight;
    saved.push(report);
  }
  return saved.reverse();
}

/** No timer, retained JSON or save queue. The next refresh retries the latest state. */
export class CacheSaveRetry {
  #failedAt: number | undefined;
  #delay = 5 * 60_000;
  run(now: number, save: () => void): boolean {
    if (this.#failedAt !== undefined && now >= this.#failedAt && now - this.#failedAt < this.#delay) return false;
    try {
      save();
      this.#failedAt = undefined;
      this.#delay = 5 * 60_000;
      return true;
    } catch {
      if (this.#failedAt !== undefined) this.#delay = Math.min(this.#delay * 2, 60 * 60_000);
      this.#failedAt = now;
      return false;
    }
  }
}
