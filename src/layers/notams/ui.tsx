import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { isNotamAirportQuery, notamAirportKey, NOTAM_STALE_MS, type NotamAirportQuery, type NotamRecord } from '@zlayer/contracts';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { useOnline } from '../../core/use-online';
import { formatCheckedAt, formatTimestamp, formatTimestampPair } from '../../core/format/time';
import { LoadingPlaceholder } from '../../core/ui/loading-placeholder';
import type { NotamsApi } from './public';
import type { PlateNoticeContext } from '../plates/public';
import { matchPlateNotams, type PlateNotamMatch } from './matcher';
import { parseNotam } from './parser';
import { notamEndKind, notamValidity } from './validity';
import './styles.css';

const visible = () => document.visibilityState !== 'hidden';
const subscribeVisibility = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};
export function airportNotamQuery(airport: { faaId?: unknown; icaoId?: unknown }): NotamAirportQuery | undefined {
  const query = { ...(typeof airport.faaId === 'string' && airport.faaId.trim() ? { faaId: airport.faaId.trim().toUpperCase() } : {}),
    ...(typeof airport.icaoId === 'string' && airport.icaoId.trim() ? { icaoId: airport.icaoId.trim().toUpperCase() } : {}) };
  return isNotamAirportQuery(query) ? query : undefined;
}
function useAirportNotams(api: NotamsApi, query: NotamAirportQuery | undefined, active: boolean) {
  const online = useOnline(), visiblePage = useSyncExternalStore(subscribeVisibility, visible, () => false);
  const state = useLayerSnapshot(api.state), key = query ? notamAirportKey(query) : '';
  useEffect(() => active && visiblePage && query ? api.retain(query, online) : undefined, [api, key, active, online, visiblePage]);
  const entry = state.airports[key], snapshot = entry?.snapshot;
  const checked = snapshot?.feed.checkedAt;
  const fresh = checked !== null && checked !== undefined && state.now >= checked && state.now - checked < NOTAM_STALE_MS;
  const complete = snapshot?.feed.continuity === 'complete' && snapshot.associationCoverage === 'complete';
  return { entry, snapshot, online, now: state.now, fresh, complete, staging: snapshot?.feed.environment === 'staging' };
}
type View = ReturnType<typeof useAirportNotams>;
const classification = (record: NotamRecord) => record.classification === 'DOMESTIC' || record.classification === 'DOM' ? 'D'
  : record.classification === 'FDC' ? 'FDC' : `Other · ${record.classification || 'Unclassified'}`;
function displayNumber(record: NotamRecord): string {
  const local = record.translations.find(t => t.type === 'LOCAL_FORMAT')?.text ?? '';
  return /^![A-Z0-9]+\s+(\d{1,2}\/\d+)\b/.exec(local)?.[1] ?? `${record.series}${record.number}/${record.year}`;
}
function currentRecords(records: readonly NotamRecord[], now: number) {
  return records.filter(r => !['cancelled', 'cancellation'].includes(r.lifecycle) && notamValidity(r, now) !== 'past end').sort((a, b) =>
    Number(notamValidity(a, now) === 'upcoming') - Number(notamValidity(b, now) === 'upcoming') ||
    (b.issuedAt ?? b.updatedAt) - (a.issuedAt ?? a.updatedAt) || a.id.localeCompare(b.id));
}
function RefreshNotams({ view, api }: { view: View; api: NotamsApi }) {
  return <button type="button" className="ui-button ui-button--icon" aria-label="Refresh NOTAMs" title="Refresh NOTAMs"
    disabled={!view.online || view.entry?.loading} aria-busy={view.entry?.loading || undefined} onClick={() => api.retry()}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
    </svg>
  </button>;
}
function SourceStatus({ view }: { view: View }) {
  const { snapshot, entry, online, now, fresh, complete, staging } = view;
  return <div className="notam-source">
    {staging ? <>
      <strong>Testing with FAA staging data. Notices may be incomplete. Do not use for flight planning.</strong>
      {!online && <span>Offline</span>}
    </> : <span>{snapshot ? `FAA NOTAMs · ${formatCheckedAt(snapshot.feed.checkedAt, now)}` : entry?.loading ? 'Checking NOTAMs…' : 'NOTAMs unavailable'}
      {!online && ' · Offline'}{snapshot && !fresh && ' · Stale'}{snapshot && !complete && ' · Incomplete coverage'}</span>}
    {entry?.error && <span role="status">{entry.error}</span>}
    {!staging && snapshot?.feed.state === 'degraded' && <span>Feed update incomplete; retained notices are shown.</span>}
  </div>;
}
function NotamEntry({ record, now, reason }: { record: NotamRecord; now: number; reason?: string }) {
  const parsed = useMemo(() => parseNotam(record), [record]);
  const validity = notamValidity(record, now);
  const endKind = notamEndKind(record);
  return <article className="notam-entry">
    <div className="notam-entry-heading"><strong>{classification(record)} · {displayNumber(record)}</strong>
      <span>{record.locations.join(', ') || record.icaoLocations.join(', ')}</span></div>
    <div className="notam-flairs">{parsed.flairs.map(flair => <span key={flair.label} className={`notam-flair--${flair.tone}`} title={flair.evidence.text}>{flair.label}</span>)}
      {parsed.unresolved && <span className="notam-flair--caution">Interpretation Limited</span>}
      {validity !== 'within interval' && validity !== 'upcoming' && <span className={validity.startsWith('check') ? 'notam-flair--caution' : 'notam-flair--neutral'}>
        {validity.replace(/\b[a-z]/g, letter => letter.toUpperCase())}</span>}</div>
    {reason && <p className="notam-match-reason">{reason}</p>}
    <p className="notam-text">{parsed.body || 'No text supplied.'}</p>
    <p className="notam-validity">From {formatTimestampPair(record.startsAt, { now, primary: 'local' })} · {endKind === 'permanent' ? 'Permanent'
      : `Until ${formatTimestampPair(record.endsAt, { now, primary: 'local' })}${endKind === 'estimated' ? ' (estimated)' : endKind === 'unknown' ? ' (unconfirmed)' : ''}`}</p>
    {record.schedule && <p className="notam-text">Schedule: {record.schedule}</p>}
    <details className="notam-raw"><summary>Show raw</summary>
      {record.translations.length ? record.translations.map((translation, i) => <div key={i}>
        <strong>{translation.type || 'Source translation'}</strong><pre>{translation.text}</pre></div>)
        : <p>Complete translation unavailable. Source body shown below.</p>}
      <strong>Source body</strong><pre>{record.text || 'No source body supplied.'}</pre>
      <p>Source ID {record.sourceId} · Updated {formatTimestamp(record.updatedAt)}</p>
    </details>
  </article>;
}
type NotamListEntry = { record: NotamRecord; reason?: string; outcome?: PlateNotamMatch['outcome'] };
export function NotamList({ entries, now }: { entries: readonly NotamListEntry[]; now: number }) {
  const sections: { key: string; title: string; entries: NotamListEntry[] }[] = [
    { key: 'active', title: 'Active', entries: [] },
    { key: 'check', title: 'Check timing', entries: [] },
    { key: 'upcoming', title: 'Upcoming', entries: [] },
  ];
  for (const entry of entries) {
    const validity = notamValidity(entry.record, now);
    sections[validity === 'upcoming' ? 2 : validity === 'within interval' ? 0 : 1]!.entries.push(entry);
  }
  const renderEntries = (items: readonly NotamListEntry[]) => items.map(({ record, reason }) =>
    <NotamEntry key={`${record.id}:${record.revision}`} record={record} now={now} {...(reason ? { reason } : {})} />);
  const populated = sections.filter(section => section.entries.length);
  if (!populated.length) return null;
  return <div className="notam-list">{populated.map(section =>
    <section key={section.key} className={`notam-section notam-section--${section.key}`} aria-label={section.title}>
      <h3 className="notam-section-heading">{section.title}{' '}<span className="notam-section-count">{section.entries.length}</span></h3>
      {section.entries.some(entry => entry.outcome) ? (['applies', 'review'] as const).map(outcome => {
        const group = section.entries.filter(entry => entry.outcome === outcome)
          .sort((a, b) => Number(b.record.classification === 'FDC') - Number(a.record.classification === 'FDC'));
        return group.length ? <div key={outcome}>
          <h4 className="notam-match-heading">{outcome === 'applies' ? 'Applies to this plate' : 'Review applicability'}</h4>
          {renderEntries(group)}
        </div> : null;
      }) : renderEntries(section.entries)}
    </section>)}</div>;
}
export function AirportNotams({ api, query, active }: { api: NotamsApi; query: NotamAirportQuery; active: boolean }) {
  const view = useAirportNotams(api, query, active), [filter, setFilter] = useState('all'), [subject, setSubject] = useState('all'), [search, setSearch] = useState('');
  const key = notamAirportKey(query);
  useEffect(() => { setFilter('all'); setSubject('all'); setSearch(''); }, [key]);
  const records = useMemo(() => currentRecords(view.snapshot?.records ?? [], view.now)
    .filter(r => filter === 'other' || !['INTL', 'MIL'].includes(r.classification)), [view.snapshot, view.now, filter]);
  const parsed = useMemo(() => records.map(record => ({ record, parsed: parseNotam(record) })), [records]);
  const subjects = [...new Set(parsed.map(p => p.parsed.subject ?? 'Other'))].sort();
  const shown = parsed.filter(({ record, parsed }) => (filter === 'all' || (filter === 'other' ? !['D', 'FDC'].includes(classification(record))
    : classification(record) === filter)) && (subject === 'all' || (parsed.subject ?? 'Other') === subject) &&
    `${parsed.body} ${record.number} ${record.translations.map(t => t.text).join(' ')}`.toUpperCase().includes(search.toUpperCase()));
  return <section className="airport-notams" aria-label="Airport NOTAMs">
    <SourceStatus view={view} />
    <div className="notam-filters">
      <label>Classification<select className="ui-input" aria-label="Classification" value={filter} onChange={e => setFilter(e.target.value)}>
        <option value="all">All</option><option value="D">D</option><option value="FDC">FDC</option><option value="other">Other / Unclassified</option>
      </select></label>
      <label>Subject<select className="ui-input" aria-label="Subject" value={subject} onChange={e => setSubject(e.target.value)}>
        <option value="all">All subjects</option>{subjects.map(s => <option key={s}>{s}</option>)}</select></label>
      <div className="notam-search-row">
        <label>Search<input type="search" className="ui-input" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <RefreshNotams view={view} api={api} />
      </div>
    </div>
    {view.entry?.loading && !view.snapshot && <LoadingPlaceholder label="Loading NOTAMs…" rows={3} />}
    {view.snapshot && <p className="notam-list-status">{shown.length} of {records.length} retained notices</p>}
    <NotamList entries={shown} now={view.now} />
    {view.snapshot && !shown.length && <p className="notam-list-status">{records.length ? 'No notices match these filters.' : 'No retained notices.'}</p>}
  </section>;
}
export function PlateNotamCount({ api, context, active }: { api: NotamsApi; context: PlateNoticeContext; active: boolean }) {
  const view = useAirportNotams(api, context.status === 'resolved' ? context.airport : undefined, active);
  const result = useMemo(() => matchPlateNotams(currentRecords(view.snapshot?.records ?? [], view.now), context), [view.snapshot, view.now, context]);
  if (context.status !== 'resolved') return null;
  const count = result.matches.length;
  return <small className={`plate-notam-count${count ? ' has-notams' : ''}`}>NOTAM · {view.snapshot
    ? `${count} matched${result.matches.some(m => m.outcome === 'review') ? ' · Review' : ''}`
    : view.entry?.loading ? 'Checking…' : 'Unavailable'}</small>;
}
export function PlateNotams({ api, context, active, retryCatalog }: {
  api: NotamsApi; context: PlateNoticeContext; active: boolean; retryCatalog?: (() => void) | undefined;
}) {
  const view = useAirportNotams(api, context.status === 'resolved' ? context.airport : undefined, active);
  const [openKey, setOpenKey] = useState<string>(), id = useId();
  const open = openKey === context.key;
  const result = useMemo(() => matchPlateNotams(currentRecords(view.snapshot?.records ?? [], view.now), context), [view.snapshot, view.now, context]);
  if (context.status === 'not-procedure') return null;
  const count = result.matches.length, review = result.matches.filter(m => m.outcome === 'review');
  const label = context.status === 'loading' ? 'Loading plate context…' : !result.available ? 'Matching unavailable' : !view.snapshot ? view.entry?.loading ? 'Checking…' : 'Unavailable'
    : `${count} matched${review.length ? ` · ${review.length} review` : ''}`;
  return <section className={`plate-notams${count ? ' has-notams' : ''}`} aria-label="Plate NOTAMs">
    <button className="ui-button plate-notam-toggle" type="button" aria-expanded={open} aria-controls={id}
      onClick={() => setOpenKey(open ? undefined : context.key)}><span>NOTAM · {label}</span><span aria-hidden="true">{open ? '▴' : '▾'}</span></button>
    {open && <div id={id} className="plate-notams-list panel-scroll" role="region" aria-label="Notices for displayed plate" tabIndex={0}>
      {!result.available ? context.status === 'loading' ? <LoadingPlaceholder label="Loading plate context…" rows={1} />
        : retryCatalog ? <div className="notam-recovery"><p className="notam-list-status">The plate catalog could not be loaded. Matching is unavailable.</p>
          <button type="button" className="ui-button ui-button--compact" onClick={retryCatalog}>Retry plate catalog</button></div>
          : <p className="notam-list-status">This page’s airport and procedure could not be established from its edition. Reopen an indexed IAP, SID or STAR from Plates.</p> : <>
        <strong className="plate-notams-heading">{context.airport?.icaoId ?? context.airport?.faaId} · {context.procedure?.name}</strong>
        <div className="notam-source-row"><SourceStatus view={view} /><RefreshNotams view={view} api={api} /></div>
        <NotamList entries={result.matches} now={view.now} />
        {!count && <p className="notam-list-status">No matches in the retained notices.</p>}
        {result.unresolved > 0 && <p className="notam-list-status">{result.unresolved} notice(s) have unresolved interpretation.</p>}
      </>}
    </div>}
  </section>;
}
