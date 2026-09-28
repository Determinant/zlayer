import { useMemo } from 'react';
import { magneticField } from '../../../core/geo/magnetic-model';
import { useMagneticModel } from '../../../core/geo/use-magnetic-model';
import { fetchMagneticModel } from '../../../workspace/catalog/catalog';

export function useMetarDeclination(coordinates: readonly number[] | undefined, observedAt: string | undefined,
  revision: string | undefined, active: boolean): number | null {
  const model = useMagneticModel(revision, active && !!observedAt, fetchMagneticModel);
  const [longitude, latitude] = coordinates ?? [];
  return useMemo(() => {
    if (!model || longitude === undefined || latitude === undefined || !observedAt) return null;
    const field = magneticField(model, [longitude, latitude], 0, Date.parse(observedAt));
    return field && field.horizontal >= 6000 && Math.abs(latitude) < 90 ? field.declination : null;
  }, [model, longitude, latitude, observedAt]);
}
