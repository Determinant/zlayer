import { useEffect, useMemo } from 'react';
import type { GeoPointFeature, NavigationData, TerminalProceduresData } from '@zlayer/contracts';
import { createRouteResolver, updateApproachHoldEntries, type ApproachArrival, type TerminalSelection } from '@zlayer/domain';
import type { RouteMapPreview, RoutePreviewInset } from './map-preview';

type Options = {
  ident: string; feature: GeoPointFeature; navigationData: NavigationData | undefined;
  data: TerminalProceduresData | undefined; revision: string | undefined;
  selection: TerminalSelection | undefined; inset: RoutePreviewInset;
  onChange: (preview: RouteMapPreview | undefined) => void; enabled?: boolean;
  arrival?: ApproachArrival | undefined;
};
/** Preview and commit use the same draft selection and route interpreter. */
export function useProcedurePreview({ ident, feature, navigationData, data, revision, selection, inset, onChange, enabled = true, arrival }: Options) {
  const resolve = useMemo(() => data && revision ? createRouteResolver([
    { type: 'FeatureCollection', features: [feature], meta: { layer: 'airports', revision, returned: 1, truncated: false } },
    ...Object.values(navigationData ?? {}).filter(collection => collection.meta.layer !== 'airports'),
  ], undefined, data) : undefined, [feature, navigationData, data, revision]);
  const key = JSON.stringify(selection);
  const plan = useMemo(() => {
    if (!selection || !resolve || !enabled) return;
    const point = { id: 'procedure-preview', text: ident, ...(feature.id ? { pinnedFeatureId: feature.id } : {}) };
    const entry = selection.kind === 'approach' ? { ...point, approach: selection } :
      selection.kind === 'departure' ? { ...point, departure: selection } : { ...point, arrival: selection };
    const plan = resolve({ entries: [entry] });
    updateApproachHoldEntries(plan, arrival);
    return plan;
  }, [key, resolve, ident, feature.id, enabled, arrival]);
  const preview = useMemo<RouteMapPreview | undefined>(() => plan && key ? { routes: [{ key, plan }], selectedKey: key, inset } : undefined,
    [plan, key, inset]);
  useEffect(() => { if (enabled) onChange(preview); }, [preview, enabled, onChange]);
  useEffect(() => () => { if (enabled) onChange(undefined); }, [enabled, onChange]);
  return plan;
}
