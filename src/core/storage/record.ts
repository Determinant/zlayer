import { readUiState, writeUiState } from './ui-state';

/** Records describe saved intent; controllers, subscriptions and live data stay private. */
export type PersistentRecord<T> = {
  readonly key: string;
  readonly version: number;
  read(): T;
  write(value: T): void;
};

/** Reuse the existing versioned UI envelope and namespaced keys. */
export function uiRecord<T>(key: string, fallback: T, valid: (value: unknown) => value is T): PersistentRecord<T> {
  return { key: `zlayer-ui:${key}`, version: 1,
    read: () => readUiState(key, fallback, valid), write: value => writeUiState(key, value) };
}
