export type ScreenPoint = { x: number; y: number };
export type ScreenRect = { left: number; right: number; top: number; bottom: number };
const length = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const inside = (point: ScreenPoint, rect: ScreenRect, padding: number) =>
  point.x > rect.left - padding && point.x < rect.right + padding &&
  point.y > rect.top - padding && point.y < rect.bottom + padding;

/** Prefer screen-up for the initial B, then the direction with the most usable space. */
export function suggestedEnd(start: ScreenPoint, width: number, height: number, obstacles: ScreenRect[] = []): ScreenPoint {
  const candidates = [{ x: start.x, y: start.y - 120 }, { x: start.x + 120, y: start.y },
    { x: start.x - 120, y: start.y }, { x: start.x, y: start.y + 120 }];
  const clamp = (point: ScreenPoint) => ({ x: Math.max(32, Math.min(width - 32, point.x)),
    y: Math.max(32, Math.min(height - 32, point.y)) });
  const score = (point: ScreenPoint) => length(point, start) - obstacles.filter(rect => inside(point, rect, 14)).length * 10000;
  return candidates.map(clamp).sort((a, b) => score(b) - score(a))[0]!;
}

/** Only choose a new offset between drags; the grabbed grip must never jump. */
export function gripPosition(anchor: ScreenPoint, other: ScreenPoint | null, occupied: ScreenPoint | null,
  width: number, height: number, obstacles: ScreenRect[], touch: boolean): ScreenPoint {
  const offset = touch ? 64 : 44;
  const separation = other ? length(anchor, other) : 0;
  let normal: [number, number] = other && separation > 1
    ? [-(other.y - anchor.y) / separation, (other.x - anchor.x) / separation] : [0, 1];
  if (normal[1] < -.01 || Math.abs(normal[1]) <= .01 && normal[0] < 0) normal = [-normal[0], -normal[1]];
  const directions = [normal, [-normal[0], -normal[1]], [0, 1], [1, 0], [-1, 0], [0, -1],
    [.707, .707], [-.707, .707], [.707, -.707], [-.707, -.707]];
  const candidates = directions.map(([x, y]) => ({ x: anchor.x + x! * offset, y: anchor.y + y! * offset }));
  const cost = (point: ScreenPoint, preference: number) => {
    const edge = Math.max(0, 26 - point.x, point.x - width + 26) + Math.max(0, 26 - point.y, point.y - height + 26);
    return edge * 100 + obstacles.filter(rect => inside(point, rect, 26)).length * 10000 +
      (other ? Math.max(0, 55 - length(point, other)) * 100 : 0) +
      (occupied ? Math.max(0, 54 - length(point, occupied)) * 200 : 0) + preference;
  };
  return candidates.map((point, i) => ({ point, cost: cost(point, i) })).sort((a, b) => a.cost - b.cost)[0]!.point;
}
