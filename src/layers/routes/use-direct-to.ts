import { useEffect, useState, useSyncExternalStore } from 'react';
import type { GeoPointFeature } from '@zlayer/contracts';
import { featureIdent, type RouteDraft, type RoutePlan } from '@zlayer/domain';
import type { GpsService } from '../../core/gps/service';
import { directToFeature, directToPosition, directToRoutePoint, directToRouteProblem, type DirectToAction } from './direct-to';
import { sameRouteDraft } from './draft';

export type DirectToConfirmation = {
  ident: string;
  available: boolean;
  problem?: string;
  confirm: () => void;
  cancel: () => void;
};

/** Observe availability only; GPS motion does not rerender the whole workspace. */
export function useDirectTo(layer: Pick<GpsService, 'subscribe' | 'getSnapshot'>, plan: RoutePlan,
  update: (edit: (draft: RouteDraft) => RouteDraft) => void): {
    action: DirectToAction | undefined;
    confirmation: DirectToConfirmation | undefined;
  } {
  const available = useSyncExternalStore(layer.subscribe, () => !!directToPosition(layer.getSnapshot()));
  const [pending, setPending] = useState<{ feature: GeoPointFeature; plan: RoutePlan; problem?: string }>();
  const unchanged = !pending || sameRouteDraft(plan, pending.plan);
  useEffect(() => { if (!unchanged) setPending(undefined); }, [unchanged]);
  const action: DirectToAction = (feature, point) => {
    const position = directToPosition(layer.getSnapshot());
    if (!position) return;
    if (!point) { setPending({ feature, plan }); return; }
    const problem = directToRouteProblem(plan, point);
    if (problem) { setPending({ feature, plan, problem }); return; }
    update(draft => directToRoutePoint(draft, plan, point, position));
  };
  return {
    action: available ? action : undefined,
    confirmation: pending && unchanged ? {
      ident: featureIdent(pending.feature), available: available && !pending.problem,
      ...(pending.problem ? { problem: pending.problem } : {}),
      cancel: () => setPending(undefined),
      confirm: () => {
        if (pending.problem) return;
        const position = directToPosition(layer.getSnapshot());
        if (!position) return;
        update(draft => sameRouteDraft(draft, pending.plan) ? directToFeature(pending.feature, position) : draft);
        setPending(undefined);
      },
    } : undefined,
  };
}
