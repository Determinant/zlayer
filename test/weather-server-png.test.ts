import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { encode } from 'fast-png';
import { decodeWeatherPng } from '../tools/weather-server/png';

function chunk(type: string, data: Uint8Array): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); result.write(type, 4); result.set(data, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
test('weather PNG validates pixels and rejects excessive inflation and compressed metadata before decoding', () => {
  const layout = { width: 2, height: 2, depth: 16 as const, channels: 1 as const };
  const data = Uint16Array.from([0, 123, 4096, 65535]);
  const png = Buffer.from(encode({ ...layout, data }));
  assert.deepEqual(decodeWeatherPng(png, layout).data, data);
  const bomb = Buffer.concat([png.subarray(0, 33), chunk('IDAT', deflateSync(Buffer.alloc(2 * 1024 * 1024))), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodeWeatherPng(bomb, layout), /larger|limit|length/i);
  for (const type of ['iCCP', 'zTXt', 'iTXt', 'IHDR', 'acTL']) {
    const unsupported = Buffer.concat([png.subarray(0, 33), chunk(type, Buffer.from([0])), png.subarray(33)]);
    assert.throws(() => decodeWeatherPng(unsupported, layout), /Unsupported.*chunk/);
  }
  assert.throws(() => decodeWeatherPng(png, { ...layout, width: 7000 }), /geometry/);
  assert.throws(() => decodeWeatherPng(png.subarray(0, -1), layout), /Truncated/);
});
