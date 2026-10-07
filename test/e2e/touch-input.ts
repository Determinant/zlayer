import type { Page } from '@playwright/test';

type Point = { x: number; y: number; id?: number };
type TouchType = 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel';

/** Chromium supplies native input. Other engines exercise the same DOM handlers;
 * Playwright does not expose native multitouch/held touches for those engines. */
export async function mapTouchInput(page: Page) {
  const session = page.context().browser()?.browserType().name() === 'chromium'
    ? await page.context().newCDPSession(page) : undefined;
  let previous: Point[] = [];
  return {
    async send(type: TouchType, points: Point[]) {
      if (session) await session.send('Input.dispatchTouchEvent', { type, touchPoints: points });
      else await page.locator('.maplibregl-canvas').evaluate((canvas, { type, points, previous }) => {
        // Desktop WebKit's Touch constructor is unavailable; match TouchEvent's
        // observable lists without pretending this is native browser input.
        const touches = (values: Point[]) => values.map((point, index) => ({
          identifier: point.id ?? index, target: canvas, clientX: point.x, clientY: point.y,
          pageX: point.x + scrollX, pageY: point.y + scrollY,
        }));
        const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: touches(points) }, targetTouches: { value: touches(points) },
          changedTouches: { value: touches(points.length ? points : previous) },
        });
        canvas.dispatchEvent(event);
      }, { type, points, previous });
      previous = points;
    },
    async close() { await session?.detach(); },
  };
}
