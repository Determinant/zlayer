import type { ComponentType } from 'react';
import type { PanelPlacement } from '../ui/edge-panels';

/** A cohesive workspace feature. Its presentation need not be on the map. */
export type LayerDefinition = { readonly id: string; readonly title: string };
export type ProductLayer = { readonly definition: LayerDefinition };

/** A product can contribute a panel without depending on MapLibre. */
export type PanelLayer = ProductLayer & {
  readonly panel: PanelPlacement;
  readonly Panel: ComponentType;
  close?: () => void;
};
