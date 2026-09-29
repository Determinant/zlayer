import type { WeatherState } from './controller';

/** Follow advisory boundaries and expire observations after app suspension. */
export function mountWeatherClock(read: () => WeatherState, publish: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const schedule = () => {
    clearTimeout(timer);
    const p = read().preferences;
    const active = p.awcGairmet || p.awcFreezing || p.awcSigmet || p.awcConvective || p.awcCwa ||
      p.awcRadar || p.awcProgs || p.awcWindBarbs || p.awcGridMode !== 'none';
    if (stopped || !p.awcEnabled || !active || document.visibilityState === 'hidden') return;
    const now = Date.now();
    const boundaries = Object.values(read().products).flatMap(product =>
      product.snapshot?.advisories.flatMap(a => [a.validFrom, ...(a.validTo === null ? [] : [a.validTo])]) ?? []);
    const next = Math.min(now + 15_000, ...boundaries.filter(time => time > now));
    timer = setTimeout(tick, next - now);
  };
  const tick = () => { if (!stopped) { publish(); schedule(); } };
  const events = ['online', 'offline', 'pageshow', 'focus'] as const;
  document.addEventListener('visibilitychange', tick);
  for (const event of events) window.addEventListener(event, tick);
  tick();
  return { schedule, stop() {
    stopped = true; clearTimeout(timer);
    document.removeEventListener('visibilitychange', tick);
    for (const event of events) window.removeEventListener(event, tick);
  } };
}
