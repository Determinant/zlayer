import { useEffect, useState } from 'react';
import type { SavedSupplement } from '../../workspace/read-context';

import type { ChartSupplementCatalog, GeoPointFeature, ProcedureCatalog, ProcedureResourceRecord } from '@zlayer/contracts';
import { fetchProcedureCatalog } from './api';
import type { ProcedureSelection } from './data';
import { airportPlateGroups } from './groups';
import { fetchAirportSupplements, supplementCatalogUrl } from './supplements';
import { LoadingPlaceholder } from '../../core/ui/loading-placeholder';

type AirportPlatesProps = {
  feature: GeoPointFeature;
  resource: ProcedureResourceRecord | undefined;
  revision: string;
  savedSupplement?: SavedSupplement | undefined;
  onOpen: (selection: ProcedureSelection) => void;
};

type CatalogState<T> = { catalog?: T; loading: boolean; error?: string };

export function AirportPlates({
  feature,
  resource,
  revision,
  savedSupplement,
  onOpen,
}: AirportPlatesProps) {
  const [procedures, setProcedures] = useState<CatalogState<ProcedureCatalog>>({ loading: Boolean(resource) });
  const [supplements, setSupplements] = useState<CatalogState<ChartSupplementCatalog>>({ loading: true });

  useEffect(() => {
    let current = true;
    setProcedures({ loading: Boolean(resource) });
    setSupplements({ loading: true });
    if (resource) fetchProcedureCatalog(resource).then(catalog => {
      if (current) setProcedures({ catalog, loading: false });
    }, (error: unknown) => {
      if (current) setProcedures({ loading: false, error: errorMessage(error, 'Procedures unavailable') });
    });
    if (savedSupplement) setSupplements({ loading: false,
      ...(savedSupplement.catalog ? { catalog: savedSupplement.catalog } : {}) });
    else fetchAirportSupplements(revision, feature).then(catalog => {
      if (current) setSupplements(catalog ? { catalog, loading: false } : {
        loading: false, error: 'Chart Supplement index is not published for this cycle yet.',
      });
    }, (error: unknown) => {
      if (current) setSupplements({ loading: false, error: errorMessage(error, 'Chart Supplements unavailable') });
    });
    return () => { current = false; };
  }, [resource, revision, feature, savedSupplement?.catalog, savedSupplement?.url]);

  const groups = airportPlateGroups(feature,
    procedures.catalog && resource ? { catalog: procedures.catalog, url: resource.url } : undefined,
    supplements.catalog ? { catalog: supplements.catalog, url: savedSupplement?.url ?? supplementCatalogUrl(revision) } : undefined,
    window.location.href);

  return (
    <div className="procedure-groups content-reveal">
      {groups.map((group) => (
        <section key={group.id} className="procedure-group">
          <h3>
            {group.title}
            <span>{group.plates.length}</span>
          </h3>
          {group.plates.map(({ selection, detail }) => (
            <button
              key={selection.procedure.id}
              type="button"
              onClick={() => onOpen(selection)}
            >
              <span>
                <strong>{selection.procedure.name}</strong>
                <small>{detail}</small>
              </span>
              <i aria-hidden="true">›</i>
            </button>
          ))}
        </section>
      ))}
      {procedures.loading && <LoadingPlaceholder label="Loading procedures…" rows={3} />}
      {supplements.loading && <LoadingPlaceholder label="Loading Chart Supplement…" rows={3} />}
      {procedures.error && <p className="procedure-state is-error">{procedures.error}</p>}
      {supplements.error && <p className="procedure-state is-error">{supplements.error}</p>}
      {!groups.length && !procedures.loading && !supplements.loading && !procedures.error && !supplements.error &&
        <p className="procedure-state">No plates published for this airport.</p>}
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
