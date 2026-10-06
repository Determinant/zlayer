import type { NotamRecord } from '@zlayer/contracts';
import { createLayerStore } from '../../core/layers/store';
import { notamChartKey } from './public';

/** Each visible reader owns one transient preview. Cached/retained airport demand is separate. */
export function createNotamMapPreviews() {
  const owners = new Map<symbol, readonly NotamRecord[]>();
  const state = createLayerStore<readonly NotamRecord[]>([]);
  const charted = createLayerStore<readonly string[]>([]);
  const highlights = new Map<symbol, { owner: symbol; key: string }>();
  const highlighted = createLayerStore<string | undefined>(undefined);
  const emphasize = () => {
    for (const [token, { owner, key }] of highlights) {
      if (!owners.get(owner)?.some(record => notamChartKey(record) === key)) highlights.delete(token);
    }
    const key = [...highlights.values()].reverse().find(value => charted.getSnapshot().includes(value.key))?.key;
    if (key !== highlighted.getSnapshot()) highlighted.publish(key);
  };
  const show = (keys: readonly string[]) => {
    const previous = charted.getSnapshot();
    if (keys.length !== previous.length || keys.some((key, i) => key !== previous[i])) charted.publish(keys);
    emphasize();
  };
  const publish = () => {
    const records = [...new Map([...owners.values()].flat().map(record => [record.id, record])).values()];
    const previous = state.getSnapshot();
    if (records.length !== previous.length || records.some((record, i) => record !== previous[i])) state.publish(records);
    emphasize();
  };
  return {
    state, charted, highlighted, show,
    open() {
      const owner = Symbol(); owners.set(owner, []);
      return {
        update(records: readonly NotamRecord[]) { if (owners.has(owner)) { owners.set(owner, records); publish(); } },
        highlight(key: string) {
          const token = Symbol(); highlights.set(token, { owner, key }); emphasize();
          return () => { if (highlights.delete(token)) emphasize(); };
        },
        release() { if (owners.delete(owner)) publish(); },
      };
    },
    clear() { owners.clear(); show([]); publish(); },
  };
}
