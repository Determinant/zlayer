import type { Map as MapLibreMap, FilterSpecification } from 'maplibre-gl';
import type { GeoPointFeature, PointGeometry } from '@zlayer/contracts';
import type { SnapBounds } from '../../layers/routes/snapping';

/** Measure once on acquisition using public rendered queries. Layout expressions,
 * variable anchors and font metrics remain MapLibre's responsibility. The bounds
 * are relative to the entity's projected anchor, so camera motion translates them.
 * Bisection finds conservative edges to within two CSS pixels. Shrinking each
 * probe avoids repeatedly querying the rest of a densely populated viewport. */
export function renderedSnapBounds(map: MapLibreMap, feature: GeoPointFeature, layers: string[],
  coordinate: PointGeometry['coordinates'], matches: (candidate: ReturnType<MapLibreMap['queryRenderedFeatures']>[number]) => boolean): SnapBounds {
  const anchor = map.project(coordinate);
  const canvas = map.getCanvas();
  const edges: SnapBounds = [-24, -24, canvas.clientWidth + 24, canvas.clientHeight + 24];
  // Queries return canonical identities for every wrapped copy. Partition the
  // search halfway to the adjacent copies, along their strongest screen axis
  // (also handles rotated maps), instead of merging their distant label bounds.
  for (const longitude of [coordinate[0] - 360, coordinate[0] + 360]) {
    const neighbor = map.project([longitude, coordinate[1]]);
    const axis = Math.abs(neighbor.x - anchor.x) >= Math.abs(neighbor.y - anchor.y) ? 0 : 1;
    const origin = axis === 0 ? anchor.x : anchor.y;
    const next = axis === 0 ? neighbor.x : neighbor.y;
    if (!Number.isFinite(next) || next === origin) continue;
    const middle = (origin + next) / 2;
    if (next < origin) edges[axis] = Math.max(edges[axis]!, middle);
    else edges[axis + 2] = Math.min(edges[axis + 2]!, middle);
  }
  const filter: FilterSpecification = ['==', ['get', 'ident'], ['literal', feature.properties.ident ?? null]];
  const hit = (bounds: SnapBounds) => map.queryRenderedFeatures([[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
    { layers, filter }).some(matches);
  for (let edge = 0; edge < 4; edge++) {
    const axis = edge % 2;
    let low = edges[axis]!, high = edges[axis + 2]!;
    while (high - low > 2) {
      const middle = (low + high) / 2;
      const query = [...edges] as SnapBounds;
      query[axis] = low;
      query[axis + 2] = high;
      query[(edge + 2) % 4] = middle;
      if (hit(query) === (edge < 2)) high = middle;
      else low = middle;
    }
    edges[edge] = edge < 2 ? low : high;
  }
  return [edges[0] - anchor.x, edges[1] - anchor.y, edges[2] - anchor.x, edges[3] - anchor.y];
}
