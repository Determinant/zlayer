/** Source-requested delays must never be shortened, including oversized numeric
 * values. Return an absolute, representable deadline; callers own fallback/minima. */
export function retryAfterAt(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const until = /^\d+$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  return Number.isNaN(until) ? undefined : Math.min(8.64e15 - 1, until);
}
