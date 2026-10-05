/** Only explicit source validation failures may suppress an unchanged input. */
export class WeatherSourceError extends Error {
  override name = 'WeatherSourceError';
  constructor(message: string, readonly code: 'invalid-source' | 'future-source' = 'invalid-source') { super(message); }
}
