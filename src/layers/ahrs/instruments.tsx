import { memo, useEffect, useState } from 'react';
import type { RoutePlan } from '@zlayer/domain';
import type { AhrsLayer } from './layer';
import type { MagneticModel } from '../../core/geo/magnetic-model';
import { Horizon } from './horizon';
import { Hsi } from './hsi';
import { AhrsDiagnostics } from './diagnostics';
import { FlightReadings } from './flight-readings';
import { InstrumentDisplay, type InstrumentValues } from './instrument-display';
import { startDisplayFrames } from './display-frames';

/** One display clock for the horizon, HSI, tapes and drums. The parent status updates
 * do not trigger extra instrument renders or change sensor/calibration timing. */
export const AhrsInstruments = memo(function AhrsInstruments({ layer, active, route, magneticModel, diagnostics = false }: {
  layer: Pick<AhrsLayer, 'getSnapshot' | 'readDisplaySnapshot' | 'subscribe'>; active: boolean;
  route?: Pick<RoutePlan, 'legs'> | undefined; magneticModel?: MagneticModel | null;
  diagnostics?: boolean;
}) {
  const [view, setView] = useState(() => ({ state: layer.getSnapshot(),
    values: { altitudeFeet: null, groundspeedKnots: null, verticalSpeed: null } as InstrumentValues }));
  useEffect(() => {
    if (!active) return;
    const display = new InstrumentDisplay();
    let cancel: (() => void) | undefined;
    const draw = (milliseconds: number) => {
      const state = layer.readDisplaySnapshot();
      const values = display.update(state.gpsLive && state.gpsTime !== null
        ? { time: state.gpsTime, speed: state.speed, altitude: state.altitude, altitudeAccuracy: state.altitudeAccuracy } : null, milliseconds / 1000);
      setView(previous => previous.state.attitude?.roll === state.attitude?.roll &&
        previous.state.attitude?.pitch === state.attitude?.pitch &&
        previous.state.attitude?.yaw === state.attitude?.yaw &&
        previous.state.hsiHeading?.degrees === state.hsiHeading?.degrees &&
        previous.state.hsiHeading?.source === state.hsiHeading?.source &&
        previous.state.attitude?.status === state.attitude?.status &&
        previous.state.attitude?.headingStatus === state.attitude?.headingStatus &&
        previous.state.attitude?.attitudeStd[2] === state.attitude?.attitudeStd[2] &&
        previous.state.phase === state.phase &&
        previous.state.crossed === state.crossed && previous.state.warning === state.warning &&
        previous.state.gpsLive === state.gpsLive && previous.state.gpsUsable === state.gpsUsable &&
        previous.state.position === state.position && previous.state.track === state.track &&
        previous.state.speed === state.speed && previous.state.altitude === state.altitude &&
        previous.values.altitudeFeet === values.altitudeFeet &&
        previous.values.verticalSpeed?.feetPerMinute === values.verticalSpeed?.feetPerMinute &&
        previous.values.verticalSpeed?.roundedFeetPerMinute === values.verticalSpeed?.roundedFeetPerMinute &&
        previous.values.groundspeedKnots === values.groundspeedKnots ? previous : { state, values });
    };
    const sync = () => {
      const { phase } = layer.getSnapshot();
      if (phase === 'idle' || phase === 'error') {
        cancel?.(); cancel = undefined;
        draw(performance.now());
      } else if (!cancel) cancel = startDisplayFrames(draw);
    };
    const unsubscribe = layer.subscribe(sync);
    sync();
    return () => { unsubscribe(); cancel?.(); };
  }, [layer, active]);
  return <>
    <div className="ahrs-primary-display">
      <InstrumentPanel state={view.state} values={view.values} />
      {diagnostics && view.state.phase === 'ready' && <AhrsDiagnostics layer={layer} active={active} />}
    </div>
    <Hsi state={view.state} route={route} active={active} magneticModel={magneticModel} />
  </>;
});

/** Shared layout for live instruments, the Test demo and geometry checks. */
export function InstrumentPanel({ state, values }: {
  state: Parameters<typeof Horizon>[0]; values: InstrumentValues;
}) {
  return <div className="ahrs-instrument">
    <div className="ahrs-attitude-display">
      <Horizon {...state} />
      <FlightReadings values={values} />
    </div>
  </div>;
}
