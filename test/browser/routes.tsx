// Local, network-free route editor fixture. Not included in production builds.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CatalogResponse, FeatureCollectionResponse } from '@zlayer/contracts';
import { createRouteResolver } from '@zlayer/domain';
import { RouteBar } from '../../src/layers/routes/bar';
import { appendRouteText, insertRouteTextBefore, moveRouteEntry, removeRouteEntry, replaceRouteText,
  routeDraftFromText } from '../../src/layers/routes/draft';
import '../../src/styles.css';

const navigation: FeatureCollectionResponse = { type: 'FeatureCollection', features: ['KSFO', 'KSJC'].map((ident, i) => ({
  type: 'Feature', id: ident, geometry: { type: 'Point', coordinates: [-122 + i, 37] }, properties: { ident },
})), meta: { layer: 'airports', revision: '2026-09-03', returned: 2, truncated: false } };
const resolve = createRouteResolver([navigation]);
const catalog: CatalogResponse = { schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-16T00:00:00Z',
  navigation: [], charts: [], weather: [] };

function Fixture() {
  const [draft, setDraft] = useState(() => routeDraftFromText('KSFO UNKNOWN KSJC'));
  const [, refresh] = useState(0);
  const plan = resolve(draft);
  useEffect(() => {
    const update = () => refresh(value => value + 1);
    window.addEventListener('route-fixture-refresh', update);
    return () => window.removeEventListener('route-fixture-refresh', update);
  }, []);
  useEffect(() => {
    if (new URLSearchParams(location.search).has('open')) {
      document.querySelector<HTMLDetailsElement>('details.route-summary')?.setAttribute('open', '');
    }
  }, []);
  return <main className="app-shell">
    <header style={{ padding: 12 }}>Route regression checks</header>
    <RouteBar plan={plan} status="ready" catalog={catalog}
      onUseRoute={setDraft} onClear={() => setDraft(routeDraftFromText(''))} onFit={() => {}}
      onAppendInput={input => setDraft(current => appendRouteText(current, input))}
      onInsertInput={(index, input) => setDraft(current => insertRouteTextBefore(current, index, input))}
      onReplaceInput={(entryId, input) => setDraft(current => replaceRouteText(current, entryId, input))}
      onRemoveEntry={index => setDraft(current => removeRouteEntry(current, index))}
      onMoveEntry={(from, to) => setDraft(current => moveRouteEntry(current, from, to))} />
    <section style={{ padding: '120px 16px 16px' }}>
      <p>Open the warning to read the error. Clear the route and paste KSFO DCT KSJC: one direct leg should appear.</p>
      <output>{plan.legs.length} legs; {plan.issues.length} issues</output>
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
