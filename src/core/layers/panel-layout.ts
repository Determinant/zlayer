import type { PanelPlacement } from '../ui/edge-panels';

export type PanelLayout = Readonly<Record<string, PanelPlacement>>;

/** Validate the entire reservation table, including currently unmounted panels. */
export function validatePanelLayout(layout: PanelLayout): void {
  const slots = new Map<string, string>();
  for (const [id, { side, tab }] of Object.entries(layout)) {
    if (!['left', 'right'].includes(side) || !['top', 'bottom'].includes(tab.edge)
      || !Number.isSafeInteger(tab.order) || tab.order < 0) throw new Error(`Invalid panel placement: ${id}`);
    const key = `${side}:${tab.edge}:${tab.order}`;
    const previous = slots.get(key);
    if (previous) throw new Error(`Panel slot collision: ${previous} and ${id} (${key})`);
    slots.set(key, id);
  }
}

export function panelPlacement(layout: PanelLayout, id: string): PanelPlacement {
  const placement = layout[id];
  if (!placement) throw new Error(`Missing panel placement: ${id}`);
  return placement;
}
