import type { GlideApi } from '../layers/glide/public';
import type { OwnshipApi } from '../layers/ownship/public';
import type { AhrsApi } from '../layers/ahrs/public';
import type { RoutesApi } from '../layers/routes/public';
import type { NavigationApi } from '../layers/navigation/public';
import type { PlatesApi } from '../layers/plates/public';
import type { RulerApi } from '../layers/ruler/public';
import type { MetarApi } from '../layers/metar-taf/public';
import type { TerrainApi } from '../layers/terrain/public';
import type { ObstructionApi } from '../layers/obstructions/public';
import type { WeatherAwcApi } from '../layers/weather-awc/public';

/** Compile-time catalog only; core never imports feature types or implementations. */
export type WorkspacePluginApis = {
  routes: RoutesApi;
  navigation: NavigationApi;
  plates: PlatesApi;
  ruler: RulerApi;
  metar: MetarApi;
  terrain: TerrainApi;
  glide: GlideApi;
  obstructions: ObstructionApi;
  'weather-awc': WeatherAwcApi;
  ahrs: AhrsApi;
  ownship: OwnshipApi;
  charts: object;
};
