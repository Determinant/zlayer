import type { SourceRecord } from '../../src/layers/weather-awc/grids/native-source';
import type { NativeSelection } from '../../src/layers/weather-awc/grids/selection';
import { WeatherSourceError } from './source-error';

export type WorkerFailure = { code: 'invalid-source' | 'future-source' | 'processing'; message: string };
export type WorkerResult<T> = { type: 'done'; value: T } | { type: 'error'; error: WorkerFailure };
export type ConversionJob = NativeSelection & { terrainOnly?: boolean };
export type ConversionRequest = { type: 'convert'; job: ConversionJob } | { type: 'read'; id: number; body: ArrayBuffer };
export type ConversionResponse = WorkerResult<ArrayBuffer> | { type: 'read'; id: number; record: SourceRecord };

export function workerFailure(cause: unknown): WorkerResult<never> {
  return { type: 'error', error: { code: cause instanceof WeatherSourceError ? cause.code : 'processing',
    message: cause instanceof Error ? cause.message : String(cause) } };
}
export function workerError(failure: WorkerFailure): Error {
  return failure.code === 'processing' ? new Error(failure.message) : new WeatherSourceError(failure.message, failure.code);
}
