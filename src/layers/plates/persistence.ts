import { pluginStorage } from './storage';
import { isRecord } from '@zlayer/contracts';
import type { ProcedureSelection } from './data';

export function isProcedureSelection(value: unknown): value is ProcedureSelection | null {
  if (value === null) return true;
  if (!isRecord(value) || !isRecord(value.airport) || !isRecord(value.procedure) || !isRecord(value.document)) return false;
  const document = value.document;
  return typeof value.airport.id === 'string' && typeof value.procedure.id === 'string' && typeof value.procedure.name === 'string'
    && typeof value.cycle === 'string' && [value.effectiveDate, value.expirationDate].every(date =>
      typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)))
    && [document.url, document.nativeUrl].every(url => typeof url === 'string' && /^https?:\/\//.test(url))
    && Number.isInteger(document.pageIndex) && Number(document.pageIndex) >= 0
    && ['combined-volume', 'faa-individual', 'chart-supplement'].includes(String(document.source))
    && (document.namedDestination === undefined || typeof document.namedDestination === 'string')
    && (document.sha256 === undefined || typeof document.sha256 === 'string')
    && [document.pageCount, document.byteLength].every(number => number === undefined ||
      (typeof number === 'number' && Number.isSafeInteger(number) && number > 0));
}

export function plateViewKey(selection: ProcedureSelection): string {
  return `plate-view:${JSON.stringify([selection.document.url, selection.procedure.id, selection.document.pageIndex])}`;
}

export function isMapPlateSelection(value: unknown): value is ProcedureSelection | null {
  return isProcedureSelection(value) && (value === null || value.procedure.kind === 'approach');
}

export const plateSelectionRecord = pluginStorage.ui('plate-selection', null, isProcedureSelection);
export const mappedPlateRecord = pluginStorage.ui('plate-on-map', null, isMapPlateSelection);
