/** Saturated map strokes for light FAA charts; dark UI legends use neutral text. */
export const ADVISORY_COLORS = {
  icing: '#0057b8',
  turbulence: '#a84800',
  convective: '#c2183a',
  ifr: '#7020a0',
  other: '#786000',
} as const;

export const ADVISORY_LEGEND = [
  { color: ADVISORY_COLORS.icing, label: 'Icing / freezing' },
  { color: ADVISORY_COLORS.turbulence, label: 'Turbulence' },
  { color: ADVISORY_COLORS.ifr, label: 'IFR / mountain obscuration' },
  { color: ADVISORY_COLORS.convective, label: 'Thunderstorms' },
  { color: ADVISORY_COLORS.other, label: 'Wind / other hazards' },
] as const;

/** Product identity on the dark toolbox timeline, independent of map hazard colors. */
export const TIME_PRODUCTS = {
  gairmet: { label: 'G-AIRMET', color: '#f5c46b' },
  sigmet: { label: 'SIGMET', color: '#ff8d9c' },
  cwa: { label: 'CWA', color: '#85e6ba' },
  clouds: { label: 'Cloud', color: '#8dceff' },
  icing: { label: 'Icing', color: '#d0a7ff' },
  winds: { label: 'Winds', color: '#dbe879' },
  progs: { label: 'Progs', color: '#f7b1da' },
  radar: { label: 'Radar', color: '#70dca2' },
} as const;
