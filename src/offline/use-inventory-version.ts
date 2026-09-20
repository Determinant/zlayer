import { useEffect, useState } from 'react';
import { observeOfflineInventory } from './inventory-events';

/** Retry partial reads after a repair or download in this tab or another tab. */
export function useInventoryVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => observeOfflineInventory(() => setVersion(value => value + 1)), []);
  return version;
}
