import { createPluginStorage } from '../../core/storage/plugin-storage';
import { SAVED_REPORT_BYTES } from './cache-budget';

export const pluginStorage = createPluginStorage('metar', undefined, { maxRecordBytes: SAVED_REPORT_BYTES });
