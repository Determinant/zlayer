import { useId } from 'react';
import type { FixAirspace, FixDetail, FixDisplaySettings } from './fix-display';

export function FixDisplayControls({ value, onChange }: {
  value: FixDisplaySettings;
  onChange: (settings: FixDisplaySettings) => void;
}) {
  const descriptionId = useId();
  return <fieldset className="fix-display-controls" aria-describedby={descriptionId}>
    <legend>IFR fix detail</legend>
    <label>
      <span>Show</span>
      <select className="ui-input ui-input--compact" value={value.detail} onChange={event =>
        onChange({ ...value, detail: event.target.value as FixDetail })}>
        <option value="enroute">Enroute fixes</option>
        <option value="terminal">Enroute + SID/STAR fixes</option>
        <option value="all">All fixes, including approaches</option>
      </select>
    </label>
    <label>
      <span>Enroute</span>
      <select className="ui-input ui-input--compact" value={value.detail === 'all' ? 'both' : value.airspace} disabled={value.detail === 'all'} onChange={event =>
        onChange({ ...value, airspace: event.target.value as FixAirspace })}>
        <option value="low">Low altitude</option>
        <option value="high">High altitude</option>
        <option value="both">Low + high altitude</option>
      </select>
    </label>
    <p id={descriptionId}>
      {value.detail === 'all' ? 'Procedure and other fixes appear at closer zooms.'
        : value.detail === 'terminal' ? 'SID/STAR fixes appear at closer zooms; approach-only fixes stay hidden.'
        : 'Airway junctions appear first. Procedure-only fixes stay hidden.'}
      {' '}Selected and route fixes remain visible. All fixes stay searchable.
    </p>
  </fieldset>;
}
