import { TFR_STALE_MS } from '@zlayer/contracts';
import { useLayoutEffect } from 'react';
import type { LayerStore } from '../../core/layers/store';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { formatCheckedAt, formatTimestampPair } from '../../core/format/time';
import { useEdgePanel } from '../../core/ui/edge-panels';
import { DetailPanel } from '../../core/ui/detail-panel';
import type { TfrState } from './tfr-client';
import { selectedTfrAreas, tfrReviewNotices, type TfrAreaSelection } from './tfr-selection';
import { tfrDetailFresh } from './tfr-time';
import './styles.css';

export function createTfrDetails(store: LayerStore<TfrState>, selection: LayerStore<readonly TfrAreaSelection[]>, clear: () => void) {
  return function TfrDetails() {
    const state = useLayerSnapshot(store), selected = useLayerSnapshot(selection);
    const panel = useEdgePanel('notams-tfr-details');
    useLayoutEffect(() => {
      if (selected.length) panel.setOpen(true);
    }, [selected, panel.setOpen]);
    if (!selected.length) return null;
    const areas = selectedTfrAreas(state, selected), { snapshot, now } = state;
    const stale = snapshot && (now < snapshot.checkedAt || now - snapshot.checkedAt >= TFR_STALE_MS || !!state.error || !!snapshot.error);
    return <DetailPanel panel={panel} title="TFR Details" label="TFR details" onClose={clear}
      closeLabel="Close TFR details" contentLabel="TFR details" icon={null}>
      <div className="notam-tfr-detail">
        <p className="notam-tfr-legend">Red: active or unknown schedule · Yellow: upcoming. Colors follow the saved schedule.</p>
        {areas.map(({ notice, area, timing, issue }) => <section key={`${notice.id}:${area.id}`}>
          <h3>{notice.id} · {notice.type}</h3>
          <p>{notice.title}</p><p>{area.name} · {area.lower}–{area.upper}</p>
          {issue && <p>FAA detail refresh failed. Showing retained detail.</p>}
          <small>{notice.detailCheckedAt === undefined ? 'Detail age unconfirmed' : `Detail · ${formatCheckedAt(notice.detailCheckedAt, now)}`}</small>
          <p>{issue || !tfrDetailFresh(notice, now) ? 'Check FAA source for current boundaries and timing' : timing.status === 'upcoming' ? 'Upcoming' : timing.status === 'unknown' ? 'Check source schedule' : 'Active'}</p>
          <p>From {formatTimestampPair(timing.startsAt, { now, primary: 'local' })}</p>
          <p>Until {timing.endsAt === null ? 'Further notice' : formatTimestampPair(timing.endsAt, { now, primary: 'local' })}</p>
          <details className="notam-raw"><summary>Show raw</summary><pre>{notice.text}</pre></details>
          <a href={`https://tfr.faa.gov/tfr3/?page=detail_${notice.id.replace('/', '_')}`} target="_blank" rel="noopener noreferrer">FAA notice</a>
        </section>)}
        {!areas.length && <p>The selected TFR areas have expired or are no longer available.</p>}
        {snapshot && <small>FAA index · {formatCheckedAt(snapshot.checkedAt, now)}{stale ? ' · May be out of date' : ''}</small>}
      </div>
    </DetailPanel>;
  };
}

export function createTfrStatus(store: LayerStore<TfrState>) {
  return function TfrStatus() {
    const state = useLayerSnapshot(store), { snapshot, now, error, loading } = state;
    const reviews = tfrReviewNotices(state);
    const stale = snapshot && (now < snapshot.checkedAt || now - snapshot.checkedAt >= TFR_STALE_MS || !!error || !!snapshot.error);
    return <footer className="panel-footer notam-tfr-status">
      <div className="notam-tfr-status-heading">
        <strong>TFRs</strong>
        <a href="https://tfr.faa.gov/tfr3/" target="_blank" rel="noopener noreferrer" aria-label="FAA TFR index">FAA index</a>
      </div>
      <small>{!snapshot ? loading ? 'Loading' : 'Unavailable' : `${formatCheckedAt(snapshot.checkedAt, now)}${stale ? ' · Check freshness' : ''}`}</small>
      {reviews.length > 0 && <details className="notam-raw"><summary>{reviews.length} need source review</summary>
        {reviews.map(({ id, title, reasons, notice, issue }) => <section key={id}>
          <p><a href={`https://tfr.faa.gov/tfr3/?page=detail_${id.replace('/', '_')}`} target="_blank" rel="noopener noreferrer">{id} · {title}</a></p>
          <p>{reasons.join(' · ')}</p>
          {notice && <>
            {notice.detailCheckedAt !== undefined && <small>{issue ? 'Retained detail' : 'Detail'} · {formatCheckedAt(notice.detailCheckedAt, now)}</small>}
            <details className="notam-raw"><summary>{issue ? 'Show retained raw' : 'Show raw'}</summary><pre>{notice.text}</pre></details>
          </>}
        </section>)}
      </details>}
    </footer>;
  };
}
