import { useEffect, useState } from 'react';
import { createRouteResolver } from '@zlayer/domain';
import { Ahrs } from './estimator/ahrs';
import { fromEuler, RAD } from './estimator/math';
import { AhrsInstruments } from './instruments';
import { Hsi } from './hsi';
import { METERS_PER_FOOT, METERS_PER_KNOT_SECOND } from './instrument-display';
import type { AhrsSnapshot } from './layer';
import type { MagneticModel } from './magnetic-model';

/** A display source only: it never acquires GPS, motion, or a workspace route. */
function createInstrumentTest() {
  const start = performance.now() / 1000;
  const attitude = new Ahrs().getState(0);
  const route = createRouteResolver([])('370000N1230000W 370000N1210000W');
  route.waypoints.forEach((waypoint, index) => { waypoint.ident = `TEST ${index + 1}`; });
  const read = (): AhrsSnapshot => {
    const elapsed = Math.max(0, performance.now() / 1000 - start);
    const second = Math.floor(elapsed);
    // Each 12-second sweep crosses a digit boundary in both directions. Supply
    // one-second fixes to exercise the same smoothing as real GPS readings.
    const cases = [[98, 9980], [8, 80], [998, 980], [98, -120], [98, -20]] as const;
    const [knots, feet] = cases[Math.floor(second / 12) % cases.length]!;
    const sweep = 1 - Math.abs(second % 12 - 6) / 6;
    const yaw = (350 + elapsed * 6) % 360;
    const roll = 20 * Math.sin(elapsed / 4), pitch = 8 * Math.sin(elapsed / 6);
    return {
      phase: 'ready', crossed: false, warning: '', message: '', calibrationReason: 'ready', progress: 1,
      // Keep guidance visible throughout the low-speed digit tests as well.
      gpsLive: true, gpsUsable: true, gpsMessage: '', trueHeading: true,
      gpsTime: start + second, speed: (knots + 4 * sweep) * METERS_PER_KNOT_SECOND,
      altitude: (feet + 40 * sweep) * METERS_PER_FOOT,
      altitudeAccuracy: 5,
      track: (yaw + 10 * Math.sin(elapsed / 5) + 360) % 360,
      position: [-122 + .3 * Math.sin(elapsed / 16), 37 + .025 * Math.sin(elapsed / 4)],
      attitude: { ...attitude, roll, pitch, yaw, quaternion: fromEuler(roll * RAD, pitch * RAD, yaw * RAD),
        status: 'tracking', headingReference: 'manual-true', headingStatus: 'tracking', attitudeStd: [1, 1, 1] },
    };
  };
  return { route, getSnapshot: read, readDisplaySnapshot: read, subscribe: () => () => {} };
}

export function InstrumentTest({ active, magneticModel }: { active: boolean; magneticModel: MagneticModel | null }) {
  const [source] = useState(createInstrumentTest);
  const [state, setState] = useState(source.getSnapshot);
  useEffect(() => {
    if (!active) return;
    setState(source.getSnapshot());
    const timer = setInterval(() => setState(source.getSnapshot()), 50);
    return () => clearInterval(timer);
  }, [active, source]);
  return <section aria-label="Instrument test" className="ahrs-display ahrs-test-display">
    <p className="ahrs-test-banner" role="status">Test mode · simulated readings</p>
    <AhrsInstruments layer={source} active={active} />
    <Hsi state={state} route={source.route} active={active} magneticModel={magneticModel} />
  </section>;
}
