import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EdgePanels } from '../../src/core/ui/edge-panels';
import type { WeatherController } from '../../src/layers/weather-awc/controller';
import { PirepDetails } from '../../src/layers/weather-awc/pireps/controls';
import '@fontsource/b612/400.css';
import '@fontsource/b612/700.css';
import '../../src/styles.css';
import '../../src/layers/weather-awc/styles.css';

export function mountPirepPanel(controller: WeatherController) {
  function Panel() {
    const [active, setActive] = useState<string | null>(null);
    return <div className="map-stage" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'transparent' }}>
      <EdgePanels side="right" active={active} onActiveChange={setActive} className="side-panels">
        <PirepDetails controller={controller} />
      </EdgePanels>
    </div>;
  }
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element); root.render(<Panel />);
  window.addEventListener('pagehide', () => root.unmount(), { once: true });
}
