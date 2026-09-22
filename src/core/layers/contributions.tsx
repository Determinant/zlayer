import { memo } from 'react';
import type { UiContribution } from './plugin';
import { ErrorBoundary } from './error-boundary';

export const LayerContributions = memo(function LayerContributions({ contributions }: { contributions: readonly UiContribution[] }) {
  return contributions.map(({ id, Component }) => <ErrorBoundary key={id}
    fallback={error => <p className="product-panel-error" role="alert">{id}: {error.message}</p>}>
    <Component />
  </ErrorBoundary>);
});
