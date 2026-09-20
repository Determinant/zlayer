import type { GeoPointFeature } from '@zlayer/contracts';
import { normalizeNavaidType } from '@zlayer/domain';

export type NavaidMorse = {
  identifier: string;
  groups: string[];
  description: string;
};

// FAA AIM 4-2-7, Phonetic Alphabet/Morse Code.
// https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_2.html
const MORSE: Readonly<Record<string, string>> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..',
  J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
  5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
};

// These facilities transmit a coded identifier. VOTs and marker beacons do not
// transmit their assigned location identifier; do not derive Morse for them.
const IDENTIFYING_TYPES = new Set([
  'VOR', 'VOR/DME', 'VORTAC', 'DME', 'TACAN', 'NDB', 'NDB/DME', 'MARINE NDB', 'LOM', 'LMM',
  'LOC', 'LOC/DME', 'ILS', 'ILS/DME', 'LDA', 'LDA/DME', 'SDF', 'SDF/DME',
]);
const LOCALIZER_TYPES = new Set(['LOC', 'LOC/DME', 'ILS', 'ILS/DME', 'LDA', 'LDA/DME']);

/** Expected identifier from published reference data, not a received radio signal. */
export function navaidMorse(feature: GeoPointFeature): NavaidMorse | undefined {
  const { kind, type, ident } = feature.properties;
  const facilityType = normalizeNavaidType(type);
  if (kind !== 'navaid' || !facilityType || !IDENTIFYING_TYPES.has(facilityType) || !ident) return undefined;

  // A charted I-DIA separator is not part of the transmitted identifier.
  let identifier = ident.trim().toUpperCase().replace(/^I[-\u2010-\u2014]([A-Z0-9]{3})$/, 'I$1');
  if (!/^[A-Z0-9]{2,4}$/.test(identifier)) return undefined;

  // FAA AIM 1-1-9 and Location Identifiers 1-2-7: LOC/ILS/LDA use I + three
  // characters. SDF does not. Preserve an already complete four-letter ident.
  if (LOCALIZER_TYPES.has(facilityType)) {
    if (identifier.length === 3) identifier = `I${identifier}`;
    else if (!/^I[A-Z0-9]{3}$/.test(identifier)) return undefined;
  }

  const characters = [...identifier];
  const patterns = characters.map(character => MORSE[character]!);
  return {
    identifier,
    groups: patterns.map(pattern => pattern.replaceAll('.', '·').replaceAll('-', '−')),
    description: `Morse identifier ${identifier}: ${characters.map((character, index) =>
      `${character} ${[...patterns[index]!].map(signal => signal === '.' ? 'dot' : 'dash').join(' ')}`
    ).join('; ')}`,
  };
}
