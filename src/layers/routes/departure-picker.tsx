import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { GeoPointFeature, NavigationData, ProcedureResourceRecord, TerminalProceduresResource } from '@zlayer/contracts';
import { departureBranches, departureExits, type RouteTerminal, type RouteDeparture } from '@zlayer/domain';
import { useProcedureResources } from './use-procedure-resources';
import { useProcedurePreview } from './use-procedure-preview';
import { usePreviewPanel } from './use-preview-panel';
import type { RouteMapPreview } from './map-preview';
import { findProcedureAirport, groupProcedures, procedureDocument, type ProcedureSelection } from '../plates/data';
import { formatDate } from '../../core/format/time';
import './approach-picker.css';

type Props = {
  ident: string;
  feature: GeoPointFeature;
  navigationData?: NavigationData | undefined;
  resource: ProcedureResourceRecord | undefined;
  routeResource?: TerminalProceduresResource | undefined;
  revision?: string | undefined;
  selected: RouteTerminal | undefined;
  onSelect: (departure: RouteTerminal | undefined) => void;
  onClose: (restoreFocus?: boolean) => void;
  onPreviewChange?: ((preview: RouteMapPreview | undefined) => void) | undefined;
  onOpenPlate?: ((selection: ProcedureSelection) => void) | undefined;
};
const NO_PREVIEW = () => {};

export function RouteDeparturePicker({ ident, feature, navigationData, resource, routeResource, revision, selected,
  onSelect, onClose, onOpenPlate, onPreviewChange = NO_PREVIEW }: Props) {
  const dialog = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const title = useId();
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string>();
  const [branchId, setBranchId] = useState<string>();
  const [exit, setExit] = useState<string>();
  const { key, routes: current, plates, retry } = useProcedureResources(resource, routeResource, revision);
  const data = current?.data;
  const airportId = feature.properties.faaId ?? ident;
  const departures = data?.procedures.filter(procedure => procedure.kind === 'departure' && procedure.airports.includes(airportId)) ?? [];
  const matches = departures.filter(procedure => `${procedure.ident} ${procedure.name}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pending = departures.find(procedure => procedure.id === pendingId);
  const selectedProcedure = selected?.effectiveDate === data?.metadata.effectiveDate
    ? departures.find(procedure => procedure.id === selected?.procedureId && selected.airportId === airportId) : undefined;
  const branches = pending ? departureBranches(pending, airportId) : [];
  const branch = branches.find(branch => branch.id === branchId);
  const exits = pending && branch ? departureExits(pending, branch) : [];
  const candidate = useMemo<RouteDeparture | undefined>(() => pending && branch && exit && exits.includes(exit) && data
    ? { kind: 'departure', source: 'nasr', airportId, procedureId: pending.id, ident: pending.ident, name: pending.name, effectiveDate: data.metadata.effectiveDate,
      branchId: branch.id, branchName: branch.name, transition: exit } : undefined,
  [pending, branch?.id, branch?.name, exit, data, airportId]);
  const inset = usePreviewPanel(true, dialog, closeButton, onClose);
  const plan = useProcedurePreview({ ident, feature, navigationData, data, revision, selection: candidate, inset,
    onChange: onPreviewChange });
  useEffect(() => { setPendingId(undefined); setBranchId(undefined); setExit(undefined); }, [key, feature.id]);
  const catalog = plates?.data?.effectiveDate === data?.metadata.effectiveDate ? plates?.data : undefined;
  const airport = catalog && findProcedureAirport(catalog, feature);
  const plateName = (name: string) => name.replace(/\([^)]*\)/g, '').trim().toUpperCase();
  const plate = airport && pending && groupProcedures(airport).find(group => group.kind === 'departure')?.procedures
    .find(procedure => plateName(procedure.name) === plateName(pending.name));
  const choose = (procedure: NonNullable<typeof pending>) => {
    setPendingId(procedure.id);
    setBranchId(procedure === selectedProcedure ? selected?.branchId : undefined);
    setExit(procedure === selectedProcedure ? selected?.transition : undefined);
  };

  return <div ref={dialog} className="route-preview-panel route-approach-picker" role="dialog" aria-labelledby={title}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
    }}>
    <header className="route-approach-heading">
      <div><span className="eyebrow">{ident}</span><h2 id={title}>{pending ? 'Choose runway and exit' : selected ? 'Change SID' : 'Choose SID'}</h2></div>
      <button ref={closeButton} type="button" className="route-approach-close" aria-label="Close SID picker" onClick={() => onClose()}>×</button>
    </header>
    <div className="route-approach-body">
      {selected && !pending && <section className="route-approach-current" aria-label="Attached SID">
        <div><small>Attached to {ident}</small><strong>{selected.name}</strong><small>{selected.branchName ?? 'Choose a runway/branch'} · {selected.transition}</small>
          {data && !selectedProcedure && <small>This selection is not in the loaded edition (saved {formatDate(selected.effectiveDate)}).</small>}</div>
        <div className="route-approach-current-actions">
          {selectedProcedure && <button type="button" onClick={() => choose(selectedProcedure)}>Change runway / exit</button>}
          <button type="button" className="route-approach-remove" onClick={() => onSelect(undefined)}>Remove SID</button>
        </div>
      </section>}
      {routeResource && revision && !data && !current?.error && <p role="status">Loading SIDs…</p>}
      {(!routeResource || !revision) && <p role="status">SID data is unavailable for this route’s data edition.</p>}
      {current?.error && <div role="alert"><p>SIDs could not be loaded. Connect to download the airport’s departures, then retry.</p>
        <button type="button" onClick={() => retry(value => value + 1)}>Retry</button></div>}
      {data && !pending && <>
        <p className="route-approach-edition">Effective {formatDate(data.metadata.effectiveDate)}</p>
        {departures.length ? <>
          <input type="search" aria-label="Filter SIDs" placeholder="Filter SIDs" value={query} onChange={event => setQuery(event.target.value)} />
          <ul aria-label={`${ident} SIDs`}>{matches.map(procedure => <li key={procedure.id}><button type="button" aria-pressed={procedure === selectedProcedure} onClick={() => choose(procedure)}>
              <span>{procedure.ident} · {procedure.name}</span>{procedure === selectedProcedure && <small>Selected</small>}
            </button></li>)}</ul>
          {!matches.length && <p role="status">No matching SIDs.</p>}
        </> : <p role="status">No SIDs published for {ident} in this edition.</p>}
      </>}
      {pending && <section className="route-approach-entry-step">
        <div className="route-approach-step-heading"><button type="button" onClick={() => setPendingId(undefined)}>‹ SIDs</button>
          {plate && airport && catalog && resource && onOpenPlate && <button type="button" onClick={() => {
            onClose(false); onOpenPlate({ airport, procedure: plate, document: procedureDocument(catalog, plate, resource.url, window.location.href),
              cycle: catalog.cycle, effectiveDate: catalog.effectiveDate, expirationDate: catalog.expirationDate });
          }}>View plate</button>}</div>
        <h3>{pending.name}</h3>
        <fieldset><legend>Select runway / branch</legend><div className="route-approach-entry-options">{branches.map(option => <label key={option.id}>
          <input type="radio" name="departure-branch" checked={branchId === option.id} onChange={() => { setBranchId(option.id); setExit(undefined); }} />
          <span>{option.name}</span>
        </label>)}</div></fieldset>
        {!branches.length && <p role="status">Published branch data is unavailable for this SID.</p>}
        {branch && <fieldset><legend>Select exit / transition</legend><div className="route-approach-entry-options">{exits.map(option => <label key={option}>
          <input type="radio" name="departure-exit" checked={exit === option} onChange={() => setExit(option)} /><span>{option}</span>
        </label>)}</div></fieldset>}
        {plan ? <>
          <p className="route-approach-legend" role="status">Preview on map · Dashed: SID waypoint route</p>
          <p className="route-approach-note">Airport connections, headings, turn paths and constraints are not depicted. Follow the plate.</p>
          {plan.issues.map((issue, index) => <p className="route-approach-note" role="status" key={index}>{issue.message}</p>)}
        </> : <p>Choose a runway / branch and exit to preview the SID on the map.</p>}
      </section>}
    </div>
    {pending && <footer className="route-approach-footer"><button className="route-approach-add" type="button" disabled={!candidate || !plan}
      onClick={() => { if (candidate && plan) onSelect(candidate); }}>{selected ? 'Replace SID' : 'Add to route'}</button></footer>}
  </div>;
}
