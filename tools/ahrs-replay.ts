import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseRecordingLine, replayAhrs } from './lib/ahrs-replay';

const file = process.argv[2];
if (!file || process.argv.length !== 3) throw new Error('Usage: node --import=tsx tools/ahrs-replay.ts recording.jsonl > replay.jsonl');
const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
async function* events() {
  for await (const line of lines) if (line.trim()) yield parseRecordingLine(line);
}
await replayAhrs(events(), event => process.stdout.write(JSON.stringify(event, (_, value: unknown) =>
  typeof value === 'number' && !Number.isFinite(value) ? String(value) : value) + '\n'));
