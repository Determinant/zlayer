import type { SourceRecord } from '../../src/layers/weather-awc/grids/native-source';
import type { NativeSelection } from '../../src/layers/weather-awc/grids/selection';
import { WeatherSourceError } from './source-error';

export type WorkerFailure = { code: 'invalid-source' | 'future-source' | 'stale-source' | 'processing'; message: string; inputIndices?: number[] };
export type WorkerResult<T> = { type: 'done'; value: T } | { type: 'error'; error: WorkerFailure };
export type ConversionJob = NativeSelection & { terrainOnly?: boolean };
export type ConversionRequest = { type: 'convert'; job: ConversionJob } | { type: 'read'; id: number; body: ArrayBuffer };
export type ConversionResponse = WorkerResult<ArrayBuffer> | { type: 'read'; id: number; record: SourceRecord };

export function workerFailure(cause: unknown, inputIndices?: number[]): WorkerResult<never> {
  return { type: 'error', error: { code: cause instanceof WeatherSourceError ? cause.code : 'processing',
    message: cause instanceof Error ? cause.message : String(cause), ...(inputIndices === undefined ? {} : { inputIndices }) } };
}
/** A decoder rejected a specific input; worker transport/crash errors have no input identity. */
export class WorkerInputError extends Error {
  constructor(readonly inputIndices: number[], message: string) { super(message); }
}
export function workerError(failure: WorkerFailure): Error {
  if (failure.inputIndices !== undefined) return new WorkerInputError(failure.inputIndices, failure.message);
  return failure.code === 'processing' ? new Error(failure.message) : new WeatherSourceError(failure.message, failure.code);
}
