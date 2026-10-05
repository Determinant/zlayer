import type { NotamAirportQuery, NotamAirportSnapshot } from '@zlayer/contracts';
import type { LayerStore } from '../../core/layers/store';

export type AirportNotamsState = { snapshot?: NotamAirportSnapshot; loading: boolean; error?: string; retrievedAt?: number };
export type NotamsState = { airports: Readonly<Record<string, AirportNotamsState>>; now: number };
export type NotamsApi = {
  readonly state: LayerStore<NotamsState>;
  /** Each mounted consumer owns a release function; offline demand still updates time labels. */
  retain(query: NotamAirportQuery, online: boolean): () => void;
  retry(): void;
};
