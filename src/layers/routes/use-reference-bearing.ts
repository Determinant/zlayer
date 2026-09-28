import { useMemo } from 'react';
import type { MagneticReferenceResolver } from '@zlayer/domain';
import { magneticField } from '../../core/geo/magnetic-model';
import { fetchMagneticModel } from '../../workspace/catalog/catalog';
import { useRouteResource } from './use-resource';

/** On-demand bearing model with the route resource's cancellation and recovery signals. */
export function useReferenceBearing(revision: string | undefined, active: boolean): MagneticReferenceResolver | undefined {
  const { data: model } = useRouteResource(active && revision ? `bearing-model:${revision}` : undefined,
    signal => fetchMagneticModel(revision!, signal));
  const time = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  return useMemo(() => {
    if (!model) return undefined;
    // A day-stable model evaluation; resolved entries retain this time and declination.
    return (coordinate => {
      const field = magneticField(model, coordinate, 0, time);
      return field && field.horizontal >= 6000 ? { declination: field.declination, model: model.model, epoch: model.epoch, time } : undefined;
    }) satisfies MagneticReferenceResolver;
  }, [model, time]);
}
