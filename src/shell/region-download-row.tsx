import { formatDate } from '../core/format/time';
import { downloadBytes, type Download, type DownloadPlan } from '../offline/downloads';
import { formatBytes } from '../offline/storage';
import { presentDownload, type RegionOperation } from './download-presentation';
import type { RegionDownloadEntry } from './region-downloads';

export type RegionDownloadRowProps = {
  region: RegionDownloadEntry;
  details: 'loading' | 'ready' | 'unavailable';
  pending: RegionOperation | undefined;
  error: string | undefined;
  busy: boolean;
  canUpdate: boolean;
  onStart: (plan: DownloadPlan) => void;
  onUpdate: (plan: DownloadPlan) => void;
  onPause: (id: string) => void;
  onRemove: (job: Download) => void;
};

export function RegionDownloadRow({ region, details, pending, error, busy, canUpdate, onStart, onUpdate, onPause, onRemove }: RegionDownloadRowProps) {
  const { plan, job, active, current, problem } = region;
  const display = job ?? plan;
  const view = presentDownload(job, pending);
  const running = view.action.kind === 'pause';
  const updateReady = current && details === 'ready' && !problem && canUpdate && plan.revision >= display.revision;
  const message = error ?? job?.error ?? (!job ? problem : undefined);
  const knownSize = Boolean(job || details === 'ready' && !problem);
  const size = knownSize
    ? job?.state === 'complete' ? formatBytes(job.completedBytes) : downloadSize(display)
    : details === 'unavailable' || problem ? 'Size unavailable' : 'Loading size…';

  return <article className={`region-row${job ? ' download-card' : ''}${running || pending ? ' is-active' : ''}`}
    data-region-id={display.regionId} data-revision={display.revision}
    aria-label={`${display.title}, FAA cycle ${formatDate(display.revision)}`}>
    <div className="region-row-heading">
      <h4>{plan.title}</h4>
      <span role="status">{view.status && <span className={`offline-tag is-${job?.state ?? 'preparing'}`}>
        {view.status}
      </span>}</span>
    </div>
    <div className="region-row-summary">
      <p>Cycle {formatDate(display.revision)} · {size}
        {knownSize && ` · ${display.files.length.toLocaleString()} ${display.files.length === 1 ? 'file' : 'files'}`}</p>
      {job && current && plan.revision > display.revision && <p>New cycle available: {formatDate(plan.revision)}.</p>}
      {active && job && !job.completedAt && job.state !== 'complete' && <p>
        Saved cycle {formatDate(active.revision)} stays selected until this update finishes.
      </p>}
      <div className="download-actions">
        <button className="ui-button" type="button" disabled={running ? view.action.disabled : busy || (!job && !updateReady)}
          onClick={() => running ? onPause(display.id) : job ? onStart(job) : onUpdate(plan)}>{view.action.label}</button>
        {job && !running && <>
          <button className="ui-button" type="button" disabled={busy || !updateReady}
            onClick={() => onUpdate(display)}>Update to latest</button>
          <button className="ui-button" type="button" disabled={busy} onClick={() => onRemove(job)}>Remove</button>
        </>}
      </div>
    </div>
    {view.progress && <div className="region-progress">
      <progress aria-label={`${display.title} ${formatDate(display.revision)} ${view.progress.label} progress`}
        value={view.progress.value} max={display.files.length || 1} />
      <p>{view.progress.message}</p>
    </div>}
    {message && <p className="settings-error" role="alert">{message}</p>}
    {job && !job.terrain && <p>Terrain is not included in this download. Update to latest to include available terrain.</p>}
  </article>;
}

function downloadSize(plan: DownloadPlan): string {
  return `${plan.files.some(file => file.kind === 'faa-pdf') || (plan.terrain && !plan.files.some(file => file.kind === 'terrain'))
    ? 'At least ' : ''}${formatBytes(downloadBytes(plan))}`;
}
