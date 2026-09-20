// Absolute elevation bands in feet MSL; comparison colors live in clearance.ts.
export const TERRAIN_COLOR_STOPS = [
  { feet: 0, color: '#e4d94b' },
  { feet: 1000, color: '#ffd42a' },
  { feet: 3000, color: '#ff9826' },
  { feet: 6000, color: '#f34a32' },
  { feet: 10000, color: '#c42134' },
] as const;
export const TERRAIN_FILL_OPACITY = 0.82;
export const TERRAIN_LINE_COLOR = [65, 34, 20];
export const TERRAIN_LINE_OPACITY = 0.98;
const colors = TERRAIN_COLOR_STOPS.map(stop => ({ feet: stop.feet,
  rgb: [1, 3, 5].map(i => parseInt(stop.color.slice(i, i + 2), 16)) }));

export function terrainColor(feet: number): number[] {
  const upper = colors.findIndex(stop => stop.feet >= feet);
  if (upper === -1) return colors.at(-1)!.rgb;
  if (upper === 0) return colors[0]!.rgb;
  const a = colors[upper - 1]!, b = colors[upper]!;
  const t = (feet - a.feet) / (b.feet - a.feet);
  return a.rgb.map((value, i) => value + (b.rgb[i]! - value) * t);
}
