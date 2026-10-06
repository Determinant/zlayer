import type { FlightCategory, TafForecast, TafReport } from '@zlayer/contracts';
import { flightCategoryForConditions, parseVisibility, visibilityForCategory } from './weather.js';
import { clearSkyToken, uncertainCeilingToken, type WeatherToken } from './weather-tokens.js';
import type { TafGroup } from './taf-parser.js';

type Conditions = { ceiling: number | undefined; visibility: number | undefined };
const unknown: Conditions = { ceiling: undefined, visibility: undefined };
const severity: Record<FlightCategory, number> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };
const temporary = (group: TafGroup) => group.header.kind === 'TEMPO' || group.header.kind === 'PROB';

/** Evaluate already-aligned source/decoded periods. Temporary changes never
 * mutate the prevailing timeline, and may overlap more than one baseline. */
export function tafCategories(report: TafReport, groups: readonly TafGroup[]): (FlightCategory | undefined)[] {
  const categories: (FlightCategory | undefined)[] = groups.map(() => undefined);
  const prevailing: { start: number; end: number; conditions: Conditions }[] = [];
  let previous = unknown;
  for (const [index, group] of groups.entries()) {
    if (temporary(group)) continue;
    const forecast = report.fcsts[index]!;
    const conditions = conditionsFor(forecast, group.tokens, group.header.kind === 'BECMG' ? previous : unknown);
    // Both baselines apply during a BECMG transition for a partial temporary group.
    const prior = prevailing.at(-1);
    if (prior) prior.end = forecast.timeBec ?? forecast.timeFrom;
    prevailing.push({ start: forecast.timeFrom, end: report.validTimeTo, conditions });
    previous = conditions;
    categories[index] = categoryFor(conditions);
  }
  for (const [index, group] of groups.entries()) {
    if (!temporary(group)) continue;
    const forecast = report.fcsts[index]!;
    const applicable = prevailing.filter(period => period.start < forecast.timeTo && period.end > forecast.timeFrom)
      .map(period => categoryFor(conditionsFor(forecast, group.tokens, period.conditions)));
    if (applicable.length && applicable.every(category => category !== undefined)) {
      categories[index] = applicable.reduce((worst, category) => severity[category] > severity[worst] ? category : worst);
    }
  }
  return categories;
}

function conditionsFor(forecast: TafForecast, tokens: readonly WeatherToken[], base: Conditions): Conditions {
  const cavok = tokens.some(token => token.value === 'CAVOK');
  let ceiling = base.ceiling;
  if (tokens.some(clearSkyToken)) ceiling = Infinity;
  else if (forecast.vertVis != null) ceiling = forecast.vertVis >= 0 ? forecast.vertVis : undefined;
  else if (forecast.clouds.length) {
    const clouds = forecast.clouds.map(cloud => ({ ...cloud, cover: cloud.cover.trim().toUpperCase() }));
    const ceilings = clouds.filter(cloud => ['BKN', 'OVC', 'VV', 'OVX'].includes(cloud.cover));
    ceiling = ceilings.some(cloud => cloud.base == null || cloud.base < 0) ? undefined
      : ceilings.length ? Math.min(...ceilings.map(cloud => cloud.base!))
      : clouds.every(cloud => ['FEW', 'SCT', 'SKC', 'CLR', 'NSC', 'NCD', 'CAVOK'].includes(cloud.cover)) ? Infinity : undefined;
  }
  if (tokens.some(uncertainCeilingToken)) ceiling = undefined;
  const supplied = forecast.visib;
  const visibility = cavok ? 10_000 / 1609.344
    : supplied == null || supplied === '' ? base.visibility
    : typeof supplied === 'number' ? supplied : tafVisibility(supplied);
  return { ceiling, visibility };
}

function tafVisibility(text: string): number | undefined {
  const value = text.trim().toUpperCase().replace(/\s+/g, ' ');
  return /^[MP]?(?:\d+(?:\.\d+)?|\d+\/\d+|\d+ \d+\/\d+)\+?$/.test(value)
    ? visibilityForCategory(parseVisibility(value), value) : undefined;
}

function categoryFor({ ceiling, visibility }: Conditions): FlightCategory | undefined {
  // Unknown elements must not silently become a reassuring VFR color.
  return ceiling === undefined || visibility === undefined || visibility < 0 ? undefined
    : flightCategoryForConditions(ceiling, visibility);
}
