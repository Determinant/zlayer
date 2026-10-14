import { memo, useMemo, useState } from 'react';
import type { PirepSnapshot } from '@zlayer/contracts';
import { formatTimestamp } from '../../../core/format/time';
import { pirepAircraftName } from './aircraft';

const labels: Record<string, string> = {
  receipt_time: 'Received', observation_time: 'Observed', aircraft_ref: 'Aircraft', report_type: 'Report type',
  altitude_ft_msl: 'Altitude (ft MSL)', latitude: 'Latitude', longitude: 'Longitude',
  sky_condition: 'Sky', sky_cover: 'Cover', turbulence_condition: 'Turbulence', icing_condition: 'Icing',
  turbulence_type: 'Type', turbulence_intensity: 'Intensity', turbulence_freq: 'Frequency',
  icing_type: 'Type', icing_intensity: 'Intensity',
  cloud_base_ft_msl: 'Base (ft MSL)', cloud_top_ft_msl: 'Top (ft MSL)',
  turbulence_base_ft_msl: 'Base (ft MSL)', turbulence_top_ft_msl: 'Top (ft MSL)',
  icing_base_ft_msl: 'Base (ft MSL)', icing_top_ft_msl: 'Top (ft MSL)',
  quality_control_flags: 'Quality', bad_location: 'Unreliable location', no_time_stamp: 'Observation time missing',
  mid_point_assumed: 'Midpoint assumed', flt_lvl_range: 'Altitude range',
  above_ground_level_indicated: 'Height above ground', no_flt_lvl: 'Altitude missing',
  visibility_statute_mi: 'Visibility (SM)', wx_string: 'Weather', temp_c: 'Temperature (°C)',
  wind_dir_degrees: 'Wind direction (°)', wind_speed_kt: 'Wind speed (kt)', vert_gust_kt: 'Vertical gust (kt)',
};
const label = (name: string) => Object.hasOwn(labels, name) ? labels[name]! : name.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());

/** Read source evidence for display only; /OV recovery uses validated observation fields. */
function sourceDetails(xml: string, excludedFlag: string | undefined) {
  if (!xml || xml.length > 20_000 || /<!DOCTYPE/i.test(xml)) return undefined;
  const document = new DOMParser().parseFromString(xml, 'application/xml'), root = document.documentElement;
  if (root.localName !== 'AircraftReport' || root.namespaceURI || document.querySelector('parsererror')) return undefined;
  const fields: { label: string; value: string }[] = [], reports: string[] = [], notes: string[] = [];
  const types = [...root.children].filter(node => node.localName === 'report_type' && !node.children.length);
  const type = types.length === 1 ? types[0]!.textContent.trim() : '';
  let count = 0;
  const visit = (node: Element, path: string[]): boolean => {
    if (++count > 256 || path.length > 12 || node.namespaceURI) return false;
    const name = node.localName, heading = [...path, label(name)];
    const text = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE)
      .map(child => child.textContent).join('');
    if (name === 'raw_text' && !path.length && !node.children.length && !node.attributes.length) {
      if (text.trim()) reports.push(text);
      return true;
    }
    if (path.length === 1 && node.parentElement?.localName === 'quality_control_flags' && !node.children.length && !node.attributes.length) {
      const value = text.trim();
      // The heading already explains the exclusion; other qualifiers are short notes.
      if (/^(TRUE|1)$/i.test(value)) { if (name !== excludedFlag) notes.push(label(name)); }
      else notes.push(`${label(name)}: ${/^(FALSE|0)$/i.test(value) ? 'No' : value || 'Not supplied'}`);
      return true;
    }
    if (text.trim() || !node.children.length && !node.attributes.length) {
      let value = text.trim() || 'Not supplied';
      if (!path.length && (name === 'observation_time' || name === 'receipt_time')) {
        const formatted = formatTimestamp(value);
        if (formatted !== '—') value = formatted;
      }
      if (!path.length && name === 'aircraft_ref') {
        const aircraft = pirepAircraftName({ type, aircraft: value });
        if (aircraft) value += ` (${aircraft})`;
      }
      fields.push({ label: heading.join(' · '), value });
    }
    for (const attribute of node.attributes) fields.push({ label: [...heading, label(attribute.name)].join(' · '), value: attribute.value || 'Not supplied' });
    return fields.length <= 256 && [...node.children].every(child => visit(child, heading));
  };
  return [...root.children].every(node => visit(node, [])) ? { fields, reports, notes } : undefined;
}

const SourceEntry = memo(function SourceEntry({ issue }: { issue: PirepSnapshot['issues'][number] }) {
  const source = useMemo(() => sourceDetails(issue.sourceXml, issue.qualityFlag), [issue.sourceXml, issue.qualityFlag]);
  return <article className="ui-section ui-section--divided awc-pirep-source-entry">
    <h4 className="ui-panel-title">{issue.report ? 'Location unavailable' : issue.qualityFlag === 'bad_location' ? 'Location unverified'
      : issue.qualityFlag === 'no_time_stamp' ? 'Observation time unavailable' : 'Report not plotted'}</h4>
    {(issue.report || !issue.qualityFlag) && <p className="ui-note">{issue.reason}</p>}
    {source ? <>
      {!!source.notes.length && <p className="ui-note">{source.notes.join(' · ')}</p>}
      {!!source.fields.length && <table className="ui-data-table" aria-label="Unverified source fields"><tbody>
        {source.fields.map((field, i) => <tr key={i}><th scope="row">{field.label}</th><td>{field.value}</td></tr>)}
      </tbody></table>}
      {source.reports.map((report, i) => <details key={i} className="ui-disclosure">
        <summary>Raw report{source.reports.length > 1 ? ` ${i + 1}` : ''}</summary>
        <pre className="awc-pirep-raw">{report}</pre>
      </details>)}
      {!source.reports.length && <p className="ui-note">Raw report unavailable.</p>}
    </> : <p className="ui-note">Readable source details unavailable.</p>}
  </article>;
});

export function PirepSourceEntries({ issues }: { issues: PirepSnapshot['issues'] }) {
  const [open, setOpen] = useState(false);
  return <details className="ui-disclosure" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Reports not plotted</summary>
    {open && issues.map(issue => <SourceEntry key={issue.id} issue={issue} />)}
  </details>;
}
