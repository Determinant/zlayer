import { memo, useEffect, useState } from 'react';
import type { AhrsLayer } from './layer';
import { Horizon } from './horizon';
import { FlightReadings } from './flight-readings';
import { InstrumentDisplay, type InstrumentValues } from './instrument-display';
import { startDisplayFrames } from './display-frames';

/** One display clock for the horizon, tapes and drums. The parent status updates
 * do not trigger extra instrument renders or change sensor/calibration timing. */
export const AhrsInstruments = memo(function AhrsInstruments({ layer, active }: {
  layer: Pick<AhrsLayer, 'getSnapshot' | 'readDisplaySnapshot' | 'subscribe'>; active: boolean;
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
        previous.state.crossed === state.crossed && previous.state.warning === state.warning &&
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
  return <InstrumentPanel state={view.state} values={view.values} />;
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
