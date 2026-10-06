import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SavedSupplement } from '../../workspace/read-context';

import type { ChartSupplementCatalog, GeoPointFeature, ProcedureCatalog, ProcedureResourceRecord } from '@zlayer/contracts';
import { fetchProcedureCatalog } from './api';
import type { ProcedureSelection } from './data';
import { airportPlateGroups } from './groups';
import { fetchAirportSupplements, supplementCatalogUrl } from './supplements';
import { LoadingPlaceholder } from '../../core/ui/loading-placeholder';
import { resolvePlateNoticeContext, type PlateNoticeContext } from './page-context';

type AirportPlatesProps = {
  feature: GeoPointFeature;
  resource: ProcedureResourceRecord | undefined;
  revision: string;
  savedSupplement?: SavedSupplement | undefined;
  onOpen: (selection: ProcedureSelection) => void;
  noticeCount?: ((context: PlateNoticeContext) => ReactNode) | undefined;
};

type CatalogSource = Omit<AirportPlatesProps, 'onOpen' | 'noticeCount'>;
type CatalogState<T> = { source: CatalogSource; catalog?: T; loading: boolean; error?: string };

export function AirportPlates({
  feature,
  resource,
  revision,
  savedSupplement,
  onOpen,
  noticeCount,
}: AirportPlatesProps) {
  const source = useMemo(() => ({ feature, resource, revision, savedSupplement }),
    [feature, resource, revision, savedSupplement?.catalog, savedSupplement?.url]);
  const [loadedProcedures, setProcedures] = useState<CatalogState<ProcedureCatalog>>();
  const [loadedSupplements, setSupplements] = useState<CatalogState<ChartSupplementCatalog>>();
  // Hide the previous edition during the render before effect cleanup runs.
  // Its page targets must never be combined with the next catalog's URL.
  const procedures: CatalogState<ProcedureCatalog> = loadedProcedures?.source === source
    ? loadedProcedures : { source, loading: Boolean(resource) };
  const supplements: CatalogState<ChartSupplementCatalog> = loadedSupplements?.source === source
    ? loadedSupplements : { source, loading: true };

  useEffect(() => {
    const { feature, resource, revision, savedSupplement } = source;
    let current = true;
    setProcedures({ source, loading: Boolean(resource) });
    setSupplements({ source, loading: true });
    if (resource) fetchProcedureCatalog(resource).then(catalog => {
      if (current) setProcedures({ source, catalog, loading: false });
    }, (error: unknown) => {
      if (current) setProcedures({ source, loading: false, error: errorMessage(error, 'Procedures unavailable') });
    });
    if (savedSupplement) setSupplements({ source, loading: false,
      ...(savedSupplement.catalog ? { catalog: savedSupplement.catalog } : {}) });
    else fetchAirportSupplements(revision, feature).then(catalog => {
      if (current) setSupplements(catalog ? { source, catalog, loading: false } : {
        source, loading: false, error: 'Chart Supplement index is not published for this cycle yet.',
      });
    }, (error: unknown) => {
      if (current) setSupplements({ source, loading: false, error: errorMessage(error, 'Chart Supplements unavailable') });
    });
    return () => { current = false; };
  }, [source]);

  const groups = airportPlateGroups(feature,
    procedures.catalog && resource ? { catalog: procedures.catalog, url: resource.url, resource } : undefined,
    supplements.catalog ? { catalog: supplements.catalog, url: savedSupplement?.url ?? supplementCatalogUrl(revision) } : undefined,
    window.location.href);

  return (
    <div className="procedure-groups content-reveal">
      {groups.map((group) => (
        <section key={group.id} className="ui-section procedure-group">
          <h3 className="ui-section-title">
            {group.title}
            <span>{group.plates.length}</span>
          </h3>
          {group.plates.map(({ selection, detail }) => (
            <button
              key={selection.procedure.id}
              type="button"
              onClick={() => onOpen(selection)}
            >
              <span className="ui-item-copy">
                <strong>{selection.procedure.name}</strong>
                <small>{detail}</small>
                {noticeCount?.(resolvePlateNoticeContext(selection, selection.document.pageIndex, procedures.catalog))}
              </span>
              <i aria-hidden="true">›</i>
            </button>
          ))}
        </section>
      ))}
      {procedures.loading && <LoadingPlaceholder label="Loading procedures…" rows={3} />}
      {supplements.loading && <LoadingPlaceholder label="Loading Chart Supplement…" rows={3} />}
      {procedures.error && <p className="ui-note procedure-state is-error">{procedures.error}</p>}
      {supplements.error && <p className="ui-note procedure-state is-error">{supplements.error}</p>}
      {!groups.length && !procedures.loading && !supplements.loading && !procedures.error && !supplements.error &&
        <p className="ui-note procedure-state">No plates published for this airport.</p>}
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
