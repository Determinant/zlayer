import type { GeoPointProperties } from '@zlayer/contracts';
import { formatMetarAltimeter, formatMetarWind } from './format';

export function metarDetailRows(properties: GeoPointProperties, declination?: number | null): { label: string; value: string; wide?: boolean }[] {
  const number = (value: number | undefined, unit: string) => typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString()} ${unit}` : undefined;
  const unavailable = properties.metarStationId || properties.rawMetar ? 'Unavailable' : undefined;
  return [
    { label: 'Wind', value: formatMetarWind(properties, declination) ?? unavailable },
    { label: 'Visibility', value: number(properties.metarVisibilitySm, 'SM') ?? unavailable },
    { label: 'Ceiling', value: number(properties.metarCeilingFt, 'ft') ??
      (properties.metarCeilingStatus === 'none' ? 'None reported'
        : properties.metarCeilingStatus || unavailable ? 'Unknown' : undefined) },
    { label: 'Altimeter', value: formatMetarAltimeter(properties.rawMetar) ?? unavailable },
    { label: 'Raw', value: properties.rawMetar, wide: true },
  ].filter((row): row is { label: string; value: string; wide?: boolean } => !!row.value);
}
