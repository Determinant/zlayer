import type { FlightCategory, TafForecast, TafReport } from '@zlayer/contracts';
import { flightCategoryForConditions, parseVisibility } from './weather.js';

export type TafLine = {
  text: string;
  category: FlightCategory | undefined;
  fm?: { token: string; time: string };
};
type Conditions = { ceiling: number | undefined; visibility: number | undefined };
const unknown: Conditions = { ceiling: undefined, visibility: undefined };
const severity: Record<FlightCategory, number> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };
const CHANGE_TOKEN = String.raw`FM\s*\d{6}|BECMG|PROB\s*(?:30|40)(?:\s+(?:TEMPO|INTER))?|TEMPO|INTER`;

/** Keep the coded text; decoded AWC fields are used only to choose its color. */
export function tafReportLines(report: TafReport): TafLine[] {
  const remarkIndex = report.rawTAF.search(/\bRMK\b/i);
  const body = remarkIndex < 0 ? report.rawTAF : report.rawTAF.slice(0, remarkIndex);
  const starts = [0, ...Array.from(body.matchAll(new RegExp(`\\b(?:${CHANGE_TOKEN})\\b`, 'gi')), match => match.index!)];
  const lines: TafLine[] = starts.map((start, index) => ({
    text: body.slice(start, starts[index + 1]).trim(), category: undefined,
  })).filter(line => line.text);
  // A decoding mismatch must never attach another period's category to raw text.
  const aligned = lines.length === report.fcsts.length && lines.every((line, index) => matchesForecast(line.text, report.fcsts[index]!, index));
  if (aligned && !/\b(?:CNL|NIL)\b/i.test(body)) {
    let previous = unknown;
    const prevailing: Array<{ start: number; end: number; conditions: Conditions }> = [];
    report.fcsts.forEach((forecast, index) => {
      if (isTemporary(forecast)) return;
      const line = lines[index]!;
      const kind = forecastKind(forecast);
      if (kind === 'FM') line.fm = { token: changeToken(line.text)!, time: new Date(forecast.timeFrom * 1000).toISOString() };
      const conditions = conditionsFor(forecast, line.text, kind === 'BECMG' ? previous : unknown);
      // During BECMG, either the old or new conditions may apply. Overlap the
      // baselines until the transition ends when coloring a partial TEMPO/PROB.
      const prior = prevailing.at(-1);
      if (prior) prior.end = forecast.timeBec ?? forecast.timeFrom;
      prevailing.push({ start: forecast.timeFrom, end: report.validTimeTo, conditions });
      previous = conditions;
      lines[index]!.category = categoryFor(conditions);
    });
    report.fcsts.forEach((forecast, index) => {
      if (!isTemporary(forecast)) return;
      // A partial TEMPO/PROB can span multiple prevailing periods. Account for
      // every overlapping baseline, without letting temporary changes persist.
      const categories = prevailing.filter(period => period.start < forecast.timeTo && period.end > forecast.timeFrom)
        .map(period => categoryFor(conditionsFor(forecast, lines[index]!.text, period.conditions)));
      if (categories.length && categories.every(category => category !== undefined)) {
        lines[index]!.category = categories.reduce((worst, category) => severity[category] > severity[worst] ? category : worst);
      }
    });
  }
  if (remarkIndex >= 0) lines.push({ text: report.rawTAF.slice(remarkIndex).trim(), category: undefined });
  return lines;
}

function matchesForecast(text: string, forecast: TafForecast, index: number): boolean {
  const decodedKind = forecastKind(forecast);
  if (index === 0) return !decodedKind && !forecast.probability;
  const original = changeToken(text);
  if (!original) return false;
  const token = original.toUpperCase().replace(/\s+/g, '');
  const probability = token.match(/^PROB(30|40)/)?.[1];
  if (Number(probability ?? 0) !== (forecast.probability ?? 0)) return false;
  // AWC maps Australian INTER to TEMPO. PROB+TEMPO may be represented by
  // either conditional kind, but its probability and complete times must match.
  const kind = token.startsWith('FM') ? 'FM' : /TEMPO|INTER/.test(token) ? 'TEMPO' : probability ? 'PROB' : 'BECMG';
  if (probability ? !['PROB', 'TEMPO'].includes(decodedKind) : kind !== decodedKind) return false;
  if (kind === 'FM') return matchesTime(token.slice(2), forecast.timeFrom);
  const period = text.slice(original.length).trimStart().match(/^(\d{4})\s*\/\s*(\d{4})(?=\s|=|$)/);
  const end = kind === 'BECMG' ? forecast.timeBec : forecast.timeTo;
  return Boolean(period && end != null && matchesTime(period[1]!, forecast.timeFrom) && matchesTime(period[2]!, end));
}

function changeToken(text: string): string | undefined {
  return text.match(new RegExp(`^(?:${CHANGE_TOKEN})\\b`, 'i'))?.[0];
}

function forecastKind(forecast: TafForecast): string {
  const kind = forecast.fcstChange?.trim().toUpperCase() ?? '';
  return kind === 'INTER' ? 'TEMPO' : kind;
}

/** Compare against the decoded UTC date, including DD24 at month/year end. */
function matchesTime(token: string, epochSeconds: number): boolean {
  const day = Number(token.slice(0, 2)), hour = Number(token.slice(2, 4));
  const minute = token.length === 6 ? Number(token.slice(4, 6)) : 0;
  if (day < 1 || day > 31 || hour > 24 || minute > 59 || hour === 24 && minute !== 0) return false;
  const date = new Date((epochSeconds - (hour === 24 ? 86400 : 0)) * 1000);
  return date.getUTCDate() === day && date.getUTCHours() === hour % 24 && date.getUTCMinutes() === minute;
}

function isTemporary(forecast: TafForecast): boolean {
  return ['TEMPO', 'PROB'].includes(forecastKind(forecast)) || Boolean(forecast.probability);
}

function conditionsFor(forecast: TafForecast, text: string, base: Conditions): Conditions {
  const cavok = /\bCAVOK\b/i.test(text);
  let ceiling = base.ceiling;
  if (cavok || /\b(?:SKC|NSC|NCD|CLR)\b/i.test(text)) ceiling = Infinity;
  else if (forecast.vertVis != null) ceiling = forecast.vertVis >= 0 ? forecast.vertVis : undefined;
  else if (forecast.clouds.length) {
    const clouds = forecast.clouds.map(cloud => ({ ...cloud, cover: cloud.cover.trim().toUpperCase() }));
    const ceilings = clouds.filter(cloud => ['BKN', 'OVC', 'VV', 'OVX'].includes(cloud.cover));
    ceiling = ceilings.some(cloud => cloud.base == null || cloud.base < 0) ? undefined
      : ceilings.length ? Math.min(...ceilings.map(cloud => cloud.base!))
      : clouds.every(cloud => ['FEW', 'SCT', 'SKC', 'CLR', 'NSC', 'NCD', 'CAVOK'].includes(cloud.cover)) ? Infinity : undefined;
  }
  if (/\b(?:VV|BKN|OVC)\/{3}/i.test(text)) ceiling = undefined;
  const supplied = forecast.visib;
  const visibility = cavok ? 10_000 / 1609.344
    : supplied == null || supplied === '' ? base.visibility
    : typeof supplied === 'number' ? supplied : tafVisibility(supplied);
  return { ceiling, visibility };
}

function tafVisibility(text: string): number | undefined {
  const value = text.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!/^[MP]?(?:\d+(?:\.\d+)?|\d+\/\d+|\d+ \d+\/\d+)\+?$/.test(value)) return undefined;
  const miles = parseVisibility(value);
  if (miles === undefined) return undefined;
  // Preserve strict inequalities at category boundaries, e.g. M1 is LIFR.
  const epsilon = Math.max(1, miles) * Number.EPSILON * 4;
  return value.startsWith('M') ? Math.max(0, miles - epsilon)
    : value.startsWith('P') || value.endsWith('+') ? miles + epsilon : miles;
}

function categoryFor({ ceiling, visibility }: Conditions): FlightCategory | undefined {
  // Unknown elements must not silently become a reassuring VFR color.
  return ceiling === undefined || visibility === undefined || visibility < 0 ? undefined
    : flightCategoryForConditions(ceiling, visibility);
}
