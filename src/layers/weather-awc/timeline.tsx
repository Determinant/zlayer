import { useLayoutEffect, useRef, type PointerEvent } from 'react';
import { useLayerSnapshot } from '../../core/layers/use-snapshot';
import { formatDate, formatTimestamp, formatTimestampPair } from '../../core/format/time';
import { forecastPreparation, forecastStreams, type WeatherController } from './controller';
import { forecastStops, HOUR } from './time';
import { TIME_PRODUCTS } from './palette';
import { preparationLabel } from './grids/presentation';
import { weatherTimeScale } from './time-scale';
import { RADAR_HISTORY_STEP } from '@zlayer/contracts';
import './styles.css';

export function WeatherTimeline({ controller }: { controller: WeatherController }) {
  const state = useLayerSnapshot(controller);
  const rail = useRef<HTMLDivElement>(null), scale = useRef<HTMLDivElement>(null), slider = useRef<HTMLInputElement>(null);
  const drag = useRef<{ id: number; x: number; left: number; moved: boolean; select: boolean } | undefined>(undefined);
  const selected = state.selectedTime ?? state.now;
  const changes = controller.forecastChanges();
  const productsAt = new Map(changes.map(change => [change.time, change.products]));
  const history = changes.filter(change => change.products.includes('radar') && change.time < state.now).map(change => change.time);
  const stops = forecastStops(changes.map(change => change.time), state.now, state.selectedTime, history);
  const start = Math.floor(Math.min(selected, ...stops.map(time => time ?? state.now)) / HOUR) * HOUR;
  const end = Math.max(start + HOUR, Math.ceil(Math.max(selected, ...stops.map(time => time ?? state.now)) / HOUR) * HOUR);
  const { position, offset, timeAt, width } = weatherTimeScale(start, end, state.now, history.length > 0);
  const previous = stops.filter(time => (time ?? state.now) < selected).pop();
  const next = stops.find(time => (time ?? state.now) > selected);
  const hours = Array.from({ length: Math.round((end - start) / HOUR) + 1 }, (_, i) => start + i * HOUR);
  const days = [start, ...hours.filter(time => time > start && time < end && time % (24 * HOUR) === 0)];
  const selectedLabel = state.selectedTime === null ? 'Now' : selected % HOUR ? formatTimestamp(selected).split(' · ')[1] : undefined;
  const minutes = history.length ? Array.from({ length: Math.ceil((Math.min(end, state.now) - start) / RADAR_HISTORY_STEP) }, (_, i) => start + i * RADAR_HISTORY_STEP)
    .filter(time => time % HOUR !== 0) : [];
  const reveal = (time: number) => {
    const view = rail.current, canvas = scale.current;
    if (!view || !canvas) return;
    const x = 8 + position(time) / 100 * (canvas.clientWidth - 16), margin = 28;
    // Only move the time scale, never the toolbox or the page.
    if (x < view.scrollLeft + margin) view.scrollLeft = Math.max(0, x - margin);
    else if (x > view.scrollLeft + view.clientWidth - margin) view.scrollLeft = x - view.clientWidth + margin;
  };
  const currentReveal = useRef(() => {});
  currentReveal.current = () => reveal(selected);
  const previousScale = useRef({ start, end, now: state.now, history: history.length > 0 });
  useLayoutEffect(() => {
    // Keep the same absolute hours under a manually panned viewport when Now
    // crosses an hour. New source horizons must not snap browsing back home.
    const previous = previousScale.current;
    if (rail.current && previous.history === (history.length > 0)) {
      const old = weatherTimeScale(previous.start, previous.end, previous.now, previous.history);
      const anchor = old.timeAt(rail.current.scrollLeft / old.width);
      rail.current.scrollLeft = offset(anchor);
    }
    previousScale.current = { start, end, now: state.now, history: history.length > 0 };
  }, [start, end, state.now, history.length > 0]);
  useLayoutEffect(() => {
    if (!state.preferences.awcEnabled || !rail.current) return;
    const observer = new ResizeObserver(() => currentReveal.current());
    observer.observe(rail.current);
    currentReveal.current();
    return () => observer.disconnect();
  }, [state.preferences.awcEnabled, state.selectedTime, history.length > 0]);
  const select = (time: number | null | undefined) => {
    if (time === undefined) return;
    controller.selectTime(time);
    reveal(time ?? Date.now());
  };
  const nearest = (time: number) => stops.reduce((best, stop) => Math.abs((stop ?? state.now) - time) < Math.abs((best ?? state.now) - time) ? stop : best);
  const stopDrag = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const moving = drag.current;
    if (!moving || moving.id !== event.pointerId) return;
    drag.current = undefined; delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && !moving.moved && moving.select && slider.current) {
      const box = slider.current.getBoundingClientRect();
      slider.current.focus({ preventScroll: true });
      select(nearest(timeAt((event.clientX - box.x - 8) / (box.width - 16))));
    }
  };
  const products = [...new Set(stops.flatMap(time => time === null ? [] : productsAt.get(time) ?? []))];
  const forecasts = forecastStreams(state);
  const loading = forecasts.some(forecast => forecast.loading || forecast.rendering);
  const preparation = forecastPreparation(state);
  const preparing = preparation && !preparation.limited && (!preparation.total || preparation.ready < preparation.total);
  const forecastError = forecasts.find(forecast => forecast.error)?.error;
  const sourceError = forecasts.find(forecast => forecast.record.error)?.record.error;
  const storageError = forecasts.find(forecast => forecast.record.storageError)?.record.storageError;
  const status = forecastError ? 'Forecast unavailable'
    : loading ? 'Loading forecast…'
    : preparation?.limited ? preparationLabel(preparation)
    : storageError ? 'Offline save incomplete'
    : preparing ? preparationLabel(preparation) : sourceError ? 'Forecast refresh failed' : undefined;
  if (!state.preferences.awcEnabled) return null;
  return <section className="awc-timeline" aria-label="Weather timeline">
    <div className="awc-time-heading"><strong>{state.selectedTime === null ? 'Now · ' : history.length && selected < state.now ? 'History · ' : ''}{formatTimestampPair(selected, { now: state.now })}</strong></div>
    {(forecastError || sourceError || storageError || preparation?.limited || !!preparation?.failed) && <div className="awc-error" role="status">
      <span>{forecastError || sourceError || storageError || (preparation?.limited ? 'Forecasts could not be saved for reopening offline.'
        : `${preparation!.failed} forecasts awaiting retry`)}</span>{' '}
      <button type="button" className="ui-button ui-button--compact" onClick={() => controller.retryForecasts()}>Retry forecasts</button>
    </div>}
    <div ref={rail} className="awc-time-scroll" role="group" aria-label="Scrollable weather time scale"
      title="Drag the scale to scroll; drag the handle to select a forecast"
      onPointerDown={event => {
        const view = event.currentTarget, input = slider.current;
        if (!input || !event.isPrimary || event.button !== 0 || view.scrollWidth <= view.clientWidth) return;
        const box = input.getBoundingClientRect(), x = box.x + 8 + position(selected) / 100 * (box.width - 16);
        // The native handle keeps its usual drag and keyboard behavior. Dragging
        // elsewhere pans the scale; a tap on its track still selects a forecast.
        const onSlider = event.target === input;
        if (onSlider && !input.disabled && Math.abs(event.clientX - x) <= 14) return;
        if (onSlider) event.preventDefault();
        drag.current = { id: event.pointerId, x: event.clientX, left: view.scrollLeft, moved: false, select: onSlider && !input.disabled };
        view.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        const moving = drag.current;
        if (!moving || moving.id !== event.pointerId) return;
        const distance = event.clientX - moving.x;
        if (Math.abs(distance) > 4) moving.moved = true;
        if (moving.moved) { event.currentTarget.dataset.dragging = 'true'; event.currentTarget.scrollLeft = moving.left - distance; }
      }} onPointerUp={event => stopDrag(event)} onPointerCancel={event => stopDrag(event, true)} onLostPointerCapture={event => stopDrag(event, true)}>
      <div ref={scale} className="awc-time-scale" style={{ width: width + 16 }}>
        <div className="awc-time-dates" aria-hidden="true">{days.map((time, i) => <div key={time} className="awc-time-date"
          style={{ left: `${position(time)}%`, width: `${position(days[i + 1] ?? end) - position(time)}%` }}><span>{formatDate(time, state.now)}</span></div>)}</div>
    <input ref={slider} className="awc-time-slider" type="range" aria-label="Weather forecast time" min={history.length ? 0 : start} max={history.length ? width : end} step="any"
      disabled={stops.length <= 1} value={history.length ? offset(selected) : selected} aria-valuetext={`${state.selectedTime === null ? 'Now · ' : ''}${formatTimestamp(selected)}`}
      onChange={e => {
        // Touch ranges can emit input while a captured background drag pans.
        // Only the native handle (or a completed track tap) selects a frame.
        if (drag.current) return;
        const requested = history.length ? timeAt(Number(e.currentTarget.value) / width) : Number(e.currentTarget.value);
        select(nearest(requested));
      }}
      onKeyDown={e => {
        const time = e.key === 'Home' ? stops[0] : e.key === 'End' ? stops[stops.length - 1]
          : ['ArrowLeft', 'ArrowDown', 'PageDown'].includes(e.key) ? previous
          : ['ArrowRight', 'ArrowUp', 'PageUp'].includes(e.key) ? next : undefined;
        if (['Home', 'End', 'ArrowLeft', 'ArrowDown', 'PageDown', 'ArrowRight', 'ArrowUp', 'PageUp'].includes(e.key)) {
          e.preventDefault(); select(time);
        }
      }} />
    <div className="awc-time-marks" aria-hidden="true">
      {hours.map(time => <span className="awc-time-hour" key={time} style={{ left: `${position(time)}%` }} data-selected={time === state.selectedTime || undefined}>
        <i />{(time === state.selectedTime || (time < state.now && history.length > 0 || time % (4 * HOUR) === 0) && Math.abs(offset(time) - offset(selected)) >= 32) &&
          <span>{new Date(time).getUTCHours().toString().padStart(2, '0')}Z</span>}
      </span>)}
      {minutes.map(time => <span className="awc-time-hour" key={time} style={{ left: `${position(time)}%` }}>
        <i />{time % (HOUR / 2) === 0 && Math.abs(offset(time) - offset(selected)) >= 32 &&
          <span>{new Date(time).toISOString().slice(11, 16)}Z</span>}
      </span>)}
      {stops.map(time =>
      <span className="awc-time-mark" key={time ?? 'now'} data-selected={time === state.selectedTime || undefined}
        data-now={time === null || undefined}
        style={{ left: `${position(time ?? state.now)}%` }} title={time === null ? 'Now' : formatTimestamp(time)}>
        {time === null ? <i /> : <i className="awc-time-segments">{productsAt.get(time)?.map(product =>
          <b key={product} data-time-product={product} style={{ backgroundColor: TIME_PRODUCTS[product].color }} />)}</i>}
        {time === state.selectedTime && selectedLabel && <span style={selected - start < HOUR / 2 ? { transform: 'none' }
          : end - selected < HOUR / 2 ? { transform: 'translateX(-100%)' } : undefined}>{selectedLabel}</span>}
        {time === null && state.selectedTime !== null && history.length > 0 && Math.abs(offset(state.now) - offset(selected)) >= 32 && <span>Now</span>}
      </span>)}</div>
      </div>
    </div>
    {products.length > 0 && <div className="awc-time-legend" aria-label="Timeline products">{products.map(product =>
      <span key={product}><i style={{ backgroundColor: TIME_PRODUCTS[product].color }} aria-hidden="true" />
        {product === 'clouds' && state.preferences.awcGridMode.startsWith('freezing') ? 'Freezing' : TIME_PRODUCTS[product].label}</span>)}</div>}
    <div className="awc-time-controls">
      <button className="ui-button ui-button--quiet ui-button--slim" type="button" aria-label="Previous weather time" onClick={() => select(previous)} disabled={previous === undefined}>‹ Prev</button>
      <button className="ui-button ui-button--quiet ui-button--slim" type="button" aria-pressed={state.selectedTime === null} onClick={() => select(null)}>Now</button>
      <button className="ui-button ui-button--quiet ui-button--slim" type="button" aria-label="Next weather time" onClick={() => select(next)} disabled={next === undefined}>Next ›</button>
    </div>
    {status && <small className="awc-time-status">{status}</small>}
    {preparing && <progress className="ui-progress" aria-label="Forecast preparation" max={preparation.total || 1}
      value={preparation.total ? preparation.ready : undefined}
      aria-valuetext={preparation.total ? `${preparation.ready} of ${preparation.total} forecasts saved${preparation.failed ? `; ${preparation.failed} awaiting retry` : ''}` : 'Checking forecast times'} />}
    {!preparing && loading && !forecastError && <progress className="ui-progress" aria-label="Forecast loading" />}
    {stops.length <= 1 && <small className="awc-frame-time">No weather steps available.</small>}
  </section>;
}
