import type { GeoPointFeature, ProcedureResourceRecord } from '@zlayer/contracts';
import { radialReference, featureIdent, routeIdentificationKey, type NearbyVor } from '@zlayer/domain';
import type { CatalogReadSource, SavedSupplement } from './read-context';
import { PANEL_LAYOUT } from './panel-layout';
import { FeatureDetailCard } from '../layers/navigation/detail-card';
import { AirportRunways } from '../layers/navigation/airport-runways';
import { NearbyNavaids } from '../layers/navigation/nearby-navaids';
import { AirportPlates, type ProcedureSelection } from '../layers/plates';
import { hasAirportPlates } from '../layers/plates/data';
import { AirportWeather, AirportRunwayWeather, type MetarClient } from '../layers/metar-taf';
import { FeatureRouteActions, type FeatureRoute } from '../layers/routes/feature-actions';
import { identifyRoutePointWithStation } from '../layers/routes/identification';
import { RouteIdentificationChoices } from '../layers/routes/identification-picker';
import { routePointForFeature } from '../layers/routes/selection';
import { WaypointElevation } from '../layers/terrain/waypoint-elevation';
import type { ReportStatusListener } from '../layers/metar-taf/station-weather';
import type { NotamsApi } from '../layers/notams/public';
import { useAirportNotamView, NavaidNotams, airportNotamQuery, airportNotamRegion, PlateNotamCount } from '../layers/notams/ui';

type FeatureDetailsPanelProps = {
  feature: GeoPointFeature;
  catalog?: CatalogReadSource | undefined;
  metarClient: MetarClient;
  onWeatherStatus?: ReportStatusListener;
  procedureResource: ProcedureResourceRecord | undefined;
  revision: string;
  savedSupplement?: SavedSupplement | undefined;
  editionUnavailable?: boolean;
  identification?: { stations: readonly NearbyVor[] | undefined; loading: boolean } | undefined;
  onIdentificationChange: (open: boolean) => void;
  route: FeatureRoute;
  onClose: () => void;
  onOpenProcedure: (selection: ProcedureSelection) => void;
  notamsApi?: NotamsApi | undefined;
  features?: { routes: boolean; weather: boolean; terrain: boolean; plates: boolean };
};

/** Explicit detail composition; each feature owns its presentation and data demand. */
export function FeatureDetailsPanel({ feature, catalog, metarClient, onWeatherStatus, procedureResource, revision, savedSupplement,
  editionUnavailable = false, identification, onIdentificationChange, route, onClose, onOpenProcedure, notamsApi,
  features = { routes: true, weather: true, terrain: true, plates: true } }: FeatureDetailsPanelProps) {
  const ident = featureIdent(feature);
  const notamQuery = hasAirportPlates(feature) ? airportNotamQuery(feature.properties) : undefined;
  const airportNotams = useAirportNotamView({ api: notamsApi, query: notamQuery, region: airportNotamRegion(feature.properties) });
  const point = features.routes ? routePointForFeature(route.plan, feature, route.pointId) : undefined;
  const entry = point && route.plan.entries.find(value => value.id === point.source.entryId);
  const radial = point?.identification?.kind === 'radial' ? point.identification
    : !point?.identification ? point?.radialPosition : undefined;
  const navaids = identification && <NearbyNavaids {...identification} selection={point ? {
    reference: radial?.reference,
    onSelect: station => route.update(draft => identifyRoutePointWithStation(draft, route.plan, point, station)),
  } : undefined} />;
  const hasOriginalRadialStation = !!point?.radialPosition && identification?.stations?.some(station =>
    JSON.stringify(radialReference(station.feature)) === JSON.stringify(point.radialPosition!.reference));
  return <FeatureDetailCard feature={feature} revision={revision} placement={PANEL_LAYOUT.details.tab} onClose={onClose}
    onIdentificationChange={onIdentificationChange}
    identification={identification ? point && entry
      ? <RouteIdentificationChoices key={`${entry.id}:${routeIdentificationKey(point)}`} plan={route.plan} entry={entry} point={point}
          data={route.navigationData} navaids={navaids} hasOriginalRadialStation={hasOriginalRadialStation}
          update={route.update} onIdentify={route.onIdentify} onPreviewChange={route.onIdentificationPreview} />
      : navaids : undefined}
    actions={<>
      {features.routes && <FeatureRouteActions feature={feature} route={route} />}
      <button className="identify-feature-button" type="button" aria-pressed={!!identification}
        aria-label={`Identify ${ident} with nearby navaids`} title="Identify using nearby navaids"
        onClick={() => onIdentificationChange(!identification)}>ID</button>
    </>}
    elevation={active => features.terrain ? <WaypointElevation feature={feature} catalog={catalog} active={active} /> : null}
    info={active => features.weather ? <AirportWeather feature={feature} client={metarClient} active={active} revision={revision} onStatus={onWeatherStatus} /> : null}
    runways={features.weather ? active => <AirportRunwayWeather feature={feature} revision={revision} active={active}>
      {weather => <AirportRunways feature={feature} weather={weather} />}
    </AirportRunwayWeather> : undefined}
    notams={airportNotams ?? (notamsApi && feature.properties.kind === 'navaid'
      ? { body: active => <NavaidNotams key={feature.id ?? ident} api={notamsApi} feature={feature} active={active} /> } : undefined)}
    plates={features.plates && hasAirportPlates(feature) ? active => editionUnavailable
      ? <p className="procedure-state is-error">This feature’s source edition is unavailable. Select it again after its navigation data reloads.</p>
      : <AirportPlates feature={feature} resource={procedureResource} revision={revision}
          noticeCount={notamsApi ? context => <PlateNotamCount api={notamsApi} context={context} active={active} /> : undefined}
          savedSupplement={savedSupplement} onOpen={onOpenProcedure} /> : undefined} />;
}
