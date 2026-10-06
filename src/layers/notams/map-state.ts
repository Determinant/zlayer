import type { NotamRecord, TfrNotice } from '@zlayer/contracts';
import { createLayerStore } from '../../core/layers/store';
import { notamChartKey } from './public';
import { chartedTfrReference } from './tfr-reference';

/** Each visible reader owns one transient preview. Cached/retained airport demand is separate. */
export function createNotamMapPreviews() {
  const owners = new Map<symbol, readonly NotamRecord[]>();
  const state = createLayerStore<readonly NotamRecord[]>([]);
  const charted = createLayerStore<readonly string[]>([]);
  const chartedTfrs = createLayerStore<readonly TfrNotice[]>([]);
  const tfrMatches = new Map<string, string>();
  const highlights = new Map<symbol, { owner: symbol; key: string }>();
  const highlighted = createLayerStore<string | undefined>(undefined);
  const highlightedTfr = createLayerStore<string | undefined>(undefined);
  const matchTfrs = () => {
    tfrMatches.clear();
    for (const record of state.getSnapshot()) {
      const tfr = chartedTfrReference(record, chartedTfrs.getSnapshot());
      if (tfr) tfrMatches.set(notamChartKey(record), tfr.id);
    }
  };
  const emphasize = () => {
    for (const [token, { owner, key }] of highlights) {
      if (!owners.get(owner)?.some(record => notamChartKey(record) === key)) highlights.delete(token);
    }
    const key = [...highlights.values()].reverse().find(value => charted.getSnapshot().includes(value.key) || tfrMatches.has(value.key))?.key;
    if (key !== highlighted.getSnapshot()) highlighted.publish(key);
    const tfr = key ? tfrMatches.get(key) : undefined;
    if (tfr !== highlightedTfr.getSnapshot()) highlightedTfr.publish(tfr);
  };
  const showTfrs = (notices: readonly TfrNotice[]) => {
    const previous = chartedTfrs.getSnapshot();
    if (notices.length !== previous.length || notices.some((notice, i) => notice !== previous[i])) {
      chartedTfrs.publish(notices); matchTfrs(); emphasize();
    }
  };
  const show = (keys: readonly string[]) => {
    const previous = charted.getSnapshot();
    if (keys.length !== previous.length || keys.some((key, i) => key !== previous[i])) charted.publish(keys);
    emphasize();
  };
  const publish = () => {
    const records = [...new Map([...owners.values()].flat().map(record => [record.id, record])).values()];
    const previous = state.getSnapshot();
    if (records.length !== previous.length || records.some((record, i) => record !== previous[i])) {
      state.publish(records); matchTfrs();
    }
    emphasize();
  };
  return {
    state, charted, chartedTfrs, highlighted, highlightedTfr, show, showTfrs,
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
    clear() { owners.clear(); show([]); showTfrs([]); publish(); },
  };
}
