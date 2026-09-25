import type { ProgsCoverageCatalog, ProgsCoverageFrame } from '@zlayer/contracts';

/** Native chart stops, with explicit missing entries breaking each interval. */
export function progsCoverageFrame(catalog: ProgsCoverageCatalog | undefined, selected: number | null, now: number): ProgsCoverageFrame | undefined {
  if (!catalog) return undefined;
  const analysis = catalog.frames.find(frame => frame.validTime === frame.chartReferenceTime);
  const recent = analysis && analysis.validTime <= now && now - analysis.validTime < 6 * 3600_000 ? analysis : undefined;
  if (selected === null) return recent;
  const forecasts = catalog.frames.filter(frame => frame.validTime > frame.chartReferenceTime);
  if (recent && selected >= recent.validTime && forecasts[0] && selected < forecasts[0].validTime) return recent;
  const index = forecasts.reduce((last, frame, index) => frame.validTime <= selected ? index : last, -1);
  const frame = forecasts[index], next = forecasts[index + 1];
  return frame && (frame.validTime === selected || next && selected < next.validTime) ? frame : undefined;
}
