import { NOTAM_AIRPORT_MAX_RECORDS, type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import { NotamError } from './error';
import type { NotamGeneration } from './store';
import { classifyNotamIssue, describeNotamIssue, emptyNotamIssueSummary } from './source-issues';

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
  private historicalDomestic = new Map<string, NotamSourceIssue[]>();
  private historicalIcao = new Map<string, NotamSourceIssue[]>();
  private generation: NotamGeneration | undefined;
  private assessedAt = -Infinity;
  private nextTransitionAt = Infinity;
  private summary = emptyNotamIssueSummary();
  constructor(private readonly now = Date.now) {}
  private update() { if (this.generation) this.publish(this.generation); }
  get unscopedCount() { this.update(); return this.unscoped.length; }
  get sourceIssues() { this.update(); return this.summary; }
  publish(generation: NotamGeneration) {
    const now = this.now(); this.generation = generation;
    if (this.records === generation.records && this.issues === generation.issues && now >= this.assessedAt && now < this.nextTransitionAt) return;
    const domestic = new Map<string, NotamRecord[]>(), icao = new Map<string, NotamRecord[]>();
    const domesticIssues = new Map<string, NotamSourceIssue[]>(), icaoIssues = new Map<string, NotamSourceIssue[]>();
    const unscoped: NotamSourceIssue[] = [];
    const historicalDomestic = new Map<string, NotamSourceIssue[]>(), historicalIcao = new Map<string, NotamSourceIssue[]>();
    let nextTransitionAt = Infinity;
    const summary = emptyNotamIssueSummary();
    for (const record of generation.records) {
      if (record.lifecycle === 'cancelled' || record.lifecycle === 'cancellation') continue;
      add(domestic, record.locations, record); add(icao, record.icaoLocations, record);
    }
    for (const issue of generation.issues ?? []) {
      const classification = classifyNotamIssue(issue, now), { resolved, blocking, applicability } = classification;
      nextTransitionAt = Math.min(nextTransitionAt, applicability.nextTransitionAt ?? Infinity);
      summary.total++;
      if (resolved) summary.associationOnly++; else summary.contentUnresolved++;
      if (issue.unscoped) summary.unscoped++;
      if (blocking) summary.blocking++; else summary.nonBlocking++;
      if (summary.samples.length < 16) summary.samples.push(describeNotamIssue(issue, classification));
      else summary.samplesTruncated = true;
      if (applicability.state === 'historical') {
        summary.historical++;
        if (classification.metadataOnly) summary.historicalMetadata++;
        add(historicalDomestic, issue.locations, issue); add(historicalIcao, issue.icaoLocations, issue);
        continue;
      }
      if (resolved) { add(domestic, resolved.locations, resolved); add(icao, resolved.icaoLocations, resolved); }
      if (issue.unscoped) unscoped.push(issue);
      else { add(domesticIssues, issue.locations, issue); add(icaoIssues, issue.icaoLocations, issue); }
    }
    this.domestic = domestic; this.icao = icao; this.domesticIssues = domesticIssues; this.icaoIssues = icaoIssues;
    this.unscoped = unscoped; this.records = generation.records; this.issues = generation.issues;
    this.summary = summary;
    this.historicalDomestic = historicalDomestic; this.historicalIcao = historicalIcao;
    this.assessedAt = now; this.nextTransitionAt = nextTransitionAt;
  }
  read(domestic?: string, icao?: string) {
    this.update();
    const records = union([domestic ? this.domestic.get(domestic) ?? [] : [], icao ? this.icao.get(icao) ?? [] : []], NOTAM_AIRPORT_MAX_RECORDS);
    const qualified = new Set(records.map(r => r.id));
    const issues = union([this.unscoped, domestic ? this.domesticIssues.get(domestic) ?? [] : [],
      icao ? this.icaoIssues.get(icao) ?? [] : []].map(group => group.filter(issue => !qualified.has(issue.id))), NOTAM_AIRPORT_MAX_RECORDS - records.length);
    const historicalIssues = union([domestic ? this.historicalDomestic.get(domestic) ?? [] : [],
      icao ? this.historicalIcao.get(icao) ?? [] : []], NOTAM_AIRPORT_MAX_RECORDS - records.length - issues.length);
    return { records, issues, ...(historicalIssues.length ? { historicalIssues } : {}) };
  }
}
