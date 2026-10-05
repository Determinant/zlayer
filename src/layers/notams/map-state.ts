import type { NotamRecord } from '@zlayer/contracts';
import { createLayerStore } from '../../core/layers/store';

/** Each visible reader owns one transient preview. Cached/retained airport demand is separate. */
export function createNotamMapPreviews() {
  const owners = new Map<symbol, readonly NotamRecord[]>();
  const state = createLayerStore<readonly NotamRecord[]>([]);
  const charted = createLayerStore<readonly string[]>([]);
  const show = (keys: readonly string[]) => {
    const previous = charted.getSnapshot();
    if (keys.length !== previous.length || keys.some((key, i) => key !== previous[i])) charted.publish(keys);
  };
  const publish = () => {
    const records = [...new Map([...owners.values()].flat().map(record => [record.id, record])).values()];
    const previous = state.getSnapshot();
    if (records.length !== previous.length || records.some((record, i) => record !== previous[i])) state.publish(records);
  };
  return {
    state, charted, show,
    open() {
      const owner = Symbol(); owners.set(owner, []);
      return {
        update(records: readonly NotamRecord[]) { if (owners.has(owner)) { owners.set(owner, records); publish(); } },
        release() { if (owners.delete(owner)) publish(); },
      };
    },
    clear() { owners.clear(); show([]); publish(); },
  };
}
