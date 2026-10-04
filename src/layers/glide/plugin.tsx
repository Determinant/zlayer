import type { GlideApi } from './public';
import type { PluginExports } from '../../core/layers/bridge';
import type { RoutesApi } from '../routes/public';
import type { OwnshipApi } from '../ownship/public';
import { GPS_MOTION_ACCURACY_METERS } from '../../core/gps/position';
import { routeSegments, type Segment, type Point } from '../../core/geo/route-corridor';
import { createLayerInput, createLayerStore, selectLayerStore, combineLayerStores } from '../../core/layers/store';
import type { LayerPlugin } from '../../core/layers/plugin';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { ToolPanel } from '../../core/ui/tool-panel';
import { bindMapLayer } from '../../core/map/contribution';
import type { CatalogReadSource } from '../../workspace/read-context';
import { pluginStorage, glidePreferences, type GlidePreferences } from './preferences';
import { GlideControls } from './controls';
import { emptyAreas, type GlideAreas, type GlideStatus } from './types';
import type { LandingStatus, LandingSelection } from './landing-data';
export type GlideInput = GlidePreferences & { catalog: CatalogReadSource; change(patch: Partial<GlidePreferences>): void };
export function createGlidePlugin() {
  const input = createLayerInput<GlideInput>();
  const status = createLayerStore<GlideStatus>({ state: 'idle' });
  const landingStatus = createLayerStore<LandingStatus>({ state: 'idle' });
  const landingRevision = createLayerStore(0);
  const landingRanges = createLayerStore<GlideAreas>(emptyAreas());
  const retryLandings = () => landingRevision.publish(landingRevision.getSnapshot() + 1);
  const revision = createLayerStore(0);
  const retry = () => revision.publish(revision.getSnapshot() + 1);
  const noSegments: Segment[] = [];
  const segments = createLayerStore<Segment[]>(noSegments);
  const ownship = createLayerStore<Point | null>(null);
  const selectedPoint = createLayerStore<Point | null>(null);
  const selectedSite = createLayerStore<LandingSelection | null>(null);
  let selectionRevision = 0;
  const clearPoint = () => { selectionRevision++; selectedSite.publish(null); selectedPoint.publish(null); };
  let inspectAt: ((point: { x: number; y: number }) => (() => Promise<LandingSelection | null>) | undefined) | undefined;
  let coordinateAt: ((point: { x: number; y: number }) => Point | undefined) | undefined;
  const settingsInput = combineLayerStores(selectLayerStore(input, state => state && ({ catalog: state.catalog,
    enabled: state.glideEnabled, airportsEnabled: state.glideAirportsEnabled, ratio: state.glideRatio, altitude: state.glideAltitude })), revision, (state, retry) => ({ ...state, retry }));
  const flightInput = combineLayerStores(combineLayerStores(settingsInput, segments,
    (state, segments) => ({ ...state, segments })),
    ownship, (state, ownship) => ({ ...state, ownship }));
  const pointInput = combineLayerStores(selectedPoint, selectedSite, (point, site) => ({ point,
    ...(site ? { pointElevationFt: site.elevationM / .3048 } : {}) }));
  const mapInput = combineLayerStores(flightInput, pointInput, (state, point) => ({ ...state, ...point }));
  const landingInput = combineLayerStores(combineLayerStores(combineLayerStores(selectLayerStore(input, state =>
    ({ enabled: !!state?.glideEnabled && !!state?.glideLandingsEnabled, catalog: state?.catalog })), segments, (state, segments) => ({ ...state, segments })),
    landingRevision, (state, retry) => ({ ...state, retry })), landingRanges, (state, ranges) => ({ ...state, ranges }));
  function Panel() {
    const state = useLayerSnapshot(input), current = useLayerSnapshot(status), point = useLayerSnapshot(selectedPoint);
    const landings = useLayerSnapshot(landingStatus), site = useLayerSnapshot(selectedSite);
    return state ? <ToolPanel className="map-edge-glide" icon={
      <path transform="rotate(135 12 12)"
        d="M10 3a2 2 0 0 1 4 0v5l8 5v3l-8-3v5l3 2v2l-5-1-5 1v-2l3-2v-5l-8 3v-3l8-5Z" />
    }>{(visible, panel) => <GlideControls {...state} status={current} retry={retry} point={point}
      site={site} landingStatus={landings} retryLandings={retryLandings} clearPoint={clearPoint} reveal={panel.setOpen} visible={visible} />}</ToolPanel> : null;
  }
  return {
    publicApi: scope => ({ contextActions: scope.command(screenPoint => {
      const locate = coordinateAt, coordinate = locate?.(screenPoint);
      if (!coordinate || !input.getSnapshot()) return [];
      const inspect = inspectAt?.(screenPoint);
      return [...(inspect ? [{ id: 'glide:inspect-area', label: 'Inspect landing area', select: scope.command(() => {
        const current = ++selectionRevision;
        void inspect().then(site => {
          const state = input.getSnapshot();
          if (!site || current !== selectionRevision || !state?.glideEnabled || !state.glideLandingsEnabled
            || site.sourceKey !== landingStatus.getSnapshot().sourceKey) return;
          selectedSite.publish(site);
          selectedPoint.publish([(site.start[0] + site.end[0]) / 2, (site.start[1] + site.end[1]) / 2]);
        }).catch(() => {
          if (current === selectionRevision) landingStatus.publish({ ...landingStatus.getSnapshot(), state: 'error' });
        });
      }) }] : []), { id: 'glide:point', label: 'Show glide range', select: scope.command(() => {
        const state = input.getSnapshot();
        if (!state || coordinateAt !== locate) return;
        clearPoint(); selectedPoint.publish(coordinate);
        if (!state.glideEnabled) state.change({ glideEnabled: true });
      }) }, ...(selectedPoint.getSnapshot() ? [{ id: 'glide:clear-point', label: 'Clear selected glide point', select: scope.command(clearPoint) }] : [])];
    }) }),
    connect(bridge, scope) {
      scope.add(() => { segments.publish([]); ownship.publish(null); clearPoint(); });
      bridge.watch('routes', (api, connection) => {
        if (api) connection.observe(api.displayedRoutes, plans => segments.publish(routeSegments(plans)));
        else segments.publish([]);
      });
      bridge.watch('ownship', (api, connection) => {
        if (api) connection.observe(api.position, snapshot => {
          const next = snapshot.enabled && snapshot.state === 'tracking' && snapshot.fix &&
            snapshot.fix.accuracy <= GPS_MOTION_ACCURACY_METERS ? snapshot.fix.coordinates : null;
          const previous = ownship.getSnapshot();
          if (next?.[0] !== previous?.[0] || next?.[1] !== previous?.[1]) ownship.publish(next);
        });
        else ownship.publish(null);
      });
    },
    definition: { id: 'glide', title: 'Glide Planner' }, storage: pluginStorage, preferences: glidePreferences, input, status,
    panels: [{ id: 'glide', title: 'Glide Planner toolbox', Component: Panel }],
    mapContribution: { id: 'glide', async load() {
      const [{ createGlideLayer }, { createLandingLayer }] = await Promise.all([import('./map'), import('./landing-map')]);
      const layer = createGlideLayer(status.publish, landingRanges.publish), bound = bindMapLayer(layer, mapInput);
      const landingLayer = createLandingLayer(next => {
        landingStatus.publish(next);
        const selected = selectedSite.getSnapshot();
        if (selected && next.sourceKey && selected.sourceKey !== next.sourceKey) clearPoint();
      }), landingBound = bindMapLayer(landingLayer, landingInput);
      return [{ ...bound,
        mount(map) { bound.mount(map); coordinateAt = layer.coordinateAt; },
        unmount() { if (coordinateAt === layer.coordinateAt) coordinateAt = undefined; bound.unmount(); },
      }, { ...landingBound,
        mount(map) { landingBound.mount(map); inspectAt = landingLayer.inspectAt; },
        update() { landingBound.update(); if (!landingInput.getSnapshot().enabled && selectedSite.getSnapshot()) clearPoint(); },
        unmount() { if (inspectAt === landingLayer.inspectAt) inspectAt = undefined; selectionRevision++; landingBound.unmount(); },
      }];
    } },
  } satisfies LayerPlugin & PluginExports<GlideApi, { routes: RoutesApi; ownship: OwnshipApi }> & { input: typeof input; status: typeof status };
}
