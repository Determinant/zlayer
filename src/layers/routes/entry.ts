import { ROUTE_DELIMITER } from '@zlayer/domain';

export type RouteEntryUpdate = {
  value: string;
  commit?: string;
};

export function updateRouteEntry(rawValue: string): RouteEntryUpdate {
  const value = rawValue.toUpperCase();
  return ROUTE_DELIMITER.test(value)
    ? { value: '', commit: value }
    : { value };
}

export function backspaceRouteTokenIndex(
  key: string,
  entry: string,
  tokenCount: number,
): number | undefined {
  return key === 'Backspace' && entry.length === 0 && tokenCount > 0
    ? tokenCount - 1
    : undefined;
}
