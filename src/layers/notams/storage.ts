import { isNotamAirportSnapshot, type NotamAirportSnapshot } from '@zlayer/contracts';
import { createPluginStorage } from '../../core/storage/plugin-storage';

export const pluginStorage = createPluginStorage('notams', undefined, { maxRecordBytes: 2 * 1024 * 1024 });
export const airportSnapshots = pluginStorage.record<NotamAirportSnapshot[]>('airport-snapshots', {
  version: 1, fallback: [],
  decode: value => Array.isArray(value) && value.length <= 24 && value.every(isNotamAirportSnapshot) ? value : undefined,
  encode: value => value,
});
