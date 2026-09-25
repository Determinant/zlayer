import type { Page } from '@playwright/test';
import type {} from '../browser/ownship';

export async function mockGps(page: Page) {
  await page.addInitScript(() => {
    let next = 0;
    const watches = new Map<number, { success: PositionCallback; error: PositionErrorCallback | null | undefined }>();
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      watchPosition(success: PositionCallback, error?: PositionErrorCallback | null) {
        const id = next++; watches.set(id, { success, error }); return id;
      },
      clearWatch(id: number) { watches.delete(id); },
    } });
    window.addEventListener('test-gps-position', event => {
      const coords = { latitude: 37, longitude: -122, accuracy: 5, heading: 90, speed: 120 * 1852 / 3600,
        altitude: null, altitudeAccuracy: null, ...(event as CustomEvent).detail };
      for (const { success } of watches.values()) success({ coords, timestamp: Date.now() } as GeolocationPosition);
    });
    window.addEventListener('test-gps-error', event => {
      for (const { error } of watches.values()) error?.({ code: (event as CustomEvent).detail } as GeolocationPositionError);
    });
    window.addEventListener('test-gps-count', () => {
      document.body.dataset.gpsWatches = String(watches.size);
      document.body.dataset.gpsStarts = String(next);
    });
  });
}

export const sendFix = (page: Page, coords: Partial<GeolocationCoordinates> = {}) => page.evaluate(coords =>
  window.dispatchEvent(new CustomEvent('test-gps-position', { detail: coords })), coords);
export const countWatches = (page: Page) => page.evaluate(() => {
  window.dispatchEvent(new Event('test-gps-count')); return Number(document.body.dataset.gpsWatches);
});
export const countWatchStarts = (page: Page) => page.evaluate(() => {
  window.dispatchEvent(new Event('test-gps-count')); return Number(document.body.dataset.gpsStarts);
});
export const stats = (page: Page) => page.evaluate(() => window.ownshipFixture.stats());
