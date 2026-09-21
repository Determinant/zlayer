import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlateMapMenu } from '../../src/layers/plates/map-menu';
import '../../src/styles.css';

let effectSetups = 0;

function Fixture() {
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const [visible, setVisible] = useState(true);
  useEffect(() => { document.body.dataset.effectSetups = String(++effectSetups); }, []);
  return <main className="map-stage" style={{ height: '100dvh' }}>
    <canvas tabIndex={0} role="region" aria-label="Test map" style={{ width: '100%', height: '100%' }}
      onContextMenu={event => {
        event.preventDefault();
        event.currentTarget.focus();
        if (visible) setPoint({ x: event.clientX, y: event.clientY });
      }} />
    <output style={{ position: 'absolute', top: 12, left: 12 }}>{visible ? 'Plate shown' : 'Plate hidden'}</output>
    {point && <PlateMapMenu point={point} onClose={() => setPoint(undefined)}
      onHide={() => { setVisible(false); setPoint(undefined); }} />}
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
