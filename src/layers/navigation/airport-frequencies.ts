import type { AirportCenterFrequency, AirportFrequency, AirportTerminalFrequency } from '@zlayer/contracts';
import type { FeatureDetailRow } from './feature-details';

type Frequency = AirportFrequency | AirportTerminalFrequency | AirportCenterFrequency;
export type AirportFrequencyChannel = { number: string; context: string[] };
export type AirportFrequencyDisplay = {
  channels: AirportFrequencyChannel[];
  notes: { channel?: AirportFrequencyChannel; text: string[] }[];
};

const WEATHER = ['ATIS', 'D-ATIS', 'AWOS', 'ASOS'] as const;
const secondary = (frequency: Frequency) => /\b(?:LCL|GND|CD|APCH|DEP)\/S\b/.test(frequency.use ?? '') &&
  !/\/P\b/.test(frequency.use ?? '');
const channel = (frequency: Frequency, distinguishFacility = false): AirportFrequencyChannel => ({
  number: frequency.frequencyMHz.toFixed(3).replace(/0$/, ''),
  context: [frequency.facilityName && distinguishFacility && frequency.facilityId
    ? `${frequency.facilityName} (${frequency.facilityId})` : frequency.facilityName || frequency.facilityId, frequency.sector,
    secondary(frequency) ? 'Secondary' : undefined].filter((text): text is string => !!text),
});
export const airportFrequencyLabel = (channel: AirportFrequencyChannel) =>
  [`${channel.number} MHz`, ...channel.context].join(' · ');
const byChannel = (a: Frequency, b: Frequency) => Number(secondary(a)) - Number(secondary(b)) ||
  a.frequencyMHz - b.frequencyMHz || (a.facilityName || a.facilityId || '').localeCompare(b.facilityName || b.facilityId || '') ||
  (a.facilityId ?? '').localeCompare(b.facilityId ?? '') || (a.sector ?? '').localeCompare(b.sector ?? '') ||
  (a.use ?? '').localeCompare(b.use ?? '') ||
  (a.hours ?? '').localeCompare(b.hours ?? '') || (a.remarks ?? '').localeCompare(b.remarks ?? '');
const summaryFrequencies = (frequencies: Frequency[]) => {
  const vhf = frequencies.filter(frequency => frequency.frequencyMHz < 137);
  return (vhf.length ? vhf : [...frequencies]).sort(byChannel);
};
const uniqueChannels = (frequencies: Frequency[], toChannel = channel) => [...new Map(frequencies.map(frequency => {
  const value = toChannel(frequency);
  return [JSON.stringify(value), value];
})).values()];

export function airportFrequencyRows(frequencies: readonly Frequency[] = []): FeatureDetailRow[] {
  if (!Array.isArray(frequencies)) return [];
  const forType = (type: Frequency['type']) => frequencies.filter(frequency => frequency.type === type);
  const rows = WEATHER.flatMap(type => {
    const group = forType(type);
    return group.length ? [frequencyRow(type, group)] : [];
  });
  const tower = forType('TOWER'), ctaf = forType('CTAF'), ground = forType('GROUND');
  const clearance = forType('CLEARANCE');
  if (clearance.length) rows.push(frequencyRow('CD', clearance));
  if (ground.length) rows.push(frequencyRow('Ground', ground));
  const channels = (group: Frequency[]) => [...new Set(summaryFrequencies(group).map(frequency =>
    JSON.stringify([frequency.frequencyMHz, frequency.facilityId, frequency.facilityName, frequency.sector, secondary(frequency)]),
  ))].sort().join('\n');
  if (tower.length && ctaf.length && channels(tower) === channels(ctaf)) {
    rows.push(frequencyRow('Tower / CTAF', [...tower, ...ctaf]));
  } else {
    if (tower.length) rows.push(frequencyRow('Tower', tower));
    if (ctaf.length) rows.push(frequencyRow('CTAF', ctaf));
  }
  for (const [type, label] of [['APPROACH', 'Approach'], ['APPROACH/DEPARTURE', 'App / Dep'],
    ['DEPARTURE', 'Departure'], ['CENTER', 'Center']] as const) {
    const group = forType(type);
    if (group.length) rows.push(frequencyRow(label, group));
  }
  return rows;
}

function frequencyRow(label: string, frequencies: Frequency[]): FeatureDetailRow {
  // Equal radio calls are not proof of equal facilities. Retain their identifiers
  // when a service contains different providers with the same published name.
  const providers = new Map<string, Set<string>>();
  for (const frequency of frequencies) {
    if (!frequency.facilityName) continue;
    const ids = providers.get(frequency.facilityName) ?? new Set<string>();
    ids.add(frequency.facilityId ?? '');
    providers.set(frequency.facilityName, ids);
  }
  const toChannel = (frequency: Frequency) => channel(frequency, (providers.get(frequency.facilityName ?? '')?.size ?? 0) > 1);
  const shown = summaryFrequencies(frequencies);
  const channels = uniqueChannels(shown, toChannel);
  const multipleChannels = uniqueChannels(frequencies, toChannel).length > 1;
  const towers = frequencies.filter(frequency => frequency.type === 'TOWER');
  // Only share a schedule when every Tower record publishes that same value.
  // Missing or conflicting schedules remain attached to their source channel.
  const hours = towers[0]?.hours;
  const commonHours = hours && towers.every(frequency => frequency.hours === hours) ? hours : undefined;
  const notes: AirportFrequencyDisplay['notes'] = commonHours ? [{ text: [`Tower hours ${commonHours}`] }] : [];
  const combined = towers.length > 0 && frequencies.some(frequency => frequency.type === 'CTAF');
  const ordered = [...shown, ...frequencies.filter(frequency => !shown.includes(frequency)).sort(byChannel)];
  for (const frequency of ordered) {
    // Plain service/priority codes are already represented by the row and channel.
    // Preserve every other published use, including LCL/GND IC and weather subtypes.
    const use = frequency.use && !/^(?:ATIS|D-ATIS|AWOS|ASOS|CTAF|(?:(?:LCL|GND|CD|APCH|DEP|APCH\/DEP)\/[PS])(?: (?:APCH|DEP)\/[PS])*)$/.test(frequency.use)
      ? frequency.use : undefined;
    const text = [...new Set([
      frequency.type === 'TOWER' && frequency.hours && !commonHours ? `Tower hours ${frequency.hours}` : undefined,
      use, frequency.remarks,
    ].filter((text): text is string => !!text))];
    const hidden = !shown.includes(frequency);
    if (!hidden && !text.length) continue;
    const detailChannel = toChannel(frequency);
    if (combined) detailChannel.context.push(frequency.type === 'TOWER' ? 'Tower' : 'CTAF');
    notes.push({ ...(hidden || multipleChannels || combined ? { channel: detailChannel } : {}), text });
  }
  return { label, value: channels.map(airportFrequencyLabel).join('\n'), wide: true,
    frequency: { channels, notes: [...new Map(notes.map(note => [JSON.stringify(note), note])).values()] } };
}
