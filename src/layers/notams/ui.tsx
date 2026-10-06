import { notamFlairs, notamInterpretationNotes } from './flairs';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { isNotamAirportQuery, notamAirportKey, NOTAM_STALE_MS, type NotamAirportQuery, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { useOnline } from '../../core/use-online';
import { formatCheckedAt, formatTimestamp, formatTimestampPair } from '../../core/format/time';
import { LoadingPlaceholder } from '../../core/ui/loading-placeholder';
import type { NotamsApi, NotamMapPreview } from './public';
import type { PlateNoticeContext } from '../plates/public';
import { matchPlateNotams, type PlateNotamMatch } from './matcher';
import { parseNotam } from './parser';
import { airportNotamPriority } from './priority';
import { presentNotam, type NotamBodyBlock } from './presentation';
import { notamEndKind, notamValidity } from './validity';
import { chartedNotamPresentation, notamChartKey } from './chart';
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
  const complete = (snapshot?.contentCoverage ?? snapshot?.feed.continuity) === 'complete' && snapshot?.associationCoverage === 'complete';
  return { entry, snapshot, online, visiblePage, now: state.now, fresh, complete, staging: snapshot?.feed.environment === 'staging' };
}
function useChartPreview(api: NotamsApi, entries: readonly { record: NotamRecord }[], active: boolean) {
  const current = useRef<NotamMapPreview | undefined>(undefined);
  const charted = useLayerSnapshot(api.charted);
  useEffect(() => {
    if (!active) return;
    const preview = api.previewChart(); current.current = preview;
    return () => { preview.release(); if (current.current === preview) current.current = undefined; };
  }, [api, active]);
  useEffect(() => { current.current?.update(entries.map(entry => entry.record)); }, [api, active, entries]);
  return useMemo(() => new Set(active ? charted : []), [active, charted]);
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
    {!staging && snapshot?.feed.state === 'degraded' && snapshot.feed.error !== 'unresolved-records' &&
      <span>Feed update incomplete; retained notices are shown.</span>}
  </div>;
}
export function NotamSourceIssues({ issues }: { issues: readonly NotamSourceIssue[] }) {
  if (!issues.length) return null;
  return <section className="notam-section notam-section--check" aria-label="Unresolved FAA source records">
    <h3 className="notam-section-heading">Source data needs review <span className="notam-section-count">{issues.length}</span></h3>
    <p className="notam-list-status">These records are excluded from interpreted notices, plate matches and map symbols. Their status or content could not be resolved.</p>
    {issues.map(issue => <article className="notam-entry" key={issue.id}>
      <strong>FAA source ID {issue.id}</strong>
      <p>{issue.reason === 'unsupported-lifecycle' ? 'The source does not establish whether this notice is active or cancelled.'
        : issue.reason === 'representation-limit' ? 'The source supplied more representations than can be safely combined.'
          : 'The source supplied different versions without a newer revision. No version has been chosen as authoritative.'}</p>
      {issue.unscoped && <p>Airport applicability is uncertain. This warning is shown for all airports.</p>}
      {issue.variantsTruncated && <p>Additional source versions were received. The retained examples below are not exhaustive.</p>}
      <details className="notam-raw"><summary>Review FAA source versions</summary>
        {issue.variants.map((record, index) => <div key={record.revision}>
          <strong>Version {index + 1} · {displayNumber(record)}</strong>
          <p>Source lifecycle: {record.lifecycle} · Updated {formatTimestamp(record.updatedAt)}</p>
          <strong>Source body</strong><pre>{record.text || 'No source body supplied.'}</pre>
          {record.translations.map((translation, i) => <div key={i}><strong>{translation.type || 'Source translation'}</strong><pre>{translation.text}</pre></div>)}
        </div>)}
      </details>
    </article>)}
  </section>;
}
function NotamBody({ blocks }: { blocks: NotamBodyBlock[] }) {
  return <div className="notam-readable">{blocks.map((block, i) => {
    if (block.kind === 'context' && blocks[i + 1]?.kind === 'heading') return null;
    const context = i > 0 && blocks[i - 1]?.kind === 'context' ? blocks[i - 1] : undefined;
    return <ReadableBlock key={i} block={block} context={context && 'text' in context ? context.text : undefined} />;
  })}</div>;
}
function ReadableBlock({ block, context }: { block: NotamBodyBlock; context?: string | undefined }) {
  if (block.kind === 'minima-group') return <div className="notam-minima-group">{block.entries.map((entry, i) => <ReadableBlock key={i} block={entry} />)}</div>;
  if (block.kind === 'takeoff-group') return <div className="notam-minima-group"><p className="notam-body-context">Takeoff minimums</p>
    {block.entries.map((entry, i) => <ReadableBlock key={i} block={entry} context="takeoff-group" />)}</div>;
  if (block.kind === 'distances') return <div className="notam-distances">
    <div className="notam-block-heading"><p className="notam-block-title">Runway {block.runway}</p><span className="notam-body-context">Declared distances</span></div>
    <div className="notam-minimum-row"><dl>{block.values.map(value => <div key={value.label}><dt>{value.label}</dt><dd>{value.value}</dd></div>)}</dl></div>
  </div>;
  if (block.kind === 'takeoff') return <div className="notam-takeoff">
      <div className="notam-block-heading"><p className="notam-block-title">{block.aircraft && <>{block.aircraft} · </>}Runway {block.runway}</p>
        {context !== 'takeoff-group' && <span className="notam-body-context">Takeoff minimums</span>}</div>
      {block.options.map((option, i) => <div className="notam-takeoff-choice" key={i}>
        {i > 0 && <p className="notam-alternative">or</p>}
        <div className="notam-takeoff-option">
          <p className={option.minimums === 'Standard minimums' ? undefined : 'notam-quantity'}>{option.minimums}</p>
          {option.climb && <p className="notam-climb"><span className="notam-field-label">Minimum climb:</span>{' '}
            <span><span className="notam-quantity">{option.climb.gradient} ft/NM</span>{' '}
              <span className="notam-climb-to">to <span className="notam-quantity">{option.climb.altitude}</span></span></span></p>}
          {option.then?.map((climb, j) => <p className="notam-climb" key={j}><span className="notam-field-label">Then minimum climb:</span>{' '}
            <span><span className="notam-quantity">{climb.gradient} ft/NM</span>{' '}
              <span className="notam-climb-to">to <span className="notam-quantity">{climb.altitude}</span></span></span></p>)}
          {option.condition && <p>{option.condition}</p>}
        </div>
      </div>)}
      {block.reference && <p className="notam-body-context">{block.reference}</p>}
    </div>;
  if (block.kind === 'minima') return <div className="notam-minima">
      {block.context && <p className="notam-body-context">{block.context}</p>}
      <p className="notam-block-title">{block.scope}</p>
      <div className="notam-minima-rows">{block.rows.map((row, j) => <div className="notam-minimum-row" key={j}>
        <dl>{row.values.map((value, k) => <div key={k}>
          <dt>{value.label.startsWith('Visibility') ? <><abbr title="Visibility">Vis</abbr>{value.label.slice('Visibility'.length)}</> : value.label}</dt>
          <dd>{value.value === 'NA' ? 'Not authorized' : value.value}</dd>
        </div>)}</dl>
        {row.categories && <span className="notam-categories">{row.categories}</span>}
      </div>)}</div>
      {block.condition && <p className="notam-minimum-condition">{block.condition}</p>}
    </div>;
  if (block.kind === 'instruction') return <div className="notam-instruction"><p className="notam-block-title">{block.label}</p><p className="notam-text">{block.text}</p></div>;
  if (block.kind === 'heading') return <div className="notam-body-title">
    {context && <p className="notam-body-context">{context}</p>}
    <p className="notam-procedure-title">{block.text}</p>{block.detail && <p className="notam-amendment">{block.detail}</p>}
  </div>;
  return <p className={block.kind === 'context' ? 'notam-body-context' : 'notam-text'}>{block.text}</p>;
}
function NotamEntry({ record, now, reason, charted }: { record: NotamRecord; now: number; reason?: string; charted: boolean }) {
  const parsed = useMemo(() => parseNotam(record), [record]);
  const flairs = useMemo(() => notamFlairs(parsed), [parsed]);
  const interpretationNotes = useMemo(() => notamInterpretationNotes(parsed), [parsed]);
  const graphical = useMemo(() => charted ? chartedNotamPresentation(record) : undefined, [record, charted]);
  const presentation = useMemo(() => graphical?.presentation ?? presentNotam(record), [record, graphical]);
  const validity = notamValidity(record, now);
  const endKind = notamEndKind(record);
  const translations = record.translations.filter(translation => translation.text.trim());
  const originals = translations.filter(translation => translation.type === 'LOCAL_FORMAT');
  const body = record.text.replace(/\s+/g, ' ').trim();
  // Compare complete words after whitespace folding; display the supplied text unchanged.
  const showSourceBody = !originals.length || !!body && !originals.some(translation =>
    ` ${translation.text.replace(/\s+/g, ' ').trim()} `.includes(` ${body} `));
  return <article className="notam-entry">
    <div className="notam-entry-heading"><strong>{classification(record)} · {displayNumber(record)}</strong>
      <span>{record.locations.join(', ') || record.icaoLocations.join(', ')}</span></div>
    <div className="notam-flairs">{flairs.map(flair => <span key={flair.label} className={`notam-flair--${flair.tone}`} title={flair.evidence.map(source => source.text).join('\n')}>{flair.label}</span>)}
      {interpretationNotes.map(note => <span key={note.label} className="notam-flair--caution" title={note.detail}>{note.label}</span>)}
      {validity !== 'within interval' && validity !== 'upcoming' && <span className={validity.startsWith('check') ? 'notam-flair--caution' : 'notam-flair--neutral'}>
        {validity.replace(/\b[a-z]/g, letter => letter.toUpperCase())}</span>}</div>
    {reason && <p className="notam-match-reason">{reason}</p>}
    {presentation.blocks.length > 0 && <NotamBody blocks={presentation.blocks} />}
    {graphical && <p className="notam-chart-note">{graphical.note}</p>}
    <div className="notam-validity">
      <div><span className="notam-validity-label">From</span>{' '}<span>{formatTimestampPair(record.startsAt, { now, primary: 'local' })}</span></div>
      <div><span className="notam-validity-label">Until</span>{' '}<span>{endKind === 'permanent' ? 'Permanent'
        : `${formatTimestampPair(record.endsAt, { now, primary: 'local' })}${endKind === 'estimated' ? ' (estimated)' : endKind === 'unknown' ? ' (unconfirmed)' : ''}`}</span></div>
    </div>
    {record.schedule && <p className="notam-text">Schedule: {record.schedule}</p>}
    <details className="notam-raw"><summary>Show raw</summary>
      {translations.map((translation, i) => <div key={i}>
        <strong>{translation.type === 'LOCAL_FORMAT' ? 'Original NOTAM' : translation.type || 'Source translation'}</strong>
        <pre>{translation.text}</pre></div>)}
      {!originals.length && <p>Original NOTAM unavailable. Source body shown below.</p>}
      {showSourceBody && <><strong>Source body</strong><pre>{body ? record.text : 'No source body supplied.'}</pre></>}
      <p>Updated {formatTimestamp(record.updatedAt)}</p>
    </details>
  </article>;
}
type NotamListEntry = { record: NotamRecord; reason?: string; outcome?: PlateNotamMatch['outcome'] };
export function NotamList({ entries, now, charted }: { entries: readonly NotamListEntry[]; now: number; charted?: ReadonlySet<string> | undefined }) {
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
    <NotamEntry key={`${record.id}:${record.revision}`} record={record} now={now} charted={charted?.has(notamChartKey(record)) ?? false} {...(reason ? { reason } : {})} />);
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
  const parsed = useMemo(() => records.map(record => ({ record, parsed: parseNotam(record) }))
    .sort((a, b) => airportNotamPriority(a.parsed) - airportNotamPriority(b.parsed)), [records]);
  const subjects = [...new Set(parsed.map(p => p.parsed.subject ?? 'Other'))].sort();
  const shown = useMemo(() => parsed.filter(({ record, parsed }) => (filter === 'all' || (filter === 'other' ? !['D', 'FDC'].includes(classification(record))
    : classification(record) === filter)) && (subject === 'all' || (parsed.subject ?? 'Other') === subject) &&
    `${parsed.body} ${presentNotam(record).searchText} ${record.number} ${record.translations.map(t => t.text).join(' ')}`.toUpperCase().includes(search.toUpperCase())), [parsed, filter, subject, search]);
  const charted = useChartPreview(api, shown, active && view.visiblePage);
  return <section className="airport-notams" aria-label="Airport NOTAMs">
    <SourceStatus view={view} />
    <NotamSourceIssues issues={view.snapshot?.issues ?? []} />
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
    <NotamList entries={shown} now={view.now} charted={charted} />
    {view.snapshot && !shown.length && <p className="notam-list-status">{records.length ? 'No notices match these filters.' : 'No retained notices.'}</p>}
  </section>;
}
/** Rows and the collapsed reader use exactly the same assurance qualifiers. */
function plateMatchLabel(view: View, result: ReturnType<typeof matchPlateNotams>): string {
  if (!view.snapshot) return view.entry?.loading ? 'Checking…' : 'Unavailable';
  const review = result.matches.filter(m => m.outcome === 'review').length;
  const labels = [`${result.matches.length} matched`];
  if (review) labels.push(`${review} review`);
  if (result.unresolved) labels.push('Interpretation limited');
  if (view.snapshot.issues?.length) labels.push('Source data needs review');
  else if (!view.complete) labels.push('Coverage incomplete');
  if (!view.online) labels.push('Offline');
  if (view.entry?.error) labels.push('Refresh failed');
  if (!view.staging) {
    if (!view.fresh) labels.push('Stale');
    if (view.snapshot.feed.state === 'degraded' && view.snapshot.feed.error !== 'unresolved-records') labels.push('Feed degraded');
  }
  return labels.join(' · ');
}
export function PlateNotamCount({ api, context, active }: { api: NotamsApi; context: PlateNoticeContext; active: boolean }) {
  const view = useAirportNotams(api, context.status === 'resolved' ? context.airport : undefined, active);
  const result = useMemo(() => matchPlateNotams(currentRecords(view.snapshot?.records ?? [], view.now), context), [view.snapshot, view.now, context]);
  if (context.status !== 'resolved') return null;
  const count = result.matches.length, sourceIssues = view.snapshot?.issues?.length ?? 0;
  return <small className={`plate-notam-count${count || sourceIssues || result.unresolved ? ' has-notams' : ''}`}>NOTAM · {view.snapshot
    ? plateMatchLabel(view, result)
    : view.entry?.loading ? 'Checking…' : 'Unavailable'}</small>;
}
export function PlateNotams({ api, context, active, retryCatalog }: {
  api: NotamsApi; context: PlateNoticeContext; active: boolean; retryCatalog?: (() => void) | undefined;
}) {
  const view = useAirportNotams(api, context.status === 'resolved' ? context.airport : undefined, active);
  const [openKey, setOpenKey] = useState<string>(), id = useId();
  const open = openKey === context.key;
  const result = useMemo(() => matchPlateNotams(currentRecords(view.snapshot?.records ?? [], view.now), context), [view.snapshot, view.now, context]);
  const charted = useChartPreview(api, result.matches, active && open && view.visiblePage && context.status !== 'not-procedure');
  if (context.status === 'not-procedure') return null;
  const count = result.matches.length, sourceIssues = view.snapshot?.issues?.length ?? 0;
  const matchedIds = new Set(result.matches.map(m => m.record.id));
  const unmatched = result.unresolvedNotices.filter(record => !matchedIds.has(record.id));
  const label = context.status === 'loading' ? 'Loading plate context…' : !result.available ? 'Matching unavailable' : !view.snapshot ? view.entry?.loading ? 'Checking…' : 'Unavailable'
    : plateMatchLabel(view, result);
  return <section className={`plate-notams${count || sourceIssues || result.unresolved ? ' has-notams' : ''}`} aria-label="Plate NOTAMs">
    <button className="ui-button plate-notam-toggle" type="button" aria-expanded={open} aria-controls={id}
      onClick={() => setOpenKey(open ? undefined : context.key)}><span>NOTAM · {label}</span><span aria-hidden="true">{open ? '▴' : '▾'}</span></button>
    {open && <div id={id} className="plate-notams-list panel-scroll" role="region" aria-label="Notices for displayed plate" tabIndex={0}>
      {!result.available ? context.status === 'loading' ? <LoadingPlaceholder label="Loading plate context…" rows={1} />
        : retryCatalog ? <div className="notam-recovery"><p className="notam-list-status">The plate catalog could not be loaded. Matching is unavailable.</p>
          <button type="button" className="ui-button ui-button--compact" onClick={retryCatalog}>Retry plate catalog</button></div>
          : <p className="notam-list-status">This page’s airport and procedure could not be established from its edition. Reopen an indexed IAP, SID or STAR from Plates.</p> : <>
        <strong className="plate-notams-heading">{context.airport?.icaoId ?? context.airport?.faaId} · {context.procedure?.name}</strong>
        <div className="notam-source-row"><SourceStatus view={view} /><RefreshNotams view={view} api={api} /></div>
        <NotamSourceIssues issues={view.snapshot?.issues ?? []} />
        <NotamList entries={result.matches} now={view.now} charted={charted} />
        {!count && <p className="notam-list-status">No matches in the retained notices.</p>}
        {result.unresolved > 0 && <p className="notam-list-status">{result.unresolved} notice(s) have unresolved interpretation.</p>}
        {unmatched.length > 0 && <details className="notam-raw"><summary>Review unmatched notices ({unmatched.length})</summary>
          <p className="notam-list-status">Applicability to this plate could not be established. Review the retained source before relying on the match count.</p>
          <NotamList entries={unmatched.map(record => ({ record }))} now={view.now} />
        </details>}
      </>}
    </div>}
  </section>;
}
