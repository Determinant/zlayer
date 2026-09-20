import { createLayerStore } from '../../core/layers/store';
import { RECORDING_MIME, recordingStorage, type RecordingInfo, type RecordingStorage } from './recording-storage';

type Phase = 'idle' | 'starting' | 'recording' | 'saving' | 'error';
export type RecorderSnapshot = { phase: Phase; info: RecordingInfo | null; error: string };
type Clock = { now(): number; epoch(): number; id(): string };
const CHUNK_CHARACTERS = 128 * 1024;
const BUFFER_CHARACTERS = 2 * 1024 * 1024;

/** Sensor callbacks only serialize into a bounded buffer. One writer drains it;
 * storage failures stop recording without throwing into the attitude estimator. */
export function createAhrsRecorder(storage: RecordingStorage = recordingStorage, clock: Clock = {
  now: () => performance.now() / 1000, epoch: () => Date.now(), id: () => crypto.randomUUID(),
}) {
  const store = createLayerStore<RecorderSnapshot>({ phase: 'idle', info: null, error: '' });
  let info: RecordingInfo | null = null;
  let buffer: string[] = [], characters = 0, sequence = 0;
  let writing: Promise<void> | undefined, starting: Promise<void> | undefined, stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const publish = (phase: Phase, error = '') => store.publish({ phase, info, error });
  const accepting = () => ['starting', 'recording'].includes(store.getSnapshot().phase);
  const fail = (error: unknown) => {
    clearInterval(timer); timer = undefined;
    buffer = []; characters = 0;
    publish('error', `Recording stopped: ${error instanceof Error ? error.message : 'local storage is unavailable'}.`);
  };
  const append = (type: string, time: number, data: unknown) => {
    // JSON's default Infinity→null would erase the distinction from absent data.
    const line = JSON.stringify({ sequence: sequence++, type, time, data }, (_, value: unknown) =>
      typeof value === 'number' && !Number.isFinite(value) ? String(value) : value) + '\n';
    buffer.push(line); characters += line.length;
  };
  const flush = (): Promise<void> => {
    if (writing) return writing;
    writing = (async () => {
      try {
        while (buffer.length && info && store.getSnapshot().phase !== 'error') {
          let size = 0, count = 0;
          while (count < buffer.length && size < CHUNK_CHARACTERS) size += buffer[count++]!.length;
          const lines = buffer.splice(0, count);
          characters -= size;
          const chunk = new Blob(lines, { type: RECORDING_MIME });
          const next: RecordingInfo = { ...info, chunks: info.chunks + 1, events: info.events + count,
            bytes: info.bytes + chunk.size, updatedAt: clock.epoch() };
          await storage.save(next, chunk);
          info = next;
          const current = store.getSnapshot();
          publish(current.phase, current.error);
        }
      } catch (error) { fail(error); }
    })().finally(() => { writing = undefined; });
    return writing;
  };
  const record = (type: string, time: number, data: unknown) => {
    if (!accepting()) return;
    try {
      append(type, time, data);
      if (characters > BUFFER_CHARACTERS) {
        // Preserve the queued data, but stop accepting more while storage catches up.
        void stop('Storage could not keep up with the sensor stream');
      } else if (characters >= CHUNK_CHARACTERS && store.getSnapshot().phase === 'recording') void flush();
    } catch (error) { fail(error); }
  };
  async function start(context: unknown): Promise<void> {
    if (accepting() || store.getSnapshot().phase === 'saving') return;
    if (writing) { await writing; return start(context); }
    info = { version: 1, id: clock.id(), startedAt: clock.epoch(), updatedAt: clock.epoch(),
      status: 'recording', chunks: 0, events: 0, bytes: 0 };
    buffer = []; characters = sequence = 0;
    publish('starting');
    starting = (async () => {
      try {
        append('header', clock.now(), { format: 'zlayer-ahrs', version: 1, id: info!.id, context });
        await flush();
        if (store.getSnapshot().phase !== 'starting') return;
        publish('recording');
        timer = setInterval(() => { void flush(); }, 1000);
      } catch (error) { fail(error); }
    })();
    await starting;
    starting = undefined;
  }
  function stop(reason = 'Stopped by user'): Promise<void> {
    if (stopping) return stopping;
    if (!accepting()) return Promise.resolve();
    publish('saving');
    clearInterval(timer); timer = undefined;
    append('end', clock.now(), { reason });
    stopping = (async () => {
      await starting;
      await flush();
      if (store.getSnapshot().phase === 'error' || !info) return;
      try {
        const next: RecordingInfo = { ...info, status: 'complete', updatedAt: clock.epoch() };
        await storage.save(next);
        info = next;
        publish(reason === 'Stopped by user' ? 'idle' : 'error', reason === 'Stopped by user' ? '' : reason);
      } catch (error) { fail(error); }
    })().finally(() => { stopping = undefined; });
    return stopping;
  }
  async function remove(id: string): Promise<void> {
    if (info?.id === id) {
      if (accepting() || store.getSnapshot().phase === 'saving') throw new Error('Stop recording before deleting it.');
      // An error can be published while a previous write is still finishing.
      await Promise.all([starting, stopping, writing]);
    }
    await storage.remove(id);
    if (info?.id === id) {
      info = null;
      publish('idle');
    }
  }
  return { ...store, accepting, start, record, flush, stop, remove };
}
export type AhrsRecorder = ReturnType<typeof createAhrsRecorder>;
