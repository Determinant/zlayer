import { expose } from 'comlink';
import { writeExportFile, type ExportFile } from '../../core/storage/export-file';
import { recordingBytes, recordingGpx } from './recording-export';
import { RECORDING_MIME, recordingStorage, type RecordingInfo, type RecordingExportFormat } from './recording-storage';

const api = {
  async prepare(info: RecordingInfo, format: RecordingExportFormat, name: string): Promise<ExportFile> {
    const source = () => recordingStorage.read(info);
    return writeExportFile(name, format === 'gpx' ? 'application/gpx+xml' : RECORDING_MIME,
      () => format === 'gpx' ? recordingGpx(source, info) : recordingBytes(source()));
  },
};
export type RecordingExportWorker = typeof api;
expose(api);
