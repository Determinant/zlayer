import { Fragment, useId, useRef } from 'react';
import type { RouteComposition } from './composition';
import { usePreviewPanel } from './use-preview-panel';
import './composition-panel.css';

export function RouteCompositionPanel({ ident, composition, onClose, onExpand, expansionProblem }: {
  ident: string; composition: RouteComposition; onClose: (restoreFocus?: boolean) => void;
  onExpand: (() => void) | undefined; expansionProblem: string | undefined;
}) {
  const titleId = useId();
  const expansionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  usePreviewPanel(true, panel, closeButton, onClose);
  const { tec, airways, procedures, issues } = composition;
  return <div ref={panel} className="route-preview-panel route-composition" role="dialog" aria-labelledby={titleId}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    }}>
    <header>
      <h2 id={titleId}>{ident} composition</h2>
      <button ref={closeButton} type="button" className="ui-button" aria-label="Close route composition" onClick={() => onClose()}>Close</button>
    </header>
    <div className="route-composition-body">
      {tec && <section aria-label="Published TEC route">
        <h3>TEC · {tec.originId} – {tec.destinationId}</h3>
        {tec.route && <p className="route-composition-path">{tec.route}</p>}
        {!!tec.segments.length && <ol>{tec.segments.map(segment => <li key={segment.sequence}>
          <strong>{segment.value}</strong> <small>{segment.type.toLowerCase()}</small>
        </li>)}</ol>}
        {!tec.route && !tec.segments.length && <p>Direct between the published airports.</p>}
      </section>}
      {airways.map((airway, index) => <section key={index} aria-label={`${airway.ident} airway`}>
        <h3>{airway.ident} · {airway.entry} – {airway.exit}</h3>
        <p className="route-composition-path">{airway.points.map(point => point.ident).join(' → ')}</p>
      </section>)}
      {procedures.map((procedure, index) => <section key={index} aria-label={`${procedure.ident} procedure`}>
        <h3>{procedure.ident} · {procedure.kind === 'departure' ? 'SID' : 'STAR'}</h3>
        <p>{procedure.airport} · {procedure.transition ? `${procedure.transition} transition` : 'Vectors'}
          {procedure.source === 'cifp' && procedure.branch && ` · ${procedure.branch}`}</p>
        {procedure.source === 'cifp' ? <>{!procedure.path.spans.length && <p>{procedure.path.points.map(point => point.ident).join(' · ') || 'No fixed route points are available.'}</p>}<ol>{procedure.path.spans.map((span, at) => <li key={at}>
          {span.from !== undefined && <strong>{procedure.path.points[span.from]?.ident} </strong>}
          {span.kind === 'gap' ? '— route discontinuity' : span.kind === 'schematic' ? '— schematic' : '→'}
          {span.to !== undefined && <strong> {procedure.path.points[span.to]?.ident}</strong>}
          {span.kind !== 'gap' && span.to === undefined && ' · open end'}
        </li>)}</ol></> : <>
        <p className="route-composition-path">{procedure.points.map((point, at) => <Fragment key={at}>
          {at > 0 && (procedure.points[at - 1]!.next === point.ident ? ' → ' : ' · [route discontinuity] · ')}{point.ident}
        </Fragment>)}</p>
        {procedure.partial && <p>Only the shared waypoint route is available; a runway or branch has not been selected.</p>}
        </>}
      </section>)}
      {!tec && !airways.length && !procedures.length && <p>Composition is unavailable for this route item.</p>}
      {!!issues.length && <section aria-label="Composition issues"><h3>Unresolved sections</h3>
        <ul>{issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>
      </section>}
      <footer>
        <p id={expansionId}>{expansionProblem ?? (tec
          ? 'Replace this TEC with its published route items. Airways stay compact and can be expanded separately.'
          : 'Replace this airway with its waypoints, keeping neighboring route items intact.')}</p>
        <button type="button" className="ui-button" disabled={!onExpand} aria-describedby={expansionId}
          onClick={onExpand}>Expand</button>
      </footer>
    </div>
  </div>;
}
