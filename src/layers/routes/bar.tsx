import type { ReactNode } from 'react';
import { PersistentDetails } from '../../core/ui/persistent-details';

import { routeEntryPins, type RoutePlan } from '@zlayer/domain';
import type { CatalogResponse } from '@zlayer/contracts';

import { RouteEditor } from './editor';
import type { RouteLoadStatus } from './use-plan';
import { RouteRecommendations } from './recommendations';
import type { RouteDraft } from './draft';
import type { RouteRecommendationsMap } from './suggestions';
import { routeConditions } from './conditions';

type RouteBarProps = {
  plan: RoutePlan;
  status: RouteLoadStatus;
  catalog: CatalogResponse;
  onUseRoute: (draft: RouteDraft) => void;
  onRecommendationPreview?: (preview: RouteRecommendationsMap | undefined) => void;
  onAppendInput: (input: string) => void;
  onInsertInput: (beforeEntryId: string, input: string) => void;
  onReplaceInput: (entryId: string, input: string) => void;
  onRemoveEntry: (entryId: string) => void;
  onMoveEntry: (fromEntryId: string, toEntryId: string) => void;
  onClear: () => void;
  onFit: () => void;
};

export function RouteBar({
  plan,
  status,
  catalog,
  onUseRoute,
  onRecommendationPreview,
  onAppendInput,
  onInsertInput,
  onReplaceInput,
  onRemoveEntry,
  onMoveEntry,
  onClear,
  onFit,
}: RouteBarProps) {
  return (
    <section className="route-bar" aria-label="Flight route planner">
      <RouteEditor
        plan={plan}
        status={status}
        onAppendInput={onAppendInput}
        onInsertInput={onInsertInput}
        onReplaceInput={onReplaceInput}
        onRemoveEntry={onRemoveEntry}
        onMoveEntry={onMoveEntry}
        onClear={onClear}
        onFit={onFit}
        tools={<>
          <RouteRecommendations catalog={catalog} tokens={plan.tokens} pins={routeEntryPins(plan.entries)} onUseRoute={onUseRoute}
            {...(onRecommendationPreview ? { onPreviewChange: onRecommendationPreview } : {})} />
          <button
            type="button"
            className="route-fit"
            onClick={onFit}
            disabled={plan.waypoints.length === 0}
            aria-label="Fit route on map"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" />
            </svg>
            <span>Fit</span>
          </button>
          <RouteSummary plan={plan} status={status} />
        </>}
      />
    </section>
  );
}

function RouteSummary({ plan, status }: Pick<RouteBarProps, 'plan' | 'status'>) {
  if (status === 'loading') return <Summary muted>Loading FAA index…</Summary>;
  const messages = plan.issues.map(issue => issue.message);
  if (plan.procedures.length) messages.push('SID/STAR waypoint preview only: airport connections, vectors, turn paths and constraints are not depicted. Consult the plates.');
  if (status === 'error') messages.unshift('Route data unavailable. Connect to download the FAA index.');
  if (status === 'partial') messages.unshift('Some route data is unavailable; the route may be incomplete.');
  const tecDetails = plan.tecRoutes.flatMap(({ route }) => [
    `${route.designator}: ${route.route}`,
    ...routeConditions(route).map(([label, value]) => `${label}: ${value}`),
    'Published TEC definition; eligibility and ATC clearance are not verified.',
  ]);
  if (messages.length > 0 || tecDetails.length > 0) {
    const warning = messages.length > 0;
    return (
      <PersistentDetails storageKey="route-summary-open" className={`route-summary${warning ? ' is-error' : ''}`}>
        <summary aria-label={warning ? `Route issues (${messages.length}): ${messages[0]}` : 'TEC route details and published conditions'}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {warning ? <path d="M12 3 2 21h20Z M12 9v5 M12 17v1" />
              : <><circle cx="12" cy="12" r="9" /><path d="M12 11v6 M12 7v1" /></>}
          </svg>
          <span>{warning ? messages[0] : `${Math.round(plan.distanceNm).toLocaleString()} NM · TEC details`}</span>
        </summary>
        <ul id="route-summary" className="route-issues" aria-live="polite">
          {[...messages, ...tecDetails].map((message, index) => <li key={index}>{message}</li>)}
        </ul>
      </PersistentDetails>
    );
  }
  if (plan.waypoints.length < 2) return <Summary muted>{null}</Summary>;
  return (
    <Summary>
      {plan.transitions.length > 0 && (
        <>
          via <strong>{plan.transitions.map(({ ident }) => ident).join(' · ')}</strong>
          <i />
        </>
      )}
      <strong>{plan.legs.length}</strong> {plan.legs.length === 1 ? 'leg' : 'legs'}
      <i />
      <strong>{Math.round(plan.distanceNm).toLocaleString()}</strong> NM
    </Summary>
  );
}

type SummaryProps = {
  children: ReactNode;
  muted?: boolean;
};

function Summary({ children, muted = false }: SummaryProps) {
  const className = [
    'route-summary',
    muted ? 'is-muted' : '',
  ].filter(Boolean).join(' ');
  return (
    <div id="route-summary" className={className} aria-live="polite">
      {children}
    </div>
  );
}
