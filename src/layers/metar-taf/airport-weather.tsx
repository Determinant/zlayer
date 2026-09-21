import { Fragment } from 'react';
import type { GeoPointFeature } from '@zlayer/contracts';
import { featureKey, isAirportFeature } from '@zlayer/domain';
import { METAR_REFRESH_MS, type MetarClient } from './metar/client';
import { MetarReportView } from './metar/report';
import { getTafClient, TAF_REFRESH_MS } from './taf/client';
import { TafReportView } from './taf/report';
import { StationWeather } from './station-weather';

/** Reset both station selections when the selected airport changes. */
export function AirportWeather({ feature, client, active = true }: {
  feature: GeoPointFeature; client: MetarClient; active?: boolean;
}) {
  if (!isAirportFeature(feature)) return null;
  const tafClient = typeof window === 'undefined' ? undefined : getTafClient();
  return <Fragment key={featureKey(feature)}>
    <StationWeather feature={feature} client={client} active={active} name="METAR" intervalMs={METAR_REFRESH_MS}
      refreshStation={(id, signal) => client.refresh([id], signal)} View={MetarReportView} />
    <StationWeather feature={feature} client={tafClient} active={active} name="TAF" intervalMs={TAF_REFRESH_MS}
      refreshStation={(id, signal) => tafClient?.refresh(id, signal)} View={TafReportView} />
  </Fragment>;
}
