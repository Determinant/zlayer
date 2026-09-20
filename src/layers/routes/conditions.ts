import type { PreferredRouteRecord } from '@zlayer/contracts';

/** Keep published restrictions as text; codes such as PQ70 are not numeric altitudes. */
export function routeConditions(entry: PreferredRouteRecord): [string, string][] {
  const fields: [string, string | undefined][] = [['Altitude', entry.altitude], ['Aircraft', entry.aircraft],
    ['Hours (UTC)', entry.hours], ['Direction', entry.direction], ['Area', entry.area], ['NAR type', entry.narType]];
  return fields.filter((field): field is [string, string] => Boolean(field[1]));
}
