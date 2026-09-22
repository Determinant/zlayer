import type { ChartRecord } from '@zlayer/contracts';
import {
  availableChartBases, availableChartOverlays, chartCountForFamily,
  type ChartBaseSelection, type ChartOverlaySelection, type ChartSelection,
} from './overlays';

export function ChartControls({ charts, selection, onBaseChange, onOverlayChange }: {
  charts: readonly ChartRecord[];
  selection: ChartSelection;
  onBaseChange: (base: ChartBaseSelection) => void;
  onOverlayChange: (overlay: ChartOverlaySelection) => void;
}) {
  const overlays = availableChartOverlays(charts, selection.base);
  return <section className="layer-section">
    <div className="section-title"><h3>Chart base</h3><span>Choose one</span></div>
    <div className="segmented-list" aria-label="Chart base">
      <Choice selected={selection.base === ''} onClick={() => onBaseChange('')} title="Base map only" note="BASE" />
      {availableChartBases(charts).map(base => <Choice key={base.id}
        selected={selection.base === base.id} onClick={() => onBaseChange(base.id)}
        title={base.title} note={`${base.shortTitle} · ${chartCountForFamily(charts, base.id)}`} />)}
    </div>
    {overlays.length > 0 && <div className="chart-overlay-options">
      <div className="section-title"><h3>VFR overlay</h3><span>Above sectionals</span></div>
      <div className="segmented-list" aria-label="VFR overlay">
        <Choice selected={selection.overlay === ''} onClick={() => onOverlayChange('')} title="None" note="SECTIONALS ONLY" />
        {overlays.map(overlay => <Choice key={overlay.id}
          selected={selection.overlay === overlay.id} onClick={() => onOverlayChange(overlay.id)}
          title={overlay.title} note={`+ ${chartCountForFamily(charts, overlay.id)}`} />)}
      </div>
    </div>}
  </section>;
}

function Choice({ selected, onClick, title, note }: {
  selected: boolean; onClick: () => void; title: string; note: string;
}) {
  return <button type="button" className={selected ? 'is-active' : ''} aria-pressed={selected} onClick={onClick}>
    <span>{title}</span><small>{note}</small>
  </button>;
}
