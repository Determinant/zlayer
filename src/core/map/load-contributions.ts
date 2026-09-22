import type { MapContribution, MapContributionContext } from './contribution';
import type { MapLayerModule } from './layer';

/** Factories construct detached adapters. Attachment and effects start at mount(). */
export async function loadMapContributions(contributions: readonly MapContribution[], context: MapContributionContext): Promise<readonly MapLayerModule<void>[]> {
  const results = await Promise.allSettled(contributions.map(contribution => Promise.resolve().then(() => {
    context.signal.throwIfAborted();
    return contribution.load(context);
  })));
  if (context.signal.aborted) return [];
  return results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [...result.value];
    // Report import failures through the same host boundary as mount failures.
    return [{ id: contributions[index]!.id, slot: 'navigation' as const,
      mount() { throw result.reason; }, update() {}, unmount() {} }];
  });
}
