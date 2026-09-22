import { createRoot } from 'react-dom/client';
import { createRouteResolver } from '@zlayer/domain';
import '@fontsource/b612/400.css';
import { Ahrs } from '../../src/layers/ahrs/estimator/ahrs';
import { fromEuler, RAD } from '../../src/layers/ahrs/estimator/math';
import { InstrumentPanel } from '../../src/layers/ahrs/instruments';
import { Hsi } from '../../src/layers/ahrs/hsi';
import { isMagneticModel } from '../../src/core/geo/magnetic-model';
import type { AhrsSnapshot } from '../../src/layers/ahrs/layer';
import type { Position } from '../../src/layers/ahrs/navigation';
import '../../src/layers/ahrs/styles.css';
import model from '../fixtures/magnetic-model.json';

if (!isMagneticModel(model)) throw new Error('Invalid magnetic model fixture');
const magneticModel = model;
const route = createRouteResolver([])('370000N1230000W 370000N1210000W');
const attitude = new Ahrs().getState(0);
const rolls = [-180, -120, -90, -60, -45, -30, -15, 0, 15, 30, 45, 60, 90, 120, 180];
const state = (heading: number, position: Position): AhrsSnapshot => ({
  phase: 'ready', crossed: false, warning: '', message: '', calibrationReason: 'ready', progress: 1,
  gpsLive: true, gpsUsable: true, gpsMessage: '', trueHeading: true,
  hsiHeading: { degrees: heading, source: 'ahrs' },
  speed: 50, altitude: 3048, altitudeAccuracy: 5, gpsTime: 0, track: heading, position,
  attitude: { ...attitude, yaw: heading, quaternion: fromEuler(0, 0, heading * RAD),
    status: 'tracking', headingReference: 'manual-true', headingStatus: 'tracking', attitudeStd: [1, 1, 1] },
});
createRoot(document.getElementById('root')!).render(<main>
  {rolls.flatMap(roll => [-15, 0, 15].map(pitch => <section className="ahrs-tool" key={`${roll}/${pitch}`} data-roll={roll} data-pitch={pitch}>
    <p>Bank {roll}° / pitch {pitch}°</p>
    <InstrumentPanel state={{ attitude: { ...attitude, roll, pitch, quaternion: fromEuler(roll * RAD, pitch * RAD, 0) }, crossed: false, warning: '' }}
      values={{ groundspeedKnots: 100, altitudeFeet: 10000,
        verticalSpeed: { feetPerMinute: pitch * 100, roundedFeetPerMinute: pitch * 100 } }} />
  </section>))}
  {([[-122, 37], [-100, 37], [0, 51]] as const).flatMap(position =>
    [0, 45, 90, 135, 180, 225, 270, 315].map(heading =>
      <section className="ahrs-tool" key={`${heading}/${position}`} data-heading={heading} data-position={position.join(',')}>
        <Hsi state={state(heading, position)} route={route} magneticModel={magneticModel} />
      </section>))}
  {[null, 0, 500, -500, 2000, -2000, 3500, -3500, 12000, -12000].map(rate =>
    <section className="ahrs-tool" key={`vsi/${rate}`} data-vsi={String(rate)}>
      <InstrumentPanel state={{ attitude: { ...attitude, roll: 0, pitch: 0 }, crossed: false, warning: '' }}
        values={{ groundspeedKnots: 100, altitudeFeet: 10000,
          verticalSpeed: rate === null ? null : { feetPerMinute: rate, roundedFeetPerMinute: rate } }} />
    </section>)}
</main>);
