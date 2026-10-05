import { TFR_STALE_MS } from '@zlayer/contracts';
import { useLayoutEffect } from 'react';
import type { LayerStore } from '../../core/layers/store';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { formatCheckedAt, formatTimestampPair } from '../../core/format/time';
import { useEdgePanel } from '../../core/ui/edge-panels';
import { DetailPanel } from '../../core/ui/detail-panel';
import type { TfrState } from './tfr-client';
import { selectedTfrAreas, type TfrAreaSelection } from './tfr-selection';
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
        {areas.map(({ notice, area, timing }) => <section key={`${notice.id}:${area.id}`}>
          <h3>{notice.id} · {notice.type}</h3>
          <p>{notice.title}</p><p>{area.name} · {area.lower}–{area.upper}</p>
          <p>{timing.status === 'upcoming' ? 'Upcoming' : timing.status === 'unknown' ? 'Check source schedule' : 'Active'}</p>
          <p>From {formatTimestampPair(timing.startsAt, { now })}</p>
          <p>Until {timing.endsAt === null ? 'Further notice' : formatTimestampPair(timing.endsAt, { now })}</p>
          <details className="notam-raw"><summary>Show raw</summary><pre>{notice.text}</pre></details>
          <a href={`https://tfr.faa.gov/tfr3/?page=detail_${notice.id.replace('/', '_')}`} target="_blank" rel="noopener noreferrer">FAA TFR details</a>
        </section>)}
        {!areas.length && <p>The selected TFR areas have expired or are no longer available.</p>}
        {snapshot && <small>FAA · {formatCheckedAt(snapshot.checkedAt, now)}{stale ? ' · May be out of date' : ''}</small>}
      </div>
    </DetailPanel>;
  };
}

export function createTfrStatus(store: LayerStore<TfrState>) {
  return function TfrStatus() {
    const { snapshot, now, error, loading } = useLayerSnapshot(store);
    const incomplete = snapshot?.notices.filter(n => !n.areas.length || n.areas.some(a => !a.geometry || !a.windows ||
      a.lower === 'Check altitude' || a.upper === 'Check altitude')).length ?? 0;
    const stale = snapshot && (now < snapshot.checkedAt || now - snapshot.checkedAt >= TFR_STALE_MS || !!error || !!snapshot.error);
    return <footer className="panel-footer notam-tfr-status">
      <span>TFRs</span><strong>{!snapshot ? loading ? 'Loading' : 'Unavailable' : stale ? 'Saved areas · Check freshness' : 'Active & upcoming areas'}</strong>
      <small>Red: active · Yellow: upcoming</small>
      {snapshot && <small>FAA · {formatCheckedAt(snapshot.checkedAt, now)}{incomplete ? ` · ${incomplete} notices need source review` : ''}</small>}
      <a href="https://tfr.faa.gov/tfr3/" target="_blank" rel="noopener noreferrer">FAA TFR details</a>
    </footer>;
  };
}
