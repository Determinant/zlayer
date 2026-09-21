import type { ProcedureSelection } from './data';

export type PlateMapImage = {
  selection: ProcedureSelection;
  canvas: HTMLCanvasElement;
  /** Clockwise from the top left, in longitude/latitude. */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  /** Actual image boundary; transparent corners must not capture map gestures. */
  outline: [number, number][];
};

/** Mercator-normalized coordinates, allowing unwrapped world copies. */
export function mercator([longitude, latitude]: [number, number]): [number, number] {
  return [longitude / 360, -Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) / (2 * Math.PI)];
}

export function unmercator([x, y]: [number, number]): [number, number] {
  return [x * 360, Math.atan(Math.sinh(-y * 2 * Math.PI)) * 180 / Math.PI];
}

export function plateContains(image: Pick<PlateMapImage, 'outline'>, coordinate: [number, number]): boolean {
  const reference = image.outline[0]?.[0];
  if (reference === undefined) return false;
  const longitude = coordinate[0] + Math.round((reference - coordinate[0]) / 360) * 360;
  const [x, y] = mercator([longitude, coordinate[1]]);
  const polygon = image.outline.map(mercator);
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
