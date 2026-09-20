import { isRecord } from '@zlayer/contracts';

/** Small, versioned UI records. Loading defaults never overwrites saved intent. */
export function readUiState<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const record: unknown = JSON.parse(window.localStorage.getItem(`zlayer-ui:${key}`) ?? 'null');
    return isRecord(record) && record.version === 1 && valid(record.value) ? record.value : fallback;
  } catch { return fallback; }
}

export function writeUiState(key: string, value: unknown): void {
  try { window.localStorage.setItem(`zlayer-ui:${key}`, JSON.stringify({ version: 1, value: value ?? null })); }
  catch { /* Storage is optional; the current session remains usable. */ }
}

export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
export const isString = (value: unknown): value is string => typeof value === 'string';
