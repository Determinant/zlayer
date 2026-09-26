import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkTafApi } from '../tools/check-taf-api';

const origin = 'https://app.test';
const fixture = JSON.parse(readFileSync(new URL('../packages/domain/test/fixtures/tafs.json', import.meta.url), 'utf8'));
const report = fixture.reports.find((value: { icaoId: string }) => value.icaoId === 'KSFO');

test('deployment check exercises the same-origin TAF route and validates a real forecast', async () => {
  await checkTafApi(origin, async (input, init) => {
    assert.equal(String(input), `${origin}/api/weather/tafs.json?ids=KSFO&format=json`);
    assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json([report]);
  });
});

test('deployment check rejects missing routes, upstream errors, HTML fallbacks and invalid forecasts', async () => {
  for (const status of [404, 502, 503]) {
    await assert.rejects(checkTafApi(origin, async () => new Response(null, { status })), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(checkTafApi(origin, async () => new Response('<html>app shell</html>')), /non-JSON/);
  for (const body of [{}, [{ rawTAF: 'invalid' }], [{ ...report, icaoId: 'KJFK' }]]) {
    await assert.rejects(checkTafApi(origin, async () => Response.json(body)), /invalid TAF response/);
  }
  await assert.rejects(checkTafApi(origin, async () => { throw new Error('network unavailable'); }), /network unavailable/);
});

test('deployment check accepts valid no-forecast responses', async () => {
  await checkTafApi(origin, async () => new Response(null, { status: 204 }));
  await checkTafApi(origin, async () => Response.json([]));
});
