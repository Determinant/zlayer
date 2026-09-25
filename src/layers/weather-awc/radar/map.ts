import type { Map, GeoJSONSource, ErrorEvent } from 'maplibre-gl';
import { RADAR_LEVELS, type RadarCatalog, type RadarContours, type RadarFile } from '@zlayer/contracts';
import type { WeatherController } from '../controller';
import { currentRadar } from './time';
import { RADAR_COLORS } from './palette';

const SOURCE = 'weather-awc-radar', LAYER = 'weather-awc-radar-fill';
type Group = { source: string; key: string; shown: string[]; loading: boolean; error?: string | undefined; failed: boolean };
export function mountRadarMap(map: Map, controller: WeatherController, before: () => string) {
  let active: AbortController | undefined, identity = '', destroyed = false, retry = -1;
  let attemptedCatalog: RadarCatalog | undefined;
  const groups: Group[] = [SOURCE, `${SOURCE}-terminals`].map(source => ({ source, key: '', shown: [], loading: false, failed: false }));
  const national = groups[0]!;
  const memory = new globalThis.Map<string, RadarContours>();
  // Interleave both sources by threshold, preserving global stronger-echo priority.
  // Only the smaller terminal source changes when the viewport crosses a station.
  const layers = RADAR_LEVELS.flatMap((dbz, i) => groups.map((group, j) => ({ group, dbz, color: RADAR_COLORS[i]!,
    id: i === 0 && j === 0 ? LAYER : `${LAYER}-${j}-${dbz}` })));
  const visibility = () => {
    for (const layer of layers) if (map.getLayer(layer.id)) map.setLayoutProperty(layer.id, 'visibility',
      national.shown.length && layer.group.shown.length ? 'visible' : 'none');
  };
  const publish = () => {
    if (destroyed) return;
    visibility();
    const errors = groups.flatMap(group => group.error ? [group.error] : []);
    controller.setRadarDisplay({ loading: groups.some(group => group.loading),
      sites: national.shown.length ? groups.flatMap(group => group.shown) : [], ...(errors.length ? { error: errors.join('; ') } : {}) });
  };
  const remove = (group: Group) => {
    for (const layer of layers.filter(layer => layer.group === group)) if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    if (map.getSource(group.source)) map.removeSource(group.source);
  };
  const ensure = (group: Group) => {
    if (map.getSource(group.source)) return;
    map.addSource(group.source, { type: 'geojson', data: { type: 'FeatureCollection', features: [] },
      attribution: 'NOAA / NSSL MRMS · NWS / FAA TDWR', tolerance: .2 });
    for (const [index, layer] of layers.entries()) if (layer.group === group) {
      const anchor = layers.slice(index + 1).find(next => map.getLayer(next.id))?.id ?? before();
      map.addLayer({ id: layer.id, source: group.source, type: 'fill', filter: ['==', ['get', 'dbz'], layer.dbz],
        layout: { visibility: 'none' }, paint: { 'fill-color': layer.color, 'fill-opacity': .75, 'fill-antialias': true } }, anchor);
    }
  };
  const onError = (event: ErrorEvent & { sourceId?: string }) => {
    const group = groups.find(group => group.source === event.sourceId);
    if (destroyed || !group || !group.key) return;
    group.failed = true; group.loading = false; group.shown = [];
    group.error = `Radar rendering failed: ${event.error?.message ?? 'Map source unavailable'}`;
    publish();
  };
  const load = (file: RadarFile, signal: AbortSignal): Promise<RadarContours> => {
    const cached = memory.get(file.sha256);
    if (cached) return Promise.resolve(cached);
    // Usable bytes reach the map before Cache Storage/access receipts finish.
    // Keep the original promise observed and owned by this selection's signal.
    return new Promise((resolve, reject) => { void controller.loadRadar(file, signal, resolve).then(resolve, reject); });
  };
  const update = () => {
    if (destroyed) return;
    const state = controller.getSnapshot();
    const candidates = state.preferences.awcEnabled && state.preferences.awcRadar ? currentRadar(state.radar.snapshot, state.selectedTime, state.now) : [];
    const composite = candidates.find(file => file.site === 'CONUS'), bounds = composite ? map.getBounds() : undefined;
    const selected = !composite ? [] : candidates.filter(file => {
      if (file.site === 'CONUS') return true;
      if (map.getZoom() < 7) return false;
      // MapLibre can expose a viewport outside ±180° while drawing a repeated
      // world. Compare the terminal footprint in that same world copy.
      const [west, south, east, north] = file.bounds;
      const shift = 360 * Math.round(((bounds!.getWest() + bounds!.getEast()) / 2 - (west + east) / 2) / 360);
      return west + shift < bounds!.getEast() && east + shift > bounds!.getWest() && south < bounds!.getNorth() && north > bounds!.getSouth();
    });
    const next = selected.map(file => file.sha256).join('/');
    if (next === identity && retry === state.radarRetry && (!state.radarDisplay.error || attemptedCatalog === state.radar.snapshot)) return;
    attemptedCatalog = state.radar.snapshot; retry = state.radarRetry; identity = next;
    active?.abort(); const task = active = new AbortController();
    const keep = new Set(selected.map(file => file.sha256));
    for (const key of memory.keys()) if (!keep.has(key)) memory.delete(key);
    for (const group of groups) {
      const files = selected.filter(file => (file.site === 'CONUS') === (group === national));
      const key = files.map(file => file.sha256).join('/');
      if (key === group.key && !group.error && !group.loading) continue;
      group.key = key; group.shown = []; group.loading = !!files.length;
      group.error = undefined;
      if (group.failed || !files.length) remove(group);
      group.failed = false;
      if (!files.length) continue;
      void (async () => {
        const results = await Promise.allSettled(files.map(async file => {
          const value = await load(file, task.signal);
          task.signal.throwIfAborted(); memory.set(file.sha256, value); return { file, value };
        }));
        if (task.signal.aborted || destroyed) return;
        const ready: { file: RadarFile; value: RadarContours }[] = [], failed: string[] = [];
        results.forEach((result, index) => { if (result.status === 'fulfilled') ready.push(result.value); else failed.push(files[index]!.site); });
        ensure(group);
        // No intermediate empty setData: one indexing pass for the chosen scans.
        await (map.getSource(group.source) as GeoJSONSource).setData({ type: 'FeatureCollection', features: ready.flatMap(item => item.value.features) });
        if (task.signal.aborted || destroyed || group.failed) return;
        group.loading = false; group.shown = ready.map(item => item.file.site);
        group.error = failed.length ? `Radar unavailable: ${failed.join(', ')}` : undefined;
        publish();
      })().catch(error => {
        if (task.signal.aborted || destroyed) return;
        group.loading = false; group.shown = []; group.failed = true; group.error = String(error); publish();
      });
    }
    publish();
  };
  map.on('moveend', update); map.on('error', onError);
  return { update, destroy() {
    destroyed = true; active?.abort(); memory.clear(); map.off('moveend', update); map.off('error', onError);
    for (const group of groups) remove(group);
    controller.setRadarDisplay({ loading: false, sites: [] });
  } };
}
