export type ResourceErrorCode = 'invalid-data' | 'http' | 'request' | 'storage' | 'worker';

export function isResourceErrorCode(value: unknown): value is ResourceErrorCode {
  return typeof value === 'string' && ['invalid-data', 'http', 'request', 'storage', 'worker'].includes(value);
}

/** Codes cross application boundaries; messages remain presentation text. */
export class ResourceError extends Error {
  constructor(readonly code: ResourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ResourceError';
  }
}

export class InvalidDataError extends ResourceError {
  constructor(message: string, options?: ErrorOptions) { super('invalid-data', message, options); }
}

/** Preserve permanent HTTP/storage failures across the service-worker boundary. */
export function httpResourceError(status: number, message: string): ResourceError {
  return new ResourceError(status === 507 ? 'storage'
    : [408, 429, 500, 502, 503, 504].includes(status) ? 'request' : 'http', message);
}

export function resourceErrorCode(error: unknown): ResourceErrorCode | undefined {
  if (error instanceof ResourceError) return error.code;
  if (error instanceof DOMException && ['QuotaExceededError', 'NotReadableError', 'SecurityError'].includes(error.name)) return 'storage';
  return undefined;
}

/** Compatibility boundary for MapLibre, SQLite XHR and older service workers,
 * which only expose text. Application-owned errors carry codes instead. */
export function externalErrorCode(message: string): ResourceErrorCode | undefined {
  const network = /failed to fetch|fetch failed|load failed|network\s*error|network request failed|network unavailable|failed to execute ['"]send['"] on ['"]XMLHttpRequest['"]/i.test(message);
  const status = Number(message.match(/AJAXError:.*\((\d+)\):/)?.[1]
    ?? message.match(/Unable to (?:load chart package|cache (?:chart )?archive): (\d+)/)?.[1]
    ?? message.match(/Couldn't load .*\. Status: (\d+)/)?.[1]);
  return network || status === 0 || (status >= 400 && status < 600 && status !== 507) ? 'request' : undefined;
}
