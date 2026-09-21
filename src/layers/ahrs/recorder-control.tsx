import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useBackDismiss } from '../../core/ui/pwa-back';
import { createPortal } from 'react-dom';
import { formatTimestamp } from '../../core/format/time';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import type { AhrsLayer } from './layer';
import { recordingStorage, type RecordingExportFormat, type RecordingInfo } from './recording-storage';
import { downloadRecording } from './recording-download';
import '../../core/ui/confirmation-dialog.css';
import './recorder.css';

const bytes = (size: number) => size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const duration = (info: RecordingInfo) => {
  const seconds = Math.max(0, Math.floor((info.updatedAt - info.startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export function AhrsRecorderControl({ layer, visible, onStart }: {
  layer: AhrsLayer; visible: boolean; onStart(): Promise<void>;
}) {
  const state = useLayerSnapshot(layer.recorder);
  const [open, setOpen] = useState(false);
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<{ id: string; format: RecordingExportFormat } | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<RecordingInfo | null>(null);
  const [error, setError] = useState('');
  const deleted = useRef(new Set<string>());
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  useBackDismiss(open && visible, root, () => { setOpen(false); button.current?.focus(); });
  const id = useId();
  const running = state.phase === 'recording' || state.phase === 'starting';
  const busy = state.phase === 'starting' || state.phase === 'saving';
  useEffect(() => () => downloadController.current?.abort(), []);
  useEffect(() => { if (!visible) { setOpen(false); setConfirmation(null); } }, [visible]);
  useEffect(() => {
    if (!open || confirmation) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, confirmation]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    recordingStorage.list().then(values => { if (!cancelled) { setRecordings(values.filter(info => !deleted.current.has(info.id))); setError(''); } },
      () => { if (!cancelled) setError('Saved recordings could not be read.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, state.phase]);
  const saved = recordings.map(info => info.id === state.info?.id ? state.info : info);
  if (state.info && state.info.chunks > 0 && (running || busy) && !saved.some(info => info.id === state.info!.id)) saved.unshift(state.info);
  const download = async (info: RecordingInfo, format: RecordingExportFormat) => {
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading({ id: info.id, format }); setError('');
    try {
      await downloadRecording(info, format, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'The recording could not be downloaded.');
    } finally { downloadController.current = null; setDownloading(null); }
  };
  const remove = async (info: RecordingInfo) => {
    button.current?.focus();
    setDeleting(info.id); setError('');
    try {
      await layer.recorder.remove(info.id);
      deleted.current.add(info.id);
      setRecordings(values => values.filter(value => value.id !== info.id));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The recording could not be deleted.');
    } finally { setDeleting(null); }
  };
  return <div ref={root} className="ahrs-recorder">
    <button ref={button} type="button" className={`ahrs-header-button ahrs-recorder-button${running ? ' is-recording' : ''}${state.error ? ' has-error' : ''}`}
      aria-label={running ? 'Recording · open recorder' : state.error ? 'Recorder needs attention' : 'AHRS recorder'}
      title={running ? 'Recording' : 'Record AHRS'} aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>
      <svg width="26" height="16" viewBox="0 0 32 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" />
        {running ? <rect x="6.5" y="6.5" width="7" height="7" rx="1" fill="currentColor" />
          : <circle cx="10" cy="10" r="4" fill="currentColor" />}
        <path d="m23 8 3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
    {open && <div id={id} className="ahrs-recorder-menu" role="region" aria-label="AHRS recordings">
      <strong>AHRS recorder</strong>
      <p>Motion, GPS, attitude and uncertainty. Saved on this device.</p>
      <button type="button" className="ahrs-record-action" disabled={busy}
        onClick={() => { if (running) void layer.recorder.stop(); else void onStart(); }}>
        {state.phase === 'starting' ? 'Starting…' : state.phase === 'saving' ? 'Saving…' : running ? 'Stop recording' : 'Start recording'}
      </button>
      <p className="ahrs-recorder-status" role="status">{running
        ? 'Recording · keep ZLayer in the foreground.'
        : 'Start before calibration to capture the complete session.'}</p>
      {(state.error || error) && <p role="alert">{error || state.error}</p>}
      <h4>Saved recordings</h4>
      {downloading && <button type="button" onClick={() => downloadController.current?.abort()}>Cancel download</button>}
      {!saved.length && <p>{loading ? 'Loading…' : 'No recordings yet.'}</p>}
      <ul>{saved.map(info => <li key={info.id}>
        <div><time dateTime={new Date(info.startedAt).toISOString()}>{formatTimestamp(info.startedAt, { timeZone: 'local' })}</time>
          <small>{duration(info)} · {bytes(info.bytes)}{info.status === 'recording'
            ? info.id === state.info?.id && (running || busy) ? ' · Recording' : ' · Partial' : ''}</small></div>
        <div className="ahrs-recording-actions">
          <button type="button" disabled={downloading !== null || deleting !== null} onClick={() => { void download(info, 'gpx'); }}>
            {downloading?.id === info.id && downloading.format === 'gpx' ? 'Preparing…' : 'Download GPX'}
          </button>
          <button type="button" disabled={downloading !== null || deleting !== null}
            title="Download the detailed sensor recording (JSONL) for debugging"
            onClick={() => { void download(info, 'jsonl'); }}>
            {downloading?.id === info.id && downloading.format === 'jsonl' ? 'Preparing…' : 'Debug log'}
          </button>
          <button type="button" className="ahrs-recording-delete"
            disabled={downloading !== null || deleting !== null || info.id === state.info?.id && (running || busy)}
            title={info.id === state.info?.id && (running || busy) ? 'Stop recording before deleting it.' : 'Delete recording from this device'}
            onClick={() => setConfirmation(info)}>
            {deleting === info.id ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </li>)}</ul>
    </div>}
    {open && visible && confirmation && <RecordingDeleteDialog
      onCancel={() => setConfirmation(null)}
      onConfirm={() => { setConfirmation(null); void remove(confirmation); }} />}
  </div>;
}

function RecordingDeleteDialog({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    cancel.current?.focus();
    return () => element.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="confirmation-dialog" role="alertdialog"
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onCancel(); }}>
    <h2 id={`${id}-title`}>Delete recording?</h2>
    <p id={`${id}-description`}>This will permanently delete the recording from this device. This cannot be undone.</p>
    <div className="confirmation-actions">
      <button type="button" className="confirmation-primary"
        onClick={() => { dialog.current?.close(); onConfirm(); }}>Delete</button>
      <button ref={cancel} type="button" onClick={onCancel}>Cancel</button>
    </div>
  </dialog>, document.body);
}
