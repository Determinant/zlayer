import type { Map as MapLibreMap, MapEventType, MapGeoJSONFeature, MapMouseEvent, MapTouchEvent } from 'maplibre-gl';
import type { GeoPointFeature } from '@zlayer/contracts';
import { featureKey, sameFeature, routeCoordinateFeature, restoreRouteCoordinate, type RouteEditTarget, type RoutePlan } from '@zlayer/domain';
import { ROUTE_LEG_HIT_LAYER_ID, ROUTE_WAYPOINT_HIT_LAYER_ID, ROUTE_SOURCE_ID, type RouteDragPreview } from '../../layers/routes/renderer';
import { routeEditTarget } from '../../layers/routes/editing';
import { routePointKeys } from '../../layers/routes/selection';
import { unwrapRouteCoordinates } from '../../layers/routes/geometry';
import type { NearbyFeature, SelectFeature } from '../feature-selection';

type GestureOptions = {
  route: () => RoutePlan;
  canEditRoute: () => boolean;
  interactiveLayerIds: () => string[];
  preview: (input: { route: RoutePlan; preview?: RouteDragPreview }) => void;
  onSelect: SelectFeature;
  onChooseNearby?: (features: NearbyFeature[], point: { x: number; y: number }) => void;
  onRouteLegInsert: (afterEntryId: string, feature: GeoPointFeature) => void;
  onRouteWaypointReplace: (entryId: string, feature: GeoPointFeature) => void;
  onRouteWaypointRemove: (entryId: string) => void;
};

type RouteDragState = {
  target: RouteEditTarget;
  revision: number;
  candidate: GeoPointFeature | undefined;
  coordinate: GeoPointFeature | undefined;
  allowCoordinateDrop: boolean;
  dragPanWasEnabled: boolean;
  touchZoomWasEnabled: boolean;
  startPoint: [number, number];
  distancePx: number;
  active: boolean;
};

const SNAP_RADIUS_PX = 24;
const DRAG_THRESHOLD_PX = 6;
const SNAP_OFF_RADIUS_PX = 28;
const NEARBY_RADIUS_PX = 30;
const LONG_PRESS_MS = 550;

export class MapGestures {
  readonly #map: MapLibreMap;
  #routeDrag: RouteDragState | undefined;
  #suppressClick = false;
  #suppressClickTimer: number | undefined;
  #nearbyLongPress: { point: [number, number]; timer: number } | undefined;
  readonly #unbind: Array<() => void> = [];

  constructor(map: MapLibreMap, private readonly options: GestureOptions) {
    this.#map = map;
    const on = <T extends keyof MapEventType>(type: T, listener: (event: MapEventType[T]) => void) => {
      map.on(type, listener);
      this.#unbind.push(() => { map.off(type, listener); });
    };
    on('click', (event) => this.#selectFeature(event));
    on('contextmenu', (event) => { event.preventDefault(); this.#showNearby(event.point); });
    on('mousedown', (event) => this.#startRouteDrag(event));
    on('touchstart', (event) => { this.#startRouteDrag(event); this.#startNearbyLongPress(event); });
    on('mousemove', (event) => {
      this.#updateRouteDrag(event);
      this.#setPointerCursor(event);
    });
    on('touchmove', (event) => { this.#updateRouteDrag(event); this.#cancelNearbyLongPressIfMoved(event); });
    on('mouseup', () => this.#finishRouteDrag());
    // MapLibre's touchend points are changedTouches, not the remaining touches.
    on('touchend', (event) => { this.#finishRouteDrag(event.originalEvent.touches.length === 0); this.#cancelNearbyLongPress(); });
    on('touchcancel', () => { this.#finishRouteDrag(false); this.#cancelNearbyLongPress(); });
    window.addEventListener('mouseup', this.#finishDragOutsideMap);
    window.addEventListener('touchend', this.#finishDragOutsideMap);
    window.addEventListener('touchcancel', this.#finishDragOutsideMap);
  }

  get dragging(): boolean { return this.#routeDrag !== undefined; }
  cancelRouteDrag(): void { this.#finishRouteDrag(false); }

  destroy(): void {
    this.#finishRouteDrag(false);
    for (const unbind of this.#unbind.splice(0)) unbind();
    if (this.#suppressClickTimer !== undefined) window.clearTimeout(this.#suppressClickTimer);
    if (this.#nearbyLongPress) window.clearTimeout(this.#nearbyLongPress.timer);
    window.removeEventListener('mouseup', this.#finishDragOutsideMap);
    window.removeEventListener('touchend', this.#finishDragOutsideMap);
    window.removeEventListener('touchcancel', this.#finishDragOutsideMap);
  }

  #selectFeature(event: MapMouseEvent): void {
    if (this.#suppressClick) {
      this.#suppressClick = false;
      if (this.#suppressClickTimer !== undefined) {
        window.clearTimeout(this.#suppressClickTimer);
        this.#suppressClickTimer = undefined;
      }
      return;
    }
    const features = this.#map.queryRenderedFeatures(event.point, {
      layers: this.options.interactiveLayerIds(),
    });
    const feature = features.find(isPointFeature);
    const pointId = feature?.source === ROUTE_SOURCE_ID && typeof feature.properties.routePointId === 'string'
      ? feature.properties.routePointId : undefined;
    this.options.onSelect(feature ? toPointFeature(feature) : undefined, pointId);
  }

  #showNearby(point: MapMouseEvent['point']): void {
    const nearby: NearbyFeature[] = [];
    const longitude = this.#map.unproject(point).lng;
    const pointKeys = routePointKeys(this.options.route());
    for (const [routeIndex, waypoint] of this.options.route().waypoints.entries()) {
      if (this.#featureDistance(waypoint.feature, point, longitude) <= NEARBY_RADIUS_PX) {
        nearby.push({ feature: waypoint.feature, routePointId: pointKeys.get(waypoint)!, routeIndex });
      }
    }
    const features = this.#map.queryRenderedFeatures([
      [point.x - NEARBY_RADIUS_PX, point.y - NEARBY_RADIUS_PX],
      [point.x + NEARBY_RADIUS_PX, point.y + NEARBY_RADIUS_PX],
    ], { layers: this.options.interactiveLayerIds() })
      .filter(isPointFeature)
      .map(toPointFeature);
    const unique = new Map<string, GeoPointFeature>();
    for (const feature of features) {
      if (nearby.some(candidate => sameFeature(candidate.feature, feature))) continue;
      unique.set(featureKey(feature), feature);
    }
    nearby.push(...[...unique.values()].map(feature => ({ feature })));
    if ((nearby.length > 1 || nearby[0]?.routeIndex !== undefined) && this.options.onChooseNearby) {
      this.options.onChooseNearby(nearby, { x: point.x, y: point.y });
    } else this.options.onSelect(nearby[0]?.feature, nearby[0]?.routePointId);
  }

  #startNearbyLongPress(event: MapTouchEvent): void {
    this.#cancelNearbyLongPress();
    if (event.points.length !== 1) return;
    const point: [number, number] = [event.point.x, event.point.y];
    const timer = window.setTimeout(() => {
      this.#nearbyLongPress = undefined;
      this.cancelRouteDrag();
      this.#showNearby({ x: point[0], y: point[1] } as MapMouseEvent['point']);
      this.#suppressNextClick();
    }, LONG_PRESS_MS);
    this.#nearbyLongPress = { point, timer };
  }

  #cancelNearbyLongPressIfMoved(event: MapTouchEvent): void {
    const pending = this.#nearbyLongPress;
    if (!pending || event.points.length !== 1 || Math.hypot(
      event.point.x - pending.point[0], event.point.y - pending.point[1]) > DRAG_THRESHOLD_PX) {
      if (pending) this.#cancelNearbyLongPress();
    }
  }

  #cancelNearbyLongPress(): void {
    if (!this.#nearbyLongPress) return;
    window.clearTimeout(this.#nearbyLongPress.timer);
    this.#nearbyLongPress = undefined;
  }

  #setPointerCursor(event: MapMouseEvent): void {
    if (this.#routeDrag) {
      this.#map.getCanvas().style.cursor = 'grabbing';
      return;
    }
    const hasRouteTarget = this.options.canEditRoute() && this.#routeTarget(event.point) !== undefined;
    const hasFeature = this.#map.queryRenderedFeatures(event.point, {
      layers: this.options.interactiveLayerIds(),
    }).length > 0;
    this.#map.getCanvas().style.cursor = hasRouteTarget ? 'grab' : hasFeature ? 'pointer' : '';
  }

  #startRouteDrag(event: MapMouseEvent | MapTouchEvent): void {
    // GeoJSON hit features can lag behind comparison state while the worker updates.
    if (!this.options.canEditRoute()) return;
    if ('points' in event && event.points.length !== 1) {
      this.#finishRouteDrag(false);
      return;
    }
    if (!('points' in event) && event.originalEvent.button !== 0) return;
    const target = this.#routeTarget(event.point);
    if (target) this.#beginRouteDrag(event, target);
  }

  #routeTarget(point: MapMouseEvent['point']): RouteEditTarget | undefined {
    const layers = [ROUTE_WAYPOINT_HIT_LAYER_ID, ROUTE_LEG_HIT_LAYER_ID].filter(id => this.#map.getLayer(id));
    if (!layers.length) return undefined;
    const targets = this.#map.queryRenderedFeatures(point, { layers });
    const route = this.options.route();
    // Endpoint hit areas overlap the leg. Always move an existing waypoint there.
    const waypoint = targets.find((feature) => feature.layer.id === ROUTE_WAYPOINT_HIT_LAYER_ID);
    if (waypoint) return routeEditTarget(waypoint.properties, route);
    const leg = targets.find(feature => feature.layer.id === ROUTE_LEG_HIT_LAYER_ID);
    return leg ? routeEditTarget(leg.properties, route) : undefined;
  }

  #beginRouteDrag(
    event: MapMouseEvent | MapTouchEvent,
    identity: RouteEditTarget,
  ): void {
    if (this.#routeDrag) return;
    event.preventDefault();
    const dragPanWasEnabled = this.#map.dragPan.isEnabled();
    const touchZoomWasEnabled = this.#map.touchZoomRotate.isEnabled();
    if (dragPanWasEnabled) this.#map.dragPan.disable();
    if (touchZoomWasEnabled) this.#map.touchZoomRotate.disable();
    this.#routeDrag = {
      target: identity,
      revision: this.options.route().revision,
      candidate: undefined,
      coordinate: undefined,
      allowCoordinateDrop: identity.kind === 'leg' || this.options.route().waypoints.some(
        waypoint => waypoint.edit?.entryId === identity.entryId && waypoint.feature.properties.kind === 'coordinate'),
      dragPanWasEnabled,
      touchZoomWasEnabled,
      startPoint: [event.point.x, event.point.y],
      distancePx: 0,
      active: false,
    };
    this.#map.getCanvas().style.cursor = 'grabbing';
  }

  #updateRouteDrag(event: MapMouseEvent | MapTouchEvent): void {
    if ('points' in event && event.points.length !== 1) {
      this.#finishRouteDrag(false);
      return;
    }
    const drag = this.#routeDrag;
    if (!drag) return;
    if (!this.options.canEditRoute() || drag.revision !== this.options.route().revision) {
      this.#finishRouteDrag(false);
      return;
    }
    drag.distancePx = Math.hypot(
      event.point.x - drag.startPoint[0],
      event.point.y - drag.startPoint[1],
    );
    if (!drag.active && drag.distancePx < DRAG_THRESHOLD_PX) return;
    drag.active = true;
    const candidate = this.#nearestSnapFeature(event);
    drag.coordinate = !candidate && drag.allowCoordinateDrop
      ? routeCoordinateFeature([event.lngLat.lng, event.lngLat.lat]) : undefined;
    const coordinate = candidate?.geometry.coordinates ?? drag.coordinate?.geometry.coordinates ?? [event.lngLat.lng, event.lngLat.lat];
    drag.candidate = candidate;
    this.options.preview({ route: this.options.route(), preview: {
      target: drag.target, revision: drag.revision, coordinate, snapped: candidate !== undefined,
    } });
  }

  #finishRouteDrag(commit = true): void {
    const drag = this.#routeDrag;
    if (!drag) return;
    commit = commit && this.options.canEditRoute() && drag.revision === this.options.route().revision;
    this.#routeDrag = undefined;
    if (drag.dragPanWasEnabled) this.#map.dragPan.enable();
    if (drag.touchZoomWasEnabled) this.#map.touchZoomRotate.enable();
    this.#map.getCanvas().style.cursor = '';
    this.options.preview({ route: this.options.route() });
    const dropFeature = drag.candidate ?? drag.coordinate;
    if (commit && drag.active && drag.target.kind === 'leg' && dropFeature) {
      this.options.onRouteLegInsert(drag.target.afterEntryId, dropFeature);
    }
    if (commit && drag.active && drag.target.kind === 'waypoint') {
      if (dropFeature) {
        this.options.onRouteWaypointReplace(drag.target.entryId, dropFeature);
      } else if (drag.distancePx >= SNAP_OFF_RADIUS_PX) {
        this.options.onRouteWaypointRemove(drag.target.entryId);
      }
    }
    if (commit && drag.active) this.#suppressNextClick();
  }

  #nearestSnapFeature(event: MapMouseEvent | MapTouchEvent): GeoPointFeature | undefined {
    const { x, y } = event.point;
    const features = this.#map.queryRenderedFeatures(
      [[x - SNAP_RADIUS_PX, y - SNAP_RADIUS_PX], [x + SNAP_RADIUS_PX, y + SNAP_RADIUS_PX]],
      { layers: this.options.interactiveLayerIds() },
    ).filter(isPointFeature);
    const drag = this.#routeDrag;
    const leg = drag?.target.kind === 'leg'
      ? this.options.route().legs.find(
          (candidate) => candidate.edit?.afterEntryId === (drag.target.kind === 'leg' ? drag.target.afterEntryId : undefined),
        )
      : undefined;
    const waypoint = drag?.target.kind === 'waypoint'
      ? this.options.route().waypoints.find((candidate) => candidate.edit?.entryId === (drag.target.kind === 'waypoint' ? drag.target.entryId : undefined))
      : undefined;
    const candidates = features
      // A GPS marker has no feature ID, and its preview has already moved away
      // from the original coordinate. Exclude it by entry identity before stripping
      // editing properties, so it cannot snap to its own marker or label.
      .filter(feature => !(drag?.target.kind === 'waypoint' && feature.source === ROUTE_SOURCE_ID &&
        feature.properties.editEntryId === drag.target.entryId))
      .map(toPointFeature)
      .filter((feature) => !leg || (
        !sameFeature(feature, leg.from.feature) && !sameFeature(feature, leg.to.feature)
      ))
      .filter((feature) => !waypoint || !sameFeature(feature, waypoint.feature));
    let nearest: GeoPointFeature | undefined;
    let nearestDistance = Infinity;
    for (const feature of candidates) {
      const distance = this.#featureDistance(feature, event.point, event.lngLat.lng);
      if (distance < nearestDistance) { nearest = feature; nearestDistance = distance; }
    }
    return nearest;
  }

  #featureDistance(feature: GeoPointFeature, point: MapMouseEvent['point'], longitude: number): number {
    // Query geometry uses canonical longitudes; compare in the world copy under the pointer.
    const coordinate = unwrapRouteCoordinates([feature.geometry.coordinates], longitude)[0]!;
    const projected = this.#map.project(coordinate);
    return Math.hypot(projected.x - point.x, projected.y - point.y);
  }

  #suppressNextClick(): void {
    this.#suppressClick = true;
    if (this.#suppressClickTimer !== undefined) {
      window.clearTimeout(this.#suppressClickTimer);
    }
    this.#suppressClickTimer = window.setTimeout(() => {
      this.#suppressClick = false;
      this.#suppressClickTimer = undefined;
    }, 400);
  }

  #finishDragOutsideMap = (event: Event): void => {
    this.#finishRouteDrag(event.type !== 'touchcancel' &&
      (!('touches' in event) || (event as TouchEvent).touches.length === 0));
  };
}

type MapPointFeature = MapGeoJSONFeature & { geometry: GeoPointFeature['geometry'] };

function isPointFeature(feature: MapGeoJSONFeature): feature is MapPointFeature {
  return feature.geometry.type === 'Point';
}

function toPointFeature(feature: MapPointFeature): GeoPointFeature {
  // Route markers also carry navigation data. Do not persist their transient
  // editing state when a selected/snapped point is reused in another route.
  const properties = { ...feature.properties };
  // Tile encoding can turn a string GeoJSON ID into 0. Recover the original
  // identity so named points still match their navigation data and route entries.
  const id = typeof properties.mapFeatureId === 'string' ? properties.mapFeatureId
    : typeof feature.id === 'string' ? feature.id : undefined;
  delete properties.mapFeatureId;
  if (feature.source === ROUTE_SOURCE_ID) {
    for (const key of ['routeKind', 'routePointId', 'navigationLayer', 'editKind', 'editEntryId', 'planRevision', 'dragging', 'snapped']) {
      delete properties[key];
    }
  }
  return restoreRouteCoordinate({
    type: 'Feature',
    ...(id === undefined ? {} : { id }),
    geometry: {
      type: 'Point',
      coordinates: feature.geometry.coordinates as [number, number],
    },
    // Tile queries return null-prototype properties that MapLibre's worker
    // serializer cannot accept when selection or route snapping reuses them.
    properties,
  });
}
