import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { formatDate } from '../core/format/time';
import { usePersistentState } from '../core/ui/use-persistent-state';
import { PersistentDetails } from '../core/ui/persistent-details';
import { ConfirmationDialog } from '../core/ui/confirmation-dialog';
import { isBoolean, isString } from '../core/storage/ui-state';
import type { CatalogResponse } from '@zlayer/contracts';
import { createBrowserDownloads, removeUnsavedFiles } from '../offline/browser-downloads';
import { isDownloadActive, type DownloadPlan, type Download } from '../offline/downloads';
import { formatBytes, storageStatus, type StorageStatus } from '../offline/storage';
import { chartRegionPlans } from '../layers/charts';
import { cacheProcedureDocument, withRegionPlates, type OfflinePlateIndex } from '../layers/plates';
import { RegionDownloadRow } from './region-download-row';
import { regionDownloadEntries } from './region-downloads';
import { useDownloadCatalog } from './use-download-catalog';
import { regionKey } from '../offline/region-selection';
import { OFFLINE_REGIONS } from '../offline/regions';
import { observeOfflineInventory } from '../offline/inventory-events';
import type { RegionOperation } from './download-presentation';

export default function Settings({ catalog: browsing, open }: {
  catalog: CatalogResponse; open: boolean;
}) {
  const latest = useDownloadCatalog(browsing, open);
  const catalog = latest.catalog;
  const [downloads] = useState(() => createBrowserDownloads(file => cacheProcedureDocument({
    ...file, nativeUrl: file.url, pageIndex: 0, source: file.kind === 'faa-pdf' ? 'faa-individual' : 'combined-volume',
  })));
  const jobs = useSyncExternalStore(downloads.subscribe, downloads.snapshot, downloads.snapshot);
  const [storageTask, setStorageTask] = useState<'checking' | 'cleaning' | undefined>('checking');
  const loading = storageTask !== undefined;
  const [storage, setStorage] = useState<StorageStatus>();
  const [storagePending, setStoragePending] = useState(true);
  const [storageRequest, setStorageRequest] = useState<'idle' | 'pending' | 'denied'>('idle');
  const [error, setError] = useState<string>();
  const [query, setQuery] = usePersistentState('settings-region-query', '', isString);
  const [savedOnly, setSavedOnly] = usePersistentState('settings-saved-regions-only', false, isBoolean);
  const [operation, setOperation] = useState<{ plan: DownloadPlan; action: RegionOperation }>();
  const [regionError, setRegionError] = useState<{ id: string; message: string }>();
  const [confirmation, setConfirmation] = useState<{ kind: 'region'; job: Download } | { kind: 'temporary' }>();
  const plateIndex = latest.index;
  const online = latest.online;
  const chartPlans = useMemo(() => chartRegionPlans(catalog, location.href), [catalog]);
  const [prepared, setPrepared] = useState<{
    catalog: CatalogResponse; index: OfflinePlateIndex;
    plans: Array<{ plan: DownloadPlan; problem: string | undefined }>;
  }>();
  const plansReady = Boolean(plateIndex && prepared?.catalog === catalog && prepared.index === plateIndex);
  const plans = useMemo(() => plansReady ? prepared!.plans
    : chartPlans.map(({ plan }) => ({ plan, problem: undefined })), [chartPlans, plansReady, prepared]);
  useEffect(() => {
    if (!open || !plateIndex || prepared?.catalog === catalog && prepared.index === plateIndex) return;
    let cancelled = false;
    const prepare = async () => {
      const plans: Array<{ plan: DownloadPlan; problem: string | undefined }> = [];
      for (const { region, plan } of chartPlans) {
        // National airport/book indexes are expensive on phones. Yield between
        // regions rather than preparing every state's plan in a React render.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (cancelled) return;
        try {
          const complete = { ...plan, ...(catalog.terrain ? { terrain: true } : {}), ...(catalog.glide ? { glide: true } : {}) };
          plans.push({ plan: withRegionPlates(complete, region, plateIndex, catalog, location.href), problem: undefined });
        } catch (error) {
          plans.push({ plan, problem: error instanceof Error ? error.message : 'Plate coverage unavailable' });
        }
      }
      if (!cancelled) setPrepared({ catalog, index: plateIndex, plans });
    };
    void prepare();
    return () => { cancelled = true; };
  }, [open, catalog, chartPlans, plateIndex, prepared]);
  const active = Boolean(operation) || jobs.some(isDownloadActive);
  const rows = useMemo(() => regionDownloadEntries(plans, jobs), [plans, jobs]);
  const operationKey = operation ? regionKey(operation.plan) : undefined;
  const visibleRows = rows.filter(({ key, plan, job }) => (!savedOnly || job || operationKey === key)
    && plan.title.toLowerCase().includes(query.trim().toLowerCase()));

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
      .finally(() => { if (!cancelled) setStorageTask(undefined); });
    setStoragePending(true);
    void storageStatus().then(value => { if (!cancelled) setStorage(value); })
      .catch(reason => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setStoragePending(false); });
    return () => { cancelled = true; };
  }, [open, downloads]);
  useEffect(() => {
    if (!open) return;
    return observeOfflineInventory(() => {
      void downloads.restore(true).catch(reason => setError(String(reason)));
    });
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
    void work().then(() => refreshStorage()).catch(reason => setRegionError({ id: regionKey(plan),
      message: reason instanceof Error ? reason.message : 'Download unavailable',
    })).finally(() => setOperation(undefined));
  };
  const start = (plan: DownloadPlan) => performRegion(plan, 'start', async () => {
    await refreshStorage(true);
    await downloads.start(plan);
  });
  const update = (plan: DownloadPlan) => performRegion(plan, 'update', async () => {
    if (!online) throw new Error('Reconnect to check for the latest cycle. Saved files can still be verified offline.');
    // Recheck at the gesture too: an open PWA can cross 0901Z or receive a correction.
    const { catalog: current, index } = await latest.refresh();
    if (current.revision < plan.revision) throw new Error('A newer saved cycle is already selected; no downgrade was made.');
    const region = OFFLINE_REGIONS.find(region => region.id === plan.regionId);
    const candidate = region && chartRegionPlans(current, location.href, [region])
      .find(({ plan: next }) => regionKey(next) === regionKey(plan));
    if (!candidate) throw new Error('This region is not available in the latest feed. The saved edition is kept.');
    const complete = withRegionPlates({ ...candidate.plan, ...(current.terrain ? { terrain: true } : {}), ...(current.glide ? { glide: true } : {}) },
      candidate.region, index, current, location.href);
    await refreshStorage(true);
    await downloads.start(complete);
  });
  const confirmRemoval = () => {
    if (!confirmation || loading || active) return;
    setConfirmation(undefined);
    if (confirmation.kind === 'region') {
      performRegion(confirmation.job, 'remove', () => downloads.removeRegion(confirmation.job.id));
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

  return <>
    <div className="settings-downloads content-reveal">
      <section className="storage-summary" aria-labelledby="storage-title">
        <div className="settings-section-heading"><h3 id="storage-title">App storage</h3>
          <span className="offline-tag">{online ? 'Online' : 'Offline'}</span></div>
        <strong>{storage?.usage !== undefined ? `${formatBytes(storage.usage)} used`
          : storagePending ? 'Checking storage usage…' : 'Storage usage unavailable'}
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
          {!storage?.persistent && storage?.persistenceSupported && <button className="ui-button" type="button"
            disabled={storageRequest === 'pending'} onClick={requestStorageProtection}>
            {storageRequest === 'pending' ? 'Requesting protection…'
              : storageRequest === 'denied' ? 'Try storage protection again' : 'Request storage protection'}</button>}
          <div className={`storage-request-result${storage?.persistent ? ' is-protected' : ''}`} role="status">
            <strong>{storageRequest === 'pending' ? 'Waiting for the browser…'
              : !storage && storagePending ? 'Checking storage protection…'
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
          <p>Charts and plates you view without downloading a region, and recently viewed basemap tiles, are stored as temporary files.
            Remove them to free up space; you’ll need an internet connection to view them again.</p>
          <p>Basemap tiles expire after one day and may be removed sooner to limit storage. Region downloads do not include them.</p>
          <p>This cleanup keeps saved regions, paused downloads, previous versions needed during updates, files retained by open views, and reference data.</p>
          <button className="ui-button" type="button" disabled={loading || active}
            onClick={() => setConfirmation({ kind: 'temporary' })}>Remove temporary map files</button>
          <p>Your browser manages storage, including in the installed app.
            The storage limit is an estimate; your device may have less free space.
            Storage protection does not increase the limit or reserve space.</p>
        </PersistentDetails>
      </section>

      {error && <p className="settings-error" role="alert">{error}</p>}
      <section aria-labelledby="regions-title">
        <div className="settings-section-heading"><h3 id="regions-title">Offline regions</h3>
          <button className="ui-button" type="button" disabled={loading || active}
            onClick={() => performStorage('checking', () => downloads.restore())}>Check saved files</button></div>
        <p>Save a state or territory for offline use. Keep ZLayer open while downloading.
          You can pause and resume here.</p>
        <p className="region-cycle">{latest.checking || latest.error
          ? `Last loaded download cycle: ${formatDate(catalog.revision)}.`
          : `Latest available download cycle: ${formatDate(catalog.revision)}.`}</p>
        <button className="ui-button" type="button" disabled={loading || active || latest.checking || !online}
          onClick={() => { void latest.refresh().catch(() => {}); }}>{latest.checking ? 'Checking for updates…' : 'Check for updates'}</button>
        {latest.error && <p className="settings-error" role="status">{latest.error}</p>}
        <PersistentDetails storageKey="settings-region-details-open" className="region-details">
          <summary>Coverage, sizes and FAA cycles</summary>
          <p>Includes all published VFR and IFR low/high charts at every zoom, navigation data,
            published terrain at every supported detail level, all applicable plates and Chart Supplements.
            Published approach entries and fixes, preferred/TEC routes and route history
            are included for offline planning when available.</p>
          <p>Terrain size is calculated while preparing the download. Sizes include charts and full books. Some FAA plate sizes are known only after
            downloading, so their regions show a minimum size until saved. Overlapping
            regions share files; navigation data and indexes add storage once.</p>
          <p>Saved editions are used in their regions, even online. The FAA data cycle controls
            browsing elsewhere. Downloads and updates always check the latest effective cycle.</p>
          <p>Update to latest downloads the current cycle and any published corrections, reusing shared files.
            Your saved edition stays selected until the replacement is fully saved. Resume continues the original download.
            Verify saved files repairs that exact saved edition; Check saved files only checks local storage.</p>
          <p>Charts, navigation, plates and supplements can have different effective dates.
            Updates keep each product's published edition and reuse books or charts that remain effective.</p>
          <p>Saved means the region’s files and required data are available offline.
            The final check confirms storage availability, not whether the FAA cycle is current. Basemap tiles
            are saved only as viewed and are not included. Cached weather may be outdated;
            check its timestamp. Saved glide data covers the publisher’s prepared areas; a download does not add missing coverage.</p>
        </PersistentDetails>
        {!catalog.terrain && <p role="status">Terrain downloads are not available from this feed. These downloads include charts and plates;
          use Update to latest to add terrain after it becomes available.</p>}
        {loading && <p role="status">{storageTask === 'cleaning' ? 'Removing temporary map files…' : 'Checking saved files…'}</p>}
        {!plateIndex && !latest.error && <p role="status">Loading region details…</p>}
        {plateIndex && !plansReady && <p role="status">Preparing region details…</p>}
        <div className="region-filters">
          <label>Find a state or territory<input className="ui-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="California, CA, Guam…" type="search" /></label>
          <div className="region-filter-options" role="group" aria-label="Regions to show">
            <button className="ui-button" type="button" aria-pressed={!savedOnly} onClick={() => setSavedOnly(false)}>All regions</button>
            <button className="ui-button" type="button" aria-pressed={savedOnly} onClick={() => setSavedOnly(true)}>My downloads</button>
          </div>
        </div>
        {!catalog.chartPackages && <p role="status">Regional downloads are unavailable for this cycle. You can still use cached charts.</p>}
        {catalog.chartPackages && plans.length === 0 && <p role="status">New regional downloads are unavailable. Reload online to try again. Saved downloads remain listed below.</p>}
        {!loading && visibleRows.length === 0 && <p role="status">{savedOnly && jobs.length === 0
          ? 'No region downloads yet. Choose All regions to get started.' : 'No regions match your search.'}</p>}
        <div className="region-list">
          {visibleRows.map(region => <RegionDownloadRow key={region.key} region={region}
            details={plansReady ? 'ready' : latest.error ? 'unavailable' : 'loading'}
            pending={operationKey === region.key ? operation?.action : undefined}
            error={regionError?.id === region.key ? regionError.message : undefined}
            busy={loading || active} canUpdate={online && !latest.checking && !latest.error}
            onStart={start} onUpdate={update} onPause={id => downloads.pause(id)}
            onRemove={job => setConfirmation({ kind: 'region', job })} />)}
        </div>
      </section>
    </div>
    {open && confirmation && <ConfirmationDialog
      title={confirmation.kind === 'region'
        ? `Remove ${confirmation.job.title}?`
        : 'Remove temporary map files?'}
      description={confirmation.kind === 'region'
        ? 'This removes all saved editions and pending updates for this region. Files used by other saved regions will stay.'
        : 'This keeps saved regions, paused downloads, previous versions needed during updates, files retained by open views, and reference data. Removed files will need an internet connection to download again.'}
      confirmLabel="Remove" destructive disabled={loading || active}
      onConfirm={confirmRemoval} onCancel={() => setConfirmation(undefined)} />}
  </>;
}
