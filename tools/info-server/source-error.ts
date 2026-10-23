import { HttpError } from './weather-resources';

/** Preserve source validation identity through the HTTP cache's error boundary. */
export class WeatherSourceError extends HttpError {
  override name = 'WeatherSourceError';
  evidenceId: string | undefined;
  constructor(message: string, readonly code: 'invalid-source' | 'future-source' | 'stale-source' = 'invalid-source') { super(502, message, 5); }
}

/** Cache error wrapping must not turn a local preparation failure into invalid
 * upstream data. Optional evidence identifies the input, not the fault's owner. */
export class WeatherPreparationError extends HttpError {
  override name = 'WeatherPreparationError';
  evidenceId: string | undefined;
  constructor(message: string) { super(502, message, 5); }
}
