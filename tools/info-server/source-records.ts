import type { SourceRecord } from '../../src/layers/weather-awc/grids/native-source';
import { MiB, modelResource, type Resource } from './routes';

export const sourceRecordKey = (record: SourceRecord): string => JSON.stringify([record.path, record.start, record.end, record.indexHash]);
export type SourceBlock = { start: number; resource: Resource };

/** Adjacent model records from one immutable index share a bounded cache fill.
 * This is a download plan, not another cache or an upstream proxy endpoint. */
export function sourceBlocks(records: readonly SourceRecord[]): ReadonlyMap<string, SourceBlock> {
  const unique = new Map(records.map(record => [sourceRecordKey(record), record]));
  const ordered = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.indexHash.localeCompare(b.indexHash) || a.start - b.start);
  const blocks = new Map<string, SourceBlock>();
  let group: SourceRecord[] = [];
  const finish = () => {
    if (!group.length) return;
    const first = group[0]!, last = group.at(-1)!;
    const resource = modelResource(first.path, `bytes=${first.start}-${last.end ?? ''}`, first.indexHash);
    if (group.length > 1) resource.multipleGribs = true;
    const block = { start: first.start, resource };
    for (const record of group) blocks.set(sourceRecordKey(record), block);
    group = [];
  };
  for (const record of ordered) {
    const first = group[0], last = group.at(-1);
    if (first && last && (record.path !== first.path || record.indexHash !== first.indexHash ||
      last.end === undefined || record.start !== last.end + 1 || record.end === undefined || record.end - first.start + 1 > 8 * MiB)) finish();
    group.push(record);
  }
  finish();
  return blocks;
}
