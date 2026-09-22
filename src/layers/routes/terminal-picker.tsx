import { useEffect, useMemo, useState } from 'react';
import { codedTerminalSelection, terminalConstraint, terminalPaths, type RouteTerminal } from '@zlayer/domain';
import { useProcedureResources } from './use-procedure-resources';
import { useProcedurePreview } from './use-procedure-preview';
import { RouteDeparturePicker } from './departure-picker';
import { ProcedurePicker, useProcedurePicker, procedurePickerPlates, procedurePlateName, NO_PREVIEW, type ProcedurePickerProps } from './procedure-picker';
import { groupProcedures } from '../plates/data';
import { formatDate } from '../../core/format/time';

type Props = ProcedurePickerProps<RouteTerminal> & { kind: 'departure' | 'arrival' };

export function RouteTerminalPicker(props: Props) {
  const { kind, ident, feature, navigationData, resource, routeResource, revision, selected,
    onSelect, onClose, onOpenPlate, onPreviewChange = NO_PREVIEW } = props;
  const label = kind === 'departure' ? 'SID' : 'STAR';
  const [query, setQuery] = useState('');
  const [procedureId, setProcedureId] = useState<string>(), [runwayId, setRunwayId] = useState<string>(), [pathId, setPathId] = useState<string>();
  const [legacy, setLegacy] = useState(false);
  const { key, routes, plates } = useProcedureResources(resource, routeResource, revision);
  const data = routes.data;
  const aliases = [ident, feature.properties.icaoId, feature.properties.faaId];
  const procedures = data?.codedProcedures?.procedures.filter(p => p.kind === kind && aliases.includes(p.airport)) ?? [];
  const pending = procedures.find(p => p.id === procedureId);
  const name = (ident: string) => data?.procedures.find(p => p.kind === kind && p.ident === ident)?.name ?? ident;
  const matches = procedures.filter(p => `${p.ident} ${name(p.ident)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const paths = useMemo(() => pending ? terminalPaths(pending) : [], [pending]);
  const runways = [...new Map(paths.map(path => [path.runwayId, path])).values()];
  const transitions = paths.filter(path => path.runwayId === runwayId);
  const path = transitions.find(path => path.id === pathId);
  const candidate = pending && path && data ? codedTerminalSelection(pending, path, data.metadata.effectiveDate, name(pending.ident)) : undefined;
  const showLegacy = kind === 'departure' && (legacy || !!data && !data.codedProcedures);
  const panel = useProcedurePicker(onClose, !showLegacy);
  const plan = useProcedurePreview({ ident, feature, navigationData, data, revision, selection: candidate, inset: panel.inset,
    onChange: onPreviewChange, enabled: !showLegacy });
  useEffect(() => { setProcedureId(undefined); setRunwayId(undefined); setPathId(undefined); setLegacy(false); }, [key, feature.id, kind]);
  const catalog = plates.data?.effectiveDate === data?.metadata.effectiveDate ? plates.data : undefined;
  const { airport, openPlate } = procedurePickerPlates(catalog, feature, resource, onClose, onOpenPlate);
  const charts = airport && groupProcedures(airport).find(group => group.kind === kind)?.procedures || [];
  const plate = pending && charts.find(p => procedurePlateName(p.name) === procedurePlateName(name(pending.ident)));
  const choose = (id: string) => {
    setProcedureId(id);
    const saved = selected?.procedureId === id && selected.effectiveDate === data?.metadata.effectiveDate
      ? terminalPaths(procedures.find(p => p.id === id)!).find(p => p.id === selected.branchId) : undefined;
    setRunwayId(saved?.runwayId); setPathId(saved?.id);
  };
  const legacyAvailable = kind === 'departure' && data?.procedures.some(p => p.kind === kind && p.airports.some(id => aliases.includes(id)));
  // Old editions remain usable. A user must explicitly choose filing topology
  // when the newer edition also provides coded paths.
  if (showLegacy) return <RouteDeparturePicker {...props} />;
  return <ProcedurePicker panel={panel} ident={ident} label={label} onClose={onClose}
    title={pending ? `Choose runway and ${kind === 'departure' ? 'exit' : 'entry'}` : `${selected ? 'Change' : 'Choose'} ${label}`}>
    <div className="route-approach-body">
      {selected && !pending && <section className="route-approach-current" aria-label={`Attached ${label}`}>
        <div><small>Attached to {ident}</small><strong>{selected.name}</strong><small>{selected.branchName} · {selected.transition || 'Vectors'}</small>
          {data && selected.effectiveDate !== data.metadata.effectiveDate && <small>This selection belongs to a different data edition.</small>}</div>
        <div className="route-approach-current-actions">
          {procedures.some(p => p.id === selected.procedureId) && <button className="ui-button" type="button" onClick={() => choose(selected.procedureId)}>Change runway / transition</button>}
          <button type="button" className="ui-button ui-button--danger" onClick={() => onSelect(undefined)}>Remove {label}</button>
        </div></section>}
      {routes.loading && <p role="status">Loading {label}s…</p>}
      {(!routeResource || !revision) && <p role="status">{label} data is unavailable for this route’s data edition.</p>}
      {routes.error && <div role="alert"><p>{label}s could not be loaded.</p><button className="ui-button" type="button" onClick={routes.retry}>Retry</button></div>}
      {data && !pending && <>
        <p className="route-approach-edition">Effective {formatDate(data.metadata.effectiveDate)}</p>
        <input className="ui-input" type="search" aria-label={`Filter ${label}s`} placeholder={`Filter ${label}s`} value={query} onChange={e => setQuery(e.target.value)} />
        <ul aria-label={`${ident} ${label}s`}>{matches.map(p => <li key={p.id}><button className="ui-button" type="button" onClick={() => choose(p.id)} aria-pressed={p.id === selected?.procedureId}>
          <span>{p.ident} · {name(p.ident)}</span></button></li>)}</ul>
        {!matches.length && <p role="status">{procedures.length ? `No matching ${label}s.` : `Coded ${label} paths are unavailable for this airport in this edition.`}</p>}
        {legacyAvailable && <button className="ui-button" type="button" onClick={() => setLegacy(true)}>Browse filing route previews</button>}
        {charts.length > 0 && openPlate && <details><summary>Published {label} plates</summary><ul>{charts.map(p => <li key={p.id}>
          <button className="ui-button" type="button" onClick={() => openPlate(p)}>{p.name}</button></li>)}</ul></details>}
      </>}
      {pending && <section className="route-approach-entry-step">
        <div className="route-approach-step-heading"><button className="ui-button" type="button" onClick={() => setProcedureId(undefined)}>‹ {label}s</button>
          {plate && openPlate && <button className="ui-button" type="button" onClick={() => openPlate(plate)}>View plate</button>}</div>
        <h3>{name(pending.ident)}</h3>
        <fieldset><legend>Select runway / branch</legend><div className="route-approach-entry-options">{runways.map(p => <label key={p.runwayId}>
          <input type="radio" name="terminal-runway" checked={runwayId === p.runwayId} onChange={() => { setRunwayId(p.runwayId); setPathId(undefined); }} />
          <span>{p.runway === 'ALL' ? 'All runways' : p.runway.replace(/^RW/, 'Runway ')}
            {runways.filter(r => r.runway === p.runway).length > 1 ? ` · ${p.branches.join(' / ')}` : ''}</span></label>)}</div></fieldset>
        {runwayId && <fieldset><legend>Select {kind === 'departure' ? 'exit' : 'entry'} / transition</legend><div className="route-approach-entry-options">{transitions.map(p => <label key={p.id}>
          <input type="radio" name="terminal-transition" checked={pathId === p.id} onChange={() => setPathId(p.id)} /><span>{p.transitionName}</span></label>)}</div></fieldset>}
        {plan ? <>
          <p className="route-approach-legend" role="status">Preview on map · {label} path and transitions</p>
          <p className="route-approach-note">Heading, climb and holding paths are schematic. Vectors remain open. Follow the plate for restrictions.</p>
          {plan.issues.map((issue, i) => <p className="route-approach-note" role="status" key={i}>{issue.message}</p>)}
          <details><summary>Published restrictions</summary><ul>{path?.legs.map((leg, i) => {
            const constraint = terminalConstraint(leg); return constraint ? <li key={i}>{leg.fix?.ident ?? leg.path}: {constraint}</li> : null;
          })}</ul></details>
        </> : <p>Choose a runway / branch and transition to preview the {label} on the map.</p>}
        {!paths.length && <p role="status">The published branches cannot be joined into an unambiguous path. View the plate.</p>}
      </section>}
    </div>
    {pending && <footer className="route-approach-footer"><button className="ui-button route-approach-add" type="button" disabled={!candidate || !plan}
      onClick={() => { if (candidate && plan) onSelect(candidate); }}>{selected ? `Replace ${label}` : 'Add to route'}</button></footer>}
  </ProcedurePicker>;
}
