import type { PirepClient } from './pireps/client';
import { AWC_ADVISORY_PRODUCTS, SURFACE_PRODUCTS, type AwcAdvisoryProduct, type SurfaceProduct, type SurfaceSnapshot } from '@zlayer/contracts';
import { OnDemandRefresh } from '../../core/layers/on-demand-refresh';
import { ADVISORY_REFRESH_MS, type AdvisoryClient, type AdvisoryState } from './client';
import type { GridClient } from './grids/client';
import type { ProgsClient, SurfaceState } from './progs/client';
import type { RadarClient } from './radar/client';
import type { RadarMotionClient } from './radar/motion-client';
import type { ProgsCoverageClient } from './progs/coverage-client';
import type { WeatherState } from './controller';
import { catalogRefresh, stopRefresh } from './catalog-refresh';

export type WeatherClients = {
  advisories: Pick<AdvisoryClient, 'restore' | 'refresh'>;
  grids?: GridClient;
  pireps?: Pick<PirepClient, 'restore' | 'refresh'>;
  progs?: Pick<ProgsClient, 'restore' | 'refresh'> & Partial<Pick<ProgsClient, 'release'>>;
  radar?: Pick<RadarClient, 'restore' | 'refresh' | 'load'>;
  motion?: Pick<RadarMotionClient, 'restore' | 'refresh' | 'load'>;
  coverage?: Pick<ProgsCoverageClient, 'restore' | 'refresh' | 'load'> & Partial<Pick<ProgsCoverageClient, 'release'>>;
};
type ProductGroup = 'pireps' | 'advisories' | 'progs' | 'radar' | 'motion' | 'coverage';
const PIREP_REFRESH_MS = 60_000;

/** Owns acquisition demand, product retry cadence and optional restoration.
 * Selection reconciliation and renderer receipts belong to the parent. */
export function createProductRefresh({ advisories: client, progs: progsClient, radar: radarClient,
  pireps: pirepClient, motion: motionClient, coverage: coverageClient }: WeatherClients,
  read: () => WeatherState, publish: (patch: Partial<WeatherState>) => void) {
  let schedulers: Partial<Record<ProductGroup, OnDemandRefresh>> = {};
  let progsRestore: AbortController | undefined, pirepsRestore: AbortController | undefined;
  let restored = false;
  let pirepsCheckedAt: number | undefined;
  let progsEnabled = false, coverageEnabled = false;
  const productState = (product: AwcAdvisoryProduct, patch: AdvisoryState) =>
    publish({ products: { ...read().products, [product]: patch } });
  const progsState = (product: SurfaceProduct, patch: SurfaceState) =>
    publish({ progs: { ...read().progs, [product]: patch } });
  const detach = () => {
    for (const scheduler of Object.values(schedulers)) stopRefresh(scheduler);
    schedulers = {};
    progsRestore?.abort(); progsRestore = undefined;
    pirepsRestore?.abort(); pirepsRestore = undefined;
  };
  return {
    attach() {
      detach();
      schedulers.advisories = new OnDemandRefresh({ intervalMs: ADVISORY_REFRESH_MS, debounceMs: 0,
        onState(loading) {
          if (!loading) for (const product of AWC_ADVISORY_PRODUCTS) {
            const current = read().products[product];
            if (current.loading) productState(product, { ...current, loading: false });
          }
        }, onError() {}, async refresh(ids, signal) {
          for (const product of ids as AwcAdvisoryProduct[]) {
            signal.throwIfAborted();
            const previous = read().products[product];
            productState(product, { ...previous, loading: true });
            try {
              const snapshot = await client.refresh(product, signal);
              signal.throwIfAborted();
              productState(product, { snapshot, checkedAt: Date.now(), loading: false });
            } catch (error) {
              if (signal.aborted) return;
              productState(product, { ...previous, loading: false, error: error instanceof Error ? error.message : 'Refresh failed' });
            }
          }
        } });
      if (progsClient) schedulers.progs = new OnDemandRefresh({ intervalMs: ADVISORY_REFRESH_MS, retryIntervalMs: 30_000, debounceMs: 0,
        onState(loading) {
          if (!loading) for (const product of SURFACE_PRODUCTS) {
            const record = read().progs[product];
            if (record.loading) progsState(product, { ...record, loading: false });
          }
        }, onError() {}, async refresh(ids, signal) {
          const results = await Promise.allSettled((ids as SurfaceProduct[]).map(async product => {
            const previous = read().progs[product];
            progsState(product, { ...previous, loading: true });
            try {
              const ready = (snapshot: SurfaceSnapshot) => {
                if (!signal.aborted) progsState(product, { snapshot, checkedAt: Date.now(), loading: false });
              };
              const snapshot = await progsClient.refresh(product, signal, Date.now(), ready);
              signal.throwIfAborted();
              progsState(product, { snapshot, checkedAt: Date.now(), loading: false });
            } catch (error) {
              if (!signal.aborted) progsState(product, { ...read().progs[product], loading: false, error: error instanceof Error ? error.message : 'Refresh failed' });
              throw error;
            }
          }));
          const failure = results.find(result => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        } });
      if (pirepClient) schedulers.pireps = catalogRefresh({ intervalMs: PIREP_REFRESH_MS,
        read: () => read().pireps, publish: pireps => publish({ pireps }), async refresh(signal) {
          try { return await pirepClient.refresh(signal, snapshot => {
            // Display live data before optional persistence, keeping acquisition
            // active until it settles so reopening cannot cancel or duplicate it.
            if (!signal.aborted) publish({ pireps: { snapshot, loading: true } });
          }); }
          finally { if (!signal.aborted) pirepsCheckedAt = Date.now(); }
        } });
      if (radarClient) schedulers.radar = catalogRefresh({ intervalMs: 60_000,
        read: () => read().radar, publish: radar => publish({ radar }),
        refresh: signal => radarClient.refresh(signal) });
      if (motionClient) schedulers.motion = catalogRefresh({ intervalMs: 60_000,
        read: () => read().radarMotion, publish: radarMotion => publish({ radarMotion }),
        refresh: signal => motionClient.refresh(signal) });
      if (coverageClient) schedulers.coverage = catalogRefresh({ intervalMs: ADVISORY_REFRESH_MS,
        read: () => read().coverage, publish: coverage => publish({ coverage }),
        refresh: (signal, ready) => coverageClient.refresh(signal, ready) });
    },
    demand() {
      const p = read().preferences;
      if (p.awcEnabled && !restored) {
        restored = true;
        publish({ products: { gairmet: client.restore('gairmet'), sigmet: client.restore('sigmet'), cwa: client.restore('cwa') },
          radar: radarClient?.restore() ?? { loading: false },
          radarMotion: motionClient?.restore() ?? { loading: false },
          coverage: coverageClient?.restore() ?? { loading: false } });
      }
      if (p.awcEnabled && p.awcProgs && progsClient && !progsRestore) {
        const restore = progsRestore = new AbortController();
        for (const product of SURFACE_PRODUCTS) void progsClient.restore(product, restore.signal).then(saved => {
          const current = read().progs[product];
          if (!restore.signal.aborted && saved.snapshot && !current.snapshot) progsState(product, { ...current, snapshot: saved.snapshot });
        }).catch(() => { /* Optional restoration; live acquisition remains independent. */ });
      }

      if (p.awcEnabled && p.awcPireps && !pirepsRestore && pirepClient) {
        const restore = pirepsRestore = new AbortController();
        void pirepClient.restore(restore.signal).then(saved => {
          const current = read().pireps;
          if (!restore.signal.aborted && saved.snapshot && !current.snapshot) publish({ pireps: { ...saved, loading: current.loading, ...(current.error ? { error: current.error } : {}) } });
        }).catch(() => { /* Optional restoration; live acquisition remains independent. */ });
      } else if (!p.awcEnabled || !p.awcPireps) {
        pirepsRestore?.abort(); pirepsRestore = undefined;
      }
      const active = p.awcEnabled && (typeof navigator === 'undefined' || navigator.onLine) &&
        (typeof document === 'undefined' || document.visibilityState !== 'hidden');
      const ids: AwcAdvisoryProduct[] = [];
      if (p.awcGairmet || p.awcFreezing) ids.push('gairmet');
      if (p.awcSigmet || p.awcConvective) ids.push('sigmet');
      if (p.awcCwa) ids.push('cwa');
      schedulers.advisories?.setDemand(ids, active);
      schedulers.progs?.setDemand(SURFACE_PRODUCTS, active && p.awcProgs);
      schedulers.coverage?.setDemand(['coverage'], active && p.awcProgs && p.awcProgsCoverage);
      schedulers.pireps?.setDemand(['pireps'], active && p.awcPireps);
      schedulers.radar?.setDemand(['radar'], active && p.awcRadar);
      schedulers.motion?.setDemand(['motion'], active && p.awcRadar && p.awcRadarMotion);
      // Explicit disable releases decoded data. Hidden pages and timeline gaps
      // merely suspend demand and retain the selected product's working set.
      const nextProgs = p.awcEnabled && p.awcProgs;
      const nextCoverage = nextProgs && p.awcProgsCoverage;
      if (progsEnabled && !nextProgs) {
        progsRestore?.abort(); progsRestore = undefined;
        progsClient?.release?.();
        publish({ retainedProgsTimes: read().progs.forecast.snapshot?.frames.map(frame => frame.validTime) ?? read().retainedProgsTimes,
          progs: { analysis: { loading: false }, forecast: { loading: false } }, progsRenderError: undefined });
      }
      if (coverageEnabled && !nextCoverage) coverageClient?.release?.();
      progsEnabled = nextProgs; coverageEnabled = nextCoverage;
    },
    retry(groups: ProductGroup[]) { for (const group of groups) schedulers[group]?.setDemand([], false); },
    checkPireps() {
      // Reopening can catch an overdue timer without cancelling an active request
      // or rechecking a recently settled response, even if its source time is old.
      const age = pirepsCheckedAt === undefined ? Infinity : Date.now() - pirepsCheckedAt;
      if (!read().pireps.loading && (age < 0 || age >= PIREP_REFRESH_MS)) schedulers.pireps?.setDemand([], false);
    },
    detach,
  };
}
