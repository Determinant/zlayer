import type { FlightCategory, TafForecast, TafReport } from '@zlayer/contracts';
import { parseTafGroups, type TafGroupHeader } from './taf-parser.js';
import { tafCategories } from './taf-conditions.js';

export type TafLine = {
  text: string;
  category: FlightCategory | undefined;
  fm?: { token: string; time: string };
};

/** Keep the coded text; decoded AWC fields are used only to choose its color. */
export function tafReportLines(report: TafReport): TafLine[] {
  const parsed = parseTafGroups(report.rawTAF);
  const lines: TafLine[] = parsed.groups.map(group => ({
    text: report.rawTAF.slice(group.start, group.end).trim(), category: undefined,
  }));
  const groups = parsed.groups.filter(group => group.header.kind !== 'remarks');
  // A decoding mismatch must never attach another period's category to raw text.
  const aligned = parsed.complete && !parsed.unavailable && groups.length === report.fcsts.length &&
    groups.every((group, index) => matchesForecast(group.header, report.fcsts[index]!, index));
  if (!aligned) return lines;
  const categories = tafCategories(report, groups);
  for (const [index, group] of groups.entries()) {
    const line = lines[index]!;
    line.category = categories[index];
    if (group.header.kind === 'FM') {
      const { start, end } = group.header.source;
      line.fm = { token: report.rawTAF.slice(start, end), time: new Date(report.fcsts[index]!.timeFrom * 1000).toISOString() };
    }
  }
  return lines;
}

function matchesForecast(header: TafGroupHeader, forecast: TafForecast, index: number): boolean {
  const change = forecast.fcstChange?.trim().toUpperCase() ?? '';
  const decodedKind = change === 'INTER' ? 'TEMPO' : change;
  if (index === 0) return header.kind === 'initial' && !decodedKind && !forecast.probability;
  switch (header.kind) {
    case 'FM':
      return decodedKind === 'FM' && !forecast.probability && matchesTime(header.from, forecast.timeFrom);
    case 'BECMG': case 'TEMPO': case 'PROB': {
      if ((header.probability ?? 0) !== (forecast.probability ?? 0)) return false;
      // AWC maps INTER to TEMPO; combined probability groups may use either
      // conditional kind. Probability and both time bounds still have to match.
      if (header.probability ? !['PROB', 'TEMPO'].includes(decodedKind) : header.kind !== decodedKind) return false;
      const end = header.kind === 'BECMG' ? forecast.timeBec : forecast.timeTo;
      return end != null && matchesTime(header.from, forecast.timeFrom) && matchesTime(header.to, end);
    }
    default: return false;
  }
}

/** Compare against the decoded UTC date, including DD24 at month/year end. */
function matchesTime(token: string, epochSeconds: number): boolean {
  const day = Number(token.slice(0, 2)), hour = Number(token.slice(2, 4));
  const minute = token.length === 6 ? Number(token.slice(4, 6)) : 0;
  if (day < 1 || day > 31 || hour > 24 || minute > 59 || hour === 24 && minute !== 0) return false;
  const date = new Date((epochSeconds - (hour === 24 ? 86400 : 0)) * 1000);
  return date.getUTCDate() === day && date.getUTCHours() === hour % 24 && date.getUTCMinutes() === minute;
}
