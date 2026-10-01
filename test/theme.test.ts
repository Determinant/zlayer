import assert from 'node:assert/strict';
import test from 'node:test';
import { contrast, lightColor, parseColor } from '../tools/theme/color';
import { palettes, seeds } from '../tools/theme/palette';
import { isTheme, themeRecord } from '../src/core/theme/preference';

test('derived opaque light text remains readable across all opaque UI surface tones', () => {
  // The two translucent glyph fills are decoration, not text ink.
  const text = Object.entries(seeds).filter(([, seed]) => seed.role === 'text' && parseColor(seed.dark).alpha === 1);
  const surfaces = Object.entries(seeds).filter(([, seed]) => seed.role === 'surface');
  for (const [foreground] of text) for (const [background] of surfaces) {
    assert.ok(contrast(palettes.light[foreground]!, palettes.light[background]!) >= 4.5,
      `${foreground} on ${background}`);
  }
  for (const mode of ['dark', 'light'] as const) {
    assert.ok(contrast(palettes[mode]['text-primary']!, palettes[mode]['surface-panel']!) >= 7);
    assert.ok(contrast(palettes[mode]['text-on-accent']!, palettes[mode]['surface-action']!) >= 4.5);
  }
});

test('derivation preserves fixed data colors and gives light panels opaque isolation', () => {
  assert.equal(lightColor('#20c66b', 'fixed'), '#20c66b');
  const shadow = parseColor(lightColor('rgba(0, 0, 0, 0.35)', 'shadow'));
  assert.deepEqual(shadow.rgb, [0, 0, 0]);
  assert.ok(shadow.alpha > 0 && shadow.alpha < 0.15, 'light elevation is a subtle shadow, not an inverted surface');
  assert.equal(parseColor(lightColor('rgba(7, 16, 29, 0.84)', 'surface')).alpha, 1);
  for (const color of Object.values(palettes.light)) {
    const { rgb, alpha } = parseColor(color);
    assert.ok([...rgb, alpha].every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  }
});

test('appearance defaults to dark for unavailable, invalid or future preference records', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  let saved: string | null = null;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } },
  } });
  assert.equal(themeRecord.read(), 'dark');
  themeRecord.write('light');
  assert.equal(themeRecord.read(), 'light');
  for (const value of ['broken', '{"version":2,"value":"light"}', '{"version":1,"value":"sepia"}']) {
    saved = value;
    assert.equal(themeRecord.read(), 'dark');
    assert.equal(saved, value, 'fallback must not overwrite saved intent');
  }
  assert.ok(isTheme('dark') && isTheme('light'));
  assert.equal(isTheme('system'), false);
});
