import type { GeoPointFeature, ProcedureResourceRecord } from '@zlayer/contracts';
import { featureIdent, type NearbyVor } from '@zlayer/domain';
import type { CatalogReadSource, SavedSupplement } from './read-context';
import { PANEL_LAYOUT } from './panel-layout';
import { FeatureDetailCard } from '../layers/navigation/detail-card';
import { NearbyNavaids } from '../layers/navigation/nearby-navaids';
import { AirportPlates, type ProcedureSelection } from '../layers/plates';
import { hasAirportPlates } from '../layers/plates/data';
import { AirportWeather, RunwayWind, RunwayWindNotes, type MetarClient } from '../layers/metar-taf';
import { FeatureRouteActions, type FeatureRoute } from '../layers/routes/feature-actions';
import { WaypointElevation } from '../layers/terrain/waypoint-elevation';

type FeatureDetailsPanelProps = {
  feature: GeoPointFeature;
  catalog?: CatalogReadSource | undefined;
  metarClient: MetarClient;
  procedureResource: ProcedureResourceRecord | undefined;
  revision: string;
  savedSupplement?: SavedSupplement | undefined;
  editionUnavailable?: boolean;
  identification?: { stations: readonly NearbyVor[] | undefined; loading: boolean } | undefined;
  onIdentificationChange: (open: boolean) => void;
  route: FeatureRoute;
  onClose: () => void;
  onOpenProcedure: (selection: ProcedureSelection) => void;
  features?: { routes: boolean; weather: boolean; terrain: boolean; plates: boolean };
};

/** Explicit detail composition; each feature owns its presentation and data demand. */
export function FeatureDetailsPanel({ feature, catalog, metarClient, procedureResource, revision, savedSupplement,
  editionUnavailable = false, identification, onIdentificationChange, route, onClose, onOpenProcedure,
  features = { routes: true, weather: true, terrain: true, plates: true } }: FeatureDetailsPanelProps) {
  const ident = featureIdent(feature);
  return <FeatureDetailCard feature={feature} revision={revision} placement={PANEL_LAYOUT.details.tab} onClose={onClose}
    onIdentificationChange={onIdentificationChange}
    identification={identification ? <NearbyNavaids {...identification} /> : undefined}
    actions={<>
      {features.routes && <FeatureRouteActions feature={feature} route={route} />}
      <button className="identify-feature-button" type="button" aria-pressed={!!identification}
        aria-label={`Identify ${ident} with nearby navaids`} title="Identify using nearby navaids"
        onClick={() => onIdentificationChange(!identification)}>ID</button>
    </>}
    elevation={active => features.terrain ? <WaypointElevation feature={feature} catalog={catalog} active={active} /> : null}
    info={active => features.weather ? <AirportWeather feature={feature} client={metarClient} active={active} /> : null}
    runwayWeather={features.weather ? {
      notes: <RunwayWindNotes properties={feature.properties} />,
      wind: heading => <RunwayWind heading={heading} properties={feature.properties} />,
    } : undefined}
    plates={features.plates && hasAirportPlates(feature) ? () => editionUnavailable
      ? <p className="procedure-state is-error">This feature’s source edition is unavailable. Select it again after its navigation data reloads.</p>
      : <AirportPlates feature={feature} resource={procedureResource} revision={revision}
          savedSupplement={savedSupplement} onOpen={onOpenProcedure} /> : undefined} />;
}
