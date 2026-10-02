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
import type { GlideStatus } from './types';
export type GlideInput = GlidePreferences & { catalog: CatalogReadSource; change(patch: Partial<GlidePreferences>): void };
export function createGlidePlugin() {
  const input = createLayerInput<GlideInput>();
  const status = createLayerStore<GlideStatus>({ state: 'idle' });
  const revision = createLayerStore(0);
  const retry = () => revision.publish(revision.getSnapshot() + 1);
  const noSegments: Segment[] = [];
  const segments = createLayerStore<Segment[]>(noSegments);
  const ownship = createLayerStore<Point | null>(null);
  const selectedPoint = createLayerStore<Point | null>(null);
  const clearPoint = () => selectedPoint.publish(null);
  let coordinateAt: ((point: { x: number; y: number }) => Point | undefined) | undefined;
  const settingsInput = combineLayerStores(selectLayerStore(input, state => state && ({ catalog: state.catalog,
    enabled: state.glideEnabled, airportsEnabled: state.glideAirportsEnabled, ratio: state.glideRatio, altitude: state.glideAltitude })), revision, (state, retry) => ({ ...state, retry }));
  // No route demand means no airport acquisition or preparation. The existing
  // route lifecycle clears amber coverage while retaining independent ranges.
  const flightInput = combineLayerStores(combineLayerStores(settingsInput, segments,
    (state, segments) => ({ ...state, segments: state.airportsEnabled ? segments : noSegments })),
    ownship, (state, ownship) => ({ ...state, ownship }));
  const mapInput = combineLayerStores(flightInput, selectedPoint, (state, point) => ({ ...state, point }));
  function Panel() {
    const state = useLayerSnapshot(input), current = useLayerSnapshot(status), point = useLayerSnapshot(selectedPoint);
    return state ? <ToolPanel className="map-edge-glide" icon={
      <path transform="rotate(135 12 12)"
        d="M10 3a2 2 0 0 1 4 0v5l8 5v3l-8-3v5l3 2v2l-5-1-5 1v-2l3-2v-5l-8 3v-3l8-5Z" />
    }>{(visible, panel) => <GlideControls {...state} status={current} retry={retry} point={point}
      clearPoint={clearPoint} reveal={panel.setOpen} visible={visible} />}</ToolPanel> : null;
  }
  return {
    publicApi: scope => ({ contextActions: scope.command(screenPoint => {
      const locate = coordinateAt, coordinate = locate?.(screenPoint);
      if (!coordinate || !input.getSnapshot()) return [];
      return [{ id: 'glide:point', label: 'Show glide range', select: scope.command(() => {
        const state = input.getSnapshot();
        if (!state || coordinateAt !== locate) return;
        selectedPoint.publish(coordinate);
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
      const { createGlideLayer } = await import('./map');
      const layer = createGlideLayer(status.publish), bound = bindMapLayer(layer, mapInput);
      return [{ ...bound,
        mount(map) { bound.mount(map); coordinateAt = layer.coordinateAt; },
        unmount() { if (coordinateAt === layer.coordinateAt) coordinateAt = undefined; bound.unmount(); },
      }];
    } },
  } satisfies LayerPlugin & PluginExports<GlideApi, { routes: RoutesApi; ownship: OwnshipApi }> & { input: typeof input; status: typeof status };
}
