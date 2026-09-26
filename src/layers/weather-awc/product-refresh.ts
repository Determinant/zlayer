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
  progs?: Pick<ProgsClient, 'restore' | 'refresh'>;
  radar?: Pick<RadarClient, 'restore' | 'refresh' | 'load'>;
  motion?: Pick<RadarMotionClient, 'restore' | 'refresh' | 'load'>;
  coverage?: Pick<ProgsCoverageClient, 'restore' | 'refresh' | 'load'>;
};
type ProductGroup = 'advisories' | 'progs' | 'radar' | 'motion' | 'coverage';

/** Owns acquisition demand, product retry cadence and optional restoration.
 * Selection reconciliation and renderer receipts belong to the parent. */
export function createProductRefresh({ advisories: client, progs: progsClient, radar: radarClient,
  motion: motionClient, coverage: coverageClient }: WeatherClients,
  read: () => WeatherState, publish: (patch: Partial<WeatherState>) => void) {
  let schedulers: Partial<Record<ProductGroup, OnDemandRefresh>> = {};
  let progsRestore: AbortController | undefined;
  const productState = (product: AwcAdvisoryProduct, patch: AdvisoryState) =>
    publish({ products: { ...read().products, [product]: patch } });
  const progsState = (product: SurfaceProduct, patch: SurfaceState) =>
    publish({ progs: { ...read().progs, [product]: patch } });
  const detach = () => {
    for (const scheduler of Object.values(schedulers)) stopRefresh(scheduler);
    schedulers = {};
    progsRestore?.abort(); progsRestore = undefined;
  };
  return {
    attach() {
      detach();
      if (progsClient) {
        const restore = progsRestore = new AbortController();
        for (const product of SURFACE_PRODUCTS) void progsClient.restore(product, restore.signal).then(saved => {
          const current = read().progs[product];
          if (!restore.signal.aborted && saved.snapshot && !current.snapshot) progsState(product, { ...current, snapshot: saved.snapshot });
        }).catch(() => { /* Optional restoration; live acquisition remains independent. */ });
      }
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
      const active = p.awcEnabled && (typeof navigator === 'undefined' || navigator.onLine) &&
        (typeof document === 'undefined' || document.visibilityState !== 'hidden');
      const ids: AwcAdvisoryProduct[] = [];
      if (p.awcGairmet || p.awcFreezing) ids.push('gairmet');
      if (p.awcSigmet || p.awcConvective) ids.push('sigmet');
      if (p.awcCwa) ids.push('cwa');
      schedulers.advisories?.setDemand(ids, active);
      schedulers.progs?.setDemand(SURFACE_PRODUCTS, active && p.awcProgs);
      schedulers.coverage?.setDemand(['coverage'], active && p.awcProgs && p.awcProgsCoverage);
      schedulers.radar?.setDemand(['radar'], active && p.awcRadar);
      schedulers.motion?.setDemand(['motion'], active && p.awcRadar && p.awcRadarMotion);
    },
    retry(groups: ProductGroup[]) { for (const group of groups) schedulers[group]?.setDemand([], false); },
    detach,
  };
}
