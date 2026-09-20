import type { GeoPointProperties } from '@zlayer/contracts';
import { formatMetarWind } from './format';

export function metarDetailRows(properties: GeoPointProperties): { label: string; value: string; wide?: boolean }[] {
  const number = (value: number | undefined, unit: string) => typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString()} ${unit}` : undefined;
  return [
    { label: 'Flight category', value: properties.flightCategory ?? (properties.metarStationId ? 'N/A' : undefined) },
    { label: 'Ceiling', value: number(properties.metarCeilingFt, 'ft') ??
      (properties.metarCeilingStatus === 'none' ? 'None reported'
        : properties.metarCeilingStatus || properties.metarStationId ? 'Unknown' : undefined) },
    { label: 'Visibility', value: number(properties.metarVisibilitySm, 'SM') },
    { label: 'Wind', value: formatMetarWind(properties) },
    { label: 'Raw', value: properties.rawMetar, wide: true },
  ].filter((row): row is { label: string; value: string; wide?: boolean } => !!row.value);
}
