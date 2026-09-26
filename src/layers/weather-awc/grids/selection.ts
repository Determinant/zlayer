import { AWC_GRID_FIELDS, type AwcGridFrame, type AwcGridManifest, type AwcGridProduct } from '@zlayer/contracts';
import { nativeManifest, type ForecastFrame, type ForecastManifest, type NativeFrame, type NativeManifest, type SourceRecord, type WindFrame } from './native-source';

type Fields<P extends AwcGridProduct> = typeof AWC_GRID_FIELDS[P][number] | (P extends 'clouds' ? never : 'terrain');
export type ValidatedNativeFrame<P extends AwcGridProduct> = NativeFrame & { records: Record<Fields<P>, SourceRecord> };
export type NativeSelection = { [P in AwcGridProduct]: {
  kind: 'native'; product: P; manifest: NativeManifest; frame: ValidatedNativeFrame<P>;
} }[AwcGridProduct];
export type ForecastSelection = NativeSelection |
  { kind: 'archive'; manifest: AwcGridManifest; frame: AwcGridFrame } |
  { kind: 'native-wind'; manifest: NativeManifest; frame: WindFrame<ValidatedNativeFrame<'winds'>> } |
  { kind: 'archive-wind'; manifest: AwcGridManifest; frame: WindFrame<AwcGridFrame> };

/** Catalog guards validate the wire format; this boundary pairs a chosen frame
 * with its source family and makes required conversion records explicit. */
export function selectNativeFrame(manifest: NativeManifest, frame: NativeFrame): NativeSelection {
  const fields = [...AWC_GRID_FIELDS[manifest.product], ...(manifest.product === 'clouds' ? [] : ['terrain'] as const)];
  if (fields.some(field => !frame.records[field])) throw new Error('Incomplete native forecast selection');
  return { kind: 'native', product: manifest.product, manifest, frame } as NativeSelection;
}

export function selectForecast(manifest: ForecastManifest, frame: ForecastFrame): ForecastSelection {
  if ('levels' in frame) {
    if (manifest.product !== 'winds' || !frame.levels.length || frame.levels.some(level => level.validTime !== frame.validTime)) {
      throw new Error('Mismatched wind interpolation source');
    }
    if (nativeManifest(manifest)) {
      for (const level of frame.levels) {
        if (!('records' in level)) throw new Error('Mismatched forecast source');
        selectNativeFrame(manifest, level);
      }
      return { kind: 'native-wind', manifest, frame: frame as WindFrame<ValidatedNativeFrame<'winds'>> };
    }
    if (frame.levels.some(level => 'records' in level)) throw new Error('Mismatched forecast source');
    return { kind: 'archive-wind', manifest, frame: frame as WindFrame<AwcGridFrame> };
  }
  if (nativeManifest(manifest)) {
    if (!('records' in frame)) throw new Error('Mismatched forecast source');
    return selectNativeFrame(manifest, frame);
  }
  if ('records' in frame) throw new Error('Mismatched forecast source');
  return { kind: 'archive', manifest, frame };
}
