import type { RoutePlan } from '@zlayer/domain';

/** Temporary map plans; selecting a preview does not edit the saved route. */
export type RoutePreview = {
  routes: { key: string; plan: RoutePlan }[];
  selectedKey: string;
};
export type RoutePreviewInset = { right: number; bottom: number };
export type RouteMapPreview = RoutePreview & { inset: RoutePreviewInset; preserveView?: boolean };
