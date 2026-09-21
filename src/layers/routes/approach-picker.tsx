import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { GeoPointFeature, NavigationData, ProcedureCatalog, ProcedureResourceRecord, TerminalProceduresData, TerminalProceduresResource } from '@zlayer/contracts';
import { approachEntryOptions, approachPreview, createRouteResolver, findApproachRoutes, updateApproachHoldEntries, type ApproachArrival, type RouteApproach } from '@zlayer/domain';
import { fetchTerminalProcedures } from './api';
import type { RouteMapPreview } from './map-preview';
import { usePreviewPanel } from './use-preview-panel';
import { fetchProcedureCatalog } from '../plates/api';
import { findProcedureAirport, groupProcedures, procedureDocument, type ProcedureSelection } from '../plates/data';
import { formatDateRange } from '../../core/format/time';
import './approach-picker.css';

type Props = {
  ident: string;
  feature: GeoPointFeature;
  navigationData?: NavigationData | undefined;
  resource: ProcedureResourceRecord | undefined;
  routeResource?: TerminalProceduresResource | undefined;
  revision?: string | undefined;
  arrival?: ApproachArrival | undefined;
  selected: RouteApproach | undefined;
  onSelect: (approach: RouteApproach | undefined) => void;
  onClose: (restoreFocus?: boolean) => void;
  onPreviewChange?: ((preview: RouteMapPreview | undefined) => void) | undefined;
  onOpenPlate?: ((selection: ProcedureSelection) => void) | undefined;
};

const NO_PREVIEW = () => {};

export function RouteApproachPicker({ ident, feature, navigationData, resource, routeResource, revision, arrival, selected, onSelect, onClose,
  onOpenPlate, onPreviewChange = NO_PREVIEW }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const title = useId();
  const [query, setQuery] = useState('');
  const [attempt, retry] = useState(0);
  const [pendingId, setPendingId] = useState<string>();
  const [entryId, setEntryId] = useState<string>();
  const [branchId, setBranchId] = useState<string>();
  const [routes, setRoutes] = useState<{ key: string; data?: TerminalProceduresData; error?: boolean }>();
  const routeKey = JSON.stringify([revision, routeResource]);
  const currentRoutes = routes?.key === routeKey ? routes : undefined;
  const [loaded, setLoaded] = useState<{ resource: ProcedureResourceRecord; catalog?: ProcedureCatalog; error?: string }>();
  const current = loaded?.resource === resource ? loaded : undefined;
  const catalog = current?.catalog;
  const airport = catalog && findProcedureAirport(catalog, feature);
  const approaches = airport ? groupProcedures(airport).find(group => group.kind === 'approach')?.procedures ?? [] : [];
  const matches = approaches.filter(procedure => procedure.name.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedProcedure = selected?.cycle === catalog?.cycle
    ? approaches.find(procedure => procedure.id === selected?.procedureId && airport?.id === selected.airportId) : undefined;
  const pending = approaches.find(procedure => procedure.id === pendingId);
  const routeData = currentRoutes?.data?.approaches;
  const procedures = pending && routeData?.metadata.effectiveDate === catalog?.effectiveDate
    ? findApproachRoutes(routeData, airport?.icaoId ?? airport?.faaId ?? '', pending.name) : [];
  const procedure = procedures.length === 1 ? procedures[0] : procedures.find(p => p.id === branchId);
  const entries = procedure ? approachEntryOptions(procedure) : [];
  const entry = entries.find(option => option.id === entryId);
  const preview = useMemo(() => procedure && entryId ? approachPreview(procedure, entryId) : undefined, [procedure, entryId]);
  const inset = usePreviewPanel(true, dialog, closeButton, onClose);
  const candidate = useMemo<RouteApproach | undefined>(() => entry && procedure && pending && catalog && airport && routeData
    ? { airportId: airport.id, procedureId: pending.id, name: pending.name, cycle: catalog.cycle,
      entry: { routeId: procedure.id, transitionId: entry.id,
        name: procedures.length > 1 ? `${entry.name} · RWY ${procedure.ident.slice(1)}` : entry.name,
        effectiveDate: routeData.metadata.effectiveDate } }
    : undefined, [procedure, procedures.length, pending, catalog, airport, routeData, entry?.id, entry?.name]);
  // Use the same procedure expansion and map renderer as an attached approach.
  // Share navigation entities with the map in previews as well as attached approaches.
  const resolvePreview = useMemo(() => currentRoutes?.data && revision ? createRouteResolver([
    { type: 'FeatureCollection', features: [feature], meta: { layer: 'airports', revision, returned: 1, truncated: false } },
    ...Object.values(navigationData ?? {}).filter(collection => collection.meta.layer !== 'airports'),
  ], undefined, currentRoutes.data) : undefined, [feature, navigationData, currentRoutes?.data, revision]);
  const mapPreview = useMemo<RouteMapPreview | undefined>(() => {
    if (!candidate || !preview || !resolvePreview) return;
    const plan = resolvePreview({ entries: [{ id: 'approach-preview', text: ident,
      ...(feature.id ? { pinnedFeatureId: feature.id } : {}), approach: candidate }] });
    updateApproachHoldEntries(plan, arrival);
    const key = JSON.stringify(candidate);
    return { routes: [{ key, plan }], selectedKey: key, inset };
  }, [candidate, preview, resolvePreview, ident, feature.id, inset, arrival]);
  useEffect(() => { onPreviewChange(mapPreview); }, [mapPreview, onPreviewChange]);
  useEffect(() => () => onPreviewChange(undefined), [onPreviewChange]);
  const openPlate = (procedure: NonNullable<typeof pending>) => {
    if (!catalog || !airport || !resource || !onOpenPlate) return;
    const selection: ProcedureSelection = { airport, procedure,
      document: procedureDocument(catalog, procedure, resource.url, window.location.href),
      cycle: catalog.cycle, effectiveDate: catalog.effectiveDate, expirationDate: catalog.expirationDate };
    onClose(false); onOpenPlate(selection);
  };

  useEffect(() => {
    if (!resource) return;
    let active = true;
    setLoaded({ resource });
    void fetchProcedureCatalog(resource).then(catalog => {
      if (active) setLoaded({ resource, catalog });
    }, () => {
      if (active) setLoaded({ resource, error: 'Approaches could not be loaded. Connect to download the airport’s approach list, then retry.' });
    });
    return () => { active = false; };
  }, [resource, attempt]);
  useEffect(() => {
    if (!routeResource || !revision) return;
    let active = true;
    setRoutes({ key: routeKey });
    void fetchTerminalProcedures(routeResource, revision).then(data => {
      if (active) setRoutes({ key: routeKey, data });
    }, () => { if (active) setRoutes({ key: routeKey, error: true }); });
    return () => { active = false; };
  }, [routeResource, revision, routeKey, attempt]);

  return <div ref={dialog} className="route-preview-panel route-approach-picker" role="dialog" aria-labelledby={title}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      // Search/entry selection must not submit the surrounding route editor.
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
    }}>
    <header className="route-approach-heading">
      <div><span className="eyebrow">{ident}</span><h2 id={title}>{pending ? 'Choose entry' : selected ? 'Change approach' : 'Choose approach'}</h2></div>
      <button ref={closeButton} type="button" className="route-approach-close" aria-label="Close approach picker" onClick={() => onClose()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </header>
    <div className="route-approach-body">
      {selected && !pending && <section className="route-approach-current" aria-label="Attached approach">
        <div><small>Attached to {ident}</small><strong>{selected.name}</strong>
          {selected.entry && <small>Entry: {selected.entry.name}</small>}
          {catalog && !selectedProcedure && <small>This selection is not in the loaded edition (saved cycle {selected.cycle}).</small>}</div>
        <div className="route-approach-current-actions">
          {selectedProcedure && <button type="button" onClick={() => {
            setPendingId(selectedProcedure.id); setEntryId(selected.entry?.transitionId); setBranchId(selected.entry?.routeId);
          }}>Change entry</button>}
          {selectedProcedure && onOpenPlate && <button type="button" onClick={() => openPlate(selectedProcedure)}>View plate</button>}
          <button type="button" className="route-approach-remove" onClick={() => onSelect(undefined)}>Remove approach</button>
        </div>
      </section>}
      {resource && !catalog && !current?.error && <p role="status">Loading approaches…</p>}
      {!resource && <p role="status">Approach data is unavailable for this route’s data edition.</p>}
      {current?.error && <div role="alert"><p>{current.error}</p><button type="button" onClick={() => retry(value => value + 1)}>Retry</button></div>}
      {catalog && !pending && <>
        <p className="route-approach-edition">Effective {formatDateRange(catalog.effectiveDate, catalog.expirationDate)}</p>
        {approaches.length > 0 ? <>
          <input type="search" aria-label="Filter approaches" placeholder="Filter approaches" value={query}
            onChange={event => setQuery(event.target.value)} />
          <ul aria-label={`${ident} approaches`}>
            {matches.map(procedure => <li key={procedure.id}>
              <button type="button" aria-pressed={procedure === selectedProcedure} onClick={() => {
                setPendingId(procedure.id);
                setBranchId(procedure === selectedProcedure ? selected?.entry?.routeId : undefined);
                setEntryId(procedure === selectedProcedure && selected?.entry?.effectiveDate === routeData?.metadata.effectiveDate
                  ? selected?.entry?.transitionId : undefined);
              }}>
                <span>{procedure.name}</span>{procedure === selectedProcedure && <small>Selected</small>}
              </button>
            </li>)}
          </ul>
          {!matches.length && <p role="status">No matching approaches.</p>}
        </> : <p role="status">No approaches published for {ident} in this edition.</p>}
      </>}
      {pending && <section className="route-approach-entry-step">
        <div className="route-approach-step-heading"><button type="button" onClick={() => setPendingId(undefined)}>‹ Approaches</button>
          {onOpenPlate && <button type="button" onClick={() => openPlate(pending)}>View plate</button>}</div>
        <h3>{pending.name}</h3>
        {procedures.length > 1 && <fieldset><legend>Select runway</legend>
          <div className="route-approach-entry-options">{procedures.map(branch => <label key={branch.id}>
            <input type="radio" name="approach-runway" value={branch.id} checked={branchId === branch.id}
              onChange={() => { setBranchId(branch.id); setEntryId(undefined); }} />
            <span>Runway {branch.ident.slice(1)}</span>
          </label>)}</div>
        </fieldset>}
        {routeResource && !currentRoutes?.data && !currentRoutes?.error ? <p role="status">Loading published entries…</p>
          : currentRoutes?.error ? <div role="alert"><p>Published entries could not be loaded.</p><button type="button" onClick={() => retry(value => value + 1)}>Retry entries</button></div>
          : procedures.length > 1 && !procedure ? <p role="status">Choose a runway to see its published entries.</p>
          : !procedure || !entries.length ? <p role="status">Published entry data is unavailable for this approach in this edition. View the plate for the procedure.</p>
          : <>
            <fieldset><legend>Select a published entry or vectors to final</legend>
              <div className="route-approach-entry-options">{entries.map(option => <label key={option.id}>
                <input type="radio" name="approach-entry" value={option.id} checked={entryId === option.id} onChange={() => setEntryId(option.id)} />
                <span>{option.kind === 'vectors' ? 'Vectors to final (VTF)' : option.name}</span>
              </label>)}</div>
            </fieldset>
            {preview ? <>
              <p className="route-approach-legend" role="status">Preview on map · Magenta: approach · Dashed: missed approach{preview.extension ? ' · Light: extended final' : ''}</p>
              {preview.depictions.length > 0 && <p className="route-approach-note">Holds, procedure turns, heading intercepts and altitude-dependent paths are schematic and excluded from route distance and terrain. Entry types use the planned arrival course; “ENTRY ?” needs an incoming leg. Follow the plate for timing, altitudes and turns.</p>}
              {preview.incomplete && <p className="route-approach-note" role="status">{[...new Set(preview.issues.map(i => i.message))].join(' ')} Refer to the plate.</p>}
            </> : <p>Choose an entry to preview it on the map.</p>}
          </>}
      </section>}
    </div>
    {pending && procedure && entries.length > 0 && <footer className="route-approach-footer">
      <button className="route-approach-add" type="button" disabled={!candidate || !preview}
        onClick={() => { if (candidate && preview) onSelect(candidate); }}>{selected ? 'Replace approach' : 'Add to route'}</button>
    </footer>}
  </div>;
}
