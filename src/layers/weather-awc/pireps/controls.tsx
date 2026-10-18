import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { PIREP_SOURCE_MAX_AGE_MS } from '@zlayer/contracts';
import { selectLayerStore } from '../../../core/layers/store';
import { useLayerSnapshot } from '../../../core/layers/use-snapshot';
import { useEdgePanel } from '../../../core/ui/edge-panels';
import { DetailPanel } from '../../../core/ui/detail-panel';
import { formatAge, formatTimestamp } from '../../../core/format/time';
import type { WeatherController, WeatherState } from '../controller';
import { pirepAltitude, pirepConditions, selectedPireps } from './selection';
import { pirepAircraftName } from './aircraft';
import { PirepSourceEntries } from './source-entries';
import type { LocatedPirep } from './locations';

type PirepPanelState = Pick<WeatherState, 'preferences' | 'now' | 'selectedTime' | 'pireps' | 'pirepView' | 'pirepSelection' | 'pirepDisplay'>;

function usePirepState(controller: WeatherController) {
  const store = useMemo(() => selectLayerStore(controller, (state): PirepPanelState => ({
    preferences: state.preferences, now: state.now, selectedTime: state.selectedTime, pireps: state.pireps,
    pirepView: state.pirepView, pirepSelection: state.pirepSelection, pirepDisplay: state.pirepDisplay,
  })), [controller]);
  return useLayerSnapshot(store);
}

function PirepStatus({ state }: { state: PirepPanelState }) {
  const { snapshot, error, loading, restored } = state.pireps;
  const issues = state.pireps.resolved?.issues ?? snapshot?.issues ?? [];
  const age = snapshot && state.now - snapshot.checkedAt;
  const stale = restored || error || age === undefined || age < 0 || age >= PIREP_SOURCE_MAX_AGE_MS;
  return <div className="awc-pirep-status">
    <p className="ui-note">{loading ? 'Refreshing reports…' : error ? 'Refresh failed' : !snapshot ? 'Reports unavailable'
      : stale ? 'Cached / unverified' : 'Source checked'}{age !== undefined && age >= 0 ? ` · ${formatAge(age)} ago` : ''}</p>
    {error && <p className="ui-note">{error}</p>}
    {!!issues.length && <p className="ui-note" role="status">AWC feed · {issues.length} {issues.length === 1 ? 'report' : 'reports'} not plotted.</p>}
    {(state.pirepDisplay.error || state.pirepDisplay.loading) && <p className="ui-note" role="status">{state.pirepDisplay.error ?? 'Drawing reports…'}</p>}
    {state.selectedTime !== null && state.selectedTime > state.now && <p className="ui-note">Observations are unavailable at future times. Choose Now to see recent reports.</p>}
  </div>;
}

export const PirepControls = memo(function PirepControls({ controller }: { controller: WeatherController }) {
  const state = usePirepState(controller), p = state.preferences;
  const issues = state.pireps.resolved?.issues ?? state.pireps.snapshot?.issues ?? [];
  return <div className="awc-pirep-controls">
    <button type="button" className="ui-button ui-button--quiet ui-button--slim awc-grid-toggle" role="switch" aria-label="Show PIREPs" aria-checked={p.awcPireps}
      onClick={() => controller.change({ awcPireps: !p.awcPireps })}>
      <span>PIREPs / AIREPs</span><span className="switch" aria-hidden="true"><i /></span>
    </button>
    <label className="ui-field">Report age<select className="ui-input ui-input--compact" value={p.awcPirepAge} onChange={e => controller.change({ awcPirepAge: e.target.value as typeof p.awcPirepAge })}>
      {['30', '60', '90'].map(n => <option key={n} value={n}>Last {n} minutes</option>)}
    </select></label>
    <label className="ui-field">Reported altitude<select className="ui-input ui-input--compact" value={p.awcPirepAltitude} onChange={e => controller.change({ awcPirepAltitude: e.target.value as typeof p.awcPirepAltitude })}>
      <option value="all">All altitudes, including unknown</option><option value="low">Below 10,000 ft MSL</option>
      <option value="mid">10,000–17,999 ft MSL</option><option value="high">18,000 ft MSL and above</option>
    </select></label>
    <label className="ui-field">Reported conditions<select className="ui-input ui-input--compact" value={p.awcPirepHazard} onChange={e => controller.change({ awcPirepHazard: e.target.value as typeof p.awcPirepHazard })}>
      <option value="all">All reports</option><option value="turbulence">Turbulence reports</option><option value="icing">Icing reports</option>
    </select></label>
    <p className="ui-note">Condition filters include negative reports. Unknown or qualified altitudes appear under All altitudes.</p>
    <p className="ui-note">Cyan: report · Violet: urgent PIREP. Select a circle for details.</p>
    {p.awcPireps && <>
      <p className="ui-meta">{state.pirepView.length} {state.pirepView.length === 1 ? 'report' : 'reports'} in view</p>
      <PirepStatus state={state} />
      {!!issues.length && <PirepSourceEntries issues={issues} />}
    </>}
  </div>;
});

const PirepEntry = memo(function PirepEntry({ controller, report, age, selected, active }: {
  controller: WeatherController; report: LocatedPirep; age: string; selected: boolean; active: boolean;
}) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const conditions = pirepConditions(report);
  const aircraftName = pirepAircraftName(report);
  const quality = report.quality.filter(q => (!report.decodedLocation || q !== 'bad_location') &&
    (!report.timeSource || q !== 'no_time_stamp'));
  const kind = report.urgent || report.type === 'PIREP' ? 'Pilot report' : report.type === 'AIREP' ? 'Air report'
    : report.type === 'Unknown' ? 'Type unspecified' : report.type;
  useEffect(() => active && (hovered || focused) ? controller.highlightPirep(report.id) : undefined,
    [active, hovered, focused, controller, report.id]);
  return <section data-report-id={report.id} className="awc-pirep-row" data-selected={selected || undefined}
    onPointerEnter={e => { if (e.pointerType !== 'touch') setHovered(true); }} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}>
    <button className="ui-button ui-button--quiet ui-button--compact awc-pirep-select" type="button" aria-expanded={selected}
      onClick={() => controller.showPireps(selected ? undefined : report.id)}>
      <span className="ui-item-copy">
        <span className="awc-pirep-heading">
          <strong className="ui-panel-title">{report.aircraft.trim() || 'Aircraft unspecified'}
            {aircraftName && <span className="ui-note"> ({aircraftName})</span>}
          </strong>
          {report.urgent && <span className="ui-badge awc-pirep-urgent">Urgent</span>}
          <span className="ui-meta awc-pirep-age">{report.timeSource === 'receipt' ? 'Received ' : ''}{age} ago</span>
        </span>
        <span className="awc-pirep-heading">
          <span className="ui-panel-content">{pirepAltitude(report)}</span>
          <span className="ui-meta" title={`Report type: ${report.type}`}>{kind}</span>
          {report.locationReferenceOnly ? <span className="ui-meta">Reference location</span>
            : report.locationEstimated && <span className="ui-meta">Approx. location</span>}
          {report.timeSource && <span className="ui-meta">{report.timeSource === 'receipt' ? 'Observation time unknown' : 'Time unverified'}</span>}
        </span>
        {!!conditions.length && <span className="ui-note">{conditions.join(' · ')}</span>}
      </span>
    </button>
    {selected && <div className="awc-pirep-expanded">
      <table className="ui-data-table"><tbody>
        <tr><th scope="row">Observed</th><td>{report.timeSource === 'receipt' ? 'Unknown; age and expiry use receipt time' : formatTimestamp(report.observedAt)}
          {report.timeSource === 'raw' && <span className="ui-note"> · Decoded /TM</span>}</td></tr>
        {report.receivedAt !== null && <tr><th scope="row">Received</th><td>{formatTimestamp(report.receivedAt)}</td></tr>}
        <tr><th scope="row">{report.locationReferenceOnly ? 'Reference position' : 'Position'}</th><td>{report.latitude.toFixed(4)}, {report.longitude.toFixed(4)}</td></tr>
        {report.decodedLocation && <tr><th scope="row">Location</th><td>{report.decodedLocation}</td></tr>}
      </tbody></table>
      {!!quality.length && <p className="ui-note">Source qualifiers: {quality.map(q => q.replaceAll('_', ' ')).join(', ')}</p>}
      <details className="ui-disclosure"><summary>Raw report</summary><pre className="awc-pirep-raw">{report.text}</pre></details>
    </div>}
  </section>;
});

const PirepList = memo(function PirepList({ controller, state, active, body }: {
  controller: WeatherController; state: PirepPanelState; active: boolean; body: RefObject<HTMLDivElement | null>;
}) {
  const matching = useMemo(() => selectedPireps(state), [state.preferences, state.selectedTime, state.now, state.pireps.snapshot, state.pireps.resolved]);
  const reports = useMemo(() => {
    const ids = new Set(state.pirepView);
    return matching.filter(report => ids.has(report.id));
  }, [matching, state.pirepView]);
  return <div ref={body} className="ui-panel-content awc-pirep-list">
    {!reports.length && <p className="ui-note">No reports in this view match the current time and filters.
      {matching.length > 0 && <> {matching.length.toLocaleString('en-US')} matching {matching.length === 1 ? 'report is' : 'reports are'} elsewhere. Zoom out or move the map.</>}
    </p>}
    {reports.map(report => <PirepEntry key={report.id} controller={controller} report={report}
      age={formatAge(Math.max(0, state.now - report.observedAt))} selected={state.pirepSelection?.id === report.id}
      active={active && !state.pirepDisplay.loading && !state.pirepDisplay.error} />)}
  </div>;
}, (previous, next) => previous.controller === next.controller && previous.body === next.body && previous.active === next.active &&
  // Stow once to release highlights; retain scroll/disclosure state until reopening with current data.
  (!next.active || previous.state === next.state));

export function PirepDetails({ controller }: { controller: WeatherController }) {
  const state = usePirepState(controller), panel = useEdgePanel('weather-awc-pireps');
  const selection = state.pirepSelection, body = useRef<HTMLDivElement>(null);
  const active = !!selection && panel.open;
  useEffect(() => { if (active) controller.checkPireps(); }, [active, controller]);
  useLayoutEffect(() => {
    if (selection) panel.setOpen(true);
  }, [selection?.request, panel.setOpen]);
  useLayoutEffect(() => {
    if (!selection || !panel.open) return;
    const row = selection.id ? body.current?.querySelector<HTMLElement>(`[data-report-id="${selection.id}"]`) : null;
    const scroll = body.current?.closest<HTMLElement>('.panel-scroll');
    // Explicit activation hands focus to the list, bringing this edge forward
    // on phones while preserving both panels and their scroll positions.
    if (scroll && !scroll.contains(document.activeElement)) scroll.focus({ preventScroll: true });
    if (row && scroll) {
      const rect = row.getBoundingClientRect(), area = scroll.getBoundingClientRect();
      if (rect.top < area.top || rect.bottom > area.bottom) scroll.scrollTop += rect.top - area.top;
    }
  }, [selection?.request, panel.open]);
  if (!selection || !state.preferences.awcEnabled || !state.preferences.awcPireps) return null;
  return <DetailPanel panel={panel} title="PIREP in View" label="PIREP in View" icon={null}
    onClose={controller.closePireps} closeLabel="Close PIREPs" contentLabel="PIREPs in viewport"
    header={<div className="ui-panel-content"><p className="ui-meta">{state.pirepView.length} reports · Newest first · Current filters</p><PirepStatus state={state} /></div>}>
    <PirepList controller={controller} state={state} active={panel.open} body={body} />
  </DetailPanel>;
}
