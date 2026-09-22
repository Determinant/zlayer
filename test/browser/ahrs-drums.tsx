import { createRoot } from 'react-dom/client';
import '@fontsource/b612/400.css';
import { InstrumentPanel } from '../../src/layers/ahrs/instruments';
import '../../src/core/ui/styles.css';
import '../../src/layers/ahrs/styles.css';

const readings = [
  [0, 0], [1, 1], [9, 9], [9.5, 19], [10, 20], [99, 80], [99.5, 90], [100, 100],
  [109.5, 190], [199.5, 990], [200, 1000], [999.5, 9990], [1000, 10000],
  [1999.5, 19990], [2000, 20000], [99999.5, 99990], [100000, 100000],
  [0, -1], [9, -90], [10, -100], [99, -9990], [100, -10000],
  [999999, 999980], [999999.5, -999990],
] as const;

createRoot(document.getElementById('root')!).render(<main>
  {readings.map(([groundspeedKnots, altitudeFeet]) =>
    <section className="ahrs-tool" key={`${groundspeedKnots}/${altitudeFeet}`}>
      <p>GS {groundspeedKnots} / ALT {altitudeFeet}</p>
      <InstrumentPanel state={{ attitude: null, crossed: false, warning: '' }}
        values={{ groundspeedKnots, altitudeFeet, verticalSpeed: null }} />
    </section>)}
</main>);
