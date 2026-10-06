/** Offsets always refer to the untouched coded report, including wrapped groups. */
export type WeatherSpan = { start: number; end: number };
export type WeatherToken = WeatherSpan & { value: string };

/** Lexical recognition only; each report grammar owns context and transitions. */
export function weatherTokens(raw: string): WeatherToken[] | undefined {
  if (raw.length > 64 * 1024) return undefined;
  const tokens: WeatherToken[] = [];
  for (const match of raw.matchAll(/[^\s=]+|=/g)) {
    if (tokens.length === 4096) return undefined;
    tokens.push({ start: match.index, end: match.index + match[0].length, value: match[0].toUpperCase() });
  }
  return tokens;
}

export function weatherCloud(token: WeatherToken): { cover: string; base: number | undefined } | undefined {
  const match = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/{3})(?:CB|TCU)?$/.exec(token.value);
  return match ? { cover: match[1]!, base: match[2] === '///' ? undefined : Number(match[2]) } : undefined;
}

/** A damaged ceiling group is evidence of uncertainty, never a guessed height.
 * 0VC is a documented O/zero transcription error in operational METARs. */
export function uncertainCeilingToken(token: WeatherToken): boolean {
  const cloud = weatherCloud(token);
  return cloud ? ['BKN', 'OVC', 'VV'].includes(cloud.cover) && cloud.base === undefined
    : /^(?:BKN|OVC|VV|0VC)(?:[\d/O]|$)/.test(token.value);
}

export function clearSkyToken(token: WeatherToken): boolean {
  return ['SKC', 'CLR', 'NSC', 'NCD', 'CAVOK'].includes(token.value);
}
