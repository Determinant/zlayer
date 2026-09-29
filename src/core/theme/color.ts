/** Build-time color math. UI themes never filter or recolor map/PDF pixels. */
export type ColorRole = 'text' | 'surface' | 'border' | 'accent' | 'overlay' | 'shadow' | 'fixed';
type Triple = readonly [number, number, number];
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const srgb = (value: number) => value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;

export function parseColor(value: string): { rgb: Triple; alpha: number } {
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length <= 4) hex = [...hex].map(char => char + char).join('');
    return { rgb: [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255) as unknown as Triple,
      alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1 };
  }
  const values = value.match(/[\d.]+/g)!.map(Number);
  return { rgb: values.slice(0, 3).map(value => value / 255) as unknown as Triple, alpha: values[3] ?? 1 };
}

function toLab(rgb: Triple): Triple {
  const [r, g, b] = rgb.map(linear) as unknown as Triple;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromLab([L, a, b]: Triple): Triple {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(srgb) as unknown as Triple;
}

/** Preserve hue; reduce chroma until the requested lightness fits sRGB. */
function gamutMapped(L: number, a: number, b: number): Triple {
  let scale = 1;
  for (let attempt = 0; attempt < 80; attempt++, scale *= 0.9) {
    const rgb = fromLab([L, a * scale, b * scale]);
    if (rgb.every(value => value >= 0 && value <= 1)) return rgb;
  }
  return fromLab([L, 0, 0]).map(value => clamp(value)) as unknown as Triple;
}

/** Dark seeds are exact compatibility values; light is derived by semantic role.
 * Surface depth reverses, text gets a bounded dark tone, accents retain hue.
 * Opaque light panels also isolate text from arbitrary chart backgrounds.
 */
export function lightColor(dark: string, role: ColorRole): string {
  if (role === 'fixed') return dark;
  const { rgb, alpha } = parseColor(dark);
  // Elevation stays a shadow, never an inverted highlight. Light UI needs less ink.
  if (role === 'shadow') return `rgba(${rgb.map(value => Math.round(value * 255)).join(', ')}, ${Number((alpha * 0.28).toFixed(4))})`;
  const [L, a, b] = toLab(rgb);
  let target: number, chroma = 1, opacity = alpha;
  switch (role) {
    case 'surface': target = clamp(1.04 - L * 0.3, 0.88, 0.985); chroma = 0.35; opacity = 1; break;
    case 'overlay': target = 0.38; chroma = 0.65; break;
    case 'border': target = alpha < 1 ? 0.32 : clamp(0.96 - L * 0.65, 0.48, 0.79); chroma = 0.55; break;
    case 'accent': target = 0.48; break;
    case 'text': target = clamp(0.98 - L * 0.75, 0.23, 0.46); break;
  }
  const result = gamutMapped(target, a * chroma, b * chroma).map(value => Math.round(value * 255));
  return opacity === 1 ? `#${result.map(value => value.toString(16).padStart(2, '0')).join('')}`
    : `rgba(${result.join(', ')}, ${Number(opacity.toFixed(4))})`;
}

export function contrast(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const { rgb } = parseColor(color);
    return rgb.reduce((sum, value, index) => sum + linear(value) * [0.2126, 0.7152, 0.0722][index]!, 0);
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
