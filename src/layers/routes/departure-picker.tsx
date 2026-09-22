import { useEffect, useMemo, useState } from 'react';
import { departureBranches, departureExits, type RouteTerminal, type RouteDeparture } from '@zlayer/domain';
import { useProcedureResources } from './use-procedure-resources';
import { useProcedurePreview } from './use-procedure-preview';
import { ProcedurePicker, useProcedurePicker, procedurePickerPlates, procedurePlateName, NO_PREVIEW, type ProcedurePickerProps } from './procedure-picker';
import { groupProcedures } from '../plates/data';
import { formatDate } from '../../core/format/time';

type Props = ProcedurePickerProps<RouteTerminal>;

export function RouteDeparturePicker({ ident, feature, navigationData, resource, routeResource, revision, selected,
  onSelect, onClose, onOpenPlate, onPreviewChange = NO_PREVIEW }: Props) {
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string>();
  const [branchId, setBranchId] = useState<string>();
  const [exit, setExit] = useState<string>();
  const { key, routes, plates } = useProcedureResources(resource, routeResource, revision);
  const data = routes.data;
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
  const panel = useProcedurePicker(onClose);
  const plan = useProcedurePreview({ ident, feature, navigationData, data, revision, selection: candidate, inset: panel.inset,
    onChange: onPreviewChange });
  useEffect(() => { setPendingId(undefined); setBranchId(undefined); setExit(undefined); }, [key, feature.id]);
  const catalog = plates.data?.effectiveDate === data?.metadata.effectiveDate ? plates.data : undefined;
  const { airport, openPlate } = procedurePickerPlates(catalog, feature, resource, onClose, onOpenPlate);
  const plate = airport && pending && groupProcedures(airport).find(group => group.kind === 'departure')?.procedures
    .find(procedure => procedurePlateName(procedure.name) === procedurePlateName(pending.name));
  const choose = (procedure: NonNullable<typeof pending>) => {
    setPendingId(procedure.id);
    setBranchId(procedure === selectedProcedure ? selected?.branchId : undefined);
    setExit(procedure === selectedProcedure ? selected?.transition : undefined);
  };

  return <ProcedurePicker panel={panel} ident={ident} label="SID" onClose={onClose}
    title={pending ? 'Choose runway and exit' : selected ? 'Change SID' : 'Choose SID'}>
    <div className="route-approach-body">
      {selected && !pending && <section className="route-approach-current" aria-label="Attached SID">
        <div><small>Attached to {ident}</small><strong>{selected.name}</strong><small>{selected.branchName ?? 'Choose a runway/branch'} · {selected.transition}</small>
          {data && !selectedProcedure && <small>This selection is not in the loaded edition (saved {formatDate(selected.effectiveDate)}).</small>}</div>
        <div className="route-approach-current-actions">
          {selectedProcedure && <button className="ui-button" type="button" onClick={() => choose(selectedProcedure)}>Change runway / exit</button>}
          <button type="button" className="ui-button ui-button--danger" onClick={() => onSelect(undefined)}>Remove SID</button>
        </div>
      </section>}
      {routes.loading && <p role="status">Loading SIDs…</p>}
      {(!routeResource || !revision) && <p role="status">SID data is unavailable for this route’s data edition.</p>}
      {routes.error && <div role="alert"><p>SIDs could not be loaded. Connect to download the airport’s departures, then retry.</p>
        <button className="ui-button" type="button" onClick={routes.retry}>Retry</button></div>}
      {data && !pending && <>
        <p className="route-approach-edition">Effective {formatDate(data.metadata.effectiveDate)}</p>
        {departures.length ? <>
          <input className="ui-input" type="search" aria-label="Filter SIDs" placeholder="Filter SIDs" value={query} onChange={event => setQuery(event.target.value)} />
          <ul aria-label={`${ident} SIDs`}>{matches.map(procedure => <li key={procedure.id}><button className="ui-button" type="button" aria-pressed={procedure === selectedProcedure} onClick={() => choose(procedure)}>
              <span>{procedure.ident} · {procedure.name}</span>{procedure === selectedProcedure && <small>Selected</small>}
            </button></li>)}</ul>
          {!matches.length && <p role="status">No matching SIDs.</p>}
        </> : <p role="status">No SIDs published for {ident} in this edition.</p>}
      </>}
      {pending && <section className="route-approach-entry-step">
        <div className="route-approach-step-heading"><button className="ui-button" type="button" onClick={() => setPendingId(undefined)}>‹ SIDs</button>
          {plate && openPlate && <button className="ui-button" type="button" onClick={() => openPlate(plate)}>View plate</button>}</div>
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
    {pending && <footer className="route-approach-footer"><button className="ui-button route-approach-add" type="button" disabled={!candidate || !plan}
      onClick={() => { if (candidate && plan) onSelect(candidate); }}>{selected ? 'Replace SID' : 'Add to route'}</button></footer>}
  </ProcedurePicker>;
}
