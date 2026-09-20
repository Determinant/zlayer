import type { NearbyVor } from '@zlayer/domain';

/** Keep MB and TB distinct; an unavailable magnetic alignment never becomes zero. */
export function formatNavaidRadial({ radial }: Pick<NearbyVor, 'radial'>, unavailable = '—'): string {
  return `MB ${degrees(radial, unavailable)}`;
}

export function formatNavaidTrueBearing({ trueBearing }: Pick<NearbyVor, 'trueBearing'>, unavailable = '—'): string {
  return `TB ${degrees(trueBearing, unavailable)}`;
}

function degrees(value: number | null, unavailable: string): string {
  return value === null ? unavailable : `${String(Math.round(value) % 360 || 360).padStart(3, '0')}°`;
}
