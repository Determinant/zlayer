import type { ApproachLeg } from '@zlayer/contracts';

export function terminalConstraint(leg: ApproachLeg): string {
  const labels: string[] = [];
  const altitude = (value: string) => value.startsWith('FL') ? value : `${Number(value).toLocaleString('en-US')} ft`;
  if (leg.altitude?.first) {
    const { first, second, restriction } = leg.altitude;
    labels.push(restriction === '+' ? `≥ ${altitude(first)}` : restriction === '-' ? `≤ ${altitude(first)}` :
      restriction === 'B' && second ? `Between ${altitude(first)} and ${altitude(second)}` :
        `${altitude(first)}${second ? ` / ${altitude(second)}` : ''}${restriction && !['+', '-', 'B'].includes(restriction) ? ` (${restriction})` : ''}`);
  }
  if (leg.speed) labels.push(`${leg.speed.restriction === '+' ? '≥ ' : leg.speed.restriction === '-' ? '≤ ' : ''}${leg.speed.knots} kt`);
  if (leg.rnpNm !== undefined) labels.push(`RNP ${leg.rnpNm}`);
  return labels.join(' · ');
}
