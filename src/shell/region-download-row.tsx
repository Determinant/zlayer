import { formatDate } from '../core/format/time';
import { downloadBytes, type Download, type DownloadPlan } from '../offline/downloads';
import { formatBytes } from '../offline/storage';
import { presentDownload, type RegionOperation } from './download-presentation';

export type RegionDownloadEntry = {
  plan: DownloadPlan;
  current: boolean;
  job: Download | undefined;
  problem: string | undefined;
};
export type RegionDownloadRowProps = {
  region: RegionDownloadEntry;
  details: 'loading' | 'ready' | 'unavailable';
  pending: RegionOperation | undefined;
  error: string | undefined;
  busy: boolean;
  onStart: (plan: DownloadPlan) => void;
  onPause: (id: string) => void;
  onRemove: (job: Download) => void;
};

export function RegionDownloadRow({ region, details, pending, error, busy, onStart, onPause, onRemove }: RegionDownloadRowProps) {
  const { plan, job, current, problem } = region;
  const display = job ?? plan;
  const view = presentDownload(job, pending);
  const running = view.action.kind === 'pause';
  const update = current && details === 'ready' && !problem && (!job || job.revision === plan.revision) ? plan : undefined;
  // Resume/retry uses the saved selection. Only Verify / update adopts a new plan.
  const primaryPlan = job?.state === 'complete' ? update ?? job : job ?? plan;
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
      <div className="download-actions">
        <button className="ui-button" type="button" disabled={running ? view.action.disabled : busy || (!job && !update)
          || (job?.state === 'complete' && current && details === 'loading')}
          onClick={() => running ? onPause(display.id) : onStart(primaryPlan)}>{view.action.label}</button>
        {job && !running && <>
          {job.state !== 'complete' && update && <button className="ui-button" type="button" disabled={busy}
            onClick={() => onStart(update)}>Verify / update</button>}
          <button className="ui-button" type="button" disabled={busy} onClick={() => onRemove(job)}>Remove</button>
        </>}
      </div>
    </div>
    {view.progress && <div className="region-progress">
      <progress aria-label={`${plan.title} ${formatDate(plan.revision)} ${view.progress.label} progress`}
        value={view.progress.value} max={display.files.length || 1} />
      <p>{view.progress.message}</p>
    </div>}
    {message && <p className="settings-error" role="alert">{message}</p>}
    {job && !job.terrain && <p>Terrain is not included in this older download. Use Verify / update to add it.</p>}
  </article>;
}

function downloadSize(plan: DownloadPlan): string {
  return `${plan.files.some(file => file.kind === 'faa-pdf') || (plan.terrain && !plan.files.some(file => file.kind === 'terrain'))
    ? 'At least ' : ''}${formatBytes(downloadBytes(plan))}`;
}
