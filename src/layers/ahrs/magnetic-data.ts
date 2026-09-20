import { fetchJson } from '../../core/data/fetch-json';
import { fetchMagneticModelResource } from '../../workspace/catalog/catalog';
import { isMagneticModel, type MagneticModel } from './magnetic-model';

/** Uses the same validated, durable JSON cache as the other chart reference data. */
export async function fetchMagneticModel(revision: string, signal?: AbortSignal): Promise<MagneticModel> {
  const resource = await fetchMagneticModelResource(revision, signal);
  return fetchJson(resource.url, (value): value is MagneticModel => isMagneticModel(value) &&
    value.effectiveDate === revision && value.coefficients.length === resource.count,
  'Geographic magnetic model', signal ? { signal } : {});
}
