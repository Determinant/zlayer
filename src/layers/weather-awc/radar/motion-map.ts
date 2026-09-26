import type { Map } from 'maplibre-gl';
import { createSourceSubmission } from '../source-submission';
import type { FeatureCollection, Feature } from 'geojson';
import type { RadarMotionCatalog, RadarMotionSnapshot } from '@zlayer/contracts';
import type { WeatherController } from '../controller';
import { currentRadar } from './time';
import { motionFile, motionScans } from './motion-time';

const SOURCE = 'weather-awc-storm-motion', ARROW = `${SOURCE}-arrow`;
export const MOTION_LAYERS = ['halo', 'line', 'dots', 'arrows', 'labels'].map(suffix => `${SOURCE}-${suffix}`);
const bearing = (a: number[], b: number[]) => {
  const r = Math.PI / 180, d = (b[0]! - a[0]!) * r, lat = a[1]! * r, next = b[1]! * r;
  return Math.atan2(Math.sin(d) * Math.cos(next), Math.cos(lat) * Math.sin(next) - Math.sin(lat) * Math.cos(next) * Math.cos(d)) / r;
};
export function mountRadarMotionMap(map: Map, controller: WeatherController, before: () => string) {
  let active: AbortController | undefined, identity = '', retry = -1, destroyed = false;
  let attempted: RadarMotionCatalog | undefined, cached: { hash: string; value: RadarMotionSnapshot } | undefined;
  const selectionKey = (hash: string, time: number, now: number) => `${hash}/${time}/${cached?.hash === hash
    ? motionScans(cached.value.scans, time, now).map(s => s.site).join(',') : ''}`;
  const remove = () => {
    for (const layer of [...MOTION_LAYERS].reverse()) if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
  };
  const hide = () => { for (const layer of MOTION_LAYERS) if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', 'none'); };
  const empty = { loading: false, cells: 0, stations: 0 };
  const submission = createSourceSubmission(map, SOURCE, error => {
    hide(); controller.setRadarMotionDisplay({ ...empty, error: `Storm motion: ${error instanceof Error ? error.message : String(error)}` });
  });
  const ensure = () => {
    if (map.getSource(SOURCE)) return;
    if (!map.hasImage(ARROW)) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 24;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Arrow image is unavailable');
      ctx.beginPath(); ctx.moveTo(12, 3); ctx.lineTo(20, 20); ctx.lineTo(12, 16); ctx.lineTo(4, 20); ctx.closePath();
      ctx.lineWidth = 2; ctx.strokeStyle = '#172b39'; ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
      map.addImage(ARROW, ctx.getImageData(0, 0, 24, 24), { pixelRatio: 2 });
    }
    map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, tolerance: 0, attribution: 'NOAA / NWS Storm Tracking Information' });
    const anchor = before();
    for (const [i, width, color] of [[0, 4, '#172b39'], [1, 2, '#fff']] as const) map.addLayer({ id: MOTION_LAYERS[i]!, source: SOURCE,
      type: 'line', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: { 'line-width': width, 'line-color': color } }, anchor);
    map.addLayer({ id: MOTION_LAYERS[2]!, source: SOURCE, type: 'circle', filter: ['==', ['geometry-type'], 'Point'], layout: { visibility: 'none' },
      paint: { 'circle-radius': ['case', ['==', ['get', 'minutes'], 0], 3.5, 2], 'circle-color': '#fff', 'circle-stroke-color': '#172b39', 'circle-stroke-width': 1.5 } }, anchor);
    map.addLayer({ id: MOTION_LAYERS[3]!, source: SOURCE, type: 'symbol', filter: ['==', ['get', 'end'], true], layout: { visibility: 'none',
      'icon-image': ARROW, 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } }, anchor);
    map.addLayer({ id: MOTION_LAYERS[4]!, source: SOURCE, type: 'symbol', minzoom: 7, filter: ['==', ['geometry-type'], 'Point'], layout: { visibility: 'none',
      'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-anchor': 'top-left', 'text-offset': [.5, .5] },
      paint: { 'text-color': '#fff', 'text-halo-color': '#172b39', 'text-halo-width': 1.5 } }, anchor);
  };
  const update = () => {
    if (destroyed) return;
    const state = controller.getSnapshot(), p = state.preferences;
    const composite = p.awcEnabled && p.awcRadar && p.awcRadarMotion && state.radarDisplay.sites.includes('CONUS')
      ? currentRadar(state.radar.snapshot, state.selectedTime, state.now).find(f => f.site === 'CONUS') : undefined;
    const file = composite && motionFile(state.radarMotion.snapshot, state.selectedTime, state.now);
    const next = file ? selectionKey(file.sha256, composite!.observedAt, state.now) : '';
    if (identity === next && retry === state.radarRetry && (!submission.failed || attempted === state.radarMotion.snapshot)) return;
    identity = next; retry = state.radarRetry; attempted = state.radarMotion.snapshot;
    active?.abort(); const task = active = new AbortController();
    hide();
    if (submission.failed) remove();
    submission.invalidate();
    if (!file || !composite) { cached = undefined; controller.setRadarMotionDisplay(empty); return; }
    const version = submission.begin();
    controller.setRadarMotionDisplay({ ...empty, loading: true });
    void (async () => {
      const value = cached?.hash === file.sha256 ? cached.value : await new Promise<RadarMotionSnapshot>((resolve, reject) => {
        void controller.loadRadarMotion(file, task.signal, resolve).then(resolve, reject);
      });
      if (task.signal.aborted || destroyed) return;
      cached = { hash: file.sha256, value };
      identity = selectionKey(file.sha256, composite.observedAt, Date.now());
      const scans = motionScans(value.scans, composite.observedAt, Date.now()), features: Feature[] = [];
      for (const scan of scans) for (const track of scan.tracks) {
        const common = { site: scan.site, cell: track.id, observedAt: scan.observedAt };
        features.push({ type: 'Feature', properties: common, geometry: { type: 'LineString', coordinates: track.coordinates } });
        for (const [i, point] of track.coordinates.entries()) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: point },
          properties: { ...common, minutes: i * track.intervalMinutes, end: i === track.coordinates.length - 1,
            bearing: i ? bearing(track.coordinates[i - 1]!, point) : 0, label: i ? `+${i * track.intervalMinutes}m` : `${scan.site} ${track.id}` } });
      }
      ensure();
      const accepted = await submission.submit(version, { type: 'FeatureCollection', features } satisfies FeatureCollection);
      if (task.signal.aborted || !accepted) return;
      for (const layer of MOTION_LAYERS) map.setLayoutProperty(layer, 'visibility', 'visible');
      controller.setRadarMotionDisplay({ loading: false, cells: scans.reduce((n, s) => n + s.tracks.length, 0), stations: scans.length,
        ...(scans.length ? { oldest: Math.min(...scans.map(s => s.observedAt)), newest: Math.max(...scans.map(s => s.observedAt)) } : {}) });
    })().catch(error => { if (!task.signal.aborted) submission.reject(version, error); });
  };
  return { update, destroy() {
    destroyed = true; active?.abort(); cached = undefined; submission.destroy(); remove();
    if (map.hasImage(ARROW)) map.removeImage(ARROW);
    controller.setRadarMotionDisplay(empty);
  } };
}
