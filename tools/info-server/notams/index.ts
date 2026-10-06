import { NOTAM_AIRPORT_MAX_RECORDS, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import { NotamError } from './error';
import type { NotamGeneration } from './store';

function union<T extends { id: string }>(groups: readonly (readonly T[])[], limit: number): T[] {
  const found = new Map<string, T>();
  for (const group of groups) for (const entry of group) {
    found.set(entry.id, entry);
    if (found.size > limit) throw new NotamError('airport-size-limit');
  }
  return [...found.values()];
}
function add<T>(map: Map<string, T[]>, codes: readonly string[], entry: T) {
  for (const code of codes) {
    const group = map.get(code) ?? []; group.push(entry); map.set(code, group);
  }
}

/** Pure local membership. Publish all indexes together after a durable generation
 * commits; unchanged source-status updates reuse them without rebuilding. */
export class NotamIndex {
  private records: readonly NotamRecord[] | undefined;
  private issues: readonly NotamSourceIssue[] | undefined;
  private domestic = new Map<string, NotamRecord[]>();
  private icao = new Map<string, NotamRecord[]>();
  private domesticIssues = new Map<string, NotamSourceIssue[]>();
  private icaoIssues = new Map<string, NotamSourceIssue[]>();
  private unscoped: NotamSourceIssue[] = [];
  get unscopedCount() { return this.unscoped.length; }
  publish(generation: NotamGeneration) {
    if (this.records === generation.records && this.issues === generation.issues) return;
    const domestic = new Map<string, NotamRecord[]>(), icao = new Map<string, NotamRecord[]>();
    const domesticIssues = new Map<string, NotamSourceIssue[]>(), icaoIssues = new Map<string, NotamSourceIssue[]>();
    const unscoped: NotamSourceIssue[] = [];
    for (const record of generation.records) {
      if (record.lifecycle === 'cancelled' || record.lifecycle === 'cancellation') continue;
      add(domestic, record.locations, record); add(icao, record.icaoLocations, record);
    }
    for (const issue of generation.issues ?? []) {
      if (issue.unscoped) unscoped.push(issue);
      else { add(domesticIssues, issue.locations, issue); add(icaoIssues, issue.icaoLocations, issue); }
    }
    this.domestic = domestic; this.icao = icao; this.domesticIssues = domesticIssues; this.icaoIssues = icaoIssues;
    this.unscoped = unscoped; this.records = generation.records; this.issues = generation.issues;
  }
  read(domestic?: string, icao?: string) {
    const records = union([domestic ? this.domestic.get(domestic) ?? [] : [], icao ? this.icao.get(icao) ?? [] : []], NOTAM_AIRPORT_MAX_RECORDS);
    const issues = union([this.unscoped, domestic ? this.domesticIssues.get(domestic) ?? [] : [],
      icao ? this.icaoIssues.get(icao) ?? [] : []], NOTAM_AIRPORT_MAX_RECORDS - records.length);
    return { records, issues };
  }
}
