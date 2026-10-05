import type { NotamAirportQuery, NotamAirportSnapshot, NotamRecord } from '@zlayer/contracts';
import type { LayerStore } from '../../core/layers/store';
import type { MapContextAction } from '../../core/map/selection';

export type AirportNotamsState = { snapshot?: NotamAirportSnapshot; loading: boolean; error?: string; retrievedAt?: number };
export type NotamsState = { airports: Readonly<Record<string, AirportNotamsState>>; now: number };
export type NotamMapPreview = { update(records: readonly NotamRecord[]): void; release(): void };
export type NotamsApi = {
  contextActions(point: { x: number; y: number }): MapContextAction[];
  readonly state: LayerStore<NotamsState>;
  /** Current record revisions accepted by the live map; empty on clear, failure or teardown. */
  readonly charted: LayerStore<readonly string[]>;
  /** Each mounted consumer owns a release function; offline demand still updates time labels. */
  retain(query: NotamAirportQuery, online: boolean): () => void;
  /** Visible readers lease temporary map context separately from cached query demand. */
  previewChart(): NotamMapPreview;
  retry(): void;
};
