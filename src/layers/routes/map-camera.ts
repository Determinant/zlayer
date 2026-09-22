import { LngLatBounds, type Map as MapLibreMap } from 'maplibre-gl';
import type { RoutePlan } from '@zlayer/domain';
import type { RouteMapPreview } from './map-preview';
import { unwrapRouteCoordinates } from './geometry';
export function fitRoute(map: MapLibreMap, route: RoutePlan, preview: RouteMapPreview | undefined, targetBearing: () => number): void {
    const plans = preview?.routes.map(route => route.plan) ?? [route];
    const coordinates = plans.flatMap(plan => unwrapRouteCoordinates(
      [...plan.waypoints.map(waypoint => waypoint.feature.geometry.coordinates),
        ...plan.legs.flatMap(leg => leg.geometry ?? []), ...(plan.approachExtensions ?? []).flat(),
        ...(plan.approachDepictions ?? []).flatMap(depiction => depiction.coordinates)], map.getCenter().lng));
    const first = coordinates[0];
    if (!first) return;
    const bearing = targetBearing();
    if (coordinates.length === 1) {
      map.flyTo({ center: first, zoom: 10.5, bearing, duration: 500 });
      return;
    }
    const bounds = coordinates.slice(1).reduce(
      (current, coordinate) => current.extend(coordinate),
      new LngLatBounds(first, first),
    );
    const inset = preview?.inset;
    const container = map.getContainer();
    const padding = inset ? { top: 36, left: 36,
      right: 36 + Math.min(inset.right, Math.max(0, container.clientWidth - 144)),
      bottom: 36 + Math.min(inset.bottom, Math.max(0, container.clientHeight - 144)) } : 72;
    map.fitBounds(bounds, { padding, bearing, maxZoom: 10.5, duration: 550 });
}
