import { useEffect, useMemo, useState } from 'react';
import type { ApproachRoute, ProcedureRecord } from '@zlayer/contracts';
import { codedApproachLabel, approachEntryOptions, approachEntryLegs, terminalConstraint, approachPreview, findApproachRoutes, publishedApproachRoutes, type ApproachArrival, type RouteApproach } from '@zlayer/domain';
import { useProcedureResources } from './use-procedure-resources';
import { useProcedurePreview } from './use-procedure-preview';
import { ProcedurePicker, useProcedurePicker, procedurePickerPlates, NO_PREVIEW, type ProcedurePickerProps } from './procedure-picker';
import { groupProcedures } from '../plates/data';
import { formatDateRange } from '../../core/format/time';

type Props = ProcedurePickerProps<RouteApproach> & { arrival?: ApproachArrival | undefined };

export function RouteApproachPicker({ ident, feature, navigationData, resource, routeResource, revision, arrival, selected, onSelect, onClose,
  onOpenPlate, onPreviewChange = NO_PREVIEW }: Props) {
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string>();
  const [entryId, setEntryId] = useState<string>();
  const [branchId, setBranchId] = useState<string>();
  const { key: routeKey, routes, plates } = useProcedureResources(resource, routeResource, revision);
  const catalog = plates.data;
  const { airport, openPlate } = procedurePickerPlates(catalog, feature, resource, onClose, onOpenPlate);
  const routeData = routes.data?.approaches;
  const aliases = [ident, feature.properties.icaoId, feature.properties.faaId];
  const charts = airport ? groupProcedures(airport).find(group => group.kind === 'approach')?.procedures ?? [] : [];
  const chartRoutes = (chart: ProcedureRecord) => resource?.associationStatus !== undefined
    ? publishedApproachRoutes(routeData, catalog?.associations, chart.id, routeResource?.jsonSha256)
    : findApproachRoutes(routeData, airport?.icaoId ?? airport?.faaId ?? '', chart.name);
  const covered = new Set(catalog?.effectiveDate === routeData?.metadata.effectiveDate ? charts.flatMap(chart =>
    chartRoutes(chart).map(p => p.id)) : []);
  type Option = { id: string; name: string; plate?: ProcedureRecord; route?: ApproachRoute };
  const approaches: Option[] = [
    ...charts.map(plate => ({ id: plate.id, name: plate.name, plate })),
    ...(routeData?.procedures.filter(p => aliases.includes(p.airport) && (!covered.has(p.id) ||
      pendingId === `cifp:${p.id}` || selected?.source === 'cifp' && selected.entry?.routeId === p.id)) ?? [])
      .map(route => ({ id: `cifp:${route.id}`, name: codedApproachLabel(route.ident), route })),
  ];
  const matches = approaches.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedProcedure = approaches.find(p => p.id === selected?.procedureId && (selected.source === 'cifp'
    ? selected.entry?.effectiveDate === routeData?.metadata.effectiveDate && p.route?.airport === selected.airportId
    : selected.cycle === catalog?.cycle && airport?.id === selected.airportId));
  const pending = approaches.find(p => p.id === pendingId);
  const procedures = pending?.route ? [pending.route] : pending && routeData?.metadata.effectiveDate === catalog?.effectiveDate
    ? pending.plate ? chartRoutes(pending.plate) : [] : [];
  const procedure = procedures.length === 1 ? procedures[0] : procedures.find(p => p.id === branchId);
  const services = [...new Set(procedure?.final.flatMap(l => l.continuations?.flatMap(c => c.services?.filter(s => s.authorization === 'A' && s.name).map(s => s.name) ?? []) ?? []) ?? [])];
  const entries = procedure ? approachEntryOptions(procedure) : [];
  const entry = entries.find(option => option.id === entryId);
  const preview = useMemo(() => procedure && entryId ? approachPreview(procedure, entryId) : undefined, [procedure, entryId]);
  const panel = useProcedurePicker(onClose);
  const candidate = useMemo<RouteApproach | undefined>(() => entry && procedure && pending && routeData && (pending.route || catalog && airport)
    ? { airportId: pending.route ? procedure.airport : airport!.id, procedureId: pending.id, name: pending.name, cycle: catalog?.cycle ?? routeData.metadata.effectiveDate,
      kind: 'approach', source: pending.route ? 'cifp' : 'chart',
      entry: { routeId: procedure.id, transitionId: entry.id,
        name: procedures.length > 1 ? `${entry.name} · RWY ${procedure.ident.slice(1)}` : entry.name,
        effectiveDate: routeData.metadata.effectiveDate } }
    : undefined, [procedure, procedures.length, pending, catalog, airport, routeData, entry?.id, entry?.name]);
  useProcedurePreview({ ident, feature, navigationData, data: routes.data, revision,
    selection: candidate, inset: panel.inset, onChange: onPreviewChange, arrival });
  useEffect(() => { setPendingId(undefined); setEntryId(undefined); setBranchId(undefined); }, [routeKey, feature.id]);
  return <ProcedurePicker panel={panel} ident={ident} label="approach" onClose={onClose}
    title={pending ? 'Choose entry' : selected ? 'Change approach' : 'Choose approach'}>
    <div className="route-approach-body">
      {selected && !pending && <section className="route-approach-current" aria-label="Attached approach">
        <div><small>Attached to {ident}</small><strong>{selected.name}</strong>
          {selected.entry && <small>Entry: {selected.entry.name}</small>}
          {catalog && !selectedProcedure && <small>This selection is not in the loaded edition (saved cycle {selected.cycle}).</small>}</div>
        <div className="route-approach-current-actions">
          {selectedProcedure && <button className="ui-button" type="button" onClick={() => {
            setPendingId(selectedProcedure.id); setEntryId(selected.entry?.transitionId); setBranchId(selected.entry?.routeId);
          }}>Change entry</button>}
          {selectedProcedure?.plate && openPlate && <button className="ui-button" type="button" onClick={() => openPlate(selectedProcedure.plate!)}>View plate</button>}
          <button type="button" className="ui-button ui-button--danger" onClick={() => onSelect(undefined)}>Remove approach</button>
        </div>
      </section>}
      {plates.loading && <p role="status">Loading approach plates…</p>}
      {!resource && <p role="status">Approach plates are unavailable for this route’s data edition.</p>}
      {routes.loading && !pending && <p role="status">Loading approach routes…</p>}
      {plates.error && <div role="alert"><p>Approach plates could not be loaded. Connect to download the airport’s plate list, then retry.</p><button className="ui-button" type="button" onClick={plates.retry}>Retry</button></div>}
      {routes.error && !pending && <div role="alert"><p>Approach routes could not be loaded.</p>
        <button className="ui-button" type="button" onClick={routes.retry}>Retry routes</button></div>}
      {(catalog || routeData) && !pending && <>
        <p className="route-approach-edition">Effective {catalog ? formatDateRange(catalog.effectiveDate, catalog.expirationDate) : routeData?.metadata.effectiveDate}</p>
        {approaches.length > 0 ? <>
          <input className="ui-input" type="search" aria-label="Filter approaches" placeholder="Filter approaches" value={query}
            onChange={event => setQuery(event.target.value)} />
          <ul aria-label={`${ident} approaches`}>
            {matches.map(procedure => <li key={procedure.id}>
              <button className="ui-button" type="button" aria-pressed={procedure === selectedProcedure} onClick={() => {
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
        <div className="route-approach-step-heading"><button className="ui-button" type="button" onClick={() => setPendingId(undefined)}>‹ Approaches</button>
          {pending.plate && openPlate && <button className="ui-button" type="button" onClick={() => openPlate(pending.plate!)}>View plate</button>}</div>
        <h3>{pending.name}</h3>
        {services.length > 0 && <p>Published services: {services.join(", ")}</p>}
        {procedures.length > 1 && <fieldset><legend>Select runway</legend>
          <div className="route-approach-entry-options">{procedures.map(branch => <label key={branch.id}>
            <input type="radio" name="approach-runway" value={branch.id} checked={branchId === branch.id}
              onChange={() => { setBranchId(branch.id); setEntryId(undefined); }} />
            <span>Runway {branch.ident.slice(1)}</span>
          </label>)}</div>
        </fieldset>}
        {routes.loading ? <p role="status">Loading published entries…</p>
          : routes.error ? <div role="alert"><p>Published entries could not be loaded.</p><button className="ui-button" type="button" onClick={routes.retry}>Retry entries</button></div>
          : procedures.length > 1 && !procedure ? <p role="status">Choose a runway to see its published entries.</p>
          : !procedure || !entries.length ? <p role="status">{!routeData
            ? 'This navigation edition does not include approach routes. Refresh the navigation download to check for an updated edition.'
            : 'No matching procedure path is available in this navigation edition. The plate remains available.'}</p>
          : <>
            <fieldset><legend>Select a published entry or vectors to final</legend>
              <div className="route-approach-entry-options">{entries.map(option => <label key={option.id}>
                <input type="radio" name="approach-entry" value={option.id} checked={entryId === option.id} onChange={() => setEntryId(option.id)} />
                <span>{option.kind === 'vectors' ? 'Vectors to final (VTF)' : option.name}</span>
              </label>)}</div>
            </fieldset>
            {preview ? <>
              <p className="route-approach-legend" role="status">Preview on map · Magenta: approach · Dashed: missed approach{preview.extension ? ' · Light: extended final' : ''}</p>
              {preview.depictions.length > 0 && <p className="route-approach-note">Holds, procedure turns, heading intercepts and altitude-dependent paths are schematic. They contribute terrain coverage but are excluded from route distance. Entry types use the planned arrival course; “ENTRY ?” needs an incoming leg. Follow the plate for timing, altitudes and turns.</p>}
              <details><summary>Published restrictions</summary><ul>{(approachEntryLegs(procedure, entryId!) ?? []).map((leg, i) => {
                const constraint = terminalConstraint(leg); return constraint ? <li key={i}>{leg.fix?.ident ?? leg.path}: {constraint}</li> : null;
              })}</ul></details>
              {preview.incomplete && <p className="route-approach-note" role="status">{[...new Set(preview.issues.map(i => i.message))].join(' ')} Refer to the plate.</p>}
            </> : <p>Choose an entry to preview it on the map.</p>}
          </>}
      </section>}
    </div>
    {pending && procedure && entries.length > 0 && <footer className="route-approach-footer">
      <button className="ui-button route-approach-add" type="button" disabled={!candidate || !preview}
        onClick={() => { if (candidate && preview) onSelect(candidate); }}>{selected ? 'Replace approach' : 'Add to route'}</button>
    </footer>}
  </ProcedurePicker>;
}
