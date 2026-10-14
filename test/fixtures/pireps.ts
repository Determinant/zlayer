import type { PirepSnapshot } from '@zlayer/contracts';
import { WEATHER_NOW } from './awc-advisories';

export function pirepFixture(): PirepSnapshot {
  return { schemaVersion: 1, checkedAt: WEATHER_NOW, source: 'AWC synthetic aircraft-report fixture', issues: [],
    reports: Array.from({ length: 24 }, (_, i) => ({
      id: i.toString(16).padStart(64, '0'), observedAt: WEATHER_NOW - (i + 1) * 60_000, receivedAt: WEATHER_NOW - i * 60_000,
      longitude: -122 + i * .003, latitude: 37.3 + i * .003, altitudeFt: i === 23 ? null : 8000 + i * 1000,
      type: i === 0 ? 'Urgent PIREP' : i === 1 ? 'AIREP' : 'PIREP', urgent: i === 0, aircraft: `TEST${i + 1}`,
      turbulence: i === 0 ? ['MOD CHOP'] : i === 2 ? ['NEG'] : [], icing: i === 1 ? ['NEG'] : [], sky: [], quality: [],
      text: `SYNTHETIC PIREP ${i + 1} /RM TEST REPORT`, sourceXml: '<AircraftReport>Synthetic fixture</AircraftReport>',
    })) };
}
