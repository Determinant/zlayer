import { useEffect, useMemo, type ReactNode } from 'react';
import { PersistentDetails } from '../../core/ui/persistent-details';
import { formatDate, formatDateRange } from '../../core/format/time';
import type { AirwayDataResponse, CatalogResponse, NavigationData, TerminalProceduresData } from '@zlayer/contracts';
import { airportRouteIdent, type RouteAirportPair } from '@zlayer/domain';
import type { RouteDraft } from './draft';
import { createRecommendationModel, recommendationGeometryKey, type RouteSuggestion } from './suggestions';
import type { RoutePreviewInset, RoutePreview, RouteMapPreview } from './map-preview';
import { useSuggestions } from './use-suggestions';
import { routeConditions } from './conditions';
import { usePersistentState } from '../../core/ui/use-persistent-state';
import { isString } from '../../core/storage/ui-state';
import { isRecord } from '@zlayer/contracts';

export function RecommendationResults({ catalog, pair, navigation, airways, terminal, inset, onPreviewChange,
  onPreviewInteraction, onUseRoute, preserveView = false }: {
  catalog: CatalogResponse; pair: RouteAirportPair; navigation: NavigationData; airways: AirwayDataResponse | undefined;
  terminal?: TerminalProceduresData | undefined;
  inset: RoutePreviewInset; onPreviewChange: (preview: RouteMapPreview | undefined) => void;
  onPreviewInteraction: () => void;
  onUseRoute: (draft: RouteDraft) => void;
  preserveView?: boolean;
}) {
  const [engine, setEngine] = usePersistentState('recommendation-engine', '', isString);
  const { history, preferred } = useSuggestions(catalog, pair, engine);
  const model = useMemo(() => createRecommendationModel(history.data, preferred.data, pair, navigation, airways, terminal),
    [history.data, preferred.data, pair, navigation, airways, terminal]);
  const scope = JSON.stringify([airportRouteIdent(pair.origin), airportRouteIdent(pair.destination), catalog.revision,
    catalog.routeHistory?.url, catalog.preferredRoutes?.url, engine]);
  const [selection, setSelection] = usePersistentState<{ scope: string; id: string } | null>('recommendation-selection', null,
    (value): value is { scope: string; id: string } | null => value === null ||
      (isRecord(value) && typeof value.scope === 'string' && typeof value.id === 'string'));
  const preview = useMemo(() => model.preview(selection?.scope === scope ? selection.id : undefined), [model, selection, scope]);
  useEffect(() => {
    onPreviewChange(preview.routes.length ? { ...preview, inset, preserveView } : undefined);
  }, [preview, inset, onPreviewChange, preserveView]);
  useEffect(() => () => onPreviewChange(undefined), [onPreviewChange]);
  const common = { model, preview, onPreview: (id: string) => { onPreviewInteraction(); setSelection({ scope, id }); }, onUseRoute };
  const engines = [...new Set(['Piston', 'Turboprop', 'Jet', 'Unknown', ...history.data?.engines ?? []])];
  return <>
    <p className="route-preview-legend" role="status"><i />Selected <i className="is-alternative" />Alternatives
      <span>{preview.routes.length ? `${preview.routes.length} on map · select a row to compare` : 'No mapped alternatives yet'}</span></p>
    <RecommendationSection key={`frequency:${scope}`} id="frequency" title="Frequency" rows={model.groups.frequency} {...common}
      error={history.error} loading={!!catalog.routeHistory && !history.data} onRetry={history.retry}
      empty={catalog.routeHistory ? 'No filed routes for this pair and aircraft selection.' : 'No route history in this chart pack.'}
      controls={<label className="route-history-filter"><span className="route-recommend-hint">Aircraft</span>
        <select aria-label="Aircraft" value={engine} onChange={event => { onPreviewInteraction(); setEngine(event.target.value); }}>
          <option value="">All aircraft</option>{engines.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>}
      source={catalog.routeHistory && <>
        <a href={catalog.routeHistory.source.url} target="_blank" rel="noopener noreferrer">{catalog.routeHistory.source.name}</a>
        {' · '}{formatDateRange(catalog.routeHistory.observationRange.firstSeen, catalog.routeHistory.observationRange.lastSeen)}
        <span className="route-source-note">Historical filings; ATC clearance unverified.</span>
      </>} />
    {(['preferred', 'tec'] as const).map(category => <RecommendationSection key={`${category}:${scope}`} id={category}
      title={category === 'tec' ? 'TEC' : 'Preferred'} rows={model.groups[category]} {...common}
      error={preferred.error} loading={!!catalog.preferredRoutes && !preferred.data} onRetry={preferred.retry}
      empty={catalog.preferredRoutes ? `No published ${category === 'tec' ? 'TEC' : 'preferred'} routes for this pair.` : 'No preferred/TEC data in this chart pack.'}
      source={`FAA · ${formatDate(catalog.revision)}`} />)}
  </>;
}

type Model = ReturnType<typeof createRecommendationModel>;
type SectionProps = {
  id: string; title: string; rows: RouteSuggestion[]; model: Model; preview: RoutePreview;
  source: ReactNode; controls?: ReactNode; error: string | undefined; loading: boolean; empty: string;
  onRetry: () => void; onPreview: (id: string) => void; onUseRoute: (draft: RouteDraft) => void;
};
export function RecommendationSection({ id, title, rows, model, preview, source, controls, error, loading, empty,
  onRetry, onPreview, onUseRoute }: SectionProps) {
  const [limit, setLimit] = usePersistentState(`recommendation-limit:${id}`, 5,
    (value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 5);
  return <section className="route-recommend-section" aria-labelledby={`route-${id}-title`} data-route-category={id}>
    <div className="route-section-heading"><h3 id={`route-${id}-title`}>{title}<span>{rows.length || ''}</span></h3>
      {controls ?? <span className="route-recommend-source is-inline">{source}</span>}</div>
    {controls && <div className="route-recommend-source">{source}</div>}
    {error ? <div className="route-recommend-state" role="alert"><span>{error}</span><button type="button" onClick={onRetry}>Retry {title}</button></div>
      : loading ? <p className="route-recommend-state" role="status">Loading {title.toLowerCase()} routes…</p>
      : rows.length === 0 ? <p className="route-recommend-state">{empty}</p>
      : <ul className="route-recommend-list">{rows.slice(0, limit).map(row => {
        const plan = model.planFor(row);
        // The shared resolver is authoritative about TEC codes, including ambiguity.
        const tecs = id === 'frequency' ? plan?.tecRoutes ?? [] : [];
        const conditions = tecs.length ? tecs.flatMap(({ route }) => routeConditions(route).map(([label, value]): [string, string] =>
          [tecs.length > 1 ? `${route.designator} · ${label}` : label, value])) : row.conditions;
        const key = recommendationGeometryKey(plan);
        const index = preview.routes.findIndex(route => route.key === key);
        const selected = !!key && key === preview.selectedKey;
        const unavailable = !row.draft ? 'A published waypoint is unavailable or ambiguous.'
          : !key ? 'No map · unresolved' : plan?.issues.length ? 'Partial map' : plan?.procedures.length ? 'Procedure preview' : undefined;
        return <li key={row.id} className={`route-suggestion${selected ? ' is-selected' : ''}`} data-suggestion-id={row.id}>
          <button type="button" className="route-suggestion-preview" disabled={!key} aria-pressed={selected}
            aria-label={`Preview route ${row.route}`} onClick={() => onPreview(row.id)}>
            <span className="route-suggestion-rank" title={index >= 0 ? `Map route ${index + 1}` : undefined}>{index >= 0 ? index + 1 : '·'}</span>
            <span className="route-suggestion-copy"><strong>{row.route}</strong>
              <span className="route-suggestion-meta">{row.detail}
                {tecs.length ? ' · current TEC' : ''}
                {plan && key && !plan.issues.length && !plan.procedures.length ? ` · ${Math.round(plan.distanceNm)} NM` : ''}
                {unavailable && <span className="route-suggestion-warning" title={plan?.issues.map(issue => issue.message).join('\n')}>{' · '}{unavailable}</span>}
              </span></span>
          </button>
          <button type="button" className="route-suggestion-use" aria-label={`Use route ${row.route}`} disabled={!row.draft}
            onClick={() => { if (row.draft) onUseRoute(row.draft); }}>Use</button>
          {conditions.length > 0 && <PersistentDetails storageKey={`recommendation-conditions:${row.id}`} className="route-recommend-conditions">
            <summary title="Route restrictions">{conditions.map(([, value]) => value).join(' · ')}</summary>
            <dl>{conditions.map(([label, value], index) => <div key={`${index}:${label}`}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          </PersistentDetails>}
        </li>;
      })}</ul>}
    {!error && !loading && rows.length > limit && <button type="button" className="route-recommend-more"
      onClick={() => setLimit(value => value + 5)}>Show more · {rows.length - limit} remaining</button>}
  </section>;
}
