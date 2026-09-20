import type { Bounds, ChartKind, ChartRecord } from '@zlayer/contracts';

export type ChartFamilyId = Exclude<ChartKind, 'unknown'>;
export type ChartBaseId = 'vfr-sectional' | 'ifr-low';
export type ChartOverlayId = 'vfr-terminal' | 'vfr-flyway';
export type ChartBaseSelection = ChartBaseId | '';
export type ChartOverlaySelection = ChartOverlayId | '';
export type ChartSelection = { readonly base: ChartBaseSelection; readonly overlay: ChartOverlaySelection };
export const NO_CHARTS: ChartSelection = { base: '', overlay: '' };

type ChartDefinition = {
  title: string;
  shortTitle: 'VFR' | 'IFR';
};
type ChartBaseDefinition = ChartDefinition & { id: ChartBaseId; role: 'base' };
type ChartOverlayDefinition = ChartDefinition & { id: ChartOverlayId; role: 'overlay'; requires: ChartBaseId };
export type ChartFamilyDefinition = ChartBaseDefinition | ChartOverlayDefinition;

export const CHART_BASES: readonly ChartBaseDefinition[] = [
  { id: 'vfr-sectional', role: 'base', title: 'VFR sectionals', shortTitle: 'VFR' },
  { id: 'ifr-low', role: 'base', title: 'IFR low enroute', shortTitle: 'IFR' },
];
export const CHART_OVERLAYS: readonly ChartOverlayDefinition[] = [
  { id: 'vfr-terminal', role: 'overlay', requires: 'vfr-sectional', title: 'VFR terminal areas', shortTitle: 'VFR' },
  { id: 'vfr-flyway', role: 'overlay', requires: 'vfr-sectional', title: 'VFR flyways', shortTitle: 'VFR' },
];
// Rendering order, bottom to top. Base families are exclusive; overlays are additive.
export const CHART_FAMILIES: readonly ChartFamilyDefinition[] = [...CHART_BASES, ...CHART_OVERLAYS];

export function availableChartBases(charts: readonly ChartRecord[]): ChartBaseDefinition[] {
  return CHART_BASES.filter(base => charts.some(chart => chart.kind === base.id));
}

export function availableChartOverlays(
  charts: readonly ChartRecord[],
  base: ChartBaseSelection,
): ChartOverlayDefinition[] {
  return CHART_OVERLAYS.filter(overlay => overlay.requires === base &&
    charts.some(chart => chart.kind === base) && charts.some(chart => chart.kind === overlay.id)
  );
}

export function resolveChartSelection(
  charts: readonly ChartRecord[],
  preferredBase: ChartBaseSelection | undefined,
  preferredOverlay: ChartOverlaySelection,
): ChartSelection {
  const bases = availableChartBases(charts);
  const base = preferredBase === '' ? ''
    : bases.find(item => item.id === preferredBase)?.id ?? bases[0]?.id ?? '';
  const overlay = availableChartOverlays(charts, base).find(item => item.id === preferredOverlay)?.id ?? '';
  return { base, overlay };
}

export function chartSelectionTitle(selection: ChartSelection): string {
  return CHART_FAMILIES.filter(family => chartIsSelected(family.id, selection))
    .map(family => family.title).join(' + ') || 'Base map';
}

export function chartCountForFamily(
  charts: readonly ChartRecord[],
  id: ChartFamilyId,
): number {
  return charts.filter(chart => chart.kind === id).length;
}

export function chartCountForSelection(charts: readonly ChartRecord[], selection: ChartSelection): number {
  return charts.filter(chart => chartIsSelected(chart.kind, selection)).length;
}

export function chartIsSelected(kind: ChartKind, selection: ChartSelection): boolean {
  return kind === selection.base || CHART_OVERLAYS.some(overlay =>
    overlay.id === kind && overlay.id === selection.overlay && overlay.requires === selection.base);
}

export function chartIsVisible(
  chart: ChartRecord,
  selection: ChartSelection,
  [west, south, east, north]: Bounds,
): boolean {
  if (!chartIsSelected(chart.kind, selection)) return false;
  const [chartWest, chartSouth, chartEast, chartNorth] = chart.bounds;
  if (north < chartSouth || south > chartNorth) return false;
  // MapLibre bounds may cross the antimeridian or lie in another world copy.
  if (east < west) east += 360;
  return Math.ceil((west - chartEast) / 360) <= Math.floor((east - chartWest) / 360);
}
