import { expect, test } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';

test.use({ hasTouch: true });

for (const touch of [false, true]) {
  test(`a GPS waypoint can be created and repeatedly repositioned (${touch ? 'touch' : 'mouse'})`, async ({ page }) => {
    await page.goto('/test/browser/route-map.html');
    await page.waitForFunction(() => {
      const map = (window as unknown as { routeMapAudit?: { map: MapLibreMap } }).routeMapAudit?.map;
      return map?.getLayer('route-leg-hits') && map.queryRenderedFeatures({ layers: ['route-leg-hits'] }).length > 0;
    });
    const { start, end } = await page.evaluate(() => {
      const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
      const from = map.project([-119, 35]), to = map.project([-119, 36]);
      return { start: { x: from.x, y: from.y }, end: { x: to.x, y: to.y } };
    });
    if (touch) {
      const session = await page.context().newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
    }
    await expect(page.getByLabel('Edits')).toHaveText('1');
    await expect(page.getByLabel('Route', { exact: true })).toHaveText(/^KSBA \d{6}N\d{7}W KSMX$/);
    await page.waitForFunction(() => {
      const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
      return map.queryRenderedFeatures({ layers: ['route-waypoints'] })
        .some(feature => feature.properties.kind === 'coordinate');
    });
    const dropError = await page.evaluate(end => {
      const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
      const waypoint = map.queryRenderedFeatures({ layers: ['route-waypoints'] })
        .find(feature => feature.properties.kind === 'coordinate')!;
      if (waypoint.geometry.type !== 'Point') throw new Error('GPS waypoint is not a point');
      const point = map.project(waypoint.geometry.coordinates as [number, number]);
      return Math.hypot(point.x - end.x, point.y - end.y);
    }, end);
    // Browser mouse events round to whole pixels; touch events retain subpixels.
    expect(dropError).toBeLessThan(1.5);
    let entryId: string | undefined;
    for (let move = 0; move < 2; move++) {
      const current = await page.evaluate(() => {
        const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
        const feature = map.queryRenderedFeatures({ layers: ['route-waypoints'] })
          .find(feature => feature.properties.kind === 'coordinate')!;
        if (feature.geometry.type !== 'Point') throw new Error('GPS waypoint is not a point');
        const point = map.project(feature.geometry.coordinates as [number, number]);
        return { x: point.x, y: point.y, entryId: feature.properties.editEntryId as string };
      });
      entryId ??= current.entryId;
      expect(current.entryId).toBe(entryId);
      const session = touch ? await page.context().newCDPSession(page) : undefined;
      if (session) await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: current.x, y: current.y }],
      });
      else {
        await page.mouse.move(current.x, current.y);
        await page.mouse.down();
      }
      const direction = move === 0 ? 1 : -1;
      // Cross the browser's touch slop on the first move, then use small steps
      // that keep the previous preview inside the snap radius. Wait for each
      // render to catch a GPS waypoint snapping to its own moving marker.
      for (let step = 1; step <= 6; step++) {
        const point = { x: current.x + direction * (step + 1) * 10, y: current.y - direction * (step + 1) * 7 };
        if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
        else await page.mouse.move(point.x, point.y);
        await page.waitForFunction(point => {
          const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
          return map.queryRenderedFeatures({ layers: ['route-waypoints'] }).some(feature => {
            if (!feature.properties.dragging || feature.geometry.type !== 'Point') return false;
            const projected = map.project(feature.geometry.coordinates as [number, number]);
            return Math.hypot(projected.x - point.x, projected.y - point.y) < 1.5;
          });
        }, point);
      }
      if (session) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await session.detach();
      } else await page.mouse.up();
      await expect(page.getByLabel('Edits')).toHaveText(String(move + 2));
      await expect(page.getByLabel('Route', { exact: true })).toHaveText(/^KSBA \d{6}N\d{7}W KSMX$/);
      await page.waitForFunction(entryId => {
        const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
        return map.queryRenderedFeatures({ layers: ['route-waypoints'] })
          .some(feature => feature.properties.editEntryId === entryId && !feature.properties.dragging);
      }, entryId);
    }
    await expect(page.getByRole('alert')).toBeEmpty();
  });
}

for (const comparison of [false, true]) for (const touch of [false, true]) {
  test(`route airports open from markers and labels (${touch ? 'touch' : 'mouse'}, comparison: ${comparison})`, async ({ page }) => {
    await page.goto(`/test/browser/route-map.html?${comparison ? 'comparison' : 'details'}`);
    await page.waitForFunction(() => {
      const map = (window as unknown as { routeMapAudit?: { map: MapLibreMap } }).routeMapAudit?.map;
      return map?.getLayer('route-waypoint-labels') && map.queryRenderedFeatures({ layers: ['route-waypoint-labels'] }).length === 2;
    });
    for (const label of [false, true]) {
      const target = await page.evaluate(label => {
        const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
        const point = map.project(label ? [-118, 35] : [-120, 35]);
        if (!label) return { x: point.x, y: point.y };
        // Hit the rendered label outside the waypoint's drag/circle hit area.
        for (let dx = 22; dx < 120; dx++) for (const sign of [1, -1]) {
          const x = point.x + dx * sign;
          if (map.queryRenderedFeatures([x, point.y], { layers: ['route-waypoint-labels'] })
            .some(feature => feature.properties.ident === 'KSMX')) return { x, y: point.y };
        }
        throw new Error('KSMX label was not rendered');
      }, label);
      if (touch) await page.touchscreen.tap(target.x, target.y);
      else await page.mouse.click(target.x, target.y);
      await expect(page.getByLabel('Selection')).toHaveText(`airport: ${label ? 'KSMX' : 'KSBA'} airport`);
      if (!comparison) {
        const remove = page.getByRole('button', { name: `Remove ${label ? 'KSMX' : 'KSBA'} from route`, exact: true });
        await expect(remove).toBeVisible();
        await expect(remove).toHaveCSS('color', 'rgb(242, 160, 154)');
      }
      await expect(page.getByLabel('Edits')).toHaveText('0');
      await expect(page.getByRole('alert')).toBeEmpty();
    }
    if (!comparison) {
      await page.getByRole('button', { name: 'Remove KSMX from route', exact: true }).click();
      await expect(page.getByLabel('Route', { exact: true })).toHaveText('KSBA');
      await expect(page.getByLabel('Edits')).toHaveText('1');
    }
  });
}
