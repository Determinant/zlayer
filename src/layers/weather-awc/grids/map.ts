import type { Map, ImageSource } from 'maplibre-gl';
import type { AwcGridField } from '@zlayer/contracts';
import { shadedGrid, type WeatherController } from '../controller';
import { gridCell, gridKey, gridMatchesTime, type DecodedGrid } from './format';
import { rasterGrid } from './raster';
import { fullGridViewport, gridViewport, type GridViewport } from './viewport';
import { loadRaster } from './raster-cache';
import { weatherTiming } from './performance';

const SOURCE = 'weather-awc-grid', LAYER = 'weather-awc-grid-raster';
const identities = new WeakMap<DecodedGrid, string>();
function rasterIdentity(data: DecodedGrid, mode: AwcGridField, sld: boolean): string {
  let identity = identities.get(data);
  if (!identity) { identity = gridKey(data.manifest, data.frame); identities.set(data, identity); }
  return `${identity}/${mode}/${sld}`;
}
type Raster = { pixels: Uint8ClampedArray<ArrayBuffer>; view: GridViewport };

export function mountGridMap(map: Map, controller: WeatherController, before: string) {
  let canvas: HTMLCanvasElement | undefined, key = '', displayed = '', active: AbortController | undefined;
  let warming: AbortController | undefined, fallback: Raster | undefined, painted: Raster | undefined;
  // Whole-domain neighboring images make cached time steps immediate; only the
  // current frame has a screen-space detail raster. No all-timeline RGBA cube.
  const rasters = new globalThis.Map<string, Raster>();
  let viewport: GridViewport | undefined, geometry = '', cameraChanged = true, pixelRatio = 0;
  let opacity: number | undefined, moving = false, destroyed = false;
  let retry = controller.getSnapshot().forecastRetry;
  const retain = (identity: string, raster: Raster) => {
    rasters.delete(identity); rasters.set(identity, raster);
    while (rasters.size > 3 || [...rasters.values()].reduce((n, value) => n + value.pixels.byteLength, 0) > 48 * 1024 * 1024) {
      rasters.delete(rasters.keys().next().value!);
    }
  };
  const paint = (raster: Raster) => {
    if (painted === raster) {
      // Back-stepping can reuse a texture hidden by an unfinished next frame.
      map.setLayoutProperty(LAYER, 'visibility', 'visible'); map.triggerRepaint();
      return;
    }
    const { pixels, view } = raster;
    const done = weatherTiming('image-upload');
    const { width, height, bounds: [w, s, e, n] } = view;
    canvas ??= document.createElement('canvas');
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0);
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[w, n], [e, n], [e, s], [w, s]];
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, { type: 'image', coordinates });
    }
    if (!map.getLayer(LAYER)) {
      opacity = controller.getSnapshot().preferences.awcGridOpacity;
      map.addLayer({ id: LAYER, type: 'raster', source: SOURCE, paint: {
        'raster-opacity': opacity, 'raster-resampling': 'nearest', 'raster-fade-duration': 0,
      } }, before);
    }
    (map.getSource(SOURCE) as ImageSource).updateImage({ image: canvas, coordinates });
    map.setLayoutProperty(LAYER, 'visibility', 'visible'); map.triggerRepaint();
    painted = raster;
    done();
  };
  const warm = () => {
    if (destroyed || active || warming || moving) return;
    const state = controller.getSnapshot(), { awcGridMode: mode, awcSldOverlay: sld } = state.preferences;
    if (!state.preferences.awcEnabled || mode === 'none') return;
    const candidates = (shadedGrid(state).nearby ?? []).filter(data => rasterIdentity(data, mode, sld) !== displayed).slice(0, 2);
    const wanted = new Set(candidates.map(data => rasterIdentity(data, mode, sld)));
    for (const identity of rasters.keys()) if (identity !== displayed && !wanted.has(identity)) rasters.delete(identity);
    const data = candidates.find(data => !rasters.has(rasterIdentity(data, mode, sld)));
    if (!data) return;
    const task = new AbortController(); warming = task;
    const view = fullGridViewport(data.manifest), identity = rasterIdentity(data, mode, sld);
    void loadRaster(data, mode, sld, task.signal).then(pixels => {
      if (!task.signal.aborted) retain(identity, { pixels, view });
    }).catch(() => { /* Speculative drawing never changes display/error state. */ }).finally(() => {
      if (warming === task) { warming = undefined; }
      // Next state/selection update can retry a failed speculative raster.
      if (!task.signal.aborted && rasters.has(identity)) warm();
    });
  };
  controller.setLocator(point => {
    const state = controller.getSnapshot();
    if (!state.preferences.awcEnabled) return undefined;
    const location = map.unproject([point.x, point.y]);
    const longitude = ((location.lng + 180) % 360 + 360) % 360 - 180;
    return [state.gridDisplay?.data, state.windDisplay].some(data => data && gridCell(data.manifest, longitude, location.lat) !== undefined)
      ? { longitude, latitude: location.lat } : undefined;
  });
  const update = () => {
    if (destroyed) return;
    const state = controller.getSnapshot(), { awcGridMode: mode, awcSldOverlay: sld } = state.preferences;
    const grid = shadedGrid(state), enabled = state.preferences.awcEnabled && mode !== 'none';
    const time = state.selectedTime ?? state.now;
    // Selection publishes before acquisition is reconciled. Reject the old
    // bundle even during that intermediate update, before its loading flag flips.
    const data = enabled && grid.data && gridMatchesTime(grid.data, time) &&
      (grid.data.manifest.fields as readonly AwcGridField[]).includes(mode) &&
      ('windAltitude' in grid.data.frame ? grid.data.frame.windAltitude === state.preferences.awcWindAltitude
        : grid.data.frame.altitudeFtMsl === null || grid.data.frame.altitudeFtMsl === state.preferences.awcGridAltitude) ? grid.data : undefined;
    const pending = enabled && (grid.loading || !!grid.data && !data);
    const detail = sld && (mode === 'icingProbability' || mode === 'icingSeverity');
    if (enabled && data && detail) {
      const nextGeometry = JSON.stringify(data.manifest.grid), ratio = globalThis.devicePixelRatio || 1;
      if (cameraChanged || geometry !== nextGeometry || pixelRatio !== ratio) {
        viewport = gridViewport(map, data.manifest); geometry = nextGeometry; cameraChanged = false; pixelRatio = ratio;
      }
    }
    const identity = enabled && data ? rasterIdentity(data, mode, sld) : '';
    const wanted = identity ? `${identity}/${detail ? moving ? 'moving' : viewport?.key ?? 'outside' : 'full'}`
      : pending ? `loading/${time}/${mode}/${sld}/${state.preferences.awcGridAltitude}/${state.preferences.awcWindAltitude}` : '';
    if (map.getLayer(LAYER) && opacity !== state.preferences.awcGridOpacity) {
      opacity = state.preferences.awcGridOpacity; map.setPaintProperty(LAYER, 'raster-opacity', opacity);
    }
    const retryRender = !!state.gridRenderError && retry !== state.forecastRetry;
    retry = state.forecastRetry;
    if (wanted === key && !retryRender) {
      if (identity && displayed === identity && data && mode !== 'none' && state.gridDisplay?.data !== data) controller.setGridDisplay({ data, mode, sld });
      if (identity && displayed === identity) warm();
      return;
    }
    key = wanted; active?.abort(); active = undefined; warming?.abort(); warming = undefined;
    // Camera redraws can retain the same forecast. A new time/run/field clears
    // the old image and inspection until its own pixels are ready.
    const keep = identity && displayed === identity;
    if (!keep) {
      displayed = ''; fallback = undefined;
      if (map.getLayer(LAYER)) map.setLayoutProperty(LAYER, 'visibility', 'none');
      controller.setGridDisplay(undefined);
    }
    controller.setGridRenderError(undefined);
    if (!identity || !data || mode === 'none') {
      // Retain hidden allocations and warmed images while loading, not graphics
      // from the preceding tick. A cached replacement can reuse them immediately.
      if (pending) return;
      if (map.getLayer(LAYER)) map.removeLayer(LAYER);
      if (map.getSource(SOURCE)) map.removeSource(SOURCE);
      if (canvas) { canvas.width = 0; canvas.height = 0; } canvas = undefined;
      rasters.clear(); painted = undefined; viewport = undefined; geometry = ''; opacity = undefined;
      return;
    }
    const task = new AbortController(); active = task;
    const view = detail ? viewport : undefined;
    const commit = (raster: Raster) => {
      const current = controller.getSnapshot(), requested = shadedGrid(current).data;
      if (!current.preferences.awcEnabled || current.preferences.awcGridMode !== mode || current.preferences.awcSldOverlay !== sld ||
        !gridMatchesTime(data, current.selectedTime ?? current.now) || !requested || rasterIdentity(requested, mode, sld) !== identity) task.abort();
      task.signal.throwIfAborted(); paint(raster); displayed = identity;
      controller.setGridDisplay({ data, mode, sld });
    };
    const cached = rasters.get(identity);
    void (async () => {
      // The cached commit runs synchronously before the first await, while any
      // map/canvas exception still follows the ordinary rendering error path.
      if (cached && displayed !== identity) { fallback = cached; commit(cached); }
      let full = cached;
      if (!full) {
        const fullView = fullGridViewport(data.manifest);
        let renderFailure: unknown;
        // The validated image can paint while its optional save finishes.
        const pixels = await loadRaster(data, mode, sld, task.signal, pixels => {
          if (task.signal.aborted) return;
          full = { pixels, view: fullView }; fallback = full; retain(identity, full);
          try { commit(full); }
          catch (error) {
            renderFailure = error;
            controller.setGridRenderError(error instanceof Error ? error.message : 'Forecast rendering failed');
          }
        });
        if (renderFailure) throw renderFailure;
        full ??= { pixels, view: fullView };
        task.signal.throwIfAborted(); retain(identity, full);
      }
      fallback = full;
      if (displayed !== identity || moving || !view) commit(full);
      if (!moving && view) commit({ pixels: await rasterGrid(data, mode, sld, view, task.signal), view });
    })().catch(error => {
      if (!task.signal.aborted) controller.setGridRenderError(error instanceof Error ? error.message : 'Forecast rendering failed');
    }).finally(() => { if (active === task) { active = undefined; warm(); } });
  };
  const start = () => {
    controller.setForecastInteraction('map', true);
    moving = true; active?.abort(); active = undefined; warming?.abort(); warming = undefined;
    // Synchronous replacement before the first animated camera frame, covering
    // the entire domain at every intermediate zoom/pan position.
    if (fallback && displayed) paint(fallback);
    cameraChanged = true; key = ''; update();
  };
  const end = () => { controller.setForecastInteraction('map', false); moving = false; cameraChanged = true; update(); };
  const resize = () => { if (fallback && displayed) paint(fallback); cameraChanged = true; key = ''; update(); };
  map.on('movestart', start); map.on('moveend', end); map.on('resize', resize);
  return { update, destroy() {
    destroyed = true;
    controller.setForecastInteraction('map', false);
    map.off('movestart', start); map.off('moveend', end); map.off('resize', resize);
    active?.abort(); warming?.abort(); controller.setLocator(undefined);
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    if (canvas) { canvas.width = 0; canvas.height = 0; } canvas = undefined;
    rasters.clear(); fallback = undefined; painted = undefined;
    controller.setGridDisplay(undefined); controller.setGridRenderError(undefined);
  } };
}
