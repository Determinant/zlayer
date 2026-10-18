import type { AircraftReport, PirepSnapshot, NavigationData } from '@zlayer/contracts';
import type { MagneticModel } from '../../../core/geo/magnetic-model';
import { readPirepLocation } from './location';
import { createPirepLocationReferences } from './location-references';
import { readPirepField } from './text';

export type LocatedPirep = AircraftReport & { decodedLocation?: string; locationEstimated?: boolean; locationReferenceOnly?: boolean };
export type PirepLocations = { reports: LocatedPirep[]; issues: PirepSnapshot['issues'] };

/** Derived view only: never overwrite the source snapshot or persist a decoded
 * point without the navigation/model identity that produced it. */
export function createPirepLocations() {
  let previous: PirepSnapshot | undefined, navigation: NavigationData | undefined, magnetic: MagneticModel | undefined;
  let resolve: ReturnType<typeof createPirepLocationReferences> | undefined, result: PirepLocations | undefined;
  return (snapshot: PirepSnapshot | undefined, data?: NavigationData, model?: MagneticModel): PirepLocations | undefined => {
    if (snapshot === previous && data === navigation && model === magnetic) return result;
    if (data !== navigation || model !== magnetic) resolve = undefined;
    previous = snapshot; navigation = data; magnetic = model;
    if (!snapshot) return result = undefined;
    const reports = new Map<string, LocatedPirep>(snapshot.reports.map(report => [report.id, report]));
    const issues: PirepSnapshot['issues'] = [];
    for (const issue of snapshot.issues) {
      const report = issue.report;
      if (!report || !['PIREP', 'Urgent PIREP'].includes(report.type)) { issues.push(issue); continue; }
      const parsed = readPirepLocation(report.text);
      if ('reason' in parsed) { issues.push({ ...issue, reason: parsed.reason }); continue; }
      resolve ??= createPirepLocationReferences(data, model);
      const station = issue.sourceCoordinate && readPirepField(report.text, 'OV')?.station;
      const hint = station && issue.sourceCoordinate ? { station, coordinate: issue.sourceCoordinate } : undefined;
      const location = resolve(parsed.location, report.observedAt, hint);
      if ('reason' in location) { issues.push({ ...issue, reason: location.reason }); continue; }
      const prior = reports.get(report.id);
      if (!prior || (report.receivedAt ?? Infinity) < (prior.receivedAt ?? Infinity)) {
        reports.set(report.id, { ...report, sourceXml: issue.sourceXml,
          longitude: location.coordinate[0], latitude: location.coordinate[1], decodedLocation: location.description,
          ...(location.estimated ? { locationEstimated: true } : {}),
          ...(location.referenceOnly ? { locationReferenceOnly: true } : {}) });
      }
    }
    return result = { reports: [...reports.values()].sort((a, b) => b.observedAt - a.observedAt || a.id.localeCompare(b.id)), issues };
  };
}
