import { pluginStorage } from './storage';
import { useId, useState, type ReactNode } from 'react';
import { PersistentDetails } from '../../core/ui/persistent-details';

import { routeEntryPins, type RouteApproach, type RouteTerminal, type RouteEntry, type RoutePlan } from '@zlayer/domain';
import type { CatalogResponse, NavigationData } from '@zlayer/contracts';

import { RouteEditor } from './editor';
import { RouteNavLog } from './navlog';
import type { RouteLoadStatus } from './use-plan';
import { RouteRecommendations } from './recommendations';
import type { RouteDraft } from './draft';
import type { RouteMapPreview } from './map-preview';
import { routeConditions } from './conditions';
import type { DirectToAction } from './direct-to';
import type { ProcedureSelection } from '../plates/data';

type RouteBarProps = {
  plan: RoutePlan;
  status: RouteLoadStatus;
  catalog: CatalogResponse;
  navigationData?: NavigationData | undefined;
  onUseRoute: (draft: RouteDraft) => void;
  onRecommendationPreview?: (preview: RouteMapPreview | undefined) => void;
  onApproachPreview?: ((preview: RouteMapPreview | undefined) => void) | undefined;
  onAppendInput: (input: string) => void;
  onInsertInput: (beforeEntryId: string, input: string) => void;
  onReplaceInput: (entryId: string, input: string) => void;
  onRemoveEntry: (entryId: string) => void;
  onMoveEntry: (fromEntryId: string, toEntryId: string) => void;
  onClear: () => void;
  onFit: () => void;
  onDirectTo?: DirectToAction | undefined;
  onApproachChange?: ((entry: RouteEntry, approach: RouteApproach | undefined) => void) | undefined;
  onArrivalChange?: ((entry: RouteEntry, arrival: RouteTerminal | undefined) => void) | undefined;
  onDepartureChange?: ((entry: RouteEntry, departure: RouteTerminal | undefined) => void) | undefined;
  onOpenPlate?: ((selection: ProcedureSelection) => void) | undefined;
};

export function RouteBar({
  plan,
  status,
  catalog,
  navigationData,
  onUseRoute,
  onRecommendationPreview,
  onApproachPreview,
  onAppendInput,
  onInsertInput,
  onReplaceInput,
  onRemoveEntry,
  onMoveEntry,
  onClear,
  onFit,
  onDirectTo,
  onApproachChange,
  onDepartureChange,
  onArrivalChange,
  onOpenPlate,
}: RouteBarProps) {
  // Mount on first opening, then retain the drawer for its closing animation.
  const [navlogOpen, setNavlogOpen] = useState<boolean>();
  const navlogId = useId();
  const toggleNavlog = () => setNavlogOpen(open => !open);
  return (
    <section className="route-bar" aria-label="Flight route planner">
      <RouteEditor
        plan={plan}
        navigationData={navigationData}
        status={status}
        navlogOpen={navlogOpen === true}
        navlogId={navlogId}
        onToggleNavlog={toggleNavlog}
        onUseRoute={onUseRoute}
        onAppendInput={onAppendInput}
        onInsertInput={onInsertInput}
        onReplaceInput={onReplaceInput}
        onRemoveEntry={onRemoveEntry}
        onMoveEntry={onMoveEntry}
        onClear={onClear}
        onFit={onFit}
        onDirectTo={onDirectTo}
        approachResource={catalog.procedures}
        approachRouteResource={catalog.terminalProcedures}
        revision={catalog.revision}
        onApproachChange={onApproachChange}
        onDepartureChange={onDepartureChange}
        onArrivalChange={onArrivalChange}
        onApproachPreview={onApproachPreview}
        onOpenPlate={onOpenPlate}
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
      {navlogOpen !== undefined && <RouteNavLog id={navlogId} open={navlogOpen} onToggle={toggleNavlog}
        plan={plan} status={status} revision={catalog.revision} />}
    </section>
  );
}

function RouteSummary({ plan, status }: Pick<RouteBarProps, 'plan' | 'status'>) {
  if (status === 'loading') return <Summary muted>Loading FAA index…</Summary>;
  const messages = plan.issues.map(issue => issue.message);
  if (plan.procedures.length) messages.push('SID/STAR planning preview: paths and restrictions depend on the available procedure data. Consult the plates.');
  if (status === 'error') messages.unshift('Route data unavailable. Connect to download the FAA index.');
  if (status === 'partial') messages.unshift('Some route data is unavailable; the route may be incomplete.');
  const tecDetails = plan.tecRoutes.flatMap(({ route }) => [
    `${route.designator}: ${route.route}`,
    ...routeConditions(route).map(([label, value]) => `${label}: ${value}`),
    'Published TEC definition; eligibility and ATC clearance are not verified.',
  ]);
  const approachDetails = plan.approachDepictions?.length
    ? ['Holds, procedure turns, intercepts and altitude-dependent paths are schematic. They contribute terrain coverage but are excluded from route distance. Entry types use the planned arrival course; “ENTRY ?” needs an incoming leg. Follow the plate for timing, altitudes and turns.'] : [];
  const connectionDetails = plan.planningConnections?.length
    ? ['Dotted lines connect known waypoints across gaps for map and terrain planning. Route distance uses resolved legs.'] : [];
  if (messages.length > 0 || tecDetails.length > 0 || approachDetails.length > 0 || connectionDetails.length > 0) {
    const warning = messages.length > 0;
    return (
      <PersistentDetails storage={pluginStorage} storageKey="route-summary-open" className={`route-summary${warning ? ' is-error' : ''}${approachDetails.length ? ' has-approach-details' : ''}`}>
        <summary aria-label={warning ? `Route issues (${messages.length}): ${messages[0]}` : approachDetails.length ? 'Approach map details' : tecDetails.length ? 'TEC route details and published conditions' : 'Route map details'}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {warning ? <path d="M12 3 2 21h20Z M12 9v5 M12 17v1" />
              : <><circle cx="12" cy="12" r="9" /><path d="M12 11v6 M12 7v1" /></>}
          </svg>
          <span>{warning ? messages[0] : `${Math.round(plan.distanceNm).toLocaleString()} NM · ${approachDetails.length ? 'Approach' : tecDetails.length ? 'TEC' : 'Route'} details`}</span>
        </summary>
        <ul id="route-summary" className="route-issues" aria-live="polite">
          {[...messages, ...tecDetails, ...approachDetails, ...connectionDetails].map((message, index) => <li key={index}>{message}</li>)}
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
