/** Messages are fixed codes: transport URLs, response bodies and credentials never escape. */
export class NotamError extends Error {
  constructor(readonly code: string, readonly retryAt?: number) { super(code); }
}
export function notamError(cause: unknown): string {
  return cause instanceof NotamError ? cause.code : 'internal-error';
}
