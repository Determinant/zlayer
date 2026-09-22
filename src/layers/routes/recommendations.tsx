import { pluginStorage } from './storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AirwayDataResponse, CatalogResponse, NavigationData, TerminalProceduresData } from '@zlayer/contracts';
import { airportRouteIdent, preferredRouteAirports,
  type RouteFeaturePins } from '@zlayer/domain';
import { loadRouteResources, routeResourceKey } from './resources';
import type { RouteDraft } from './draft';
import { RecommendationResults } from './recommendation-results';
import type { RouteMapPreview } from './map-preview';
import { usePreviewPanel } from './use-preview-panel';
import { useOnline } from '../../core/use-online';
import { usePluginState } from '../../core/ui/use-persistent-state';
import { isBoolean } from '../../core/storage/ui-state';

const HINT = 'Enter at least two airports: departure first and destination last. Intermediate waypoints do not affect recommendations.';
type Loaded = { key: string; navigation: NavigationData; airways: AirwayDataResponse | undefined;
  terminal: TerminalProceduresData | undefined; partial: boolean };
const NO_PREVIEW = () => {};

export function RouteRecommendations({ catalog, tokens, pins, onUseRoute, onPreviewChange = NO_PREVIEW }: {
  catalog: CatalogResponse;
  tokens: readonly string[];
  pins: RouteFeaturePins;
  onUseRoute: (draft: RouteDraft) => void;
  onPreviewChange?: (preview: RouteMapPreview | undefined) => void;
}) {
  const [open, setOpen] = usePluginState(pluginStorage, 'recommendations-open', false, isBoolean);
  const [preserveRestoredView, setPreserveRestoredView] = useState(open);
  // Results can unmount while the route is edited; a new airport pair is no longer a restored preview.
  const restoredEndpoints = useRef([tokens[0], tokens.at(-1)]);
  const sameEndpoints = tokens[0] === restoredEndpoints.current[0] && tokens.at(-1) === restoredEndpoints.current[1];
  const [loaded, setLoaded] = useState<Loaded>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [attempt, setAttempt] = useState(0);
  const online = useOnline();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const inset = usePreviewPanel(open, panel, closeButton, restoreFocus => {
    setOpen(false); if (restoreFocus) button.current?.focus();
  }, button);
  const airports = catalog.navigation.find(layer => layer.id === 'airports');
  const key = routeResourceKey(catalog, 'recommendations');
  const canLoad = tokens.length >= 2;
  const data = loaded?.key === key ? loaded : undefined;
  const error = failure?.key === key ? failure.message : undefined;
  const pair = useMemo(() => data ? preferredRouteAirports(tokens, data.navigation.airports?.features ?? [], pins) : undefined,
    [data, canLoad, tokens[0], tokens.at(-1), pins[0], pins[tokens.length - 1]]);
  const useRoute = (draft: RouteDraft) => { onUseRoute(draft); setOpen(false); button.current?.focus(); };

  useEffect(() => { if (!sameEndpoints) setPreserveRestoredView(false); }, [sameEndpoints]);

  useEffect(() => {
    if (!open || !canLoad || !airports) return;
    let cancelled = false;
    setFailure(undefined);
    // Both recommendation sources need the same resolved airport pair.
    void loadRouteResources(catalog, 'recommendations').then(({ data, unavailable, airways, terminal, failed }) => {
      if (unavailable.includes('airports')) throw new Error('Airport data unavailable');
      if (!cancelled) setLoaded({ key, airways, terminal, partial: failed, navigation: data });
    }).catch(reason => {
      if (!cancelled) setFailure({ key, message: reason instanceof Error ? reason.message : 'Route data unavailable' });
    });
    return () => { cancelled = true; };
  }, [open, canLoad, airports, catalog.navigation, catalog.airways, catalog.terminalProcedures, catalog.revision, key, attempt, online]);


  return <>
    <span id="route-recommend-hint" className="route-recommend-hint">{HINT}</span>
    <button ref={button} type="button" className="route-recommend" title={HINT}
      aria-describedby="route-recommend-hint"
      aria-expanded={open} aria-controls={open ? 'route-recommendations' : undefined}
      aria-haspopup="dialog" onClick={() => { setPreserveRestoredView(false); setOpen(value => !value); }}>Advise</button>
    {open && <div ref={panel} id="route-recommendations" className="route-preview-panel route-recommendations"
      role="dialog" aria-labelledby="route-recommendations-title" aria-describedby="route-recommendations-hint">
      <header className="route-recommend-header">
        <div><span className="route-recommend-caption">Route recommendations</span>
          <h2 id="route-recommendations-title">{pair ? `${airportRouteIdent(pair.origin)} → ${airportRouteIdent(pair.destination)}` : 'Choose airports'}</h2></div>
        <button ref={closeButton} type="button" className="route-recommend-close" aria-label="Close recommendations"
          onClick={() => { setOpen(false); button.current?.focus(); }}>×</button>
      </header>
      <div className="route-recommend-body">
      <p id="route-recommendations-hint" className={pair ? 'route-recommend-hint' : undefined}>{HINT}</p>
      {!canLoad ? <p role="status">For example, enter <strong>KSBA KSMO</strong> in the route box.</p>
        : !airports ? <p role="status">Airport data is unavailable for this cycle. Reload feeds online to retry.</p>
        : error ? <div role="alert"><p>Could not load recommendations. Connect to download the data, or retry your saved copy.</p>
          <p className="route-recommend-error">{error}</p>
          <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>
        : !data ? <p role="status">Loading FAA navigation data…</p>
        : !pair ? <p role="status">The first and last entries must be airport identifiers, such as KSBA and KSMO.</p>
        : <>
          <RecommendationResults catalog={catalog} pair={pair} navigation={data.navigation} airways={data.airways}
            terminal={data.terminal}
            preserveView={preserveRestoredView && sameEndpoints} onPreviewInteraction={() => setPreserveRestoredView(false)}
            inset={inset} onPreviewChange={onPreviewChange} onUseRoute={useRoute} />
          {data.partial && <div role="status"><p>Some navigation data is unavailable. Route details may be incomplete.</p>
            <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry navigation</button></div>}
        </>}
      </div>
    </div>}
  </>;
}
