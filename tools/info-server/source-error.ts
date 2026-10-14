import { HttpError } from './weather-resources';

/** Preserve source validation identity through the HTTP cache's error boundary. */
export class WeatherSourceError extends HttpError {
  override name = 'WeatherSourceError';
  constructor(message: string, readonly code: 'invalid-source' | 'future-source' | 'stale-source' = 'invalid-source') { super(502, message, 5); }
}
