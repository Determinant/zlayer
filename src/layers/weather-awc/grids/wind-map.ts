import type { Map, GeoJSONSource, ErrorEvent } from 'maplibre-gl';
import type { WeatherController } from '../controller';
import { gridKey, gridMatchesTime, type DecodedGrid } from './format';
import { barbGeometry, windSymbols } from './wind';

const SOURCE = 'weather-awc-winds', LAYER = 'weather-awc-wind-barbs';
const imageId = (speed: number) => `weather-awc-barb-${speed}`;
function barbImage(speed: number): ImageData {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!; ctx.scale(2, 2);
  const shape = barbGeometry(speed);
  const path = () => {
    ctx.beginPath();
    if (shape.calm) ctx.arc(32, 32, 4, 0, 2 * Math.PI);
    for (const [x, y, x1, y1] of shape.lines) { ctx.moveTo(x!, y!); ctx.lineTo(x1!, y1!); }
    for (const [x, y, x1, y1, x2, y2] of shape.flags) { ctx.moveTo(x!, y!); ctx.lineTo(x1!, y1!); ctx.lineTo(x2!, y2!); ctx.closePath(); }
  };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  path(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3.5; ctx.stroke();
  path(); ctx.strokeStyle = '#183f54'; ctx.lineWidth = 1.5; ctx.stroke();
  for (const [x, y, x1, y1, x2, y2] of shape.flags) {
    ctx.beginPath(); ctx.moveTo(x!, y!); ctx.lineTo(x1!, y1!); ctx.lineTo(x2!, y2!); ctx.closePath(); ctx.fillStyle = '#183f54'; ctx.fill();
  }
  return ctx.getImageData(0, 0, 128, 128);
}

export function mountWindMap(map: Map, controller: WeatherController, before: string) {
  let key = '', cameraDirty = true, revision = 0, destroyed = false;
  let previous: DecodedGrid | undefined;
  let zoomLevel: number | undefined;
  let retry = controller.getSnapshot().forecastRetry;
  const images = new Set<string>(), identities = new WeakMap<DecodedGrid, string>();
  const clear = () => {
    revision++; key = ''; previous = undefined;
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    for (const id of images) if (map.hasImage(id)) map.removeImage(id);
    images.clear(); controller.setWindDisplay(undefined); controller.setWindRenderError(undefined);
  };
  const fail = (error: unknown) => {
    revision++; previous = undefined;
    if (map.getLayer(LAYER)) map.setLayoutProperty(LAYER, 'visibility', 'none');
    controller.setWindDisplay(undefined);
    controller.setWindRenderError(error instanceof Error ? error.message : 'Wind rendering failed');
  };
  const sourceError = (event: ErrorEvent & { sourceId?: string }) => {
    // MapLibre reports worker/tile failures as events; setData can still resolve.
    // Invalidate that pending completion before it can claim a ready display.
    if (!destroyed && key && event.sourceId === SOURCE) fail(event.error);
  };
  const update = () => {
    if (destroyed) return;
    const state = controller.getSnapshot(), p = state.preferences;
    const retryRender = !!state.windRenderError && retry !== state.forecastRetry;
    retry = state.forecastRetry;
    if (!p.awcEnabled || !p.awcWindBarbs) { if (key || previous) clear(); return; }
    const data = state.wind.data && 'windAltitude' in state.wind.data.frame && state.wind.data.frame.windAltitude === p.awcWindAltitude &&
      gridMatchesTime(state.wind.data, state.selectedTime ?? state.now) ? state.wind.data : undefined;
    if (!data) { if (key || previous) clear(); return; }
    let identity = identities.get(data);
    if (!identity) { identity = gridKey(data.manifest, data.frame); identities.set(data, identity); }
    if (identity === key && !cameraDirty && !retryRender) {
      if (previous && previous !== data) { previous = data; controller.setWindDisplay(data); }
      return;
    }
    const version = ++revision; key = identity; cameraDirty = false;
    // Keep symbols through camera movement only for the same forecast. New
    // time/run/level data stays hidden until MapLibre accepts its replacement.
    if (previous && gridKey(previous.manifest, previous.frame) !== identity) {
      if (map.getLayer(LAYER)) map.setLayoutProperty(LAYER, 'visibility', 'none');
      previous = undefined; controller.setWindDisplay(undefined);
    }
    controller.setWindRenderError(undefined);
    // Source/image setup can throw synchronously; it shares the same recovery
    // path as an asynchronous MapLibre source failure.
    void (async () => {
      const canvas = map.getCanvas(), width = canvas.clientWidth, height = canvas.clientHeight;
      const corners = [[-64, -64], [width + 64, -64], [width + 64, height + 64], [-64, height + 64]].map(([x, y]) => map.unproject([x!, y!]));
      const [west, south, east, north] = data.manifest.grid.bounds;
      // Sample canonical model longitudes while projecting the visible world copy.
      const wrap = 360 * Math.round((map.getCenter().lng - (west + east) / 2) / 360);
      const symbols = windSymbols(data, { zoom: map.getZoom(), width, height,
        bounds: [Math.max(west, Math.min(...corners.map(p => p.lng)) - wrap), Math.max(south, Math.min(...corners.map(p => p.lat))),
          Math.min(east, Math.max(...corners.map(p => p.lng)) - wrap), Math.min(north, Math.max(...corners.map(p => p.lat)))],
        project: (lng, lat) => map.project([lng + wrap, lat]) });
      for (const symbol of symbols) {
        const id = imageId(symbol.barb);
        if (!images.has(id)) { map.addImage(id, barbImage(symbol.barb), { pixelRatio: 2 }); images.add(id); }
      }
      if (!map.getSource(SOURCE)) {
        map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: 'NOAA HRRR' });
      }
      if (!map.getLayer(LAYER)) {
        map.addLayer({ id: LAYER, type: 'symbol', source: SOURCE, layout: {
          visibility: 'none',
          'icon-image': ['get', 'barb'], 'icon-rotate': ['get', 'direction'], 'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        } }, before);
      }
      const shown = data;
      await (map.getSource(SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: symbols.map(s => ({
        type: 'Feature', id: s.cell, geometry: { type: 'Point', coordinates: [s.longitude, s.latitude] },
        properties: { barb: imageId(s.barb), direction: s.direction },
      })) });
      if (destroyed || revision !== version) return;
      const current = controller.getSnapshot();
      if (!current.preferences.awcEnabled || !current.preferences.awcWindBarbs ||
        !('windAltitude' in shown.frame) || current.preferences.awcWindAltitude !== shown.frame.windAltitude || !gridMatchesTime(shown, current.selectedTime ?? current.now) ||
        !current.wind.data || gridKey(current.wind.data.manifest, current.wind.data.frame) !== identity) {
        clear(); return;
      }
      map.setLayoutProperty(LAYER, 'visibility', 'visible');
      previous = shown; controller.setWindDisplay(shown);
    })().catch(error => {
      if (!destroyed && revision === version) fail(error);
    });
  };
  const move = () => { cameraDirty = true; update(); };
  const zoom = () => {
    const level = Math.floor(map.getZoom() + Math.log2(512 / 80));
    if (level !== zoomLevel) { zoomLevel = level; move(); }
  };
  map.on('moveend', move); map.on('resize', move); map.on('zoom', zoom); map.on('error', sourceError);
  return { update, destroy() { destroyed = true; map.off('moveend', move); map.off('resize', move); map.off('zoom', zoom); map.off('error', sourceError); clear(); } };
}
