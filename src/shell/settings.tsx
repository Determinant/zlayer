import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { formatDate } from '../core/format/time';
import { usePersistentState } from '../core/ui/use-persistent-state';
import { PersistentDetails } from '../core/ui/persistent-details';
import { ConfirmationDialog } from '../core/ui/confirmation-dialog';
import { isBoolean, isString } from '../core/storage/ui-state';
import type { ChartCatalog } from '../workspace/catalog/catalog';
import { createBrowserDownloads, removeUnsavedFiles } from '../offline/browser-downloads';
import { isDownloadActive, type DownloadPlan, type Download } from '../offline/downloads';
import { formatBytes, storageStatus, type StorageStatus } from '../offline/storage';
import { chartRegionPlans } from '../layers/charts';
import { cacheProcedureDocument, fetchOfflinePlateIndex, withRegionPlates, type OfflinePlateIndex } from '../layers/plates';
import { useOnline } from '../core/use-online';
import { SettingsLoading } from './settings-dialog';
import { RegionDownloadRow, type RegionDownloadEntry } from './region-download-row';
import type { RegionOperation } from './download-presentation';

export default function Settings({ catalog, open }: {
  catalog: ChartCatalog; open: boolean;
}) {
  const [downloads] = useState(() => createBrowserDownloads(file => cacheProcedureDocument({
    ...file, nativeUrl: file.url, pageIndex: 0, source: file.kind === 'faa-pdf' ? 'faa-individual' : 'combined-volume',
  })));
  const jobs = useSyncExternalStore(downloads.subscribe, downloads.snapshot, downloads.snapshot);
  const [storageTask, setStorageTask] = useState<'checking' | 'cleaning' | undefined>('checking');
  const loading = storageTask !== undefined;
  const [restored, setRestored] = useState(false);
  const [storage, setStorage] = useState<StorageStatus>();
  const [storageRequest, setStorageRequest] = useState<'idle' | 'pending' | 'denied'>('idle');
  const [error, setError] = useState<string>();
  const [query, setQuery] = usePersistentState('settings-region-query', '', isString);
  const [savedOnly, setSavedOnly] = usePersistentState('settings-saved-regions-only', false, isBoolean);
  const [operation, setOperation] = useState<{ plan: DownloadPlan; action: RegionOperation }>();
  const [regionError, setRegionError] = useState<{ id: string; message: string }>();
  const [confirmation, setConfirmation] = useState<{ kind: 'region'; job: Download } | { kind: 'temporary' }>();
  const [loadedIndex, setLoadedIndex] = useState<{ catalog: ChartCatalog; index: OfflinePlateIndex }>();
  const plateIndex = loadedIndex?.catalog === catalog ? loadedIndex.index : undefined;
  const [plateError, setPlateError] = useState<string>();
  const [plateAttempt, setPlateAttempt] = useState(0);
  const online = useOnline();
  const plans = useMemo(() => chartRegionPlans(catalog, location.href).map(({ region, plan }) => {
    if (!plateIndex) return { plan, problem: undefined };
    try {
      const complete = { ...plan, ...(catalog.terrain ? { terrain: true } : {}) };
      return { plan: withRegionPlates(complete, region, plateIndex, catalog, location.href), problem: undefined };
    } catch (error) { return { plan, problem: error instanceof Error ? error.message : 'Plate coverage unavailable' }; }
  }), [catalog, plateIndex]);
  const active = Boolean(operation) || jobs.some(isDownloadActive);
  const rows = useMemo(() => {
    const entries = new Map<string, RegionDownloadEntry>(plans.map(({ plan, problem }) => [plan.id, {
      plan, problem, current: true, job: undefined,
    }]));
    for (const job of jobs) {
      const entry = entries.get(job.id);
      if (entry) entry.job = job;
      else entries.set(job.id, { plan: job, problem: undefined, current: false, job });
    }
    if (operation && !entries.has(operation.plan.id)) {
      entries.set(operation.plan.id, { plan: operation.plan, problem: undefined, current: false, job: undefined });
    }
    // Keep a region in the same position as it starts, pauses, and completes.
    return [...entries.values()].sort((a, b) => a.plan.title.localeCompare(b.plan.title)
      || b.plan.revision.localeCompare(a.plan.revision) || a.plan.id.localeCompare(b.plan.id));
  }, [plans, jobs, operation]);
  const visibleRows = rows.filter(({ plan, job }) => (!savedOnly || job || operation?.plan.id === plan.id)
    && plan.title.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    let cancelled = false;
    setLoadedIndex(undefined);
    setPlateError(undefined);
    void fetchOfflinePlateIndex(catalog).then(index => { if (!cancelled) setLoadedIndex({ catalog, index }); })
      .catch(error => { if (!cancelled) setPlateError(String(error)); });
    return () => { cancelled = true; };
  }, [catalog, plateAttempt]);

  const perform = (operation: () => Promise<unknown>) => {
    setError(undefined);
    void operation().catch(reason => setError(reason instanceof Error ? reason.message : 'Offline storage unavailable'));
  };
  useEffect(() => {
    if (!open) { setConfirmation(undefined); return; }
    let cancelled = false;
    setError(undefined);
    setStorageTask('checking');
    void downloads.restore().catch(reason => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) { setStorageTask(undefined); setRestored(true); } });
    void storageStatus().then(value => { if (!cancelled) setStorage(value); });
    return () => { cancelled = true; };
  }, [open, downloads]);

  const refreshStorage = async (requestPersistence = false) => {
    const status = await storageStatus(requestPersistence);
    setStorage(status);
    return status;
  };
  const performStorage = (task: 'checking' | 'cleaning', work: () => Promise<void>) => perform(async () => {
    setStorageTask(task);
    try { await work(); await refreshStorage(); }
    finally { setStorageTask(undefined); }
  });
  const performRegion = (plan: DownloadPlan, action: RegionOperation, work: () => Promise<void>) => {
    setRegionError(undefined);
    setOperation({ plan, action });
    void work().then(() => refreshStorage()).catch(reason => setRegionError({ id: plan.id,
      message: reason instanceof Error ? reason.message : 'Download unavailable',
    })).finally(() => setOperation(undefined));
  };
  const start = (plan: DownloadPlan) => performRegion(plan, 'start', async () => {
    await refreshStorage(true);
    await downloads.start(plan);
  });
  const confirmRemoval = () => {
    if (!confirmation || loading || active) return;
    setConfirmation(undefined);
    if (confirmation.kind === 'region') {
      performRegion(confirmation.job, 'remove', () => downloads.remove(confirmation.job.id));
    } else {
      performStorage('cleaning', removeUnsavedFiles);
    }
  };

  const requestStorageProtection = () => perform(async () => {
    setStorageRequest('pending');
    try {
      const status = await refreshStorage(true);
      setStorageRequest(status.persistent ? 'idle' : 'denied');
    } catch (reason) {
      setStorageRequest('idle');
      throw reason;
    }
  });

  const ready = restored && Boolean(storage);
  return <>
    {!ready && <SettingsLoading />}
    <div className="settings-downloads content-reveal" hidden={!ready}>
      <section className="storage-summary" aria-labelledby="storage-title">
        <div className="settings-section-heading"><h3 id="storage-title">App storage</h3>
          <span className="offline-tag">{online ? 'Online' : 'Offline'}</span></div>
        <strong>{storage?.usage !== undefined ? `${formatBytes(storage.usage)} used` : 'Storage usage unavailable'}
          {storage?.usage !== undefined && storage.quota !== undefined && ` of an estimated ${formatBytes(storage.quota)}`}</strong>
        {storage?.quota !== undefined && <progress aria-label="App storage usage" value={storage.usage ?? 0} max={storage.quota || 1} />}
        <div className="storage-guidance">
          <h4>Keep downloads available offline</h4>
          {!storage?.persistent && <p>Downloads are saved on this device. Your browser may remove them to free up space or after inactivity.
            {' '}Storage protection asks the browser to keep them during automatic cleanup.</p>}
          <p><strong>iPhone and iPad:</strong> Add ZLayer to your Home Screen, then open it there to download regions.
            The app stores downloads separately from Safari and avoids Safari’s inactivity cleanup.</p>
          {!storage?.persistent && <p><strong>Android:</strong> Use Chrome or the installed app.
            Installing ZLayer can help Chrome grant storage protection.</p>}
          {!storage?.persistent && storage?.persistenceSupported && <button type="button"
            disabled={storageRequest === 'pending'} onClick={requestStorageProtection}>
            {storageRequest === 'pending' ? 'Requesting protection…'
              : storageRequest === 'denied' ? 'Try storage protection again' : 'Request storage protection'}</button>}
          <div className={`storage-request-result${storage?.persistent ? ' is-protected' : ''}`} role="status">
            <strong>{storageRequest === 'pending' ? 'Waiting for the browser…'
              : storage?.persistent ? 'Downloads protected from browser cleanup'
                : !storage?.persistenceSupported ? 'Storage protection unavailable in this browser'
                  : storageRequest === 'denied' ? 'The browser did not grant protection' : 'Storage protection not granted yet'}</strong>
            {storageRequest === 'pending' ? <p>Your browser may ask you to allow storage protection.</p>
              : storage?.persistent ? <p>Downloads are saved on this device.
                Clearing site data or removing the app can still erase them.</p>
                : <>
                  {storageRequest === 'denied' && <p>You can try again later. Installing ZLayer may help your browser grant protection.</p>}
                  <p>You can still download and use regions offline. If downloads are removed,
                    reconnect to the internet and download them again.</p>
                </>}
          </div>
          {!storage?.persistent && <p>Clearing site data or removing the app can erase downloads, even with storage protection.</p>}
        </div>

        <PersistentDetails storageKey="settings-storage-open" className="storage-details">
          <summary>Temporary files and storage limits</summary>
          <p>Charts and plates you view without downloading a region are stored as temporary files.
            Remove them to free up space; you’ll need an internet connection to view them again.</p>
          <p>This cleanup keeps saved regions, paused downloads, previous versions needed during updates, and reference data.</p>
          <button type="button" disabled={loading || active}
            onClick={() => setConfirmation({ kind: 'temporary' })}>Remove temporary charts and plates</button>
          <p>Your browser manages storage, including in the installed app.
            The storage limit is an estimate; your device may have less free space.
            Storage protection does not increase the limit or reserve space.</p>
        </PersistentDetails>
      </section>

      {error && <p className="settings-error" role="alert">{error}</p>}
      <section aria-labelledby="regions-title">
        <div className="settings-section-heading"><h3 id="regions-title">Offline regions</h3>
          <button type="button" disabled={loading || active}
            onClick={() => performStorage('checking', () => downloads.restore())}>Check saved files</button></div>
        <p>Save a state or territory for offline use. Keep ZLayer open while downloading.
          You can pause and resume here.</p>
        <p className="region-cycle">New downloads use FAA cycle {formatDate(catalog.revision)}.</p>
        <PersistentDetails storageKey="settings-region-details-open" className="region-details">
          <summary>Coverage, sizes and FAA cycles</summary>
          <p>Includes all published VFR and IFR low charts at every zoom, navigation data,
            published terrain at every supported detail level, all applicable plates and Chart Supplements.
            Published approach entries and fixes, preferred/TEC routes and route history
            are included for offline planning when available.</p>
          <p>Terrain size is calculated while preparing the download. Sizes include charts and full books. Some FAA plate sizes are known only after
            downloading, so their regions show a minimum size until saved. Overlapping
            regions share files; navigation data and indexes add storage once.</p>
          <p>Saved editions are used in their regions, even online. The FAA data cycle controls
            browsing elsewhere and new downloads. Different cycles are saved separately.</p>
          <p>Resume continues the original download. Verify / update checks saved files and
            downloads any changes for that same cycle. Check saved files only checks local storage.</p>
          <p>Saved means the region’s files and required data are available offline.
            The final check confirms storage availability, not whether the FAA cycle is current. Basemap tiles
            are saved only as viewed and are not included. Cached weather may be outdated;
            check its timestamp.</p>
        </PersistentDetails>
        {!catalog.terrain && <p role="status">Terrain downloads are not available from this feed. These downloads include charts and plates;
          use Verify / update to add terrain after it becomes available.</p>}
        {loading && <p role="status">{storageTask === 'cleaning' ? 'Removing temporary charts and plates…' : 'Checking saved files…'}</p>}
        {!plateIndex && !plateError && <p role="status">Loading region details…</p>}
        {plateError && <p className="settings-error" role="alert">{plateError}{' '}
          <button type="button" onClick={() => setPlateAttempt(value => value + 1)}>Try again</button></p>}
        <div className="region-filters">
          <label>Find a state or territory<input value={query} onChange={event => setQuery(event.target.value)} placeholder="California, CA, Guam…" type="search" /></label>
          <div className="region-filter-options" role="group" aria-label="Regions to show">
            <button type="button" aria-pressed={!savedOnly} onClick={() => setSavedOnly(false)}>All regions</button>
            <button type="button" aria-pressed={savedOnly} onClick={() => setSavedOnly(true)}>My downloads</button>
          </div>
        </div>
        {!catalog.chartPackages && <p role="status">Regional downloads are unavailable for this cycle. You can still use cached charts.</p>}
        {catalog.chartPackages && plans.length === 0 && <p role="status">New regional downloads are unavailable. Reload online to try again. Saved downloads remain listed below.</p>}
        {visibleRows.length === 0 && <p role="status">{savedOnly && jobs.length === 0
          ? 'No region downloads yet. Choose All regions to get started.' : 'No regions match your search.'}</p>}
        <div className="region-list">
          {visibleRows.map(region => <RegionDownloadRow key={region.plan.id} region={region}
            details={plateIndex ? 'ready' : plateError ? 'unavailable' : 'loading'}
            pending={operation?.plan.id === region.plan.id ? operation.action : undefined}
            error={regionError?.id === region.plan.id ? regionError.message : undefined}
            busy={loading || active} onStart={start} onPause={id => downloads.pause(id)}
            onRemove={job => setConfirmation({ kind: 'region', job })} />)}
        </div>
      </section>
    </div>
    {open && confirmation && <ConfirmationDialog
      title={confirmation.kind === 'region'
        ? `Remove ${confirmation.job.title} (cycle ${formatDate(confirmation.job.revision)})?`
        : 'Remove temporary charts and plates?'}
      description={confirmation.kind === 'region'
        ? 'Files used by other saved regions will stay.'
        : 'This keeps saved regions, paused downloads, previous versions needed during updates, and reference data. Removed files will need an internet connection to download again.'}
      confirmLabel="Remove" disabled={loading || active}
      onConfirm={confirmRemoval} onCancel={() => setConfirmation(undefined)} />}
  </>;
}
