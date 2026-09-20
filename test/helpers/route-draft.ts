import { routeDraftText, routeEntryPins, type RouteDraft } from '@zlayer/domain';

/** Compare filing behavior independently of freshly allocated entry identities. */
export function draftSnapshot(draft: RouteDraft | undefined) {
  return draft ? { input: routeDraftText(draft), pinnedFeatureIds: routeEntryPins(draft.entries) } : undefined;
}
