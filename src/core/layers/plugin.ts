import type { PluginConnection } from './bridge';
import type { ComponentType } from 'react';
import type { MapContribution } from '../map/contribution';
import type { PluginStorage } from '../storage/plugin-storage';
import type { PreferenceSlice } from '../storage/preferences';
import type { LayerDefinition } from './product';

export type PanelContribution = {
  readonly id: string;
  readonly title: string;
  readonly Component: ComponentType;
  readonly close?: () => void;
};
export type UiContribution = { readonly id: string; readonly Component: ComponentType };

/** Trusted feature modules expose ordinary components and a lazy rendering entry. */
export type LayerPlugin = {
  readonly definition: LayerDefinition;
  /** Workspace-bound public API registration and optional integrations. */
  readonly communication?: PluginConnection;
  /** Loading includes dependencies; unloading includes their dependents. */
  readonly requires?: readonly string[];
  readonly storage?: PluginStorage;
  readonly preferences?: PreferenceSlice<object>;
  readonly mapContribution?: MapContribution;
  readonly panels?: readonly PanelContribution[];
  readonly controls?: readonly UiContribution[];
  readonly footer?: readonly UiContribution[];
  readonly overlays?: readonly UiContribution[];
  /** Release live work on unload; keep intent and allow this instance to be loaded again. */
  readonly dispose?: () => void;
};

export function layerPlugins<T extends readonly LayerPlugin[]>(plugins: T): T {
  const ids = new Set<string>();
  const contributions = new Set<string>();
  const maps = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.definition.id)) throw new Error(`Duplicate layer plugin: ${plugin.definition.id}`);
    ids.add(plugin.definition.id);
    if (plugin.mapContribution) {
      if (maps.has(plugin.mapContribution.id)) throw new Error(`Duplicate map contribution: ${plugin.mapContribution.id}`);
      maps.add(plugin.mapContribution.id);
    }
    if (plugin.storage && plugin.storage.pluginId !== plugin.definition.id) {
      throw new Error(`Plugin storage identity must match ${plugin.definition.id}`);
    }
    if (plugin.preferences && plugin.preferences.key !== plugin.storage?.slot('preferences').key) {
      throw new Error(`Preferences must use the storage scope for ${plugin.definition.id}`);
    }
    for (const [kind, values] of [['panel', plugin.panels], ['control', plugin.controls], ['overlay', plugin.overlays], ['footer', plugin.footer]] as const) {
      for (const value of values ?? []) {
        const key = `${kind}:${value.id}`;
        if (contributions.has(key)) throw new Error(`Duplicate layer contribution: ${key}`);
        contributions.add(key);
      }
    }
  }
  return plugins;
}
