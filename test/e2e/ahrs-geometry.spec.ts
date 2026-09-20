import { test, expect } from '@playwright/test';

test('GPS V/S fits beneath altitude while the horizon and tapes fill the instrument width', async ({ page }, testInfo) => {
  await page.goto('/test/browser/ahrs-geometry.html');
  await expect(page.locator('[data-vsi]')).toHaveCount(10);
  await expect(page.locator('.ahrs-vsi')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.locator('[data-vsi]').evaluateAll(cards => cards.map(card => {
      const rateText = card.getAttribute('data-vsi')!;
      const rate = rateText === 'null' ? null : Number(rateText);
      const altitude = card.querySelector('.ahrs-altitude-tape')!.getBoundingClientRect();
      const drum = card.querySelector('.ahrs-altitude-tape .ahrs-drum')!.getBoundingClientRect();
      const instrument = card.querySelector('.ahrs-instrument')!.getBoundingClientRect();
      const horizon = card.querySelector('.ahrs-horizon')!.getBoundingClientRect();
      const text = card.querySelector<SVGGraphicsElement>('.ahrs-vsi-number')!;
      const readout = card.querySelector('.ahrs-vsi-readout')!.getBoundingClientRect();
      const textBounds = text.getBBox();
      return { rate, fullWidth: Math.abs(horizon.width - instrument.width + 2) < .1,
        inside: textBounds.x >= 0 && textBounds.x + textBounds.width <= 74,
        text: text.querySelector('[data-testid="ahrs-vsi-number"]')!.textContent,
        belowAltitude: readout.top >= drum.bottom && readout.bottom <= altitude.bottom + .1
          && readout.left >= altitude.left - .1 && readout.right <= altitude.right + .1,
      };
    }));
    for (const sample of geometry) {
      expect(sample.fullWidth).toBe(true);
      expect(sample.belowAltitude).toBe(true);
      expect(sample.inside, String(sample.rate)).toBe(true);
      if (sample.rate === null) expect(sample.text).toBe('—');
      else {
        expect(sample.text).toBe(sample.rate > 0 ? `+${sample.rate}` : sample.rate < 0 ? `−${Math.abs(sample.rate)}` : '0');
      }
    }
    await page.locator('[data-vsi="500"]').screenshot({ path: testInfo.outputPath(`vsi-climb-${width}.png`) });
    await page.locator('[data-vsi="-3500"]').screenshot({ path: testInfo.outputPath(`vsi-descent-${width}.png`) });
  }
});

test('bank pointers stay perpendicular to their horizon and aircraft references at every attitude', async ({ page }, testInfo) => {
  await page.goto('/test/browser/ahrs-geometry.html');
  await expect(page.locator('[data-roll]')).toHaveCount(45);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.locator('[data-roll]').evaluateAll(cards => cards.map(card => {
      const element = (id: string) => card.querySelector<SVGGraphicsElement>(`[data-testid="${id}"]`)!;
      const point = (node: SVGGraphicsElement, x: number, y: number) => new DOMPoint(x, y).matrixTransform(node.getScreenCTM()!);
      const vector = (a: DOMPoint, b: DOMPoint) => ({ x: b.x - a.x, y: b.y - a.y });
      const dot = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        (a.x * b.x + a.y * b.y) / Math.hypot(a.x, a.y) / Math.hypot(b.x, b.y);
      const triangleAxis = (node: SVGGraphicsElement) => {
        const box = node.getBBox(), x = box.x + box.width / 2;
        return vector(point(node, x, box.y), point(node, x, box.y + box.height));
      };
      const lineAxis = (node: SVGGraphicsElement) => {
        const path = node as SVGPathElement;
        const a = path.getPointAtLength(0), b = path.getPointAtLength(path.getTotalLength());
        return vector(point(node, a.x, a.y), point(node, b.x, b.y));
      };
      const aircraft = element('ahrs-aircraft-reference'), horizon = element('ahrs-horizon-line');
      const pointer = element('ahrs-bank-pointer'), index = element('ahrs-bank-index');
      const scale = element('ahrs-bank-scale'), matrix = scale.getScreenCTM()!;
      const scaleX = { x: matrix.a, y: matrix.b }, scaleY = { x: matrix.c, y: matrix.d };
      // A rotated group's rectangular bounds include empty corners. Measure
      // its individual painted marks to check actual overlap with the tapes.
      const bounds = [...scale.querySelectorAll('path')].map(mark => mark.getBoundingClientRect());
      const left = card.querySelector('.ahrs-speed-tape')!.getBoundingClientRect().right;
      const right = card.querySelector('.ahrs-altitude-tape')!.getBoundingClientRect().left;
      return {
        attitude: `${card.getAttribute('data-roll')}/${card.getAttribute('data-pitch')}`,
        aircraftPerpendicular: dot(triangleAxis(pointer), lineAxis(aircraft)),
        horizonPerpendicular: dot(triangleAxis(index), lineAxis(horizon)),
        circular: Math.hypot(matrix.a, matrix.b) / Math.hypot(matrix.c, matrix.d),
        orthogonal: dot(scaleX, scaleY),
        followsRoll: dot(scaleX, lineAxis(horizon)),
        clearOfTapes: bounds.every(mark => mark.left >= left && mark.right <= right),
      };
    }));
    for (const sample of geometry) {
      expect(Math.abs(sample.aircraftPerpendicular), sample.attitude).toBeLessThan(1e-6);
      expect(Math.abs(sample.horizonPerpendicular), sample.attitude).toBeLessThan(1e-6);
      expect(sample.circular, sample.attitude).toBeCloseTo(1, 6);
      expect(Math.abs(sample.orthogonal), sample.attitude).toBeLessThan(1e-6);
      expect(sample.followsRoll, sample.attitude).toBeCloseTo(1, 6);
      expect(sample.clearOfTapes, sample.attitude).toBe(true);
    }
    if (width === 1280) {
      await page.locator('[data-roll="-45"][data-pitch="0"]').screenshot({ path: testInfo.outputPath('bank-left.png') });
      await page.locator('[data-roll="0"][data-pitch="0"]').screenshot({ path: testInfo.outputPath('bank-level.png') });
      await page.locator('[data-roll="45"][data-pitch="15"]').screenshot({ path: testInfo.outputPath('bank-right-climb.png') });
    }
  }
});


test('HSI retains magnetic variation information without a separate true-north marker', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date('2026-09-18T12:00:00Z') });
  await page.goto('/test/browser/ahrs-geometry.html');
  await expect(page.locator('[data-heading]')).toHaveCount(24);
  await expect(page.getByTestId('hsi-true-north')).toHaveCount(0);
  for (const card of await page.locator('[data-heading]').all()) {
    await expect(card.locator('.ahrs-hsi-variation')).toContainText('VAR');
    await expect(card.locator('.ahrs-hsi-dial')).not.toContainText('N′');
  }
  await page.locator('[data-heading="45"][data-position="-122,37"]').screenshot({ path: testInfo.outputPath('magnetic-hsi.png') });
});
