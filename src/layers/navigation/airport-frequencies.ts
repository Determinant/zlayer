import type { AirportFrequency } from '@zlayer/contracts';
import type { FeatureDetailRow } from './feature-details';

const WEATHER = ['ATIS', 'D-ATIS', 'AWOS', 'ASOS'] as const;
const mhz = (frequency: AirportFrequency) => `${frequency.frequencyMHz.toFixed(3).replace(/0$/, '')} MHz`;
const secondary = (frequency: AirportFrequency) => /\b(?:LCL|GND)\/S\b/.test(frequency.use ?? '');
const byChannel = (a: AirportFrequency, b: AirportFrequency) => Number(secondary(a)) - Number(secondary(b)) ||
  a.frequencyMHz - b.frequencyMHz || (a.sector ?? '').localeCompare(b.sector ?? '');
const summaryFrequencies = (frequencies: AirportFrequency[]) => {
  const vhf = frequencies.filter(frequency => frequency.frequencyMHz < 137);
  return (vhf.length ? vhf : [...frequencies]).sort(byChannel);
};

export function airportFrequencyRows(frequencies: readonly AirportFrequency[] = []): FeatureDetailRow[] {
  if (!Array.isArray(frequencies)) return [];
  const forType = (type: AirportFrequency['type']) => frequencies.filter(frequency => frequency.type === type);
  const rows = WEATHER.flatMap(type => {
    const group = forType(type);
    return group.length ? [frequencyRow(type, group)] : [];
  });
  const tower = forType('TOWER'), ctaf = forType('CTAF'), ground = forType('GROUND');
  const channels = (group: AirportFrequency[]) => summaryFrequencies(group)
    .map(frequency => `${frequency.frequencyMHz}:${frequency.sector ?? ''}`).sort().join('|');
  if (tower.length && ctaf.length && channels(tower) === channels(ctaf)) {
    rows.push(frequencyRow('Tower / CTAF', [...tower, ...ctaf]));
  } else {
    if (tower.length) rows.push(frequencyRow('Tower', tower));
    if (ctaf.length) rows.push(frequencyRow('CTAF', ctaf));
  }
  if (ground.length) rows.push(frequencyRow('Ground', ground));
  return rows;
}

function frequencyRow(label: string, frequencies: AirportFrequency[]): FeatureDetailRow {
  const shown = summaryFrequencies(frequencies);
  const value = [...new Set(shown.map(frequency => [mhz(frequency), frequency.sector,
    secondary(frequency) ? 'Secondary' : undefined].filter(Boolean).join(' · ')))].join('\n');
  const notes = [...new Set(frequencies.flatMap(frequency => {
    const details = [frequency.type === 'TOWER' && frequency.hours ? `Tower hours ${frequency.hours}` : undefined,
      frequency.remarks].filter(Boolean);
    if (!shown.includes(frequency)) details.unshift(`${mhz(frequency)}${frequency.sector ? ` · ${frequency.sector}` : ''}`);
    else if (shown.length > 1 && details.length) details.unshift(mhz(frequency));
    return details.length ? [details.join(' · ')] : [];
  }))];
  return { label, value, wide: true, frequency: true,
    ...(notes.length ? { notes } : {}) };
}
